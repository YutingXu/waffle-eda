"use strict";
// Board shape: an exact board outline made of lines and arcs, with cutouts.
//
// doc.outline stays the flattened outer polygon so every existing consumer
// keeps working. doc.boardShape (optional) carries the exact geometry:
//   {version:1, contour:[seg...], cutouts:[[seg...]...], source, sig}
//   seg = {kind:"line", a:[x,y], b:[x,y]}
//       | {kind:"arc", c:[x,y], r, start, end, ccw}
// Coordinates are model millimetres (Y down). Arc angles are degrees measured
// counter-clockwise as seen on screen (Altium's convention), so a point on an
// arc is [cx + r cos a, cy - r sin a]; ccw means the angle increases from start
// to end. start === end is a full circle. `sig` fingerprints the doc.outline
// the shape was flattened to; when another tool rewrites doc.outline the
// stored shape is stale and the renderer falls back to the polygon.
// Shape construction and editing extend this API on demand (board-shape.js).
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("./resolved-geometry-curves.js");
globalThis.AtriumBoardShape = (() => {
  const D2R = Math.PI / 180, TOL = 0.005, CHAIN_TOL = 0.01;
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const P = p => [r6(p[0]), r6(p[1])];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const n360 = a => ((a % 360) + 360) % 360;
  const fin = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e8;
  const pt = p => Array.isArray(p) && p.length === 2 && fin(p[0]) && fin(p[1]);

  // ---------------------------------------------------------------------------
  // Segments
  const at = (c, r, a) => [c[0] + r * Math.cos(a * D2R), c[1] - r * Math.sin(a * D2R)];
  const angleOf = (c, p) => Math.atan2(c[1] - p[1], p[0] - c[0]) / D2R;
  function sweep(s) {
    if (s.kind !== "arc") return 0;
    const d = s.ccw ? n360(s.end - s.start) : -n360(s.start - s.end);
    return d === 0 ? (s.ccw ? 360 : -360) : d;
  }
  const line = (a, b) => ({kind: "line", a: P(a), b: P(b)});
  const arc = (c, r, start, end, ccw) => ({kind: "arc", c: P(c), r: r6(r), start: +(+start).toFixed(9), end: +(+end).toFixed(9), ccw: !!ccw});
  function ends(s) { return s.kind === "arc" ? [at(s.c, s.r, s.start), at(s.c, s.r, s.end)] : [s.a, s.b]; }
  const head = s => s.kind === "arc" ? at(s.c, s.r, s.start) : s.a;
  const tail = s => s.kind === "arc" ? at(s.c, s.r, s.end) : s.b;
  const reverse = s => s.kind === "arc" ? {kind: "arc", c: s.c, r: s.r, start: s.end, end: s.start, ccw: !s.ccw} : {kind: "line", a: s.b, b: s.a};
  const segLength = s => s.kind === "arc" ? s.r * Math.abs(sweep(s)) * D2R : dist(s.a, s.b);
  // Is a screen angle inside the arc's sweep (inclusive)?
  function within(s, a) {
    const w = Math.abs(sweep(s));
    return (s.ccw ? n360(a - s.start) : n360(s.start - a)) <= w + 1e-9;
  }
  // Split an arc at the given screen angles that lie strictly inside it.
  function splitArc(s, angles) {
    const w = sweep(s), sign = Math.sign(w), cuts = [];
    for (const a of angles) {
      const t = s.ccw ? n360(a - s.start) : n360(s.start - a);
      if (t > 1e-9 && t < Math.abs(w) - 1e-9) cuts.push(t);
    }
    cuts.sort((x, y) => x - y);
    const out = []; let from = 0;
    for (const t of [...cuts, Math.abs(w)]) { out.push({kind: "arc", c: s.c, r: s.r, start: s.start + sign * from, end: s.start + sign * t, ccw: s.ccw}); from = t; }
    return out;
  }
  function arcPoints(s, tol = TOL) {
    return AtriumGeometryCurves.flatten([AtriumGeometryCurves.arcEdge(s, sweep(s))], tol).map(P);
  }

  // ---------------------------------------------------------------------------
  // Contours
  function flattenContour(contour, tol = TOL) {
    const out = [];
    const push = p => { const l = out[out.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); };
    for (const s of contour) {
      if (s.kind === "arc") { const q = arcPoints(s, tol); for (let i = 0; i < q.length - 1; i++) push(q[i]); }
      else push(P(s.a));
    }
    if (out.length > 1 && out[0][0] === out.at(-1)[0] && out[0][1] === out.at(-1)[1]) out.pop();
    return out;
  }
  function flatten(shape, tol = TOL) {
    return {outline: flattenContour(shape.contour, tol), cutouts: (shape.cutouts || []).map(c => flattenContour(c, tol))};
  }
  // Signed area in model axes (Green's theorem, exact for arcs). Positive is
  // clockwise on screen because the model is Y down.
  function signedArea(contour) {
    let s = 0;
    for (const g of contour) {
      if (g.kind === "arc") {
        const p0 = -g.start * D2R, p1 = p0 - sweep(g) * D2R, [cx, cy] = g.c, r = g.r;
        s += cx * r * (Math.sin(p1) - Math.sin(p0)) - cy * r * (Math.cos(p1) - Math.cos(p0)) + r * r * (p1 - p0);
      } else s += g.a[0] * g.b[1] - g.b[0] * g.a[1];
    }
    return s / 2;
  }
  function polyArea(points) {
    let s = 0;
    for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }
  const contourLength = c => c.reduce((s, g) => s + segLength(g), 0);
  function contourBounds(contour, b = [Infinity, Infinity, -Infinity, -Infinity]) {
    const add = p => { if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1]; if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1]; };
    for (const g of contour) {
      for (const p of ends(g)) add(p);
      if (g.kind === "arc") for (const a of [0, 90, 180, 270]) if (within(g, a)) add(at(g.c, g.r, a));
    }
    return b;
  }
  // Ray casting toward +X; arcs are split into pieces monotone in Y.
  function crossings(contour, p) {
    let odd = false;
    const [px, py] = p;
    for (const g of contour) {
      if (g.kind !== "arc") {
        const a = g.a, b = g.b;
        if ((a[1] > py) !== (b[1] > py) && px < (b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]) odd = !odd;
        continue;
      }
      for (const q of splitArc(g, [90, 270])) {
        const a = at(q.c, q.r, q.start), b = at(q.c, q.r, q.end);
        if ((a[1] > py) === (b[1] > py)) continue;
        const dy = py - q.c[1], dx = Math.sqrt(Math.max(0, q.r * q.r - dy * dy));
        const mid = q.start + sweep(q) / 2, x = q.c[0] + (Math.cos(mid * D2R) >= 0 ? dx : -dx);
        if (px < x) odd = !odd;
      }
    }
    return odd;
  }
  function polyContains(points, p) {
    let odd = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) odd = !odd;
    }
    return odd;
  }
  const area = shape => Math.abs(signedArea(shape.contour)) - (shape.cutouts || []).reduce((s, c) => s + Math.abs(signedArea(c)), 0);
  const perimeter = (shape, withCutouts = false) => withCutouts
    ? profileContours(shape).reduce((sum, contour) => sum + contourLength(contour), 0) : contourLength(shape.contour);
  function bounds(shape) { const b = contourBounds(shape.contour); return b[0] === Infinity ? null : b; }
  const contains = (shape, p) => crossings(shape.contour, p) && !(shape.cutouts || []).some(c => crossings(c, p));
  // Outer contour counter-clockwise on screen, cutouts clockwise.
  function orient(contour, ccw) {
    const isCcw = signedArea(contour) < 0;
    return isCcw === ccw ? contour : contour.slice().reverse().map(reverse);
  }
  // Region contours move with a footprint. In Y-up arc angles a clockwise screen
  // rotation subtracts its angle; mirroring the local X also reverses winding.
  function placeContour(contour, place, rotation = 0, mirror = false) {
    const angle = v => (mirror ? 180 - v : v) - rotation;
    return contour.map(g => g.kind === "line" ? {kind:"line", a:place(g.a), b:place(g.b)}
      : {...g, c:place(g.c), start:angle(g.start), end:angle(g.end), ccw:mirror ? !g.ccw : g.ccw});
  }
  function regionOf(item) {
    return item?.regionShape ? fresh({boardShape:item.regionShape, outline:item.points}) : null;
  }
  // The cut-in representing a nested void is useful for containment, while machining
  // and interchange need its separate closed paths. Editing a contour retires its copy.
  function cutoutRegion(shape, index) {
    const c = shape.cutouts?.[index], r = shape.cutoutRegions?.[index];
    return c && r && r.sig === signature(flattenContour(c)) ? r : null;
  }
  // Physical voids with their material islands, in the stored cutout order.
  function* profileCutouts(shape) {
    for (const [index, contour] of (shape.cutouts || []).entries()) {
      const region = cutoutRegion(shape, index);
      yield region?.cutouts ? region : {contour: region?.contour || contour, cutouts: []};
    }
  }
  function profileContours(shape) {
    if (!shape.cutoutRegions) return [shape.contour, ...(shape.cutouts || [])];
    const contours = [shape.contour];
    for (const r of profileCutouts(shape)) contours.push(r.contour, ...r.cutouts);
    return contours;
  }
  // Preserve the saved polygon on older generic imports unless exact output is requested.
  function screenProfile(doc, precise) {
    const shape = fresh(doc);
    return shape && (precise || shape.source !== "import" || doc.sourceArcVersion === 1) ? shape : null;
  }
  function mapCutoutRegions(shape, target, map) {
    if (!shape.cutoutRegions) return target;
    const extra = {};
    for (const index of Object.keys(shape.cutoutRegions)) {
      const r = cutoutRegion(shape,index);
      if (r && target.cutouts[index]) extra[index] = {version:1,contour:map(r.contour),cutouts:r.cutouts.map(map),sig:signature(flattenContour(target.cutouts[index]))};
    }
    if (Object.keys(extra).length) target.cutoutRegions = extra;
    else delete target.cutoutRegions;
    return target;
  }
  function translate(shape, dx, dy) {
    const m = p => P([p[0] + dx, p[1] + dy]);
    const move = c => c.map(g => g.kind === "arc" ? {...g, c: m(g.c)} : {kind: "line", a: m(g.a), b: m(g.b)});
    return mapCutoutRegions(shape,{...shape,contour:move(shape.contour),cutouts:(shape.cutouts||[]).map(move)},move);
  }

  // ---------------------------------------------------------------------------
  // Validation, signature and doc integration
  function validSeg(g) {
    if (!g || typeof g !== "object") return false;
    if (g.kind === "line") return pt(g.a) && pt(g.b);
    return g.kind === "arc" && pt(g.c) && fin(g.r) && g.r > 0 && fin(g.start) && fin(g.end) && typeof g.ccw === "boolean";
  }
  function validate(shape) {
    const bad = m => { throw Error("Invalid board shape: " + m + "."); };
    if (!shape || typeof shape !== "object" || shape.version !== 1) bad("version");
    if (!Array.isArray(shape.contour) || !shape.contour.length || shape.contour.length > 1e6 || !shape.contour.every(validSeg)) bad("contour");
    if (shape.cutouts != null && (!Array.isArray(shape.cutouts) || !shape.cutouts.every(c => Array.isArray(c) && c.length && c.every(validSeg)))) bad("cutouts");
    if (shape.cutoutRegions != null) {
      if (typeof shape.cutoutRegions !== "object" || Array.isArray(shape.cutoutRegions)) bad("cutout regions");
      for (const [k,r] of Object.entries(shape.cutoutRegions)) {
        if (!/^(0|[1-9]\d*)$/.test(k) || !shape.cutouts?.[+k] || !r || r.cutoutRegions != null) bad("cutout region index");
        validate(r);
      }
    }
    if (shape.source != null && typeof shape.source !== "string") bad("source");
    if (shape.sig != null && typeof shape.sig !== "string") bad("signature");
    return shape;
  }
  function signature(points) {
    let h = 0x811c9dc5;
    for (const p of points || []) for (const v of p) { h ^= Math.round(v * 1e4) | 0; h = Math.imul(h, 16777619); }
    return (points?.length || 0) + ":" + (h >>> 0).toString(16);
  }
  const sigCache = new WeakMap();
  function sigOf(points) { let s = sigCache.get(points); if (s == null) { s = signature(points); sigCache.set(points, s); } return s; }
  // A stored shape is current when doc.outline is its flattening. Shapes
  // stored by apply() carry the outline's signature. Importers that cannot
  // load this module (the import worker) store the shape without one; it is
  // then checked geometrically: area and extents within the chord tolerance.
  const freshCache = new WeakMap();
  function fresh(doc) {
    const s = doc?.boardShape;
    if (!s || !Array.isArray(doc.outline) || doc.outline.length < 3) return null;
    const hit = freshCache.get(s);
    if (hit && hit.outline === doc.outline) return hit.ok ? s : null;
    let ok = false;
    try {
      validate(s);
      if (s.sig != null) ok = s.sig === sigOf(doc.outline);
      else {
        const slack = TOL * 1.05 + 1e-6, b = contourBounds(s.contour), q = boundsOf(doc.outline);
        ok = b.every((v, i) => Math.abs(v - q[i]) <= slack) && Math.abs(Math.abs(polyArea(doc.outline)) - Math.abs(signedArea(s.contour))) <= contourLength(s.contour) * slack;
      }
    } catch { ok = false; }
    freshCache.set(s, {outline: doc.outline, ok});
    return ok ? s : null;
  }
  const holeCache = new WeakMap();
  // Flattened cutouts for canvas, DRC and pours ([] when none or stale).
  function holes(doc) {
    const s = fresh(doc);
    if (!s || !s.cutouts?.length) return [];
    let h = holeCache.get(s);
    if (!h) { h = s.cutouts.map(c => flattenContour(c)); holeCache.set(s, h); }
    return h;
  }
  // Board cutouts as obstacles: a point inside one, and the pieces of a segment outside all of them.
  function inCutout(doc, p) { return holes(doc).some(h => polyContains(h, p)); }
  function clipOutsideCutouts(doc, a, b) {
    const hs = holes(doc);
    if (!hs.length) return [[a, b]];
    const ts = [0, 1], dx = b[0] - a[0], dy = b[1] - a[1], out = [];
    for (const h of hs) for (let i = 0; i < h.length; i++) {
      const p = h[i], q = h[(i + 1) % h.length], ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den, u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    const at = t => [a[0] + dx * t, a[1] + dy * t];
    for (let k = 1; k < ts.length; k++) {
      if (ts[k] - ts[k - 1] < 1e-9 || hs.some(h => polyContains(h, at((ts[k] + ts[k - 1]) / 2)))) continue;
      const last = out[out.length - 1], s = at(ts[k - 1]), e = at(ts[k]);
      if (last && dist(last[1], s) < 1e-9) last[1] = e; else out.push([s, e]);
    }
    return out;
  }
  // A polyline's runs outside every cutout (one run, unchanged, when it crosses none).
  function clipPolyline(doc, line) {
    const runs = [];
    for (let k = 1; k < line.length; k++) for (const [s, e] of clipOutsideCutouts(doc, line[k - 1], line[k])) {
      const run = runs[runs.length - 1];
      if (run && dist(run[run.length - 1], s) < 1e-9) run.push(e); else runs.push([s, e]);
    }
    return runs;
  }
  function boundsOf(points) {
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of points) { if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1]; if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1]; }
    return b;
  }

  // ---------------------------------------------------------------------------
  // Board origin (Altium Edit > Origin > Set). doc.origin = [x, y] in model mm.
  // Displayed coordinates are relative to it with Y up, matching Altium and
  // the fabrication outputs; without an origin, display is unchanged.
  const toUser = (doc, p) => doc?.origin ? [r6(p[0] - doc.origin[0]), r6(doc.origin[1] - p[1])] : p;
  const fromUser = (doc, u) => doc?.origin ? [r6(u[0] + doc.origin[0]), r6(doc.origin[1] - u[1])] : u;

  // ---------------------------------------------------------------------------
  // Append one connected contour in Canvas's Y-down coordinate system.
  function traceContour(ctx, contour, closed = false) {
    if (!contour.length) return;
    ctx.moveTo(...head(contour[0]));
    for (const g of contour) {
      if (g.kind === "arc") ctx.arc(g.c[0], g.c[1], g.r, -g.start * D2R, -(g.start + sweep(g)) * D2R, g.ccw);
      else ctx.lineTo(...g.b);
    }
    if (closed) ctx.closePath();
  }

  // ---------------------------------------------------------------------------
  // User interface: board-shape-ui.js (AtriumBoardShapeUI) loads on first use through lazy.js.
  const UI = () => globalThis.AtriumLazy?.pending?.("AtriumBoardShapeUI") ? null : globalThis.AtriumBoardShapeUI;
  function open(ctx, opts = {}) {
    const ui = UI();
    if (ui) return ui.open(ctx, opts);
    if (!globalThis.AtriumLazy) throw Error("The board shape dialog is unavailable in this build.");
    return AtriumLazy.need("AtriumBoardShapeUI").then(U => U.open(ctx, opts), e => { ctx.info?.(e.message); });
  }
  // The inspector section: drawn once the interface has loaded, unless the panel was rebuilt.
  function properties(host, ctx, opt = {}) {
    const ui = UI();
    if (ui) return ui.properties(host, ctx, opt);
    host.replaceChildren();
    globalThis.AtriumLazy?.need("AtriumBoardShapeUI").then(U => { if (host.isConnected !== false) U.properties(host, ctx, opt); }, e => { ctx.info?.(e.message); });
  }

  return {
    TOL, CHAIN_TOL, roundPoint:P, roundScalar:r6, validSegment:validSeg, validPoint:pt, boundsOf, mapCutoutRegions,
    line, arc, ends, head, tail, reverse, sweep, segLength, arcPoints, splitArc, within, angleOf, pointAt:at,
    flatten, flattenContour, signedArea, polyArea, contourLength, contourBounds, area, perimeter, bounds, contains, crossings, polyContains,
    orient, translate, validate, signature, fresh, placeContour, regionOf, cutoutRegion, profileCutouts, profileContours, screenProfile, holes, inCutout, clipOutsideCutouts, clipPolyline,
    toUser, fromUser, traceContour, open, properties
  };
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumBoardShape;
