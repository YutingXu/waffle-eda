"use strict";
// The pour engine's copper since 2026-11-20 (two stages, earlier copper clipped to the work box,
// canonical rings) against the copper the single-stage engine stored for the same boards
// (tests/fixtures/pour-v1/copper.json, made from tests/fixtures/pour-v1/boards.js): every boundary
// vertex of either lies within 50 nm of the other's boundary, per pour, layer and net, and the copper
// areas agree. Islands may differ only by slivers under 1e-5 mm² (snapping artefacts).
// Run: scripts/test-jsc.sh pour-v2-deviation   (ATRIUM_ENGINE=wasm|js picks the core) or node.
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "query", "viastack", "rooms", "component-classes", "pcb-pours", "rules", "polygon-pour"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
try { require("../../app/engine-core.js"); } catch { /* JS core */ }
require("./dense-board.js");
require("../fixtures/pour-v1/boards.js");
const fs = require("node:fs"), path = require("node:path");
const PP = AtriumPolygonPour, MAX_MM = 50e-6, SLIVER_MM2 = 1e-5;
const old = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/pour-v1/copper.json"), "utf8"));
const area = r => { let s = 0; const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) s += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1]; return s / 2; };
// Edges of a ring set in a uniform grid; dist(x, y) is the distance to the nearest edge within `reach`.
function edges(rings, reach) {
  const segs = [];
  for (const r of rings) { const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) segs.push(r[2 * j], r[2 * j + 1], r[2 * i], r[2 * i + 1]); }
  const cell = .05, grid = new Map(), key = (cx, cy) => cx * 1e6 + cy;
  for (let k = 0; k < segs.length; k += 4) {
    const x0 = Math.floor((Math.min(segs[k], segs[k + 2]) - reach) / cell), x1 = Math.floor((Math.max(segs[k], segs[k + 2]) + reach) / cell);
    const y0 = Math.floor((Math.min(segs[k + 1], segs[k + 3]) - reach) / cell), y1 = Math.floor((Math.max(segs[k + 1], segs[k + 3]) + reach) / cell);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) { const q = key(cx, cy); let l = grid.get(q); if (!l) grid.set(q, l = []); l.push(k); }
  }
  return (x, y) => {
    let best = Infinity;
    for (const k of grid.get(key(Math.floor(x / cell), Math.floor(y / cell))) || []) {
      const ax = segs[k], ay = segs[k + 1], dx = segs[k + 2] - ax, dy = segs[k + 3] - ay, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
    }
    return best;
  };
}
function deviation(a, b) {
  const near = edges(b, 1e-3);let worst = 0;
  for (const r of a) for (let i = 0; i < r.length; i += 2) worst = Math.max(worst, near(r[i], r[i + 1]));
  return worst;
}
let groups = 0, worst = 0, vertices = 0;
for (const b of atriumPourV1Boards()) {
  const list = PP.polygons(b.d), index = new Map(list.map((p, k) => [p.id, k]));
  const fresh = PP.repourAll(b.d, b.defs, {project: b.p, reuse: false}).regions;
  const group = (regions, pourOf) => {
    const m = new Map();
    for (const r of regions) { const k = pourOf(r) + "|" + r.layer + "|" + (r.net || ""); if (!m.has(k)) m.set(k, []); m.get(k).push(PP.rings(r)); }
    return m;
  };
  const A = group(old[b.label], r => r.pour), B = group(fresh, r => index.get(r.polygon));
  const keys = new Set([...A.keys(), ...B.keys()]);
  for (const k of keys) {
    const ra = A.get(k) || [], rb = B.get(k) || [];
    const big = isl => Math.abs(area(isl[0])) >= SLIVER_MM2;
    assert.equal(ra.filter(big).length, rb.filter(big).length, b.label + " " + k + ": islands (other than slivers)");
    const fa = ra.flat(), fb = rb.flat(), copper = rs => rs.reduce((s, r) => s + area(r), 0);
    const da = deviation(fa.filter(r => Math.abs(area(r)) >= SLIVER_MM2), fb), db = deviation(fb.filter(r => Math.abs(area(r)) >= SLIVER_MM2), fa);
    const d = Math.max(da, db), per = fa.reduce((s, r) => { let p = 0; const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) p += Math.hypot(r[2 * i] - r[2 * j], r[2 * i + 1] - r[2 * j + 1]); return s + p; }, 0);
    assert.ok(d <= MAX_MM, b.label + " " + k + ": copper moved by " + (d * 1e6).toFixed(1) + " nm (limit 50 nm)");
    assert.ok(Math.abs(copper(fa) - copper(fb)) <= MAX_MM * per + 1e-9, b.label + " " + k + ": copper area " + copper(fa) + " vs " + copper(fb));
    worst = Math.max(worst, d); groups++; vertices += fa.reduce((s, r) => s + r.length / 2, 0);
  }
}
console.log("pour-v2-deviation: " + groups + " pour groups, " + vertices + " old vertices; largest boundary deviation " + (worst * 1e6).toFixed(1) + " nm (limit 50 nm)");
