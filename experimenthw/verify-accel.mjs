// Verifies the cursor-acceleration state machine (extracted copy of the
// logic in app.js's § Cursor acceleration section) against a fake clock,
// since it has several interacting rules -- fresh-start conditions, the
// watchdog, different-direction cancellation -- that are easy to get
// subtly wrong and hard to observe reliably against real keyboard timing.
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
  let lastAccelDir = null;
  let lastAccelPressAt = 0;
  let accelWatchdog = null;

  function cancelAcceleration() {
    if (accelWatchdog !== null) { clock.clearTimer(accelWatchdog); accelWatchdog = null; }
    accelActive = false;
    accelCount = 0;
    lastAccelDir = null;
  }

  function armAccelWatchdog() {
    if (accelWatchdog !== null) clock.clearTimer(accelWatchdog);
    accelWatchdog = clock.setTimer(() => {
      accelWatchdog = null;
      cancelAcceleration();
      if (onCancelByTimeout) onCancelByTimeout();
    }, timeoutMs);
  }

  function press(dir) {
    const now = clock.now();
    if (accelActive) {
      if (dir !== lastAccelDir) {
        cancelAcceleration();
      } else {
        lastAccelPressAt = now;
        armAccelWatchdog();
        return factor;
      }
    }
    const freshStart = lastAccelDir === null || dir !== lastAccelDir || (now - lastAccelPressAt) >= timingThresholdMs;
    accelCount = freshStart ? 1 : accelCount + 1;
    lastAccelDir = dir;
    lastAccelPressAt = now;
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
  distances.push(accel.press('right')); clock.advance(50);
  distances.push(accel.press('right')); clock.advance(50);
  check('sub-threshold fast presses all move 1px, not active', { distances, active: accel.isActive() }, { distances: [1, 1], active: false });
}

// ---- Case 2: the threshold-crossing press itself accelerates.
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  const distances = [];
  distances.push(accel.press('right')); clock.advance(50); // count 1
  distances.push(accel.press('right')); clock.advance(50); // count 2
  distances.push(accel.press('right'));                    // count 3 -> crosses threshold=3
  check('3rd fast press crosses threshold and accelerates immediately', { distances, active: accel.isActive() }, { distances: [1, 1, 5], active: true });
}

// ---- Case 3: continuing fast same-direction presses after acceleration
// keep moving at the accelerated factor.
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  accel.press('right'); clock.advance(50);
  accel.press('right'); clock.advance(50);
  accel.press('right'); clock.advance(50); // now active
  const d = accel.press('right');
  check('press after acceleration active still moves by factor', d, 5);
}

// ---- Case 4: a slow gap during ramp-up resets to a fresh streak (count 1,
// not accelerated), per the "reset to 0" decision (this press becomes
// press #1 of the new streak).
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  accel.press('right'); clock.advance(50);
  accel.press('right'); // count 2
  clock.advance(300); // slower than timingThresholdMs=200
  const d = accel.press('right'); // should reset, not reach count 3
  check('slow gap during ramp-up resets streak', { d, count: accel.count(), active: accel.isActive() }, { d: 1, count: 1, active: false });
}

// ---- Case 5: a different direction during ramp-up resets, and that
// press starts a fresh streak for the NEW direction (not accelerated).
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  accel.press('right'); clock.advance(50);
  accel.press('right'); // count 2 for 'right'
  clock.advance(50);
  const d = accel.press('left'); // different direction -> reset, fresh streak for 'left'
  check('different direction during ramp-up resets to a fresh streak', { d, count: accel.count(), active: accel.isActive() }, { d: 1, count: 1, active: false });
}

// ---- Case 6: a different direction WHILE accelerated cancels immediately;
// that press itself is not accelerated (starts a fresh ramp-up).
{
  const clock = makeFakeClock();
  const accel = createAccelerator(CFG, clock);
  accel.press('right'); clock.advance(50);
  accel.press('right'); clock.advance(50);
  accel.press('right'); // active now
  clock.advance(50);
  const d = accel.press('left'); // switch direction while accelerated
  check('direction switch while accelerated cancels and does not accelerate that press', { d, active: accel.isActive(), count: accel.count() }, { d: 1, active: false, count: 1 });
}

// ---- Case 7: watchdog timeout while accelerated, with no further presses,
// cancels acceleration and fires the redraw callback.
{
  const clock = makeFakeClock();
  let cancelCallbacks = 0;
  const accel = createAccelerator(CFG, clock, () => { cancelCallbacks++; });
  accel.press('right'); clock.advance(50);
  accel.press('right'); clock.advance(50);
  accel.press('right'); // active now, watchdog armed for timeoutMs=500
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
  accel.press('right'); clock.advance(50);
  accel.press('right'); // count 2, still below threshold=3
  clock.advance(5000); // long pause, well past timeoutMs, but never armed since not active
  check('no proactive callback during ramp-up, ever', cancelCallbacks, 0);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
