"use strict";
// Render stage: what the editor draws is the copper. Waffle's own 2D board renderer (app/canvas/canvas.js,
// the code path the editor paints with) draws one copper layer at a time into a recording 2D
// context. Every fill and stroke in that layer's copper colour becomes a vector shape in board
// millimetres, which is rasterised on the same grid as the plots and compared with the original
// tool's Gerber for that layer. A difference here is "what you see is not the copper", which the
// output comparison cannot catch because the plotter has its own code path.
//
// Strokes one device pixel wide or less are screen hairlines (outlines, boundaries), not copper.
// Text is not rasterised; copper text is rare and the plots cover it.

const ARC_STEPS = 48;

function recorder(keep) {
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [], shapes = [];
  let path = [], sub = null;
  const state = {fillStyle:"#000", strokeStyle:"#000", lineWidth:1, globalAlpha:1, lineCap:"butt", lineJoin:"miter", font:"10px sans-serif",
    globalCompositeOperation:"source-over", textAlign:"start", textBaseline:"alphabetic", miterLimit:10, lineDashOffset:0, filter:"none",
    imageSmoothingEnabled:true, shadowBlur:0, shadowColor:"transparent", shadowOffsetX:0, shadowOffsetY:0};
  const apply = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const point = (x, y) => { if (!sub) { sub = []; path.push(sub); } sub.push(apply(x, y)); };
  function arc(x, y, r, a0, a1, ccw) {
    let sweep = a1 - a0;
    if (!ccw && sweep < 0) sweep = sweep % (2 * Math.PI) + 2 * Math.PI;
    if (ccw && sweep > 0) sweep = sweep % (2 * Math.PI) - 2 * Math.PI;
    if (Math.abs(a1 - a0) >= 2 * Math.PI) sweep = ccw ? -2 * Math.PI : 2 * Math.PI;
    const n = Math.max(2, Math.ceil(ARC_STEPS * Math.abs(sweep) / (2 * Math.PI)));
    for (let k = 0; k <= n; k++) { const t = a0 + sweep * k / n; point(x + r * Math.cos(t), y + r * Math.sin(t)); }
  }
  const scaleOf = () => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const ctx = {
    shapes, colours:new Map(),
    save() { stack.push({m, s:{...state}}); },
    restore() { const top = stack.pop(); if (top) { m = top.m; Object.assign(state, top.s); } },
    setTransform(a, b, c, d, e, f) { m = typeof a === "object" ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b, c, d, e, f]; },
    resetTransform() { m = [1, 0, 0, 1, 0, 0]; },
    getTransform() { return {a:m[0], b:m[1], c:m[2], d:m[3], e:m[4], f:m[5]}; },
    transform(a, b, c, d, e, f) { m = mul(m, [a, b, c, d, e, f]); },
    translate(x, y) { m = mul(m, [1, 0, 0, 1, x, y]); },
    scale(x, y) { m = mul(m, [x, 0, 0, y, 0, 0]); },
    rotate(t) { const c = Math.cos(t), s = Math.sin(t); m = mul(m, [c, s, -s, c, 0, 0]); },
    beginPath() { path = []; sub = null; },
    moveTo(x, y) { sub = null; point(x, y); },
    lineTo(x, y) { point(x, y); },
    closePath() { if (sub?.length) { sub.closed = true; const first = sub[0]; sub = [first]; path.push(sub); } },
    rect(x, y, w, h) { sub = null; point(x, y); point(x + w, y); point(x + w, y + h); point(x, y + h); sub.closed = true; sub = null; },
    roundRect(x, y, w, h, r = 0) {
      const q = Math.min(Math.abs(Array.isArray(r) ? r[0] ?? 0 : r), Math.abs(w) / 2, Math.abs(h) / 2);
      sub = null;
      arc(x + w - q, y + q, q, -Math.PI / 2, 0); arc(x + w - q, y + h - q, q, 0, Math.PI / 2);
      arc(x + q, y + h - q, q, Math.PI / 2, Math.PI); arc(x + q, y + q, q, Math.PI, 1.5 * Math.PI);
      sub.closed = true; sub = null;
    },
    arc,
    ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
      this.save(); this.translate(x, y); this.rotate(rot); this.scale(rx || 1e-9, ry || 1e-9); arc(0, 0, 1, a0, a1, ccw); this.restore();
    },
    arcTo(x1, y1, x2, y2) { point(x1, y1); point(x2, y2); },
    bezierCurveTo(a, b, c, d, x, y) {
      const p0 = sub?.at(-1); if (!p0) { point(x, y); return; }
      const inv = invert(m), s0 = [inv[0] * p0[0] + inv[2] * p0[1] + inv[4], inv[1] * p0[0] + inv[3] * p0[1] + inv[5]];
      for (let k = 1; k <= 12; k++) { const t = k / 12, u = 1 - t;
        point(u * u * u * s0[0] + 3 * u * u * t * a + 3 * u * t * t * c + t * t * t * x, u * u * u * s0[1] + 3 * u * u * t * b + 3 * u * t * t * d + t * t * t * y); }
    },
    quadraticCurveTo(a, b, x, y) { point(a, b); point(x, y); },
    fill(a) {
      if (a && typeof a === "object") return withPath(a, () => ctx.fill());
      const style = String(state.fillStyle);
      ctx.colours.set("fill " + style, (ctx.colours.get("fill " + style) || 0) + 1);
      if (!keep(style, state.globalAlpha)) return;
      const rings = path.filter(r => r.length >= 3).map(r => r.slice());
      if (rings.length) shapes.push({k:"poly", dark:true, rings});
    },
    stroke(a) {
      if (a && typeof a === "object") return withPath(a, () => ctx.stroke());
      const style = String(state.strokeStyle), width = state.lineWidth * scaleOf();
      ctx.colours.set("stroke " + style, (ctx.colours.get("stroke " + style) || 0) + 1);
      if (!keep(style, state.globalAlpha) || width <= 1.01) return;
      for (const r of path) {
        const pts = r.closed ? [...r, r[0]] : r;
        for (let i = 0; i + 1 < pts.length; i++) shapes.push({k:"capsule", dark:true, x1:pts[i][0], y1:pts[i][1], x2:pts[i + 1][0], y2:pts[i + 1][1], r:width / 2});
        if (pts.length === 1) shapes.push({k:"circle", dark:true, x:pts[0][0], y:pts[0][1], r:width / 2});
      }
    },
    clip() {}, fillRect() {}, clearRect() {}, strokeRect() {}, fillText() {}, strokeText() {}, drawImage() {}, putImageData() {},
    setLineDash() {}, getLineDash() { return []; }, createPattern() { return null; },
    measureText(t) { return {width:String(t).length * 6, actualBoundingBoxAscent:7, actualBoundingBoxDescent:2}; },
    createLinearGradient() { return {addColorStop() {}}; }, createRadialGradient() { return {addColorStop() {}}; },
    getImageData(x, y, w, h) { return {data:new Uint8ClampedArray(4 * w * h), width:w, height:h}; },
    createImageData(w, h) { return {data:new Uint8ClampedArray(4 * w * h), width:w, height:h}; },
    isPointInPath() { return false; },
  };
  // Path2D objects: app/core/path-record.js keeps each path's commands (it wraps Path2D for printing).
  function withPath(p, use) {
    const rec = globalThis.AtriumPathRecord, ops = rec?.REC.get(p);
    if (!ops) return;
    const saved = [path, sub];
    path = []; sub = null;
    for (let i = 0; i < ops.length;) {
      const k = ops[i++], n = rec.NARGS[k], args = ops.slice(i, i + n); i += n;
      ctx[rec.NAMES[k]](...args);
    }
    use();
    [path, sub] = saved;
  }
  for (const k of Object.keys(state)) Object.defineProperty(ctx, k, {get:() => state[k], set:v => { state[k] = v; }});
  return ctx;
}
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

