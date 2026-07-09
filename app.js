import {
  DotPadSDK,
  DotPadScanner,
  DisplayMode,
  DataCodes
} from './web-sdk-3.0.0/DotPadSDK-3.0.0.js';

// Data sources — see tmap spec.md § Data sources
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Settings-ready variables (see tmap spec.md § Settings) — not yet exposed in a UI,
// but kept as named constants rather than inlined so the Settings dialog has a real
// value to bind to later.
//
// Temporarily set well below the spec's [1 mile] default: with no decluttering
// (Phase 2) or scale control (Phase 1 item 6) built yet, 1 mile crammed into the
// 60x40 dot grid is too dense to read by touch. 0.15 miles (~three or four short
// blocks) is small enough to verify individual streets render in the right place.
// Revert to the real default once Scale / decluttering land.
const POI_DISTANCE_THRESHOLD_MILES = 0.15;

// Matches DotSVG's 600x400 canvas (10:1 over the 60x40 dot grid) — see tmap spec.md
// § SVG Display Requirements (3x2 canvas ratio).
const SVG_WIDTH = 600;
const SVG_HEIGHT = 400;
const MILES_TO_METERS = 1609.344;

// § Cursor and hit testing — the cursor/hit-testing grid is fixed at the
// Dot Pad's native 60x40 dot resolution (confirmed via the on-connect
// device-info diagnostic: numberCellColumns=30, numberCellRows=10) and is
// independent of whether a device is actually connected, per the Hardware
// requirement that the app works standalone.
const DOT_GRID_WIDTH = 60;
const DOT_GRID_HEIGHT = 40;
const SVG_UNITS_PER_DOT = SVG_WIDTH / DOT_GRID_WIDTH; // 10
// § Scale behavior / § Settings — the 9 Traditional Scale presets ("1 in =
// Y ft"). DOT_PAD_DISPLAY_WIDTH_INCHES is the tactile display's measured
// width: 6 3/16 in (height is 4 1/8 in — exactly a 3:2 ratio, matching
// SVG_WIDTH:SVG_HEIGHT below, so height is still derived from width via
// that fixed ratio rather than tracked separately). Works out to ~9.7 dots
// per inch on both axes -- close enough to call it 10 DPI.
const SCALE_PRESETS_FT = [100, 200, 300, 400, 500, 1000, 1500, 2000, 5000];
const DEFAULT_SCALE_INDEX = 3; // 400
const DOT_PAD_DISPLAY_WIDTH_INCHES = 6 + 3 / 16;

// § Pan Behavior / § Settings — default Pan Amount, in units of display
// width/height (no Settings dialog yet, so this is the only value in use).
const PAN_AMOUNT_FRACTION = 0.25;

// A street "hits" the cursor when it passes within this many grid units of
// the cursor's center — an approximation of "intersects the cursor's edge"
// (tmap spec.md § Cursor and hit testing) sized to roughly match the small
// 4x4 cursor footprint. To be refined once this is visible on hardware.
const CURSOR_HIT_RADIUS = 2;

const browserWarning = document.getElementById('browser-warning');
const searchForm = document.getElementById('search-form');
const locationLabel = document.getElementById('location-label');
const locationInput = document.getElementById('location-input');
const anchorHeading = document.getElementById('anchor-heading');
const mapSvg = document.getElementById('map');
const messageDisplay = document.getElementById('message-display');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const deviceInfo = document.getElementById('device-info');
const scaleSelect = document.getElementById('scale-select');
const btnPanNorth = document.getElementById('btn-pan-north');
const btnPanSouth = document.getElementById('btn-pan-south');
const btnPanEast = document.getElementById('btn-pan-east');
const btnPanWest = document.getElementById('btn-pan-west');
const panButtons = [btnPanNorth, btnPanSouth, btnPanEast, btnPanWest];

let hasAnchor = false;

// § Screen Layout — Dot Pad connection state. Only one of btn-connect /
// btn-disconnect is ever visible at a time (see setConnectedState/setDisconnectedState).
const sdk = new DotPadSDK();
const scanner = new DotPadScanner();
let currentDevice = null;

// Last-rendered map data, kept so a device that connects after a map is already
// showing can be synced immediately (see setConnectedState).
let lastBbox = null;
let lastWays = [];
let lastAnchorLat = null;
let lastAnchorLon = null;
let lastAnchorName = null;

