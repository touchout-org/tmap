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
// Larger than the earlier 0.15mi test value now that Scale/Pan (Phase 1
// item 6) exist -- the original concern about a big fetch being too dense
// to read by touch was about cramming the whole fetch region into the
// display at once, which no longer happens now that only a scale-sized
// viewport window is ever shown. Not yet the spec's real [1 mile] default,
// though: empirically tested both directly against the public Overpass
// instance (isolated single requests, not rate-limit noise) -- 1 mile
// half-side reliably times out (504 after ~13s) for this dense test area,
// while 0.5 miles reliably succeeds (~3s, ~400KB). 0.5mi gets Scale changes
// visibly working up toward the 1000ft preset with some room to pan.
// Revisit once a non-public/self-hosted Overpass endpoint is used --
// Phase 2 decluttering (see processWays) reduces what's rendered, not the
// fetch payload itself, so it doesn't relax this constraint.
const POI_DISTANCE_THRESHOLD_MILES = 0.5;

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
const CURSOR_SVG_RADIUS = SVG_UNITS_PER_DOT * 1.5;

// § Braille labels — label zones are windows adjacent to the map viewbox,
// carved out of the fixed DOT_GRID_WIDTH/HEIGHT canvas rather than growing
// it (the physical Dot Pad grid never changes size). Left/right zones need
// 10 dot columns each (6 for 3 braille characters + 2 kerning + 2 padding);
// top/bottom need 5 dot rows each (3 for the braille dots + 2 padding).
const LABEL_ZONE_DOT_COLS = 10;
const LABEL_ZONE_DOT_ROWS = 5;
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

// § Same-name roadway/pedestrian de-duplication
const ROADWAY_CLASSES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service'
]);
const PEDESTRIAN_CLASSES = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'steps']);

// § Street importance tiers — an unrecognized highway value (the Overpass
// query has no class filter, so lifecycle tags like construction/proposed
// can come through) falls to tier 7, the first to be hidden by decluttering,
// rather than crashing or getting treated as important.
const HIGHWAY_TIERS = {
  motorway: 1, trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  unclassified: 5, residential: 5, living_street: 5,
  service: 6,
  footway: 7, path: 7, cycleway: 7, pedestrian: 7, steps: 7
};
const MAX_TIER = 7;

// § Experimental tuning fields (early development only) — empirically-
// chosen defaults from testing against real Berkeley OSM data, matching the
// values pre-filled in the tuning inputs (see index.html). Carriageway
// collapse and tier-based decluttering are no-ops (show/keep everything)
// only if a field is cleared back to blank.
let tuningCarriagewayMaxSeparationFt = 200;
let tuningDensityCellSizePx = 20;
let tuningDensityThreshold = 2;

// Number of evenly-spaced points used to resample each way in a matched
// carriageway cluster before averaging into a centerline (see
// collapseClusterWindowed) — arbitrary but plenty for street-scale geometry.
const CARRIAGEWAY_RESAMPLE_POINTS = 12;

// A street "hits" the cursor when it passes within this many grid units of
// the cursor's center — an approximation of "intersects the cursor's edge"
// (tmap spec.md § Cursor and hit testing) sized to roughly match the small
// 4x4 cursor footprint. To be refined once this is visible on hardware.
const CURSOR_HIT_RADIUS = 2;

const browserWarning = document.getElementById('browser-warning');
const searchForm = document.getElementById('search-form');
const locationLabel = document.getElementById('location-label');
const locationInput = document.getElementById('location-input');
const btnSearch = document.getElementById('btn-search');
const anchorHeading = document.getElementById('anchor-heading');
const mapSvg = document.getElementById('map');
const messageDisplay = document.getElementById('message-display');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const scaleSelect = document.getElementById('scale-select');
const btnPanNorth = document.getElementById('btn-pan-north');
const btnPanSouth = document.getElementById('btn-pan-south');
const btnPanEast = document.getElementById('btn-pan-east');
const btnPanWest = document.getElementById('btn-pan-west');
const panButtons = [btnPanNorth, btnPanSouth, btnPanEast, btnPanWest];
const btnLabels = document.getElementById('btn-labels');
const labelsDialog = document.getElementById('labels-dialog');
const btnLabelsClose = document.getElementById('btn-labels-close');
const labelCheckboxes = {
  top: document.getElementById('label-top'),
  bottom: document.getElementById('label-bottom'),
  left: document.getElementById('label-left'),
  right: document.getElementById('label-right')
};
const tuningDensityCellSizeInput = document.getElementById('tuning-density-cell-size');
const tuningDensityThresholdInput = document.getElementById('tuning-density-threshold');
const tuningCarriagewayMaxSeparationInput = document.getElementById('tuning-carriageway-max-separation');
const poiListSelect = document.getElementById('poi-list');
const poiTooFarDialog = document.getElementById('poi-too-far-dialog');
const poiTooFarMessage = document.getElementById('poi-too-far-message');
const btnPoiShowAnyway = document.getElementById('btn-poi-show-anyway');
const btnPoiCancel = document.getElementById('btn-poi-cancel');

let hasAnchor = false;

// § Additional POIs — locations beyond the anchor, each with a triangle
// marker and an entry in the POI list box. Cleared whenever a new anchor
// is created (a discarded map takes its POIs with it).
let additionalPois = []; // { name, lat, lon }

// Holds the pending too-far location while the confirmation dialog is open,
// so "Show new location" knows what to do (see promptTooFarPoi).
let pendingFarPoi = null;

// § Screen Layout — Dot Pad connection state. Only one of btn-connect /
// btn-disconnect is ever visible at a time (see setConnectedState/setDisconnectedState).
const sdk = new DotPadSDK();
const scanner = new DotPadScanner();
let currentDevice = null;

// Last-rendered map data, kept so a device that connects after a map is already
// showing can be synced immediately (see setConnectedState).
let lastBbox = null;
// § Data ingestion and cleaning pipeline — lastRawWays is exactly what
// Overpass returned; lastWays is processWays(lastRawWays), the deduped/
// collapsed/tiered list actually rendered and hit-tested. Kept separate so
// changing a tuning field can re-run the pipeline without a new fetch.
let lastRawWays = [];
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

// § Braille labels / § Settings — shared toggle state for the 4 label
// zones, driven equally by the dialog checkboxes and the i/j/k/l hotkeys
// (see spec § Command / hotkey mapping). [none checked] is the default.
let labelZones = { top: false, bottom: false, left: false, right: false };

// The map's effective drawable region within the fixed DOT_GRID_WIDTH x
// DOT_GRID_HEIGHT canvas, after carving out whichever label zones are
// active. All grid/SVG/device projections for streets, cursor, and hit
// testing operate within this sub-region rather than the full canvas.
function mapGridBounds() {
  const offsetX = labelZones.left ? LABEL_ZONE_DOT_COLS : 0;
  const offsetY = labelZones.top ? LABEL_ZONE_DOT_ROWS : 0;
  const width = DOT_GRID_WIDTH - offsetX - (labelZones.right ? LABEL_ZONE_DOT_COLS : 0);
  const height = DOT_GRID_HEIGHT - offsetY - (labelZones.bottom ? LABEL_ZONE_DOT_ROWS : 0);
  return { offsetX, offsetY, width, height };
}

// Same region, in on-screen SVG units (see SVG_UNITS_PER_DOT).
function svgMapRect() {
  const b = mapGridBounds();
  return {
    x: b.offsetX * SVG_UNITS_PER_DOT,
    y: b.offsetY * SVG_UNITS_PER_DOT,
    width: b.width * SVG_UNITS_PER_DOT,
    height: b.height * SVG_UNITS_PER_DOT
  };
}

