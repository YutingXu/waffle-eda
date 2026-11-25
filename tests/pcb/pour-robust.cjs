"use strict";
// A pour whose solve fails degrades gracefully (polygon-pour.js guardedPourSteps): its previous
// copper and signature are kept (it stays stale), the other pours are repoured exactly as a clean
// run would, the editor names it (repouredText), Design Insights shows it (pourFailed), live
// pours do not retry it for the same inputs, and the next successful repour clears it.
//   * serial runs (apply): the core throws for one pour;
//   * pooled runs (repourParallel): a worker error, a hung worker (worker-pool.js watchdog:
//     error.hung), and a solve past the time budget, whose job is cancelled (its worker stopped).
// Node: node tests/pcb/pour-robust.cjs   JSC: scripts/test-jsc.sh pour-robust
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "pcb-text-rich", "pcb-text", "stackup", "rules", "viastack", "board-shape", "polygon-pour", "insights", "insights-pcb"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
try { require("../../app/engine-core.js"); } catch { /* JS core */ }
require("./dense-board.js");
const PP = AtriumPolygonPour, A = Atrium, CORE = PP._internal.core;

function board() {
  const {d, defs} = makeAtriumBenchmarkBoard(14), p = A.project("Robust"); p.documents = [d]; p.library = [...defs.values()];
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 4), "2": "N" + ((k + 1) % 4)}; else if (i.kind !== "track") i.net = "N" + (k % 4); k++; }
  const b = A.bounds(d.outline), w = b[2] - b[0], h = b[3] - b[1];
  const rect = (x0, y0, x1, y1) => [[b[0] + x0 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y1 * h], [b[0] + x0 * w, b[1] + y1 * h]];
  [["Top", "N0", [0, 0, .5, 1]], ["Top", "N1", [.5, 0, 1, 1]], ["Bottom", "N2", [0, 0, 1, 1]]]
    .forEach(([layer, net, o], j) => d.items.push(PP.make(rect(...o), {layer, net, pourIndex: j, name: net + " " + layer})));
  return {p, d, defs};
}
const copperOf = (d, id) => JSON.stringify((d.pcbDrawing?.pours || []).filter(r => r.polygon === id).map(r => r.data));
const vias = d => d.items.filter(i => i.kind === "via");
const insightsOf = (p, d, defs) => AtriumInsights.analyze(p, d, defs).insights.filter(x => x.check === "pourFailed" || x.id?.startsWith?.("pourFailed"));