// § Scale behavior / § Pan Behavior — the viewport is the sub-window of the
// fetched data (lastBbox) actually shown at the current scale. Center starts
// at the anchor POI on each new search; scaleIndex indexes SCALE_PRESETS_FT.
let viewportCenterLat = null;
let viewportCenterLon = null;
let scaleIndex = DEFAULT_SCALE_INDEX;

// Cursor position in dot-grid units (0..DOT_GRID_WIDTH-1, 0..DOT_GRID_HEIGHT-1).
// null until a map has been loaded.
let cursorGridX = null;
let cursorGridY = null;
const cursorSvg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
cursorSvg.setAttribute('class', 'cursor');
cursorSvg.setAttribute('r', SVG_UNITS_PER_DOT * 1.5);
cursorSvg.hidden = true;

// § Browser check
function isChrome() {
  const ua = navigator.userAgent;
  return /Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);
}
if (!isChrome()) {
  browserWarning.hidden = false;
}

// § Message display architecture — the on-screen field is the single source of
// truth; it updates first, then pushes to the Dot Pad's 20-cell message display.
// Messages are kept terse throughout: the device only has 20 cells to show
// them in, and there's no way to pan to see the rest of a longer message yet.
function setMessage(text, deviceDelayMs = 0) {
  // Full text always goes on-screen (and so is what speech/ARIA announces).
  // Only the device copy is truncated, since that's the only channel with
  // an actual 20-cell physical limit.
  messageDisplay.textContent = text;
  if (currentDevice) {
    const deviceText = truncateMessage(text, currentDevice.numberBrailleCellColumns);
    if (deviceDelayMs > 0) {
      setTimeout(() => sendTextToDevice(deviceText, currentDevice), deviceDelayMs);
    } else {
      sendTextToDevice(deviceText, currentDevice);
    }
  }
}

// Truncates to at most maxLen characters, but backs off to the last space
// rather than cutting a word in half -- e.g. "2632 College Ave, Berkeley"
// becomes "2632 College Ave," (18 chars), not "2632 College Ave, Be".
function truncateMessage(text, maxLen = 20) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

// § Scale behavior — populate the combo box once from SCALE_PRESETS_FT.
SCALE_PRESETS_FT.forEach((_, index) => {
  const option = document.createElement('option');
  option.value = String(index);
  option.textContent = formatScaleLabel(index);
  scaleSelect.appendChild(option);
});
scaleSelect.value = String(DEFAULT_SCALE_INDEX);

scaleSelect.addEventListener('change', () => {
  const newIndex = Number(scaleSelect.value);
  scaleIndex = newIndex;
  refreshMap();
  setMessage(formatScaleLabel(scaleIndex));
});

btnPanNorth.addEventListener('click', () => panMap('north'));
btnPanSouth.addEventListener('click', () => panMap('south'));
btnPanEast.addEventListener('click', () => panMap('east'));
btnPanWest.addEventListener('click', () => panMap('west'));

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = locationInput.value.trim();
  if (query) {
    runSearch(query);
  }
});

async function runSearch(query) {
  setMessage('Searching…');
  let place;
  try {
    place = await geocode(query);
  } catch (err) {
    setMessage('Search failed');
    return;
  }
  if (!place) {
    setMessage('No results');
    return;
  }

  const lat = parseFloat(place.lat);
  const lon = parseFloat(place.lon);
  const bbox = squareBoundingBox(lat, lon, POI_DISTANCE_THRESHOLD_MILES);

  let ways;
  try {
    ways = await fetchWays(bbox);
  } catch (err) {
    setMessage('Streets failed');
    return;
  }

  const displayName = formatPlaceName(place);
  showAnchor(displayName, lat, lon, bbox, ways);
}

