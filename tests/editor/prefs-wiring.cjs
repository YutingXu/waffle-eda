"use strict";
// Preferences wiring: every preference a Preferences page shows has a reader (AtriumPrefs.READERS,
// checked against the files named), live changes reach the editor through AtriumNavHost.setPref,
// AtriumPref (theme.js) reads and writes before prefs.js loads, schematic placement's old
// auto-increment key migrates, auto-junctions, autosave and router readers, and the settings
// bundle (export / import, never with secrets).
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh prefs-wiring).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const store = new Map(), storage = {getItem:k => store.has(k) ? store.get(k) : null, setItem:(k, v) => store.set(k, String(v)), removeItem:k => store.delete(k)};
Object.defineProperty(globalThis, "localStorage", {value:storage, configurable:true, writable:true});
const app = path.join(__dirname, "../../app"), read = f => fs.readFileSync(require("../support/app-source-paths.cjs").appFileFrom(app, f), "utf8");

require("../../app/core/model.js");
require("../../app/editor/theme.js");

// ---- AtriumPref before prefs.js has loaded -----------------------------------------------------------
store.set("atrium.snap.v1", JSON.stringify({objects:false}));
store.set("atrium-sch-place", JSON.stringify({autoIncrement:false, step:2}));
assert.equal(AtriumPref.get("pcb.smartGuides", true), true, "nothing stored: the fallback");
AtriumPref.set("pcb.smartGuides", false);
assert.equal(AtriumPref.get("pcb.smartGuides", true), false);
assert.equal(JSON.parse(store.get("atrium.prefs")).migrate, true, "a store written early still migrates");

require("../../app/editor/prefs.js");
const P = AtriumPrefs;
assert.equal(P.get("pcb.smartGuides"), false, "the early write survives");
assert.equal(P.get("pcb.snapObjects"), false, "and the old snap key still migrated");
assert.equal(JSON.parse(store.get("atrium.prefs")).migrate, undefined);
// Schematic placement's own key: auto-increment moves into prefs, the step stays.
assert.equal(P.get("general.autoIncrement"), false);
assert.deepEqual(JSON.parse(store.get("atrium-sch-place")), {step:2});
P.reload();
assert.equal(P.get("general.autoIncrement"), false, "migrates once");
assert.equal(AtriumPref.get("general.autoIncrement", true), false, "AtriumPref reads through AtriumPrefs once loaded");

