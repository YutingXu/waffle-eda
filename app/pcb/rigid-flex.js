"use strict";
if (!globalThis.AtriumLandContours && typeof require === "function") require("./land-contours.js");

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");

// Rigid-flex: board regions, bend lines, the Board Planning view, the
// rigid-flex design rule checks and fabrication layers. The stack model
// (substacks, coverlay, stiffener and adhesive layers) lives in stackup.js;
// regions and bends are stored with it:
//   doc.stackup.regions = [{id, name, stack, points:[[x,y]...]}]
//   doc.stackup.bends   = [{id, name, a:[x,y], b:[x,y], angle, radius, width, dynamic}]
// `stack` is a substack id ("main" is the master stack). A board without
// stored regions is one region, the board outline, on the master stack.
// Bend angle is in degrees: positive folds the side of the line away from the
// fixed (largest rigid) region toward the top side, negative toward the bottom
// (flex-fold.js). width is the bend zone across the line (0 = the neutral-axis
// arc length, radius x angle). order (optional, 1..99) is the fold sequence:
// lower orders fold first; bends without one fold with the first group.
globalThis.AtriumRigidFlex = (() => {
  const EPS = 1e-9, DEG = Math.PI / 180;
  const S = () => globalThis.AtriumStackup;
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

  // ---------------------------------------------------------------- geometry
  function area(poly) {let s = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]; return s / 2;}
  function box(poly) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of poly) {if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];}
    return [a, b, c, d];
  }
  const inside = globalThis.AtriumGeometry.inRing;
  const inBox = (p, b, m = 0) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
  const boxesMeet = (a, b, m = 0) => a[0] <= b[2] + m && b[0] <= a[2] + m && a[1] <= b[3] + m && b[1] <= a[3] + m;
  // Parameters (t on ab, u on cd) of a proper or touching intersection.
  function cross(a, b, c, d) {
    const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-15) return null;
    const qx = c[0] - a[0], qy = c[1] - a[1], t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? {t, u} : null;
  }
  const segDist = (p, a, b) => globalThis.Atrium.nearSegment(p, a, b);
  function segSegDist(a, b, c, d) {
    if (cross(a, b, c, d)) return 0;
    return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
  }
  // Convex polygons overlap (separating axis theorem).
  function convexOverlap(P, Q) {
    for (const poly of [P, Q]) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const nx = poly[i][1] - poly[j][1], ny = poly[j][0] - poly[i][0];
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const p of P) {const v = p[0] * nx + p[1] * ny; a = Math.min(a, v); b = Math.max(b, v);}
      for (const p of Q) {const v = p[0] * nx + p[1] * ny; c = Math.min(c, v); d = Math.max(d, v);}
      if (b < c - EPS || d < a - EPS) return false;
    }
    return true;
  }
  function polyOverlap(P, Q) {
    if (P.some(p => inside(p, Q)) || Q.some(p => inside(p, P))) return true;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) for (let k = 0, l = Q.length - 1; k < Q.length; l = k++) if (cross(P[j], P[i], Q[l], Q[k])) return true;
    return false;
  }
  // Distance from p to the boundary of poly.
  function edgeDist(p, poly) {
    let d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(p, poly[j], poly[i]));
    return d;
  }
  const TOUCH = 1e-6; // mm: closer than this to a boundary counts as on it
  const strictlyInside = (p, poly) => inside(p, poly) && edgeDist(p, poly) > TOUCH;
  // Parameters along ab where it crosses the edges of poly, with 0 and 1.
  function cuts(a, b, poly, ts = [0, 1]) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {const c = cross(a, b, poly[j], poly[i]); if (c) ts.push(Math.min(1, Math.max(0, c.t)));}
    return ts;
  }
  // First point of segment ab strictly inside poly (a stretch of positive
  // length, not a touch or a run along the boundary), or null.
  function segInside(a, b, poly) {
    const ts = cuts(a, b, poly).sort((x, y) => x - y);
    for (let k = 1; k < ts.length; k++) {
      if (ts[k] - ts[k - 1] <= 1e-12) continue;
      const t = (ts[k] + ts[k - 1]) / 2, m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (strictlyInside(m, poly)) return m;
    }
    return null;
  }
  // Does a disc (centre c, radius rad) reach strictly into poly?
  const circleIn = (c, rad, poly) => strictlyInside(c, poly) || (rad > TOUCH && edgeDist(c, poly) < rad - TOUCH);
  // Do two simple polygons share positive area? Shared edges and touching
  // corners do not count.
  function areaOverlap(P, Q) {
    for (const [A, B] of [[P, Q], [Q, P]]) for (let i = 0, j = A.length - 1; i < A.length; j = i++) if (segInside(A[j], A[i], B)) return true;
    // Coincident boundaries (P == Q, or P inside Q sharing every edge): probe
    // just inside each edge of P.
    const sgn = Math.sign(area(P)) || 1;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[j], b = P[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!(len > TOUCH)) continue;
      const k = 10 * TOUCH / len * sgn, m = [(a[0] + b[0]) / 2 - (b[1] - a[1]) * k, (a[1] + b[1]) / 2 + (b[0] - a[0]) * k];
      if (inside(m, P) && inside(m, Q)) return true;
    }
    return false;
  }

  // Split a simple polygon along segment ab. Every stretch of ab inside the
  // polygon cuts it; returns the pieces (one piece when ab misses it).
  // A piece worth keeping: not a sliver (mean width above 1 um and area above
  // 1e-7 of the polygon it came from).
  function perimeter(poly) {let s = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]); return s;}
  function solid(piece, whole) {
    const A = Math.abs(area(piece));
    return A > 1e-9 && A > 1e-7 * Math.abs(area(whole)) && 2 * A / perimeter(piece) > 1e-3;
  }
  function splitPolygon(poly, a, b) {
    const pieces = [poly.map(p => [p[0], p[1]])], out = [];
    let guard = 0;
    while (pieces.length && guard++ < 64) {
      const P = pieces.pop(), hits = [];
      for (let i = 0; i < P.length; i++) {
        const c = cross(a, b, P[i], P[(i + 1) % P.length]);
        if (c && c.u < 1 - 1e-12) hits.push({t:c.t, edge:i, u:c.u, at:[a[0] + (b[0] - a[0]) * c.t, a[1] + (b[1] - a[1]) * c.t]});
      }
      hits.sort((x, y) => x.t - y.t);
      const uniq = hits.filter((h, k) => !k || Math.hypot(h.at[0] - hits[k - 1].at[0], h.at[1] - hits[k - 1].at[1]) > 1e-7);
      let done = false;
      for (let k = 0; k + 1 < uniq.length && !done; k++) {
        const p = uniq[k], q = uniq[k + 1], m = [(p.at[0] + q.at[0]) / 2, (p.at[1] + q.at[1]) / 2];
        if (!inside(m, P) || p.edge === q.edge) continue;
        const [x, y] = p.edge < q.edge ? [p, q] : [q, p], n = P.length;
        const A = [x.at, ...P.slice(x.edge + 1, y.edge + 1), y.at];
        const B = [y.at, ...P.slice(y.edge + 1, n), ...P.slice(0, x.edge + 1), x.at];
        const clean = Q => Q.filter((v, i) => Math.hypot(v[0] - Q[(i + 1) % Q.length][0], v[1] - Q[(i + 1) % Q.length][1]) > 1e-9);
        const qa = clean(A), qb = clean(B);
        if (qa.length >= 3 && qb.length >= 3 && solid(qa, P) && solid(qb, P)) {pieces.push(qa, qb); done = true;}
      }
      if (!done) out.push(P);
    }
    return out.concat(pieces);
  }

  // ---------------------------------------------------------------- regions
  function outline(doc) {
    if (Array.isArray(doc?.outline) && doc.outline.length >= 3 && Math.abs(area(doc.outline)) > EPS) return doc.outline;
    return null;
  }
  function holes(doc) {try {return globalThis.AtriumBoardShape?.holes?.(doc) || [];} catch {return [];}}
  // Stored regions, or the whole board on the master stack.
  function regions(doc) {
    const st = doc?.stackup && Array.isArray(doc.stackup.regions) ? doc.stackup.regions : null;
    if (st && st.length) return st.filter(r => Array.isArray(r?.points) && r.points.length >= 3);
    const o = outline(doc);
    return o ? [{id:"board", name:"Board", stack:"main", points:o.map(p => [p[0], p[1]]), implicit:true}] : [];
  }
  const bends = doc => Array.isArray(doc?.stackup?.bends) ? doc.stackup.bends : [];
  // The stored stack of a doc, created from the derived default when needed,
  // so region and bend edits have somewhere to live.
  function storedStack(doc, defs) {
    S().guard?.(doc);
    if (!S().stored(doc)) {const s = S().get(doc, defs); delete s.derived; doc.stackup = JSON.parse(JSON.stringify(s));}
    return doc.stackup;
  }
  function uniqueId(list, base) {
    const ids = new Set(list.map(r => r.id));
    let n = list.length + 1;
    while (ids.has(base + "-" + n)) n++;
    return base + "-" + n;
  }
  // Split the region(s) the line crosses. line: {a, b} or [[x,y],[x,y]].
  // The line is extended by opts.extend (default 0.5 mm) at both ends so a
  // click on the board edge still crosses it. Mutates doc.stackup; call it in
  // an undoable edit. Returns {ok, created:[ids], split:[ids], problem}.
  function splitRegion(doc, line, opts = {}) {
    const a0 = Array.isArray(line) ? line[0] : line?.a, b0 = Array.isArray(line) ? line[1] : line?.b;
    if (!a0 || !b0 || !(Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) > 1e-6)) return {ok:false, problem:"Draw a split line with two different points."};
    if (!outline(doc)) return {ok:false, problem:"Define the board shape before splitting it into regions."};
    const len = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]), e = (opts.extend ?? 0.5) / len;
    const a = [a0[0] - (b0[0] - a0[0]) * e, a0[1] - (b0[1] - a0[1]) * e], b = [b0[0] + (b0[0] - a0[0]) * e, b0[1] + (b0[1] - a0[1]) * e];
    const current = regions(doc), next = [], created = [], split = [];
    let ids = current.map(r => ({id:r.id}));
    for (const r of current) {
      if (opts.region && r.id !== opts.region) {next.push(r); continue;}
      const pieces = splitPolygon(r.points, a, b);
      if (pieces.length < 2) {next.push(r); continue;}
      pieces.sort((p, q) => Math.abs(area(q)) - Math.abs(area(p)));
      const {implicit, ...base} = r;
      void implicit;
      split.push(r.id);
      pieces.forEach((pts, i) => {
        if (!i) {next.push({...base, points:pts}); return;}
        const id = uniqueId(ids, "region");
        ids.push({id}); created.push(id);
        next.push({id, name:(r.name || "Region") + " " + (i + 1), stack:r.stack || "main", points:pts});
      });
    }
    if (!split.length) return {ok:false, problem:"The line does not cross a board region."};
    const st = storedStack(doc, opts.defs);
    st.regions = next.map(r => ({id:r.id, name:r.name || r.id, stack:r.stack || "main", points:r.points.map(p => [+p[0], +p[1]])}));
    S().touch?.(doc);
    return {ok:true, created, split};
  }
  function assignStack(doc, regionId, stackId, defs) {
    const st = storedStack(doc, defs), list = S().substacks(st);
    if (!list.some(s => s.id === stackId)) throw Error("Unknown substack " + stackId + ".");
    if (!Array.isArray(st.regions) || !st.regions.length) st.regions = regions(doc).map(({implicit, ...r}) => (void implicit, r));
    const r = st.regions.find(x => x.id === regionId);
    if (!r) throw Error("Unknown board region " + regionId + ".");
    r.stack = stackId;
    S().touch?.(doc);
    return r;
  }
  function addBend(doc, bend, defs) {
    const st = storedStack(doc, defs);
    st.bends = Array.isArray(st.bends) ? st.bends : [];
    const b = {id:bend.id || uniqueId(st.bends, "bend"), name:bend.name || "Bend " + (st.bends.length + 1), a:[+bend.a[0], +bend.a[1]], b:[+bend.b[0], +bend.b[1]],
      angle:Number.isFinite(+bend.angle) ? +bend.angle : 90, radius:+bend.radius > 0 ? +bend.radius : 1, width:+bend.width >= 0 ? +bend.width : 0, dynamic:!!bend.dynamic};
    if (Number.isInteger(+bend.order) && +bend.order >= 1 && +bend.order <= 99) b.order = +bend.order;
    st.bends.push(b);
    S().touch?.(doc);
    return b;
  }
  function removeBend(doc, id) {
    const st = doc.stackup;
    if (!Array.isArray(st?.bends)) return false;
    const n = st.bends.length;
    st.bends = st.bends.filter(b => b.id !== id);
    if (st.bends.length !== n) S().touch?.(doc);
    return st.bends.length !== n;
  }

  // ---------------------------------------------------------------- resolved data (2D checks, STEP export)
  const isCopper = l => l.type === "Signal" || l.type === "Plane";
  function stackFacts(sub, masterZ) {
    let z = 0;
    const layers = sub.layers.map(l => {const o = {name:l.name, type:l.type, material:l.material || "", key:l.key, dk:l.dk, z0:z, z1:z + l.thickness, thickness:l.thickness}; z += l.thickness; return o;});
    const cu = layers.filter(isCopper), anchor = cu.find(l => masterZ.has(l.key));
    const off = anchor ? masterZ.get(anchor.key) - anchor.z0 : 0;
    for (const l of layers) {l.z0 += off; l.z1 += off;}
    const first = layers.indexOf(cu[0]), last = layers.indexOf(cu.at(-1));
    const body = layers.filter(l => l.type !== "Stiffener" && l.thickness > 0);
    const stiffeners = layers.filter(l => l.type === "Stiffener").map(l => ({side:layers.indexOf(l) < first ? "Top" : "Bottom", material:l.material, thickness:l.thickness, z0:l.z0, z1:l.z1}));
    const zTop = body.length ? body[0].z0 : 0, zBottom = body.length ? body.at(-1).z1 : 0;
    const coverlay = {Top:layers.slice(0, first).some(l => l.type === "Coverlay"), Bottom:layers.slice(last + 1).some(l => l.type === "Coverlay")};
    return {layers, copper:cu.map(l => l.key), zTop, zBottom, thickness:zBottom - zTop, stiffeners, coverlay};
  }
  const cache = new WeakMap();
  // Cheap content checksum of the outline: in-place vertex moves change it.
  function outlineSig(o) {
    if (!Array.isArray(o)) return "none";
    let h = o.length, k = 1;
    for (const p of o) {h = (h + (+p?.[0] || 0) * (k += 0.618034) + (+p?.[1] || 0) * (k += 0.414214)) % 1e15;}
    return o.length + ":" + h;
  }
  // Regions with their substack z-ranges and bend lines with their axes, for
  // the 2D checks, Board Planning and 3D/STEP export. z is measured down from
  // the top of the master stack (mm); shared copper layers line up.
  function regionsResolved(doc, defs) {
    // The stack's revision (stackup.js): in-place stack edits call AtriumStackup.touch.
    const st = doc?.stackup, sig = (st == null ? "null" : S().revision ? "rev:" + S().revision(doc) : JSON.stringify(st)) + "|" + outlineSig(doc?.outline);
    const hit = cache.get(doc);
    if (hit && hit.sig === sig && hit.outline === doc.outline) return hit.value;
    const stack = S().get(doc, defs), subs = S().substacks(stack), masterZ = new Map();
    let z = 0;
    for (const l of stack.layers) {if (isCopper(l)) masterZ.set(l.key, z); z += l.thickness;}
    const facts = new Map(subs.map(s => [s.id, {...stackFacts(s, masterZ), id:s.id, name:s.name, flex:!!s.flex}]));
    const main = facts.get("main");
    const regs = regions(doc).map(r => {
      const f = facts.get(r.stack) || main;
      return {id:r.id, name:r.name || r.id, stack:f.id, stackName:f.name, flex:f.flex, implicit:!!r.implicit, points:r.points, box:box(r.points), area:Math.abs(area(r.points)),
        zTop:f.zTop, zBottom:f.zBottom, thickness:f.thickness, copper:f.copper, copperIndex:new Set(f.copper.map(k => S().copperIndex(k))),
        layers:f.layers, stiffeners:f.stiffeners, coverlay:f.coverlay};
    });
    const regionAt = p => regs.find(r => inBox(p, r.box) && inside(p, r.points)) || null;
    const bl = bends(doc).map(b => {
      const dx = b.b[0] - b.a[0], dy = b.b[1] - b.a[1], len = Math.hypot(dx, dy) || 1, d = [dx / len, dy / len], n = [-d[1], d[0]];
      const mid = [(b.a[0] + b.b[0]) / 2, (b.a[1] + b.b[1]) / 2], reg = regionAt(mid);
      const arc = Math.abs(b.angle || 0) * DEG * (b.radius || 0), width = b.width > 0 ? b.width : arc, hw = width / 2;
      const zone = [[b.a[0] + n[0] * hw, b.a[1] + n[1] * hw], [b.b[0] + n[0] * hw, b.b[1] + n[1] * hw], [b.b[0] - n[0] * hw, b.b[1] - n[1] * hw], [b.a[0] - n[0] * hw, b.a[1] - n[1] * hw]];
      return {id:b.id, name:b.name || b.id, a:b.a, b:b.b, angle:b.angle || 0, radius:b.radius || 0, width, arcLength:arc, dynamic:!!b.dynamic,
        region:reg?.id || null, flex:!!reg?.flex, thickness:reg?.thickness || 0, copperCount:reg?.copper.length || 0,
        neutralZ:reg ? (reg.zTop + reg.zBottom) / 2 : 0, axis:{origin:b.a, direction:d, normal:n, length:len}, zone};
    });
    const o = outline(doc), boardArea = o ? Math.abs(area(o)) : 0, outlineArea = o ? boardArea - holes(doc).reduce((s, h) => s + Math.abs(area(h)), 0) : 0;
    const regionArea = regs.reduce((s, r) => s + r.area, 0);
    // Tiling: total area matches the outline (holes included: regions are
    // split from the outline), no two regions overlap and none leaves it.
    let tiled = !o || Math.abs(regionArea - boardArea) <= 1e-6 * Math.max(1, regionArea), overlaps = 0, outside = 0;
    if (o && regs.length > 1) {
      for (let i = 0; i < regs.length; i++) for (let j = i + 1; j < regs.length; j++) if (boxesMeet(regs[i].box, regs[j].box) && areaOverlap(regs[i].points, regs[j].points)) overlaps++;
      for (const r of regs) {
        const P = r.points;
        for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
          const ts = cuts(P[j], P[i], o).sort((x, y) => x - y);
          if (ts.some((t, k) => k && t - ts[k - 1] > 1e-12 && (m => !inside(m, o) && edgeDist(m, o) > TOUCH)([P[j][0] + (P[i][0] - P[j][0]) * (t + ts[k - 1]) / 2, P[j][1] + (P[i][1] - P[j][1]) * (t + ts[k - 1]) / 2]))) {outside++; break;}
        }
      }
      if (overlaps || outside) tiled = false;
    }
    const value = {regions:regs, bends:bl, regionAt, stacks:subs.map(s => s.id),
      coverage:{outlineArea, boardArea, regionArea, overlaps, outside, ok:tiled},
      flex:regs.some(r => r.flex), split:regs.length > 1 || subs.length > 1};
    cache.set(doc, {sig, outline:doc?.outline, value});
    return value;
  }
  function regionAt(doc, p, defs) {return regionsResolved(doc, defs).regionAt(p);}
  // Substacks a path runs through: [{stack, region, regionName, at, length}],
  // in path order of first entry, or null on a board without regions. Only
  // stretches of positive length count; at is a point inside the stretch.
  function stacksAlong(doc, points, defs) {
    const pieces = piecesAlong(doc, points, defs);
    if (!pieces) return null;
    const out = new Map();
    for (const p of pieces) {
      const e = out.get(p.stack), len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
      if (e) e.length += len; else out.set(p.stack, {stack:p.stack, region:p.region, regionName:p.regionName, at:[(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2], length:len});
    }
    return out.size ? [...out.values()] : null;
  }
  // The path cut at region edges: [{a, b, stack, region, regionName}] in path
  // order (adjacent pieces in one region merged per segment), or null on a
  // board without regions. Stretches outside every region are left out.
  function piecesAlong(doc, points, defs) {
    const R = regionsResolved(doc, defs);
    if (!R.split || !Array.isArray(points) || !points.length) return null;
    const out = [];
    if (points.length === 1) {const g = R.regionAt(points[0]); if (g) out.push({a:points[0], b:points[0], stack:g.stack, region:g.id, regionName:g.name});}
    for (let n = 1; n < points.length; n++) {
      const a = points[n - 1], b = points[n], sb = box([a, b]), ts = [0, 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (const g of R.regions) if (boxesMeet(sb, g.box)) cuts(a, b, g.points, ts);
      ts.sort((x, y) => x - y);
      const at = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      let last = null;
      for (let k = 1; k < ts.length; k++) {
        if (ts[k] - ts[k - 1] <= 1e-12 && L > 0) continue;
        const g = R.regionAt(at((ts[k] + ts[k - 1]) / 2));
        if (!g) {last = null; continue;}
        if (last && last.region === g.id) {last.b = at(ts[k]); continue;}
        out.push(last = {a:at(ts[k - 1]), b:at(ts[k]), stack:g.stack, region:g.id, regionName:g.name});
      }
    }
    return out.length ? out : null;
  }

  // IPC-2223 bend ratio (minimum bend radius / finished flex thickness).
  // Static: 6x (1 layer), 10x (2 layers), 15x (3+), the low end of the
  // published IPC-2223 static guideline table. Dynamic: 100x (1 layer), 150x
  // (2 layers), 200x (3+, and a warning: dynamic multilayer flex is not
  // recommended). The dynamic values are the IPC-2223 (Rev. C/D) guideline
  // ratios as summarised by fabricators and design guides, e.g. iConnect007
  // "Designer's Notebook: Flexible and Rigid-Flex Circuit Design Principles,
  // Part 5" (100x finished thickness in the dynamic area), multi-circuit-
  // boards.eu flex/rigid-flex design aid (1L 100:1, 2L 150:1, ML not
  // recommended) and ALLPCB's dynamic bend-radius note (ML up to 200:1). The
  // primary IPC text was not available; the rule's ratio fields override them.
  const RATIOS = Object.freeze({static1:6, static2:10, staticMulti:15, dynamic1:100, dynamic2:150, dynamicMulti:200});
  function minBendRadius(thickness, copperCount, dynamic, ratios = RATIOS) {
    const k = (dynamic ? "dynamic" : "static") + (copperCount <= 1 ? "1" : copperCount === 2 ? "2" : "Multi");
    const ratio = ratios[k] ?? RATIOS[k];
    return {ratio, radius:ratio * thickness};
  }

  // ---------------------------------------------------------------- design rule checks
  // Called by AtriumRules.drc with api = {geo, active(type), first(type, o), flag(rule, v), notes}.
  const CONNECTOR = /^(J|P|CN|CON|X|FPC)\d/i;
  function check(doc, defs, api) {
    const R = regionsResolved(doc, defs);
    if (!R.split) return;
    const {geo, active, first, flag, notes} = api, regs = R.regions, flexRegs = regs.filter(r => r.flex);
    const key = i => i === 0 ? "Top" : i === 127 ? "Bottom" : "Inner " + i;
    const label = i => globalThis.AtriumRules?.layerLabel?.(key(i)) || key(i);
    if (!R.coverage.ok) notes.push("Board regions cover " + R.coverage.regionArea.toFixed(2) + " mm² of a " + R.coverage.boardArea.toFixed(2) + " mm² outline" +
      (R.coverage.overlaps ? ", " + R.coverage.overlaps + " overlapping pair" + (R.coverage.overlaps === 1 ? "" : "s") : "") + (R.coverage.outside ? ", " + R.coverage.outside + " outside the outline" : "") +
      "; split the outline so every area has one region.");
    const masterCu = S().copperLayers(doc, defs), masterTop = S().copperIndex(masterCu[0]), masterBottom = S().copperIndex(masterCu.at(-1));
    // Region layer availability.
    if (active("flexLayers")) {
      const missing = regs.filter(r => r.copperIndex.size < masterCu.length);
      if (missing.length) {
        for (const t of geo.tracks) {
          const li = t.span?.[0];
          if (li == null || t.points.length < 2) continue;
          const r = first("flexLayers", t);
          if (!r) continue;
          const tb = box(t.points);
          for (const g of missing) {
            if (g.copperIndex.has(li) || !boxesMeet(tb, g.box)) continue;
            // A stretch of centre line inside the region; ending on or
            // running along its edge is fine.
            let hit = null;
            for (let n = 1; n < t.points.length && !hit; n++) hit = segInside(t.points[n - 1], t.points[n], g.points);
            if (hit) {flag(r, {id:t.id, title:t.label + " in " + g.name, detail:"Layer " + label(li) + " does not exist in region " + g.name + " (" + g.stackName + ")", at:hit}); break;}
          }
        }
        for (const v of geo.vias) {
          const rad = (v.item?.diameter > 0 ? v.item.diameter : 0) / 2;
          for (const g of missing) {
            if (!inBox(v.at, g.box, rad) || !circleIn(v.at, rad, g.points)) continue;
            const r = first("flexLayers", v);
            if (!r) break;
            const ends = [v.item.fromLayer ? S().copperIndex(v.item.fromLayer) : masterTop, v.item.toLayer ? S().copperIndex(v.item.toLayer) : masterBottom];
            const absent = ends.filter(i => !g.copperIndex.has(i));
            if (absent.length) {flag(r, {id:v.id, title:v.label + " in " + g.name, detail:"Via ends on " + absent.map(label).join(", ") + ", absent from region " + g.name, at:v.at}); break;}
          }
        }
        for (const p of geo.pads) {
          if (p.span[0] !== p.span[1]) continue;
          const g = R.regionAt(p.at);
          if (!g || g.copperIndex.has(p.span[0])) continue;
          const r = first("flexLayers", p);
          if (r) flag(r, {id:p.id, title:p.label + " in " + g.name, detail:"Pad layer " + label(p.span[0]) + " does not exist in region " + g.name, at:p.at});
        }
        for (const poly of doc.items) {
          if (poly.kind !== "polygon" || poly.cutout || !Array.isArray(poly.points) || poly.points.length < 3 || !(Math.abs(area(poly.points)) > EPS)) continue;
          const li = S().copperIndex(poly.layer), pb = box(poly.points);
          for (const g of missing) {
            if (li < 0 || g.copperIndex.has(li) || !boxesMeet(pb, g.box) || !areaOverlap(poly.points, g.points)) continue;
            const r = first("flexLayers", {net:poly.net || "", layer:poly.layer, span:[li, li]});
            if (r) flag(r, {id:poly.id, title:"Polygon " + (poly.name || poly.id) + " in " + g.name, detail:"Pour layer " + label(li) + " does not exist in region " + g.name, at:poly.points[0]});
          }
        }
      }
    }
    // Vias and plated holes in flex or near bends.
    if (active("flexVias")) for (const h of geo.holes) {
      if (h.what === "Pad" && h.ring == null) continue;
      const r = first("flexVias", h);
      if (!r) continue;
      // The land (hole plus annular ring) reaching into flex counts, not only the centre.
      const rad = (h.radius || 0) + (h.ring > 0 ? h.ring : 0), at = R.regionAt(h.at), g = at?.flex ? at : flexRegs.find(f => inBox(h.at, f.box, rad) && circleIn(h.at, rad, f.points));
      if (g?.flex && !r.allowInFlex) {flag(r, {id:h.id, title:h.what + " hole " + h.label, detail:"Plated hole " + (inside(h.at, g.points) ? "inside" : "overlapping") + " flex region " + g.name, at:h.at}); continue;}
      for (const b of R.bends) {
        const d = segDist(h.at, b.a, b.b) - h.radius - b.width / 2;
        if (d < r.bendKeepout - EPS) {flag(r, {id:h.id, title:h.what + " hole " + h.label + " near " + b.name, what:"Distance to bend zone", actual:Math.max(0, d), required:r.bendKeepout, limit:"min", at:h.at}); break;}
      }
    }
    // Components and pads in bend zones.
    const parts = new Map();
    for (const p of geo.pads) {
      const owner = p.parent?.id || p.id, b = p.box;
      let e = parts.get(owner);
      if (!e) parts.set(owner, e = {id:owner, part:p.parent || null, box:[...b], pads:0, label:p.parent ? "Component " + p.parent.ref : p.label, side:p.span[0] === 127 ? "Bottom" : p.parent?.layer === "Bottom" ? "Bottom" : "Top"});
      e.box = [Math.min(e.box[0], b[0]), Math.min(e.box[1], b[1]), Math.max(e.box[2], b[2]), Math.max(e.box[3], b[3])];
      e.pads++;
    }
    const rect = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    const center = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    if (active("bendKeepout") && R.bends.length) for (const e of parts.values()) {
      const r = first("bendKeepout", {net:"", component:e.part?.ref, span:[0, 127]});
      if (!r) continue;
      for (const b of R.bends) {
        const k = r.keepout, n = b.axis.normal, d = b.axis.direction, hw = b.width / 2 + k;
        const zone = [[b.a[0] + n[0] * hw - d[0] * k, b.a[1] + n[1] * hw - d[1] * k], [b.b[0] + n[0] * hw + d[0] * k, b.b[1] + n[1] * hw + d[1] * k],
          [b.b[0] - n[0] * hw + d[0] * k, b.b[1] - n[1] * hw + d[1] * k], [b.a[0] - n[0] * hw - d[0] * k, b.a[1] - n[1] * hw - d[1] * k]];
        if (convexOverlap(rect(e.box), zone)) {flag(r, {id:e.id, title:e.label + " in bend zone " + b.name, detail:(e.part ? "Component" : "Pad") + " within " + k + " mm of the " + b.width.toFixed(2) + " mm bend zone", at:center(e.box)}); break;}
      }
    }
    // Tracks crossing bends at an angle, and sharp corners in flex.
    if (active("bendCrossing")) for (const t of geo.tracks) {
      if (t.points.length < 2) continue;
      const r = first("bendCrossing", t);
      if (!r) continue;
      let crossed = false;
      for (const b of R.bends) {
        for (let n = 1; n < t.points.length && !crossed; n++) {
          const p = t.points[n - 1], q = t.points[n], c = cross(p, q, b.a, b.b);
          if (!c) continue;
          const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
          const along = Math.abs(((q[0] - p[0]) * b.axis.direction[0] + (q[1] - p[1]) * b.axis.direction[1]) / len);
          const off = Math.asin(Math.min(1, along)) / DEG;
          if (off > r.tolerance + 1e-6) {crossed = true; flag(r, {id:t.id, title:t.label + " across " + b.name, detail:"Crosses the bend line " + off.toFixed(1) + "° from perpendicular (limit " + r.tolerance + "°)", at:[p[0] + (q[0] - p[0]) * c.t, p[1] + (q[1] - p[1]) * c.t]});}
        }
        if (crossed) break;
      }
      if (r.cornerAngle > 0 && flexRegs.length) for (let n = 1; n + 1 < t.points.length; n++) {
        const a = t.points[n - 1], m = t.points[n], c = t.points[n + 1];
        const g = R.regionAt(m);
        if (!g?.flex) continue;
        const u = [m[0] - a[0], m[1] - a[1]], v = [c[0] - m[0], c[1] - m[1]], lu = Math.hypot(...u), lv = Math.hypot(...v);
        if (!(lu > EPS && lv > EPS)) continue;
        const turn = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))) / DEG;
        if (turn >= r.cornerAngle - 1e-6) {flag(r, {id:t.id, title:t.label + " corner in " + g.name, detail:"Warning: " + turn.toFixed(0) + "° corner in a flex region; prefer curved (arc) routing", at:m, severity:"warning", warning:true}); break;}
      }
    }
    // Minimum bend radius (IPC-2223).
    if (active("bendRadius")) for (const b of R.bends) {
      const r = first("bendRadius", {net:"", span:[0, 127]});
      if (!r) break;
      if (!b.region) {notes.push("Bend line " + b.name + " is outside every board region."); continue;}
      const reg = regs.find(x => x.id === b.region);
      if (!reg.flex) {flag(r, {id:b.id, title:"Bend " + b.name, detail:"Bend line in rigid region " + reg.name + " (" + reg.stackName + ")", at:b.a}); continue;}
      const rigidHit = regs.find(g => !g.flex && boxesMeet(box([b.a, b.b]), g.box) && segInside(b.a, b.b, g.points));
      if (rigidHit) flag(r, {id:b.id, title:"Bend " + b.name, detail:"Bend line runs into rigid region " + rigidHit.name + " (" + rigidHit.stackName + ")", at:segInside(b.a, b.b, rigidHit.points)});
      const need = minBendRadius(reg.thickness, reg.copper.length, b.dynamic, r);
      if (b.radius + EPS < need.radius) flag(r, {id:b.id, title:"Bend " + b.name + " in " + reg.name + " (" + (b.dynamic ? "dynamic" : "static") + ", " + reg.copper.length + " layer" + (reg.copper.length === 1 ? "" : "s") + ", " + need.ratio + "x " + reg.thickness.toFixed(3) + " mm)", what:"Bend radius", actual:b.radius, required:need.radius, limit:"min", at:b.a});
      if (b.dynamic && reg.copper.length > 2) flag(r, {id:b.id, title:"Bend " + b.name, detail:"Warning: dynamic flexing of " + reg.copper.length + " copper layers is not recommended (IPC-2223)", at:b.a, severity:"warning", warning:true});
    }
    // Solid copper in flex.
    if (active("flexCopper") && flexRegs.length) {
      // A hatched pour that was poured solid (too many hatch openings) is
      // solid copper: check the poured regions, not only the setting.
      const pours = Array.isArray(doc.pcbDrawing?.pours) ? doc.pcbDrawing.pours : [];
      const fellBack = new Set(pours.filter(p => p?.hatchSkipped && p.polygon != null).map(p => p.polygon));
      for (const poly of doc.items) {
        if (poly.kind !== "polygon" || poly.cutout || !Array.isArray(poly.points) || poly.points.length < 3 || !(Math.abs(area(poly.points)) > EPS)) continue;
        const solidFill = poly.fillMode !== "hatched" || fellBack.has(poly.id);
        if (!solidFill) continue;
        const li = S().copperIndex(poly.layer), r = first("flexCopper", {net:poly.net || "", layer:poly.layer, span:[li, li]});
        if (!r || !r.requireHatch) continue;
        const g = flexRegs.find(g => g.copperIndex.has(li) && boxesMeet(box(poly.points), g.box) && areaOverlap(poly.points, g.points));
        if (g) flag(r, {id:poly.id, title:"Polygon " + (poly.name || poly.id) + " in " + g.name, detail:"Warning: " + (poly.fillMode === "hatched" ? "hatched pour was poured solid (too many hatch openings); " : "solid copper pour in a flex region; ") + "use a hatched pour for flexibility", at:poly.points[0], severity:"warning", warning:true});
      }
      for (const g of flexRegs) {
        const r = first("flexCopper", {net:"", span:[0, 127]});
        if (!r?.requireHatch) break;
        for (const l of g.layers) if (l.type === "Plane") flag(r, {id:g.id, title:"Region " + g.name, detail:"Warning: plane layer " + l.name + " is solid copper in flex region " + g.name + "; make it a hatched signal layer", at:g.points[0], severity:"warning", warning:true});
      }
    }
    // Stiffeners and components.
    if (active("stiffener")) {
      const stiff = regs.filter(g => g.stiffeners.length);
      for (const e of parts.values()) {
        if (!e.part) continue;
        const r = first("stiffener", {net:"", component:e.part.ref, span:[0, 127]});
        if (!r) continue;
        const corners = rect(e.box), c = center(e.box);
        let reported = false;
        for (const g of stiff) {
          if (!boxesMeet(e.box, g.box) || !polyOverlap(corners, g.points)) continue;
          const all = corners.every(p => inside(p, g.points));
          if (g.stiffeners.some(s => s.side === e.side)) {flag(r, {id:e.id, title:e.label + " on " + g.name, detail:"Component on the same side as the " + e.side.toLowerCase() + " stiffener of " + g.name, at:c}); reported = true; break;}
          if (!all) {flag(r, {id:e.id, title:e.label + " at " + g.name, detail:"Warning: component straddles the stiffener edge; solder joints see the bend stress", at:c, severity:"warning", warning:true}); reported = true; break;}
        }
        if (reported || !r.requireBacking) continue;
        const g = R.regionAt(c);
        if (!g?.flex) continue;
        if (!(CONNECTOR.test(e.part.ref || "") || e.pads >= r.minPads)) continue;
        const opposite = e.side === "Top" ? "Bottom" : "Top";
        const backed = stiff.some(s => s.stiffeners.some(x => x.side === opposite) && corners.every(p => inside(p, s.points)));
        if (!backed) flag(r, {id:e.id, title:e.label + " in " + g.name, detail:"Warning: " + (CONNECTOR.test(e.part.ref || "") ? "connector" : e.pads + "-pad component") + " in flex without a " + opposite.toLowerCase() + " stiffener behind it", at:c, severity:"warning", warning:true});
      }
    }
  }

  // ---------------------------------------------------------------- fabrication layers
  const flat = pts => pts.flatMap(p => [p[0], p[1]]);
  // Gerber layers for coverlay, stiffeners and the region drawing. Returns
  // null for a board without regions or substacks. Features use the
  // fab-outputs feature records ({t:"pour"|"region"|"stroke", ...}).
  function fabLayers(doc, defs, opts = {}) {
    const R = regionsResolved(doc, defs);
    if (!R.split && !opts.coverlayOnly) return null;
    const grow = opts.coverlayExpansion ?? 0.1, out = [];
    const pads = {Top:[], Bottom:[]};
    const L=AtriumResolvedLand,PCB=AtriumPCBAppearance;
    const addPad = (p, parent) => {
      const layer=PCB.padLayer(parent,p);
      for(const side of ["Top","Bottom"]){
        if(layer!=="Multi"&&layer!==side)continue;
        const source=L.geometry(p,side)??{...L.profile("circle",0,0,p.angle),x:p.x,y:p.y};
        const land=AtriumLandContours.expand(source,grow);
        if(!land||!(land.w>0&&land.h>0))continue;
        const {at,angle,mirror}=L.place(land,parent),frame={x:at[0],y:at[1],angle,mirror};
        pads[side].push({poly:AtriumLandContours.outline(land).map(q=>Atrium.world(q,frame)),at});
      }
    };
    for (const i of doc.items) {
      if (i.kind === "pad") addPad(i, null);
      else if (i.kind === "part") for (const p of defs?.get?.(i.def)?.footprint?.pads || []) addPad(p, i);
    }
    for (const side of ["Top", "Bottom"]) {
      const regs = R.regions.filter(g => g.coverlay[side]);
      if (!regs.length) continue;
      const openings = g => pads[side].filter(p => inBox(p.at, g.box) && inside(p.at, g.points));
      const key = side + " coverlay";
      if (opts.coverlayOnly) {
        out.push({key, openings:regs.flatMap(openings)});
      } else {
        const features = regs.map(g => ({t:"pour", fn:null, rings:[flat(g.points), ...openings(g).map(p => flat(p.poly))]}));
        out.push({key, ext:side === "Top" ? "GCT" : "GCB", title:side + " Coverlay", group:"Rigid-flex", fileFunction:"Other,Coverlay" + (side === "Top" ? "Top" : "Bot"), polarity:"Positive", features});
      }
    }
    if (opts.coverlayOnly) return {layers:out};
    for (const side of ["Top", "Bottom"]) {
      const regs = R.regions.filter(g => g.stiffeners.some(s => s.side === side));
      if (!regs.length) continue;
      out.push({key:side + " stiffener", ext:side === "Top" ? "GSTT" : "GSTB", title:side + " Stiffener", group:"Rigid-flex", fileFunction:"Other,Stiffener" + (side === "Top" ? "Top" : "Bot"), polarity:"Positive",
        features:regs.map(g => ({t:"region", fn:null, points:g.points}))});
    }
    const lines = [], labels = [];
    for (const g of R.regions) {
      lines.push({t:"stroke", points:[...g.points, g.points[0]], width:0.1, fn:null});
      labels.push({text:g.name + " · " + g.stackName, at:[(g.box[0] + g.box[2]) / 2, (g.box[1] + g.box[3]) / 2], angle:0, size:1});
    }
    for (const b of R.bends) {
      const len = b.axis.length, dash = 1, gap = 0.6;
      for (let s = 0; s < len; s += dash + gap) {
        const e = Math.min(len, s + dash), d = b.axis.direction;
        lines.push({t:"stroke", points:[[b.a[0] + d[0] * s, b.a[1] + d[1] * s], [b.a[0] + d[0] * e, b.a[1] + d[1] * e]], width:0.15, fn:null});
      }
      for (const edge of [[b.zone[0], b.zone[1]], [b.zone[3], b.zone[2]]]) lines.push({t:"stroke", points:edge, width:0.05, fn:null});
      const ang = -Math.atan2(b.axis.direction[1], b.axis.direction[0]) / DEG;
      labels.push({text:b.name + " " + b.angle + "° R" + b.radius, at:[(b.a[0] + b.b[0]) / 2 + b.axis.normal[0] * (b.width / 2 + 0.5), (b.a[1] + b.b[1]) / 2 + b.axis.normal[1] * (b.width / 2 + 0.5)], angle:ang, size:0.8});
    }
    // Fabrication notes for the flex build, as a text block under the board.
    const notes = fabNotes(doc, defs, R), o = outline(doc), ob = o ? box(o) : [0, 0, 0, 0];
    notes.forEach((text, i) => labels.push({text, at:[ob[0] + 0.5 * text.length * 0.5, ob[3] + 4 + i * 1.6], angle:0, size:0.8}));
    out.push({key:"Rigid-flex regions", ext:"GM15", title:"Mechanical 15 (board regions and bend lines)", group:"Rigid-flex", fileFunction:"OtherDrawing,BoardRegions", polarity:"Positive", features:lines, labels});
    return {layers:out, regionAt:R.regionAt, notes};
  }
  // Rigid-flex fabrication notes (Readme and the Mechanical 15 drawing): the build-up of each
  // substack in use, bend lines with radius, angle, fold order and the IPC-2223 minimum,
  // coverlay and stiffeners, and the construction rules the design was checked against.
  function fabNotes(doc, defs, R = regionsResolved(doc, defs)) {
    if (!R.split) return [];
    const f = v => (+v).toFixed(3).replace(/\.?0+$/, ""), lines = ["RIGID-FLEX FABRICATION NOTES"], used = new Set(R.regions.map(g => g.stack));
    let n = 1;
    for (const id of R.stacks) {
      if (!used.has(id)) continue;
      const g = R.regions.find(x => x.stack === id), names = R.regions.filter(x => x.stack === id).map(x => x.name).join(", ");
      lines.push(n++ + ". " + (g.flex ? "Flex" : "Rigid") + " build-up \"" + g.stackName + "\" (" + names + "): " + g.copper.length + " copper layer" + (g.copper.length === 1 ? "" : "s") + ", " + f(g.thickness) + " mm finished.");
      lines.push("   " + g.layers.filter(l => l.thickness > 0).map(l => l.name + (l.material ? " " + l.material : "") + " " + f(l.thickness * 1000) + " um").join(" / "));
    }
    for (const b of R.bends) {
      const reg = R.regions.find(g => g.id === b.region), need = reg?.flex ? minBendRadius(reg.thickness, reg.copper.length, b.dynamic) : null;
      const raw = bends(doc).find(x => x.id === b.id);
      lines.push(n++ + ". Bend " + b.name + ": " + b.angle + " deg, inside radius " + f(b.radius) + " mm, " + (b.dynamic ? "dynamic" : "static") + (raw?.order ? ", fold order " + raw.order : "") +
        (need ? " (IPC-2223 minimum " + f(need.radius) + " mm = " + need.ratio + "x " + f(reg.thickness) + " mm)" : "") + "; bend zone " + f(b.width) + " mm.");
    }
    const cov = ["Top", "Bottom"].filter(s => R.regions.some(g => g.coverlay[s]));
    if (cov.length) lines.push(n++ + ". Coverlay on " + cov.join(" and ").toLowerCase() + " of the flex regions; openings per the coverlay Gerbers (GCT/GCB), pads grown 0.1 mm.");
    const st = R.regions.flatMap(g => g.stiffeners.map(s => s.side + " " + (s.material || "stiffener") + " " + f(s.thickness) + " mm under " + g.name));
    if (st.length) lines.push(n++ + ". Stiffeners: " + st.join("; ") + "; outlines per GSTT/GSTB, bonded with pressure-sensitive or thermoset adhesive.");
    lines.push(n++ + ". Region outlines and bend lines per Mechanical 15 (GM15). Do not plate or drill in bend zones.");
    lines.push(n++ + ". Copper in flex regions: rolled annealed copper preferred; planes hatched; tracks staggered across layers.");
    return lines;
  }

  // ---------------------------------------------------------------- Board Planning view
  let planning = false;
  const setPlanning = on => {planning = !!on; return planning;};
  const isPlanning = () => planning;
  const TINTS = ["rgba(86,156,214,.30)", "rgba(206,145,120,.34)", "rgba(181,206,168,.32)", "rgba(197,134,192,.32)", "rgba(220,220,170,.30)", "rgba(78,201,176,.30)"];
  // Draws regions as tinted areas and bends as dashed lines with labels.
  // ctx is in world transform; view = {scale, dpr, worldToScreen, selected, line}.
  function drawPlanning(ctx, doc, view, defs) {
    let R;
    try {R = regionsResolved(doc, defs);} catch {return;}
    const tint = id => TINTS[Math.max(0, R.stacks.indexOf(id)) % TINTS.length];
    const px = 1 / view.scale;
    ctx.save();
    for (const g of R.regions) {
      ctx.beginPath();
      g.points.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      ctx.closePath();
      ctx.fillStyle = tint(g.stack); ctx.fill();
      ctx.lineWidth = (g.id === view.selected ? 2.5 : 1.2) * px; ctx.strokeStyle = g.flex ? "#e8c46a" : "#9cdcfe"; ctx.setLineDash([]); ctx.stroke();
    }
    for (const b of R.bends) {
      ctx.beginPath(); ctx.moveTo(b.zone[0][0], b.zone[0][1]);
      for (const p of b.zone.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.closePath(); ctx.fillStyle = "rgba(232,196,106,.12)"; ctx.fill();
      ctx.beginPath(); ctx.moveTo(b.a[0], b.a[1]); ctx.lineTo(b.b[0], b.b[1]);
      ctx.setLineDash([6 * px, 4 * px]); ctx.lineWidth = 1.6 * px; ctx.strokeStyle = "#f2cc60"; ctx.stroke();
    }
    if (view.line?.a && view.line?.b) {
      ctx.beginPath(); ctx.moveTo(view.line.a[0], view.line.a[1]); ctx.lineTo(view.line.b[0], view.line.b[1]);
      ctx.setLineDash([4 * px, 3 * px]); ctx.lineWidth = 1.4 * px; ctx.strokeStyle = "#ffffff"; ctx.stroke();
    }
    ctx.restore();
    // Labels in screen space.
    ctx.save(); ctx.setTransform(view.dpr || 1, 0, 0, view.dpr || 1, 0, 0);
    ctx.font = "500 11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const tag = (text, at, ink) => {const [x, y] = view.worldToScreen(at), w = ctx.measureText(text).width + 10; ctx.fillStyle = "rgba(30,30,30,.82)"; ctx.fillRect(x - w / 2, y - 9, w, 18); ctx.fillStyle = ink; ctx.fillText(text, x, y);};
    for (const g of R.regions) tag(g.name + " · " + g.stackName + (g.flex ? " (flex)" : ""), [(g.box[0] + g.box[2]) / 2, (g.box[1] + g.box[3]) / 2], g.flex ? "#f2cc60" : "#d4d4d4");
    // Bend labels sit near the start of the line, clear of the region label at the centre.
    for (const b of R.bends) {
      const t = Math.min(b.axis.length * 0.15, 40 / view.scale), d = b.axis.direction, n = b.axis.normal, off = b.width / 2 + 16 / view.scale;
      tag(b.name + " · " + b.angle + "° · R " + b.radius + " mm", [b.a[0] + d[0] * t + n[0] * off, b.a[1] + d[1] * t + n[1] * off], "#f2cc60");
    }
    ctx.restore();
  }

  // Board Planning turns two picked points into a split line or a bend line.
  async function pickPlanningLine(action, {doc, defs, edit, draw, info, pickPoint}) {
    if (!isPlanning()) { setPlanning(true); draw(); }
    const split = action === "split-region";
    const first = await pickPoint(split ? "Split region: click the start of the split line." : "Bend line: click the start of the bend line.");
    if (!first) return;
    const second = await pickPoint("Click the end of the line.");
    if (!second) return;
    try {
      edit(() => {
        if (split) {
          const result = splitRegion(doc(), {a: first, b: second}, {defs: defs()});
          if (!result.ok) throw Error(result.problem);
          info("Region split. Assign substacks in Layer Stack Manager › Board Regions.");
        } else {
          const bend = addBend(doc(), {a: first, b: second, angle: 90, radius: 1}, defs());
          info(bend.name + " added (90°, radius 1 mm). Edit it in Layer Stack Manager › Board Regions.");
        }
      });
      draw();
    } catch (error) { info(error.message); }
  }

  return Object.freeze({regions, pickPlanningLine, splitRegion, splitPolygon, assignStack, addBend, removeBend, regionsResolved, regionAt, stacksAlong, piecesAlong, minBendRadius, RATIOS,
    check, fabLayers, fabNotes, setPlanning, planning:isPlanning, drawPlanning, geometry:Object.freeze({area, inside, box, segDist, segSegDist, convexOverlap, polyOverlap, areaOverlap, segInside}), has:own});
})();
