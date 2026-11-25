"use strict";

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// Via fencing and stitching (Altium "Advanced Via Fencing", plus more).
//
//   Fence     rows of stitch-net vias along tracks, a whole net or class, or a
//             differential pair (outer sides). Pitch is fixed or λ/20 at a
//             frequency with Dk from the stackup. Rows, row spacing, stagger,
//             corner vias, caps or square ends, T-junctions (fences end where
//             a branch joins; candidates there are checked like any other).
//   Edge      rows along the board outline and around cutouts (exact arcs and
//             cutouts from AtriumBoardShape when present).
//   Area      grid or hex stitching inside a polygon, only where the stitch
//             net's copper exists on the required layers.
//   Return    return-path vias: signal vias that change reference planes with
//             no reference via within D. A check (DRC) and a fixer.
//
// Every candidate is checked against copper of other nets (AtriumRouter's
// clearance world), pads, NPTH holes, keep-outs, the board edge and cutouts,
// hole-to-hole spacing (all existing drills and the other new vias), other
// nets' poured copper, flex regions (AtriumStackup.regionsResolved) and, when
// pour-aware, the stitch net's poured copper. A failing candidate can be
// nudged along the path, then outwards, to the nearest legal spot.
//
// Data. Generated vias are ordinary vias tagged {fence:id, groupId:"fence:"+id}
// so clicking one selects the whole group. Definitions live on the board:
//   board.viaFences = [{id, kind:"path"|"edge"|"area"|"return", name, net,
//                       source:{trackIds?|net?|netClass?|pair?|nets?|polygonId?|outline?},
//                       params:{...}, sig, count}]
// `sig` fingerprints the source geometry and parameters; a fence whose
// source changed is stale and Regenerate replaces its vias.
//
// Headless: plan(board, defs, spec, opts) -> {add, remove, modify, fences, stats, preview}
// in the router/length-tuning plan format; applyPlan(board, plan, opts) commits
// it (call inside one undoable edit). Only open()/inspector() touch the DOM.
// Units are mm, Y down.
globalThis.AtriumViaFence = (() => {
  const TOL = 1e-7, C_MM_PS = 0.299792458;
  // Special net ids used by AtriumRouter worlds (router.js: HOLE, OUTLINE, KEEPOUT).
  const HOLE = -4, OUTLINE = -3, KEEPOUT = -2;
  const KINDS = ["path", "edge", "area", "return"];
  const KIND_NAMES = {path:"Fence", edge:"Board edge", area:"Area stitching", return:"Return path vias"};
  // net-intent.js (isGround) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const GROUND_RE = /^(?:[ADPSCE]?GND\w*|\w*_GND\w*|VSS\w*|0V|GROUND\w*|EARTH|CHASSIS)$/i;
  const GROUND = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isGround ? N.isGround(String(n ?? "")) : GROUND_RE.test(n); }};
  const now = () => globalThis.performance?.now?.() ?? (typeof preciseTime === "function" ? preciseTime() * 1000 : Date.now());
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const At = () => globalThis.Atrium;
  let serial = 0;
  const newId = () => At()?.id ? At().id() : "vf" + Date.now().toString(36) + (serial++).toString(36);
  // Membership is the group id: copies made by paste get new group ids and stop being fence members.
  const fenceOfItem = item => typeof item?.groupId === "string" && item.groupId.startsWith("fence:") ? item.groupId.slice(6) : null;

  const DEFAULTS = Object.freeze({
    net:"", template:null, diameter:null, drill:null,
    sides:"both",            // both | left | right | outer (pairs: away from the partner)
    between:false,           // pairs: also try the gap between P and N
    offset:0,                // extra gap beyond the rule clearance (via edge to track edge)
    useRuleClearance:true,
    pitch:1, pitchMode:"fixed", frequency:10, fraction:20,   // pitchMode "lambda": λ/fraction at frequency GHz
    rows:1, rowSpacing:null, stagger:true,
    cornerVias:true, cornerAngle:30,
    ends:"cap",              // cap | terminate
    nudge:true, nudgeMax:null,
    holeGap:null,            // hole-to-hole gap; null = rule (0.254 without one)
    pourLayers:"auto",       // auto | none | [layer keys]
    pourMargin:0.05,
    avoidOtherPours:true, avoidFlex:true,
    inset:null, cutouts:true,              // edge
    pattern:"hex", margin:null,            // area
    distance:1, count:1, referenceNets:null // return
  });

  // ---------------------------------------------------------------- small geometry
  const segDist2 = globalThis.AtriumGeometry.pointSegmentDistanceSquared;
  const inRing = globalThis.AtriumGeometry.inRingAt;
  function ringDist(pts, x, y) {
    let m = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const d = segDist2(x, y, pts[j][0], pts[j][1], pts[i][0], pts[i][1]); if (d < m) m = d; }
    return Math.sqrt(m);
  }
  function boxOf(pts) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of pts) { if (p[0] < a) a = p[0]; if (p[1] < b) b = p[1]; if (p[0] > c) c = p[0]; if (p[1] > d) d = p[1]; }
    return [a, b, c, d];
  }
  const area2 = pts => { let s = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return s; };
  function dedupe(pts, closed) {
    const out = [];
    for (const p of pts) { const l = out[out.length - 1]; if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 1e-6) out.push([+p[0], +p[1]]); }
    if (closed && out.length > 2 && Math.hypot(out[0][0] - out.at(-1)[0], out[0][1] - out.at(-1)[1]) <= 1e-6) out.pop();
    return out;
  }
  function hasher() {
    let h1 = 2166136261, h2 = 5381;
    function text(s) { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2, 33) ^ c; } }
    function value(v) {
      if (Array.isArray(v)) { text("["); for (const x of v) value(x); text("]"); }
      else if (v !== null && typeof v === "object") { text("{"); for (const k of Object.keys(v).sort()) { text(k + ":"); value(v[k]); } text("}"); }
      else if (typeof v === "number") text((Math.round(v * 1e6) / 1e6) + ",");
      else text(String(v) + ",");
    }
    return {text, value, hex:() => (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")};
  }

  // Offset of an open or closed polyline by signed distance d (positive = left
  // of travel in model axes). Outer corners get round joins (so pitch is kept
  // along the curve); inner corners are mitred. Returns {pts, fixed:[index]}:
  // fixed marks the midpoints of sharp corners (cornerAngle) and is where
  // corner vias go.
  function offsetPath(pts, d, closed, opt = {}) {
    const n = pts.length, out = [], fixed = [], cosLimit = Math.cos((opt.cornerAngle ?? 30) * Math.PI / 180);
    const step = opt.step || 0.25, ad = Math.abs(d);
    if (n < 2) return {pts:n ? [[pts[0][0], pts[0][1]]] : [], fixed};
    const U = [], N = [];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; U.push(u); N.push([-u[1], u[0]]);
    }
    const put = (p, fix) => { out.push(p); if (fix) fixed.push(out.length - 1); };
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const inSeg = closed ? (i - 1 + segs) % segs : i - 1, outSeg = closed ? i % segs : i < segs ? i : -1;
      if (inSeg < 0 || outSeg < 0) { const k = inSeg < 0 ? outSeg : inSeg; put([p[0] + N[k][0] * d, p[1] + N[k][1] * d]); continue; }
      const n0 = N[inSeg], n1 = N[outSeg], u0 = U[inSeg], u1 = U[outSeg];
      const cross = u0[0] * u1[1] - u0[1] * u1[0], dot = u0[0] * u1[0] + u0[1] * u1[1];
      const sharp = dot < cosLimit, a0 = [p[0] + n0[0] * d, p[1] + n0[1] * d], a1 = [p[0] + n1[0] * d, p[1] + n1[1] * d];
      if (Math.abs(cross) < 1e-12 && dot > 0) { put(a1); continue; }
      const outer = d * cross < 0;
      if (outer) {
        let t0 = Math.atan2(a0[1] - p[1], a0[0] - p[0]), t1 = Math.atan2(a1[1] - p[1], a1[0] - p[0]), dt = t1 - t0;
        while (dt > Math.PI) dt -= 2 * Math.PI; while (dt < -Math.PI) dt += 2 * Math.PI;
        const m = Math.max(2, Math.ceil(Math.abs(dt) * ad / step)) & ~1;   // even: the middle point is the corner
        for (let k = 0; k <= m; k++) { const t = t0 + dt * k / m; put([p[0] + ad * Math.cos(t), p[1] + ad * Math.sin(t)], sharp && k === m / 2); }
      } else {
        const bis = [n0[0] + n1[0], n0[1] + n1[1]], bl = Math.hypot(bis[0], bis[1]);
        const cosH = Math.max(0.2, bl / 2);   // limit the mitre on hairpins
        put(bl > 1e-9 ? [p[0] + bis[0] / bl * d / cosH, p[1] + bis[1] / bl * d / cosH] : a1, sharp);
      }
    }
    return {pts:out, fixed};
  }
  // Half turn of radius r around p from point a through tip; tip is the middle point.
  function halfTurn(p, a, tip, r, step) {
    const ta = Math.atan2(a[1] - p[1], a[0] - p[0]), tt = Math.atan2(tip[1] - p[1], tip[0] - p[0]);
    let dt = tt - ta; while (dt > Math.PI) dt -= 2 * Math.PI; while (dt < -Math.PI) dt += 2 * Math.PI;
    const m = Math.max(4, Math.ceil(Math.PI * Math.abs(r) / (step || .25))) & ~1, pts = [], R = Math.abs(r);
    for (let k = 0; k <= m; k++) { const t = ta + 2 * dt * k / m; pts.push([p[0] + R * Math.cos(t), p[1] + R * Math.sin(t)]); }
    return {pts, tip:m / 2};
  }
  // Cumulative arc length.
  function measure(pts, closed) {
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = closed && pts.length > 1 ? s.at(-1) + Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) : s.at(-1);
    return {s, total};
  }
  function pointAt(path, t) {
    const {pts, s, total, closed} = path, n = pts.length;
    if (closed) { t %= total; if (t < 0) t += total; } else t = Math.max(0, Math.min(total, t));
    let lo = 0, hi = n - 1;
    if (closed && t >= s[n - 1]) {
      const a = pts[n - 1], b = pts[0], l = total - s[n - 1] || 1, f = (t - s[n - 1]) / l;
      return {x:a[0] + (b[0] - a[0]) * f, y:a[1] + (b[1] - a[1]) * f, ux:(b[0] - a[0]) / l, uy:(b[1] - a[1]) / l};
    }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= t) lo = m; else hi = m; }
    const a = pts[lo], b = pts[Math.min(lo + 1, n - 1)], l = s[Math.min(lo + 1, n - 1)] - s[lo] || 1, f = (t - s[lo]) / l;
    return {x:a[0] + (b[0] - a[0]) * f, y:a[1] + (b[1] - a[1]) * f, ux:(b[0] - a[0]) / l, uy:(b[1] - a[1]) / l};
  }
  // Even sampling between fixed points, spacing at most `pitch`. With `half`,
  // the samples sit halfway between (staggered rows).
  function sample(path, pitch, half) {
    const corners = path.fixed.map(i => path.s[i]);
    const fx = [...new Set(corners)].sort((a, b) => a - b);
    if (!path.closed) { if (!fx.length || fx[0] > 1e-9) fx.unshift(0); if (fx.at(-1) < path.total - 1e-9) fx.push(path.total); }
    else { if (!fx.length) fx.push(0); fx.push(fx[0] + path.total); }
    const isCorner = t => corners.some(c => Math.abs(c - t) < 1e-9), out = [];
    for (let k = 0; k + 1 < fx.length; k++) {
      const a = fx[k], len = fx[k + 1] - a, m = Math.max(1, Math.ceil(len / pitch - 1e-6)), sp = len / m;
      for (let j = 0; j < m; j++) out.push(half ? {t:a + (j + .5) * sp, fixed:false, corner:false} : {t:a + j * sp, fixed:j === 0, corner:j === 0 && isCorner(a)});
    }
    if (!path.closed && !half) out.push({t:path.total, fixed:true, corner:isCorner(path.total)});
    return out;
  }

  // ---------------------------------------------------------------- environment
  const baseHoles = new WeakMap();
  function holeIndex(board, defs, revision) {
    const c = baseHoles.get(board);
    if (c && revision != null && c.revision === revision && c.items === board.items) return c.index;
    const index = grid(1);
    const A = At();
    for (const it of board.items || []) {
      if (it.kind === "via" && it.drill > 0) index.add(it.x, it.y, it.drill / 2, it.id);
      else if (it.kind === "pad" && it.drill > 0) index.add(it.x, it.y, it.drill / 2, it.id);
      else if (it.kind === "part") {
        const fp = defs?.get?.(it.def)?.footprint;
        for (const p of fp?.pads || []) if (p.drill > 0) { const c = A ? A.world([p.x, p.y], it) : [it.x + p.x, it.y + p.y]; index.add(c[0], c[1], p.drill / 2, it.id); }
      }
    }
    baseHoles.set(board, {revision, items:board.items, index});
    return index;
  }
  // Uniform hash grid of circles {x, y, r, id}.
  function grid(cs) {
    const cells = new Map(), list = [];
    const key = (i, j) => i * 1048576 + j;
    return {
      list,
      add(x, y, r, id) {
        const e = {x, y, r, id}; list.push(e);
        const i = Math.floor(x / cs), j = Math.floor(y / cs), k = key(i, j);
        let c = cells.get(k); if (!c) cells.set(k, c = []); c.push(e); return e;
      },
      // First circle within `gap` (edge to edge) of a circle (x, y, r), skipping ids in `skip`.
      hit(x, y, r, gap, maxR, skip) {
        const reach = r + gap + maxR, i0 = Math.floor((x - reach) / cs), i1 = Math.floor((x + reach) / cs), j0 = Math.floor((y - reach) / cs), j1 = Math.floor((y + reach) / cs);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const c = cells.get(key(i, j)); if (!c) continue;
          for (const e of c) {
            if (skip && e.id != null && skip.has(e.id)) continue;
            const lim = r + e.r + gap; const dx = e.x - x, dy = e.y - y;
            if (dx * dx + dy * dy < lim * lim - TOL) return e;
          }
        }
        return null;
      },
      nearest(x, y, maxD, filter) {
        const i0 = Math.floor((x - maxD) / cs), i1 = Math.floor((x + maxD) / cs), j0 = Math.floor((y - maxD) / cs), j1 = Math.floor((y + maxD) / cs);
        let best = null, bd = maxD;
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const c = cells.get(key(i, j)); if (!c) continue;
          for (const e of c) { if (filter && !filter(e)) continue; const d = Math.hypot(e.x - x, e.y - y); if (d <= bd) { bd = d; best = e; } }
        }
        return best ? {e:best, d:bd} : null;
      }
    };
  }
  // Poured copper of one net on one layer: ring edges bucketed by row (for
  // parity) and by cell (for the distance to the boundary).
  const pourCache = new WeakMap();
  function pourIndexes(board) {
    const pours = board.pcbDrawing?.pours;
    if (!Array.isArray(pours) || !pours.length) return {byLayer:new Map(), get:() => null};
    let c = pourCache.get(pours); if (c) return c;
    const P = globalThis.AtriumPolygonPour, byLayer = new Map(), built = new Map();
    for (const r of pours) {
      if (!r || !r.layer) continue;
      let m = byLayer.get(r.layer); if (!m) byLayer.set(r.layer, m = new Map());
      const net = r.net || ""; if (!m.has(net)) m.set(net, []); m.get(net).push(r);
    }
    function ringsOf(region) {
      if (P?.rings) try { return P.rings(region); } catch { return []; }
      if (Array.isArray(region.outline)) return [region.outline.flat(), ...(region.holes || []).map(h => h.flat())];
      return [];
    }
    function build(regions) {
      const cs = 0.5, X1 = [], Y1 = [], X2 = [], Y2 = [], RG = [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      regions.forEach((reg, ri) => {
        for (const ring of ringsOf(reg)) {
          const n = ring.length >> 1;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const ax = ring[2 * j], ay = ring[2 * j + 1], bx = ring[2 * i], by = ring[2 * i + 1];
            X1.push(ax); Y1.push(ay); X2.push(bx); Y2.push(by); RG.push(ri);
            if (ax < x0) x0 = ax; if (ax > x1) x1 = ax; if (ay < y0) y0 = ay; if (ay > y1) y1 = ay;
          }
        }
      });
      const E = X1.length;
      if (!E) return null;
      const nx = Math.max(1, Math.ceil((x1 - x0) / cs) + 1), ny = Math.max(1, Math.ceil((y1 - y0) / cs) + 1);
      const rows = Array.from({length:ny}, () => []), cells = new Map();
      for (let e = 0; e < E; e++) {
        const r0 = Math.floor((Math.min(Y1[e], Y2[e]) - y0) / cs), r1 = Math.floor((Math.max(Y1[e], Y2[e]) - y0) / cs);
        for (let r = r0; r <= r1; r++) rows[r].push(e);
        const c0 = Math.floor((Math.min(X1[e], X2[e]) - x0) / cs), c1 = Math.floor((Math.max(X1[e], X2[e]) - x0) / cs);
        for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) { const k = r * nx + cc; let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(e); }
      }
      const parity = new Uint8Array(regions.length);
      return {
        box:[x0, y0, x1, y1],
        inside(x, y) {
          if (x < x0 || x > x1 || y < y0 || y > y1) return false;
          const row = rows[Math.floor((y - y0) / cs)]; if (!row) return false;
          parity.fill(0);
          for (const e of row) {
            const ay = Y1[e], by = Y2[e];
            if ((ay > y) !== (by > y) && x < (X2[e] - X1[e]) * (y - ay) / (by - ay) + X1[e]) parity[RG[e]] ^= 1;
          }
          for (let i = 0; i < parity.length; i++) if (parity[i]) return true;
          return false;
        },
        // Is the boundary at least m away?
        clear(x, y, m) {
          const c0 = Math.floor((x - m - x0) / cs), c1 = Math.floor((x + m - x0) / cs), r0 = Math.floor((y - m - y0) / cs), r1 = Math.floor((y + m - y0) / cs), m2 = m * m;
          for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
            if (cc < 0 || cc >= nx || r < 0 || r >= ny) continue;
            const l = cells.get(r * nx + cc); if (!l) continue;
            for (const e of l) if (segDist2(x, y, X1[e], Y1[e], X2[e], Y2[e]) < m2) return false;
          }
          return true;
        }
      };
    }
    c = {byLayer, get(layer, net) {
      const k = layer + "\u0000" + net;
      if (!built.has(k)) { const regs = byLayer.get(layer)?.get(net); built.set(k, regs ? build(regs) : null); }
      return built.get(k);
    }};
    pourCache.set(pours, c);
    return c;
  }
  function flexRegions(board, defs) {
    const S = globalThis.AtriumStackup;
    if (!S || typeof S.regionsResolved !== "function") return [];
    let list; try { list = S.regionsResolved(board, defs) || []; } catch { return []; }
    const out = [];
    for (const r of Array.isArray(list) ? list : list.regions || []) {
      if (!r) continue;
      const flex = r.flex === true || r.rigid === false || /flex/i.test(String(r.kind || r.type || r.role || ""));
      const pts = r.outline || r.points || r.polygon || r.contour;
      if (flex && Array.isArray(pts) && pts.length >= 3 && Array.isArray(pts[0])) out.push({pts, box:boxOf(pts), margin:0});
    }
    // Bend zones, plus the Flex Via Keepout rule's distance (1 mm without a rule).
    let keep = 1;
    try { const r = globalThis.AtriumRules?.query?.(board, "flexVias", {}); if (finite(r?.bendKeepout)) keep = r.bendKeepout; } catch { /* default */ }
    for (const b of list.bends || []) if (Array.isArray(b?.zone) && b.zone.length >= 3) out.push({pts:b.zone, box:boxOf(b.zone), margin:keep});
    return out;
  }
  function boardGeometry(board) {
    const BS = globalThis.AtriumBoardShape;
    if (BS?.current) {
      try {
        const s = BS.current(board);
        if (s) { const f = BS.flatten(s); return {outline:dedupe(f.outline, true), cutouts:(f.cutouts || []).map(c => dedupe(c, true)).filter(c => c.length >= 3), exact:!!BS.fresh?.(board)}; }
      } catch { /* fall back to the polygon */ }
    }
    return {outline:Array.isArray(board.outline) && board.outline.length >= 3 ? dedupe(board.outline, true) : null, cutouts:[], exact:false};
  }
  function copperKeys(board, defs) {
    const S = globalThis.AtriumStackup;
    try { if (S?.copperLayers) { const k = S.copperLayers(board, defs); if (k?.length) return k; } } catch { /* below */ }
    return globalThis.AtriumRouter?.copperLayers ? AtriumRouter.copperLayers(board, defs) : ["Top", "Bottom"];
  }
  const layerIdx = k => k === "Top" ? 0 : k === "Bottom" ? 127 : (/^Inner (\d+)$/.exec(k || "") || [])[1] * 1 || -1;

  // The prototype via for a net: template, else the via tool default.
  function prototypeVia(board, net, params, project) {
    const VS = globalThis.AtriumViaStack;
    let v = {kind:"via", x:0, y:0, diameter:.6, drill:.3, layer:"Multi", net};
    if (VS) {
      try {
        if (params.template) { const t = VS.find(board, params.template, project); if (t) v = VS.applyTemplate(v, t); else v = VS.place(board, {x:0, y:0, net}, {project}); }
        else v = VS.place(board, {x:0, y:0, net}, {project});
      } catch { /* stock size */ }
    } else {
      try {
        const r = globalThis.AtriumRules?.query?.(board, "viaStyle", {net}, {project});
        if (r?.diameterPreferred > 0) v.diameter = r.diameterPreferred;
        if (r?.holePreferred > 0 && r.holePreferred < v.diameter) v.drill = r.holePreferred;
      } catch { /* stock */ }
    }
    if (finite(params.diameter) && params.diameter > 0) v.diameter = params.diameter;
    if (finite(params.drill) && params.drill > 0 && params.drill < v.diameter) v.drill = params.drill;
    delete v.id; v.net = net; v.layer = "Multi";
    return v;
  }
  function holeGapRule(board, net, project) {
    try {
      const R = globalThis.AtriumRules;
      if (R?.resolver) { const r = R.resolver(board, project ? {project} : {})("holeToHole", {net}); if (finite(r?.gap)) return r.gap; }
    } catch { /* default */ }
    return 0.254;
  }

  // Shared state for one or more fences planned together.
  function environment(board, defs, opts = {}) {
    const Rt = globalThis.AtriumRouter;
    if (!Rt) throw Error("Via fencing needs the router module.");
    const core = Rt.core, ignore = new Set(opts.ignore || []);
    const W = opts.world || Rt.world(board, defs, {revision:opts.revision});
    W.scene.reset();
    // Copper of vias being replaced is hidden for this plan only (scene.reset restores it).
    for (const id of ignore) {
      const o = W.ownerById.get(id); if (o == null) continue;
      const rec = W.owners[o];
      for (let f = rec.first; f < rec.first + rec.count; f++) if (!(W.dead[f] & 2)) { W.dead[f] |= 2; W.scene.marked.push(f); }
      W.scene.dirty = true;
    }
    const rules = core.rulesFor(board, opts.rules, opts.project);
    const holes = holeIndex(board, defs, opts.revision), added = grid(1);
    let maxHole = 0; for (const h of holes.list) if (h.r > maxHole) maxHole = h.r;
    const geo = boardGeometry(board);
    for (const c of geo.cutouts) c.box = boxOf(c);
    return {board, defs, opts, W, core, rules, ignore, holes, added, maxHole, geo, pours:pourIndexes(board), flex:flexRegions(board, defs),
      layers:copperKeys(board, defs), project:opts.project, done:() => W.scene.reset()};
  }
  // Checker for one stitch net and via size.
  function checker(env, net, proto, params) {
    const {W, core, rules} = env;
    const netId = W.netIds.has(net) ? W.netIds.get(net) : -99;
    const r = proto.diameter / 2, hr = proto.drill / 2;
    const span = proto.fromLayer && proto.toLayer ? [layerIdx(proto.fromLayer), layerIdx(proto.toLayer)].sort((a, b) => a - b) : [0, 127];
    const lo = span[0], hi = span[1];
    const spanned = env.layers.filter(k => { const i = layerIdx(k); return i >= lo && i <= hi; });
    const holeGap = finite(params.holeGap) ? params.holeGap : holeGapRule(env.board, net, env.project);
    const edgeClr = rules.edgeClearance(net);
    const bound = rules.maxClearance?.();
    const reach = r + Math.max(finite(bound) ? bound : 1, edgeClr) + 0.01;
    const clrCache = new Map();
    const clr = (n, li) => {
      const k = n * 64 + li; let v = clrCache.get(k);
      if (v === undefined) { v = n === OUTLINE ? edgeClr : n === KEEPOUT ? 0 : rules.clearance(net, n >= 0 ? W.netName(n) : "", core.layerName(li)); clrCache.set(k, v); }
      return v;
    };
    // Required pour layers.
    let need = [];
    if (Array.isArray(params.pourLayers)) need = params.pourLayers.filter(k => spanned.includes(k));
    else if (params.pourLayers !== "none") need = spanned.filter(k => env.pours.byLayer.get(k)?.has(net));
    const needIdx = need.map(k => env.pours.get(k, net)).filter(Boolean);
    const others = [];
    if (params.avoidOtherPours !== false) for (const k of spanned) for (const n of env.pours.byLayer.get(k)?.keys() || []) if (n !== net) { const ix = env.pours.get(k, n); if (ix) others.push(ix); }
    const margin = finite(params.pourMargin) ? params.pourMargin : 0.05;
    const minEdge = {value:0};
    function test(x, y) {
      if (!core.insideOutline(W, x, y)) return "edge";
      for (const c of env.geo.cutouts) if (x > c.box[0] - reach && x < c.box[2] + reach && y > c.box[1] - reach && y < c.box[3] + reach && (inRing(x, y, c) || ringDist(c, x, y) < r + edgeClr - TOL)) return "edge";
      if (minEdge.value > 0 && env.geo.outline && (ringDist(env.geo.outline, x, y) < minEdge.value - 1e-6 || env.geo.cutouts.some(c => ringDist(c, x, y) < minEdge.value - 1e-6))) return "edge";
      if (params.avoidFlex !== false) for (const f of env.flex) { const m = r + f.margin; if (x > f.box[0] - m && x < f.box[2] + m && y > f.box[1] - m && y < f.box[3] + m && (inRing(x, y, f.pts) || ringDist(f.pts, x, y) < m)) return "flex"; }
      if (env.holes.hit(x, y, hr, holeGap, env.maxHole, env.ignore) || env.added.hit(x, y, hr, holeGap, hr, null)) return "hole";
      for (const ix of needIdx) if (!ix.inside(x, y) || !ix.clear(x, y, margin)) return "pour";
      for (const ix of others) if (ix.inside(x, y) || !ix.clear(x, y, r)) return "otherPour";
      const m = core.candidates(W, x, y, x, y, reach, lo, hi), qb = W.qb;
      for (let i = 0; i < m; i++) {
        const f = qb[i], n = W.net[f];
        if (n >= 0 && n === netId) continue;
        const req = r + clr(n, W.lo[f] || 0);
        if (W.x0[f] - req > x || W.x1[f] + req < x || W.y0[f] - req > y || W.y1[f] + req < y) continue;
        if (core.fdist(W, f, x, y, x, y) < req - TOL) {
          if (n === OUTLINE) return "edge";
          if (n === KEEPOUT) return "keepout";
          if (n === HOLE) return "hole";
          return W.owners[W.own[f]]?.kind || "copper";
        }
      }
      return null;
    }
    return {test, r, hr, holeGap, edgeClr, netId, lo, hi, spanned, need, minEdge, accept:(x, y) => env.added.add(x, y, hr, null)};
  }

  // ---------------------------------------------------------------- sources
  function boardNets(board, defs) {
    const s = new Set();
    for (const i of board.items || []) {
      if (i.net) s.add(i.net);
      if (i.pinNets) for (const v of Object.values(i.pinNets)) if (v) s.add(v);
    }
    for (const r of board.pcbDrawing?.pours || []) if (r.net) s.add(r.net);
    return [...s].sort();
  }
  function classMembers(board, cls, project) {
    try { return globalThis.AtriumRules?.netClasses?.(board, {project})?.[cls] || []; } catch { return []; }
  }
  function pairNets(board, pair, project) {
    if (Array.isArray(pair)) return pair.slice(0, 2);
    try { const p = globalThis.AtriumRules?.diffPairs?.(board, {project})?.find(x => x.name === pair); if (p) return [p.positive, p.negative]; } catch { /* none */ }
    return [];
  }
  // Signal tracks of a path source.
  function sourceTracks(board, source, project) {
    const tracks = (board.items || []).filter(i => i.kind === "track" && Array.isArray(i.points) && i.points.length >= 2 && layerIdx(i.layer) >= 0);
    if (source.trackIds?.length) { const s = new Set(source.trackIds); return tracks.filter(t => s.has(t.id)); }
    let nets = null;
    if (source.net) nets = [source.net];
    else if (source.nets) nets = source.nets;
    else if (source.netClass) nets = classMembers(board, source.netClass, project);
    else if (source.pair) nets = pairNets(board, source.pair, project);
    if (!nets) return [];
    const s = new Set(nets);
    return tracks.filter(t => s.has(t.net));
  }
  // The default stitch net: the user's, a ground-like pour net near the source, any ground net, else GND.
  function defaultNet(board, defs, box, exclude = []) {
    const pours = board.pcbDrawing?.pours || [], skip = new Set(exclude), score = new Map();
    for (const r of pours) {
      if (!r.net || skip.has(r.net)) continue;
      const b = r.bounds, near = !box || !b || !(b[0] > box[2] || b[2] < box[0] || b[1] > box[3] || b[3] < box[1]);
      if (near) score.set(r.net, (score.get(r.net) || 0) + (GROUND.test(r.net) ? 10 : 1));
    }
    for (const i of board.items || []) if (i.kind === "polygon" && i.net && !skip.has(i.net)) score.set(i.net, (score.get(i.net) || 0) + (GROUND.test(i.net) ? 5 : .5));
    const best = [...score].sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0];
    return boardNets(board, defs).find(n => GROUND.test(n) && !skip.has(n)) || "GND";
  }
  // Join tracks of one layer and net through nodes of degree two.
  function chains(tracks) {
    const key = (l, p) => l + "|" + Math.round(p[0] * 1e4) + "|" + Math.round(p[1] * 1e4);
    const nodes = new Map(), seen = new Set(), out = [];
    const ends = t => [key(t.layer, t.points[0]), key(t.layer, t.points.at(-1))];
    for (const t of tracks) for (const [e, k] of ends(t).entries()) { let l = nodes.get(k); if (!l) nodes.set(k, l = []); l.push({t, e}); }
    const deg = k => nodes.get(k)?.length || 0;
    function grow(t, fromEnd) {
      // Walk from track t leaving through end (1 - fromEnd).
      let pts = fromEnd === 0 ? t.points.slice() : t.points.slice().reverse();
      const ids = [t.id]; seen.add(t);
      let width = t.width || 0, k = key(t.layer, pts.at(-1));
      while (deg(k) === 2) {
        const nx = nodes.get(k).find(x => x.t !== t && !seen.has(x.t)); if (!nx) break;
        const q = nx.e === 0 ? nx.t.points : nx.t.points.slice().reverse();
        pts = pts.concat(q.slice(1)); seen.add(nx.t); ids.push(nx.t.id); width = Math.max(width, nx.t.width || 0);
        t = nx.t; k = key(t.layer, pts.at(-1));
      }
      return {pts, ids, width, endKey:k};
    }
    for (const t of tracks) {
      if (seen.has(t)) continue;
      const [k0, k1] = ends(t);
      if (deg(k0) === 2 && deg(k1) === 2) continue;   // interior: reached from a chain end
      const start = deg(k0) !== 2 ? 0 : 1;
      const g = grow(t, start), sk = start === 0 ? k0 : k1;
      out.push({points:dedupe(g.pts), layer:t.layer, net:t.net || "", width:g.width, ids:g.ids, startDeg:deg(sk), endDeg:deg(g.endKey), closed:false});
    }
    for (const t of tracks) {   // loops
      if (seen.has(t)) continue;
      const g = grow(t, 0), pts = dedupe(g.pts, true);
      out.push({points:pts, layer:t.layer, net:t.net || "", width:g.width, ids:g.ids, startDeg:2, endDeg:2, closed:true});
    }
    return out.filter(c => c.points.length >= 2);
  }

  // ---------------------------------------------------------------- pitch
  // λ/fraction at `frequency` GHz, from the layer's effective permittivity (its delay).
  function suggestPitch(board, defs, o = {}) {
    const f = +o.frequency || 10, frac = +o.fraction || 20, layer = o.layer || "Top", w = +o.width || 0.2;
    let dk = 4.2, h = 0.2, outer = layer === "Top" || layer === "Bottom", source = "default";
    try {
      const S = globalThis.AtriumStackup, stack = S?.get?.(board, defs);
      if (stack?.layers) {
        const L = stack.layers, i = L.findIndex(l => (l.type === "Signal" || l.type === "Plane") && l.key === layer);
        if (i >= 0) {
          const near = [L[i - 1], L[i + 1]].filter(l => l && l.type === "Dielectric");
          if (near.length) { dk = near.reduce((s, l) => s + (+l.dk || 4.2), 0) / near.length; h = Math.min(...near.map(l => +l.thickness || .2)); source = "stackup"; }
        }
      }
    } catch { /* defaults */ }
    // εeff from the layer's delay (AtriumStackup.delay, else AtriumImpedance.delayFallback): the delay DRC and timing use.
    let d = null;
    try { d = globalThis.AtriumStackup?.delay?.(board, layer, w, defs) || null; } catch { d = null; }
    if (!(d > 0)) d = globalThis.AtriumImpedance?.delayFallback({outer, w, h, er: dk}).delay;
    const eeff = d > 0 ? (d * C_MM_PS) ** 2 : dk;
    const lambda = C_MM_PS * 1000 / (f * Math.sqrt(eeff));   // mm
    return {pitch:r6(lambda / frac), lambda:r6(lambda), dk:r6(dk), eeff:r6(eeff), frequency:f, fraction:frac, source};
  }

  // ---------------------------------------------------------------- planning
  function params(p) {
    const out = {...DEFAULTS};
    if (plain(p)) for (const k of Object.keys(DEFAULTS)) if (p[k] !== undefined) out[k] = p[k];
    out.pitch = Math.max(0.05, +out.pitch || 1); out.rows = Math.max(1, Math.min(8, Math.round(+out.rows || 1)));
    out.count = Math.max(1, Math.min(4, Math.round(+out.count || 1)));
    return out;
  }
  function makeVia(proto, x, y, fenceId) {
    const v = JSON.parse(JSON.stringify(proto));
    v.id = newId(); v.x = r6(x); v.y = r6(y); v.groupId = "fence:" + fenceId;
    return v;
  }
  function stats0() { return {placed:0, skipped:0, nudged:0, candidates:0, largestGap:0, reasons:{}, ms:0}; }
  function skip(st, prev, c, reason, d) { st.skipped++; st.reasons[reason] = (st.reasons[reason] || 0) + 1; prev.skipped.push({x:r6(c.x), y:r6(c.y), d, reason}); }

  // Places candidates along rows of paths. Each path {pts, closed, fixed, out:[nx,ny] per point (optional)}.
  function placeOnPaths(env, chk, paths, P, fenceId, st, prev, proto) {
    const nudgeMax = finite(P.nudgeMax) ? P.nudgeMax : P.pitch * .45, step = Math.max(.02, P.pitch / 8), d = proto.diameter;
    const placed = [];
    const order = [];
    for (const path of paths) {
      const m = measure(path.pts, path.closed); Object.assign(path, m);
      path.got = [];
      if (path.total < 1e-6) continue;
      for (const c of sample(path, P.pitch, path.half)) order.push({path, ...c});
    }
    order.sort((a, b) => (b.corner - a.corner) || (b.fixed - a.fixed));
    for (const c of order) {
      st.candidates++;
      const p = pointAt(c.path, c.t);
      let reason = chk.test(p.x, p.y), at = p, t = c.t;
      if (reason && P.nudge) {
        const tries = [];
        for (let k = 1; k * step <= nudgeMax + 1e-9; k++) { tries.push([k * step, 0], [-k * step, 0]); }
        if (c.path.side) for (let k = 1; k * step <= nudgeMax + 1e-9; k++) tries.push([0, k * step]);
        for (const [dt, dn] of tries) {
          if (!c.path.closed && (c.t + dt < -1e-9 || c.t + dt > c.path.total + 1e-9)) continue;
          const q = dn ? {...p, x:p.x - p.uy * dn * c.path.side, y:p.y + p.ux * dn * c.path.side} : pointAt(c.path, c.t + dt);
          if (!chk.test(q.x, q.y)) { at = q; t = c.t + dt; reason = null; st.nudged++; break; }
        }
      }
      if (reason) { skip(st, prev, p, reason, d); continue; }
      chk.accept(at.x, at.y);
      c.path.got.push(t);
      placed.push(makeVia(proto, at.x, at.y, fenceId));
      prev.placed.push({x:r6(at.x), y:r6(at.y), d, drill:proto.drill, nudged:at !== p});
    }
    for (const path of paths) {
      if (!path.got || path.total < 1e-6) continue;
      const g = path.got.sort((a, b) => a - b);
      let gap = 0;
      if (!g.length) gap = path.total;
      else {
        for (let i = 1; i < g.length; i++) gap = Math.max(gap, g[i] - g[i - 1]);
        gap = path.closed ? Math.max(gap, g[0] + path.total - g.at(-1)) : Math.max(gap, g[0], path.total - g.at(-1));
      }
      st.largestGap = Math.max(st.largestGap, r6(gap));
      prev.paths.push({pts:path.pts, closed:path.closed});
    }
    st.placed += placed.length;
    return placed;
  }
  function rowSpacing(P, chk) { return finite(P.rowSpacing) && P.rowSpacing > 0 ? P.rowSpacing : Math.max(P.pitch * (P.stagger ? .866 : 1), 2 * chk.hr + chk.holeGap); }

  function planPath(env, spec, P, fenceId, st, prev) {
    const board = env.board, tracks = sourceTracks(board, spec.source || {}, env.project);
    if (!tracks.length) throw Error("Choose tracks, a net, a net class or a differential pair to fence.");
    const signal = new Set(tracks.map(t => t.net).filter(Boolean));
    const net = P.net || defaultNet(board, env.defs, boxOf(tracks.flatMap(t => t.points)), [...signal]);
    if (signal.has(net)) throw Error("The fence net must differ from the fenced net " + net + ".");
    const proto = prototypeVia(board, net, P, env.project), chk = checker(env, net, proto, P);
    const pair = spec.source?.pair ? pairNets(board, spec.source.pair, env.project) : null;
    if (P.pitchMode === "lambda") {
      const t = tracks[0], s = suggestPitch(board, env.defs, {layer:t.layer, width:t.width, frequency:P.frequency, fraction:P.fraction});
      P.pitch = Math.max(s.pitch, 2 * chk.hr + chk.holeGap); st.lambda = s;
    }
    const rs = rowSpacing(P, chk); st.rowSpacing = r6(rs);
    const paths = [], W = env.W;
    const endsOnTerminal = (ch, q) => {
      const n = W.netIds.get(ch.net); if (n == null) return false;
      const hit = env.core.sameNetAt(W, n, layerIdx(ch.layer), q, new Set(ch.ids.map(i => W.ownerById.get(i)).filter(o => o != null)));
      return !!hit && hit.kind !== "track";
    };
    for (const ch of chains(tracks)) {
      const hw = ch.width / 2, gap = (P.useRuleClearance !== false ? env.rules.clearance(ch.net, net, ch.layer) : 0) + (+P.offset || 0);
      st.offset = r6(gap);
      let sides = P.sides === "left" ? [1] : P.sides === "right" ? [-1] : [1, -1];
      if (pair?.length === 2 && (P.sides === "outer" || P.sides === "both") && !P.between) {
        // Keep the side facing away from the partner.
        const other = tracks.filter(t => t.net !== ch.net && t.layer === ch.layer), m = Math.floor(ch.points.length / 2);
        const a = ch.points[Math.max(0, m - 1)], b = ch.points[Math.min(ch.points.length - 1, Math.max(1, m))], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], nrm = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
        const near = s => { const q = [mid[0] + nrm[0] * s * (hw + gap + chk.r), mid[1] + nrm[1] * s * (hw + gap + chk.r)]; let best = Infinity; for (const t of other) for (let i = 1; i < t.points.length; i++) best = Math.min(best, Math.sqrt(segDist2(q[0], q[1], t.points[i - 1][0], t.points[i - 1][1], t.points[i][0], t.points[i][1]))); return best; };
        if (other.length) sides = [near(1) > near(-1) ? 1 : -1];
      }
      for (let row = 0; row < P.rows; row++) {
        const d = hw + gap + chk.r + row * rs, half = P.stagger && row % 2 === 1;
        const o = {cornerAngle:P.cornerAngle, step:Math.min(.25, P.pitch / 4)};
        const off = sides.map(s => ({s, ...offsetPath(ch.points, s * d, ch.closed, o)}));
        if (!P.cornerVias) for (const x of off) x.fixed = [];
        const mk = (pts, fixed, closed, side) => paths.push({pts, fixed, closed, half, side});
        if (ch.closed) { for (const x of off) mk(x.pts, x.fixed, true, x.s); continue; }
        // Free ends are capped; an end on a pad or via of its own net (a connector, a layer change) stops abreast.
        const free = (deg, q) => deg <= 1 && !endsOnTerminal(ch, q);
        const capStart = P.ends === "cap" && sides.length === 2 && free(ch.startDeg, ch.points[0]), capEnd = P.ends === "cap" && sides.length === 2 && free(ch.endDeg, ch.points.at(-1));
        if (sides.length === 2 && (capStart || capEnd)) {
          // One path around the stroke: right side reversed, start cap, left side, end cap.
          const L = off[0], Rr = off[1], p0 = ch.points[0], pn = ch.points.at(-1);
          const unit = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
          const u0 = unit(p0, ch.points[1]), un = unit(ch.points.at(-2), pn);
          const cap0 = halfTurn(p0, [p0[0] + u0[1] * d, p0[1] - u0[0] * d], [p0[0] - u0[0] * d, p0[1] - u0[1] * d], d, o.step);
          const capN = halfTurn(pn, [pn[0] - un[1] * d, pn[1] + un[0] * d], [pn[0] + un[0] * d, pn[1] + un[1] * d], d, o.step);
          const pts = [], fixed = [];
          const add = (list, fx) => { const at = pts.length; list.forEach(p => pts.push(p)); fx.forEach(i => fixed.push(at + i)); };
          const revR = Rr.pts.slice().reverse(), revF = Rr.fixed.map(i => Rr.pts.length - 1 - i);
          const inner = c => ({pts:c.pts.slice(1, -1), fixed:[c.tip - 1]});
          if (capStart && capEnd) { const c0 = inner(cap0), cn = inner(capN); add(c0.pts, c0.fixed); add(L.pts, L.fixed); add(cn.pts, cn.fixed); add(revR, revF); }
          else if (capStart) { const c0 = inner(cap0); add(revR, revF); add(c0.pts, c0.fixed); add(L.pts, L.fixed); }
          else { const cn = inner(capN); add(L.pts, L.fixed); add(cn.pts, cn.fixed); add(revR, revF); }
          mk(pts, fixed, capStart && capEnd, 0);
        } else for (const x of off) mk(x.pts, x.fixed, false, x.s);
      }
    }
    const add = placeOnPaths(env, chk, paths, P, fenceId, st, prev, proto);
    return {add, net, tracks};
  }
  // Closed loops a fence follows inside: the board outline and cutouts, a polygon or region
  // outline (source.polygonId / source.regionId), or the poured copper of a polygon
  // (source.poured: every island outline and the holes inside it).
  function edgeLoops(board, src, P) {
    const id = src.polygonId || src.regionId;
    if (!id) return null;
    const it = (board.items || []).find(i => i.id === id);
    if (!it) throw Error("The polygon or region this fence follows is no longer on the board.");
    if (src.poured) {
      const C = globalThis.AtriumPCBPours?.contours || globalThis.AtriumPolygonPour?.rings, loops = [];
      for (const reg of board.pcbDrawing?.pours || []) {
        if (reg.polygon !== id || !C) continue;
        let rings; try { rings = C(reg); } catch { continue; }
        rings.forEach((ring, k) => {
          const pts = []; for (let i = 0; i + 1 < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
          if (pts.length >= 3 && (k === 0 || P.cutouts !== false)) loops.push({pts:dedupe(pts, true), hole:k > 0});
        });
      }
      if (!loops.length) throw Error("The polygon has no poured copper yet. Repour it, or fence its outline.");
      return loops;
    }
    const pts = it.points || it.outline;
    if (!Array.isArray(pts) || pts.length < 3) throw Error("Choose a polygon or a region with an outline.");
    return [{pts:dedupe(pts, true), hole:false}];
  }
  function planEdge(env, spec, P, fenceId, st, prev) {
    const board = env.board, geo = env.geo, src = spec.source || {}, own = edgeLoops(board, src, P);
    if (!own && !geo.outline) throw Error("Set the board outline first.");
    const item = own ? (board.items || []).find(i => i.id === (src.polygonId || src.regionId)) : null;
    const net = P.net || (item?.kind === "polygon" ? item.net : "") || defaultNet(board, env.defs, null, []);
    const proto = prototypeVia(board, net, P, env.project), chk = checker(env, net, proto, P);
    // Inside a pour or region the first row sits a via radius plus the pour margin in from its edge.
    const inset0 = finite(P.inset) && P.inset > 0 ? P.inset : own ? chk.r + (finite(P.pourMargin) ? P.pourMargin : 0.05) + (+P.offset || 0) : chk.edgeClr + chk.r + (+P.offset || 0);
    const rs = rowSpacing(P, chk); st.inset = r6(inset0); st.rowSpacing = r6(rs);
    const loops = own || [{pts:geo.outline, hole:false}, ...(P.cutouts !== false ? geo.cutouts.map(c => ({pts:c, hole:true})) : [])];
    const paths = [];
    for (const lp of loops) {
      const pts = lp.pts, ccw = area2(pts) > 0;
      // Positive offset is to the left of travel; inwards for an outline is left when area2 < 0 (Y-down clockwise on screen).
      for (let row = 0; row < P.rows; row++) {
        const d = inset0 + row * rs;
        const sgn = (ccw ? 1 : -1) * (lp.hole ? -1 : 1);
        const off = offsetPath(pts, sgn * d, true, {cornerAngle:P.cornerAngle, step:Math.min(.25, P.pitch / 4)});
        // The offset must sit inside the board (probe its first point).
        paths.push({pts:off.pts, fixed:P.cornerVias ? off.fixed : [], closed:true, half:P.stagger && row % 2 === 1, side:sgn, inset:d});
      }
    }
    if (!own) chk.minEdge.value = inset0 - 1e-6;
    const add = placeOnPaths(env, chk, paths, P, fenceId, st, prev, proto);
    return {add, net};
  }
  const MAX_AREA_CANDIDATES = 200000;
  function planArea(env, spec, P, fenceId, st, prev) {
    const board = env.board, src = spec.source || {};
    let outline = Array.isArray(src.outline) ? src.outline : null, poly = null;
    if (!outline && src.polygonId) { poly = (board.items || []).find(i => i.id === src.polygonId && i.kind === "polygon"); outline = poly?.points || poly?.outline; }
    if (!outline && env.geo.outline) outline = env.geo.outline;
    if (!outline || outline.length < 3) throw Error("Choose a polygon to stitch.");
    outline = dedupe(outline, true);
    const net = P.net || poly?.net || defaultNet(board, env.defs, boxOf(outline), []);
    const proto = prototypeVia(board, net, P, env.project), chk = checker(env, net, proto, P);
    const pitch = Math.max(P.pitch, 2 * chk.hr + chk.holeGap), margin = finite(P.margin) ? P.margin : chk.r;
    const box = boxOf(outline), hex = P.pattern !== "grid", dy = hex ? pitch * Math.sqrt(3) / 2 : pitch;
    const y0 = Math.ceil(box[1] / dy) * dy, d = proto.diameter;
    // Bound the work before it starts: a hostile outline (100 m square) must not exhaust memory.
    const cells = (Math.floor((box[2] - box[0]) / pitch) + 1) * (Math.floor((box[3] - box[1]) / dy) + 1);
    if (!(cells <= MAX_AREA_CANDIDATES)) throw Error("Stitching this area would test about " + Math.round(cells).toLocaleString("en") + " via positions (limit " +
      MAX_AREA_CANDIDATES.toLocaleString("en") + "). Increase the pitch or choose a smaller polygon.");
    const placed = [];
    let row = Math.round(y0 / dy);
    for (let y = y0; y <= box[3] + 1e-9; y += dy, row++) {
      const shift = hex && (row & 1) ? pitch / 2 : 0, x0 = Math.ceil((box[0] - shift) / pitch) * pitch + shift;
      for (let x = x0; x <= box[2] + 1e-9; x += pitch) {
        if (!inRing(x, y, outline) || ringDist(outline, x, y) < margin) continue;
        st.candidates++;
        let reason = chk.test(x, y), at = [x, y];
        if (reason && P.nudge) {
          const k = pitch / 4;
          for (const [a, b] of [[k, 0], [-k, 0], [0, k], [0, -k], [k, k], [-k, k], [k, -k], [-k, -k]]) {
            const q = [x + a, y + b];
            if (inRing(q[0], q[1], outline) && ringDist(outline, q[0], q[1]) >= margin && !chk.test(q[0], q[1])) { at = q; reason = null; st.nudged++; break; }
          }
        }
        if (reason) { skip(st, prev, {x, y}, reason, d); continue; }
        chk.accept(at[0], at[1]);
        placed.push(makeVia(proto, at[0], at[1], fenceId));
        prev.placed.push({x:r6(at[0]), y:r6(at[1]), d, drill:proto.drill, nudged:at[0] !== x || at[1] !== y});
      }
    }
    st.placed += placed.length; st.pitch = r6(pitch); st.pattern = hex ? "hex" : "grid";
    // Largest void: the farthest skipped candidate from any placed via.
    if (prev.skipped.length && placed.length) {
      const g = grid(Math.max(1, pitch * 2)); for (const v of placed) g.add(v.x, v.y, 0, null);
      let worst = 0; for (const s of prev.skipped) { const n = g.nearest(s.x, s.y, pitch * 20); worst = Math.max(worst, n ? n.d : pitch * 20); }
      st.largestGap = r6(worst * 2);
    } else st.largestGap = placed.length ? r6(pitch) : 0;
    prev.paths.push({pts:outline, closed:true});
    return {add:placed, net};
  }

  // ---------------------------------------------------------------- return paths
  // Reference layers next to a copper layer: Plane layers, or layers holding
  // poured copper of a reference net.
  function referenceLayers(board, defs, refNets) {
    const keys = copperKeys(board, defs), types = new Map();
    try { const st = globalThis.AtriumStackup?.get?.(board, defs); for (const l of st?.layers || []) if (l.key) types.set(l.key, l.type); } catch { /* none */ }
    const poured = new Set((board.pcbDrawing?.pours || []).filter(r => refNets.has(r.net)).map(r => r.layer));
    const isRef = k => types.get(k) === "Plane" || poured.has(k);
    const map = new Map();
    keys.forEach((k, i) => map.set(k, [keys[i - 1], keys[i + 1]].filter(x => x && isRef(x))));
    return map;
  }
  function returnCandidates(board, defs, o, project) {
    const refNets = new Set(o.referenceNets?.length ? o.referenceNets : [o.net || defaultNet(board, defs, null, [])]);
    const signalOk = typeof o.signal === "function" ? o.signal : o.nets ? (s => n => s.has(n))(new Set(o.nets)) : o.netClass ? (s => n => s.has(n))(new Set(classMembers(board, o.netClass, project))) : n => !!n && !GROUND.test(n);
    const items = board.items || [];
    const tracksByNet = new Map();
    for (const t of items) if (t.kind === "track" && t.net && Array.isArray(t.points)) { let l = tracksByNet.get(t.net); if (!l) tracksByNet.set(t.net, l = []); l.push(t); }
    const refs = referenceLayers(board, defs, refNets), out = [];
    const refVias = grid(2);
    for (const v of items) if (v.kind === "via" && refNets.has(v.net) && (o.ignoreFence == null || fenceOfItem(v) !== o.ignoreFence)) refVias.add(v.x, v.y, (v.diameter || 0) / 2, v.id);
    for (const v of items) {
      if (v.kind !== "via" || !v.net || refNets.has(v.net) || !signalOk(v.net, v)) continue;
      const r = (v.diameter || .6) / 2, layers = new Set();
      for (const t of tracksByNet.get(v.net) || []) {
        const hw = (t.width || 0) / 2, a = t.points[0], b = t.points.at(-1);
        if (Math.hypot(a[0] - v.x, a[1] - v.y) <= r + hw || Math.hypot(b[0] - v.x, b[1] - v.y) <= r + hw) layers.add(t.layer);
      }
      if (layers.size < 2) continue;
      const L = [...layers].sort((a, b) => layerIdx(a) - layerIdx(b));
      // Same reference on every layer: no reference change.
      const sets = L.map(k => refs.get(k) || []);
      const common = sets[0].filter(k => sets.every(s => s.includes(k)));
      if (sets.every(s => s.length) && common.length) continue;
      const near = refVias.nearest(v.x, v.y, Math.max(o.distance || 1, 0) + 5);
      out.push({via:v, layers:L, refLayers:[...new Set(sets.flat())], nearest:near ? r6(near.d) : null, nearestId:near?.e.id || null, refNets:[...refNets]});
    }
    return out;
  }
  // DRC-style check: [{id, net, at, layers, nearest, required, ok}].
  function returnPaths(board, defs, o = {}) {
    const D = finite(o.distance) ? o.distance : 1;
    return returnCandidates(board, defs, o, o.project).map(c => ({id:c.via.id, net:c.via.net, at:[c.via.x, c.via.y], layers:c.layers, refLayers:c.refLayers,
      nearest:c.nearest, required:D, ok:c.nearest != null && c.nearest <= D + 1e-9, referenceNets:c.refNets}));
  }
  // Violations in the AtriumRules.drc shape (without rule fields).
  function returnPathCheck(board, defs, o = {}) {
    return returnPaths(board, defs, o).filter(c => !c.ok).map(c => ({id:c.id, title:"Via " + c.net + " (" + c.layers.join(" → ") + ")",
      detail:"No return via of " + c.referenceNets.join("/") + " within " + c.required + " mm" + (c.nearest != null ? " (nearest " + c.nearest + " mm)" : ""),
      what:"Return via distance", actual:c.nearest ?? Infinity, required:c.required, limit:"max", at:c.at}));
  }
  function planReturn(env, spec, P, fenceId, st, prev) {
    const board = env.board, src = spec.source || {};
    const refNets = P.referenceNets?.length ? P.referenceNets : [P.net || defaultNet(board, env.defs, null, [])];
    const net = P.net || refNets[0];
    const D = finite(P.distance) ? P.distance : 1;
    const list = returnCandidates(board, env.defs, {...src, referenceNets:refNets, distance:D, ignoreFence:spec.id || fenceId}, env.project).filter(c => !(c.nearest != null && c.nearest <= D + 1e-9));
    const proto = prototypeVia(board, net, P, env.project);
    const placed = [], d = proto.diameter;
    st.checked = list.length;
    for (const c of list) {
      const v = c.via, need = c.refLayers.filter(k => env.pours.byLayer.get(k)?.has(net));
      const chk = checker(env, net, proto, {...P, pourLayers:P.pourLayers === "auto" ? need : P.pourLayers});
      const r0 = (v.diameter || .6) / 2 + env.rules.clearance(v.net, net, "Top") + chk.r, got = [];
      const step = 0.05, ang = 24;
      for (let k = 0; k < P.count; k++) {
        let best = null;
        for (let rad = r0; rad <= D + 1e-9 && !best; rad += step) {
          for (let a = 0; a < ang; a++) {
            const th = a / ang * 2 * Math.PI, x = v.x + rad * Math.cos(th), y = v.y + rad * Math.sin(th);
            if (got.some(g => Math.abs(Math.atan2(Math.sin(th - g), Math.cos(th - g))) < Math.PI / 2)) continue;
            st.candidates++;
            if (!chk.test(x, y)) { best = {x, y, th}; break; }
          }
        }
        if (!best) { skip(st, prev, {x:v.x, y:v.y}, "noRoom", d); break; }
        got.push(best.th); chk.accept(best.x, best.y);
        placed.push(makeVia(proto, best.x, best.y, fenceId));
        prev.placed.push({x:r6(best.x), y:r6(best.y), d, drill:proto.drill, for:v.id});
      }
      prev.paths.push({pts:circle(v.x, v.y, D), closed:true});
    }
    st.placed += placed.length;
    return {add:placed, net};
  }
  function circle(x, y, r, n = 32) { const o = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; o.push([x + r * Math.cos(a), y + r * Math.sin(a)]); } return o; }

  // ---------------------------------------------------------------- signatures and storage
  function fences(board) { return Array.isArray(board?.viaFences) ? board.viaFences : []; }
  function fenceById(board, id) { return fences(board).find(f => f.id === id) || null; }
  function signature(board, defs, def, project) {
    const h = hasher(), src = def.source || {};
    h.value(def.kind); h.value(src); h.value(def.params || {}); h.value(globalThis.AtriumRules?.stored?.(board, project) ?? null);
    if (def.kind === "path") {
      for (const t of sourceTracks(board, src, project).sort((a, b) => String(a.id) < String(b.id) ? -1 : 1)) { h.text(String(t.id)); h.value(t.points); h.value([t.width, t.layer, t.net]); }
    } else if (def.kind === "edge") {
      const it = src.polygonId || src.regionId ? (board.items || []).find(i => i.id === (src.polygonId || src.regionId)) : null;
      if (it) { h.value([it.points || it.outline || null, it.layer, it.net]); if (src.poured) for (const r of board.pcbDrawing?.pours || []) if (r.polygon === it.id) { h.text(r.layer); h.text(r.data || ""); } }
      else { h.value(board.outline || null); h.value(board.boardShape || null); }
    }
    else if (def.kind === "area") {
      const poly = (board.items || []).find(i => i.id === src.polygonId);
      h.value(poly ? [poly.points, poly.layer, poly.net] : src.outline || board.outline || null);
      for (const r of board.pcbDrawing?.pours || []) if (r.net === def.net) { h.text(r.layer); h.text(r.data || ""); }
    } else if (def.kind === "return") {
      for (const i of board.items || []) if ((i.kind === "via" && fenceOfItem(i) !== def.id) || (i.kind === "track" && i.net !== def.net)) { h.value([i.kind, i.x, i.y, i.net, i.layer, i.points]); }
    }
    return h.hex();
  }
  // Fences with their present via count and staleness.
  function status(board, defs, o = {}) {
    const counts = new Map();
    for (const i of board.items || []) { const f = fenceOfItem(i); if (f) counts.set(f, (counts.get(f) || 0) + 1); }
    return fences(board).map(f => ({id:f.id, kind:f.kind, name:f.name || KIND_NAMES[f.kind], net:f.net, vias:counts.get(f.id) || 0, planned:f.count ?? null,
      stale:signature(board, defs, f, o.project) !== f.sig}));
  }
  // The fence id when every selected item belongs to one fence (else null).
  function fenceOfSelection(board, ids) {
    let id = null;
    for (const i of board.items || []) {
      if (!ids.has?.(i.id) && !(Array.isArray(ids) && ids.includes(i.id))) continue;
      const f = fenceOfItem(i); if (!f || (id && f !== id)) return null; id = f;
    }
    return id;
  }

  // plan(board, defs, spec, opts) -> {add, remove, modify, fences:{set, remove}, stats, preview}
  // spec: {kind, source, params, id?, name?}. With an id of a stored fence its
  // vias are replaced (regenerate). opts: {project, rules, world, revision}.
  function plan(board, defs, spec, opts = {}) {
    if (!board || board.kind && board.kind !== "pcb") throw Error("Open a PCB layout to place via fences.");
    return planMany(board, defs, [spec], opts);
  }
  function planMany(board, defs, specs, opts = {}) {
    const t0 = now(), ids = new Set(specs.map(s => s.id).filter(Boolean));
    // Locked fence vias stay (and are kept as obstacles); the rest are replaced.
    const remove = (board.items || []).filter(i => ids.has(fenceOfItem(i)) && i.locked !== true).map(i => i.id);
    const env = environment(board, defs, {...opts, ignore:remove});
    const out = {add:[], remove, modify:[], fences:{set:[], remove:[]}, stats:stats0(), preview:{placed:[], skipped:[], paths:[]}, results:[]};
    try {
      for (const raw of specs) {
        const kind = KINDS.includes(raw.kind) ? raw.kind : "path";
        const P = params(raw.params), st = stats0(), prev = {placed:[], skipped:[], paths:[]};
        const id = raw.id || newId(), t1 = now();
        const run = {path:planPath, edge:planEdge, area:planArea, return:planReturn}[kind];
        const r = run(env, {...raw, kind}, P, id, st, prev);
        st.ms = r6(now() - t1); st.pitch = st.pitch ?? r6(P.pitch); st.net = r.net;
        st.coverage = st.candidates ? r6(st.placed / st.candidates) : 0;
        const prior = fenceById(board, id);
        const source = JSON.parse(JSON.stringify(raw.source || {}));
        const def = {id, kind, name:raw.name || prior?.name || (kind === "edge" && (source.polygonId || source.regionId) ? (source.poured ? "Pour edge" : "Region edge") : KIND_NAMES[kind]) + (source.net ? " " + source.net : source.netClass ? " " + source.netClass : source.pair ? " " + source.pair : ""), net:r.net, source, params:JSON.parse(JSON.stringify(raw.params || {})), count:r.add.length};
        def.sig = signature({...board, items:(board.items || []).filter(i => !ids.has(fenceOfItem(i)))}, defs, def, opts.project);
        out.add.push(...r.add); out.fences.set.push(def);
        for (const k of ["placed", "skipped", "nudged", "candidates"]) out.stats[k] += st[k];
        out.stats.largestGap = Math.max(out.stats.largestGap, st.largestGap || 0);
        for (const [k, v] of Object.entries(st.reasons)) out.stats.reasons[k] = (out.stats.reasons[k] || 0) + v;
        Object.assign(out.stats, {pitch:st.pitch, offset:st.offset, inset:st.inset, rowSpacing:st.rowSpacing, lambda:st.lambda, net:r.net, checked:st.checked});
        for (const k of ["placed", "skipped", "paths"]) out.preview[k].push(...prev[k]);
        out.results.push({id, stats:st});
      }
    } finally { env.done(); }
    out.stats.coverage = out.stats.candidates ? r6(out.stats.placed / out.stats.candidates) : 0;
    out.stats.ms = r6(now() - t0);
    out.preview.stats = out.stats;
    return out;
  }
  // Regenerate stored fences (all, or the given ids; `staleOnly` for stale ones).
  function regenerate(board, defs, ids, opts = {}) {
    let list = fences(board);
    if (ids?.length) { const s = new Set(ids); list = list.filter(f => s.has(f.id)); }
    if (opts.staleOnly) { const st = new Map(status(board, defs, opts).map(s => [s.id, s.stale])); list = list.filter(f => st.get(f.id)); }
    if (!list.length) return {add:[], remove:[], modify:[], fences:{set:[], remove:[]}, stats:stats0(), preview:{placed:[], skipped:[], paths:[]}};
    return planMany(board, defs, list.map(f => ({id:f.id, kind:f.kind, name:f.name, source:f.source, params:{...f.params, net:f.params?.net || f.net}})), opts);
  }
  function removePlan(board, ids) {
    const s = new Set(ids && ids.length ? ids : fences(board).map(f => f.id));
    return {add:[], modify:[], remove:(board.items || []).filter(i => s.has(fenceOfItem(i))).map(i => i.id), fences:{set:[], remove:[...s]}};
  }
  // Commit a plan (call inside one undoable edit). opts {defs, repour, project}:
  // with repour, polygon pours are repoured so stitch vias join the copper.
  function applyPlan(board, p, opts = {}) {
    if (p.remove?.length) { const gone = new Set(p.remove); board.items = board.items.filter(i => !gone.has(i.id)); }
    if (p.modify?.length) {
      const byId = new Map(board.items.map(i => [i.id, i]));
      for (const m of p.modify) { const it = byId.get(m.id); if (it) Object.assign(it, m.set || Object.fromEntries(Object.entries(m).filter(([k]) => k !== "id"))); }
    }
    for (const it of p.add || []) board.items.push(it);
    const fx = p.fences || {};
    if (fx.remove?.length || fx.set?.length) {
      const drop = new Set(fx.remove || []);
      let list = fences(board).filter(f => !drop.has(f.id));
      for (const d of fx.set || []) { const i = list.findIndex(f => f.id === d.id); if (i >= 0) list[i] = d; else list.push(d); }
      if (list.length) board.viaFences = list; else delete board.viaFences;
    }
    const P = globalThis.AtriumPolygonPour;
    if (opts.repour && P && (board.items || []).some(i => i.kind === "polygon") && ((p.add?.length || 0) + (p.remove?.length || 0)) > 0) {
      try { P.apply(board, opts.defs, {project:opts.project}); } catch { /* the pour stays stale; the user can repour */ }
    }
    return board;
  }

  // ---------------------------------------------------------------- canvas overlay
  // draw(ctx2d, preview, {scale, dpr, worldToScreen, copper}) in world space.
  function draw(g, pv, view = {}) {
    if (!pv) return;
    const s = view.scale || 1, px = 1 / s;
    g.save();
    g.lineCap = "round"; g.lineJoin = "round";
    g.setLineDash([4 * px, 3 * px]); g.lineWidth = px; g.strokeStyle = "rgba(120,190,255,.55)";
    for (const p of pv.paths || []) {
      if (!p.pts?.length) continue;
      g.beginPath(); p.pts.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); if (p.closed) g.closePath(); g.stroke();
    }
    g.setLineDash([]);
    const fill = view.copper ? view.copper("Multi") : "#c8a24a";
    g.globalAlpha = .85;
    for (const v of pv.placed || []) {
      g.beginPath(); g.arc(v.x, v.y, v.d / 2, 0, 2 * Math.PI); g.fillStyle = fill; g.fill();
      g.beginPath(); g.arc(v.x, v.y, (v.drill || v.d / 2) / 2, 0, 2 * Math.PI); g.fillStyle = "#1b1b1b"; g.fill();
      if (v.nudged) { g.beginPath(); g.arc(v.x, v.y, v.d / 2 + 1.5 * px, 0, 2 * Math.PI); g.strokeStyle = "#f0c040"; g.lineWidth = 1.2 * px; g.stroke(); }
    }
    g.globalAlpha = 1; g.strokeStyle = "#ff4d4d"; g.lineWidth = 1.4 * px;
    for (const v of pv.skipped || []) {
      const r = Math.max(v.d / 2, 3 * px), k = r * .6;
      g.beginPath(); g.arc(v.x, v.y, r, 0, 2 * Math.PI); g.moveTo(v.x - k, v.y - k); g.lineTo(v.x + k, v.y + k); g.moveTo(v.x + k, v.y - k); g.lineTo(v.x - k, v.y + k); g.stroke();
    }
    g.restore();
    const st = pv.stats;
    if (st && view.worldToScreen && pv.placed?.length) {
      const first = pv.placed[0], at = view.worldToScreen([first.x, first.y]), dpr = view.dpr || 1;
      const text = st.placed + " placed · " + st.skipped + " skipped" + (st.largestGap ? " · max gap " + (+st.largestGap).toFixed(2) + " mm" : "");
      g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.font = "500 11px ui-monospace, Menlo, monospace";
      const w = g.measureText(text).width + 12, x = at[0] + 14, y = at[1] - 26;
      g.fillStyle = "rgba(20,20,20,.86)"; g.fillRect(x, y, w, 18); g.fillStyle = st.skipped ? "#f0c040" : "#9fe0b0"; g.fillText(text, x + 6, y + 13); g.restore();
    }
  }

  // ---------------------------------------------------------------- dialog (DOM)
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = v; else if (k === "class") n.className = v; else if (k.startsWith("on")) n[k] = v; else if (k in n && typeof v !== "string") n[k] = v; else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids) if (c != null) n.append(c);
    return n;
  }
  const MODE_TITLES = {path:"Fence", edge:"Edge", area:"Area", return:"Return path"};
  // open(ctx, {mode, polygonId}) — ctx: {doc, defs, project, edit, info, revision(), selection(), preview(p), select(ids), units}
  function open(ctx, o = {}) {
    const doc = ctx.doc, defs = ctx.defs;
    if (!doc || doc.kind !== "pcb") { ctx.info?.("Open a board layout first."); return null; }
    document.querySelector("dialog.via-fence-panel")?.close();
    const sel = new Set(ctx.selection?.() || []), items = doc.items || [];
    const selTracks = items.filter(i => sel.has(i.id) && i.kind === "track").map(i => i.id);
    const selPoly = items.find(i => sel.has(i.id) && i.kind === "polygon");
    const editing = o.fenceId ? fenceById(doc, o.fenceId) : null;
    const nets = boardNets(doc, defs), classes = Object.keys((() => { try { return globalThis.AtriumRules?.netClasses?.(doc, {project:ctx.project}) || {}; } catch { return {}; } })());
    const pairs = (() => { try { return globalThis.AtriumRules?.diffPairs?.(doc, {project:ctx.project}) || []; } catch { return []; } })();
    const polys = items.filter(i => i.kind === "polygon");
    // Copper regions (solid regions and fills on a copper layer) a fence can follow.
    const regions = items.filter(i => i.kind === "graphic" && i.fill && Array.isArray(i.points) && i.points.length >= 3 && /^(Top|Bottom|Inner \d+)$/.test(i.layer || ""));
    const templates = (() => { try { return globalThis.AtriumViaStack?.templates?.(doc, ctx.project) || []; } catch { return []; } })();
    const state = {mode:editing?.kind || o.mode || (selPoly ? "area" : "path"), P:{...DEFAULTS, ...(editing?.params || {})}, source:editing?.source ? {...editing.source} : null};
    if (!state.source) {
      if (state.mode === "path") state.source = selTracks.length ? {trackIds:selTracks} : nets.length ? {net:items.find(i => sel.has(i.id) && i.net && !GROUND.test(i.net))?.net || nets.find(n => !GROUND.test(n)) || nets[0]} : {};
      else if (state.mode === "area") state.source = {polygonId:o.polygonId || selPoly?.id || polys[0]?.id};
      else state.source = {};
    }
    if (!state.P.net) state.P.net = editing?.net || "";
    let current = null, timer = 0;
    const d = el("dialog", {class:"ui-dialog ui-sheet work-dialog via-fence-panel", "aria-label":"Via fencing"});
    const tabs = el("div", {class:"vf-tabs ui-tabs", "data-strip":"", role:"tablist"});
    for (const k of KINDS) tabs.append(el("button", {type:"button", class:"ui-tab", role:"tab", "data-mode":k, text:MODE_TITLES[k], "aria-selected":String(k === state.mode), onclick:() => { state.mode = k; if (k === "area" && !state.source?.polygonId) state.source = {polygonId:selPoly?.id || polys[0]?.id}; else if (k === "path" && !(state.source?.trackIds || state.source?.net || state.source?.netClass || state.source?.pair)) state.source = selTracks.length ? {trackIds:selTracks} : {net:nets.find(n => !GROUND.test(n)) || ""}; else if (k === "return" || k === "edge") state.source = {}; build(); schedule(); }}));
    const body = el("div", {class:"vf-body ui-dialog-body"}), stats = el("div", {class:"vf-stats", role:"status", "aria-live":"polite"}), list = el("div", {class:"vf-list"});
    const place = el("button", {type:"button", class:"vf-primary ui-button", "data-variant":"primary", text:editing ? "Regenerate" : "Place", onclick:commit});
    const foot = el("div", {class:"work-actions ui-dialog-actions vf-actions"}, el("button", {type:"button", class:"ui-button", text:"Close", onclick:() => d.close()}), place);
    d.append(el("header", {class:"vf-head"}, el("h2", {class:"ui-dialog-title", text:"Via Fencing"}), el("small", {text:editing ? editing.name : "Shielding and stitching vias"})), tabs, body, stats, list, foot);
    const field = (label, control, unit) => {
      control.classList.add("ui-field");
      if (unit) control.classList.add("ui-field-number");
      return el("label", {class:"vf-field"}, el("span", {text:label}), unit ? el("span", {class:"vf-input ui-field-measure"}, control, el("small", {class:"ui-field-unit",text:unit})) : control);
    };
    const num = (key, step = "0.05", min = "0") => { const i = el("input", {type:"number", step, min, "data-numeric-unit":key==="frequency"?"GHz":key==="fraction"?"":key==="rows"?"ea":"mm", value:state.P[key] ?? ""}); i.oninput = () => { state.P[key] = i.value === "" ? null : +i.value; schedule(); }; return i; };
    const choice = (key, options, onChange) => { const s = el("select"); for (const [v, t] of options) s.add(new Option(t, v)); s.value = String(state.P[key]); s.onchange = () => { state.P[key] = s.value === "true" ? true : s.value === "false" ? false : s.value; onChange?.(); schedule(); }; return s; };
    const check = (key, label) => { const i = el("input", {class:"ui-checkbox", type:"checkbox", checked:!!state.P[key]}); i.onchange = () => { state.P[key] = i.checked; schedule(); }; return el("label", {class:"vf-check"}, i, el("span", {text:label})); };
    const group = (title, ...kids) => el("fieldset", {class:"vf-section"}, el("legend", {text:title}), ...kids);
    function netSelect(value, onChange, auto) {
      const s = el("select"); if (auto) s.add(new Option(auto, "")); for (const n of nets) s.add(new Option(n, n));
      if (value && !nets.includes(value)) s.add(new Option(value, value));
      s.value = value || ""; s.onchange = () => { onChange(s.value); schedule(); }; return s;
    }
    function sourceGroup() {
      const S = state.source || {}, kind = S.trackIds ? "tracks" : S.netClass != null ? "class" : S.pair != null ? "pair" : "net";
      const which = el("select");
      which.add(new Option("Selected tracks (" + selTracks.length + ")", "tracks")); which.add(new Option("Net", "net"));
      if (classes.length) which.add(new Option("Net class", "class")); if (pairs.length) which.add(new Option("Differential pair", "pair"));
      which.value = kind;
      const pick = el("span", {class:"vf-pick"});
      const fill = () => {
        pick.replaceChildren();
        if (which.value === "net") pick.append(netSelect(state.source.net, v => { state.source = {net:v}; }));
        if (which.value === "class") { const s = el("select"); for (const c of classes) s.add(new Option(c, c)); s.value = state.source.netClass || classes[0]; state.source = {netClass:s.value}; s.onchange = () => { state.source = {netClass:s.value}; schedule(); }; pick.append(s); }
        if (which.value === "pair") { const s = el("select"); for (const p of pairs) s.add(new Option(p.name + " (" + p.positive + " / " + p.negative + ")", p.name)); s.value = state.source.pair || pairs[0].name; state.source = {pair:s.value}; s.onchange = () => { state.source = {pair:s.value}; schedule(); }; pick.append(s); }
      };
      which.onchange = () => { state.source = which.value === "tracks" ? {trackIds:selTracks} : which.value === "net" ? {net:nets.find(n => !GROUND.test(n)) || ""} : which.value === "class" ? {netClass:classes[0]} : {pair:pairs[0]?.name}; fill(); schedule(); };
      fill();
      return group("Source", field("Fence", which), field("Object", pick));
    }
    function viaGroup() {
      const t = el("select"); t.add(new Option("Board default / rule", ""));
      for (const x of templates) t.add(new Option(x.name, x.id));
      t.value = state.P.template || ""; t.onchange = () => { state.P.template = t.value || null; schedule(); };
      return group("Via", field("Stitch net", netSelect(state.P.net, v => { state.P.net = v; }, "Auto (GND / pour net)")), field("Template", t),
        field("Diameter", num("diameter", "0.01", "0.05"), "mm"), field("Hole", num("drill", "0.01", "0.05"), "mm"));
    }
    function pitchGroup(extra = []) {
      const lam = el("small", {class:"vf-note"});
      const upd = () => {
        lam.textContent = "";
        if (state.P.pitchMode !== "lambda") return;
        const t = items.find(i => i.kind === "track" && (state.source?.trackIds?.includes(i.id) || i.net === state.source?.net)) || {};
        const s = suggestPitch(doc, defs, {layer:t.layer, width:t.width, frequency:state.P.frequency, fraction:state.P.fraction});
        lam.textContent = "Dk " + s.dk + " (εeff " + s.eeff + ", " + s.source + ") · λ " + s.lambda.toFixed(2) + " mm · pitch λ/" + s.fraction + " = " + s.pitch.toFixed(3) + " mm";
      };
      const freq = num("frequency", "0.5", "0.01"); freq.addEventListener("input", upd);
      const fr = num("fraction", "1", "4"); fr.addEventListener("input", upd);
      const mode = choice("pitchMode", [["fixed", "Fixed pitch"], ["lambda", "λ / n at frequency"]], () => { upd(); build(); });
      upd();
      return group("Pitch", field("Mode", mode), state.P.pitchMode === "lambda" ? field("Max frequency", freq, "GHz") : field("Pitch", num("pitch", "0.05", "0.1"), "mm"),
        state.P.pitchMode === "lambda" ? field("Fraction n", fr) : null, lam, ...extra);
    }
    function pourGroup() {
      const sel = el("select");
      for (const [v, t] of [["auto", "Auto: where the stitch net is poured"], ["none", "Not required"], ...copperKeys(doc, defs).map(k => [k, "Only " + k])]) sel.add(new Option(t, v));
      sel.value = Array.isArray(state.P.pourLayers) ? state.P.pourLayers[0] : state.P.pourLayers;
      sel.onchange = () => { state.P.pourLayers = sel.value === "auto" || sel.value === "none" ? sel.value : [sel.value]; schedule(); };
      return group("Copper and keep-outs", field("Stitch copper", sel), check("avoidOtherPours", "Keep out of other nets' pours"), check("avoidFlex", "Keep out of flex regions"), check("nudge", "Nudge blocked vias to the nearest legal spot"));
    }
    function build() {
      for (const b of tabs.children) {
        const selected = b.dataset.mode === state.mode;
        b.setAttribute("aria-selected", String(selected));
        b.tabIndex = selected ? 0 : -1;
      }
      body.replaceChildren();
      const left = el("div", {class:"vf-col"}), right = el("div", {class:"vf-col"});
      if (state.mode === "path") {
        left.append(sourceGroup(), viaGroup());
        right.append(group("Placement", field("Sides", choice("sides", [["both", "Both sides"], ["left", "Left"], ["right", "Right"], ["outer", "Outer (pairs)"]])),
          field("Extra offset", num("offset", "0.05", "0"), "mm"), check("useRuleClearance", "Start at the rule clearance"),
          field("Rows", num("rows", "1", "1")), field("Row spacing", num("rowSpacing", "0.05", "0"), "mm"), check("stagger", "Stagger rows"),
          field("Track ends", choice("ends", [["cap", "Cap around the end"], ["terminate", "Stop abreast of the end"]])), check("cornerVias", "Via at every corner"), check("between", "Pairs: also between P and N")),
        pitchGroup(), pourGroup());
      } else if (state.mode === "edge") {
        left.append(viaGroup(), pitchGroup());
        const along = el("select"); along.setAttribute("aria-label", "Fence along");
        along.add(new Option("Board outline and cutouts", ""));
        for (const q of polys) { along.add(new Option("Pour outline · " + (q.name || "Polygon") + " · " + (q.net || "no net") + " · " + q.layer, "poly:" + q.id)); along.add(new Option("Poured copper edges · " + (q.name || "Polygon") + " · " + q.layer, "pour:" + q.id)); }
        for (const q of regions) along.add(new Option("Region · " + (q.net || "no net") + " · " + q.layer, "region:" + q.id));
        const S0 = state.source || {};
        along.value = S0.polygonId ? (S0.poured ? "pour:" : "poly:") + S0.polygonId : S0.regionId ? "region:" + S0.regionId : "";
        along.onchange = () => { const [k, id] = along.value.split(/:(.*)/s); state.source = !k ? {} : k === "region" ? {regionId:id} : {polygonId:id, ...(k === "pour" ? {poured:true} : {})}; schedule(); };
        left.append(group("Follow", field("Along", along), el("small", {class:"vf-note", text:"Pour and region fences sit inside the copper, a via radius plus the pour margin from its edge."})));
        right.append(group("Edge", field("Inset", num("inset", "0.05", "0"), "mm"), el("small", {class:"vf-note", text:"Blank: edge clearance (board) or pour margin (pours, regions) plus the via radius."}), field("Rows", num("rows", "1", "1")), field("Row spacing", num("rowSpacing", "0.05", "0"), "mm"),
          check("stagger", "Stagger rows"), check("cutouts", "Also around cutouts"), check("cornerVias", "Via at every corner")), pourGroup());
      } else if (state.mode === "area") {
        const p = el("select"); for (const q of polys) p.add(new Option((q.name || "Polygon") + " · " + (q.net || "no net") + " · " + q.layer, q.id));
        p.add(new Option("Whole board outline", "")); p.value = state.source?.polygonId || "";
        p.onchange = () => { state.source = p.value ? {polygonId:p.value} : {}; schedule(); };
        left.append(group("Region", field("Polygon", p), field("Pattern", choice("pattern", [["hex", "Hexagonal"], ["grid", "Grid"]])), field("Pitch", num("pitch", "0.1", "0.2"), "mm"), field("Edge margin", num("margin", "0.05", "0"), "mm")), viaGroup());
        right.append(pourGroup());
      } else {
        const scope = el("select"); scope.add(new Option("All signal nets", "")); for (const n of nets) scope.add(new Option("Net " + n, "net:" + n)); for (const c of classes) scope.add(new Option("Class " + c, "class:" + c));
        scope.value = state.source?.nets ? "net:" + state.source.nets[0] : state.source?.netClass ? "class:" + state.source.netClass : "";
        scope.onchange = () => { const v = scope.value; state.source = v.startsWith("net:") ? {nets:[v.slice(4)]} : v.startsWith("class:") ? {netClass:v.slice(6)} : {}; schedule(); };
        left.append(group("Signal vias", field("Check", scope), field("Max distance D", num("distance", "0.1", "0.1"), "mm"), field("Vias to add", choice("count", [["1", "1"], ["2", "2 (both sides)"]], () => { state.P.count = +state.P.count; })),
          el("small", {class:"vf-note", text:"Signal vias that change reference planes need a reference via within D. Missing ones are proposed at the nearest legal spot."})), viaGroup());
        right.append(pourGroup());
      }
      body.append(left, right);
    }
    function specNow() { return {kind:state.mode, id:editing?.id, name:editing?.name, source:state.source || {}, params:Object.fromEntries(Object.entries(state.P).filter(([k, v]) => v !== DEFAULTS[k] || k === "net"))}; }
    function run() {
      try {
        current = plan(doc, defs, specNow(), {project:ctx.project, revision:ctx.revision?.()});
        const s = current.stats, rs = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => v + " " + (REASONS[k] || k)).join(", ");
        stats.replaceChildren(el("strong", {text:s.placed + " vias"}), el("span", {text:" placed · " + s.skipped + " skipped" + (s.nudged ? " · " + s.nudged + " nudged" : "") + " · largest gap " + (+s.largestGap || 0).toFixed(2) + " mm · net " + (s.net || "—") + (s.pitch ? " · pitch " + (+s.pitch).toFixed(3) + " mm" : "") + " · " + (+s.ms).toFixed(1) + " ms"}),
          ...[rs ? el("small", {text:"Skipped: " + rs}) : null, state.mode === "return" ? el("small", {text:(s.checked || 0) + " signal vias change reference without a return via within D."}) : null].filter(Boolean));
        stats.dataset.state = s.skipped ? "partial" : "ok";
        place.disabled = !s.placed && !(editing && current.remove.length);
        ctx.preview?.(current.preview);
      } catch (e) { current = null; stats.replaceChildren(el("span", {text:e.message})); stats.dataset.state = "error"; place.disabled = true; ctx.preview?.(null); }
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(run, 60); }
    function commit() {
      if (!current) return;
      const p = current;
      ctx.edit(() => applyPlan(doc, p, {defs, repour:true, project:ctx.project}));
      ctx.info?.((editing ? "Fence regenerated" : "Placed " + p.stats.placed + " fence vias") + (p.stats.skipped ? " · " + p.stats.skipped + " positions skipped" : ""));
      ctx.preview?.(null); d.close();
    }
    function paintList() {
      const st = status(doc, defs, {project:ctx.project});
      list.replaceChildren();
      if (!st.length) return;
      const t = el("table", {class:"vf-table"}), tb = el("tbody");
      t.append(el("thead", {}, el("tr", {}, el("th", {text:"Fence"}), el("th", {text:"Net"}), el("th", {text:"Vias"}), el("th", {text:""}))), tb);
      for (const f of st) tb.append(el("tr", {"data-stale":String(f.stale)}, el("td", {text:f.name}), el("td", {text:f.net || ""}), el("td", {text:String(f.vias)}),
        el("td", {}, f.stale ? el("span", {class:"ui-badge vf-badge", "data-tone":"warning", text:"stale"}) : null,
          el("button", {type:"button", class:"ui-button", "data-size":"sm", text:"Select", onclick:() => ctx.select?.(items.filter(i => fenceOfItem(i) === f.id).map(i => i.id))}),
          el("button", {type:"button", class:"ui-button", "data-size":"sm", text:"Regenerate", onclick:() => { const p = regenerate(doc, defs, [f.id], {project:ctx.project, revision:ctx.revision?.()}); ctx.edit(() => applyPlan(doc, p, {defs, repour:true, project:ctx.project})); ctx.info?.("Fence regenerated · " + p.stats.placed + " vias"); paintList(); }}),
          el("button", {type:"button", class:"ui-button", "data-size":"sm", "data-variant":"danger", text:"Remove", onclick:() => { ctx.edit(() => applyPlan(doc, removePlan(doc, [f.id]), {defs, repour:true, project:ctx.project})); ctx.info?.("Fence removed"); paintList(); }}))));
      list.append(el("details", {class:"vf-existing", open:true}, el("summary", {text:"Fences on this board (" + st.length + ")"}), t));
    }
    d.addEventListener("keydown", e => {
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); d.close(); }
    });
    d.addEventListener("close", () => { clearTimeout(timer); ctx.preview?.(null); d.remove(); });
    build(); paintList();
    document.body.append(d); globalThis.AtriumShell?.adoptDialog?.(d, {defaultAction:false}); d.show();
    run();
    return d;
  }
  const REASONS = {edge:"at the board edge", hole:"hole spacing", track:"track clearance", via:"via clearance", pad:"pad clearance", graphic:"copper clearance", copper:"copper clearance",
    keepout:"keep-out", pour:"outside stitch copper", otherPour:"in another net's pour", flex:"flex region", noRoom:"no legal spot within D"};
  // Inspector section for a selected fence group (editor patch), built with the Properties
  // panel's own helpers (AtriumNavHost.ui) so it looks like the editor's sections.
  function inspector(panel, ctx) {
    const ui = ctx.ui || globalThis.AtriumNavHost?.ui;
    if (!ui) return null;
    const doc = ctx.doc, id = ctx.fenceId, f = fenceById(doc, id), vias = (doc.items || []).filter(i => fenceOfItem(i) === id);
    const st = f ? status(doc, ctx.defs, {project:ctx.project}).find(x => x.id === id) : null;
    const s = ui.section(panel, f ? f.name : "Via fence"), row = (k, v) => ui.row(s, k, v);
    s.classList.add("vf-inspect");
    row("Kind", KIND_NAMES[f?.kind] || "Fence"); row("Net", f?.net || vias[0]?.net || ""); row("Vias", String(vias.length));
    if (f?.params?.pitch) row("Pitch", f.params.pitch + " mm");
    if (st) row("Source", st.stale ? "Changed — regenerate" : "Up to date");
    const acts = el("div", {class:"inspect-actions"});
    if (f) acts.append(ui.button("Edit…", () => open(ctx, {fenceId:id})),
      ui.button("Regenerate", () => { const p = regenerate(doc, ctx.defs, [id], {project:ctx.project, revision:ctx.revision?.()}); ctx.edit(() => applyPlan(doc, p, {defs:ctx.defs, repour:true, project:ctx.project})); ctx.select?.((doc.items || []).filter(i => fenceOfItem(i) === id).map(i => i.id)); ctx.info?.("Fence regenerated · " + p.stats.placed + " vias"); }));
    acts.append(ui.button("Remove fence", () => { ctx.edit(() => applyPlan(doc, f ? removePlan(doc, [id]) : {remove:vias.map(v => v.id)}, {defs:ctx.defs, repour:true, project:ctx.project})); ctx.select?.([]); ctx.info?.("Fence removed"); }));
    s.append(acts);
    return s;
  }
  // Menu commands: via-fence | fence-selected | fence-edge | fence-area | fence-return | fence-regenerate | fence-remove
  function command(a, ctx) {
    const doc = ctx.doc;
    if (!doc || doc.kind !== "pcb") { ctx.info?.("Open a board layout first."); return; }
    const sel = new Set(ctx.selection?.() || []);
    if (a === "fence-regenerate") {
      if (!fences(doc).length) { ctx.info?.("This board has no via fences."); return; }
      const p = regenerate(doc, ctx.defs, null, {project:ctx.project, revision:ctx.revision?.()});
      ctx.edit(() => applyPlan(doc, p, {defs:ctx.defs, repour:true, project:ctx.project}));
      ctx.info?.("Regenerated " + p.fences.set.length + " fence" + (p.fences.set.length === 1 ? "" : "s") + " · " + p.stats.placed + " vias"); return;
    }
    if (a === "fence-remove") {
      const ids = [...new Set((doc.items || []).filter(i => sel.has(i.id)).map(fenceOfItem).filter(Boolean))];
      if (!ids.length) { if (fences(doc).length) open(ctx, {mode:"path"}); ctx.info?.("Select a fence via to remove its fence, or use the list in Via Fencing."); return; }
      ctx.edit(() => applyPlan(doc, removePlan(doc, ids), {defs:ctx.defs, repour:true, project:ctx.project}));
      ctx.select?.([]); ctx.info?.("Removed " + ids.length + " fence" + (ids.length === 1 ? "" : "s")); return;
    }
    const fid = fenceOfSelection(doc, sel);
    if (a === "via-fence" && fid && fenceById(doc, fid)) return open(ctx, {fenceId:fid});
    return open(ctx, {mode:{"fence-selected":"path", "fence-edge":"edge", "fence-area":"area", "fence-return":"return"}[a]});
  }

  return Object.freeze({DEFAULTS, KINDS, KIND_NAMES, plan, planMany, regenerate, removePlan, applyPlan, status, signature, fences, fenceOfItem, fenceOfSelection,
    returnPaths, returnPathCheck, suggestPitch, defaultNet, boardNets, isGround:n => GROUND.test(n || ""), draw, open, inspector, command,
    _internal:{offsetPath, sample, chains, measure, pointAt, halfTurn, boardGeometry}});
})();