// ---- every page row has a reader -----------------------------------------------------------------------
{
  const src = read("prefs.js") + "\n" + read("prefs-routing.js");
  const shown = [...new Set([...src.matchAll(/\brow\(\w+, "([\w.]+)"/g)].map(m => m[1]))];
  assert.ok(shown.length >= 20, "found the page rows: " + shown.length);
  for (const k of shown) {
    assert.ok(k in P.DEFAULTS, k + " has a default");
    assert.ok(Array.isArray(P.READERS[k]) && P.READERS[k].length, k + " has a reader");
  }
  for (const [k, files] of Object.entries(P.READERS)) {
    assert.ok(k in P.DEFAULTS, k + " is a preference");
    for (const f of files) if (f !== "prefs.js") assert.ok(read(f).includes('"' + k + '"'), f + " reads " + k);
  }
  // Menu toggles write back (editor.js), and new projects take units and sheet defaults.
  const ed = read("editor.js");
  for (const k of ["pcb.rerouteOnDrag", "pcb.smartGuides", "pcb.designatorsFollow", "pcb.hud", "schematic.hopOvers"])
    assert.ok(ed.includes('prefOut("' + k + '"') || ed.includes('?"' + k + '"'), "editor writes " + k);
  assert.ok(/AtriumPrefs\?\.junctions\?\.\(doc\(\)/.test(ed), "finished wires get auto-junctions");
  assert.ok(/AtriumPref\?\.get\("general\.units"/.test(ed), "File › New reads the units");
}

// ---- live changes reach the editor -----------------------------------------------------------------------
{
  const calls = [], snaps = [];
  globalThis.AtriumNavHost = {setPref:(k, v) => { calls.push([k, v]); return true; }, redraw() {}};
  globalThis.AtriumPCBEdit = {setSnap:(k, v) => snaps.push([k, v]), snapPrefs:{}};
  P.set("pcb.rerouteOnDrag", false); P.set("pcb.hud", true); P.set("pcb.designatorsFollow", true); P.set("pcb.smartGuides", true);
  P.set("pcb.trackWidth", .4); P.set("schematic.hopOvers", true);
  P.set("pcb.snapObjects", true); P.set("pcb.snapRadius", 12);
  assert.deepEqual(calls, [["pcb.rerouteOnDrag", false], ["pcb.hud", true], ["pcb.designatorsFollow", true], ["pcb.smartGuides", true], ["pcb.trackWidth", .4], ["schematic.hopOvers", true]]);
  assert.deepEqual(snaps, [["objects", true], ["radius", 12]]);
  // A write back with the same value is not an event (no loop).
  calls.length = 0; AtriumPref.set("pcb.hud", true); assert.equal(calls.length, 0);
  AtriumPref.set("pcb.hud", false); assert.deepEqual(calls, [["pcb.hud", false]]);
  delete globalThis.AtriumNavHost; delete globalThis.AtriumPCBEdit;
}

// ---- sheet defaults and auto-junctions ---------------------------------------------------------------------
{
  P.set("schematic.grid", 2.54); P.set("pcb.grid", .1);
  const sch = P.sheetDefaults({kind:"schematic", items:[]}), pcb = P.sheetDefaults({kind:"pcb", items:[]});
  assert.equal(sch.grid, 2.54); assert.equal(sch.hopOvers, true); assert.equal(pcb.grid, .1); assert.equal(pcb.hopOvers, undefined);
  const doc = {kind:"schematic", items:[{id:"w1", kind:"wire", points:[[0, 0], [10, 0]]}]};
  const tee = {id:"w2", kind:"wire", points:[[5, 0], [5, 8]]}; doc.items.push(tee);
  const added = P.junctions(doc, tee);
  assert.equal(added.length, 1); assert.deepEqual([added[0].x, added[0].y], [5, 0]);
  assert.equal(P.junctions(doc, tee).length, 0, "never twice");
  // The other way round: an existing wire ends on the new one.
  const d2 = {kind:"schematic", items:[{id:"a", kind:"wire", points:[[3, 5], [3, 0]]}]}, w = {id:"b", kind:"wire", points:[[0, 0], [9, 0]]}; d2.items.push(w);
  assert.equal(P.junctions(d2, w).length, 1);
  // Corners and plain end-to-end joins get none; with the preference off, nothing is added.
  const d3 = {kind:"schematic", items:[{id:"a", kind:"wire", points:[[0, 0], [5, 0]]}]}, w3 = {id:"b", kind:"wire", points:[[5, 0], [5, 5]]}; d3.items.push(w3);
  assert.equal(P.junctions(d3, w3).length, 0);
  P.set("schematic.autoJunctions", false);
  const d4 = {kind:"schematic", items:[{id:"w1", kind:"wire", points:[[0, 0], [10, 0]]}]}, t4 = {id:"w2", kind:"wire", points:[[5, 0], [5, 8]]}; d4.items.push(t4);
  assert.equal(P.junctions(d4, t4).length, 0);
  P.reset(["schematic.autoJunctions", "schematic.grid", "pcb.grid", "schematic.hopOvers"]);
}

// ---- schematic placement reads general.autoIncrement ---------------------------------------------------------
{
  require("../../app/schematic/sch-place.js");
  const S = AtriumSchPlace;
  assert.equal(S.prefs().autoIncrement, false); assert.equal(S.prefs().step, 2);
  assert.equal(S.toggleAutoIncrement(), true);
  assert.equal(P.get("general.autoIncrement"), true, "the menu toggle writes the preference");
  P.set("general.autoIncrement", false);
  assert.equal(S.prefs().autoIncrement, false, "a preference change is live");
  P.reset(["general.autoIncrement"]);
}

// ---- autosave: the enable flag and the interval ------------------------------------------------------------
async function checkAutosave() {
  require("../../app/project/folder-drafts.js");
  const {shelf} = require("../project/folder-drafts.cjs");
  const fixture = require("../support/native-save-session.cjs"), store = shelf();
  const real = {now:Date.now,set:setTimeout,clear:clearTimeout,host:globalThis.AtriumNavHost};
  let time=100000, serial=0, session, beforeCommit;
  const timers = new Map();
  const advance = async ms => {
    time+=ms;
    for (const [id,task] of [...timers]) if (task.when <= time) {timers.delete(id); await task.call();}
  };
  const nextDelay = () => Math.min(...Array.from(timers.values(),t=>t.when-time));
  const open = async () => {const f=await fixture.open({draftStore:store,beforeCommit:r=>beforeCommit?.(r)});session=f.session;return f;};
  P.set("general.autosave",false);
  let f=await open();
  globalThis.AtriumNavHost={folderProject:()=>session};
  Date.now=()=>time;
  globalThis.setTimeout=(call,ms)=>{timers.set(++serial,{call,when:time+ms});return serial;};
  globalThis.clearTimeout=id=>timers.delete(id);
  try {
    f.edit("Power","DISABLED");
    await session.flushDrafts();
    assert.deepEqual([session.draftMetrics().writes,timers.size],[0,0],"off: an edit or urgent flush cannot write a private draft");
    P.set("general.autosaveMinutes",2);
    P.set("general.autosave",true);
    await advance(nextDelay());
    assert.equal(session.draftMetrics().writes,1,"enabling with pending edits creates the first draft after the normal debounce");
    assert.equal(timers.size,0,"an unchanged folder has no periodic timer");

    f.edit("Power","MINIMUM");
    assert.equal(nextDelay(),120000,"the next dirty checkpoint uses the configured two-minute interval");
    await advance(119999);
    assert.equal(session.draftMetrics().writes,1);
    await advance(1);
    assert.equal(session.draftMetrics().writes,2);
    f.edit("Power","LONGER");
    P.set("general.autosaveMinutes",10);
    assert.equal(nextDelay(),600000,"a changed interval re-arms the pending checkpoint");
    P.set("general.autosaveMinutes",1);
    assert.equal(nextDelay(),60000);
    P.set("general.autosave",false);
    assert.equal(timers.size,0,"turning autosave off cancels the already-armed timer");
    await session.close();
    assert.equal(session.draftMetrics().writes,2,"closing while disabled retains the previously saved draft");
    assert.equal(store.data.size,1);

    f=await open();
    const offers=await session.listDrafts();
    assert.equal(offers.length,1,"a restarted folder offers its stored draft while autosave is disabled");
    await session.resolveDraft(offers[0],"keep");
    assert.equal((await session.listDrafts()).length,1);
    await session.resolveDraft(offers[0],"discard");
    assert.equal((await session.listDrafts()).length,0);
    P.set("general.autosave",true);
    assert.equal(timers.size,0,"re-enabling a clean folder starts no work");
    f.edit("Power","RESTARTED");
    assert.ok(nextDelay()<=20000,"a fresh session gets its own first checkpoint");
    await advance(nextDelay());
    assert.equal(session.draftMetrics().writes,1);
    assert.deepEqual(await f.read("Power.wsch"),f.originals.get("Power.wsch"),"private checkpoints never alter saved project bytes");

    await session.activate("Control");
    f.edit("Control","PREVIOUS PRIVATE");
    await session.flushDrafts();
    P.set("general.autosave",false);
    f.edit("Control","NEWER DISABLED EDIT");
    let resumeCommit, commitStarted;
    const resume=new Promise(resolve=>{resumeCommit=resolve;}), accepted=new Promise(resolve=>{commitStarted=resolve;});
    beforeCommit=async()=>{commitStarted();await resume;};
    const saving=session.save({documentId:"Power"});
    await accepted;
    f.edit("Power","AFTER THE MANUAL SAVE STARTED");
    resumeCommit();
    await saving;
    beforeCommit=undefined;
    await session.flushDrafts();
    const [remaining] = store.data.values();
    assert.deepEqual(remaining.head.rows.map(row=>row.id),["Control"],"an explicit Save retires only its covered private row");
    assert.equal(remaining.members.get("Control").owner.items[0].text,"PREVIOUS PRIVATE","retiring a row does not checkpoint a disabled edit");
    assert.deepEqual(f.commits.at(-1).plan.map(entry=>entry.path),["Power.wsch"]);
    assert.equal(AtriumFormat2.parse(await f.read("Power.wsch")).get("n").text,"RESTARTED");
    assert.equal(session.project.documents.find(d=>d.id==="Power").items[0].text,"AFTER THE MANUAL SAVE STARTED");
    assert.deepEqual(await f.read("Control.wsch"),f.originals.get("Control.wsch"));

    await session.close();
    P.set("general.autosave",true);
    f=await open();
    let accept, entered;
    const pending=new Promise(resolve=>{accept=resolve;}), writing=new Promise(resolve=>{entered=resolve;});
    const write=store.write;
    store.write=async (...args)=>{entered();await pending;return write(...args);};
    f.edit("Power","SLOW CHECKPOINT");
    const firstCheckpoint=advance(nextDelay());
    await writing;
    f.edit("Power","WHILE STORAGE IS BUSY");
    const secondCheckpoint=advance(nextDelay());
    accept();
    await Promise.all([firstCheckpoint,secondCheckpoint]);
    store.write=write;
    assert.equal(session.draftMetrics().writes,1,"a timer queued behind a slow first checkpoint retains the configured interval");
    assert.equal(nextDelay(),60000);
    await advance(60000);
    assert.equal(session.draftMetrics().writes,2);
  } finally {
    await session.close();
    Date.now=real.now;globalThis.setTimeout=real.set;globalThis.clearTimeout=real.clear;
    globalThis.AtriumNavHost=real.host;
    P.reset(["general.autosave","general.autosaveMinutes"]);
  }
}

// ---- router defaults ---------------------------------------------------------------------------------------
{
  require("../../app/pcb/router.js");
  const board = {id:"b", kind:"pcb", name:"B", grid:.1, outline:[[0, 0], [20, 0], [20, 20], [0, 20]], items:[]};
  P.set("pcb.trackWidth", .33); P.set("pcb.viaDiameter", .7); P.set("pcb.viaDrill", .35);
  const pr = AtriumRouter.presets(board, "N1");
  assert.equal(pr.preferredWidth, .33, "no width rule: the preference");
  assert.deepEqual(pr.preferredVia, {diameter:.7, drill:.35});
  P.reset(["pcb.trackWidth", "pcb.viaDiameter", "pcb.viaDrill"]);
  const d = AtriumRouter.presets(board, "N1");
  assert.equal(d.preferredWidth, .25); assert.deepEqual(d.preferredVia, {diameter:.6, drill:.3});
}

// ---- settings bundle -------------------------------------------------------------------------------------------
{
  require("../../app/editor/keymap.js");
  AtriumKeymap.useStorage(storage); AtriumTheme.useStorage(storage);
  P.set("general.units", "mil");
  AtriumTheme.set({preset:"light", accent:"#2bb3a3"});
  AtriumKeymap.setBindings("save", ["Mod+Alt+9"]);
  store.set("atrium.collapsed-panels", JSON.stringify(["Projects"]));
  store.set("atrium.pcbView.v1", JSON.stringify({colors:{Top:"#ff2200"}, system:{}, opacity:{}, apiKey:"x", note:"sk-abcdef"}));
  const text = P.exportSettings(), b = JSON.parse(text);
  assert.equal(b.format, "atrium-settings");
  assert.equal(b.prefs["general.units"], "mil");
  assert.equal(b.theme.preset, "light"); assert.equal(b.theme.accent, "#2bb3a3");
  assert.deepEqual(b.keymap.bindings.save, [{key:"Mod+Alt+9"}]);
  assert.deepEqual(b.layout.collapsedPanels, ["Projects"]);
  assert.equal(b.layout.pcbView.colors.Top, "#ff2200");
  assert.ok(!/apiKey|sk-abc/.test(text), "no secrets in the bundle");
  // Fresh machine: import everything.
  P.reset(); AtriumTheme.reset(); AtriumKeymap.resetAll(); store.delete("atrium.collapsed-panels");
  const r = P.importSettings(JSON.stringify({...b, prefs:{...b.prefs, "ai.token":"t"}, extra:{password:"p"}}));
  assert.deepEqual(r.applied, ["preferences", "appearance", "key map", "panel layout"]);
  assert.ok(r.skipped.some(s => /token/.test(s)), "secret-looking keys are dropped on import");
  assert.equal(P.get("general.units"), "mil"); assert.equal(AtriumTheme.get().preset, "light");
  assert.deepEqual(AtriumKeymap.bindingsFor("save").map(x => x.key), ["Mod+Alt+9"]);
  assert.equal(store.get("atrium.collapsed-panels"), '["Projects"]');
  assert.throws(() => P.importSettings('{"format":"atrium-prefs"}'), /not a Waffle settings file/);
  assert.throws(() => P.importSettings('{"format":"atrium-settings","version":9}'), /newer/);
  assert.equal(P.scrub({tokens:{a:"#fff"}}).tokens.a, "#fff", "theme tokens are not secrets");
}
globalThis.__testDone = checkAutosave().then(() => console.log("Preferences wiring and native private draft scheduling passed"));
globalThis.__testDone.catch(e => { console.error(e); if (typeof process !== "undefined") process.exitCode = 1; });
