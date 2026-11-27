"use strict";
// An independent reference for the polygon pour overlay (app/pcb/polygon-pour.js PourCore, and its
// Rust/WebAssembly port engine/src/pour.rs). Tests only: slow and simple, sharing no code with
// the core. tests/pcb/pour-fuzz.cjs checks every solved task against it.
//
// The core snaps crossings to the integer grid, so its copper differs from the exact boolean by
// up to a grid unit (10 nm at full resolution). The reference measures that difference instead of
// copying the snapping:
//   * slabs: the plane is cut at every vertex and crossing x of the input and output edges (exact
//     crossings, in doubles); inside a slab no edges cross, so the edges spanning it are sorted by
//     height and swept upward, accumulating each class's winding number and the output's. Every
//     trapezoid where the pour predicate of the windings and the output disagree is a piece of the
//     XOR. Its area is summed, and its deviation is measured: how far it reaches from the exact
//     boundary (the largest distance from its corners and centre to an input edge). Snapping
//     moves an edge by at most 0.71 units, so no misplaced copper lies further than that;
//   * the output's own winding is 0 or 1 everywhere (islands never overlap themselves or each other);
//   * probes: points farther than `margin` from every input edge are classified by brute-force
//     winding numbers and must match the output;
//   * the rings are valid: outers counter-clockwise, holes clockwise, no two edges cross or overlap,
//     every hole inside its island's outer ring and assigned to the smallest outer containing it;
//   * keep(): links (anchors an island touches, closed sets, brute force), dead copper, minimum
//     area (exact BigInt area) and minimum size, from the unfiltered islands.
globalThis.AtriumPourReference = (() => {
  // Edges of rings: {x1, y1, x2, y2, c (class), w (winding change crossing upward)}.
  function edgesOf(shapes) {
    const out = [];
    for (const s of shapes) {
      const r = s.ring, n = r.length >> 1;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, x1 = r[2 * i], y1 = r[2 * i + 1], x2 = r[2 * j], y2 = r[2 * j + 1];
        if (x1 === x2 && y1 === y2) continue;
        out.push({x1, y1, x2, y2, c: s.cls, s: s.sign, w: x2 > x1 ? s.sign : x2 < x1 ? -s.sign : 0});
      }
    }
    return out;
  }
  function outputEdges(islands) {
    const out = [];
    for (const isl of islands) for (const r of [isl.ring, ...isl.holes.map(h => h.ring)]) {
      const n = r.length >> 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, x1 = r[2 * i], y1 = r[2 * i + 1], x2 = r[2 * j], y2 = r[2 * j + 1];
        if (x1 === x2 && y1 === y2) continue;
        out.push({x1, y1, x2, y2, c: -1, s: 1, w: x2 > x1 ? 1 : x2 < x1 ? -1 : 0});
      }
    }
    return out;
  }
  // Windings of every class at (px, py) by the crossing rule (half-open in y).
  function windingAt(edges, K, px, py) {
    const W = new Int32Array(K);
    for (const e of edges) {
      const up = e.y1 <= py && py < e.y2, down = e.y2 <= py && py < e.y1;
      if (!up && !down) continue;
      const cr = (e.x2 - e.x1) * (py - e.y1) - (e.y2 - e.y1) * (px - e.x1);
      if (up && cr > 0) W[e.c] += e.s; else if (down && cr < 0) W[e.c] -= e.s;
    }
    return W;
  }
  function outputWinding(oedges, px, py) {
    let w = 0;
    for (const e of oedges) {
      const up = e.y1 <= py && py < e.y2, down = e.y2 <= py && py < e.y1;
      if (!up && !down) continue;
      const cr = (e.x2 - e.x1) * (py - e.y1) - (e.y2 - e.y1) * (px - e.x1);
      if (up && cr > 0) w++; else if (down && cr < 0) w--;
    }
    return w;
  }
  function segDist(e, px, py) {
    const vx = e.x2 - e.x1, vy = e.y2 - e.y1, l = vx * vx + vy * vy;
    let t = l ? ((px - e.x1) * vx + (py - e.y1) * vy) / l : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - e.x1 - t * vx, py - e.y1 - t * vy);
  }
  const nearest = (edges, px, py) => { let d = Infinity; for (const e of edges) { const v = segDist(e, px, py); if (v < d) d = v; } return d; };
  // Pairs of edges whose x ranges overlap (sort and sweep), visited once.
  function pairs(edges, visit) {
    const order = edges.map((e, i) => i).sort((a, b) => Math.min(edges[a].x1, edges[a].x2) - Math.min(edges[b].x1, edges[b].x2));
    const active = [];
    for (const i of order) {
      const e = edges[i], lo = Math.min(e.x1, e.x2);
      for (let k = active.length - 1; k >= 0; k--) if (Math.max(edges[active[k]].x1, edges[active[k]].x2) < lo) active.splice(k, 1);
      for (const j of active) {
        const f = edges[j];
        if (Math.max(e.y1, e.y2) < Math.min(f.y1, f.y2) || Math.min(e.y1, e.y2) > Math.max(f.y1, f.y2)) continue;
        visit(e, f);
      }
      active.push(i);
    }
  }
  const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  // The crossing x of two segments, when they cross at a point inside both (else NaN).
  function crossX(e, f) {
    const d1 = orient(e.x1, e.y1, e.x2, e.y2, f.x1, f.y1), d2 = orient(e.x1, e.y1, e.x2, e.y2, f.x2, f.y2);
    if ((d1 > 0 && d2 > 0) || (d1 < 0 && d2 < 0) || d1 === d2) return NaN;
    const d3 = orient(f.x1, f.y1, f.x2, f.y2, e.x1, e.y1), d4 = orient(f.x1, f.y1, f.x2, f.y2, e.x2, e.y2);
    if ((d3 > 0 && d4 > 0) || (d3 < 0 && d4 < 0) || d3 === d4) return NaN;
    return e.x1 + d3 / (d3 - d4) * (e.x2 - e.x1);
  }

  // The XOR of the predicate's region and the output, by slabs. Returns {area, maxDev, worst,
  // overlap (largest |output winding| beyond 1, by area), pieces}.
  // extraOnly: count only output copper where the predicate is false (output ⊆ predicate region).
  function xor(inEdges, outEdges, K, inside, extraOnly = false) {
    const all = inEdges.concat(outEdges), xs = [];
    for (const e of all) xs.push(e.x1, e.x2);
    pairs(all, (e, f) => { const x = crossX(e, f); if (x === x) xs.push(x); });
    xs.sort((a, b) => a - b);
    const ev = [];
    for (const x of xs) if (!ev.length || x - ev[ev.length - 1] > 1e-7) ev.push(x);
    const order = all.filter(e => e.x1 !== e.x2).sort((a, b) => Math.min(a.x1, a.x2) - Math.min(b.x1, b.x2));
    let at = 0, active = [], area = 0, maxDev = 0, worst = null, overlap = 0, pieces = 0;
    const W = new Int32Array(K);
    for (let s = 0; s + 1 < ev.length; s++) {
      const xa = ev[s], xb = ev[s + 1], xm = (xa + xb) / 2;
      while (at < order.length && Math.min(order[at].x1, order[at].x2) < xm) active.push(order[at++]);
      active = active.filter(e => Math.max(e.x1, e.x2) > xm);
      if (!active.length) continue;
      const rows = active.map(e => {
        const k = (e.y2 - e.y1) / (e.x2 - e.x1), y = x => e.y1 + (x - e.x1) * k;
        return {e, ya: y(xa), ym: y(xm), yb: y(xb)};
      }).sort((a, b) => a.ym - b.ym);
      W.fill(0);
      let wo = 0;
      for (let i = 0; i + 1 < rows.length; i++) {
        const r = rows[i], q = rows[i + 1];
        if (r.e.c >= 0) W[r.e.c] += r.e.w; else wo += r.e.w;
        const hm = q.ym - r.ym;
        if (!(hm > 1e-9)) continue;
        const a = (xb - xa) * ((q.ya - r.ya) + (q.yb - r.yb)) / 2;
        if (wo !== 0 && wo !== 1 && a > 1e-6) overlap += a;
        if (inside(W) === (wo === 1) || extraOnly && wo !== 1) continue;
        area += a; pieces++;
        // How far the misplaced copper (or gap) reaches from the exact boundary: the trapezoid's
        // corners and centre, measured to the nearest input edge.
        const cy = (r.ym + q.ym) / 2;
        for (const [px, py] of [[xm, cy], [xa, r.ya], [xa, q.ya], [xb, r.yb], [xb, q.yb]]) {
          const dev = nearest(inEdges, px, py);
          if (dev > maxDev) { maxDev = dev; worst = [px, py]; }
        }
      }
    }
    return {area, maxDev, worst, overlap, pieces};
  }

  const area2 = r => { let s = 0; const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) s += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1]; return s; };
  function bigArea2(r) {
    let s = 0n; const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) s += BigInt(r[2 * j]) * BigInt(r[2 * i + 1]) - BigInt(r[2 * i]) * BigInt(r[2 * j + 1]);
    return s;
  }
  // Even-odd point in ring: 1 inside, 0 on the boundary, -1 outside (exact for integers).
  function inRing(px, py, r) {
    let c = false; const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const x1 = r[2 * j], y1 = r[2 * j + 1], x2 = r[2 * i], y2 = r[2 * i + 1];
      const cr = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
      if (cr === 0 && px >= Math.min(x1, x2) && px <= Math.max(x1, x2) && py >= Math.min(y1, y2) && py <= Math.max(y1, y2)) return 0;
      if ((y1 > py) !== (y2 > py) && (cr > 0) === (y2 > y1)) c = !c;
    }
    return c ? 1 : -1;
  }
  // Ring validity: orientation, no crossing or overlapping edges, holes inside their island.
  function validity(islands) {
    const errors = [], edges = [];
    islands.forEach((isl, k) => {
      if (!(area2(isl.ring) > 0)) errors.push("island " + k + ": outer ring not counter-clockwise");
      if (isl.ring.length < 6 || isl.tags && isl.tags.length !== isl.ring.length / 2) errors.push("island " + k + ": ring or tags malformed");
      isl.holes.forEach((h, j) => {
        if (!(area2(h.ring) < 0)) errors.push("island " + k + " hole " + j + ": not clockwise");
        for (let i = 0; i < h.ring.length; i += 2) if (inRing(h.ring[i], h.ring[i + 1], isl.ring) < 0) { errors.push("island " + k + " hole " + j + ": outside its outer ring"); break; }
      });
      for (const [ring, tag] of [[isl.ring, "i" + k], ...isl.holes.map((h, j) => [h.ring, "i" + k + "h" + j])]) {
        const n = ring.length >> 1;
        for (let i = 0; i < n; i++) { const j = (i + 1) % n; edges.push({x1: ring[2 * i], y1: ring[2 * i + 1], x2: ring[2 * j], y2: ring[2 * j + 1], tag}); }
      }
    });
    let bad = 0;
    pairs(edges, (e, f) => {
      if (bad > 3) return;
      const d1 = orient(e.x1, e.y1, e.x2, e.y2, f.x1, f.y1), d2 = orient(e.x1, e.y1, e.x2, e.y2, f.x2, f.y2);
      const d3 = orient(f.x1, f.y1, f.x2, f.y2, e.x1, e.y1), d4 = orient(f.x1, f.y1, f.x2, f.y2, e.x2, e.y2);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) { bad++; errors.push("edges cross: " + e.tag + " " + f.tag + " near " + e.x1 + "," + e.y1); return; }
      if (d1 === 0 && d2 === 0) {
        // Collinear: overlapping by a positive length?
        const ax = e.x2 - e.x1, ay = e.y2 - e.y1, l = ax * ax + ay * ay;
        const t1 = ((f.x1 - e.x1) * ax + (f.y1 - e.y1) * ay) / l, t2 = ((f.x2 - e.x1) * ax + (f.y2 - e.y1) * ay) / l;
        if (Math.min(1, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)) > 1e-12) { bad++; errors.push("edges overlap: " + e.tag + " " + f.tag + " near " + e.x1 + "," + e.y1); }
      }
    });
    // Each hole belongs to the smallest outer ring (larger than the hole) that contains every
    // vertex and edge midpoint of the hole, closed.
    islands.forEach((isl, k) => isl.holes.forEach((h, j) => {
      const r = h.ring, n = r.length >> 1, ha = -area2(r), pts = [];
      for (let i = 0; i < n; i++) { const q = (i + 1) % n; pts.push(r[2 * i], r[2 * i + 1], (r[2 * i] + r[2 * q]) / 2, (r[2 * i + 1] + r[2 * q + 1]) / 2); }
      let owner = -1, oa = Infinity;
      islands.forEach((o, m) => {
        const a = area2(o.ring);
        if (a <= ha || a >= oa) return;
        for (let i = 0; i < pts.length; i += 2) if (inRing(pts[i], pts[i + 1], o.ring) < 0) return;
        oa = a; owner = m;
      });
      if (owner !== k) errors.push("island " + k + " hole " + j + ": belongs to island " + owner);
    }));
    return errors;
  }
  // Closed-set contact of anchor ring a with an island (brute force, no boxes).
  function touches(a, isl) {
    const inIsl = (x, y) => {
      const o = inRing(x, y, isl.ring); if (o < 0) return false; if (o === 0) return true;
      for (const h of isl.holes) if (inRing(x, y, h.ring) > 0) return false;
      return true;
    };
    for (let i = 0; i < a.length; i += 2) if (inIsl(a[i], a[i + 1])) return true;
    if (inRing(isl.ring[0], isl.ring[1], a) >= 0) return true;
    const on = (px, py, qx, qy, rx, ry) => rx >= Math.min(px, qx) && rx <= Math.max(px, qx) && ry >= Math.min(py, qy) && ry <= Math.max(py, qy);
    const n = a.length >> 1;
    for (const r of [isl.ring, ...isl.holes.map(h => h.ring)]) {
      const m = r.length >> 1;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m, ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * j], by = r[2 * j + 1];
        for (let k = 0; k < n; k++) {
          const l = (k + 1) % n, cx = a[2 * k], cy = a[2 * k + 1], dx = a[2 * l], dy = a[2 * l + 1];
          const d1 = orient(ax, ay, bx, by, cx, cy), d2 = orient(ax, ay, bx, by, dx, dy), d3 = orient(cx, cy, dx, dy, ax, ay), d4 = orient(cx, cy, dx, dy, bx, by);
          if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
          if ((d1 === 0 && on(ax, ay, bx, by, cx, cy)) || (d2 === 0 && on(ax, ay, bx, by, dx, dy)) || (d3 === 0 && on(cx, cy, dx, dy, ax, ay)) || (d4 === 0 && on(cx, cy, dx, dy, bx, by))) return true;
        }
      }
    }
    return false;
  }
  // The islands keep() should return from the unfiltered ones, with their links.
  function kept(base, task) {
    const out = [];
    for (const isl of base) {
      const links = []; task.anchors.forEach((a, k) => { if (touches(a, isl)) links.push(k); });
      if (task.removeDead && !links.length) continue;
      let a2 = bigArea2(isl.ring); for (const h of isl.holes) a2 += bigArea2(h.ring);
      const area = Number(a2) / 2;
      if (task.minArea > 0 && area < task.minArea) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < isl.ring.length; i += 2) { const x = isl.ring[i], y = isl.ring[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 - x0 < task.minSize && y1 - y0 < task.minSize) continue;
      out.push({...isl, links});
    }
    return out;
  }
  // The pour predicate (classes: 0 polygon, 1 board, 2 obstacle, 3 relief annulus, 4 spoke, 5 same-net clearance a spoke crosses, 6.. earlier pours).
  const pourPredicate = (K, hasBoard) => w => {
    if (w[0] === 0 || (hasBoard && w[1] === 0) || w[2] > 0) return false;
    for (let c = 6; c < K; c++) if (w[c] > 0) return false;
    return w[4] !== 0 || (w[3] === 0 && w[5] === 0);
  };

  // Every check on one solved task. solved: {islands} (any order); base: the solution of the same
  // task without keep()'s filters (null: task already unfiltered). Returns {errors, xorArea, maxDev,
  // probes, perimeter}.
  function check(task, solved, base, options = {}) {
    const tol = options.tol ?? 1, margin = options.margin ?? 1.5, probes = options.probes ?? 200;
    const K = task.K, inside = pourPredicate(K, task.hasBoard), errors = [];
    const inEdges = edgesOf(task.shapes), unfiltered = base ? base.islands || base : solved.islands, outEdges = outputEdges(unfiltered);
    errors.push(...validity(solved.islands));
    if (base) errors.push(...validity(base.islands || base).map(e => "unfiltered: " + e));
    const X = xor(inEdges, outEdges, K, inside);
    let perimeter = 0; for (const e of inEdges.concat(outEdges)) perimeter += Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    if (X.overlap > 0) errors.push("output overlaps itself over " + X.overlap.toFixed(3) + " units²");
    if (X.maxDev > tol) errors.push("deviation " + X.maxDev.toFixed(3) + " units near " + X.worst.map(v => v.toFixed(1)) + " (tolerance " + tol + ")");
    if (X.area > tol * Math.max(1, perimeter)) errors.push("XOR area " + X.area.toFixed(1) + " > tolerance × perimeter " + perimeter.toFixed(1));
    // Probes far from every input edge.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of inEdges) { x0 = Math.min(x0, e.x1, e.x2); x1 = Math.max(x1, e.x1, e.x2); y0 = Math.min(y0, e.y1, e.y2); y1 = Math.max(y1, e.y1, e.y2); }
    let seed = options.seed ?? 1, probed = 0;
    const rnd = () => { seed = (Math.imul(seed, 48271) + 11) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < probes && inEdges.length && errors.length < 8; k++) {
      // Half the probes near a vertex, where the degenerate cases live.
      let px, py;
      if (k & 1) { const e = inEdges[Math.floor(rnd() * inEdges.length)], r = margin * (1 + 4 * rnd()), a = rnd() * 6.2832; px = e.x1 + r * Math.cos(a); py = e.y1 + r * Math.sin(a); }
      else { px = x0 + (x1 - x0) * rnd(); py = y0 + (y1 - y0) * rnd(); }
      if (nearest(inEdges, px, py) <= margin) continue;
      probed++;
      const want = inside(windingAt(inEdges, K, px, py)), got = outputWinding(outEdges, px, py);
      if (want !== (got === 1)) errors.push("probe " + px.toFixed(2) + "," + py.toFixed(2) + ": predicate " + want + ", output winding " + got);
    }
    if (base) {
      const want = kept(base.islands || base, task), key = isl => Array.from(isl.ring).join(",") + "|" + isl.holes.map(h => Array.from(h.ring).join(",")).sort().join("/");
      const got = new Map(solved.islands.map(isl => [key(isl), isl]));
      if (want.length !== solved.islands.length) errors.push("keep(): " + solved.islands.length + " islands, reference " + want.length);
      for (const w of want) {
        const g = got.get(key(w));
        if (!g) { errors.push("keep(): an island the reference keeps is missing"); break; }
        if (JSON.stringify(Array.from(g.links)) !== JSON.stringify(w.links)) { errors.push("keep(): links " + JSON.stringify(Array.from(g.links)) + ", reference " + JSON.stringify(w.links)); break; }
      }
    }
    return {errors, xorArea: X.area, maxDev: X.maxDev, pieces: X.pieces, probes: probed, perimeter};
  }
  // ---- Remove Necks and Outlines Only (task.morph): the shaped copper M against the unshaped
  // copper P of the same task (both unfiltered), with the template T (task.morph.t):
  //   * M is valid and lies inside P (slabs: no M copper outside P beyond the snapping tolerance), so
  //     it never comes nearer anything P clears;
  //   * opening (mode 1): every probe p of P covered by a placement x + T inside P (x = p - s for
  //     sample points s of T, containment tested exactly against P's rings), or by a keep ring, and
  //     farther than `margin` from M's boundary, is copper of M: nothing wider than T is removed.
  //     Points of P deeper than T's circumradius are always covered (T fits around them);
  //   * outline band (mode 2): probes of P within T's inradius of P's boundary are copper of M; probes
  //     deeper than its circumradius (and outside the keep rings) are not.
  function checkMorph(task, P, M, options = {}) {
    const m = task.morph, T = m.t, tol = options.tol ?? 1, margin = options.margin ?? 2, probes = options.probes ?? 150, errors = [];
    errors.push(...validity(M.islands || M).map(e => "shaped: " + e));
    const pE = outputEdges(P.islands || P).map(e => ({...e, c: 0})), mE = outputEdges(M.islands || M);
    const X = xor(pE, mE, 1, w => w[0] === 1, true);
    let perimeter = 0; for (const e of pE.concat(mE)) perimeter += Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    if (X.area > tol * Math.max(1, perimeter) || X.maxDev > tol * 1.5) errors.push("shaped copper outside the unshaped copper: area " + X.area.toFixed(2) + ", reaching " + X.maxDev.toFixed(2) + " units");
    if (!pE.length) return {errors, probes: 0};
    let R = 0, r = Infinity;
    for (let i = 0; i < T.length; i += 2) R = Math.max(R, Math.hypot(T[i], T[i + 1]));
    const tE = edgesOf([{cls: 0, sign: 1, ring: T}]);
    for (const e of tE) { const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1); r = Math.min(r, Math.abs(e.x1 * e.y2 - e.x2 * e.y1) / L); }
    const inP = (x, y) => outputWinding(pE, x, y) === 1, inM = (x, y) => outputWinding(mE, x, y) === 1;
    const keepE = (m.keep || []).map(ring => edgesOf([{cls: 0, sign: 1, ring}]));
    const inKeep = (x, y) => keepE.some(E => windingAt(E, 1, x, y)[0] > 0);
    // x + T inside P: its vertices in P, no P edge crossing or touching its edges, no P vertex inside it.
    // With slack: T grown by `margin` units must fit, so the placement is not a single tangent point
    // (the core's erosion is a closed-set difference snapped to the grid).
    const grow = 1 + margin / r;
    const fits = (x, y) => {
      const ring = []; for (let i = 0; i < T.length; i += 2) ring.push(x + T[i] * grow, y + T[i + 1] * grow);
      for (let i = 0; i < ring.length; i += 2) if (!inP(ring[i], ring[i + 1])) return false;
      const n = ring.length >> 1;
      for (const e of pE) {
        if (inRingF(e.x1, e.y1, ring)) return false;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, ax = ring[2 * i], ay = ring[2 * i + 1], bx = ring[2 * j], by = ring[2 * j + 1];
          const d1 = orient(ax, ay, bx, by, e.x1, e.y1), d2 = orient(ax, ay, bx, by, e.x2, e.y2), d3 = orient(e.x1, e.y1, e.x2, e.y2, ax, ay), d4 = orient(e.x1, e.y1, e.x2, e.y2, bx, by);
          if ((d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0) && d1 && d2 && d3 && d4) return false;
        }
      }
      return true;
    };
    function inRingF(px, py, r) { // strictly inside a convex CCW ring
      const n = r.length >> 1;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (orient(r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1], px, py) <= 0) return false; }
      return true;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of pE) { x0 = Math.min(x0, e.x1, e.x2); x1 = Math.max(x1, e.x1, e.x2); y0 = Math.min(y0, e.y1, e.y2); y1 = Math.max(y1, e.y1, e.y2); }
    let seed = options.seed ?? 7, probed = 0;
    const rnd = () => { seed = (Math.imul(seed, 48271) + 11) >>> 0; return seed / 4294967296; };
    const samples = [[0, 0]];
    for (let k = 0; k < T.length; k += 2) for (const f of [.25, .5, .75, .97]) samples.push([T[k] * f, T[k + 1] * f]);
    for (let k = 0; k < probes && errors.length < 6; k++) {
      let px, py;
      if (k & 1) { const e = pE[Math.floor(rnd() * pE.length)], d = R * 2 * rnd(), a = rnd() * 6.2832; px = e.x1 + d * Math.cos(a); py = e.y1 + d * Math.sin(a); }
      else { px = x0 + (x1 - x0) * rnd(); py = y0 + (y1 - y0) * rnd(); }
      if (!inP(px, py) || nearest(pE, px, py) <= margin || nearest(mE, px, py) <= margin || keepE.some(E => nearest(E, px, py) <= margin)) continue;
      probed++;
      const got = inM(px, py), depth = nearest(pE, px, py), keep = inKeep(px, py);
      if (m.mode === 2) {
        if (depth < r - margin && !got) errors.push("band: probe " + px.toFixed(1) + "," + py.toFixed(1) + " at depth " + depth.toFixed(1) + " < " + r.toFixed(1) + " is not copper");
        if (depth > R + margin && got && !keep) errors.push("band: probe " + px.toFixed(1) + "," + py.toFixed(1) + " at depth " + depth.toFixed(1) + " > " + R.toFixed(1) + " is copper");
        continue;
      }
      if (got) continue;
      if (keep) { errors.push("opening: probe " + px.toFixed(1) + "," + py.toFixed(1) + " in a keep ring was removed"); continue; }
      if (depth > R + margin) { errors.push("opening: probe " + px.toFixed(1) + "," + py.toFixed(1) + " at depth " + depth.toFixed(1) + " (T fits around it) was removed"); continue; }
      for (const [sx, sy] of samples) if (fits(px - sx, py - sy)) { errors.push("opening: probe " + px.toFixed(1) + "," + py.toFixed(1) + " lies in a placement of T inside the copper but was removed"); break; }
    }
    return {errors, probes: probed, outside: X.area};
  }
  return {check, checkMorph, xor, validity, kept, touches, edgesOf, outputEdges, windingAt, pourPredicate, inRing};
})();
