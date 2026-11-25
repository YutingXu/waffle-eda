"use strict";
// Lasso selection (app/editor/lasso.js): fully-inside test for concave outlines, the selection filter, and Shift/Ctrl modes.
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/core/geometry.js");
require("../../app/editor/lasso.js");
const L = globalThis.AtriumLasso;
// A "C" shape: concave on the right.
const C = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 7], [10, 7], [10, 10], [0, 10]];
assert.ok(L.contains(C, [1, 5]) && !L.contains(C, [6, 5]) && L.contains(C, [8, 1]));
assert.ok(L.inside(C, [[1, 1], [8, 1]]), "a track along the bottom arm");
assert.ok(!L.inside(C, [[8, 1], [8, 9]]), "a track that leaves through the notch is not inside");
assert.ok(!L.inside(C, [[1, 1], [11, 1]]));
const notch = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 6], [4, 6], [4, 10], [0, 10]];
assert.ok(L.inside(notch, [[1, 8], [7, 4]]), "a tangent to the concave vertex is not a crossing");
const doc = {kind: "pcb", items: [
  {id: "t1", kind: "track", points: [[1, 1], [8, 1]], width: .2, layer: "Top"},
  {id: "t2", kind: "track", points: [[8, 1], [8, 9]], width: .2, layer: "Top"},
  {id: "v1", kind: "via", x: 1, y: 8, diameter: .6, drill: .3},
  {id: "v2", kind: "via", x: 6, y: 5, diameter: .6, drill: .3},
  {id: "v3", kind: "via", x: 2, y: 5, diameter: .6, drill: .3}]};
const defs = new Map();
assert.deepEqual(L.pick(doc, defs, C).sort(), ["t1", "v1", "v3"]);
assert.deepEqual(L.pick(doc, defs, C, {selectable: i => i.kind !== "via"}), ["t1"], "the selection filter applies");
assert.deepEqual(L.pick(doc, defs, [[0, 0], [1, 0]]), [], "an outline needs three points");
assert.deepEqual(L.combine(["a", "b"], ["c"], "replace"), ["c"]);
assert.deepEqual(L.combine(["a", "b"], ["b", "c"], "add"), ["a", "b", "c"]);
assert.deepEqual(L.combine(["a", "b"], ["b"], "remove"), ["a"]);
console.log("PASS lasso: concave outlines, fully-inside segments, selection filter, add/remove modes");
