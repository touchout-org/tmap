import {
  DotPadSDK,
  DotPadScanner,
  DisplayMode,
  DataCodes
} from './web-sdk-3.0.0/DotPadSDK-3.0.0.js';

// Data sources — see tmap spec.md § Data sources
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// § Local test data cache (dev-only, see test-data/README.md) — set to true
// while testing locally to serve cached geocode+Overpass data for the
// addresses below instead of hitting the real Nominatim/Overpass endpoints.
// Avoids the rate-limit/flakiness these two public instances show under
// repeated same-session testing (see project notes). MUST be false before
// every deploy/push -- the dev-cache banner below exists specifically so
// this is impossible to miss in a screenshot before pushing.
const USE_LOCAL_TEST_DATA_CACHE = false;

// Maps a normalized ("trim + lowercase") search query to its cached dataset
// file under test-data/. Add an entry (and a matching file, built the same
// way as the existing ones -- see test-data/README.md) whenever a new
// address is needed for repeated local testing.
const LOCAL_TEST_DATA_FILES = {
  // Anchors.
  '2318 fillmore st, san francisco, ca': 'test-data/2318-fillmore-st-san-francisco-ca.json',
  '1516 hearst ave, berkeley, ca': 'test-data/1516-hearst-ave-berkeley-ca.json',
  '2000 university ave, berkeley, ca': 'test-data/2000-university-ave-berkeley-ca.json',
  '261 6th ave, brooklyn, ny': 'test-data/261-6th-ave-brooklyn-ny.json',
  // Near-POIs (within 0.5mi of the matching anchor above -- joins the
  // current map as an additional POI). See test-data/README.md for exact
  // measured distances.
  '2323 fillmore st, san francisco, ca': 'test-data/2323-fillmore-st-san-francisco-ca.json',
  '2199 sacramento st, san francisco, ca': 'test-data/2199-sacramento-st-san-francisco-ca.json',
  '1600 hearst ave, berkeley, ca': 'test-data/1600-hearst-ave-berkeley-ca.json',
  '1400 hearst ave, berkeley, ca': 'test-data/1400-hearst-ave-berkeley-ca.json',
  '2100 university ave, berkeley, ca': 'test-data/2100-university-ave-berkeley-ca.json',
  '2224 shattuck ave, berkeley, ca': 'test-data/2224-shattuck-ave-berkeley-ca.json',
  // All three within 0.5mi of the 261 6th Ave anchor -- together they make
  // a real multi-POI map without needing a too-far case of their own.
  '592 carroll st, brooklyn, ny': 'test-data/592-carroll-st-brooklyn-ny.json',
  '26 garfield pl, brooklyn, ny': 'test-data/26-garfield-pl-brooklyn-ny.json',
  '851 president st, brooklyn, ny': 'test-data/851-president-st-brooklyn-ny.json',
  // Too-far POIs (beyond 0.5mi of the matching anchor above -- triggers the
  // "that's too far for one map" dialog; each also has full ways data, so
  // "Show new location" can promote it to a new anchor from cache too). All
  // four anchors above are >0.5mi from each other too, so any one also
  // works as a too-far POI relative to any of the others (Brooklyn is
  // obviously far from all three CA anchors).
  '2400 fillmore st, san francisco, ca': 'test-data/2400-fillmore-st-san-francisco-ca.json',
  '1801 california st, san francisco, ca': 'test-data/1801-california-st-san-francisco-ca.json',
  '1520 walnut st, berkeley, ca': 'test-data/1520-walnut-st-berkeley-ca.json'
};

// In-memory cache of already-fetched test-data files, so geocode() and
// fetchWays() (both of which consult the same cached dataset for a given
// search) don't each trigger their own fetch of the same JSON file.
const localTestDataCache = new Map();

// Returns { geocode, ways } for a cached query, or null if the cache is off
// or this query isn't one of the cached addresses (in which case callers
// fall back to the real network request, same as ever).
async function loadLocalTestData(query) {
  if (!USE_LOCAL_TEST_DATA_CACHE || !query) return null;
  const file = LOCAL_TEST_DATA_FILES[query.trim().toLowerCase()];
  if (!file) return null;
  if (localTestDataCache.has(file)) return localTestDataCache.get(file);
  const res = await fetch(file);
  if (!res.ok) throw new Error('local-test-data-missing: ' + file);
  const data = await res.json();
  localTestDataCache.set(file, data);
  return data;
}

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
// Revisit once a non-public/self-hosted Overpass endpoint is used -- this
// constraint is about the fetch payload itself, independent of whatever
// processWays does (or doesn't) do with it afterward.
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

// § Street importance tiers — every way gets tagged with a tier in
// processWays, purely as data for the Map Complexity filter (see
// MAP_COMPLEXITY_LEVELS/visibleWays). An unrecognized highway value (the
// Overpass query has no class filter, so lifecycle tags like construction/
// proposed can come through) falls to tier 7 rather than crashing.
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

// § Editing the Map — Map Complexity radio options, most to least detail.
// Each level is a maxTier cutoff (a way is visible only if its tier is <=
// maxTier) -- a strict nested ladder (highways ⊂ major ⊂ simplified ⊂ all),
// not independent per-tier toggles. Index in this array doubles as the
// 1-4 hotkey mapping (see the keydown handler) and the Edit Map dialog's
// radio button order.
const MAP_COMPLEXITY_LEVELS = [
  { label: 'All streets and pathways', maxTier: MAX_TIER },
  { label: 'Simplified neighborhoods', maxTier: 5 },
  { label: 'Major streets', maxTier: 4 },
  { label: 'Major highways', maxTier: 1 }
];

// A street "hits" the cursor when it passes within this many grid units of
// the cursor's center — an approximation of "intersects the cursor's edge"
// (tmap spec.md § Cursor and hit testing) sized to roughly match the small
// 4x4 cursor footprint. To be refined once this is visible on hardware.
const CURSOR_HIT_RADIUS = 2;

const browserWarning = document.getElementById('browser-warning');
const devCacheBanner = document.getElementById('dev-cache-banner');
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
const poiListSelect = document.getElementById('poi-list');
const btnDropPin = document.getElementById('btn-drop-pin');
const poiTooFarDialog = document.getElementById('poi-too-far-dialog');
const poiTooFarMessage = document.getElementById('poi-too-far-message');
const btnPoiShowAnyway = document.getElementById('btn-poi-show-anyway');
const btnPoiCancel = document.getElementById('btn-poi-cancel');
const customPoiDialog = document.getElementById('custom-poi-dialog');
const customPoiForm = document.getElementById('custom-poi-form');
const customPoiNameInput = document.getElementById('custom-poi-name');
const btnCustomPoiCancel = document.getElementById('btn-custom-poi-cancel');
const btnEditMap = document.getElementById('btn-edit-map');
const editMapDialog = document.getElementById('edit-map-dialog');
const editMapPoisList = document.getElementById('edit-map-pois-list');
const editMapVisibleStreetsList = document.getElementById('edit-map-visible-streets-list');
const editMapHiddenFeaturesList = document.getElementById('edit-map-hidden-features-list');
const editMapComplexityList = document.getElementById('edit-map-complexity-list');
const btnEditMapClose = document.getElementById('btn-edit-map-close');

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
// lastRawWays is exactly what Overpass returned; lastWays is
// processWays(lastRawWays) -- currently just tags each way with its tier
// (manual-declutter experiment, see git tag `pre-manual-declutter` on main
// for the dedup/collapse stages that used to also run here), but kept as a
// separate step/variable in case more gets added back later.
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

