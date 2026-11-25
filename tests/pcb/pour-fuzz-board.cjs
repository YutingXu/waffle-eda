"use strict";
// Property-based fuzzing of whole pours (polygon-pour.js prepare, both stages, finish) on random
// boards, checked against geometry measured independently from the board items:
//   * copper lies inside the polygon outline (nonzero rule: self-intersecting user outlines too)
//     and the board outline, within 1.5 grid units (20 nm at most on boards up to about 400 mm);
//   * copper keeps the polygon's clearance from every other-net track, pad (rectangles at odd
//     angles, round pads, vias) and from earlier pours of other nets on the layer, and never covers
//     one;
//   * dead copper removal, island area threshold and minimum primitive length hold per region;
//   * the JS core, the Rust/WebAssembly core and the pooled run (repourParallel on a pool that
//     answers in shuffled order) store identical copper.
// Boards range from 10 mm to 1.4 m (the integer frame's resolution drops below 10 nm past about
// 330 mm); relief spokes at odd angles, 2 or 4 entries, tiny and coarse arc approximations.
//   scripts/test-jsc.sh pour-fuzz-board                      the seed-pinned short run (CI)
//   ATRIUM_POUR_FUZZ_BOARDS=500 node tests/pcb/pour-fuzz-board.cjs   a long run (ATRIUM_POUR_FUZZ_SEED picks the seed)
const assert = require("node:assert/strict");
const env = name => globalThis[name] ?? process.env[name];
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "pcb-text-rich", "pcb-text", "stackup", "rules", "viastack", "board-shape", "polygon-pour"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
try { require("../../app/engine-core.js"); } catch { /* the JS core alone */ }
const PP = AtriumPolygonPour, A = Atrium, engine = globalThis.AtriumEngine;
const wasm = engine?.available && env("ATRIUM_ENGINE") !== "js" ? engine : null;
const withEngine = (on, f) => { const e = globalThis.AtriumEngine; globalThis.AtriumEngine = on || undefined; try { return f(); } finally { globalThis.AtriumEngine = e; } };

