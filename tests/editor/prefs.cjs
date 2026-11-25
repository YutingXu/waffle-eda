"use strict";
// AtriumPrefs: one versioned preferences object, migration from older keys, change events,
// import/export without secrets, and sheet defaults.
const assert=require("node:assert/strict");
const store=new Map(),storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
Object.defineProperty(globalThis,"localStorage",{value:storage,configurable:true,writable:true});
// An older install: object snap settings in their own key.
store.set("atrium.snap.v1",JSON.stringify({grid:true,objects:false,radius:12,pads:true}));
require("../../app/core/model.js");
require("../../app/editor/labs.js");
require("../../app/editor/prefs.js");
const P=AtriumPrefs;

// Migration: the snap key becomes prefs; the old key stays for pcb-edit.js.
assert.equal(P.get("pcb.snapObjects"),false);
assert.equal(P.get("pcb.snapRadius"),12);
assert.equal(P.get("pcb.snapGrid"),true,"defaults are not stored");
const saved=JSON.parse(store.get(P.STORE));
assert.equal(saved.format,"atrium-prefs");assert.equal(saved.version,1);
assert.deepEqual(saved.values,{"pcb.snapObjects":false,"pcb.snapRadius":12});
assert.ok(store.has("atrium.snap.v1"));
// Migration runs once: a stored prefs object wins over the old key.
store.set("atrium.snap.v1",JSON.stringify({objects:true}));P.reload();
assert.equal(P.get("pcb.snapObjects"),false);

// The retired preference travels with settings as inert data, including a
// stored value equal to the former default and uninterpreted future values.
const retired = "pcb.violationDetails";
assert.equal(P.DEFAULTS[retired],undefined);
assert.equal(P.READERS[retired],undefined);
for (const value of ["hover","click",{mode:"future"}]) {
  const bundle={format:P.FORMAT,version:1,values:{[retired]:value}};
  store.set(P.STORE,JSON.stringify(bundle));P.reload();
  assert.deepEqual(JSON.parse(P.exportJSON()).values[retired],value);
  P.reset([retired]);P.importJSON(JSON.stringify(bundle));P.reload();
  assert.deepEqual(JSON.parse(P.exportJSON()).values[retired],value);
}
P.reset([retired]);

// get/set with validation and clamping.
assert.equal(P.get("general.units"),"mm");
assert.equal(P.get().general===undefined,true);
assert.equal(P.get()["pcb.smartGuides"],true);
assert.throws(()=>P.set("general.units","furlong"),/one of mm, mil/);
assert.equal(P.set("pcb.snapRadius",99),40,"clamped to the range");
assert.equal(P.set("general.autoIncrement","false"),false);
assert.throws(()=>P.set("schematic.grid","wide"),/number/);
// Change events, with an optional key prefix; unchanged values emit nothing.
const seen=[],pcb=[];
const off=P.on(e=>seen.push(e.key+"="+e.value)),offPcb=P.on("pcb.",e=>pcb.push(e.key));
P.set("general.units","mil");P.set("general.units","mil");P.set({"pcb.hud":true,"schematic.grid":2.54});
assert.deepEqual(seen,["general.units=mil","pcb.hud=true","schematic.grid=2.54"]);
assert.deepEqual(pcb,["pcb.hud"]);
off();offPcb();P.set("pcb.hud",false);assert.equal(seen.length,3);
// Setting a value back to its default removes it from storage.
assert.equal(JSON.parse(store.get(P.STORE)).values["pcb.hud"],undefined);
// Other modules may add their own keys.
P.set("bom.lastView","Grouped");assert.equal(P.get("bom.lastView"),"Grouped");

// Secrets never enter prefs, exports or imports.
assert.throws(()=>P.set("ai.apiKey","sk-123"),/secrets/);
assert.throws(()=>P.set("suppliers.token","x"),/secrets/);
const text=P.exportJSON(),data=JSON.parse(text);
assert.equal(data.format,"atrium-prefs");assert.equal(data.values["general.units"],"mil");
assert.doesNotMatch(text,/apiKey|sk-/i);
assert.doesNotMatch(JSON.stringify(JSON.parse(text).values),/token/i);
store.set(P.STORE,JSON.stringify({format:"atrium-prefs",version:1,values:{"general.units":"mil","ai.apiKey":"leak"}}));P.reload();
assert.equal(P.get("ai.apiKey"),undefined,"a stored secret is dropped on load");
assert.doesNotMatch(P.exportJSON(),/leak/);

