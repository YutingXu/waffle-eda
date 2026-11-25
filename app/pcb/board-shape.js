"use strict";
// Shape construction, editing and SVG export. The browser demands this file
// after the core; direct CommonJS callers still load the full board-shape API.
if (!globalThis.AtriumBoardShape && typeof require === "function") require("./board-shape-core.js");

globalThis.AtriumBoardShapeAuthoring = (() => {
  const S = globalThis.AtriumBoardShape;
  const {TOL, roundPoint:P, roundScalar:r6, validPoint:pt, line, arc, angleOf, sweep,
    ends, head, tail, splitArc, arcPoints, orient, mapCutoutRegions, flattenContour,
    fresh, signature, validate, bounds, area, perimeter, polyArea} = S;
  const D2R = Math.PI / 180;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // Bulge (DXF): tan(sweep / 4), positive counter-clockwise.
  const bulgeOf = s => s.kind === "arc" ? Math.tan(sweep(s) * D2R / 4) : 0;
  function fromBulge(a, b, bulge) {
    const d = dist(a, b);
    if (!(Math.abs(bulge) > 1e-12) || d < 1e-12) return line(a, b);
    // Work in Y-up coordinates where counter-clockwise is the usual sense.
    const ax = a[0], ay = -a[1], bx = b[0], by = -b[1];
    const s = d * (1 - bulge * bulge) / (4 * bulge);
    const cx = (ax + bx) / 2 - (by - ay) / d * s, cy = (ay + by) / 2 + (bx - ax) / d * s;
    const r = d * (1 + bulge * bulge) / (4 * Math.abs(bulge));
    return arc([cx, -cy], r, Math.atan2(ay - cy, ax - cx) / D2R, Math.atan2(by - cy, bx - cx) / D2R, bulge > 0);
  }

  function circle3(a, b, c) {
    const ax = a[0], ay = -a[1], bx = b[0], by = -b[1], cx = c[0], cy = -c[1];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    return {c: [ux, -uy], r: Math.hypot(ax - ux, ay - uy), ccw: d > 0};
  }
  // Arc from a through m to b.
  function arcThrough(a, m, b) {
    const k = circle3(a, m, b);
    if (!k) return line(a, b);
    return arc(k.c, k.r, angleOf(k.c, a), angleOf(k.c, b), k.ccw);
  }

  function normalize(shape) {
    return mapCutoutRegions(shape,{...shape, contour:orient(shape.contour,true), cutouts:(shape.cutouts||[]).map(c=>orient(c,false))},c=>c);
  }
  // Make each joint exact: a line end takes its neighbour's end point.
  function weld(contour) {
    const c = contour.map(g => ({...g}));
    for (let i = 0; i < c.length; i++) {
      const g = c[i], h = c[(i + 1) % c.length];
      if (g.kind === "line" && h.kind === "line") { const m = P(h.a); g.b = m; }
      else if (g.kind === "line") g.b = P(head(h));
      else if (h.kind === "line") h.a = P(tail(g));
    }
    return c;
  }

  // Scale about `about`. Arcs survive uniform scaling; otherwise they become
  // chords within tolerance.
  function scale(shape, sx, sy, about = [0, 0]) {
    const m = p => P([about[0] + (p[0] - about[0]) * sx, about[1] + (p[1] - about[1]) * sy]);
    const uniform = Math.abs(sx - sy) < 1e-12;
    const conv = c => c.flatMap(g => {
      if (g.kind === "line") return [{kind: "line", a: m(g.a), b: m(g.b)}];
      if (uniform) return [arc(m(g.c), g.r * Math.abs(sx), g.start, g.end, g.ccw)];
      const q = arcPoints(g, TOL / Math.max(Math.abs(sx), Math.abs(sy))).map(m);
      return q.slice(1).map((p, i) => ({kind: "line", a: q[i], b: p}));
    });
    return mapCutoutRegions(shape,{...shape,contour:conv(shape.contour),cutouts:(shape.cutouts||[]).map(conv)},conv);
  }

  // Polygon outline as a shape (optionally recognising tessellated arcs).
  function fromPolygon(points, opt = {}) {
    return {version: 1, contour: polySegments(points, true, opt), cutouts: [], source: opt.source || "vertices"};
  }
  // The exact shape for a doc: the stored one when current, else its polygon.
  function current(doc, opt = {}) {
    const s = fresh(doc);
    if (s) return s;
    if (!Array.isArray(doc?.outline) || doc.outline.length < 3) return null;
    return fromPolygon(doc.outline, {fitArcs: !!opt.fitArcs});
  }

  // Store a shape on a doc: exact geometry plus the flattened outline.
  function apply(doc, shape, source) {
    const s = normalize(mapCutoutRegions(shape,{version:1,contour:weld(shape.contour),cutouts:(shape.cutouts||[]).map(weld),source:source||shape.source||"vertices"},weld));
    validate(s);
    const outline = flattenContour(s.contour);
    if (outline.length < 3 || Math.abs(polyArea(outline)) < 1e-9) throw Error("The board shape encloses no area.");
    s.sig = signature(outline);
    doc.outline = outline;
    doc.boardShape = s;
    return s;
  }
  function clear(doc) { delete doc.boardShape; }

  // ---------------------------------------------------------------------------
  // Polylines to segments, recognising arcs tessellated by importers.
  function dedupe(points, closed) {
    const out = [];
    for (const p of points) { const l = out[out.length - 1]; if (!l || dist(l, p) > 1e-9) out.push(p); }
    if (closed && out.length > 1 && dist(out[0], out.at(-1)) <= 1e-9) out.pop();
    return out;
  }
  function polySegments(points, closed, opt = {}) {
    let q = dedupe(points, closed);
    if (q.length < 2) return [];
    if (!opt.fitArcs || q.length < 4) {
      const out = [];
      for (let i = 0; i < q.length - 1; i++) out.push(line(q[i], q[i + 1]));
      if (closed && q.length > 2) out.push(line(q.at(-1), q[0]));
      return out;
    }
    const tol = opt.arcTolerance ?? 0.002;
    if (closed) {
      // Start on the longest edge so an arc run never wraps the seam.
      let best = 0, len = -1;
      for (let i = 0; i < q.length; i++) { const l = dist(q[i], q[(i + 1) % q.length]); if (l > len + 1e-9) { len = l; best = i; } }
      q = [...q.slice(best), ...q.slice(0, best), q[best]];
    }
    const out = [], L = q.length - 1;
    for (let i = 0; i < L;) {
      const j = arcRun(q, i, tol);
      if (j - i >= 3) {
        const full = closed && i === 0 && j === L;
        const k = full ? circle3(q[0], q[Math.floor(L / 3)], q[Math.floor(2 * L / 3)]) : runCircle(q, i, j);
        if (k) {
          const s = angleOf(k.c, q[i]);
          if (full) { const h = s + (k.ccw ? 180 : -180); out.push(arc(k.c, k.r, s, h, k.ccw), arc(k.c, k.r, h, s, k.ccw)); }
          else out.push(arc(k.c, k.r, s, angleOf(k.c, q[j]), k.ccw));
          i = j; continue;
        }
      }
      out.push(line(q[i], q[i + 1])); i++;
    }
    return out;
  }
  // Last index of a run of equal angular steps on one circle starting at i.
  // The circle comes from interior points and the run's end points may sit a
  // little off it, as they do when separate primitives meet within tolerance.
  function arcRun(q, i, tol) {
    const L = q.length - 1;
    if (i + 3 > L) return i;
    const k = i + 4 <= L ? circle3(q[i + 1], q[i + 2], q[i + 3]) : circle3(q[i], q[i + 1], q[i + 2]);
    if (!k || k.r > 1e5) return i;
    const ang = p => Math.atan2(k.c[1] - p[1], p[0] - k.c[0]);
    const step = (a, b) => { let d = ang(b) - ang(a); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
    const d0 = step(q[i + 1], q[i + 2]), loose = Math.max(5 * tol, .01);
    if (Math.abs(d0) > 20 * D2R || Math.abs(d0) < 1e-6) return i;
    const fits = (a, b, strict) => {
      const d = step(a, b);
      return Math.abs(dist(b, k.c) - k.r) <= (strict ? tol : loose) && Math.abs(d - d0) <= (strict ? Math.max(.03 * Math.abs(d0), 2e-4) : .15 * Math.abs(d0));
    };
    if (Math.abs(dist(q[i], k.c) - k.r) > loose || !fits(q[i], q[i + 1], false)) return i;
    let j = i + 1, total = step(q[i], q[i + 1]);
    while (j < L) {
      const strict = fits(q[j], q[j + 1], true);
      if (!strict && !fits(q[j], q[j + 1], false)) break;
      const d = step(q[j], q[j + 1]);
      if (Math.abs(total + d) > 2 * Math.PI + 1e-6) break;
      total += d; j++;
      if (!strict) break;
    }
    return j;
  }
  function runCircle(q, i, j) {
    return j - i >= 5 ? circle3(q[i + 1], q[(i + j) >> 1], q[j - 1]) : circle3(q[i], q[(i + j) >> 1], q[j]);
  }

  // Parametric rectangles: position (x, y) is the lower-left corner as seen on
  // screen (model max Y). corners: {bl, br, tr, tl}: {style, size}.
  const CORNERS = ["bl", "br", "tr", "tl"];
  function cornerSpec(c) { const style = c?.style === "radius" || c?.style === "chamfer" ? c.style : "sharp"; const size = style === "sharp" ? 0 : Math.max(0, +c.size || 0); return {style: size > 0 ? style : "sharp", size: size > 0 ? size : 0}; }
  function rect(o) {
    const w = +o.width, h = +o.height;
    if (!(w > 0 && h > 0)) throw Error("Width and height must be positive.");
    const x0 = +o.x || 0, yb = +o.y || 0, x1 = x0 + w, yt = yb - h;
    const lim = Math.min(w, h) / 2, C = {};
    for (const k of CORNERS) { const c = cornerSpec(o.corners?.[k]); C[k] = {style: c.style, size: Math.min(c.size, lim)}; if (!(C[k].size > 1e-9)) C[k] = {style: "sharp", size: 0}; }
    // Corner positions, the incoming edge direction and the screen angle range.
    const spec = {
      bl: {p: [x0, yb], inDir: [0, 1], outDir: [1, 0], c: s => [x0 + s, yb - s], a: [180, 270]},
      br: {p: [x1, yb], inDir: [1, 0], outDir: [0, -1], c: s => [x1 - s, yb - s], a: [270, 360]},
      tr: {p: [x1, yt], inDir: [0, -1], outDir: [-1, 0], c: s => [x1 - s, yt + s], a: [0, 90]},
      tl: {p: [x0, yt], inDir: [-1, 0], outDir: [0, 1], c: s => [x0 + s, yt + s], a: [90, 180]}
    };
    const pieces = CORNERS.map(k => {
      const {p, inDir, outDir} = spec[k], c = C[k], s = c.size;
      const enter = [p[0] - inDir[0] * s, p[1] - inDir[1] * s], leave = [p[0] + outDir[0] * s, p[1] + outDir[1] * s];
      const seg = c.style === "radius" ? arc(spec[k].c(s), s, spec[k].a[0], spec[k].a[1], true) : c.style === "chamfer" ? line(enter, leave) : null;
      return {enter, leave, seg};
    });
    const contour = [];
    for (let i = 0; i < 4; i++) {
      const cur = pieces[i], nxt = pieces[(i + 1) % 4];
      if (cur.seg) contour.push(cur.seg);
      if (dist(cur.leave, nxt.enter) > 1e-9) contour.push(line(cur.leave, nxt.enter));
    }
    return {version: 1, contour, cutouts: [], source: o.source || "wizard"};
  }
  function circleShape(d, centre) {
    const r = d / 2;
    if (!(r > 0)) throw Error("Diameter must be positive.");
    return {version: 1, contour: [arc(centre, r, 270, 90, true), arc(centre, r, 90, 270, true)], cutouts: [], source: "wizard"};
  }

  function originPoint(doc, mode, pick) {
    const s = current(doc), b = s ? bounds(s) : null;
    if (mode === "point") { if (!pt(pick)) throw Error("Pick a point."); return P(pick); }
    if (!b) throw Error("The board has no outline.");
    if (mode === "centre" || mode === "center") return P([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
    return P([b[0], b[3]]);
  }
  function setOrigin(doc, p) { if (p == null) delete doc.origin; else { if (!pt(p)) throw Error("Invalid origin."); doc.origin = P(p); } }

  // Summary for reports and the inspector.
  function describe(shape) {
    if (!shape) return null;
    const b = bounds(shape);
    return {width: b[2] - b[0], height: b[3] - b[1], area: area(shape), perimeter: perimeter(shape), cutouts: (shape.cutouts || []).length,
      arcs: [shape.contour, ...(shape.cutouts || [])].reduce((s, c) => s + c.filter(g => g.kind === "arc").length, 0), rect: globalThis.AtriumBoardShapeEditing?.analyze(shape) ?? null, bounds: b};
  }

  // SVG path with exact arcs (Y down, like the model).
  function svgPath(segs, f = v => +v.toFixed(4)) {
    const parts = [];
    let cur = null;
    for (const g of segs) {
      const [a, b] = ends(g);
      if (!cur || Math.abs(cur[0] - a[0]) > 1e-6 || Math.abs(cur[1] - a[1]) > 1e-6) parts.push("M" + f(a[0]) + " " + f(a[1]));
      if (g.kind === "line") parts.push("L" + f(b[0]) + " " + f(b[1]));
      else for (const h of Math.abs(sweep(g)) > 359.999 ? splitArc(g, [g.start + sweep(g) / 2]) : [g]) {
        const e = tail(h);
        parts.push("A" + f(h.r) + " " + f(h.r) + " 0 " + (Math.abs(sweep(h)) > 180 ? 1 : 0) + " " + (h.ccw ? 0 : 1) + " " + f(e[0]) + " " + f(e[1]));
      }
      cur = b;
    }
    return parts.join("");
  }

  return {
    bulgeOf, fromBulge, arcThrough, normalize, weld, scale, current, fromPolygon, dedupe, polySegments,
    apply, clear, CORNERS, rect, circle:circleShape, originPoint, setOrigin, describe, svgPath
  };
})();
Object.assign(globalThis.AtriumBoardShape, globalThis.AtriumBoardShapeAuthoring);
