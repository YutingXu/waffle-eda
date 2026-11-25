"use strict";

const {segSeg} = require("./segment-distance.cjs");
// The two drag fixtures use unrotated placements and axis-aligned rectangular pads.
function prims(items, defs) {
  const out = [];
  for (const i of items) {
    if (i.kind === "track") for (let k = 1; k < i.points.length; k++) out.push({id:i.id, net:i.net, layer:i.layer, a:i.points[k - 1], b:i.points[k], r:i.width / 2});
    else if (i.kind === "via") out.push({id:i.id, net:i.net, layer:"*", a:[i.x, i.y], b:[i.x, i.y], r:i.diameter / 2});
    else if (i.kind === "part") for (const p of defs.get(i.def).footprint.pads) {
      const c = [i.x + p.x, i.y + p.y], hw = p.w / 2, hh = p.h / 2, net = i.pinNets?.[p.number] || "";
      const q = [[c[0] - hw, c[1] - hh], [c[0] + hw, c[1] - hh], [c[0] + hw, c[1] + hh], [c[0] - hw, c[1] + hh]];
      for (let k = 0; k < 4; k++) out.push({id:i.id + "." + p.number, net, layer:p.layer || "Top", a:q[k], b:q[(k + 1) % 4], r:0, poly:q});
    }
  }
  return out;
}
const inside = (p, q) => p[0] >= q[0][0] - 1e-9 && p[0] <= q[2][0] + 1e-9 && p[1] >= q[0][1] - 1e-9 && p[1] <= q[2][1] + 1e-9;
function audit(items, defs, clearance = 0.2) {
  const P = prims(items, defs);
  let worst = Infinity, where = null;
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], b = P[j];
    if (a.net && a.net === b.net || a.id === b.id) continue;
    if (a.layer !== "*" && b.layer !== "*" && a.layer !== b.layer) continue;
    let g = segSeg(a.a, a.b, b.a, b.b) - a.r - b.r;
    if (a.poly && (inside(b.a, a.poly) || inside(b.b, a.poly))) g = -1;
    if (b.poly && (inside(a.a, b.poly) || inside(a.b, b.poly))) g = -1;
    if (g - clearance < worst) { worst = g - clearance; where = [a.id, b.id]; }
  }
  return {worst, where};
}

module.exports = {audit};