// § Data ingestion and cleaning pipeline, step 1 (Geocode)
async function geocode(query) {
  const url = `${NOMINATIM_URL}?format=json&q=${encodeURIComponent(query)}&limit=1&addressdetails=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('geocode-failed');
  const data = await res.json();
  return data.length ? data[0] : null;
}

function formatPlaceName(place) {
  const address = place.address || {};
  const parts = [];
  if (place.name) parts.push(place.name);
  const streetLine = [address.house_number, address.road].filter(Boolean).join(' ');
  if (streetLine) parts.push(streetLine);
  const city = address.city || address.town || address.village;
  if (city) parts.push(city);
  if (address.state) parts.push(address.state);
  if (address.postcode) parts.push(address.postcode);
  return parts.length ? parts.join(', ') : place.display_name;
}

// § Data sources — square region centered on the anchor POI, half-side = POI
// distance threshold setting.
function squareBoundingBox(lat, lon, halfSideMiles) {
  const halfSideMeters = halfSideMiles * MILES_TO_METERS;
  const metersPerDegreeLat = 111320;
  const latDelta = halfSideMeters / metersPerDegreeLat;
  const lonDelta = halfSideMeters / (metersPerDegreeLat * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - latDelta,
    north: lat + latDelta,
    west: lon - lonDelta,
    east: lon + lonDelta
  };
}

const FEET_TO_METERS = 0.3048;
const METERS_PER_DEGREE_LAT = 111320;

function feetToLatDelta(feet) {
  return (feet * FEET_TO_METERS) / METERS_PER_DEGREE_LAT;
}

function feetToLonDelta(feet, atLat) {
  return (feet * FEET_TO_METERS) / (METERS_PER_DEGREE_LAT * Math.cos((atLat * Math.PI) / 180));
}

// East/north offset in feet of (lat, lon) from (fromLat, fromLon).
function feetOffsetFrom(lat, lon, fromLat, fromLon) {
  const northFt = ((lat - fromLat) * METERS_PER_DEGREE_LAT) / FEET_TO_METERS;
  const eastFt = ((lon - fromLon) * METERS_PER_DEGREE_LAT * Math.cos((fromLat * Math.PI) / 180)) / FEET_TO_METERS;
  return { eastFt, northFt };
}

// § Scale behavior — current viewport width/height in feet, from the
// selected preset. Height follows the 3x2 display ratio (see SVG_HEIGHT/SVG_WIDTH).
function viewportSizeFeet() {
  const widthFt = SCALE_PRESETS_FT[scaleIndex] * DOT_PAD_DISPLAY_WIDTH_INCHES;
  const heightFt = widthFt * (SVG_HEIGHT / SVG_WIDTH);
  return { widthFt, heightFt };
}

// The geo bbox actually projected/displayed right now: centered on
// viewportCenterLat/Lon, sized by the current scale, clamped to never
// exceed the fetched data (lastBbox) even if the viewport is larger.
function getViewportBbox() {
  if (viewportCenterLat === null || !lastBbox) return null;
  const { widthFt, heightFt } = viewportSizeFeet();
  const latDelta = feetToLatDelta(heightFt / 2);
  const lonDelta = feetToLonDelta(widthFt / 2, viewportCenterLat);
  return {
    south: Math.max(lastBbox.south, viewportCenterLat - latDelta),
    north: Math.min(lastBbox.north, viewportCenterLat + latDelta),
    west: Math.max(lastBbox.west, viewportCenterLon - lonDelta),
    east: Math.min(lastBbox.east, viewportCenterLon + lonDelta)
  };
}

// § Scale behavior / § Settings — Traditional Scale is the spec's default
// Scale Type, now that DOT_PAD_DISPLAY_WIDTH_INCHES is a real measured
// value rather than a placeholder. (Display Area is still what actually
// drives the viewport math in viewportSizeFeet() — this is just the label.)
function formatScaleLabel(index) {
  return `1 in = ${SCALE_PRESETS_FT[index]} ft`;
}

// § Data ingestion and cleaning pipeline, step 2 (Fetch). No dedup/collapse/tiering
// yet (Phase 2) — every named, highway-tagged way in the box is rendered as-is.
async function fetchWays(bbox) {
  const query = `[out:json][timeout:25];way["highway"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out geom;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error('overpass-failed');
  const data = await res.json();
  return data.elements || [];
}

function projectToSvg(lat, lon, bbox) {
  const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * SVG_WIDTH;
  const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * SVG_HEIGHT;
  return { x, y };
}

// Same -0.5 pixel-center convention as rasterizeMapToPixels, so cursor/hit
// testing lines up with what the tactile display actually shows.
function projectToGrid(lat, lon, bbox) {
  const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * DOT_GRID_WIDTH - 0.5;
  const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * DOT_GRID_HEIGHT - 0.5;
  return { x, y };
}

function showAnchor(displayName, lat, lon, bbox, ways) {
  document.title = `DotTMAP — ${displayName}`;
  anchorHeading.textContent = displayName;
  anchorHeading.hidden = false;

  if (!hasAnchor) {
    hasAnchor = true;
    locationLabel.textContent = 'Enter another nearby address or location (optional):';
  }

  lastBbox = bbox;
  lastWays = ways;
  lastAnchorLat = lat;
  lastAnchorLon = lon;
  lastAnchorName = displayName;

  // § Scale behavior / § Pan Behavior — reset the viewport to the anchor
  // POI at the default scale on every new search.
  viewportCenterLat = lat;
  viewportCenterLon = lon;
  scaleIndex = DEFAULT_SCALE_INDEX;
  scaleSelect.value = String(scaleIndex);

  cursorSvg.hidden = false;
  scaleSelect.disabled = false;
  panButtons.forEach((btn) => { btn.disabled = false; });
  refreshMap();

  setMessage(displayName);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Central re-render: recomputes the viewport bbox, redraws the on-screen
// map, re-centers the cursor, and refreshes the tactile display if
// connected. Called after a new search, a pan, or a scale change.
//
// Cursor re-centers on every viewport change rather than tracking a fixed
// real-world point through the pan/scale -- simpler, and the spec leaves
// this interaction open ("we will refine this behavior as we experiment
// with the UI"). Revisit if that turns out to feel wrong in practice.
function refreshMap() {
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return;

  renderMap(viewportBbox, lastWays, lastAnchorLat, lastAnchorLon);

  cursorGridX = Math.round(DOT_GRID_WIDTH / 2);
  cursorGridY = Math.round(DOT_GRID_HEIGHT / 2);
  updateCursorVisual();

  if (currentDevice) {
    sendGraphicToDevice(currentDevice);
  }
}

function renderMap(bbox, ways, anchorLat, anchorLon) {
  mapSvg.innerHTML = '';
  const svgNs = 'http://www.w3.org/2000/svg';

  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    const points = way.geometry
      .map((pt) => {
        const { x, y } = projectToSvg(pt.lat, pt.lon, bbox);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    const line = document.createElementNS(svgNs, 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('class', 'street');
    mapSvg.appendChild(line);
  }

  const anchorPoint = projectToSvg(anchorLat, anchorLon, bbox);
  const marker = document.createElementNS(svgNs, 'circle');
  marker.setAttribute('cx', anchorPoint.x.toFixed(1));
  marker.setAttribute('cy', anchorPoint.y.toFixed(1));
  marker.setAttribute('r', 4);
  marker.setAttribute('class', 'anchor-poi');
  mapSvg.appendChild(marker);

  // Cursor is a single reused element, always drawn last (on top).
  mapSvg.appendChild(cursorSvg);
}

// Centers the on-screen cursor circle on the current grid cell.
function updateCursorVisual() {
  const cx = (cursorGridX + 0.5) * SVG_UNITS_PER_DOT;
  const cy = (cursorGridY + 0.5) * SVG_UNITS_PER_DOT;
  cursorSvg.setAttribute('cx', cx.toFixed(1));
  cursorSvg.setAttribute('cy', cy.toFixed(1));
}

function distanceToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

// § Cursor and hit testing — streets within CURSOR_HIT_RADIUS grid units of
// the cursor's center are "current." Unique names only, joined with " & ".
function currentObjectNames() {
  const viewportBbox = getViewportBbox();
  if (!viewportBbox || cursorGridX === null) return null;
  const names = new Set();
  for (const way of lastWays) {
    const name = way.tags && way.tags.name;
    if (!name || !way.geometry || way.geometry.length < 2) continue;
    let prev = null;
    for (const pt of way.geometry) {
      const p = projectToGrid(pt.lat, pt.lon, viewportBbox);
      if (prev) {
        const d = distanceToSegment(cursorGridX, cursorGridY, prev.x, prev.y, p.x, p.y);
        if (d <= CURSOR_HIT_RADIUS) {
          names.add(name);
          break;
        }
      }
      prev = p;
    }
  }
  return names.size ? Array.from(names).join(' & ') : null;
}

// § Command / hotkey mapping — cursor moves one display pixel per press, no
// acceleration. Shared by both the arrow keys and the Dot Pad's dots 3/2/5/6.
function moveCursor(dx, dy) {
  if (!lastBbox || cursorGridX === null) return;
  cursorGridX = clamp(cursorGridX + dx, 0, DOT_GRID_WIDTH - 1);
  cursorGridY = clamp(cursorGridY + dy, 0, DOT_GRID_HEIGHT - 1);
  updateCursorVisual();

  const names = currentObjectNames();
  setMessage(names || 'No street');

  if (currentDevice) {
    sendGraphicToDevice(currentDevice);
  }
}

// § Pan Behavior — moves the viewport by PAN_AMOUNT_FRACTION of its current
// width/height. Rejected (viewport unchanged) if the move would push the
// viewport past the edge of the fetched data; the message field reports
// "Edge of Map" in that case, per spec. (No device "beep": the vendored SDK
// doesn't expose one, and the message-field report is the primary channel
// per Message display architecture regardless.)
function panMap(direction) {
  if (!lastBbox || viewportCenterLat === null) return;
  const { widthFt, heightFt } = viewportSizeFeet();
  const latStep = feetToLatDelta(heightFt * PAN_AMOUNT_FRACTION);
  const lonStep = feetToLonDelta(widthFt * PAN_AMOUNT_FRACTION, viewportCenterLat);

  let newLat = viewportCenterLat;
  let newLon = viewportCenterLon;
  if (direction === 'north') newLat += latStep;
  else if (direction === 'south') newLat -= latStep;
  else if (direction === 'east') newLon += lonStep;
  else if (direction === 'west') newLon -= lonStep;

  const halfLat = feetToLatDelta(heightFt / 2);
  const halfLon = feetToLonDelta(widthFt / 2, newLat);
  const exceedsEdge =
    newLat + halfLat > lastBbox.north + 1e-9 ||
    newLat - halfLat < lastBbox.south - 1e-9 ||
    newLon + halfLon > lastBbox.east + 1e-9 ||
    newLon - halfLon < lastBbox.west - 1e-9;

  if (exceedsEdge) {
    setMessage('Edge of Map');
    return;
  }

  viewportCenterLat = newLat;
  viewportCenterLon = newLon;
  refreshMap();

  const { eastFt, northFt } = feetOffsetFrom(viewportCenterLat, viewportCenterLon, lastAnchorLat, lastAnchorLon);
  const distFt = Math.round(Math.hypot(eastFt, northFt));
  const compass = Math.abs(eastFt) > Math.abs(northFt)
    ? (eastFt >= 0 ? 'East' : 'West')
    : (northFt >= 0 ? 'North' : 'South');
  setMessage(distFt === 0 ? `At ${lastAnchorName}` : `${distFt} ft ${compass} of ${lastAnchorName}`);
}

// § Scale behavior — steps through SCALE_PRESETS_FT; delta is +1 ("[",
// increase scale/zoom out) or -1 ("]", decrease scale/zoom in).
function changeScale(delta) {
  if (!lastBbox) return;
  const newIndex = clamp(scaleIndex + delta, 0, SCALE_PRESETS_FT.length - 1);
  if (newIndex === scaleIndex) return;
  scaleIndex = newIndex;
  scaleSelect.value = String(scaleIndex);
  refreshMap();
  setMessage(formatScaleLabel(scaleIndex));
}

document.addEventListener('keydown', (event) => {
  if (document.activeElement === locationInput) return;
  if (!lastBbox) return;

  // § Command / hotkey mapping — [ increases scale (zoom out), ] decreases
  // (zoom in).
  if (event.key === '[' || event.key === ']') {
    event.preventDefault();
    changeScale(event.key === '[' ? 1 : -1);
    return;
  }

  // Ctrl+arrow pans; plain arrow moves the cursor.
  const panDirections = { ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east' };
  if (event.ctrlKey && panDirections[event.key]) {
    event.preventDefault();
    panMap(panDirections[event.key]);
    return;
  }

  const cursorDeltas = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1]
  };
  const delta = cursorDeltas[event.key];
  if (!delta) return;
  event.preventDefault();
  moveCursor(delta[0], delta[1]);
});

// ── Dot Pad connection + tactile rendering ──────────────────────────────────
// Reuses the DotSVG project's braille-message and pixel-rasterization modules
// (see tmap spec.md § Representing braille on the Dot Pad) rather than
// reinventing them.

// NABCC 8-dot Computer Braille lookup table, ported verbatim from DotSVG.
// Index = ASCII code - 0x20 (covers 0x20 space through 0x7E tilde).
// Value = 8-dot braille byte: bit0=dot1, bit1=dot2, ..., bit7=dot8.
// Source: BRLTTY en-nabcc.ttb (North American Braille Computer Code)
const NABCC = new Uint8Array([
  0x00, 0x2E, 0x10, 0x3C, 0x2B, 0x29, 0x2F, 0x04, 0x37, 0x3E, 0x21, 0x2C, 0x20, 0x24, 0x28, 0x0C,
  0x34, 0x02, 0x06, 0x12, 0x32, 0x22, 0x16, 0x36, 0x26, 0x14, 0x31, 0x30, 0x23, 0x3F, 0x1C, 0x39,
  0x48, 0x41, 0x43, 0x49, 0x59, 0x51, 0x4B, 0x5B, 0x53, 0x4A, 0x5A, 0x45, 0x47, 0x4D, 0x5D, 0x55,
  0x4F, 0x5F, 0x57, 0x4E, 0x5E, 0x65, 0x67, 0x7A, 0x6D, 0x7D, 0x75, 0x6A, 0x73, 0x7B, 0x58, 0x38,
  0x08, 0x01, 0x03, 0x09, 0x19, 0x11, 0x0B, 0x1B, 0x13, 0x0A, 0x1A, 0x05, 0x07, 0x0D, 0x1D, 0x15,
  0x0F, 0x1F, 0x17, 0x0E, 0x1E, 0x25, 0x27, 0x3A, 0x2D, 0x3D, 0x35, 0x2A, 0x33, 0x3B, 0x18
]);

// Convert a text string to a DotPad message-line hex string (one raw NABCC byte
// per cell; displayTextData with TextMode applies the pin mapping internally).
function textToMessageHex(text, numCells) {
  let hex = '';
  for (let i = 0; i < numCells; i++) {
    const ch = i < text.length ? text[i] : ' ';
    const code = ch.charCodeAt(0);
    const b = (code >= 0x20 && code <= 0x7E) ? NABCC[code - 0x20] : 0x00;
    hex += b.toString(16).padStart(2, '0').toUpperCase();
  }
  return hex;
}

function sendTextToDevice(text, device) {
  // Confirmed via on-screen device-info diagnostic that this hardware
  // reports numberBrailleCellColumns=20, matching the spec, so back to
  // trusting the device's own reported value rather than hardcoding it.
  const numCells = device.numberBrailleCellColumns;
  const zeros = '00'.repeat(numCells);
  const hex = textToMessageHex(text, numCells);
  sdk.displayTextData(zeros, device, DisplayMode.TextMode);
  sdk.displayTextData(hex, device, DisplayMode.TextMode);
}

// Bresenham line/circle rasterization directly into a dot-grid pixel buffer,
// ported from DotSVG. Drawing at native tactile resolution (rather than
// downscaling a full-size SVG image) guarantees every touched pixel is fully
// on, so thin street lines can't anti-alias away to nothing at 60x40.
function setGridPixel(pixels, w, h, x, y) {
  if (x >= 0 && x < w && y >= 0 && y < h) pixels[y * w + x] = 1;
}

function drawLinePixels(pixels, w, h, x0, y0, x1, y1) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x1 > x0 ? 1 : -1, sy = y1 > y0 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (true) {
    setGridPixel(pixels, w, h, x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

function drawFilledCircle(pixels, w, h, cx, cy, r) {
  cx = Math.round(cx); cy = Math.round(cy);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) {
        setGridPixel(pixels, w, h, cx + dx, cy + dy);
      }
    }
  }
}

// § SVG Display Requirements — cursor is "a 4x4 square with corner dots
// removed": an 8-dot ring around a 2x2 unfilled center. (cx,cy) is the
// square's upper-left interior corner.
function drawCursorPixels(pixels, w, h, cx, cy) {
  cx = Math.round(cx); cy = Math.round(cy);
  const offsets = [
    [0, -1], [1, -1],
    [-1, 0], [2, 0],
    [-1, 1], [2, 1],
    [0, 2], [1, 2]
  ];
  for (const [dx, dy] of offsets) {
    setGridPixel(pixels, w, h, cx + dx, cy + dy);
  }
}

// Packs a 0/1 pixel buffer into the DotPad SDK's per-cell hex byte format
// (each braille cell is 2 dots wide x 4 dots tall).
function packPixelsToHex(pixels, displayW, displayH, numRows) {
  const nibbles = new Uint8Array(displayW * numRows);
  for (let y = 0; y < displayH; y++) {
    const band = Math.floor(y / 4);
    const bit = y % 4;
    for (let x = 0; x < displayW; x++) {
      if (pixels[y * displayW + x]) {
        nibbles[(x ^ 1) + band * displayW] |= (1 << bit);
      }
    }
  }
  // No padStart here: each entry is a true 4-bit nibble (bit ranges 0-3, so
  // the max value is 0b1111 = 0xF) and needs exactly one hex character, not
  // two. Padding to 2 chars (as the message-line byte encoding correctly
  // does) silently doubles the string length and shifts every nibble after
  // the first non-trivial one out of alignment -- this was the actual bug
  // behind the deformed grid, not any timing/delay issue.
  return Array.from(nibbles, (n) => n.toString(16).toUpperCase()).join('');
}

// Reprojects lon/lat directly to the device's native dot-grid resolution
// (not downscaled from the on-screen 600x400 SVG) and rasterizes streets +
// anchor marker with the Bresenham helpers above. No dedup/tiering yet
// (Phase 2) — same raw, unfiltered data as the on-screen render.
function rasterizeMapToPixels(bbox, ways, anchorLat, anchorLon, displayW, displayH, cursor) {
  const pixels = new Uint8Array(displayW * displayH);
  // -0.5 matches DotSVG's pixX/pixY: canvas/logical coordinates address the
  // *center* of a display pixel, not its corner (see rasterizeShapes).
  const project = (lat, lon) => ({
    x: ((lon - bbox.west) / (bbox.east - bbox.west)) * displayW - 0.5,
    y: ((bbox.north - lat) / (bbox.north - bbox.south)) * displayH - 0.5
  });

  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    let prev = null;
    for (const pt of way.geometry) {
      const p = project(pt.lat, pt.lon);
      if (prev) drawLinePixels(pixels, displayW, displayH, prev.x, prev.y, p.x, p.y);
      prev = p;
    }
  }

  const anchor = project(anchorLat, anchorLon);
  drawFilledCircle(pixels, displayW, displayH, anchor.x, anchor.y, 1);

  if (cursor) {
    // Scale from the fixed DOT_GRID_WIDTH/HEIGHT cursor space into this
    // device's own reported dimensions (equal in practice, per the
    // on-connect device-info diagnostic, but kept independent).
    const cx = cursor.x * (displayW / DOT_GRID_WIDTH);
    const cy = cursor.y * (displayH / DOT_GRID_HEIGHT);
    drawCursorPixels(pixels, displayW, displayH, cx, cy);
  }

  return pixels;
}

// Diagnostic-only: a 6x4 lattice of long horizontal and vertical lines
// spanning the full display, drawn with the exact same drawLinePixels /
// packPixelsToHex path as real street data. Shown before the first map is
// loaded so a broken/discontinuous render can be isolated to the rendering
// pipeline itself (grid also broken) vs. something specific to street
// geometry (grid solid, map broken).
function rasterizeTestGrid(displayW, displayH, cols, rows) {
  const pixels = new Uint8Array(displayW * displayH);
  for (let c = 0; c <= cols; c++) {
    const x = Math.min(displayW - 1, Math.round((c / cols) * (displayW - 1)));
    drawLinePixels(pixels, displayW, displayH, x, 0, x, displayH - 1);
  }
  for (let r = 0; r <= rows; r++) {
    const y = Math.min(displayH - 1, Math.round((r / rows) * (displayH - 1)));
    drawLinePixels(pixels, displayW, displayH, 0, y, displayW - 1, y);
  }
  return pixels;
}

function sendPixelsToDevice(device, pixels, numCols, numRows) {
  const displayW = numCols * 2;
  const displayH = numRows * 4;
  const hex = packPixelsToHex(pixels, displayW, displayH, numRows);
  const zeros = '00'.repeat(numCols * numRows);
  sdk.displayGraphicData(zeros, device, DisplayMode.GraphicMode);
  sdk.displayGraphicData(hex, device, DisplayMode.GraphicMode);
}

function sendGraphicToDevice(device) {
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return;
  const numCols = device.numberCellColumns;
  const numRows = device.numberCellRows;
  const displayW = numCols * 2;
  const displayH = numRows * 4;
  const cursor = cursorGridX === null ? null : { x: cursorGridX, y: cursorGridY };
  const pixels = rasterizeMapToPixels(viewportBbox, lastWays, lastAnchorLat, lastAnchorLon, displayW, displayH, cursor);
  sendPixelsToDevice(device, pixels, numCols, numRows);
}

function sendTestGridToDevice(device) {
  const numCols = device.numberCellColumns;
  const numRows = device.numberCellRows;
  const displayW = numCols * 2;
  const displayH = numRows * 4;
  const pixels = rasterizeTestGrid(displayW, displayH, 6, 4);
  sendPixelsToDevice(device, pixels, numCols, numRows);
}

// § Screen Layout — only one of Connect/Disconnect is ever visible, never both
// shown with one disabled.
function setConnectedState(device) {
  currentDevice = device;
  btnConnect.hidden = true;
  btnDisconnect.hidden = false;
  // Diagnostic: show what the device actually reports for its grid
  // dimensions, rather than trusting our assumed 30x10 (60x40 dots).
  deviceInfo.textContent =
    `Device: numberCellColumns=${device.numberCellColumns}, ` +
    `numberCellRows=${device.numberCellRows}, ` +
    `numberBrailleCellColumns=${device.numberBrailleCellColumns}`;
  // Graphic renders immediately (matches DotSVG); the message-line write is
  // delayed 1s -- confirmed by testing this avoids a ~15s hold-up before the
  // graphic write completes, so it stays even though the actual deformed-grid
  // bug (packPixelsToHex padding above) is now fixed for other reasons.
  if (lastBbox) {
    setMessage('Connected', 1000);
    sendGraphicToDevice(device);
  } else {
    setMessage('Connected: grid', 1000);
    sendTestGridToDevice(device);
  }
}

function setDisconnectedState() {
  currentDevice = null;
  btnConnect.hidden = false;
  btnDisconnect.hidden = true;
  deviceInfo.textContent = '';
  setMessage('Disconnected');
}

btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  setMessage('Scanning…');
  try {
    const bleDevice = await scanner.startBleScan();
    if (!bleDevice) {
      setMessage('No device selected');
      btnConnect.disabled = false;
      return;
    }
    setMessage('Connecting…');
    const dotDevice = await sdk.connectBleDevice(bleDevice);
    if (!dotDevice) {
      setMessage('Connect failed');
      btnConnect.disabled = false;
    }
  } catch (err) {
    setMessage('Connect error');
    btnConnect.disabled = false;
  }
});