function rng(seed) {
  let s = seed >>> 0 || 1;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  r.int = n => Math.floor(r() * n); r.pick = a => a[r.int(a.length)]; r.range = (a, b) => a + (b - a) * r();
  return r;
}
const rot = (x, y, deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };
// A random board: outline, 1..3 pours on Top, pads, vias, tracks and a part, nets N0..N3.
function board(seed) {
  const R = rng(seed), size = R.pick([10, 30, 60, 200, 600, 1400]), u = size / 30, ox = R.pick([0, -size / 2, 3000]), oy = R.pick([0, 50, -9000]);
  const d = A.sheet("pcb", "Fuzz " + seed), net = () => "N" + R.int(4), at = () => [ox + R.range(0, size), oy + R.range(0, size)];
  d.outline = R() < .8 ? [[ox, oy], [ox + size, oy], [ox + size, oy + size], [ox, oy + size]]
    : Array.from({length: 7}, (_, k) => { const a = k / 7 * 6.2832, r = size / 2 * (.7 + .3 * R()); return [ox + size / 2 + r * Math.cos(a), oy + size / 2 + r * Math.sin(a)]; });
  let id = 0;
  const item = o => { const i = {id: "f" + (++id), ...o}; d.items.push(i); return i; };
  for (let k = R.int(10) + 2; k > 0; k--) {
    const [x, y] = at(), w = u * R.range(.3, 2), h = R() < .4 ? w : u * R.range(.3, 2);
    item({kind: "pad", x, y, w, h, angle: R.pick([0, 45, 90, R.range(0, 360)]), layer: "Top", shape: w === h && R() < .5 ? "round" : "rect", net: net()});
  }
  for (let k = R.int(8); k > 0; k--) { const [x, y] = at(), dia = u * R.range(.3, 1); item({kind: "via", x, y, diameter: dia, drill: dia / 2, layer: "Multi", net: net()}); }
  for (let k = R.int(8); k > 0; k--) {
    const pts = [at()];
    for (let j = R.int(4) + 1; j > 0; j--) { const p = pts[pts.length - 1]; pts.push(R() < .3 ? at() : [p[0] + u * R.range(-4, 4), p[1] + u * R.range(-4, 4)]); }
    item({kind: "track", layer: "Top", width: u * R.range(.05, .6), points: pts, net: net()});
  }
  const defs = new Map();
  if (R() < .7) {
    const pads = Array.from({length: 2 + R.int(4)}, (_, j) => ({number: String(j + 1), x: u * (j - 1.5), y: u * R.range(-1, 1), w: u * .8, h: u * .5, angle: R.range(0, 180), shape: "rect", layer: "Top"}));
    defs.set("fz", {id: "fz", footprint: {pads}});
    const [x, y] = at();
    item({kind: "part", def: "fz", x, y, angle: R.range(0, 360), ref: "U1", pinNets: Object.fromEntries(pads.map(p => [p.number, net()]))});
  }
  const polys = [];
  for (let k = 1 + R.int(3); k > 0; k--) {
    let outline;
    const kind = R.int(4);
    if (kind === 0) outline = [[ox, oy], [ox + size, oy], [ox + size, oy + size], [ox, oy + size]];
    else if (kind === 1) { const [x, y] = at(), w = R.range(size / 4, size), h = R.range(size / 4, size); outline = [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]]; }
    else if (kind === 2) outline = Array.from({length: 4 + R.int(5)}, at); // often self-intersecting
    else outline = [0, 2, 4, 1, 3].map(j => { const a = j / 5 * 6.2832 + .3; return [ox + size / 2 + size * .45 * Math.cos(a), oy + size / 2 + size * .45 * Math.sin(a)]; }); // a star
    polys.push(item(PP.make(outline, {layer: "Top", net: net(), pourIndex: k, clearance: u * R.range(.05, .5), removeDeadCopper: R() < .5,
      connectStyle: R.pick(["relief", "relief", "direct", "none"]), reliefEntries: R.pick([2, 4]), reliefAngle: R.pick([45, 90]),
      reliefConductorWidth: u * R.range(.05, .3), reliefAirGap: u * R.range(.05, .3), arcApproximation: R.pick([.0005, .0127, u * .2]),
      islandAreaThreshold: R() < .3 ? u * u * R.range(.1, 3) : 0, minPrimLength: R() < .3 ? u * R.range(.05, .5) : 0})));
    // Remove Necks on a third of the pours, Outlines Only on a tenth (the island tests still hold).
    const last = polys[polys.length - 1], f = R();
    if (f < .3) last.neckWidth = Math.min(5, Math.max(.01, u * R.range(.05, .6)));
    else if (f < .4) { last.fillMode = "outline"; last.hatchWidth = u * R.range(.05, .4); }
  }
  return {d, defs, polys, size};
}

