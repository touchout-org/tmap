// Verifies the cursor-acceleration state machine (extracted copy of the
// logic in app.js's § Cursor acceleration section) against a fake clock,
// since it has several interacting rules -- fresh-start conditions, the
// watchdog -- that are easy to get subtly wrong and hard to observe
// reliably against real keyboard timing. Direction plays no role in this
// state machine at all (only timing does; see app.js's comment for why),
// so `press()` here takes no direction argument, matching onCursorKeyPress.
function makeFakeClock() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map();
  function now() { return currentTime; }
  function setTimer(fn, ms) {
    const id = nextId++;
    timers.set(id, { fireAt: currentTime + ms, fn });
    return id;
  }
  function clearTimer(id) { timers.delete(id); }
  function advance(ms) {
    const target = currentTime + ms;
    for (;;) {
      let dueId = null, dueAt = Infinity;
      for (const [id, t] of timers) {
        if (t.fireAt <= target && t.fireAt < dueAt) { dueId = id; dueAt = t.fireAt; }
      }
      if (dueId === null) break;
      currentTime = dueAt;
      const { fn } = timers.get(dueId);
      timers.delete(dueId);
      fn();
    }
    currentTime = target;
  }
  return { now, setTimer, clearTimer, advance };
}

// Same shape as app.js's accelConfig/state, parameterized by a fake clock
// and an onCancelByTimeout callback (app.js's equivalent: scheduleSend()).
function createAccelerator({ timingThresholdMs, countThreshold, factor, timeoutMs }, clock, onCancelByTimeout) {
  let accelCount = 0;
  let accelActive = false;
  let lastPressAt = -Infinity;
  let accelWatchdog = null;

  function cancelAcceleration() {
    if (accelWatchdog !== null) { clock.clearTimer(accelWatchdog); accelWatchdog = null; }
    accelActive = false;
    accelCount = 0;
  }

  function armAccelWatchdog() {
    if (accelWatchdog !== null) clock.clearTimer(accelWatchdog);
    accelWatchdog = clock.setTimer(() => {
      accelWatchdog = null;
      cancelAcceleration();
      if (onCancelByTimeout) onCancelByTimeout();
    }, timeoutMs);
  }

  function press() {
    const now = clock.now();
    if (accelActive) {
      lastPressAt = now;
      armAccelWatchdog();
      return factor;
    }
    const freshStart = (now - lastPressAt) >= timingThresholdMs;
    accelCount = freshStart ? 1 : accelCount + 1;
    lastPressAt = now;
    if (accelCount >= countThreshold) {
      accelActive = true;
      armAccelWatchdog();
      return factor;
    }
    return 1;
  }

  return { press, isActive: () => accelActive, count: () => accelCount };
}

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) { failures++; console.log(`FAIL ${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${label}`);
}

const CFG = { timingThresholdMs: 200, countThreshold: 3, factor: 5, timeoutMs: 500 };

// ---- Case 1: fewer than countThreshold fast presses -> never accelerates.
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  const distances = [];
  distances.push(accel.press()); clock.advance(50);
  distances.push(accel.press()); clock.advance(50);
  check('sub-threshold fast presses all move 1px, not active', { distances, active: accel.isActive() }, { distances: [1, 1], active: false });
}

// ---- Case 2: the threshold-crossing press itself accelerates.
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  const distances = [];
  distances.push(accel.press()); clock.advance(50); // count 1
  distances.push(accel.press()); clock.advance(50); // count 2
  distances.push(accel.press());                    // count 3 -> crosses threshold=3
  check('3rd fast press crosses threshold and accelerates immediately', { distances, active: accel.isActive() }, { distances: [1, 1, 5], active: true });
}

// ---- Case 3: continuing fast presses after acceleration keep moving at
// the accelerated factor.
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  accel.press(); clock.advance(50);
  accel.press(); clock.advance(50);
  accel.press(); clock.advance(50); // now active
  const d = accel.press();
  check('press after acceleration active still moves by factor', d, 5);
}

// ---- Case 4: a slow gap during ramp-up resets to a fresh streak (count 1,
// not accelerated) -- this press becomes press #1 of the new streak.
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  accel.press(); clock.advance(50);
  accel.press(); // count 2
  clock.advance(300); // slower than timingThresholdMs=200
  const d = accel.press(); // should reset, not reach count 3
  check('slow gap during ramp-up resets streak', { d, count: accel.count(), active: accel.isActive() }, { d: 1, count: 1, active: false });
}

// ---- Case 5: switching "direction" during ramp-up does NOT reset the
// count -- fast presses accumulate regardless of what direction each one
// logically represents, since this state machine never sees direction at
// all. (Direction only matters to the caller, handleDirectionPress, for
// which way to actually move the cursor -- not to this timing state
// machine.) Simulated here by just calling press() repeatedly; there's no
// direction argument to vary.
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  accel.press(); clock.advance(50); // count 1 ("right", say)
  accel.press(); clock.advance(50); // count 2 ("left", say) -- still counts
  const d = accel.press();          // count 3 ("up", say) -- crosses threshold
  check('fast presses accumulate across a simulated direction switch during ramp-up', { d, active: accel.isActive() }, { d: 5, active: true });
}

// ---- Case 6: once accelerated, continuing fast presses (regardless of
// simulated direction) keep accelerating -- only the timeout cancels now.
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  accel.press(); clock.advance(50);
  accel.press(); clock.advance(50);
  accel.press(); // active now
  clock.advance(50);
  const d = accel.press(); // simulated direction switch while accelerated
  // accelCount doesn't increment once active (see app.js: the active branch
  // returns early without touching it) -- it stays at whatever it was when
  // acceleration first kicked in.
  check('acceleration continues across a simulated direction switch', { d, active: accel.isActive(), count: accel.count() }, { d: 5, active: true, count: 3 });
}

// ---- Case 7: watchdog timeout while accelerated, with no further presses,
// cancels acceleration and fires the redraw callback.
{
  const clock = makeFakeClock();
  let cancelCallbacks = 0;
  const accel = createAccelerator(CFG, clock, () => { cancelCallbacks++; });
  accel.press(); clock.advance(50);
  accel.press(); clock.advance(50);
  accel.press(); // active now, watchdog armed for timeoutMs=500
  clock.advance(600); // let the watchdog fire
  check('watchdog cancels acceleration and fires callback after silence', { active: accel.isActive(), count: accel.count(), cancelCallbacks }, { active: false, count: 0, cancelCallbacks: 1 });
}

// ---- Case 8: no watchdog fires during ordinary ramp-up (below threshold)
// even after a long pause -- it just lazily resets on the next press,
// no proactive callback.
{
  const clock = makeFakeClock();
  let cancelCallbacks = 0;
  const accel = createAccelerator(CFG, clock, () => { cancelCallbacks++; });
  accel.press(); clock.advance(50);
  accel.press(); // count 2, still below threshold=3
  clock.advance(5000); // long pause, well past timeoutMs, but never armed since not active
  check('no proactive callback during ramp-up, ever', cancelCallbacks, 0);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
