// keySpacing.js — tracks the running mean time between consecutive presses
// of the SAME named key, for measuring single-key (non-chord) Dot Pad read
// responsiveness. One series is active at a time:
//
//   - Same key pressed again within limitMs of its last press: the elapsed
//     time is added to the running mean, and the timer restarts.
//   - A DIFFERENT key is pressed, or limitMs passes with no repeat of the
//     current key (a watchdog, not gated on any new event): the current
//     series closes and is reported via onSeriesClose, using only the
//     intervals already accumulated -- never the in-progress, now-expired
//     gap since the last press, since that's exactly what "too slow to
//     count" means here.
//
// No DOM, no fixed clock/timer -- both are injectable so this can be driven
// by a fake clock in a Node test (see verify-key-spacing.mjs) instead of
// trusting the timing logic by eye.
export function createKeySpacingTracker({
  limitMs = 500,
  now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onSeriesClose
} = {}) {
  let name = null;
  let lastPressAt = 0;
  let sum = 0;
  let count = 0;
  let watchdog = null;

  function closeSeries() {
    if (watchdog !== null) {
      clearTimer(watchdog);
      watchdog = null;
    }
    if (name === null) return;
    onSeriesClose({ name, mean: count > 0 ? sum / count : null, count });
    name = null;
  }

  function startSeries(newName, at) {
    name = newName;
    lastPressAt = at;
    sum = 0;
    count = 0;
    watchdog = setTimer(closeSeries, limitMs);
  }

  // Call once per resolved single-key press (chords should never be passed
  // in -- filtering those out is the caller's job, see app.js).
  function press(pressedName) {
    const at = now();
    if (name !== null && pressedName === name) {
      const elapsed = at - lastPressAt;
      if (elapsed < limitMs) {
        sum += elapsed;
        count += 1;
        lastPressAt = at;
        clearTimer(watchdog);
        watchdog = setTimer(closeSeries, limitMs);
        return;
      }
      // Same key, but too slow to count as a repeat -- the watchdog above
      // should normally have already closed this series before a press this
      // late could even arrive; this is just a defensive fallback for that
      // exact boundary race.
    }
    closeSeries();
    startSeries(pressedName, at);
  }

  return { press };
}
