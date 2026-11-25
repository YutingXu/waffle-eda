"use strict";
// Get set up (app/editor/welcome.js): step state and persistence, feature detection of the optional steps
// (renderer, efficiency, fab presets, languages), that loading it and reading values changes nothing,
// that each choice applies through its owner (key map, theme, preferences), and the start page's
// fab preset for new blank projects. Runs under Node and JavaScriptCore (scripts/test-jsc.sh welcome).
const assert = require("node:assert/strict");
const store = new Map(), writes = [];
const storage = {getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => { writes.push(k); store.set(k, String(v)); }, removeItem: k => { writes.push(k); store.delete(k); },
  get length() { return store.size; }, key: i => [...store.keys()][i] ?? null};
Object.defineProperty(globalThis, "localStorage", {value: storage, configurable: true, writable: true});
for (const m of ["model", "theme", "prefs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const P = AtriumPrefs, T = AtriumTheme;
T.useStorage(storage);
// A key map stand-in that records what is asked of it.
const keyCalls = [];
let preset = "altium";
globalThis.AtriumKeymap = {preset: () => preset, setPreset: id => { keyCalls.push(id); preset = id; }, presets: () => ["altium", "classic", "kicad", "vscode", "allegro", "modern"].map(id => ({id, title: id})),
  hintFor: () => "", onChange: () => () => {}, mac: false};

const snapshot = () => JSON.stringify([...store]);
const themeBefore = JSON.stringify(T.get()), prefsBefore = JSON.stringify(P.get()), storeBefore = snapshot();
writes.length = 0;
require("../../app/editor/welcome.js");
const W = AtriumWelcome;

// ---- loading and reading change nothing --------------------------------------------------------------
assert.equal(W.firstLaunch(), true, "no state saved: a first launch");
assert.deepEqual(W.steps(), ["from", "theme", "units", "mouse", "motion", "ai"], "optional steps stay hidden without their modules");
for (const id of W.steps()) { W.value(id); for (const part of ["keys", "wheel", "accent", "pcbGrid", "schGrid", "zoomAt", "invertZoom", "efficiency"]) W.value(id, part); }
W.state(); W.progress();
assert.deepEqual(writes, [], "nothing is written until a choice is made");
assert.equal(snapshot(), storeBefore);
assert.equal(JSON.stringify(T.get()), themeBefore); assert.equal(JSON.stringify(P.get()), prefsBefore);
assert.deepEqual(keyCalls, []);
assert.equal(W.value("from"), "", "no Coming from choice is preselected");
assert.equal(W.value("from", "keys"), "altium"); assert.equal(W.value("from", "wheel"), "zoom");
assert.equal(W.value("theme"), "system"); assert.equal(W.value("units"), "mm"); assert.equal(W.value("units", "pcbGrid"), .25);
assert.equal(W.value("motion"), "system"); assert.equal(W.value("mouse"), "zoom");
assert.deepEqual(W.progress(), {done: 0, skipped: 0, total: 6});

// ---- choices apply through their owners and are remembered -------------------------------------------
W.choose("from", "altium");
assert.deepEqual(keyCalls, [], "Altium keys are already on: the key map is not touched");
assert.equal(P.get("mouse.wheel"), "altium", "Altium: the wheel scrolls");
let s = JSON.parse(store.get(W.STORE));
assert.equal(s.from, "altium"); assert.equal(s.done.from, true); assert.equal(W.firstLaunch(), false);
W.choose("from", "kicad");
assert.deepEqual(keyCalls, ["kicad"]); assert.equal(P.get("mouse.wheel"), "zoom");
W.choose("from", "vscode", "keys"); W.choose("from", "altium", "wheel");
assert.deepEqual(keyCalls, ["kicad", "vscode"], "each part is overridable on its own"); assert.equal(P.get("mouse.wheel"), "altium");
assert.equal(W.value("from"), "kicad", "the Coming from choice stays as picked");
assert.throws(() => W.choose("from", "orcad"), /Unknown choice/);

W.choose("theme", "light"); assert.equal(T.get().preset, "light"); assert.equal(T.get().followSystem, false);
assert.equal(JSON.parse(store.get(T.STORE)).preset, "light", "the theme persists in its own store");
W.choose("theme", "system"); assert.equal(T.get().followSystem, true); assert.equal(W.value("theme"), "system");
W.choose("theme", "dark"); assert.equal(T.get().preset, "dark"); assert.equal(T.get().followSystem, false);
W.choose("theme", "#3fb950", "accent"); assert.equal(T.get().accent, "#3fb950"); W.choose("theme", "", "accent"); assert.equal(T.get().accent, "");
assert.equal(JSON.parse(store.get(T.STORE)).followSystem, false, "explicit Dark persists independently of the system");
W.choose("theme", "system");
assert.equal(store.has(T.STORE), false, "back at the defaults: changed back, nothing is left stored");

W.choose("units", "mm");
assert.equal(P.get("general.units"), "mm"); assert.equal(W.state().done.units, true, "choosing the current value still counts as a choice");
W.choose("units", "mil"); assert.equal(JSON.parse(store.get(P.STORE)).values["general.units"], "mil");
W.choose("units", .254, "pcbGrid"); assert.equal(P.get("pcb.grid"), .254);
W.choose("units", 2.54, "schGrid"); assert.equal(P.get("schematic.grid"), 2.54);
assert.throws(() => W.choose("units", "inch"), /mm or mil/);
W.choose("mouse", "centre", "zoomAt"); assert.equal(P.get("mouse.zoomAt"), "centre");
W.choose("mouse", true, "invertZoom"); assert.equal(P.get("mouse.invertZoom"), true);
W.choose("motion", "off"); assert.equal(T.get().motion, "off");
W.choose("motion", "system"); assert.equal(T.get().motion, "system");
assert.throws(() => W.choose("motion", "wild"), /animation level/);

// ---- skip, progress, close, reopen state ---------------------------------------------------------------
W.skip("ai");
assert.deepEqual(W.progress(), {done: 5, skipped: 1, total: 6});
W.skip("theme"); assert.equal(W.state().done.theme, true, "skipping a done step keeps it done");
W.close();
s = W.state(); assert.equal(s.closed, true); assert.equal(s.seen, true);
assert.deepEqual(Object.keys(s.done).sort(), ["from", "motion", "mouse", "theme", "units"]);
assert.equal(JSON.parse(store.get(W.STORE)).v, 1, "versioned");
// A damaged or newer store is ignored rather than trusted.
store.set(W.STORE, "{not json"); assert.equal(W.firstLaunch(), true);
store.set(W.STORE, JSON.stringify({v: 2, done: {from: true}})); assert.deepEqual(W.state().done, {});
store.set(W.STORE, JSON.stringify({v: 1, seen: true, done: {from: true}, skipped: [], from: 7}));
assert.deepEqual(W.state().skipped, {}); assert.equal(W.state().from, "");
W.reset(); assert.equal(W.firstLaunch(), true); assert.equal(store.has(W.STORE), false);
// Prefs storage registration: per-viewer state (Reset all clears it; an export leaves it out).
require("../../app/editor/prefs-storage.js");
assert.equal(AtriumPrefsStorage.kind(W.STORE), "state");

// ---- feature detection ---------------------------------------------------------------------------------
globalThis.AtriumCanvasGPUPref = {key: "display.renderer", modes: ["auto", "gpu", "2d"], describe: () => "2D: test"};
assert.ok(W.steps().includes("performance"), "Renderer appears with canvas-gpu-pref.js");
assert.equal(W.value("performance"), "auto"); assert.equal(W.value("performance", "efficiency"), undefined);
W.choose("performance", "2d"); assert.equal(P.get("display.renderer"), "2d");
assert.throws(() => W.choose("performance", "auto", "efficiency"), /not available/);
delete globalThis.AtriumCanvasGPUPref;
assert.ok(!W.steps().includes("performance"));
const power = [];
globalThis.AtriumPower = {key: "power.efficiency", modes: ["auto", "always", "off"], setMode: v => power.push(v), mode: () => "auto"};
assert.ok(W.steps().includes("performance"), "Efficiency alone shows the card");
assert.equal(W.value("performance", "efficiency"), "auto");
W.choose("performance", "always", "efficiency"); assert.deepEqual(power, ["always"], "the power module's own setter");
globalThis.AtriumPower = {key: "power.mode", modes: [{id: "battery", title: "On battery"}, {id: "off"}]};
assert.deepEqual(W.efficiency().modes, ["battery", "off"]); assert.equal(W.efficiency().titles.battery, "On battery");
W.choose("performance", "off", "efficiency"); assert.equal(P.get("power.mode"), "off", "without a setter: its preference key");
let pm = "auto";
globalThis.AtriumPower = {efficient: () => false, mode: () => pm, setMode: v => { pm = v; }};
assert.deepEqual(W.efficiency().modes, ["auto", "always", "off"], "power.js: mode()/setMode() without a list");
W.choose("performance", "always", "efficiency"); assert.equal(pm, "always");
globalThis.AtriumPower = {efficient: () => false};
assert.equal(W.efficiency(), null, "no modes: no card"); assert.ok(!W.steps().includes("performance"));
delete globalThis.AtriumPower;
globalThis.AtriumI18nCore = {available: () => [{id: "en", name: "English"}, {id: "en-XA", pseudo: true}]};
assert.ok(!W.steps().includes("language"), "English and the pseudo-locale only: no language step");
globalThis.AtriumI18nCore = {available: () => [{id: "en", name: "English"}, {id: "de", name: "German", native: "Deutsch"}]};
assert.ok(W.steps().includes("language")); W.choose("language", "de"); assert.equal(P.get("general.language"), "de");
P.set("general.language", "system"); delete globalThis.AtriumI18nCore;

// ---- fab preset for new projects (and the start page applying it) --------------------------------------
for (const m of ["parts", "library-panel", "footprint-wizard", "starter-library", "impedance", "stackup", "viastack", "polygon-pour", "rules", "rigid-flex", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "templates", "start-page"])
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
assert.ok(W.steps().includes("fab"), "fab presets present: the fab step");
assert.equal(W.value("fab"), "", "Generic by default");
const run = async () => {
  const blank = await AtriumTemplates.build("blank", {name: "B"});
  assert.equal(await AtriumStartPage.withFab(blank), null, "no preset chosen: the blank project is unchanged");
  assert.equal(blank.documents[1].fabPreset, undefined);
  W.choose("fab", "jlcpcb-4l"); assert.equal(P.get("start.fabPreset"), "jlcpcb-4l");
  const p = await AtriumTemplates.build("blank", {name: "F"});
  assert.equal(await AtriumStartPage.withFab(p), AtriumFabPresets.get("jlcpcb-4l").name);
  assert.equal(p.documents[1].fabPreset.id, "jlcpcb-4l");
  assert.equal(p.documents[1].stackup.layers.filter(AtriumStackup.isCopper).length, 4);
  Atrium.validate(JSON.parse(JSON.stringify(p)));
  W.choose("fab", ""); assert.equal(P.get("start.fabPreset"), undefined, "Generic removes the preference");
  console.log("SHIM-OK welcome");
};
run().catch(e => console.log("SHIM-FAIL " + e.message + "\n" + e.stack));