// ---------------------------------------------------------------- independent geometry
function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(ax, ay, bx, by, cx, cy), d2 = o(ax, ay, bx, by, dx, dy), d3 = o(cx, cy, dx, dy, ax, ay), d4 = o(cx, cy, dx, dy, bx, by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const ps = (px, py, x1, y1, x2, y2) => { const vx = x2 - x1, vy = y2 - y1, l = vx * vx + vy * vy; let t = l ? ((px - x1) * vx + (py - y1) * vy) / l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - x1 - t * vx, py - y1 - t * vy); };
  return Math.min(ps(ax, ay, cx, cy, dx, dy), ps(bx, by, cx, cy, dx, dy), ps(cx, cy, ax, ay, bx, by), ps(dx, dy, ax, ay, bx, by));
}
const winding = (rings, x, y) => {
  let w = 0;
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const x1 = r[2 * j], y1 = r[2 * j + 1], x2 = r[2 * i], y2 = r[2 * i + 1], cr = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
      if (y1 <= y && y < y2 && cr > 0) w++; else if (y2 <= y && y < y1 && cr < 0) w--;
    }
  }
  return w;
};
const evenOdd = (rings, x, y) => { let c = false; for (const r of rings) { const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) { const yi = r[2 * i + 1], yj = r[2 * j + 1]; if ((yi > y) !== (yj > y) && x < (r[2 * j] - r[2 * i]) * (y - yi) / (yj - yi) + r[2 * i]) c = !c; } } return c; };
const flat = pts => pts.flatMap(p => [p[0], p[1]]);
const edgesOf = rings => { const out = []; for (const r of rings) { const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) out.push([r[2 * j], r[2 * j + 1], r[2 * i], r[2 * i + 1]]); } return out; };
function distToRing(edges, core, x, y) { // distance from copper edges to a convex core (point, segment, polygon)
  let best = Infinity;
  const n = core.length;
  for (const e of edges) {
    if (n === 1) best = Math.min(best, segSeg(e[0], e[1], e[2], e[3], core[0][0], core[0][1], core[0][0], core[0][1]));
    else for (let i = 0; i < (n === 2 ? 1 : n); i++) { const p = core[i], q = core[(i + 1) % n]; best = Math.min(best, segSeg(e[0], e[1], e[2], e[3], p[0], p[1], q[0], q[1])); }
  }
  return best;
}
// Other-net obstacles of a pour: {what, core (convex: points), radius, at (a point inside)}.
function obstacles(d, defs, P) {
  const out = [], same = n => !!P.net && n === P.net;
  for (const i of d.items) {
    if (i.kind === "pad" && !same(i.net)) {
      if (i.shape === "round") out.push({what: i.id, core: [[i.x, i.y]], radius: i.w / 2});
      else out.push({what: i.id, core: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => { const q = rot(sx * i.w / 2, sy * i.h / 2, i.angle); return [i.x + q[0], i.y + q[1]]; }), radius: 0});
    } else if (i.kind === "via" && !same(i.net)) out.push({what: i.id, core: [[i.x, i.y]], radius: i.diameter / 2});
    else if (i.kind === "track" && !same(i.net)) for (let k = 1; k < i.points.length; k++) out.push({what: i.id + "/" + k, core: [i.points[k - 1], i.points[k]], radius: i.width / 2});
    else if (i.kind === "part") for (const p of defs.get(i.def).footprint.pads) {
      if (same(i.pinNets[p.number])) continue;
      const c = rot(p.x, p.y, i.angle), cx = i.x + c[0], cy = i.y + c[1];
      out.push({what: i.id + ":" + p.number, core: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => { const q = rot(sx * p.w / 2, sy * p.h / 2, i.angle + p.angle); return [cx + q[0], cy + q[1]]; }), radius: 0});
    }
  }
  return out;
}
const regionRings = r => AtriumPCBPours.contours(r).map(x => Array.from(x));
// The failures of one board's stored copper.
function check(b, pours, scale = () => 1e5) {
  const errors = [], {d, defs, polys} = b, byPoly = new Map(polys.map(p => [p.id, []]));
  for (const r of pours) byPoly.get(r.polygon)?.push(r);
  const order = polys.slice().sort((p, q) => p.pourIndex - q.pourIndex);
  const boardRing = flat(d.outline), eps = 1e-9;
  for (const P of order) {
    const regions = byPoly.get(P.id), outline = flat(P.points), obs = obstacles(d, defs, P), unit = Math.max(2e-5, 1.5 / scale(P.id));
    for (const r of regions) {
      const rings = regionRings(r), edges = edgesOf(rings);
      // Inside the outline (nonzero) and the board: every vertex and edge midpoint, unless on the boundary.
      const outlineEdges = edgesOf([outline]), boardEdges = edgesOf([boardRing]);
      for (const e of edges) for (const [x, y] of [[e[0], e[1]], [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2]]) {
        const near = (es, x, y) => es.some(f => segSeg(x, y, x, y, f[0], f[1], f[2], f[3]) < unit);
        if (winding([outline], x, y) === 0 && !near(outlineEdges, x, y)) { errors.push(P.id + ": copper at " + x.toFixed(4) + "," + y.toFixed(4) + " outside its outline"); break; }
        if (!evenOdd([boardRing], x, y) && !near(boardEdges, x, y)) { errors.push(P.id + ": copper at " + x.toFixed(4) + "," + y.toFixed(4) + " outside the board"); break; }
      }
      // Clearance to other-net objects, and not covering them.
      for (const o of obs) {
        const gap = distToRing(edges, o.core) - o.radius;
        if (gap < P.clearance - eps) errors.push(P.id + ": " + o.what + " at " + gap.toFixed(7) + " mm, clearance " + P.clearance.toFixed(7) + " (short " + ((P.clearance - gap) * 1e6).toFixed(1) + " nm)");
        const cx = o.core.reduce((s, p) => s + p[0], 0) / o.core.length, cy = o.core.reduce((s, p) => s + p[1], 0) / o.core.length;
        if (evenOdd(rings, cx, cy)) errors.push(P.id + ": copper covers " + o.what);
      }
      // Island tests.
      let area = 0; for (const ring of rings) { let s = 0; const n = ring.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) s += ring[2 * j] * ring[2 * i + 1] - ring[2 * i] * ring[2 * j + 1]; area += s / 2; }
      if (P.removeDeadCopper && P.net && !(r.links || []).length) errors.push(P.id + ": dead island kept");
      if (P.islandAreaThreshold > 0 && Math.abs(area) < P.islandAreaThreshold * (1 - 1e-9)) errors.push(P.id + ": island of " + Math.abs(area).toExponential(3) + " mm² under the threshold " + P.islandAreaThreshold.toExponential(3));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < rings[0].length; i += 2) { x0 = Math.min(x0, rings[0][i]); x1 = Math.max(x1, rings[0][i]); y0 = Math.min(y0, rings[0][i + 1]); y1 = Math.max(y1, rings[0][i + 1]); }
      if (P.minPrimLength > 0 && x1 - x0 < P.minPrimLength - 1e-6 && y1 - y0 < P.minPrimLength - 1e-6) errors.push(P.id + ": island smaller than the minimum primitive length");
      if (errors.length > 6) return errors;
    }
    // Earlier pours of another net keep this pour's clearance.
    for (const Q of order) {
      if (Q === P || Q.pourIndex >= P.pourIndex || (P.net && Q.net === P.net)) continue;
      for (const r of regions) for (const q of byPoly.get(Q.id)) {
        const re = edgesOf(regionRings(r)), qe = edgesOf(regionRings(q));
        let gap = Infinity;
        for (const e of re) for (const f of qe) { const g = segSeg(e[0], e[1], e[2], e[3], f[0], f[1], f[2], f[3]); if (g < gap) gap = g; }
        if (gap < P.clearance - eps) errors.push(P.id + " to earlier " + Q.id + ": " + gap.toFixed(7) + " mm, clearance " + P.clearance.toFixed(7));
        const v = regionRings(r)[0];
        if (evenOdd(regionRings(q), v[0], v[1])) errors.push(P.id + " overlaps earlier " + Q.id);
      }
    }
  }
  return errors;
}

