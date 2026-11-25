"use strict";

const assert = require("node:assert/strict");
const G = require("../../app/core/geometry.js");

function checkRing(ring, examples) {
  for (const points of [ring, [...ring].reverse()]) {
    const packed = points.flat(), buffer = Float64Array.from([99, 99, ...packed, 99, 99]);
    const view = buffer.subarray(2, buffer.length - 2);
    for (const [p, expected] of examples) {
      assert.equal(G.inRing(p, points), expected);
      assert.equal(G.inRingAt(p[0], p[1], points), expected);
      assert.equal(G.inFlatRing(p[0], p[1], packed), expected);
      assert.equal(G.inFlatRing(p[0], p[1], view), expected);
    }
  }
}

checkRing([[0, 0], [4, 0], [4, 4], [0, 4]], [
  [[0, 0], true], [[0, 2], true], [[2, 0], true], [[2, 2], true],
  [[2, 4], false], [[4, 2], false], [[4, 4], false], [[4 + 5e-10, 2], false]
]);
checkRing([[0, 0], [4, 0], [4, 1], [4, 1], [1, 1], [1, 4], [0, 4]], [
  [[0.5, 2], true], [[2, 0.5], true], [[2, 2], false], [[5, 0.5], false]
]);
for (const ring of [[], [[1, 1]], [[1, 1], [2, 2]]]) checkRing(ring, [[[1, 1], false], [[1.5, 1.5], false]]);
assert.equal(G.inFlatRing(2, 2, [0, 0, 4, 0, 4, 4, 0, 4, 23]), true, "ignore an unmatched final coordinate");

const distance2 = G.pointSegmentDistanceSquared;
for (const [args, expected] of [
  [[2, 3, 0, 0, 4, 0], 9],
  [[-2, 3, 0, 0, 4, 0], 13],
  [[6, 3, 0, 0, 4, 0], 13],
  [[2, 3, 4, 0, 0, 0], 9],
  [[2, 1, 1, 1, 1, 1], 1],
  [[-0, -0, -0, -0, -0, -0], 0],
  [[1e-160, 1e-160, 0, 0, 1e-160, 0], 1e-320],
  [[1e8 + 0.1, 1e8 + 0.2, 1e8, 1e8, 1e8 + 0.4, 1e8 + 0.4], 0.005000000894069823],
  [[NaN, 3, 1, 1, 1, 1], NaN],
  [[1e200, 0, 0, 0, 1e200, 1e200], NaN]
]) assert.equal(distance2(...args), expected);
console.log("ok   half-open rings and squared point-to-segment geometry");