// § Editing the Map — names of POIs/streets the user has unchecked in the
// Edit Map dialog (Streets and Pedestrian Pathways are merged into one
// name-keyed set now that the dialog no longer classifies by way class).
// Hidden features stay in additionalPois/lastWays (and in the dialog's own
// Hidden Streets/POIs list, so they can be turned back on) but are skipped
// by rendering, hit-testing, and the tactile raster -- see visiblePois() /
// visibleWays(). Reset whenever a brand-new anchor discards the old map
// (see showAnchor); untouched by pan/scale/complexity changes, which reuse
// the same fetched data. Every change here takes effect immediately (the
// Edit Map dialog has no Save/Cancel staging step) and refreshes the map.
let hiddenPoiNames = new Set();
let hiddenStreetNames = new Set();

// § Editing the Map — index into MAP_COMPLEXITY_LEVELS for the Map
// Complexity radio group's current selection. Independent of
// hiddenStreetNames -- a manually-hidden street stays hidden regardless of
// complexity level, and changing complexity never touches hiddenStreetNames
// (see visibleWays(), which ANDs both filters). Reset to 0 ("All streets
// and pathways") on a brand-new anchor.
let mapComplexityIndex = 0;

// § Command / hotkey mapping — the 0 hotkey's "show only the cursor" mode.
// A display-only override, not a real edit: when true, visibleWays()/
// visiblePois() both short-circuit to empty, so rendering, the tactile
// raster, and cursor hit-testing all show nothing but the cursor -- but
// hiddenStreetNames/hiddenPoiNames/mapComplexityIndex are never touched,
// so toggling this back off restores exactly whatever was showing before.
// The on-screen POI dropdown is unaffected either way (it's a navigation
// aid keyed off hiddenPoiNames directly, not visiblePois()). Reset to
// false on a brand-new anchor, same as the other Edit Map state.
let cursorOnlyMode = false;

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

