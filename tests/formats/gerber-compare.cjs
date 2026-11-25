"use strict";
// Geometric Gerber / Excellon comparator. No dependencies; runs under node
// and under the JavaScriptCore shim (tests/jsc-shim.js).
//
// Two CAM tools never write byte-identical files (headers, aperture numbers,
// coordinate formats, draw order and drawing style differ), so the comparison
// is of the plotted image, not of the text:
//
//   parseGerber(text)      RS-274X with X2 attributes: FS/MO (and legacy
//                          G70/G71), AD (C, R, O, P with optional hole), AM
//                          macros (primitives 0, 1, 4, 5, 7, 20, 21 with
//                          $variables and arithmetic), LP polarity, SR
//                          step-repeat, G01/G02/G03 with G74/G75, G36/G37
//                          regions, D01/D02/D03 (also the deprecated bare D03
//                          and G54Dnn). Attributes are kept as text.
//   parseExcellon(text)    Excellon 1/2 as written by Altium, KiCad and
//                          Waffle: INCH/METRIC with LZ/TZ and FILE_FORMAT=i:d,
//                          or decimal coordinates; tools TnC<d>; modal hits;
//                          G85 slots and G00/M15/M16 routed slots.
//   rasterize(shapes, g)   paints every object, in order and with its polarity,
//                          into a 1-byte-per-pixel image (pixel centres
//                          sampled; nonzero winding for regions).
//   compareImages(a, b, g) XOR area and the maximum deviation: the largest
//                          distance from a pixel set in only one image to the
//                          nearest pixel set in the other (a one-pixel
//                          quantised Hausdorff distance), plus XOR components.
//   compareFlashes / compareDrills / compareOutlines: object-level matching
//                          with exact deviations in µm (no raster quantisation).
//
// All geometry is in millimetres, Y up, in each file's own coordinate system.
const MM_PER_IN = 25.4;

// ---------------------------------------------------------------------------
// Small geometry helpers.
function rot(p, deg) {
  if (!deg) return p;
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}
function circlePoly(cx, cy, r, chord) {
  // Chord error ≤ chord (mm).
  const n = Math.max(16, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - Math.min(chord, r) / r))));
  const out = [];
  for (let k = 0; k < n; k++) { const a = 2 * Math.PI * k / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}
function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
// Points along an arc from a to b around c; cw = clockwise. Full circle when a == b in G75 mode.
function arcPoints(a, b, c, cw, full, chord) {
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]), r2 = Math.hypot(b[0] - c[0], b[1] - c[1]);
  let a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  let sweep = cw ? a0 - a1 : a1 - a0;
  while (sweep < 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  if (full && sweep < 1e-12) sweep = 2 * Math.PI;
  const R = Math.max(r, r2, 1e-9), step = 2 * Math.acos(Math.max(-1, 1 - Math.min(chord, R) / R));
  const n = Math.max(1, Math.ceil(sweep / Math.max(step, 1e-4)));
  const out = [];
  for (let k = 1; k <= n; k++) {
    const t = k / n, ang = a0 + (cw ? -1 : 1) * sweep * t, rr = r + (r2 - r) * t;
    out.push(k === n ? [b[0], b[1]] : [c[0] + rr * Math.cos(ang), c[1] + rr * Math.sin(ang)]);
  }
  return {points: out, radius: r, radiusMismatch: Math.abs(r - r2)};
}

// ---------------------------------------------------------------------------
// Aperture macro expressions: numbers, $n, + - x X / and parentheses.
function evalExpr(src, vars) {
  const s = src.replace(/\s+/g, ""); let i = 0;
  const peek = () => s[i];
  function atom() {
    if (peek() === "(") { i++; const v = sum(); if (s[i] !== ")") throw Error("macro expression: missing ) in " + src); i++; return v; }
    if (peek() === "-") { i++; return -atom(); }
    if (peek() === "+") { i++; return atom(); }
    if (peek() === "$") { const m = /^\$(\d+)/.exec(s.slice(i)); if (!m) throw Error("macro expression: bad variable in " + src); i += m[0].length; return vars[+m[1]] ?? 0; }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) throw Error("macro expression: unexpected '" + (peek() ?? "end") + "' in " + src);
    i += m[0].length; return +m[1];
  }
  function product() { let v = atom(); while (peek() === "x" || peek() === "X" || peek() === "/") { const op = s[i++]; const w = atom(); v = op === "/" ? v / w : v * w; } return v; }
  function sum() { let v = product(); while (peek() === "+" || peek() === "-") { const op = s[i++]; const w = product(); v = op === "+" ? v + w : v - w; } return v; }
  const v = sum();
  if (i !== s.length) throw Error("macro expression: trailing text in " + src);
  return v;
}