// Cursor position, stored as a real-world lat/lon (not grid units) so it
// stays fixed relative to the map through pan and scale changes rather than
// jumping around when the viewport underneath it moves. null until a map
// has been loaded. Grid/display position is derived fresh from this each
// render (see cursorGridPosition/updateCursorVisual), and clamped to the
// current viewport's bounds -- if the cursor's real position is temporarily
// outside the visible area, it displays pinned to the nearest edge without
// forgetting where it actually is, so panning back brings it into view
// again at the same real-world spot.
let cursorLat = null;
let cursorLon = null;
const cursorSvg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
cursorSvg.setAttribute('class', 'cursor');
cursorSvg.setAttribute('r', CURSOR_SVG_RADIUS);
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
  //
  // § Message display architecture — the live region is cleared and forced
  // to reflow before being repopulated. Screen readers (confirmed on NVDA)
  // don't reliably treat a same-element textContent change as a fresh
  // assertive announcement that interrupts whatever's still being spoken;
  // clear-then-reflow-then-set is the standard technique for forcing that,
  // rather than letting rapid successive messages queue up and play in
  // full one after another.
  messageDisplay.textContent = '';
  void messageDisplay.offsetHeight;
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

// § Sound cues — secondary, non-verbal feedback alongside the message
// field. There's no standard way for a web page to trigger the OS/console
// bell, so cues are short tones synthesized with the Web Audio API --
// no external library or audio file needed. AudioContext is created lazily
// on first use, since browsers require it to happen inside a user-gesture
// event handler (a keypress or click, which every caller here already is).
let audioContext = null;
function playTone(frequency, durationMs) {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = new AudioContextClass();
  }
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.value = 0.2;
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + durationMs / 1000);
}

// Low, short "bump" tone for Edge of Map -- see tmap spec.md § Sound cues.
function playEdgeOfMapTone() {
  playTone(220, 150);
}

// § Scale behavior — populate the combo box once from SCALE_PRESETS_FT.
SCALE_PRESETS_FT.forEach((_, index) => {
  const option = document.createElement('option');
  option.value = String(index);
  option.textContent = formatScaleLabel(index);
  scaleSelect.appendChild(option);
});
scaleSelect.value = String(DEFAULT_SCALE_INDEX);

// § Scale behavior — shared by the on-screen combo box and the changeScale
// hotkey helper below, so a mouse-driven scale change goes through the exact
// same update (message + refresh) as a keyboard/Dot Pad one, not a separate
// copy of the same logic.
function setScaleIndex(newIndex) {
  if (!lastBbox) return;
  newIndex = clamp(newIndex, 0, SCALE_PRESETS_FT.length - 1);
  if (newIndex === scaleIndex) return;
  scaleIndex = newIndex;
  scaleSelect.value = String(scaleIndex);
  refreshMap();
  setMessage(formatScaleLabel(scaleIndex));
}

scaleSelect.addEventListener('change', () => {
  setScaleIndex(Number(scaleSelect.value));
});

btnPanNorth.addEventListener('click', () => panMap('north'));
btnPanSouth.addEventListener('click', () => panMap('south'));
btnPanEast.addEventListener('click', () => panMap('east'));
btnPanWest.addEventListener('click', () => panMap('west'));

// § Braille labels — the dialog checkboxes are a live view of the shared
// labelZones state (see setLabelZone), not a separately-synced copy: they're
// set to match on every open, matching the i/j/k/l hotkeys' effect too.
btnLabels.addEventListener('click', () => {
  for (const zone in labelCheckboxes) labelCheckboxes[zone].checked = labelZones[zone];
  labelsDialog.showModal();
});
btnLabelsClose.addEventListener('click', () => labelsDialog.close());
for (const zone in labelCheckboxes) {
  labelCheckboxes[zone].addEventListener('change', () => setLabelZone(zone, labelCheckboxes[zone].checked));
}

// § Braille labels — shared toggle used by both the dialog checkboxes and
// the i/j/k/l hotkeys. Reports the new state in the message field per
// § Command / hotkey mapping, then re-renders (zone geometry changed).
function setLabelZone(zone, value) {
  if (labelZones[zone] === value) return;
  labelZones[zone] = value;
  setMessage(`${zone} labels ${value ? 'on' : 'off'}`);
  refreshMap();
}

function toggleLabelZone(zone) {
  setLabelZone(zone, !labelZones[zone]);
  // Keep the checkbox in sync even if the dialog happens to be open right now.
  labelCheckboxes[zone].checked = labelZones[zone];
}

