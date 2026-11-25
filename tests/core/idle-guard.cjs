"use strict";
// AtriumIdle (app/core/idle.js), the setTimeout stand-in used in WebKit: callbacks share one slice's
// deadline, and with ATRIUM_DEV (the test shim, the macOS harness) a callback that runs over three
// slices is reported in AtriumIdle.slow with its caller, so work that ignores timeRemaining() shows up.
// Node: node tests/core/idle-guard.cjs   JSC: scripts/test-jsc.sh idle-guard
const assert = require("node:assert/strict");
globalThis.ATRIUM_DEV = true;
const ric = globalThis.requestIdleCallback; delete globalThis.requestIdleCallback;
require("../../app/core/idle.js");
if (ric) globalThis.requestIdleCallback = ric;
const I = globalThis.AtriumIdle, now = () => globalThis.performance?.now?.() ?? Date.now();
const spin = ms => { const t = now(); while (now() - t < ms); };
const next = fn => new Promise(r => I.idle(d => { fn(d); r(); }, {timeout: 5000}));
globalThis.__testDone = (async () => {
  assert.equal(I.native, false);
  const timers = new Map(), ran = [], later = globalThis.setTimeout, clear = globalThis.clearTimeout;
  let timerId = 0;
  try {
    globalThis.setTimeout = fn => { timers.set(++timerId, fn); return timerId; };
    globalThis.clearTimeout = id => timers.delete(id);
    const only = I.idle(() => ran.push("withdrawn"));
    assert.equal(timers.size, 1);
    I.cancel(only);
    assert.equal(timers.size, 0, "withdrawing the last request also cancels its wakeup");
    const hint = I.idle(() => ran.push("hint"));
    I.idle(() => ran.push("recovery"));
    I.cancel(hint);
    assert.equal(timers.size, 1, "independent work keeps the shared wakeup");
    const [id, pump] = timers.entries().next().value;
    timers.delete(id); pump();
    assert.deepEqual(ran, ["recovery"]);
    assert.equal(timers.size, 0);
  } finally { globalThis.setTimeout = later; globalThis.clearTimeout = clear; }
  // A callback that overruns: reported with its caller (a file and line where the engine names them) and name.
  await new Promise(r => I.idle(function overrun() { spin(170); r(); }, {timeout: 5000}));
  assert.equal(I.slow.length, 1, JSON.stringify(I.slow));
  assert.ok(I.slow[0].ms >= 150 && /overrun/.test(I.slow[0].owner), JSON.stringify(I.slow));
  console.log("ok - an overrunning callback is reported with its caller");
  // One that keeps to its slice is not.
  await next(d => { while (d.timeRemaining() > 1) spin(1); });
  assert.equal(I.slow.length, 1);
  console.log("ok - a callback within its slice is not reported");
  // Two callbacks queued together share the slice: the second sees what the first left.
  let left = null;
  await new Promise(r => { I.idle(() => spin(30), {timeout: 5000}); I.idle(d => { left = d.didTimeout ? null : d.timeRemaining(); r(); }, {timeout: 5000}); });
  if (left != null) assert.ok(left <= 21, "the second callback's deadline counts the first: " + left);
  console.log("ok - callbacks in one slice share its deadline");
})();
globalThis.__testDone.catch(e => { console.error(e); if (globalThis.process) process.exitCode = 1; });
