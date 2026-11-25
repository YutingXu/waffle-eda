"use strict";
// Online native diagnostics finish at the point of check demand, even with no
// ordinary findings and no marker painter to pull in the worker's dependency.
const assert = require("node:assert/strict");
for (const m of ["model", "nav-common", "spatial", "connectivity", "pcb-appearance", "pcb-text", "vectorize",
  "pcb-text-rich", "designator-place", "pcb/mask-openings", "rules", "drc", "checks", "drc-fixes", "drc-view", "undo-store"]) {
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
}
const V = AtriumDRCView, K = AtriumChecks, U = AtriumUndoStore, fixes = AtriumDRCFixes;
const deck = id => ({kind:"pcb", id, name:id, outline:[[-10, -10], [20, -10], [20, 20], [-10, 20]], items:[
  {kind:"track", id:"end", layer:"Top", net:"OPEN", width:.25, points:[[0, 0], [3, 0]]}
]});
const sheet = {kind:"schematic", id:"sheet", items:[]};
const defs = new Map(), jobs = new Map();
let document = deck("first"), panes = [document], project = {}, home = true, requested = 0, release, paint;
function install(...docs) {
  project = {format:"atrium", name:"Native DRC demand", documents:[sheet, ...docs], library:[]};
  U.reset(); U.record(project);
}
const host = {project:() => project, doc:() => panes[0], panes:() => panes.map(d => ({docId:d.id})),
  docById:id => project.documents.find(d => d.id === id), defs:() => defs, invalidate() {}, invalidateDocument() {},
  registerAction() {}, addRenderer(fn) {paint = fn;}, info() {}, on() {},
  stageEdit(phase, key, fn) {
    const job = {key, fn}; jobs.set(key, job);
    return {cancel() {if (jobs.get(key) === job) jobs.delete(key);}};
  }};
