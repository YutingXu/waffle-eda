"use strict";
// A 4-layer Altium board (tests/fixtures/altium/planes-qfn, ASCII PcbDoc made for this test): Top, Mid-Layer 1
// with a GND pour, an internal split plane (GND) and Bottom, a QFN-32 with rounded-rectangle pads and a field of
// signal vias that give the inner copper a few thousand vertices of antipads. Checks the import (layers, plane,
// pad shapes) and that the inner copper stays whole at every display level of detail (pcb-pours.js lodRingsAt,
// which both board renderers fill): from far out to close in, no level drops the plane's or the pour's outline.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const name of ["model", "parts", "spatial", "pcb-appearance", "pcb-pours", "pcb-text-rich", "pcb-text", "vectorize",
  "stackup", "net-intent", "signals", "query", "rules", "project-rules", "viastack", "board-shape", "pcb-import", "polygon-pour", "io"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const P = AtriumPolygonPour, L = AtriumPCBPours;
const text = fs.readFileSync(path.join(__dirname, "../fixtures/altium/planes-qfn/PlanesQfn.PcbDoc"), "utf8");
const read = AtriumPCB.read("PlanesQfn.PcbDoc", null, text), board = read.documents[0];
const area = xy => { let a = 0; for (let i = 0; i < xy.length; i += 2) { const j = (i + 2) % xy.length; a += xy[i] * xy[j + 1] - xy[j] * xy[i + 1]; } return Math.abs(a) / 2; };
(async () => {
  assert.deepEqual(board.stackup.layers.filter(l => /Signal|Plane/.test(l.type)).map(l => l.type), ["Signal", "Signal", "Plane", "Signal"]);
  const plane = board.items.find(i => i.powerPlane), pour = board.items.find(i => i.kind === "polygon" && i.layer === "Inner 1");
  assert.equal(plane.layer, "Inner 2"); assert.ok(pour);
  const project = Atrium.project("Planes"); project.documents[project.documents.findIndex(d => d.kind === "pcb")] = board; project.library = [...project.library, ...(read.library || [])];
  const defs = new Map(project.library.map(x => [x.id, x]));
  const part = board.items.find(i => i.kind === "part"), fp = defs.get(part.def).footprint;
  assert.equal(fp.pads.length, 33);
  assert.ok(fp.pads.every(p => p.shape === "roundrect" && p.roundrectRadiusRatio === .25), "QFN pads are rounded rectangles at 50 %");
  P.apply(board, defs, {project});
  const regions = board.pcbDrawing.pours.filter(r => /^Inner/.test(r.layer));
  assert.deepEqual([...new Set(regions.map(r => r.layer))].sort(), ["Inner 1", "Inner 2"]);
  const big = regions.filter(r => L.contours(r).reduce((n, x) => n + x.length / 2, 0) >= 1500);
  assert.equal(big.length, 2, "both inner layers have enough antipads for display levels of detail");
  // Every level from far out (0.2 px/mm) to close in: the outline of each region keeps its area within 2 %.
  for (const k of [.2, .5, 1, 2, 4, 8, 16, 64]) {
    for (let n = 0; n < 40; n++) { big.forEach(r => L.lodRingsAt(r, k)); if (!L.lod.stats().queued) break; await new Promise(r => setTimeout(r, 60)); }
    for (const r of big) {
      const stored = L.contours(r), lod = L.lodRingsAt(r, k), rings = lod ? lod.rings : stored;
      assert.equal(rings.length, stored.length, "one ring for each stored ring at " + k + " px/mm");
      const outer = stored.reduce((m, x, i) => area(x) > area(stored[m]) ? i : m, 0);
      assert.ok(rings[outer].length >= 6, r.layer + " outline kept at " + k + " px/mm");
      assert.ok(Math.abs(area(rings[outer]) / area(stored[outer]) - 1) < .02, r.layer + " outline area at " + k + " px/mm");
    }
  }
  console.log("PASS 4-layer Altium board: inner pour and split plane, rounded QFN pads, inner copper whole at every display level");
})().catch(e => { console.error(e); process.exit(1); });