btnDisconnect.addEventListener('click', () => {
  if (currentDevice) sdk.disconnect(currentDevice);
});

// The key-event callback is a placeholder for now — cursor movement/hit-testing
// (Phase 1 item 4) and hotkey wiring (item 5) aren't built yet.
// § Command / hotkey mapping — decodes a Dot Pad key event into a byte6
// dot-chord bitmask, ported verbatim from DotSVG's labelToByte6. Cursor
// dots per tmap spec.md § Cursor and hit testing: 3=left, 2=up, 5=down,
// 6=right (bit0=dot1 ... bit5=dot6).
function labelToByte6(label) {
  const hasLP = /\bLP\b/.test(label) || /\bAP\b/.test(label);
  const hasRP = /\bRP\b/.test(label) || /\bAP\b/.test(label);
  const mPlus = label.match(/\+\s*(\d+)/);
  const mBare = !mPlus && label.match(/^\d+$/);
  const num = mPlus ? parseInt(mPlus[1], 10) : mBare ? parseInt(mBare[0], 10) : 0;
  return ((num & 4) ? 0x01 : 0) |  // dot 1
         ((num & 8) ? 0x02 : 0) |  // dot 2
         (hasLP     ? 0x04 : 0) |  // dot 3
         ((num & 2) ? 0x08 : 0) |  // dot 4
         ((num & 1) ? 0x10 : 0) |  // dot 5
         (hasRP     ? 0x20 : 0);   // dot 6
}

