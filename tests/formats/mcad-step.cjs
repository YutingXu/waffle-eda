"use strict";
// STEP round trip (mcad-step.js, step-export.js): an enclosure tray with a boss over the connector
// is read as a reference body; enclosure clearance finds the colliding and the too-close
// components; a section and a face of the enclosure propose the board outline and a keep-out with
// its height; a board outline edited in MCAD and saved as STEP comes back as proposals; the STEP
// export is byte-stable for an unchanged design and names its products by designator, with the
// Waffle id in each placement.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "pcb-appearance", "pcb-pours", "stackup", "board-shape", "rigid-flex", "zip", "fab-outputs", "step-export", "flex-fold", "step-import", "collision-3d",
  "pcb-edit", "mcad-xml", "mcad", "mcad-idx", "mcad-step"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("./mcad-board.js");
const S = AtriumSTEP, MC = AtriumMCAD, ST = AtriumMCADStep;
const L = (a, b) => ({a, b});
const rect = (x0, y0, x1, y1, ccw = true) => { const P = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], Q = ccw ? P : P.slice().reverse(); return Q.map((p, i) => L(p, Q[(i + 1) % 4])); };

// An enclosure tray (STEP export coordinates: Y up, board from z 0 to 1.6): walls round the board
// with 1 mm play, a floor 2 mm under the board, a lid at z 10 and a boss over J1 (45, -32) from z 5.
function enclosureStep() {
  const m = S.model({name: "Tray", documents: [{id: "e", kind: "pcb", name: "Tray", grid: 1, outline: [[0, 0], [1, 0], [1, 1]], items: [], notes: []}], library: []}, "e", {components: false});
  m.name = "Tray";
  m.board.bodies = [
    {name: "Walls", prism: {loops: [rect(-3, -43, 63, 3), rect(-1, -41, 61, 1, false)], z0: -3, z1: 11}},
    {name: "Floor", prism: {loops: [rect(-1, -41, 61, 1)], z0: -3, z1: -2}},
    {name: "Lid", prism: {loops: [rect(-1, -41, 61, 1)], z0: 10, z1: 11}},
    {name: "Boss", prism: {loops: [S.circleLoop([45, -32], 1.5, true)], z0: 5, z1: 10}}];
  m.parts = []; m.layers = [];
  return S.step(m, {deterministic: true});
}
const text = enclosureStep();
const enc = ST.enclosure(text, {name: "tray.step"});
assert.ok(enc.triangles > 50 && enc.bbox[0] === -3 && enc.bbox[5] === 11, JSON.stringify(enc.bbox));

// ---- enclosure clearance -----------------------------------------------------------------------
{
  const p = mcadBoard(), d = p.documents[0];
  let r = ST.clearance(p, d, enc, {gap: 0.5});
  assert.deepEqual(r.findings.map(f => f.ref + ":" + f.kind), ["J1:collision"], JSON.stringify(r.findings));
  r = ST.clearance(p, d, enc, {gap: 1.5});
  // U1 hangs 0.9 mm from the 35 µm bottom foil. The floor is 2 mm below the laminate.
  const floorGap = 2 - .9 - .035;
  assert.deepEqual(r.findings.map(f => f.ref + ":" + f.kind), ["J1:collision", "U1:clearance"]);
  assert.ok(Math.abs(r.findings[1].distance - floorGap) < 0.01, String(r.findings[1].distance));
  // Moving J1 out from under the boss clears it; turning the enclosure by 180 degrees about its centre is the same tray.
  d.items.find(i => i.id === "pJ1").x = 20;
  assert.deepEqual(ST.clearance(p, d, enc, {gap: 0.5}).findings, []);
  const turned = ST.place(ST.enclosure(text), {rz: 180, offset: [60, -40, 0]});
  d.items.find(i => i.id === "pJ1").x = 15; d.items.find(i => i.id === "pJ1").y = 8;  // under the turned boss at (60-45, -40+32)
  assert.deepEqual(ST.clearance(p, d, turned, {gap: 0.5}).findings.map(f => f.ref), ["J1"]);
  // A component sunk inside a wall (no triangle touches it) is still a collision.
  d.items.find(i => i.id === "pR1").x = -2; d.items.find(i => i.id === "pR1").y = 20;
  assert.ok(ST.clearance(p, d, turned, {gap: 0.1}).findings.some(f => f.ref === "R1" && f.kind === "collision"));
}

