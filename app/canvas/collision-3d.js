"use strict";

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// 3D component clearance (the componentClearance rule, Altium's Component Clearance) and the
// 3D view's collision highlight. Loaded lazily (AtriumLazy "AtriumCollision3D") by DRC and the
// 3D view; needs AtriumSTEP (bodies and placements) and, for rigid-flex, AtriumFlexFold.
//
// Bodies are the ones the 3D view and the STEP export use (AtriumSTEP.model): generated bodies
// extruded from the footprint's body or courtyard outline to the part height, and embedded STEP
// models as their bounding box in the part frame (AtriumSTEPImport's tessellation when loaded,
// else the box of the model's points; mode "boxes" turns every body into its box).
// Folded (rigid-flex), the parts ride the fold with the same matrices as the 3D view.
//
// Broad phase: world AABBs grown by the reach, a uniform spatial hash (xy flat, xyz folded),
// pair keys deduplicated. Narrow phase:
//   - bodies with parallel axes (every pair on a flat board; parts on the same or a parallel
//     rigid piece when folded): exact. The outlines are projected on the common plane, the
//     heights on the axis: horizontal gap dh = polygon distance, vertical gap dv = interval
//     gap. A pair violates when dh < horizontal clearance and dv < vertical clearance.
//   - other pairs (different pieces of a folded board): GJK distance between the convex hulls
//     of the two bodies (conservative for concave outlines) against the horizontal clearance.
//   - folded boards, rule option "board": bodies (lifted 0.05 mm off their own seat) against
//     the folded board's triangles: any intersection is a collision.
//
//   AtriumCollision3D.bodies(doc, defs, {t, mode, project})       -> {list, board, fold, ms}
//   AtriumCollision3D.check(doc, defs, {t, gap, vertical, mode, board, rules, project, pairs})
//       -> {findings:[{a, b, kind, actual, required, at, otherAt, at3d, otherAt3d, rule}], stats}
//   AtriumCollision3D.drc(doc, defs, {rules, flag, notes, stats, project})   (rules.js hook)
globalThis.AtriumCollision3D = (() => {
  const EPS = 1e-6, SEAT = 0.05;
  const now = () => globalThis.performance?.now ? performance.now() : Date.now();
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const projectOf = (doc, defs, project) => project || {name: doc.name || "Board", documents: [doc], library: [...(defs?.values?.() || [])]};

  // ---------------------------------------------------------------- bodies
  // Each body: {id, ref, side, part, M (column-major), pts (local outline, Y up), z0, z1, box (world AABB)}.
  function bodies(doc, defs, o = {}) {
    const S = globalThis.AtriumSTEP, A = globalThis.AtriumGeometry.affine3D, t0 = now();
    if (!S) throw Error("Component clearance needs the 3D geometry module (step-export.js).");
    const t = o.t > 0 ? Math.min(1, o.t) : 0, folded = t > 0 && !!globalThis.AtriumFlexFold?.hasBends?.(doc);
    const m = S.model(projectOf(doc, defs, o.project), doc, {holes: false, vias: false, copper: false, silk: false, bodyEnvelopes: true, fold: folded ? t : 0, variant: o.variant});
    const list = [], items = new Map((doc.items || []).map(i => [i.id, i]));
    for (const p of m.parts) {
      let pts, z0, z1;
      if (p.source === "model") {
        // The tessellated model's box (assembly placements applied); else the raw point box.
        const tb = globalThis.AtriumSTEPImport?.ensure?.(p.model.text)?.bbox;
        const [x0,y0,lo,x1,y1,hi] = A.bounds(p.model.placement.matrix, tb || p.model.data.bbox);
        pts = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]; z0 = lo; z1 = hi;
      } else {
        const f = S.flattenLoop(p.body.loops[0], 0.02); pts = [];
        for (let i = 0; i < f.length; i += 2) pts.push([f[i], f[i + 1]]);
        z0 = p.body.z0; z1 = p.body.z1;
      }
      if (o.mode === "boxes") {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const q of pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
        pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      }
      if (pts.length < 3 || !(z1 > z0)) continue;
      const M = Array.from(p.matrix), box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const q of pts) for (const z of [z0, z1]) { const w = A.point(M, [q[0], q[1], z]); for (let k = 0; k < 3; k++) { box[k] = Math.min(box[k], w[k]); box[k + 3] = Math.max(box[k + 3], w[k]); } }
      const it = items.get(p.id);
      const authoredSolid = it?.kind === "part" && p.source === "extruded" && p.body.loops.length === 1 && p.body.loops[0].every(s => !s.c);
      list.push({id: p.id, item: it, ref: p.ref, side: p.side, source: p.source, component: it?.kind === "part", authoredSolid, M, pts, z0, z1, box, index: list.length, xy: it ? [it.x, it.y] : [M[12], -M[13]]});
    }
    return {list, model: m, folded, t: folded ? t : 0, ms: now() - t0};
  }

  // ---------------------------------------------------------------- parallel-axis frame
  // Canonical axis (sign normalised) and a basis of its plane, so bodies with parallel axes
  // project into the same 2D coordinates.
  function frameOf(b) {
    if (b.frame) return b.frame;
    let a = [b.M[8], b.M[9], b.M[10]];
    const s = a[2] < -1e-9 || Math.abs(a[2]) <= 1e-9 && (a[1] < -1e-9 || Math.abs(a[1]) <= 1e-9 && a[0] < 0) ? -1 : 1;
    a = a.map(v => v * s);
    const key = a.map(v => Math.round(v * 1e6)).join(",");
    const ax = Math.abs(a[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1], e1 = norm(cross(ax, a)), e2 = cross(a, e1);
    // A flat board keeps x and y (so the 2D points are board points, Y up).
    const flat = key === "0,0,1000000";
    const E1 = flat ? [1, 0, 0] : e1, E2 = flat ? [0, 1, 0] : e2;
    const {point} = globalThis.AtriumGeometry.affine3D;
    const poly = b.pts.map(q => { const w = point(b.M, [q[0], q[1], 0]); return [dot(w, E1), dot(w, E2)]; });
    const o = dot(point(b.M, [0, 0, 0]), a), h = [o + b.z0 * s, o + b.z1 * s].sort((x, y) => x - y);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of poly) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
    return (b.frame = {key, axis: a, E1, E2, poly, h, box2: [x0, y0, x1, y1], flat});
  }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // ---------------------------------------------------------------- 2D polygon distance
  const {inRing, projectPointOnSegment, strictCrossing} = globalThis.AtriumGeometry;
  // {d, at}: 0 when the outlines overlap.
  function polyDist(A, B) {
    if (inRing(A[0], B)) return {d: 0, at: A[0]};
    if (inRing(B[0], A)) return {d: 0, at: B[0]};
    let best = {d: Infinity, at: A[0]};
    for (let i = 0; i < A.length; i++) {
      const a = A[i], a2 = A[(i + 1) % A.length];
      for (let j = 0; j < B.length; j++) {
        const b = B[j], b2 = B[(j + 1) % B.length];
        if (strictCrossing(a, a2, b, b2)) return {d: 0, at: a};
        const q = projectPointOnSegment(a, b, b2), da = Math.hypot(a[0]-q[0], a[1]-q[1]);
        if (da < best.d) best = {d: da, at: [(a[0]+q[0])/2, (a[1]+q[1])/2]};
        const p = projectPointOnSegment(b, a, a2), db = Math.hypot(b[0]-p[0], b[1]-p[1]);
        if (db < best.d) best = {d: db, at: [(b[0]+p[0])/2, (b[1]+p[1])/2]};
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- GJK distance (convex hulls)
  const support = (P, d) => { let bi = 0, bv = -Infinity; for (let i = 0; i < P.length; i += 3) { const v = P[i] * d[0] + P[i + 1] * d[1] + P[i + 2] * d[2]; if (v > bv) { bv = v; bi = i; } } return [P[bi], P[bi + 1], P[bi + 2]]; };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], addS = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  function segClosest(a, b) {
    const ab = sub(b, a), l = dot(ab, ab), t = l > 0 ? Math.max(0, Math.min(1, -dot(a, ab) / l)) : 0;
    return t <= 0 ? {p: a, s: [a]} : t >= 1 ? {p: b, s: [b]} : {p: addS(a, ab, t), s: [a, b]};
  }
  function triClosest(a, b, c) {
    const ab = sub(b, a), ac = sub(c, a), ap = [-a[0], -a[1], -a[2]];
    const d1 = dot(ab, ap), d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return {p: a, s: [a]};
    const bp = [-b[0], -b[1], -b[2]], d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return {p: b, s: [b]};
    const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) return {p: addS(a, ab, d1 / (d1 - d3)), s: [a, b]};
    const cp = [-c[0], -c[1], -c[2]], d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return {p: c, s: [c]};
    const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) return {p: addS(a, ac, d2 / (d2 - d6)), s: [a, c]};
    const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return {p: addS(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))), s: [b, c]};
    const den = 1 / (va + vb + vc); return {p: addS(addS(a, ab, vb * den), ac, vc * den), s: [a, b, c]};
  }
  function tetClosest(a, b, c, d) {
    const side = (p, q, r, s) => { const n = cross(sub(q, p), sub(r, p)); return [dot(n, [-p[0], -p[1], -p[2]]), dot(n, sub(s, p))]; };
    let best = null;
    for (const [p, q, r, s] of [[a, b, c, d], [a, c, d, b], [a, d, b, c], [b, d, c, a]]) {
      const [o, w] = side(p, q, r, s);
      if (o * w < 0 || Math.abs(w) < 1e-18) { const t = triClosest(p, q, r); if (!best || dot(t.p, t.p) < dot(best.p, best.p)) best = t; }
    }
    return best || {p: [0, 0, 0], s: [a, b, c, d]};
  }
  // Distance between the convex hulls of two point sets (flat xyz arrays); 0 when they meet.
  function gjk(A, B) {
    const sup = d => sub(support(A, d), support(B, [-d[0], -d[1], -d[2]]));
    let v = sub([A[0], A[1], A[2]], [B[0], B[1], B[2]]), S = [];
    for (let it = 0; it < 64; it++) {
      const vv = dot(v, v);
      if (vv < 1e-18) return 0;
      const w = sup([-v[0], -v[1], -v[2]]);
      if (vv - dot(v, w) <= 1e-10 * Math.max(1, vv) || S.some(s => Math.abs(s[0] - w[0]) + Math.abs(s[1] - w[1]) + Math.abs(s[2] - w[2]) < 1e-12)) return Math.sqrt(vv);
      S.push(w);
      const r = S.length === 1 ? {p: S[0], s: [S[0]]} : S.length === 2 ? segClosest(S[0], S[1]) : S.length === 3 ? triClosest(S[0], S[1], S[2]) : tetClosest(S[0], S[1], S[2], S[3]);
      v = r.p; S = r.s;
      if (S.length === 4) return 0;
    }
    return Math.sqrt(dot(v, v));
  }
  function hull(b, lift) {
    if (b.hull && !lift) return b.hull;
    let z0 = b.z0, z1 = b.z1;
    if (lift) { if (z1 > 0 && z0 < SEAT) z0 = Math.min(z1, SEAT); else if (z1 <= 0 && z1 > -SEAT) z1 = Math.max(z0, -SEAT); if (!(z1 > z0)) return null; }
    const out = [], {point} = globalThis.AtriumGeometry.affine3D;
    for (const q of b.pts) for (const z of [z0, z1]) out.push(...point(b.M, [q[0], q[1], z]));
    if (!lift) b.hull = out;
    return out;
  }
  const centre = b => [(b.box[0] + b.box[3]) / 2, (b.box[1] + b.box[4]) / 2, (b.box[2] + b.box[5]) / 2];

  // ---------------------------------------------------------------- broad phase
  // Calls fn(i, j) once for every pair whose boxes, grown by reach, overlap.
  function pairs(list, reach, use3d, fn, verticalReach = reach) {
    if (list.length < 2) return 0;
    let size = 0;
    for (const b of list) size += Math.max(b.box[3] - b.box[0], b.box[4] - b.box[1]);
    const cell = Math.max(0.5, size / list.length * 2 + reach), grid = new Map(), seen = new Set();
    const k3 = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
    const range = (lo, hi) => [Math.floor(lo / cell), Math.floor(hi / cell)];
    let tests = 0;
    for (const b of list) {
      const [x0, x1] = range(b.box[0] - reach / 2, b.box[3] + reach / 2), [y0, y1] = range(b.box[1] - reach / 2, b.box[4] + reach / 2);
      const [z0, z1] = use3d ? range(b.box[2] - reach / 2, b.box[5] + reach / 2) : [0, 0];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const key = k3(x, y, z), l = grid.get(key);
        if (!l) { grid.set(key, [b.index]); continue; }
        for (const j of l) {
          const a = list[j], pk = j * 1048576 + b.index;
          if (seen.has(pk)) continue;
          seen.add(pk);
          if (a.box[0] - b.box[3] > reach || b.box[0] - a.box[3] > reach || a.box[1] - b.box[4] > reach || b.box[1] - a.box[4] > reach || a.box[2] - b.box[5] > verticalReach || b.box[2] - a.box[5] > verticalReach) continue;
          tests++; fn(a, b);
        }
        l.push(b.index);
      }
    }
    return tests;
  }

  // ---------------------------------------------------------------- check
  // opts: {t, gap, vertical, mode, board (bodies vs folded board), rules (compiled, with m1/m2),
  //        project, variant}. With rules, each pair uses the first rule whose scopes match it.
  function check(doc, defs, opts = {}) {
    const t0 = now(), B = bodies(doc, defs, opts), list = B.list, findings = [], stats = {bodies: list.length, pairs: 0, exact: 0, hull: 0, board: 0, buildMs: B.ms};
    const rules = opts.rules?.length ? opts.rules : null, unassessed = new Set();
    const H = r => r ? r.gap ?? 0.25 : opts.gap ?? 0, V = r => r ? r.vertical ?? 0.25 : opts.vertical ?? opts.gap ?? 0;
    // Rule masks per body (first scope / second scope).
    if (rules) {
      const n = Math.min(rules.length, 30);
      for (const b of list) {
        const o = {id:b.id, item:b.item, kind:b.item?.kind, definition:defs?.get(b.item?.def),
          net:"", component:b.ref, layer:b.side, at:b.xy};
        let m1 = 0, m2 = 0;
        for (let k = 0; k < n; k++) { if (rules[k].m1(o)) m1 |= 1 << k; if ((rules[k].m2 || rules[k].m1)(o)) m2 |= 1 << k; }
        b.m1 = m1; b.m2 = m2;
      }
    }
    const ruleOf = (a, b) => {
      if (!rules) return null;
      const m = (a.m1 & b.m2) | (b.m1 & a.m2);
      if (!m) return undefined;
      return rules[31 - Math.clz32(m & -m)];
    };
    const horizontalReach = rules ? Math.max(...rules.map(H)) : H(null), verticalReach = rules ? Math.max(...rules.map(V)) : V(null);
    const reach = B.folded ? Math.max(horizontalReach, verticalReach) : horizontalReach;
    const scoped = rules ? list.filter(b => b.m1 || b.m2) : list;
    scoped.forEach((b, i) => { b.index = i; });
    const flatXY = b => b.xy; // the part's board position (its origin before any fold)
    stats.pairs = pairs(scoped, reach + EPS, B.folded, (a, b) => {
      if (a.id === b.id) return; // authored bodies of one component may overlap
      const r = ruleOf(a, b);
      if (r === undefined || a.id === b.id) return;
      if ((r?.mode ?? opts.mode) === "authored" && (!a.component || !b.component)) return;
      if ((r?.skipMissingBody ?? opts.skipMissingBody) && (a.source === "generated" || b.source === "generated")) return;
      if ((r?.mode ?? opts.mode) === "authored" && (!a.authoredSolid || !b.authoredSolid || B.folded)) {
        if (!a.authoredSolid) unassessed.add(a.id);
        if (!b.authoredSolid) unassessed.add(b.id);
        return;
      }
      const h = H(r), v = V(r), fa = frameOf(a), fb = frameOf(b);
      if (fa.key === fb.key) {
        stats.exact++;
        const dv = Math.max(0, Math.max(fa.h[0], fb.h[0]) - Math.min(fa.h[1], fb.h[1]));
        if (dv >= v - EPS && dv > EPS) return;
        if (fa.box2[0] - fb.box2[2] >= h || fb.box2[0] - fa.box2[2] >= h || fa.box2[1] - fb.box2[3] >= h || fb.box2[1] - fa.box2[3] >= h) return;
        const g = polyDist(fa.poly, fb.poly), dh = g.d;
        if (dh >= h - EPS && !(dh <= EPS && dv <= EPS)) return;
        const kind = dh <= EPS && dv <= EPS ? "collision" : dv <= EPS ? "horizontal" : dh <= EPS ? "vertical" : "horizontal";
        const at = fa.flat && !B.folded ? [g.at[0], -g.at[1]] : flatXY(a);
        findings.push({a, b, rule: r, kind, actual: kind === "vertical" ? dv : kind === "collision" ? 0 : dh, required: kind === "vertical" ? v : h, horizontal: dh, vertical: dv,
          at, otherAt: fa.flat && !B.folded ? at : flatXY(b), at3d: centre(a), otherAt3d: centre(b), folded: B.folded});
        return;
      }
      stats.hull++;
      const d = gjk(hull(a), hull(b));
      if (d >= h - EPS && d > EPS) return;
      findings.push({a, b, rule: r, kind: d <= EPS ? "collision" : "3d", actual: d, required: h, at: flatXY(a), otherAt: flatXY(b), at3d: centre(a), otherAt3d: centre(b), folded: B.folded, approximate: true});
    }, (B.folded ? reach : verticalReach) + EPS);
    // Bodies against the folded board.
    if (B.folded && opts.board !== false && list.length) {
      const S = globalThis.AtriumSTEP, mesh = S.mesh({...B.model, parts: [], layers: []}, {tolerance: 0.05}), tris = [];
      for (const p of mesh.parts) {
        if (p.kind !== "board" && p.kind !== "stiffener") continue;
        const P = p.positions, I = p.indices;
        for (let i = 0; i < I.length; i += 3) {
          const T = [P[I[i] * 3], P[I[i] * 3 + 1], P[I[i] * 3 + 2], P[I[i + 1] * 3], P[I[i + 1] * 3 + 1], P[I[i + 1] * 3 + 2], P[I[i + 2] * 3], P[I[i + 2] * 3 + 1], P[I[i + 2] * 3 + 2]];
          tris.push({T, box: [Math.min(T[0], T[3], T[6]), Math.min(T[1], T[4], T[7]), Math.min(T[2], T[5], T[8]), Math.max(T[0], T[3], T[6]), Math.max(T[1], T[4], T[7]), Math.max(T[2], T[5], T[8])]});
        }
      }
      const cell = 2, grid = new Map(), K = (x, y, z) => x + "," + y + "," + z;
      tris.forEach((tr, i) => { for (let x = Math.floor(tr.box[0] / cell); x <= Math.floor(tr.box[3] / cell); x++) for (let y = Math.floor(tr.box[1] / cell); y <= Math.floor(tr.box[4] / cell); y++) for (let z = Math.floor(tr.box[2] / cell); z <= Math.floor(tr.box[5] / cell); z++) { const k = K(x, y, z); const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); } });
      for (const b of scoped) {
        const r = rules ? rules.find((x, k) => k < 30 && ((b.m1 | b.m2) >> k & 1) && x.board !== false && x.fold !== "flat") : null;
        if (rules && !r) continue;
        const hp = hull(b, true);
        if (!hp) continue;
        const seen = new Set();
        let hit = false;
        for (let x = Math.floor(b.box[0] / cell); x <= Math.floor(b.box[3] / cell) && !hit; x++) for (let y = Math.floor(b.box[1] / cell); y <= Math.floor(b.box[4] / cell) && !hit; y++) for (let z = Math.floor(b.box[2] / cell); z <= Math.floor(b.box[5] / cell) && !hit; z++) {
          for (const i of grid.get(K(x, y, z)) || []) {
            if (seen.has(i)) continue; seen.add(i);
            const tr = tris[i].box;
            if (tr[0] > b.box[3] || tr[3] < b.box[0] || tr[1] > b.box[4] || tr[4] < b.box[1] || tr[2] > b.box[5] || tr[5] < b.box[2]) continue;
            stats.board++;
            if (gjk(hp, tris[i].T) <= EPS) { hit = true; break; }
          }
        }
        if (hit) findings.push({a: b, b: null, rule: r, kind: "board", actual: 0, required: 0, at: flatXY(b), otherAt: flatXY(b), at3d: centre(b), otherAt3d: centre(b), folded: true});
      }
    }
    stats.ms = Math.round((now() - t0) * 10) / 10;
    if (unassessed.size) stats.unassessedComponents = unassessed.size;
    return {findings, stats, folded: B.folded, t: B.t};
  }

  // ---------------------------------------------------------------- DRC hook (rules.js)
  const fmt = v => (Math.round(v * 1000) / 1000) + " mm";
  function drc(doc, defs, {rules, flag, notes, stats, project}) {
    if (!rules?.length) return;
    if (!globalThis.AtriumSTEP) { notes?.push?.("Component clearance needs the 3D geometry module (step-export.js)."); return; }
    const hasBends = !!globalThis.AtriumFlexFold?.hasBends?.(doc);
    const passes = [{t: 0, rules: rules.filter(r => r.fold !== "folded" || !hasBends)}];
    if (hasBends) passes.push({t: 1, rules: rules.filter(r => r.fold !== "flat")});
    const seen = new Set();
    let models = 0;
    for (const pass of passes) {
      if (!pass.rules.length) continue;
      for (const mode of [...new Set(pass.rules.map(r => r.mode === "boxes" ? "boxes" : "bodies"))]) {
        const rs = pass.rules.filter(r => (r.mode === "boxes" ? "boxes" : "bodies") === mode);
        const res = check(doc, defs, {t: pass.t, rules: rs, mode, project});
        if (stats) { stats.candidates += res.stats.pairs; stats.collision3d = {...(stats.collision3d || {}), [pass.t ? "folded" : "flat"]: res.stats}; }
        models = Math.max(models, res.stats.bodies);
        if (res.stats.unassessedComponents) notes?.push?.("Component clearance needs exact source geometry for " + res.stats.unassessedComponents + " nearby components. Their envelope contacts are unassessed.");
        for (const f of res.findings) {
          const key = f.a.id + "|" + (f.b?.id || "board");
          if (seen.has(key)) continue;
          seen.add(key);
          const st = pass.t ? " (folded)" : "", what = {collision: "Bodies collide", horizontal: "Horizontal clearance", vertical: "Vertical clearance", "3d": "3D clearance", board: "Body collides with the folded board"}[f.kind];
          flag(f.rule, {id: f.a.id, otherId: f.b?.id || f.a.id, title: f.b ? f.a.ref + " ↔ " + f.b.ref + st : f.a.ref + " ↔ board" + st, what,
            detail: what + (f.kind === "board" ? "" : st) + (f.kind === "collision" || f.kind === "board" ? "" : ": " + fmt(f.actual) + ", minimum " + fmt(f.required)) + (f.approximate ? " (convex hulls)" : "") +
              (f.kind === "horizontal" && f.vertical > EPS ? "; vertical gap " + fmt(f.vertical) : ""),
            actual: f.actual, required: f.required, limit: "min", at: f.at, otherAt: f.otherAt, at3d: f.at3d, otherAt3d: f.otherAt3d, folded: !!pass.t});
        }
      }
    }
    if (!models) notes?.push?.("Component clearance: no component bodies to check.");
  }
  return Object.freeze({bodies, check, drc, gjk, hull, polyDist, pairs});
})();