globalThis.__testDone = (async () => {
  // ---- serial: the core throws for the second pour's stage 1
  {
    const {p, d, defs} = board(), ids = PP.polygons(d).map(q => q.id);
    PP.apply(d, defs, {project: p});
    assert.deepEqual(PP.stale(d, defs, {project: p}), []);
    const before = ids.map(id => copperOf(d, id));
    for (const v of vias(d)) v.x += .07;
    // The clean answer for this edit, on a copy.
    const ref = JSON.parse(JSON.stringify(p)), rd = ref.documents[0];
    PP.apply(rd, new Map(ref.library.map(x => [x.id, x])), {project: ref, reuse: false});
    const target = PP._internal.prepare(d, defs, PP.polygons(d)[1], {project: p}).task.shapes.length, solve = CORE.solve;
    CORE.solve = t => { if (!t.packed && t.shapes.length === target && !t.anchors.length) throw Error("injected failure"); return solve(t); };
    let res;
    try { res = PP.apply(d, defs, {project: p, reuse: false}); } finally { CORE.solve = solve; }
    assert.equal(res.failed.length, 1, JSON.stringify(res.failed));
    assert.equal(res.failed[0].id, ids[1]);
    assert.match(res.failed[0].reason, /injected failure/);
    assert.equal(copperOf(d, ids[1]), before[1], "the failed pour keeps its previous copper");
    assert.equal(copperOf(d, ids[0]), copperOf(rd, ids[0]), "the other pours are repoured as a clean run would");
    assert.equal(copperOf(d, ids[2]), copperOf(rd, ids[2]));
    assert.deepEqual(PP.stale(d, defs, {project: p}), [ids[1]], "the failed pour stays stale");
    assert.ok(PP.failures(d)[ids[1]], "failures() names it");
    const ins = insightsOf(p, d, defs);
    assert.equal(ins.length, 1, "Design Insights: " + JSON.stringify(ins.map(x => x.message)));
    assert.match(ins[0].message, /N1 Top pour kept its previous copper because the solve failed/);
    // The editor's command (no live host here: the serial repour) names the failed pour.
    for (const v of vias(d)) v.x -= .03;
    const said = [];
    CORE.solve = t => { if (!t.packed && t.shapes.length === target && !t.anchors.length) throw Error("injected failure"); return solve(t); };
    try { PP.repour(d, defs, {project: p, reuse: false}, fn => fn(), m => said.push(m)); } finally { CORE.solve = solve; }
    assert.ok(said.join(" ").includes("The N1 Top pour kept its previous copper and stays stale: the solve failed (injected failure). The other pours were repoured."), said.join(" "));
    PP.apply(d, defs, {project: p, reuse: false});
    assert.deepEqual(PP.stale(d, defs, {project: p}), []);
    assert.deepEqual(PP.failures(d), {}, "a successful repour clears the failure");
    console.log("ok - serial: a failing solve keeps that pour's copper, stale; the others repour");
  }

  // ---- pooled: error, hung worker, time budget
  for (const how of ["error", "hung", "budget"]) {
    const {p, d, defs} = board(), ids = PP.polygons(d).map(q => q.id);
    PP.apply(d, defs, {project: p});
    const before = ids.map(id => copperOf(d, id));
    for (const v of vias(d)) v.y += .05;
    const ref = JSON.parse(JSON.stringify(p)), rd = ref.documents[0];
    PP.apply(rd, new Map(ref.library.map(x => [x.id, x])), {project: ref, reuse: false});
    // The second pour's stage 1 fails (no other pour reads its copper).
    const target = PP._internal.prepare(d, defs, PP.polygons(d)[1], {project: p}).task.shapes.length;
    let cancelled = 0;
    const pool = {size: 2, available: true, run(task, transfer, progress, original) {
      const t = original || task;
      if (t.shapes.length !== target || t.anchors.length) return Promise.resolve().then(() => CORE.solve(t));
      if (how === "error") return Promise.reject(Error("worker crashed"));
      if (how === "hung") return Promise.reject(Object.assign(Error("The background task pour-solve stopped responding and was restarted."), {hung: true}));
      let reject; const pr = new Promise((_ok, no) => { reject = no; });
      return Object.assign(pr, {cancel() { cancelled++; reject(Object.assign(Error("cancelled"), {cancelled: true})); }});
    }};
    PP.reuse?.clear?.();
    const result = await PP.repourParallel(d, defs, {project: p, reuse: false, budgetMs: 30}, pool);
    assert.ok(result, how + ": the run completes");
    assert.equal(result.failed.length, 1, how + ": " + JSON.stringify(result.failed));
    const f = result.failed[0], j = ids.indexOf(f.id);
    assert.equal(f.id, ids[1], how);
    assert.match(f.reason, how === "budget" ? /solve took longer than 30 ms/ : how === "hung" ? /stopped responding/ : /worker crashed/, how);
    if (how === "budget") assert.equal(cancelled, 1, "the over-budget solve was cancelled (its worker stopped)");
    PP.apply(d, defs, {project: p, result});
    assert.equal(copperOf(d, f.id), before[j], how + ": previous copper kept");
    for (const id of ids) if (id !== f.id) assert.equal(copperOf(d, id), copperOf(rd, id), how + ": " + id + " as a clean run");
    assert.deepEqual(PP.stale(d, defs, {project: p}), [f.id], how + ": stale");
    console.log("ok - pooled (" + how + "): only that pour fails; previous copper, stale, the others exact");
  }
})();
globalThis.__testDone.catch(e => { console.error(e); if (globalThis.process) process.exitCode = 1; });
