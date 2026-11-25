"use strict";

// Geometry is in the owner's coordinates. An image owner applies its oriented
// source-to-sheet transform and crop before calling draw, and inverse-maps hits.
globalThis.AtriumSchNoteMarkup = (() => {
  function box(mark) {
    const [x, y] = mark.at, [u, v] = mark.to;
    return [Math.min(x, u), Math.min(y, v), Math.max(x, u), Math.max(y, v)];
  }
  function arrow(mark) {
    const a = mark.at, b = mark.to, dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (!length) return null;
    const size = Math.min(4 * mark.width, length * .45), x = dx / length, y = dy / length;
    const neck = [b[0] - size * x, b[1] - size * y];
    return {neck, left: [neck[0] - size * .55 * y, neck[1] + size * .55 * x],
      right: [neck[0] + size * .55 * y, neck[1] - size * .55 * x]};
  }
  function distance(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
  }
  const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const contains = (r, p, tol) => p[0] >= r[0] - tol && p[0] <= r[2] + tol && p[1] >= r[1] - tol && p[1] <= r[3] + tol;

  // Nearest point on an axis-aligned ellipse. The Lagrange multiplier is
  // monotone between the minor-axis pole and infinity, including inner hits.
  function ellipseDistance(p, r) {
    let a = (r[2] - r[0]) / 2, b = (r[3] - r[1]) / 2;
    let x = Math.abs(p[0] - r[0] - a), y = Math.abs(p[1] - r[1] - b);
    if (a < b) { [a, b] = [b, a]; [x, y] = [y, x]; }
    if (!b) return Math.hypot(Math.max(0, x - a), y);
    if (a === b) return Math.abs(Math.hypot(x, y) - a);
    const aa = a * a, bb = b * b;
    if (y === 0) {
      const cosine = Math.min(1, a * x / (aa - bb));
      return Math.hypot(a * cosine - x, b * Math.sqrt(1 - cosine * cosine));
    }
    let low = -bb, high = Math.hypot(a * x, b * y);
    for (let i = 0; i < 52; i++) {
      const mid = low + (high - low) / 2;
      if ((a * x / (aa + mid)) ** 2 + (b * y / (bb + mid)) ** 2 > 1) low = mid;
      else high = mid;
    }
    return Math.hypot(aa * x / (aa + high) - x, bb * y / (bb + high) - y);
  }
  function bounds(mark) {
    if (mark.shape === "highlight" && mark.points?.length)
      return AtriumSchNoteInk.bounds(mark.points, {brush: "highlighter", width: mark.width});
    const r = box(mark), pad = mark.shape === "highlight" || mark.shape === "text" ? 0 : mark.width / 2;
    const result = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
    if (mark.shape === "arrow") {
      const h = arrow(mark);
      if (h) for (const p of [h.left, h.right]) {
        result[0] = Math.min(result[0], p[0]); result[1] = Math.min(result[1], p[1]);
        result[2] = Math.max(result[2], p[0]); result[3] = Math.max(result[3], p[1]);
      }
    }
    return result;
  }
  function hit(mark, point, tolerance = 0) {
    if (!contains(bounds(mark), point, tolerance)) return false;
    const r = box(mark), d = tolerance + mark.width / 2;
    switch (mark.shape) {
    case "text": return true;
    case "highlight": return !mark.points?.length || AtriumSchNoteInk.hit(mark.points, {brush: "highlighter", width: mark.width}, point, point, tolerance);
    case "ellipse": return ellipseDistance(point, r) <= d;
    case "box": {
      const c = [[r[0],r[1]], [r[2],r[1]], [r[2],r[3]], [r[0],r[3]]];
      return c.some((p, i) => distance(point, p, c[(i + 1) % 4]) <= d);
    }
    case "arrow": {
      const h = arrow(mark);
      if (!h) return distance(point, mark.at, mark.at) <= d;
      if (distance(point, mark.at, h.neck) <= d) return true;
      const poly = [mark.to, h.left, h.right];
      return poly.every((p, i) => cross(p, poly[(i + 1) % 3], point) >= 0) ||
        poly.some((p, i) => distance(point, p, poly[(i + 1) % 3]) <= tolerance);
    }
    default: return false;
    }
  }
  function draw(ctx, mark, {colour, drawText} = {}) {
    const r = box(mark), w = r[2] - r[0], h = r[3] - r[1];
    ctx.save();
    try {
      ctx.fillStyle = ctx.strokeStyle = colour;
      ctx.lineWidth = mark.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
      switch (mark.shape) {
      case "text":
        if (!drawText) throw Error("Text markup needs a text renderer.");
        drawText(ctx, mark); return;
      case "highlight":
        if (mark.points?.length) AtriumSchNoteInk.draw(ctx, mark.points, {brush: "highlighter", width: mark.width}, colour);
        else { ctx.globalAlpha *= AtriumSchNoteInk.highlighterAlpha; ctx.fillRect(r[0], r[1], w, h); }
        return;
      case "box": ctx.strokeRect(r[0], r[1], w, h); return;
      case "ellipse":
        ctx.beginPath();
        if (w && h) ctx.ellipse(r[0] + w / 2, r[1] + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
        else { ctx.moveTo(...mark.at); ctx.lineTo(...mark.to); }
        ctx.stroke(); return;
      case "arrow": {
        const head = arrow(mark);
        ctx.beginPath();
        if (!head) { ctx.arc(...mark.at, mark.width / 2, 0, 2 * Math.PI); ctx.fill(); return; }
        ctx.moveTo(...mark.at); ctx.lineTo(...head.neck); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(...mark.to); ctx.lineTo(...head.left); ctx.lineTo(...head.right); ctx.closePath(); ctx.fill(); return;
      }
      default: throw Error("Unknown image markup shape.");
      }
    } finally { ctx.restore(); }
  }
  return Object.freeze({draw, hit, bounds});
})();
