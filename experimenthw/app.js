// experimenthw — a minimal Dot Pad app for isolating why the display gets
// "confused and sluggish" under rapid cursoring. No map, no pan/zoom: a
// single cursor ring on a fixed 60x40 tactile grid, moved by the arrow keys
// or the Dot Pad's own cursor dots. Everything else on the page is a set of
// switchable strategies for how a cursor move gets turned into a BLE write,
// plus a live stats readout, so those strategies can be A/B tested against
// real hardware.
//
// Built on dotpad-toolkit (../../dotpad-toolkit/) rather than duplicating
// DotTMAP's own copies of this logic — see that repo's README for the
// module index and the encoding/dimension gotchas already documented there.
import { DotPadSDK, DotPadScanner, DisplayMode, DataCodes } from '../../dotpad-toolkit/vendor/web-sdk-3.0.0/DotPadSDK-3.0.0.js';
import { connectDotPad, disconnectDotPad, watchDotPad } from '../../dotpad-toolkit/device/connection.js';
import { sendTextToDevice, truncateMessage } from '../../dotpad-toolkit/device/messageDisplay.js';
import { sendGraphicToDevice, graphicsDimensions } from '../../dotpad-toolkit/device/graphicsDisplay.js';
import { packPixelsToHex } from '../../dotpad-toolkit/graphics/packPixelsToHex.js';
import { drawCursorRing, drawLinePixels } from '../../dotpad-toolkit/graphics/rasterizer.js';
import { CURSOR_DOT, labelToByte6 } from '../../dotpad-toolkit/device/keys.js';
import { createKeySpacingTracker } from './keySpacing.js';

const sdk = new DotPadSDK();
const scanner = new DotPadScanner();
let currentDevice = null;

// § Browser check — same detection DotTMAP uses (Web Bluetooth/Dot Pad
// connectivity is Chromium-only).
function isChrome() {
  const ua = navigator.userAgent;
  return /Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);
}
if (!isChrome()) {
  document.getElementById('browser-warning').hidden = false;
}

// No pan/zoom: the app's coordinate space is always 1:1 with the physical
// display. 60x40 is the standard grid (numberCellColumns=30,
// numberCellRows=10); read the real values from the device on connect
// rather than hardcoding, per dotpad-toolkit's own guidance, but nothing
// here needs to handle a different-sized display gracefully beyond that.
let displayW = 60;
let displayH = 40;
let cursorX = Math.floor(displayW / 2);
let cursorY = Math.floor(displayH / 2);
// Position as of the last frame actually written to the device -- distinct
// from cursorX/Y (the latest desired position) whenever sends are being
// coalesced. The partial-rows strategy needs both: it has to know what's
// really on the display right now, not just where the cursor logically is.
let prevCursorX = cursorX;
let prevCursorY = cursorY;

// ---- DOM ----
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const messageEl = document.getElementById('message');
const statPosition = document.getElementById('stat-position');
const statKeydowns = document.getElementById('stat-keydowns');
const statSends = document.getElementById('stat-sends');
const statCoalesced = document.getElementById('stat-coalesced');
const statPayloadSize = document.getElementById('stat-payload-size');
const statGap = document.getElementById('stat-gap');
const btnResetStats = document.getElementById('btn-reset-stats');
const inputInterval = document.getElementById('input-interval');
const chkCoalesce = document.getElementById('chk-coalesce');
const keySpacingBody = document.getElementById('key-spacing-body');

function currentPayloadStrategy() {
  return document.querySelector('input[name="payload-strategy"]:checked').value;
}

// § Message display — mirrors to the Dot Pad's message line, single source
// of truth for anything announced, same pattern as DotTMAP's setMessage
// (clear-then-reflow so a screen reader treats each update as a fresh
// assertive announcement rather than coalescing successive ones).
function setMessage(text) {
  messageEl.textContent = '';
  void messageEl.offsetHeight;
  messageEl.textContent = text;
  if (currentDevice) {
    const numCells = currentDevice.numberBrailleCellColumns;
    sendTextToDevice(sdk, DisplayMode, currentDevice, truncateMessage(text, numCells));
  }
}

