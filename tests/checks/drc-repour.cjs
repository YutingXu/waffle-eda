"use strict";
// Online DRC and pour-only changes (app/checks/drc-view.js, app/history/undo-store.js outer()): a live pour's repour
// changes no board item, so the whole-board extra checks (AtriumDRCFixes.online: net antennae, missing
// courtyards) are not run again; a real edit, a library edit or a layer-name edit still re-checks.
// Node: node tests/checks/drc-repour.cjs   JSC: scripts/test-jsc.sh drc-repour
const assert = require("node:assert/strict");
for (const m of ["model", "nav-common", "spatial", "connectivity", "rules", "drc", "pcb-edit", "drc-view", "problem-marks", "drc-markers", "drc-fixes", "drc-pours", "checks", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../support/drc-geometry.cjs");
const V = AtriumDRCView, U = AtriumUndoStore, F0 = AtriumDRCFixes, scheduler = AtriumChecks.scheduler;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

const fp = {id: "r2", name: "R", footprint: {name: "R0603", courtyard: [-1.5, -.8, 1.5, .8], shapes: [],
  pads: [{number: "1", x: -.75, y: 0, w: .8, h: .9, shape: "rect"}, {number: "2", x: .75, y: 0, w: .8, h: .9, shape: "rect"}]}};
const track = (id, net, points) => ({kind: "track", id, net, points, width: .25, layer: "Top"});
const region = (n, x = 25 + n / 100, y = 6) => AtriumPCBPours.region(
  [[[x,y],[x+2,y],[x+2,y+2],[x,y+2]]], "Top", "GND", {polygon:"poly1"});

test("a pour-only repour reuses the extra checks; real edits re-check", () => {
  const doc = {kind: "pcb", id: "b1", name: "T", outline: [[-20, -20], [40, -20], [40, 20], [-20, 20]], layerNames: {},
    items: [track("t1", "A", [[0, 0], [5, 0]]), track("t2", "B", [[0, 5], [5, 5]]), {kind: "part", id: "p1", def: "r2", ref: "R1", x: 20, y: 0, pinNets: {"1": "A", "2": "B"}}],
    pcbDrawing: {pours: [region(40)]}};
  let project = {format: "atrium", name: "P", library: [fp], documents: [doc]};
  let defs = new Map(project.library.map(d => [d.id, d]));
  const jobs = new Map();
  const host = {doc: () => project.documents[0], docById: () => project.documents[0], defs: () => defs, project: () => project, units: () => "mm", info() {},
    registerAction() {}, addRenderer() {}, on() {}, invalidate() {}, redraw() {}, act() {}, tool: () => "select",
    stageEdit(phase, key, run) {
      jobs.set(key,run);
      return {cancel() {if (jobs.get(key) === run) jobs.delete(key);}};
    }};
  function check(awaitsCopper = false) {
    const result = V.check();
    if (awaitsCopper) assert.deepEqual(V.violations(doc.id), [], "findings wait for current pour clearance");
    scheduler.plan("pour-drc", {now:true});
    const key = "pour-drc:" + host.doc().id;
    for (let k = 0; jobs.has(key) && k < 30; k++) {
      const run = jobs.get(key);
      jobs.delete(key);
      run(() => true,{timeRemaining:() => 100});
    }
    assert.ok(!jobs.has(key) && !scheduler.running("pour-drc"), "pour clearance finished through the scheduler");
    return result;
  }
  let calls = 0, updates = 0;
  globalThis.AtriumDRCFixes = {...F0,
    online(...args) {calls++; return F0.online(...args);},
    extras() {
      const engine = F0.extras();
      return {...engine, update(...args) {updates++; return engine.update(...args);}};
    }};
  U.reset(); U.touch(project); U.sync();
  const history = [], future = [];
  // An editor edit (an undo step) and a derived change (no step, as host.derive does), each followed
  // by the editor's change() (touch) and then the online check.
  const edit = fn => { const before = U.mark(project, {current: "b1"}); fn(project.documents[0]); U.checkpoint(history, future, before, ""); U.touch(project); defs = new Map(project.library.map(d => [d.id, d])); };
  const derive = fn => { fn(project.documents[0]); U.touch(project); defs = new Map(project.library.map(d => [d.id, d])); };
  const count = f => { const n = calls; const r = f(); return [calls - n, r]; };
  const types = () => V.violations("b1").map(v => v.type).sort();
  V.attach(host);
  try {
    let [n, r] = count(() => check(true)); assert.equal(n, 1, "first check");
    const first = V.violations("b1");
    assert.ok(first.some(v => v.type === "netAntennae"), JSON.stringify(types()));

    // A live pour's exact repour: only pcbDrawing.pours changes (a new array of new regions).
    const extraUpdates = updates;
    [n, r] = count(() => { derive(d => { d.pcbDrawing.pours = [region(60), region(20)]; d.pcbDrawing.pourSignatures = {poly1: "2:ab"}; d.pcbDrawing.pourSignatureVersion = 2; d.sourcePourSignature = "s1"; }); return check(); });
    assert.equal(r.mode, "copper"); assert.equal(n, 0, "a pour-only repour does not re-run the extra checks");
    assert.deepEqual(V.violations("b1"), first, "same violations");
    assert.equal(updates,extraUpdates,"the cursor advances without an extras update");
    // A pour region edited in place, and the pours list spliced: still pour-only.
    [n, r] = count(() => { derive(d => { Object.assign(d.pcbDrawing.pours[0],region(5)); d.pcbDrawing.pours.pop(); }); return check(); });
    assert.equal(n, 0, "pour edits in place");
    // Nothing changed at all (a redraw-only change()).
    [n] = count(() => { U.touch(project); return check(); }); assert.equal(n, 0, "no change");

    // A real edit: a track moves; the extra checks run and see it.
    [n, r] = count(() => { edit(d => { d.items[1].points = [[0, 0], [5, 0]]; d.items[1].net = "A"; }); return check(); });
    assert.equal(n, 1, "a real edit re-checks"); assert.notEqual(r.mode, "none");
    // An item added in the same step as a repour still re-checks.
    [n] = count(() => { edit(d => { d.items.push(track("t3", "C", [[9, 9], [12, 9]])); d.pcbDrawing.pours = [region(30)]; }); return check(); });
    assert.equal(n, 1, "item + pour edit");
    assert.ok(V.violations("b1").some(v => v.id === "t3"), "the new stub is found");
    // Undo of that step (items and pours restored together).
    [n] = count(() => { const here = U.mark(project, {current: "b1"}); U.jump(history, future, here, -1); project = U.root(); U.touch(project); return check(); });
    assert.equal(n, 1, "undo re-checks");
    assert.ok(!V.violations("b1").some(v => v.id === "t3"), "the undone stub is gone");

    // A library edit with no item change: the footprint loses its courtyard (missing courtyard appears).
    [n, r] = count(() => { edit(() => { delete project.library[0].footprint.courtyard; }); return check(); });
    assert.equal(r.mode, "full", "a changed footprint invalidates board geometry"); assert.equal(n, 1, "a library edit re-checks");
    assert.ok(V.violations("b1").some(v => v.type === "courtyard"), JSON.stringify(types()));
    // The same library edit as a derived change (in place, no step).
    [n] = count(() => { derive(() => { project.library[0].footprint.courtyard = [-1, -1, 1, 1]; }); return check(); });
    assert.equal(n, 1, "a derived library edit re-checks");
    assert.ok(!V.violations("b1").some(v => v.type === "courtyard"), JSON.stringify(types()));
    // A document key outside items and pours (layer names, read by the checks' labels).
    [n] = count(() => { edit(d => { d.layerNames = {Top: "L1"}; }); return check(); });
    assert.equal(n, 1, "a layer-name edit re-checks");
    // Another document's pcbDrawing key other than pours (outline handles etc.) also counts.
    [n] = count(() => { derive(d => { d.pcbDrawing.note = "x"; }); return check(); });
    assert.equal(n, 1, "a pcbDrawing key other than pours re-checks");
    // A project replaced (Open): re-checks.
    [n] = count(() => { project = JSON.parse(JSON.stringify(project)); U.touch(project); return check(); });
    assert.equal(n, 1, "a replaced project re-checks");
    // Repour after all that: reuse again.
    [n] = count(() => { derive(d => { d.pcbDrawing.pours = [region(10)]; }); return check(); });
    assert.equal(n, 0, "repour reuses again");
    // A rule change: full check.
    [n, r] = count(() => { edit(d => { d.rules = globalThis.AtriumRules.defaults(); d.rules.defaults.clearance = .3; }); return check(); });
    assert.equal(n, 1, "a rule change re-checks");
    // New copper near the track publishes an actual pour-clearance marker.
    [n] = count(() => { derive(d => { d.pcbDrawing.pours = [region(0,2,0)]; }); return check(true); });
    assert.equal(n,0,"pour clearance still reuses the extra checks");
    assert.ok(V.violations(doc.id).some(v => v.type === "pourClearance" && v.otherId === "t1"));
  } finally { scheduler.reset(); U.reset(); globalThis.AtriumDRCFixes = F0; }
});

console.log(passed + " drc-repour tests passed");
