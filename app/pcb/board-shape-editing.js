"use strict";
// Board Shape dialogs and the explicit outline-edit tool share these operations.
globalThis.AtriumBoardShapeEditing = (() => {
  const geometry = globalThis.AtriumBoardShape;
  const {TOL, CORNERS, roundPoint: P, roundScalar: r6, pointAt: at, contourBounds, head,
    sweep, rect, circle:circleShape, contourLength, signedArea, bounds, scale, translate, arc, line, ends, tail,
    fromBulge, bulgeOf, angleOf, within, splitArc, arcThrough, orient, dedupe, polyArea, flattenContour} = geometry;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const D2R = Math.PI / 180;

  // Recognise a rectangle with sharp, rounded or chamfered corners.
  function analyze(shape) {
    if (!shape?.contour?.length) return null;
    const b = contourBounds(shape.contour), [x0, yt, x1, yb] = b, w = x1 - x0, h = yb - yt, eps = Math.max(1e-6, 1e-7 * Math.max(w, h));
    if (!(w > 0 && h > 0) || shape.contour.length > 8) return null;
    const corner = {bl: [x0, yb], br: [x1, yb], tr: [x1, yt], tl: [x0, yt]}, corners = {};
    const near = (p, q) => dist(p, q) <= eps;
    for (const k of CORNERS) {
      const p = corner[k];
      if (shape.contour.some(g => near(head(g), p))) { corners[k] = {style: "sharp", size: 0}; continue; }
      const a = shape.contour.find(g => g.kind === "arc" && Math.abs(Math.abs(sweep(g)) - 90) < 1e-6 && Math.abs(Math.abs(g.c[0] - p[0]) - g.r) <= eps && Math.abs(Math.abs(g.c[1] - p[1]) - g.r) <= eps && dist(g.c, p) < Math.hypot(w, h));
      if (a) { corners[k] = {style: "radius", size: r6(a.r)}; continue; }
      const l = shape.contour.find(g => g.kind === "line" && [g.a, g.b].every(q => (Math.abs(q[0] - p[0]) <= eps) !== (Math.abs(q[1] - p[1]) <= eps)) && Math.abs(Math.abs(g.a[0] - g.b[0]) - Math.abs(g.a[1] - g.b[1])) <= eps && dist(g.a, p) < Math.min(w, h) / 2 + eps);
      if (l) { corners[k] = {style: "chamfer", size: r6(Math.abs(l.a[0] - l.b[0]))}; continue; }
      return null;
    }
    const params = {x: r6(x0), y: r6(yb), width: r6(w), height: r6(h), corners};
    const test = rect(params);
    if (Math.abs(Math.abs(signedArea(test.contour)) - Math.abs(signedArea(shape.contour))) > 1e-6 * w * h + 1e-9 || Math.abs(contourLength(test.contour) - contourLength(shape.contour)) > 1e-6 * (w + h)) return null;
    return params;
  }
  // Edit dimensions. Rectangular boards rebuild parametrically; others scale
  // about their lower-left corner. Cutouts keep their place relative to the
  // lower-left corner when only the size changes and move with the board.
  function resize(shape, o) {
    const b = bounds(shape), ll = [b[0], b[3]], w = b[2] - b[0], h = b[3] - b[1];
    const x = o.x ?? ll[0], y = o.y ?? ll[1], width = o.width ?? w, height = o.height ?? h;
    if (!(width > 0 && height > 0)) throw Error("Width and height must be positive.");
    const params = analyze(shape);
    let out;
    if (params) out = rect({...params, x: ll[0], y: ll[1], width, height, corners: o.corners || params.corners});
    else {
      if (o.corners && Object.values(o.corners).some(c => c && c.style !== "sharp")) throw Error("Corner styles apply to rectangular boards only.");
      out = scale(shape, width / w, height / h, ll);
    }
    // Unscaled cutouts keep their material islands; translate moves both.
    out = {...out, cutouts: shape.cutouts || []};
    if (shape.cutoutRegions) out.cutoutRegions = shape.cutoutRegions; else delete out.cutoutRegions;
    out = translate(out, x - ll[0], y - ll[1]);
    return {...out, source: shape.source || "vertices"};
  }

  // ---------------------------------------------------------------------------
  // Wizard and standard form factors. Hole positions are measured from the
  // lower-left corner with Y up, as in the mechanical drawings.
  const PRESETS = [
    {id: "100x100", name: "100 × 100 mm", width: 100, height: 100, corners: 0, holes: {inset: 4, d: 3.2}},
    {id: "50x50", name: "50 × 50 mm", width: 50, height: 50, corners: 0, holes: {inset: 3.5, d: 3.2}},
    {id: "rpi-hat", name: "Raspberry Pi HAT (65 × 56.5)", width: 65, height: 56.5, corners: 3, holes: {d: 2.75, at: [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]]}, note: "M2.5 holes on a 58 × 49 mm pattern."},
    {id: "rpi-b", name: "Raspberry Pi 4/5 Model B (85 × 56)", width: 85, height: 56, corners: 3, holes: {d: 2.75, at: [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]]}},
    {id: "arduino-uno", name: "Arduino Uno shield (68.58 × 53.34)", width: 68.58, height: 53.34, corners: 0, holes: {d: 3.2, at: [[13.97, 2.54], [15.24, 50.8], [66.04, 7.62], [66.04, 35.56]]}, note: "Rectangular envelope; the Uno's angled edge near the headers is not drawn."},
    {id: "feather", name: "Adafruit Feather (50.8 × 22.86)", width: 50.8, height: 22.86, corners: 2.54, holes: {d: 2.5, at: [[2.54, 2.54], [48.26, 2.54], [2.54, 20.32], [48.26, 20.32]]}},
    {id: "eurocard", name: "Eurocard (160 × 100)", width: 160, height: 100, corners: 0, holes: {inset: 4, d: 3.2}},
    {id: "pcie-half", name: "PCIe half-length, full-height (167.65 × 111.15)", width: 167.65, height: 111.15, corners: 0, holes: null, note: "Card envelope only; add the edge-connector fingers and bracket notch from the PCI-SIG drawing."},
    {id: "pcie-lp", name: "PCIe low-profile (167.65 × 68.9)", width: 167.65, height: 68.9, corners: 0, holes: null, note: "Card envelope only; add the edge-connector fingers from the PCI-SIG drawing."},
    {id: "m2-2280", name: "M.2 2280 (22 × 80)", width: 22, height: 80, corners: 0, notch: 1.75, holes: null, note: "Semicircular mounting notch (R1.75) at the top edge; the connector key is not drawn."},
    {id: "m2-2242", name: "M.2 2242 (22 × 42)", width: 22, height: 42, corners: 0, notch: 1.75, holes: null, note: "Semicircular mounting notch (R1.75) at the top edge; the connector key is not drawn."}
  ];
  function wizard(o) {
    const x = +o.x || 0, y = +o.y || 0;
    let shape, holes = [], note = "";
    const cornerHoles = (w, h, inset, d) => [[inset, inset], [w - inset, inset], [inset, h - inset], [w - inset, h - inset]].map(p => ({x: x + p[0], y: y - p[1], d}));
    if (o.type === "circle") {
      const d = +o.diameter;
      shape = circleShape(d, [x + d / 2, y - d / 2]);
      if (o.holes) { const c = [x + d / 2, y - d / 2], rr = d / 2 - (+o.holeInset || 4), n = Math.max(2, Math.round(+o.holeCount || 4)); for (let i = 0; i < n; i++) { const a = (45 + 360 * i / n) * D2R; holes.push({x: c[0] + rr * Math.cos(a), y: c[1] - rr * Math.sin(a), d: +o.holeDiameter || 3.2}); } }
    } else if (o.type === "preset") {
      const p = PRESETS.find(q => q.id === o.preset);
      if (!p) throw Error("Unknown form factor.");
      const all = {style: p.corners ? "radius" : "sharp", size: p.corners};
      shape = rect({x, y, width: p.width, height: p.height, corners: {bl: all, br: all, tr: all, tl: all}});
      if (p.notch) {
        // Replace the top edge with a semicircular notch centred on it.
        const cx = x + p.width / 2, yt = y - p.height, r = p.notch;
        shape.contour = shape.contour.flatMap(g => g.kind === "line" && Math.abs(g.a[1] - yt) < 1e-9 && Math.abs(g.b[1] - yt) < 1e-9 ?
          [line(g.a, [cx + r, yt]), arc([cx, yt], r, 0, 180, false), line([cx - r, yt], g.b)] : [g]);
      }
      if (o.holes !== false && p.holes) holes = p.holes.at ? p.holes.at.map(q => ({x: x + q[0], y: y - q[1], d: o.holeDiameter || p.holes.d})) : cornerHoles(p.width, p.height, p.holes.inset, o.holeDiameter || p.holes.d);
      note = p.note || "";
    } else {
      const w = +o.width, h = +o.height, r = o.type === "rounded" ? +o.radius || 0 : 0;
      const c = {style: r > 0 ? "radius" : "sharp", size: r};
      shape = rect({x, y, width: w, height: h, corners: o.corners || {bl: c, br: c, tr: c, tl: c}});
      if (o.holes) holes = cornerHoles(w, h, +o.holeInset || Math.max(3, r || 0), +o.holeDiameter || 3.2);
    }
    if (!o.holes && o.type !== "preset") holes = [];
    shape.source = "wizard";
    return {shape, holes: holes.map(h => ({x: r6(h.x), y: r6(h.y), d: h.d})), note};
  }
  // Mounting holes as pads: non-plated (pad = drill) unless a pad size is set.
  function holeItems(holes, opt = {}) {
    const id = globalThis.Atrium?.id || (() => "h" + Math.random().toString(36).slice(2));
    return holes.map(h => {
      const pad = opt.pad > h.d ? opt.pad : h.d;
      const item = {id: id(), kind: "pad", x: h.x, y: h.y, w: pad, h: pad, drill: h.d, shape: "round", layer: "Multi", number: "", net: opt.net || ""};
      if (!(opt.pad > h.d)) item.plated = false;
      return item;
    });
  }

  // ---------------------------------------------------------------------------
  // Vertex editing. ref = {contour: -1 (outer) | cutout index, index: k};
  // vertex k is the start of segment k. All functions return a new shape.
  function contourAt(shape, ref) { const c = ref.contour == null || ref.contour < 0 ? shape.contour : shape.cutouts?.[ref.contour]; if (!c) throw Error("No such contour."); return c; }
  function withContour(shape, ref, c) {
    if (ref.contour == null || ref.contour < 0) return {...shape, contour: c};
    const cut = shape.cutouts.slice(); cut[ref.contour] = c; return {...shape, cutouts: cut};
  }
  function rebuild(g, a, b) { return g.kind === "arc" ? fromBulge(a, b, bulgeOf(g)) : line(a, b); }
  function vertices(shape) {
    const out = [];
    [shape.contour, ...(shape.cutouts || [])].forEach((c, ci) => c.forEach((g, k) => {
      const [a, b] = ends(g);
      out.push({ref: {contour: ci - 1, index: k}, at: P(a), type: "vertex"});
      out.push({ref: {contour: ci - 1, index: k}, at: P(g.kind === "arc" ? at(g.c, g.r, g.start + sweep(g) / 2) : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), type: "mid", kind: g.kind});
    }));
    return out;
  }
  function moveVertex(shape, ref, p) {
    const c = contourAt(shape, ref).slice(), n = c.length, k = ref.index, j = (k - 1 + n) % n;
    if (!(k >= 0 && k < n)) throw Error("No such vertex.");
    c[k] = rebuild(c[k], p, tail(c[k]));
    c[j] = rebuild(c[j], j === k ? p : head(c[j]), p);
    return withContour(shape, ref, c);
  }
  function insertVertex(shape, ref, p) {
    const c = contourAt(shape, ref).slice(), g = c[ref.index];
    if (!g) throw Error("No such edge.");
    let parts;
    if (g.kind === "arc") {
      const a = angleOf(g.c, p);
      parts = within(g, a) ? splitArc(g, [a]) : [g];
      if (parts.length < 2) throw Error("The point is not on the arc.");
      parts = parts.map(q => arc(q.c, q.r, q.start, q.end, q.ccw));
    } else parts = [line(g.a, p), line(p, g.b)];
    c.splice(ref.index, 1, ...parts);
    return withContour(shape, ref, c);
  }
  function deleteVertex(shape, ref) {
    const c = contourAt(shape, ref).slice(), n = c.length, k = ref.index, j = (k - 1 + n) % n;
    if (n <= 2 || n === 3 && c.every(g => g.kind === "line")) throw Error("A contour needs at least three vertices.");
    const merged = line(head(c[j]), tail(c[k]));
    if (k === 0) { c.splice(0, 1); c[c.length - 1] = merged; } else c.splice(j, 2, merged);
    return withContour(shape, ref, c);
  }
  // opts: {through:[x,y]} | {bulge} | {radius, large}
  function convertToArc(shape, ref, o = {}) {
    const c = contourAt(shape, ref).slice(), g = c[ref.index];
    if (!g) throw Error("No such edge.");
    const [a, b] = ends(g);
    let s;
    if (o.through) s = arcThrough(a, o.through, b);
    else if (o.radius) {
      const d = dist(a, b), r = Math.max(+o.radius, d / 2), half = Math.asin(Math.min(1, d / (2 * r))) * 2;
      const w = o.large ? 2 * Math.PI - half : half;
      s = fromBulge(a, b, Math.tan(w / 4) * (o.ccw === false ? -1 : 1));
    } else s = fromBulge(a, b, o.bulge ?? Math.tan(Math.PI / 8));
    c[ref.index] = s;
    return withContour(shape, ref, c);
  }
  function convertToLine(shape, ref) {
    const c = contourAt(shape, ref).slice(), g = c[ref.index];
    const [a, b] = ends(g);
    if (dist(a, b) < 1e-9) throw Error("A full circle cannot become a line.");
    c[ref.index] = line(a, b);
    return withContour(shape, ref, c);
  }
  function addCutout(shape, contour) { return {...shape, cutouts: [...(shape.cutouts || []), orient(contour, false)]}; }
  function removeCutout(shape, i) {
    const result={...shape,cutouts:(shape.cutouts||[]).filter((_,k)=>k!==i)};
    if (shape.cutoutRegions) result.cutoutRegions=Object.fromEntries(Object.entries(shape.cutoutRegions).filter(([k])=>+k!==i).map(([k,r])=>[+k>i?+k-1:k,r]));
    return result;
  }

  // Offset a polygon by d (positive grows it): round joins on the outer side,
  // mitred joins inside. Self-intersections from large inward offsets are not
  // removed. Returns a new polygon.
  function offset(points, d, tol = TOL) {
    const q = dedupe(points, true);
    if (q.length < 3 || !d) return q.map(P);
    const n = q.length, sgn = polyArea(q) > 0 ? 1 : -1, r = Math.abs(d), out = [];
    const nrm = (a, b) => { const l = dist(a, b) || 1, ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l; return [sgn * uy, -sgn * ux]; };
    const N = q.map((p, i) => nrm(p, q[(i + 1) % n]));
    const {project, arcEdge} = AtriumGeometryCurves, limits = {legacyRadians: true, maxStep: tol < r ? 180 : 90};
    for (let i = 0; i < n; i++) {
      const p = q[i], n0 = N[(i - 1 + n) % n], n1 = N[i];
      const turn = n0[0] * n1[1] - n0[1] * n1[0];
      const a0 = [p[0] + n0[0] * d, p[1] + n0[1] * d], a1 = [p[0] + n1[0] * d, p[1] + n1[1] * d];
      const outward = (sgn * turn > 0) === (d > 0);
      if (dist(a0, a1) < 1e-9) { out.push(P(a1)); continue; }
      if (outward) {
        // Round join around p from a0 to a1.
        const start = Math.atan2(a0[1] - p[1], a0[0] - p[0]);
        let turn = Math.atan2(a1[1] - p[1], a1[0] - p[0]) - start;
        if (turn > Math.PI) turn -= 2 * Math.PI; else if (turn < -Math.PI) turn += 2 * Math.PI;
        out.push(...project([arcEdge({c: p, r, start: -start}, -turn)], tol, limits).map(P));
      } else {
        // Mitre: intersect the two offset edges.
        const pPrev = q[(i - 1 + n) % n], pNext = q[(i + 1) % n];
        const b0 = [pPrev[0] + n0[0] * d, pPrev[1] + n0[1] * d], b1 = [pNext[0] + n1[0] * d, pNext[1] + n1[1] * d];
        const x = intersect(b0, a0, a1, b1);
        out.push(P(x || a1));
      }
    }
    return dedupe(out, true);
  }
  function intersect(p1, p2, p3, p4) {
    const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if (Math.abs(d) < 1e-12) return null;
    const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / d;
    return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
  }
  // Keep-out ring inside the board edge: [outer polygon, inner polygon].
  function keepoutRing(shape, width) {
    const o = flattenContour(shape.contour);
    return [o, offset(o, -Math.abs(width))];
  }

  return Object.assign(geometry, { PRESETS, analyze, resize, wizard, holeItems, vertices, moveVertex,
    insertVertex, deleteVertex, convertToArc, convertToLine, addCutout, removeCutout, offset, keepoutRing});
})();