// ---- Stats ----
let stats = { keydowns: 0, sends: 0, coalesced: 0, lastPayloadChars: null, lastGap: null };
function renderStats() {
  statPosition.textContent = `row ${cursorY}, col ${cursorX}`;
  statKeydowns.textContent = stats.keydowns;
  statSends.textContent = stats.sends;
  statCoalesced.textContent = stats.coalesced;
  statPayloadSize.textContent = stats.lastPayloadChars === null ? '—' : stats.lastPayloadChars;
  statGap.textContent = stats.lastGap === null ? '—' : stats.lastGap.toFixed(1);
}
btnResetStats.addEventListener('click', () => {
  stats = { keydowns: 0, sends: 0, coalesced: 0, lastPayloadChars: null, lastGap: null };
  renderStats();
});

// ---- Building a frame ----
// Same reference grid DotTMAP draws on initial connect, before a real map
// is loaded (see rasterizeTestGrid/sendTestGridToDevice in tmap/app.js) --
// added here purely so the display has realistic static content for the
// cursor to move over, rather than a blank field, while testing send
// strategies. Being static, it never changes between frames -- only the
// cursor ring's own row-span does, so it doesn't affect the partial-rows
// strategy's change-detection below (see sendPartialRows).
function drawReferenceGrid(pixels) {
  const cols = 6, rows = 4;
  for (let c = 0; c <= cols; c++) {
    const x = Math.min(displayW - 1, Math.round((c / cols) * (displayW - 1)));
    drawLinePixels(pixels, displayW, displayH, x, 0, x, displayH - 1);
  }
  for (let r = 0; r <= rows; r++) {
    const y = Math.min(displayH - 1, Math.round((r / rows) * (displayH - 1)));
    drawLinePixels(pixels, displayW, displayH, 0, y, displayW - 1, y);
  }
}

function buildPixels() {
  const pixels = new Uint8Array(displayW * displayH);
  drawReferenceGrid(pixels);
  drawCursorRing(pixels, displayW, displayH, cursorX, cursorY);
  return pixels;
}

function fullFrameHexChars() {
  return currentDevice.numberCellColumns * currentDevice.numberCellRows * 2;
}

// Strategy: single full-frame write, skipping the redundant zero-clear pass
// that dotpad-toolkit's own sendGraphicToDevice always does first.
function sendSingleFrame(pixels) {
  const numRows = currentDevice.numberCellRows;
  const hex = packPixelsToHex(pixels, displayW, displayH, numRows);
  sdk.displayGraphicData(hex, currentDevice, DisplayMode.GraphicMode);
  return hex.length;
}

// Strategy: only rewrite the cell-ROWS the cursor ring actually touched
// (its old position through its new one), not the whole 60x40 frame.
//
// This calls the connected DotDevice's own displayGraphicData(hex,
// startLine, startCellIndex, mode) directly, bypassing
// DotPadSDK.displayGraphicData()'s public wrapper -- that wrapper always
// forwards to the device with startLine=1/startCellIndex=0, i.e. it can
// only ever do a full-frame write (see DotPadSDK-3.0.0.js). The device's
// own method does support a sub-range: startLine is a 1-indexed cell-row,
// and startCellIndex/hex-length together address a flat, row-major CELL
// range (2 hex chars per cell -- NOT the dot/nibble addressing
// packPixelsToHex itself uses internally). This was worked out by reading
// the vendored SDK source directly; it isn't documented anywhere and isn't
// exercised by dotpad-toolkit's own graphicsDisplay.js, so treat it as an
// unsupported technique that needs re-checking against any future SDK
// version, not an assumed-stable API.
//
// Only restricts by row band, not column -- still sends full display-width
// rows, just fewer of them. A simpler, safer partial update than a full 2D
// bounding box, and already a large reduction for typical single-step
// cursor moves.
function sendPartialRows(pixels) {
  const numCols = currentDevice.numberCellColumns;
  const numRows = currentDevice.numberCellRows;
  const hexFull = packPixelsToHex(pixels, displayW, displayH, numRows);

  const ringRowSpan = (cy) => [Math.max(0, cy - 1), Math.min(displayH - 1, cy + 2)];
  const [oldTop, oldBottom] = ringRowSpan(prevCursorY);
  const [newTop, newBottom] = ringRowSpan(cursorY);
  const minRow = Math.min(oldTop, newTop);
  const maxRow = Math.max(oldBottom, newBottom);
  const minBand = Math.floor(minRow / 4);
  const maxBand = Math.floor(maxRow / 4);

  const charsPerBand = displayW; // packPixelsToHex: 1 hex char per nibble, displayW nibbles/band
  const hexSlice = hexFull.substring(minBand * charsPerBand, (maxBand + 1) * charsPerBand);
  const startCellIndex = minBand * numCols; // flat row-major cell offset, 2 hex chars/cell

  currentDevice.displayGraphicData(hexSlice, 1, startCellIndex, DisplayMode.GraphicMode);
  return hexSlice.length;
}