// Draw one copper layer of `doc` as the editor does (single-layer mode) and return its copper
// as shapes in board millimetres (Waffle's frame: Y down).
function copperShapes(doc, defs, layer, {pxPerMm = 40} = {}) {
  const PCB = AtriumPCBAppearance;
  const norm = c => String(c).trim().toLowerCase().replace(/\s+/g, "");
  // The layer's copper colour, and the Multi-Layer colour through-hole pads draw in on every copper
  // layer. Drill holes have their own system colours and are not copper in a copper film.
  // Single-layer mode draws only objects on this layer; a via spanning it paints its two halves in
  // its end layers' colours, so every copper colour drawn here is this layer's copper.
  const copperNames = ["Top", "Bottom", "Multi", ...Array.from({length:30}, (_, k) => "Inner " + (k + 1))];
  const ink = new Set(copperNames.map(n => norm(PCB.color(n))));
  for (const c of [PCB.system.hole, PCB.system.padHole, PCB.system.board, PCB.system.selection]) ink.delete(norm(c));
  const keep = (style, alpha) => ink.has(norm(style)) && alpha > 0.05;
  const ctx = recorder(keep);
  const size = 1 << 14;
  const canvas = {width:size, height:size, clientWidth:size, clientHeight:size, style:{}, dataset:{},
    getContext:() => ctx, getBoundingClientRect:() => ({left:0, top:0, width:size, height:size, right:size, bottom:size}),
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {}, parentElement:null, ownerDocument:null};
  const view = AtriumCanvas.create(canvas), I = view.internals();
  view.resized?.();
  I.ctx = ctx;
  const box = Atrium.docBounds(doc, defs) || [0, 0, 100, 100];
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const opts = {layerMode:"single", layer, hidden:new Set(), showUnrouted:false, netColors:null, lodForce:false};
  I.lodForce = false;
  I.withCamera(cx, cy, pxPerMm, () => I.paint(doc, defs, opts, null, true));
  // Device pixels back to board millimetres through the camera's own mapping.
  const [ox, oy] = I.withCamera(cx, cy, pxPerMm, () => I.worldToScreen([0, 0]));
  const [ux] = I.withCamera(cx, cy, pxPerMm, () => I.worldToScreen([1, 0]));
  const [, vy] = I.withCamera(cx, cy, pxPerMm, () => I.worldToScreen([0, 1]));
  const sx = ux - ox, sy = vy - oy, dpr = I.cam()[6] || 1;
  const toMm = ([x, y]) => [(x / dpr - ox) / sx, (y / dpr - oy) / sy];
  const shapes = ctx.shapes.map(s => s.k === "poly" ? {...s, rings:s.rings.map(r => r.map(toMm))}
    : s.k === "capsule" ? (() => { const a = toMm([s.x1, s.y1]), b = toMm([s.x2, s.y2]); return {...s, x1:a[0], y1:a[1], x2:b[0], y2:b[1], r:s.r / dpr / Math.abs(sx)}; })()
    : (() => { const a = toMm([s.x, s.y]); return {...s, x:a[0], y:a[1], r:s.r / dpr / Math.abs(sx)}; })());
  return {shapes, colours:ctx.colours, ink:[...ink]};
}

