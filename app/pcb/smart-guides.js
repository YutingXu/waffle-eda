"use strict";
// Smart guides (PowerPoint-style alignment while dragging) and Edit → Align commands.
//
//   const s = AtriumGuides.begin(doc, defs, movingIds, {viewport, margin});   // once per drag
//   const r = s.snap([dx, dy], {scale, threshold_px, grid, anchor, suspend});  // every pointer move
//   AtriumGuides.draw(ctx, r, {scale, dpr, worldToScreen});                     // in render()
//
// begin() caches every reference coordinate once, in sorted typed arrays per axis and
// class (box edges, box centres, pad/pin centres). snap() binary-searches them for each
// feature of the moving group, so a pointer move costs O(features · log n) plus one pass
// over the row/column boxes for equal-spacing. Guides win on the axis that snapped; the
// grid applies on the other axis.
//
// Align / distribute commands are pure: they return {moves:[{id,dx,dy}]} plans that
// applyPlan() (or the caller) applies inside one undo step.
globalThis.AtriumGuides = (() => {
  const A = globalThis.Atrium;
  const EPS = 1e-6;
  const localBoxes = new WeakMap();
  const geometry = (def, kind) => kind === "pcb" ? def?.footprint : def?.symbol;
  // Part body box in part coordinates: pads, pins and outline shapes (as the canvas
  // selection box and Gerber designator default use).
  function localBox(g) {
    if (!g) return null;
    let b = localBoxes.get(g);
    if (b === undefined) { b = A.bounds(A.symbolPoints(g)); localBoxes.set(g, b); }
    return b;
  }
  function worldBox(item, b) {
    const a = item.angle || 0;
    if (!a) return [item.x + b[0], item.y + b[1], item.x + b[2], item.y + b[3]];
    const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const px = k & 1 ? b[2] : b[0], py = k & 2 ? b[3] : b[1];
      const x = item.x + px * c - py * s, y = item.y + px * s + py * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // Exact multiples of 90° should not leave 1e-16 noise in the box.
    const r = v => Math.abs(v - Math.round(v * 1e9) / 1e9) < 1e-12 ? Math.round(v * 1e9) / 1e9 : v;
    return [r(x0), r(y0), r(x1), r(y1)];
  }
  // World box of any document item, or null.
  function itemBox(item, defs, kind) {
    if (item.kind === "part") {
      const b = localBox(geometry(defs.get(item.def), kind));
      return b ? worldBox(item, b) : [item.x, item.y, item.x, item.y];
    }
    if (item.points) return A.bounds(item.points);
    if (item.kind === "pad") {
      const w = (item.w || 0) / 2, h = (item.h || 0) / 2;
      return worldBox(item, [-w, -h, w, h]);
    }
    if (item.kind === "via") { const r = (item.diameter || 0) / 2; return [item.x - r, item.y - r, item.x + r, item.y + r]; }
    if (Number.isFinite(item.x) && Number.isFinite(item.y)) return [item.x, item.y, item.x, item.y];
    return null;
  }
  const originOf = item => item.points ? item.points[0] : [item.x, item.y];
  const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

  // ------------------------------------------------------------ sorted reference lines
  // A class of reference lines on one axis: value, and the extent of its source on the
  // other axis (to draw the guide from the source to the moving object).
  function lines() { return {v: [], lo: [], hi: []}; }
  function push(l, v, lo, hi) { l.v.push(v); l.lo.push(lo); l.hi.push(hi); }
  function freeze(l) {
    const n = l.v.length, order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const src = Float64Array.from(l.v);
    order.sort((a, b) => src[a] - src[b]);
    const v = new Float64Array(n), lo = new Float64Array(n), hi = new Float64Array(n);
    for (let i = 0; i < n; i++) { const k = order[i]; v[i] = src[k]; lo[i] = l.lo[k]; hi[i] = l.hi[k]; }
    return {v, lo, hi, n};
  }
  // Index of the value nearest x, or -1.
  function nearest(l, x) {
    const v = l.v;
    let a = 0, b = l.n;
    if (!b) return -1;
    while (a < b) { const m = (a + b) >> 1; if (v[m] < x) a = m + 1; else b = m; }
    if (a === 0) return 0;
    if (a === l.n) return l.n - 1;
    return x - v[a - 1] <= v[a] - x ? a - 1 : a;
  }
  // Union of the other-axis extents of every line at value x.
  function extentAt(l, i, x, out) {
    for (let k = i; k >= 0 && Math.abs(l.v[k] - x) <= EPS; k--) { if (l.lo[k] < out[0]) out[0] = l.lo[k]; if (l.hi[k] > out[1]) out[1] = l.hi[k]; }
    for (let k = i + 1; k < l.n && Math.abs(l.v[k] - x) <= EPS; k++) { if (l.lo[k] < out[0]) out[0] = l.lo[k]; if (l.hi[k] > out[1]) out[1] = l.hi[k]; }
    return out;
  }

  /**
   * begin(doc, defs, movingIds, opts) -> session
   *  opts.viewport [x0,y0,x1,y1] world box; references outside it (plus opts.margin) are ignored
   *  opts.margin   world margin around the viewport (default: 25% of the viewport)
   *  opts.pads     include pad / pin centres (default true)
   *  opts.maxMovingPads  skip pad matching for bigger moving groups (default 256)
   * session.snap(delta, o): delta is the raw pointer offset since the drag began.
   *  o.scale, o.threshold_px (6), o.grid + o.anchor (grid for unsnapped axes, as editor.js),
   *  o.suspend (grid only), o.gridOnly (schematics: keep the anchor on the grid), o.spacing (true)
   *  -> {delta:[dx,dy], snapped:[bx,by], guides:[{x1,y1,x2,y2,kind}], spacing:[{x1,y1,x2,y2,gap,axis}]}
   */
  function begin(doc, defs, movingIds, opts = {}) {
    const started = now();
    const moving = movingIds instanceof Set ? movingIds : new Set(movingIds || []);
    const kind = doc.kind, pcb = kind === "pcb", usePads = opts.pads !== false;
    let view = opts.viewport || null;
    if (view) {
      const m = opts.margin ?? Math.max(view[2] - view[0], view[3] - view[1]) * .25;
      view = [view[0] - m, view[1] - m, view[2] + m, view[3] + m];
    }
    const X = {edge: lines(), center: lines(), pad: lines()}, Y = {edge: lines(), center: lines(), pad: lines()};
    const boxes = [];
    let mb = null;
    const movingPadsX = [], movingPadsY = [];
    for (const item of doc.items) {
      const isMoving = moving.has(item.id);
      if (!isMoving && item.kind !== "part" && !(pcb && (item.kind === "pad" || item.kind === "via"))) continue;
      const b = itemBox(item, defs, kind);
      if (!b) continue;
      if (isMoving) {
        mb = mb ? [Math.min(mb[0], b[0]), Math.min(mb[1], b[1]), Math.max(mb[2], b[2]), Math.max(mb[3], b[3])] : b.slice();
        if (usePads && item.kind === "part") {
          for (const p of A.pins(item, defs.get(item.def), kind)) if (!p.hidden) { movingPadsX.push(p.at[0]); movingPadsY.push(p.at[1]); }
        } else if (usePads && (item.kind === "pad" || item.kind === "via")) { movingPadsX.push(item.x); movingPadsY.push(item.y); }
        continue;
      }
      if (view && !overlaps(b, view)) continue;
      if (item.kind === "part") {
        boxes.push(b);
        push(X.edge, b[0], b[1], b[3]); push(X.edge, b[2], b[1], b[3]); push(X.center, (b[0] + b[2]) / 2, b[1], b[3]);
        push(Y.edge, b[1], b[0], b[2]); push(Y.edge, b[3], b[0], b[2]); push(Y.center, (b[1] + b[3]) / 2, b[0], b[2]);
        if (usePads) for (const p of A.pins(item, defs.get(item.def), kind)) {
          if (p.hidden) continue;
          push(X.pad, p.at[0], p.at[1], p.at[1]); push(Y.pad, p.at[1], p.at[0], p.at[0]);
        }
      } else if (usePads) {
        push(X.pad, item.x, item.y, item.y); push(Y.pad, item.y, item.x, item.x);
      }
    }
    const outline = pcb && doc.outline?.length >= 3 ? doc.outline : null;
    if (outline) {
      const ob = A.bounds(outline);
      push(X.edge, ob[0], ob[1], ob[3]); push(X.edge, ob[2], ob[1], ob[3]); push(X.center, (ob[0] + ob[2]) / 2, ob[1], ob[3]);
      push(Y.edge, ob[1], ob[0], ob[2]); push(Y.edge, ob[3], ob[0], ob[2]); push(Y.center, (ob[1] + ob[3]) / 2, ob[0], ob[2]);
      // Straight outline edges (notches, cut-outs) are references too.
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i], c = outline[(i + 1) % outline.length];
        if (Math.abs(a[0] - c[0]) < EPS && Math.abs(a[1] - c[1]) > EPS) push(X.edge, a[0], Math.min(a[1], c[1]), Math.max(a[1], c[1]));
        if (Math.abs(a[1] - c[1]) < EPS && Math.abs(a[0] - c[0]) > EPS) push(Y.edge, a[1], Math.min(a[0], c[0]), Math.max(a[0], c[0]));
      }
    }
    const R = {x: {edge: freeze(X.edge), center: freeze(X.center), pad: freeze(X.pad)}, y: {edge: freeze(Y.edge), center: freeze(Y.center), pad: freeze(Y.pad)}};
    const B = new Float64Array(boxes.length * 4);
    boxes.forEach((b, i) => B.set(b, i * 4));
    const maxPads = opts.maxMovingPads ?? 256;
    const mp = movingPadsX.length <= maxPads ? {x: Float64Array.from(movingPadsX), y: Float64Array.from(movingPadsY)} : {x: new Float64Array(0), y: new Float64Array(0)};
    const stats = {references: R.x.edge.n + R.x.center.n + R.x.pad.n + R.y.edge.n + R.y.center.n + R.y.pad.n, boxes: boxes.length, movingPads: mp.x.length, ms: 0};

    // Best alignment on one axis at trial offset d: {diff, value, base, cls} with |diff| <= t, or null.
    function align(axis, d, t) {
      const r = R[axis], lo = axis === "x" ? 0 : 1;
      let best = null;
      // base: the feature's coordinate before the move, so the snapped delta is value - base.
      const consider = (base, cls) => {
        const v = base + d, l = r[cls], i = nearest(l, v);
        if (i < 0) return;
        const diff = l.v[i] - v;
        // Pads align capacitors; prefer them on a tie.
        const score = Math.abs(diff) * (cls === "pad" ? .999 : 1);
        if (Math.abs(diff) <= t && (!best || score < best.score)) best = {diff, value: l.v[i], base, cls, score};
      };
      if (mb) {
        consider(mb[lo], "edge"); consider((mb[lo] + mb[lo + 2]) / 2, "center"); consider(mb[lo + 2], "edge");
      }
      const pads = mp[axis];
      for (let i = 0; i < pads.length; i++) consider(pads[i], "pad");
      return best;
    }
    // Equal spacing along one axis, inside the band the moving box occupies on the other.
    function spacing(axis, d, other, t) {
      if (!mb || !B.length) return null;
      const a0 = axis === "x" ? 0 : 1, b0 = 1 - a0;
      const lo = mb[a0] + d, hi = mb[a0 + 2] + d, bandLo = mb[b0] + other, bandHi = mb[b0 + 2] + other;
      const before = [], after = [];
      for (let i = 0; i < B.length; i += 4) {
        if (B[i + b0] > bandHi || B[i + b0 + 2] < bandLo) continue;
        const s = B[i + a0], e = B[i + a0 + 2];
        if (e <= lo + t && s < lo) before.push(i); else if (s >= hi - t && e > hi) after.push(i);
      }
      if (!before.length && !after.length) return null;
      before.sort((p, q) => B[q + a0 + 2] - B[p + a0 + 2]);
      after.sort((p, q) => B[p + a0] - B[q + a0]);
      let best = null;
      const offer = (diff, gap, pairs) => { if (Math.abs(diff) <= t && gap > EPS && (!best || Math.abs(diff) < Math.abs(best.diff))) best = {diff, gap, pairs}; };
      const L = before[0], R2 = after[0];
      // Same gap as the previous pair on the left, or on the right.
      if (L !== undefined) {
        const LL = before.find(k => B[k + a0 + 2] <= B[L + a0] + EPS);
        if (LL !== undefined) { const gap = B[L + a0] - B[LL + a0 + 2]; offer(B[L + a0 + 2] + gap - lo, gap, [[LL, L], [L, -1]]); }
      }
      if (R2 !== undefined) {
        const RR = after.find(k => B[k + a0] >= B[R2 + a0 + 2] - EPS);
        if (RR !== undefined) { const gap = B[RR + a0] - B[R2 + a0 + 2]; offer(B[R2 + a0] - gap - hi, gap, [[-1, R2], [R2, RR]]); }
      }
      // Centred between the neighbours.
      if (L !== undefined && R2 !== undefined) {
        const room = B[R2 + a0] - B[L + a0 + 2] - (hi - lo);
        if (room > 0) offer(B[L + a0 + 2] + room / 2 - lo, room / 2, [[L, -1], [-1, R2]]);
      }
      return best;
    }
    function snap(delta, o = {}) {
      const t0 = now();
      const scale = o.scale || 1, t = (o.threshold_px ?? 6) / scale;
      const raw = [delta[0], delta[1]], out = [raw[0], raw[1]], snapped = [false, false];
      const gridded = k => (o.grid > 0 && o.anchor) ? A.snap(o.anchor[k] + raw[k], o.grid) - o.anchor[k] : raw[k];
      const result = {delta: out, snapped, guides: [], spacing: []};
      if (o.suspend || (!mb && !mp.x.length)) { out[0] = gridded(0); out[1] = gridded(1); finish(); return result; }
      const ax = align("x", raw[0], t), ay = align("y", raw[1], t);
      const ox = ax ? raw[0] + ax.diff : gridded(0), oy = ay ? raw[1] + ay.diff : gridded(1);
      const sx = o.spacing === false ? null : spacing("x", raw[0], oy, t), sy = o.spacing === false ? null : spacing("y", raw[1], ox, t);
      const pick = (a, s) => a && (!s || Math.abs(a.diff) <= Math.abs(s.diff) + EPS) ? {kind: "align", diff: a.diff} : s ? {kind: "space", diff: s.diff} : null;
      let px = pick(ax, sx), py = pick(ay, sy);
      // Schematics: accept a guide only where it leaves the anchor on the grid (pins stay connectable).
      if (o.gridOnly && o.grid > 0 && o.anchor) {
        const off = (k, hit, raw0) => { if (!hit) return false; const v = o.anchor[k] + (hit.kind === "align" ? (k ? ay : ax).value - (k ? ay : ax).base : raw0 + hit.diff); return Math.abs(A.snap(v, o.grid) - v) > 1e-6; };
        if (off(0, px, raw[0])) px = null;
        if (off(1, py, raw[1])) py = null;
      }
      // Round to 1 nm so a snapped coordinate equals its reference exactly.
      if (px) { out[0] = px.kind === "align" ? ax.value - ax.base : nm(raw[0] + px.diff); snapped[0] = true; } else out[0] = gridded(0);
      if (py) { out[1] = py.kind === "align" ? ay.value - ay.base : nm(raw[1] + py.diff); snapped[1] = true; } else out[1] = gridded(1);
      if (o.guides !== false) {
        if (px) px.kind === "align" ? guides("x", out[0], out[1], result.guides) : markers("x", sx, out, result.spacing);
        if (py) py.kind === "align" ? guides("y", out[1], out[0], result.guides) : markers("y", sy, out, result.spacing);
      }
      finish();
      return result;
      function finish() { stats.lastSnapMs = now() - t0; }
    }
    // Every feature that lies exactly on a reference line after the snap gets a guide.
    function guides(axis, d, other, list) {
      const r = R[axis], a0 = axis === "x" ? 0 : 1, b0 = 1 - a0;
      const seen = new Set();
      const emit = (cls, v, ext) => {
        const key = cls + ":" + Math.round(v * 1e6);
        if (seen.has(key)) return;
        seen.add(key);
        const lo = ext[0], hi = ext[1];
        list.push(axis === "x" ? {x1: v, y1: lo, x2: v, y2: hi, kind: cls} : {x1: lo, y1: v, x2: hi, y2: v, kind: cls});
      };
      const test = (v, cls, moveLo, moveHi) => {
        const l = r[cls], i = nearest(l, v);
        if (i < 0 || Math.abs(l.v[i] - v) > EPS) return;
        emit(cls, l.v[i], extentAt(l, i, l.v[i], [moveLo, moveHi]));
      };
      if (mb) {
        const lo = mb[b0] + other, hi = mb[b0 + 2] + other;
        test(mb[a0] + d, "edge", lo, hi); test((mb[a0] + mb[a0 + 2]) / 2 + d, "center", lo, hi); test(mb[a0 + 2] + d, "edge", lo, hi);
      }
      const pads = mp[axis], cross = mp[axis === "x" ? "y" : "x"];
      for (let i = 0; i < pads.length && list.length < 64; i++) test(pads[i] + d, "pad", cross[i] + other, cross[i] + other);
    }
    function markers(axis, s, out, list) {
      const a0 = axis === "x" ? 0 : 1, b0 = 1 - a0;
      const m = [mb[0] + out[0], mb[1] + out[1], mb[2] + out[0], mb[3] + out[1]];
      const box = k => k < 0 ? m : [B[k], B[k + 1], B[k + 2], B[k + 3]];
      for (const [p, q] of s.pairs) {
        const P = box(p), Q = box(q);
        // Draw across the overlap of the two boxes on the other axis, else between centres.
        const lo = Math.max(P[b0], Q[b0]), hi = Math.min(P[b0 + 2], Q[b0 + 2]);
        const c = lo <= hi ? (lo + hi) / 2 : (P[b0] + P[b0 + 2] + Q[b0] + Q[b0 + 2]) / 4;
        const s1 = P[a0 + 2], s2 = Q[a0];
        list.push(axis === "x" ? {x1: s1, y1: c, x2: s2, y2: c, gap: s2 - s1, axis} : {x1: c, y1: s1, x2: c, y2: s2, gap: s2 - s1, axis});
      }
    }
    stats.ms = now() - started;
    return {snap, stats, bounds: mb};
  }
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const nm = v => Math.round(v * 1e9) / 1e9 + 0;

  // ------------------------------------------------------------ drawing
  const STYLE = {edge: "#ff4fd8", center: "#ff4fd8", pad: "#3fe0ff", space: "#ff4fd8", label: "#1b1f24"};
  function draw(ctx, result, o) {
    if (!result || (!result.guides?.length && !result.spacing?.length)) return;
    const S = o.worldToScreen, dpr = o.dpr || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1; ctx.lineCap = "butt";
    const crisp = v => Math.round(v) + .5;
    for (const g of result.guides) {
      const a = S([g.x1, g.y1]), b = S([g.x2, g.y2]);
      const vertical = g.x1 === g.x2, ext = 10;
      ctx.strokeStyle = STYLE[g.kind] || STYLE.edge;
      ctx.setLineDash(g.kind === "pad" ? [4, 3] : g.kind === "center" ? [7, 3] : []);
      ctx.beginPath();
      if (vertical) { const x = crisp(a[0]); ctx.moveTo(x, Math.min(a[1], b[1]) - ext); ctx.lineTo(x, Math.max(a[1], b[1]) + ext); }
      else { const y = crisp(a[1]); ctx.moveTo(Math.min(a[0], b[0]) - ext, y); ctx.lineTo(Math.max(a[0], b[0]) + ext, y); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = ctx.fillStyle = STYLE.space;
    ctx.font = "600 10px ui-monospace, Menlo, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const m of result.spacing) {
      const a = S([m.x1, m.y1]), b = S([m.x2, m.y2]), horizontal = m.axis === "x";
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 2) continue;
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, h = Math.min(5, len / 3);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      // End ticks and arrowheads, PowerPoint style.
      for (const [p, s] of [[a, 1], [b, -1]]) {
        ctx.moveTo(p[0] - uy * 5, p[1] + ux * 5); ctx.lineTo(p[0] + uy * 5, p[1] - ux * 5);
        ctx.moveTo(p[0] + s * ux * h - uy * h * .6, p[1] + s * uy * h + ux * h * .6); ctx.lineTo(p[0], p[1]);
        ctx.lineTo(p[0] + s * ux * h + uy * h * .6, p[1] + s * uy * h - ux * h * .6);
      }
      ctx.stroke();
      if (o.labels !== false && len > 28 && Number.isFinite(m.gap)) {
        const text = (o.format ? o.format(m.gap) : +m.gap.toFixed(3) + "");
        const cx = (a[0] + b[0]) / 2 + (horizontal ? 0 : 12), cy = (a[1] + b[1]) / 2 + (horizontal ? -9 : 0);
        const w = ctx.measureText ? ctx.measureText(text).width + 6 : 30;
        ctx.save(); ctx.fillStyle = STYLE.label; ctx.globalAlpha = .8; ctx.fillRect(cx - w / 2, cy - 7, w, 14); ctx.restore();
        ctx.fillText(text, cx, cy);
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ align / distribute plans
  function selection(doc, defs, ids) {
    const want = ids instanceof Set ? ids : new Set(ids || []), out = [];
    for (const item of doc.items) {
      if (!want.has(item.id)) continue;
      const box = itemBox(item, defs, doc.kind);
      if (box) out.push({item, box, origin: originOf(item)});
    }
    return out;
  }
  // plan.locked: ids of locked objects the plan moves. The editor asks before applying
  // (AtriumPCBEdit guardLocked), as it does for drag, nudge and delete.
  const plan = (list, doc) => {
    const moves = list.filter(m => Math.abs(m.dx) > 1e-12 || Math.abs(m.dy) > 1e-12), ids = new Set(moves.map(m => m.id));
    return {moves, locked: doc ? doc.items.filter(i => i.locked === true && ids.has(i.id)).map(i => i.id) : []};
  };
  const round = v => Math.round(v * 1e9) / 1e9 + 0;
  /**
   * align(doc, defs, ids, mode) -> {moves:[{id,dx,dy}]}
   * mode: "left" | "right" | "top" | "bottom" | "hcenter" (same centre x) | "vcenter" (same centre y)
   * Aligns body boxes to the extreme (or the centre) of the selection's bounding box.
   * opts.to: "selection" (default) or "primary" with opts.primary = id (Altium aligns to the selection bounds).
   */
  function align(doc, defs, ids, mode, opts = {}) {
    const sel = selection(doc, defs, ids);
    if (sel.length < 2) return {moves: []};
    const ref = opts.to === "primary" ? sel.find(s => s.item.id === opts.primary)?.box : null;
    const all = ref || sel.reduce((b, s) => [Math.min(b[0], s.box[0]), Math.min(b[1], s.box[1]), Math.max(b[2], s.box[2]), Math.max(b[3], s.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    const f = {
      left: s => [all[0] - s.box[0], 0], right: s => [all[2] - s.box[2], 0],
      top: s => [0, all[1] - s.box[1]], bottom: s => [0, all[3] - s.box[3]],
      hcenter: s => [(all[0] + all[2] - s.box[0] - s.box[2]) / 2, 0], vcenter: s => [0, (all[1] + all[3] - s.box[1] - s.box[3]) / 2]
    }[mode];
    if (!f) throw Error("Unknown alignment " + mode + ".");
    return plan(sel.map(s => { const [dx, dy] = f(s); return {id: s.item.id, dx: round(dx), dy: round(dy)}; }), doc);
  }
  /**
   * distribute(doc, defs, ids, axis) -> plan. Equal gaps between body boxes along "x"
   * (horizontally) or "y"; the first and last objects stay. opts.gap fixes the gap instead.
   */
  function distribute(doc, defs, ids, axis, opts = {}) {
    const sel = selection(doc, defs, ids), a = axis === "y" ? 1 : 0;
    if (sel.length < (opts.gap != null ? 2 : 3)) return {moves: []};
    sel.sort((p, q) => (p.box[a] + p.box[a + 2]) - (q.box[a] + q.box[a + 2]) || p.box[a] - q.box[a]);
    const first = sel[0], last = sel.at(-1);
    const sizes = sel.reduce((s, x) => s + x.box[a + 2] - x.box[a], 0);
    const gap = opts.gap != null ? opts.gap : (last.box[a + 2] - first.box[a] - sizes) / (sel.length - 1);
    let at = first.box[a];
    return plan(sel.map(s => {
      const d = at - s.box[a]; at += s.box[a + 2] - s.box[a] + gap;
      return {id: s.item.id, dx: a ? 0 : round(d), dy: a ? round(d) : 0};
    }), doc);
  }
  /** alignToGrid(doc, defs, ids, grid?) -> plan moving each object's origin onto the grid. */
  function alignToGrid(doc, defs, ids, grid = doc.grid) {
    return plan(selection(doc, defs, ids).map(s => ({id: s.item.id, dx: round(A.snap(s.origin[0], grid) - s.origin[0]), dy: round(A.snap(s.origin[1], grid) - s.origin[1])})), doc);
  }
  /**
   * array(doc, defs, ids, axis, pitch, opts) -> plan. "Make a row/column at pitch N":
   * objects sorted along axis ("x" row, "y" column) are placed pitch apart (origin to
   * origin, or centre to centre with opts.ref="center"), starting at the first object;
   * opts.align (default true) lines them up on the other axis too.
   */
  function array(doc, defs, ids, axis, pitch, opts = {}) {
    if (!(Math.abs(pitch) > 0) || !Number.isFinite(pitch)) throw Error("Enter a pitch greater than zero.");
    const sel = selection(doc, defs, ids), a = axis === "y" ? 1 : 0, b = 1 - a;
    if (sel.length < 2) return {moves: []};
    const at = s => opts.ref === "center" ? [(s.box[0] + s.box[2]) / 2, (s.box[1] + s.box[3]) / 2] : s.origin;
    sel.sort((p, q) => at(p)[a] - at(q)[a] || at(p)[b] - at(q)[b]);
    const start = at(sel[0]);
    return plan(sel.map((s, i) => {
      const p = at(s), d = [0, 0];
      d[a] = start[a] + i * pitch - p[a];
      if (opts.align !== false) d[b] = start[b] - p[b];
      return {id: s.item.id, dx: round(d[0]), dy: round(d[1])};
    }), doc);
  }
  /** Apply a plan in place. Parts go through A.transformPart so schematic wires follow. */
  function applyPlan(doc, defs, p, wiresOf, touched) {
    const byId = new Map(doc.items.map(i => [i.id, i])), changed = [];
    for (const m of p.moves) {
      const item = byId.get(m.id);
      if (!item) continue;
      if (item.kind === "part") {
        const moved = A.transformPart(doc, item, defs.get(item.def), {x: round(item.x + m.dx), y: round(item.y + m.dy)}, wiresOf?.(item));
        if (touched) for (const obj of moved) touched.add(obj);
      } else {
        A.moveItem(item, m.dx, m.dy);
        touched?.add(item);
      }
      changed.push(item);
    }
    return changed;
  }

  function command(action,{doc,defs,selection,excluded,unit,info,promptValue,edit,guard,wires,followDesignators}) {
    const ids = doc().items.filter(item => selection.has(item.id) && !excluded(item)).map(item => item.id);
    const grid = action === "align-grid", units = A.units;
    const run = plan => {
      if (plan.locked?.length && !guard(plan.locked, () => run(plan))) return;
      if (!plan.moves.length) {info("Nothing to move."); return;}
      const touched = new Set();
      edit(() => {
        applyPlan(doc(), defs(), plan, wires, touched);
        for (const obj of followDesignators(plan.moves.map(move => move.id))) touched.add(obj);
      }, undefined, touched);
      info(plan.moves.length + (plan.moves.length === 1 ? " object moved" : " objects moved"));
    };
    if (ids.length < (grid ? 1 : 2)) {
      info(grid ? "Select the objects to align to the grid." : "Select two or more objects.");
      return;
    }
    if (action === "make-row" || action === "make-column") {
      const row = action === "make-row";
      promptValue(row ? "Row pitch" : "Column pitch", units.format(doc().grid * 8, unit()), text => {
        const pitch = units.parse(text, unit());
        if (!(pitch > 0)) {info("Enter a pitch greater than zero."); return;}
        run(array(doc(), defs(), ids, row ? "x" : "y", pitch));
      }, "Apply", {unit:unit(), storageUnit:"mm", nanometres:true, min:.000001});
      return;
    }
    run(grid ? alignToGrid(doc(), defs(), ids) : action.startsWith("distribute")
      ? distribute(doc(), defs(), ids, action === "distribute-h" ? "x" : "y") : align(doc(), defs(), ids, action.slice(6)));
  }

  return {begin, draw, align, distribute, alignToGrid, array, applyPlan, command, itemBox, style: STYLE};
})();
