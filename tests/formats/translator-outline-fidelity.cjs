"use strict";
const assert = require("node:assert/strict");
for (const mod of ["model", "sexpr", "board-shape","board-shape-sources"]) require(require("../support/app-source-paths.cjs").appFile(mod + ".js"));
const trace = AtriumImportFormats.geom.setOutline;
const outline = [{kind: "path", points: [[0,0], [6,0], [6,6], [0,6], [0,0]]}];
const cutout = {kind: "circle", c: [2,2], r: .5};
const outside = {kind: "circle", c: [20,20], r: .5};
function check(edges, expected) {
  const a = {}, b = {}, rows = [];
  const warnings = trace(a, edges, (i, status, reason) => rows.push([i, status, reason]));
  assert.deepEqual(warnings, trace(b, edges));
  assert.deepEqual(a, b);
  assert.deepEqual(rows.map(r => r.slice(0, 2)), expected.map((v, i) => [i,v]));
  for (const r of rows) if (r[1] !== "kept") assert.ok(r[2]);
}
check([...outline, cutout, outside, outline[0]], ["kept", "kept", "dropped", "dropped"]);
check([{kind: "line", a: [0,0], b: [6,0]}], ["dropped"]);
const boardShape = globalThis.AtriumBoardShape;
try {
  globalThis.AtriumBoardShape = null;
  check([{kind: "path", points: []}, ...outline, cutout], ["dropped", "kept", "dropped"]);
  check([cutout], ["approximated"]);
} finally { globalThis.AtriumBoardShape = boardShape; }