// § Experimental tuning fields — blank means "unset" (null), matching the
// spec's "no defaults yet" -- Carriageway collapse / tier decluttering are
// no-ops until a real number is entered. Carriageway separation needs the
// data pipeline re-run (it changes which pairs collapse); the density
// fields only affect the render-time tier-drop pass, so a plain refresh
// is enough for those.
function parseTuningValue(input) {
  const value = input.value.trim();
  if (value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

tuningDensityCellSizeInput.addEventListener('change', () => {
  tuningDensityCellSizePx = parseTuningValue(tuningDensityCellSizeInput);
  refreshMap();
});
tuningDensityThresholdInput.addEventListener('change', () => {
  tuningDensityThreshold = parseTuningValue(tuningDensityThresholdInput);
  refreshMap();
});
tuningCarriagewayMaxSeparationInput.addEventListener('change', () => {
  tuningCarriagewayMaxSeparationFt = parseTuningValue(tuningCarriagewayMaxSeparationInput);
  reprocessWays();
});

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  // Move focus off the text field and onto Search on every submit
  // (including pressing Enter in the field) rather than leaving it in the
  // edit field, where a screen reader user could accidentally retype into it.
  btnSearch.focus();
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

  // § Screen Layout — the edit field is only for entering a location to
  // search for; once one's been found, its job here is done.
  locationInput.value = '';

  const lat = parseFloat(place.lat);
  const lon = parseFloat(place.lon);
  const displayName = formatPlaceName(place);
  const shortName = formatShortAddress(place);

  if (!hasAnchor) {
    await createNewAnchor(displayName, shortName, lat, lon);
    return;
  }

  // § Additional POIs — a location entered after the anchor exists either
  // joins the current map (within the POI distance threshold) or requires
  // discarding it for a new one, depending on distance from the anchor.
  const { eastFt, northFt } = feetOffsetFrom(lat, lon, lastAnchorLat, lastAnchorLon);
  const distFt = Math.hypot(eastFt, northFt);
  const thresholdFt = (POI_DISTANCE_THRESHOLD_MILES * MILES_TO_METERS) / FEET_TO_METERS;

  if (distFt > thresholdFt) {
    promptTooFarPoi(displayName, shortName, lat, lon, distFt);
    return;
  }

  addAdditionalPoi(shortName, lat, lon);
}

// § POIs — fetches and displays a brand-new anchor, discarding whatever map
// (and additional POIs) may already be showing. Used both for the very
// first search and for "Show new location" when a later search is too far
// from the current anchor to fit on the same map. displayName (the fuller
// name) is used only for the on-screen title and heading; shortName (street
// address only) is what's spoken/brailled everywhere else -- see
// formatShortAddress.
async function createNewAnchor(displayName, shortName, lat, lon) {
  const bbox = squareBoundingBox(lat, lon, POI_DISTANCE_THRESHOLD_MILES);
  let ways;
  try {
    ways = await fetchWays(bbox);
  } catch (err) {
    setMessage('Streets failed');
    return;
  }
  additionalPois = [];
  showAnchor(displayName, shortName, lat, lon, bbox, ways);
  renderPoiList();
}

// § Additional POIs — "The new location is [distance] away from [anchor
// POI]. That's too far away for a single map." Confirming discards the
// current map and makes the new location the anchor; cancelling leaves the
// current map untouched.
function promptTooFarPoi(displayName, shortName, lat, lon, distFt) {
  pendingFarPoi = { displayName, shortName, lat, lon };
  poiTooFarMessage.textContent =
    `The new location is ${Math.round(distFt)} ft away from ${lastAnchorName}. ` +
    `That's too far away for a single map.`;
  btnPoiShowAnyway.textContent = `Show ${shortName}`;
  poiTooFarDialog.showModal();
}

btnPoiShowAnyway.addEventListener('click', () => {
  poiTooFarDialog.close();
  const pending = pendingFarPoi;
  pendingFarPoi = null;
  if (pending) createNewAnchor(pending.displayName, pending.shortName, pending.lat, pending.lon);
});
btnPoiCancel.addEventListener('click', () => {
  poiTooFarDialog.close();
  pendingFarPoi = null;
});

// § Additional POIs — adds a triangle-marker POI to the current map, then
// pans to center it and moves the cursor there (announcing distance/
// direction from the anchor, same as an explicit pan).
function addAdditionalPoi(shortName, lat, lon) {
  additionalPois.push({ name: shortName, lat, lon });
  renderPoiList();
  panToPoint(lat, lon);
}

// § POIs — the anchor is always the first entry (value "anchor"), followed
// by every additional POI (value = its index into additionalPois).
function renderPoiList() {
  poiListSelect.innerHTML = '';
  if (lastAnchorName) {
    const anchorOption = document.createElement('option');
    anchorOption.value = 'anchor';
    anchorOption.textContent = lastAnchorName;
    poiListSelect.appendChild(anchorOption);
  }
  additionalPois.forEach((poi, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = poi.name;
    poiListSelect.appendChild(option);
  });
  poiListSelect.disabled = !lastAnchorName;
}

// § Additional POIs — "Selecting an item from the list box (or arrowing
// through the list) pans to that POI." A native <select> already fires
// 'change' on every arrow-key move, not just on a committed selection, so
// this alone covers both interactions.
poiListSelect.addEventListener('change', () => {
  if (poiListSelect.value === 'anchor') {
    panToPoint(lastAnchorLat, lastAnchorLon);
    return;
  }
  const poi = additionalPois[Number(poiListSelect.value)];
  if (poi) panToPoint(poi.lat, poi.lon);
});

// Centers the view exactly on (lat, lon) and moves the cursor there too --
// used for panning to a POI (newly added, or selected from the list), as
// opposed to panMap's fixed-amount directional step, which never moves the
// cursor. refreshMap's keepCursorInView shifts the view further if needed
// to keep the cursor visible, the same as it does after a scale change.
function panToPoint(lat, lon) {
  viewportCenterLat = lat;
  viewportCenterLon = lon;
  cursorLat = lat;
  cursorLon = lon;
  refreshMap();
  announcePositionRelativeToAnchor();
}

// § Pan Behavior — "[distance] [direction] of [anchor POI]," shared by an
// explicit pan and panning to a POI.
function announcePositionRelativeToAnchor() {
  const { eastFt, northFt } = feetOffsetFrom(viewportCenterLat, viewportCenterLon, lastAnchorLat, lastAnchorLon);
  const distFt = Math.round(Math.hypot(eastFt, northFt));
  const compass = Math.abs(eastFt) > Math.abs(northFt)
    ? (eastFt >= 0 ? 'East' : 'West')
    : (northFt >= 0 ? 'North' : 'South');
  setMessage(distFt === 0 ? `At ${lastAnchorName}` : `${distFt} ft ${compass} of ${lastAnchorName}`);
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

// § POIs — the short form used whenever a POI is spoken, brailled, or
// otherwise referenced (message field, POI list entries, the too-far
// dialog): street address only, no business/POI name, city, state, or zip.
// formatPlaceName's fuller result is reserved for the on-screen title and
// H2 heading only. Falls back to the full name for the rare place with no
// house_number/road at all (e.g. a searched city or neighborhood).
function formatShortAddress(place) {
  const address = place.address || {};
  const streetLine = [address.house_number, address.road].filter(Boolean).join(' ');
  return streetLine || formatPlaceName(place);
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

// § Scale behavior / § Braille labels — current viewport width/height in
// feet, from the selected preset, applied per-axis via the Dot Pad's
// measured (isotropic, ~10 DPI) dot pitch rather than a fixed 3x2 ratio --
// necessary now that active label zones can make the map's sub-region
// narrower and/or shorter than the full physical display, including
// asymmetric cases (e.g. only a top zone) that no longer keep a 3x2 shape.
function viewportSizeFeet() {
  const b = mapGridBounds();
  const inchesPerDot = DOT_PAD_DISPLAY_WIDTH_INCHES / DOT_GRID_WIDTH;
  const widthFt = SCALE_PRESETS_FT[scaleIndex] * (b.width * inchesPerDot);
  const heightFt = SCALE_PRESETS_FT[scaleIndex] * (b.height * inchesPerDot);
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

// § Data ingestion and cleaning pipeline, step 2 (Fetch).
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

// § Data ingestion and cleaning pipeline, steps 3-7 (Group by name, Detect
// carriageway pairs, Roadway/pedestrian dedup, Collapse to centerline,
// Assign tier). Runs on every fetch and again whenever a tuning field
// changes (see reprocessWays), since a different carriageway max-separation
// changes which clusters collapse.
//
// Carriageway collapse is N-way, not just pairwise -- a divided road with
// 3+ same-name, same-tier ways sharing a stretch of corridor (not just the
// standard 2-way oneway pair) collapses to one centerline. Tier is assigned
// right after dedup (rather than at the very end) specifically so clustering
// only ever groups ways of identical importance -- a two-way collapse must
// never accidentally average a road with a same-named service driveway.
function processWays(rawWays) {
  const nameGroups = groupWaysByName(rawWays);
  const cleaned = [];

  for (const ways of nameGroups.values()) {
    // Dedup runs across the whole name group first, per spec pipeline order.
    const survivors = dedupRoadwayPedestrian(ways);
    for (const way of survivors) {
      way.tier = HIGHWAY_TIERS[way.tags && way.tags.highway] || MAX_TIER;
    }

    const tierGroups = groupByTier(survivors);
    for (const tierWays of tierGroups.values()) {
      const clusters = detectCarriagewayClusters(tierWays, tuningCarriagewayMaxSeparationFt);
      for (const cluster of clusters) {
        if (cluster.length === 1) {
          cleaned.push(cluster[0]);
        } else {
          const { collapsed, remainders } = collapseClusterWindowed(cluster);
          cleaned.push(collapsed, ...remainders);
        }
      }
    }
  }
  return cleaned;
}

function groupWaysByName(ways) {
  const groups = new Map();
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(way);
  }
  return groups;
}

function groupByTier(ways) {
  const groups = new Map();
  for (const way of ways) {
    if (!groups.has(way.tier)) groups.set(way.tier, []);
    groups.get(way.tier).push(way);
  }
  return groups;
}

// § Same-name roadway/pedestrian de-duplication — footway/path/cycleway/
// pedestrian/steps ways are dropped once at least one roadway-class way
// shares their name (treated as a sidewalk/path running alongside the
// road); a name with no roadway-class way at all is left untouched.
function dedupRoadwayPedestrian(ways) {
  const hasRoadway = ways.some((w) => ROADWAY_CLASSES.has(w.tags && w.tags.highway));
  if (!hasRoadway) return ways.slice();
  return ways.filter((w) => !PEDESTRIAN_CLASSES.has(w.tags && w.tags.highway));
}

// Bearing in degrees (0-360, 0=north, clockwise) of the straight line from a
// way's first to last point. Equirectangular approximation -- plenty
// accurate at street scale.
function wayBearing(way) {
  const a = way.geometry[0], b = way.geometry[way.geometry.length - 1];
  const dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  const dy = b.lat - a.lat;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

function bearingsAreOpposite(b1, b2, toleranceDeg = 30) {
  const raw = ((b1 - b2) % 360 + 360) % 360;
  const diff = Math.abs(raw - 180);
  return diff <= toleranceDeg;
}

function wayLengthFt(way) {
  const geom = way.geometry;
  let total = 0;
  for (let i = 1; i < geom.length; i++) {
    const { eastFt, northFt } = feetOffsetFrom(geom[i].lat, geom[i].lon, geom[i - 1].lat, geom[i - 1].lon);
    total += Math.hypot(eastFt, northFt);
  }
  return total;
}

// § Divided-road carriageway collapse — an axis unit vector for projecting
// points into "distance along the corridor" terms, from a way's own bearing.
function axisUnitVector(bearingDeg) {
  const rad = bearingDeg * (Math.PI / 180);
  return { dx: Math.sin(rad), dy: Math.cos(rad) };
}

function axisPosition(pt, origin, dx, dy) {
  const { eastFt, northFt } = feetOffsetFrom(pt.lat, pt.lon, origin.lat, origin.lon);
  return eastFt * dx + northFt * dy;
}

function wayAxisExtent(way, origin, dx, dy) {
  let min = Infinity, max = -Infinity;
  for (const pt of way.geometry) {
    const p = axisPosition(pt, origin, dx, dy);
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}

// Finds the lat/lon on a way's polyline at a given axis position, by linear
// interpolation between the two vertices bracketing it. Assumes the way's
// axis-position runs roughly monotonically along its vertex order (true for
// a carriageway segment that doesn't double back on itself).
function latLonAtAxisPosition(way, origin, dx, dy, targetPos) {
  const geom = way.geometry;
  const positions = geom.map((pt) => axisPosition(pt, origin, dx, dy));
  const increasing = positions[positions.length - 1] >= positions[0];
  for (let i = 1; i < geom.length; i++) {
    const p0 = positions[i - 1], p1 = positions[i];
    const inSeg = increasing ? (targetPos >= p0 && targetPos <= p1) : (targetPos <= p0 && targetPos >= p1);
    if (inSeg) {
      const t = p1 !== p0 ? (targetPos - p0) / (p1 - p0) : 0;
      const a = geom[i - 1], b = geom[i];
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
  }
  return targetPos < Math.min(...positions) ? geom[increasing ? 0 : geom.length - 1] : geom[increasing ? geom.length - 1 : 0];
}

// Resamples a way to n evenly-spaced points across an ABSOLUTE axis-position
// window (not the way's own full length) -- this is what makes corresponding
// indices across two different-length, differently-directioned ways
// represent the same physical location, so no bearing-based reversal is
// needed before averaging (unlike parametrizing by each way's own length
// fraction, which silently misaligns whenever the ways aren't the same
// length -- see tmap spec.md's Divided-road carriageway collapse notes).
function resampleWayInWindow(way, origin, dx, dy, windowMin, windowMax, n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    const target = windowMin + ((windowMax - windowMin) * i) / (n - 1);
    points.push(latLonAtAxisPosition(way, origin, dx, dy, target));
  }
  return points;
}

// Trims a way's own geometry to the portion(s) OUTSIDE [windowMin, windowMax]
// -- the "remainder" that stays a separate, uncollapsed segment rather than
// being silently dropped or wrongly folded into the collapsed centerline.
// Pieces shorter than MIN_REMAINDER_LENGTH_FT are discarded as boundary-
// interpolation noise, not real leftover road.
const MIN_REMAINDER_LENGTH_FT = 10;
function trimOutsideWindow(way, origin, dx, dy, windowMin, windowMax) {
  const geom = way.geometry;
  const positions = geom.map((pt) => axisPosition(pt, origin, dx, dy));
  const before = [];
  const after = [];
  for (let i = 0; i < geom.length; i++) {
    if (positions[i] < windowMin) before.push(geom[i]);
    else if (positions[i] > windowMax) after.push(geom[i]);
  }
  if (before.length) before.push(latLonAtAxisPosition(way, origin, dx, dy, windowMin));
  if (after.length) after.unshift(latLonAtAxisPosition(way, origin, dx, dy, windowMax));

  const remainders = [];
  for (const geometry of [before, after]) {
    if (geometry.length < 2) continue;
    const remainder = { tags: way.tags, geometry, tier: way.tier };
    if (wayLengthFt(remainder) >= MIN_REMAINDER_LENGTH_FT) remainders.push(remainder);
  }
  return remainders;
}

// § Divided-road carriageway collapse — whether two ways should be
// considered part of the same carriageway, checked in order of reliability:
// explicit tag, then oneway+opposite-bearing+windowed-overlap. The windowed
// overlap test (rather than a simple nearest-point distance) is what
// prevents two sequential, end-to-end blocks that never actually run
// alongside each other from being mistaken for a parallel pair -- and lets
// two ways of different lengths match on just their shared stretch.
const CARRIAGEWAY_MIN_OVERLAP_FRACTION = 0.5;
function isCarriagewayMatch(a, b, maxSepFt) {
  if (!a.geometry || a.geometry.length < 2 || !b.geometry || b.geometry.length < 2) return false;
  if (a.tags && a.tags.dual_carriageway === 'yes' && b.tags && b.tags.dual_carriageway === 'yes') return true;

  const aOneway = a.tags && a.tags.oneway === 'yes';
  const bOneway = b.tags && b.tags.oneway === 'yes';
  if (!aOneway || !bOneway) return false;
  if (!bearingsAreOpposite(wayBearing(a), wayBearing(b))) return false;
  if (maxSepFt == null) return false;

  const { dx, dy } = axisUnitVector(wayBearing(a));
  const origin = a.geometry[0];
  const [aMin, aMax] = wayAxisExtent(a, origin, dx, dy);
  const [bMin, bMax] = wayAxisExtent(b, origin, dx, dy);
  const windowMin = Math.max(aMin, bMin);
  const windowMax = Math.min(aMax, bMax);
  const overlapLen = windowMax - windowMin;
  if (overlapLen <= 0) return false; // no shared stretch at all -- sequential blocks, not a pair

  const shorterLen = Math.min(aMax - aMin, bMax - bMin);
  if (shorterLen <= 0 || overlapLen / shorterLen < CARRIAGEWAY_MIN_OVERLAP_FRACTION) return false;

  const n = CARRIAGEWAY_RESAMPLE_POINTS;
  const aPts = resampleWayInWindow(a, origin, dx, dy, windowMin, windowMax, n);
  const bPts = resampleWayInWindow(b, origin, dx, dy, windowMin, windowMax, n);
  const distances = aPts.map((pt, i) => {
    const { eastFt, northFt } = feetOffsetFrom(pt.lat, pt.lon, bPts[i].lat, bPts[i].lon);
    return Math.hypot(eastFt, northFt);
  });
  const maxDist = Math.max(...distances);
  const minDist = Math.min(...distances);
  if (maxDist > maxSepFt) return false;
  if (maxDist - minDist > maxSepFt * 0.75) return false;

  return true;
}

// § Divided-road carriageway collapse — greedy mutual-compatibility
// clustering: a candidate only joins a growing cluster if it matches EVERY
// current member, not just the most recently added one. This is what keeps
// a long, busy street from chaining an entire corridor into one cluster via
// a series of individually-valid but not mutually-compatible links --
// confirmed against real Berkeley OSM data during local experimentation
// (see project notes). Cost is O(k^2) per name+tier group; real groups stay
// small (tens of ways at most for a 0.5mi fetch), so this stays well under
// a millisecond in practice.
function detectCarriagewayClusters(ways, maxSepFt) {
  if (maxSepFt == null) return ways.map((w) => [w]);
  const remaining = ways.slice().sort((a, b) => wayLengthFt(b) - wayLengthFt(a));
  const clusters = [];
  while (remaining.length) {
    const seed = remaining.shift();
    const cluster = [seed];
    let addedSomething = true;
    while (addedSomething) {
      addedSomething = false;
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        let compatibleWithAll = true;
        for (const member of cluster) {
          if (!isCarriagewayMatch(member, candidate, maxSepFt)) { compatibleWithAll = false; break; }
        }
        if (compatibleWithAll) {
          cluster.push(candidate);
          remaining.splice(i, 1);
          addedSomething = true;
          break;
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// Collapses a cluster of 2+ same-tier, same-name ways into one centerline
// covering only their mutually-shared stretch of corridor (the intersection
// of every member's own extent), plus any non-overlapping tail of a longer
// member preserved as its own separate way rather than distorted into the
// average or silently dropped.
function collapseClusterWindowed(cluster) {
  const reference = cluster.reduce((longest, w) => (wayLengthFt(w) > wayLengthFt(longest) ? w : longest));
  const { dx, dy } = axisUnitVector(wayBearing(reference));
  const origin = reference.geometry[0];

  let windowMin = -Infinity, windowMax = Infinity;
  for (const way of cluster) {
    const [mn, mx] = wayAxisExtent(way, origin, dx, dy);
    windowMin = Math.max(windowMin, mn);
    windowMax = Math.min(windowMax, mx);
  }

  const n = CARRIAGEWAY_RESAMPLE_POINTS;
  const perWayPoints = cluster.map((way) => resampleWayInWindow(way, origin, dx, dy, windowMin, windowMax, n));
  const geometry = [];
  for (let i = 0; i < n; i++) {
    let lat = 0, lon = 0;
    for (const pts of perWayPoints) { lat += pts[i].lat; lon += pts[i].lon; }
    geometry.push({ lat: lat / cluster.length, lon: lon / cluster.length });
  }
  const collapsed = { tags: reference.tags, geometry, tier: reference.tier };

  const remainders = [];
  for (const way of cluster) {
    remainders.push(...trimOutsideWindow(way, origin, dx, dy, windowMin, windowMax));
  }
  return { collapsed, remainders };
}

// Re-runs the pipeline against the last raw fetch (no new Overpass request)
// and re-renders -- used when a tuning field changes.
function reprocessWays() {
  if (!lastRawWays.length) return;
  lastWays = processWays(lastRawWays);
  refreshMap();
}

// Projects into the map's sub-rectangle of the SVG canvas (see svgMapRect),
// not the full 600x400 canvas -- active label zones shrink and offset it.
function projectToSvg(lat, lon, bbox) {
  const rect = svgMapRect();
  const x = rect.x + ((lon - bbox.west) / (bbox.east - bbox.west)) * rect.width;
  const y = rect.y + ((bbox.north - lat) / (bbox.north - bbox.south)) * rect.height;
  return { x, y };
}

// Same -0.5 pixel-center convention as rasterizeMapToPixels, so cursor/hit
// testing lines up with what the tactile display actually shows. Grid
// space here is map-relative (0..mapGridBounds().width/height), not the
// full DOT_GRID_WIDTH/HEIGHT canvas -- see mapGridBounds.
function projectToGrid(lat, lon, bbox) {
  const b = mapGridBounds();
  const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * b.width - 0.5;
  const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * b.height - 0.5;
  return { x, y };
}

// Inverse of projectToGrid: map-relative grid position -> lat/lon, for the
// same bbox.
function gridToLatLon(gridX, gridY, bbox) {
  const b = mapGridBounds();
  const lon = bbox.west + ((gridX + 0.5) / b.width) * (bbox.east - bbox.west);
  const lat = bbox.north - ((gridY + 0.5) / b.height) * (bbox.north - bbox.south);
  return { lat, lon };
}

// The cursor's position in the *current* viewport's grid space, clamped to
// what's actually on screen. Returns null if there's no map or viewport yet.
function cursorGridPosition(viewportBbox) {
  if (cursorLat === null || !viewportBbox) return null;
  const b = mapGridBounds();
  const p = projectToGrid(cursorLat, cursorLon, viewportBbox);
  return {
    x: clamp(Math.round(p.x), 0, b.width - 1),
    y: clamp(Math.round(p.y), 0, b.height - 1)
  };
}

// displayName (fuller: may include a business/POI name, city, state, zip)
// is used only for the on-screen title and heading. shortName (street
// address only, see formatShortAddress) is what's spoken/brailled
// everywhere else, including this initial "found it" announcement.
function showAnchor(displayName, shortName, lat, lon, bbox, ways) {
  document.title = `DotTMAP — ${displayName}`;
  anchorHeading.textContent = displayName;
  anchorHeading.hidden = false;

  if (!hasAnchor) {
    hasAnchor = true;
    locationLabel.textContent = 'Enter another nearby address or location (optional):';
  }

  lastBbox = bbox;
  lastRawWays = ways;
  lastWays = processWays(lastRawWays);
  lastAnchorLat = lat;
  lastAnchorLon = lon;
  lastAnchorName = shortName;

  // § Scale behavior / § Pan Behavior — reset the viewport to the anchor
  // POI at the default scale on every new search.
  viewportCenterLat = lat;
  viewportCenterLon = lon;
  scaleIndex = DEFAULT_SCALE_INDEX;
  scaleSelect.value = String(scaleIndex);

  // § Cursor and hit testing — cursor starts at the anchor POI on a new
  // search (but not on later pan/scale changes -- see refreshMap).
  cursorLat = lat;
  cursorLon = lon;
  cursorSvg.hidden = false;
  scaleSelect.disabled = false;
  panButtons.forEach((btn) => { btn.disabled = false; });
  refreshMap();

  setMessage(shortName);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Central re-render: recomputes the viewport bbox, redraws the on-screen
// map, repositions the cursor, and refreshes the tactile display if
// connected. Called after a new search, a pan, or a scale change.

// § Pan Behavior — "unless rescaling forces a pan due to edge-of-map": if
// the cursor's fixed real-world position would fall outside the viewport
// after whatever just changed it (scale, or a pan that happens to leave an
// already-near-edge cursor out of view), shift the viewport center just
// enough to bring it back on screen, the same way an explicit pan would.
// Falls back to leaving it clamped to the display edge (see
// cursorGridPosition) only if the fetched data itself doesn't allow enough
// room to shift into -- the one case where map-fixed and display-fixed
// genuinely can't both hold, and map-fixed wins.
const VIEW_MARGIN_UNITS = 2;
function keepCursorInView() {
  if (cursorLat === null || !lastBbox) return;
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return;
  const b = mapGridBounds();
  const p = projectToGrid(cursorLat, cursorLon, viewportBbox);

  let overflowX = 0;
  if (p.x < 0) overflowX = p.x - VIEW_MARGIN_UNITS;
  else if (p.x > b.width - 1) overflowX = p.x - (b.width - 1) + VIEW_MARGIN_UNITS;

  let overflowY = 0;
  if (p.y < 0) overflowY = p.y - VIEW_MARGIN_UNITS;
  else if (p.y > b.height - 1) overflowY = p.y - (b.height - 1) + VIEW_MARGIN_UNITS;

  if (overflowX === 0 && overflowY === 0) return;

  const { widthFt, heightFt } = viewportSizeFeet();
  const ftPerUnitX = widthFt / b.width;
  const ftPerUnitY = heightFt / b.height;

  let newLat = viewportCenterLat - feetToLatDelta(overflowY * ftPerUnitY);
  let newLon = viewportCenterLon + feetToLonDelta(overflowX * ftPerUnitX, viewportCenterLat);

  // Clamp the shift to what the fetched data allows, degrading to centering
  // within it if the viewport itself is larger than the fetched region.
  const halfLat = feetToLatDelta(heightFt / 2);
  const minCenterLat = lastBbox.south + halfLat;
  const maxCenterLat = lastBbox.north - halfLat;
  newLat = minCenterLat <= maxCenterLat
    ? clamp(newLat, minCenterLat, maxCenterLat)
    : (lastBbox.south + lastBbox.north) / 2;

  const halfLon = feetToLonDelta(widthFt / 2, newLat);
  const minCenterLon = lastBbox.west + halfLon;
  const maxCenterLon = lastBbox.east - halfLon;
  newLon = minCenterLon <= maxCenterLon
    ? clamp(newLon, minCenterLon, maxCenterLon)
    : (lastBbox.west + lastBbox.east) / 2;

  viewportCenterLat = newLat;
  viewportCenterLon = newLon;
}

function refreshMap() {
  keepCursorInView();
  const viewportBbox = getViewportBbox();

  // § Braille labels — zones redraw even with no map loaded yet (toggling
  // before a search is allowed), so renderScene runs unconditionally;
  // street/anchor/cursor positioning still needs a real viewport.
  renderScene(viewportBbox);
  if (!viewportBbox) return;

  // Cursor keeps its real-world position (cursorLat/cursorLon) through pan
  // and scale changes -- just reproject it against the new viewport, rather
  // than resetting it. See the cursorLat/cursorLon declaration for why.
  updateCursorVisual();

  if (currentDevice) {
    sendGraphicToDevice(currentDevice);
  }
}

// Clears and redraws the whole on-screen SVG: label zones first (always),
// then streets/anchor within the map sub-rect (only once a map is loaded),
// then the cursor on top.
function renderScene(viewportBbox) {
  mapSvg.innerHTML = '';
  const svgNs = 'http://www.w3.org/2000/svg';

  drawLabelZoneRects(svgNs);

  if (viewportBbox) {
    renderStreetsAndAnchor(svgNs, viewportBbox, lastWays, lastAnchorLat, lastAnchorLon);
    // Cursor is a single reused element, drawn last (on top). Only appended
    // once there's a real viewport/position -- cursorSvg.hidden doesn't
    // reliably suppress rendering for an SVG element, so keeping it out of
    // the DOM entirely pre-search (as before this function existed) avoids
    // showing a stray circle at its default (0,0) position.
    mapSvg.appendChild(cursorSvg);
  }
}

// § Braille labels — draws each active zone as an empty bordered region
// (see svgMapRect/mapGridBounds for the geometry). Label *content* is
// Phase 4; these render as placeholders reserving the space per spec.
function drawLabelZoneRects(svgNs) {
  const leftW = labelZones.left ? LABEL_ZONE_DOT_COLS * SVG_UNITS_PER_DOT : 0;
  const rightW = labelZones.right ? LABEL_ZONE_DOT_COLS * SVG_UNITS_PER_DOT : 0;
  const topH = labelZones.top ? LABEL_ZONE_DOT_ROWS * SVG_UNITS_PER_DOT : 0;
  const bottomH = labelZones.bottom ? LABEL_ZONE_DOT_ROWS * SVG_UNITS_PER_DOT : 0;

  const addRect = (x, y, width, height) => {
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', x.toFixed(1));
    rect.setAttribute('y', y.toFixed(1));
    rect.setAttribute('width', width.toFixed(1));
    rect.setAttribute('height', height.toFixed(1));
    rect.setAttribute('class', 'label-zone');
    mapSvg.appendChild(rect);
  };

  // Left/right zones span the full display height; top/bottom fill the
  // space left between them -- matches mapGridBounds' offset/width math.
  if (labelZones.left) addRect(0, 0, leftW, SVG_HEIGHT);
  if (labelZones.right) addRect(SVG_WIDTH - rightW, 0, rightW, SVG_HEIGHT);
  if (labelZones.top) addRect(leftW, 0, SVG_WIDTH - leftW - rightW, topH);
  if (labelZones.bottom) addRect(leftW, SVG_HEIGHT - bottomH, SVG_WIDTH - leftW - rightW, bottomH);
}

// § Braille labels — streets/anchor go in a group clipped to the map's
// sub-rect (see svgMapRect), not just the full 600x400 canvas. Way geometry
// routinely extends well beyond the current viewport (lastBbox is the whole
// fetched square; bbox here is just the visible window within it), so
// without this a polyline can run straight through a reserved label zone on
// its way to an off-screen point -- previously only hidden from view by the
// zone rect's own fill/z-order, not actually excluded.
function renderStreetsAndAnchor(svgNs, bbox, ways, anchorLat, anchorLon) {
  const rect = svgMapRect();
  const clipPath = document.createElementNS(svgNs, 'clipPath');
  clipPath.setAttribute('id', 'map-clip');
  const clipRect = document.createElementNS(svgNs, 'rect');
  clipRect.setAttribute('x', rect.x.toFixed(1));
  clipRect.setAttribute('y', rect.y.toFixed(1));
  clipRect.setAttribute('width', rect.width.toFixed(1));
  clipRect.setAttribute('height', rect.height.toFixed(1));
  clipPath.appendChild(clipRect);
  mapSvg.appendChild(clipPath);

  const group = document.createElementNS(svgNs, 'g');
  group.setAttribute('clip-path', 'url(#map-clip)');
  mapSvg.appendChild(group);

  // § Map density evaluation and tier-based decluttering — reruns every
  // render (pan/zoom/scale all call refreshMap); ways below the current
  // cutoff are skipped entirely rather than hidden via CSS, which is just
  // as cheap at this scale (a few hundred ways, one filter pass already
  // walked below) without needing a separate class-swap mechanism.
  const visibleMaxTier = computeVisibleMaxTier(bbox, ways);
  for (const way of ways) {
    if (way.tier > visibleMaxTier || !way.geometry || way.geometry.length < 2) continue;
    const points = way.geometry
      .map((pt) => {
        const { x, y } = projectToSvg(pt.lat, pt.lon, bbox);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    const line = document.createElementNS(svgNs, 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('class', 'street');
    line.setAttribute('data-tier', String(way.tier));
    group.appendChild(line);
  }

  // § POIs — every POI marker (anchor and additional alike) is a solid
  // square, all corners intact -- unlike the cursor's hollow ring, so the
  // two read as clearly distinct shapes both on screen and by touch. Sized
  // to the same 3-dot footprint as the tactile marker (see drawSquarePixels)
  // for a consistent visual/tactile scale.
  const anchorPoint = projectToSvg(anchorLat, anchorLon, bbox);
  group.appendChild(createPoiMarkerSvg(svgNs, anchorPoint.x, anchorPoint.y, 'anchor-poi'));

  for (const poi of additionalPois) {
    const p = projectToSvg(poi.lat, poi.lon, bbox);
    group.appendChild(createPoiMarkerSvg(svgNs, p.x, p.y, 'additional-poi'));
  }
}

function createPoiMarkerSvg(svgNs, x, y, className) {
  const size = 3 * SVG_UNITS_PER_DOT;
  const rect = document.createElementNS(svgNs, 'rect');
  rect.setAttribute('x', (x - size / 2).toFixed(1));
  rect.setAttribute('y', (y - size / 2).toFixed(1));
  rect.setAttribute('width', size);
  rect.setAttribute('height', size);
  rect.setAttribute('class', className);
  return rect;
}

// § Map density evaluation and tier-based decluttering — escalating
// tier-drop: start showing every tier and hide the least important (7)
// first, rechecking density each step, until density clears the threshold
// or tier 1 is reached. No-op (show everything) until both tuning fields
// are set.
function computeVisibleMaxTier(viewportBbox, ways) {
  if (tuningDensityCellSizePx == null || tuningDensityThreshold == null) return MAX_TIER;
  for (let maxTier = MAX_TIER; maxTier >= 1; maxTier--) {
    const visible = ways.filter((w) => w.tier <= maxTier);
    if (computeMaxCellDensity(viewportBbox, visible) <= tuningDensityThreshold) return maxTier;
  }
  return 1;
}

// Grid overlay sized by tuningDensityCellSizePx over the map's current
// on-screen sub-rect; counts distinct street *names* per cell (not raw way
// segments, since one named street is often split into many ways at
// intersections and would otherwise overstate its own density) and returns
// the busiest cell's count.
function computeMaxCellDensity(viewportBbox, ways) {
  const rect = svgMapRect();
  const cellSize = tuningDensityCellSizePx;
  const cols = Math.max(1, Math.ceil(rect.width / cellSize));
  const rows = Math.max(1, Math.ceil(rect.height / cellSize));
  const cellNames = new Map();

  for (const way of ways) {
    const name = way.tags && way.tags.name;
    if (!name || !way.geometry || way.geometry.length < 2) continue;
    let prev = null;
    for (const pt of way.geometry) {
      const p = projectToSvg(pt.lat, pt.lon, viewportBbox);
      if (prev) markCellsAlongLine(prev, p, rect, cellSize, cols, rows, cellNames, name);
      prev = p;
    }
  }

  let maxDensity = 0;
  for (const names of cellNames.values()) {
    if (names.size > maxDensity) maxDensity = names.size;
  }
  return maxDensity;
}

// Samples points along a line at roughly half-cell-size intervals (simpler
// than a true line-vs-grid-cell traversal, plenty precise at this scale)
// and records the given street name into every density cell touched.
function markCellsAlongLine(p0, p1, rect, cellSize, cols, rows, cellNames, name) {
  const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const steps = Math.max(1, Math.ceil(dist / (cellSize / 2)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = p0.x + (p1.x - p0.x) * t;
    const y = p0.y + (p1.y - p0.y) * t;
    const col = Math.floor((x - rect.x) / cellSize);
    const row = Math.floor((y - rect.y) / cellSize);
    if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
    const key = col + ',' + row;
    if (!cellNames.has(key)) cellNames.set(key, new Set());
    cellNames.get(key).add(name);
  }
}

// Centers the on-screen cursor circle on the current grid cell. Position is
// additionally clamped by the circle's own radius so it always renders
// fully intact, never clipped by the SVG viewBox edge -- this is purely a
// rendering safeguard on top of cursorGridPosition's grid-space clamp
// (which keepCursorInView already tries hard to avoid ever needing).
function updateCursorVisual() {
  const viewportBbox = getViewportBbox();
  const grid = cursorGridPosition(viewportBbox);
  if (!grid) return;
  const rect = svgMapRect();
  const cx = clamp(rect.x + (grid.x + 0.5) * SVG_UNITS_PER_DOT, rect.x + CURSOR_SVG_RADIUS, rect.x + rect.width - CURSOR_SVG_RADIUS);
  const cy = clamp(rect.y + (grid.y + 0.5) * SVG_UNITS_PER_DOT, rect.y + CURSOR_SVG_RADIUS, rect.y + rect.height - CURSOR_SVG_RADIUS);
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
  const cursorGrid = cursorGridPosition(viewportBbox);
  if (!cursorGrid) return null;
  const names = new Set();
  // § Map density evaluation and tier-based decluttering — a street hidden
  // by decluttering shouldn't be "feelable" via the cursor either, so hit
  // testing respects the same tier cutoff as rendering.
  const visibleMaxTier = computeVisibleMaxTier(viewportBbox, lastWays);
  for (const way of lastWays) {
    if (way.tier > visibleMaxTier) continue;
    const name = way.tags && way.tags.name;
    if (!name || !way.geometry || way.geometry.length < 2) continue;
    let prev = null;
    for (const pt of way.geometry) {
      const p = projectToGrid(pt.lat, pt.lon, viewportBbox);
      if (prev) {
        const d = distanceToSegment(cursorGrid.x, cursorGrid.y, prev.x, prev.y, p.x, p.y);
        if (d <= CURSOR_HIT_RADIUS) {
          names.add(name);
          break;
        }
      }
      prev = p;
    }
  }

  // § POIs — POI markers are point objects, hit the same way as a street
  // vertex: within CURSOR_HIT_RADIUS grid units of the cursor's center.
  for (const poi of allPois()) {
    const p = projectToGrid(poi.lat, poi.lon, viewportBbox);
    if (Math.hypot(cursorGrid.x - p.x, cursorGrid.y - p.y) <= CURSOR_HIT_RADIUS) {
      names.add(poi.name);
    }
  }

  return names.size ? Array.from(names).join(' & ') : null;
}

// § POIs — the anchor plus every additional POI, as a flat list of
// { name, lat, lon }.
function allPois() {
  const pois = [];
  if (lastAnchorName) pois.push({ name: lastAnchorName, lat: lastAnchorLat, lon: lastAnchorLon });
  pois.push(...additionalPois);
  return pois;
}

// § Command / hotkey mapping — cursor moves one display pixel per press, no
// acceleration. Shared by both the arrow keys and the Dot Pad's dots 3/2/5/6.
function moveCursor(dx, dy) {
  const viewportBbox = getViewportBbox();
  const current = cursorGridPosition(viewportBbox);
  if (!current) return;
  const b = mapGridBounds();
  const newGridX = clamp(current.x + dx, 0, b.width - 1);
  const newGridY = clamp(current.y + dy, 0, b.height - 1);

  // § Cursor and hit testing — hitting the edge of the viewport pans
  // instead of stopping there, inheriting normal Pan Behavior as-is
  // (including Edge of Map, tone and all, if that pan would itself exceed
  // the fetched data). moveCursor is always called with exactly one of
  // dx/dy nonzero, so the sign of whichever is nonzero gives the direction.
  if (newGridX === current.x && newGridY === current.y) {
    const direction = dx < 0 ? 'west' : dx > 0 ? 'east' : dy < 0 ? 'north' : 'south';
    panMap(direction);
    return;
  }

  const newPos = gridToLatLon(newGridX, newGridY, viewportBbox);
  cursorLat = newPos.lat;
  cursorLon = newPos.lon;
  updateCursorVisual();

  const names = currentObjectNames();
  setMessage(names || 'No street');

  if (currentDevice) {
    sendGraphicToDevice(currentDevice);
  }
}

// § Pan Behavior — an explicit pan carries the cursor's fixed real-world
// position along with it if (and only if) the pan would otherwise push that
// position past the edge OPPOSITE the pan direction (the "trailing" edge).
// Without this, keepCursorInView (called from refreshMap right after) would
// see the cursor fall outside the new viewport and silently shift the
// viewport back toward it -- fighting the pan the user just asked for, with
// no Edge of Map message since panMap's own edge check already passed. From
// the user's perspective, repeated presses in the same direction just stop
// doing anything once the cursor is close enough to the trailing edge.
//
// This deliberately only fires for the trailing edge: a cursor pinned at
// the LEADING edge (e.g. from moveCursor's own edge-triggered pan) is left
// untouched, since that's the existing, correct behavior -- the cursor
// naturally ends up further from that edge as the viewport moves under it.
// Shifting by exactly latStep/lonStep (the same amount the viewport itself
// just moved) restores the cursor to the same position relative to the new
// viewport that it had relative to the old one, which was already safely
// in view -- so keepCursorInView finds nothing left to correct.
function carryCursorPastTrailingEdge(direction, latStep, lonStep) {
  if (cursorLat === null) return;
  const viewportBbox = getViewportBbox();
  if (!viewportBbox) return;
  const b = mapGridBounds();
  const p = projectToGrid(cursorLat, cursorLon, viewportBbox);

  if (direction === 'south' && p.y < 0) {
    cursorLat -= latStep;
  } else if (direction === 'north' && p.y > b.height - 1) {
    cursorLat += latStep;
  } else if (direction === 'east' && p.x < 0) {
    cursorLon += lonStep;
  } else if (direction === 'west' && p.x > b.width - 1) {
    cursorLon -= lonStep;
  }
}

// § Pan Behavior — moves the viewport by PAN_AMOUNT_FRACTION of its current
// width/height. Rejected (viewport unchanged) if the move would push the
// viewport past the edge of the fetched data; the message field reports
// "Edge of Map" and a tone plays (see § Sound cues), per spec. This is a
// tone from the computer's own speakers, not the physical Dot Pad beeping --
// the vendored SDK doesn't expose a device-side beep/vibrate.
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
    playEdgeOfMapTone();
    return;
  }

  viewportCenterLat = newLat;
  viewportCenterLon = newLon;
  carryCursorPastTrailingEdge(direction, latStep, lonStep);
  refreshMap();
  announcePositionRelativeToAnchor();
}

// § Scale behavior — steps through SCALE_PRESETS_FT; delta is +1 ("[",
// increase scale/zoom out) or -1 ("]", decrease scale/zoom in).
function changeScale(delta) {
  setScaleIndex(scaleIndex + delta);
}

// Form controls (the search field, POI/scale dropdowns, tuning number
// fields, dialog checkboxes) all have their own meaning for arrow keys and
// letter keys -- the app-level hotkey handler below must never compete with
// them, or e.g. arrowing through the POI dropdown also moves the map
// cursor. Checking the focused element's tag name (rather than listing
// specific IDs) covers every current and future form control uniformly.
const FORM_CONTROL_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
function isFormControlFocused() {
  return FORM_CONTROL_TAGS.has(document.activeElement && document.activeElement.tagName);
}

document.addEventListener('keydown', (event) => {
  if (isFormControlFocused()) return;

  // § Command / hotkey mapping — label zone toggles work regardless of
  // whether a map is loaded or the Braille Labels dialog is open (the
  // dialog's checkboxes and these hotkeys drive one shared piece of state).
  const labelZoneKeys = { i: 'top', k: 'bottom', j: 'left', l: 'right' };
  if (labelZoneKeys[event.key]) {
    event.preventDefault();
    toggleLabelZone(labelZoneKeys[event.key]);
    return;
  }

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

// § Braille labels — Liang-Barsky segment-vs-rectangle clip. Needed because
// way geometry routinely extends well beyond the current viewport (see
// rasterizeMapToPixels), so a raw Bresenham draw would run straight through
// a reserved label zone on its way to an off-screen endpoint. Returns null
// if the segment doesn't intersect the rect at all.
function clipSegmentToRect(x0, y0, x1, y1, minX, minY, maxX, maxY) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const edges = [
    [-dx, x0 - minX],
    [dx, maxX - x0],
    [-dy, y0 - minY],
    [dy, maxY - y0]
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return {
    x0: x0 + t0 * dx, y0: y0 + t0 * dy,
    x1: x0 + t1 * dx, y1: y0 + t1 * dy
  };
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

// § POIs — a solid 3x3 dot square, all corners filled, for every POI
// marker (anchor and additional alike) -- clearly distinct from the
// cursor's hollow ring, and more prominent than a single dot.
function drawSquarePixels(pixels, w, h, cx, cy) {
  cx = Math.round(cx); cy = Math.round(cy);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      setGridPixel(pixels, w, h, cx + dx, cy + dy);
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
// anchor marker with the Bresenham helpers above. `ways` is already the
// deduped/collapsed/tiered output of processWays (see showAnchor); tier
// decluttering is applied below via the same computeVisibleMaxTier used
// on-screen.
function rasterizeMapToPixels(bbox, ways, anchorLat, anchorLon, displayW, displayH, cursor) {
  const pixels = new Uint8Array(displayW * displayH);
  // § Braille labels — project into the device-pixel sub-rect matching
  // mapGridBounds (scaled from dot units to this device's own reported
  // resolution, same as the cursor scaling below). Segments are clipped to
  // this rect below (see clipSegmentToRect) so a reserved zone actually
  // stays blank, rather than just being where in-bounds points happen to
  // land.
  const b = mapGridBounds();
  const scaleX = displayW / DOT_GRID_WIDTH;
  const scaleY = displayH / DOT_GRID_HEIGHT;
  const rectX = b.offsetX * scaleX;
  const rectY = b.offsetY * scaleY;
  const rectW = b.width * scaleX;
  const rectH = b.height * scaleY;
  // -0.5 matches DotSVG's pixX/pixY: canvas/logical coordinates address the
  // *center* of a display pixel, not its corner (see rasterizeShapes).
  const project = (lat, lon) => ({
    x: rectX + ((lon - bbox.west) / (bbox.east - bbox.west)) * rectW - 0.5,
    y: rectY + ((bbox.north - lat) / (bbox.north - bbox.south)) * rectH - 0.5
  });

  // § Braille labels — way geometry commonly extends well beyond the
  // current viewport (lastBbox is the whole fetched square; bbox here is
  // just the visible window within it), so each segment is clipped to the
  // map rect before drawing rather than relying on setGridPixel's full-
  // canvas bounds check, which would otherwise let a line run straight
  // through a reserved zone on its way to an off-screen endpoint.
  const rectMaxX = rectX + rectW;
  const rectMaxY = rectY + rectH;
  // § Map density evaluation and tier-based decluttering — same cutoff as
  // the on-screen render, so the tactile picture and the SVG never disagree
  // about which streets are currently shown.
  const visibleMaxTier = computeVisibleMaxTier(bbox, ways);
  for (const way of ways) {
    if (way.tier > visibleMaxTier || !way.geometry || way.geometry.length < 2) continue;
    let prev = null;
    for (const pt of way.geometry) {
      const p = project(pt.lat, pt.lon);
      if (prev) {
        const clipped = clipSegmentToRect(prev.x, prev.y, p.x, p.y, rectX, rectY, rectMaxX, rectMaxY);
        if (clipped) drawLinePixels(pixels, displayW, displayH, clipped.x0, clipped.y0, clipped.x1, clipped.y1);
      }
      prev = p;
    }
  }

  const anchor = project(anchorLat, anchorLon);
  if (anchor.x >= rectX && anchor.x <= rectMaxX && anchor.y >= rectY && anchor.y <= rectMaxY) {
    drawSquarePixels(pixels, displayW, displayH, anchor.x, anchor.y);
  }

  for (const poi of additionalPois) {
    const p = project(poi.lat, poi.lon);
    if (p.x >= rectX && p.x <= rectMaxX && p.y >= rectY && p.y <= rectMaxY) {
      drawSquarePixels(pixels, displayW, displayH, p.x, p.y);
    }
  }

  if (cursor) {
    // cursor.x/y are map-relative grid units (see cursorGridPosition), so
    // scale the same way as street projection above, then offset into the
    // device-pixel sub-rect. Clamped so the full 8-dot ring (offsets -1..+2,
    // see drawCursorPixels) always fits within the map region rather than
    // getting dots silently dropped by setGridPixel's own bounds check, or
    // spilling into an adjacent label zone.
    const cx = clamp(rectX + cursor.x * scaleX, rectX + 1, rectX + rectW - 3);
    const cy = clamp(rectY + cursor.y * scaleY, rectY + 1, rectY + rectH - 3);
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
  const cursor = cursorGridPosition(viewportBbox);
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