// Into the plot frame of a generated Gerber: X from the export origin, Y up.
function toPlotFrame(shapes, origin) {
  const g = ([x, y]) => [x - origin[0], origin[1] - y];
  return shapes.map(s => s.k === "poly" ? {...s, rings:s.rings.map(r => r.map(g))}
    : s.k === "capsule" ? (() => { const a = g([s.x1, s.y1]), b = g([s.x2, s.y2]); return {...s, x1:a[0], y1:a[1], x2:b[0], y2:b[1]}; })()
    : (() => { const a = g([s.x, s.y]); return {...s, x:a[0], y:a[1]}; })());
}

module.exports = {recorder, copperShapes, toPlotFrame};

// XOR area (mm²) between a reference film and rendered shapes on the plot grid. Pixels inside
// drilled holes are ignored (copper there is drilled away; the canvas draws holes). A pixel only
// counts when the other image has no copper within `edgeMm` of it: the editor insets pad and
// track edges by a device pixel or two for legibility, which is display, not geometry. A stray
// 0.18 mm stroke, a wrong pad shape or a moved object is still far outside that band.
function xorWithMask(C, reference, shapes, holes, offset = [0, 0], pixelMm = 0.025, dump = null, edgeMm = 0.05) {
  const moved = shapes.map(s => s.k === "poly" ? {...s, rings:s.rings.map(r => r.map(([x, y]) => [x + offset[0], y + offset[1]]))}
    : s.k === "capsule" ? {...s, x1:s.x1 + offset[0], y1:s.y1 + offset[1], x2:s.x2 + offset[0], y2:s.y2 + offset[1]} : {...s, x:s.x + offset[0], y:s.y + offset[1]});
  const mask = holes.map(h => ({k:"circle", dark:true, x:h.x + offset[0], y:h.y + offset[1], r:h.r}));
  const grid = C.gridFor([reference.bbox, C.bboxOf(moved)].filter(Boolean), pixelMm);
  if (grid.w * grid.h > 160_000_000) throw Error("render comparison exceeds the raster budget");
  const t = Math.round(edgeMm / pixelMm), W = grid.w;
  // Square dilation by t pixels (separable maximum), over a stripe with t halo rows on each side.
  function dilate(img, h) {
    const row = new Uint8Array(img.length), out = new Uint8Array(img.length);
    for (let j = 0; j < h; j++) {
      let last = -1e9;
      for (let i = 0; i < W; i++) { if (img[j * W + i]) last = i; row[j * W + i] = i - last <= t ? 1 : 0; }
      last = 1e9;
      for (let i = W - 1; i >= 0; i--) { if (img[j * W + i]) last = i; if (last - i <= t) row[j * W + i] = 1; }
    }
    for (let i = 0; i < W; i++) {
      let last = -1e9;
      for (let j = 0; j < h; j++) { if (row[j * W + i]) last = j; out[j * W + i] = j - last <= t ? 1 : 0; }
      last = 1e9;
      for (let j = h - 1; j >= 0; j--) { if (row[j * W + i]) last = j; if (last - j <= t) out[j * W + i] = 1; }
    }
    return out;
  }
  let missing = 0, added = 0;
  const bins = new Map();  // 1 mm cells of the reference frame, for the report
  for (let row = 0; row < grid.h; row += 256) {
    const rows = Math.min(256, grid.h - row), top = Math.min(t, row), bottom = Math.min(t, grid.h - row - rows), h = rows + top + bottom;
    const stripe = {...grid, y0:grid.y0 + (row - top) * pixelMm, h};
    const a = C.rasterize(reference.shapes, stripe), b = C.rasterize(moved, stripe), m = C.rasterize(mask, stripe);
    const da = t ? dilate(a, h) : a, db = t ? dilate(b, h) : b;
    if (dump) dump({...stripe, y0:grid.y0 + row * pixelMm, h:rows}, a.subarray(top * W, (top + rows) * W), b.subarray(top * W, (top + rows) * W), m.subarray(top * W, (top + rows) * W));
    for (let k = top * W; k < (top + rows) * W; k++) {
      if (m[k] || a[k] === b[k]) continue;
      if (a[k] ? db[k] : da[k]) continue;
      if (a[k]) missing++; else added++;
      const x = Math.floor(stripe.x0 + (k % W + .5) * pixelMm), y = Math.floor(stripe.y0 + (Math.floor(k / W) + .5) * pixelMm);
      const key = (a[k] ? "missing" : "added") + " at " + x + "," + y + " mm";
      bins.set(key, (bins.get(key) || 0) + 1);
    }
  }
  const area = n => Math.round(n * pixelMm * pixelMm * 1e6) / 1e6;
  const worst = [...bins].sort((p, q) => q[1] - p[1]).slice(0, 6).map(([k, n]) => k + " (" + area(n) + " mm²)");
  return {xorMm2:area(missing + added), missingMm2:area(missing), addedMm2:area(added), edgeToleranceMm:edgeMm, worst};
}
module.exports.xorWithMask = xorWithMask;
