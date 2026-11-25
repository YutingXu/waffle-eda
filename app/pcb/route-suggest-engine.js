"use strict";

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// Route Suggestions engine: "autocomplete for copper". Given a connection (two terminals of one
// net) it returns a few legal completions, best first, each with its metrics and the reasons it
// looks the way it does. Pure model code (no DOM): route-suggest-worker.js runs it off the main
// thread, tests and MCP (suggest_route) run it directly.
//
// Legality comes from the interactive router's world and exact checks (AtriumRouter.core): a
// conservative multi-layer grid (cells blocked by the exact clearance of every feature plus the
// cell's half diagonal), an A* search whose cost model carries the soft preferences (layer and
// direction preferences, via cost, corners, spacing, learned habits), then the router's corner
// optimiser and an exact audit of every track segment and via. Rules decide widths, via styles,
// clearances, corner style, routing layers and via spans (HDI); habits only weigh legal choices.
//
//   suggest(board, defs, query, options) -> {ok, alternatives:[alt], reason?, ms, stats}
//   query: {net, from:[x,y], to:[x,y], fromLayer?, toLayer?, weights?, bias?, length?, pair?, shove?}
//   alt:   {kind, label, legs:[{layer, width, points}], vias:[{x, y, diameter, drill, fromLayer?, toLayer?, parts?, extra?}],
//           modify:[{id, points}|{id, x, y}], length, vias count (viaCount), bends, layers, cost, reasons:[text], tuned?}
//   toPlan(alt, {upTo, makeId})  -> {add, modify, remove} edit plan (AtriumRouter.apply)
//   steps(alt) -> accept points (bends and vias) for partial accept; prefix(alt, k) -> the part up to step k
globalThis.AtriumRouteSuggestEngine = (() => {
  const VERSION = 1;
  const now = typeof performance !== "undefined" && performance.now ? () => performance.now()
    : typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const RT = () => globalThis.AtriumRouter;
  const HOLE = -4, OUTLINE = -3;

  // Cost-model weights (mm of track equivalent). Tuned on the evaluation harness
  // (tests/pcb/route-suggest-eval.cjs, 23 human-routed connections): the
  // baseline {via:3, turn45:0.1, turn90:0.4, dir:0, near:0, layer:0} scored 1.60 (layer agreement
  // 0.59, via match 0.39, distance to the human path 2.01 mm); these weights with learned habits
  // score 1.85 (0.57, 0.61, 1.72 mm). DRC 0 and every connection found in both.
  const WEIGHTS = Object.freeze({
    via: 4.0,        // one via, in mm of track
    turn45: 0.25,    // a 45° bend
    turn90: 1.2,     // a 90° bend (45° corner style); 90° style uses turn45 for its bends
    dir: 0.35,       // extra cost per mm against a layer's preferred direction
    near: 0.08,      // per mm of track that hugs an obstacle (keeps spacing where there is room)
    layer: 0.6,      // learned layer preference strength (per mm, scaled by how unpreferred)
    inner: 0.04,     // per mm on inner layers when nothing else decides
    exit: 0.5,       // first step not along the learned pad exit axis
    fan: 1.5,        // via placed inward of the start component when the user fans outward
    epsilon: 1.15    // weighted A* (bounded suboptimality, much faster)
  });

  // ------------------------------------------------------------------ world
  // The world is the router's (exact features, uniform grid). A board passed with a revision is
  // cached until that revision or its item array changes.
  const worlds = new WeakMap();
  function world(board, defs, o = {}) {
    const R = RT();
    if (o.world) return o.world;
    const c = worlds.get(board);
    if (c && c.items === board.items && (o.revision == null || c.revision === o.revision)) { c.W.scene.reset(); return c.W; }
    const W = R.core.buildWorld(board, defs);
    worlds.set(board, {W, items: board.items, revision: o.revision});
    return W;
  }

  // Routing layers for a net: copper layers less planes and the Routing Layers rule's exclusions.
  function routingLayers(board, defs, rules, net, at) {
    const R = RT();
    let list = R.copperLayers(board, defs);
    try {
      const st = globalThis.AtriumStackup?.get?.(board, defs);
      const planes = new Set((st?.layers || []).filter(l => l.type === "Plane" && l.key).map(l => l.key));
      if (planes.size && list.some(l => !planes.has(l))) list = list.filter(l => !planes.has(l));
    } catch { /* no stack-up module */ }
    return list.filter(layer => rules.allowsLayer?.(net, layer, at) !== false);
  }

  // ------------------------------------------------------------------ grid
  // Conservative raster of one query window: per layer, cells where a track centre of that
  // layer's width would violate a clearance (exactly, inflated by the cell half diagonal), and
  // cells where a via would. Outline and cutouts by scanline.
  function makeGrid(W, rules, q, layers, widths, via, box, pitch) {
    const R = RT(), C = R.core, L = layers.length;
    const [x0, y0, x1, y1] = box;
    const nx = Math.max(2, Math.ceil((x1 - x0) / pitch) + 1), ny = Math.max(2, Math.ceil((y1 - y0) / pitch) + 1), N = nx * ny;
    const blocked = new Uint8Array(N * L), near = new Uint8Array(N * L), viaFree = L > 1 ? new Uint8Array(N * L).fill(1) : null;
    const slack = pitch * Math.SQRT1_2;
    const netId = W.netIds.has(q.net) ? W.netIds.get(q.net) : q.net ? 1e9 : C.NONET;
    const pairId = q.pair && W.netIds.has(q.pair.partner) ? W.netIds.get(q.pair.partner) : -99;
    // 2 nm of extra half width: optimised paths keep a margin for the 1 nm rounding of stored points.
    const ctxs = layers.map((l, i) => C.makeContext(W, rules, {layer: l, hw: widths[i] / 2 + 2e-6, net: netId, netName: q.net || "", base: "45", dirs: 8,
      ...(q.pair ? {net2: pairId, net2Name: q.pair.partner} : {})}));
    // All-layer specials (unplated holes, board edges) the router stores on layers 0..32.
    const specials = [];
    {
      const m = C.candidates(W, (x0 + x1) / 2, y0, (x0 + x1) / 2, y1, (x1 - x0) / 2 + 2, 0, 0);
      for (let i = 0; i < m; i++) { const f = W.qb[i]; if (W.lo[f] === 0 && W.hi[f] === 32 && (W.net[f] === HOLE || W.net[f] === OUTLINE)) specials.push(f); }
    }
    function stamp(ctx, li, extraCells, mask, off, extra) {
      const m = C.candidates(W, (x0 + x1) / 2, y0, (x0 + x1) / 2, y1, (x1 - x0) / 2 + ctx.reach + extra + pitch, li, li);
      const list = Array.from(W.qb.subarray(0, m));
      if (li > 32) for (const f of specials) list.push(f);
      for (const f of list) {
        const req = C.required(ctx, f); if (req < 0) continue;
        const lim = req + extra + slack, reach = lim + extraCells * pitch;
        const cx0 = Math.max(0, Math.floor((W.x0[f] - reach + W.r[f] * 0 - x0) / pitch)), cx1 = Math.min(nx - 1, Math.ceil((W.x1[f] + reach - x0) / pitch));
        const cy0 = Math.max(0, Math.floor((W.y0[f] - reach - y0) / pitch)), cy1 = Math.min(ny - 1, Math.ceil((W.y1[f] + reach - y0) / pitch));
        for (let y = cy0; y <= cy1; y++) {
          const py = y0 + y * pitch, row = off + y * nx;
          for (let x = cx0; x <= cx1; x++) {
            const k = row + x; if (mask[k] === 1) continue;
            const px = x0 + x * pitch, d = C.fdist(W, f, px, py, px, py);
            if (d < lim) mask[k] = 1;
            else if (extraCells && d < reach && mask[k] === 0) mask[k] = 2;
          }
        }
      }
    }
    for (let l = 0; l < L; l++) {
      const li = C.layerIndex(layers[l]), tmp = new Uint8Array(N);
      stamp(ctxs[l], li, 1, tmp, 0, 0);
      for (let i = 0; i < N; i++) { if (tmp[i] === 1) blocked[l * N + i] = 1; else if (tmp[i] === 2) near[l * N + i] = 1; }
      if (viaFree) {
        const vt = new Uint8Array(N);
        stamp(ctxs[l], li, 0, vt, 0, via.diameter / 2 - widths[l] / 2);
        for (let i = 0; i < N; i++) if (vt[i] === 1) viaFree[l * N + i] = 0;
      }
    }
    // Board outline and cutouts: scanline fill of the inside, per row.
    const outside = new Uint8Array(N);
    const polys = [];
    if (W.outline) polys.push({pts: W.outline, inside: true});
    for (const h of W.cutouts || []) polys.push({pts: h, inside: false});
    if (polys.length) {
      if (!W.outline) outside.fill(0);
      else outside.fill(1);
      const xs = [];
      for (let y = 0; y < ny; y++) {
        const py = y0 + y * pitch + 1e-9;
        for (const P of polys) {
          xs.length = 0;
          const pts = P.pts;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const a = pts[i], b = pts[j];
            if ((a[1] > py) !== (b[1] > py)) xs.push((b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]);
          }
          xs.sort((u, v) => u - v);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const c0 = Math.max(0, Math.ceil((xs[k] - x0) / pitch)), c1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / pitch));
            for (let x = c0; x <= c1; x++) outside[y * nx + x] = P.inside ? 0 : 1;
          }
        }
      }
      for (let l = 0; l < L; l++) for (let i = 0; i < N; i++) if (outside[i]) { blocked[l * N + i] = 1; if (viaFree) viaFree[l * N + i] = 0; }
    }
    // Exact contexts for the audit (the search contexts carry the rounding margin).
    const exact = layers.map((l, i) => C.makeContext(W, rules, {layer: l, hw: widths[i] / 2, net: netId, netName: q.net || "", base: "45", dirs: 8,
      ...(q.pair ? {net2: pairId, net2Name: q.pair.partner} : {})}));
    return {nx, ny, N, L, x0, y0, pitch, blocked, near, viaFree, ctxs, exact, netId, layers, widths, specials};
  }

  // ------------------------------------------------------------------ search
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  let bufS = 0, gBuf = null, parBuf = null, closedBuf = null, dirBuf = null;
  function buffers(S) {
    if (S > bufS) { bufS = S; gBuf = new Float64Array(S); parBuf = new Int32Array(S); closedBuf = new Uint8Array(S); dirBuf = new Int8Array(S); }
    gBuf.fill(Infinity, 0, S); parBuf.fill(-1, 0, S); closedBuf.fill(0, 0, S); dirBuf.fill(-1, 0, S);
  }
  // A* over (cell, layer). Costs: step length x layer multiplier x direction factor, bends,
  // spacing (near), vias with span legality, pad exit and fanout direction preferences.
  function search(G, P, starts, goals, deadline) {
    const {nx, ny, N, L, pitch, blocked, near, viaFree} = G, S = N * L;
    buffers(S);
    const g = gBuf, parent = parBuf, closed = closedBuf, inDir = dirBuf;
    const goalCell = goals.cell, goalLayer = new Uint8Array(L); for (const l of goals.layers) goalLayer[l] = 1;
    const gx = goalCell % nx, gy = (goalCell - gx) / nx, ortho = P.ortho, eps = P.epsilon;
    const h = c => { const x = c % nx, y = (c - x) / nx, dx = Math.abs(x - gx), dy = Math.abs(y - gy); return pitch * (ortho ? dx + dy : Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * eps; };
    const {push, pop} = RT().core.routeHeap(4096);
    for (const l of starts.layers) { const s0 = l * N + starts.cell; g[s0] = 0; push(h(starts.cell), s0); }
    const layerMul = P.layerMul, dirPref = P.dirPref, wDir = P.dir, wNear = P.near * pitch, t45 = P.turn45, t90 = P.turn90;
    const exitAxis = P.exitAxis, wExit = P.exit, fanCentre = P.fanCentre, wFan = P.fan;
    const sx = starts.cell % nx, sy = (starts.cell - sx) / nx;
    const sdx = fanCentre ? sx * pitch + G.x0 - fanCentre[0] : 0, sdy = fanCentre ? sy * pitch + G.y0 - fanCentre[1] : 0, sR = Math.hypot(sdx, sdy);
    let goal = -1, expanded = 0;
    for (let st = pop(); st >= 0; st = pop()) {
      if (closed[st]) continue; closed[st] = 1;
      const l = (st / N) | 0, cell = st - l * N;
      if (cell === goalCell && goalLayer[l]) { goal = st; break; }
      if ((++expanded & 2047) === 0 && now() > deadline) break;
      const cx = cell % nx, cy = (cell - cx) / nx, pd = inDir[st], gs = g[st], mul = layerMul[l], pref = dirPref[l];
      for (let d = 0; d < 8; d++) {
        if (ortho && (d & 1)) continue;
        const x = cx + DX[d], y = cy + DY[d]; if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const nc = y * nx + x, ns = l * N + nc;
        if (blocked[ns] || closed[ns]) continue;
        if ((d & 1) && blocked[l * N + cy * nx + x] && blocked[l * N + y * nx + cx]) continue;
        let turn = 0;
        if (pd >= 0 && pd < 8 && pd !== d) {
          const a = Math.abs(pd - d), t = a > 4 ? 8 - a : a;
          if (t >= 3) continue;                    // no acute corners (135° turns)
          turn = t === 1 ? t45 : ortho ? t45 : t90;
        }
        let step = pitch * ((d & 1) ? Math.SQRT2 : 1) * mul;
        if (pref) { const along = pref === 1 ? (d === 0 || d === 4) : (d === 2 || d === 6); if (!along) step *= 1 + ((d & 1) ? wDir * 0.5 : wDir); }
        let cost = gs + step + turn + (near[ns] ? wNear : 0);
        if (exitAxis && cell === starts.cell) { const ax = DX[d] * exitAxis[0] + DY[d] * exitAxis[1]; if (Math.abs(ax) < 0.9 * Math.hypot(DX[d], DY[d])) cost += wExit; }
        if (cost < g[ns]) { g[ns] = cost; parent[ns] = st; inDir[ns] = d; push(cost + h(nc), ns); }
      }
      if (viaFree && P.viaOK) for (let k = 0; k < L; k++) {
        if (k === l) continue;
        const ns = k * N + cell; if (blocked[ns] || closed[ns]) continue;
        if (!P.viaOK(l, k, cell)) continue;
        let cost = gs + P.viaCost(l, k);
        if (fanCentre && wFan && sR > 1e-6) { const vx = cx * pitch + G.x0 - fanCentre[0], vy = cy * pitch + G.y0 - fanCentre[1]; if (Math.hypot(vx, vy) < sR) cost += wFan; }
        if (cost < g[ns]) { g[ns] = cost; parent[ns] = st; inDir[ns] = 8; push(cost + h(cell), ns); }
      }
    }
    if (goal < 0) return null;
    const states = []; for (let s = goal; s >= 0; s = parent[s]) states.push(s);
    states.reverse();
    return {states, cost: g[goal], expanded};
  }

  // ------------------------------------------------------------------ geometry helpers
  function bends(pts) {
    let n = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]), b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
      let t = Math.abs(b - a); if (t > Math.PI) t = 2 * Math.PI - t;
      if (t > 0.05) n++;
    }
    return n;
  }
  const pathLength = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; };
  // Exact audit of one track polyline on its layer (router clearance + all-layer specials).
  function legClear(W, ctx, G, pts) {
    const C = RT().core;
    if (C.pathHit(ctx, pts, true)) return false;
    if (ctx.li > 32 && G.specials.length) {
      for (let i = 1; i < pts.length; i++) for (const f of G.specials) {
        const req = C.required(ctx, f); if (req < 0) continue;
        if (C.fdist(W, f, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) < req - 1e-7) return false;
      }
    }
    for (const p of pts) if (!C.insideOutline(W, p[0], p[1])) return false;
    return true;
  }
  // Octilinear offset of a polyline (miter joins) by d to the left.
  function offset(pts, d) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(pts.length - 1, i + 1)];
      const n1 = i > 0 ? norm(a, b) : norm(b, c), n2 = i < pts.length - 1 ? norm(b, c) : n1;
      let nx = n1[0] + n2[0], ny = n1[1] + n2[1]; const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
      const cos = nx * n1[0] + ny * n1[1], k = d / Math.max(0.2, cos);
      out.push([b[0] + nx * k, b[1] + ny * k]);
    }
    return out;
  }
  function norm(a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [-dy / L, dx / L]; }

  // Length tuning on the ghost: trombone meanders on the longest straight segments until the
  // extra length is reached, each meander checked exactly. Returns the tuned points or null.
  function tune(ctx, W, G, pts, extra, hw) {
    if (!(extra > 0.05)) return pts;
    let out = pts.map(p => [p[0], p[1]]), need = extra;
    const gap = Math.max(2 * hw + (ctx.clr[RT().core.NONET + 4] || 0.2), 4 * hw);
    for (let pass = 0; pass < 6 && need > 0.05; pass++) {
      let best = -1, bestL = 0;
      for (let i = 1; i < out.length; i++) { const L = dist(out[i - 1], out[i]); if (L > bestL) { bestL = L; best = i; } }
      if (best < 0 || bestL < 3 * gap) break;
      const a = out[best - 1], b = out[best], u = [(b[0] - a[0]) / bestL, (b[1] - a[1]) / bestL], n = [-u[1], u[0]];
      const usable = bestL - 2 * gap, count = Math.max(1, Math.floor(usable / (2 * gap)));
      let amp = Math.min(Math.max(need / (2 * count), gap * 0.5), 6 * gap);
      for (const sign of [1, -1]) {
        for (let shrink = 0; shrink < 4; shrink++, amp *= 0.6) {
          const m = [], start = (bestL - count * 2 * gap) / 2;
          for (let k = 0; k < count && 2 * amp * (k + 1) <= need + 2 * amp; k++) {
            const s0 = start + k * 2 * gap, s1 = s0 + gap;
            const p0 = [a[0] + u[0] * s0, a[1] + u[1] * s0], p1 = [a[0] + u[0] * s1, a[1] + u[1] * s1];
            m.push(p0, [p0[0] + n[0] * amp * sign, p0[1] + n[1] * amp * sign], [p1[0] + n[0] * amp * sign, p1[1] + n[1] * amp * sign], p1);
          }
          const cand = [...out.slice(0, best), ...m, ...out.slice(best)];
          const added = pathLength(cand) - pathLength(out);
          if (added > 0 && legClear(W, ctx, G, [a, ...m, b])) { out = cand; need -= added; break; }
        }
        if (need <= 0.05) break;
      }
    }
    return need <= Math.max(0.05, extra * 0.02) ? out : null;
  }

  // ------------------------------------------------------------------ suggest
  function suggest(board, defs, q, o = {}) {
    const t0 = now(), R = RT();
    if (!R?.core) return {ok: false, reason: "The router is not loaded.", alternatives: [], ms: 0};
    const C = R.core;
    const W = world(board, defs, o), rules = o.rules || C.rulesFor(board, {}, o.project || null);
    const net = q.net || "";
    if (!q.from || !q.to) return {ok: false, reason: "No connection to complete.", alternatives: [], ms: 0};
    const span = dist(q.from, q.to);
    const deadline = t0 + (finite(q.budgetMs) ? q.budgetMs : 120);
    const layers = q.layers?.length ? q.layers.filter(l => rules.allowsLayer?.(net, l, q.from) !== false) :
      routingLayers(board, defs, rules, net, q.from);
    if (!layers.length) return {ok: false, reason: "No routing layers for this net.", alternatives: [], ms: now() - t0};
    const netId = W.netIds.has(net) ? W.netIds.get(net) : net ? 1e9 : C.NONET;
    const onCopper = p => layers.map((l, i) => C.sameNetAt(W, netId, C.layerIndex(l), p, null) ? i : -1).filter(i => i >= 0);
    let startLs = q.fromLayer && layers.includes(q.fromLayer) && q.fromFree ? [layers.indexOf(q.fromLayer)] : onCopper(q.from);
    if (!startLs.length && q.fromLayer && rules.allowsLayer?.(net, q.fromLayer, q.from) === false)
      return {ok:false, reason:"The start is on a layer excluded by its Routing Layers rule.", alternatives:[], ms:now() - t0};
    if (!startLs.length) startLs = [Math.max(0, layers.indexOf(q.fromLayer || q.layer || layers[0]))];
    let goalLs = q.toLayer && layers.includes(q.toLayer) ? [layers.indexOf(q.toLayer)] : onCopper(q.to);
    if (!goalLs.length && q.toLayer && rules.allowsLayer?.(net, q.toLayer, q.to) === false)
      return {ok:false, reason:"The target is on a layer excluded by its Routing Layers rule.", alternatives:[], ms:now() - t0};
    if (!goalLs.length) goalLs = layers.map((_, i) => i);
    // Rules: width per layer (habit width only inside the rule's range), via style, corner style.
    const bias = q.bias || {};
    const widths = layers.map(l => {
      const r = rules.width(net, l, q.from);
      let w = r.preferred;
      if (q.pair) w = q.pair.width;
      else if (finite(bias.width) && bias.width >= r.min - 1e-9 && bias.width <= r.max + 1e-9) w = bias.width;
      return w;
    });
    const viaRule = rules.via(q.pair ? [net,q.pair.partner] : net), via = {diameter: viaRule.diameter, drill: viaRule.drill};
    const cornerRule = rules.corners(net);
    let corner = cornerRule.style || (bias.corner && bias.corner !== "any" ? bias.corner : "45");
    const ortho = C.baseCorner(corner) === "90";
    const weights = {...WEIGHTS, ...(q.weights || {})};
    // Window and pitch: grows with the span, bounded in cells.
    const maxW = Math.max(...widths), maxClr = Math.max(0.1, rules.maxClearance?.() ?? rules.clearance(net, "", layers[0]));
    const margin = finite(q.margin) ? q.margin : Math.max(2.5, Math.min(25, span * 0.45));
    let box = [Math.min(q.from[0], q.to[0]) - margin, Math.min(q.from[1], q.to[1]) - margin, Math.max(q.from[0], q.to[0]) + margin, Math.max(q.from[1], q.to[1]) + margin];
    if (W.outline) {
      let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity;
      for (const p of W.outline) { ox0 = Math.min(ox0, p[0]); oy0 = Math.min(oy0, p[1]); ox1 = Math.max(ox1, p[0]); oy1 = Math.max(oy1, p[1]); }
      box = [Math.max(box[0], ox0 - 0.5), Math.max(box[1], oy0 - 0.5), Math.min(box[2], ox1 + 0.5), Math.min(box[3], oy1 + 0.5)];
    }
    const pairW = q.pair ? q.pair.width + q.pair.gap / 2 : 0;
    let pitch = finite(q.pitch) ? q.pitch : Math.min(0.5, Math.max(0.04, ((q.pair ? 2 * pairW : maxW) + maxClr) / 3));
    const maxCells = q.maxCells || 160000;
    while (((box[2] - box[0]) / pitch) * ((box[3] - box[1]) / pitch) * layers.length > maxCells) pitch *= 1.2;
    const G = makeGrid(W, rules, q, layers, q.pair ? widths.map(() => 2 * pairW) : widths, via, box, pitch);
    const tGrid = now() - t0;
    const cellOf = p => Math.max(0, Math.min(G.ny - 1, Math.round((p[1] - G.y0) / pitch))) * G.nx + Math.max(0, Math.min(G.nx - 1, Math.round((p[0] - G.x0) / pitch)));
    const sCell = cellOf(q.from), gCell = cellOf(q.to);
    // Terminals sit in our own copper, perhaps inside a conservative inflation: free them and a
    // short exit run along the pad (the exact audit decides afterwards).
    for (const l of startLs) G.blocked[l * G.N + sCell] = 0;
    for (const l of goalLs) G.blocked[l * G.N + gCell] = 0;
    // A terminal on a clearance boundary (a live route's anchor) would sit in a ring of conservatively
    // blocked cells: open the nearby cells an exact straight run from the terminal reaches.
    const escape = (p, cell, ls) => {
      const r = 2, cx = cell % G.nx, cy = (cell - cx) / G.nx;
      for (const l of ls) for (let y = Math.max(0, cy - r); y <= Math.min(G.ny - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(G.nx - 1, cx + r); x++) {
        // Cells next to the terminal are decided exactly: the path's first run goes straight from it.
        const k = l * G.N + y * G.nx + x, c = [G.x0 + x * pitch, G.y0 + y * pitch];
        if (y * G.nx + x === cell) continue;
        G.blocked[k] = legClear(W, G.exact[l], G, [[p[0], p[1]], c]) ? 0 : 1;
      }
    };
    escape(q.from, sCell, startLs); escape(q.to, gCell, goalLs);
    // No vias in the terminal pads unless asked.
    if (G.viaFree && !q.viaInPad) {
      const rad = via.diameter / 2 + maxClr + 0.05;
      for (const p of [q.from, q.to]) {
        const r = Math.ceil(rad / pitch), c = cellOf(p), cx = c % G.nx, cy = (c - cx) / G.nx;
        for (let y = Math.max(0, cy - r); y <= Math.min(G.ny - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(G.nx - 1, cx + r); x++)
          if (Math.hypot((x - cx) * pitch, (y - cy) * pitch) < rad) for (let l = 0; l < G.L; l++) G.viaFree[l * G.N + y * G.nx + x] = 0;
      }
    }
    // Via spans (HDI aware) per layer pair, and which grid layers each must clear.
    const spanOf = new Map();
    const spanFor = (a, b) => {
      const k = a * 64 + b; if (spanOf.has(k)) return spanOf.get(k);
      const sp = C.viaSpan(board, layers[a], layers[b]);
      const inSpan = layers.map(l => { const li = C.layerIndex(l); return li >= sp.lo && li <= sp.hi; });
      const n = inSpan.filter(Boolean).length;
      const v = {sp, inSpan, n};
      spanOf.set(k, v); return v;
    };
    const viaOK = (a, b, cell) => {
      if (!viaRule.legal) return false;
      const s = spanFor(a, b), N = G.N;
      for (let l = 0; l < G.L; l++) if (s.inSpan[l] && !G.viaFree[l * N + cell]) return false;
      return true;
    };
    // Soft preferences: rule-free defaults, learned bias, then per-alternative tweaks.
    const dirDefault = layers.map((l, i) => layers.length < 2 ? 0 : i % 2 ? 2 : 1);
    const baseParams = (w, extra = {}) => {
      const layerMul = new Float64Array(layers.length), dirPref = new Int8Array(layers.length);
      layers.forEach((l, i) => {
        let m = 1 + (i > 0 && i < layers.length - 1 ? w.inner : 0);
        const share = bias.layers?.[l];
        if (bias.layers && Object.keys(bias.layers).length) m += w.layer * (1 - Math.min(1, finite(share) ? share : 0));
        if (extra.avoid?.has(l)) m += 1.5;
        layerMul[i] = m;
        const dp = bias.dirs?.[l];
        dirPref[i] = dp === "h" ? 1 : dp === "v" ? 2 : dp === "none" ? 0 : (w.dir > 0 ? dirDefault[i] : 0);
      });
      return {layerMul, dirPref, dir: w.dir, near: w.near * (finite(bias.spacing) ? bias.spacing : 1), turn45: w.turn45, turn90: w.turn90, ortho, epsilon: w.epsilon,
        exitAxis: bias.exitAxis || null, exit: w.exit, fanCentre: bias.fanCentre || null, fan: bias.fanOut ? w.fan : 0,
        viaOK: G.viaFree ? viaOK : null, viaCost: (a, b) => w.via * (finite(bias.viaScale) ? bias.viaScale : 1) * (extra.viaMul || 1) * (1 + 0.1 * (spanFor(a, b).n - 2))};
    };
    // A search result becomes an alternative: legs, vias, corner optimisation, exact audit.
    const finish = (res, kind, label) => {
      if (!res) return null;
      const N = G.N, legs = [], vias = [];
      let cur = null;
      for (const s of res.states) {
        const l = (s / N) | 0, cell = s - l * N, p = [G.x0 + (cell % G.nx) * pitch, G.y0 + Math.floor(cell / G.nx) * pitch];
        if (!cur || cur.l !== l) {
          if (cur) { const at = cur.points[cur.points.length - 1]; vias.push({at, a: cur.l, b: l}); cur = {l, points: [at]}; }
          else cur = {l, points: [p]};
          legs.push(cur); continue;
        }
        cur.points.push(p);
      }
      const base = C.baseCorner(corner);
      // Exact terminals.
      const first = legs[0], last = legs[legs.length - 1];
      first.points[0] = [q.from[0], q.from[1]];
      if (first === last && first.points.length <= 2) first.points = C.connector([q.from[0], q.from[1]], [q.to[0], q.to[1]], base, false);
      else {
        if (first.points.length > 1) first.points = [...C.connector(first.points[0], first.points[Math.min(1, first.points.length - 1)], base, false), ...first.points.slice(2)];
        const n = last.points.length;
        last.points = n > 1 ? [...last.points.slice(0, n - 1), ...C.connector(last.points[n - 2], [q.to[0], q.to[1]], base, false).slice(1)] : [...last.points, [q.to[0], q.to[1]]];
      }
      // Straight terminal runs (exactly checked cells) when a corner-style joint would not clear.
      const straight = legs.map(l => l.points.slice());
      straight[0][0] = [q.from[0], q.from[1]];
      { const L = straight[straight.length - 1]; L[L.length - 1] = [q.to[0], q.to[1]]; }
      const out = [];
      for (const [li, leg] of legs.entries()) {
        let pts = C.simplify(leg.points);
        if (pts.length < 2) continue;
        const ctx = G.ctxs[leg.l];
        ctx.deadline = Math.min(deadline, now() + 12);
        // The audit sees the geometry exactly as it will be stored (rounded to 1 nm).
        // Terminals are given (pad centres, a live route's anchor) and stay exact; interior points round.
        const first = li === 0, last = li === legs.length - 1;
        const r6 = q2 => q2.map((p, i) => (first && i === 0) || (last && i === q2.length - 1) ? [p[0], p[1]] : [C.round6(p[0]), C.round6(p[1])]), raw = r6(pts);
        pts = r6(C.optimize(ctx, pts, base, 300));
        const ex = G.exact[leg.l];
        if (!legClear(W, ex, G, pts)) { pts = raw; if (!legClear(W, ex, G, pts)) pts = r6(C.simplify(straight[li])); if (!legClear(W, ex, G, pts)) { const h = C.pathHit(ex, pts, true); auditMiss = h ? "segment " + (h.seg + 1) + " of " + (pts.length - 1) + " on " + layers[leg.l] + (h.seg === 0 ? " (start)" : h.seg === pts.length - 2 ? " (end)" : "") : "outline"; return null; } }
        out.push({layer: layers[leg.l], l: leg.l, width: widths[leg.l], points: pts});
      }
      if (!out.length) return null;
      const vout = [];
      for (const v of vias) {
        const sp = spanFor(v.a, v.b).sp;
        v.at = [C.round6(v.at[0]), C.round6(v.at[1])];
        if (!C.viaFitsSpan(rules,net,via,v.at,sp) || !C.viaClear(W, rules, netId, net, v.at, via.diameter / 2, sp.lo, sp.hi, false)) return null;
        vout.push({x: C.round6(v.at[0]), y: C.round6(v.at[1]), diameter: via.diameter, drill: via.drill, ...(sp.fromLayer ? {fromLayer: sp.fromLayer, toLayer: sp.toLayer} : {}),
          ...(sp.parts ? {parts: sp.parts} : {}), ...(sp.extra ? {extra: sp.extra} : {})});
      }
      return describe({kind, label, legs: out, vias: vout, modify: [], corner});
    };
    const describe = alt => {
      let length = 0, nb = 0; const used = new Map();
      for (const l of alt.legs) { const L = pathLength(l.points); length += L; nb += bends(l.points); used.set(l.layer, (used.get(l.layer) || 0) + L); }
      alt.length = +length.toFixed(4); alt.viaCount = alt.vias.reduce((n, v) => n + (v.parts?.length || 1), 0); alt.bends = nb;
      alt.layers = [...used.keys()]; alt.layerLength = Object.fromEntries([...used].map(([k, v]) => [k, +v.toFixed(3)]));
      alt.cost = +(length + alt.viaCount * WEIGHTS.via + nb * WEIGHTS.turn45).toFixed(3);
      return alt;
    };
    const startCell = {cell: sCell, layers: startLs}, goals = {cell: gCell, layers: goalLs};
    const alts = [], notes = [];
    let auditMiss = null;
    const tries = [];
    // 1. Best: the weighted cost model with the learned bias.
    tries.push({kind: "best", label: "Suggested", w: weights});
    const run = (t) => {
      if (now() > deadline && alts.length) return null;
      const P = baseParams(t.w, t.extra || {});
      if (t.singleLayer != null) { P.viaOK = null; }
      const st = t.singleLayer != null ? {cell: sCell, layers: [t.singleLayer]} : startCell;
      const gl = t.singleLayer != null ? {cell: gCell, layers: [t.singleLayer]} : goals;
      const res = search(G, P, st, gl, Math.max(deadline, now() + 20));
      if (!res) { notes.push(t.label + ": no path on the grid"); return null; }
      const alt = finish(res, t.kind, t.label);
      if (!alt) notes.push(t.label + ": failed the exact audit" + (auditMiss ? " (" + auditMiss + ")" : ""));
      return alt;
    };
    const best = q.pair ? null : run(tries[0]);
    if (best) alts.push(best);
    const tFirst = now() - t0;
    // The first ghost goes out at once (the worker posts it); alternatives follow.
    if (best && o.onFirst && !q.length && !q.pair) {
      best.reasons = explain(best, q, bias, rules, net, cornerRule, widths, layers);
      try { o.onFirst({ok: true, partial: true, alternatives: [best], ms: tFirst, stats: {gridMs: +tGrid.toFixed(2), firstMs: +tFirst.toFixed(2), cells: G.N * G.L, pitch: +pitch.toFixed(4), layers}}); } catch { /* caller */ }
    }
    if (q.pair) {
      const pr = pairSuggest(W, rules, G, q, layers, widths, corner, startLs, goalLs, deadline, C);
      if (pr.alt) alts.push(describe(pr.alt)); else notes.push(pr.reason);
    }
    if (!q.pair && q.alternatives !== false) {
      const more = [];
      const common = startLs.filter(l => goalLs.includes(l));
      if (best && best.viaCount > 0 && common.length) more.push({kind: "fewer-vias", label: "No vias", w: weights, singleLayer: common[0]});
      else if (best && best.viaCount > 1) more.push({kind: "fewer-vias", label: "Fewer vias", w: weights, extra: {viaMul: 3}});
      more.push({kind: "shorter", label: "Shorter", w: {...weights, dir: 0, near: 0, layer: 0, inner: 0, turn90: weights.turn45, via: weights.via * 0.6}});
      if (best && layers.length > 1) {
        const avoid = new Set(best.legs.filter(l => pathLength(l.points) > 1.5).map(l => l.layer));
        if (avoid.size && avoid.size < layers.length) more.push({kind: "layer", label: "Other layer", w: {...weights, via: weights.via * 0.7}, extra: {avoid}});
      }
      for (const t of more) {
        if (now() > deadline) break;
        const a = run(t);
        if (a) alts.push(a);
      }
      if (!best && !alts.length) {
        // Nothing with the preferences: plain shortest with cheap vias.
        const a = run({kind: "fallback", label: "Suggested", w: {...weights, dir: 0, near: 0, layer: 0, via: 1}});
        if (a) alts.push(a);
      }
    }
    // Push-and-shove proposal on the start layer when the best is a long detour or missing.
    const direct = span;
    if (!q.pair && q.shove !== false && startLs.some(l => goalLs.includes(l)) && (!alts.length || alts[0].length > 1.35 * direct + 1) && now() < deadline + 40) {
      const a = shoveSuggest(board, defs, W, q, layers[startLs.find(l => goalLs.includes(l))], widths[startLs.find(l => goalLs.includes(l))], corner, rules, o);
      if (a) alts.push(describe(a));
    }
    // Length band (path targets through series parts arrive pre-computed in q.length).
    let kept = alts;
    if (q.length && (finite(q.length.min) || finite(q.length.max))) {
      const min = finite(q.length.min) ? q.length.min : -Infinity, max = finite(q.length.max) ? q.length.max : Infinity, off = q.length.offset || 0;
      kept = [];
      for (const a of alts) {
        let total = a.length + off;
        if (total < min && q.length.final !== false && !a.modify.length) {
          // Tune the longest leg with meanders.
          const legI = a.legs.reduce((bi, l, i) => pathLength(l.points) > pathLength(a.legs[bi].points) ? i : bi, 0), leg = a.legs[legI];
          const ctx = G.ctxs[layers.indexOf(leg.layer)];
          ctx.deadline = now() + 10;
          const t = tune(ctx, W, G, leg.points, min - total + Math.min(0.3, (max - min) / 2), leg.width / 2);
          if (t) { leg.points = t; describe(a); a.tuned = true; total = a.length + off; }
        }
        if (total > max + 1e-6) { notes.push(a.label + " is over the length target"); continue; }
        if (total < min - 1e-6 && q.length.final !== false) { notes.push(a.label + " is short of the length target"); continue; }
        a.lengthTarget = {min: q.length.min, max: q.length.max, total: +total.toFixed(3), label: q.length.label || null};
        kept.push(a);
      }
    }
    // Dedupe: same layers, via count and nearly the same length and shape.
    const out = [];
    for (const a of kept) {
      if (out.some(b => b.viaCount === a.viaCount && b.layers.join() === a.layers.join() && Math.abs(b.length - a.length) < Math.max(0.2, 0.03 * a.length) && shapeClose(a, b))) continue;
      out.push(a);
    }
    for (const a of out) a.reasons = explain(a, q, bias, rules, net, cornerRule, widths, layers);
    const ms = now() - t0;
    return {ok: out.length > 0, alternatives: out, reason: out.length ? null : notes[0] || "No legal route found in the time allowed.", notes,
      ms, stats: {gridMs: +tGrid.toFixed(2), firstMs: +tFirst.toFixed(2), cells: G.N * G.L, pitch: +pitch.toFixed(4), layers}};
  }
  function shapeClose(a, b) {
    const pa = a.legs.flatMap(l => l.points), pb = b.legs.flatMap(l => l.points);
    let s = 0, n = 0;
    for (let i = 0; i < pa.length; i++) { let m = Infinity; for (let j = 1; j < pb.length; j++) m = Math.min(m, Math.sqrt(segD2(pa[i], pb[j - 1], pb[j]))); s += m; n++; }
    return n ? s / n < 0.25 : true;
  }
  const pointSegmentDistanceSquared = globalThis.AtriumGeometry.pointSegmentDistanceSquared;
  const segD2 = (p, a, b) => pointSegmentDistanceSquared(p[0], p[1], a[0], a[1], b[0], b[1]);
  // Why the suggestion looks the way it does: rules first, then the learned habits that applied.
  function explain(a, q, bias, rules, net, cornerRule, widths, layers) {
    const out = [], ev = bias.evidence || {};
    const main = Object.entries(a.layerLength).sort((x, y) => y[1] - x[1])[0]?.[0];
    if (main && bias.layers && ev.layers && bias.layers[main] >= 0.5) out.push("Prefers " + main + (ev.cls ? " for " + ev.cls : "") + " (learned from " + ev.layers + " route" + (ev.layers === 1 ? "" : "s") + ")");
    if (a.legs.length) {
      const w = a.legs[0].width, r = rules.width(net, a.legs[0].layer, q.from);
      if (finite(bias.width) && Math.abs(bias.width - w) < 1e-9 && Math.abs(r.preferred - w) > 1e-9) out.push("Width " + fmt(w) + " mm" + (ev.cls ? " for " + ev.cls : "") + ", within the rule's " + fmt(r.min) + "–" + fmt(r.max) + " mm (learned from " + (ev.widths || 0) + " routes)");
      else out.push("Width " + fmt(w) + " mm from the Width rule");
    }
    if (cornerRule.style) out.push(cornerName(cornerRule.style) + " corners from the Routing Corners rule");
    else if (bias.corner && ev.corners) out.push(cornerName(bias.corner) + " corners (learned from " + ev.corners + " corners)");
    if (a.viaCount === 0 && finite(bias.viaScale) && bias.viaScale > 1.05 && ev.vias) out.push("Avoids vias (you use " + ev.viaRate + " per route)");
    if (a.kind === "fewer-vias") out.push("No layer change");
    if (a.kind === "layer") out.push("Moves to " + (a.layers.find(l => !q.bestLayers?.includes(l)) || a.layers[0]));
    if (a.modify?.length) out.push("Pushes " + a.modify.length + " track" + (a.modify.length === 1 ? "" : "s") + " aside (proposal)");
    if (a.tuned) out.push("Meanders added for the length target");
    if (a.lengthTarget) out.push("Length " + fmt(a.lengthTarget.total) + " mm in " + fmt(a.lengthTarget.min) + "–" + fmt(a.lengthTarget.max) + " mm" + (a.lengthTarget.label ? " (" + a.lengthTarget.label + ")" : ""));
    if (bias.exitAxis && ev.exit) out.push("Leaves the pad along its long side (learned from " + ev.exit + " routes)");
    if (bias.fanOut && a.viaCount && ev.fan) out.push("Fans out away from the part (learned from " + ev.fan + " vias)");
    if (q.pair) out.push("Coupled pair, gap " + fmt(q.pair.gap) + " mm");
    return out;
  }
  const fmt = v => (Math.round(v * 1000) / 1000).toString();
  const cornerName = c => ({"45": "45°", "45arc": "45° with arc", "90": "90°", "90arc": "90° with arc", any: "Any-angle"})[c] || c;

  // Push-and-shove proposal: the interactive router in push mode along the direct connector,
  // with locked copper honoured. The shoved tracks and vias come back as modifications.
  function shoveSuggest(board, defs, W, q, layer, width, corner, rules, o) {
    const R = RT();
    try {
      W.scene.reset();
      const s = R.begin(board, defs, {world: W, net: q.net, layer, start: q.from, mode: "push", corner: C2(corner), width, halos: false, pushBudgetMs: 12, moveBudgetMs: 16,
        locked: o.locked || [], rules: o.userRules, project: o.project});
      const r = s.move(q.to);
      if (!(r.reached || dist(r.end, q.to) < 1e-6) || !["pushed", "ok"].includes(r.status)) { s.cancel(); return null; }
      s.click();
      const plan = s.commit({gloss: true, removeLoops: false, makeId: () => "g"});
      W.scene.reset();
      const legs = plan.add.filter(i => i.kind === "track").map(t => ({layer: t.layer, width: t.width, points: t.points}));
      if (!legs.length) return null;
      return {kind: "shove", label: "Push aside", legs, vias: [], modify: plan.modify, corner};
    } catch { W.scene.reset(); return null; }
  }
  const C2 = c => c;

  // Differential pairs: route the pair's centreline (pair width + gap) on one layer, offset it to
  // the two tracks, join the pads, then audit each track exactly (the partner is its own net).
  function pairSuggest(W, rules, G, q, layers, widths, corner, startLs, goalLs, deadline, C) {
    const p = q.pair, common = startLs.filter(l => goalLs.includes(l));
    if (!common.length) return {reason: "This pair changes layer; use the pair router (U I)."};
    const l = common[0], mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = mid(q.from, p.from2), e = mid(q.to, p.to2);
    const cellOf = pt => Math.max(0, Math.min(G.ny - 1, Math.round((pt[1] - G.y0) / G.pitch))) * G.nx + Math.max(0, Math.min(G.nx - 1, Math.round((pt[0] - G.x0) / G.pitch)));
    const sc = cellOf(s), gc = cellOf(e);
    G.blocked[l * G.N + sc] = 0; G.blocked[l * G.N + gc] = 0;
    const P = {layerMul: new Float64Array(G.L).fill(1), dirPref: new Int8Array(G.L), dir: 0, near: 0, turn45: WEIGHTS.turn45, turn90: WEIGHTS.turn90 * 2,
      ortho: false, epsilon: WEIGHTS.epsilon, viaOK: null, viaCost: () => Infinity};
    const res = search(G, P, {cell: sc, layers: [l]}, {cell: gc, layers: [l]}, deadline + 20);
    if (!res) return {reason: "No room for the coupled pair on " + layers[l] + "."};
    let centre = res.states.map(st => { const cell = st % G.N; return [G.x0 + (cell % G.nx) * G.pitch, G.y0 + Math.floor(cell / G.nx) * G.pitch]; });
    centre[0] = s; centre[centre.length - 1] = e;
    centre = C.simplify(centre);
    const half = (p.gap + p.width) / 2;
    const side = (pt, path) => { const a = path[0], b = path[1] || path[0], n = norm(a, b); return (pt[0] - a[0]) * n[0] + (pt[1] - a[1]) * n[1]; };
    const sign = side(q.from, centre) >= 0 ? 1 : -1;
    const A1 = offset(centre, sign * half), B1 = offset(centre, -sign * half);
    const pathA = C.simplify([[q.from[0], q.from[1]], ...A1, [q.to[0], q.to[1]]]), pathB = C.simplify([[p.from2[0], p.from2[1]], ...B1, [p.to2[0], p.to2[1]]]);
    const r6 = q2 => q2.map(pt => [C.round6(pt[0]), C.round6(pt[1])]);
    pathA.splice(0, pathA.length, ...r6(pathA)); pathB.splice(0, pathB.length, ...r6(pathB));
    const uncoupled = dist(q.from, A1[0]) + dist(A1[A1.length - 1], q.to);
    if (finite(p.maxUncoupled) && uncoupled > p.maxUncoupled + 1e-6) return {reason: "The pad entries exceed the pair's max uncoupled length."};
    const netId = G.netId, partId = W.netIds.has(p.partner) ? W.netIds.get(p.partner) : 1e9;
    const ctxA = C.makeContext(W, rules, {layer: layers[l], hw: p.width / 2, net: netId, netName: q.net, net2: partId, net2Name: p.partner});
    const ctxB = C.makeContext(W, rules, {layer: layers[l], hw: p.width / 2, net: partId, netName: p.partner, net2: netId, net2Name: q.net});
    if (!legClear(W, ctxA, G, pathA) || !legClear(W, ctxB, G, pathB)) return {reason: "The coupled pair does not clear here; use the pair router (U I)."};
    // The two tracks keep the gap (each segment pair checked).
    for (let i = 1; i < pathA.length; i++) for (let j = 1; j < pathB.length; j++) {
      const d = Math.sqrt(segSeg2(pathA[i - 1], pathA[i], pathB[j - 1], pathB[j])) - p.width;
      if (d < Math.min(p.gap, rules.clearance(q.net, p.partner, layers[l])) - 1e-6) return {reason: "The pair gap cannot be kept at the pads; use the pair router (U I)."};
    }
    return {alt: {kind: "pair", label: "Coupled pair", legs: [{layer: layers[l], width: p.width, points: pathA}, {layer: layers[l], width: p.width, points: pathB, net: p.partner}], vias: [], modify: [], corner}};
  }
  function segSeg2(a, b, c, d) {
    const cr = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = cr(c, d, a), d2 = cr(c, d, b), d3 = cr(a, b, c), d4 = cr(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
    return Math.min(segD2(a, c, d), segD2(b, c, d), segD2(c, a, b), segD2(d, a, b));
  }

  // ------------------------------------------------------------------ plans and partial accept
  // Accept points along the suggestion: every bend and via, in route order.
  function steps(alt) {
    const out = [];
    alt.legs.filter(l => !l.net).forEach((leg, li) => {
      for (let i = 1; i < leg.points.length; i++) out.push({leg: li, vertex: i, at: leg.points[i], via: i === leg.points.length - 1 && li < alt.legs.filter(l => !l.net).length - 1});
    });
    return out;
  }
  // The suggestion up to step k (inclusive), and the rest from there.
  function prefix(alt, k) {
    const st = steps(alt);
    if (k >= st.length - 1) return {head: alt, rest: null};
    const s = st[k], own = alt.legs.filter(l => !l.net);
    const legs = own.slice(0, s.leg).map(l => ({...l})), cut = own[s.leg];
    legs.push({...cut, points: cut.points.slice(0, s.vertex + 1)});
    const vias = alt.vias.slice(0, s.leg + (s.via ? 1 : 0));
    const restLegs = [];
    if (!s.via) restLegs.push({...cut, points: cut.points.slice(s.vertex)});
    restLegs.push(...own.slice(s.leg + 1));
    const rest = {...alt, legs: restLegs, vias: alt.vias.slice(vias.length), modify: []};
    return {head: {...alt, legs, vias, modify: alt.modify}, rest};
  }
  function toPlan(alt, o = {}) {
    const R = RT(), idOf = o.makeId || (() => globalThis.Atrium?.id?.() || "s" + Math.random().toString(36).slice(2));
    const add = [];
    for (const l of alt.legs) if (l.points.length > 1) add.push({id: idOf(), kind: "track", points: l.points.map(p => [p[0], p[1]]), width: l.width, layer: l.layer, net: l.net || o.net || alt.net || ""});
    for (const v of alt.vias) add.push(...R.core && R.core.viaSpan ? viaItems(v, idOf, o.net || alt.net || "") : []);
    return {add, remove: [], modify: (alt.modify || []).map(m => ({...m})), length: alt.length};
  }
  function viaItems(v, idOf, net) {
    return (v.parts || [v]).map(p => {
      const via = {id: idOf(), kind: "via", x: v.x, y: v.y, diameter: v.diameter, drill: v.drill, layer: "Multi", net};
      if (p.fromLayer) { via.fromLayer = p.fromLayer; via.toLayer = p.toLayer; }
      if (p.extra) Object.assign(via, p.extra);
      return via;
    });
  }
  // Exact audit of a plan against a world (accept-time check on the main thread's own world).
  function validate(board, defs, alt, o = {}) {
    const R = RT(), C = R.core, W = world(board, defs, o), rules = o.rules || C.rulesFor(board, {}, o.project || null);
    const net = alt.net || o.net || "", netId = W.netIds.has(net) ? W.netIds.get(net) : net ? 1e9 : C.NONET;
    const G = {specials: []};
    {
      const m = C.candidates(W, 0, 0, 0, 0, 1e6, 0, 0);
      for (let i = 0; i < m; i++) { const f = W.qb[i]; if (W.lo[f] === 0 && W.hi[f] === 32 && (W.net[f] === HOLE || W.net[f] === OUTLINE)) G.specials.push(f); }
    }
    for (const l of alt.legs) {
      const n = l.net || net, id = W.netIds.has(n) ? W.netIds.get(n) : n ? 1e9 : C.NONET;
      const partner = l.net ? net : alt.pairPartner;
      const ctx = C.makeContext(W, rules, {layer: l.layer, hw: l.width / 2, net: id, netName: n, ...(partner ? {net2: W.netIds.get(partner) ?? 1e9, net2Name: partner} : {})});
      if (!legClear(W, ctx, G, l.points)) return {ok: false, reason: "A track would violate a clearance on " + l.layer + "."};
    }
    for (const v of alt.vias) {
      const lo = v.fromLayer ? Math.min(C.layerIndex(v.fromLayer), C.layerIndex(v.toLayer)) : 0, hi = v.fromLayer ? Math.max(C.layerIndex(v.fromLayer), C.layerIndex(v.toLayer)) : 127;
      if (!C.viaFitsSpan(rules,net,v,[v.x,v.y],{...v,lo,hi})) return {ok:false,reason:"The suggested via no longer meets its diameter, drill and annular ring rules."};
      if (!C.viaClear(W, rules, netId, net, [v.x, v.y], v.diameter / 2, lo, hi, false)) return {ok: false, reason: "A via would violate a clearance."};
    }
    return {ok: true};
  }
  return Object.freeze({VERSION, WEIGHTS, suggest, toPlan, steps, prefix, validate, world, routingLayers, pathLength, bends, tune});
})();
