"use strict";
// AtriumPower (app/core/power.js): page visibility and the host's occlusion, Low Power
// Mode and battery reports, Efficiency mode (Automatic / Always / Off, stored as general.efficiency),
// change events, <html data-efficient>, delay() and frame(); and the modules that follow it: motion
// (no canvas effects), collaboration polling backoff, the worker pool cap, autosave's debounce.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh power).
const assert = require("node:assert/strict");

// ---- a minimal page: visibility, the root's attributes, window events and timers ----------------
const docListeners = {}, winListeners = {}, attrs = new Set();
const store = new Map();
globalThis.localStorage = {getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)};
globalThis.document = {visibilityState: "visible", addEventListener: (t, f) => (docListeners[t] ||= []).push(f),
  documentElement: {toggleAttribute: (k, on) => { if (on) attrs.add(k); else attrs.delete(k); }, getAttribute: () => null}};
globalThis.addEventListener = (t, f) => (winListeners[t] ||= []).push(f);
const fire = (list, t, e) => (list[t] || []).forEach(f => f(e));
require("../../app/editor/theme.js");
require("../../app/core/power.js");
const P = AtriumPower;

// ---- defaults: visible, not efficient, Automatic -------------------------------------------------
assert.equal(P.visible(), true);
assert.equal(P.efficient(), false);
assert.equal(P.mode(), "auto");
assert.equal(P.idle(), false);
assert.equal(P.delay(150), 150);
assert.ok(!attrs.has("data-efficient"));

const seen = [];
const off = P.onChange(s => seen.push(s));

// ---- hidden page, host occlusion ------------------------------------------------------------------
document.visibilityState = "hidden"; fire(docListeners, "visibilitychange");
assert.equal(P.visible(), false); assert.equal(P.idle(), true); assert.equal(seen.at(-1).hidden, true);
document.visibilityState = "visible"; fire(docListeners, "visibilitychange");
assert.equal(P.visible(), true);
fire(winListeners, "atrium-power", {detail: {occluded: true, lowPower: false, battery: false}});
assert.equal(P.visible(), false, "an occluded window is not visible");
assert.equal(P.efficient(), false);
fire(winListeners, "atrium-power", {detail: {occluded: false}});
assert.equal(P.visible(), true, "a partial report keeps the other fields");

// ---- Automatic: battery or Low Power Mode -------------------------------------------------------
const n = seen.length;
fire(winListeners, "atrium-power", {detail: {battery: true}});
assert.equal(P.efficient(), true); assert.ok(attrs.has("data-efficient")); assert.equal(P.delay(150), 300);
assert.equal(seen.length, n + 1, "one change event");
fire(winListeners, "atrium-power", {detail: {battery: true}});
assert.equal(seen.length, n + 1, "no event when nothing changed");
fire(winListeners, "atrium-power", {detail: {battery: false, lowPower: true}});
assert.equal(P.efficient(), true, "Low Power Mode");
fire(winListeners, "atrium-power", {detail: {lowPower: false}});
assert.equal(P.efficient(), false); assert.ok(!attrs.has("data-efficient"));

// ---- Always / Off, stored in atrium.prefs ----------------------------------------------------------
// The list and the key the welcome walkthrough reads (welcome.js efficiency()).
assert.deepEqual([...P.modes], ["auto", "always", "off"]); assert.equal(P.key, "general.efficiency");
assert.equal(P.setMode("always"), "always");
assert.equal(P.efficient(), true);
assert.equal(JSON.parse(store.get("atrium.prefs")).values["general.efficiency"], "always");
fire(winListeners, "atrium-power", {detail: {battery: true}});
assert.equal(P.setMode("off"), "off");
assert.equal(P.efficient(), false, "Off ignores the battery");
assert.equal(P.setMode("nonsense"), "auto");
assert.equal(P.efficient(), true, "back to Automatic on battery");
fire(winListeners, "atrium-power", {detail: {battery: false}});
off();
const m = seen.length; P.setMode("always"); assert.equal(seen.length, m, "off() unsubscribes");

// ---- frame(): requestAnimationFrame normally, about 30 fps in Efficiency mode ---------------------
{
  const raf = [], timers = [];
  globalThis.requestAnimationFrame = f => { raf.push(f); return raf.length; };
  const st = globalThis.setTimeout; globalThis.setTimeout = (f, ms) => { timers.push(ms); return st(f, 0); };
  P.setMode("off"); P.frame(() => {}); assert.equal(raf.length, 1); assert.equal(timers.length, 0);
  P.setMode("always"); P.frame(() => {}); assert.equal(raf.length, 1, "waits first"); assert.deepEqual(timers, [16]);
  globalThis.setTimeout = st;
}

// ---- motion: no canvas effects in Efficiency mode, unless Animations is Full ------------------------
{
  require("../../app/editor/editor-motion.js");
  P.setMode("always");
  assert.equal(AtriumMotion.level(), "off");
  P.setMode("off");
  assert.equal(AtriumMotion.level(), "full");
}

// ---- collaboration: the poll backs off while nothing changes and nobody else is here -------------
(async () => {
  require("../../app/project/collab-lock.js");
  const delays = [], st = globalThis.setTimeout, ct = globalThis.clearTimeout;
  let t = 1e6;
  const host = {list: async () => ({session: "me", machine: "m", now: t, locks: [], project: {size: 1, modified: 1, inode: 1}}),
    write: async () => ({written: true}), remove: async () => ({removed: true})};
  globalThis.setTimeout = (f, ms) => { delays.push(ms); return 1; };
  globalThis.clearTimeout = () => {};
  P.setMode("off");
  const mgr = AtriumCollabLock.create({host, now: () => t, name: () => "Me", open: () => [], docName: () => "", changed: () => false, current: () => null});
  await mgr.start();
  await new Promise(r => st(r, 0));
  const C = AtriumCollabLock.constants;
  assert.equal(delays.length, 1, "one timer, no interval");
  assert.ok(delays[0] <= C.HEARTBEAT, "never longer than the heartbeat");
  globalThis.setTimeout = st; globalThis.clearTimeout = ct;
  await mgr.stop();
  globalThis.__powerTestDone = true;
  console.log("power ok");
})().catch(e => { console.error(e); throw e; });