// ---------------------------------------------------------------------------
// Gerber parser. Returns {units, shapes, flashes, draws, regions, attributes,
// warnings, bbox}. Each shape is a paint operation in mm:
//   {k: "poly", rings: [[[x, y], ...], ...], dark}     (nonzero winding over all rings)
//   {k: "circle", x, y, r, dark}
//   {k: "capsule", x1, y1, x2, y2, r, dark}
// flashes: [{x, y, ap: {type, params, macro}, outline: shapes, dark, fn}] for object matching.
function parseGerber(text, options = {}) {
  const chord = options.chord ?? 0.0005;
  const warnings = [], shapes = [], flashes = [], draws = [], regions = [], attributes = {file: {}, apertureFunctions: {}};
  let fmt = null, toMM = null, units = null;
  const apertures = new Map(), macros = new Map();
  let cur = [0, 0], ap = null, interp = "G01", quadrant = "G75", region = false, contour = null, contours = [], dark = true;
  let sr = null; // {x, y, i, j, start}
  let regionCount = 0, drawCount = 0, flashCount = 0, arcDrawCount = 0, arcRegionCount = 0, apFn = null;
  const setUnits = u => { units = u; toMM = u === "in" ? MM_PER_IN : 1; };
  function coord(str, axis) {
    if (str == null) return null;
    if (!fmt) { warnings.push("coordinate before %FS; assuming 2:6 leading-zero omission"); fmt = {zeros: "L", x: [2, 6], y: [2, 6]}; }
    if (!toMM) { warnings.push("coordinate before units; assuming mm"); setUnits("mm"); }
    if (str.includes(".")) return +str * toMM;
    const [ip, dp] = fmt[axis], neg = str.startsWith("-"), digits = str.replace(/^[+-]/, "");
    let v;
    if (fmt.zeros === "T") v = +(digits.padEnd(ip + dp, "0")) / 10 ** dp;
    else v = +digits / 10 ** dp;
    return (neg ? -v : v) * toMM;
  }
  function apertureShapes(a, at, isDark) {
    // Paint operations of a flash of aperture a at point at.
    const [x, y] = at, p = a.params.map(v => v * toMM), out = [];
    const hole = (h) => { if (h > 0) out.push({k: "circle", x, y, r: h / 2, dark: !isDark, hole: true}); };
    if (a.type === "C") { out.push({k: "circle", x, y, r: p[0] / 2, dark: isDark}); hole(p[1]); }
    else if (a.type === "R") { const w = p[0] / 2, h = p[1] / 2; out.push({k: "poly", rings: [[[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]]], dark: isDark}); hole(p[2]); }
    else if (a.type === "O") {
      const w = p[0], h = p[1], r = Math.min(w, h) / 2;
      if (w >= h) out.push({k: "capsule", x1: x - (w / 2 - r), y1: y, x2: x + (w / 2 - r), y2: y, r, dark: isDark});
      else out.push({k: "capsule", x1: x, y1: y - (h / 2 - r), x2: x, y2: y + (h / 2 - r), r, dark: isDark});
      hole(p[2]);
    } else if (a.type === "P") {
      const R = p[0] / 2, n = Math.round(a.params[1]), r0 = a.params[2] || 0, ring = [];
      for (let k = 0; k < n; k++) { const ang = (r0 + 360 * k / n) * Math.PI / 180; ring.push([x + R * Math.cos(ang), y + R * Math.sin(ang)]); }
      out.push({k: "poly", rings: [ring], dark: isDark}); hole((a.params[3] || 0) * toMM);
    } else if (a.type === "M") {
      const vars = [0, ...a.params];
      for (const prim of a.macro) {
        if (prim.assign) { vars[prim.assign] = evalExpr(prim.expr, vars); continue; }
        const v = prim.args.map(e => evalExpr(e, vars)), code = prim.code;
        if (code === 0) continue;
        const exp = v[0] === 1 ? isDark : v[0] === 0 ? !isDark : isDark;
        const T = (q, r) => { const t = rot(q, r); return [x + t[0] * toMM, y + t[1] * toMM]; };
        if (code === 1) { const c = T([v[2], v[3]], v[4] || 0); out.push({k: "circle", x: c[0], y: c[1], r: v[1] * toMM / 2, dark: exp}); }
        else if (code === 20) {
          const [, w, xs, ys, xe, ye, r] = v, dx = xe - xs, dy = ye - ys, l = Math.hypot(dx, dy) || 1, nx = -dy / l * w / 2, ny = dx / l * w / 2;
          out.push({k: "poly", rings: [[T([xs + nx, ys + ny], r), T([xe + nx, ye + ny], r), T([xe - nx, ye - ny], r), T([xs - nx, ys - ny], r)]], dark: exp});
        } else if (code === 21) {
          const [, w, h, cx, cy, r] = v;
          out.push({k: "poly", rings: [[T([cx - w / 2, cy - h / 2], r), T([cx + w / 2, cy - h / 2], r), T([cx + w / 2, cy + h / 2], r), T([cx - w / 2, cy + h / 2], r)]], dark: exp});
        } else if (code === 4) {
          const n = Math.round(v[1]), ring = [];
          for (let k = 0; k <= n; k++) ring.push(T([v[2 + 2 * k], v[3 + 2 * k]], v[4 + 2 * n] || 0));
          out.push({k: "poly", rings: [ring.slice(0, -1)], dark: exp});
        } else if (code === 5) {
          const n = Math.round(v[1]), ring = [];
          for (let k = 0; k < n; k++) { const ang = 2 * Math.PI * k / n; ring.push(T([v[2] + v[4] / 2 * Math.cos(ang), v[3] + v[4] / 2 * Math.sin(ang)], v[5] || 0)); }
          out.push({k: "poly", rings: [ring], dark: exp});
        } else if (code === 7) {
          // Thermal: outer ring minus inner circle minus a cross of gaps, as polygons (dark only).
          const [cx, cy, od, id, gap, r] = v.slice(0), steps = 180, ro = od / 2, ri = id / 2, g = gap / 2;
          for (let q = 0; q < 4; q++) {
            const ring = [], a0 = q * Math.PI / 2, a1 = a0 + Math.PI / 2;
            const ao = Math.asin(Math.min(1, g / ro)), ai = Math.asin(Math.min(1, g / Math.max(ri, 1e-9)));
            for (let k = 0; k <= steps; k++) { const t = a0 + ao + (a1 - a0 - 2 * ao) * k / steps; ring.push(T([cx + ro * Math.cos(t), cy + ro * Math.sin(t)], r)); }
            for (let k = steps; k >= 0; k--) { const t = a0 + ai + (a1 - a0 - 2 * ai) * k / steps; ring.push(T([cx + ri * Math.cos(t), cy + ri * Math.sin(t)], r)); }
            out.push({k: "poly", rings: [ring], dark: exp});
          }
        } else warnings.push("macro primitive " + code + " is not supported");
      }
    } else warnings.push("aperture type " + a.type + " is not supported");
    return out;
  }
  // The outline a drawing aperture sweeps (relative to the draw point): circle radius, or a convex polygon.
  function sweepOf(a) {
    const p = a.params.map(v => v * toMM);
    if (a.type === "C") return {r: p[0] / 2};
    if (a.type === "R") { const w = p[0] / 2, h = p[1] / 2; return {poly: [[-w, -h], [w, -h], [w, h], [-w, h]]}; }
    if (a.type === "O") { const r = Math.min(p[0], p[1]) / 2; return {poly: hull([...circlePoly(-(p[0] / 2 - r), 0, r, chord), ...circlePoly(p[0] / 2 - r, 0, r, chord)].map(q => p[0] >= p[1] ? q : [q[1], q[0]]))}; }
    warnings.push("drawing with a non-circular, non-rectangular aperture: swept as its bounding circle");
    return {r: Math.max(p[0] || 0, p[1] || 0) / 2};
  }
  const sweepWidth = a => a.type === "C" ? a.params[0] * toMM : Math.min(a.params[0] || 0, a.params[1] ?? a.params[0] ?? 0) * toMM;
  function segment(a, b) {
    if (!ap) { warnings.push("draw without an aperture"); return; }
    const s = sweepOf(ap);
    if (s.r != null) shapes.push({k: "capsule", x1: a[0], y1: a[1], x2: b[0], y2: b[1], r: s.r, dark});
    else shapes.push({k: "poly", rings: [hull([...s.poly.map(q => [a[0] + q[0], a[1] + q[1]]), ...s.poly.map(q => [b[0] + q[0], b[1] + q[1]])])], dark});
  }
  function arcTo(to, ij) {
    const cw = interp === "G02";
    let c;
    if (quadrant === "G75") c = [cur[0] + ij[0], cur[1] + ij[1]];
    else {
      // G74 single quadrant: unsigned offsets; choose the signs giving a ≤ 90° arc with matching radii.
      let best = null;
      for (const sx of [1, -1]) for (const sy of [1, -1]) {
        const cc = [cur[0] + sx * Math.abs(ij[0]), cur[1] + sy * Math.abs(ij[1])];
        const r1 = Math.hypot(cur[0] - cc[0], cur[1] - cc[1]), r2 = Math.hypot(to[0] - cc[0], to[1] - cc[1]);
        let a0 = Math.atan2(cur[1] - cc[1], cur[0] - cc[0]), a1 = Math.atan2(to[1] - cc[1], to[0] - cc[0]);
        let sw = cw ? a0 - a1 : a1 - a0; while (sw < 0) sw += 2 * Math.PI;
        const e = Math.abs(r1 - r2) + (sw > Math.PI / 2 + 1e-6 ? 1e3 : 0);
        if (!best || e < best.e) best = {e, cc};
      }
      c = best.cc;
    }
    const arc = arcPoints(cur, to, c, cw, quadrant === "G75", chord);
    if (options.verifyArcs) {
      const tick = Math.hypot(10 ** -fmt.x[1], 10 ** -fmt.y[1]) * toMM;
      if (!arc.radius || !arc.points.length || arc.radiusMismatch > 2 * tick + 1e-9)
        warnings.push("invalid circular interpolation");
    }
    return arc;
  }
  function closeRegion() {
    if (contour && contour.length >= 3) contours.push(contour);
    contour = null;
  }
  function endSR() {
    if (!sr) return;
    const block = shapes.slice(sr.start), fl = flashes.slice(sr.flashStart);
    for (let xi = 0; xi < sr.x; xi++) for (let yi = 0; yi < sr.y; yi++) {
      if (!xi && !yi) continue;
      const dx = xi * sr.i, dy = yi * sr.j;
      for (const s of block) shapes.push(moveShape(s, dx, dy));
      for (const f of fl) flashes.push({...f, x: f.x + dx, y: f.y + dy, shapes: f.shapes.map(s => moveShape(s, dx, dy))});
    }
    sr = null;
  }
  // Split into commands: extended (%...%) blocks and word commands ending in *.
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r" || ch === " " || ch === "\t") { i++; continue; }
    if (ch === "%") {
      const end = text.indexOf("%", i + 1);
      if (end < 0) { warnings.push("unterminated extended command"); break; }
      const body = text.slice(i + 1, end).replace(/[\r\n]/g, "");
      i = end + 1;
      const cmds = body.split("*").filter(s => s.length);
      if (!cmds.length) continue;
      const head = cmds[0];
      if (head.startsWith("FS")) {
        const m = /^FS([LTD])?([AI])?X(\d)(\d)Y(\d)(\d)/.exec(head);
        if (!m) { warnings.push("bad FS " + head); continue; }
        if (m[2] === "I") warnings.push("incremental coordinates (FS..I) are not supported");
        fmt = {zeros: m[1] === "T" ? "T" : "L", x: [+m[3], +m[4]], y: [+m[5], +m[6]]};
      } else if (head.startsWith("MO")) setUnits(head.slice(2) === "IN" ? "in" : "mm");
      else if (head.startsWith("AD")) {
        const m = /^ADD(\d+)([^,]+)(?:,(.*))?$/.exec(head);
        if (!m) { warnings.push("bad AD " + head); continue; }
        const name = m[2], params = m[3] ? m[3].split("X").map(Number) : [];
        const std = /^[CROP]$/.test(name);
        apertures.set(+m[1], {code: +m[1], type: std ? name : "M", name, params, macro: std ? null : macros.get(name), fn: apFn});
        if (!std && !macros.has(name)) warnings.push("aperture macro " + name + " is not defined");
      } else if (head.startsWith("AM")) {
        const name = head.slice(2), prims = [];
        for (const c of cmds.slice(1)) {
          const t = c.trim();
          if (!t || t.startsWith("0 ") || t === "0") continue;
          const asg = /^\$(\d+)=(.*)$/.exec(t);
          if (asg) { prims.push({assign: +asg[1], expr: asg[2]}); continue; }
          const parts = t.split(",");
          prims.push({code: +parts[0], args: parts.slice(1)});
        }
        macros.set(name, prims);
      } else if (head.startsWith("LP")) dark = head[2] !== "C";
      else if (head.startsWith("SR")) {
        endSR();
        const m = /^SR(?:X(\d+)Y(\d+)I([\d.+-]+)J([\d.+-]+))?$/.exec(head);
        if (m && m[1] && (+m[1] > 1 || +m[2] > 1)) sr = {x: +m[1], y: +m[2], i: +m[3] * (toMM || 1), j: +m[4] * (toMM || 1), start: shapes.length, flashStart: flashes.length};
      } else if (head.startsWith("TF")) { const [k, ...v] = head.slice(2).split(","); attributes.file[k] = v.join(","); }
      else if (head.startsWith("TA")) { const [k, ...v] = head.slice(2).split(","); if (k === ".AperFunction") apFn = v.join(","); }
      else if (head.startsWith("TD")) { if (head === "TD" || head === "TD.AperFunction") apFn = null; }
      else if (head.startsWith("TO")) { /* object attributes: not geometry */ }
      else if (/^(IP|MI|OF|SF|IR|AS|IN|LN)/.test(head)) { if (!/^(IN|LN)/.test(head) && !/^(IPPOS|MIA0B0|OFA0B0|SFA1B1|IR0|ASAXBY)$/.test(head)) warnings.push("deprecated image command " + head + " is ignored"); }
      else if (/^L[MRS]/.test(head)) { if (!/^(LMN|LR0|LS1)$/.test(head)) warnings.push("object transformation " + head + " is not supported"); }
      else warnings.push("unknown extended command " + head.slice(0, 12));
      continue;
    }
    const end = text.indexOf("*", i);
    if (end < 0) break;
    let w = text.slice(i, end).replace(/[\r\n\s]/g, "");
    i = end + 1;
    if (!w) continue;
    if (w.startsWith("G04")) continue;
    if (w === "M02" || w === "M00" || w === "M01") { if (w === "M02") break; continue; }
    // Modal G codes may prefix a data block.
    let g;
    while ((g = /^G(\d+)/.exec(w))) {
      const code = +g[1];
      w = w.slice(g[0].length);
      if (code === 1 || code === 2 || code === 3) interp = "G0" + code;
      else if (code === 74 || code === 75) quadrant = "G" + code;
      else if (code === 36) { region = true; contour = null; contours = []; }
      else if (code === 37) {
        closeRegion();
        if (contours.length) { for (const c of contours) { shapes.push({k: "poly", rings: [c], dark}); regions.push({ring: c, dark}); } regionCount += contours.length; }
        region = false; contours = [];
      } else if (code === 70) setUnits("in");
      else if (code === 71) setUnits("mm");
      else if (code === 90 || code === 54 || code === 55) { /* absolute / deprecated select prefix */ }
      else if (code === 91) warnings.push("incremental mode (G91) is not supported");
      else warnings.push("G" + code + " is not supported");
    }
    if (!w) continue;
    const dm = /^D(\d+)$/.exec(w);
    if (dm && +dm[1] >= 10) { ap = apertures.get(+dm[1]) || null; if (!ap) warnings.push("D" + dm[1] + " selected but not defined"); continue; }
    const m = /^(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?(?:I([+-]?[\d.]+))?(?:J([+-]?[\d.]+))?(?:D0*([123]))?$/.exec(w);
    if (!m) { warnings.push("unparsed block " + w.slice(0, 20)); continue; }
    const to = [m[1] != null ? coord(m[1], "x") : cur[0], m[2] != null ? coord(m[2], "y") : cur[1]];
    const ij = [m[3] != null ? coord(m[3], "x") : 0, m[4] != null ? coord(m[4], "y") : 0];
    const d = m[5] ? +m[5] : (m[1] != null || m[2] != null ? 1 : 0); // deprecated: coordinates without D use D01
    if (d === 2) {
      if (region) { closeRegion(); contour = [to.slice()]; }
      cur = to;
    } else if (d === 1) {
      if (region) {
        if (!contour) contour = [cur.slice()];
        if (interp === "G01") contour.push(to.slice());
        else { arcRegionCount++; contour.push(...arcTo(to, ij).points); }
      } else {
        drawCount++;
        if (interp === "G01") { segment(cur, to); draws.push({points: [cur.slice(), to.slice()], ap, width: ap ? sweepWidth(ap) : 0}); }
        else {
          arcDrawCount++;
          const pts = arcTo(to, ij).points;
          let p0 = cur;
          for (const q of pts) { segment(p0, q); p0 = q; }
          draws.push({points: [cur.slice(), ...pts], ap, width: ap ? sweepWidth(ap) : 0, arc: true});
        }
      }
      cur = to;
    } else if (d === 3) {
      cur = to;
      if (!ap) { warnings.push("flash without an aperture"); continue; }
      const s = apertureShapes(ap, to, dark);
      shapes.push(...s);
      flashCount++;
      flashes.push({x: to[0], y: to[1], ap, shapes: s, dark, fn: ap.fn});
    }
  }
  endSR();
  if (region) warnings.push("file ended inside a region");
  return {units, format: fmt, shapes, flashes, draws, regions, regionCount, drawCount, flashCount,
    arcDrawCount, arcRegionCount, attributes, warnings, bbox: bboxOf(shapes)};
}
function moveShape(s, dx, dy) {
  if (s.k === "circle") return {...s, x: s.x + dx, y: s.y + dy};
  if (s.k === "capsule") return {...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy};
  return {...s, rings: s.rings.map(r => r.map(p => [p[0] + dx, p[1] + dy]))};
}
function shapeBox(s) {
  if (s.k === "circle") return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r];
  if (s.k === "capsule") return [Math.min(s.x1, s.x2) - s.r, Math.min(s.y1, s.y2) - s.r, Math.max(s.x1, s.x2) + s.r, Math.max(s.y1, s.y2) + s.r];
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of s.rings) for (const p of r) b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])];
  return b;
}
function bboxOf(shapes, darkOnly = true) {
  let b = null;
  for (const s of shapes) {
    if (darkOnly && !s.dark) continue;
    const q = shapeBox(s);
    b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q;
  }
  return b;
}