sdk.setCallBack(
  (device, dataCode) => {
    btnConnect.disabled = false;
    if (dataCode === DataCodes.Connected) {
      setConnectedState(device);
    } else if (dataCode === DataCodes.Disconnected) {
      setDisconnectedState();
    } else if (dataCode === DataCodes.ConnectedFail) {
      setMessage('Connect failed');
    }
  },
  (device, keyCode, msg) => {
    const byte6 = labelToByte6(msg || keyCode);
    // § Command / hotkey mapping — cursor: single dots 3/2/5/6.
    if (byte6 === 0x04) moveCursor(-1, 0);       // dot3 alone -> left
    else if (byte6 === 0x20) moveCursor(1, 0);   // dot6 alone -> right
    else if (byte6 === 0x02) moveCursor(0, -1);  // dot2 alone -> up
    else if (byte6 === 0x10) moveCursor(0, 1);   // dot5 alone -> down
    // Pan: two-dot combos.
    else if (byte6 === 0x09) panMap('north');    // dots 1+4
    else if (byte6 === 0x24) panMap('south');    // dots 3+6
    else if (byte6 === 0x05) panMap('west');     // dots 1+3
    else if (byte6 === 0x28) panMap('east');     // dots 4+6
    // Scale: two-dot combos.
    else if (byte6 === 0x06) changeScale(1);     // dots 2+3 -> increase (zoom out)
    else if (byte6 === 0x30) changeScale(-1);    // dots 5+6 -> decrease (zoom in)
  }
);