let seed = 7;
const pool = {size: 3, available: true, run(task) {
  return new Promise((ok, no) => setTimeout(() => { try { ok(PP._internal.core.solve(task)); } catch (e) { no(e); } }, (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 3));
}, stats: () => ({workerMs: 0})};
const json = regions => JSON.stringify(regions);
globalThis.__testDone = (async () => {
  const cases = +(env("ATRIUM_POUR_FUZZ_BOARDS") || 0) || 40, seed0 = +(env("ATRIUM_POUR_FUZZ_SEED") || 0) || 0xb0a2d;
  const failed = [], times = [];
  let regions = 0, maxScale = 0, minScale = Infinity, shapedPours = 0;
  for (let c = 0; c < cases; c++) {
    const s = (seed0 + Math.imul(c, 0x9e3779b1)) >>> 0, b = board(s), errors = [];
    const t0 = performance.now();
    let js;
    if (env("ATRIUM_POUR_FUZZ_VERBOSE")) console.log("board " + s.toString(16) + " " + b.size + " mm: " + b.polys.map(P => P.id.slice(-4) + (P.neckWidth ? " neck " + P.neckWidth.toFixed(3) : "") + (P.fillMode === "outline" ? " outline " + P.hatchWidth.toFixed(3) : "") + " arc " + P.arcApproximation).join(", "));
    try { js = withEngine(null, () => PP.repourAll(b.d, b.defs, {})); } catch (e) { failed.push(s); console.log("FAIL board " + s.toString(16) + ": threw " + e.message); continue; }
    times.push(performance.now() - t0);
    for (const st of Object.values(js.stats.polygons || {})) if (st.scale) { maxScale = Math.max(maxScale, st.scale); minScale = Math.min(minScale, st.scale); }
    regions += js.regions.length;
    errors.push(...check(b, js.regions, id => js.stats.polygons?.[id]?.scale || 1e5));
    if (wasm && json(withEngine(wasm, () => PP.repourAll(b.d, b.defs, {})).regions) !== json(js.regions)) errors.push("Rust/WebAssembly copper differs from the JS core's");
    // Remove Necks and Outlines Only only take copper away: each such pour's copper, with every
    // other pour as poured, lies within (here: its area is at most) the copper it pours without them.
    for (const P of b.polys) {
      if (!(P.neckWidth > 0 || P.fillMode === "outline")) continue;
      const area = rs => { let a = 0; for (const r of rs) for (const ring of regionRings(r)) { let s2 = 0; const n = ring.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) s2 += ring[2 * j] * ring[2 * i + 1] - ring[2 * i] * ring[2 * j + 1]; a += s2 / 2; } return a; };
      const shaped = js.regions.filter(r => r.polygon === P.id), keep = {neckWidth: P.neckWidth, fillMode: P.fillMode};
      delete P.neckWidth; P.fillMode = "solid";
      let plain; try { plain = withEngine(null, () => PP.repourAll(b.d, b.defs, {reuse: false})).regions.filter(r => r.polygon === P.id); } finally { if (keep.neckWidth) P.neckWidth = keep.neckWidth; P.fillMode = keep.fillMode; }
      // Earlier pours are unchanged and later ones are not read: the plain run is the same board otherwise.
      if (area(shaped) > area(plain) * (1 + 1e-9) + 1e-9) errors.push(P.id + ": shaped copper " + area(shaped).toFixed(6) + " mm² exceeds the unshaped " + area(plain).toFixed(6));
      shapedPours++;
    }
    const pooled = await withEngine(null, () => PP.repourParallel(b.d, b.defs, {}, pool));
    if (json(pooled.regions) !== json(js.regions)) errors.push("the pooled run's copper differs from the serial run's");
    if (env("ATRIUM_POUR_FUZZ_VERBOSE")) console.log("board " + s.toString(16) + " " + b.size + " mm: pour " + times[times.length - 1].toFixed(0) + " ms, total " + (performance.now() - t0).toFixed(0) + " ms, " + js.regions.length + " regions");
    if (errors.length) { failed.push(s); console.log("FAIL board " + s.toString(16) + " (" + b.size + " mm): " + errors.slice(0, 4).join("; ")); }
  }
  times.sort((a, b) => a - b);
  console.log("pour-fuzz-board: " + cases + " boards from seed " + seed0.toString(16) + ", " + regions + " regions, scale " + minScale.toFixed(0) + ".." + maxScale.toFixed(0) +
    " units/mm, per board median " + times[times.length >> 1].toFixed(1) + " ms (serial pour); " + shapedPours + " pours with necks removed or outlines only; " + failed.length + " failures");
  assert.equal(failed.length, 0, "failing boards: " + failed.map(s => s.toString(16)).join(", "));
})();
globalThis.__testDone.catch(e => { console.error(e); if (globalThis.process) process.exitCode = 1; });
