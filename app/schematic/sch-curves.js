"use strict";
// Exact schematic curves kept beside a path's points (sch-import.js). The points remain the drawing
// for polygon tools, hit testing and older readers. A curve is used only while the points still trace
// it, so an editor that changed the points (a vertex edit, a rotation) never shows a stale curve.
// The descriptors are relative to the first point, so a move that shifts the points keeps the curve.
//
//   ellipse {a, b, sweep}       c + a·cos t + b·sin t for t from 0 to sweep degrees, with the centre
//                               c = points[0] − a; points evenly spaced in t.
//   arc {x, y, r, start, end}   the symbol editor's arc (symbol-editor.js): screen degrees, clockwise
//                               from start to end. Sheet arcs use the board form (model.js pathArc).
//
//   AtriumSchCurves.trace(ctx, shape) -> true when it traced the exact curve as the current path
//   AtriumSchCurves.ellipse(shape) / arc(shape) -> absolute geometry, or null
// Lazy (app/lazy.js "AtriumSchCurves", prefetched when the editor is idle). Until it loads, and in a
// release without it, the canvas (sch-appearance.js shape, canvas.js drawItemPath) draws the points.
globalThis.AtriumSchCurves = (() => {
  const A = Atrium, TOL = 5e-6;
  const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const near = (p, q) => point(q) && Math.abs(p[0] - q[0]) <= TOL && Math.abs(p[1] - q[1]) <= TOL;
  const origin = s => Array.isArray(s?.points) && s.points.length > 1 && point(s.points[0]) ? s.points[0] : null;
  function ellipsePoint(e, t) {
    const a = A.rad(t), c = Math.cos(a), s = Math.sin(a);
    return [e.c[0] + e.a[0] * c + e.b[0] * s, e.c[1] + e.a[1] * c + e.b[1] * s];
  }
  function ellipse(s) {
    const e = s?.ellipse, p0 = origin(s);
    if (!p0 || !e || !point(e.a) || !point(e.b) || !Number.isFinite(e.sweep) || !e.sweep || Math.abs(e.sweep) > 360) return null;
    const out = {c: [p0[0] - e.a[0], p0[1] - e.a[1]], a: e.a, b: e.b, sweep: e.sweep}, n = s.points.length - 1;
    for (let k = 1; k <= n; k++) if (!near(ellipsePoint(out, e.sweep * k / n), s.points[k])) return null;
    return out;
  }
  function arc(s) {
    const g = s?.arc;
    if (!origin(s) || !g || g.kind != null || ![g.x, g.y, g.r, g.start, g.end].every(Number.isFinite) || g.r <= 0) return null;
    const sweep = ((g.end - g.start) % 360 + 360) % 360 || 360, at = a => [g.x + g.r * Math.cos(A.rad(a)), g.y + g.r * Math.sin(A.rad(a))];
    const p = s.points[0], q = s.points.at(-1), from = at(g.start), to = at(g.end), slack = TOL / g.r * 180 / Math.PI;
    if (!(near(from, p) && near(to, q) || near(to, p) && near(from, q))) return null;
    for (const v of s.points) {
      if (!point(v) || Math.abs(Math.hypot(v[0] - g.x, v[1] - g.y) - g.r) > TOL) return null;
      const turn = ((Math.atan2(v[1] - g.y, v[0] - g.x) * 180 / Math.PI - g.start) % 360 + 360) % 360;
      if (turn > sweep + slack && turn < 360 - slack) return null;
    }
    return {x: g.x, y: g.y, r: g.r, start: g.start, end: g.start + sweep};
  }
  function trace(ctx, s) {
    if (!s.ellipse && !s.bezier && !s.arc) return false;
    const e = ellipse(s), g = !e && arc(s);
    if (!e && !g) return false;
    ctx.beginPath();
    if (e) {
      // A transformed unit circle; the caller strokes with its own pen after the restore.
      ctx.moveTo(...s.points[0]);
      ctx.save(); ctx.transform(e.a[0], e.a[1], e.b[0], e.b[1], e.c[0], e.c[1]); ctx.arc(0, 0, 1, 0, A.rad(e.sweep), e.sweep < 0); ctx.restore();
    } else {
      ctx.moveTo(g.x + g.r * Math.cos(A.rad(g.start)), g.y + g.r * Math.sin(A.rad(g.start)));
      ctx.arc(g.x, g.y, g.r, A.rad(g.start), A.rad(g.end), false);
    }
    if (s.closed) ctx.closePath();
    return true;
  }
  return Object.freeze({trace, ellipse, ellipsePoint, arc});
})();
