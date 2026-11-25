"use strict";
if (!globalThis.AtriumResolvedLand && typeof require === "function") require("./pcb-appearance.js");

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("./resolved-geometry-curves.js");
// Autorouter: a multi-layer fine-grid router with negotiated-congestion rip-up
// and reroute (PathFinder), short-connection, completion, straighten, 45° recorner
// and exact clearance verification passes. Altium's Situs is the model.
//
// The routing core (AtriumRouteCore) and its geometry are serialised into a
// Blob Worker without a build step, even from file://.
// The main thread turns the board into a plain job (obstacles, nets, terminals)
// and turns the result into one edit plan {add, remove} for a single ctx.edit.
//
// Grid model. Pitch g = (w0 + c0) / k for the dominant track width w0 and
// clearance c0 (k = 2 by default). Every routed object "repels" the cells within
// w/2 + w0/2 + c of its copper; a default-class track centre may only sit on a
// cell no foreign object repels, which with R = 2g is exact for 8-direction grid
// paths. Static copper is rasterised once with an analytic discretisation margin,
// vias use a second exact 2D map, and wide nets and pad stubs are checked against
// exact geometry. The final pass checks every new object exactly.
function AtriumRouteCore(geometry = globalThis.AtriumGeometry) {
  const SQ2 = Math.SQRT2, INF = Infinity;
  const now = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

  // ------------------------------------------------------------------ geometry
  // Shapes are rounded cores: {k, c, r}. k 0 point, 1 segment, 2 convex polygon,
  // 3 filled simple polygon; c is a flat coordinate array; r grows the core.
  const {pointSegmentDistanceSquared: ptSeg2, segmentDistanceSquared: segSeg2, inFlatRing: inside} = geometry;
  // Distance between the cores of two shapes (0 when they overlap).
  function coreDist(A, B) {
    const ca = A.c, cb = B.c;
    if (A.k >= 2 && inside(cb[0], cb[1], ca)) return 0;
    if (B.k >= 2 && inside(ca[0], ca[1], cb)) return 0;
    const na = ca.length >> 1, nb = cb.length >> 1, ea = A.k >= 2 ? na : Math.max(1, na - 1), eb = B.k >= 2 ? nb : Math.max(1, nb - 1);
    let best = INF;
    for (let i = 0; i < ea; i++) {
      const i2 = na === 1 ? 0 : (i + 1) % na, ax = ca[2 * i], ay = ca[2 * i + 1], bx = ca[2 * i2], by = ca[2 * i2 + 1];
      for (let j = 0; j < eb; j++) {
        const j2 = nb === 1 ? 0 : (j + 1) % nb;
        const d = segSeg2(ax, ay, bx, by, cb[2 * j], cb[2 * j + 1], cb[2 * j2], cb[2 * j2 + 1]);
        if (d < best) { best = d; if (d === 0) return 0; }
      }
    }
    return Math.sqrt(best);
  }
  const shapeDist = (A, B) => coreDist(A, B) - A.r - B.r;
  function ptCore(px, py, S) {
    const c = S.c, n = c.length >> 1;
    if (n === 1) return Math.hypot(px - c[0], py - c[1]);
    if (S.k >= 2 && inside(px, py, c)) return 0;
    let best = INF;
    const e = S.k >= 2 ? n : n - 1;
    for (let i = 0; i < e; i++) {
      const j = (i + 1) % n, d = ptSeg2(px, py, c[2 * i], c[2 * i + 1], c[2 * j], c[2 * j + 1]);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
  function box(S) {
    const c = S.c;
    let x0 = INF, y0 = INF, x1 = -INF, y1 = -INF;
    for (let i = 0; i < c.length; i += 2) { const x = c[i], y = c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0 - S.r, y0 - S.r, x1 + S.r, y1 + S.r];
  }

  // Bucket index of shapes for exact queries. Records may be removed.
  function bucketIndex(x0, y0, x1, y1, size) {
    const nx = Math.max(1, Math.ceil((x1 - x0) / size) + 1), ny = Math.max(1, Math.ceil((y1 - y0) / size) + 1);
    const cells = new Array(nx * ny);
    const all = [];
    let mark = new Uint32Array(64), stamp = 0;
    const range = (b, m) => [Math.max(0, Math.floor((b[0] - m - x0) / size)), Math.max(0, Math.floor((b[1] - m - y0) / size)),
      Math.min(nx - 1, Math.floor((b[2] + m - x0) / size)), Math.min(ny - 1, Math.floor((b[3] + m - y0) / size))];
    function add(rec) {
      rec.id = all.length; rec.bb = rec.bb || box(rec); rec.alive = true; all.push(rec);
      if (mark.length < all.length) { const m = new Uint32Array(all.length * 2); m.set(mark); mark = m; }
      const r = range(rec.bb, 0);
      for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) { const k = y * nx + x; (cells[k] || (cells[k] = [])).push(rec); }
      return rec;
    }
    function remove(rec) {
      if (!rec.alive) return;
      rec.alive = false;
      const r = range(rec.bb, 0);
      for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
        const list = cells[y * nx + x]; if (!list) continue;
        const i = list.indexOf(rec); if (i >= 0) { list[i] = list[list.length - 1]; list.pop(); }
      }
    }
    // Calls fn(rec) once for each live record whose box meets b grown by m; stops when fn returns true.
    function query(b, m, fn) {
      stamp++;
      if (stamp === 0xffffffff) { mark.fill(0); stamp = 1; }
      const r = range(b, m);
      for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
        const list = cells[y * nx + x]; if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const rec = list[i]; if (mark[rec.id] === stamp) continue; mark[rec.id] = stamp;
          const q = rec.bb;
          if (q[0] > b[2] + m || q[2] < b[0] - m || q[1] > b[3] + m || q[3] < b[1] - m) continue;
          if (fn(rec)) return true;
        }
      }
      return false;
    }
    return {add, remove, query, all};
  }

  // ------------------------------------------------------------------ heap
  function heap() {
    let keys = new Float64Array(1024), vals = new Int32Array(1024), n = 0;
    return {
      get size() { return n; },
      clear() { n = 0; },
      push(k, v) {
        if (n === keys.length) { const k2 = new Float64Array(n * 2), v2 = new Int32Array(n * 2); k2.set(keys); v2.set(vals); keys = k2; vals = v2; }
        let i = n++;
        while (i > 0) { const p = (i - 1) >> 1; if (keys[p] <= k) break; keys[i] = keys[p]; vals[i] = vals[p]; i = p; }
        keys[i] = k; vals[i] = v;
      },
      topKey() { return keys[0]; },
      pop() {
        const top = vals[0]; n--;
        if (n > 0) {
          const k = keys[n], v = vals[n]; let i = 0;
          for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && keys[c + 1] < keys[c]) c++; if (keys[c] >= k) break; keys[i] = keys[c]; vals[i] = vals[c]; i = c; }
          keys[i] = k; vals[i] = v;
        }
        return top;
      },
      free() { keys = vals = null; }
    };
  }

  // ------------------------------------------------------------------ router
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  function dirOf(dx, dy) { for (let d = 0; d < 8; d++) if (DX[d] === Math.sign(dx) && DY[d] === Math.sign(dy)) return d; return -1; }

  function* route(job) {
    const T0 = now(), opt = job.options || {};
    const L = job.layers.length, nets = job.nets, NN = nets.length;
    const stats = {expansions: 0, searches: 0, passes: [], iterations: 0};
    // With opt.live, each progress event carries the nets whose copper changed since the last
    // one ({net, segs:[[layer, x0, y0, x1, y1]], vias:[[x, y]]}; empty when ripped up), so a
    // view can draw routes as they land.
    const liveDirty = opt.live ? new Set() : null;
    const liveDelta = () => {
      if (!liveDirty || !liveDirty.size) return undefined;
      const out = [];
      for (const rec of liveDirty) out.push({net: rec.n, segs: rec.marked ? rec.segs.map(s => [s.l, s.a[0], s.a[1], s.b[0], s.b[1]]) : [], vias: rec.marked ? rec.vias.map(v => [v.x, v.y]) : []});
      liveDirty.clear();
      return out;
    };
    const progress = (phase, extra) => ({type: "progress", phase, elapsed: now() - T0, ...extra, landed: liveDelta()});
    yield progress("Preparing grid", {fraction: 0});

    // Dominant class.
    const routed = new Set(job.conns.map(c => c.net));
    const freq = new Map();
    for (const n of routed) { const k = nets[n].w.toFixed(4) + "/" + nets[n].c.toFixed(4); freq.set(k, (freq.get(k) || 0) + 1); }
    let w0 = 0.2, c0 = 0.2, best = -1;
    for (const [k, v] of freq) if (v > best) { best = v; [w0, c0] = k.split("/").map(Number); }
    if (!routed.size) { w0 = job.defaultWidth || 0.2; c0 = job.defaultClearance || 0.2; }
    const kdiv = opt.gridDiv || 2;
    let g = (w0 + c0) / kdiv;
    const [bx0, by0, bx1, by1] = job.bounds;
    const maxNodes = opt.maxNodes || 6e6;
    while (Math.ceil((bx1 - bx0) / g + 3) * Math.ceil((by1 - by0) / g + 3) * L > maxNodes) g *= 1.25;
    const W = Math.ceil((bx1 - bx0) / g) + 3, H = Math.ceil((by1 - by0) / g) + 3, N2 = W * H, NL = N2 * L;
    const ox = bx0 - g, oy = by0 - g;
    const X = i => ox + (i % W) * g, Y = i => oy + ((i % N2) / W | 0) * g;
    const layerOf = n => (n / N2) | 0;

    // Group ids: a differential pair shares one group on the grid.
    const group = new Int32Array(NN);
    for (let i = 0; i < NN; i++) group[i] = nets[i].group || i;

    // About 12 bytes per node: owner (2 or 4), repel (1), history (2), cost (4), arrival (1), stamp (2).
    // The arrival byte replaces a parent array: 0-7 planar direction, 8 + layer for a via, 255 for a source.
    const Owner = NN < 32000 ? Int16Array : Int32Array;
    const blk = new Owner(NL), vblk = new Owner(N2), repel = new Uint8Array(NL), vrep = new Uint8Array(N2);
    const hist = new Uint16Array(NL), gcost = new Float32Array(NL), dirs = new Uint8Array(NL);
    const HQ = 0.05, histAdd = (k, v) => { const q = hist[k] + Math.round(v / HQ); hist[k] = q > 65535 ? 65535 : q; };
    const stamp = new Uint16Array(NL), stamp2 = new Uint16Array(N2);
    let ctr = 2;
    const nextStamp = () => { ctr += 2; if (ctr > 0xfff0) { stamp.fill(0); stamp2.fill(0); ctr = 2; } return ctr; };
    const mergeOwner = (cur, v) => cur === 0 ? v : cur === v ? cur : -1;

    // Frame cells are always blocked so neighbour arithmetic never wraps.
    for (let l = 0; l < L; l++) for (let x = 0; x < W; x++) { blk[l * N2 + x] = -1; blk[l * N2 + (H - 1) * W + x] = -1; }
    for (let l = 0; l < L; l++) for (let y = 0; y < H; y++) { blk[l * N2 + y * W] = -1; blk[l * N2 + y * W + W - 1] = -1; }
    for (let x = 0; x < W; x++) { vblk[x] = -1; vblk[(H - 1) * W + x] = -1; }
    for (let y = 0; y < H; y++) { vblk[y * W] = -1; vblk[y * W + W - 1] = -1; }

    // Smallest radius at least R for which the 8-direction grid test is exact
    // against point features on cell centres (see header).
    function snapR(R) {
      for (let a = 1; a < 200; a++) {
        const lo = (2 * a - 1) / SQ2 * g, hi = Math.hypot(a, a - 1) * g;
        if (lo > R) break;
        if (R > lo + 1e-9 && R <= hi) return hi + 1e-9;
      }
      return R;
    }
    const staticMargin = T => Math.sqrt(T * T + g * g / 2) - T;

    // Iterate grid cells whose centre lies within R of shape S: fn(index2D, distance).
    function cellsNear(S, R, fn) {
      const b = S.bb || box(S);
      const x0 = Math.max(0, Math.floor((b[0] - R - ox) / g)), x1 = Math.min(W - 1, Math.ceil((b[2] + R - ox) / g));
      const y0 = Math.max(0, Math.floor((b[1] - R - oy) / g)), y1 = Math.min(H - 1, Math.ceil((b[3] + R - oy) / g));
      for (let y = y0; y <= y1; y++) {
        const cy = oy + y * g;
        for (let x = x0; x <= x1; x++) {
          const d = ptCore(ox + x * g, cy, S) - S.r;
          if (d < R - 1e-9) fn(y * W + x, d);
        }
      }
    }
    // Fast path for a capsule (segment of radius 0 core) used by dynamic marking.
    function cellsNearSeg(ax, ay, bx, by, R, fn) {
      const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - ox) / g)), x1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + R - ox) / g));
      const y0 = Math.max(0, Math.floor((Math.min(ay, by) - R - oy) / g)), y1 = Math.min(H - 1, Math.ceil((Math.max(ay, by) + R - oy) / g));
      const R2 = R * R - 1e-9;
      for (let y = y0; y <= y1; y++) {
        const cy = oy + y * g, row = y * W;
        for (let x = x0; x <= x1; x++) if (ptSeg2(ox + x * g, cy, ax, ay, bx, by) < R2) fn(row + x);
      }
    }

    // ---- static obstacles
    const obs = job.obstacles;
    let dmax = 0;
    for (const n of routed) dmax = Math.max(dmax, nets[n].vd);
    if (!dmax) dmax = 0.6;
    const sidx = bucketIndex(bx0 - 5, by0 - 5, bx1 + 5, by1 + 5, Math.max(1, 6 * g));
    const allLayers = (2 ** L) - 1;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      o.bb = box(o); o.oi = i;
      sidx.add(o);
      const lm = o.lm & allLayers; if (!lm) continue;
      const own = o.net > 0 ? group[o.net] : -1;
      const T = w0 / 2 + Math.max(c0, o.clr), Tm = T + staticMargin(T), Tv = dmax / 2 + Math.max(c0, o.clr);
      cellsNear(o, Math.max(Tm, Tv), (cell, d) => {
        if (o.blockTrack !== false && d < Tm - 1e-9) for (let l = 0; l < L; l++) if (lm & (1 << l)) { const k = l * N2 + cell; blk[k] = mergeOwner(blk[k], own); }
        if (o.blockVia !== false && d < Tv - 1e-9) vblk[cell] = mergeOwner(vblk[cell], own);
      });
    }
    yield progress("Preparing grid", {fraction: 0.5});
    // Board outline: outside cells and an edge band are blocked.
    const outline = job.outline && job.outline.length >= 6 ? job.outline : null;
    const edgeClr = job.edgeClearance ?? c0;
    const edges = [];
    if (outline) {
      const n = outline.length >> 1;
      for (let y = 0; y < H; y++) {
        const cy = oy + y * g, xs = [];
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = outline[2 * i], yi = outline[2 * i + 1], xj = outline[2 * j], yj = outline[2 * j + 1];
          if ((yi > cy) !== (yj > cy)) xs.push((xj - xi) * (cy - yi) / (yj - yi) + xi);
        }
        xs.sort((a, b) => a - b);
        let k = 0, inside = false;
        for (let x = 0; x < W; x++) {
          const cx = ox + x * g;
          while (k < xs.length && xs[k] <= cx) { inside = !inside; k++; }
          if (!inside) { vblk[y * W + x] = -1; for (let l = 0; l < L; l++) blk[l * N2 + y * W + x] = -1; }
        }
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, e = {k: 1, c: [outline[2 * i], outline[2 * i + 1], outline[2 * j], outline[2 * j + 1]], r: 0, net: -2, clr: edgeClr, lm: allLayers, edge: true};
        e.bb = box(e); edges.push(e); sidx.add(e);
        const T = w0 / 2 + edgeClr, Tm = T + staticMargin(T), Tv = dmax / 2 + edgeClr;
        cellsNear(e, Math.max(Tm, Tv), (cell, d) => {
          if (d < Tm - 1e-9) for (let l = 0; l < L; l++) blk[l * N2 + cell] = -1;
          if (d < Tv - 1e-9) vblk[cell] = -1;
        });
      }
    }
    // Board cutouts: cells inside are blocked and their edges keep the edge clearance.
    for (const cut of job.cutouts || []) {
      const n = cut.length >> 1;
      if (n < 3) continue;
      for (let y = 0; y < H; y++) {
        const cy = oy + y * g, xs = [];
        for (let i = 0, j = n - 1; i < n; j = i++) { const xi = cut[2 * i], yi = cut[2 * i + 1], xj = cut[2 * j], yj = cut[2 * j + 1]; if ((yi > cy) !== (yj > cy)) xs.push((xj - xi) * (cy - yi) / (yj - yi) + xi); }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil((xs[k] - ox) / g)); x < W && ox + x * g <= xs[k + 1]; x++) {
          vblk[y * W + x] = -1; for (let l = 0; l < L; l++) blk[l * N2 + y * W + x] = -1;
        }
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, e = {k: 1, c: [cut[2 * i], cut[2 * i + 1], cut[2 * j], cut[2 * j + 1]], r: 0, net: -2, clr: edgeClr, lm: allLayers, edge: true};
        e.bb = box(e); edges.push(e); sidx.add(e);
        const T = w0 / 2 + edgeClr, Tm = T + staticMargin(T), Tv = dmax / 2 + edgeClr;
        cellsNear(e, Math.max(Tm, Tv), (cell, d) => {
          if (d < Tm - 1e-9) for (let l = 0; l < L; l++) blk[l * N2 + cell] = -1;
          if (d < Tv - 1e-9) vblk[cell] = -1;
        });
      }
    }
    // Hole-to-hole clearance (all nets): no via centre within r + via hole/2 + gap of a drilled hole.
    const holeGap = job.holeGap > 0 ? job.holeGap : 0;
    let vhMax = 0;
    for (const n of routed) vhMax = Math.max(vhMax, nets[n].vh || 0);
    const holeIdx = holeGap ? bucketIndex(bx0 - 5, by0 - 5, bx1 + 5, by1 + 5, Math.max(1, 6 * g)) : null;
    if (holeGap) for (const h of job.holes || []) {
      const S = {k: 0, c: [h[0], h[1]], r: 0, hr: h[2]};
      S.bb = box(S); holeIdx.add(S);
      cellsNear(S, h[2] + vhMax / 2 + holeGap, cell => { vblk[cell] = -1; });
    }
    // Layers a net may not use are blocked for that net by the search itself.

    // ---- per-net classes
    const cls = nets.map((n, i) => {
      const R = snapR(n.w / 2 + w0 / 2 + Math.max(n.c, c0));
      const wide = n.w > w0 + 1e-9 || n.c > c0 + 1e-9;
      return {R, Rv: dmax / 2 + n.w / 2 + Math.max(n.c, c0), wide, via: snapR(n.vd / 2 + w0 / 2 + Math.max(n.c, c0)),
        vv: Math.max(n.vd / 2 + dmax / 2 + Math.max(n.c, c0), holeGap ? (n.vh || 0) / 2 + vhMax / 2 + holeGap : 0)};
    });
    const pairClr = (a, b) => Math.max(a > 0 ? nets[a].c : c0, b > 0 ? nets[b].c : c0);
    const sameGroup = (a, b) => a > 0 && b > 0 && group[a] === group[b];

    // ---- exact checks against static obstacles
    // A capsule of net n: does it keep clearance from every static obstacle of another net?
    function staticClear(n, S, layerMask, ignore) {
      const w = S.r;
      return !sidx.query(S.bb || box(S), nets[n].c + 2, o => {
        if (!(o.lm & layerMask) || o === ignore || o.blockTrack === false) return false;
        if (o.edge) return shapeDist(S, o) < o.clr - 1e-7;
        if (o.net > 0 && sameGroup(o.net, n)) return false;
        return shapeDist(S, o) < pairClr(n, o.net) - 1e-7;
      });
    }

    // ---- dynamic exact index of routed copper
    const didx = bucketIndex(bx0 - 5, by0 - 5, bx1 + 5, by1 + 5, Math.max(1, 6 * g));
    // Number of foreign nets whose routed copper violates clearance with S.
    function dynConflicts(n, S, layerMask, stopAtOne) {
      let count = 0;
      const seen = stopAtOne ? null : new Set();
      didx.query(S.bb || box(S), 1.5, o => {
        if (!(o.lm & layerMask) || sameGroup(o.net, n)) return false;
        if (shapeDist(S, o) < pairClr(n, o.net) - 1e-7) {
          if (stopAtOne) { count = 1; return true; }
          if (!seen.has(o.net)) { seen.add(o.net); count++; }
        }
        return false;
      });
      return count;
    }

    // ---- terminals and access points
    const termCache = new Map();
    function accessOne(t, n) {
      const key = t.obs + "/" + n + "/" + t.x + "," + t.y;
      if (termCache.has(key)) return termCache.get(key);
      const o = obs[t.obs], lm = (t.lm ?? (o ? o.lm : 0)) & nets[n].lm & allLayers, gid = group[n];
      const out = [];
      const reach = Math.max(2.5 * g, 1.5 * (w0 + c0));
      const base = o && t.pad ? o : {k: 0, c: [t.x, t.y], r: 0};
      const bb = box(base);
      const x0 = Math.max(1, Math.floor((bb[0] - reach - ox) / g)), x1 = Math.min(W - 2, Math.ceil((bb[2] + reach - ox) / g));
      const y0 = Math.max(1, Math.floor((bb[1] - reach - oy) / g)), y1 = Math.min(H - 2, Math.ceil((bb[3] + reach - oy) / g));
      const wr = nets[n].w / 2;
      for (let l = 0; l < L; l++) {
        if (!(lm & (1 << l))) continue;
        const list = [];
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const cx = ox + x * g, cy = oy + y * g, cell = y * W + x, node = l * N2 + cell, b = blk[node];
          if (b !== 0 && b !== gid) continue;
          if (ptCore(cx, cy, base) - base.r > reach) continue;
          const len = Math.hypot(cx - t.x, cy - t.y);
          list.push([node, len, cx, cy]);
        }
        list.sort((a, b) => a[1] - b[1]);
        let kept = 0;
        for (const [node, len, cx, cy] of list) {
          if (kept >= 24) break;
          const S = {k: len > 1e-9 ? 1 : 0, c: len > 1e-9 ? [t.x, t.y, cx, cy] : [cx, cy], r: wr};
          S.bb = box(S);
          if (!staticClear(n, S, 1 << l, null)) continue;
          out.push({node, cost: len / g, S, l, o: t.pad ? o : null});
          kept++;
        }
      }
      termCache.set(key, out);
      return out;
    }
    // Access points of a terminal: every member of its copper island.
    function access(t, n) {
      if (!t.members || !t.members.length) return accessOne(t, n);
      if (t.cache && t.cache.n === n) return t.cache.out;
      const best = new Map();
      for (const m of t.members) for (const e of accessOne(m, n)) { const q = best.get(e.node); if (!q || e.cost < q.cost) best.set(e.node, e); }
      const out = [...best.values()].sort((a, b) => a.cost - b.cost).slice(0, 96);
      t.cache = {n, out};
      return out;
    }

    // ---- step cost tables
    const multi = L > 2;
    const against = opt.againstCost ?? (multi ? 1.0 : 0.6), diagCost = opt.diagCost ?? 0.1;
    const viaCost = opt.viaCost ?? (multi ? 8 : 12);
    const stepCost = new Float64Array(L * 8);
    const layerDir = job.layerDir || [];
    for (let l = 0; l < L; l++) {
      const vertical = layerDir[l] === 1, free = layerDir[l] === 2;
      for (let d = 0; d < 8; d++) {
        if (d >= 4) stepCost[l * 8 + d] = SQ2 * (1 + diagCost);
        else stepCost[l * 8 + d] = free ? 1 : ((d < 2) !== vertical ? 1 : 1 + against);
      }
    }
    const turn = new Float64Array(81);
    for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) {
      if (a === 8 || b === 8) { turn[a * 9 + b] = 0; continue; }
      const dot = (DX[a] * DX[b] + DY[a] * DY[b]) / (Math.hypot(DX[a], DY[a]) * Math.hypot(DX[b], DY[b]));
      turn[a * 9 + b] = dot > 0.99 ? 0 : dot > 0.6 ? (opt.bend45 ?? 0.15) : dot > -0.1 ? (opt.bend90 ?? 0.8) : dot > -0.9 ? 6 : 1e6;
    }
    const offs = new Int32Array(8);
    for (let d = 0; d < 8; d++) offs[d] = DY[d] * W + DX[d];

    // Vias of the net being routed keep the hole-to-hole gap from each other (other nets'
    // vias repel through vrep): cells near one of its vias are stamped with the current token.
    const ownVia = holeGap ? new Uint32Array(N2) : null;
    let ownTok = 1;
    function stampOwnVia(cell, n) {
      const R = (nets[n].vh || 0) + holeGap;
      cellsNearSeg(X(cell), Y(cell), X(cell), Y(cell), R, c => { if (c !== cell) ownVia[c] = ownTok; });
    }
    const hp = heap();
    let pres = opt.presFactor ?? 0.6, hard = false;
    // Global routing guides (engine v2), set by globalRoute() below.
    let GK = 1, GW = 1, GH = 1, GN = 1, gmark = null, gtok = 1, guideOn = false, guidePhase = false;
    // Steps inside a net's corridor are discounted (guideIn), outside ones cost more (guideMul).
    const guides = new Map(), guideMul = 1 + (opt.guidePenalty ?? 0.6), guideIn = opt.guideDiscount ?? 1;
    const hw = opt.heuristicWeight ?? 1.25;

    // ---- differential pairs: the negative net follows the positive one at the pair pitch
    const pairs = job.pairs || [], partner = new Map();
    let couple = null, coupleOn = false;
    const couplingBonus = opt.couplingBonus ?? 0.35;
    if (pairs.length) {
      couple = new Uint8Array(NL);
      for (const pr of pairs) { partner.set(pr.n, {lead: pr.p, gap: pr.gap}); partner.set(pr.p, {follower: pr.n, gap: pr.gap}); }
    }
    function pitchOf(n, lead) { return Math.max(nets[n].w / 2 + nets[lead].w / 2 + partner.get(n).gap, cls[lead].R); }
    // Mark the band of cells at the pair pitch from the lead net's tracks.
    function coupleCells(n, lead, delta) {
      const D = pitchOf(n, lead), list = [];
      for (const s of recs[lead]?.segs || []) {
        const base = s.l * N2;
        cellsNearSeg(s.a[0], s.a[1], s.b[0], s.b[1], D + g * 0.75, cell => {
          const k = base + cell, x = X(k), y = Y(k);
          if (ptSeg2(x, y, s.a[0], s.a[1], s.b[0], s.b[1]) >= D * D - 1e-9) list.push(k);
        });
      }
      for (const k of list) couple[k] = delta > 0 ? 1 : 0;
      return list.length;
    }

    // ---- A* search for one connection.
    // sources/targets: [{node, cost, S}] access points. Returns node list or null.
    function search(n, sources, targets, win, limit) {
      const gid = group[n], st = nextStamp(), closed = st + 1, wide = cls[n].wide, lm = nets[n].lm;
      // Preferred layers (engine v2: the fanout's escape layer): other layers cost more.
      const pref = nets[n].pref & allLayers, prefMul = 1 + (opt.prefPenalty ?? 0.5);
      const allowVia = opt.vias !== false && !limit.noVia && nets[n].vias !== false;
      const wr = nets[n].w / 2;
      let tx = 0, ty = 0;
      const tmap = new Map();
      for (const t of targets) { tmap.set(t.node, t); tx += t.node % W; ty += ((t.node % N2) / W | 0); }
      tx /= targets.length; ty /= targets.length;
      // A follower's heuristic must not overestimate the discounted band, or it would ignore its lead.
      const hs = coupleOn ? couplingBonus : hw;
      const h = node => {
        const dx = Math.abs(node % W - tx), dy = Math.abs(((node % N2) / W | 0) - ty);
        return (dx > dy ? dx + (SQ2 - 1) * dy : dy + (SQ2 - 1) * dx) * hs;
      };
      hp.clear();
      for (const s of sources) {
        let c = s.cost;
        const k = dynConflicts(n, s.S, 1 << s.l, hard);
        if (k) { if (hard) continue; c += k * pres * 20; }
        const node = s.node;
        if (stamp[node] === st && gcost[node] <= c) continue;
        stamp[node] = st; gcost[node] = c; dirs[node] = 255;
        hp.push(c + h(node), node);
      }
      const [wx0, wy0, wx1, wy1] = win;
      let expanded = 0, found = -1;
      const maxExp = limit.maxExpansions || 4e6;
      while (hp.size) {
        const node = hp.pop();
        if (stamp[node] === closed) continue;
        stamp[node] = closed;
        if (tmap.has(node)) { found = node; break; }
        if (++expanded > maxExp) break;
        const gn = gcost[node], l = (node / N2) | 0, cell = node - l * N2, x = cell % W, y = (cell / W) | 0, pd = dirs[node] < 8 ? dirs[node] : 8;
        const sc = l * 8;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < wx0 || nx > wx1 || ny < wy0 || ny > wy1) continue;
          const nb = node + offs[d];
          if (stamp[nb] === closed) continue;
          const b = blk[nb];
          if (b !== 0 && b !== gid) continue;
          const rp = repel[nb];
          if (hard && rp) continue;
          let c = stepCost[sc + d] * (1 + hist[nb] * HQ) * (1 + pres * rp) + turn[pd * 9 + d];
          if (coupleOn && couple[nb]) c *= couplingBonus;
          if (guideOn) { if (gmark[l * GN + ((ny / GK) | 0) * GW + ((nx / GK) | 0)] === gtok) c *= guideIn; else c *= guideMul; }
          if (pref && !(pref & (1 << l))) c *= prefMul;
          if (wide) {
            const ax = ox + x * g, ay = oy + y * g, S = {k: 1, c: [ax, ay, ax + DX[d] * g, ay + DY[d] * g], r: wr};
            S.bb = box(S);
            if (!staticClear(n, S, 1 << l, null)) continue;
            const k = dynConflicts(n, S, 1 << l, hard);
            if (k) { if (hard) continue; c *= 1 + pres * k * 2; }
          }
          const ng = gn + c;
          if (stamp[nb] !== st || ng < gcost[nb]) {
            stamp[nb] = st; gcost[nb] = ng; dirs[nb] = d;
            hp.push(ng + h(nb), nb);
          }
        }
        if (allowVia && L > 1) {
          const v = vblk[cell];
          if (v !== 0 && v !== gid) continue;
          if (ownVia && ownVia[cell] === ownTok) continue;
          let vr = vrep[cell];
          if (hard && vr) continue;
          let vc = viaCost * (limit.viaMul || 1) * (1 + hist[node] * HQ) * (1 + pres * vr * 2);
          for (let l2 = 0; l2 < L; l2++) {
            if (l2 === l || !(lm & (1 << l2))) continue;
            const nb = l2 * N2 + cell;
            if (stamp[nb] === closed) continue;
            const b = blk[nb];
            if (b !== 0 && b !== gid) continue;
            const rp = repel[nb];
            if (hard && rp) continue;
            let ng = gn + vc + Math.abs(l2 - l) * 0.01 + pres * rp;
            if (guideOn && gmark[l2 * GN + ((y / GK) | 0) * GW + ((x / GK) | 0)] !== gtok) ng += vc * (guideMul - 1);
            if (stamp[nb] !== st || ng < gcost[nb]) {
              stamp[nb] = st; gcost[nb] = ng; dirs[nb] = 8 + l;
              hp.push(ng + h(nb), nb);
            }
          }
        }
      }
      stats.expansions += expanded; stats.searches++;
      if (found < 0) return null;
      const path = [];
      for (let k = found, guard = 0; guard < NL; guard++) {
        path.push(k);
        const d = dirs[k];
        if (d === 255) break;
        k = d < 8 ? k - offs[d] : (d - 8) * N2 + (k % N2);
      }
      path.reverse();
      return {path, src: sources.find(s => s.node === path[0]), dst: tmap.get(found)};
    }

    // ---- net records: geometry, marking
    // rec = {n, conns:[{ci, path:[nodes], src, dst}], segs:[], vias:[], marked}
    const recs = new Array(NN);
    function geometry(rec) {
      const n = rec.n, segs = [], vias = [], w = nets[n].w;
      for (const p of rec.conns) {
        if (!p.path) continue;
        const nodes = p.path;
        let run = [];
        const flush = (l, pts) => {
          // merge collinear points
          const m = [];
          for (const q of pts) {
            if (m.length && Math.abs(m[m.length - 1][0] - q[0]) < 1e-9 && Math.abs(m[m.length - 1][1] - q[1]) < 1e-9) continue;
            if (m.length >= 2) {
              const a = m[m.length - 2], b = m[m.length - 1];
              const cr = (b[0] - a[0]) * (q[1] - b[1]) - (b[1] - a[1]) * (q[0] - b[0]);
              const dt = (b[0] - a[0]) * (q[0] - b[0]) + (b[1] - a[1]) * (q[1] - b[1]);
              if (Math.abs(cr) < 1e-9 && dt > 0) { m[m.length - 1] = q; continue; }
            }
            m.push(q);
          }
          if (m.length >= 2) for (let i = 1; i < m.length; i++) segs.push({l, a: m[i - 1], b: m[i], p});
          return m;
        };
        p.lines = [];
        let l = layerOf(nodes[0]);
        run.push([p.src.S.c[0], p.src.S.c[1]]);
        if (p.srcKink) run.push(p.srcKink);
        for (let i = 0; i < nodes.length; i++) {
          const k = nodes[i], kl = layerOf(k);
          if (kl !== l) {
            const pts = flush(l, run);
            if (pts.length >= 2) p.lines.push({l, pts});
            const c = k - kl * N2;
            vias.push({x: X(c), y: Y(c), cell: c, p});
            run = [];
            l = kl;
          }
          run.push([X(k), Y(k)]);
        }
        const dc = p.dst.S.c;
        if (p.dstKink) run.push(p.dstKink);
        run.push([dc[0], dc[1]]);
        const pts = flush(l, run);
        if (pts.length >= 2) p.lines.push({l, pts});
      }
      // de-duplicate vias at the same cell
      const seen = new Set();
      rec.vias = vias.filter(v => !seen.has(v.cell) && seen.add(v.cell));
      rec.segs = segs;
    }
    function mark(rec, delta) {
      const n = rec.n, c = cls[n];
      if (delta > 0) geometry(rec);
      const st = nextStamp(), st2 = st;
      const w = nets[n].w;
      for (const s of rec.segs) {
        const base = s.l * N2;
        cellsNearSeg(s.a[0], s.a[1], s.b[0], s.b[1], c.R, cell => { const k = base + cell; if (stamp[k] !== st) { stamp[k] = st; repel[k] += delta; } });
        cellsNearSeg(s.a[0], s.a[1], s.b[0], s.b[1], c.Rv, cell => { if (stamp2[cell] !== st2) { stamp2[cell] = st2; vrep[cell] += delta; } });
      }
      for (const v of rec.vias) {
        for (let l = 0; l < L; l++) {
          const base = l * N2;
          cellsNearSeg(v.x, v.y, v.x, v.y, c.via, cell => { const k = base + cell; if (stamp[k] !== st) { stamp[k] = st; repel[k] += delta; } });
        }
        cellsNearSeg(v.x, v.y, v.x, v.y, c.vv, cell => { if (stamp2[cell] !== st2) { stamp2[cell] = st2; vrep[cell] += delta; } });
      }
      if (delta > 0) {
        rec.dyn = [];
        for (const s of rec.segs) rec.dyn.push(didx.add({k: 1, c: [s.a[0], s.a[1], s.b[0], s.b[1]], r: w / 2, lm: 1 << s.l, net: n, p: s.p}));
        for (const v of rec.vias) rec.dyn.push(didx.add({k: 0, c: [v.x, v.y], r: nets[n].vd / 2, vh: nets[n].vh || 0, lm: allLayers, net: n, via: true, p: v.p}));
      } else if (rec.dyn) { for (const d of rec.dyn) didx.remove(d); rec.dyn = null; }
      rec.marked = delta > 0;
      if (liveDirty) liveDirty.add(rec);
    }

    // Grid conflicts of a marked net: cells it uses that another net repels.
    // Grid conflicts of a marked net: cells it uses that another net repels.
    // `which` collects the connections involved.
    function conflicts(rec, collect, which) {
      let k = 0;
      const n = rec.n;
      for (const p of rec.conns) {
        if (!p.path) continue;
        let hit = false;
        for (const node of p.path) if (repel[node] > 1) { k++; hit = true; if (collect) collect.push(node); }
        if (hit && which) which.add(p);
      }
      for (const v of rec.vias) if (vrep[v.cell] > 1) { k++; if (which) which.add(v.p); if (collect) for (let l = 0; l < L; l++) collect.push(l * N2 + v.cell); }
      // exact check of stubs and wide geometry
      for (const d of rec.dyn || []) {
        if (!cls[n].wide && !d.stub) continue;
        if (dynConflicts(n, d, d.lm, true)) { k++; if (which && d.p) which.add(d.p); if (collect) collect.push(cellNode(d)); }
      }
      return k;
    }
    const cellNode = d => {
      const x = Math.round((d.c[0] - ox) / g), y = Math.round((d.c[1] - oy) / g), l = Math.max(0, Math.round(Math.log2(d.lm & -d.lm)));
      return Math.min(L - 1, l) * N2 + Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x));
    };

    // ---- connections grouped by net
    const conns = job.conns.map((c, i) => ({...c, i}));
    for (const c of conns) {
      const ta = job.terms[c.a], tb = job.terms[c.b];
      c.len = Math.hypot(ta.x - tb.x, ta.y - tb.y);
      if (!recs[c.net]) recs[c.net] = {n: c.net, conns: [], segs: [], vias: [], marked: false, failed: 0};
      recs[c.net].conns.push({ci: c.i, path: null});
    }
    const order = recs.filter(Boolean);
    for (const r of order) {
      r.conns.sort((a, b) => conns[a.ci].len - conns[b.ci].len);
      r.span = r.conns.reduce((s, p) => s + conns[p.ci].len, 0);
      r.priority = nets[r.n].priority || 0;
    }
    order.sort((a, b) => b.priority - a.priority || a.span - b.span || a.n - b.n);
    if (partner.size) {
      // pairs first, the follower right after its lead
      const lead = order.filter(r => partner.get(r.n)?.follower !== undefined), followers = new Set(order.filter(r => partner.get(r.n)?.lead !== undefined));
      const rest = order.filter(r => !followers.has(r) && !lead.includes(r));
      order.length = 0;
      for (const r of lead) { order.push(r); const f = recs[partner.get(r.n).follower]; if (f) { order.push(f); followers.delete(f); } }
      order.push(...followers, ...rest);
    }
    // Rerouting either net of a pair reroutes both, lead first.
    const withPartners = list => {
      if (!partner.size) return list;
      const set = new Set(list);
      for (const r of list) { const q = partner.get(r.n), o = q && recs[q.lead ?? q.follower]; if (o) set.add(o); }
      return order.filter(r => set.has(r));
    };
    const total = conns.length;

    function windowFor(c, grow) {
      const ta = job.terms[c.a], tb = job.terms[c.b];
      const m = grow ? INF : Math.max(3, 0.35 * Math.max(Math.abs(ta.x - tb.x), Math.abs(ta.y - tb.y))) + 2 * (w0 + c0);
      return [Math.max(1, Math.floor((Math.min(ta.x, tb.x) - m - ox) / g)), Math.max(1, Math.floor((Math.min(ta.y, tb.y) - m - oy) / g)),
        Math.min(W - 2, Math.ceil((Math.max(ta.x, tb.x) + m - ox) / g)), Math.min(H - 2, Math.ceil((Math.max(ta.y, tb.y) + m - oy) / g))];
    }
    function routeNet(rec, limit = {}) {
      if (rec.marked) mark(rec, -1);
      const lead = couple && opt.pairs !== false ? partner.get(rec.n)?.lead : undefined;
      const corridor = guidePhase ? guides.get(rec.n) : null;
      if (corridor) { if (++gtok === 0xffffffff) { gmark.fill(0); gtok = 1; } for (let i = 0; i < corridor.length; i++) gmark[corridor[i]] = gtok; guideOn = true; }
      else guideOn = false;
      if (lead !== undefined && recs[lead]?.marked) { coupleCells(rec.n, lead, 1); coupleOn = true; }
      try { return routeNetInner(rec, limit); }
      finally { if (coupleOn) { coupleCells(rec.n, lead, -1); coupleOn = false; } }
    }
    function viaCells(path) {
      const out = [];
      for (let i = 1; i < path.length; i++) if (layerOf(path[i]) !== layerOf(path[i - 1])) out.push(path[i] % N2);
      return out;
    }
    function routeNetInner(rec, limit) {
      let ok = 0;
      if (ownVia) {
        ownTok++;
        for (const p of rec.conns) if (limit.only && p.path && !limit.only.has(p)) for (const c of viaCells(p.path)) stampOwnVia(c, rec.n);
      }
      for (const p of rec.conns) {
        const c = conns[p.ci];
        if (limit.only && !limit.only.has(p)) continue;
        if (c.dead) { p.path = null; continue; }
        const A = access(job.terms[c.a], rec.n), B = access(job.terms[c.b], rec.n);
        if (!A.length || !B.length) { p.path = null; c.reason = !A.length ? "No legal escape from " + (job.terms[c.a].label || "terminal") : "No legal escape from " + (job.terms[c.b].label || "terminal"); c.dead = true; continue; }
        let r = search(rec.n, A, B, windowFor(c, false), limit);
        if (!r && !limit.noGrow) r = search(rec.n, A, B, windowFor(c, true), limit);
        p.srcKink = p.dstKink = null;
        if (r) { p.path = r.path; p.src = r.src; p.dst = r.dst; ok++; if (ownVia) for (const vc of viaCells(r.path)) stampOwnVia(vc, rec.n); }
        else { p.path = null; c.reason = hard ? "Blocked by routed copper" : "No path within the routing area"; }
      }
      mark(rec, 1);
      // Stubs are exact-checked; tag their dynamic records.
      for (const d of rec.dyn || []) {
        const s = d.c;
        const onGrid = (x, y) => Math.abs((x - ox) / g - Math.round((x - ox) / g)) < 1e-6 && Math.abs((y - oy) / g - Math.round((y - oy) / g)) < 1e-6;
        if (d.k === 1 && (!onGrid(s[0], s[1]) || !onGrid(s[2], s[3]))) d.stub = true;
      }
      return ok;
    }

    // ---- pass 1: short connections on one layer, no vias
    const timeLimit = opt.timeLimit ?? 60000;
    let lastYield = now();
    const yieldMs = opt.yieldMs ?? 40;
    const shouldYield = () => { const t = now(); if (t - lastYield > yieldMs) { lastYield = t; return true; } return false; };
    const routedCount = () => order.reduce((s, r) => s + r.conns.filter(p => p.path).length, 0);

    const shortLen = opt.shortLength ?? 6;
    if (opt.shortPass !== false) {
      const t = now();
      let i = 0;
      for (const rec of order) {
        if (rec.conns.every(p => conns[p.ci].len <= shortLen)) {
          hard = true;
          routeNet(rec, {noVia: true, noGrow: true, maxExpansions: 60000});
          if (rec.conns.some(p => !p.path)) { mark(rec, -1); for (const p of rec.conns) p.path = null; }
          hard = false;
        }
        if (++i % 8 === 0 && shouldYield()) yield progress("Short connections", {fraction: i / order.length, routed: routedCount(), total});
      }
      stats.passes.push({name: "Short connections", ms: now() - t, routed: routedCount()});
    }

    // ---- global routing (engine v2): PathFinder on a coarse grid of routing cells (gcells) per
    // layer, with capacities from the free fine cells, gives every net a corridor of gcells and
    // layers (its channel and layer assignment). The detailed search then costs steps outside
    // the corridor more, so nets spread over channels and layers before they ever conflict.
    if (opt.global && L >= 1) {
      const t = now();
      globalRoute();
      stats.passes.push({name: "Global routing", ms: now() - t, routed: routedCount(), gcell: GK * g, overflow: stats.global?.overflow});
      yield progress("Global routing", {fraction: 1, routed: routedCount(), total});
    }
    function globalRoute() {
      GK = Math.max(3, Math.round(opt.gcellTracks ?? 6) * kdiv);
      GW = Math.ceil(W / GK); GH = Math.ceil(H / GK); GN = GW * GH;
      const GL = GN * L;
      gmark = new Uint32Array(GL);
      // Capacity: tracks that fit through a gcell = free share of its fine cells x tracks per gcell.
      const free = new Float32Array(GL), cap = new Float32Array(GL), use = new Uint16Array(GL), ghist = new Float32Array(GL);
      for (let l = 0; l < L; l++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = l * N2 + y * W + x;
        if (blk[k] === 0 && !repel[k]) free[l * GN + ((y / GK) | 0) * GW + ((x / GK) | 0)]++;
      }
      for (let i = 0; i < GL; i++) cap[i] = (free[i] / (GK * GK)) * GK / kdiv;
      const gdir = layerDir;
      const gq = heap(), gcost = new Float64Array(GL), gfrom = new Int32Array(GL), gst = new Uint32Array(GL);
      let gstamp = 0;
      const gvia = opt.globalViaCost ?? 3;
      const GDX = [1, -1, 0, 0, 1, 1, -1, -1], GDY = [0, 0, 1, -1, 1, -1, 1, -1];
      const gOf = (x, y, l) => l * GN + Math.min(GH - 1, Math.max(0, Math.floor((y - oy) / g / GK))) * GW + Math.min(GW - 1, Math.max(0, Math.floor((x - ox) / g / GK)));
      let pf = 0.5;
      const todo = [];
      for (const rec of order) for (const p of rec.conns) if (!p.path && !conns[p.ci].dead) todo.push([rec, p]);
      const netNodes = new Map(); // net -> Map(gl -> count)
      const gpaths = new Map();
      const addNet = (n, path, d) => {
        let m = netNodes.get(n); if (!m) netNodes.set(n, m = new Map());
        for (const id of path) {
          const was = m.get(id) || 0, c = was + d;
          if (c <= 0) { if (was > 0) { m.delete(id); use[id]--; } }
          else { if (!was) use[id]++; m.set(id, c); }
        }
      };
      function groute(n, a, b) {
        const ta = job.terms[a], tb = job.terms[b], lm = nets[n].lm;
        gstamp++;
        gq.clear();
        const tgx = Math.floor((tb.x - ox) / g / GK), tgy = Math.floor((tb.y - oy) / g / GK);
        const targets = new Set();
        for (let l = 0; l < L; l++) if ((lm & (tb.lm ?? allLayers)) & (1 << l)) targets.add(gOf(tb.x, tb.y, l));
        const h = id => { const c = id % GN, x = c % GW, y = (c / GW) | 0, dx = Math.abs(x - tgx), dy = Math.abs(y - tgy); return (dx > dy ? dx + (SQ2 - 1) * dy : dy + (SQ2 - 1) * dx); };
        for (let l = 0; l < L; l++) if ((lm & (ta.lm ?? allLayers)) & (1 << l)) { const id = gOf(ta.x, ta.y, l); gst[id] = gstamp; gcost[id] = 0; gfrom[id] = -1; gq.push(h(id), id); }
        const mine = netNodes.get(n);
        let found = -1, guard = 0;
        while (gq.size && guard++ < 4 * GL) {
          const id = gq.pop();
          if (targets.has(id)) { found = id; break; }
          const l = (id / GN) | 0, c = id - l * GN, x = c % GW, y = (c / GW) | 0, gc = gcost[id];
          const step = (nid, base) => {
            const over = Math.max(0, use[nid] + (mine?.has(nid) ? 0 : 1) - cap[nid]);
            const cost = gc + (base + ghist[nid]) * (1 + pf * over) + (cap[nid] < 0.5 ? 4 : 0);
            if (gst[nid] !== gstamp || cost < gcost[nid] - 1e-9) { gst[nid] = gstamp; gcost[nid] = cost; gfrom[nid] = id; gq.push(cost + h(nid), nid); }
          };
          for (let d = 0; d < 8; d++) {
            const nx = x + GDX[d], ny = y + GDY[d];
            if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
            const dir = gdir[l], along = dir === 2 || d >= 4 ? 0 : ((d < 2) !== (dir === 1) ? 0 : 1);
            step(l * GN + ny * GW + nx, (d >= 4 ? SQ2 * 1.1 : 1) + along * (multi ? 1 : 0.6));
          }
          if (L > 1 && opt.vias !== false && nets[n].vias !== false) for (let l2 = 0; l2 < L; l2++) if (l2 !== l && (lm & (1 << l2))) step(l2 * GN + c, gvia);
        }
        if (found < 0) return null;
        const out = [];
        for (let id = found; id >= 0; id = gfrom[id]) { out.push(id); if (out.length > GL) break; }
        return out;
      }
      for (let it = 0; it < (opt.globalIterations ?? 6); it++) {
        const over = new Set();
        for (let i = 0; i < GL; i++) if (use[i] > cap[i] + 1e-9) over.add(i);
        const redo = it === 0 ? todo : todo.filter(([, p]) => (gpaths.get(p) || []).some(id => over.has(id)));
        if (it > 0 && !redo.length) break;
        for (const i of over) ghist[i] += 0.5 * (use[i] - cap[i]);
        for (const [rec, p] of redo) {
          const old = gpaths.get(p);
          if (old) addNet(rec.n, old, -1);
          const c = conns[p.ci], path = groute(rec.n, c.a, c.b);
          gpaths.set(p, path || []);
          if (path) addNet(rec.n, path, 1);
        }
        pf *= 1.8;
      }
      let overflow = 0;
      for (let i = 0; i < GL; i++) if (use[i] > cap[i] + 1e-9) overflow += use[i] - cap[i];
      // Corridors: the gcells of each net's global paths and their planar neighbours on the same layer.
      const dil = opt.guideDilate ?? 1;
      for (const [n, m] of netNodes) {
        const set = new Set();
        for (const id of m.keys()) {
          const l = (id / GN) | 0, c = id - l * GN, x = c % GW, y = (c / GW) | 0;
          for (let dy = -dil; dy <= dil; dy++) for (let dx = -dil; dx <= dil; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < GW && ny < GH) set.add(l * GN + ny * GW + nx); }
        }
        guides.set(n, Int32Array.from(set));
      }
      stats.global = {gcell: GK * g, gcells: GN, overflow: Math.round(overflow * 10) / 10, nets: netNodes.size};
    }

    // ---- pass 2: main, negotiated congestion
    {
      const t = now();
      const maxIter = opt.maxIterations ?? 40;
      guidePhase = guides.size > 0;
      let it = 0, conflicted = order.filter(r => !r.marked), bestConf = Infinity, stale = 0;
      const rerouteOnly = new Map();
      for (; it < maxIter; it++) {
        stats.iterations = it + 1;
        let i = 0;
        for (const rec of conflicted) {
          const only = it > 0 && !partner.has(rec.n) ? rerouteOnly.get(rec) : undefined;
          routeNet(rec, only && only.size ? {only} : {});
          if (++i % 4 === 0 && shouldYield()) yield progress("Main routing", {iteration: it + 1, fraction: i / conflicted.length, routed: routedCount(), total, conflicts: conflicted.length});
          if (now() - T0 > timeLimit) break;
        }
        const next = [];
        rerouteOnly.clear();
        for (const rec of order) {
          const cells = [], which = new Set();
          rerouteOnly.set(rec, which);
          if (conflicts(rec, cells, which)) { next.push(rec); for (const c of cells) histAdd(c, opt.histStep ?? 0.4); if (opt.debug) opt.debug(rec, cells.map(c => [layerOf(c), X(c), Y(c), repel[c]])); }
        }
        yield progress("Main routing", {iteration: it + 1, fraction: 1, routed: routedCount(), total, conflicts: next.length});
        conflicted = withPartners(next);
        if (!next.length || now() - T0 > timeLimit) break;
        if (next.length < bestConf) { bestConf = next.length; stale = 0; } else if (++stale >= (opt.stagnation ?? 6)) break;
        pres *= opt.presGrowth ?? 1.5;
      }
      guidePhase = false;
      // Resolve leftovers in hard mode: rip every conflicted net, then reroute each against the rest.
      if (conflicted.length) {
        for (const rec of conflicted) mark(rec, -1);
        hard = true;
        for (const rec of conflicted) { routeNet(rec); if (shouldYield()) yield progress("Completion", {routed: routedCount(), total}); }
        hard = false;
      }
      stats.passes.push({name: "Main routing", ms: now() - t, routed: routedCount(), iterations: stats.iterations});
    }
    // ---- completion: retry failed connections on the whole board, then rip up and retry
    {
      const t = now();
      const failedConns = rec => rec.conns.filter(p => !p.path && !conns[p.ci].dead);
      const snapshot = rec => rec.conns.map(p => ({path: p.path, src: p.src, dst: p.dst, reason: conns[p.ci].reason}));
      const restore = (rec, snap) => {
        if (rec.marked) mark(rec, -1);
        rec.conns.forEach((p, i) => { p.path = snap[i].path; p.src = snap[i].src; p.dst = snap[i].dst; conns[p.ci].reason = snap[i].reason; });
        mark(rec, 1);
      };
      // Nets whose routed copper violates clearance with this net's copper.
      function victimsOf(rec) {
        const out = new Set();
        for (const d of rec.dyn || []) didx.query(d.bb, 1.5, o => {
          if (o.net !== rec.n && !sameGroup(o.net, rec.n) && (o.lm & d.lm) && shapeDist(d, o) < pairClr(rec.n, o.net) - 1e-7) out.add(o.net);
          return false;
        });
        return [...out].map(n => recs[n]).filter(Boolean);
      }
      hard = true;
      for (const rec of order) {
        const failed = failedConns(rec);
        if (!failed.length) continue;
        for (const p of failed) delete conns[p.ci].reason;
        routeNet(rec, {only: new Set(failed)});
        if (shouldYield()) yield progress("Completion", {routed: routedCount(), total});
      }
      const maxVictims = opt.maxVictims ?? 6;
      for (let round = 0; round < 2; round++) {
        for (const rec of order) {
          if (now() - T0 > timeLimit) break;
          const failed = failedConns(rec);
          if (!failed.length) continue;
          const before = snapshot(rec), lost = failed.length;
          hard = false;
          const keep = pres;
          pres = Math.max(pres, 20);
          routeNet(rec, {only: new Set(failed)});
          pres = keep;
          hard = true;
          if (failedConns(rec).length >= lost) { if (opt.debug) opt.debug("retry: still failed", rec.n, failedConns(rec).map(p => conns[p.ci].reason)); restore(rec, before); continue; }
          const victims = victimsOf(rec).filter(v => v !== rec);
          if (opt.debug) opt.debug("retry", rec.n, "victims", victims.map(v => v.n));
          if (victims.length > maxVictims) { restore(rec, before); continue; }
          const snaps = victims.map(snapshot), had = victims.reduce((s, v) => s + failedConns(v).length, 0);
          for (const v of victims) mark(v, -1);
          for (const v of victims) routeNet(v);
          const now2 = victims.reduce((s, v) => s + failedConns(v).length, 0);
          const gained = lost - failedConns(rec).length;
          if (now2 - had >= gained || conflicts(rec) || victims.some(v => conflicts(v))) {
            for (const v of victims) if (v.marked) mark(v, -1);
            if (rec.marked) mark(rec, -1);
            victims.forEach((v, i) => { v.conns.forEach((p, j) => { p.path = snaps[i][j].path; p.src = snaps[i][j].src; p.dst = snaps[i][j].dst; conns[p.ci].reason = snaps[i][j].reason; }); });
            rec.conns.forEach((p, j) => { p.path = before[j].path; p.src = before[j].src; p.dst = before[j].dst; conns[p.ci].reason = before[j].reason; });
            for (const v of victims) mark(v, 1);
            mark(rec, 1);
          }
          if (shouldYield()) yield progress("Completion", {routed: routedCount(), total});
        }
      }
      hard = false;
      stats.passes.push({name: "Completion", ms: now() - t, routed: routedCount()});
    }

    // ---- via minimisation (engine v2): reroute each connection that changes layer, first on
    // one layer, then with a much higher via cost, against everything else; keep the result
    // only when it has fewer vias and is not much longer.
    const pathCells = path => { let s = 0; for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i]; if (layerOf(a) === layerOf(b)) s += (a % W === b % W || ((a % N2) / W | 0) === ((b % N2) / W | 0)) ? 1 : SQ2; } return s; };
    if (opt.viaMinimize) {
      const t = now();
      let saved = 0, tried = 0;
      const list = [];
      // Pairs keep their coupled shape (rerouting one side alone would split the pair).
      for (const rec of order) if (!(partner.has(rec.n) && opt.pairs !== false)) for (const p of rec.conns) if (p.path && viaCells(p.path).length) list.push([rec, p]);
      list.sort((a, b) => viaCells(b[1].path).length - viaCells(a[1].path).length);
      hard = true;
      // Bounded: at most a share of the time routing took so far (the most vias first).
      const vmBudget = opt.viaMinimizeBudget ?? Math.max(15, 0.3 * (now() - T0));
      for (const [rec, p] of list) {
        if (now() - T0 > timeLimit || now() - t > vmBudget) break;
        if (!p.path) continue;
        const old = {path: p.path, src: p.src, dst: p.dst}, v0 = viaCells(p.path).length, len0 = pathCells(p.path);
        let best = null;
        // A single-layer route is only possible when both ends reach a common layer.
        const cc = conns[p.ci], common = (job.terms[cc.a].lm ?? allLayers) & (job.terms[cc.b].lm ?? allLayers) & nets[rec.n].lm;
        const tries = [];
        if (common) tries.push({noVia: true, noGrow: true, maxExpansions: opt.viaMinimizeExpansions ?? 20000});
        if (v0 > 1 || !common) tries.push({viaMul: opt.viaMinimizeMul ?? 6, noGrow: true, maxExpansions: 2 * (opt.viaMinimizeExpansions ?? 20000)});
        for (const lim of tries) {
          tried++;
          mark(rec, -1);
          routeNet(rec, {only: new Set([p]), ...lim});
          const ok = p.path && conflicts(rec) === 0, v1 = ok ? viaCells(p.path).length : Infinity, len1 = ok ? pathCells(p.path) : Infinity;
          if (ok && v1 < v0 && len1 <= len0 * (opt.viaMinimizeStretch ?? 1.6) + 20) { best = {path: p.path, src: p.src, dst: p.dst}; break; }
          mark(rec, -1);
          p.path = old.path; p.src = old.src; p.dst = old.dst; delete conns[p.ci].reason;
          mark(rec, 1);
        }
        if (best) saved += v0 - viaCells(best.path).length;
        if (shouldYield()) yield progress("Via minimisation", {routed: routedCount(), total});
      }
      hard = false;
      stats.viaMinimize = {saved, tried};
      stats.passes.push({name: "Via minimisation", ms: now() - t, routed: routedCount()});
    }

    // ---- cleanup: straighten and recorner on the grid with hard legality
    function legalNode(n, node, from) {
      const b = blk[node], gid = group[n];
      if (b !== 0 && b !== gid) return false;
      if (repel[node]) return false;
      if (cls[n].wide && from >= 0) {
        const S = {k: 1, c: [X(from), Y(from), X(node), Y(node)], r: nets[n].w / 2};
        S.bb = box(S);
        if (!staticClear(n, S, 1 << layerOf(node), null) || dynConflicts(n, S, 1 << layerOf(node), true)) return false;
      }
      return true;
    }
    // Cells of a straight grid leg from a to b (exclusive of a), or null if not a grid direction.
    function leg(a, b) {
      const l = layerOf(a), ca = a - l * N2, cb = b - l * N2;
      const dx = cb % W - ca % W, dy = ((cb / W) | 0) - ((ca / W) | 0);
      if (dx && dy && Math.abs(dx) !== Math.abs(dy)) return null;
      const steps = Math.max(Math.abs(dx), Math.abs(dy)), o = Math.sign(dy) * W + Math.sign(dx), out = [];
      for (let i = 1; i <= steps; i++) out.push(a + o * i);
      return out;
    }
    function legalLeg(n, a, cells) {
      let prev = a;
      for (const c of cells) { if (!legalNode(n, c, prev)) return false; prev = c; }
      return true;
    }
    // Two-leg octile paths between a and b on one layer.
    function octile(a, b) {
      const l = layerOf(a), ca = a - l * N2, cb = b - l * N2;
      const dx = cb % W - ca % W, dy = ((cb / W) | 0) - ((ca / W) | 0), adx = Math.abs(dx), ady = Math.abs(dy);
      const sx = Math.sign(dx), sy = Math.sign(dy), m = Math.min(adx, ady);
      const diag = a + (sy * W + sx) * m;
      const orthFirst = a + (adx > ady ? sx * (adx - m) : sy * (ady - m) * W);
      return [[diag, b], [orthFirst, b]];
    }
    const gx = k => (k % N2) % W, gy = k => ((k % N2) / W) | 0;
    const vlen = (a, b) => Math.hypot(gx(a) - gx(b), gy(a) - gy(b));
    const sdir = (a, b) => [Math.sign(gx(b) - gx(a)), Math.sign(gy(b) - gy(a))];
    const steps = (a, b) => Math.max(Math.abs(gx(b) - gx(a)), Math.abs(gy(b) - gy(a)));
    // Corner vertices of a same-layer run of cells.
    function corners(nodes) {
      if (nodes.length < 3) return nodes.slice();
      const out = [nodes[0]];
      for (let i = 1; i < nodes.length - 1; i++) {
        const a = nodes[i - 1], v = nodes[i], b = nodes[i + 1];
        if (gx(v) - gx(a) !== gx(b) - gx(v) || gy(v) - gy(a) !== gy(b) - gy(v)) out.push(v);
      }
      out.push(nodes[nodes.length - 1]);
      return out;
    }
    function expand(v) {
      const out = [v[0]];
      for (let i = 1; i < v.length; i++) { const c = leg(v[i - 1], v[i]); if (c) for (const q of c) out.push(q); }
      return out;
    }
    const turnOK = (p, a, b) => { const d1 = sdir(p, a), d2 = sdir(a, b); return d1[0] * d2[0] + d1[1] * d2[1] >= 0; };
    function straightenVerts(n, v) {
      if (v.length < 3) return v;
      const out = [v[0]];
      let i = 0;
      while (i < v.length - 1) {
        let done = false;
        for (let j = Math.min(v.length - 1, i + 8); j > i + 1; j--) {
          let L0 = 0;
          for (let k = i + 1; k <= j; k++) L0 += vlen(v[k - 1], v[k]);
          const B0 = j - i - 1;
          for (const [mid] of octile(v[i], v[j])) {
            const legs = mid === v[i] || mid === v[j] ? [v[j]] : [mid, v[j]];
            let L1 = 0, prev = v[i];
            for (const q of legs) { L1 += vlen(prev, q); prev = q; }
            if (L1 > L0 + 1e-9 || (L1 > L0 - 1e-9 && legs.length - 1 >= B0)) continue;
            if (out.length >= 2 && !turnOK(out[out.length - 2], v[i], legs[0])) continue;
            if (j + 1 < v.length && !turnOK(legs.length > 1 ? legs[0] : v[i], v[j], v[j + 1])) continue;
            let ok = true;
            prev = v[i];
            for (const q of legs) { const cells = leg(prev, q); if (!cells || !legalLeg(n, prev, cells)) { ok = false; break; } prev = q; }
            if (!ok) continue;
            out.push(...legs); i = j; done = true; break;
          }
          if (done) break;
        }
        if (!done) { out.push(v[i + 1]); i++; }
      }
      return out;
    }
    // Replace 90 degree corners by two 45 degree corners, as long as the setback allows.
    function recornerVerts(n, v, setback) {
      for (let i = 1; i < v.length - 1; i++) {
        const d1 = sdir(v[i - 1], v[i]), d2 = sdir(v[i], v[i + 1]);
        if (d1[0] * d2[0] + d1[1] * d2[1] !== 0) continue;
        const kmax = Math.min(steps(v[i - 1], v[i]) - (i > 1 ? 1 : 0), steps(v[i], v[i + 1]) - (i + 2 < v.length ? 1 : 0), setback);
        for (let k = kmax; k >= 1; k--) {
          const from = v[i] - (d1[1] * W + d1[0]) * k, to = v[i] + (d2[1] * W + d2[0]) * k, cells = leg(from, to);
          if (!cells || !legalLeg(n, from, cells)) continue;
          const repl = [];
          if (from !== v[i - 1]) repl.push(from);
          if (to !== v[i + 1]) repl.push(to);
          v = [...v.slice(0, i), ...repl, ...v.slice(i + 1)];
          i += repl.length - 1;
          break;
        }
      }
      return v;
    }
    const straightenRun = (n, nodes) => expand(straightenVerts(n, corners(nodes)));
    const recornerRun = (n, nodes, setback) => expand(recornerVerts(n, corners(nodes), setback));
    // Enter each terminal straight from the furthest legal cell, preferring 0/45/90 degree entries.
    function padEntry(n, p, atStart) {
      const path = atStart ? p.path : p.path.slice().reverse(), term = atStart ? p.src : p.dst;
      if (!term || path.length < 2) return;
      const tx = term.S.c[0], ty = term.S.c[1], l = layerOf(path[0]), wr = nets[n].w / 2, tol = 1e-6;
      const o = term.o || null, ob = o ? o.bb : null;
      const free = (ob ? Math.max(ob[2] - ob[0], ob[3] - ob[1]) / 2 : 0) + 1.5 * g;
      let kmax = 0;
      while (kmax + 1 < path.length && kmax < 24 && layerOf(path[kmax + 1]) === l) kmax++;
      let best = -1, aligned = -1, bestS = null, alignedS = null;
      for (let k = kmax; k >= 1; k--) {
        const x = X(path[k]), y = Y(path[k]), dx = Math.abs(x - tx), dy = Math.abs(y - ty);
        const isAligned = dx < tol || dy < tol || Math.abs(dx - dy) < tol;
        if ((best >= 0 || Math.hypot(dx, dy) > free) && !isAligned) continue;
        const S = {k: 1, c: [tx, ty, x, y], r: wr};
        S.bb = box(S);
        if (!staticClear(n, S, 1 << l, null) || dynConflicts(n, S, 1 << l, true)) continue;
        // the turn at the new first cell must not be acute
        if (k + 1 < path.length && layerOf(path[k + 1]) === l) {
          const ax = x - tx, ay = y - ty, bx = X(path[k + 1]) - x, by = Y(path[k + 1]) - y;
          if (ax * bx + ay * by < -1e-9) continue;
        }
        if (best < 0) { best = k; bestS = S; }
        if (isAligned) { aligned = k; alignedS = S; break; }
      }
      const k = aligned >= 0 && aligned >= best - 3 ? aligned : best, S = k === aligned ? alignedS : bestS;
      if (k > 0) {
        const rest = path.slice(k);
        const nt = {node: rest[0], cost: 0, S, l, o};
        if (atStart) { p.path = rest; p.src = nt; } else { p.path = rest.reverse(); p.dst = nt; }
      }
      if (opt.octEntry && !(partner.has(n) && opt.pairs !== false)) octEntry(n, p, atStart);
    }
    // Engine v2: an entry that is not at 0/45/90 degrees becomes a straight-then-45° dog-leg
    // (or 45°-then-straight) where both legs keep clearance, so tracks leave pads like a person draws them.
    function octEntry(n, p, atStart) {
      const term = atStart ? p.src : p.dst, path = atStart ? p.path : p.path.slice().reverse();
      if (!term || !path.length) return;
      const tx = term.S.c[0], ty = term.S.c[1], node = path[0], l = layerOf(node), x = X(node), y = Y(node), tol = 1e-6;
      const dx = x - tx, dy = y - ty, adx = Math.abs(dx), ady = Math.abs(dy);
      if (adx < tol || ady < tol || Math.abs(adx - ady) < tol) return;
      const sx = Math.sign(dx), sy = Math.sign(dy), m = Math.min(adx, ady), wr = nets[n].w / 2;
      const next = path.length > 1 && layerOf(path[1]) === l ? path[1] : -1;
      const cands = [adx > ady ? [tx + sx * (adx - ady), ty] : [tx, ty + sy * (ady - adx)], [tx + sx * m, ty + sy * m]];
      for (const K of cands) {
        if (next >= 0) { const ax = x - K[0], ay = y - K[1], bx = X(next) - x, by = Y(next) - y; if (ax * bx + ay * by < -1e-9) continue; }
        let ok = true;
        for (const c of [[tx, ty, K[0], K[1]], [K[0], K[1], x, y]]) {
          const S = {k: 1, c, r: wr}; S.bb = box(S);
          if (!staticClear(n, S, 1 << l, null) || dynConflicts(n, S, 1 << l, true)) { ok = false; break; }
        }
        if (!ok) continue;
        if (atStart) p.srcKink = K; else p.dstKink = K;
        return;
      }
    }
    if (opt.cleanup !== false) {
      const t = now();
      const setback = Math.max(1, Math.round((opt.setback ?? Math.max(0.5, 3 * (w0 + c0))) / g));
      let i = 0;
      for (const rec of order) {
        if (!rec.marked || !rec.conns.some(p => p.path)) continue;
        mark(rec, -1);
        for (const p of rec.conns) {
          if (!p.path) continue;
          // split into same-layer runs
          const runs = [];
          let cur = [p.path[0]];
          for (let k = 1; k < p.path.length; k++) {
            if (layerOf(p.path[k]) !== layerOf(p.path[k - 1])) { runs.push(cur); cur = [p.path[k]]; }
            else cur.push(p.path[k]);
          }
          runs.push(cur);
          // Pair nets keep their coupled shape: straightening either side would split the pair.
          const paired = partner.has(rec.n) && opt.pairs !== false;
          p.path = runs.flatMap(r => { const q = paired ? r : straightenRun(rec.n, r); return opt.recorner === false ? q : recornerRun(rec.n, q, paired ? 1 : setback); });
          padEntry(rec.n, p, true);
          padEntry(rec.n, p, false);
        }
        mark(rec, 1);
        if (++i % 8 === 0 && shouldYield()) yield progress("Straighten and recorner", {fraction: i / order.length, routed: routedCount(), total});
      }
      stats.passes.push({name: "Straighten and recorner", ms: now() - t, routed: routedCount()});
    }

    // ---- exact verification of everything new
    function verifyRec(rec) {
      const bad = [];
      const n = rec.n;
      for (const d of rec.dyn || []) {
        const S = d;
        // static
        let hit = null;
        sidx.query(S.bb, 2, o => {
          if (!(o.lm & S.lm) || (S.k === 0 ? o.blockVia === false : o.blockTrack === false)) return false;
          const need = o.edge ? o.clr : (o.net > 0 && sameGroup(o.net, n)) ? -1 : pairClr(n, o.net);
          if (need >= 0 && shapeDist(S, o) < need - 1e-6) { hit = o; return true; }
          return false;
        });
        if (!hit) didx.query(S.bb, 2, o => {
          if (!(o.lm & S.lm) || sameGroup(o.net, n)) return false;
          if (shapeDist(S, o) < pairClr(n, o.net) - 1e-6) { hit = o; return true; }
          return false;
        });
        // Hole to hole, any net (the same net's other vias included).
        if (!hit && holeGap && S.via) {
          const x = S.c[0], y = S.c[1];
          holeIdx.query(S.bb, vhMax + holeGap + 1, h => { if (Math.hypot(h.c[0] - x, h.c[1] - y) < S.vh / 2 + h.hr + holeGap - 1e-6) { hit = h; return true; } return false; });
          if (!hit) didx.query(S.bb, vhMax + holeGap + 1, o => { if (o !== S && o.via && Math.hypot(o.c[0] - x, o.c[1] - y) < S.vh / 2 + o.vh / 2 + holeGap - 1e-6) { hit = o; return true; } return false; });
        }
        if (hit) bad.push({d, with: hit});
      }
      return bad;
    }
    {
      const t = now();
      for (let round = 0; round < 3; round++) {
        const offenders = [];
        for (const rec of order) { if (rec.marked && rec.dyn && rec.dyn.length) { const bad = verifyRec(rec); if (bad.length) offenders.push([rec, bad]); } }
        stats.verifyViolations = stats.verifyViolations || [];
        stats.verifyViolations.push(offenders.reduce((s, [, b]) => s + b.length, 0));
        if (!offenders.length) break;
        for (const [rec, bad] of offenders) {
          for (const b of bad) { const k = cellNode(b.d); for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const q = k + dy * W + dx; if (q >= 0 && q < NL) histAdd(q, 4); } }
          mark(rec, -1);
          if (round === 2) {
            // Drop only the offending connections (all of them when one cannot be told).
            const which = new Set(bad.map(b => b.d.p).filter(Boolean)), all = bad.some(b => !b.d.p);
            for (const p of rec.conns) {
              if (!p.path || (!all && !which.has(p))) continue;
              const bb = bad.map(b => b.d);
              p.path = null; conns[p.ci].reason = "Could not keep clearance near " + bb[0].c.slice(0, 2).map(v => v.toFixed(2)).join(", ");
            }
            mark(rec, 1);
            continue;
          }
          hard = true; routeNet(rec); hard = false;
        }
        yield progress("Verify", {routed: routedCount(), total});
      }
      // A final pass removes any connection that still violates (normally none).
      for (const rec of order) {
        if (!rec.marked) continue;
        const bad = verifyRec(rec);
        if (!bad.length) continue;
        mark(rec, -1);
        const which = new Set(bad.map(b => b.d.p).filter(Boolean)), all = bad.some(b => !b.d.p);
        for (const p of rec.conns) { if (p.path && (all || which.has(p))) { p.path = null; conns[p.ci].reason = "Could not keep clearance"; } }
        mark(rec, 1);
      }
      stats.passes.push({name: "Verify", ms: now() - t, routed: routedCount()});
    }

    // ---- result
    const tracks = [], vias = [], failed = [];
    let length = 0;
    for (const rec of order) {
      if (!rec.marked) continue;
      geometry(rec);
      for (const p of rec.conns) {
        const c = conns[p.ci];
        if (!p.path) { failed.push({conn: c.i, net: rec.n, a: c.a, b: c.b, reason: c.reason || "Unrouted"}); continue; }
        for (const line of p.lines) {
          tracks.push({net: rec.n, layer: line.l, points: line.pts, width: nets[rec.n].w, conn: c.i});
          for (let i = 1; i < line.pts.length; i++) length += Math.hypot(line.pts[i][0] - line.pts[i - 1][0], line.pts[i][1] - line.pts[i - 1][1]);
        }
      }
      for (const v of rec.vias) vias.push({net: rec.n, x: v.x, y: v.y, d: nets[rec.n].vd, drill: nets[rec.n].vh});
    }
    stats.pairs = pairs.map(pr => {
      const a = recs[pr.p], b = recs[pr.n];
      if (!a?.marked || !b?.marked || !a.segs.length || !b.segs.length) return {p: pr.p, n: pr.n, coupled: 0, length: 0};
      const D = pitchOf(pr.n, pr.p);
      let total = 0, near = 0;
      for (const s of b.segs) {
        const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), k = Math.max(1, Math.ceil(len / (g / 2)));
        for (let i = 0; i < k; i++) {
          const t = (i + 0.5) / k, x = s.a[0] + (s.b[0] - s.a[0]) * t, y = s.a[1] + (s.b[1] - s.a[1]) * t;
          let m = INF;
          for (const q of a.segs) if (q.l === s.l) m = Math.min(m, ptSeg2(x, y, q.a[0], q.a[1], q.b[0], q.b[1]));
          total += len / k;
          if (Math.sqrt(m) <= D + g * 0.8) near += len / k;
        }
      }
      return {p: pr.p, n: pr.n, coupled: total ? near / total : 0, length: total, pitch: D};
    });
    stats.ms = now() - T0;
    stats.grid = {pitch: g, width: W, height: H, layers: L, nodes: NL, bytes: NL * (Owner.BYTES_PER_ELEMENT + 10 + (couple ? 1 : 0)) + N2 * (Owner.BYTES_PER_ELEMENT + 3)};
    stats.routed = total - failed.length; stats.total = total; stats.length = length; stats.vias = vias.length;
    hp.free();
    return {type: "result", tracks, vias, failed, stats};
  }

  // Run a job synchronously (tests, workers).
  function runSync(job, onProgress) {
    const it = route(job);
    for (;;) {
      const s = it.next();
      if (s.done) return s.value;
      if (onProgress) onProgress(s.value);
    }
  }
  return {route, runSync, geometry: {coreDist, shapeDist, ptCore, box, inside, ptSeg2, segSeg2, bucketIndex}};
}


