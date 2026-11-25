"use strict";
// Differential-pair interactive routing on top of AtriumRouter's engine.
// The pair is routed as one centreline whose half width covers both traces
// (gap/2 + width); the traces are its parallel offsets at ±(gap + width)/2,
// so bends stay coupled with the correct inner/outer lengths. Breakouts from
// the start pads (or vias) to the coupled section are reported as uncoupled length.
globalThis.AtriumDiffPair = (() => {
  const RT = globalThis.AtriumRouter, C = RT.core;
  const {segmentDistance} = globalThis.AtriumGeometry;
  const now = typeof performance !== "undefined" && performance.now ? () => performance.now()
    : typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const {simplify, pathLength, connector, fillet} = C;
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  // ------------------------------------------------------------ pair definitions
  // Declared pairs (rules / signals.js stages), the board's own list, then name matches from the one
  // recogniser (rules.js detectDiffPairs → net-intent.js), marked source "names": suggestions until the user
  // declares them (the route bar offers it, route-feel.js); routing one as a pair never declares it.
  const SUFFIX = [[/^(.*?)_P$/i, "_N"], [/^(.*?)_DP$/i, "_DN"], [/^(.*?)\+$/, "-"], [/^(.*?)P$/, "N"], [/^(.*?)_H$/i, "_L"]];
  function pairs(board) {
    const out = [], seen = new Set();
    const R = globalThis.AtriumRules;
    if (R && typeof R.diffPairs === "function") {
      try {
        for (const p of R.diffPairs(board) || []) {
          const pos = p.positive ?? p.p ?? p.netP ?? p.pos ?? p.plus, neg = p.negative ?? p.n ?? p.netN ?? p.neg ?? p.minus;
          if (pos && neg) { out.push({name:p.name || String(pos).replace(/[_+]?P?$/i, ""), positive:pos, negative:neg, source:"rules"}); seen.add(pos); seen.add(neg); }
        }
      } catch { /* fall back to naming */ }
    }
    for (const p of board.diffPairs || []) if (p && p.positive && p.negative && !seen.has(p.positive)) { out.push({name:p.name || p.positive, positive:p.positive, negative:p.negative, source:"board"}); seen.add(p.positive); seen.add(p.negative); }
    const nets = new Set();
    for (const i of board.items || []) { if (i.net) nets.add(i.net); for (const n of Object.values(i.pinNets || {})) if (n) nets.add(n); }
    if (R && typeof R.detectDiffPairs === "function") {
      try {
        for (const p of R.detectDiffPairs([...nets], out) || []) if (!seen.has(p.positive) && !seen.has(p.negative)) { out.push({...p, source:"names"}); seen.add(p.positive); seen.add(p.negative); }
        return out;
      } catch { /* the fallback below */ }
    }
    // Without rules.js (standalone router runners): net-intent.js, else the old suffix table (one release).
    const N = globalThis.AtriumNetIntent;
    if (N?.pairs) {
      for (const p of N.pairs([...nets], out)) if (!seen.has(p.positive) && !seen.has(p.negative)) { out.push({name:p.name, positive:p.positive, negative:p.negative, source:"names"}); seen.add(p.positive); seen.add(p.negative); }
      return out;
    }
    for (const n of nets) {
      if (seen.has(n)) continue;
      for (const [re, suffix] of SUFFIX) {
        const m = re.exec(n); if (!m) continue;
        const other = m[1] + (suffix.startsWith("_") && n[n.length - 2] === "_" ? suffix : suffix.replace(/^_/, n.includes("_") ? "_" : ""));
        const cand = [m[1] + suffix, other].find(x => nets.has(x) && x !== n && !seen.has(x));
        if (cand) { out.push({name:m[1], positive:n, negative:cand, source:"names"}); seen.add(n); seen.add(cand); break; }
      }
    }
    return out;
  }
  function find(board, net) {
    for (const p of pairs(board)) if (p.positive === net || p.negative === net) return p;
    return null;
  }

  // ------------------------------------------------------------ geometry
  // Parallel offset with mitred joins: positive d is to the left of travel (x right, y down: -uy, ux).
  function offset(pts, d) {
    // Keeps collinear vertices (callers index the result); only repeats are dropped.
    pts = pts.filter((p, i) => !i || dist(p, pts[i - 1]) > 1e-12);
    if (pts.length < 2) return pts.map(p => [p[0], p[1]]);
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(pts.length - 1, i + 1)];
      let n1 = null, n2 = null;
      if (i > 0) { const l = dist(a, b); n1 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; }
      if (i < pts.length - 1) { const l = dist(b, c); n2 = [-(c[1] - b[1]) / l, (c[0] - b[0]) / l]; }
      if (!n1) n1 = n2; if (!n2) n2 = n1;
      let mx = n1[0] + n2[0], my = n1[1] + n2[1]; const ml = Math.hypot(mx, my);
      if (ml < 1e-9) { mx = n1[0]; my = n1[1]; } else { mx /= ml; my /= ml; }
      const k = d / Math.max(0.2, mx * n1[0] + my * n1[1]);
      out.push([b[0] + mx * k, b[1] + my * k]);
    }
    return out;
  }
  // Signed coupled-bend length difference: the left offset changes length by
  // -d * 2 tan(theta/2) at each left turn (+ at right turns).
  function bendSkew(pts, d) {
    let s = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
      const th = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      s += -2 * d * Math.tan(th / 2);
    }
    return s;
  }
  const snapDir = (v, base) => {
    const a = Math.atan2(v[1], v[0]), step = base === "90" ? Math.PI / 2 : base === "any" ? 0 : Math.PI / 4;
    const q = step ? Math.round(a / step) * step : a;
    return [Math.cos(q), Math.sin(q)];
  };
  function centreOf(W, f) {
    if (W.kind[f] === 0) return [(W.ax[f] + W.bx[f]) / 2, (W.ay[f] + W.by[f]) / 2];
    return [W.ax[f], W.ay[f]];
  }
  // Pad (or via) centres of each net nearest p, on the routing layer.
  function terminals(W, p, idP, idN, li, radius = 6, skip) {
    const m = C.candidates(W, p[0], p[1], p[0], p[1], radius, li, li), list = Array.from(W.qb.subarray(0, m));
    let bp = null, bn = null, dp = Infinity, dn = Infinity;
    for (const f of list) {
      const n = W.net[f], o = W.own[f], rec = W.owners[o];
      if (n !== idP && n !== idN || !rec || (rec.kind !== "pad" && rec.kind !== "via") || (skip && skip.has(o))) continue;
      const c = centreOf(W, f), d = dist(c, p);
      if (n === idP && d < dp) { dp = d; bp = {at:c, owner:o}; }
      if (n === idN && d < dn) { dn = d; bn = {at:c, owner:o}; }
    }
    return {P:bp, N:bn};
  }

  // ------------------------------------------------------------ size profiles (neck-down)
  // A leg's sizes along its centreline: base {width, gap} plus zones [{s0, s1, width, gap}]
  // in arc length. Between sizes the traces taper over a transition: "mitered" (a 45°
  // linear ramp), "rounded" (a cosine S-curve) or "step". The ramp always lies on the
  // wider side, so the copper never exceeds what was routed (and checked) there.
  const TRANSITIONS = ["mitered", "rounded", "step"];
  const TRANSITION_NAMES = {mitered:"Mitered transitions", rounded:"Rounded transitions", step:"Stepped transitions"};
  const STATUS_NAMES = {ok:"OK", pushed:"Pushed", blocked:"Blocked", violation:"Violation", shrink:"Auto-shrink", pair:"Pair gap violation"};
  function cumulative(pts) { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i])); return c; }
  function pointAt(pts, cum, s) {
    let i = 1; while (i < pts.length - 1 && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i], L = cum[i] - cum[i - 1], t = L > 0 ? Math.max(0, Math.min(1, (s - cum[i - 1]) / L)) : 0;
    if (t >= 1) return [b[0], b[1]]; if (t <= 0) return [a[0], a[1]];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  // Sub-polyline between arc lengths s0 and s1.
  function slice(pts, s0, s1) {
    const cum = cumulative(pts), out = [pointAt(pts, cum, s0)];
    for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
    out.push(pointAt(pts, cum, s1));
    return out;
  }
  const ease = (t, style) => style === "rounded" ? (1 - Math.cos(Math.PI * t)) / 2 : t;
  const extentOf = z => z.gap / 2 + z.width;
  function rampOf(z, base, style) {
    const dd = Math.abs((z.gap + z.width) / 2 - (base.gap + base.width) / 2), dw = Math.abs(z.width - base.width);
    const L = style === "step" ? 1e-4 : Math.max(dd, dw / 2, 0.005) * (style === "rounded" ? 2.5 : 1);
    const narrow = extentOf(z) <= extentOf(base) + 1e-12;
    return {...z, L, a0:narrow ? z.s0 - L : z.s0, b1:narrow ? z.s1 + L : z.s1, narrow};
  }
  function sizeProfile(centre, base, zones, style, steps) {
    const cum = cumulative(centre), total = cum[cum.length - 1];
    const Z = (zones || []).filter(z => z.s1 > z.s0 - 1e-9 && (Math.abs(z.width - base.width) > 1e-9 || Math.abs(z.gap - base.gap) > 1e-9)).map(z => rampOf(z, base, style));
    const sizeAt = s => {
      let best = null, bf = 0;
      for (const z of Z) {
        if (s < z.a0 - 1e-12 || s > z.b1 + 1e-12) continue;
        const f = Math.max(0, Math.min(1, (s - z.a0) / z.L, (z.b1 - s) / z.L));
        if (f <= 0) continue;
        if (!best || f > bf + 1e-12 || (Math.abs(f - bf) <= 1e-12 && extentOf(z) < extentOf(best))) { best = z; bf = f; }
      }
      if (!best) return [base.width, base.gap];
      const g = ease(bf, style);
      return [base.width + (best.width - base.width) * g, base.gap + (best.gap - base.gap) * g];
    };
    const at = new Set(cum.map(x => +x.toFixed(9)));
    const marks = [...cum];
    for (const z of Z) {
      const n = style === "rounded" ? Math.max(4, steps) : Math.abs(z.width - base.width) > 1e-9 ? Math.max(1, steps) : 1;
      for (const [r0, r1] of [[z.a0, z.a0 + z.L], [z.b1 - z.L, z.b1]]) for (let k = 0; k <= n; k++) marks.push(r0 + (r1 - r0) * k / n);
    }
    const list = marks.filter(s => s > 1e-9 && s < total - 1e-9 || at.has(+s.toFixed(9))).sort((a, b) => a - b);
    const S = [];
    for (const s of list) if (!S.length || s - S[S.length - 1] > 1e-7) S.push(s);
    const pts = [], d = [], w = [];
    for (const s of S) {
      const p = pointAt(centre, cum, s);
      if (pts.length && dist(p, pts[pts.length - 1]) <= 1e-12) continue;
      const [ww, gg] = sizeAt(s);
      pts.push(p); w.push(ww); d.push((gg + ww) / 2);
    }
    return {pts, d, w, zones:Z};
  }
  // Mitred parallel offset with a per-vertex signed distance (positive = left of travel).
  function offsetVar(pts, ds) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(pts.length - 1, i + 1)];
      let n1 = null, n2 = null;
      if (i > 0) { const l = dist(a, b); n1 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; }
      if (i < pts.length - 1) { const l = dist(b, c); n2 = [-(c[1] - b[1]) / l, (c[0] - b[0]) / l]; }
      if (!n1) n1 = n2; if (!n2) n2 = n1;
      if (!n1) { out.push([b[0], b[1]]); continue; }
      let mx = n1[0] + n2[0], my = n1[1] + n2[1]; const ml = Math.hypot(mx, my);
      if (ml < 1e-9) { mx = n1[0]; my = n1[1]; } else { mx /= ml; my /= ml; }
      const k = ds[i] / Math.max(0.2, mx * n1[0] + my * n1[1]);
      out.push([b[0] + mx * k, b[1] + my * k]);
    }
    return out;
  }
  const qw = w => Math.round(w * 1e6) / 1e6;
  // Splits a polyline with per-segment widths into constant-width track pieces.
  function piecesOf(pts, segW) {
    const out = [];
    let run = [pts[0]], w = segW[0];
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(segW[i - 1] - w) > 1e-9 && run.length > 1) { out.push({points:simplify(run), width:w}); run = [pts[i - 1]]; }
      w = segW[i - 1]; run.push(pts[i]);
    }
    if (run.length > 1) out.push({points:simplify(run), width:w});
    return out;
  }
  // Exact minimum edge-to-edge distance between two sets of pieces.
  function minGap(A, B) {
    let m = Infinity, where = null;
    for (const p of A) for (const q of B) {
      if (p.layer !== q.layer) continue;
      const P = p.points, Q = q.points, h = (p.width + q.width) / 2;
      for (let i = 1; i < P.length; i++) {
        const x0 = Math.min(P[i - 1][0], P[i][0]), x1 = Math.max(P[i - 1][0], P[i][0]), y0 = Math.min(P[i - 1][1], P[i][1]), y1 = Math.max(P[i - 1][1], P[i][1]);
        for (let j = 1; j < Q.length; j++) {
          const lim = m + h;
          if (Math.min(Q[j - 1][0], Q[j][0]) > x1 + lim || Math.max(Q[j - 1][0], Q[j][0]) < x0 - lim || Math.min(Q[j - 1][1], Q[j][1]) > y1 + lim || Math.max(Q[j - 1][1], Q[j][1]) < y0 - lim) continue;
          const g = segmentDistance(P[i - 1], P[i], Q[j - 1], Q[j]) - h;
          if (g < m) { m = g; where = P[i]; }
        }
      }
    }
    return {gap:m, at:where};
  }

  // ------------------------------------------------------------ session
  function begin(board, defs, o = {}) {
    const pair = o.pair || (o.netP && o.netN ? {name:o.pairName || o.netP, positive:o.netP, negative:o.netN} : find(board, o.net));
    if (!pair) throw Error("Choose a net that belongs to a differential pair.");
    const W = C.worldFor(board, defs, o), rules = C.rulesFor(board, o.rules, o.project, defs);
    W.scene.reset();
    const P = pair.positive, N = pair.negative;
    const idP = W.netIds.has(P) ? W.netIds.get(P) : 1e9, idN = W.netIds.has(N) ? W.netIds.get(N) : 1e9 + 1;
    let layer = o.layer || "Top";
    const dp = rules.diffPair(P, N, pair.name, layer);
    const st = {
      mode:C.MODES.includes(o.mode) ? o.mode : "walkaround",
      corner:C.CORNERS.includes(o.corner) ? o.corner : "45", bend:!!o.bend,
      width:finite(o.width) ? o.width : dp.width, gap:finite(o.gap) ? o.gap : dp.gap,
      via:o.viaStyle && finite(o.viaStyle.diameter) ? {...o.viaStyle} : (() => { const v = rules.via([P,N]); return {diameter:v.diameter, drill:v.drill}; })(),
      arcRadius:finite(o.arcRadius) ? o.arcRadius : null, maxUncoupled:finite(o.maxUncoupled) ? o.maxUncoupled : dp.maxUncoupled,
      autoShrink:o.autoShrink !== false, transition:TRANSITIONS.includes(o.transition) ? o.transition : "mitered", taperSteps:finite(o.taperSteps) ? Math.max(1, Math.min(8, o.taperSteps | 0)) : 3,
      minWidth:finite(o.minWidth) ? o.minWidth : dp.minWidth, minGap:finite(o.minGap) ? o.minGap : dp.minGap,
      legs:[], vias:[], undo:[], base:new Map(), last:null, cursor:null, moveMs:o.moveBudgetMs || 4, pushMs:o.pushBudgetMs || 5
    };
    st.width0 = st.width;
    const clrPN = l => rules.clearance(P, N, l);
    // Start terminals: explicit, or the nearest P and N pads around `start`.
    let sP = o.startP, sN = o.startN;
    if (!sP || !sN) {
      const t = terminals(W, o.start, idP, idN, C.layerIndex(layer));
      if (!t.P || !t.N) throw Error("Start on a pad of " + P + " or " + N + " with its partner nearby.");
      sP = t.P.at; sN = t.N.at; st.startOwners = new Set([t.P.owner, t.N.owner]);
    }
    const newLeg = (lay, a, b) => ({layer:lay, sP:[a[0], a[1]], sN:[b[0], b[1]], centre:null, dir:null, side:0, width:st.width, gap:st.gap, zones:[], manualEnd:0});
    st.legs.push(newLeg(layer, sP, sN));
    let ctx = null;
    const leg = () => st.legs[st.legs.length - 1];
    const half = () => (st.gap + st.width) / 2;
    const shrinkLimits = () => ({w:Math.min(st.width, finite(st.minWidth) ? st.minWidth : st.width), g:Math.min(st.gap, finite(st.minGap) ? st.minGap : st.gap)});
    const ctxCache = new Map();
    function contextFor(lay, hw) {
      const base = C.baseCorner(st.corner), k = lay + "|" + hw.toFixed(9) + "|" + base;
      let c = ctxCache.get(k);
      if (!c || c.epoch !== W.hullEpoch) {
        c = C.makeContext(W, rules, {layer:lay, hw, net:idP, net2:idN, netName:P, net2Name:N, base, dirs:{"45":8, "90":4, any:16}[base]});
        c.epoch = W.hullEpoch;
        if (ctxCache.size > 24) ctxCache.clear();
        ctxCache.set(k, c);
      }
      c.exempt = new Set(); c.endExempt.clear();
      return c;
    }
    function context() { const l = leg(); ctx = contextFor(l.layer, st.gap / 2 + st.width); return ctx; }
    // Breakout: where the coupled section starts for a first direction u.
    function breakout(l, u) {
      const m = [(l.sP[0] + l.sN[0]) / 2, (l.sP[1] + l.sN[1]) / 2], n = [-u[1], u[0]], d = half();
      const lat = (l.sP[0] - m[0]) * n[0] + (l.sP[1] - m[1]) * n[1], along = (l.sP[0] - m[0]) * u[0] + (l.sP[1] - m[1]) * u[1];
      const side = lat >= 0 ? 1 : -1;
      const change = Math.abs(side * d - lat), b = Math.max(0, Math.abs(along) + change);
      const c0 = [m[0] + u[0] * b, m[1] + u[1] * b];
      return {m, c0, side, n, b};
    }
    // Pad-to-coupled-start connection whose last leg runs along u where possible.
    function fan(pad, q, u, base) {
      if (dist(pad, q) < 1e-9) return [pad, q];
      for (const bend of [false, true]) {
        const c = connector(pad, q, base, bend), a = c[c.length - 2];
        const vx = q[0] - a[0], vy = q[1] - a[1], l = Math.hypot(vx, vy);
        if (l > 1e-9 && Math.abs(vx / l * u[1] - vy / l * u[0]) < 1e-6 && vx * u[0] + vy * u[1] > 0) return c;
      }
      return connector(pad, q, base, false);
    }
    // The anchored pair (except the section the head continues from) is an obstacle
    // for the head: a pair may not cross or crowd its own earlier copper.
    function selfObstacles() {
      const sc = W.scene;
      for (let i = 0; i < st.legs.length; i++) {
        const l = st.legs[i]; if (!l.centre || l.centre.length < 2) continue;
        const li = C.layerIndex(l.layer), last = i === st.legs.length - 1;
        const pts = last ? l.centre.slice(0, -1) : l.centre;
        if (pts.length < 2) continue;
        const r = (l.gap / 2 + l.width) + clrPN(l.layer);
        if (last) {
          // Keep clear of the segment joint, where the head legitimately starts.
          const a = pts[pts.length - 2], b = pts[pts.length - 1], L = dist(a, b), cut = Math.min(L, 2 * r + (st.gap / 2 + st.width));
          if (L - cut > 1e-6) sc.addLine([...pts.slice(0, -1), [b[0] + (a[0] - b[0]) * cut / L, b[1] + (a[1] - b[1]) * cut / L]], r - 1e-6, li, li, -2);
          else if (pts.length > 2) sc.addLine(pts.slice(0, -1), r - 1e-6, li, li, -2);
        } else sc.addLine(pts, r - 1e-6, li, li, -2);
      }
    }
    function restoreScene() { const sc = W.scene; sc.reset(); for (const [k, g] of st.base) sc.set(k, g); selfObstacles(); }
    // Side hysteresis (as the single-track router): from the same start the centreline keeps going
    // round obstacles the way it went last time unless the other way is clearly shorter.
    const slack = finite(o.sideSlack) ? Math.max(0, o.sideSlack) : 1;
    const sticky = (c, a) => slack && st.side && st.sideAt && st.sideHw === c.hw && dist(st.sideAt, a) < 1e-9 ? {side:st.side, slack:slack * (2 * c.hw + c.clr[0]) * 0.5} : {};  // clr[0]: the no-net clearance
    const walkSticky = (c, a, p) => {
      const r = C.walkaround(c, a, p, st.bend, sticky(c, a));
      if (r.ok && r.side) { st.side = r.side; st.sideAt = [a[0], a[1]]; st.sideHw = c.hw; }
      return r;
    };
    // Routes the centreline from `a` to `p` in the current mode.
    function centreRoute(c, a, p) {
      const base = C.baseCorner(st.corner), direct = connector(a, p, base, st.bend);
      let path = direct, status = "ok", pushed = false;
      const tryPush = () => {
        const li = c.li, heads = [{pts:direct, hw:c.hw, net:idP, net2:idN, lo:li, hi:li}];
        for (const l of st.legs) if (l.centre && l.centre.length > 1 && C.layerIndex(l.layer) === li) heads.push({pts:l.centre, hw:c.hw, net:idP, net2:idN, lo:li, hi:li});
        const r = C.shove(null, c, heads, {ms:st.pushMs, shoves:48});
        if (!r.ok) restoreScene();
        return r.ok;
      };
      if (st.mode === "ignore") { if (C.pathHit(c, direct, true)) status = "violation"; }
      else if (st.mode === "stop") { const t = C.truncate(c, direct, true); path = t.path; status = t.clipped ? "blocked" : "ok"; }
      else if (st.mode === "push" && C.pathHit(c, direct, true)) {
        if (tryPush()) { pushed = true; status = "pushed"; } else { const r = walkSticky(c, a, p); path = r.path; status = r.status; }
      } else if (st.mode === "hug") {
        const r = walkSticky(c, a, p); path = r.path; status = r.status;
        if ((!r.ok || pathLength(r.path) > 1.4 * pathLength(direct) + 0.5) && C.pathHit(c, direct, true) && tryPush()) { path = direct; pushed = true; status = "pushed"; }
      } else if (st.mode !== "push") { const r = walkSticky(c, a, p); path = r.path; status = r.status; }
      if (C.hasArc(st.corner) && path.length > 2) {
        const R = Math.max(st.arcRadius || 0, half() + st.width / 2 + 0.05, 2.5 * st.width);
        path = fillet(path, R, st.mode === "ignore" ? null : pts => C.pathClear(c, pts));
      }
      return {path, status, pushed};
    }
    // The pair leaves (or arrives at) two terminals perpendicular to their axis,
    // on the side facing `toward`, so both fans are symmetric.
    function exitDir(a, b, toward, base) {
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ax = b[0] - a[0], ay = b[1] - a[1], l = Math.hypot(ax, ay);
      const v = [toward[0] - m[0], toward[1] - m[1]];
      if (l < 1e-9) return Math.hypot(v[0], v[1]) > 1e-9 ? snapDir(v, base) : [1, 0];
      let n = [-ay / l, ax / l];
      if (v[0] * n[0] + v[1] * n[1] < 0) n = [-n[0], -n[1]];
      return snapDir(n, base === "90" ? "90" : "45");
    }
    // Arc-length intervals of `path` where copper of half width cf.hw does not fit.
    function constrictions(cf, path) {
      const out = []; let s = 0;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i], L = dist(a, b);
        if (L > 1e-12 && C.segmentHit(cf, a[0], a[1], b[0], b[1], true) >= 0) {
          const at = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          let lo = 0, hi = 1;
          for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2, q = at(m); if (C.segmentHit(cf, a[0], a[1], q[0], q[1], true) >= 0) hi = m; else lo = m; }
          const tIn = lo; lo = 0; hi = 1;
          for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2, q = at(m); if (C.segmentHit(cf, q[0], q[1], b[0], b[1], true) >= 0) lo = m; else hi = m; }
          out.push([s + tIn * L, s + hi * L]);
        }
        s += L;
      }
      const merged = [];
      for (const iv of out) { const m = merged[merged.length - 1]; if (m && iv[0] - m[1] < 0.1) m[1] = Math.max(m[1], iv[1]); else merged.push([...iv]); }
      return merged;
    }
    // Auto-shrink: when the pair at full size is blocked or forced into a long detour,
    // route at the rule minimums and neck down only where (and only as much as) needed.
    function shrinkRoute(c, a, target, stub, full, li) {
      const lim = shrinkLimits();
      if (lim.w >= st.width - 1e-9 && lim.g >= st.gap - 1e-9) return null;
      const lead = stub ? dist(stub, a) : 0, direct = dist(a, target) + lead;
      const fullEnd = full.path[full.path.length - 1], fullReach = dist(fullEnd, target) < 1e-6 && (full.status === "ok" || full.status === "pushed");
      const fullLen = pathLength(full.path);
      if (fullReach && fullLen <= 1.15 * direct + 0.3) return null;
      const fullMods = new Map(W.scene.mods);
      restoreScene();
      const cn = contextFor(leg().layer, lim.g / 2 + lim.w);
      cn.deadline = Math.max(now() + st.moveMs * 0.25, st.t0 + st.moveMs * 0.85);
      const rn = centreRoute(cn, a, target);
      if (stub) rn.path = simplify([stub, ...rn.path]);
      const nEnd = rn.path[rn.path.length - 1], nReach = dist(nEnd, target) < 1e-6 && (rn.status === "ok" || rn.status === "pushed"), nLen = pathLength(rn.path);
      const better = nReach ? (!fullReach || nLen < fullLen - Math.max(0.3, 0.1 * fullLen)) : !fullReach && dist(nEnd, target) < dist(fullEnd, target) - 0.05;
      if (!better) { restoreScene(); for (const [k, g] of fullMods) W.scene.set(k, g); return null; }
      const full2 = contextFor(leg().layer, st.gap / 2 + st.width);
      const zones = [];
      for (const [s0, s1] of constrictions(full2, rn.path)) {
        // Smallest shrink factor that clears this interval.
        const part = slice(rn.path, Math.max(0, s0 - 1e-4), s1 + 1e-4);
        const fits = lam => {
          const w = st.width - (st.width - lim.w) * lam, g = st.gap - (st.gap - lim.g) * lam, cc = contextFor(leg().layer, g / 2 + w);
          for (let i = 1; i < part.length; i++) if (C.segmentHit(cc, part[i - 1][0], part[i - 1][1], part[i][0], part[i][1], true) >= 0) return false;
          return true;
        };
        let lo = 0, hi = 1;
        if (now() < st.t0 + st.moveMs && fits(1)) for (let k = 0; k < 5 && now() < st.t0 + st.moveMs * 1.1; k++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
        const w = Math.max(lim.w, Math.floor((st.width - (st.width - lim.w) * hi) * 1e4) / 1e4), g = Math.max(lim.g, Math.floor((st.gap - (st.gap - lim.g) * hi) * 1e4) / 1e4);
        zones.push({s0, s1, width:w, gap:g, kind:"shrink"});
      }
      void li;
      return {r:rn, zones};
    }
    // Pad entry (fine-pitch QFN/QFP pins whose neighbours crowd the pair): the coupled section
    // ends where the pair still fits, straight out from the pads, and each net finishes with a
    // short uncoupled fan to its pad, within the rule's max uncoupled length (neck-down to the
    // rule minimum width when the full width does not clear).
    function padEntry(c, a, stub, eb, sd) {
      const out = eb.out, pitch = st.gap + st.width, b0 = dist(eb.m, eb.c0), h = half(), n = [-out[1], out[0]];
      const cap = finite(st.maxUncoupled) && st.maxUncoupled > 0 ? st.maxUncoupled : Math.max(2.5, 6 * pitch);
      const step = Math.max(0.05, pitch / 4), base = C.baseCorner(st.corner), stop = now() + 2 * st.moveMs + 8, lay = leg().layer;
      const widths = [st.width, ...(finite(st.minWidth) && st.minWidth < st.width - 1e-9 ? [st.minWidth] : [])];
      let routes = 0;
      for (let d = b0 + step; d - b0 <= cap + 1e-9 && routes < 6 && now() < stop; d += step) {
        const q = [eb.m[0] + out[0] * d, eb.m[1] + out[1] * d], qa = [q[0] + out[0] * pitch, q[1] + out[1] * pitch];
        if (C.segmentHit(c, qa[0], qa[1], q[0], q[1], true) >= 0) continue;
        // The pair arrives along -out: P runs on the left of travel for side +1.
        const oP = [q[0] - n[0] * h * sd, q[1] - n[1] * h * sd], oN = [q[0] + n[0] * h * sd, q[1] + n[1] * h * sd];
        const fP = fan(eb.P, oP, out, base), fN = fan(eb.N, oN, out, base);
        if (Math.max(pathLength(fP), pathLength(fN)) > cap + 1e-9) break;
        const w = widths.find(x => fanClear(fP, P, x, lay) && fanClear(fN, N, x, lay));
        if (w == null) continue;
        routes++;
        c.deadline = now() + st.moveMs; restoreScene();
        const r = centreRoute(c, a, qa);
        if (stub) r.path = simplify([stub, ...r.path]);
        if (r.status === "blocked" || dist(r.path[r.path.length - 1], qa) > 1e-6) continue;
        r.path = simplify([...r.path, q]);
        return {r, target:q, endBreak:{...eb, c0:q, entry:true, fanWidth:w < st.width - 1e-9 ? w : null}};
      }
      return null;
    }
    function compute(p) {
      const t0 = now(), l = leg(), base = C.baseCorner(st.corner), c = context(), lim = shrinkLimits();
      // With auto-shrink available, the full-size attempt gets part of the move budget.
      const canShrink = st.autoShrink && st.mode !== "ignore" && (lim.w < st.width - 1e-9 || lim.g < st.gap - 1e-9);
      c.deadline = t0 + st.moveMs * (canShrink ? 0.5 : 1); restoreScene(); st.t0 = t0;
      // End terminals: the cursor on a pad of either net (other than the start pads).
      const li = C.layerIndex(l.layer);
      const atEnd = (() => {
        const hit = C.sameNetAt(W, idP, li, p, st.startOwners) || C.sameNetAt(W, idN, li, p, st.startOwners);
        if (!hit || (hit.kind !== "pad" && hit.kind !== "via")) return null;
        const t = terminals(W, p, idP, idN, li, 6, st.startOwners);
        return t.P && t.N ? t : null;
      })();
      const u = l.dir || exitDir(l.sP, l.sN, p, base);
      const br = l.centre ? null : breakout(l, u);
      // Run straight on past the terminals before the coupled section may turn,
      // so neither trace swings back beside its partner's pad.
      let a = l.centre ? l.centre[l.centre.length - 1] : br.c0, stub = null;
      if (!l.centre) {
        const ext = Math.max(extent(l.sP, li), extent(l.sN, li));
        const len = Math.max(0, ext + clrPN(l.layer) + half() + st.width / 2 - br.b);
        if (len > 1e-9) { stub = br.c0; a = [br.c0[0] + u[0] * len, br.c0[1] + u[1] * len]; }
      }
      let target = p, endBreak = null;
      if (atEnd) {
        // The coupled section ends before the end pads; fans run from there.
        const out = exitDir(atEnd.P.at, atEnd.N.at, a, base);
        const eb = breakout({sP:atEnd.P.at, sN:atEnd.N.at}, out);
        target = eb.c0; endBreak = {P:atEnd.P.at, N:atEnd.N.at, m:eb.m, c0:eb.c0, out};
        // P runs on the left of travel for side +1; arriving along -out, its pad must be on that side.
        const latP = (atEnd.P.at[0] - eb.m[0]) * out[1] - (atEnd.P.at[1] - eb.m[1]) * out[0];
        if (Math.abs(latP) > 1e-9 && Math.sign(latP) !== (l.centre ? l.side : br.side)) {
          endBreak.twisted = true;
          const oP = W.owners[atEnd.P.owner], oN = W.owners[atEnd.N.owner];
          if (oP?.parent && oP.parent === oN?.parent && oP.item?.number != null && oN.item?.number != null) endBreak.swap = {partId:oP.parent.id, ref:oP.parent.ref, pins:[String(oP.item.number), String(oN.item.number)]};
        }
      }
      if (dist(a, target) < 1e-9 && !endBreak) return {empty:true, status:"ok", ms:now() - t0};
      let r = centreRoute(c, a, target);
      if (stub) r.path = simplify([stub, ...r.path]);
      let zones = [];
      if (st.autoShrink && st.mode !== "ignore") {
        const s = shrinkRoute(c, a, target, stub, r, li);
        if (s) { r = s.r; zones = s.zones; }
      }
      if (endBreak && st.mode !== "ignore" && !(r.status !== "blocked" && dist(r.path[r.path.length - 1], target) < 1e-6)) {
        const e = padEntry(c, a, stub, endBreak, l.centre ? l.side : br.side);
        if (e) { r = e.r; zones = []; target = e.target; endBreak = e.endBreak; }
      }
      return {centre:r.path, br, u, endBreak, zones, status:r.status, pushed:r.pushed, twisted:!!endBreak?.twisted, swap:endBreak?.swap || null,
        reached:!!endBreak && r.status !== "blocked" && dist(r.path[r.path.length - 1], target) < 1e-6, ms:now() - t0};
    }
    // The geometry of one leg, with the head merged into the last one.
    function legSpec(i, head) {
      const l = st.legs[i], last = i === st.legs.length - 1;
      let centre = l.centre ? l.centre.slice() : null, br = l.br || null, side = l.side, endBreak = l.endBreak || null;
      let base = {width:l.width, gap:l.gap}, zones = (l.zones || []).slice();
      if (last && head && !head.empty) {
        const L0 = centre ? pathLength(centre) : 0;
        if (!centre) { centre = head.centre; br = {...head.br, u:head.u}; side = head.br.side; base = {width:st.width, gap:st.gap}; }
        else {
          if (Math.abs(st.width - l.width) > 1e-9 || Math.abs(st.gap - l.gap) > 1e-9) {
            zones.push({s0:l.manualEnd || 0, s1:L0, width:l.width, gap:l.gap, kind:"manual"}); base = {width:st.width, gap:st.gap};
          }
          centre = simplify([...centre, ...head.centre.slice(1)]);
        }
        for (const z of head.zones || []) zones.push({...z, s0:z.s0 + L0, s1:z.s1 + L0});
        endBreak = head.endBreak;
      }
      return {l, last, centre, br, side, endBreak, base, zones};
    }
    // Builds both traces for every leg (anchored + head) as constant-width pieces.
    function traces(head) {
      const out = [];
      let lenP = 0, lenN = 0, unP = 0, unN = 0, coupled = 0, fanBad = false, entry = null;
      const necks = [];
      for (let i = 0; i < st.legs.length; i++) {
        const sp = legSpec(i, head), {l, centre, br, side, endBreak} = sp;
        if (!centre || centre.length < 2 || !br) continue;
        const base = C.baseCorner(st.corner);
        const prof = sizeProfile(centre, sp.base, sp.zones, st.transition, st.taperSteps);
        // Offsets use the breakout midpoints as virtual neighbours so the mitres at
        // the coupled start and end match the fans.
        const pre = dist(br.m, prof.pts[0]) > 1e-9 ? [br.m] : [], post = endBreak && dist(endBreak.m, prof.pts[prof.pts.length - 1]) > 1e-9 ? [endBreak.m] : [];
        const ext = [...pre, ...prof.pts, ...post], dExt = [...pre.map(() => prof.d[0]), ...prof.d, ...post.map(() => prof.d[prof.d.length - 1])];
        let offP = offsetVar(ext, dExt.map(x => side * x)), offN = offsetVar(ext, dExt.map(x => -side * x));
        offP = offP.slice(pre.length, offP.length - post.length); offN = offN.slice(pre.length, offN.length - post.length);
        const w0 = prof.w[0], w1 = prof.w[prof.w.length - 1];
        let fanP = fan(l.sP, offP[0], br.u, base), fanN = fan(l.sN, offN[0], br.u, base);
        if (st.transition === "rounded") { fanP = fillet(fanP, 2 * w0, null); fanN = fillet(fanN, 2 * w0, null); }
        const build = (fanS, off, endFan) => {
          const pts = [], segW = [];
          const push = (q, w) => { if (pts.length && dist(q, pts[pts.length - 1]) <= 1e-12) return; if (pts.length) segW.push(qw(w)); pts.push(q); };
          for (const q of fanS) push(q, w0);
          for (let k = 1; k < off.length; k++) push(off[k], Math.min(prof.w[k - 1], prof.w[k]));
          if (endFan) for (const q of endFan.slice(1)) push(q, endBreak?.fanWidth || w1);
          return {pts, segW};
        };
        let eP = 0, eN = 0, bP = null, bN = null;
        if (endBreak) {
          bP = fan(endBreak.P, offP[offP.length - 1], endBreak.out, base).reverse(); bN = fan(endBreak.N, offN[offN.length - 1], endBreak.out, base).reverse();
          if (st.transition === "rounded") { bP = fillet(bP, 2 * w1, null); bN = fillet(bN, 2 * w1, null); }
          eP = pathLength(bP); eN = pathLength(bN);
          if (endBreak.entry) entry = {length:Math.max(eP, eN), P:eP, N:eN, width:endBreak.fanWidth || w1};
          if (!fanBad) fanBad = !fanClear(bP, P, endBreak.fanWidth || w1, l.layer) || !fanClear(bN, N, endBreak.fanWidth || w1, l.layer);
        }
        const TP = build(fanP, offP, bP), TN = build(fanN, offN, bN);
        const tP = simplify(TP.pts), tN = simplify(TN.pts);
        // Each trace must clear the partner net's copper too (the centreline treats both as its own).
        if (!fanBad) fanBad = !fanClear(fanP, P, w0, l.layer) || !fanClear(fanN, N, w0, l.layer);
        unP += pathLength(fanP) + eP; unN += pathLength(fanN) + eN;
        coupled += pathLength(centre);
        lenP += pathLength(tP); lenN += pathLength(tN);
        const piecesP = piecesOf(TP.pts, TP.segW), piecesN = piecesOf(TN.pts, TN.segW);
        for (const z of prof.zones) if (z.kind === "shrink" || z.narrow) necks.push({points:slice(centre, Math.max(0, z.s0), Math.min(pathLength(centre), z.s1)), width:z.width, gap:z.gap, layer:l.layer, length:Math.max(0, Math.min(pathLength(centre), z.s1) - Math.max(0, z.s0)), kind:z.kind || "manual"});
        out.push({layer:l.layer, width:prof.w.length ? Math.max(...prof.w) : l.width, P:tP, N:tN, piecesP, piecesN, centre, head:sp.last, minGap:Math.min(sp.base.gap, ...sp.zones.map(z => z.gap))});
      }
      // The pair's own clearance: P against N over every leg (anchored and head).
      let pairGap = Infinity, pairAt = null, need = Infinity;
      const PP = [], NN = [];
      for (const t of out) {
        for (const q of t.piecesP) PP.push({...q, layer:t.layer});
        for (const q of t.piecesN) NN.push({...q, layer:t.layer});
        need = Math.min(need, Math.min(t.minGap, clrPN(t.layer)));
      }
      if (PP.length && NN.length) { const g = minGap(PP, NN); pairGap = g.gap; pairAt = g.at; }
      const pairBad = st.mode !== "ignore" && pairGap < need - 1e-6;
      return {legs:out, lenP, lenN, unP, unN, coupled, fanBad, necks, pairGap, pairNeed:need, pairAt, pairBad, entry};
    }
    // Half-size of the terminal copper at p (pad or via) on layer li.
    function extent(p, li) {
      const m = C.candidates(W, p[0], p[1], p[0], p[1], 1e-6, li, li); let e = 0;
      for (let i = 0; i < m; i++) { const f = W.qb[i]; if (C.fdist(W, f, p[0], p[1], p[0], p[1]) <= 1e-6) e = Math.max(e, (W.x1[f] - W.x0[f]) / 2, (W.y1[f] - W.y0[f]) / 2); }
      return e;
    }
    // Exact clearance of an uncoupled fan for its own net (the partner net is an obstacle).
    function fanClear(pts, net, width, lay) {
      if (st.mode === "ignore" || pts.length < 2 || pathLength(pts) < 1e-9) return true;
      const id = net === P ? idP : idN;
      const fc = C.makeContext(W, rules, {layer:lay, hw:width / 2, net:id, netName:net, base:"any", dirs:8});
      const hit = C.pathHit(fc, pts, true);
      return !hit || W.own[hit.f] < 0;
    }
    // Computes the head for the cursor and resolves pair self-clearance: a head whose
    // traces fold onto each other (a short last segment) or crowd the anchored pair is
    // shortened vertex by vertex; if that cannot fix it, the head is a violation.
    function evaluate(p) {
      let r = compute(p), t = traces(r);
      if (t.pairBad && r && !r.empty) {
        // Longest clean prefix of the head, by bisection on its vertex count.
        const full = r.centre, trial = k => {
          const c = full.slice(0, k), r2 = {...r, centre:c, endBreak:null, reached:false, status:r.status === "ok" ? "blocked" : r.status, zones:(r.zones || []).filter(z => z.s0 < pathLength(c))};
          return {r2, t2:traces(r2)};
        };
        let lo = 1, hi = full.length, good = null;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1, x = trial(mid);
          if (x.t2.pairBad) hi = mid; else { lo = mid; good = x; }
        }
        if (good) { r = good.r2; t = good.t2; }
      }
      if ((t.pairBad || t.fanBad) && r && !r.empty && st.mode !== "ignore") r = {...r, status:"violation", pairViolation:t.pairBad};
      return {r, t};
    }
    function result(r, t) {
      t = t || traces(r);
      const preview = [];
      for (const l of t.legs) {
        for (const q of l.piecesP) preview.push({points:q.points, width:q.width, layer:l.layer, net:P, head:l.head});
        for (const q of l.piecesN) preview.push({points:q.points, width:q.width, layer:l.layer, net:N, head:l.head});
      }
      const pushed = [], hidden = [];
      for (const [k, g] of W.scene.mods) {
        const rec = W.owners[k]; hidden.push(rec.id);
        pushed.push(g.kind === "track" ? {id:rec.id, kind:"track", points:g.points, width:g.width, layer:g.layer} : {id:rec.id, kind:"via", x:g.x, y:g.y, diameter:g.diameter});
      }
      let status = r && !r.empty ? (t.fanBad && r.status === "ok" ? "violation" : r.status) : "ok";
      if (t.pairBad) status = "violation";
      const shrinkLen = t.necks.filter(n => n.kind === "shrink").reduce((s, n) => s + n.length, 0);
      const shrinkNecks = t.necks.filter(n => n.kind === "shrink");
      const shrink = {enabled:st.autoShrink, active:shrinkNecks.length > 0, zones:shrinkNecks.length, length:shrinkLen,
        width:shrinkNecks.length ? Math.min(...shrinkNecks.map(n => n.width)) : st.width, gap:shrinkNecks.length ? Math.min(...shrinkNecks.map(n => n.gap)) : st.gap};
      shrink.text = shrink.active ? "Auto-shrink " + shrink.width.toFixed(3) + "/" + shrink.gap.toFixed(3) + " mm over " + shrinkLen.toFixed(2) + " mm" : "";
      const notes = [];
      if (shrink.text) notes.push(shrink.text);
      if (t.entry) notes.push("Pad entry " + t.entry.length.toFixed(3) + " mm uncoupled" + (finite(st.maxUncoupled) ? " (max " + st.maxUncoupled.toFixed(3) + ")" : "") + (t.entry.width < st.width - 1e-9 ? " · neck-down " + t.entry.width.toFixed(3) + " mm" : ""));
      if (r && r.twisted && !globalThis.AtriumPinSwap) globalThis.AtriumLazy?.need?.("AtriumPinSwap")?.catch?.(() => {});
      if (r && r.twisted) notes.push(P + " and " + N + " arrive crossed at these pads: swap the pins (Tools › Pin Swapping) or cross over on another layer");
      if (t.pairBad) notes.push("Pair gap " + t.pairGap.toFixed(3) + " mm < " + t.pairNeed.toFixed(3) + " mm");
      return {preview, centre:t.legs.map(l => l.centre), vias:st.vias.map(v => ({...v})), pushed, hidden,
        status, reached:!!(r && r.reached) && status !== "violation", breakoutOk:!t.fanBad,
        lengthP:t.lenP, lengthN:t.lenN, skew:t.lenP - t.lenN, uncoupledP:t.unP, uncoupledN:t.unN,
        uncoupled:Math.max(t.unP, t.unN), uncoupledOk:Math.max(t.unP, t.unN) <= st.maxUncoupled + 1e-9, coupledLength:t.coupled,
        gap:st.gap, width:st.width, pitch:st.gap + st.width, layer:leg().layer, mode:st.mode, corner:st.corner,
        modeName:C.MODE_NAMES[st.mode], cornerName:C.CORNER_NAMES[st.corner], transition:st.transition, transitionName:TRANSITION_NAMES[st.transition],
        shrink, entry:t.entry, crossed:r && r.twisted ? {...(r.swap || r.endBreak?.swap || {})} : null, necks:t.necks, pairGap:t.pairGap, pairOk:!t.pairBad, notes, statusName:STATUS_NAMES[status] || status,
        ms:r ? r.ms : 0, pair:{...pair}};
    }
    const pushUndo = l => st.undo.push({legs:st.legs.length, centre:l.centre ? l.centre.slice() : null, br:l.br, side:l.side, dir:l.dir, base:new Map(st.base), vias:st.vias.length,
      endBreak:l.endBreak, zones:(l.zones || []).slice(), width:l.width, gap:l.gap, manualEnd:l.manualEnd || 0, stWidth:st.width, stGap:st.gap});
    const api = {
      get state() { return {mode:st.mode, corner:st.corner, layer:leg().layer, width:st.width, gap:st.gap, via:{...st.via}, pair:{...pair}, autoShrink:st.autoShrink, transition:st.transition,
        minWidth:shrinkLimits().w, minGap:shrinkLimits().g, arcRadius:st.arcRadius, anchors:st.undo.length}; },
      move(p) {
        // The same point again reuses the last result while nothing changed (no work per snap cell).
        const m = st.memo;
        if (m && m.last === st.last && m.via === st.via && m.gen === W.scene.gen && st.cursor && st.cursor[0] === p[0] && st.cursor[1] === p[1]) return m.out;
        st.cursor = [p[0], p[1]]; const e = evaluate(st.cursor); st.last = e.r;
        const out = result(e.r, e.t); st.memo = {last:st.last, via:st.via, gen:W.scene.gen, out}; return out;
      },
      click() {
        if (!st.last && st.cursor) st.last = evaluate(st.cursor).r;
        const r = st.last; if (!r || r.empty || !r.centre || r.centre.length < 2) return {anchored:false, done:false};
        if (r.status === "violation" && st.mode !== "ignore") return {anchored:false, done:false, status:"violation", message:"The pair would violate its own gap or clearance here."};
        const l = leg();
        pushUndo(l);
        const L0 = l.centre ? pathLength(l.centre) : 0;
        if (!l.centre) { l.centre = r.centre; l.br = {...r.br, u:r.u}; l.side = r.br.side; l.dir = r.u; l.width = st.width; l.gap = st.gap; }
        else {
          if (Math.abs(st.width - l.width) > 1e-9 || Math.abs(st.gap - l.gap) > 1e-9) {
            l.zones.push({s0:l.manualEnd || 0, s1:L0, width:l.width, gap:l.gap, kind:"manual"}); l.manualEnd = L0; l.width = st.width; l.gap = st.gap;
          }
          l.centre = simplify([...l.centre, ...r.centre.slice(1)]);
        }
        for (const z of r.zones || []) l.zones.push({...z, s0:z.s0 + L0, s1:z.s1 + L0});
        l.endBreak = r.endBreak;
        st.base = new Map(W.scene.mods); st.last = null;
        return {anchored:true, done:r.reached, status:r.status};
      },
      back() {
        const u = st.undo.pop(); if (!u) return false;
        st.legs.length = u.legs; const l = leg();
        Object.assign(l, {centre:u.centre, br:u.br, side:u.side, dir:u.dir, endBreak:u.endBreak, zones:u.zones, width:u.width, gap:u.gap, manualEnd:u.manualEnd});
        st.base = u.base; st.vias.length = u.vias;
        st.last = null; ctx = null; if (st.cursor) st.last = evaluate(st.cursor).r;
        return true;
      },
      // Drops a via for each net at the head, side by side, and continues on `next`.
      switchLayer(next, style) {
        if (C.layerIndex(next) < 0 || next === leg().layer) return {ok:false, message:"Choose another copper layer."};
        const viaStyle = style && finite(style.diameter) ? style : st.via;
        if (!rules.via([P,N],viaStyle).legal) return {ok:false,message:"No shared via of this diameter and drill meets the member nets' design rules."};
        if (st.last && !st.last.empty && st.last.centre && st.last.centre.length > 1) { const c = api.click(); if (!c.anchored && c.status === "violation") return {ok:false, message:c.message}; }
        const l = leg(); if (!l.centre || l.centre.length < 2) return {ok:false, message:"Route the pair before changing layers."};
        const v = style && finite(style.diameter) ? style : st.via, a = l.centre[l.centre.length - 1], b = l.centre[l.centre.length - 2];
        const len = dist(a, b), u = [(a[0] - b[0]) / len, (a[1] - b[1]) / len], n = [-u[1], u[0]];
        const pitch = Math.max(st.gap + st.width, v.diameter + clrPN(l.layer));
        const span = C.viaSpan(board, l.layer, next);
        const q = [a[0] + u[0] * Math.max(0, pitch / 2 - half()), a[1] + u[1] * Math.max(0, pitch / 2 - half())];
        const vP = [q[0] + n[0] * l.side * pitch / 2, q[1] + n[1] * l.side * pitch / 2], vN = [q[0] - n[0] * l.side * pitch / 2, q[1] - n[1] * l.side * pitch / 2];
        const okP = rules.via(P,v,vP,[span.lo,span.hi]).legal && C.viaClear(W, rules, idP, P, vP, v.diameter / 2, span.lo, span.hi, st.mode === "ignore");
        const okN = rules.via(N,v,vN,[span.lo,span.hi]).legal && C.viaClear(W, rules, idN, N, vN, v.diameter / 2, span.lo, span.hi, st.mode === "ignore");
        if (!okP || !okN) return {ok:false, message:"No room for the pair's vias here."};
        pushUndo(l);
        // The coupled section runs on to the via pair; each trace ends on its via.
        l.endBreak = {P:vP, N:vN, m:q, c0:a, out:[-u[0], -u[1]]};
        st.vias.push({x:vP[0], y:vP[1], diameter:v.diameter, drill:v.drill, net:P, fromLayer:span.fromLayer, toLayer:span.toLayer},
          {x:vN[0], y:vN[1], diameter:v.diameter, drill:v.drill, net:N, fromLayer:span.fromLayer, toLayer:span.toLayer});
        st.legs.push(newLeg(next, vP, vN));
        st.last = null; ctx = null; if (st.cursor) st.last = evaluate(st.cursor).r;
        return {ok:true, vias:[vP, vN], layer:next};
      },
      // Altium "2": a via pair at the head; the pair continues on the next copper layer.
      addVia(style) {
        const ls = RT.copperLayers(board, defs), cur = leg().layer;
        const next = ls.find(x => C.layerIndex(x) > C.layerIndex(cur)) || ls.find(x => x !== cur);
        if (!next) return {ok:false, message:"The board has one copper layer."};
        const r = api.switchLayer(next, style);
        return r.ok ? {...r, message:"Via pair · " + next} : r;
      },
      presets() {
        const pr = RT.presets(board, P, leg().layer, {rules:o.rules,project:o.project,nets:[P,N]}), lim = shrinkLimits();
        const lo = Math.min(lim.w, dp.width, st.width0), hi = finite(dp.maxWidth) ? Math.max(dp.maxWidth, dp.width) : pr.maxWidth;
        const widths = [...new Set([...pr.widths, dp.width, st.width].filter(w => w >= lo - 1e-9 && w <= hi + 1e-9).map(w => +w.toFixed(4)))].sort((a, b) => a - b);
        return {...pr, widths, preferredWidth:dp.width};
      },
      nextWidth(step = 1) {
        const list = api.presets().widths; if (!list.length) return st.width;
        let i = step > 0 ? list.findIndex(w => w > st.width + 1e-9) : list.length - 1 - [...list].reverse().findIndex(w => w < st.width - 1e-9);
        if (i < 0 || i >= list.length) i = step > 0 ? 0 : list.length - 1;
        return api.setWidth(list[i]);
      },
      nextVia(step = 1) { const list = api.presets().vias; if (!list.length) return {...st.via}; let i = list.findIndex(v => Math.abs(v.diameter - st.via.diameter) < 1e-9 && Math.abs(v.drill - st.via.drill) < 1e-9); i = (i + step + list.length) % list.length; return api.setVia(list[i]); },
      cycleMode(step = 1) { st.mode = C.MODES[(C.MODES.indexOf(st.mode) + C.MODES.length + step) % C.MODES.length]; st.last = null; return st.mode; },
      cycleCorner(step = 1) { st.corner = C.CORNERS[(C.CORNERS.indexOf(st.corner) + C.CORNERS.length + step) % C.CORNERS.length]; st.last = null; return st.corner; },
      toggleBend() { st.bend = !st.bend; st.last = null; return st.bend; },
      toggleAutoShrink() { st.autoShrink = !st.autoShrink; st.last = null; return st.autoShrink; },
      setAutoShrink(v) { st.autoShrink = !!v; st.last = null; return st.autoShrink; },
      cycleTransition(step = 1) { st.transition = TRANSITIONS[(TRANSITIONS.indexOf(st.transition) + TRANSITIONS.length + step) % TRANSITIONS.length]; st.last = null; return st.transition; },
      setTransition(t) { if (TRANSITIONS.includes(t)) st.transition = t; st.last = null; return st.transition; },
      setMode(m) { if (C.MODES.includes(m)) st.mode = m; st.last = null; return st.mode; },
      setCorner(c) { if (C.CORNERS.includes(c)) st.corner = c; st.last = null; return st.corner; },
      setWidth(w) { if (finite(w) && w > 0) st.width = w; st.last = null; return st.width; },
      setGap(g) { if (finite(g) && g > 0) st.gap = g; st.last = null; return st.gap; },
      setArcRadius(r) { st.arcRadius = finite(r) && r > 0 ? r : null; st.last = null; return st.arcRadius; },
      setVia(v) { if (v && finite(v.diameter)) st.via = {diameter:v.diameter, drill:finite(v.drill) ? v.drill : v.diameter / 2}; return {...st.via}; },
      commit(opt = {}) {
        if (opt.head && st.last && !st.last.empty) api.click();
        W.scene.reset(); selfObstacles();
        const t = traces(null), idOf = opt.makeId || (() => Atrium.id()), r6 = C.round6;
        W.scene.reset();
        const add = [];
        for (const l of t.legs) for (const [list, net] of [[l.piecesP, P], [l.piecesN, N]]) for (const q of list) {
          if (q.points.length > 1) add.push({id:idOf(), kind:"track", points:q.points.map(p => [r6(p[0]), r6(p[1])]), width:q.width, layer:l.layer, net});
        }
        for (const v of st.vias) { const via = {id:idOf(), kind:"via", x:r6(v.x), y:r6(v.y), diameter:v.diameter, drill:v.drill, layer:"Multi", net:v.net}; if (v.fromLayer) { via.fromLayer = v.fromLayer; via.toLayer = v.toLayer; } add.push(via); }
        const modify = [];
        for (const [k, g] of st.base) { const rec = W.owners[k]; modify.push(g.kind === "track" ? {id:rec.id, points:g.points.map(p => [r6(p[0]), r6(p[1])])} : {id:rec.id, x:r6(g.x), y:r6(g.y)}); }
        return {add, remove:[], modify, lengthP:t.lenP, lengthN:t.lenN, skew:t.lenP - t.lenN, pairGap:t.pairGap, pairOk:!t.pairBad};
      },
      cancel() { W.scene.reset(); st.last = null; st.legs.length = 1; Object.assign(st.legs[0], {centre:null, dir:null, br:null, side:0, endBreak:null, zones:[], manualEnd:0}); st.vias.length = 0; st.base = new Map(); st.undo.length = 0; },
      world:W
    };
    return api;
  }
  // ------------------------------------------------------------ retrace and gloss
  // Shifts each segment of a polyline by its own signed left offset; vertices are the
  // intersections of consecutive shifted lines (mitred joins).
  function shiftPolyline(pts, offs) {
    const n = pts.length, nrm = [];
    for (let i = 0; i < n - 1; i++) { const l = dist(pts[i], pts[i + 1]) || 1; nrm.push([-(pts[i + 1][1] - pts[i][1]) / l, (pts[i + 1][0] - pts[i][0]) / l]); }
    const out = [[pts[0][0] + nrm[0][0] * offs[0], pts[0][1] + nrm[0][1] * offs[0]]];
    for (let i = 1; i < n - 1; i++) {
      const a1 = [pts[i - 1][0] + nrm[i - 1][0] * offs[i - 1], pts[i - 1][1] + nrm[i - 1][1] * offs[i - 1]], b1 = [pts[i][0] + nrm[i - 1][0] * offs[i - 1], pts[i][1] + nrm[i - 1][1] * offs[i - 1]];
      const a2 = [pts[i][0] + nrm[i][0] * offs[i], pts[i][1] + nrm[i][1] * offs[i]], b2 = [pts[i + 1][0] + nrm[i][0] * offs[i], pts[i + 1][1] + nrm[i][1] * offs[i]];
      const rx = b1[0] - a1[0], ry = b1[1] - a1[1], sx = b2[0] - a2[0], sy = b2[1] - a2[1], den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12 * Math.hypot(rx, ry) * Math.hypot(sx, sy) + 1e-15) { out.push([(b1[0] + a2[0]) / 2, (b1[1] + a2[1]) / 2]); continue; }
      const t = ((a2[0] - a1[0]) * sy - (a2[1] - a1[1]) * sx) / den;
      out.push([a1[0] + rx * t, a1[1] + ry * t]);
    }
    const k = n - 2;
    out.push([pts[n - 1][0] + nrm[k][0] * offs[k], pts[n - 1][1] + nrm[k][1] * offs[k]]);
    return out;
  }
  // From `from` onto the polyline `line` over length L: a 45° ramp ("mitered"), an
  // S-curve ("rounded") or a jog ("step"). Returns {points, ramp:index of the ramp end}.
  function rampOnto(from, line, style, steps) {
    const q0 = line[0], off = [from[0] - q0[0], from[1] - q0[1]], m = Math.hypot(off[0], off[1]);
    if (m < 1e-9) return {points:line.slice(), end:0};
    const total = pathLength(line);
    let L = style === "step" ? 1e-4 : Math.max(m, 0.01) * (style === "rounded" ? 2.5 : 1);
    L = Math.min(L, total * 0.45);
    const cum = cumulative(line), n = style === "rounded" ? Math.max(5, steps + 1) : Math.max(1, steps);
    const pts = [[from[0], from[1]]];
    for (let k = 1; k <= n; k++) {
      const t = k / n, q = pointAt(line, cum, L * t), g = ease(t, style === "rounded" ? "rounded" : "mitered");
      pts.push([q[0] + off[0] * (1 - g), q[1] + off[1] * (1 - g)]);
    }
    const end = pts.length - 1;
    for (let i = 1; i < line.length; i++) if (cum[i] > L + 1e-9) pts.push(line[i]);
    return {points:pts, end, L};
  }
  // Coupled partner segment of segment a-b among `others` (same layer, other net).
  function partnerSeg(a, b, others, maxSep) {
    const L = dist(a, b); if (L < 1e-9) return null;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    let best = null;
    for (const t of others) for (let m = 1; m < t.points.length; m++) {
      const q0 = t.points[m - 1], q1 = t.points[m], ql = dist(q0, q1);
      if (ql < 1e-9 || Math.abs(ux * (q1[1] - q0[1]) - uy * (q1[0] - q0[0])) / ql > 0.02) continue;
      const lat = (q0[0] - a[0]) * -uy + (q0[1] - a[1]) * ux, sep = Math.abs(lat);
      if (sep > maxSep) continue;
      const p0 = (q0[0] - a[0]) * ux + (q0[1] - a[1]) * uy, p1 = (q1[0] - a[0]) * ux + (q1[1] - a[1]) * uy;
      const overlap = Math.min(L, Math.max(p0, p1)) - Math.max(0, Math.min(p0, p1));
      if (overlap < Math.min(0.5 * L, 0.5 * ql) - 1e-9) continue;
      if (!best || sep < best.sep - 1e-9) best = {track:t, m:m - 1, sep, side:lat >= 0 ? 1 : -1, dir:(q1[0] - q0[0]) * ux + (q1[1] - q0[1]) * uy > 0 ? 1 : -1};
    }
    return best;
  }
  function pairOf(board, o) {
    if (o.pair && o.pair.positive) return o.pair;
    if (typeof o.pair === "string") { const p = pairs(board).find(x => x.name === o.pair) || find(board, o.pair); if (p) return p; }
    if (o.net) return find(board, o.net);
    for (const id of o.ids || []) { const t = (board.items || []).find(i => i.id === id); if (t && t.net) { const p = find(board, t.net); if (p) return p; } }
    return null;
  }
  const GAP_MODES = ["min", "max", "preferred", "current", "custom"];
  const GAP_MODE_NAMES = {min:"Minimum gap", max:"Maximum gap", preferred:"Preferred gap", current:"Keep current gap", custom:"Custom gap"};
  // Re-traces a routed pair at a new gap (and optionally width), keeping its centreline.
  // Coupled runs move symmetrically; their ends ramp from the unchanged breakouts with
  // mitered or rounded transitions. Validated against the board; returns an edit plan.
  function retrace(board, defs, o = {}) {
    const t0 = now(), pair = pairOf(board, o);
    if (!pair) throw Error("Choose tracks of a differential pair to retrace.");
    const gapMode = GAP_MODES.includes(o.gapMode) ? o.gapMode : finite(o.gap) ? "custom" : "preferred";
    if (gapMode === "custom" && !(o.gap > 0)) throw Error("Enter a custom gap.");
    const style = TRANSITIONS.includes(o.transition) ? o.transition : "mitered", steps = finite(o.taperSteps) ? Math.max(1, o.taperSteps | 0) : 3;
    const W = C.worldFor(board, defs, o), rules = C.rulesFor(board, o.rules, o.project, defs), P = pair.positive, N = pair.negative;
    const ids = o.ids && o.ids.length ? new Set(o.ids) : null;
    const all = (board.items || []).filter(i => i.kind === "track" && (i.net === P || i.net === N) && Array.isArray(i.points) && i.points.length > 1 && !i.locked);
    const pick = all.filter(i => !ids || ids.has(i.id));
    const newPts = new Map(), runs = [], failed = [];
    let gapUsed = null;
    for (const T of pick.filter(i => i.net === P)) {
      const dp = rules.diffPair(P, N, pair.name, T.layer);
      const others = all.filter(i => i.net === N && i.layer === T.layer);
      const maxSep = Math.max(finite(dp.maxGap) ? dp.maxGap * 1.5 : 0, dp.gap * 3, 0.5) + 2 * T.width;
      const segs = [];
      for (let j = 1; j < T.points.length; j++) segs.push(partnerSeg(T.points[j - 1], T.points[j], others, maxSep));
      // Runs of coupled segments whose partners are consecutive segments of one N track.
      for (let j = 0; j < segs.length;) {
        if (!segs[j]) { j++; continue; }
        let k = j;
        while (k + 1 < segs.length && segs[k + 1] && segs[k + 1].track === segs[j].track && segs[k + 1].m - segs[k].m === segs[j].dir && segs[k + 1].side === segs[j].side) k++;
        if (k === j && segs.length > 1 && dist(T.points[j], T.points[j + 1]) < 1e-6) { j++; continue; }
        runs.push({T, j, k, partner:segs[j].track, m0:segs[j].m, m1:segs[k].m, dir:segs[j].dir, side:segs[j].side, segs:segs.slice(j, k + 1), dp});
        j = k + 1;
      }
    }
    for (const run of runs) {
      const {T, j, k, partner, side, dp} = run;
      if (ids && !ids.has(partner.id) && !ids.has(T.id)) continue;
      const Prun = T.points.slice(j, k + 2);
      const wP = finite(o.width) ? o.width : T.width, wN = finite(o.width) ? o.width : partner.width, wOld = (T.width + partner.width) / 2, wNew = (wP + wN) / 2;
      const cur = run.segs.map(s => s.sep - wOld);
      const target = gapMode === "min" ? dp.minGap : gapMode === "max" ? (finite(dp.maxGap) ? dp.maxGap : dp.gap) : gapMode === "preferred" ? dp.gap : gapMode === "custom" ? o.gap : null;
      if (gapUsed == null && target != null) gapUsed = target;
      const centre = shiftPolyline(Prun, run.segs.map(s => side * s.sep / 2));
      const half = run.segs.map((s, i) => ((target ?? cur[i]) + wNew) / 2);
      let nP = shiftPolyline(centre, half.map(h => -side * h)), nN = shiftPolyline(centre, half.map(h => side * h));
      // N in its own vertex order.
      const nIdx0 = run.dir > 0 ? run.m0 : run.m0 + 1, nIdx1 = run.dir > 0 ? run.m1 + 1 : run.m1;
      const Nrun = run.dir > 0 ? partner.points.slice(nIdx0, nIdx1 + 1) : partner.points.slice(nIdx1, nIdx0 + 1).reverse();
      const fit = (orig, line) => {
        let a = rampOnto(orig[0], line, style, steps), pts = a.points;
        const b = rampOnto(orig[orig.length - 1], pts.slice().reverse(), style, steps);
        return b.points.reverse();
      };
      const fP = fit(Prun, nP), fN = fit(Nrun, nN);
      const spliced = (Tr, from, to, mid, wNew2) => {
        const prev = newPts.get(Tr.id) || {pts:Tr.points.map(p => [p[0], p[1]]), segW:Tr.points.slice(1).map(() => Tr.width), map:Tr.points.map((_, i) => i)};
        const a = prev.map[from], b = prev.map[to];
        if (a == null || b == null) return false;
        const midW = mid.slice(1).map(() => qw(wNew2));
        // Width tapers over the ramps (first and last `steps` segments when widths differ).
        if (Math.abs(wNew2 - Tr.width) > 1e-9) {
          const n = midW.length, r = Math.min(steps, Math.floor(n / 2));
          for (let i = 0; i < r; i++) { const f = (i + 0.5) / r, w = qw(Tr.width + (wNew2 - Tr.width) * f); midW[i] = w; midW[n - 1 - i] = w; }
        }
        const pts = [...prev.pts.slice(0, a), ...mid, ...prev.pts.slice(b + 1)];
        const segW = [...prev.segW.slice(0, a), ...midW, ...prev.segW.slice(b)];
        const shift = mid.length - (b - a + 1), map = prev.map.map(x => x == null ? null : x <= a ? x : x >= b ? x + shift : null);
        newPts.set(Tr.id, {pts, segW, map, T:Tr});
        return true;
      };
      const iN = run.dir > 0 ? [nIdx0, nIdx1] : [nIdx1, nIdx0];
      if (!spliced(T, j, k + 1, fP, wP) || !spliced(partner, iN[0], iN[1], run.dir > 0 ? fN : fN.slice().reverse(), wN)) failed.push({id:T.id, reason:"Overlapping runs"});
    }
    // Validate: the new copper against the board, and P against N.
    W.scene.reset();
    for (const id of newPts.keys()) { const ow = W.ownerById.get(id); if (ow != null) W.scene.set(ow, {kind:"track", points:[[1e9, 1e9]], width:0, layer:W.owners[ow].item.layer, net:W.owners[ow].net}); }
    const idP = W.netIds.has(P) ? W.netIds.get(P) : 1e9, idN = W.netIds.has(N) ? W.netIds.get(N) : 1e9 + 1;
    const add = [], modify = [], PP = [], NN = [], idOf = o.makeId || (() => Atrium.id());
    let bad = null;
    for (const [id, e] of newPts) {
      const pieces = piecesOf(e.pts, e.segW);
      for (const q of pieces) {
        const c = C.makeContext(W, rules, {layer:e.T.layer, hw:q.width / 2, net:e.T.net === P ? idP : idN, netName:e.T.net, net2:e.T.net === P ? idN : idP, net2Name:e.T.net === P ? N : P, base:"any", dirs:8});
        const hit = C.pathHit(c, q.points, true);
        if (hit && W.own[hit.f] >= 0 && !bad) bad = {id, reason:"Clearance to " + (W.owners[W.own[hit.f]]?.id ?? "copper")};
        (e.T.net === P ? PP : NN).push({...q, layer:e.T.layer});
      }
      pieces.forEach((q, i) => {
        const pts = q.points.map(p => [C.round6(p[0]), C.round6(p[1])]);
        if (!i) modify.push(Math.abs(q.width - e.T.width) > 1e-9 ? {id, points:pts, width:q.width} : {id, points:pts});
        else add.push({id:idOf(), kind:"track", points:pts, width:q.width, layer:e.T.layer, net:e.T.net});
      });
    }
    W.scene.reset();
    const pg = PP.length && NN.length ? minGap(PP, NN).gap : Infinity;
    const need = Math.min(gapUsed ?? Infinity, ...runs.map(r => rules.clearance(P, N, r.T.layer)), ...runs.map(r => Math.min(...r.segs.map(s => s.sep - (r.T.width + r.partner.width) / 2))));
    if (!bad && pg < Math.min(need, gapUsed ?? need) - 1e-5) bad = {id:null, reason:"Pair gap " + pg.toFixed(3) + " mm"};
    if (bad && !o.force) return {add:[], remove:[], modify:[], failed:[...failed, bad], runs:runs.length, gap:gapUsed, gapMode, gapModeName:GAP_MODE_NAMES[gapMode], ok:false, ms:now() - t0};
    return {add, remove:[], modify, failed:bad ? [...failed, bad] : failed, runs:runs.length, gap:gapUsed, gapMode, gapModeName:GAP_MODE_NAMES[gapMode], pairGap:pg, ok:!bad, ms:now() - t0};
  }
  // Smooths size steps on pair tracks: two collinear tracks of different width meeting
  // end to end get a taper, and short lateral jogs become 45° or S-curve transitions.
  function gloss(board, defs, o = {}) {
    const pair = pairOf(board, o), style = TRANSITIONS.includes(o.transition) ? o.transition : "mitered", steps = finite(o.taperSteps) ? Math.max(1, o.taperSteps | 0) : 3;
    const W = C.worldFor(board, defs, o), rules = C.rulesFor(board, o.rules, o.project, defs);
    const ids = o.ids && o.ids.length ? new Set(o.ids) : null;
    const nets = pair ? new Set([pair.positive, pair.negative]) : null;
    const tracks = (board.items || []).filter(i => i.kind === "track" && Array.isArray(i.points) && i.points.length > 1 && !i.locked && (!ids || ids.has(i.id)) && (!nets || nets.has(i.net)));
    const modify = new Map(), add = [], idOf = o.makeId || (() => Atrium.id()), key = p => Math.round(p[0] * 1e5) + "," + Math.round(p[1] * 1e5);
    const ptsOf = t => modify.get(t.id)?.points || t.points;
    const legal = (t, pts, width) => {
      W.scene.reset();
      const ow = W.ownerById.get(t.id); if (ow != null) W.scene.set(ow, {kind:"track", points:[[1e9, 1e9]], width:0, layer:t.layer, net:W.owners[ow].net});
      const nid = W.netIds.has(t.net) ? W.netIds.get(t.net) : 1e9;
      const c = C.makeContext(W, rules, {layer:t.layer, hw:width / 2, net:nid, netName:t.net || "", base:"any", dirs:8});
      const hit = C.pathHit(c, pts, true); W.scene.reset();
      return !hit || W.own[hit.f] < 0;
    };
    // Lateral jogs inside one track.
    for (const t of tracks) {
      let pts = t.points.map(p => [p[0], p[1]]), changed = false;
      for (let i = 1; i + 2 < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1], d = pts[i + 2];
        const L1 = dist(a, b), Lj = dist(b, c), L2 = dist(c, d);
        if (L1 < 1e-9 || Lj < 1e-9 || L2 < 1e-9) continue;
        const u = [(b[0] - a[0]) / L1, (b[1] - a[1]) / L1], v = [(d[0] - c[0]) / L2, (d[1] - c[1]) / L2];
        if (u[0] * v[0] + u[1] * v[1] < 0.9999) continue;
        const nrm = [-u[1], u[0]], delta = (c[0] - b[0]) * nrm[0] + (c[1] - b[1]) * nrm[1], along = (c[0] - b[0]) * u[0] + (c[1] - b[1]) * u[1];
        if (Math.abs(delta) < 1e-6 || Lj > Math.max(4 * t.width, 1.5)) continue;
        const want = style === "rounded" ? 2.5 * Math.abs(delta) : style === "step" ? 0 : Math.abs(delta);
        if (style === "mitered" && Math.abs(along - Math.abs(delta)) < 1e-6) continue;
        if (style === "step") continue;
        const mid = (along) / 2, s0 = -want / 2 + mid, s1 = want / 2 + mid;
        if (L1 + s0 < 1e-6 || L2 - (along - s1) < 1e-6) continue;
        const start = [b[0] + u[0] * s0, b[1] + u[1] * s0], n = style === "rounded" ? Math.max(6, steps + 3) : 1, ramp = [];
        for (let k = 0; k <= n; k++) { const f = k / n, g = ease(f, style); ramp.push([start[0] + u[0] * want * f + nrm[0] * delta * g, start[1] + u[1] * want * f + nrm[1] * delta * g]); }
        const next = simplify([...pts.slice(0, i), ...ramp, ...pts.slice(i + 2)]);
        if (!legal(t, next, t.width)) continue;
        pts = next; changed = true;
      }
      if (changed) modify.set(t.id, {id:t.id, points:pts.map(p => [C.round6(p[0]), C.round6(p[1])])});
    }
    // Width steps between two collinear tracks meeting end to end.
    const ends = new Map();
    for (const t of tracks) { const p = ptsOf(t); for (const [e, q] of [[0, p[0]], [1, p[p.length - 1]]]) { const k = t.layer + "|" + key(q); if (!ends.has(k)) ends.set(k, []); ends.get(k).push({t, e}); } }
    for (const [k, list] of ends) {
      if (list.length !== 2) continue;
      const [x, y] = list; if (x.t.net !== y.t.net || Math.abs(x.t.width - y.t.width) < 1e-9 || style === "step") continue;
      const wide = x.t.width > y.t.width ? x : y, narrow = wide === x ? y : x;
      let wp = ptsOf(wide.t).map(p => [p[0], p[1]]); if (wide.e === 0) wp.reverse();
      let np = ptsOf(narrow.t); if (narrow.e === 1) np = np.slice().reverse();
      const J = wp[wp.length - 1], A = wp[wp.length - 2], B = np[1], La = dist(A, J), Lb = dist(J, B);
      if ((J[0] - A[0]) * (B[0] - J[0]) + (J[1] - A[1]) * (B[1] - J[1]) < 0.999 * La * Lb) continue;
      const dw = (wide.t.width - narrow.t.width) / 2, L = Math.min(La * 0.45, Math.max(dw, 0.01) * (style === "rounded" ? 2.5 : 1) * 2);
      const u = [(J[0] - A[0]) / La, (J[1] - A[1]) / La], n = style === "rounded" ? Math.max(4, steps) : steps;
      const cut = [J[0] - u[0] * L, J[1] - u[1] * L];
      const wNew = [...wp.slice(0, -1), cut];
      if (wide.e === 0) wNew.reverse();
      modify.set(wide.t.id, {id:wide.t.id, points:wNew.map(p => [C.round6(p[0]), C.round6(p[1])])});
      for (let i = 0; i < n; i++) {
        const f0 = i / n, f1 = (i + 1) / n, g = ease((i + 0.5) / n, style);
        const p0 = [cut[0] + u[0] * L * f0, cut[1] + u[1] * L * f0], p1 = [cut[0] + u[0] * L * f1, cut[1] + u[1] * L * f1];
        add.push({id:idOf(), kind:"track", points:[p0, p1].map(p => [C.round6(p[0]), C.round6(p[1])]), width:qw(wide.t.width - (wide.t.width - narrow.t.width) * g), layer:wide.t.layer, net:wide.t.net});
      }
      void k;
    }
    return {add, remove:[], modify:[...modify.values()], transition:style};
  }
  return Object.freeze({begin, pairs, find, offset, bendSkew, retrace, gloss, sizeProfile, offsetVar, shiftPolyline,
    transitions:TRANSITIONS.slice(), transitionNames:TRANSITION_NAMES, gapModes:GAP_MODES.slice(), gapModeNames:GAP_MODE_NAMES, statusNames:STATUS_NAMES});
})();