// ---- outline and keep-outs from the enclosure -------------------------------------------------
{
  const p = mcadBoard(), d = p.documents[0];
  const lv = ST.levels(enc);
  assert.ok(lv.some(l => l.z === 5 && !l.up), "the boss bottom is a downward face at z 5");
  // Section 3 mm up: the inner wall, pulled in 1 mm, is the board's outline: the rounded corner goes.
  const des = ST.derive(p, d, enc, {mode: "section", z: 3, inset: 1});
  assert.deepEqual(des.board.outline.map(q => q.map(v => Math.round(v * 1000) / 1000)).sort(), [[0, 0], [0, 40], [60, 0], [60, 40]]);
  const {proposals} = MC.receive(p, d, des, {file: "tray.step (section)", source: "enclosure"});
  assert.deepEqual(proposals.map(x => x.kind), ["outline"]);
  MC.accept(p, d, proposals[0].id);
  assert.equal(d.boardShape.cutouts.length, 1, "the cutout is kept");
  assert.ok(MC.samePoly(d.outline, [[0, 0], [60, 0], [60, 40], [0, 40]], 1e-6));
  // The boss's underside: a keep-out over J1, 5 - 1.6 = 3.4 mm above the board.
  const face = ST.derive(p, d, enc, {mode: "face", z: 5, up: false});
  assert.equal(face.keepouts.length, 1);
  const k = face.keepouts[0];
  assert.ok(Math.abs(k.z1 - (5 - MC.snapshot(p, d).board.thickness)) < 1e-3);
  assert.ok(k.points.every(q => Math.abs(Math.hypot(q[0] - 45, q[1] - 32) - 1.5) < 0.05), "the keep-out is the boss footprint (Waffle coordinates)");
  const r2 = MC.receive(p, d, face, {source: "enclosure"});
  assert.deepEqual(r2.proposals.map(x => x.kind), ["keepout-add"]);
  MC.accept(p, d, r2.proposals[0].id);
  assert.equal(d.items.at(-1).mcadKind, "component");
}

// ---- a board outline edited in MCAD, read back from STEP --------------------------------------
{
  const p = mcadBoard(), d = p.documents[0];
  const own = S.export(p, d, {deterministic: true});
  // Unchanged: nothing to propose (holes matched by position and diameter, vias and pin holes included).
  const same = ST.boardFromStep(own);
  assert.equal(same.board.cutouts.length, 1);
  assert.deepEqual(MC.compare(p, d, same).map(x => x.label), []);
  // The ME widens the board to 70 mm, moves the 3.2 mm hole and adds a 2.5 mm hole.
  const q = mcadBoard(), e = q.documents[0];
  AtriumBoardShape.apply(e, {contour: [AtriumBoardShape.line([0, 0], [70, 0]), AtriumBoardShape.line([70, 0], [70, 40]), AtriumBoardShape.line([70, 40], [0, 40]), AtriumBoardShape.line([0, 40], [0, 0])],
    cutouts: d.boardShape.cutouts}, "mcad");
  e.items.find(i => i.id === "h1").x = 6;
  e.items.push({id: "h7", kind: "pad", number: "", x: 66, y: 20, w: 2.5, h: 2.5, drill: 2.5, shape: "round", layer: "Multi", net: "", plated: false});
  const des = ST.boardFromStep(S.export(q, e, {deterministic: true}));
  const {proposals} = MC.receive(p, d, des, {file: "edited.step", source: "step"});
  const kinds = proposals.map(x => x.kind).sort();
  assert.deepEqual(kinds, ["hole-add", "hole-add", "hole-remove", "outline"], JSON.stringify(proposals.map(x => x.label)));
  for (const x of proposals) MC.accept(p, d, x.id);
  assert.deepEqual(MC.compare(p, d, des).map(x => x.label), [], "the board matches the STEP");
}

// ---- STEP export: byte-stable, stable names ------------------------------------------------------
{
  const a = S.export(mcadBoard(), "pcb1"), b = S.export(mcadBoard(), "pcb1");
  assert.equal(a, b, "the default export is byte-stable for an unchanged design (no wall-clock time)");
  assert.match(a, /FILE_NAME\('Board\.step','2000-01-01T00:00:00'/);
  assert.match(a, /NEXT_ASSEMBLY_USAGE_OCCURRENCE\('R1','R1','atrium:pR1',/);
  assert.match(a, /NEXT_ASSEMBLY_USAGE_OCCURRENCE\('J1','J1','atrium:pJ1',/);
  // Renumbering stays local: a moved part changes its own placement only, the rest keeps its text.
  const p = mcadBoard(); p.documents[0].items.find(i => i.id === "pR1").x = 11;
  const c = S.export(p, "pcb1"), la = a.split("\n"), lc = c.split("\n");
  assert.equal(la.length, lc.length);
  const diff = la.filter((l, i) => l !== lc[i]);
  assert.ok(diff.length > 0 && diff.length <= 2, "only R1's placement point changes (" + diff.length + " lines)");
  assert.equal(S.export(mcadBoard(), "pcb1", {timestamp: "2026-11-19T12:00:00"}).includes("2026-11-19T12:00:00"), true);
}
console.log("SHIM-OK");
