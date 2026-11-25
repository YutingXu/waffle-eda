"use strict";

if (!globalThis.AtriumPCBText && typeof require === "function") require("./pcb-text.js");
if (!globalThis.AtriumResolvedLand && typeof require === "function") require("./pcb-appearance.js");
if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// PCB place and draw tools (Altium's Place menu on boards): free Pad (P P), Fill (P F),
// Solid Region (P R), Keepouts (P K T/A/F/R), Line (P L), Arcs (P A centre, P E edge,
// P N three-point), Dimensions (P D L/G/R/A), Polygon Pour by vertices (P G), polygon and
// region vertex editing on the canvas, board outline vertex editing (D S E) and Measure
// Primitives / Measure Selected (Ctrl+Shift+M). Units are mm, Y down.
//
// The first half is DOM-free: item builders (plans), arc and dimension geometry, edge-to-edge
// measurement, keep-out violations and vertex edit operations. MCP, extensions and tests
// use these directly. install(host) wires the tools into the editor through AtriumNavHost.
//
// Object model (no new item kinds; every consumer already reads these):
//   pad       {kind:"pad", x, y, w, h, shape, layer, drill, plated, net, angle, number}
//   fill      {kind:"graphic", layer, points:rect, fill:true, closed:true, width:0, net, fillRect:true}
//   region    {kind:"graphic", layer, points, fill:true, closed:true, width:0, net}
//   keepout   graphic on layer "Keepout" (all layers), or on one copper layer with keepout:true
//   line/arc  {kind:"graphic", layer, points, width}; arc holds exact circular geometry in Board Shape coordinates
//   dimension {kind:"graphic", layer, points:[defining points], width, dimension:{type, ...}}
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("./resolved-geometry-curves.js");
globalThis.AtriumPCBDraw = (() => {
  const A = () => globalThis.Atrium;
  const D2R = Math.PI / 180, EPS = 1e-9;
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const P = p => [r6(p[0]), r6(p[1])];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const mod = (x, m) => ((x % m) + m) % m;
  const angleOf = (c, p) => Math.atan2(p[1] - c[1], p[0] - c[0]) / D2R;
  const unit = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const newId = () => A()?.id?.() || "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const COPPER = /^(Top|Bottom|Inner \d+)$/;
  const isCopper = l => COPPER.test(l || "");
  const KEEPOUT = "Keepout";

  // ------------------------------------------------------------------ arcs
  // Model angles in degrees, Y down: a positive sweep turns clockwise on screen.
  function projectedArc(center, r, start, sweep, options = {}) {
    const step = options.step || 5;
    if (!r) return Array.from({length: 1 + Math.max(2, Math.ceil(Math.abs(sweep) / step))}, () => P(center));
    const edge = {kind: "arc", center, radius: Math.abs(r), start: -start + (r < 0 ? 180 : 0), sweep: -sweep};
    const points = AtriumGeometryCurves.project([edge], .005, {minSegments: 2, minStep: step, maxStep: step});
    if (points.length === 1) points.push(points[0], points[0]);
    return points.map(P);
  }
  // Altium "Arc (Center)": centre, start (radius), end; counter-clockwise on screen unless cw.
  function arcFromCenter(c, s, e, cw = false) {
    const r = dist(c, s), a1 = angleOf(c, s), a2 = angleOf(c, e);
    let sweep = cw ? mod(a2 - a1, 360) : -mod(a1 - a2, 360);
    if (Math.abs(sweep) < EPS) sweep = cw ? 360 : -360;
    return {c: P(c), r, start: a1, sweep};
  }
  // Altium "Arc (Edge)": a quarter arc between two points; flip picks the other side.
  function arcFromEdge(a, b, flip = false) {
    const chord = dist(a, b); if (chord < EPS) return null;
    const u = unit([b[0] - a[0], b[1] - a[1]]), n = flip ? [-u[1], u[0]] : [u[1], -u[0]], m = mid(a, b);
    const c = [m[0] + n[0] * chord / 2, m[1] + n[1] * chord / 2], start = angleOf(c, a);
    return {c: P(c), r: chord / Math.SQRT2, start, sweep: mod(angleOf(c, b) - start + 180, 360) - 180};
  }
  function circumcenter(a, b, c) {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const A2 = a[0] ** 2 + a[1] ** 2, B2 = b[0] ** 2 + b[1] ** 2, C2 = c[0] ** 2 + c[1] ** 2;
    return [(A2 * (b[1] - c[1]) + B2 * (c[1] - a[1]) + C2 * (a[1] - b[1])) / d, (A2 * (c[0] - b[0]) + B2 * (a[0] - c[0]) + C2 * (b[0] - a[0])) / d];
  }
  // Arc from a through m to b.
  function arcThrough(a, m, b) {
    const c = circumcenter(a, m, b); if (!c) return null;
    const start = angleOf(c, a), s1 = mod(angleOf(c, b) - start, 360), sm = mod(angleOf(c, m) - start, 360);
    return {c: P(c), r: dist(c, a), start, sweep: sm < s1 ? s1 : s1 - 360};
  }
  // Circle fitted to a tessellated arc (null when the points are not on one circle).
  function arcFit(points, tol = 0.002) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const n = points.length, closed = n >= 4 && dist(points[0], points.at(-1)) < EPS;
    // A full circle starts and ends on the same point: fit through thirds instead.
    const s = closed ? arcThrough(points[0], points[Math.floor(n / 3)], points[Math.floor(2 * n / 3)]) : arcThrough(points[0], points[Math.floor(n / 2)], points.at(-1));
    if (!s || !(s.r > 0)) return null;
    for (const p of points) if (Math.abs(dist(p, s.c) - s.r) > Math.max(tol, s.r * 1e-3)) return null;
    if (closed) { const t = mod(angleOf(s.c, points[1]) - s.start + 180, 360) - 180; s.sweep = t < 0 ? -360 : 360; }
    return s;
  }
  // Altium angles (counter-clockwise, Y up) for an arc spec, and back.
  function altiumAngles(s) {
    const a = mod(-s.start, 360), b = mod(-(s.start + s.sweep), 360);
    return s.sweep <= 0 ? {start: a, end: b} : {start: b, end: a};
  }
  function fromAltium(c, r, start, end) {
    let sweep = -mod(end - start, 360); if (Math.abs(sweep) < EPS) sweep = -360;
    return {c, r, start: -start, sweep};
  }

  // ------------------------------------------------------------------ item builders (plans)
  const rectPoints = (a, b) => { const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(P); };
  const SHAPES = ["round", "rect", "oval", "roundrect", "octagon"];
  function padItem(at, o = {}) {
    const drill = Math.max(0, +o.drill || 0), w = +o.w > 0 ? +o.w : 1.5, h = +o.h > 0 ? +o.h : w;
    let layer = o.layer || (drill > 0 ? "Multi" : "Top");
    if (drill <= 0 && layer === "Multi") layer = "Top";
    if (drill > 0) layer = "Multi";
    const it = {id: o.id || newId(), kind: "pad", x: r6(at[0]), y: r6(at[1]), w, h, shape: SHAPES.includes(o.shape) ? o.shape : "round", layer, net: o.net || ""};
    if (it.shape === "roundrect" && o.roundrectRadiusRatio != null) it.roundrectRadiusRatio = A().padCornerRatio(o);
    if (drill > 0) { it.drill = Math.min(drill, Math.min(w, h)); if (o.plated === false) it.plated = false; }
    if (o.angle) it.angle = mod(+o.angle, 360);
    if (o.number != null && o.number !== "") it.number = String(o.number);
    return it;
  }
  function shapeItem(points, o, extra) {
    const it = {id: o.id || newId(), kind: "graphic", layer: o.layer || "Top", points: points.map(P), ...extra};
    if (o.net && isCopper(it.layer)) it.net = o.net;
    return it;
  }
  const fillItem = (a, b, o = {}) => shapeItem(rectPoints(a, b), o, {fill: true, closed: true, width: 0, fillRect: true});
  function regionItem(points, o = {}) {
    if (!Array.isArray(points) || points.length < 3) throw Error("A region needs at least three vertices.");
    return shapeItem(points, o, {fill: true, closed: true, width: 0});
  }
  function lineItem(points, o = {}) {
    if (!Array.isArray(points) || points.length < 2) throw Error("A line needs two points.");
    return shapeItem(points, o, {width: o.width ?? .2});
  }
  function nativeArc(spec) {
    return spec && {kind:"arc", c:[...spec.c], r:spec.r, start:-spec.start, end:-(spec.start + spec.sweep), ccw:spec.sweep < 0};
  }
  function arcItem(spec, o = {}) {
    if (!spec || !(spec.r > 0)) throw Error("An arc needs a radius.");
    const arc = nativeArc(spec);
    return shapeItem(A().arcProjection(arc, 5), o, {width:o.width ?? .2, arc});
  }
  // Keep-out: o.layer "Keepout" (or "all") = every layer; a copper layer = that layer only.
  function keepoutItem(shape, o = {}) {
    const all = !o.layer || o.layer === "all" || o.layer === KEEPOUT, layer = all ? KEEPOUT : o.layer;
    if (!all && !isCopper(layer)) throw Error("A keep-out goes on all layers or on one copper layer.");
    const base = {id: o.id, layer};
    let it;
    switch (shape.type) {
      case "track": it = lineItem(shape.points, {...base, width: o.width ?? .25}); break;
      case "arc": it = arcItem(shape.arc, {...base, width: o.width ?? .25}); break;
      case "fill": it = fillItem(shape.a, shape.b, base); delete it.fillRect; it.fillRect = true; break;
      case "region": it = regionItem(shape.points, base); break;
      default: throw Error("Unknown keep-out shape " + shape.type + ".");
    }
    delete it.net;
    if (!all) it.keepout = true;
    return it;
  }
  const isKeepout = i => !!i && (i.keepout === true || i.layer === KEEPOUT || /^keep-?out/i.test(i.layer || "")) && i.kind !== "part";
  const keepoutLayers = i => i.keepout === true && isCopper(i.layer) ? [i.layer] : "all";

  // ------------------------------------------------------------------ dimensions
  const DIM_TYPES = ["linear", "aligned", "radial", "angular"];
  function dimensionItem(type, points, o = {}) {
    if (!DIM_TYPES.includes(type)) throw Error("Unknown dimension type " + type + ".");
    const need = type === "angular" ? 3 : 2;
    if (!Array.isArray(points) || points.length < need) throw Error("A " + type + " dimension needs " + need + " points.");
    const dim = {type, textHeight: o.textHeight ?? 1, units: o.units || "auto", export: o.export !== false};
    if (o.precision != null) dim.precision = o.precision;
    if (type === "linear") { dim.dir = o.dir === "v" ? "v" : "h"; dim.offset = +o.offset || 0; }
    if (type === "aligned") dim.offset = +o.offset || 0;
    if (type === "angular") { dim.radius = +o.radius > 0 ? +o.radius : dist(points[0], points[1]) * .6; if (o.reflex) dim.reflex = true; }
    if (o.refs?.some(Boolean)) dim.refs = o.refs.slice(0, points.length).map(r => r || null);
    if (o.circle) dim.circle = {id: o.circle.id || o.circle};
    if (dim.refs || dim.circle) dim.anchor = points.slice(0, type === "angular" ? 3 : 2).map(P);
    return {id: o.id || newId(), kind: "graphic", layer: o.layer || "Mechanical 2", width: o.width ?? .1, points: points.slice(0, type === "angular" ? 3 : 2).map(P), dimension: dim};
  }
  // Offset that puts a linear or aligned dimension line through `at`.
  function dimensionOffset(type, points, at, dir) {
    const [a, b] = points;
    if (type === "linear") return dir === "v" ? at[0] - a[0] : at[1] - a[1];
    const n = normalOf(a, b);
    return (at[0] - a[0]) * n[0] + (at[1] - a[1]) * n[1];
  }
  const normalOf = (a, b) => { const u = unit([b[0] - a[0], b[1] - a[1]]); return [u[1], -u[0]]; };
  // Linear dimension orientation from the placement point (Altium picks the axis the cursor leaves).
  function linearDir(a, b, at) {
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const out = [at[0] < x0 ? x0 - at[0] : at[0] > x1 ? at[0] - x1 : 0, at[1] < y0 ? y0 - at[1] : at[1] > y1 ? at[1] - y1 : 0];
    return out[0] > out[1] ? "v" : "h";
  }
  const UNIT_MM = {mm: 1, mil: .0254, in: 25.4};
  function formatValue(mm, dim, units) {
    const u = dim.units && dim.units !== "auto" ? dim.units : units === "mil" ? "mil" : "mm";
    const digits = dim.precision ?? (u === "mil" ? 1 : u === "in" ? 3 : 2);
    return (mm / UNIT_MM[u]).toFixed(digits) + u;
  }
  function arrow(tip, dir, size) {
    const u = unit(dir), w = size * .3, back = [tip[0] - u[0] * size, tip[1] - u[1] * size];
    return [P(tip), P([back[0] + u[1] * w, back[1] - u[0] * w]), P([back[0] - u[1] * w, back[1] + u[0] * w])];
  }
  // Extension line from p to the dimension line point q, with a small gap and overshoot.
  function extension(p, q, gap, over) {
    const d = dist(p, q); if (d < EPS) return null;
    const u = unit([q[0] - p[0], q[1] - p[1]]);
    return [P([p[0] + u[0] * Math.min(gap, d), p[1] + u[1] * Math.min(gap, d)]), P([q[0] + u[0] * over, q[1] + u[1] * over])];
  }
  const readable = deg => { let a = mod(deg + 180, 360) - 180; if (a > 90) a -= 180; if (a <= -90) a += 180; return a; };
  /**
   * Drawn geometry of a dimension: {value, label, lines:[[p…]], arrows:[[3 points]], text:{at, angle, size, label}}.
   * o.units: "mm" | "mil" for "auto" dimensions. Values are live: they come from the points.
   */
  function dimensionGeometry(item, o = {}) {
    const dim = item.dimension || {}, pts = item.points, th = dim.textHeight || 1, size = Math.max(th * .6, .3), gap = th * .25;
    const lines = [], arrows = [];
    let value = 0, label = "", text = null;
    const up = deg => { const r = deg * D2R; return [Math.sin(r), -Math.cos(r)]; };
    const along = (a, b, off) => {
      const ang = readable(angleOf(a, b)), m = mid(a, b), n = up(ang);
      text = {at: P([m[0] + n[0] * (gap + off), m[1] + n[1] * (gap + off)]), angle: ang, size: th};
      lines.push([P(a), P(b)]);
      if (dist(a, b) > 2 * size) { arrows.push(arrow(a, [a[0] - b[0], a[1] - b[1]], size), arrow(b, [b[0] - a[0], b[1] - a[1]], size)); }
      else { arrows.push(arrow(a, [b[0] - a[0], b[1] - a[1]], size), arrow(b, [a[0] - b[0], a[1] - b[1]], size)); }
    };
    if (dim.type === "linear" || dim.type === "aligned") {
      const [a, b] = pts;
      let e1, e2;
      if (dim.type === "linear") {
        if (dim.dir === "v") { const x = a[0] + (dim.offset || 0); e1 = [x, a[1]]; e2 = [x, b[1]]; value = Math.abs(b[1] - a[1]); }
        else { const y = a[1] + (dim.offset || 0); e1 = [a[0], y]; e2 = [b[0], y]; value = Math.abs(b[0] - a[0]); }
      } else {
        const n = normalOf(a, b), k = dim.offset || 0;
        e1 = [a[0] + n[0] * k, a[1] + n[1] * k]; e2 = [b[0] + n[0] * k, b[1] + n[1] * k]; value = dist(a, b);
      }
      for (const [p, q] of [[a, e1], [b, e2]]) { const l = extension(p, q, gap, size * .6); if (l) lines.push(l); }
      along(e1, e2, item.width || 0);
      label = formatValue(value, dim, o.units);
    } else if (dim.type === "radial") {
      const [c, e] = pts, r = dist(c, e);
      value = r; label = "R" + formatValue(r, dim, o.units);
      lines.push([P(c), P(e)]);
      if (r > EPS) arrows.push(arrow(e, [e[0] - c[0], e[1] - c[1]], Math.min(size, r * .5)));
      const u = unit([e[0] - c[0], e[1] - c[1]]), w = label.length * th * .7;
      const tail = [e[0] + u[0] * th * .8, e[1] + u[1] * th * .8], end = [tail[0] + (u[0] >= 0 ? w : -w), tail[1]];
      lines.push([P(e), P(tail), P(end)]);
      text = {at: P([(tail[0] + end[0]) / 2, tail[1] - gap]), angle: 0, size: th};
    } else if (dim.type === "angular") {
      const [v, p1, p2] = pts, R = dim.radius || dist(v, p1) * .6;
      const a1 = angleOf(v, p1);
      let sw = mod(angleOf(v, p2) - a1 + 180, 360) - 180;
      if (dim.reflex) sw = sw > 0 ? sw - 360 : sw + 360;
      value = Math.abs(sw); label = value.toFixed(dim.precision ?? 1) + "°";
      const arc = projectedArc(v, R, a1, sw);
      lines.push(arc);
      for (const p of [p1, p2]) {
        const u = unit([p[0] - v[0], p[1] - v[1]]), d = dist(v, p), far = [v[0] + u[0] * (R + size * .6), v[1] + u[1] * (R + size * .6)];
        if (d < R) lines.push([P(p), P(far)]);
      }
      const tan = (k, s) => { const a = (a1 + sw * k) * D2R; return [-Math.sin(a) * s, Math.cos(a) * s]; };
      const sg = Math.sign(sw) || 1;
      arrows.push(arrow(arc[0], tan(0, -sg), Math.min(size, R * .4)), arrow(arc.at(-1), tan(1, sg), Math.min(size, R * .4)));
      const am = (a1 + sw / 2) * D2R;
      text = {at: P([v[0] + Math.cos(am) * (R + th * 1.2), v[1] + Math.sin(am) * (R + th * 1.2) + th / 2]), angle: 0, size: th};
    }
    if (text) text.label = label;
    return {value, label, lines, arrows, text};
  }
  const textStrokes = t => t ? AtriumPCBText.strokeText(t.label,t.at,t.angle,t.size,"center").strokes : [];
  // Every point of the drawn dimension (bounds, spatial index, hit testing).
  function dimensionPoints(item, o) {
    const g = dimensionGeometry(item, o), out = [...item.points];
    for (const l of g.lines) out.push(...l);
    for (const a of g.arrows) out.push(...a);
    if (g.text) { const w = g.label.length * g.text.size * .7 / 2, r = g.text.angle * D2R, c = Math.cos(r), s = Math.sin(r), h = g.text.size;
      for (const [x, y] of [[-w, 0], [w, 0], [w, -h], [-w, -h]]) out.push(P([g.text.at[0] + x * c - y * s, g.text.at[1] + x * s + y * c])); }
    return out;
  }
  function dimensionHit(item, p, o) {
    const g = dimensionGeometry(item, o);
    let d = Infinity;
    for (const l of [...g.lines, ...g.arrows]) for (let k = 1; k < l.length; k++) d = Math.min(d, segPoint(p, l[k - 1], l[k]));
    if (g.text) { const w = g.label.length * g.text.size * .7 / 2, r = -g.text.angle * D2R, q = [p[0] - g.text.at[0], p[1] - g.text.at[1]];
      const x = q[0] * Math.cos(r) - q[1] * Math.sin(r), y = q[0] * Math.sin(r) + q[1] * Math.cos(r);
      if (Math.abs(x) <= w && y <= .2 * g.text.size && y >= -g.text.size * 1.1) d = 0; }
    return d - (item.width || 0) / 2;
  }
  /** Canvas painter (canvas.js calls this for graphics with a `dimension`). */
  function drawDimension(ctx, item, o = {}) {
    const g = dimensionGeometry(item, {units: o.units || displayUnits()}), scale = o.scale || 1;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = o.ink || "#ff00fd"; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(item.width || .1, 1 / scale);
    for (const l of g.lines) { ctx.beginPath(); ctx.moveTo(l[0][0], l[0][1]); for (let k = 1; k < l.length; k++) ctx.lineTo(l[k][0], l[k][1]); ctx.stroke(); }
    for (const a of g.arrows) { ctx.beginPath(); ctx.moveTo(a[0][0], a[0][1]); ctx.lineTo(a[1][0], a[1][1]); ctx.lineTo(a[2][0], a[2][1]); ctx.closePath(); ctx.fill(); }
    if (g.text && g.text.size * scale > 2.5) {
      const strokes = textStrokes(g.text);
      if (strokes.length) {
        ctx.lineWidth = Math.max(g.text.size * .12, 1 / scale);
        for (const l of strokes) { ctx.beginPath(); ctx.moveTo(l[0][0], l[0][1]); for (let k = 1; k < l.length; k++) ctx.lineTo(l[k][0], l[k][1]); ctx.stroke(); }
      } else {
        ctx.translate(g.text.at[0], g.text.at[1]); ctx.rotate(g.text.angle * D2R);
        ctx.font = "500 " + g.text.size + "px ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
        ctx.fillText(g.label, 0, 0);
      }
    }
    ctx.restore();
  }
  // Associative dimensions: endpoints referenced to pads, vias and track vertices; radial
  // dimensions to a circular object. Returns resolved points (or null when unchanged).
  function circleOf(i) {
    if (!i) return null;
    if (i.kind === "via") return {c: [i.x, i.y], r: (i.diameter || 0) / 2};
    if (i.kind === "pad") return {c: [i.x, i.y], r: Math.max(i.w || 0, i.h || 0) / 2};
    if (Array.isArray(i.points)) { const s = A().pathArc(i) || arcFit(i.points); if (s) return {c: s.c, r: s.r}; }
    return null;
  }
  function refPoint(byId, ref) {
    const it = ref && byId.get(ref.id); if (!it) return null;
    if (ref.vertex != null) {
      if (!Array.isArray(it.points)) return null;
      // Follow the point, not the index: a vertex inserted before it shifts the index.
      let k = ref.at ? it.points.findIndex(p => dist(p, ref.at) < 1e-6) : -1;
      if (k < 0) k = ref.vertex < it.points.length ? ref.vertex : -1;
      if (k < 0) return null;
      ref.vertex = k; ref.at = P(it.points[k]); return it.points[k];
    }
    if (ref.local && it.kind === "part") return A().world(ref.local, it);
    return Number.isFinite(it.x) ? [it.x, it.y] : null;
  }
  function resolveDimension(item, byId) {
    const dim = item.dimension; if (!dim) return null;
    let pts = item.points.map(p => p.slice()), moved = false;
    if (dim.circle) {
      const c = circleOf(byId.get(dim.circle.id));
      if (c && c.r > 0) {
        const u = unit([pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]]);
        const next = [c.c, [c.c[0] + u[0] * c.r, c.c[1] + u[1] * c.r]].map(P);
        if (dist(next[0], pts[0]) > 1e-6 || dist(next[1], pts[1]) > 1e-6) { pts = next; moved = true; }
      }
    }
    (dim.refs || []).forEach((ref, k) => { const q = ref && refPoint(byId, ref); if (q && dist(q, pts[k]) > 1e-6) { pts[k] = P(q); moved = true; } });
    return moved ? pts : null;
  }
  /** Moves associative dimensions onto their objects. Returns how many changed. */
  // A move of the whole dimension (its points translated together) becomes an offset change,
  // so an attached dimension can still be repositioned; its points stay on their objects.
  function moveToOffset(d, delta) {
    const dim = d.dimension, a = dim.anchor;
    if (dim.type === "linear") dim.offset = r6((dim.offset || 0) + (dim.dir === "v" ? delta[0] : delta[1]));
    else if (dim.type === "aligned") { const n = normalOf(a[0], a[1]); dim.offset = r6((dim.offset || 0) + delta[0] * n[0] + delta[1] * n[1]); }
  }
  function syncDimensions(doc) {
    const dims = doc.items.filter(i => i.dimension && (i.dimension.refs || i.dimension.circle));
    if (!dims.length) return 0;
    const byId = new Map(doc.items.map(i => [i.id, i]));
    let n = 0;
    for (const d of dims) {
      const dim = d.dimension, a = dim.anchor;
      if (Array.isArray(a) && a.length === d.points.length) {
        const deltas = d.points.map((p, k) => [p[0] - a[k][0], p[1] - a[k][1]]);
        const moved = deltas.some(v => Math.hypot(v[0], v[1]) > 1e-6), uniform = deltas.every(v => dist(v, deltas[0]) < 1e-6);
        if (moved && uniform) { moveToOffset(d, deltas[0]); d.points = a.map(p => p.slice()); n++; }
      }
      const pts = resolveDimension(d, byId);
      if (pts) { d.points = pts; n++; }
      dim.anchor = d.points.map(p => p.slice());
    }
    return n;
  }
  /**
   * A copy of the board for Gerber and DXF writers: each dimension with export !== false
   * becomes plain graphics (lines, filled arrowheads, stroked text) on its layer; dimensions
   * with export === false are left out. Other items are shared, not copied.
   */
  function dimensionPrimitives(item, o = {}) {
    const g = dimensionGeometry(item, o), w = item.width || .1, out = [];
    const add = (points, extra) => out.push({id: item.id + ":" + out.length, kind: "graphic", layer: item.layer, points, width: w, ...extra});
    for (const l of g.lines) if (l.length >= 2) add(l);
    for (const a of g.arrows) add(a, {fill: true, closed: true, width: 0});
    for (const s of textStrokes(g.text)) if (s.length >= 2) add(s.map(P), {width: g.text.size * .12});
    return out;
  }
  function forExport(doc, o = {}) {
    if (!doc.items.some(i => i.dimension)) return doc;
    return {...doc, items: doc.items.flatMap(i => !i.dimension ? [i] : i.dimension.export === false ? [] : dimensionPrimitives(i, o))};
  }

  // ------------------------------------------------------------------ measurement geometry
  const {closestSegments, orient, projectPointOnSegment, inRing:inside} = globalThis.AtriumGeometry;
  const segPoint = (p, a, b) => dist(p, projectPointOnSegment(p, a, b));
  const segmentsOf = f => {
    const pts = f.pts; if (pts.length === 1) return [[pts[0], pts[0]]];
    const out = []; for (let k = 1; k < pts.length; k++) out.push([pts[k - 1], pts[k]]);
    if ((f.filled || f.closed) && pts.length > 2) out.push([pts.at(-1), pts[0]]);
    for (const h of f.holes || []) for (let k = 0; k < h.length; k++) out.push([h[k], h[(k + 1) % h.length]]);
    return out;
  };
  // Inside a filled feature: inside its outline and outside its holes (poured copper).
  const within = (p, f) => f.filled && f.pts.length > 2 && inside(p, f.pts) && !(f.holes || []).some(h => inside(p, h));
  /** Edge-to-edge gap between two features: {d, pa, pb} (pa on a's edge, pb on b's). */
  function featureGap(a, b) {
    if (within(b.pts[0], a)) return {d: 0, pa: b.pts[0], pb: b.pts[0], overlap: true};
    if (within(a.pts[0], b)) return {d: 0, pa: a.pts[0], pb: a.pts[0], overlap: true};
    let best = {d: Infinity};
    for (const [p, q] of segmentsOf(a)) for (const [r, s] of segmentsOf(b)) { const c = closestSegments(p, q, r, s); if (c.d < best.d) best = c; }
    const d = best.d - (a.r || 0) - (b.r || 0);
    if (d <= 0) return {d: 0, pa: best.pa, pb: best.pb, overlap: true};
    const u = unit([best.pb[0] - best.pa[0], best.pb[1] - best.pa[1]]);
    return {d, pa: P([best.pa[0] + u[0] * (a.r || 0), best.pa[1] + u[1] * (a.r || 0)]), pb: P([best.pb[0] - u[0] * (b.r || 0), best.pb[1] - u[1] * (b.r || 0)])};
  }
  function featureBox(f) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of f.pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const r = f.r || 0; return [x0 - r, y0 - r, x1 + r, y1 + r];
  }
  function padFeature(p, parent, layer) {
    const L=AtriumResolvedLand,PCB=AtriumPCBAppearance,land=L.geometry(p,layer);
    const declared=layer??PCB.padLayer(parent,p),layers=declared==="Multi"?"all":[declared];
    if(!land){
      if(!(p.drill>0))return null;
      const pts=PCB.padDrillCore(p,parent);
      return {pts,r:p.drill/2,layers,drillOnly:true};
    }
    const {at,angle,mirror}=L.place(land,parent),{core:pts,r}=L.core(land,at,angle,mirror);
    return {pts,filled:pts.length>2,r,layers};
  }
  function padFeatures(p, parent, doc, defs) {
    const {padLayer,padPlanes}=AtriumPCBAppearance;
    const layers=padPlanes(p,padLayer(parent,p),()=>globalThis.AtriumStackup?.copperLayers(doc,defs)||["Top","Bottom"]);
    return layers.map(layer=>padFeature(p,parent,layer)).filter(Boolean);
  }
  /** Copper-style features of a board item (track capsules, pad shapes, filled regions…). */
  // Poured copper of a polygon (stored regions tagged with its id): outlines with holes, in mm.
  function pourFeatures(doc, poly) {
    const C = globalThis.AtriumPCBPours?.contours, out = [];
    if (!C) return out;
    for (const r of doc?.pcbDrawing?.pours || []) {
      if (r.polygon !== poly.id) continue;
      let rings; try { rings = C(r); } catch { continue; }
      const ring = xy => { const q = []; for (let k = 0; k + 1 < xy.length; k += 2) q.push([xy[k], xy[k + 1]]); return q; };
      if (!rings.length) continue;
      out.push({pts: ring(rings[0]), holes: rings.slice(1).map(ring), filled: true, r: 0, layers: [r.layer || poly.layer], poured: true});
    }
    return out;
  }
  function graphicFeatures(shape, layers, frame) {
    const C = AtriumGeometryCurves, out = [], width = shape.width || 0;
    const points = edges => C.flatten(frame ? edges.map(edge => C.placeEdge(edge, frame)) : edges, .002);
    const emit = (ink, kind) => {
      if (ink.kind === "stroke") {
        out.push({pts: points(ink.centerline), r: ink.width / 2, layers});
      } else for (const {outer, holes} of ink.islands) {
        out.push({pts: points(outer).slice(0, -1), holes: holes.map(loop => points(loop).slice(0, -1)),
          r: kind === "disk" ? 0 : width / 2, filled: true, layers});
      }
    };
    C.artworkInk(shape, width, emit);
    return out;
  }
  function itemFeatures(i, defs, doc) {
    const out = [];
    if (!i) return out;
    if (i.kind === "track" || (i.kind === "graphic" && !i.dimension)) {
      return graphicFeatures(i, isKeepout(i) ? keepoutLayers(i) : [i.layer || "Top"]);
    } else if (i.kind === "graphic" && i.dimension) {
      for (const l of dimensionGeometry(i).lines) out.push({pts: l, r: (i.width || 0) / 2, layers: [i.layer]});
    } else if (i.kind === "polygon") {
      const poured = pourFeatures(doc, i);
      if (poured.length) out.push(...poured);
      else if ((i.points || []).length > 2) out.push({pts: i.points, r: 0, filled: true, layers: [i.layer || "Top"], unpoured: true});
    } else if (i.kind === "via") {
      out.push({pts: [[i.x, i.y]], r: (i.diameter || 0) / 2, layers: "all"});
    } else if (i.kind === "pad") {
      out.push(...padFeatures(i, null, doc, defs));
    } else if (i.kind === "part") {
      const fp = defs?.get?.(i.def)?.footprint;
      for (const p of fp?.pads || []) for (const f of padFeatures(p, i, doc, defs)) {
        out.push({...f, restriction:p.kind === "via" ? "via" : p.drill > 0 ? "throughPad" : "smdPad"});
      }
      const frame = AtriumGeometryCurves.artworkFrame(i);
      for (const s of fp?.shapes || []) if (!s.cutout && !isKeepout(s) && isCopper(s.layer))
        for (const f of graphicFeatures(s, [s.layer], frame)) out.push({...f, restriction: s.fill ? "copper" : "track"});
    } else if (i.kind === "label") {
      const b = globalThis.AtriumPCBText?.hitBox?.(i);
      if (Array.isArray(b) && b.length === 4) out.push({pts: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], r: 0, filled: true, layers: [i.layer]});
      else out.push({pts: [[i.x, i.y]], r: (i.size || 1) / 2, layers: [i.layer]});
    }
    return out;
  }
  /** Measure Primitives: edge-to-edge clearance between two items. {d, pa, pb, overlap}. */
  function measure(doc, defs, a, b) {
    const ia = typeof a === "string" ? doc.items.find(i => i.id === a) : a, ib = typeof b === "string" ? doc.items.find(i => i.id === b) : b;
    const fa = itemFeatures(ia, defs, doc), fb = itemFeatures(ib, defs, doc);
    if (!fa.length || !fb.length) throw Error("These objects have no measurable geometry.");
    let best = null;
    for (const x of fa) for (const y of fb) { const g = featureGap(x, y); if (!best || g.d < best.d) best = g; }
    // An unpoured polygon is measured by its outline; say so.
    return {...best, a: ia.id, b: ib.id, outline: [...fa, ...fb].some(f => f.unpoured)};
  }
  /** Measure Selected Objects: total length of the selected tracks and lines. */
  function measureSelected(doc, ids) {
    const set = ids instanceof Set ? ids : new Set(ids || []), nets = new Set();
    let length = 0, count = 0, box = null;
    for (const i of doc.items) {
      if (!set.has(i.id) || !Array.isArray(i.points) || i.fill || i.dimension || !["track", "graphic"].includes(i.kind)) continue;
      count++; if (i.net) nets.add(i.net);
      length += A().pathLength(i);
      const b = A().bounds(i.points); if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
    }
    return {length, count, nets: [...nets], box};
  }

  // ------------------------------------------------------------------ keep-out violations (DRC)
  const layersMeet = (a, b) => a === "all" || b === "all" || a.some(l => (l === "Multi" ? true : b.includes(l)) || b.includes("Multi"));
  const LABEL = {track: "Track", via: "Via", pad: "Pad", graphic: "Copper", polygon: "Polygon"};
  /**
   * Copper (tracks, vias, pads, copper graphics, component pads) touching a keep-out on a
   * shared layer. Returns DRC-style rows: {id, otherId, title, what, actual:0, at}.
   */
  function keepoutViolations(doc, defs, o = {}) {
    const keeps = doc.items.filter(i => isKeepout(i) && Array.isArray(i.points)).map(k => ({k, f: itemFeatures(k, defs)[0]})).filter(x => x.f);
    const byFootprint = new Map();
    for (const part of doc.items) if (part.kind === "part") {
      const fp = defs?.get?.(part.def)?.footprint;
      if (!fp) continue;
      if (!byFootprint.has(fp)) byFootprint.set(fp, (fp.shapes || []).filter(s => isKeepout(s) && s.points?.length));
      const frame = AtriumGeometryCurves.artworkFrame(part);
      for (const s of byFootprint.get(fp)) {
        const k = {...s, kind:"graphic", id:part.id};
        const [f] = graphicFeatures(s, keepoutLayers(k), frame);
        if (f) keeps.push({k,f});
      }
    }
    if (!keeps.length) return [];
    for (const x of keeps) x.box = featureBox(x.f);
    const out = [], cap = o.limit ?? 500;
    for (const i of doc.items) {
      if (isKeepout(i) || i.dimension || !["track", "via", "pad", "part", "graphic", "polygon"].includes(i.kind)) continue;
      if (i.kind === "graphic" && !isCopper(i.layer) && i.layer !== "Multi") continue;
      if (i.kind === "polygon" && (i.cutout || !(doc.pcbDrawing?.pours || []).some(r => r.polygon === i.id))) continue;
      const fs = (i.kind === "polygon" ? pourFeatures(doc, i) : itemFeatures(i, defs, doc)).filter(f =>
        !f.drillOnly && (f.layers === "all" || f.layers.some(l => isCopper(l) || l === "Multi")));
      for (const x of keeps) {
        let hit = null;
        for (const f of fs) {
          const target=f.restriction || (i.kind==="pad" ? i.drill>0?"throughPad":"smdPad" : i.kind==="via"||i.kind==="track" ? i.kind : "copper");
          if (!A().keepoutBlocks(x.k,target) || !layersMeet(f.layers, keepoutLayers(x.k))) continue;
          const b = featureBox(f);
          if (b[0] > x.box[2] || b[2] < x.box[0] || b[1] > x.box[3] || b[3] < x.box[1]) continue;
          const g = featureGap(f, x.f); if (g.d <= 1e-6) { hit = g; break; }
        }
        if (!hit) continue;
        const what = i.kind === "part" ? (i.ref || "Component") + " pad" : i.kind === "polygon" ? "Poured copper" : LABEL[i.kind] || i.kind;
        out.push({id: i.id, otherId: x.k.id, title: what + (i.net ? " " + i.net : "") + " in keep-out (" + (x.k.layer === KEEPOUT ? "all layers" : x.k.layer) + ")",
          what: "Keep-out", actual: 0, required: 0, at: P(hit.pa), otherAt: P(hit.pb)});
        if (out.length >= cap) return out;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ outline checks
  /** Drops repeated vertices (zero-length edges), including the closing edge. */
  function cleanPoints(pts) {
    const out = [];
    for (const p of pts) if (!out.length || dist(out.at(-1), p) > 1e-6) out.push(P(p));
    while (out.length > 1 && dist(out[0], out.at(-1)) <= 1e-6) out.pop();
    return out;
  }
  /** True when a closed outline crosses or touches itself (bow-ties, folded edges). O(n²) up to 3000 vertices. */
  function selfIntersects(pts) {
    const n = pts.length; if (n < 4 || n > 3000) return false;
    const on = (a, b, c) => Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9;
    const sgn = v => Math.abs(v) < 1e-12 ? 0 : Math.sign(v);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = pts[j], d = pts[(j + 1) % n];
        const o1 = sgn(orient(a, b, c)), o2 = sgn(orient(a, b, d)), o3 = sgn(orient(c, d, a)), o4 = sgn(orient(c, d, b));
        if (o1 !== o2 && o3 !== o4) return true;
        if (!o1 && on(a, b, c) || !o2 && on(a, b, d) || !o3 && on(c, d, a) || !o4 && on(c, d, b)) return true;
      }
    }
    return false;
  }
  /** Keep-out areas as closed polygons (KiCad rule areas): regions as drawn, tracks and arcs as bands. */
  function keepoutOutlines(item) {
    const pts = item.points || [];
    if (item.fill && pts.length > 2) return [pts.map(P)];
    const r = Math.max((item.width || 0) / 2, .01), out = [];
    if (item.arc && pts.length > 2) {
      // One band along the arc: offset left, then right reversed.
      const left = [], right = [];
      pts.forEach((p, k) => { const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)], n = normalOf(a, b); left.push(P([p[0] + n[0] * r, p[1] + n[1] * r])); right.push(P([p[0] - n[0] * r, p[1] - n[1] * r])); });
      return [[...left, ...right.reverse()]];
    }
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], u = unit([b[0] - a[0], b[1] - a[1]]), n = [u[1], -u[0]];
      const s0 = [a[0] - u[0] * r, a[1] - u[1] * r], s1 = [b[0] + u[0] * r, b[1] + u[1] * r];
      out.push([[s0[0] + n[0] * r, s0[1] + n[1] * r], [s1[0] + n[0] * r, s1[1] + n[1] * r], [s1[0] - n[0] * r, s1[1] - n[1] * r], [s0[0] - n[0] * r, s0[1] - n[1] * r]].map(P));
    }
    return out;
  }
  /** Canvas painter for a keep-out on one copper layer: hatched area or a translucent band with a dashed spine. */
  function drawKeepout(ctx, item, o = {}) {
    const scale = o.scale || 1, pts = item.points || []; if (pts.length < 2) return;
    const line = (q, closed) => { ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); for (let k = 1; k < q.length; k++) ctx.lineTo(q[k][0], q[k][1]); if (closed) ctx.closePath(); };
    ctx.save(); ctx.strokeStyle = ctx.fillStyle = o.ink || "#ff0000"; ctx.lineCap = "round"; ctx.lineJoin = "round";
    const base = typeof ctx.globalAlpha === "number" ? ctx.globalAlpha : 1;
    if (item.fill && pts.length > 2) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      ctx.save(); line(pts, true); ctx.clip();
      const step = Math.max(8 / scale, (x1 - x0 + y1 - y0) / 400);
      ctx.lineWidth = 1 / scale; ctx.beginPath();
      for (let t = x0 - (y1 - y0); t <= x1; t += step) { ctx.moveTo(t, y1); ctx.lineTo(t + (y1 - y0), y0); }
      ctx.stroke(); ctx.restore();
      ctx.lineWidth = 1 / scale; ctx.setLineDash?.([6 / scale, 4 / scale]); line(pts, true); ctx.stroke();  // a boundary, not copper
    } else {
      ctx.globalAlpha = base * .35; ctx.lineWidth = Math.max(item.width || 0, 1 / scale); line(pts, item.closed); ctx.stroke();
      ctx.globalAlpha = base; ctx.lineWidth = 1 / scale; ctx.setLineDash?.([6 / scale, 4 / scale]); line(pts, item.closed); ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ vertex editing (polygons, regions, keep-outs)
  const editable = i => !!i && Array.isArray(i.points) && i.points.length >= 3 && !i.dimension && (i.kind === "polygon" || i.kind === "graphic" && (i.fill || i.closed));
  function handles(points) {
    const out = [], n = points.length;
    points.forEach((p, k) => { out.push({type: "vertex", index: k, at: p}); out.push({type: "mid", index: k, at: mid(p, points[(k + 1) % n])}); });
    return out;
  }
  const moveVertex = (pts, k, p) => pts.map((q, j) => j === k ? P(p) : q.slice());
  function insertVertex(pts, k, p) { const out = pts.map(q => q.slice()); out.splice(k + 1, 0, P(p)); return out; }
  function deleteVertex(pts, k) {
    if (pts.length <= 3) throw Error("A polygon needs at least three vertices.");
    return pts.filter((_, j) => j !== k).map(q => q.slice());
  }
  // Move edge k (vertex k to k+1) parallel to itself by the component of delta along its normal.
  function moveEdge(pts, k, delta) {
    const n = pts.length, a = pts[k], b = pts[(k + 1) % n], nv = normalOf(a, b), t = delta[0] * nv[0] + delta[1] * nv[1];
    const d = [nv[0] * t, nv[1] * t];
    return pts.map((q, j) => j === k || j === (k + 1) % n ? P([q[0] + d[0], q[1] + d[1]]) : q.slice());
  }
  // Replace edge k with an arc through p (regions store arcs as vertices).
  function arcEdge(pts, k, p) {
    const n = pts.length, a = pts[k], b = pts[(k + 1) % n], s = arcThrough(a, p, b);
    if (!s) return pts.map(q => q.slice());
    const inner = projectedArc(s.c, s.r, s.start, s.sweep).slice(1, -1);
    const out = pts.map(q => q.slice()); out.splice(k + 1, 0, ...inner); return out;
  }

  /**
   * Pours to repour after `poly`'s outline changes: the polygon and every poured polygon after it
   * in pour order on its layer (they pour around it and their stored signatures depend on it);
   * for a cutout, every poured polygon on its layer (any layer for a Multi cutout).
   */
  function affectedPours(doc, poly, defs, options) {
    return globalThis.AtriumPolygonPour?.affected(doc, [poly.id], defs, options) || [];
  }

  function outlineProblem(pts) {
    const clean = cleanPoints(pts);
    if (clean.length < 3) return "A polygon needs at least three distinct vertices.";
    if (selfIntersects(clean)) return "The outline would cross itself.";
    if (Math.abs(area(clean)) < 1e-9) return "The outline encloses no area.";
    return null;
  }
  function area(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
  /**
   * Polygon modify (one undo step; call inside the editor's edit()): set a cleaned outline and,
   * for a polygon pour, repour it and every pour it affects at once. Throws on an invalid outline.
   * Returns {points, repoured:[ids], ms, error}.
   */
  function modifyOutline(doc, defs, item, pts, o = {}) {
    const bad = outlineProblem(pts); if (bad) throw Error(bad);
    item.points = cleanPoints(pts); if (item.fillRect) delete item.fillRect;
    const out = {points: item.points, repoured: [], ms: 0, error: null}, PP = globalThis.AtriumPolygonPour;
    if (item.kind !== "polygon" || !PP?.apply) return out;
    const ids = affectedPours(doc, item, defs, o); if (!ids.length) return out;
    const t0 = Date.now();
    try { PP.apply(doc, defs, {project: o.project, only: ids}); out.repoured = ids; } catch (err) { out.error = err.message; }
    out.ms = Date.now() - t0;
    return out;
  }

  // ------------------------------------------------------------------ headless creation (MCP, extensions)
  /**
   * Build one object from a plain description. spec.type: pad | fill | region | line | arc |
   * keepout | dimension. Coordinates in mm. Examples:
   *   {type:"pad", at:[10,5], w:2, h:2, drill:1, net:"GND"}
   *   {type:"fill", a:[0,0], b:[5,3], layer:"Top", net:"GND"}
   *   {type:"region", points:[[0,0],[4,0],[2,3]], layer:"Bottom"}
   *   {type:"line", points:[[0,0],[10,0]], layer:"Silk", width:.15}
   *   {type:"arc", center:[0,0], radius:2, start:0, end:90, layer:"Mechanical"}   (Altium angles, CCW)
   *   {type:"arc", through:[[0,0],[1,1],[2,0]]}
   *   {type:"keepout", shape:"track"|"arc"|"fill"|"region", layer:"all"|"Top", …same fields}
   *   {type:"dimension", kind:"linear"|"aligned"|"radial"|"angular", points:[…], offset, dir}
   */
  function create(spec) {
    if (!spec || typeof spec !== "object") throw Error("Describe the object to create.");
    const arcOf = s => s.through ? arcThrough(...s.through) : fromAltium(s.center, s.radius, s.start ?? 0, s.end ?? 360);
    switch (spec.type) {
      case "pad": return padItem(spec.at || [spec.x, spec.y], spec);
      case "fill": return fillItem(spec.a, spec.b, spec);
      case "region": return regionItem(spec.points, spec);
      case "line": return lineItem(spec.points, spec);
      case "arc": return arcItem(arcOf(spec), spec);
      case "keepout": {
        const shape = spec.shape || "region";
        return keepoutItem(shape === "arc" ? {type: "arc", arc: arcOf(spec)} : shape === "fill" ? {type: "fill", a: spec.a, b: spec.b} : {type: shape, points: spec.points}, spec);
      }
      case "dimension": return dimensionItem(spec.kind || "linear", spec.points, spec);
      default: throw Error("Unknown object type " + spec.type + ".");
    }
  }
  /** Create and add to a board (call inside the editor's edit() for undo). Returns the item. */
  function place(doc, spec) {
    if (doc?.kind !== "pcb") throw Error("Objects can only be placed on a board.");
    const it = create(spec); doc.items.push(it); return it;
  }

  // ================================================================== editor integration (DOM)
  let H = null, session = null, result = null, hover = null, vdrag = null, dialog = null, spaceHeld = false;
  const displayUnits = () => { try { return H?.units?.() === "mil" ? "mil" : "mm"; } catch { return "mm"; } };
  const prefs = {
    pad: {number: "1", shape: "round", w: 1.5, h: 1.5, drill: .8, layer: "Multi", plated: true, net: "", angle: 0},
    copper: {layer: null, net: ""}, keepout: {layer: KEEPOUT, width: .25},
    line: {layer: null, width: .2}, dimension: {layer: "Mechanical 2", width: .1, textHeight: 1, units: "auto", precision: null, export: true},
    corner: "45"
  };
  const CORNERS = ["45", "any", "90"], CORNER_NAMES = {"45": "45° snap", any: "Any angle", "90": "90° snap"};
  // Tool table: kind is the click sequence; group picks the preference set.
  const TOOLS = {
    "pcb-pad": {kind: "point", group: "pad", title: "Place Pad"},
    "pcb-fill": {kind: "rect", group: "copper", title: "Place Fill"},
    "pcb-region": {kind: "poly", group: "copper", title: "Place Solid Region"},
    "pcb-polygon": {kind: "poly", group: "pour", title: "Place Polygon Pour"},
    "pcb-keepout-track": {kind: "line", group: "keepout", shape: "track", title: "Place Keepout Track"},
    "pcb-keepout-arc": {kind: "arc-center", group: "keepout", shape: "arc", title: "Place Keepout Arc"},
    "pcb-keepout-fill": {kind: "rect", group: "keepout", shape: "fill", title: "Place Keepout Fill"},
    "pcb-keepout-region": {kind: "poly", group: "keepout", shape: "region", title: "Place Keepout Region"},
    "pcb-line": {kind: "line", group: "line", title: "Place Line"},
    "pcb-arc-center": {kind: "arc-center", group: "line", title: "Place Arc (Center)"},
    "pcb-arc-edge": {kind: "arc-edge", group: "line", title: "Place Arc (Edge)"},
    "pcb-arc-3pt": {kind: "arc-3pt", group: "line", title: "Place Arc (3 Points)"},
    "pcb-dim-linear": {kind: "dim", dim: "linear", group: "dimension", title: "Place Linear Dimension"},
    "pcb-dim-aligned": {kind: "dim", dim: "aligned", group: "dimension", title: "Place Aligned Dimension"},
    "pcb-dim-radial": {kind: "dim", dim: "radial", group: "dimension", title: "Place Radial Dimension"},
    "pcb-dim-angular": {kind: "dim", dim: "angular", group: "dimension", title: "Place Angular Dimension"},
    "measure-primitives": {kind: "measure", title: "Measure Primitives"},
    "board-edit-vertices": {kind: "board", title: "Edit Board Shape"}
  };
  const ACTIONS = [...Object.keys(TOOLS), "measure-selected", "polygon-pour"];

  function prompt(s) {
    const n = s.pts.length, k = s.def.kind;
    const tail = " Tab properties, Esc ends.";
    switch (k) {
      case "point": return "Click to place a pad. Space rotates." + tail;
      case "rect": return (n ? "Click the opposite corner." : "Click the first corner.") + tail;
      case "poly": return (n < 3 ? "Click to add vertices." : "Click the first vertex, double-click, Enter or Esc to close.") + " Backspace removes the last vertex. " + CORNER_NAMES[prefs.corner] + ": Space flips the corner, Shift+Space changes the mode.";
      case "line": return (n ? "Click to add a corner. Right-click, Enter or Esc finishes." : "Click the start of the line.") + " " + CORNER_NAMES[prefs.corner] + ": Space flips the corner, Shift+Space changes the mode.";
      case "arc-center": return ["Click the arc centre.", "Click the start point (radius).", "Click the end point. Space reverses the direction."][n] + tail;
      case "arc-edge": return (n ? "Click the end point. Space flips the side." : "Click the start point.") + tail;
      case "arc-3pt": return ["Click the start point.", "Click the end point.", "Click a point on the arc."][n] + tail;
      case "dim": {
        const t = s.def.dim;
        if (t === "radial") return (n ? "Click to place the leader." : "Click an arc, via or round pad, or the centre.") + tail;
        if (t === "angular") return ["Click the vertex.", "Click a point on the first leg.", "Click a point on the second leg.", "Click to place the arc. Space picks the outer angle."][n] + tail;
        return ["Click the first point.", "Click the second point.", "Click to place the dimension line." + (t === "linear" ? " Space toggles horizontal / vertical." : "")][n] + tail;
      }
      case "measure": return n ? "Click the second object." : "Click the first object to measure clearance from. Esc clears.";
      case "board": return "Drag vertices to reshape, midpoints to add a vertex (Alt: arc), edges to move them. Delete removes the hovered vertex. Esc ends.";
    }
    return "";
  }
  const layerName = l => l === KEEPOUT ? "Keep-Out Layer" : globalThis.AtriumPCBAppearance?.name?.(l) || l;
  const copperLayers = () => { try { return H.copperLayers() || ["Top", "Bottom"]; } catch { return ["Top", "Bottom"]; } };
  const activeCopper = () => { const l = H.activeLayer?.(); return isCopper(l) ? l : copperLayers()[0] || "Top"; };
  const OTHER_LAYERS = ["Silk", "Bottom silk", "Mechanical", "Mechanical 2", "Mechanical 3", "Mechanical 4", "Top mask", "Bottom mask", "Top paste", "Bottom paste", "Drill drawing", "Drill guide", KEEPOUT];
  const lineLayer = () => prefs.line.layer || activeCopper();
  const isPcb = () => H?.doc?.()?.kind === "pcb";

  function ensureBoard() {
    if (isPcb()) return true;
    const p = H.project(), b = globalThis.Atrium?.preferredDocument?.(p, "pcb", H.currentId?.()) || p.documents.find(d => d.kind === "pcb");
    if (!b) { H.info("Open a board layout first."); return false; }
    H.selectDocument(b.id); return isPcb();
  }
  function active() {
    if (!session || !H) return null;
    if (H.tool() !== "pcb-draw" || !isPcb()) { session = null; vdrag = null; return null; }
    return session;
  }
  // Nets and designator counters belong to a project: reset them when another project is open.
  let prefsProject = null;
  function projectPrefs() {
    const key = (H.project().documents || []).map(d => d.id).join("|");
    if (key === prefsProject) return;
    if (prefsProject !== null) { prefs.copper.net = ""; prefs.pad.net = ""; prefs.pad.number = "1"; }
    prefsProject = key;
  }
  function start(id, extra = {}) {
    if (!ensureBoard()) return;
    projectPrefs();
    const def = TOOLS[id];
    if (def.kind === "board") {
      const S = globalThis.AtriumBoardShape;
      if (!S || !S.current(H.doc())) { H.info("Set the board shape first (Design → Board Shape)."); return; }
    }
    session = {id, def, pts: [], refs: [], angle: prefs.pad.angle || 0, cw: false, flip: false, dir: null, reflex: false, ...extra};
    H.setTool("pcb-draw");
    H.info(def.title + ". " + prompt(session));
    try { H.canvas().focus(); } catch {}
    H.redraw();
  }
  function stop() { session = null; vdrag = null; dialog?.close?.(); if (H.tool() === "pcb-draw") H.setTool("select"); H.redraw(); }
  // Polygon Pour by vertices (Place → Polygon Pour with nothing selected).
  function drawPour(base) { if (!H) return false; start("pcb-polygon", {pourBase: base}); return !!session; }

  // ---------- snapping
  function snapped(p) { try { return H.snapAt(p); } catch { return p; } }
  // Altium corner modes: 45° and 90° lay an orthogonal-plus-diagonal (or two orthogonal) pair of
  // segments that ends at the cursor; Space flips which leg comes first.
  function legs(s, q) {
    const prev = s.pts.at(-1);
    if (!prev || prefs.corner === "any") return [P(q)];
    const is45 = prefs.corner === "45", path = s.knee ? A().pathBetween(q, prev, is45).reverse() : A().pathBetween(prev, q, is45);
    return path.slice(1).map(P);
  }
  function cursor() { const p = H.pointer?.(); return p ? snapped(p) : null; }
  function refAt(q) {
    const E = globalThis.AtriumPCBEdit; if (!E?.objectSnap) return null;
    const d = H.doc(), view = H.view();
    const hit = E.objectSnap(d, H.defs(), q, {radius: 1 / view.scale(), kinds: {pads: true, vias: true, tracks: true}, query: b => view.query(d, H.defs(), b)});
    if (!hit || !hit.id || dist(hit.point, q) > 1e-6) return null;
    const it = d.items.find(i => i.id === hit.id); if (!it) return null;
    if (hit.kind === "track") { const k = it.points.findIndex(p => dist(p, q) < 1e-6); return k >= 0 ? {id: it.id, vertex: k, at: P(it.points[k])} : null; }
    if (it.kind === "part") { const v = A().rotate([q[0] - it.x, q[1] - it.y], -(it.angle || 0)); return {id: it.id, local: P(v)}; }
    return {id: it.id};
  }

  // ---------- committing
  function commit(items, msg) {
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
    if (!list.length) return;
    try { H.edit(() => { H.doc().items.push(...list); }); H.info(msg || (session?.def.title.replace(/^Place /, "") + " placed. " + prompt(session))); }
    catch (e) { H.info(e.message); }
  }
  // Copper fills and regions take the Net preference, else the net of the copper under the first click.
  const copperOpts = s => ({layer: prefs.copper.layer && copperLayers().includes(prefs.copper.layer) ? prefs.copper.layer : activeCopper(), net: prefs.copper.net || s?.net || ""});
  function netUnder(e) {
    const it = e && H.hit?.(H.canvas(), e.clientX, e.clientY)?.item;
    if (!it || isKeepout(it) || it.holeOnly) return "";
    if (it.kind !== "part" && it.kind !== "pad") return it.net || "";
    const q = worldOf(e), layer = activeCopper(), defs = H.defs();
    const parent = it.kind === "part" ? it : null;
    const pads = parent ? defs.get(it.def)?.footprint?.pads || [] : [it];
    for (const p of pads) for (const f of padFeatures(p, parent, H.doc(), defs)) {
      if (!f.drillOnly && layersMeet(f.layers, [layer]) && featureGap(f, {pts:[q], r:0}).d <= 0) return parent?.pinNets?.[p.number] ?? p.net ?? "";
    }
    return "";
  }
  const keepOpts = () => ({layer: prefs.keepout.layer || KEEPOUT, width: prefs.keepout.width});
  const lineOpts = () => ({layer: lineLayer(), width: prefs.line.width});
  const dimOpts = () => ({...prefs.dimension, precision: prefs.dimension.precision ?? undefined});
  function arcSpec(s, q) {
    const p = s.pts;
    if (s.def.kind === "arc-center") return p.length >= 2 ? arcFromCenter(p[0], p[1], q, s.cw) : null;
    if (s.def.kind === "arc-edge") return p.length >= 1 ? arcFromEdge(p[0], q, s.flip) : null;
    if (s.def.kind === "arc-3pt") return p.length >= 2 ? arcThrough(p[0], q, p[1]) : null;
    return null;
  }
  function closePoly(s) {
    const pts = cleanPoints(s.pts);
    if (pts.length < 3) { H.info("A polygon needs at least three distinct vertices."); return; }
    if (selfIntersects(pts)) { H.info("The outline crosses itself. Backspace removes vertices; Esc twice discards it."); H.redraw(); return; }
    if (Math.abs(area(pts)) < 1e-9) { H.info("The outline encloses no area."); return; }
    s.pts = []; s.refs = [];
    if (s.def.group === "pour") {
      const PP = globalThis.AtriumPolygonPour;
      if (!PP?.open) { H.info("Polygon pours are unavailable in this build."); return; }
      const base = s.pourBase || pourBase(), d = H.doc(), count = () => d.items.filter(i => i.kind === "polygon").length, before = count();
      const dlg = PP.open({...base, doc: d, defs: H.defs(), outline: pts});
      // Cancel keeps the drawn outline so it can be closed again or edited.
      dlg?.addEventListener?.("close", () => { if (count() === before && active() === s && !s.pts.length) { s.pts = pts; s.kept = true; H.info("Pour cancelled; the outline is kept. Enter reopens the properties, Esc discards it."); H.redraw(); } }, {once: true});
      H.info("Polygon outline drawn: set its properties. Then click to draw another, or Esc."); H.redraw(); return;
    }
    if (s.def.group === "keepout") commit(keepoutItem({type: "region", points: pts}, keepOpts()));
    else commit(regionItem(pts, copperOpts(s)), regionMessage(s));
  }
  function regionMessage(s) {
    const o = copperOpts(s);
    return (s.def.id === "pcb-fill" ? "Fill" : "Region") + " placed on " + layerName(o.layer) + (o.net ? " · net " + o.net : " · no net: it joins every net it touches") + ". " + prompt(s);
  }
  function finishLine(s) {
    const pts = s.pts.slice(); s.pts = [];
    if (pts.length < 2) { H.redraw(); return; }
    commit(s.def.group === "keepout" ? keepoutItem({type: "track", points: pts}, keepOpts()) : lineItem(pts, lineOpts()));
  }
  function dimFrom(s, q) {
    const t = s.def.dim, p = s.pts, o = dimOpts();
    if (t === "linear" || t === "aligned") {
      if (p.length < 2) return null;
      const dir = t === "linear" ? s.dir || linearDir(p[0], p[1], q) : undefined;
      return dimensionItem(t, p, {...o, dir, offset: dimensionOffset(t, p, q, dir), refs: s.refs, id: "preview-dim"});
    }
    if (t === "radial") {
      if (!p.length) return null;
      let e = q;
      if (s.circle) { const u = unit([q[0] - p[0][0], q[1] - p[0][1]]); e = [p[0][0] + u[0] * s.circle.r, p[0][1] + u[1] * s.circle.r]; }
      if (dist(p[0], e) < EPS) return null;
      return dimensionItem("radial", [p[0], e], {...o, circle: s.circle?.id, id: "preview-dim"});
    }
    if (t === "angular") {
      if (p.length < 3) return p.length === 2 ? dimensionItem("angular", [p[0], p[1], q], {...o, id: "preview-dim"}) : null;
      return dimensionItem("angular", p, {...o, radius: Math.max(dist(p[0], q), .2), reflex: s.reflex, id: "preview-dim"});
    }
    return null;
  }
  function click(q, e, raw = q) {
    const s = active(); if (!s) return;
    const k = s.def.kind;
    if (k === "point") {
      const pp = prefs.pad;
      commit(padItem(q, {...pp, angle: s.angle}));
      if (/^\d+$/.test(pp.number)) pp.number = String(+pp.number + 1);
      return;
    }
    if (k === "rect") {
      if (!s.pts.length && s.def.group === "copper") s.net = netUnder(e);
      s.pts.push(q);
      if (s.pts.length === 2) {
        const [a, b] = s.pts; s.pts = [];
        if (Math.abs(a[0] - b[0]) < EPS || Math.abs(a[1] - b[1]) < EPS) { H.info("Drag out a rectangle with some area."); return; }
        if (s.def.group === "keepout") commit(keepoutItem({type: "fill", a, b}, keepOpts()));
        else commit(fillItem(a, b, copperOpts(s)), regionMessage(s));
        s.net = "";
      }
      H.info(prompt(s)); H.redraw(); return;
    }
    if (k === "poly") {
      const n = s.pts.length;
      // Clicking the first vertex, or clicking the last one again (the second click of a double-click), closes.
      if (n >= 3 && (nearScreen(raw, s.pts[0], 7) || dist(q, s.pts[n - 1]) < EPS)) { closePoly(s); return; }
      if (n && dist(q, s.pts[n - 1]) < EPS) return;
      if (!n && s.def.group === "copper") s.net = netUnder(e);
      for (const v of n ? legs(s, q) : [P(q)]) if (!s.pts.length || dist(v, s.pts.at(-1)) > EPS) s.pts.push(v);
      s.kept = false; H.info(prompt(s)); H.redraw(); return;
    }
    if (k === "line") {
      const n = s.pts.length;
      if (n >= 2 && dist(q, s.pts[n - 1]) < EPS) { finishLine(s); return; }
      if (n && dist(q, s.pts[n - 1]) < EPS) return;
      for (const v of n ? legs(s, q) : [P(q)]) if (!s.pts.length || dist(v, s.pts.at(-1)) > EPS) s.pts.push(v);
      H.info(prompt(s)); H.redraw(); return;
    }
    if (k === "arc-center" || k === "arc-edge" || k === "arc-3pt") {
      const need = k === "arc-edge" ? 2 : 3;
      if (s.pts.length === need - 1) {
        const spec = arcSpec(s, q); s.pts = [];
        if (!spec || !(spec.r > 0)) { H.info("These points do not make an arc."); return; }
        commit(s.def.group === "keepout" ? keepoutItem({type: "arc", arc: spec}, keepOpts()) : arcItem(spec, lineOpts()));
        return;
      }
      if (s.pts.length && dist(q, s.pts.at(-1)) < EPS) return;
      s.pts.push(q); H.info(prompt(s)); H.redraw(); return;
    }
    if (k === "dim") {
      const t = s.def.dim;
      if (t === "radial" && !s.pts.length) {
        const hit = e && H.hit?.(H.canvas(), e.clientX, e.clientY)?.item, c = circleOf(hit);
        if (c && c.r > 0) { s.circle = {id: hit.id, r: c.r}; s.pts = [P(c.c)]; }
        else s.pts = [q];
        H.info(prompt(s)); H.redraw(); return;
      }
      const need = t === "angular" ? 4 : t === "radial" ? 2 : 3;
      if (s.pts.length === need - 1) {
        const it = dimFrom(s, q); s.pts = []; s.refs = []; s.circle = null; s.dir = null;
        if (!it) { H.info("Pick distinct points."); return; }
        it.id = newId(); commit(it, "Dimension placed: " + dimensionGeometry(it, {units: displayUnits()}).label + ". " + prompt(s));
        return;
      }
      if (s.pts.length && dist(q, s.pts.at(-1)) < EPS) return;
      if (t === "linear" || t === "aligned") s.refs.push(refAt(q));
      s.pts.push(q); H.info(prompt(s)); H.redraw(); return;
    }
    if (k === "measure") {
      const hit = e && H.hit?.(H.canvas(), e.clientX, e.clientY)?.item;
      if (!hit) { H.info("Click an object."); return; }
      if (!s.first) { s.first = hit; result = null; H.info(prompt({...s, pts: [1]})); H.redraw(); return; }
      try {
        const m = measure(H.doc(), H.defs(), s.first, hit);
        result = {...m, text: (m.overlap ? "Overlapping · clearance 0" : "Clearance " + fmt(m.d)) + " (" + fmt(m.d, "other") + ")" + (m.outline ? " · unpoured polygon: outline" : "")};
        H.info(describe(s.first) + " ↔ " + describe(hit) + ": " + result.text + ". Click another pair, Esc clears.");
      } catch (err) { H.info(err.message); }
      s.first = null; H.redraw();
    }
  }
  const fmt = (mm, which) => { const u = displayUnits(), w = which === "other" ? (u === "mil" ? "mm" : "mil") : u; return A().units.format(mm, w, w === "mil" ? 2 : 4); };
  const describe = i => i.kind === "part" ? i.ref : i.kind === "track" ? "Track" + (i.net ? " " + i.net : "") : i.kind === "via" ? "Via" + (i.net ? " " + i.net : "") :
    i.kind === "pad" ? "Pad" + (i.net ? " " + i.net : "") : i.kind === "polygon" ? "Polygon" + (i.net ? " " + i.net : "") : isKeepout(i) ? "Keep-out" : i.kind[0].toUpperCase() + i.kind.slice(1);
  function nearScreen(a, b, px) { const v = H.view(), s = v.worldToScreen(a), t = v.worldToScreen(b); return Math.hypot(s[0] - t[0], s[1] - t[1]) <= px; }
  function pourBase() {
    return {doc: H.doc(), defs: H.defs(), unit: H.project().units || "mm", edit: H.edit, info: H.info, layer: activeCopper(), options: {project: H.project()}};
  }

  // ---------- keys while a tool runs (Altium: Tab, Space, Shift+Space, Backspace, Enter, Esc)
  function key(e) {
    const s = active();
    if (e.key === "Escape" && result && !s) { result = null; H.redraw(); return false; }
    if (!s) return selectKey(e);
    if (e.key === "Escape") {
      const k = s.def.kind;
      if (k === "line" && s.pts.length >= 2) { finishLine(s); return true; }
      if (k === "poly" && s.pts.length >= 3 && !s.kept) { closePoly(s); if (s.pts.length) s.kept = true; return true; }
      s.kept = false;
      if (s.pts.length || s.first) { s.pts = []; s.refs = []; s.first = null; s.circle = null; H.info("Cancelled. " + prompt(s)); H.redraw(); return true; }
      if (result) result = null;
      stop(); H.info("Ready"); return true;
    }
    if (e.key === "Tab") { openProperties(); return true; }
    if (e.key === "Backspace" || e.key === "Delete") {
      if (s.def.kind === "board") { boardDelete(); return true; }
      if (s.pts.length) { s.pts.pop(); s.refs.length = Math.min(s.refs.length, s.pts.length); if (!s.pts.length) s.circle = null; H.info(prompt(s)); H.redraw(); }
      return true;
    }
    if (e.key === "Enter") {
      if (s.def.kind === "poly" && s.pts.length >= 3) closePoly(s);
      else if (s.def.kind === "line" && s.pts.length >= 2) finishLine(s);
      else { const q = cursor(); if (q) click(q, null); }
      return true;
    }
    if (e.key === " " || e.code === "Space") {
      if (e.repeat) return true;
      const k = s.def.kind;
      if (k === "point") { s.angle = mod(s.angle + (e.shiftKey ? -90 : 90), 360); H.info("Rotation " + s.angle + "°"); }
      else if ((k === "poly" || k === "line") && !e.shiftKey) { s.knee = !s.knee; H.info("Corner flipped · " + CORNER_NAMES[prefs.corner]); }
      else if (k === "poly" || k === "line") { prefs.corner = CORNERS[(CORNERS.indexOf(prefs.corner) + 1) % CORNERS.length]; H.info(CORNER_NAMES[prefs.corner]); }
      else if (k === "arc-center") { s.cw = !s.cw; H.info(s.cw ? "Clockwise" : "Counter-clockwise"); }
      else if (k === "arc-edge") s.flip = !s.flip;
      else if (k === "dim" && s.def.dim === "linear") { const q = cursor(); s.dir = (s.dir || (q && s.pts.length >= 2 ? linearDir(s.pts[0], s.pts[1], q) : "h")) === "h" ? "v" : "h"; H.info(s.dir === "h" ? "Horizontal" : "Vertical"); }
      else if (k === "dim" && s.def.dim === "angular") s.reflex = !s.reflex;
      H.redraw(); return true;
    }
    return false;
  }
  function selectKey(e) {
    if ((e.key === "Delete" || e.key === "Backspace") && hover?.type === "vertex" && H.tool() === "select") {
      const it = selectedEditable(); if (!it || hover.id !== it.id) return false;
      try { const pts = deleteVertex(it.points, hover.index); applyPoints(it, pts, "Vertex removed"); }
      catch (err) { H.info(err.message); }
      hover = null; return true;
    }
    return false;
  }

  // ---------- vertex editing on the selected polygon / region / keep-out
  function selectedEditable() {
    if (!H || H.tool() !== "select" || !isPcb()) return null;
    const ids = H.selection(); if (ids.length !== 1) return null;
    const it = H.doc().items.find(i => i.id === ids[0]);
    return editable(it) && !it.locked ? it : null;
  }
  // Handles shown at this zoom: vertices at least 6 px apart, midpoints on edges of 16 px or more.
  function visibleHandles(points, toScreen) {
    const out = [], n = points.length; let last = null;
    for (let k = 0; k < n; k++) {
      const a = toScreen(points[k]), b = toScreen(points[(k + 1) % n]);
      if (!last || Math.hypot(a[0] - last[0], a[1] - last[1]) >= 6) { out.push({type: "vertex", index: k, at: points[k], s: a}); last = a; }
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 16) { const m = mid(points[k], points[(k + 1) % n]); out.push({type: "mid", index: k, at: m, s: toScreen(m)}); }
    }
    return out;
  }
  function handleAt(points, p, px = 7) {
    const v = H.view(), s = v.worldToScreen(p);
    let best = null, bd = px;
    for (const h of visibleHandles(points, v.worldToScreen)) { const t = h.s, d = Math.hypot(t[0] - s[0], t[1] - s[1]); if (d <= bd + (h.type === "vertex" ? .5 : 0)) { bd = d; best = {type: h.type, index: h.index, at: h.at}; } }
    if (best) return best;
    const tol = 5 / v.scale(), n = points.length;
    for (let k = 0; k < n; k++) if (segPoint(p, points[k], points[(k + 1) % n]) <= tol) return {type: "edge", index: k, at: p};
    return null;
  }
  function dragPoints(d, q) {
    const {pts, h} = d;
    if (h.type === "vertex") return moveVertex(pts, h.index, q);
    if (h.type === "mid") return d.alt ? arcEdge(pts, h.index, q) : insertVertex(pts, h.index, q);
    if (h.type === "edge") return moveEdge(pts, h.index, [q[0] - d.origin[0], q[1] - d.origin[1]]);
    return pts;
  }
  // One undo step: the new outline and, for a polygon, the repour of every pour it affects
  // (Altium's polygon modify). Synchronous, so undo, redo and other edits never interleave.
  function applyPoints(it, pts, msg) {
    const check = outlineProblem(pts);
    if (check) { H.info(check + " Nothing changed."); H.redraw(); return; }
    let res = null;
    try {
      H.edit(() => { res = modifyOutline(H.doc(), H.defs(), it, pts, {project: H.project()}); });
      H.info(msg + (res.repoured.length ? " · repoured " + res.repoured.length + " pour" + (res.repoured.length === 1 ? "" : "s") + " (" + res.ms + " ms)" : "") + (res.error ? " · repour failed (" + res.error + "); pours are marked stale" : ""));
    } catch (err) { H.info(err.message); }
  }

  // ---------- board outline vertex editing (AtriumBoardShape vertex API)
  function boardShape() { return vdrag?.board ? vdrag.preview || vdrag.shape : globalThis.AtriumBoardShape?.current(H.doc()); }
  function boardHandleAt(shape, p) {
    const shapeEdit = globalThis.AtriumBoardShapeEditing, v = H.view(), s = v.worldToScreen(p);
    let best = null, bd = 7;
    for (const h of shapeEdit.vertices(shape)) { const t = v.worldToScreen(h.at), d = Math.hypot(t[0] - s[0], t[1] - s[1]); if (d <= bd) { bd = d; best = h; } }
    if (best) return best;
    const tol = 5 / v.scale();
    [shape.contour, ...(shape.cutouts || [])].forEach((c, ci) => c.forEach((g, k) => {
      if (best || g.kind !== "line") return;
      if (segPoint(p, g.a, g.b) <= tol) best = {type: "edge", ref: {contour: ci - 1, index: k}, at: p};
    }));
    return best;
  }
  function touchGrips(p, consider) {
    if (!H || !isPcb()) return;
    if (active()?.def.kind === "board") {
      const shape = boardShape();
      if (shape) {
        for (const h of globalThis.AtriumBoardShapeEditing.vertices(shape)) consider(h.at,null);
        if (boardHandleAt(shape,p)?.type === "edge") consider(p,null,1);
      }
    } else {
      const item = selectedEditable();
      if (item) for (const h of visibleHandles(item.points,H.view().worldToScreen)) consider(h.at,item);
    }
  }
  function boardDrag(d, q) {
    const S = globalThis.AtriumBoardShapeEditing, h = d.h;
    if (h.type === "vertex") return S.moveVertex(d.shape, h.ref, q);
    if (h.type === "mid") {
      if (d.alt) return S.convertToArc(d.shape, h.ref, {through: q});
      const ins = S.insertVertex(d.shape, h.ref, d.origin);
      return S.moveVertex(ins, {contour: h.ref.contour, index: h.ref.index + 1}, q);
    }
    if (h.type === "edge") {
      const c = h.ref.contour == null || h.ref.contour < 0 ? d.shape.contour : d.shape.cutouts[h.ref.contour], g = c[h.ref.index];
      const nv = normalOf(g.a, g.b), t = (q[0] - d.origin[0]) * nv[0] + (q[1] - d.origin[1]) * nv[1];
      const a = [g.a[0] + nv[0] * t, g.a[1] + nv[1] * t], b = [g.b[0] + nv[0] * t, g.b[1] + nv[1] * t];
      const next = {contour: h.ref.contour, index: (h.ref.index + 1) % c.length};
      return S.moveVertex(S.moveVertex(d.shape, h.ref, a), next, b);
    }
    return d.shape;
  }
  function boardDelete() {
    const S = globalThis.AtriumBoardShape;
    if (hover?.board !== true || hover.type !== "vertex") { H.info("Point at a vertex to delete it."); return; }
    try { const next = globalThis.AtriumBoardShapeEditing.deleteVertex(S.current(H.doc()), hover.ref); H.edit(() => S.apply(H.doc(), next, "vertices")); H.info("Board vertex removed"); }
    catch (err) { H.info(err.message); }
    hover = null; H.redraw();
  }

  // ---------- pointer
  function worldOf(e) { const c = H.canvas(), b = c.getBoundingClientRect(); return H.view().screenToWorld([e.clientX - b.left, e.clientY - b.top]); }
  const ours = e => H && e.target === H.canvas?.() && isPcb();
  function onPointerDown(e) {
    if (!ours(e) || e.button !== 0 || spaceHeld) return;
    const touch=e.pointerType==="touch", alt=e.altKey && !touch;
    if (touch && (e.ctrlKey || e.shiftKey)) return;
    const s = active(), p = worldOf(e);
    if (s?.def.kind === "board") {
      const shape = globalThis.AtriumBoardShape.current(H.doc()), h = boardHandleAt(shape, p);
      if (h) vdrag = {board: true, h, shape, origin: snapped(p), alt, preview: null};
      swallow(e); grab(e); return;
    }
    if (s) { if (alt) return; swallow(e); grab(e, false); click(cursorAt(p), e, snapped(p)); return; }
    if (alt && !selectedEditable()) return;
    const it = selectedEditable(); if (!it) return;
    const h = handleAt(it.points, p); if (!h) return;
    vdrag = {id: it.id, h, pts: it.points.map(q => q.slice()), origin: snapped(p), alt, preview: null, moved: false};
    hover = h.type === "vertex" ? {...h, id: it.id} : hover;
    swallow(e); grab(e);
  }
  const cursorAt = p => snapped(p);
  function grab(e, capture = true) { try { H.canvas().focus(); if (capture && !globalThis.AtriumCanvasInput?.isReplay(e)) H.canvas().setPointerCapture(e.pointerId); } catch {} }
  function swallow(e) { e.preventDefault(); e.stopImmediatePropagation(); }
  function onPointerMove(e) {
    if (!H || !isPcb()) return;
    if (e.target !== H.canvas?.() && !vdrag) return;
    const p = worldOf(e);
    if (vdrag) {
      const q = snapped(p);
      vdrag.moved = vdrag.moved || dist(q, vdrag.origin) > 1e-9;
      try { vdrag.preview = vdrag.board ? boardDrag(vdrag, q) : dragPoints(vdrag, q); } catch { /* keep the last valid preview */ }
      H.redraw(); return;
    }
    const s = active();
    if (s) { H.redraw(); return; }
    // Hover feedback over handles of the selected editable item.
    const it = selectedEditable(), h = it && handleAt(it.points, p);
    const next = h ? {...h, id: it.id} : null;
    if ((next?.type) !== (hover?.type) || next?.index !== hover?.index) { hover = next; H.redraw(); }
    H.canvas().style.cursor = h ? (h.type === "vertex" ? "move" : h.type === "mid" ? "copy" : "ns-resize") : "";
  }
  function boardHover(p) {
    const shape = globalThis.AtriumBoardShape?.current(H.doc()); if (!shape) return;
    const h = boardHandleAt(shape, p), next = h ? {...h, board: true} : null;
    if (next?.type !== hover?.type || next?.ref?.index !== hover?.ref?.index || next?.ref?.contour !== hover?.ref?.contour) { hover = next; H.redraw(); }
    H.canvas().style.cursor = h ? (h.type === "vertex" ? "move" : h.type === "mid" ? "copy" : "ns-resize") : "";
  }
  function onPointerUp(e) {
    if (!vdrag) return;
    const d = vdrag; vdrag = null;
    swallow(e);
    if (!d.moved || !d.preview) { H.redraw(); return; }
    if (d.board) {
      try { const S = globalThis.AtriumBoardShape; H.edit(() => S.apply(H.doc(), d.preview, "vertices")); H.info("Board shape changed"); }
      catch (err) { H.info(err.message); }
      H.redraw(); return;
    }
    const it = H.doc().items.find(i => i.id === d.id); if (!it) return;
    applyPoints(it, d.preview, d.h.type === "vertex" ? "Vertex moved" : d.h.type === "mid" ? (d.alt ? "Edge made an arc" : "Vertex added") : "Edge moved");
  }
  function onContext(e) {
    if (!ours(e)) return;
    const s = active(); if (!s) return;
    if (s.def.kind === "poly" && s.pts.length >= 3) { swallow(e); closePoly(s); return; }
    if (s.def.kind === "line" && s.pts.length >= 2) { swallow(e); finishLine(s); return; }
    if (s.pts.length || s.first) { swallow(e); s.pts = []; s.refs = []; s.first = null; s.circle = null; H.info("Cancelled. " + prompt(s)); H.redraw(); return; }
    // Nothing in progress: the editor's right-click ends the tool.
  }
  function onDblClick(e) {
    if (!ours(e)) return;
    const s = active();
    if (s) {
      // Double-click closes a shape or finishes a line (Chrome reports detail 0 on pointerdown).
      if (s.def.kind === "poly" && s.pts.length >= 3) { swallow(e); closePoly(s); }
      else if (s.def.kind === "line" && s.pts.length >= 2) { swallow(e); finishLine(s); }
      return;
    }
    if (H.tool() !== "select") return;
    const hit = H.hit?.(H.canvas(), e.clientX, e.clientY)?.item;
    if (hit?.kind !== "polygon" || !globalThis.AtriumPolygonPour?.open) return;
    swallow(e);
    H.select([hit.id], hit.id);
    AtriumPolygonPour.open({...pourBase(), polygon: hit});
  }
  function onKey(e) {
    if (!H || !isPcb()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target, tag = t?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t?.isContentEditable || document.querySelector("dialog[open]")) return;
    if (!(t === document.body || t === H.canvas?.() || t === document.documentElement || t?.closest?.("#canvas-stage, .split-pane"))) return;
    if (active()?.def.kind === "board" && (e.key === "Delete" || e.key === "Backspace")) { swallow(e); boardDelete(); return; }
    if (key(e)) swallow(e);
  }

  // ---------- rendering (navigation host renderer: world-space overlay + board handles)
  function ink(layer) { return globalThis.AtriumPCBAppearance?.color?.(layer) || "#ffd400"; }
  function path(ctx, pts, closed) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]); if (closed) ctx.closePath(); }
  function screenText(ctx, info, at, text, color = "#ffd400") {
    const [x, y] = info.worldToScreen(at);
    ctx.save(); ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0);
    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif"; const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = "rgba(20,24,28,.82)"; ctx.fillRect(x + 8, y - 22, w, 18);
    ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.fillText(text, x + 13, y - 13); ctx.restore();
  }
  function drawHandles(ctx, info, pts, hot) {
    ctx.save(); ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0); ctx.lineWidth = 1;
    // Level of detail: crowded handles are thinned; vertices and midpoints each draw as one path.
    const list = visibleHandles(pts, info.worldToScreen), vx = new Path2DLike(), mx = new Path2DLike();
    let hotHandle = null;
    for (const h of list) {
      if (hot && hot.type === h.type && hot.index === h.index) { hotHandle = h; continue; }
      const [x, y] = h.s;
      if (h.type === "vertex") vx.rect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7); else mx.circle(Math.round(x) + .5, Math.round(y) + .5, 3);
    }
    ctx.strokeStyle = "#ffffff";
    mx.draw(ctx, "#3b3b3b"); vx.draw(ctx, "#ffffff");
    if (hotHandle) { const [x, y] = hotHandle.s; ctx.beginPath(); if (hotHandle.type === "vertex") ctx.rect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7); else ctx.arc(Math.round(x) + .5, Math.round(y) + .5, 3, 0, Math.PI * 2); ctx.fillStyle = "#ffd400"; ctx.strokeStyle = "#000"; ctx.fill(); ctx.stroke(); }
    if (hot?.type === "edge") { const n = pts.length, a = info.worldToScreen(pts[hot.index]), b = info.worldToScreen(pts[(hot.index + 1) % n]); ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    ctx.restore();
  }
  // Collects rects and circles and fills/strokes them as one canvas path.
  function Path2DLike() { const ops = []; return {rect: (x, y, w, h) => ops.push([0, x, y, w, h]), circle: (x, y, r) => ops.push([1, x, y, r]),
    draw(ctx, fill) { if (!ops.length) return; ctx.beginPath(); for (const o of ops) { if (o[0]) { ctx.moveTo(o[1] + o[3], o[2]); ctx.arc(o[1], o[2], o[3], 0, Math.PI * 2); } else ctx.rect(o[1], o[2], o[3], o[4]); } ctx.fillStyle = fill; ctx.fill(); ctx.stroke(); }}; }
  function vertexMarks(ctx, info, pts, closing) {
    ctx.save(); ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0); ctx.globalAlpha = 1; ctx.lineWidth = 1;
    pts.forEach((p, k) => { const [x, y] = info.worldToScreen(p), on = closing && k === 0; ctx.beginPath(); ctx.rect(Math.round(x) - (on ? 5.5 : 3.5), Math.round(y) - (on ? 5.5 : 3.5), on ? 11 : 7, on ? 11 : 7);
      ctx.fillStyle = on ? "#ffd400" : "#ffffff"; ctx.strokeStyle = "#000"; ctx.fill(); ctx.stroke(); });
    ctx.restore();
  }
  function ghostPad(ctx, q, pp, angle) {
    const w = pp.w, h = pp.h; ctx.save(); ctx.translate(q[0], q[1]); ctx.rotate(angle * D2R); ctx.beginPath();
    if (pp.shape === "rect") ctx.rect(-w / 2, -h / 2, w, h); else if (pp.shape === "roundrect" && ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) * A().padCornerRatio(pp));
    else if (pp.shape === "octagon") { const t = Math.min(w, h) * .25; path(ctx, [[-w / 2 + t, -h / 2], [w / 2 - t, -h / 2], [w / 2, -h / 2 + t], [w / 2, h / 2 - t], [w / 2 - t, h / 2], [-w / 2 + t, h / 2], [-w / 2, h / 2 - t], [-w / 2, -h / 2 + t]], true); }
    else if (w !== h && ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2); else ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    if (pp.drill > 0) { ctx.globalAlpha = 1; ctx.fillStyle = "#1d6d8c"; ctx.beginPath(); ctx.arc(0, 0, Math.min(pp.drill, w, h) / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  function paint(ctx, info) {
    const s = active(), px = 1 / info.scale;
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    // Measurement result: stays until Escape.
    if (result) {
      ctx.strokeStyle = "#ffd400"; ctx.fillStyle = "#ffd400"; ctx.lineWidth = 1.5 * px; ctx.setLineDash([4 * px, 3 * px]);
      path(ctx, [result.pa, result.pb]); ctx.stroke(); ctx.setLineDash([]);
      for (const p of [result.pa, result.pb]) { ctx.beginPath(); ctx.arc(p[0], p[1], 3 * px, 0, Math.PI * 2); ctx.fill(); }
      screenText(ctx, info, mid(result.pa, result.pb), result.text);
    }
    const edit = !s && selectedEditable();
    if (edit) {
      const pts = vdrag && !vdrag.board && vdrag.preview && vdrag.id === edit.id ? vdrag.preview : edit.points;
      if (pts !== edit.points) { ctx.strokeStyle = selfIntersects(pts) ? "#ff3b30" : "#ffd400"; ctx.lineWidth = 1.5 * px; ctx.setLineDash([5 * px, 3 * px]); path(ctx, pts, true); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = .18; ctx.fillStyle = "#ffd400"; ctx.fill(); ctx.globalAlpha = 1; }
      drawHandles(ctx, info, pts, vdrag ? null : hover?.id === edit.id ? hover : null);
    }
    if (s) paintSession(ctx, info, s, px);
    ctx.restore();
  }
  function paintSession(ctx, info, s, px) {
    const k = s.def.kind, q = cursor();
    if (k === "board") {
      if (vdrag?.preview) { const S = globalThis.AtriumBoardShape, pts = S.flattenContour(vdrag.preview.contour); ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 1.5 * px; ctx.setLineDash([5 * px, 3 * px]); path(ctx, pts, true); ctx.stroke(); ctx.setLineDash([]); }
      if (hover?.board && hover.type === "edge") { const S = globalThis.AtriumBoardShape, sh = S.current(H.doc()), c = hover.ref.contour < 0 ? sh.contour : sh.cutouts[hover.ref.contour], g = c?.[hover.ref.index]; if (g?.kind === "line") { ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 3 * px; path(ctx, [g.a, g.b]); ctx.stroke(); } }
      return;
    }
    if (!q) return;
    const group = s.def.group, layer = group === "keepout" ? (prefs.keepout.layer === KEEPOUT ? KEEPOUT : prefs.keepout.layer) : group === "line" ? lineLayer() : group === "dimension" ? prefs.dimension.layer : group === "pad" ? (prefs.pad.drill > 0 ? "Multi" : prefs.pad.layer === "Multi" ? "Top" : prefs.pad.layer) : copperOpts().layer;
    const color = group === "pour" ? ink(s.pourBase?.layer || activeCopper()) : ink(layer);
    ctx.globalAlpha = .7; ctx.strokeStyle = ctx.fillStyle = color;
    const width = group === "keepout" ? prefs.keepout.width : group === "line" ? prefs.line.width : 0;
    ctx.lineWidth = Math.max(width, 1.5 * px);
    if (k === "point") { ghostPad(ctx, q, prefs.pad, s.angle); }
    else if (k === "rect") {
      if (s.pts.length) { const r = rectPoints(s.pts[0], q); path(ctx, r, true); ctx.globalAlpha = .45; ctx.fill(); ctx.globalAlpha = .9; ctx.lineWidth = 1.5 * px; ctx.stroke(); screenText(ctx, info, q, fmt(Math.abs(q[0] - s.pts[0][0])) + " × " + fmt(Math.abs(q[1] - s.pts[0][1]))); }
    } else if (k === "poly" || k === "line") {
      if (s.pts.length) {
        const pts = [...s.pts, ...legs(s, q)], bad = k === "poly" && pts.length >= 4 && selfIntersects(pts);
        if (bad) ctx.strokeStyle = ctx.fillStyle = "#ff3b30";
        if (k === "poly" && pts.length >= 3) { path(ctx, pts, true); ctx.globalAlpha = .25; ctx.fill(); ctx.globalAlpha = .9; }
        ctx.lineWidth = k === "poly" ? 1.5 * px : Math.max(width, 1.5 * px); path(ctx, pts); ctx.stroke();
        if (k === "poly" && pts.length >= 3) { ctx.setLineDash([4 * px, 3 * px]); ctx.lineWidth = 1 * px; path(ctx, [q, s.pts[0]]); ctx.stroke(); ctx.setLineDash([]); }
        ctx.globalAlpha = 1;
        if (k === "poly") vertexMarks(ctx, info, s.pts, s.pts.length >= 3 && nearScreen(snapped(H.pointer()), s.pts[0], 7));
        screenText(ctx, info, q, fmt(dist(s.pts.at(-1), q)));
      }
    } else if (k.startsWith("arc")) {
      const spec = arcSpec(s, q);
      if (spec && spec.r > 0) { path(ctx, projectedArc(spec.c, spec.r, spec.start, spec.sweep)); ctx.stroke(); screenText(ctx, info, q, "R " + fmt(spec.r) + " · " + Math.abs(spec.sweep).toFixed(1) + "°"); }
      else if (s.pts.length) { ctx.lineWidth = px; ctx.setLineDash([4 * px, 3 * px]); path(ctx, [s.pts.at(-1), q]); ctx.stroke(); ctx.setLineDash([]); }
    } else if (k === "dim") {
      const it = dimFrom(s, q);
      if (it) { ctx.globalAlpha = .85; drawDimension(ctx, it, {scale: info.scale, ink: ink(it.layer), units: displayUnits()}); }
      else if (s.pts.length) { ctx.lineWidth = px; ctx.setLineDash([4 * px, 3 * px]); path(ctx, [s.pts.at(-1), q]); ctx.stroke(); ctx.setLineDash([]); }
    } else if (k === "measure" && s.first) {
      ctx.globalAlpha = .5; ctx.fillStyle = ctx.strokeStyle = "#ffd400";
      for (const f of itemFeatures(s.first, H.defs(), H.doc())) { ctx.lineWidth = Math.max(2 * (f.r || 0), 2 * px); if (f.filled) { path(ctx, f.pts, true); ctx.fill(); } else if (f.pts.length === 1) { ctx.beginPath(); ctx.arc(f.pts[0][0], f.pts[0][1], Math.max(f.r, 2 * px), 0, Math.PI * 2); ctx.fill(); } else { path(ctx, f.pts); ctx.stroke(); } }
    }
    // Cross-hair at the snapped cursor.
    ctx.globalAlpha = 1; ctx.strokeStyle = "#ffd400"; ctx.lineWidth = px; ctx.beginPath();
    ctx.moveTo(q[0] - 6 * px, q[1]); ctx.lineTo(q[0] + 6 * px, q[1]); ctx.moveTo(q[0], q[1] - 6 * px); ctx.lineTo(q[0], q[1] + 6 * px); ctx.stroke();
  }
  function render(d, info) {
    if (!info?.active || d.kind !== "pcb") return null;
    const s = active(), out = {};
    if (s?.def.kind === "board") {
      const S = globalThis.AtriumBoardShape, shape = vdrag?.board && vdrag.preview ? vdrag.preview : S?.current(d);
      if (shape) { out.boardHandles = globalThis.AtriumBoardShapeEditing.vertices(shape); if (hover?.board && hover.type !== "edge") out.boardHandleActive = hover; }
    }
    if (s || result || selectedEditable()) out.overlay = paint;
    return Object.keys(out).length ? out : null;
  }

  // ---------- properties (Tab mid-placement, and the Properties panel while a tool runs)
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function netNames() {
    const set = new Set();
    for (const i of H.doc().items) { if (i.net) set.add(i.net); if (i.pinNets) for (const n of Object.values(i.pinNets)) if (n) set.add(n); }
    return [...set].sort((a, b) => a.localeCompare(b, "en", {numeric: true}));
  }
  // One field row. f: {label, value, set, type:"length"|"number"|"text"|"select"|"check"|"net", values:[[v,label]]}
  function field(parent, f) {
    const l = el("label", null, "field-row" + (f.type === "check" ? " pcbdraw-check" : "")), U = A().units, u = displayUnits();
    let inp;
    if (f.type === "select") { inp = el("select"); for (const [v, t] of f.values) inp.add(new Option(t, v)); inp.value = f.value ?? ""; }
    else if (f.type === "check") { inp = el("input"); inp.type = "checkbox"; inp.checked = !!f.value; }
    else {
      inp = el("input"); inp.type = "text"; inp.autocomplete = "off"; inp.spellcheck = false;
      if (f.type === "length") { inp.inputMode = "decimal";inp.dataset.unit=u; inp.value = f.value == null ? "" : String(U.value(f.value, u)); inp.title = "Value in " + u + ". Suffixes such as mil, mm or in are accepted."; }
      else inp.value = f.value ?? "";
      if (f.type === "number" || f.type === "percent") {inp.inputMode="decimal";inp.dataset.numericUnit=f.type==="percent"?"%":f.unit || "";}
      if (f.type === "net") { const id = "pcbdraw-nets"; let dl = document.getElementById(id); if (!dl) { dl = el("datalist"); dl.id = id; document.body.append(dl); } dl.replaceChildren(...netNames().map(n => new Option(n, n))); inp.setAttribute("list", id); }
    }
    const label = f.type === "length" ? f.label + " (" + u + ")" : f.label;
    inp.classList.add(f.type === "check" ? "ui-checkbox" : "ui-field");
    inp.setAttribute("aria-label", label);
    if(f.numeric)globalThis.AtriumLazy?.numericField?.(inp,{...f.numeric,unit:f.type==="length"?u:f.numeric.unit});
    inp.onchange = () => {
      let v = f.type === "check" ? inp.checked : inp.value;
      if (f.type === "length") { v = U.parse(inp.value, u); if (!Number.isFinite(v) || v < (f.min ?? 0)) { H.info("Enter a length such as 0.25mm or 10mil."); inp.value = f.value == null ? "" : String(U.value(f.value, u)); return; } }
      if (f.type === "number") { v = +inp.value; if (!Number.isFinite(v)) { H.info("Enter a number."); inp.value = f.value ?? ""; return; } }
      if (f.type === "percent") { v = +inp.value; if (!inp.value.trim() || !Number.isFinite(v) || v<0 || v>100) { H.info("Enter a percentage from 0 to 100."); inp.value=f.value; return; } }
      f.value = v; f.set(v); H.redraw();
    };
    if (f.type === "check") l.append(inp, el("span", label)); else l.append(el("span", label), inp);
    parent.append(l);
    return inp;
  }
  const layerChoices = list => list.map(l => [l, layerName(l)]);
  const cornerField=(pad,set)=>({label:"Corner radius (%)",value:r6(A().padCornerRatio(pad)*200),type:"percent",set:v=>set(v/200)});
  function toolFields(s) {
    const g = s.def.group, out = [];
    if (g === "pad") {
      const pp = prefs.pad;
      out.push({label: "Designator", value: pp.number, set: v => pp.number = v, type: "text"},
        {label: "Shape", value: pp.shape, set: v => pp.shape = v, type: "select", values: SHAPES.map(x => [x, x[0].toUpperCase() + x.slice(1)])},
        {label: "X size", value: pp.w, set: v => pp.w = v, type: "length", min: .001}, {label: "Y size", value: pp.h, set: v => pp.h = v, type: "length", min: .001},
        {label: "Hole (0 = SMD)", value: pp.drill, set: v => pp.drill = v, type: "length"},
        {label: "Layer", value: pp.layer, set: v => pp.layer = v, type: "select", values: layerChoices(["Multi", ...copperLayers()])},
        {label: "Plated", value: pp.plated, set: v => pp.plated = v, type: "check"}, {label: "Net", value: pp.net, set: v => pp.net = v, type: "net"},
        {label: "Rotation (°)", value: s.angle, set: v => { s.angle = mod(v, 360); pp.angle = s.angle; }, type: "number",unit:"deg"});
      if(pp.shape === "roundrect")out.push(cornerField(pp,r=>pp.roundrectRadiusRatio=r));
    } else if (g === "copper") {
      out.push({label: "Layer", value: copperOpts().layer, set: v => prefs.copper.layer = v, type: "select", values: layerChoices(copperLayers())},
        {label: "Net", value: prefs.copper.net, set: v => prefs.copper.net = v, type: "net"});
    } else if (g === "keepout") {
      out.push({label: "Keep-out layer", value: prefs.keepout.layer, set: v => prefs.keepout.layer = v, type: "select", values: [[KEEPOUT, "All layers (Keep-Out Layer)"], ...layerChoices(copperLayers())]});
      if (s.def.shape === "track" || s.def.shape === "arc") out.push({label: "Width", value: prefs.keepout.width, set: v => prefs.keepout.width = v, type: "length"});
    } else if (g === "line") {
      out.push({label: "Layer", value: lineLayer(), set: v => prefs.line.layer = v, type: "select", values: layerChoices([...copperLayers(), ...OTHER_LAYERS])},
        {label: "Width", value: prefs.line.width, set: v => prefs.line.width = v, type: "length", min: 0});
    } else if (g === "dimension") {
      const dp = prefs.dimension;
      out.push({label: "Layer", value: dp.layer, set: v => dp.layer = v, type: "select", values: layerChoices(["Mechanical", "Mechanical 2", "Mechanical 3", "Mechanical 4", "Silk", "Bottom silk", "Drill drawing"])},
        {label: "Line width", value: dp.width, set: v => dp.width = v, type: "length", min: .001}, {label: "Text height", value: dp.textHeight, set: v => dp.textHeight = v, type: "length", min: .05},
        {label: "Units", value: dp.units, set: v => dp.units = v, type: "select", values: [["auto", "Board units"], ["mm", "mm"], ["mil", "mil"], ["in", "in"]]},
        {label: "Decimals", value: dp.precision ?? "", set: v => dp.precision = v === "" ? null : Math.max(0, Math.min(6, Math.round(+v))), type: "text"},
        {label: "Export to Gerber/DXF (Mechanical 2 and up, overlay)", value: dp.export, set: v => dp.export = v, type: "check"});
    }
    if (s.def.kind === "poly" || s.def.kind === "line") out.push({label: "Corner mode", value: prefs.corner, set: v => prefs.corner = v, type: "select", values: CORNERS.map(c => [c, CORNER_NAMES[c]])});
    return out;
  }
  /** Properties panel while a draw tool runs (editor inspect() hook). Returns true when shown. */
  function inspectTool(panel) {
    const s = active(); if (!s) return false;
    const sec = el("section", null, "inspect-section pcbdraw-tool"); sec.append(el("h3", s.def.title.replace(/^Place /, "")));
    for (const f of toolFields(s)) field(sec, f);
    if (s.def.group === "pour") {
      const b = el("button", "Pour the board outline…"); b.type = "button";
      globalThis.AtriumUI?.button(b, "secondary");
      b.onclick = () => { const d = H.doc(); if (!d.outline?.length) { H.info("Set the board perimeter first."); return; } globalThis.AtriumPolygonPour?.open({...(s.pourBase || pourBase()), doc: d, outline: d.outline.map(p => [...p])}); };
      sec.append(b);
    }
    sec.append(el("p", prompt(s), "pcbdraw-hint"));
    panel.append(sec); return true;
  }
  function openProperties() {
    const s = active(); if (!s || typeof document === "undefined") return;
    dialog?.close?.();
    const dlg = el("dialog", null, "ui-dialog message-dialog pcbdraw-props"); dlg.setAttribute("aria-label", s.def.title + " properties");
    dlg.append(el("h2", s.def.title, "ui-dialog-title"));
    const body = el("div", null, "pcbdraw-fields ui-dialog-body"); dlg.append(body);
    const list = toolFields(s); let first = null;
    for (const f of list) { const i = field(body, f); first ??= i; }
    if (!list.length) body.append(el("p", "This tool has no properties."));
    const ok = el("button", "Resume", "ui-button"); ok.dataset.variant = "primary"; ok.type = "button"; ok.onclick = () => dlg.close();
    const row = el("div", null, "pcbdraw-actions ui-dialog-actions"); row.append(ok); dlg.append(row);
    dlg.addEventListener("close", () => { dlg.remove(); if (dialog === dlg) dialog = null; try { H.canvas().focus(); } catch {} H.redraw(); }, {once: true});
    document.body.append(dlg); dialog = dlg; globalThis.AtriumShell?.adoptDialog?.(dlg, {initialFocus: first || ok, defaultAction: false}); dlg.showModal(); (first || ok).focus();
  }
  /** Extra Properties rows for a selected board object (editor inspect() hook). */
  function inspectItem(sec, item) {
    if (!H || !item || !isPcb()) return;
    const edit = fn => { try { H.edit(fn, undefined, [item]); } catch (e) { H.info(e.message); } };
    const add = f => field(sec, f);
    if (item.kind === "pad") {
      add({label: "Designator", value: item.number || "", set: v => edit(() => { if (v) item.number = v; else delete item.number; }), type: "text"});
      add({label: "Shape", value: item.shape || "round", set: v => edit(() => item.shape = v), type: "select", values: SHAPES.map(x => [x, x])});
      if (item.shape === "roundrect") add(cornerField(item,r=>edit(()=>{item.roundrectRadiusRatio=r;})));
      const docId=H.doc().id;
      const address=key=>({scope:"item",documentId:docId,itemId:item.id,path:[key]});
      for(const [key,label] of /** @type {const} */ ([["w","X size"],["h","Y size"],["drill","Hole"]])) {
        const spec=A().padNumericSpec(key);
        add({label,value:item[key] ?? 0,type:"length",min:spec.min,
          numeric:{...spec,target:address(key),locals:()=>globalThis.AtriumNumericFields.geometryLocals(item,docId)},
          set:v=>edit(()=>{
            const next=A().padDimensions(item,key,v);
            for(const field of [key,"drill","layer"]) {
              if(Object.hasOwn(next,field))item[field]=next[field];else delete item[field];
            }
          })});
      }
      add({label: "Layer", value: item.layer || "Multi", set: v => edit(() => item.layer = v), type: "select", values: layerChoices(["Multi", ...copperLayers()])});
      add({label: "Rotation (°)", value: item.angle || 0, set: v => edit(() => { item.angle = mod(v, 360); }), type: "number",unit:"deg",
        numeric:{...A().padNumericSpec("angle"),target:address("angle")}});
      return;
    }
    if (item.kind === "polygon") { sec.append(el("p", "Drag vertex handles to reshape, midpoints to add a vertex, edges to move them. Double-click for pour properties.", "pcbdraw-hint")); return; }
    // Display the former editor's fitted properties for legacy paths. Only an
    // explicit change to an arc property replaces their stored chords with a curve.
    const arc = item.arc === true ? nativeArc(arcFit(item.points)) : A().pathArc(item);
    if (arc) {
      const regen = changes => edit(() => {
        const current = A().pathArc(item) || arc;
        item.arc = {...current, ...changes(current)};
        item.points = A().arcProjection(item.arc, 5);
      });
      add({label:"Center X", value:arc.c[0], set:v=>regen(g=>({c:[v,g.c[1]]})), type:"length"});
      add({label:"Center Y", value:arc.c[1], set:v=>regen(g=>({c:[g.c[0],v]})), type:"length"});
      add({label:"Radius", value:arc.r, set:v=>regen(()=>({r:v})), type:"length", min:.001});
      add({label:"Start angle (°)", value:mod(arc.start,360), set:v=>regen(()=>({start:v})), type:"number",unit:"deg"});
      add({label:"End angle (°)", value:mod(arc.end,360), set:v=>regen(()=>({end:v})), type:"number",unit:"deg"});
      add({label:"Direction", value:arc.ccw?"ccw":"cw", set:v=>regen(()=>({ccw:v==="ccw"})), type:"select", values:[["ccw","Counter-clockwise"],["cw","Clockwise"]]});
    }
    if (item.kind !== "graphic") return;
    if (item.dimension) {
      const dim = item.dimension, g = dimensionGeometry(item, {units: displayUnits()});
      AtriumNavCommon.appendPropertyRow(sec, "Dimension", dim.type[0].toUpperCase() + dim.type.slice(1)); AtriumNavCommon.appendPropertyRow(sec, "Value", g.label);
      add({label: "Layer", value: item.layer, set: v => edit(() => item.layer = v), type: "select", values: layerChoices(["Mechanical", "Mechanical 2", "Mechanical 3", "Mechanical 4", "Silk", "Bottom silk", "Drill drawing"])});
      add({label: "Text height", value: dim.textHeight || 1, set: v => edit(() => dim.textHeight = v), type: "length", min: .05});
      add({label: "Line width", value: item.width || .1, set: v => edit(() => item.width = v), type: "length", min: .001});
      if (dim.type === "linear" || dim.type === "aligned") add({label: "Offset", value: dim.offset || 0, set: v => edit(() => { dim.offset = v; }), type: "length", min: -1e6});
      if (dim.type === "angular") add({label: "Arc radius", value: dim.radius || 1, set: v => edit(() => { dim.radius = v; }), type: "length", min: .01});
      add({label: "Units", value: dim.units || "auto", set: v => edit(() => dim.units = v), type: "select", values: [["auto", "Board units"], ["mm", "mm"], ["mil", "mil"], ["in", "in"]]});
      add({label: "Export to Gerber/DXF", value: dim.export !== false, set: v => edit(() => dim.export = !!v), type: "check"});
      if (/^Mechanical( 1)?$/.test(item.layer)) AtriumNavCommon.appendPropertyRow(sec, "Note", "Mechanical 1 holds the board profile in Gerber; use Mechanical 2 or later to plot this dimension.");
      if (dim.refs || dim.circle) AtriumNavCommon.appendPropertyRow(sec, "Associative", "follows its objects");
      return;
    }
    if (isKeepout(item)) {
      add({label: "Keep-out layer", value: item.layer, set: v => edit(() => { item.layer = v; if (v === KEEPOUT) delete item.keepout; else item.keepout = true; }), type: "select", values: [[KEEPOUT, "All layers"], ...layerChoices(copperLayers())]});
    } else {
      add({label: "Layer", value: item.layer, set: v => edit(() => { item.layer = v; if (!isCopper(v)) delete item.net; }), type: "select", values: layerChoices([...new Set([item.layer, ...copperLayers(), ...OTHER_LAYERS.filter(l => l !== KEEPOUT)])])});
      if (isCopper(item.layer)) add({label: "Net", value: item.net || "", set: v => edit(() => { if (v) item.net = v; else delete item.net; }), type: "net"});
    }
    if (!item.fill) add({label: "Width", value: item.width || 0, set: v => edit(() => item.width = v), type: "length"});
    if (editable(item)) sec.append(el("p", "Drag vertex handles on the canvas to reshape.", "pcbdraw-hint"));
  }

  // ---------- actions
  function run(a) {
    if (a === "polygon-pour") { if (!ensureBoard()) return; start("pcb-polygon", {pourBase: pourBase()}); return; }
    if (a === "measure-selected") {
      if (!ensureBoard()) return;
      const m = measureSelected(H.doc(), H.selection());
      if (!m.count) { H.info("Select tracks or lines to measure their length."); return; }
      const text = "Total length " + fmt(m.length) + " (" + fmt(m.length, "other") + ")";
      result = {pa: [m.box[0], m.box[1]], pb: [m.box[0], m.box[1]], text};
      H.info(m.count + " track" + (m.count === 1 ? "" : "s") + (m.nets.length ? " on " + m.nets.join(", ") : "") + " · " + text + ". Esc clears.");
      H.redraw(); return;
    }
    start(a);
  }
  let installed = false;
  function install(host) {
    H = host;
    for (const a of ACTIONS) host.registerAction(a, () => run(a));
    if (installed) return api;
    installed = true;
    host.addRenderer(render);
    host.on("change", () => {
      try { const d = H.doc(); if (d.kind === "pcb" && syncDimensions(d)) { H.view()?.invalidate?.(d); } } catch {}
    });
    host.on("selection", () => { hover = null; });
    host.on("document", () => { session = null; vdrag = null; result = null; hover = null; });
    if (typeof window !== "undefined") {
      window.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("pointermove", e => { onPointerMove(e); if (active()?.def.kind === "board" && !vdrag && e.target === H.canvas?.()) boardHover(worldOf(e)); }, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", e => {
        if (vdrag && e.target === H.canvas()) { vdrag = null; hover = null; H.redraw(); }
      }, true);
      window.addEventListener("contextmenu", onContext, true);
      window.addEventListener("dblclick", onDblClick, true);
      window.addEventListener("keydown", e => { if (e.code === "Space" && !active()) { spaceHeld = true; } onKey(e); }, true);
      window.addEventListener("keyup", e => { if (e.code === "Space") spaceHeld = false; }, true);
      window.addEventListener("blur", () => { spaceHeld = false; });
    }
    return api;
  }

  const api = {
    // geometry and plans (DOM-free)
    arcPoints: projectedArc, arcFromCenter, arcFromEdge, arcThrough, arcFit, altiumAngles, fromAltium,
    padItem, fillItem, regionItem, lineItem, arcItem, keepoutItem, dimensionItem, rectPoints, create, place,
    isKeepout, keepoutLayers, keepoutViolations,
    dimensionGeometry, dimensionPoints, dimensionHit, dimensionOffset, linearDir, drawDimension, dimensionPrimitives, forExport, syncDimensions, resolveDimension, circleOf,
    itemFeatures, featureGap, measure, measureSelected,
    editable, handles, outlineProblem, modifyOutline, cleanPoints, selfIntersects, affectedPours, keepoutOutlines, drawKeepout, pourFeatures, moveVertex, insertVertex, deleteVertex, moveEdge, arcEdge,
    TOOLS, ACTIONS, prefs,
    // editor integration
    install, drawPour, startAt(id, point, net) {
      if (!TOOLS[id] || !isPcb()) return;
      run(id);
      if (!active()) return;
      const at = snapped(point);
      click(at, null, at);
      if (net && session) session.net = net;
      H.redraw();
    }, inspectTool, inspectItem, touchGrips, get session() { return session; }, get result() { return result; }
  };
  globalThis.AtriumNavCommon?.ready?.(install);
  return api;
})();