// ---------------------------------------------------------------------------
// Excellon parser. Returns {units, tools: {T: {d, plated}}, hits: [{x, y, d, tool, plated}], slots: [...], warnings}.
function parseExcellon(text) {
  const warnings = [], tools = {}, hits = [], slots = [], missingTools = new Set();
  let units = null, zeros = "LZ", fmt = null, header = false, tool = null, cur = [0, 0], plated = null, route = false, routeStart = null;
  const lines = text.split(/\r?\n/);
  const scale = () => units === "in" ? MM_PER_IN : 1;
  function selectedTool() {
    const cutter = tools[tool];
    if (!cutter && !missingTools.has(tool)) {
      warnings.push(tool == null ? "drill coordinate without a selected tool" : "T" + tool + " has no defined diameter");
      missingTools.add(tool);
    }
    return cutter;
  }
  function num(s, axis) {
    if (s == null) return null;
    if (s.includes(".")) return +s * scale();
    const f = fmt || (units === "in" ? [2, 4] : [3, 3]), neg = s.startsWith("-"), dg = s.replace(/^[+-]/, "");
    // LZ: leading zeros kept, trailing omitted (pad right). TZ: trailing kept (value = int / 10^dp).
    const v = zeros === "LZ" ? +dg.padEnd(f[0] + f[1], "0") / 10 ** f[1] : +dg / 10 ** f[1];
    return (neg ? -v : v) * scale();
  }
  for (const raw of lines) {
    let l = raw.trim();
    if (!l) continue;
    if (l.startsWith(";")) {
      const ff = /FILE_FORMAT=(\d):(\d)/.exec(l); if (ff) fmt = [+ff[1], +ff[2]];
      const ty = /TYPE=(PLATED|NON_PLATED)/.exec(l); if (ty) plated = ty[1] === "PLATED";
      const x2 = /TF\.FileFunction,(Plated|NonPlated)/.exec(l); if (x2) plated = x2[1] === "Plated";
      continue;
    }
    if (l === "M48") { header = true; continue; }
    if (l === "%" || l === "M95") { header = false; continue; }
    const u = /^(INCH|METRIC)(?:,(LZ|TZ))?(?:,(0*)\.(0*))?/.exec(l);
    if (u) { units = u[1] === "INCH" ? "in" : "mm"; if (u[2]) zeros = u[2]; if (u[3] != null && u[4] != null && (u[3].length || u[4].length)) fmt = [u[3].length, u[4].length]; continue; }
    if (l === "M72") { units = "in"; continue; }
    if (l === "M71") { units = "mm"; continue; }
    const td = /^T0*(\d+)(?:F\d+)?(?:S\d+)?C([\d.]+)/.exec(l);
    if (td) {
      const id = +td[1], d = +td[2] * scale();
      if (Number.isFinite(d) && d > 0) tools[id] = {d, plated};
      else { delete tools[id]; warnings.push("T" + id + " has an invalid diameter"); }
      if (!header) tool = id;
      continue;
    }
    const ts = /^T0*(\d+)$/.exec(l);
    if (ts) { tool = +ts[1] || null; continue; }
    if (/^(G90|G05|M30|M00|FMAT,\d|ICI,OFF|VER,\d|DETECT,ON|ATC,ON)$/.test(l)) continue;
    if (l === "G00" || /^G00X/.test(l)) { route = true; l = l.replace(/^G00/, ""); if (!l) continue; }
    if (l === "M15") { routeStart = cur.slice(); continue; }
    if (l === "M16" || l === "M17") { routeStart = null; continue; }
    const sl = /^X([+-]?[\d.]+)?Y?([+-]?[\d.]+)?G85X([+-]?[\d.]+)?Y?([+-]?[\d.]+)?$/.exec(l.replace(/^(X[^Y]*)?(Y[^G]*)?G85(X[^Y]*)?(Y.*)?$/, (all, a, b, c, d2) => "X" + (a ? a.slice(1) : "") + "Y" + (b ? b.slice(1) : "") + "G85X" + (c ? c.slice(1) : "") + "Y" + (d2 ? d2.slice(1) : "")));
    if (/G85/.test(l) && sl) {
      const a = [sl[1] ? num(sl[1], 0) : cur[0], sl[2] ? num(sl[2], 1) : cur[1]];
      const b = [sl[3] ? num(sl[3], 0) : a[0], sl[4] ? num(sl[4], 1) : a[1]];
      if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) { warnings.push("invalid slot coordinate"); continue; }
      const cutter = selectedTool();
      if (cutter) slots.push({a, b, d: cutter.d, tool, plated: cutter.plated ?? plated});
      cur = b; continue;
    }
    const m = /^(?:G01)?(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?$/.exec(l);
    if (m && (m[1] != null || m[2] != null)) {
      const p = [m[1] != null ? num(m[1], 0) : cur[0], m[2] != null ? num(m[2], 1) : cur[1]];
      if (!p.every(Number.isFinite)) { warnings.push("invalid drill coordinate"); continue; }
      if (routeStart && /^G01/.test(l)) {
        const cutter = selectedTool();
        if (cutter) slots.push({a: cur.slice(), b: p, d: cutter.d, tool, plated: cutter.plated ?? plated});
        cur = p; continue;
      }
      cur = p;
      if (route) { route = false; continue; }
      const cutter = selectedTool();
      if (cutter) hits.push({x: p[0], y: p[1], d: cutter.d, tool, plated: cutter.plated ?? plated});
      continue;
    }
    warnings.push("unparsed drill line " + l.slice(0, 24));
  }
  return {units, tools, hits, slots, warnings};
}

