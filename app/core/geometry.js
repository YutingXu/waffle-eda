"use strict";

globalThis.AtriumGeometry = (() => {
  // The autorouter embeds this factory in its Blob Worker.
  function create() {
    // Even-odd crossings use a strict half-open edge test. Callers choose their
    // own boundary tolerance and how to combine an outline with holes.
    function inRingAt(x, y, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    }
    function inRing(p, ring) {
      return inRingAt(p[0], p[1], ring);
    }
    // Keep packed router contours in place, without creating point arrays.
    function inFlatRing(x, y, ring) {
      let inside = false;
      for (let i = 0, n = ring.length >> 1, j = n - 1; i < n; j = i++) {
        const ax = ring[2 * i], ay = ring[2 * i + 1], bx = ring[2 * j], by = ring[2 * j + 1];
        if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
      }
      return inside;
    }
    function pointSegmentDistanceSquared(px, py, ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
      let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const x = ax + dx * t - px, y = ay + dy * t - py;
      return x * x + y * y;
    }
    const orientAt = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    function segmentDistanceSquared(ax, ay, bx, by, cx, cy, dx, dy) {
      const a = orientAt(cx, cy, dx, dy, ax, ay), b = orientAt(cx, cy, dx, dy, bx, by);
      const c = orientAt(ax, ay, bx, by, cx, cy), d = orientAt(ax, ay, bx, by, dx, dy);
      if (((a > 0 && b < 0) || (a < 0 && b > 0)) && ((c > 0 && d < 0) || (c < 0 && d > 0))) return 0;
      const p = pointSegmentDistanceSquared;
      return Math.min(p(ax, ay, cx, cy, dx, dy), p(bx, by, cx, cy, dx, dy), p(cx, cy, ax, ay, bx, by), p(dx, dy, ax, ay, bx, by));
    }
    return {inRing, inRingAt, inFlatRing, orientAt, pointSegmentDistanceSquared, segmentDistanceSquared};
  }
  const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const opposite = (a, b) => (a > 0 && b < 0) || (a < 0 && b > 0);
  // A zero orientation is a touch or overlap, not a crossing.
  function strictCrossing(a, b, c, d) {
    return opposite(orient(c, d, a), orient(c, d, b)) && opposite(orient(a, b, c), orient(a, b, d));
  }
  function projectPointOnSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
    return [a[0] + dx * t, a[1] + dy * t];
  }
  // Keep witnesses on the first and second segment respectively. Ties retain
  // the first candidate, in the order of the endpoints p, q, r, s.
  function closestSegments(p, q, r, s) {
    const o1 = orient(p, q, r), o2 = orient(p, q, s), o3 = orient(r, s, p), o4 = orient(r, s, q);
    if (opposite(o1, o2) && opposite(o3, o4)) {
      const t = o3 / (o3 - o4), at = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      return {d:0, pa:at, pb:at};
    }
    let best = {d:Infinity};
    const witnesses = [[p, projectPointOnSegment(p, r, s)], [q, projectPointOnSegment(q, r, s)],
      [projectPointOnSegment(r, p, q), r], [projectPointOnSegment(s, p, q), s]];
    for (const [pa, pb] of witnesses) {
      const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      if (d < best.d) best = {d, pa, pb};
    }
    return best;
  }
  // Route gap tests use the residual in segment-local coordinates. Adding a
  // large origin to the projected vector first changes the rounded distance.
  function pointSegmentDistance(p, a, b) {
    const x = p[0] - a[0], y = p[1] - a[1], dx = b[0] - a[0], dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, (x * dx + y * dy) / length2)) : 0;
    return Math.hypot(x - t * dx, y - t * dy);
  }
  function segmentDistance(a, b, c, d) {
    const o1 = orient(c, d, a), o2 = orient(c, d, b), o3 = orient(a, b, c), o4 = orient(a, b, d);
    if (opposite(o1, o2) && opposite(o3, o4)) return 0;
    return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
      pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
  }
  // The STEP export worker embeds only the independent placement operations.
  function createAffine3D() {
    const point = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]];
    const direction = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2], M[1] * p[0] + M[5] * p[1] + M[9] * p[2], M[2] * p[0] + M[6] * p[1] + M[10] * p[2]];
    // Transform an axis-aligned bound by the same affine placement as the body.
    function bounds(M, b) {
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 8; c++) {
        const p = point(M, [b[c & 1 ? 3 : 0], b[c & 2 ? 4 : 1], b[c & 4 ? 5 : 2]]);
        for (let k = 0; k < 3; k++) { box[k] = Math.min(box[k], p[k]); box[k + 3] = Math.max(box[k + 3], p[k]); }
      }
      return box;
    }
    return {point, direction, bounds};
  }
  return {...create(), orient, strictCrossing, projectPointOnSegment, closestSegments, segmentDistance, create, createAffine3D, affine3D: createAffine3D()};
})();

if (typeof module === "object" && module.exports) module.exports = globalThis.AtriumGeometry;