globalThis.AtriumStartPage = {isOpen:() => home};
globalThis.AtriumLazy = {modules:() => ["AtriumDRCFixes"], need(name) {
  assert.equal(name, "AtriumDRCFixes"); requested++;
  return new Promise(resolve => {release = () => {
    globalThis.AtriumDRCFixes = fixes;
    resolve(fixes);
  };});
}};
const cold = () => {delete globalThis.AtriumDRCFixes;};
const yieldLoad = async () => {release(); await Promise.resolve();};
const finish = () => {
  for (const job of [...jobs.values()]) {jobs.delete(job.key); job.fn(() => true, {timeRemaining:() => 100});}
};
async function test() {
  install(document); cold();
  K.scheduler.attach(host); V.attach(host);
  assert.equal(V.check(), null);
  assert.equal(requested, 0, "Home does not demand diagnostics");
  home = false;
  V.setEnabled(false);
  assert.equal(V.check(), null); assert.equal(requested, 0, "disabled Online DRC does not load diagnostics");
  V.setEnabled(true);
  document.ruleCheckSelection = {online:["netAntennae", "courtyard"], batch:[]};
  U.record(project);
  assert.ok(V.check());
  assert.equal(requested, 0, "a disabled online check selection leaves the optional module cold");
  assert.deepEqual(V.violations(document.id), [], "the fixture has no ordinary findings");
  delete document.ruleCheckSelection;
  U.record(project);
  assert.equal(V.check(null, deck("inactive")), null);
  assert.equal(requested, 0, "a board without a pane cannot demand diagnostics");

  assert.equal(V.check(), null); assert.equal(requested, 1);
  panes = [sheet];
  jobs.clear(); await yieldLoad();
  assert.equal(jobs.size, 0, "a departed pane cannot resume the check");
  assert.deepEqual(V.violations(document.id), []);

  cold(); panes = [document];
  assert.equal(V.check(), null); assert.equal(requested, 2);
  V.setEnabled(false);
  jobs.clear(); await yieldLoad();
  assert.equal(jobs.size, 0, "disabling Online DRC cancels a pending publication");

  cold();
  V.setEnabled(true);
  assert.equal(V.check(), null); assert.equal(requested, 3);
  const previous = document;
  document = deck("replacement"); panes = [document]; install(document);
  assert.equal(V.check(), null); assert.equal(requested, 3, "both requests share the module load");
  jobs.clear(); await yieldLoad();
  assert.deepEqual([...jobs.keys()], ["online-drc:replacement"]);
  finish();
  const coldFindings = V.violations(document.id);
  assert.ok(coldFindings.some(v => v.type === "netAntennae"), "actual native findings publish with no renderer or further edit");
  assert.deepEqual(V.violations(previous.id), []);
  assert.ok(V.check(), "a subsequent warm online check completes");
  assert.deepEqual(V.violations(document.id), coldFindings, "cold and warm findings agree with the same enabled checks");
  const items = document.items, pane = {docId:document.id};
  const overlay = {}, hit = {};
  const findings = V.violations(document.id);
  let itemReads = 0, eligibilityScans = 0, paints = 0, hits = 0;
  Object.defineProperty(document, "items", {configurable:true, get() {itemReads++; return items;}});
  findings.some = function (...args) {eligibilityScans++; return Array.prototype.some.apply(this, args);};
  globalThis.AtriumDRCMarkers = {
    renderFor() {paints++; return overlay;},
    groupAt() {hits++; return hit;}
  };
  for (let frame = 0; frame < 1000; frame++) {
    assert.equal(paint(document), overlay);
    assert.equal(V.groupAt(pane, frame, frame + 1), hit);
  }
  assert.equal(itemReads, 0, "render and hit gates read committed counters without scanning PCB items");
  assert.equal(eligibilityScans, 0, "drawable findings are checked once at publication, outside camera and pointer frames");
  assert.deepEqual([paints, hits], [1000, 1000], "each ready frame and hit reaches the canonical owner");
  delete findings.some;
  Object.defineProperty(document, "items", {configurable:true, writable:true, value:items});
  console.log("PASS live DRC demand converges after optional diagnostics load and drops cancelled pane and project work");
}
function checkRuleScopes() {
  const app = require("../support/app-source-paths.cjs").appFile;
  const saved = globalThis.AtriumLazy;
  require(app("lazy.js")); require(app("project-rules.js")); require(app("polygon-pour.js"));
  const lazy = globalThis.AtriumLazy, reader = globalThis.AtriumDesignQueryRecord;
  globalThis.AtriumDesignQueryRecord=undefined;
  const simple = {languageVersion:1, bindings:[], source:" Object "};
  const scope = {languageVersion:1, bindings:[], source:"track where width < 2 mm"};
  const scoped = (where, extra) => ({version:2, list:[{type:"clearance", scope:where, ...extra}]});
  const cases = [
    [{version:1, nets:{GND:{clearance:.25}}}, true, true],
    [scoped(simple), false, false], [scoped(scope), true, true],
    [scoped(scope, {severity:"off"}), false, true],
    [{...scoped(scope, {set:"Hidden"}), ruleSets:[{name:"hidden", enabled:false}]}, false, true],
    [scoped({source:"object"}), true, false]
  ];
  try {
    for (const [rules, eager, detached] of cases) {
      globalThis.AtriumLazy=lazy;
      assert.equal(lazy.validatorsFor({rules, documents:[]}).includes("AtriumDesignQuery"), eager);
      assert.equal(AtriumPolygonPour.queryPending(deck("scope"), {rules}), eager, "eager " + JSON.stringify(rules));
      globalThis.AtriumLazy=undefined;
      assert.equal(AtriumPolygonPour.queryPending(deck("scope"), {rules}), detached, "detached " + JSON.stringify(rules));
    }
    assert.equal(lazy.needsRuleQuery(cases[0][0], "schematic"), false);
    globalThis.AtriumDesignQueryRecord=reader;
    assert.equal(AtriumPolygonPour.queryPending(deck("scope"), {rules:cases.at(-1)[0]}), true);
  } finally { globalThis.AtriumLazy=saved; globalThis.AtriumDesignQueryRecord=reader; }
  console.log("PASS rule scopes: cold validators and detached pour retain version, disabled-set and severity policy");
}
test().then(checkRuleScopes).then(() => { console.log("SHIM-OK"); }, e => { console.error(e); if (typeof process !== "undefined") process.exitCode = 1; });