// ---------------------------------------------------------------------------
// Raster. grid = {x0, y0, s, w, h}: pixel (i, j) has its centre at
// (x0 + (i + .5) s, y0 + (j + .5) s).
// phase (a fraction of a pixel) shifts the pixel centres off the round coordinates that CAD
// edges sit on, so an edge moved by format rounding (0.1 µm) does not flip a whole row of pixels.
function gridFor(boxes, s, margin = .2, phase = 0) {
  let b = null;
  for (const q of boxes) if (q) b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q.slice();
  if (!b) b = [0, 0, 1, 1];
  const x0 = (Math.floor((b[0] - margin) / s) - phase) * s, y0 = (Math.floor((b[1] - margin) / s) - phase) * s;
  return {x0, y0, s, w: Math.ceil((b[2] + margin - x0) / s), h: Math.ceil((b[3] + margin - y0) / s)};
}
function rasterize(shapes, g, img) {
  const {x0, y0, s, w, h} = g;
  img = img || new Uint8Array(w * h);
  const span = (j, xlo, xhi, v) => {
    if (j < 0 || j >= h || !(xhi >= xlo)) return;
    let a = Math.ceil((xlo - x0) / s - .5), b = Math.floor((xhi - x0) / s - .5);
    if (a < 0) a = 0; if (b > w - 1) b = w - 1;
    if (b >= a) img.fill(v, j * w + a, j * w + b + 1);
  };
  const rowsOf = (ylo, yhi) => [Math.max(0, Math.ceil((ylo - y0) / s - .5)), Math.min(h - 1, Math.floor((yhi - y0) / s - .5))];
  const cy = j => y0 + (j + .5) * s;
  for (const sh of shapes) {
    const v = sh.dark ? 1 : 0;
    if (sh.k === "circle") {
      const [j0, j1] = rowsOf(sh.y - sh.r, sh.y + sh.r);
      for (let j = j0; j <= j1; j++) { const dy = cy(j) - sh.y, q = sh.r * sh.r - dy * dy; if (q >= 0) { const dx = Math.sqrt(q); span(j, sh.x - dx, sh.x + dx, v); } }
    } else if (sh.k === "capsule") {
      const {x1, y1, x2, y2, r} = sh, dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
      const [j0, j1] = rowsOf(Math.min(y1, y2) - r, Math.max(y1, y2) + r);
      const nx = L ? -dy / L * r : 0, ny = L ? dx / L * r : 0;
      const quad = L ? [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]] : null;
      for (let j = j0; j <= j1; j++) {
        const y = cy(j); let lo = Infinity, hi = -Infinity;
        for (const [px, py] of [[x1, y1], [x2, y2]]) { const q = r * r - (y - py) * (y - py); if (q >= 0) { const e = Math.sqrt(q); lo = Math.min(lo, px - e); hi = Math.max(hi, px + e); } }
        if (quad) for (let k = 0; k < 4; k++) {
          const a = quad[k], b = quad[(k + 1) % 4];
          if ((a[1] <= y) !== (b[1] <= y)) { const x = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]); lo = Math.min(lo, x); hi = Math.max(hi, x); }
        }
        if (hi >= lo) span(j, lo, hi, v);
      }
    } else {
      const box = shapeBox(sh), [j0, j1] = rowsOf(box[1], box[3]);
      if (j1 < j0) continue;
      const buckets = new Array(j1 - j0 + 1);
      for (const ring of sh.rings) for (let k = 0, n = ring.length; k < n; k++) {
        const a = ring[k], b = ring[(k + 1) % n];
        if (a[1] === b[1]) continue;
        const dir = b[1] > a[1] ? 1 : -1, ylo = Math.min(a[1], b[1]), yhi = Math.max(a[1], b[1]);
        // Rows whose centre y satisfies ylo <= y < yhi (half-open).
        const r0 = Math.max(j0, Math.ceil((ylo - y0) / s - .5)), r1 = Math.min(j1, Math.ceil((yhi - y0) / s - .5) - 1);
        for (let j = r0; j <= r1; j++) {
          const y = cy(j), x = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
          (buckets[j - j0] ||= []).push(x, dir);
        }
      }
      for (let j = j0; j <= j1; j++) {
        const list = buckets[j - j0];
        if (!list) continue;
        const idx = []; for (let k = 0; k < list.length; k += 2) idx.push(k);
        idx.sort((p, q) => list[p] - list[q]);
        let wind = 0, start = 0;
        for (const k of idx) {
          const before = wind; wind += list[k + 1];
          if (before === 0 && wind !== 0) start = list[k];
          else if (before !== 0 && wind === 0) span(j, start, list[k], v);
        }
      }
    }
  }
  return img;
}
function count(img) { let n = 0; for (let k = 0; k < img.length; k++) n += img[k]; return n; }

