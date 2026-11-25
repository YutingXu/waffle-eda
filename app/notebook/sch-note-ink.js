"use strict";

// Sheet coordinates are millimetres. This is shared geometry for live sketch
// feedback, recorded output and hit testing. A capture never edits a document.
globalThis.AtriumSchNoteInk = (() => {
  const TAU = 2 * Math.PI, HIGHLIGHT_ALPHA = 0.28;
  const samePlace = (a, b) => a[0] === b[0] && a[1] === b[1];
  const length2 = (x, y) => x * x + y * y;
  const clamp = n => Math.max(0, Math.min(1, n));

  function capture(pointerType, width) {
    if (!["pen", "touch", "mouse"].includes(pointerType) || !Number.isFinite(width) || width <= 0)
      throw RangeError("Choose a pointer and a positive stroke width.");
    const points = [], spacing2 = Math.min(width / 20, 0.08) ** 2;
    let previous = null, tip = null, closed = false;

    function emit(p, endpoint) {
      const b = points.at(-1), a = points.at(-2);
      if (b && samePlace(b, p) && b[2] === p[2]) return;
      if (!endpoint && b && length2(p[0] - b[0], p[1] - b[1]) < spacing2 && Math.abs(p[2] - b[2]) < 2) return;
      // Exact straight, constant-pressure segments need just their two ends.
      if (a && a[2] === b[2] && b[2] === p[2]) {
        const x = b[0] - a[0], y = b[1] - a[1], dx = p[0] - b[0], dy = p[1] - b[1];
        if (x * dy === y * dx && x * dx + y * dy > 0) { points[points.length - 1] = p; return; }
      }
      points.push(p);
    }

    function append(samples, releasing = false) {
      if (closed) throw Error("The stroke is closed.");
      // The last retained vertex may be replaced by compaction. The segment
      // joining it to its predecessor is the earliest wet geometry affected.
      const redrawFrom = Math.max(0, points.length - 2);
      for (const s of samples) {
        if (!Array.isArray(s.world) || !Number.isFinite(s.world[0]) || !Number.isFinite(s.world[1])) continue;
        let pressure = pointerType === "mouse" || !Number.isFinite(s.pressure) ? 128 : Math.round(clamp(s.pressure) * 255);
        if (releasing && tip && s.pressure === 0) pressure = tip[2];
        const p = [s.world[0], s.world[1], pressure];
        if (!tip) { tip = p; emit(p, true); continue; }
        if (samePlace(tip, p)) {
          tip = [p[0], p[1], Math.max(p[2], tip[2])];
          if (!previous) points[0] = tip;
          continue;
        }
        // Smooth the intermediate sample only. The first and last positions
        // are exact and the current unsmoothed tip is available for wet ink.
        if (previous) emit([(previous[0] + 2 * tip[0] + p[0]) / 4,
          (previous[1] + 2 * tip[1] + p[1]) / 4, Math.round((previous[2] + 2 * tip[2] + p[2]) / 4)], false);
        previous = tip; tip = p;
      }
      return redrawFrom;
    }
    return {
      append, get points() { return points; }, get tip() { return tip; },
      finish(samples = []) { append(samples, true); if (tip) emit(tip, true); closed = true; return points; },
      cancel() { if (!closed) { closed = true; points.length = 0; tip = previous = null; } }
    };
  }

  // Sections are closed discs and the trapezoids between them. All subpaths
  // have the same winding. A translucent stroke is filled exactly once.
  const radius = (style, p) => style.width / 2 * (style.brush === "highlighter" ? 1 : 0.25 + 0.75 * p[2] / 255);
  function strip(a, b, ra, rb) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (!len) return null;
    const nx = -dy / len, ny = dx / len;
    return [[a[0] + nx * ra, a[1] + ny * ra], [a[0] - nx * ra, a[1] - ny * ra],
      [b[0] - nx * rb, b[1] - ny * rb], [b[0] + nx * rb, b[1] + ny * rb]];
  }
  function draw(ctx, points, style, colour) {
    if (!points.length) return;
    drawPaths(ctx,[points],style,colour);
  }
  function drawPaths(ctx, paths, style, colour) {
    ctx.save();
    try {
      ctx.fillStyle = colour;
      if (style.brush === "highlighter") ctx.globalAlpha *= HIGHLIGHT_ALPHA;
      ctx.beginPath();
      for (const points of paths) for (let i = 0; i < points.length; i++) {
        const p = points[i], r = radius(style, p);
        ctx.moveTo(p[0] + r, p[1]); ctx.arc(p[0], p[1], r, 0, TAU); ctx.closePath();
        if (i === 0) continue;
        const a = points[i - 1], q = strip(a, p, radius(style, a), r);
        if (!q) continue;
        ctx.moveTo(...q[0]); ctx.lineTo(...q[1]); ctx.lineTo(...q[2]); ctx.lineTo(...q[3]); ctx.closePath();
      }
      ctx.fill();
    } finally { ctx.restore(); }
  }
  function bounds(points, style) {
    if (!points.length) return null;
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of points) {
      const r = radius(style, p);
      box[0] = Math.min(box[0], p[0] - r); box[1] = Math.min(box[1], p[1] - r);
      box[2] = Math.max(box[2], p[0] + r); box[3] = Math.max(box[3], p[1] + r);
    }
    return box;
  }

  const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  function distance2(p, a, b) {
    const x = b[0] - a[0], y = b[1] - a[1];
    const t = clamp(((p[0] - a[0]) * x + (p[1] - a[1]) * y) / (length2(x, y) || 1));
    return length2(p[0] - (a[0] + t * x), p[1] - (a[1] + t * y));
  }
  function nearEdge(a, b, c, d, r2) {
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
    return Math.min(distance2(c, a, b), distance2(d, a, b), distance2(a, c, d), distance2(b, c, d)) <= r2;
  }
  function hit(points, style, from, to, eraserRadius) {
    const r2 = eraserRadius ** 2;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], r = radius(style, p);
      if (distance2(p, from, to) <= (r + eraserRadius) ** 2) return true;
      if (i === 0) continue;
      const a = points[i - 1], q = strip(a, p, radius(style, a), r);
      if (!q) continue;
      let inside = true;
      for (let j = 0; j < 4; j++) {
        const edgeA = q[j], edgeB = q[(j + 1) % 4];
        if (nearEdge(from, to, edgeA, edgeB, r2)) return true;
        if (cross(edgeA, edgeB, from) < 0) inside = false;
      }
      if (inside) return true;
    }
    return false;
  }
  return Object.freeze({capture, draw, drawPaths, bounds, hit, highlighterAlpha: HIGHLIGHT_ALPHA});
})();