// Worker entry: answers {type:"route", job} with progress and one result. It is
// serialised into a Blob together with AtriumRouteCore, so it must not close
// over anything.
function AtriumRouteServe(scope, core) {
  "use strict";
  scope.onmessage = event => {
    const msg = event.data || {};
    if (msg.type !== "route") return;
    try {
      const job = msg.job;
      job.options = {...(job.options || {}), yieldMs: 100};
      const it = core.route(job);
      let last = 0;
      // Landed-route deltas of progress events that are not posted are merged into the next one.
      const pending = new Map();
      for (;;) {
        const step = it.next();
        if (step.done) { scope.postMessage({type: "result", id: msg.id, value: step.value}); break; }
        for (const d of step.value.landed || []) pending.set(d.net, d);
        const t = Date.now();
        if (t - last > 90) {
          last = t;
          const value = pending.size ? {...step.value, landed: [...pending.values()]} : step.value;
          pending.clear();
          scope.postMessage({type: "progress", id: msg.id, value});
        }
      }
    } catch (error) {
      scope.postMessage({type: "error", id: msg.id, message: String(error && error.stack || error)});
    }
  };
  scope.postMessage({type: "ready"});
}

globalThis.AtriumAutorouter = (() => {
  const core = AtriumRouteCore();
  const G = core.geometry;
  const scriptURL = globalThis.document?.currentScript?.src || globalThis.document?.baseURI || globalThis.location?.href;
  const A = () => globalThis.Atrium;
  const RULE_ALIASES = {Clearance: "clearance", Width: "width", RoutingVias: "viaStyle", FanoutControl: "fanoutControl",
    RoutingLayers: "routingLayers", RoutingCorners: "routingCorners", DiffPairsRouting: "diffPairsRouting", RoutingPriority: "routingPriority",
    MinimumAnnularRing: "annularRing", HoleToHoleClearance: "holeToHole"};
  // net-intent.js (isSupply) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const POWER_RE = /^(?:[AD]?GND|GND\w*|P?GND\w*|VSS\w*|VDD\w*|VCC\w*|VEE\w*|VBAT\w*|VBUS\w*|VIN|VSYS|VREF\w*|AVDD\w*|DVDD\w*|PWR\w*|\+?\d+V\d*\w*|\d+V\d+|V\d+(?:V\d+)?|[+-]\d+(?:\.\d+)?V)$/i;
  const POWER = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isSupply ? N.isSupply(String(n ?? "")) : POWER_RE.test(n); }};

  // ---------------------------------------------------------------- rules
  // Rule access that works with the current AtriumRules and with versions that
  // take Altium rule names; every miss falls back to the caller's default.
  function queriedViaLimits(rules, net) {
    const subject = {net}, style = rules.query("viaStyle", subject);
    return A().viaLimits({land:style,hole:style,diameter:style?.diameterPreferred,drill:style?.holePreferred},
      rules.query("holeSize", subject), rules.query("annularRing", subject));
  }
  function rulesFor(board, project) {
    const R = globalThis.AtriumRules;
    let resolve = null;
    try { if (R?.resolver) resolve = R.resolver(board, {project}); } catch { resolve = null; }
    const cache = new Map();
    function query(type, o = {}) {
      const key = type + "\u0000" + (o.net || "") + "\u0000" + (o.net2 ?? "\u0001") + "\u0000" + (o.layer || "");
      if (cache.has(key)) return cache.get(key);
      let out = null;
      const names = [RULE_ALIASES[type] || type, type];
      for (const t of names) {
        try { out = resolve ? resolve(t, o) : R?.query ? R.query(board, t, {...o, project}) : null; } catch { out = null; }
        if (out) break;
      }
      cache.set(key, out);
      return out;
    }
    const safe = fn => { try { return fn() || null; } catch { return null; } };
    const viaLimits = resolve?.viaLimits || (R ? net => queriedViaLimits({query}, net) : () => ({}));
    return {
      available: !!R,
      viaLimits, query,
      permitsVia(net, style, at, span) { return A().viaSize([viaLimits(net,style,at,span)],style,true).legal; },
      diffPairs: () => safe(() => R?.diffPairs?.(board, {project})) || [],
      netClasses: () => safe(() => R?.netClasses?.(board, {project})) || {}
    };
  }

  // ---------------------------------------------------------------- layers
  const copperIndex = name => globalThis.AtriumPCBAppearance.index(name);
  function boardLayers(doc, defs) {
    let list = null;
    try { list = globalThis.AtriumStackup?.copperLayers?.(doc, defs); } catch { list = null; }
    if (!list?.length) try { list = globalThis.AtriumCanvas?.routingLayers?.(doc, defs); } catch { list = null; }
    if (!list?.length) {
      const s = new Set(["Top", "Bottom"]);
      for (const i of doc.items) for (const k of [i.layer, i.fromLayer, i.toLayer]) if (copperIndex(k) >= 0) s.add(k);
      list = [...s];
    }
    return [...new Set(list)].filter(k => copperIndex(k) >= 0).sort((a, b) => copperIndex(a) - copperIndex(b));
  }
  // Copper layers the stackup marks as planes; the router leaves them to pours.
  function planeLayers(doc, defs) {
    try {
      const st = globalThis.AtriumStackup?.get?.(doc, defs);
      return (st?.layers || []).filter(l => l.type === "Plane" && l.key).map(l => l.key);
    } catch { return []; }
  }
  // Situs-style alternating preferred directions. Top is horizontal.
  const defaultDirections = layers => layers.map((_, i) => layers.length === 1 ? 2 : i % 2);

  // ---------------------------------------------------------------- shapes
  function padShape(p,parent,layer){
    const L=AtriumResolvedLand,land=L.geometry(p,layer);
    if(!land||land.holeOnly)return null;
    const {at,angle,mirror}=L.place(land,parent),{core,r}=L.core(land,at,angle,mirror);
    return {k:core.length===1?0:core.length===2?1:2,c:core.flat(),r};
  }
  function padCentre(shape) {
    const c = shape.c, n = c.length >> 1;
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { x += c[2 * i]; y += c[2 * i + 1]; }
    return [x / n, y / n];
  }
  // Copper and keep-out of a board as plain shapes. Callback per object:
  // fn({shape, layers:"all"|[names]|{from,to}, net, kind, id, item, parent, pad, hole})
  function eachCopper(doc, defs, fn) {
    const At = A(), {padLayer,padPlanes} = globalThis.AtriumPCBAppearance;
    const copper = () => globalThis.AtriumStackup?.copperLayers(doc,defs) || ["Top","Bottom"];
    const isCopper = k => copperIndex(k) >= 0;
    const keep = k => k === "Keepout" || /keep.?out/i.test(k || "");
    function viaLayers(i) {
      if (!i.fromLayer && !i.toLayer) return "all";
      return {from: i.fromLayer || "Top", to: i.toLayer || "Bottom"};
    }
    function pad(p, parent, slot) {
      const layer = padLayer(parent, p), id = parent?.id || p.id;
      const net = parent && Object.hasOwn(parent.pinNets || {}, p.number) ? parent.pinNets[p.number] : p.net || "";
      const w = p.w ?? p.diameter, h = p.h ?? p.diameter;
      if (!(w > 0 && h > 0)) return;
      const plated = p.plated !== false && !(p.drill >= Math.min(w, h) - 1e-9) && !/^mechanical/i.test(layer);
      if (p.drill > 0 && !plated) {
        const c = parent ? At.world([p.x, p.y], parent) : [p.x, p.y];
        fn({shape: {k: 0, c, r: p.drill / 2}, layers: "all", net: "", kind: "hole", id, item: p, parent, slot});
        return;
      }
      if (p.kind === "via") { fn({shape: padShape({...p, w, h, shape: "round"}, parent), layers: viaLayers(p), net, kind: "via", id, item: p, parent, slot}); return; }
      if(layer!=="Multi"&&!isCopper(layer))return;
      for(const key of padPlanes(p,layer,copper)){
        const shape=padShape(p,parent,key), plane=key??layer;
        if(shape)fn({shape,layers:plane==="Multi"?"all":[plane],net,kind:"pad",id,item:p,parent,slot,pad:true});
      }
    }
    function line(s, parent, id, net, slot) {
      const layer = s.layer || parent?.layer;
      const ko = keep(layer) || s.keepout === true && isCopper(layer);
      if (s.cutout || !ko && !isCopper(layer)) return;
      const points = AtriumGeometryCurves.pathPoints(s, .001);
      if (!points || points.length < 2) return;
      const pts = parent ? points.map(q => At.world(q, parent)) : points;
      const layers = keep(layer) ? "all" : [layer];
      if (s.fill && pts.length >= 3) { fn({shape: {k: 3, c: pts.flat(), r: (s.width || 0) / 2}, layers, net: ko ? "" : net, kind: ko ? "keepout" : "fill", id, item: s, parent, slot}); return; }
      const r = (s.width || 0) / 2, count = pts.length + (s.closed ? 1 : 0);
      for (let j = 1; j < count; j++) fn({shape: {k: 1, c: [...pts[j - 1], ...pts[j % pts.length]], r}, layers, net: ko ? "" : net, kind: ko ? "keepout" : s.kind === "track" ? "track" : "fill", id, item: s, parent, slot, seg: j - 1});
    }
    for (const i of doc.items) {
      if (i.kind === "track") line(i, null, i.id, i.net || "", 0);
      else if (i.kind === "graphic") line(i, null, i.id, i.net || "", 0);
      else if (i.kind === "via") fn({shape: {k: 0, c: [i.x, i.y], r: i.diameter / 2}, layers: viaLayers(i), net: i.net || "", kind: "via", id: i.id, item: i});
      else if (i.kind === "pad") pad(i, null, 0);
      else if (i.kind === "part") {
        const fp = defs.get(i.def)?.footprint;
        if (!fp) continue;
        (fp.pads || []).forEach((p, j) => pad(p, i, "pad" + j));
        (fp.shapes || []).forEach((s, j) => { if (s.points && (s.layer && (isCopper(s.layer) || keep(s.layer)))) line(s, i, i.id, "", "shape" + j); });
      }
    }
  }

  function outlineOf(doc, defs) {
    const At = A();
    if (doc.outline?.length >= 3 && At.validOutline?.(doc.outline) !== false) return doc.outline.map(p => [p[0], p[1]]);
    return null;
  }
  function boundsOf(doc, defs, outline) {
    const At = A();
    if (outline) return At.bounds(outline);
    const b = At.docBounds(doc, defs);
    return [b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2];
  }

  // Width, clearance, via and layer constraints of one net from the rules.
  const num = (v, d) => Number.isFinite(v) && v > 0 ? v : d;
  // A Clearance rule's routeGap (rules.js) covers its object-kind matrix cells for new copper.
  const gapOf = r => r ? r.routeGap ?? r.gap : undefined;
  function netStyle(rules, layers, options = {}, allNets = null) {
    const baseClr = num(gapOf(rules.query("clearance", {net: "", net2: ""})), num(options.clearance, 0.2));

    const all = (allNets || []).filter(Boolean), many = all.length > 250;
    const allMask = (1 << layers.length) - 1;
    const cache = new Map();
    const fn = name => {
      if (cache.has(name)) return cache.get(name);
      let c = num(gapOf(rules.query("clearance", {net: name, net2: ""})), baseClr);
      if (!many && name) for (const other of all) { if (other !== name) { const r = gapOf(rules.query("clearance", {net: name, net2: other})); if (r > c) c = r; } }
      const wr = rules.query("width", {net: name, layer: layers[0]});
      let w = num(options.width, num(wr?.preferred, num(wr?.min, 0.25)));
      if (wr?.max > 0 && w > wr.max) w = wr.max;
      const limits = rules.viaLimits?.(name) ?? queriedViaLimits(rules,name);
      const diameter = num(options.viaDiameter,null),drill = num(options.viaDrill,null);
      const configured = {minDiameter:diameter,maxDiameter:diameter,minDrill:drill,maxDrill:drill};
      const fallback={diameter:diameter??.6,drill:drill??.3,landGap:.3};
      const selected={...limits,diameter:diameter??limits.diameter,drill:drill??limits.drill};
      // Keep the stock fallback of boards opened without a design-rule module.
      const via=!globalThis.AtriumRules && rules.available===false && rules.viaLimits
        ? A().viaSize([configured],fallback) : A().preferredViaSize([selected,configured],fallback);
      const lr = rules.query("routingLayers", {net: name});
      const excluded = Array.isArray(lr?.excluded) ? lr.excluded : [];
      const lm = layers.reduce((m, l, k) => excluded.includes(l) ? m : m | (1 << k), 0);
      const pr = rules.query("routingPriority", {net: name});
      const out = {w, c, vd:via.diameter, vh:via.drill, vias:via.legal, lm: lm || allMask, priority: pr?.value || 0};
      cache.set(name, out);
      return out;
    };
    fn.baseClr = baseClr;
    return fn;
  }

  function copperMask(span, layers, layerBit, allMask) {
    if (span === "all") return allMask;
    if (Array.isArray(span)) return span.reduce((m, layer) => m | (layerBit.get(layer) || 0), 0);
    // Keep the conservative routing obstacle for incomplete, equal or unknown endpoints.
    const [lo, hi] = globalThis.AtriumPCBAppearance.copperInterval(span.from, span.to);
    return layers.reduce((mask, layer, i) => {
      const n = copperIndex(layer);
      return n >= lo && n <= hi ? mask | (1 << i) : mask;
    }, 0);
  }

  // ---------------------------------------------------------------- job
  // Turns a board into a routing job. scope: {nets?:Set|Array, connections?:[{from,to}],
  // components?:Set|Array of part ids, area?:[x0,y0,x1,y1]}.
  function prepare(doc, defs, options = {}) {
    const At = A();
    if (doc.kind !== "pcb") throw Error("Choose a PCB layout to route.");
    const notes = [];
    const rules = rulesFor(doc, options.project);
    if (!rules.available) notes.push("Design rules module is not loaded; built-in defaults are used.");
    let layers = boardLayers(doc, defs);
    const planes = planeLayers(doc, defs);
    if (!options.layers?.length && planes.length && layers.some(l => !planes.includes(l))) {
      layers = layers.filter(l => !planes.includes(l));
      notes.push("Plane layers " + planes.join(", ") + " are left to plane pours and not used for routing.");
    }
    if (options.layers?.length) layers = [...new Set(options.layers)].filter(l => copperIndex(l) >= 0).sort((a, b) => copperIndex(a) - copperIndex(b));
    if (!layers.length) throw Error("No copper layers are enabled for routing.");
    // Layer masks are 32-bit: at most 30 routing layers (outer two kept). Use options.layers to pick others.
    if (layers.length > 30) { notes.push("The autorouter routes on at most 30 copper layers; it used " + layers.slice(0, 29).concat(layers.at(-1)).join(", ") + "."); layers = layers.slice(0, 29).concat(layers.at(-1)); }
    const layerBit = new Map(layers.map((l, i) => [l, 1 << i]));
    const allMask = (1 << layers.length) - 1;

    // nets
    const names = new Set();
    for (const i of doc.items) { if (i.net) names.add(i.net); if (i.kind === "part") for (const n of Object.values(i.pinNets || {})) if (n) names.add(n); }
    const netNames = ["", ...[...names].sort()];
    const netId = new Map(netNames.map((n, i) => [n, i]));
    const style = netStyle(rules, layers, options, netNames);
    const baseClr = style.baseClr;
    const nets = netNames.map((name, i) => ({name, ...style(name), group: i}));

    // obstacles
    const obstacles = [], byId = new Map(), holes = [], holeSeen = new Set();
    eachCopper(doc, defs, o => {
      // Drilled holes for the hole-to-hole rule: unplated holes, plated pads and vias.
      const drill = o.kind === "hole" ? 2 * o.shape.r : (o.kind === "via" || o.kind === "pad") ? +(o.item?.drill || 0) : 0;
      if (drill > 0) {
        const c = o.shape.k === 0 ? o.shape.c : padCentre(o.shape), key = c[0].toFixed(4) + "," + c[1].toFixed(4);
        if (!holeSeen.has(key)) { holeSeen.add(key); holes.push([c[0], c[1], drill / 2]); }
      }
      const lm = copperMask(o.layers, layers, layerBit, allMask);
      if (!lm && o.kind !== "hole") return;
      const id = netId.get(o.net) ?? 0;
      const rec = {k: o.shape.k, c: o.shape.c, r: o.shape.r, lm: lm || allMask, net: o.kind === "keepout" || o.kind === "hole" ? 0 : id, clr: nets[id]?.c ?? baseClr};
      if (o.kind === "keepout" && o.item.keepoutRestrictions != null) {
        if (!At.keepoutBlocks(o.item,"track") && !At.keepoutBlocks(o.item,"via")) return;
        rec.blockTrack = At.keepoutBlocks(o.item,"track"); rec.blockVia = At.keepoutBlocks(o.item,"via");
      }
      obstacles.push(rec);
      if (!byId.has(o.id)) byId.set(o.id, []);
      byId.get(o.id).push({index: obstacles.length - 1, kind: o.kind, pad: !!o.pad, shape: o.shape, net: o.net, label: o.parent ? o.parent.ref + "." + (o.item.number ?? "?") : o.kind === "pad" ? "Pad " + (o.item.number || "") : o.kind});
    });

    // connections from the ratsnest
    const C = globalThis.AtriumConnectivity;
    if (!C) throw Error("Connectivity is unavailable in this build.");
    const inspected = C.inspect(doc, defs);
    let airwires = inspected.airwires;
    const scope = options.scope || {};
    const asSet = v => v instanceof Set ? v : new Set(v || []);
    if (scope.nets) { const s = asSet(scope.nets); airwires = airwires.filter(a => s.has(a.net)); }
    if (scope.components) { const s = asSet(scope.components); airwires = airwires.filter(a => s.has(a.fromId) || s.has(a.toId)); }
    if (scope.area) {
      const [x0, y0, x1, y1] = scope.area, inA = p => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
      airwires = airwires.filter(a => inA(a.from) && inA(a.to));
    }
    if (scope.connections) {
      const k = (a, b) => a.map(v => v.toFixed(4)).join(",") + "|" + b.map(v => v.toFixed(4)).join(",");
      const want = new Set(scope.connections.flatMap(c => [k(c.from, c.to), k(c.to, c.from)]));
      airwires = airwires.filter(a => want.has(k(a.from, a.to)));
    }
    airwires = airwires.filter(a => netId.has(a.net) && netId.get(a.net) > 0);
    // Copper islands of each net, so a connection may start anywhere on an
    // island (a fanout via, an existing track end) and not only at its anchor.
    const meta = [];
    byId.forEach(list => { for (const e of list) meta[e.index] = e; });
    const parent = obstacles.map((_, i) => i);
    const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    {
      const b = At.bounds(obstacles.flatMap(o => { const q = G.box(o); return [[q[0], q[1]], [q[2], q[3]]]; })) || [0, 0, 1, 1];
      const idx = G.bucketIndex(b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1, 2);
      obstacles.forEach((o, i) => { if (o.net > 0) idx.add({k: o.k, c: o.c, r: o.r, i, net: o.net, lm: o.lm}); });
      for (const rec of idx.all) idx.query(rec.bb, 1e-6, other => {
        if (other.i <= rec.i || other.net !== rec.net || !(other.lm & rec.lm)) return false;
        if (G.shapeDist(rec, other) <= 1e-6) parent[root(other.i)] = root(rec.i);
        return false;
      });
    }
    const islandMembers = new Map();
    obstacles.forEach((o, i) => {
      if (o.net <= 0) return;
      const r = root(i), m = meta[i];
      if (!islandMembers.has(r)) islandMembers.set(r, []);
      const list = islandMembers.get(r);
      if (m?.pad || m?.kind === "via") list.push({obs: i, x: o.k === 0 ? o.c[0] : (G.box(o)[0] + G.box(o)[2]) / 2, y: o.k === 0 ? o.c[1] : (G.box(o)[1] + G.box(o)[3]) / 2, lm: o.lm, pad: true});
      else if (o.k === 1) { list.push({obs: i, x: o.c[0], y: o.c[1], lm: o.lm, pad: false}); list.push({obs: i, x: o.c[2], y: o.c[3], lm: o.lm, pad: false}); }
    });
    const terms = [], termKey = new Map(), conns = [], skipped = [];
    function terminal(id, at, net, label) {
      const list = byId.get(id) || [];
      let best = null, bestScore = Infinity;
      for (const e of list) {
        if (e.net !== net) continue;
        const d = G.ptCore(at[0], at[1], e.shape) - e.shape.r;
        if (d > 1e-4) continue;
        const score = (e.pad ? 0 : e.kind === "via" ? 1 : 2) + Math.max(0, d);
        if (score < bestScore) { bestScore = score; best = e; }
      }
      if (!best) return -1;
      const key = best.index + ":" + at[0].toFixed(5) + "," + at[1].toFixed(5);
      if (termKey.has(key)) return termKey.get(key);
      const island = islandMembers.get(root(best.index)) || [];
      let members = island.length > 1 ? island.slice().sort((a, b) => Math.hypot(a.x - at[0], a.y - at[1]) - Math.hypot(b.x - at[0], b.y - at[1])).slice(0, 24) : null;
      if (members) {
        const seen = new Set();
        members = members.filter(m => { const k = m.obs + ":" + m.x.toFixed(5) + "," + m.y.toFixed(5); return !seen.has(k) && seen.add(k); });
        // pads keep their own centre as the access point
        for (const m of members) if (m.pad && meta[m.obs]?.pad) { const c = padCentre(meta[m.obs].shape); m.x = c[0]; m.y = c[1]; }
      }
      const lm = members ? members.reduce((v, m) => v | m.lm, 0) : obstacles[best.index].lm;
      terms.push({obs: best.index, x: at[0], y: at[1], lm, pad: best.pad || best.kind === "via", label: label || best.label, members});
      termKey.set(key, terms.length - 1);
      return terms.length - 1;
    }
    for (const a of airwires) {
      const n = netId.get(a.net), ta = terminal(a.fromId, a.from, a.net, a.fromLabel), tb = terminal(a.toId, a.to, a.net, a.toLabel);
      if (ta < 0 || tb < 0) { skipped.push(a); continue; }
      if (!(nets[n].lm & terms[ta].lm) && !(nets[n].lm & terms[tb].lm)) { skipped.push(a); continue; }
      conns.push({net: n, a: ta, b: tb, wire: a});
    }
    if (skipped.length) notes.push(skipped.length + " connection" + (skipped.length === 1 ? "" : "s") + " could not be matched to copper and were skipped.");

    const outline = outlineOf(doc, defs);
    if (!outline) notes.push("The board has no outline; routing is limited to the design extents.");
    if (doc.items.some(i => i.kind === "polygon" && !i.shelved)) notes.push("Polygon pours are not obstacles for the router; repour polygons after routing.");
    const bounds = boundsOf(doc, defs, outline);
    const directions = options.directions?.length === layers.length ? options.directions : defaultDirections(layers);
    const job = {
      layers, layerDir: directions, bounds, outline: outline ? outline.flat() : null, cutouts: (globalThis.AtriumBoardShape?.holes?.(doc) || []).filter(h => h.length >= 3).map(h => h.flat()),
      edgeClearance: num(options.edgeClearance, Math.max(baseClr, 0.25)), defaultClearance: baseClr,
      holes, holeGap: options.holeToHole === false ? 0 : num(rules.query("holeToHole", {})?.gap, rules.available ? 0.254 : 0),
      nets: nets.map(n => ({w: n.w, c: n.c, vd: n.vd, vh: n.vh, vias:n.vias, lm: n.lm, priority: n.priority, group: n.group})),
      obstacles, terms, conns: conns.map(c => ({net: c.net, a: c.a, b: c.b})), options: {...(options.router || {})}
    };
    const corners = rules.query("routingCorners", {});
    if (corners && job.options.recorner === undefined) {
      if (corners.style === "90") { job.options.recorner = false; job.options.bend90 ??= 0.3; }
      if (Number.isFinite(corners.setbackMax) && corners.setbackMax > 0) job.options.setback ??= corners.setbackMax;
    }
    if (options.diffPairs !== false) {
      const list = [];
      for (const dp of rules.diffPairs()) {
        const p = netId.get(dp.positive), n = netId.get(dp.negative);
        if (!(p > 0 && n > 0)) continue;
        const r = rules.query("diffPairsRouting", {net: dp.positive, layer: layers[0]}) || {};
        const w = num(r.widthPreferred, num(r.widthMin, job.nets[p].w)), gap = num(r.gapPreferred, num(r.gapMin, job.nets[p].c));
        job.nets[p].w = job.nets[n].w = w;
        list.push({p, n, gap, name: dp.name});
      }
      if (list.length) job.pairs = list;
    }
    if (!rules.available) notes.push("Clearance " + baseClr + " mm and track width " + nets[0].w + " mm are built-in defaults.");
    return {job, board:doc, netNames, nets, layers, conns, notes, inspected, rules, baseClr};
  }

  // ---------------------------------------------------------------- plan
  const round = v => Math.round(v * 1e7) / 1e7;
  function plan(prep, result, options = {}) {
    const At = A(), add = [];
    const newId = () => At.id(), invalid = new Set();
    for (const v of result.vias) {
      const net = prep.netNames[v.net], at = [round(v.x),round(v.y)];
      if (prep.rules?.permitsVia && !prep.rules.permitsVia(net,{diameter:v.d,drill:v.drill},at)) invalid.add(v.net);
    }
    // A rule can depend on the final position. Withhold its entire net, keeping the original copper.
    const dropped = invalid.size ? prep.conns.flatMap((c,conn) => invalid.has(c.net) ? [{net:c.net,conn,reason:"No legal via diameter and drill at the proposed location."}] : []) : [];
    const failed = dropped.length ? [...result.failed.filter(f => !invalid.has(f.net)),...dropped] : result.failed;
    for (const t of result.tracks) {
      if (invalid.has(t.net)) continue;
      const pts = t.points.map(p => [round(p[0]), round(p[1])]).filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
      if (pts.length < 2) continue;
      add.push({id: newId(), kind: "track", points: pts, width: t.width, layer: prep.layers[t.layer], net: prep.netNames[t.net]});
    }
    for (const v of result.vias) if (!invalid.has(v.net)) add.push({id: newId(), kind: "via", x: round(v.x), y: round(v.y), diameter: v.d, drill: v.drill, layer: "Multi", net: prep.netNames[v.net]});
    const failures = failed.map(f => {
      const c = prep.conns[f.conn];
      return {net: prep.netNames[f.net], from: c.wire.from, to: c.wire.to, fromId: c.wire.fromId, toId: c.wire.toId,
        fromLabel: c.wire.fromLabel, toLabel: c.wire.toLabel, reason: f.reason};
    });
    const s = result.stats;
    let remove = options.remove || [];
    if (invalid.size && remove.length) {
      const names = new Set([...invalid].map(n => prep.netNames[n]));
      const keep = new Set((options.original || prep.board).items.filter(i => names.has(i.net)).map(i => i.id));
      remove = remove.filter(id => !keep.has(id));
    }
    let length = s.length;
    if (invalid.size) {
      length = 0;
      for (const item of add) if (item.kind === "track") for (let k = 1; k < item.points.length; k++) {
        const a = item.points[k-1], b = item.points[k]; length += Math.hypot(b[0]-a[0],b[1]-a[1]);
      }
    }
    return {add, remove, report: {routed: s.total-failures.length, total: s.total, vias: invalid.size ? add.filter(i=>i.kind==="via").length : s.vias, length, failures,
      ms: s.ms, passes: s.passes, iterations: s.iterations, grid: s.grid, expansions: s.expansions, notes: prep.notes,
      pairs: (s.pairs || []).filter(q=>!invalid.has(q.p) && !invalid.has(q.n)).map(q => ({positive: prep.netNames[q.p], negative: prep.netNames[q.n], coupled: q.coupled, length: q.length, pitch: q.pitch}))}};
  }
  // Apply an edit plan to a board document in place.
  function apply(doc, editPlan) {
    if (editPlan.remove?.length) { const gone = new Set(editPlan.remove); doc.items = doc.items.filter(i => !gone.has(i.id)); }
    for (const item of editPlan.add) doc.items.push(item);
  }

  // ---------------------------------------------------------------- strategies
  const STRATEGIES = [
    {id: "default2", name: "Default 2 Layer Board", description: "Short connections, then main rip-up and reroute with Top horizontal and Bottom vertical, completion, straighten and 45° recorner.",
      layers: 2, passes: ["Short connections", "Main (negotiated rip-up and reroute)", "Completion", "Straighten", "Recorner 45°", "Clearance verify"], router: {viaCost: 12, againstCost: 0.6}},
    {id: "multi", name: "Default Multi Layer Board", description: "Fanout of fine-pitch and BGA parts, short connections, main rip-up and reroute with alternating layer directions, completion, straighten and recorner.",
      fanout: true, passes: ["Fanout (BGA and fine pitch)", "Short connections", "Main (negotiated rip-up and reroute)", "Completion", "Straighten", "Recorner 45°", "Clearance verify"], router: {viaCost: 8, againstCost: 1.0}},
    {id: "orthogonal", name: "Orthogonal (strict layer directions)", description: "Strongly prefers each layer's direction; fewer diagonal tracks, more vias. Suits buses and dense digital boards.",
      passes: ["Short connections", "Main (negotiated rip-up and reroute)", "Completion", "Straighten", "Clearance verify"], router: {viaCost: 6, againstCost: 2.5, diagCost: 0.6}},
    {id: "dense", name: "Dense (fine grid)", description: "Quarter-pitch grid for fine-pitch parts and tight channels. Slower and uses more memory.",
      fanout: true, passes: ["Fanout (BGA and fine pitch)", "Short connections", "Main (negotiated rip-up and reroute)", "Completion", "Straighten", "Recorner 45°", "Clearance verify"], router: {gridDiv: 3, viaCost: 8}},
    {id: "single", name: "Single layer (no vias)", description: "Routes on the current layers without vias. Useful for one-sided boards and jumpers.",
      passes: ["Main (negotiated rip-up and reroute)", "Completion", "Straighten", "Recorner 45°", "Clearance verify"], router: {vias: false}}
  ];

  // ---------------------------------------------------------------- execution
  function workerSource() {
    return '"use strict";\n' + AtriumRouteCore.toString() + "\n" + AtriumRouteServe.toString() +
      "\nAtriumRouteServe(self, AtriumRouteCore((" + globalThis.AtriumGeometry.create.toString() + ")()));\n";
  }

  let workerBroken = false;
  function makeWorker() {
    if (workerBroken || typeof Worker !== "function") return null;
    try {
      if (typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
        const url = URL.createObjectURL(new Blob([workerSource()], {type: "text/javascript"}));
        try { return new Worker(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
      }
    } catch { /* blob workers may be blocked */ }
    try { if (scriptURL) return new Worker(new URL("../workers/autorouter-worker.js", scriptURL).href); } catch { /* fall back */ }
    return null;
  }
  // Runs a job; returns {promise, cancel}. Uses a Worker when possible, otherwise
  // time-slices the generator on the UI thread.
  function run(job, {onProgress, foreground = false} = {}) {
    let cancelled = false, worker = null, timer = null, rejectRun = null;
    const promise = new Promise((resolve, reject) => {
      rejectRun = reject;
      const fore = () => {
        job.options = {...(job.options || {}), yieldMs: 12};
        const it = core.route(job);
        const slice = () => {
          if (cancelled) return;
          const end = Date.now() + 14;
          try {
            while (Date.now() < end) {
              const s = it.next();
              if (s.done) { resolve(s.value); return; }
              onProgress?.(s.value);
            }
          } catch (error) { reject(error); return; }
          timer = setTimeout(slice, 0);
        };
        slice();
      };
      if (!foreground) worker = makeWorker();
      if (!worker) { fore(); return; }
      let ready = false;
      const fallback = setTimeout(() => { if (!ready) { worker.terminate(); worker = null; workerBroken = true; fore(); } }, 4000);
      worker.onmessage = ({data}) => {
        if (data.type === "ready") { ready = true; clearTimeout(fallback); worker.postMessage({type: "route", id: 1, job}); return; }
        if (data.type === "progress") onProgress?.(data.value);
        else if (data.type === "result") { worker.terminate(); worker = null; resolve(data.value); }
        else if (data.type === "error") { worker.terminate(); worker = null; reject(Error(data.message)); }
      };
      worker.onerror = e => {
        e.preventDefault?.();
        clearTimeout(fallback);
        if (worker) worker.terminate();
        worker = null;
        if (!ready) { workerBroken = true; fore(); } else reject(Error(e.message || "Autorouter worker failed."));
      };
    });
    return {promise, cancel() { cancelled = true; if (timer) clearTimeout(timer); if (worker) { worker.terminate(); worker = null; } rejectRun?.(Object.assign(Error("Routing cancelled."), {cancelled: true})); }};
  }

  // Synchronous convenience for tests and scripts: route a board, return the plan.
  function routeBoard(doc, defs, options = {}) {
    let fan = null, work = doc, remove = [];
    if (options.lockPreroutes === false) {
      remove = unlockedRoutes(doc, options.scope?.nets ? new Set(options.scope.nets) : null);
      const gone = new Set(remove);
      work = {...doc, items: doc.items.filter(i => !gone.has(i.id))};
    }
    if (options.fanout && globalThis.AtriumFanout) {
      fan = AtriumFanout.plan(doc, defs, {...options.fanoutOptions, project: options.project, auto: true});
      if (fan.add.length) work = {...doc, items: [...doc.items, ...fan.add]};
    }
    const prep = prepare(work, defs, options);
    const result = core.runSync(prep.job, options.onProgress);
    const out = plan(prep, result, {...options,remove,original:doc});
    if (fan) { out.add.unshift(...fan.add); out.report.fanout = fan.report; }
    return out;
  }

  // ---------------------------------------------------------------- scope helpers
  function selectionIds(ctx) {
    try { const s = typeof ctx.selection === "function" ? ctx.selection() : ctx.selectedIds; return new Set(s || []); } catch { return new Set(); }
  }
  // Nets, components and area implied by the editor selection.
  function fromSelection(doc, defs, ids) {
    const At = A(), nets = new Set(), parts = [], pts = [];
    for (const i of doc.items) {
      if (!ids.has(i.id)) continue;
      if (i.net) nets.add(i.net);
      if (i.kind === "part") { parts.push(i.id); for (const n of Object.values(i.pinNets || {})) if (n) nets.add(n); }
      const b = At.bounds(At.itemPoints(i, defs.get(i.def), "pcb") || []);
      if (b) pts.push([b[0], b[1]], [b[2], b[3]]);
    }
    return {nets: [...nets].sort(), components: parts, area: pts.length ? At.bounds(pts) : null};
  }
  // Unlocked tracks and vias of the nets in scope: removed when pre-routes are not locked.
  function unlockedRoutes(doc, nets) {
    return doc.items.filter(i => (i.kind === "track" || i.kind === "via") && !i.locked && i.net && (!nets || nets.has(i.net))).map(i => i.id);
  }

  // ---------------------------------------------------------------- dialog
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, fn, cls) { const b = el("button", text, cls); if (!b.classList.contains("ui-tab") && !b.classList.contains("ui-row")) b.classList.add("ui-button"); b.type = "button"; if (fn) b.onclick = fn; return b; }
  const fmt = v => (Math.round(v * 1000) / 1000) + " mm";
  function rulesSummary(doc, defs, project, layers) {
    const rules = rulesFor(doc, project), rows = [], warn = [];
    if (!rules.available) warn.push("Design rules are not loaded. The router uses 0.2 mm clearance, 0.25 mm tracks and 0.6/0.3 mm vias.");
    const q = (t, o) => rules.query(t, o || {});
    const c = q("clearance", {net: "", net2: ""}), w = q("width", {net: ""}), v = q("viaStyle", {net: ""}), rl = q("routingLayers", {net: ""}), rc = q("routingCorners", {}), fc = q("fanoutControl", {}), dp = q("diffPairsRouting", {});
    const style = netStyle(rules, layers, {}, []);
    const s0 = style("");
    rows.push(["Clearance", c ? fmt(c.gap) + " (" + (c.ruleName || "rule") + ")" : "missing — " + fmt(s0.c) + " used"]);
    if (!c) warn.push("No Clearance rule applies to all nets.");
    rows.push(["Width", w ? "preferred " + fmt(s0.w) + (w.min ? ", min " + fmt(w.min) : "") + (w.max ? ", max " + fmt(w.max) : "") : "missing — " + fmt(s0.w) + " used"]);
    if (w && w.preferred == null) warn.push("The Width rule has no preferred width; the minimum width is used for routing.");
    rows.push(["Routing Via Style", fmt(s0.vd) + " / " + fmt(s0.vh) + " hole" + (v ? "" : " (default)")]);
    const enabled = layers.filter(l => !(rl?.excluded || []).includes(l));
    rows.push(["Routing Layers", enabled.join(", ") || "none"]);
    if (!enabled.length) warn.push("The Routing Layers rule excludes every copper layer.");
    rows.push(["Routing Corners", rc ? (rc.style === "45" ? "45°" : rc.style === "90" ? "90°" : "Rounded (routed as 45°)") + ", setback " + fmt(rc.setbackMin ?? 0) : "45° (default)"]);
    rows.push(["Fanout Control", fc ? (fc.style || "auto") + ", " + (fc.direction || "alternating") : "Auto, alternating (default)"]);
    const pairs = rules.diffPairs();
    rows.push(["Differential Pairs", pairs.length ? pairs.length + " pair" + (pairs.length === 1 ? "" : "s") + (dp ? ", gap " + fmt(dp.gapPreferred ?? dp.gapMin) + ", width " + fmt(dp.widthPreferred ?? dp.widthMin) : "") : "none defined"]);
    const classes = Object.keys(rules.netClasses());
    rows.push(["Net Classes", classes.length ? classes.join(", ") : "none"]);
    if (!doc.outline?.length) warn.push("The board has no outline. Routing stays within the design extents.");
    return {rows, warn, rules};
  }

  // Engine choice (Route › Auto Route dialog, MCP "engine"). v1 stays the default until v2 wins
  // every benchmark (tests/autorouter-bench.cjs).
  const ENGINE_KEY = "atrium.autorouter.engine", DEFAULT_ENGINE = "v1";
  function engineDefault() { try { const v = localStorage.getItem(ENGINE_KEY); if (v === "v1" || v === "v2") return v; } catch { /* storage optional */ } return DEFAULT_ENGINE; }
  const V2_PASSES = ["Fanout v2 (escape layers, via-in-pad on HDI, plane vias)", "Criticality order (pairs, length groups, short first)", "Short connections",
    "Main (negotiated rip-up and reroute, hole-to-hole aware)", "Completion", "Via minimisation", "Straighten, recorner, 45° pad entries", "Clearance verify",
    "Retry (finer grid, global routing guides) if incomplete", "Push-and-shove completion", "Gloss, length tuning, teardrops", "Proposal preview"];
  let active = null;
  function open(ctx) {
    const doc = ctx.doc, defs = ctx.defs;
    if (doc?.kind !== "pcb") { ctx.info?.("Open a PCB layout to autoroute."); return; }
    if (active?.isConnected) { active.showModal?.(); return active; }
    // Engine v2 loads in the background while the dialog is open.
    const v2Ready = globalThis.AtriumAutorouterV2 ? Promise.resolve() : (globalThis.AtriumLazy?.need?.("AtriumAutorouterV2") || Promise.resolve()).catch(() => {});
    const preset = ctx.scope || ctx.autorouteScope || "all";
    const dlg = el("dialog", null, "ui-dialog work-dialog ar-dialog");
    dlg.setAttribute("aria-label", "Autorouter");
    active = dlg;
    const head = el("div", null, "ar-head");
    head.append(el("h2", "Routing Strategies", "ui-dialog-title"), el("small", doc.name));
    const body = el("div", null, "ui-dialog-body");
    dlg.append(head, body);

    // Rules summary (Situs "Routing Setup Report").
    const planes = planeLayers(doc, defs), layers = boardLayers(doc, defs);
    const signal = layers.filter(l => !planes.includes(l) || layers.every(k => planes.includes(k)));
    const summary = rulesSummary(doc, defs, ctx.project, signal);
    if (planes.length) summary.rows.push(["Plane layers", planes.join(", ") + " (not routed)"]);
    const rulesBox = el("details", null, "ar-rules");
    rulesBox.open = summary.warn.length > 0;
    rulesBox.append(el("summary", "Routing setup report" + (summary.warn.length ? " · " + summary.warn.length + " warning" + (summary.warn.length === 1 ? "" : "s") : "")));
    const dl = el("dl", null, "rule-properties");
    for (const [k, v] of summary.rows) dl.append(el("dt", k), el("dd", v));
    rulesBox.append(dl);
    for (const w of summary.warn) rulesBox.append(el("p", w, "ar-warn"));
    body.append(rulesBox);

    // Layer directions.
    const dirBox = el("div", null, "ar-layers");
    const dirs = defaultDirections(layers), dirSel = [];
    layers.forEach((l, i) => {
      const lab = el("label");
      const s = el("select", null, "ui-field");
      for (const [v, t] of [["0", "Horizontal"], ["1", "Vertical"], ["2", "Any direction"], ["off", "Not used"]]) s.add(new Option(t, v));
      s.value = signal.includes(l) ? String(dirs[i]) : "off";
      lab.append(el("span", globalThis.AtriumPCBAppearance?.name?.(l) || l), s);
      dirBox.append(lab);
      dirSel.push(s);
    });
    const addInner = button("Route on 4 layers", () => {
      for (const l of ["Inner 1", "Inner 2"]) if (!layers.includes(l)) layers.splice(layers.length - 1, 0, l);
      openAgain();
    }, "ar-small");
    function openAgain() {
      dirBox.replaceChildren();
      dirSel.length = 0;
      const d = defaultDirections(layers);
      layers.forEach((l, i) => {
        const lab = el("label"), s = el("select", null, "ui-field");
        for (const [v, t] of [["0", "Horizontal"], ["1", "Vertical"], ["2", "Any direction"], ["off", "Not used"]]) s.add(new Option(t, v));
        s.value = planes.includes(l) && signal.length < layers.length ? "off" : String(d[i]);
        lab.append(el("span", globalThis.AtriumPCBAppearance?.name?.(l) || l), s);
        dirBox.append(lab); dirSel.push(s);
      });
      addInner.hidden = layers.length > 2;
    }
    addInner.hidden = layers.length > 2;
    addInner.title = "Add Mid-Layer 1 and 2 to the layers the router may use (the stackup itself is not changed).";
    const layerHead = el("div", null, "ar-section-head");
    layerHead.append(el("h3", "Layer directions"), addInner);
    body.append(layerHead, dirBox);

    // Strategies.
    body.append(el("h3", "Strategy"));
    const list = el("div", null, "ui-list ar-strategies"); // checked library rows in a radio group
    list.setAttribute("role", "radiogroup");
    let strategy = signal.length > 2 ? "multi" : "default2";
    const passes = el("ol", null, "ar-passes");
    function showStrategy() {
      for (const b of list.children) b.setAttribute("aria-checked", String(b.dataset.id === strategy));
      const st = STRATEGIES.find(s => s.id === strategy);
      const v2 = engineSel.value === "v2";
      passes.replaceChildren(...(v2 ? V2_PASSES.filter(p => st.fanout || !/^Fanout/.test(p)) : st.passes).map(p => el("li", p)));
    }
    for (const st of STRATEGIES) {
      const b = button(null, () => { strategy = st.id; showStrategy(); }, "ui-row ar-strategy"), text = el("span", null, "ui-row-text");
      b.dataset.id = st.id; b.setAttribute("role", "radio");
      text.append(el("span", st.name, "ui-row-title"), el("span", st.description, "ui-row-detail")); b.append(text);
      list.append(b);
    }
    const stratWrap = el("div", null, "ar-strategy-wrap");
    const passWrap = el("div", null, "ar-pass-wrap");
    // Engine: v1 (classic) or v2 (fanout v2, global + detailed routing, via minimisation, a
    // proposal previewed on the board until Accept). The choice is remembered.
    const engineSel = el("select", null, "ui-field");
    engineSel.setAttribute("aria-label", "Routing engine");
    engineSel.add(new Option("Engine v1 (classic)", "v1"));
    engineSel.add(new Option("Engine v2 (proposal, fewer vias)", "v2"));
    engineSel.value = engineDefault();
    engineSel.title = "v2: fanout v2, criticality order, fine-grid rip-up and retry with hole-to-hole aware vias, via minimisation, 45° pad entries, retries, push-and-shove completion, gloss and length tuning. The result is previewed on the board until you accept it (one undo step).";
    engineSel.onchange = () => { try { localStorage.setItem(ENGINE_KEY, engineSel.value); } catch { /* storage optional */ } showStrategy(); };
    passWrap.append(el("span", "Passes", "ar-label"), passes, el("span", "Engine", "ar-label ar-engine-label"), engineSel);
    stratWrap.append(list, passWrap);
    body.append(stratWrap);
    showStrategy();

    // Options.
    const opts = el("div", null, "ar-checks");
    const check = (label, on, title) => { const l = el("label", null, "ar-check"), c = el("input", null, "ui-checkbox"); c.type = "checkbox"; c.checked = on; l.append(c, el("span", label)); if (title) l.title = title; opts.append(l); return c; };
    const lock = check("Lock all pre-routes", true, "Leave existing tracks and vias untouched. When off, unlocked routes of the nets being routed are ripped up and routed again.");
    const pairs = check("Route differential pairs as coupled pairs", true);
    const tear = check("Teardrops (engine v2)", false, "Add teardrops where the proposal's tracks meet pads and vias.");
    const limitWrap = el("label", null, "ar-check");
    const limit = el("input"); limit.type = "number"; limit.dataset.numericUnit = "s"; limit.min = "5"; limit.max = "3600"; limit.value = "120"; limit.className = "ar-num ui-field";
    limitWrap.append(el("span", "Time limit (s)"), limit);
    opts.append(limitWrap);
    body.append(opts);

    // Scope.
    body.append(el("h3", "Route"));
    const scopeBar = el("div", null, "ar-scope ui-tabs");
    scopeBar.setAttribute("role", "tablist");
    const scopes = [["all", "All"], ["net", "Net"], ["connection", "Connection"], ["component", "Component"], ["area", "Area"]];
    let scope = scopes.some(s => s[0] === preset) ? preset : "all";
    const scopeBody = el("div", null, "ar-scope-body");
    const sel = fromSelection(doc, defs, selectionIds(ctx));
    let inspected = null;
    try { inspected = globalThis.AtriumConnectivity?.inspect(doc, defs); } catch { inspected = null; }
    const airwires = inspected?.airwires || [];
    const unroutedNets = [...new Set(airwires.map(a => a.net))].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    const netSel = el("select"); netSel.multiple = true; netSel.size = 6;
    for (const n of unroutedNets) { const o = new Option(n + " (" + airwires.filter(a => a.net === n).length + ")", n); o.selected = sel.nets.includes(n); netSel.add(o); }
    const connSel = el("select"); connSel.multiple = true; connSel.size = 6;
    const selParts = new Set(sel.components);
    airwires.forEach((a, i) => { const o = new Option(a.net + ": " + a.fromLabel + " → " + a.toLabel, String(i)); o.selected = selParts.has(a.fromId) || selParts.has(a.toId); connSel.add(o); });
    const partList = doc.items.filter(i => i.kind === "part").sort((a, b) => String(a.ref).localeCompare(String(b.ref), undefined, {numeric: true}));
    const compSel = el("select"); compSel.multiple = true; compSel.size = 6;
    for (const p of partList) { const o = new Option(p.ref + " · " + (defs.get(p.def)?.footprint?.name || p.value || ""), p.id); o.selected = selParts.has(p.id); compSel.add(o); }
    const area = sel.area || (doc.outline?.length ? A().bounds(doc.outline) : [0, 0, 10, 10]);
    const areaFields = ["x1", "y1", "x2", "y2"].map((k, i) => { const f = el("input"); f.type = "number"; f.dataset.numericUnit = "mm"; f.step = "0.1"; f.value = String(Math.round(area[i] * 1000) / 1000); f.className = "ar-num ui-field"; f.setAttribute("aria-label", k); return f; });
    const areaRow = el("div", null, "ar-area");
    areaFields.forEach((f, i) => { const l = el("label"); l.append(el("span", ["X1", "Y1", "X2", "Y2"][i]), f); areaRow.append(l); });
    const scopeHelp = {all: "Routes every unrouted connection on the board (" + airwires.length + ").",
      net: "Routes every connection of the chosen nets.", connection: "Routes the chosen connections only.",
      component: "Routes every connection with a pad on the chosen components.", area: "Routes connections with both ends inside the area (mm). The area starts from the selection."};
    function showScope() {
      for (const b of scopeBar.children) {
        const selected = b.dataset.id === scope;
        b.setAttribute("aria-selected", String(selected));
        b.tabIndex = selected ? 0 : -1;
      }
      scopeBody.replaceChildren(el("small", scopeHelp[scope]));
      if (scope === "net") scopeBody.append(netSel);
      if (scope === "connection") scopeBody.append(connSel);
      if (scope === "component") scopeBody.append(compSel);
      if (scope === "area") scopeBody.append(areaRow);
    }
    for (const [id, label] of scopes) { const b = button(label, () => { scope = id; showScope(); }, "ar-tab ui-tab"); b.dataset.id = id; b.setAttribute("role", "tab"); scopeBar.append(b); }
    body.append(scopeBar, scopeBody);
    showScope();

    // Progress, messages and report.
    const status = el("div", null, "ar-status");
    const bar = el("progress"); bar.max = 1; bar.value = 0; bar.hidden = true;
    const phase = el("span", "Ready.");
    status.append(bar, phase);
    const log = el("div", null, "ar-log"); log.setAttribute("aria-live", "polite");
    const report = el("div", null, "ar-report");
    body.append(status, report, log);
    const message = (text, cls) => { const line = el("div", text, "ar-msg" + (cls ? " " + cls : "")); line.prepend(el("time", new Date().toLocaleTimeString())); log.append(line); log.scrollTop = log.scrollHeight; };

    const actions = el("div", null, "work-actions ui-dialog-actions");
    const close = button("Close", () => dlg.close());
    const stop = button("Stop", () => job?.cancel());
    stop.disabled = true;
    const go = button("Route " + "All", () => start());
    go.dataset.variant = "primary";
    actions.append(close, stop, go);
    dlg.append(actions);
    const relabel = () => { go.textContent = "Route " + scopes.find(s => s[0] === scope)[1]; };
    scopeBar.addEventListener("click", relabel);
    relabel();

    let job = null;
    function scopeOptions() {
      if (scope === "net") { const nets = [...netSel.selectedOptions].map(o => o.value); if (!nets.length) throw Error("Choose at least one net."); return {nets}; }
      if (scope === "connection") { const c = [...connSel.selectedOptions].map(o => airwires[+o.value]); if (!c.length) throw Error("Choose at least one connection."); return {connections: c.map(a => ({from: a.from, to: a.to}))}; }
      if (scope === "component") { const c = [...compSel.selectedOptions].map(o => o.value); if (!c.length) throw Error("Choose at least one component."); return {components: c}; }
      if (scope === "area") { const v = areaFields.map(f => +f.value); if (v.some(x => !Number.isFinite(x))) throw Error("Enter the area corners in mm."); return {area: [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])]}; }
      return {};
    }
    // Engine v2: route in the background with routes appearing on the board as they land, then
    // review the proposal on the board; Accept applies it as one undo step.
    let proposal = null;
    const V2 = () => globalThis.AtriumAutorouterV2;
    function endReview() { proposal = null; V2()?.preview.clear(); dlg.classList.remove("ar-reviewing"); reviewBar.hidden = true; }
    const reviewBar = el("div", null, "work-actions ui-dialog-actions ar-review");
    reviewBar.hidden = true;
    const accept = button("Accept", () => {
      if (!proposal) return;
      const {out, revision} = proposal;
      if (revision !== undefined && ctx.revision?.() !== revision) { message("The board changed since this proposal was computed. Route again.", "ar-warn"); endReview(); return; }
      ctx.edit(() => V2().applyPlan(ctx.doc, out));
      ctx.info?.("Routed " + out.report.routed + " of " + out.report.total + " connections (engine v2).");
      message("Accepted: " + out.add.length + " objects added" + (out.remove.length ? ", " + out.remove.length + " removed" : "") + ". Undo reverts it in one step.");
      endReview();
    });
    const discard = button("Discard", () => { message("Proposal discarded. Nothing was changed."); endReview(); });
    const compare = button("Compare…", () => compareProposal());
    compare.title = "Open the proposal in the diff view: the board now against the board with the proposal.";
    accept.dataset.variant = "primary";
    reviewBar.append(compare, discard, accept);
    dlg.insertBefore(reviewBar, actions);
    async function compareProposal() {
      if (!proposal) return;
      try {
        await globalThis.AtriumLazy?.need?.("AtriumDiffView");
        const DV = globalThis.AtriumDiffView;
        if (!DV?.start || !ctx.project) throw Error("The diff view is not available in this build.");
        const after = JSON.parse(JSON.stringify(ctx.project)), d = after.documents.find(x => x.id === ctx.doc.id);
        V2().applyPlan(d, JSON.parse(JSON.stringify(proposal.out)));
        dlg.close();
        await DV.start({project: ctx.project, label: "Board"}, {project: after, label: "Autoroute proposal"}, {doc: ctx.doc.id});
      } catch (e) { message(e.message, "ar-warn"); }
    }
    function startV2(sc, st, used, directions, timeLimit) {
      const revision = ctx.revision?.(), t0 = Date.now();
      endReview();
      report.replaceChildren();
      const router = {timeLimit};
      for (const k of ["gridDiv", "vias", "diagCost", "againstCost"]) if (st.router?.[k] !== undefined) router[k] = st.router[k];
      const options = {project: ctx.project, layers: used, directions, scope: sc, diffPairs: pairs.checked, lockPreroutes: lock.checked,
        fanout: st.fanout && used.length > 2 ? undefined : false, teardrops: tear.checked, router};
      message("Starting " + st.name + " with engine v2.");
      go.disabled = true; stop.disabled = false; bar.hidden = false; bar.value = 0;
      let lastPhase = "";
      try {
        job = V2().start(ctx.doc, defs, options, {onProgress: e => {
          if (e.phase !== lastPhase) { lastPhase = e.phase; message(e.phase + "…"); }
          if (e.landed) V2().preview.landed(ctx.doc, e.landed, e.layers, e.widths);
          phase.textContent = e.phase + (e.iteration ? " · pass " + e.iteration : "") + (e.total ? " · " + e.routed + "/" + e.total : "");
          if (Number.isFinite(e.fraction)) bar.value = e.fraction;
        }});
      } catch (e) { message(e.message, "ar-warn"); go.disabled = false; stop.disabled = true; bar.hidden = true; return; }
      job.promise.then(out => {
        if (revision !== undefined && ctx.revision?.() !== revision) { message("The board changed while routing. The result was discarded; route again.", "ar-warn"); V2().preview.clear(); return; }
        proposal = {out, revision};
        V2().preview.show(ctx.doc, out);
        dlg.classList.add("ar-reviewing");
        reviewBar.hidden = false;
        showReport(out.report, Date.now() - t0);
        message("Review the proposal on the board, then Accept (one undo step) or Discard.");
        accept.focus();
      }).catch(e => {
        V2().preview.clear();
        message(e.cancelled ? "Routing stopped. Nothing was changed." : "Routing failed: " + e.message, "ar-warn");
      }).finally(() => { job = null; go.disabled = false; stop.disabled = true; bar.hidden = true; phase.textContent = proposal ? "Proposal ready." : "Ready."; });
    }
    function start() {
      if (job) return;
      let sc;
      try { sc = scopeOptions(); } catch (e) { message(e.message, "ar-warn"); return; }
      if (engineSel.value === "v2" && !V2()) { go.disabled = true; v2Ready.then(() => { go.disabled = false; start(); }); return; }
      if (engineSel.value === "v2") {
        if (!V2()) { message("Engine v2 is not loaded in this build; using v1.", "ar-warn"); }
        else {
          const st2 = STRATEGIES.find(s => s.id === strategy), used2 = layers.filter((_, i) => dirSel[i].value !== "off");
          if (!used2.length) { message("Enable at least one layer.", "ar-warn"); return; }
          startV2(sc, st2, used2, layers.map((_, i) => dirSel[i].value).filter(v => v !== "off").map(Number), Math.max(5, +limit.value || 120) * 1000);
          return;
        }
      }
      const st = STRATEGIES.find(s => s.id === strategy);
      const used = layers.filter((_, i) => dirSel[i].value !== "off");
      if (!used.length) { message("Enable at least one layer.", "ar-warn"); return; }
      const directions = layers.map((_, i) => dirSel[i].value).filter(v => v !== "off").map(Number);
      const revision = ctx.revision?.();
      const t0 = Date.now();
      let work = doc, remove = [], fan = null;
      report.replaceChildren();
      try {
        if (!lock.checked) {
          const nets = sc.nets ? new Set(sc.nets) : null;
          remove = unlockedRoutes(doc, nets);
          if (remove.length) { const gone = new Set(remove); work = {...doc, items: doc.items.filter(i => !gone.has(i.id))}; message("Ripping up " + remove.length + " unlocked track and via objects."); }
        }
        if (st.fanout && globalThis.AtriumFanout && used.length > 2) {
          message("Fanout: BGA and fine-pitch components.");
          fan = AtriumFanout.plan(work, defs, {auto: strategy === "dense" ? "fine" : "bga", project: ctx.project, components: sc.components});
          if (fan.add.length) work = {...work, items: [...work.items, ...fan.add]};
          message("Fanout placed " + fan.report.vias + " vias.");
        }
        var prep = prepare(work, defs, {project: ctx.project, layers: used, directions, scope: sc, diffPairs: pairs.checked,
          router: {...st.router, timeLimit: Math.max(5, +limit.value || 120) * 1000}});
      } catch (e) { message(e.message, "ar-warn"); return; }
      for (const n of prep.notes) message(n, "ar-warn");
      if (!prep.conns.length && !fan?.add.length) { message("Nothing to route in this scope."); return; }
      message("Starting " + st.name + ": " + prep.conns.length + " connections on " + used.length + " layers.");
      go.disabled = true; stop.disabled = false; bar.hidden = false; bar.value = 0;
      let lastPhase = "";
      job = run(prep.job, {onProgress: e => {
        if (e.phase !== lastPhase) { lastPhase = e.phase; message(e.phase + "…"); }
        if (e.iteration && e.fraction === 1) message("Main routing pass " + e.iteration + ": " + e.routed + "/" + e.total + " routed, " + (e.conflicts || 0) + " nets in conflict.");
        phase.textContent = e.phase + (e.iteration ? " · pass " + e.iteration : "") + (e.total ? " · " + e.routed + "/" + e.total : "");
        if (Number.isFinite(e.fraction)) bar.value = e.fraction;
      }});
      job.promise.then(result => {
        const out = plan(prep, result, {remove,original:doc});
        if (fan) { out.add.unshift(...fan.add); out.report.fanout = fan.report; }
        if (revision !== undefined && ctx.revision?.() !== revision) { message("The board changed while routing. The result was discarded; route again.", "ar-warn"); return; }
        if (out.add.length || out.remove.length) ctx.edit(() => apply(ctx.doc, out));
        showReport(out.report, Date.now() - t0);
        ctx.info?.("Routed " + out.report.routed + " of " + out.report.total + " connections.");
      }).catch(e => {
        message(e.cancelled ? "Routing stopped. Nothing was changed." : "Routing failed: " + e.message, "ar-warn");
      }).finally(() => { job = null; go.disabled = false; stop.disabled = true; bar.hidden = true; phase.textContent = "Ready."; });
    }
    function showReport(r, ms) {
      const pct = r.total ? Math.round(1000 * r.routed / r.total) / 10 : 100;
      message("Routing finished in " + (ms / 1000).toFixed(1) + " s.");
      report.replaceChildren();
      const stats = el("dl", null, "ar-stats");
      const q = r.quality;
      const rows = [["Connections", r.routed + " of " + r.total + " (" + pct + "%)"], ["Vias added", String(r.vias + (r.fanout?.vias || 0)) + (r.fanout?.vias ? " (" + r.fanout.vias + " fanout)" : "")], ["Track length", (Math.round(r.length * 10) / 10) + " mm"]];
      if (q) rows.push(["Quality", (Math.round(q.bendsPerConnection * 100) / 100) + " bends per connection · " + Math.round(q.oct45 * 100) + "% at 0/45/90° · " + q.acute + " acute corners"],
        ["Per layer", Object.entries(q.layers).map(([k, v]) => (globalThis.AtriumPCBAppearance?.name?.(k) || k) + " " + v + " mm").join(" · ") || "–"]);
      if (r.pairs?.length) rows.push(["Differential pairs", r.pairs.map(p => p.positive.replace(/_?P$/i, "") + " " + Math.round(p.coupled * 100) + "% coupled").join(" · ")]);
      if (r.tuning) rows.push(["Length tuning", r.tuning.nets + " nets tuned in " + r.tuning.groups + " group" + (r.tuning.groups === 1 ? "" : "s") + (r.tuning.failed ? ", " + r.tuning.failed + " not matched" : "")]);
      if (r.viaMinimize) rows.push(["Via minimisation", r.viaMinimize.saved + " vias removed"]);
      if (r.alternate) rows.push(["Retry", "best result from " + r.alternate]);
      if (r.changes) rows.push(["Changes", r.changes.length + " nets: " + r.changes.slice(0, 8).map(c => c.net + " +" + c.tracks + "t/" + c.vias + "v").join(", ") + (r.changes.length > 8 ? "…" : "")]);
      rows.push(["Passes", r.passes.map(p => p.name + " " + Math.round(p.ms) + " ms").join(" · ")]);
      if (r.grid) rows.push(["Grid", fmt(r.grid.pitch) + " · " + r.grid.layers + " layers · " + Math.round(r.grid.bytes / 1048576 * 10) / 10 + " MB"]);
      for (const [k, v] of rows) stats.append(el("dt", k), el("dd", v));
      report.append(stats);
      if (r.failures.length) {
        report.append(el("h3", r.failures.length + " connection" + (r.failures.length === 1 ? "" : "s") + " not routed"));
        const ul = el("div", null, "ar-failures");
        for (const f of r.failures.slice(0, 500)) {
          // A library list row: the net and its ends, then why it failed and where.
          const b = button(null, () => { dlg.close(); ctx.locate?.(f.fromId, f.from); }, "ui-row ar-locate"), text = el("span", null, "ui-row-text"), title = el("span", null, "ui-row-title");
          title.append(el("strong", f.net), " " + f.fromLabel + " → " + f.toLabel);
          text.append(title, el("span", f.reason + " · " + f.from.map(v => v.toFixed(2)).join(", "), "ui-row-detail")); b.append(text);
          ul.append(b);
        }
        report.append(ul);
      }
    }
    dlg.onclose = () => { job?.cancel(); endReview(); dlg.remove(); if (active === dlg) active = null; };
    document.body.append(dlg);
    globalThis.AtriumShell?.adoptDialog?.(dlg, {actions, defaultAction: false});
    dlg.showModal();
    return dlg;
  }

  // Editor workflow entries, one per Route » Auto Route command (see the integration notes).
  const scoped = scope => ({open: ctx => open({...ctx, scope})});
  const workflows = {autoroute: {open}, "autoroute-all": scoped("all"), "autoroute-net": scoped("net"), "autoroute-connection": scoped("connection"),
    "autoroute-component": scoped("component"), "autoroute-area": scoped("area"), fanout: {open: ctx => globalThis.AtriumFanout?.open(ctx)}};

  return {core, AtriumRouteCore, AtriumRouteServe, workerSource, STRATEGIES, POWER, rulesFor, netStyle, outlineOf, open, workflows, fromSelection, unlockedRoutes, rulesSummary, planeLayers, boardLayers, padShape, eachCopper, copperMask, prepare, plan, apply, run, routeBoard, copperIndex, defaultDirections, engineDefault, DEFAULT_ENGINE, V2_PASSES};
})();

// Engine v2 (autorouter-v2.js) is its own lazy module, registered here so app/lazy.js (eager) does not grow.
try { globalThis.AtriumLazy?.register?.("AtriumAutorouterV2", {scripts: ["pcb/autorouter-v2.js"], deps: ["AtriumAutorouter"]}); } catch { /* headless */ }

// Inside a dedicated worker started from autorouter-worker.js.
if (typeof importScripts === "function" && typeof document === "undefined" && globalThis.AtriumAutorouterWorker === true) AtriumRouteServe(self, AtriumRouteCore());