// ---- Send pacing: trailing-edge throttle + coalescing ----
//
// The vendored SDK has its own write-acknowledgment handshake --
// DataCodes.ResponseDisplayLineAck / ResponseDisplayLineComplete, tracked
// internally per display-line via requestReady/receiveAck flags -- but it's
// consumed entirely inside the SDK's own dispatch (see its DataCode switch)
// and never reaches setCallBack()'s public callback. So this app has no way
// to directly observe "did the device actually finish the last write";
// there's no true ack to gate on from app code. The mitigation below
// approximates it with a configurable minimum inter-send interval instead,
// meant to be tuned empirically against real hardware -- which is the
// actual point of exposing it as a live control rather than a constant.
let pendingSend = false;
let lastSendAt = 0;
let sendTimer = null;

function scheduleSend() {
  renderStats();
  if (!currentDevice) return;

  const coalesce = chkCoalesce.checked;
  const intervalMs = Number(inputInterval.value) || 0;

  if (!coalesce) {
    doSend();
    return;
  }

  const now = performance.now();
  const elapsed = now - lastSendAt;
  if (elapsed >= intervalMs && !sendTimer) {
    doSend();
    return;
  }

  // A send happened too recently (or one's already scheduled) -- collapse
  // this move into whichever send eventually fires, rather than queuing
  // every intermediate position.
  if (pendingSend) stats.coalesced++;
  pendingSend = true;
  if (!sendTimer) {
    const wait = Math.max(0, intervalMs - elapsed);
    sendTimer = setTimeout(() => {
      sendTimer = null;
      if (pendingSend) {
        pendingSend = false;
        doSend();
      }
    }, wait);
  }
}

function doSend() {
  if (!currentDevice) return;
  const now = performance.now();
  if (lastSendAt) stats.lastGap = now - lastSendAt;
  lastSendAt = now;
  stats.sends++;

  const pixels = buildPixels();
  const strategy = currentPayloadStrategy();
  if (strategy === 'clear-redraw') {
    sendGraphicToDevice(sdk, DisplayMode, currentDevice, pixels);
    stats.lastPayloadChars = 2 * fullFrameHexChars(); // zero pass + real pass
  } else if (strategy === 'single-frame') {
    stats.lastPayloadChars = sendSingleFrame(pixels);
  } else {
    stats.lastPayloadChars = sendPartialRows(pixels);
  }

  prevCursorX = cursorX;
  prevCursorY = cursorY;
  renderStats();
}

// ---- Cursor movement -- shared by keyboard and Dot Pad dots, one display
// pixel per press, no acceleration (same convention as DotTMAP). ----
function moveCursor(dx, dy) {
  const newX = Math.min(displayW - 1, Math.max(0, cursorX + dx));
  const newY = Math.min(displayH - 1, Math.max(0, cursorY + dy));
  if (newX === cursorX && newY === cursorY) return;
  cursorX = newX;
  cursorY = newY;
  scheduleSend();
}

