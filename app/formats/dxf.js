"use strict";
// ASCII DXF reader and writer for board outlines and mechanical layers.
//
// read(text) walks group-code pairs with a cursor (no line array), converting
// each entity to segments as soon as it ends, so a 100k-entity file needs
// memory for its geometry only. Supported: LINE, ARC, CIRCLE, LWPOLYLINE and
// POLYLINE (bulges), SPLINE (sampled), ELLIPSE, INSERT (nested, arrays,
// mirrored) from R12 to R2018. Output segments use the board-shape format in
// the file's units with Y flipped to the model's Y-down axis; segments(...)
// scales them to millimetres.
globalThis.AtriumDXF = (() => {
  const D2R = Math.PI / 180;
  // $INSUNITS codes in millimetres.
  const INSUNITS = {1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 2.54e-5, 9: .0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100, 15: 1e4, 16: 1e5};
  const UNIT_NAMES = {1: "in", 2: "ft", 3: "mi", 4: "mm", 5: "cm", 6: "m", 7: "km", 8: "µin", 9: "mil", 10: "yd", 11: "Å", 12: "nm", 13: "µm", 14: "dm"};
  const UNITS = {mm: 1, cm: 10, m: 1000, in: 25.4, mil: .0254, ft: 304.8, um: .001};
  const MAX_DEPTH = 16;

  // ---------------------------------------------------------------------------
  // Geometry in DXF axes (Y up, arcs counter-clockwise from start to end).
  const up = (c, r, a) => [c[0] + r * Math.cos(a * D2R), c[1] + r * Math.sin(a * D2R)];
  const n360 = a => ((a % 360) + 360) % 360;
  const sweepOf = s => { const d = s.ccw ? n360(s.end - s.start) : -n360(s.start - s.end); return d === 0 ? (s.ccw ? 360 : -360) : d; };
  const L = (a, b) => ({kind: "line", a, b});
  const C = (c, r, start, end, ccw = true) => ({kind: "arc", c, r, start, end, ccw});
  function bulgeSeg(a, b, bulge) {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(Math.abs(bulge) > 1e-12) || d < 1e-12) return L(a, b);
    const s = d * (1 - bulge * bulge) / (4 * bulge);
    const cx = (a[0] + b[0]) / 2 - (b[1] - a[1]) / d * s, cy = (a[1] + b[1]) / 2 + (b[0] - a[0]) / d * s;
    const r = d * (1 + bulge * bulge) / (4 * Math.abs(bulge));
    return C([cx, cy], r, Math.atan2(a[1] - cy, a[0] - cx) / D2R, Math.atan2(b[1] - cy, b[0] - cx) / D2R, bulge > 0);
  }
  const polyline = (pts, closed) => {
    const out = [];
    for (let i = 0; i + 1 < pts.length; i++) out.push(L(pts[i], pts[i + 1]));
    if (closed && pts.length > 2) out.push(L(pts[pts.length - 1], pts[0]));
    return out;
  };
  // Affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
  const ID = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const tp = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  const isId = m => m === ID;
  function transform(segs, m, tol) {
    if (isId(m) && segs.every(g => g.kind !== "ellipseArc")) return segs;
    const det = m[0] * m[3] - m[1] * m[2], s = Math.sqrt(Math.abs(det)), eps = 1e-9 * Math.max(1, s);
    const similar = Math.abs(m[0] - m[3]) < eps && Math.abs(m[1] + m[2]) < eps || Math.abs(m[0] + m[3]) < eps && Math.abs(m[1] - m[2]) < eps;
    const out = [];
    for (const g of segs) {
      if (g.kind !== "ellipseArc" && isId(m)) { out.push(g); continue; }
      if (g.kind === "line") { out.push(L(tp(m, g.a), tp(m, g.b))); continue; }
      if (g.kind === "arc" && similar && s > 0) {
        const c = tp(m, g.c), a = tp(m, up(g.c, g.r, g.start)), b = tp(m, up(g.c, g.r, g.end));
        const full = Math.abs(sweepOf(g)) === 360, st = Math.atan2(a[1] - c[1], a[0] - c[0]) / D2R;
        out.push(C(c, g.r * s, st, full ? st : Math.atan2(b[1] - c[1], b[0] - c[0]) / D2R, det > 0 ? g.ccw : !g.ccw));
      } else {
        const ellipse = g.kind === "ellipseArc", [x, y] = tp(m, ellipse ? g.center : g.c);
        const axis = ([u, v]) => [m[0] * u + m[2] * v, -m[1] * u - m[3] * v];
        const edge = {kind: "ellipseArc", center: [x, -y], start: g.start, sweep: ellipse ? g.sweep : sweepOf(g),
          cosineAxis: axis(ellipse ? g.cosineAxis : [g.r, 0]), sineAxis: axis(ellipse ? g.sineAxis : [0, g.r])};
        const points = AtriumGeometryCurves.flatten([edge], tol);
        if (points.length > 4097) throw new RangeError("A DXF curve exceeds the 4,096 segment limit at the requested tolerance.");
        out.push(...polyline(points.map(([x, y]) => [x, -y]), false));
      }
    }
    return out;
  }
  // Object coordinate system with extrusion (0, 0, -1): x mirrored.
  const OCS_FLIP = [-1, 0, 0, 1, 0, 0];

  // ---------------------------------------------------------------------------
  // Group-code cursor.
  function cursor(text) {
    let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0, line = 0;
    const n = text.length;
    const readLine = () => {
      if (pos >= n) return null;
      let e = text.indexOf("\n", pos); if (e < 0) e = n;
      const s = text.slice(pos, e); pos = e + 1; line++;
      return s;
    };
    const t = {code: -1, value: "", get line() { return line; }, done: false,
      next() {
        const c = readLine(), v = readLine();
        if (c == null || v == null) { this.done = true; this.code = 0; this.value = "EOF"; return false; }
        const code = +c.trim();
        if (!Number.isInteger(code) || c.trim() === "") throw Error("Malformed DXF near line " + line + ": expected a group code.");
        this.code = code; this.value = v.trim();
        return true;
      }};
    return t;
  }
  // Collect an entity's group codes until the next code 0.
  function gather(t) {
    const type = t.value, line = t.line - 1, codes = [], vals = [];
    while (t.next() && t.code !== 0) { codes.push(t.code); vals.push(t.value); }
    return {type, line, codes, vals};
  }
  const num = (r, code, def = 0) => { const i = r.codes.indexOf(code); if (i < 0) return def; const v = parseFloat(r.vals[i]); return Number.isFinite(v) ? v : def; };
  const str = (r, code, def = "") => { const i = r.codes.indexOf(code); return i < 0 ? def : r.vals[i]; };
  // Geometry values: a missing group reads as def (NaN when the entity needs it) and a malformed
  // value as NaN, so the entity is skipped instead of gaining a vertex at 0.
  const realValue = v => v === "" ? NaN : Number(v);
  const real = (r, code, def = NaN) => { const i = r.codes.indexOf(code); return i < 0 ? def : realValue(r.vals[i]); };
  const finite = values => values.every(Number.isFinite);

  // ---------------------------------------------------------------------------
  // Entity conversion (DXF axes, own units).
  function lwpolyline(r) {
    const pts = [], bulges = [];
    for (let i = 0; i < r.codes.length; i++) {
      const c = r.codes[i];
      if (c === 10) { pts.push([realValue(r.vals[i]), NaN]); bulges.push(0); }
      else if (c === 20 && pts.length) pts[pts.length - 1][1] = realValue(r.vals[i]);
      else if (c === 42 && pts.length) bulges[bulges.length - 1] = realValue(r.vals[i]);
    }
    if (!finite(pts.flat()) || !finite(bulges)) return null;
    return polyFrom(pts, bulges, (num(r, 70) & 1) === 1);
  }
  function polyFrom(pts, bulges, closed) {
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) segs.push(bulgeSeg(pts[i], pts[i + 1], bulges[i]));
    if (closed && pts.length > 1) segs.push(bulgeSeg(pts[pts.length - 1], pts[0], bulges[pts.length - 1]));
    return {segs: segs.filter(g => g.kind === "arc" || g.a[0] !== g.b[0] || g.a[1] !== g.b[1]), closed};
  }
  function ellipse(r, warn) {
    const c = [real(r, 10), real(r, 20)], m = [real(r, 11), real(r, 21)], k = real(r, 40, 1), nz = real(r, 230, 1);
    let t0 = real(r, 41, 0), t1 = real(r, 42, 2 * Math.PI);
    if (!finite([...c, ...m, k, nz, t0, t1])) return null;
    const minor = nz >= 0 ? [-m[1] * k, m[0] * k] : [m[1] * k, -m[0] * k];
    const at = t => [c[0] + m[0] * Math.cos(t) + minor[0] * Math.sin(t), c[1] + m[1] * Math.cos(t) + minor[1] * Math.sin(t)];
    let span = t1 - t0; while (span <= 1e-12) span += 2 * Math.PI; if (span > 2 * Math.PI) span = 2 * Math.PI;
    const a = Math.hypot(m[0], m[1]);
    if (!(a > 0)) return {segs: []};
    const full = Math.abs(span - 2 * Math.PI) < 1e-9;
    if (Math.abs(k - 1) < 1e-9) {
      const p0 = at(t0), p1 = at(t0 + span), s = Math.atan2(p0[1] - c[1], p0[0] - c[0]) / D2R;
      return {segs: [C(c, a, s, full ? s : Math.atan2(p1[1] - c[1], p1[0] - c[0]) / D2R, nz >= 0)], closed: full};
    }
    warn("Ellipses were approximated by line segments");
    return {segs: [{kind: "ellipseArc", center: c, cosineAxis: m, sineAxis: minor, start: t0 / D2R,
      sweep: full ? 360 : span / D2R}], closed: full};
  }
  function spline(r, tol, warn) {
    const p = Math.round(real(r, 71, 3)), flags = num(r, 70), knots = [], weights = [], ctrl = [], fit = [];
    for (let i = 0; i < r.codes.length; i++) {
      const c = r.codes[i], v = realValue(r.vals[i]);
      if (c === 40) knots.push(v); else if (c === 41) weights.push(v);
      else if (c === 10) ctrl.push([v, NaN]); else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = v;
      else if (c === 11) fit.push([v, NaN]); else if (c === 21 && fit.length) fit[fit.length - 1][1] = v;
    }
    if (!finite([p, ...knots, ...weights, ...ctrl.flat(), ...fit.flat()])) return null;
    const closed = (flags & 1) === 1;
    warn("Splines were approximated by line segments");
    const n = ctrl.length;
    if (n >= p + 1 && p >= 1 && knots.length === n + p + 1) {
      const W = weights.length === n ? weights : null;
      const u0 = knots[p], u1 = knots[n];
      if (!(u1 > u0)) return {segs: []};
      // Sample density from the control polygon length.
      let len = 0; for (let i = 1; i < n; i++) len += Math.hypot(ctrl[i][0] - ctrl[i - 1][0], ctrl[i][1] - ctrl[i - 1][1]);
      const count = Math.min(4000, Math.max(8 * (n - p), Math.ceil(Math.sqrt(len / Math.max(tol, 1e-9)) * 2), 16));
      const pts = [];
      let k = p;
      const d = new Array(p + 1);
      for (let s = 0; s <= count; s++) {
        const u = s === count ? u1 : u0 + (u1 - u0) * s / count;
        while (k < n - 1 && knots[k + 1] <= u) k++;
        for (let j = 0; j <= p; j++) { const q = ctrl[k - p + j], w = W ? W[k - p + j] : 1; d[j] = [q[0] * w, q[1] * w, w]; }
        for (let lv = 1; lv <= p; lv++) for (let j = p; j >= lv; j--) {
          const i = k - p + j, den = knots[i + p - lv + 1] - knots[i], al = den ? (u - knots[i]) / den : 0;
          d[j] = [(1 - al) * d[j - 1][0] + al * d[j][0], (1 - al) * d[j - 1][1] + al * d[j][1], (1 - al) * d[j - 1][2] + al * d[j][2]];
        }
        pts.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
      }
      const shut = closed || Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
      if (shut) pts.pop();
      return {segs: polyline(pts, shut), closed: shut};
    }
    if (fit.length >= 2) return {segs: polyline(fit, closed), closed};
    return {segs: []};
  }

  // ---------------------------------------------------------------------------
  // Reader
  function read(text, opt = {}) {
    if (typeof text !== "string") text = new TextDecoder().decode(text);
    if (text.startsWith("AutoCAD Binary DXF")) throw Error("Binary DXF is not supported. Save the drawing as ASCII DXF.");
    const t = cursor(text), warnings = new Map(), header = {}, layerTable = new Map(), blocks = new Map();
    const warn = m => warnings.set(m, (warnings.get(m) || 0) + 1);
    const entities = [], skipped = new Map();
    let tol = .005, scaleHint = 1, sawSection = false;
    const tolFor = () => tol / scaleHint;
    // Convert one gathered entity (or a POLYLINE with its vertices).
    const NOUN = {LINE: "lines", ARC: "arcs", CIRCLE: "circles", LWPOLYLINE: "polylines", POLYLINE: "polylines", ELLIPSE: "ellipses", SPLINE: "splines"};
    function convert(r, verts) {
      const type = r.type, nz = real(r, 230, 1), flip = nz < 0;
      const malformed = () => { warn("DXF " + NOUN[type] + " with missing or malformed coordinates were skipped"); return null; };
      let g = null;
      switch (type) {
        case "LINE": {
          const coordinates = [10, 20, 11, 21].map(code => real(r, code));
          if (!finite(coordinates)) return malformed();
          const [x, y, endX, endY] = coordinates;
          return {segs: [L([x, y], [endX, endY])], closed: false, flip: false};
        }
        case "ARC": {
          const c = [real(r, 10), real(r, 20)], rr = real(r, 40), start = real(r, 50, 0), end = real(r, 51, 0);
          if (!finite([...c, rr, start, end, nz])) return malformed();
          if (rr > 0) g = {segs: [C(c, rr, start, end)]};
          break;
        }
        case "CIRCLE": {
          const c = [real(r, 10), real(r, 20)], rr = real(r, 40);
          if (!finite([...c, rr, nz])) return malformed();
          // A CIRCLE has an extrusion axis but no start vertex. Optional application data
          // remembers where an editable full-turn path began in its object coordinates.
          const i = r.codes.findIndex((code,k) => code === 1001 && r.vals[k] === "WAFFLE" && r.codes[k+1] === 1000 && r.vals[k+1] === "ARC_START" && r.codes[k+2] === 1040);
          const angle = i >= 0 ? Number(r.vals[i+2]) : 0, start = Number.isFinite(angle) ? n360(angle) : 0;
          if (rr > 0) g = {segs:[C(c,rr,start,start+180), C(c,rr,start+180,start+360)], closed:true};
          break;
        }
        case "LWPOLYLINE": g = lwpolyline(r); if (!g || !Number.isFinite(nz)) return malformed(); break;
        case "POLYLINE": {
          const f = num(r, 70);
          if (f & 80) { warn("3D meshes and polyface meshes were skipped"); return null; }
          const pts = [], bulges = [];
          for (const v of verts) { if (num(v, 70) & 16) continue; pts.push([real(v, 10), real(v, 20)]); bulges.push(real(v, 42, 0)); }
          if (!finite([...pts.flat(), ...bulges, nz])) return malformed();
          if (f & 8) { bulges.fill(0); if (nz !== 1) warn("3D polylines were projected onto the XY plane"); }
          g = polyFrom(pts, bulges, (f & 1) === 1);
          if (f & 8) return g.segs.length ? {segs: g.segs, closed: g.closed, flip: false} : null;
          break;
        }
        case "ELLIPSE": g = ellipse(r, warn); if (!g) return malformed(); return g.segs.length ? {...g, flip: false} : null;
        case "SPLINE": g = spline(r, tolFor(), warn); if (!g) return malformed(); return g.segs.length ? {...g, flip: false} : null;
        default: return null;
      }
      if (!g || !g.segs.length) return null;
      return {segs: g.segs, closed: !!g.closed, flip};
    }
    // Read entities until one of the end markers; calls sink(record) for each.
    function readList(endMarkers, sink) {
      while (!t.done) {
        if (t.code !== 0) { t.next(); continue; }
        const type = t.value;
        if (endMarkers.has(type) || type === "EOF") return;
        const r = gather(t);
        if (type === "POLYLINE") {
          const verts = [];
          while (t.code === 0 && t.value === "VERTEX") verts.push(gather(t));
          if (t.code === 0 && t.value === "SEQEND") gather(t);
          sink(r, verts);
        } else if (type === "INSERT") {
          if (num(r, 66) === 1) { while (t.code === 0 && t.value === "ATTRIB") gather(t); if (t.code === 0 && t.value === "SEQEND") gather(t); }
          sink(r, null);
        } else sink(r, null);
      }
    }
    // Store raw block content: converted primitives plus unexpanded inserts.
    const layerOf = r => str(r, 8, "0") || "0";
    const sourceOf = r => str(r, 5) || "line " + r.line;
    function prim(r, verts) {
      if (r.type === "INSERT") {
        const at = [real(r, 10, 0), real(r, 20, 0)], sx = real(r, 41, 1), sy = real(r, 42, 1), rot = real(r, 50, 0), cs = real(r, 44, 0), rs = real(r, 45, 0), nz = real(r, 230, 1);
        if (finite([...at, sx, sy, rot, cs, rs, nz])) return {insert: true, ...(opt.entityResult ? {reference:sourceOf(r)} : {}), layer: layerOf(r), name: str(r, 2), at, sx: sx || 1, sy: sy || 1,
          rot, cols: Math.max(1, Math.min(1000, num(r, 70, 1) | 0)), rows: Math.max(1, Math.min(1000, num(r, 71, 1) | 0)), cs, rs, flip: nz < 0};
        warn("DXF block inserts with malformed coordinates were skipped");
      }
      const g = r.type === "INSERT" ? null : convert(r, verts);
      if (!g) {
        if (!["ATTDEF", "ATTRIB", "SEQEND", "VERTEX", "ENDBLK", "BLOCK"].includes(r.type)) {
          skipped.set(r.type, (skipped.get(r.type) || 0) + 1);
          opt.entityResult?.(sourceOf(r), r.type, "dropped", layerOf(r));
        }
        return null;
      }
      if (g.flip) g.segs = transform(g.segs, OCS_FLIP, tolFor());
      return {type: r.type, layer: layerOf(r), segs: g.segs, closed: g.closed,
        ...(opt.entityResult ? {reference:sourceOf(r), projected:r.type === "POLYLINE" && !!(num(r,70) & 8)} : {})};
    }
    const yflip = g => g.kind === "line" ? {kind: "line", a: [g.a[0], -g.a[1]], b: [g.b[0], -g.b[1]]} : {kind: "arc", c: [g.c[0], -g.c[1]], r: g.r, start: g.start, end: g.end, ccw: g.ccw};
    let expanded = 0, expandedSegments = 0;
    function emit(p, m, layer) {
      const segs = transform(p.segs, m, tolFor()).map(yflip);
      if (segs.length) {
        expandedSegments += segs.length;
        if (expandedSegments > 2000000) throw Error("The expanded DXF exceeds two million geometry segments.");
        entities.push({type: p.type, layer, segs, closed: p.closed, ...(opt.entityResult ? {reference:p.reference} : {})});
        if (opt.entityResult) {
          const sampled = p.projected || ["ELLIPSE", "SPLINE"].includes(p.type) || segs.length !== p.segs.length ||
            segs.some((segment, i) => segment.kind !== p.segs[i].kind);
          opt.entityResult(p.reference, p.type, sampled ? "approximated" : "kept", layer);
        }
      }
    }
    function expand(ins, m, parentLayer, stack) {
      const b = blocks.get(ins.name);
      if (!b) { opt.entityResult?.(ins.reference, "INSERT", "dropped", ins.layer); warn("Inserts of undefined blocks were skipped"); return; }
      if (stack.length >= MAX_DEPTH || stack.includes(ins.name)) { opt.entityResult?.(ins.reference, "INSERT", "dropped", ins.layer); warn("Recursive or deeply nested blocks were cut off"); return; }
      const layer = ins.layer === "0" ? parentLayer : ins.layer;
      const rot = ins.rot * D2R, cos = Math.cos(rot), sin = Math.sin(rot);
      expanded += ins.rows * ins.cols;
      if (expanded > 400000) throw Error("The expanded DXF exceeds 400,000 block placements.");
      for (let row = 0; row < ins.rows; row++) for (let col = 0; col < ins.cols; col++) {
        const ox = col * ins.cs, oy = row * ins.rs;
        // p -> R * (S * (p - base) + offset) + at, then OCS.
        let local = [ins.sx * cos, ins.sx * sin, -ins.sy * sin, ins.sy * cos, 0, 0];
        local = mul([1, 0, 0, 1, ins.at[0] + cos * ox - sin * oy, ins.at[1] + sin * ox + cos * oy], mul(local, [1, 0, 0, 1, -b.base[0], -b.base[1]]));
        if (ins.flip) local = mul(OCS_FLIP, local);
        const mm = isId(m) ? local : mul(m, local);
        for (const p of b.items) {
          const l = p.layer === "0" ? layer : p.layer;
          if (p.insert) expand(p, mm, l, [...stack, ins.name]);
          else emit(p, mm, l);
        }
      }
    }
    function topSink(r, verts) {
      const p = prim(r, verts);
      if (!p) return;
      if (p.insert) expand(p, ID, p.layer === "0" ? "0" : p.layer, []);
      else emit(p, ID, p.layer);
    }

    t.next();
    while (!t.done) {
      if (!(t.code === 0 && t.value === "SECTION")) { if (t.code === 0 && t.value === "EOF") break; t.next(); continue; }
      t.next();
      const name = t.code === 2 ? t.value : "";
      sawSection = true;
      t.next();
      if (name === "HEADER") {
        let v = "";
        while (!t.done && !(t.code === 0 && t.value === "ENDSEC")) {
          if (t.code === 9) v = t.value;
          else if (t.code === 70 && (v === "$INSUNITS" || v === "$MEASUREMENT" || v === "$LUNITS")) header[v] = +t.value;
          else if (v === "$ACADVER" && t.code === 1) header.$ACADVER = t.value;
          t.next();
        }
        const u = opt.units && UNITS[opt.units] ? UNITS[opt.units] : INSUNITS[header.$INSUNITS] || (header.$MEASUREMENT === 0 ? 25.4 : 1);
        scaleHint = u; tol = opt.tolerance || .005;
      } else if (name === "TABLES") {
        let table = "";
        while (!t.done && !(t.code === 0 && t.value === "ENDSEC")) {
          if (t.code === 0 && t.value === "TABLE") { t.next(); table = t.code === 2 ? t.value : ""; continue; }
          if (t.code === 0 && t.value === "LAYER" && table === "LAYER") { const r = gather(t); const nm = str(r, 2); if (nm) layerTable.set(nm, {color: num(r, 62, 7), off: num(r, 62, 7) < 0}); continue; }
          t.next();
        }
      } else if (name === "BLOCKS") {
        while (!t.done && !(t.code === 0 && t.value === "ENDSEC")) {
          if (!(t.code === 0 && t.value === "BLOCK")) { t.next(); continue; }
          const h = gather(t), bname = str(h, 2), block = {base: [real(h, 10, 0), real(h, 20, 0)], items: []};
          readList(new Set(["ENDBLK", "ENDSEC"]), (r, verts) => { const p = prim(r, verts); if (p) block.items.push(p); });
          if (t.code === 0 && t.value === "ENDBLK") gather(t);
          // A block without a readable base point is left undefined: its inserts are skipped with a warning.
          if (bname && !finite(block.base)) warn("DXF blocks with a malformed base point were skipped");
          else if (bname) blocks.set(bname, block);
        }
      } else if (name === "ENTITIES") {
        readList(new Set(["ENDSEC"]), topSink);
      } else {
        while (!t.done && !(t.code === 0 && t.value === "ENDSEC")) t.next();
      }
      if (t.code === 0 && t.value === "ENDSEC") t.next();
    }
    if (!sawSection) throw Error("This file is not an ASCII DXF drawing.");
    const code = header.$INSUNITS;
    const detected = INSUNITS[code] ? {code, name: UNIT_NAMES[code], mm: INSUNITS[code], assumed: false}
      : header.$MEASUREMENT === 0 ? {code: 0, name: "in", mm: 25.4, assumed: true} : {code: code || 0, name: "mm", mm: 1, assumed: true};
    // Layer summary.
    const layers = new Map();
    for (const e of entities) {
      let l = layers.get(e.layer);
      if (!l) { l = {name: e.layer, count: 0, types: {}, segments: 0}; layers.set(e.layer, l); }
      l.count++; l.segments += e.segs.length; l.types[e.type] = (l.types[e.type] || 0) + 1;
    }
    for (const [nm, v] of layerTable) if (!layers.has(nm)) layers.set(nm, {name: nm, count: 0, types: {}, segments: 0, color: v.color});
    for (const l of layers.values()) l.color = layerTable.get(l.name)?.color ?? 7;
    for (const [type, n] of skipped) warn(type + " entities were skipped (" + n + ")");
    return {
      units: detected, version: header.$ACADVER || "", entities,
      layers: [...layers.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      bounds: boundsOf(entities), blocks: blocks.size,
      warnings: [...warnings].map(([m, n]) => n > 1 && !/\(\d+\)$/.test(m) ? m + " (" + n + ")" : m)
    };
  }
  function boundsOf(entities, layers) {
    const S = globalThis.AtriumBoardShape, b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const e of entities) if (!layers || layers.has(e.layer)) S.contourBounds(e.segs, b);
    return b[0] === Infinity ? null : b;
  }
  // Segments of the chosen layers in millimetres: model = file * mm + offset.
  function segments(result, opt = {}) {
    const k = opt.mm ?? result.units.mm, off = opt.offset || [0, 0], layers = opt.layers ? new Set(opt.layers) : null;
    const r6 = v => Math.round(v * 1e6) / 1e6 + 0, P = p => [r6(p[0] * k + off[0]), r6(p[1] * k + off[1])];
    const out = [];
    result.entities.forEach((e, i) => {
      if (layers && !layers.has(e.layer)) return;
      for (const g of e.segs) out.push({seg: g.kind === "line" ? {kind: "line", a: P(g.a), b: P(g.b)} : {kind: "arc", c: P(g.c), r: r6(g.r * k), start: g.start, end: g.end, ccw: g.ccw}, id: null, entity: i});
    });
    return out;
  }
  // Entities of the chosen layers as model polylines (for graphics import).
  function polylines(result, opt = {}) {
    const S = globalThis.AtriumBoardShape, k = opt.mm ?? result.units.mm, off = opt.offset || [0, 0], layers = opt.layers ? new Set(opt.layers) : null;
    const out = [];
    for (const e of result.entities) {
      if (layers && !layers.has(e.layer)) continue;
      // Split each entity into runs of connected segments.
      const firstOutput = out.length;
      let run = [];
      const flush = () => { if (run.length) out.push({layer: e.layer, points: run, closed: false}); run = []; };
      const first = e.segs[0], full = opt.exactArcs && e.type === "CIRCLE" && e.segs.length === 2 && first.kind === "arc" && e.segs[1].kind === "arc";
      for (const g0 of full ? [{...first, end:first.start}] : e.segs) {
        const g = g0.kind === "line" ? {kind: "line", a: [g0.a[0] * k + off[0], g0.a[1] * k + off[1]], b: [g0.b[0] * k + off[0], g0.b[1] * k + off[1]]}
          : {kind: "arc", c: [g0.c[0] * k + off[0], g0.c[1] * k + off[1]], r: g0.r * k, start: g0.start, end: g0.end, ccw: g0.ccw};
        if (opt.exactArcs && g.kind === "arc") {
          flush(); out.push({layer:e.layer, arc:g, points:S.arcPoints(g,opt.tolerance || .005), closed:false});
          continue;
        }
        const pts = g.kind === "arc" ? S.arcPoints(g, opt.tolerance || .005) : [S.ends(g)[0].map(v => Math.round(v * 1e6) / 1e6), S.ends(g)[1].map(v => Math.round(v * 1e6) / 1e6)];
        const last = run[run.length - 1];
        if (last && Math.hypot(last[0] - pts[0][0], last[1] - pts[0][1]) < 1e-6) run.push(...pts.slice(1)); else { flush(); run = pts.slice(); }
      }
      flush();
      if (e.reference != null) for (let i = firstOutput; i < out.length; i++) out[i].reference = e.reference;
      if (e.closed && out.length) {
        const p = out[out.length - 1];
        if (!p.arc && p.points.length > 2 && Math.hypot(p.points[0][0] - p.points.at(-1)[0], p.points[0][1] - p.points.at(-1)[1]) < 1e-6) { p.points.pop(); p.closed = true; }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // SVG preview: one path per layer, arcs as SVG arcs, capped segment count.
  const previewPath = (segs, f) => globalThis.AtriumBoardShape.svgPath(segs, f);
  function preview(result, opt = {}) {
    const layers = opt.layers ? new Set(opt.layers) : null, max = opt.maxSegments || 40000, byLayer = new Map();
    let used = 0, truncated = false;
    for (const e of result.entities) {
      if (layers && !layers.has(e.layer)) continue;
      if (used + e.segs.length > max) { truncated = true; continue; }
      used += e.segs.length;
      (byLayer.get(e.layer) || byLayer.set(e.layer, []).get(e.layer)).push(...e.segs);
    }
    const b = boundsOf(result.entities, layers);
    const scale = b ? Math.max(b[2] - b[0], b[3] - b[1]) || 1 : 1, digits = Math.max(0, 4 - Math.floor(Math.log10(scale)));
    const f = v => +v.toFixed(Math.min(6, digits));
    return {bounds: b, truncated, paths: [...byLayer].map(([layer, segs]) => ({layer, d: previewPath(segs, f)}))};
  }

  // ---------------------------------------------------------------------------
  // Writer: R12 (AC1009) ASCII, readable by every MCAD and CAM tool.
  // entities: [{layer, segs:[model segments], closed}] in model mm (Y down).
  // opt: {units:"mm"|"in", origin:[x,y] model point mapped to (0,0), mode:"polyline"|"primitives"}
  function write(entities, opt = {}) {
    const S = globalThis.AtriumBoardShape, k = opt.units === "in" ? 25.4 : opt.units === "mil" ? .0254 : 1;
    const o = opt.origin || [0, 0], mode = opt.mode || "polyline", digits = k === 1 ? 6 : 8;
    const fx = v => String(+((v - o[0]) / k).toFixed(digits) + 0), fy = v => String(+((o[1] - v) / k).toFixed(digits) + 0), fr = v => String(+(v / k).toFixed(digits));
    const fa = v => String(+n360(v).toFixed(9));
    const out = [], layerNames = new Map();
    let circleStart = false;
    const name = l => { let s = layerNames.get(l); if (!s) { s = String(l || "0").toUpperCase().replace(/[^A-Z0-9_$-]+/g, "_").slice(0, 31) || "0"; layerNames.set(l, s); } return s; };
    const ext = [Infinity, Infinity, -Infinity, -Infinity];
    const push = (...pairs) => { for (let i = 0; i < pairs.length; i += 2) out.push(String(pairs[i]), pairs[i + 1]); };
    const halves = g => g.kind === "arc" && Math.abs(S.sweep(g)) === 360 ? S.splitArc(g, [g.start + S.sweep(g) / 2]) : [g];
    for (const e of entities) {
      const L8 = name(e.layer), segs = e.segs.flatMap(halves);
      if (!segs.length) continue;
      S.contourBounds(segs, ext);
      const full = e.segs.length === 1 && e.segs[0].kind === "arc" && Math.abs(S.sweep(e.segs[0])) === 360;
      if (full || segs.length === 2 && segs.every(g => g.kind === "arc") && e.closed && Math.abs(segs[0].r - segs[1].r) < 1e-9 && Math.abs(segs[0].c[0] - segs[1].c[0]) < 1e-9 && Math.abs(segs[0].c[1] - segs[1].c[1]) < 1e-9) {
        const g = segs[0];
        push(0, "CIRCLE", 8, L8, 10, g.ccw ? fx(g.c[0]) : String(-Number(fx(g.c[0]))), 20, fy(g.c[1]), 30, "0", 40, fr(g.r));
        if (!g.ccw) push(210,"0",220,"0",230,"-1");
        const start = fa(g.ccw ? g.start : 180-g.start);
        if (+start) { push(1001,"WAFFLE",1000,"ARC_START",1040,start); circleStart=true; }
        continue;
      }
      if (mode === "primitives") {
        for (const g of segs) {
          if (g.kind === "line") push(0, "LINE", 8, L8, 10, fx(g.a[0]), 20, fy(g.a[1]), 30, "0", 11, fx(g.b[0]), 21, fy(g.b[1]), 31, "0");
          else if (g.ccw) push(0, "ARC", 8, L8, 10, fx(g.c[0]), 20, fy(g.c[1]), 30, "0", 40, fr(g.r), 50, fa(g.start), 51, fa(g.end));
          // DXF arcs travel CCW around their extrusion axis. The negative Z axis
          // reverses traversal in the board plane and mirrors the entity's local X.
          else push(0, "ARC", 8, L8, 10, String(-Number(fx(g.c[0]))), 20, fy(g.c[1]), 30, "0", 40, fr(g.r), 50, fa(180 - g.start), 51, fa(180 - g.end), 210, "0", 220, "0", 230, "-1");
        }
        continue;
      }
      // One POLYLINE per connected run, with bulges.
      let i = 0;
      while (i < segs.length) {
        let j = i + 1;
        while (j < segs.length) { const a = S.ends(segs[j - 1])[1], b = S.ends(segs[j])[0]; if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) break; j++; }
        const run = segs.slice(i, j), first = S.ends(run[0])[0], last = S.ends(run[run.length - 1])[1];
        const closed = e.closed && i === 0 && j === segs.length && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6;
        push(0, "POLYLINE", 8, L8, 66, "1", 10, "0", 20, "0", 30, "0", 70, closed ? "1" : "0");
        for (const g of run) {
          const a = S.ends(g)[0], bl = S.bulgeOf(g);
          push(0, "VERTEX", 8, L8, 10, fx(a[0]), 20, fy(a[1]), 30, "0");
          if (bl) push(42, String(+bl.toFixed(12)));
        }
        if (!closed) push(0, "VERTEX", 8, L8, 10, fx(last[0]), 20, fy(last[1]), 30, "0");
        push(0, "SEQEND", 8, L8);
        i = j;
      }
    }
    const head = [];
    const h = (...pairs) => { for (let i = 0; i < pairs.length; i += 2) head.push(String(pairs[i]), pairs[i + 1]); };
    const code = k === 1 ? "4" : k === 25.4 ? "1" : "9";
    h(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1009", 9, "$INSUNITS", 70, code, 9, "$MEASUREMENT", 70, k === 1 ? "1" : "0");
    if (ext[0] !== Infinity) h(9, "$EXTMIN", 10, fx(ext[0]), 20, fy(ext[3]), 30, "0", 9, "$EXTMAX", 10, fx(ext[2]), 20, fy(ext[1]), 30, "0");
    h(0, "ENDSEC", 0, "SECTION", 2, "TABLES",
      0, "TABLE", 2, "LTYPE", 70, "1", 0, "LTYPE", 2, "CONTINUOUS", 70, "0", 3, "Solid line", 72, "65", 73, "0", 40, "0.0", 0, "ENDTAB",
      0, "TABLE", 2, "LAYER", 70, String(layerNames.size + 1), 0, "LAYER", 2, "0", 70, "0", 62, "7", 6, "CONTINUOUS");
    let color = 1;
    for (const nm of layerNames.values()) if (nm !== "0") h(0, "LAYER", 2, nm, 70, "0", 62, String(color++ % 255 || 1), 6, "CONTINUOUS");
    h(0, "ENDTAB");
    if (circleStart) h(0,"TABLE",2,"APPID",70,"1",0,"APPID",2,"WAFFLE",70,"0",0,"ENDTAB");
    h(0, "ENDSEC", 0, "SECTION", 2, "ENTITIES");
    return head.concat(out, ["0", "ENDSEC", "0", "EOF", ""]).join("\n");
  }

  // ---------------------------------------------------------------------------
  // Board export: outline (exact arcs) plus chosen layers and drill holes.
  function shapeLayerOf(item, s) { return globalThis.AtriumPCBAppearance?.shapeLayer?.(item, s) || s.layer || item.layer || "Top"; }
  function layersOf(doc, defs) {
    const counts = new Map(), add = l => counts.set(l, (counts.get(l) || 0) + 1);
    for (const i of doc.items) {
      if (Array.isArray(i.points) && i.points.length >= 2) add(i.layer || "Top");
      else if (i.kind === "part") { const fp = defs?.get?.(i.def)?.footprint; for (const s of fp?.shapes || []) if (s.kind === "path" || s.kind === "circle") add(shapeLayerOf(i, s)); }
    }
    return [...counts].map(([name, count]) => ({name, count})).sort((a, b) => a.name.localeCompare(b.name));
  }
  function exportBoard(doc, defs, opt = {}) {
    const S = globalThis.AtriumBoardShape, A = globalThis.Atrium, entities = [], chosen = new Set(opt.layers || []);
    const shape = S.current(doc);
    if (opt.outline !== false && shape) {
      const L8 = opt.outlineLayer || "BOARD_OUTLINE";
      for (const contour of S.profileContours(shape)) entities.push({layer:L8, segs:contour, closed:true});
      opt.sourceEntity?.("Board profile", doc.id + "/outline", "kept");
    }
    for (const i of (globalThis.AtriumPCBDraw ? AtriumPCBDraw.forExport(doc, {units: opt.units === "mil" ? "mil" : "mm"}) : doc).items) {
      if (Array.isArray(i.points) && i.points.length >= 2 && chosen.has(i.layer || "Top")) {
        const arc = A.pathArc(i);
        entities.push({layer: i.layer || "Top", segs: arc ? [arc] : S.polySegments(i.points, !!i.closed, {fitArcs: true}), closed: !!i.closed});
        opt.sourceEntity?.(i.kind, i.id, i.fill || i.width > 0 ? "approximated" : "kept");
      } else if (i.kind === "part" && chosen.size) {
        const fp = defs?.get?.(i.def)?.footprint;
        let member = 0;
        for (const s of fp?.shapes || []) {
          member++;
          const l = shapeLayerOf(i, s);
          if (!chosen.has(l)) continue;
          if (s.kind === "path" && s.points?.length >= 2) {
            const arc = A.pathArc(s), place = p => A.world(p, i);
            opt.sourceEntity?.("Footprint graphic", i.id + "/graphic/" + member, s.width > 0 || s.fill ? "approximated" : "kept");
            entities.push({layer:l, segs:arc ? [A.transformArc(arc, place, i.angle || 0, !!i.mirror)] : S.polySegments(s.points.map(place), !!s.closed, {fitArcs:true}), closed:!!s.closed});
          }
          else if (s.kind === "circle" && s.r > 0) { opt.sourceEntity?.("Footprint circle", i.id + "/graphic/" + member, s.width > 0 || s.fill ? "approximated" : "kept"); const c = A.world([s.x, s.y], i); entities.push({layer: l, segs: [S.arc(c, s.r, 0, 0, true)], closed: true}); }
        }
      }
    }
    if (opt.holes) {
      const hole = (point, pad, parent) => {
        entities.push({layer: opt.holeLayer || "HOLES", segs: [S.arc(point, pad.drill / 2, 0, 0, true)], closed: true});
        opt.sourceEntity?.("Hole", parent ? parent.id + "/pad/" + pad.number : pad.id, pad.slotLength > pad.drill ? "approximated" : "kept");
      };
      for (const i of doc.items) {
        if ((i.kind === "pad" || i.kind === "via") && i.drill > 0) hole([i.x, i.y], i);
        else if (i.kind === "part") for (const p of defs?.get?.(i.def)?.footprint?.pads || []) if (p.drill > 0) hole(A.world([p.x, p.y], i), p, i);
      }
    }
    let origin = [0, 0];
    if (opt.origin === "board" && shape) { const b = S.bounds(shape); origin = [b[0], b[3]]; }
    else if (opt.origin === "user" && doc.origin) origin = doc.origin;
    return {text: write(entities, {units: opt.units, mode: opt.mode, origin}), entities: entities.length};
  }

  return {read, segments, polylines, preview, previewPath, write, exportBoard, layersOf, bulgeSeg, INSUNITS, UNIT_NAMES, UNITS};
})();