// Exact 2D Euclidean distance (in pixels) from each pixel flagged in `query`
// to the nearest set pixel of `target`, using a vertical scan then the
// Felzenszwalb-Huttenlocher lower envelope on the rows that hold query pixels.
// Only the query box grown by capPx is scanned: distances beyond capPx are
// reported as capPx or more (Infinity when no target is that close).
// Returns {max} over the query pixels.
function distances(target, query, g, rows, box, capPx = 400) {
  const {w, h} = g, INF = 65535;
  const X0 = Math.max(0, box[0] - capPx), X1 = Math.min(w - 1, box[2] + capPx), Y0 = Math.max(0, box[1] - capPx), Y1 = Math.min(h - 1, box[3] + capPx);
  const ww = X1 - X0 + 1, hh = Y1 - Y0 + 1, col = new Uint16Array(ww * hh);
  for (let x = 0; x < ww; x++) {
    let d = INF;
    for (let y = 0; y < hh; y++) { const k = y * ww + x; d = target[(y + Y0) * w + x + X0] ? 0 : d === INF ? INF : d + 1; col[k] = d; }
    d = INF;
    for (let y = hh - 1; y >= 0; y--) { const k = y * ww + x; d = target[(y + Y0) * w + x + X0] ? 0 : d === INF ? INF : d + 1; if (d < col[k]) col[k] = d; }
  }
  const f = new Float64Array(ww), v = new Int32Array(ww), z = new Float64Array(ww + 1);
  let max = 0;
  for (const y of rows) {
    const base = (y - Y0) * ww, qbase = y * w + X0;
    // Lower envelope of the parabolas (x - p)^2 + f[p] over columns with a finite f.
    let k = -1;
    for (let q = 0; q < ww; q++) {
      const c = col[base + q];
      if (c === INF) continue;
      f[q] = c * c;
      if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
      let sct;
      while (true) {
        const p = v[k];
        sct = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (sct <= z[k] && k > 0) k--; else break;
      }
      k++; v[k] = q; z[k] = sct; z[k + 1] = Infinity;
    }
    if (k < 0) { for (let q = 0; q < ww; q++) if (query[qbase + q]) max = Infinity; continue; }
    k = 0;
    for (let q = 0; q < ww; q++) {
      while (z[k + 1] < q) k++;
      if (!query[qbase + q]) continue;
      const p = v[k], d = Math.sqrt((q - p) * (q - p) + f[p]);
      if (d > max) max = d;
    }
  }
  return {max: max > capPx ? Infinity : max};
}
// mask: optional Uint8Array of don't-care pixels (1 = ignore). distance: false skips the
// maximum-deviation transform (areas only).
function compareImages(a, b, g, mask, {distance = true} = {}) {
  const n = a.length, onlyA = new Uint8Array(n), onlyB = new Uint8Array(n), rowsA = [], rowsB = [], {w, h} = g;
  let xa = 0, xb = 0, na = 0, nb = 0, transitions = 0;
  const boxA = [w, h, -1, -1], boxB = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    let ha = false, hb = false;
    for (let x = 0, k = y * w; x < w; x++, k++) {
      if (mask && mask[k]) continue;
      const p = a[k], q = b[k];
      na += p; nb += q;
      // Boundary length of the reference image (pixel transitions; see perimeter below).
      if (x + 1 < w && p !== a[k + 1]) transitions++;
      if (y + 1 < h && p !== a[k + w]) transitions++;
      if (p === q) continue;
      if (p) { onlyA[k] = 1; xa++; ha = true; if (x < boxA[0]) boxA[0] = x; if (x > boxA[2]) boxA[2] = x; }
      else { onlyB[k] = 1; xb++; hb = true; if (x < boxB[0]) boxB[0] = x; if (x > boxB[2]) boxB[2] = x; }
    }
    if (ha) { rowsA.push(y); if (y < boxA[1]) boxA[1] = y; boxA[3] = y; }
    if (hb) { rowsB.push(y); if (y < boxB[1]) boxB[1] = y; boxB[3] = y; }
  }
  const s = g.s, px2 = s * s;
  const dA = xa && distance ? distances(b, onlyA, g, rowsA, boxA) : {max: xa ? NaN : 0}, dB = xb && distance ? distances(a, onlyB, g, rowsB, boxB) : {max: xb ? NaN : 0};
  const comps = components(onlyA, onlyB, g, [...new Set([...rowsA, ...rowsB])].sort((p, q) => p - q));
  // XOR area / boundary length is the mean edge displacement. Boundary length: pixel
  // transitions x s x pi/4 (Cauchy-Crofton; exact on average over edge directions).
  const perimeter = transitions * s * Math.PI / 4;
  return {areaA: na * px2, areaB: nb * px2, xorArea: (xa + xb) * px2, onlyA: xa * px2, onlyB: xb * px2, perimeter, meanDev: perimeter ? (xa + xb) * px2 / perimeter : 0,
    maxDevA: dA.max * s, maxDevB: dB.max * s, maxDev: Math.max(dA.max, dB.max) * s, components: comps, pixel: s};
}
// Connected XOR components (8-connected), largest first, with their box and pixel count.
function components(onlyA, onlyB, g, rows, limit = 40) {
  const {w, h, x0, y0, s} = g, seen = new Uint8Array(w * h), out = [];
  let total = 0;
  const stack = [];
  for (const row of rows) for (let k0 = row * w, end = k0 + w; k0 < end; k0++) {
    if (seen[k0] || !(onlyA[k0] || onlyB[k0])) continue;
    let nA = 0, nB = 0, bx = [Infinity, Infinity, -Infinity, -Infinity];
    stack.push(k0); seen[k0] = 1;
    while (stack.length) {
      const k = stack.pop(), x = k % w, y = (k - x) / w;
      if (onlyA[k]) nA++; else nB++;
      if (x < bx[0]) bx[0] = x; if (y < bx[1]) bx[1] = y; if (x > bx[2]) bx[2] = x; if (y > bx[3]) bx[3] = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const q = Y * w + X;
        if (!seen[q] && (onlyA[q] || onlyB[q])) { seen[q] = 1; stack.push(q); }
      }
    }
    total++;
    out.push({onlyA: nA * s * s, onlyB: nB * s * s, box: [x0 + bx[0] * s, y0 + bx[1] * s, x0 + (bx[2] + 1) * s, y0 + (bx[3] + 1) * s], thick: Math.min(bx[2] - bx[0] + 1, bx[3] - bx[1] + 1) * s});
  }
  out.sort((p, q) => (q.onlyA + q.onlyB) - (p.onlyA + p.onlyB));
  return {count: total, largest: out.slice(0, limit)};
}