const FORM_CONTROL_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
function isFormControlFocused() {
  const focused = document.activeElement;
  return !!focused && FORM_CONTROL_TAGS.has(focused.tagName);
}

const CURSOR_DELTAS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
};

document.addEventListener('keydown', (event) => {
  const delta = CURSOR_DELTAS[event.key];
  if (!delta || isFormControlFocused()) return;
  event.preventDefault();
  stats.keydowns++;
  moveCursor(delta[0], delta[1]);
});

// ---- Key spacing (single dots only, no chords) ----
// Measures how quickly consecutive presses of the SAME lone dot are read,
// per keySpacing.js -- see that file for the timing state machine itself.
// Scoped to single dots specifically because a chord (multiple dots, or a
// paddle combo) goes through the SDK's ~200ms chord-assembly debounce
// before it's even resolved into one event; a lone dot doesn't wait for
// that, so this is where read responsiveness should be closest to
// real-time and most worth measuring.
const DOT_BITS = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20]; // dot1..dot6, single bit each
function singleDotName(byte6) {
  const idx = DOT_BITS.indexOf(byte6);
  return idx === -1 ? null : `dot ${idx + 1}`;
}

const KEY_SPACING_MAX_ROWS = 10;
function addKeySpacingRow({ name, mean, count }) {
  const row = document.createElement('tr');
  const nameCell = document.createElement('td');
  const meanCell = document.createElement('td');
  const countCell = document.createElement('td');
  nameCell.textContent = name;
  meanCell.textContent = mean === null ? '—' : mean.toFixed(1);
  countCell.textContent = count;
  row.append(nameCell, meanCell, countCell);
  keySpacingBody.insertBefore(row, keySpacingBody.firstChild);
  while (keySpacingBody.children.length > KEY_SPACING_MAX_ROWS) {
    keySpacingBody.removeChild(keySpacingBody.lastChild);
  }
}

const keySpacingTracker = createKeySpacingTracker({ onSeriesClose: addKeySpacingRow });

// ---- Dot Pad connection ----
watchDotPad(sdk, DataCodes, {
  onConnected: (device) => {
    currentDevice = device;
    const dims = graphicsDimensions(device);
    displayW = dims.displayW;
    displayH = dims.displayH;
    cursorX = Math.min(cursorX, displayW - 1);
    cursorY = Math.min(cursorY, displayH - 1);
    prevCursorX = cursorX;
    prevCursorY = cursorY;
    btnConnect.hidden = true;
    btnConnect.disabled = false;
    btnDisconnect.hidden = false;
    setMessage('Connected');
    doSend();
  },
  onDisconnected: () => {
    currentDevice = null;
    btnConnect.hidden = false;
    btnConnect.disabled = false;
    btnDisconnect.hidden = true;
    setMessage('Disconnected');
  },
  onConnectFailed: () => {
    setMessage('Connect failed');
    btnConnect.disabled = false;
  },
  onKey: (device, keyCode, msg) => {
    const byte6 = labelToByte6(msg || keyCode);
    stats.keydowns++;
    const dotName = singleDotName(byte6);
    if (dotName) keySpacingTracker.press(dotName);
    if (byte6 === CURSOR_DOT.LEFT) moveCursor(-1, 0);
    else if (byte6 === CURSOR_DOT.RIGHT) moveCursor(1, 0);
    else if (byte6 === CURSOR_DOT.UP) moveCursor(0, -1);
    else if (byte6 === CURSOR_DOT.DOWN) moveCursor(0, 1);
  }
});

btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  setMessage('Scanning…');
  try {
    const device = await connectDotPad(sdk, scanner);
    if (!device) {
      setMessage('No device selected');
      btnConnect.disabled = false;
    }
    // Otherwise onConnected (above, via watchDotPad) takes over once the
    // SDK reports DataCodes.Connected.
  } catch (err) {
    setMessage('Connect error');
    btnConnect.disabled = false;
  }
});

btnDisconnect.addEventListener('click', () => {
  disconnectDotPad(sdk, currentDevice);
});

renderStats();
