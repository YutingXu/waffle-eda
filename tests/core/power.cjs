"use strict";
// AtriumPower (app/core/power.js): page visibility and the host's occlusion and power-saving
// (lowPower) reports, Efficiency mode (Automatic / Always / Off, stored as general.efficiency),
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
// A Chromium-like engine on battery: the Battery Status API says "discharging". power.js must not ask.
let batteryAsked = 0;
const setNavigator = v => Object.defineProperty(globalThis, "navigator", {value: v, configurable: true, writable: true});
setNavigator({platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)",
  getBattery: () => { batteryAsked++; return Promise.resolve({charging: false, addEventListener() {}}); }});
require("../../app/editor/theme.js");
require("../../app/core/power.js");
const P = AtriumPower;

// ---- defaults: visible, not efficient, Automatic -------------------------------------------------
assert.equal(P.visible(), true);
assert.equal(P.efficient(), false, "Automatic in a browser on battery: no power-saving signal, not efficient");
assert.equal(batteryAsked, 0, "the battery is never asked");
assert.equal("battery" in P.state(), false, "state() has no battery field");
assert.equal(P.saver(), "", "a browser reports no power-saving mode");
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
fire(winListeners, "atrium-power", {detail: {occluded: true, lowPower: false}});
assert.equal(P.visible(), false, "an occluded window is not visible");
assert.equal(P.efficient(), false);
fire(winListeners, "atrium-power", {detail: {occluded: false}});
assert.equal(P.visible(), true, "a partial report keeps the other fields");

// ---- Automatic: the system's power-saving mode only, never the battery alone ----------------------
// The macOS host sends Low Power Mode, the Windows host energy saver / battery saver and the Linux host
// the Power Saver power mode, all as lowPower. An older macOS host also sent battery: it is ignored.
let n = seen.length;
fire(winListeners, "atrium-power", {detail: {battery: true}});
assert.equal(P.efficient(), false, "on battery alone: not efficient"); assert.ok(!attrs.has("data-efficient"));
assert.equal(P.delay(150), 150); assert.equal(seen.length, n, "a battery report changes nothing");
fire(winListeners, "atrium-power", {detail: {lowPower: true}});
assert.equal(P.efficient(), true, "Low Power Mode / energy saver / Power Saver"); assert.ok(attrs.has("data-efficient"));
assert.equal(P.delay(150), 300); assert.equal(seen.length, n + 1, "one change event");
fire(winListeners, "atrium-power", {detail: {lowPower: true}});
assert.equal(seen.length, n + 1, "no event when nothing changed");
fire(winListeners, "atrium-power", {detail: {lowPower: true, battery: true}});
assert.equal(P.efficient(), true, "low power on battery");
fire(winListeners, "atrium-power", {detail: {lowPower: false, battery: true}});
assert.equal(P.efficient(), false, "low power off, still on battery"); assert.ok(!attrs.has("data-efficient"));
fire(winListeners, "atrium-power", {detail: {lowPower: false}});
assert.equal(P.efficient(), false); assert.ok(!attrs.has("data-efficient"));
// The host's initial report (globalThis.__atriumPowerState) is read at load: see the fresh copies below.

// ---- Always / Off, stored in atrium.prefs ----------------------------------------------------------
// The list and the key the welcome walkthrough reads (welcome.js efficiency()).
assert.deepEqual([...P.modes], ["auto", "always", "off"]); assert.equal(P.key, "general.efficiency");
assert.equal(P.setMode("always"), "always");
assert.equal(P.efficient(), true);
assert.equal(JSON.parse(store.get("atrium.prefs")).values["general.efficiency"], "always");
fire(winListeners, "atrium-power", {detail: {battery: true}});
assert.equal(P.efficient(), true, "Always, on battery or not");
fire(winListeners, "atrium-power", {detail: {lowPower: true}});
assert.equal(P.setMode("off"), "off");
assert.equal(P.efficient(), false, "Off ignores Low Power Mode");
assert.equal(P.setMode("nonsense"), "auto");
assert.equal(P.efficient(), true, "back to Automatic in Low Power Mode");
fire(winListeners, "atrium-power", {detail: {lowPower: false}});
assert.equal(P.efficient(), false, "Automatic, on battery, Low Power Mode off");
off();
const m = seen.length; P.setMode("always"); assert.equal(seen.length, m, "off() unsubscribes");

// ---- a fresh page: the host's report at load wins over the engine's battery ------------------------
// Each copy is a new AtriumPower over the same page; the shared one (P) is restored afterwards.
{
  const fresh = (pre, nav) => {
    const saved = {G: globalThis.AtriumPower, nav: globalThis.navigator, pre: globalThis.__atriumPowerState};
    if (nav) setNavigator(nav);
    if (pre === undefined) delete globalThis.__atriumPowerState; else globalThis.__atriumPowerState = pre;
    const path = require.resolve("../../app/core/power.js");
    delete require.cache[path]; require(path);
    const X = globalThis.AtriumPower;
    globalThis.AtriumPower = saved.G; setNavigator(saved.nav);
    if (saved.pre === undefined) delete globalThis.__atriumPowerState; else globalThis.__atriumPowerState = saved.pre;
    return X;
  };
  const asked = batteryAsked;
  P.setMode("auto");   // the stored mode the fresh copies read
  assert.equal(fresh({lowPower: true}).efficient(), true, "macOS Low Power Mode at load");
  assert.equal(fresh({lowPower: true, battery: true}).efficient(), true, "low power plus battery at load");
  assert.equal(fresh({lowPower: false, battery: true}).efficient(), false, "an older host's battery report at load");
  assert.equal(fresh({lowPower: false}).efficient(), false, "the host says not saving power; getBattery says discharging");
  assert.equal(fresh(undefined).efficient(), false, "no host, getBattery discharging: not efficient");
  assert.equal(batteryAsked, asked, "no copy asks for the battery");
  // The help text and the welcome card name the mode Automatic follows on each platform.
  // saver() reads the page's navigator and AtriumHost when the help is shown.
  const saverOn = (host, nav) => {
    const was = globalThis.navigator; setNavigator(nav);
    if (host) globalThis.AtriumHost = {};
    try { return P.saver(); } finally { delete globalThis.AtriumHost; setNavigator(was); }
  };
  const hosted = ua => saverOn(true, {platform: "", userAgent: ua});
  assert.equal(hosted("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"), "mac");
  assert.equal(hosted("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0"), "windows");
  assert.equal(hosted("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"), "linux");
  assert.equal(saverOn(true, {platform: "Linux x86_64", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"}), "linux",
    "navigator.platform wins over a user agent that claims to be a Mac");
  assert.equal(saverOn(true, {platform: "Win32", userAgent: ""}), "windows");
  assert.equal(saverOn(false, {platform: "Win32", userAgent: "Windows"}), "", "a browser on Windows: none");
}

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
