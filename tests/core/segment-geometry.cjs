"use strict";

const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/checks/connectivity.js");
require("../../app/checks/rules.js");
require("../../app/pcb/pcb-draw.js");
const {closestSegments, segmentDistance} = AtriumGeometry;

assert.equal(AtriumRules.kit.closestSegments, closestSegments);
function expect(ends, d, pa, pb) {
  assert.equal(segmentDistance(...ends), d);
  assert.deepEqual(closestSegments(...ends), {d,pa,pb});
}
expect([[0,0],[4,0],[1,-2],[1,3]],0,[1,0],[1,0]);
expect([[0,0],[4,0],[4,-2],[4,0]],0,[4,0],[4,0]);
expect([[1,0],[3,0],[-2,0],[8,0]],0,[1,0],[1,0]);
expect([[3,0],[1,0],[-2,0],[8,0]],0,[3,0],[3,0]);
expect([[1,0],[3,0],[0,2],[4,2]],2,[1,0],[1,2]);
expect([[0,0],[4,0],[2,1],[2,2]],1,[2,0],[2,1]);
expect([[1,1],[1,1],[2,1],[2,1]],1,[1,1],[2,1]);
expect([[-0,-0],[-0,-0],[2,1],[2,1]],Math.hypot(2,1),[-0,-0],[2,1]);

const crossing = closestSegments([0,0],[1e-90,0],[5e-91,-1e-90],[5e-91,1e-90]);
assert.equal(crossing.d,0,"Signs detect crossings even when their products underflow");
assert.equal(crossing.pa,crossing.pb,"A strict crossing has a single shared witness");
assert.equal(segmentDistance([0,0],[1e-90,0],[5e-91,-1e-90],[5e-91,1e-90]),0);
const x = 1+5e-10;
expect([[0,0],[1,0],[x,-1],[x,1]],x-1,[1,0],[x,0]);
expect([[0,0],[0,0],[1e200,1e200],[1e200,1e200]],Math.hypot(1e200,1e200),[0,0],[1e200,1e200]);

// At a large enough offset, the rounded residual can differ from the length
// between the constructed witness points. Keep both arithmetic contracts.
const a = [138.47507564350963,119.71270199865103], b = [79.72149373963475,113.79415467381477];
const p = [109.73562067374587,178.4291559830308];
const witness = closestSegments(a,b,p,p), scalar = segmentDistance(a,b,p,p);
assert.equal(witness.pb,p);
assert.equal(witness.d,Math.hypot(witness.pa[0]-p[0],witness.pa[1]-p[1]));
assert.equal(scalar,Atrium.nearSegment(p,a,b));
assert.notEqual(witness.d,scalar);

const P = [[1,0],[3,0]], Q = [[0,2],[4,2]];
assert.deepEqual(AtriumPCBDraw.featureGap({pts:P},{pts:Q}),{d:2,pa:[1,0],pb:[1,2]});
const kit = AtriumRules.kit;
assert.deepEqual(kit.gap(kit.feature({},P,0),kit.feature({},Q,0)),{d:2,at:[1,1]});

const c0 = [0,0], c1 = [2,0], c2 = [2,2], c3 = [0,2];
const triangles = [[c0,c1,c2],[c2,c3,c0]];
const strictConvex = points => points.every((v,i) =>
  AtriumGeometry.orient(v,points[(i+1)%points.length],points[(i+2)%points.length]) > 0);
assert.deepEqual(Atrium.mergeConvex(triangles,strictConvex),[[c0,c1,c2,c3]]);
assert.deepEqual(Atrium.mergeConvex(Atrium.clone(triangles),strictConvex),triangles,"Equal coordinates do not establish shared vertices");
const distant = Array.from({length:8},(_,i) => [[10+i,0],[10+i+.5,0],[10+i,1]]);
const beyond = [triangles[0],...distant,triangles[1]];
assert.deepEqual(Atrium.mergeConvex(beyond,strictConvex),beyond,"Only the eight most recent pieces are considered");

console.log("Segment witnesses, scalar gaps, PCB Measure, DRC and convex merge contracts passed.");