// § Local test data cache — unmissable visual flag (not just a code
// comment) that this build is serving cached data instead of hitting the
// real Nominatim/Overpass endpoints, so it can't accidentally slip into a
// deploy/push unnoticed.
if (USE_LOCAL_TEST_DATA_CACHE) {
  devCacheBanner.hidden = false;
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

// § Editing the Map — sets Map Complexity to the given MAP_COMPLEXITY_LEVELS
// index, whether triggered by the 1-4 hotkeys or by picking the radio
// button directly in the Edit Map dialog -- both go through this one
// function so the message field always announces the change (per the
// Message display architecture) and the dialog's own radio stays in sync
// no matter which path triggered it.
function setMapComplexity(index) {
  if (index === mapComplexityIndex) return;
  mapComplexityIndex = index;
  setMessage(`${MAP_COMPLEXITY_LEVELS[index].label} visible.`);
  refreshMap();
  const radio = editMapComplexityList.querySelector(`input[value="${index}"]`);
  if (radio) radio.checked = true;
}

// § Command / hotkey mapping — the 0 hotkey. See cursorOnlyMode above for
// what it does and doesn't affect.
function toggleCursorOnlyMode() {
  cursorOnlyMode = !cursorOnlyMode;
  setMessage(cursorOnlyMode ? 'Cursor only' : 'Features restored');
  refreshMap();
}


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
    await createNewAnchor(displayName, shortName, lat, lon, query);
    return;
  }

  // § Additional POIs — a location entered after the anchor exists either
  // joins the current map (within the POI distance threshold) or requires
  // discarding it for a new one, depending on distance from the anchor.
  const { eastFt, northFt } = feetOffsetFrom(lat, lon, lastAnchorLat, lastAnchorLon);
  const distFt = Math.hypot(eastFt, northFt);
  const thresholdFt = (POI_DISTANCE_THRESHOLD_MILES * MILES_TO_METERS) / FEET_TO_METERS;

  if (distFt > thresholdFt) {
    promptTooFarPoi(displayName, shortName, lat, lon, distFt, query);
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
async function createNewAnchor(displayName, shortName, lat, lon, query) {
  const bbox = squareBoundingBox(lat, lon, POI_DISTANCE_THRESHOLD_MILES);
  let ways;
  try {
    ways = await fetchWays(bbox, query);
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
function promptTooFarPoi(displayName, shortName, lat, lon, distFt, query) {
  pendingFarPoi = { displayName, shortName, lat, lon, query };
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
  if (pending) createNewAnchor(pending.displayName, pending.shortName, pending.lat, pending.lon, pending.query);
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

// § Additional POIs — "Drop Pin" adds a custom, user-named POI at the
// cursor's current position, via the same addAdditionalPoi path as any
// other POI -- so it shows up in the POI dropdown, the Edit Map dialog,
// rendering, hit-testing, and the tactile raster exactly like an
// address pulled from OSM, with no separate plumbing needed.
function openCustomPoiDialog() {
  customPoiNameInput.value = '';
  customPoiDialog.showModal();
}

btnDropPin.addEventListener('click', openCustomPoiDialog);

customPoiForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = customPoiNameInput.value.trim();
  if (!name) return;
  customPoiDialog.close();
  addAdditionalPoi(name, cursorLat, cursorLon);
});

btnCustomPoiCancel.addEventListener('click', () => customPoiDialog.close());

// § POIs — the anchor is always the first entry (value "anchor"), followed
// by every additional POI (value = its index into additionalPois).
// § Editing the Map — a POI hidden via the Edit Map dialog is left out of
// this nav list too (it's no longer "on the map" to pan to), but option
// values for additional POIs still carry their real additionalPois index,
// not a position within this filtered list -- the change handler below
// indexes additionalPois directly.
function renderPoiList() {
  poiListSelect.innerHTML = '';
  if (lastAnchorName && !hiddenPoiNames.has(lastAnchorName)) {
    const anchorOption = document.createElement('option');
    anchorOption.value = 'anchor';
    anchorOption.textContent = lastAnchorName;
    poiListSelect.appendChild(anchorOption);
  }
  additionalPois.forEach((poi, index) => {
    if (hiddenPoiNames.has(poi.name)) return;
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

// § Editing the Map — every street/pathway name currently in lastWays
// (regardless of hidden state -- the dialog must still list a hidden
// feature so it can be turned back on), merged into one alphabetical list
// regardless of way class. The old Streets/Pedestrian Pathways split
// (classified per-way, not per-name) is gone along with its sync quirk --
// Visible/Hidden Streets are both keyed by name alone now, same as
// hiddenStreetNames itself.
function collectStreetNames() {
  const names = new Set();
  for (const way of lastWays) {
    const name = way.tags && way.tags.name;
    if (name) names.add(name);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

// § Editing the Map — fills one group's list with a clickable button per
// item (no checkboxes -- section membership alone conveys visible/hidden
// state, so a checkbox would be redundant). Each item is { name, kind };
// kind is only meaningful in Hidden Features (see collectHiddenFeatures),
// where it's needed to route a restore back to the right home section.
function populateEditMapButtons(listContainer, items, idPrefix) {
  listContainer.innerHTML = '';
  if (items.length === 0) {
    const none = document.createElement('p');
    none.textContent = '(none)';
    listContainer.appendChild(none);
    return;
  }
  items.forEach(({ name, kind }, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${idPrefix}-${index}`;
    button.textContent = name;
    button.dataset.name = name;
    if (kind) button.dataset.kind = kind;
    listContainer.appendChild(button);
  });
}

function editMapButtons(listContainer) {
  return [...listContainer.querySelectorAll('button')];
}

// § Editing the Map — after a toggle, focus stays in the section it came
// from, landing on whatever item now sits at the same position (the next
// item, or the previous one if it was last) -- not on the item's new
// location. Only falls back to destList (focusing this name's button
// there) if sourceList is now completely empty. Shared by POIs, Visible
// Streets, and Hidden Features so all three sections behave the same way.
function focusAfterEditMapToggle(sourceList, sourceIndex, destList, name) {
  const remaining = editMapButtons(sourceList);
  if (remaining.length > 0) {
    remaining[Math.min(sourceIndex, remaining.length - 1)].focus();
  } else {
    const moved = editMapButtons(destList).find((b) => b.dataset.name === name);
    if (moved) moved.focus();
  }
}

// § Editing the Map — currently-visible POIs, as buttons for the POIs
// section. Re-run after any POI hide/restore.
function renderEditMapPois() {
  const items = allPois().filter((poi) => !hiddenPoiNames.has(poi.name)).map((poi) => ({ name: poi.name }));
  populateEditMapButtons(editMapPoisList, items, 'edit-map-poi');
}

// § Editing the Map — currently-visible streets, as buttons for the
// Visible Streets section. Re-run after any street hide/restore.
function renderVisibleStreets() {
  const items = collectStreetNames().filter((name) => !hiddenStreetNames.has(name)).map((name) => ({ name }));
  populateEditMapButtons(editMapVisibleStreetsList, items, 'edit-map-visible-street');
}

// § Editing the Map — Hidden Features combines hidden POIs and hidden
// streets into one list (per user request -- a shared destination for
// anything hidden, not two parallel hidden-POIs/hidden-streets sections).
// Hidden POIs are listed first (in their normal POI order -- anchor, then
// additional POIs in add order), hidden streets alphabetically after.
function renderHiddenFeatures() {
  const hiddenPois = allPois()
    .filter((poi) => hiddenPoiNames.has(poi.name))
    .map((poi) => ({ name: poi.name, kind: 'poi' }));
  const hiddenStreets = collectStreetNames()
    .filter((name) => hiddenStreetNames.has(name))
    .map((name) => ({ name, kind: 'street' }));
  populateEditMapButtons(editMapHiddenFeaturesList, [...hiddenPois, ...hiddenStreets], 'edit-map-hidden-feature');
}

// § Editing the Map — clicking a visible POI removes it: hides it (moves
// it into Hidden Features), refreshes the map and the on-screen POI
// dropdown, and applies the shared focus rule above.
function handlePoiButtonClick(event) {
  const button = event.target;
  if (!button.matches('button')) return;
  const name = button.dataset.name;
  const sourceIndex = editMapButtons(editMapPoisList).indexOf(button);
  hiddenPoiNames.add(name);
  renderEditMapPois();
  renderHiddenFeatures();
  renderPoiList();
  refreshMap();
  setMessage(`${name} removed`);
  focusAfterEditMapToggle(editMapPoisList, sourceIndex, editMapHiddenFeaturesList, name);
}

editMapPoisList.addEventListener('click', handlePoiButtonClick);

// § Editing the Map — clicking a visible street removes it: hides it
// (moves it into Hidden Features), refreshes the map, and applies the
// shared focus rule above.
function handleVisibleStreetButtonClick(event) {
  const button = event.target;
  if (!button.matches('button')) return;
  const name = button.dataset.name;
  const sourceIndex = editMapButtons(editMapVisibleStreetsList).indexOf(button);
  hiddenStreetNames.add(name);
  renderVisibleStreets();
  renderHiddenFeatures();
  refreshMap();
  setMessage(`${name} removed`);
  focusAfterEditMapToggle(editMapVisibleStreetsList, sourceIndex, editMapHiddenFeaturesList, name);
}

editMapVisibleStreetsList.addEventListener('click', handleVisibleStreetButtonClick);

// § Editing the Map — clicking a Hidden Features item restores it to its
// home section (POIs or Visible Streets, per its kind), refreshes the map
// (and the POI dropdown, for a POI), and applies the shared focus rule.
function handleHiddenFeatureButtonClick(event) {
  const button = event.target;
  if (!button.matches('button')) return;
  const name = button.dataset.name;
  const kind = button.dataset.kind;
  const sourceIndex = editMapButtons(editMapHiddenFeaturesList).indexOf(button);
  if (kind === 'poi') {
    hiddenPoiNames.delete(name);
    renderEditMapPois();
    renderPoiList();
  } else {
    hiddenStreetNames.delete(name);
    renderVisibleStreets();
  }
  renderHiddenFeatures();
  refreshMap();
  setMessage(`${name} restored`);
  const destList = kind === 'poi' ? editMapPoisList : editMapVisibleStreetsList;
  focusAfterEditMapToggle(editMapHiddenFeaturesList, sourceIndex, destList, name);
}

editMapHiddenFeaturesList.addEventListener('click', handleHiddenFeatureButtonClick);

// § Editing the Map — Map Complexity radio group, one row per
// MAP_COMPLEXITY_LEVELS entry (see setMapComplexity for what picking one
// does).
function populateEditMapComplexity(listContainer) {
  listContainer.innerHTML = '';
  MAP_COMPLEXITY_LEVELS.forEach((level, index) => {
    const id = `edit-map-complexity-${index}`;
    const row = document.createElement('div');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'map-complexity';
    radio.id = id;
    radio.value = String(index);
    radio.checked = index === mapComplexityIndex;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = level.label;
    row.appendChild(radio);
    row.appendChild(label);
    listContainer.appendChild(row);
  });
}

editMapComplexityList.addEventListener('change', (event) => {
  const radio = event.target;
  if (!radio.matches('input[type="radio"]')) return;
  setMapComplexity(Number(radio.value));
});

// § Editing the Map — rebuilt from current map data every time the dialog
// opens, so it always reflects whatever's actually on the map (including
// features added since the dialog was last open). No Save/Cancel step --
// every button/radio here applies immediately (see handlePoiButtonClick,
// handleVisibleStreetButtonClick, handleHiddenFeatureButtonClick,
// setMapComplexity).
function openEditMapDialog() {
  renderEditMapPois();
  renderVisibleStreets();
  renderHiddenFeatures();
  populateEditMapComplexity(editMapComplexityList);
  editMapDialog.showModal();
}

btnEditMap.addEventListener('click', openEditMapDialog);

btnEditMapClose.addEventListener('click', () => editMapDialog.close());

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
  const cached = await loadLocalTestData(query);
  if (cached) return cached.geocode;

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

// § Data ingestion and cleaning pipeline, step 2 (Fetch). searchQuery is the
// original user-typed search text (not the Overpass QL below) -- passed
// through purely so this can be matched against the local test data cache,
// same key geocode() uses for the same search.
async function fetchWays(bbox, searchQuery) {
  const cached = await loadLocalTestData(searchQuery);
  if (cached) return cached.ways;

  const overpassQuery = `[out:json][timeout:25];way["highway"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out geom;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(overpassQuery)
  });
  if (!res.ok) throw new Error('overpass-failed');
  const data = await res.json();
  return data.elements || [];
}

// § Data ingestion and cleaning pipeline — the automated roadway/pedestrian
// dedup and carriageway collapse that used to run here are still removed
// for the manual-editing experiment (see git tag `pre-manual-declutter` on
// main for that code, and the project's own notes on why; a later,
// name-match-based "Redundant sidewalks" filter was also tried and retired
// -- see git history around commit `7324c55` if it's ever wanted back).
// Tier assignment came back, though: every way still gets tagged with its
// street-importance tier, purely as data for the Map Complexity filter (see
// MAP_COMPLEXITY_LEVELS/visibleWays) -- nothing here hides anything
// automatically.
function processWays(rawWays) {
  for (const way of rawWays) {
    way.tier = HIGHWAY_TIERS[way.tags && way.tags.highway] || MAX_TIER;
  }
  return rawWays;
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

  // § Editing the Map — a brand-new anchor is a brand-new feature set;
  // whatever was hidden on the discarded map doesn't carry over.
  hiddenPoiNames = new Set();
  hiddenStreetNames = new Set();
  mapComplexityIndex = 0;
  cursorOnlyMode = false;

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
  btnEditMap.disabled = false;
  btnDropPin.disabled = false;
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
    renderStreetsAndAnchor(svgNs, viewportBbox, visibleWays(), lastAnchorLat, lastAnchorLon);
    drawLabelContent(svgNs, computeLabelPlacements(), mapGridBounds());
    // Cursor is a single reused element, drawn last (on top). Only appended
    // once there's a real viewport/position -- cursorSvg.hidden doesn't
    // reliably suppress rendering for an SVG element, so keeping it out of
    // the DOM entirely pre-search (as before this function existed) avoids
    // showing a stray circle at its default (0,0) position.
    mapSvg.appendChild(cursorSvg);
  }
}

// § Braille labels / § Label creation — ported from the OSM Data Mine
// experiment site's "Braille Labels" tab (experiment/app.js) once that
// tab validated the algorithm against real Overpass data. See tmap
// spec.md's Label creation section for the numbered steps this
// implements. Operates on every name currently in lastWays (not
// visibleWays()) -- per spec, "No two streets on the map, even if
// they're not both being displayed currently, may have the same
// abbreviation."
const LABEL_VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'A', 'E', 'I', 'O', 'U']);

// § Label creation, step 1 — strip vowels from each word of the name,
// except when a word (once its own punctuation is stripped) is a single
// vowel letter on its own, e.g. "A Street" or "E. 12th St." -- those words
// are kept whole. Runs on the original whitespace-separated words, since
// word boundaries still need to exist for this check; spaces themselves
// aren't removed until the next step.
function stripVowelsPreservingSingleLetterWords(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lettersOnly = word.replace(/[^A-Za-z]/g, '');
      if (lettersOnly.length === 1 && LABEL_VOWELS.has(lettersOnly)) return word;
      const vowelsStripped = [...word].filter((ch) => !LABEL_VOWELS.has(ch)).join('');
      return compressDoubledLetters(vowelsStripped);
    })
    .join(' ');
}

// § Label creation, step 1 (cont.) — doubled letters are a wasted phonetic
// cue for a 3-character abbreviation, so collapse each run of the same
// letter (case-insensitively) down to one occurrence, e.g. "ddsn" ->
// "dsn". Only consecutive runs collapse -- non-adjacent repeats (like the
// two t's in "Strt") are left alone, since those aren't "doubled letters"
// in the sense meant here.
function compressDoubledLetters(s) {
  let result = '';
  for (const ch of s) {
    const prev = result[result.length - 1];
    if (!prev || prev.toLowerCase() !== ch.toLowerCase()) result += ch;
  }
  return result;
}

// § Label creation, steps 1-3 — the full candidate string a street's label
// is drawn from: vowels stripped (per the single-letter-word exception),
// every space and punctuation character removed, lowercased.
function labelCandidateString(name) {
  const vowelsStripped = stripVowelsPreservingSingleLetterWords(name);
  return vowelsStripped.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

// § Label creation, steps 4-7 — assigns every street name a unique
// 3-character label. Processes names in the given order (alphabetical, so
// output is stable/reproducible run to run) -- uniqueness resolution is
// first-come-first-served, so earlier names in the list get first claim
// on their natural 3-letter window.
function assignBrailleLabels(names) {
  const used = new Set();
  const labels = new Map();

  for (const name of names) {
    const candidate = labelCandidateString(name);
    const label = findUniqueLabel(candidate, used)
      || findUniqueLabelWalkingMiddle(candidate, used)
      || findUniqueDigitSuffix(candidate, used);
    used.add(label);
    labels.set(name, label);
  }

  return labels;
}

// § Label creation, steps 4-5 — try the candidate string's first three
// characters; on collision, keep the first two characters fixed and walk
// only the third character forward through the rest of the candidate
// string, rather than sliding the whole 3-character window. This keeps
// same-prefix streets (e.g. "University Avenue"/"University Walk", or
// "Virginia Gardens"/"Virginia Street") looking and feeling as similar as
// the data allows -- only the one character that actually needs to differ
// changes, instead of the whole label shifting to a different, unrelated
// stretch of the name. A candidate shorter than 3 characters is padded
// with dashes (the label's only allowed punctuation, per the Label
// creation intro) rather than skipped -- there's nothing to walk through
// in that case. Returns null if every remaining character collides too,
// so the caller can fall through to the digit-suffix step.
function findUniqueLabel(candidate, used) {
  if (candidate.length < 3) {
    const label = padLabel(candidate);
    return used.has(label) ? null : label;
  }
  const prefix = candidate.slice(0, 2);
  for (let i = 2; i < candidate.length; i++) {
    const label = prefix + candidate[i];
    if (!used.has(label)) return label;
  }
  return null;
}

function padLabel(s) {
  return (s + '---').slice(0, 3);
}

// § Label creation, step 5b — every prefix-anchored window (step 5)
// collided too, so try a different anchor: keep the candidate's first and
// last characters fixed (the label's 1st and 3rd positions), and walk the
// label's middle position through the candidate string's interior
// characters. A different combinatorial space than step 5 (which only
// ever anchors the first two characters), so it can still find a unique
// label for a longer candidate string even after step 5 is exhausted.
// Returns null if that's exhausted too (or the candidate is too short to
// have a distinct first/middle/last), so the caller can fall through to
// the digit-suffix step.
function findUniqueLabelWalkingMiddle(candidate, used) {
  if (candidate.length < 3) return null;
  const first = candidate[0];
  const last = candidate[candidate.length - 1];
  for (let j = 1; j < candidate.length - 1; j++) {
    const label = first + candidate[j] + last;
    if (!used.has(label)) return label;
  }
  return null;
}

// § Label creation, step 7 — steps 5 and 6 both collided on every
// attempt, so fall back to the candidate's first two characters (padded
// with a dash if the candidate itself is shorter than 2 characters) plus
// a single trailing digit, trying 0-9 in order until one is unique.
function findUniqueDigitSuffix(candidate, used) {
  const prefix = (candidate.slice(0, 2) + '-').slice(0, 2);
  for (let digit = 0; digit <= 9; digit++) {
    const label = prefix + String(digit);
    if (!used.has(label)) return label;
  }
  // All 10 digits already taken by this exact prefix -- vanishingly
  // unlikely for any real street list, but return a guaranteed-unique
  // placeholder rather than a duplicate label.
  let n = 0;
  while (used.has(`?${n}`)) n++;
  return `?${n}`;
}

// § Label placement — constants from tmap spec.md's placement rules. The
// spec's "2 display-pixels" of whitespace is expressed in this doc's own
// dot-grid units (a "display-pixel" here means one dot, same as the
// zone-sizing math above).
const LABEL_WHITESPACE_DOTS = 2;
const LABEL_ANGLE_THRESHOLD_DEGREES = 45;

// § Label placement, step 1 — fixed edge processing order.
const LABEL_EDGE_ORDER = ['top', 'right', 'bottom', 'left'];

// § Label placement — a label's actual along-edge content span: how much
// room its own rendered dots take, not the zone's fixed depth. 8 dots for
// top/bottom (the horizontal character span -- 2 dots/char x 3 chars + 1
// dot kerning x 2 gaps, matching labelDotPositions' own charSpan exactly),
// 3 dots for left/right (just the character height, since a label always
// reads horizontally regardless of which edge it's on -- see
// labelDotPositions). This governs both same-edge whitespace and how far
// a label can reach before needing corner space; using the zone's full
// depth (LABEL_ZONE_DOT_COLS/ROWS, which already bakes in the 2-dot
// map-side padding) here double-counts that padding as if it were also
// inter-label spacing, over-restricting both.
function labelFootprintDots(edge) {
  return edge === 'top' || edge === 'bottom'
    ? LABEL_CHAR_WIDTH_DOTS * 3 + LABEL_CHAR_KERNING_DOTS * 2
    : LABEL_CHAR_HEIGHT_DOTS;
}

// § Label placement — which of the map rectangle's four edges (if any) a
// map-relative grid point sits on. Checked in LABEL_EDGE_ORDER so a
// (vanishingly unlikely) exact corner point resolves to one edge
// consistently rather than being ambiguous.
function edgeAtGridPoint(x, y, gridBounds) {
  const EPSILON = 1e-6;
  if (Math.abs(y) < EPSILON) return 'top';
  if (Math.abs(x - gridBounds.width) < EPSILON) return 'right';
  if (Math.abs(y - gridBounds.height) < EPSILON) return 'bottom';
  if (Math.abs(x) < EPSILON) return 'left';
  return null;
}

// § Label placement — every point where a way's geometry crosses one of
// the map rectangle's four edges, using the same Liang-Barsky clip
// already used for rendering (see clipSegmentToRect) -- a way's raw
// geometry routinely continues well beyond the current viewport, so a
// clipped segment endpoint that lands exactly on the rectangle boundary
// (rather than ending strictly inside it) is a genuine "this street
// continues past this edge" crossing. dx/dy is the crossing segment's own
// direction (unaffected by clipping, which only truncates a segment's
// length, not its slope), used for the angle rule.
function findEdgeCrossings(way, viewportBbox, gridBounds) {
  const crossings = [];
  const geometry = way.geometry || [];
  let prev = null;
  for (const pt of geometry) {
    const p = projectToGrid(pt.lat, pt.lon, viewportBbox);
    if (prev) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const clipped = clipSegmentToRect(prev.x, prev.y, p.x, p.y, 0, 0, gridBounds.width, gridBounds.height);
      if (clipped && (dx !== 0 || dy !== 0)) {
        for (const corner of [[clipped.x0, clipped.y0], [clipped.x1, clipped.y1]]) {
          const edge = edgeAtGridPoint(corner[0], corner[1], gridBounds);
          if (edge) crossings.push({ edge, x: corner[0], y: corner[1], dx, dy });
        }
      }
    }
    prev = p;
  }
  return crossings;
}

// § Label placement — "intersects the active edge at more than 45
// degrees." Both top/bottom (horizontal) and left/right (vertical) edges
// reduce to the same angle-from-horizontal measurement, just compared on
// opposite sides of the 45-degree threshold: a street must run closer to
// perpendicular than parallel to the edge it's crossing. Exactly 45
// degrees fails on every edge, per the spec's "45 degrees or less" wording.
function crossingAngleOk(crossing) {
  const angleFromHorizontal = Math.atan2(Math.abs(crossing.dy), Math.abs(crossing.dx)) * 180 / Math.PI;
  if (crossing.edge === 'top' || crossing.edge === 'bottom') {
    return angleFromHorizontal > LABEL_ANGLE_THRESHOLD_DEGREES;
  }
  return angleFromHorizontal < LABEL_ANGLE_THRESHOLD_DEGREES;
}

// § Label placement — whether any part of a way's geometry is actually
// visible within the current map rectangle (as opposed to passing nearby
// or only appearing in the wider fetch square) -- used by
// visibleSegmentCounts below. Same clip as findEdgeCrossings, just
// checking for any intersection at all rather than collecting crossing
// points.
function wayHasVisiblePortion(way, viewportBbox, gridBounds) {
  const geometry = way.geometry || [];
  let prev = null;
  for (const pt of geometry) {
    const p = projectToGrid(pt.lat, pt.lon, viewportBbox);
    if (prev) {
      if (clipSegmentToRect(prev.x, prev.y, p.x, p.y, 0, 0, gridBounds.width, gridBounds.height)) return true;
    }
    prev = p;
  }
  return false;
}

// § Label placement — how many of a street's own way-segments have any
// part visible in the current viewport, per street name. Replaces the
// earlier length-based "stub street" exclusion: that rule measured the
// length of the one segment crossing a given edge, which wrongly
// penalized substantial streets whose specific edge-crossing segment
// happened to be short even though the street has plenty of other
// visible segments elsewhere. Segment count is a better proxy for "is
// this a real, significant street on the current display" -- used as a
// tie-breaker in placeLabels, not an exclusion filter, so a street is
// never outright disqualified from labeling by this alone.
function visibleSegmentCounts(ways, viewportBbox, gridBounds) {
  const counts = new Map();
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    if (!name || !wayHasVisiblePortion(way, viewportBbox, gridBounds)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

// § Label placement — every candidate label point across all four edges,
// for every currently-visible way with an assigned label. A candidate
// carries its own intrinsic pass/fail state (the angle rule) but not
// whitespace/dedup, which depend on what else gets placed and are handled
// by placeLabels below. "along" is the crossing's position along whichever
// axis that edge runs (x for top/bottom, y for left/right) -- what step
// 2's left-to-right/top-to-bottom position ordering sorts by, after
// segment count (see placeLabels).
function collectLabelCandidates(ways, viewportBbox, gridBounds, labels) {
  const segmentCounts = visibleSegmentCounts(ways, viewportBbox, gridBounds);
  const candidates = [];
  for (const way of ways) {
    const name = way.tags && way.tags.name;
    if (!name || !labels.has(name)) continue;
    const crossings = findEdgeCrossings(way, viewportBbox, gridBounds);
    if (crossings.length === 0) continue;
    for (const crossing of crossings) {
      if (!crossingAngleOk(crossing)) continue;
      const along = crossing.edge === 'top' || crossing.edge === 'bottom' ? crossing.x : crossing.y;
      candidates.push({
        name, label: labels.get(name), tier: way.tier, edge: crossing.edge, along,
        segmentCount: segmentCounts.get(name) || 0
      });
    }
  }
  return candidates;
}

// § Label placement, steps 1-5 — the placement algorithm proper. Runs two
// passes over the four edges in LABEL_EDGE_ORDER, walking tiers 1-7
// (most to least important) within each edge and candidates by visible
// segment count then position within each tier: a primary pass that skips
// any street already labeled on an earlier-processed edge (step 4, "at
// most one label"), then a final pass over the same candidates without
// that restriction, filling any room left over (step 5) -- which may
// duplicate an existing label or give a first label to a street skipped
// everywhere in the primary pass.
// Returns { top: [...], right: [...], bottom: [...], left: [...] }, each
// entry { name, label, tier, edge, along, footprint }.
function placeLabels(candidates, gridBounds, activeZones) {
  const byEdge = { top: [], right: [], bottom: [], left: [] };
  for (const c of candidates) byEdge[c.edge].push(c);

  const placed = { top: [], right: [], bottom: [], left: [] };
  const labeledNames = new Set();

  // § Braille labels — the four corners are shared, contested space, not
  // owned outright by any one zone: each corner is exactly one label's
  // worth of physical room (LABEL_ZONE_DOT_COLS x LABEL_ZONE_DOT_ROWS),
  // where the two zones meeting there could each place a label if the
  // other doesn't. Only exists when *both* contributing zones are active
  // -- if either is off, gridBounds already leaves no gap there.
  function cornerBox(horizontalEdge, verticalEdge) {
    return {
      x0: verticalEdge === 'left' ? 0 : gridBounds.offsetX + gridBounds.width,
      x1: verticalEdge === 'left' ? gridBounds.offsetX : DOT_GRID_WIDTH,
      y0: horizontalEdge === 'top' ? 0 : gridBounds.offsetY + gridBounds.height,
      y1: horizontalEdge === 'top' ? gridBounds.offsetY : DOT_GRID_HEIGHT
    };
  }

  // Which corner (and its other contributing edge) a candidate would need
  // to reach into, if its footprint extends past its own edge's map-sized
  // core range. Returns null for the common case -- fits entirely within
  // the map's own width/height, no corner involved.
  function cornerNeeded(edge, along, footprint) {
    const half = footprint / 2;
    if (edge === 'top' || edge === 'bottom') {
      if (along - half < 0) return { horizontalEdge: edge, verticalEdge: 'left', neighbor: 'left' };
      if (along + half > gridBounds.width) return { horizontalEdge: edge, verticalEdge: 'right', neighbor: 'right' };
    } else {
      if (along - half < 0) return { horizontalEdge: 'top', verticalEdge: edge, neighbor: 'top' };
      if (along + half > gridBounds.height) return { horizontalEdge: 'bottom', verticalEdge: edge, neighbor: 'bottom' };
    }
    return null;
  }

  // A placed label's absolute (full-canvas) bounding box, for checking
  // corner overlap against another edge's placements.
  function placementBox(p) {
    const half = p.footprint / 2;
    if (p.edge === 'top' || p.edge === 'bottom') {
      return {
        x0: gridBounds.offsetX + p.along - half, x1: gridBounds.offsetX + p.along + half,
        y0: p.edge === 'top' ? 0 : gridBounds.offsetY + gridBounds.height,
        y1: p.edge === 'top' ? gridBounds.offsetY : DOT_GRID_HEIGHT
      };
    }
    return {
      x0: p.edge === 'left' ? 0 : gridBounds.offsetX + gridBounds.width,
      x1: p.edge === 'left' ? gridBounds.offsetX : DOT_GRID_WIDTH,
      y0: gridBounds.offsetY + p.along - half, y1: gridBounds.offsetY + p.along + half
    };
  }

  function boxesOverlap(a, b) {
    return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  }

  // § Braille labels — a candidate fits if: it either stays within its
  // own edge's core range, or reaches into a corner that's still free (the
  // neighbor zone is active and hasn't already placed something
  // overlapping that corner -- since edges are processed in
  // LABEL_EDGE_ORDER and nothing is ever un-placed, whichever of the two
  // corner-sharing edges gets processed first effectively has "first
  // crack" at it, exactly as tried-and-not-taken); and it keeps the usual
  // whitespace gap from every other label already on its own edge.
  function fits(edge, along, footprint) {
    const corner = cornerNeeded(edge, along, footprint);
    if (corner) {
      if (!activeZones[corner.neighbor]) return false;
      const box = cornerBox(corner.horizontalEdge, corner.verticalEdge);
      for (const p of placed[corner.neighbor]) {
        if (boxesOverlap(box, placementBox(p))) return false;
      }
    }
    for (const p of placed[edge]) {
      const gap = Math.abs(along - p.along) - (footprint / 2 + p.footprint / 2);
      if (gap < LABEL_WHITESPACE_DOTS) return false;
    }
    return true;
  }

  function runPass(skipAlreadyLabeled) {
    for (const edge of LABEL_EDGE_ORDER) {
      if (!activeZones[edge]) continue;
      for (let tier = 1; tier <= MAX_TIER; tier++) {
        // Within a tier: more visible segments wins (a rough proxy for
        // "how substantial is this street on the current display" -- see
        // visibleSegmentCounts), then position order as the final,
        // deterministic tie-break.
        const tierCandidates = byEdge[edge]
          .filter((c) => c.tier === tier)
          .sort((a, b) => b.segmentCount - a.segmentCount || a.along - b.along);
        for (const c of tierCandidates) {
          if (skipAlreadyLabeled && labeledNames.has(c.name)) continue;
          const footprint = labelFootprintDots(edge);
          if (!fits(edge, c.along, footprint)) continue;
          placed[edge].push({ ...c, footprint });
          labeledNames.add(c.name);
        }
      }
    }
  }

  runPass(true);
  runPass(false);

  return placed;
}

// § Label placement — top-level entry point: labels every street name
// currently in lastWays (per spec, uniqueness spans the whole fetch, not
// just what's visible), then places labels for whatever's actually
// visible right now against the current viewport and active label zones.
function computeLabelPlacements() {
  if (!lastBbox) return { top: [], right: [], bottom: [], left: [] };
  const allNames = Array.from(new Set(
    lastWays.map((way) => way.tags && way.tags.name).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
  const labels = assignBrailleLabels(allNames);
  const viewportBbox = getViewportBbox();
  const gridBounds = mapGridBounds();
  const candidates = collectLabelCandidates(visibleWays(), viewportBbox, gridBounds, labels);
  return placeLabels(candidates, gridBounds, labelZones);
}

// § Label placement — a label character's dot pattern within its own 2
// (dot-column) x 3 (dot-row) cell, decoded from the same NABCC table used
// for the message display (see NABCC below). Every character a label can
// actually contain -- lowercase letters, digits, dash -- stays within
// NABCC's low 6 bits (confirmed by inspection: none exceed 0x3F), so dots
// 7/8 (bits 6/7) never apply here; this only decodes bits 0-5.
// bit0=dot1(col0,row0) bit1=dot2(col0,row1) bit2=dot3(col0,row2)
// bit3=dot4(col1,row0) bit4=dot5(col1,row1) bit5=dot6(col1,row2)
const LABEL_DOT_BIT_POSITIONS = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]];

function labelCharacterDots(ch) {
  const code = ch.charCodeAt(0);
  const byte = (code >= 0x20 && code <= 0x7E) ? NABCC[code - 0x20] : 0x00;
  const dots = [];
  for (let bit = 0; bit < 6; bit++) {
    if (byte & (1 << bit)) dots.push(LABEL_DOT_BIT_POSITIONS[bit]);
  }
  return dots;
}

// § Label placement — converts one placed label into absolute dot-grid
// coordinates (the full DOT_GRID_WIDTH/HEIGHT canvas, not map-relative)
// for every "on" braille dot. A label's own 3 characters are always laid
// out horizontally (left-to-right, 1-dot kerning between each pair) --
// confirmed from the spec's zone-sizing math, where the *same* 8-dot
// character span (2+1+2+1+2) makes up the left/right zones' width too,
// meaning even a label on a vertical edge reads horizontally within its
// own narrow strip; only the zone/label's *perpendicular* dimension
// differs by edge (see labelFootprintDots). What differs here per edge is
// just where that horizontal strip sits: spread along the edge and
// pinned to the outer (non-map) side for top/bottom, or fixed near the
// zone's own outer side and positioned along the edge by "along" for
// left/right.
const LABEL_CHAR_WIDTH_DOTS = 2;
const LABEL_CHAR_HEIGHT_DOTS = 3;
const LABEL_CHAR_KERNING_DOTS = 1;
const LABEL_MAP_PADDING_DOTS = 2;

function labelDotPositions(placement, gridBounds) {
  const charSpan = LABEL_CHAR_WIDTH_DOTS * 3 + LABEL_CHAR_KERNING_DOTS * 2; // 8
  const horizontal = placement.edge === 'top' || placement.edge === 'bottom';

  let baseX, baseY;
  if (horizontal) {
    const centerX = gridBounds.offsetX + placement.along;
    baseX = Math.round(centerX - charSpan / 2);
    baseY = placement.edge === 'top'
      ? 0
      : gridBounds.offsetY + gridBounds.height + LABEL_MAP_PADDING_DOTS;
  } else {
    const centerY = gridBounds.offsetY + placement.along;
    baseX = placement.edge === 'left'
      ? 0
      : gridBounds.offsetX + gridBounds.width + LABEL_MAP_PADDING_DOTS;
    baseY = Math.round(centerY - LABEL_CHAR_HEIGHT_DOTS / 2);
  }

  const dots = [];
  placement.label.split('').forEach((ch, i) => {
    const charX = baseX + i * (LABEL_CHAR_WIDTH_DOTS + LABEL_CHAR_KERNING_DOTS);
    for (const [col, row] of labelCharacterDots(ch)) {
      dots.push({ x: charX + col, y: baseY + row });
    }
  });
  return dots;
}

// § Braille labels — draws every placed label's actual braille dot
// pattern into its zone, as small circles at each "on" dot's absolute
// grid position (converted to SVG units the same way svgMapRect/
// mapGridBounds do elsewhere). Deliberately mirrors what
// drawLabelDotsToPixels draws into the tactile raster -- the on-screen
// SVG and the physical device should always show the same pattern, same
// as every other element on this map.
function drawLabelContent(svgNs, placements, gridBounds) {
  const group = document.createElementNS(svgNs, 'g');
  for (const edge of LABEL_EDGE_ORDER) {
    for (const placement of placements[edge]) {
      for (const dot of labelDotPositions(placement, gridBounds)) {
        const circle = document.createElementNS(svgNs, 'circle');
        circle.setAttribute('cx', (dot.x * SVG_UNITS_PER_DOT + SVG_UNITS_PER_DOT / 2).toFixed(1));
        circle.setAttribute('cy', (dot.y * SVG_UNITS_PER_DOT + SVG_UNITS_PER_DOT / 2).toFixed(1));
        circle.setAttribute('r', (SVG_UNITS_PER_DOT * 0.35).toFixed(1));
        circle.setAttribute('class', 'label-dot');
        group.appendChild(circle);
      }
    }
  }
  mapSvg.appendChild(group);
}

// § Braille labels — same geometry as drawLabelContent, but drawn straight
// into the tactile raster's pixel buffer instead of SVG circles. scaleX/
// scaleY match the ones rasterizeMapToPixels already computes for
// everything else, in case the connected device ever reports a
// resolution other than the expected 60x40.
function drawLabelDotsToPixels(pixels, w, h, placements, gridBounds, scaleX, scaleY) {
  for (const edge of LABEL_EDGE_ORDER) {
    for (const placement of placements[edge]) {
      for (const dot of labelDotPositions(placement, gridBounds)) {
        setGridPixel(pixels, w, h, Math.round(dot.x * scaleX), Math.round(dot.y * scaleY));
      }
    }
  }
}

// § Braille labels — draws each active zone as a bordered region (see
// svgMapRect/mapGridBounds for the geometry). Label content itself is
// drawn separately, on top, by drawLabelContent -- this just reserves and
// shows the zone's own space, so it still renders (empty) even before a
// map is loaded or if a zone happens to have no labels placed in it.
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
    group.appendChild(line);
  }

  // § POIs — every POI marker (anchor and additional alike) is a solid
  // square, all corners intact -- unlike the cursor's hollow ring, so the
  // two read as clearly distinct shapes both on screen and by touch. Sized
  // to the same 3-dot footprint as the tactile marker (see drawSquarePixels)
  // for a consistent visual/tactile scale.
  // § Editing the Map — a POI unchecked in the Edit Map dialog is skipped
  // here, same as a hidden street above. § Command / hotkey mapping — also
  // skipped entirely while cursorOnlyMode (the 0 hotkey) is active, same
  // as visibleWays()/visiblePois() -- these two checks are direct (not
  // routed through visiblePois()) only because this loop needs to keep the
  // anchor/additional marker-class distinction that function doesn't carry.
  if (!cursorOnlyMode && !hiddenPoiNames.has(lastAnchorName)) {
    const anchorPoint = projectToSvg(anchorLat, anchorLon, bbox);
    group.appendChild(createPoiMarkerSvg(svgNs, anchorPoint.x, anchorPoint.y, 'anchor-poi'));
  }

  if (!cursorOnlyMode) {
    for (const poi of additionalPois) {
      if (hiddenPoiNames.has(poi.name)) continue;
      const p = projectToSvg(poi.lat, poi.lon, bbox);
      group.appendChild(createPoiMarkerSvg(svgNs, p.x, p.y, 'additional-poi'));
    }
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
  // § Editing the Map — a street hidden via the Edit Map dialog isn't
  // "feelable" via the cursor either.
  const ways = visibleWays();
  for (const way of ways) {
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
  // § Editing the Map — a POI hidden via the Edit Map dialog isn't
  // "feelable" either, hence visiblePois() rather than allPois() here.
  for (const poi of visiblePois()) {
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

// § Editing the Map — allPois() minus whatever the user has unchecked in
// the dialog. allPois() itself stays unfiltered so the dialog can still
// list a hidden POI (and let it be turned back on); everywhere a POI is
// actually shown, hit-tested, or brailled uses this instead. cursorOnlyMode
// (the 0 hotkey) short-circuits this to nothing without touching
// hiddenPoiNames itself -- see its declaration for why.
function visiblePois() {
  if (cursorOnlyMode) return [];
  return allPois().filter((poi) => !hiddenPoiNames.has(poi.name));
}

// § Editing the Map — lastWays minus any manually-hidden street/pathway
// name, ANDed with the current Map Complexity cutoff (mapComplexityIndex).
// These are two independent filters, not one merged set: a manually-hidden
// street stays hidden at every complexity level, and raising/lowering
// complexity never touches hiddenStreetNames. lastWays itself stays
// unfiltered for the same reason as visiblePois() above. cursorOnlyMode
// short-circuits this the same way it does visiblePois().
function visibleWays() {
  if (cursorOnlyMode) return [];
  const maxTier = MAP_COMPLEXITY_LEVELS[mapComplexityIndex].maxTier;
  return lastWays.filter((way) =>
    !hiddenStreetNames.has(way.tags && way.tags.name) &&
    way.tier <= maxTier
  );
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

  // § Editing the Map — 1-4 jump straight to the matching Map Complexity
  // level (1 = All streets and pathways, 4 = Major highways), only once a
  // map is loaded (unlike the label-zone hotkeys above, a complexity change
  // has no effect with nothing on screen, and mapComplexityIndex resets on
  // the next new anchor anyway).
  const complexityNum = Number(event.key);
  if (complexityNum >= 1 && complexityNum <= MAP_COMPLEXITY_LEVELS.length && String(complexityNum) === event.key) {
    event.preventDefault();
    setMapComplexity(complexityNum - 1);
    return;
  }

  // § Command / hotkey mapping — 0 toggles cursor-only mode on/off.
  if (event.key === '0') {
    event.preventDefault();
    toggleCursorOnlyMode();
    return;
  }

  // § Additional POIs — a opens the Custom POI ("Drop Pin") dialog.
  if (event.key === 'a') {
    event.preventDefault();
    openCustomPoiDialog();
    return;
  }

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
// anchor marker with the Bresenham helpers above. `ways` is whatever
// visibleWays() passed in (see sendGraphicToDevice) -- every street/pathway
// Overpass returned, minus anything hidden via the Edit Map dialog.
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
  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
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

  // § Editing the Map — a POI unchecked in the Edit Map dialog is skipped
  // here, same as on the on-screen SVG (see renderStreetsAndAnchor).
  // § Command / hotkey mapping — also skipped entirely while cursorOnlyMode
  // is active, same as that function.
  const anchor = project(anchorLat, anchorLon);
  if (!cursorOnlyMode && !hiddenPoiNames.has(lastAnchorName) &&
      anchor.x >= rectX && anchor.x <= rectMaxX && anchor.y >= rectY && anchor.y <= rectMaxY) {
    drawSquarePixels(pixels, displayW, displayH, anchor.x, anchor.y);
  }

  for (const poi of additionalPois) {
    if (cursorOnlyMode || hiddenPoiNames.has(poi.name)) continue;
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

  drawLabelDotsToPixels(pixels, displayW, displayH, computeLabelPlacements(), b, scaleX, scaleY);

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
  const pixels = rasterizeMapToPixels(viewportBbox, visibleWays(), lastAnchorLat, lastAnchorLon, displayW, displayH, cursor);
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