// ---------------------------------------------------------------------------
// Object-level matching (exact, in µm).
// A flash's plotted footprint: [kind, w, h] after resolving the aperture (rotation-free
// bounding size plus kind), and its dark area for comparing macro and standard forms.
function flashSignature(f) {
  const b = bboxOf(f.shapes, true) || [f.x, f.y, f.x, f.y];
  return {w: b[2] - b[0], h: b[3] - b[1], cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, type: f.ap.type === "M" ? "macro" : f.ap.type};
}
// Greedy nearest matching of points within tol (mm). Returns matched pairs and leftovers.
function matchPoints(A, B, key, tol) {
  const cell = Math.max(tol, 1e-3), grid = new Map(), used = new Uint8Array(B.length);
  const ck = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
  B.forEach((b, i) => { const k = ck(b.x, b.y); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const pairs = [], missing = [];
  for (const a of A) {
    let best = -1, bd = Infinity;
    const cx = Math.floor(a.x / cell), cy = Math.floor(a.y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of grid.get((cx + dx) + "," + (cy + dy)) || []) {
      if (used[i] || (key && key(a) !== key(B[i]))) continue;
      const d = Math.hypot(a.x - B[i].x, a.y - B[i].y);
      if (d <= tol && d < bd) { bd = d; best = i; }
    }
    if (best >= 0) { used[best] = 1; pairs.push([a, B[best], bd]); } else missing.push(a);
  }
  return {pairs, missing, extra: B.filter((_, i) => !used[i])};
}
function compareFlashes(ref, out, tol = .005) {
  const A = ref.flashes.filter(f => f.dark).map(f => ({...flashSignature(f), f})).map(q => ({...q, x: q.cx, y: q.cy}));
  const B = out.flashes.filter(f => f.dark).map(f => ({...flashSignature(f), f})).map(q => ({...q, x: q.cx, y: q.cy}));
  const m = matchPoints(A, B, null, tol);
  let pos = 0, size = 0;
  const sizeOff = [];
  for (const [a, b, d] of m.pairs) {
    pos = Math.max(pos, d);
    const ds = Math.max(Math.abs(a.w - b.w), Math.abs(a.h - b.h));
    if (ds > size) size = ds;
    if (ds > tol) sizeOff.push({at: [a.x, a.y], ref: [a.w, a.h], out: [b.w, b.h]});
  }
  return {ref: A.length, out: B.length, matched: m.pairs.length, missing: m.missing.map(q => ({at: [q.x, q.y], size: [q.w, q.h]})),
    extra: m.extra.map(q => ({at: [q.x, q.y], size: [q.w, q.h]})), maxPosDev: pos, maxSizeDev: size, sizeOff};
}
function compareDrills(ref, out, tol = .001) {
  const key = h => (h.plated === false ? "N" : "P") + Math.round(h.d * 1e3);
  const m = matchPoints(ref.hits, out.hits, null, tol);
  let pos = 0, dia = 0;
  const wrong = [];
  for (const [a, b, d] of m.pairs) {
    pos = Math.max(pos, d); dia = Math.max(dia, Math.abs(a.d - b.d));
    if (Math.abs(a.d - b.d) > tol || (a.plated !== false) !== (b.plated !== false)) wrong.push({at: [a.x, a.y], ref: {d: a.d, plated: a.plated}, out: {d: b.d, plated: b.plated}});
  }
  const tally = hits => { const t = {}; for (const h of hits) t[key(h)] = (t[key(h)] || 0) + 1; return t; };
  return {ref: ref.hits.length, out: out.hits.length, matched: m.pairs.length, refTools: tally(ref.hits), outTools: tally(out.hits),
    missing: m.missing.map(h => ({at: [h.x, h.y], d: h.d})), extra: m.extra.map(h => ({at: [h.x, h.y], d: h.d})), wrong, maxPosDev: pos, maxDiaDev: dia,
    slots: {ref: ref.slots.length, out: out.slots.length}};
}
// Profile: segments of both files sampled every `step` mm; one-sided distances to the other polyline set.
function outlineSegments(parsed) {
  return parsed.shapes.filter(s => s.k === "capsule" && s.dark).map(s => [[s.x1, s.y1], [s.x2, s.y2]]);
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function compareOutlines(ref, out, step = .05) {
  const A = outlineSegments(ref), B = outlineSegments(out);
  const one = (P, Q) => {
    let max = 0;
    for (const [a, b] of P) {
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let k = 0; k <= n; k++) {
        const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
        let d = Infinity; for (const [c, e] of Q) d = Math.min(d, segDist(p, c, e));
        max = Math.max(max, d);
      }
    }
    return max;
  };
  const box = segs => segs.length ? segs.flat().reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]) : null;
  const len = segs => segs.reduce((s, [a, b]) => s + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
  return {refBox: box(A), outBox: box(B), refLength: len(A), outLength: len(B), maxDev: Math.max(one(A, B), one(B, A)),
    refWidth: ref.shapes.find(s => s.k === "capsule")?.r * 2 || 0, outWidth: out.shapes.find(s => s.k === "capsule")?.r * 2 || 0};
}
// Raster of drill holes (don't-care mask for copper: drilled away in fabrication).
function holeShapes(drills) {
  const out = [];
  for (const d of drills) {
    for (const h of d.hits) out.push({k: "circle", x: h.x, y: h.y, r: h.d / 2, dark: true});
    for (const sl of d.slots) out.push({k: "capsule", x1: sl.a[0], y1: sl.a[1], x2: sl.b[0], y2: sl.b[1], r: sl.d / 2, dark: true});
  }
  return out;
}

// Layer mapping from a file name (Altium / Protel extensions, KiCad names) or X2 file function.
const EXT_LAYERS = {GTL: "Copper,Top", GBL: "Copper,Bot", GTO: "Legend,Top", GBO: "Legend,Bot", GTS: "Soldermask,Top", GBS: "Soldermask,Bot",
  GTP: "Paste,Top", GBP: "Paste,Bot", GKO: "Profile", GM1: "Profile", GML: "Profile", GD1: "Drillmap"};
function layerOf(name, parsed) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] || "").toUpperCase();
  if (EXT_LAYERS[ext]) return EXT_LAYERS[ext];
  if (/^G\d+$/.test(ext)) return "Copper,Inner" + ext.slice(1);
  if (/^GM\d+$/.test(ext)) return "Mechanical" + ext.slice(2);
  const ff = parsed?.attributes?.file?.[".FileFunction"];
  if (ff) return ff.replace(/,L\d+/, "").replace(/,(Signal|Plane|Mixed)$/, "");
  return ext || name;
}

