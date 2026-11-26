"use strict";
// Online native diagnostics finish at the point of check demand, even with no
// ordinary findings and no marker painter to pull in the worker's dependency.
const assert = require("node:assert/strict");
for (const m of ["model", "nav-common", "spatial", "connectivity", "pcb-appearance", "pcb-text", "vectorize",
  "pcb-text-rich", "designator-place", "pcb/mask-openings", "rules", "drc", "checks", "drc-fixes", "drc-view", "problem-marks", "drc-markers", "drc-inspector", "length-tuning", "undo-store"]) {
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
}
const V = AtriumDRCView, K = AtriumChecks, U = AtriumUndoStore, fixes = AtriumDRCFixes;
const inspector = AtriumDRCInspector, markers = AtriumDRCMarkers, length = AtriumLength;
const deck = id => ({kind:"pcb", id, name:id, outline:[[-10, -10], [20, -10], [20, 20], [-10, 20]], items:[
  {kind:"track", id:"end", layer:"Top", net:"OPEN", width:.25, points:[[0, 0], [3, 0]]}
]});
const sheet = {kind:"schematic", id:"sheet", items:[]};
const defs = new Map(), jobs = new Map(), events = new Map();
const badge = {dataset:{}, textContent:"", setAttribute(name, value) {this[name] = value;}, addEventListener() {}};
const emit = name => {for (const fn of events.get(name) || []) fn();};
let document = deck("first"), panes = [document], project = {}, home = true, requested = 0, release, paint;
function install(...docs) {
  project = {format:"atrium", name:"Native DRC demand", documents:[sheet, ...docs], library:[]};
  U.reset(); U.record(project);
}
const host = {project:() => project, doc:() => panes[0], panes:() => panes.map(d => ({docId:d.id})),
  docById:id => project.documents.find(d => d.id === id), defs:() => defs, units:() => "mm", invalidate() {}, invalidateDocument() {},
  registerAction() {}, addRenderer(fn) {paint = fn;}, info() {},
  on(name, fn) {if (!events.has(name)) events.set(name, []); events.get(name).push(fn);},
  connections:() => AtriumConnectivity.inspect(panes[0], defs),
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
  globalThis.document = {getElementById:id => id === "status-problems" ? badge : null, addEventListener() {}, removeEventListener() {}};
  globalThis.AtriumPrefs = {registerPage() {}};
  K.scheduler.attach(host); V.attach(host); inspector.attach(host);
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
async function manualOnlineSelection() {
  const hasViaStyle = rows => rows.some(v => v.type === "viaStyle" && v.id === "narrow-drill");
  const board = deck("manual-board");
  board.items.push({kind:"via", id:"narrow-drill", net:"VIA", x:5, y:5, diameter:.6, drill:.1, layer:"Multi"});
  const extras = ["netAntennae", "courtyard"];
  board.ruleCheckSelection = {online:extras, batch:[...extras, "viaStyle"]};
  panes = [board]; install(board);
  project.rules = AtriumRules.create();
  project.rules.list.find(r => r.type === "viaStyle").holeMin = .25;
  U.record(project);
  jobs.clear();

  const manual = await V.run();
  assert.equal(manual.complete, true);
  assert.equal(hasViaStyle(manual.violations), false, "the manual report honors its batch settings");
  assert.equal(hasViaStyle(V.violations(board.id)), false, "the immediate publication uses the batch result");
  assert.ok(K.scheduler.pending("drc", board), "an unseeded online engine queues a same-revision check");
  finish();
  assert.ok(hasViaStyle(V.violations(board.id)), "online-only findings publish without another edit or toggle");
  assert.equal(hasViaStyle(manual.violations), false, "online refresh leaves the manual report intact");
  const complete = V.violations(board.id);
  K.scheduler.plan("drc", {now:true});
  assert.equal(jobs.size, 0, "a settled journal-backed result does not queue again");

  board.ruleCheckSelection.batch = extras;
  U.record(project);
  const reusable = await V.run();
  assert.ok(hasViaStyle(reusable.violations));
  K.scheduler.plan("drc", {now:true});
  assert.equal(jobs.size, 0, "a reusable manual seed needs no follow-up check");
  assert.deepEqual(V.violations(board.id), complete, "the reusable seed holds the same findings");

  board.ruleCheckSelection.batch = [...extras, "viaStyle"];
  globalThis.AtriumUndoStore = undefined;
  try {
    const withoutJournal = await V.run();
    assert.equal(hasViaStyle(withoutJournal.violations), false);
    assert.ok(K.scheduler.pending("drc", board), "a host without a journal still queues its online check");
    finish();
    assert.ok(hasViaStyle(V.violations(board.id)));
  } finally {globalThis.AtriumUndoStore = U;}
  console.log("PASS manual batch selection restores online-only findings through the scheduler");
}
async function manualPublicationContinues() {
  const board = deck("manual-publication");
  board.items[0].width = .08;
  board.items.push({kind:"via", id:"drill", net:"VIA", x:5, y:5, diameter:.6, drill:.1, layer:"Multi"});
  const extras = ["netAntennae", "courtyard"];
  board.ruleCheckSelection = {online:extras, batch:[...extras, "viaStyle"]};
  panes = [board]; install(board);
  const R = AtriumRules;
  project.rules = R.create();
  project.rules.list.find(r => r.type === "viaStyle").holeMin = .25;
  project.rules.list.push({id:"length", type:"length", name:"Trace length", comment:"", enabled:true,
    priority:1, scope:AtriumDesignQueryRecord.selector("all"), max:20});
  U.record(project);
  emit("document");

  const savedLazy = globalThis.AtriumLazy;
  globalThis.AtriumDRCMarkers = markers;
  let releaseLength;
  globalThis.AtriumLazy = {modules:() => ["AtriumLength"], need(name) {
    assert.equal(name, "AtriumLength");
    return new Promise(resolve => {releaseLength = () => {globalThis.AtriumLength = length; resolve(length);};});
  }};
  const publish = () => ({count:K.problemReport(project).total, busy:badge["aria-busy"], status:badge.textContent,
    state:badge.dataset.state, pending:K.meta(board.id, "drc")?.pending, inspector:inspector.current()});
  const held = [];
  const stop = K.on(() => held.push(publish()));
  const visible = () => V.violations(board.id);
  async function start() {
    delete globalThis.AtriumLength;
    releaseLength = null;
    jobs.clear();
    await V.run();
    const original = visible();
    const width = original.find(v => v.type === "width");
    assert.ok(width, "manual result includes the narrow track");
    assert.ok(inspector.open(host, width), "the production Violation inspector is open");
    const before = publish();
    assert.equal(before.busy, "false");
    assert.equal(before.pending, false);
    held.length = 0;
    return {before, original, width};
  }
  async function release() {
    assert.equal(typeof releaseLength, "function", "the real length dependency is waiting");
    releaseLength();
    await Promise.resolve();
    await Promise.resolve();
  }
  try {
    const {before, original, width} = await start();
    finish();
    await Promise.resolve();
    assert.deepEqual(publish(), before, "Problems and the open inspector survive the same-stamp wait");
    assert.equal(visible(), original, "the same-stamp manual marker rows survive a delayed follow-up");
    emit("change"); finish();
    await Promise.resolve();
    assert.deepEqual(publish(), before, "repeated revision notifications preserve publication while waiting");
    await release();
    assert.equal(visible(), original, "an optional module becoming ready retains the manual marker rows until the next result");
    assert.deepEqual(publish(), before);
    finish();
    await Promise.resolve();
    assert.ok(visible().some(v => v.type === "viaStyle"), "the complete online publication adds its missing type");
    assert.equal(publish().count, before.count + 1, "Problems counts the replacement publication");
    assert.ok(held.length && held.every(p => p.busy === "false" && !p.pending && p.count >= before.count),
      "each publication has resolved Problems with its findings");
    assert.equal(inspector.current()?.id, width.id, "the inspector follows the same violation in the replacement");
    assert.ok(visible().includes(inspector.current()), "the pin refers to a finding in the new publication");
    assert.equal(jobs.size, 0);

    await start();
    finish();
    assert.ok(inspector.isOpen());
    board.items[0].width = .25;
    U.record(project);
    emit("change");
    assert.deepEqual(visible(), [], "a committed board edit immediately clears stale findings");
    assert.equal(K.meta(board.id, "drc")?.pending, true);
    assert.equal(badge["aria-busy"], "true");
    assert.equal(badge.textContent, "Checking…");
    assert.equal(inspector.isOpen(), false, "an inspector on a genuinely stale finding closes");
    await release();
    finish();
    assert.ok(visible().some(v => v.type === "viaStyle"));
    assert.ok(!visible().some(v => v.type === "width"), "the interrupted follow-up cannot republish the obsolete width finding");
  } finally {
    stop(); inspector.close();
    globalThis.AtriumLength = length; globalThis.AtriumLazy = savedLazy;
    delete globalThis.document; delete globalThis.AtriumPrefs;
  }
  console.log("PASS manual DRC rows, Problems and the open inspector persist through a same-revision recheck");
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
test().then(manualOnlineSelection).then(manualPublicationContinues).then(checkRuleScopes).then(() => { console.log("SHIM-OK"); }, e => { console.error(e); if (typeof process !== "undefined") process.exitCode = 1; });
