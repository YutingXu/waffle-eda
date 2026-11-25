"use strict";
const assert = require("node:assert/strict");
const {pointSeg} = require("./segment-distance.cjs");

const F2 = {
  track: {kind:"track", points:[[6, 0], [0, -6], [-6, 0]], width:.8, maskExpansion:.2, pasteExpansion:-.15,
    arc:{kind:"arc", c:[0, 0], r:6, start:0, end:180, ccw:true}},
  inside: [3 * Math.SQRT2, -3 * Math.SQRT2], outside:[3, -3], staleEnd:90
};
const C1 = {
  arc: {kind:"arc", center:F2.track.arc.c, radius:F2.track.arc.r, start:0, sweep:180},
  ellipse: {kind:"ellipseArc", center:[1, -2], cosineAxis:[3 * Math.sqrt(3), 3], sineAxis:[-1, Math.sqrt(3)], start:20, sweep:-250}
};
const F3 = {
  part:{ref:"Q4", x:4, y:-3, angle:30}, field:{at:[-1, 2], angle:90, upright:true, size:1.1, width:.11},
  anchor:[2.13397459621556, -1.76794919243112], clockwiseDegrees:-60
};
const F4 = {
  part:{x:4, y:-3, angle:30}, pad:{shape:"rect", w:2.2, h:1.4, x:1.4, y:.7, angle:17, drill:.28},
  stack:{Top:{w:1.1}, Mid:{w:1.2, h:.7}, "Inner 2":{w:.92, h:.88}},
  center:[4.862435565298214, -1.693782217350893], clockwiseDegrees:47
};
const F5 = {
  w:1.8, h:.8, witness:[.7, .3], aliases:["round", "circle", "circular", "oval", "oblong", "obround"],
  radiusRatio:.18, cornerRadius:.144
};
// Probe a land under reflection before the outer turn, independent of the model world helper.
function mirroredLandPoint([x,y],row={}){
  const pad={...F4.pad,...row}, part=F4.part;
  const a=pad.angle*Math.PI/180,b=part.angle*Math.PI/180;
  const u=-(pad.x+x*Math.cos(a)-y*Math.sin(a)),v=pad.y+x*Math.sin(a)+y*Math.cos(a);
  return [part.x+u*Math.cos(b)-v*Math.sin(b),part.y+u*Math.sin(b)+v*Math.cos(b)];
}
const mirroredTopRow={w:1.1,x:3.6,angle:-30};
const extendedCustom=[[-.3,-.2],[4.8,-.23],[4.6,.3],[-.3,.3]];
const landContacts=[
  {shape:"obround",point:F5.witness,inside:true},
  {shape:"ellipse",point:F5.witness,inside:false},
  {shape:"custom",poly:extendedCustom,point:[4.2,.1],inside:true},
  {shape:"custom",poly:extendedCustom,point:[.5,.37],inside:false},
  {shape:"roundedrectangle",point:[.88,.38],inside:false},
  {shape:"rect",point:[.88,.38],inside:true}
];
const F6 = {drill:1, diameter:2, dielectric:1.6, externalCopper:.035};
const F1 = {
  POWER:{preferred:[1.10, .45], minimum:[.80, .37], passing:[.95, .40], failing:[.76, .40]},
  SIGNAL:{preferred:[.54, .28], minimum:[.42, .24]}
};

// Independent analytic coordinates and distance to every output segment.
function sample(edge, fraction) {
  const t = (edge.start + fraction * edge.sweep) * Math.PI / 180;
  const c = Math.cos(t), s = Math.sin(t), at = edge.center;
  return edge.kind === "arc" ? [at[0] + edge.radius * c, at[1] - edge.radius * s] :
    at.map((x, k) => x + edge.cosineAxis[k] * c + edge.sineAxis[k] * s);
}
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;
function assertError(flatten) {
  for (const tolerance of [.01, .001]) for (const edge of [C1.arc, C1.ellipse]) {
    const points = flatten([edge], tolerance);
    assert.ok(points.length >= 2);
    assert.ok(near(points[0], sample(edge, 0)) && near(points.at(-1), sample(edge, 1)), "authored endpoints");
    let worst = 0;
    for (let i = 0; i <= 1024; i++) {
      const at = sample(edge, i / 1024);
      let gap = Infinity;
      for (let j = 1; j < points.length; j++) gap = Math.min(gap, pointSeg(at, points[j - 1], points[j]));
      worst = Math.max(worst, gap);
    }
    assert.ok(worst <= tolerance + 1e-10, edge.kind + " chord deviation " + worst + " exceeds " + tolerance);
  }
}
function assertFlatten(flatten) {
  assertError(flatten);
  const arc = C1.arc, end = [-6, 0], line = {kind:"line", a:end, b:[-7, 0]};
  const joined = flatten([arc, line], .01);
  assert.equal(joined.filter(p => near(p, end)).length, 1, "shared endpoint occurs once");
  assert.deepEqual(joined.at(-1), line.b);
  for (const sweep of [360, -360]) {
    const full = flatten([{...arc, sweep}], .01);
    assert.ok(near(full[0], full.at(-1)) && full.length > 2, "signed full turn closes");
    const area = full.slice(1).reduce((n, p, i) => n + full[i][0] * p[1] - p[0] * full[i][1], 0);
    assert.equal(Math.sign(area), -Math.sign(sweep), "full turn preserves winding");
  }
  assert.deepEqual(flatten([], .01), []);
  assert.throws(() => flatten([arc, {...line, a:[-6.1, 0]}], .01), "disconnected edges");
  for (const tolerance of [0, -1, NaN, Infinity]) assert.throws(() => flatten([arc], tolerance), RangeError);
  assert.throws(() => assertError(([edge]) => [0, .5, 1].map(t => sample(edge, t))), /chord deviation/);
}

module.exports = {F1, F2, F3, F4, F5, F6, C1, assertFlatten, mirroredLandPoint, mirroredTopRow, landContacts};
