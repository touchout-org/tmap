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

const browserWarning = document.getElementById('browser-warning');
const searchForm = document.getElementById('search-form');
const locationLabel = document.getElementById('location-label');
const locationInput = document.getElementById('location-input');
const anchorHeading = document.getElementById('anchor-heading');
const mapSvg = document.getElementById('map');
const messageDisplay = document.getElementById('message-display');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');

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
function setMessage(text, deviceDelayMs = 0) {
  messageDisplay.textContent = text;
  if (currentDevice) {
    if (deviceDelayMs > 0) {
      setTimeout(() => sendTextToDevice(text, currentDevice), deviceDelayMs);
    } else {
      sendTextToDevice(text, currentDevice);
    }
  }
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = locationInput.value.trim();
  if (query) {
    runSearch(query);
  }
});

async function runSearch(query) {
  setMessage(`Searching for "${query}"…`);
  let place;
  try {
    place = await geocode(query);
  } catch (err) {
    setMessage(`Could not reach Nominatim to search for "${query}". Check your connection and try again.`);
    return;
  }
  if (!place) {
    setMessage(`No results found for "${query}".`);
    return;
  }

  const lat = parseFloat(place.lat);
  const lon = parseFloat(place.lon);
  const bbox = squareBoundingBox(lat, lon, POI_DISTANCE_THRESHOLD_MILES);

  let ways;
  try {
    ways = await fetchWays(bbox);
  } catch (err) {
    setMessage(`Found "${formatPlaceName(place)}", but could not reach Overpass to fetch street data. Check your connection and try again.`);
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

  renderMap(bbox, ways, lat, lon);
  if (currentDevice) {
    sendGraphicToDevice(currentDevice);
  }

  const streetCount = new Set(ways.map((w) => w.tags && w.tags.name).filter(Boolean)).size;
  setMessage(`Showing ${displayName}. ${streetCount} named street${streetCount === 1 ? '' : 's'} in view.`);
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
}

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

// Hardcoded to the spec's documented 20-cell message display rather than
// trusting device.numberBrailleCellColumns — diagnostic step to rule out the
// device misreporting a larger cell count and being sent more data than its
// message line can actually hold.
const MESSAGE_LINE_CELLS = 20;

function sendTextToDevice(text, device) {
  const numCells = MESSAGE_LINE_CELLS;
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
  return Array.from(nibbles, (n) => n.toString(16).padStart(2, '0').toUpperCase()).join('');
}

// Reprojects lon/lat directly to the device's native dot-grid resolution
// (not downscaled from the on-screen 600x400 SVG) and rasterizes streets +
// anchor marker with the Bresenham helpers above. No dedup/tiering yet
// (Phase 2) — same raw, unfiltered data as the on-screen render.
function rasterizeMapToPixels(bbox, ways, anchorLat, anchorLon, displayW, displayH) {
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
  if (!lastBbox) return;
  const numCols = device.numberCellColumns;
  const numRows = device.numberCellRows;
  const displayW = numCols * 2;
  const displayH = numRows * 4;
  const pixels = rasterizeMapToPixels(lastBbox, lastWays, lastAnchorLat, lastAnchorLon, displayW, displayH);
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
  // Diagnostic: delay just the message-line device write by 1s after
  // connecting, to test whether writing it immediately puts the device into
  // a bad state that then corrupts the graphic write that follows.
  if (lastBbox) {
    setMessage('Dot Pad connected.', 1000);
    sendGraphicToDevice(device);
  } else {
    setMessage('Dot Pad connected. Showing 6x4 test grid.', 1000);
    sendTestGridToDevice(device);
  }
}

function setDisconnectedState() {
  currentDevice = null;
  btnConnect.hidden = false;
  btnDisconnect.hidden = true;
  setMessage('Dot Pad disconnected.');
}

btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  setMessage('Scanning for Dot Pad…');
  try {
    const bleDevice = await scanner.startBleScan();
    if (!bleDevice) {
      setMessage('No Dot Pad selected.');
      btnConnect.disabled = false;
      return;
    }
    setMessage('Connecting to Dot Pad…');
    const dotDevice = await sdk.connectBleDevice(bleDevice);
    if (!dotDevice) {
      setMessage('Could not connect to the Dot Pad.');
      btnConnect.disabled = false;
    }
  } catch (err) {
    setMessage(`Dot Pad connection error: ${err.message}`);
    btnConnect.disabled = false;
  }
});

btnDisconnect.addEventListener('click', () => {
  if (currentDevice) sdk.disconnect(currentDevice);
});

// The key-event callback is a placeholder for now — cursor movement/hit-testing
// (Phase 1 item 4) and hotkey wiring (item 5) aren't built yet.
sdk.setCallBack(
  (device, dataCode) => {
    btnConnect.disabled = false;
    if (dataCode === DataCodes.Connected) {
      setConnectedState(device);
    } else if (dataCode === DataCodes.Disconnected) {
      setDisconnectedState();
    } else if (dataCode === DataCodes.ConnectedFail) {
      setMessage('Dot Pad connection failed.');
    }
  },
  () => {}
);
