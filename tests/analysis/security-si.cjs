"use strict";
// Signal-integrity API and extension edit paths under hostile callers.
//   scripts/test-jsc.sh security-si        or      node tests/analysis/security-si.cjs
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "altium-rules", "connectivity", "rules", "dfa", "rooms", "pcb-appearance", "stackup", "autorouter", "fanout",
  "autoplace", "route-planner", "plane-planner", "eco", "annotate", "polygon-pour", "bom", "length-tuning", "proposal", "atrium-api", "field-solver"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, API = AtriumAPI, FS = AtriumFieldSolver;

// P3 (Medium): api.simulation.fieldSolve(geom) runs AtriumFieldSolver.async in a worker. When the
// worker took longer than 10 s, async() terminated it, marked the worker broken and solved the same
// cross-section again synchronously on the UI thread. A 1.5 KB generic cross-section (40 thin
// conductors) solves for minutes, so any extension with read:project froze the editor, and every
// later solve ran on the UI thread. A timeout now resolves {ok: false} and keeps the worker path.
async function fieldSolveTimeoutStaysOffTheUIThread() {
  const saved = {Worker: globalThis.Worker, Blob: globalThis.Blob, URL: globalThis.URL, setTimeout: globalThis.setTimeout, solve: null};
  let made = 0;
  globalThis.Worker = class { constructor() { made++; } postMessage() { /* never answers: a slow solve */ } terminate() {} };
  globalThis.Blob = globalThis.Blob || class { constructor(parts) { this.parts = parts; } };
  globalThis.URL = {createObjectURL: () => "blob:x", revokeObjectURL() {}};
  globalThis.setTimeout = (f, ms, ...a) => saved.setTimeout(f, ms >= 10000 ? 0 : ms, ...a);
  try {
    const geom = {structure: "microstrip", w: 0.3, h: 0.2, er: 4.3};
    const r = await FS.async(geom);
    assert.equal(made, 1, "the solve was sent to a worker");
    assert.equal(r.ok, false, "a timed-out solve is reported, not re-run on the UI thread");
    assert.match(r.error, /longer than 10 s/);
    await FS.async(geom);
    assert.equal(made, 2, "a timeout does not mark the worker broken; the next solve uses a worker too");
  } finally {
    globalThis.Worker = saved.Worker; globalThis.Blob = saved.Blob; globalThis.URL = saved.URL; globalThis.setTimeout = saved.setTimeout;
  }
}

// Follow-up of the si-sim fix (atrium-api.js fork(): project-level fields are deep-copied only for
// touched === "all"). The host-feature edits (annotate, pour, route, fanout, AI planning) compute on a
// fork and must not write anything into the live project before the user approves. Declined here.
async function featureEditsDoNotWriteThrough() {
  const base = AtriumParts.example(), pcb = base.documents.find(d => d.kind === "pcb");
  pcb.items = pcb.items.filter(i => i.kind !== "track" && i.kind !== "via");
  for (const i of base.documents.flatMap(d => d.items)) if (i.ref) i.ref = i.ref.replace(/\d+$/, "?");
  base.simulation = {models: {}, settings: {probe: {a: 1}}};
  for (const name of ["route", "fanout", "pour", "annotate.apply", "autoplace", "routePlan"]) {
    const h = API.headless(A.clone(base), {extension: {id: "x", permissions: {"read:project": true, "propose:edits": true}}, approve: () => false});
    const before = JSON.stringify(h.project);
    const r = await h.call(name, [{}], false);
    assert.ok(r && !r.applied, name + " was declined");
    assert.equal(JSON.stringify(h.project), before, name + " left the live project untouched before approval");
  }
  // An untrusted proposal's dry run (submit) never writes project-level fields through either.
  const h = API.headless(A.clone(base), {extension: {id: "x", permissions: {"read:project": true, "propose:edits": true}}, approve: () => false});
  const before = JSON.stringify(h.project);
  const r = await h.call("proposals.submit", [{format: "atrium-ai", version: 2, project: h.project.name,
    ops: [{op: "set", target: "project", path: ["simulation", "settings", "probe", "a"], before: 1, after: 2}]}], false);
  assert.ok(r.declined || r.applied === 0);
  assert.equal(JSON.stringify(h.project), before, "a declined proposal changed nothing");
}

globalThis.__testDone = (async () => {
  await fieldSolveTimeoutStaysOffTheUIThread();
  await featureEditsDoNotWriteThrough();
  console.log("security-si ok");
})();