// Import: validates, applies, skips secrets and bad values; refuses other files and newer versions.
P.reset();assert.equal(P.get("general.units"),"mm");
const r=P.importJSON(JSON.stringify({format:"atrium-prefs",version:1,values:{"general.units":"mil","pcb.trackWidth":.2,"ai.token":"x","general.startPage":"sometimes"}}));
assert.deepEqual(r.skipped.sort(),["ai.token","general.startPage"]);
assert.equal(P.get("general.units"),"mil");assert.equal(P.get("pcb.trackWidth"),.2);
assert.throws(()=>P.importJSON("{}"),/not a Waffle preferences file/);
assert.throws(()=>P.importJSON("nope"),/not valid JSON/);
assert.throws(()=>P.importJSON(JSON.stringify({format:"atrium-prefs",version:9,values:{}})),/newer Waffle/);
// Round trip.
const before=P.get();P.importJSON(P.exportJSON());assert.deepEqual(P.get(),before);

// Sheet defaults for sheets the user adds: only values that differ from the defaults.
P.reset();
let s=P.sheetDefaults(Atrium.sheet("schematic","S"));assert.equal(s.grid,1.27);assert.equal(s.sheet,undefined);
P.set({"schematic.grid":2.54,"schematic.sheetSize":"A3","schematic.orientation":"portrait","pcb.grid":.1});
s=P.sheetDefaults(Atrium.sheet("schematic","S"));assert.equal(s.grid,2.54);assert.deepEqual(s.sheet,{size:"A3",orientation:"portrait"});
assert.equal(P.sheetDefaults(Atrium.sheet("pcb","B")).grid,.1);
assert.deepEqual(Object.keys(P.changed()).sort(),["pcb.grid","schematic.grid","schematic.orientation","schematic.sheetSize"]);
const usualPages = ["general","schematic","pcb","routing","appearance","keyboard","extensions","library","labs"];
const pageIds = () => P.pages().map(p => p.id);
assert.deepEqual(pageIds(), usualPages);
assert.equal(P.pages().find(page => page.id === "labs").title, "Experimental features");
const labs = AtriumLabs;
assert.equal(labs.notebookEnabled(), false, "a fresh profile has notebook authoring off");
const priorModes = [], unlistenBefore = labs.beforeChange(enabled => priorModes.push([labs.notebookEnabled(), enabled]));
const transitions = [], unlisten = labs.onChange(enabled => transitions.push(enabled));
assert.equal(labs.notebookSignal().aborted, true);
P.set("labs.notebook", true);
assert.deepEqual(pageIds(), usualPages, "Command palette preferences stay within Keyboard when notebook features are enabled");
const enabledSignal = labs.notebookSignal();
assert.equal(enabledSignal.aborted, false);
assert.equal(JSON.parse(store.get(P.STORE)).values["labs.notebook"], true);
P.set("labs.notebook", true);
P.reset(["labs.notebook"]);
assert.deepEqual(pageIds(), usualPages);
assert.deepEqual(transitions, [true, false]);
assert.deepEqual(priorModes, [[false, true], [true, false]]);
assert.equal(enabledSignal.aborted, true);
P.set("labs.notebook", true);
assert.notEqual(labs.notebookSignal(), enabledSignal);
const draftSignal = labs.notebookSignal();
const keepDraft = labs.beforeChange(enabled => enabled);
assert.throws(() => P.set("labs.notebook", false), /Finish editing/);
P.reset(["labs.notebook"]);
assert.equal(P.get("labs.notebook"), true);
assert.equal(draftSignal.aborted, false);
keepDraft();
unlisten();
unlistenBefore();
P.reset(["labs.notebook"]);
const optIns = {"labs.notebook":true, "butter.visualHistory":true, "butter.numericFields":true};
store.set(P.STORE,JSON.stringify({format:P.FORMAT,version:P.VERSION,values:optIns}));
P.reload();
assert.equal(P.get("labs.notebook"), true);
assert.equal(labs.butterEnabled("visualHistory"), true);
assert.equal(labs.butterEnabled("numericFields"), true);
assert.deepEqual(JSON.parse(P.exportJSON()).values, optIns);
P.reset();
const page=P.registerPage({id:"demo",title:"Demo",order:50,render(){}});
assert.ok(P.pages().some(p=>p.id==="demo"));page.dispose();assert.ok(!P.pages().some(p=>p.id==="demo"));
// Lazy-loaded and small.
const size=require("node:fs").readFileSync(require("node:path").join(__dirname,"../..","app","editor","prefs.js")).length;
// Raised from 40,000 on 2026-11-19 after four features added settings. New feature pages should
// self-register from their own lazy module with AtriumPrefs.registerPage (as camera.js does) rather than grow prefs.js.
// 50,500 on 2026-11-19: the extend() hook that lets prefs-storage.js add tools' own keys to export and reset.
// 51,000 on 2026-11-20: Schematic › General › Single "\" negation (a row on an existing page; the redraw lives in sch-appearance.js).
// The Settings sidebar, responsive page picker and per-setting reset share the same lazy Preferences module.
assert.ok(size<57000,"prefs.js "+size+" bytes");
console.log("SHIM-OK prefs");
