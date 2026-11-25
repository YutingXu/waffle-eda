"use strict";
// Physical curve projection in board XY. The resolved board view will use
// this kernel once it is installed. Standalone profile and format code can
// already share it without depending on editor, journal or document state.
globalThis.AtriumGeometryCurves = (function createGeometryCurves() {
  const D = Math.PI / 180, MAX_POINTS = 20001;
  const point = p => p?.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const joint = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <=
    16 * Number.EPSILON * Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));

  const line = (a, b) => ({kind: "line", a, b});
  const arc = (center, radius, start, sweep) => ({kind: /** @type {const} */ ("arc"), center, radius, start, sweep});
  const circlePoint = ([x, y], r, a) => [x + r * Math.cos(a * D), y - r * Math.sin(a * D)];
  const angle = (a, b) => Math.atan2(a[1] - b[1], b[0] - a[0]) / D;
  const arcEdge = (g, sweep = globalThis.Atrium.arcSweep(g)) => arc(g.c, g.r, g.start, sweep);
  const phase = (start, sweep, a) => ((a - start) * Math.sign(sweep) % 360 + 360) % 360;
  // Native encoders quantize evaluated endpoints. Keep the authored angle so
  // equivalent phases (e.g. 0 and 360 degrees) tie-break the same way as before.
  const authoredEnds = new WeakMap();
  function artworkArc(source) {
    const edge = arcEdge(source);
    authoredEnds.set(edge, source.end);
    return edge;
  }
  const arcEndAngle = edge => authoredEnds.get(edge) ?? edge.start + edge.sweep;
  function pathEdges(item) {
    const curve = globalThis.Atrium.pathArc(item);
    return curve ? [arcEdge(curve)] : lineEdges(item.points);
  }
  function pathPoints(item, tolerance) {
    const curve = !item.fill && globalThis.Atrium.pathArc(item);
    return curve ? flatten([arcEdge(curve)], tolerance) : item.points;
  }
  /** @param {readonly import("./resolved-geometry").XY[]} points */
  function lineEdges(points = []) {
    if (points.length === 1) return [line(points[0], points[0])];
    return points.slice(1).map((p, i) => line(points[i], p));
  }
  function artworkFrame(part) {
    const {at,mirror}=globalThis.Atrium.placement(part);
    return {at,turn:part.angle||0,mirror};
  }
  function flashFrame({at: [x, y], clockwiseDegrees: angle, mirrorLocalX: mirror}) {
    return artworkFrame({x, y, angle, mirror});
  }
  const artworkPolarity = shape => shape.polarity === "clear" ? "clear" : "add";
  function placeEdge(edge, transform) {
    if (!transform) return edge;
    const {at, turn, mirror} = transform, {kind} = edge;
    if (kind === "line") return line(at(edge.a), at(edge.b));
    if (kind === "arc") {
      const angleAt = a => (mirror ? 180 - a : a) - turn;
      const placed = arc(at(edge.center), edge.radius, angleAt(edge.start), mirror ? -edge.sweep : edge.sweep);
      const end = authoredEnds.get(edge);
      if (end !== undefined) authoredEnds.set(placed, angleAt(end));
      return placed;
    }
    const vector = p => globalThis.Atrium.rotate(mirror ? [-p[0], p[1]] : p, turn);
    return {...edge, center: at(edge.center), cosineAxis: vector(edge.cosineAxis), sineAxis: vector(edge.sineAxis)};
  }
  function placeArea(area, frame) {
    const loop = edges => edges.map(edge => placeEdge(edge, frame));
    return area.map(({outer, holes}) => ({outer: loop(outer), holes: holes.map(loop)}));
  }
  function edgeBounds(edge, box) {
    function include(x, y) {
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
    if (edge.kind === "line") {
      include(...edge.a); include(...edge.b);
      return;
    }
    const [x, y] = edge.center, {start, sweep} = edge;
    const [cx, cy] = edge.kind === "arc" ? [edge.radius, 0] : edge.cosineAxis;
    const [sx, sy] = edge.kind === "arc" ? [0, -edge.radius] : edge.sineAxis;
    const xMax = Math.atan2(sx, cx) / D, yMax = Math.atan2(sy, cy) / D;
    const extremum = a => phase(start, sweep, a) <= Math.abs(sweep);
    for (const a of [start, start + sweep, ...[xMax, xMax + 180, yMax, yMax + 180].filter(extremum)]) {
      const c = Math.cos(a * D), s = Math.sin(a * D);
      include(x + cx * c + sx * s, y + cy * c + sy * s);
    }
  }
  // Analytic box intersections select runs of the original sampling grid.
  // Enlarging the box by the chord error belongs to the requesting stroke.
  function* arcRuns(edge, tolerance, box, source = edge) {
    const {center:[x,y], radius, sweep} = edge, start = edge.start % 360;
    const span = Math.abs(sweep), cuts = [0,1];
    function add(a) {
      const t = phase(start,sweep,a) / span;
      if (t > 0 && t < 1) cuts.push(t);
    }
    for (const px of [box[0],box[2]]) if (Math.abs(px-x) <= radius) {
      const a = Math.acos((px-x)/radius)/D;
      add(a); add(-a);
    }
    for (const py of [box[1],box[3]]) if (Math.abs(py-y) <= radius) {
      const a = Math.asin((y-py)/radius)/D;
      add(a); add(180-a);
    }
    cuts.sort((a,b) => a-b);
    let count = 0, runStart = null;
    for (let j=1; j<cuts.length; j++) {
      const lo=cuts[j-1], hi=cuts[j];
      if (lo === hi) continue;
      const [px,py] = circlePoint(edge.center,radius,start+sweep*(lo+hi)/2);
      const inside = px>=box[0] && py>=box[1] && px<=box[2] && py<=box[3];
      if (inside && runStart == null) runStart = lo;
      if (runStart != null && (!inside || hi === 1)) {
        const run = project([source],tolerance,{interval:[runStart,inside?hi:lo]});
        count += run.length;
        if (count > MAX_POINTS) throw new RangeError("Curve point budget exceeded.");
        yield run;
        runStart = null;
      }
    }
  }
  // Keep true curves and compound regions until a consumer requests a projection.
  // Plotters may normalize ordinary vertices without altering the retained geometry.
  function artworkInk(shape, width, emit, preparePolygon) {
    const region = (outer, holes = []) => ({kind: "region", islands: [{outer, holes}]});
    const stroke = centerline => ({kind: "stroke", centerline, width});
    if (shape.kind === "circle") {
      if (!Number.isFinite(shape.r) || !(shape.r > 0)) return true;
      const radius = shape.r + (shape.fill ? Math.max(0, shape.width || 0) / 2 : 0);
      const loop = [arc([shape.x, shape.y], radius, 0, 360)];
      if (shape.fill) emit(region(loop), "disk", true);
      else emit(stroke(loop), "ring", true);
      return true;
    }
    if (!shape.points?.length) return false;
    const exact = shape.fill && shape.points.length >= 3 && shape.regionShape && globalThis.AtriumBoardShape.regionOf(shape);
    if (exact) {
      const edges = loop => loop.map(edge => edge.kind === "arc" ? artworkArc(edge) : edge);
      const outer = edges(exact.contour);
      emit(region(outer, exact.cutouts.map(edges)), "region", true);
      if (shape.strokeOutline && shape.width > 0) emit(stroke(outer), "outline", true);
      return true;
    }
    const path = !shape.fill && globalThis.Atrium.pathArc(shape);
    if (path) {
      emit(stroke([artworkArc(path)]), "arc", true);
      return true;
    }
    const source = preparePolygon ? preparePolygon(shape) : shape;
    if (!source?.points?.length) return true;
    const {points, closed, strokeOutline} = source, filled = source.fill && points.length >= 3;
    const edges = lineEdges(points);
    if ((filled || closed) && points.length > 2 && !same(points[0], points.at(-1))) edges.push(line(points.at(-1), points[0]));
    if (filled) emit(region(edges), "region", false);
    if (!filled || strokeOutline && source.width > 0) emit(stroke(edges), filled ? "outline" : "stroke", false);
    return true;
  }
  function checkTolerance(toleranceMm) {
    if (!(Number.isFinite(toleranceMm) && toleranceMm > 0)) throw new RangeError("Invalid curve tolerance.");
  }

  // This small factory also runs in the pour tile worker. Tangent vertices
  // lie on a larger circle so their chords enclose the requested clearance.
  function createRoundProjection() {
    const circles = new Map();
    const step = (r, tol, tangent) => 2 * Math.acos(tangent ? r / (r + tol) : Math.max(-1, 1 - tol / r));
    function vertices(out, x, y, r, start, spacing, phase, first, end) {
      for (let j = first; j < end; j++) {
        const a = start + (j + phase) * spacing;
        out.push(x + r * Math.cos(a), y + r * Math.sin(a));
      }
    }
    function envelope(out, x, y, r, start, sweep, limitStep, tangent, full, limit) {
      if (full) sweep = 2 * Math.PI;
      const count = Math.min(limit, Math.max(full ? 8 : 1, Math.ceil(sweep / limitStep)));
      const spacing = sweep / count, radius = tangent ? r / Math.cos(spacing / 2) : r, phase = tangent ? .5 : 0;
      if (full && start === 0) {
        const key = count + "|" + radius + "|" + tangent;
        let template = circles.get(key);
        if (!template) {
          template = [];
          vertices(template, 0, 0, radius, start, spacing, phase, 0, count);
          if (circles.size > 2048) circles.clear();
          circles.set(key, template);
        }
        for (let j = 0; j < template.length; j += 2) out.push(x + template[j], y + template[j + 1]);
      } else vertices(out, x, y, radius, start, spacing, phase, full || tangent ? 0 : 1, count);
      return radius;
    }
    return {step, envelope};
  }
  const round = createRoundProjection();

  // Legacy formats and conservative clearance envelopes can additionally
  // constrain the angular spacing or bound their projection before allocation.
  function project(edges, toleranceMm, {minSegments = 1, maxSegments = Infinity, minStep = 0, maxStep = 90, legacyRadians = false, legacyDegrees = false, interval = null} = {}) {
    checkTolerance(toleranceMm);
    const out = [];
    function append(p) {
      if (!point(p)) throw new RangeError("Invalid curve point.");
      if (out.length && same(out.at(-1), p)) return;
      if (out.length === MAX_POINTS) throw new RangeError("Curve point budget exceeded.");
      out.push([p[0], p[1]]);
    }
    function startAt(p) {
      if (!out.length) append(p);
      else if (!point(p) || !joint(out.at(-1), p)) throw new RangeError("Discontinuous edge chain.");
    }
    for (const edge of edges) {
      if (edge.kind === "line") {
        startAt(edge.a);
        append(edge.b);
        continue;
      }
      const {center, start, sweep} = edge;
      const u = edge.kind === "arc" && !(legacyRadians && edge.cosineAxis) ? [edge.radius, 0] : edge.cosineAxis;
      const v = edge.kind === "arc" && !(legacyRadians && edge.sineAxis) ? [0, -edge.radius] : edge.sineAxis;
      if (!point(center) || !point(u) || !point(v) || !Number.isFinite(start) || !Number.isFinite(sweep) ||
          (edge.kind === "arc" && !(edge.radius > 0))) throw new RangeError("Invalid curved edge.");
      // The Frobenius norm bounds the amplification of a unit-circle chord's
      // sagitta under a general ellipse transform, including a skewed basis.
      const r = edge.kind === "arc" ? edge.radius : Math.hypot(...u, ...v);
      if (!Number.isFinite(r)) throw new RangeError("Invalid curved edge extent.");
      // Authored trace and offset commands used radians and this rounding at exact
      // subdivision ties. Replay those sampled vertices without changing flatten().
      const unit = legacyRadians ? D : 1, ratio = toleranceMm / r;
      const step = legacyRadians ? round.step(r, toleranceMm) : 4 * Math.asin(Math.sqrt(Math.min(1, ratio / 2))) / D;
      const n = sweep === 0 ? 0 : Math.min(maxSegments,
        Math.max(minSegments, Math.ceil(Math.abs(sweep) / Math.max(minStep * unit, Math.min(maxStep * unit, step)))));
      const first = interval ? Math.floor(interval[0] * n) : 0, last = interval ? Math.ceil(interval[1] * n) : n;
      if (!Number.isFinite(n) || last - first + Math.max(1, out.length) > MAX_POINTS) throw new RangeError("Curve point budget exceeded.");
      const at = offset => {
        const t = legacyRadians ? start + offset : legacyDegrees ? (start + offset) * Math.PI / 180 : (start % 360 + offset) * D;
        const c = Math.cos(t), s = Math.sin(t);
        return [center[0] + u[0] * c + v[0] * s,
          legacyRadians ? center[1] + v[1] * s + u[1] * c : center[1] + u[1] * c + v[1] * s];
      };
      const a = at(0);
      startAt(first ? at(sweep * (first / n)) : a);
      for (let i = first + 1; i <= last; i++) {
        const closing = !legacyDegrees && i === n && sweep % (360 * unit) === 0;
        append(closing ? a : at(legacyRadians || legacyDegrees ? sweep * i / n : sweep * (i / n)));
      }
    }
    // Preserve the legacy writer's final quantized coordinate at rounding ties.
    if (!legacyDegrees && out.length > 2 && joint(out[0], out.at(-1))) out[out.length - 1] = out[0];
    return out;
  }

  /** @type {import("./resolved-geometry").ResolvedBoardGeometry["flatten"]} */
  const flatten = (edges, toleranceMm) => project(edges, toleranceMm);

  const disk = (center, r) => ({outer: [arc(center, r, 0, 360)], holes: []});
  function lineStroke({a, b}, r) {
    if (same(a, b)) return disk(a, r);
    const start = angle(a, b) - 90;
    const p0 = circlePoint(a, r, start), q0 = circlePoint(b, r, start);
    const p1 = circlePoint(a, r, start + 180), q1 = circlePoint(b, r, start + 180);
    return {outer: [line(p0, q0), arc(b, r, start, 180), line(q1, p1), arc(a, r, start + 180, 180)], holes: []};
  }
  // Positive sweeps up to a half-turn have a single simple outline.
  function arcStrip(center, radius, start, sweep, r) {
    const end = start + sweep, a = circlePoint(center, radius, start), b = circlePoint(center, radius, end);
    const outer = [arc(center, radius + r, start, sweep)];
    if (r < radius) {
      outer.push(arc(b, r, end, 180), arc(center, radius - r, end, -sweep), arc(a, r, start + 180, 180));
    } else {
      // The inner boundary ends at the intersection of the round caps.
      const t = sweep * D / 2, halfChord = radius * Math.sin(t);
      const inset = radius * Math.cos(t) - Math.sqrt((r - halfChord) * (r + halfChord));
      const join = circlePoint(center, inset, start + sweep / 2);
      const n = angle(b, join), m = angle(a, join);
      outer.push(arc(b, r, end, (n - end + 720) % 360), arc(a, r, m, (start - m + 720) % 360));
    }
    return {outer, holes: []};
  }
  // STEP has an exact representation for separate circular solids. Use the
  // same pieces for that encoding and for composing a single filled area.
  function strokePieces(stroke, toleranceMm) {
    checkTolerance(toleranceMm);
    const r = stroke.width / 2;
    if (!Number.isFinite(r) || r <= 0) return [];
    return stroke.centerline.flatMap(edge => {
      if (edge.kind === "line") return [lineStroke(edge, r)];
      if (edge.kind === "ellipseArc") return lineEdges(flatten([edge], toleranceMm / 2)).map(s => lineStroke(s, r));
      const {center, radius, sweep} = edge, span = Math.abs(sweep);
      const start = (edge.start + Math.min(sweep, 0)) % 360;
      if (span >= 360) return [{outer: [arc(center, radius + r, start, 360)],
        holes: radius > r ? [[arc(center, radius - r, start, -360)]] : []}];
      if (span === 0) return [disk(circlePoint(center, radius, start), r)];
      if (span <= 180 || r < radius * Math.sin(span * D / 2)) return [arcStrip(center, radius, start, span, r)];
      return [arcStrip(center, radius, start, 180, r), arcStrip(center, radius, start + 180, span - 180, r)];
    });
  }

  /** @type {import("./resolved-geometry").ResolvedBoardGeometry["strokeOutline"]} */
  function strokeOutline(stroke, toleranceMm) {
    if (stroke.centerline.length > MAX_POINTS) throw new RangeError("Stroke point budget exceeded.");
    const pieces = strokePieces(stroke, toleranceMm);
    if (pieces.length < 2) return pieces;
    // Adjacent round caps overlap. Unite their ink before returning rings
    // so an even-odd fill gets the same physical area.
    if (!globalThis.AtriumPolygonPour && typeof require === "function") require("./polygon-pour.js");
    let count = 0;
    const rings = pieces.flatMap(({outer, holes}) => [outer, ...holes]).map(loop => {
      const points = flatten(loop, toleranceMm / 4);
      if ((count += points.length) > MAX_POINTS) throw new RangeError("Stroke point budget exceeded.");
      return points.slice(0, -1);
    });
    const loopOf = points => points.map((a, i) => line(a, points[(i + 1) % points.length]));
    return AtriumPolygonPour.boolean([rings], ([winding]) => winding !== 0, Math.max(1e6, 8 / toleranceMm), 4 / toleranceMm)
      .map(({outline, holes}) => ({outer: loopOf(outline), holes: holes.map(loopOf)}));
  }

  return Object.freeze({flatten, project, strokeOutline, strokePieces, arcEdge, arcEndAngle, pathEdges, pathPoints, lineEdges,
    artworkInk, artworkFrame, artworkPolarity, placeEdge, flashFrame, placeArea, edgeBounds, arcRuns,
    roundProjection: Object.freeze(round), roundProjectionSource: () => "(" + createRoundProjection.toString() + ")()",
    source: () => "(" + createGeometryCurves.toString() + ")()"});
})();