// ---------------------------------------------------------------------------
// Vector deviation (exact, no raster): every reference path is sampled every
// `step` mm (vertices included) and each sample is measured to the nearest
// segment of the other file's paths. Draws only match draws of the same width
// (within wTol); region boundaries match region boundaries, with cut-ins (two
// coincident, opposite segments of one contour) left out.
function segmentsOfRing(ring, closed) {
  const out = [], n = ring.length, key = (p, q) => p[0].toFixed(6) + "," + p[1].toFixed(6) + ">" + q[0].toFixed(6) + "," + q[1].toFixed(6);
  const all = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) { const a = ring[i], b = ring[(i + 1) % n]; if (a[0] !== b[0] || a[1] !== b[1]) all.push([a, b]); }
  if (!closed) return all;
  const count = new Map();
  for (const [a, b] of all) { const k = key(a, b); count.set(k, (count.get(k) || 0) + 1); }
  for (const [a, b] of all) if (!count.get(key(b, a))) out.push([a, b]);
  return out;
}
function segGrid(segs, cell) {
  const grid = new Map();
  segs.forEach((s, i) => {
    const [a, b] = s.seg, x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell), y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + "," + y; (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  });
  return grid;
}
function nearest(p, segs, grid, cell, accept, cap) {
  const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
  let best = Infinity;
  for (let r = 0; r * cell <= cap + cell; r++) {
    if (best <= (r - 1) * cell) break;
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      for (const i of grid.get((cx + dx) + "," + (cy + dy)) || []) {
        if (accept && !accept(segs[i])) continue;
        const d = segDist(p, segs[i].seg[0], segs[i].seg[1]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}
function pathDeviation(refSegs, outSegs, {step = .01, cap = 1, cell = .1, accept} = {}) {
  const grid = segGrid(outSegs, cell);
  let max = 0, at = null, beyond = 0, samples = 0;
  for (const s of refSegs) {
    const [a, b] = s.seg, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k <= n; k++) {
      const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
      const d = nearest(p, outSegs, grid, cell, accept ? o => accept(s, o) : null, cap);
      samples++;
      if (d > max) { max = d; at = p; }
      if (d > .001) beyond++;
    }
  }
  return {max: max === Infinity ? Infinity : max, at, samples, beyond1um: beyond};
}
function drawSegments(parsed) {
  const out = [];
  for (const d of parsed.draws) for (let i = 1; i < d.points.length; i++) out.push({seg: [d.points[i - 1], d.points[i]], w: d.width});
  return out;
}
function regionSegments(parsed) {
  const out = [];
  for (const r of parsed.regions) for (const seg of segmentsOfRing(r.ring, true)) out.push({seg, dark: r.dark});
  return out;
}
// Two-sided vector deviation of draws (by width) and region boundaries.
// exclude(point) leaves out segments with both ends where it is true (e.g. text boxes).
// regions: false skips the region boundaries (e.g. pours from another pour engine).
function vectorDeviation(ref, out, {wTol = .001, cap = 1, exclude = null, regions = true} = {}) {
  const keep = list => exclude ? list.filter(s => !(exclude(s.seg[0]) && exclude(s.seg[1]))) : list;
  const dr = keep(drawSegments(ref)), dout = keep(drawSegments(out)), rr = regions ? keep(regionSegments(ref)) : [], ro = regions ? keep(regionSegments(out)) : [];
  const sameWidth = (a, b) => Math.abs(a.w - b.w) <= wTol;
  const one = (A, B, accept) => A.length ? (B.length ? pathDeviation(A, B, {cap, accept}) : {max: Infinity, samples: A.length, beyond1um: A.length}) : {max: 0, samples: 0, beyond1um: 0};
  return {draws: {ref: dr.length, out: dout.length, refToOut: one(dr, dout, sameWidth), outToRef: one(dout, dr, sameWidth)},
    regions: {ref: rr.length, out: ro.length, refToOut: one(rr, ro), outToRef: one(ro, rr)}};
}

// Full comparison of one Gerber layer pair.
function compareLayer(refText, outText, options = {}) {
  const s = options.pixel ?? .005;
  const ref = typeof refText === "string" ? parseGerber(refText) : refText, out = typeof outText === "string" ? parseGerber(outText) : outText;
  const g = options.grid || gridFor([ref.bbox, out.bbox, options.box], s, .2, options.phase || 0);
  const a = rasterize(ref.shapes, g), b = rasterize(out.shapes, g);
  const mask = options.mask ? rasterize(options.mask, g) : null;
  const masked = mask ? compareImages(a, b, g, mask) : null;
  const raw = compareImages(a, b, g, null, {distance: !masked || !!options.rawDistance});
  const vector = options.vector === false ? null : vectorDeviation(ref, out, options);
  return {raw, masked, vector, flashes: compareFlashes(ref, out, options.flashTol ?? .005), refStats: {flashes: ref.flashCount, draws: ref.drawCount, regions: ref.regionCount},
    outStats: {flashes: out.flashCount, draws: out.drawCount, regions: out.regionCount}, warnings: {ref: ref.warnings, out: out.warnings}, grid: g, ref, out};
}

// CLI: node tests/formats/gerber-compare.cjs <reference> <output> [--pixel=0.005]   (Gerber pair, or Excellon pair with --drill)
// Prints the comparison as JSON (no exit status: tests apply their own tolerances).
if (typeof require !== "undefined" && require.main === module && process.argv.length > 3) {
  const fs = require("node:fs"), [ref, out] = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const pixel = +(process.argv.find(a => a.startsWith("--pixel="))?.slice(8) || .005);
  const read = f => fs.readFileSync(f, "utf8");
  if (process.argv.includes("--drill")) console.log(JSON.stringify(compareDrills(parseExcellon(read(ref)), parseExcellon(read(out)))));
  else {
    const r = compareLayer(read(ref), read(out), {pixel});
    console.log(JSON.stringify({layer: layerOf(ref), raw: {...r.raw, components: r.raw.components.count}, vector: r.vector,
      flashes: {ref: r.flashes.ref, out: r.flashes.out, matched: r.flashes.matched, maxPosDev: r.flashes.maxPosDev, maxSizeDev: r.flashes.maxSizeDev}, refStats: r.refStats, outStats: r.outStats}));
  }
}
module.exports = {parseGerber, vectorDeviation, pathDeviation, drawSegments, regionSegments, parseExcellon, rasterize, gridFor, compareImages, compareLayer, compareFlashes, compareDrills, compareOutlines, holeShapes, layerOf, count, evalExpr, bboxOf, MM_PER_IN};
