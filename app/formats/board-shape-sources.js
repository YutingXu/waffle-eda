"use strict";
// Build a new board outline from drawing primitives. The canvas and connectivity
// use board-shape-core.js. Import and Board Shape actions request this module.
globalThis.AtriumBoardShapeSources = (() => {
  const shape = globalThis.AtriumBoardShape;
  const {CHAIN_TOL, validSegment, roundPoint, pointAt, ends, line, arc, reverse, sweep,
    weld, signedArea, contains, crossings, normalize, polySegments, bounds,
    contourBounds, boundsOf, rect, orient, head, tail, within, angleOf} = shape;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // ---------------------------------------------------------------------------
  // Chaining primitives into closed loops.
  // input: [{seg, id}], options {tolerance, closeGaps}
  function chain(input, opt = {}) {
    const tol = Math.max(1e-6, opt.tolerance ?? CHAIN_TOL);
    let items = input.filter(x => validSegment(x.seg) && !(x.seg.kind === "line" && dist(x.seg.a, x.seg.b) < 1e-9));
    // Drop duplicates (the same edge drawn on two layers, or twice), either way round.
    const seen = new Set(), q = v => Math.round(v / tol), before = items.length;
    items = items.filter(x => {
      const [a, b] = ends(x.seg), k1 = q(a[0]) + "," + q(a[1]), k2 = q(b[0]) + "," + q(b[1]);
      const mid = x.seg.kind === "arc" ? pointAt(x.seg.c, x.seg.r, x.seg.start + sweep(x.seg) / 2) : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const key = (k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1) + "|" + q(mid[0]) + "," + q(mid[1]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const duplicates = before - items.length;
    let result = link(items, tol), bridged = 0;
    if (opt.closeGaps > 0 && result.gaps.length) {
      const extra = [];
      for (const g of result.gaps) if (g.distance <= opt.closeGaps) { extra.push({seg: line(g.from, g.to), id: null, bridge: true}); bridged++; }
      if (extra.length) { items = items.concat(extra); result = link(items, tol); }
    }
    result.bridged = bridged; result.duplicates = duplicates;
    return result;
  }
  function link(items, tol) {
    const n = items.length, pts = new Array(2 * n), parent = new Int32Array(2 * n);
    for (let i = 0; i < n; i++) { const [a, b] = ends(items[i].seg); pts[2 * i] = a; pts[2 * i + 1] = b; }
    for (let i = 0; i < 2 * n; i++) parent[i] = i;
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const cell = tol * 2, grid = new Map(), keyOf = (x, y) => x + "," + y;
    for (let e = 0; e < 2 * n; e++) {
      const p = pts[e], gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(keyOf(gx + dx, gy + dy));
        if (list) for (const f of list) if (dist(p, pts[f]) <= tol) { const a = find(e), b = find(f); if (a !== b) parent[a] = b; }
      }
      const k = keyOf(gx, gy), list = grid.get(k);
      if (list) list.push(e); else grid.set(k, [e]);
    }
    const node = new Int32Array(2 * n), incident = new Map(), sum = new Map();
    for (let e = 0; e < 2 * n; e++) {
      const r = node[e] = find(e);
      (incident.get(r) || incident.set(r, []).get(r)).push(e);
      const s = sum.get(r) || sum.set(r, [0, 0, 0]).get(r); s[0] += pts[e][0]; s[1] += pts[e][1]; s[2]++;
    }
    const centre = r => { const s = sum.get(r); return [s[0] / s[2], s[1] / s[2]]; };
    const used = new Uint8Array(n), loops = [], open = [], branches = [];
    // Pieces shorter than the tolerance collapse into one node; drop them.
    for (let i = 0; i < n; i++) if (node[2 * i] === node[2 * i + 1] && !(items[i].seg.kind === "arc" && Math.abs(sweep(items[i].seg)) > 359)) {
      used[i] = 1;
      for (const e of [2 * i, 2 * i + 1]) { const l = incident.get(node[e]), k = l.indexOf(e); if (k >= 0) l.splice(k, 1); }
    }
    for (const [r, list] of incident) if (list.length > 2) branches.push({at: centre(r), count: list.length});
    // Next unused edge leaving node r: returns {i, forward}.
    const next = r => { for (const e of incident.get(r)) { const i = e >> 1; if (!used[i]) return {i, forward: (e & 1) === 0}; } return null; };
    for (let s = 0; s < n; s++) {
      if (used[s]) continue;
      used[s] = 1;
      const path = [{i: s, forward: true}], startNode = node[2 * s];
      let endNode = node[2 * s + 1], closed = endNode === startNode;
      while (!closed) {
        const e = next(endNode); if (!e) break;
        used[e.i] = 1; path.push(e);
        endNode = node[2 * e.i + (e.forward ? 1 : 0)];
        closed = endNode === startNode;
      }
      let beginNode = startNode;
      if (!closed) for (;;) {
        const e = next(beginNode); if (!e) break;
        used[e.i] = 1; path.unshift({i: e.i, forward: !e.forward});
        beginNode = node[2 * e.i + (e.forward ? 1 : 0)];
        if (beginNode === endNode) { closed = true; break; }
      }
      const segs = path.map(({i, forward}) => {
        const g = forward ? items[i].seg : reverse(items[i].seg);
        if (g.kind !== "line") return g;
        const a = node[2 * i + (forward ? 0 : 1)], b = node[2 * i + (forward ? 1 : 0)];
        return {kind: "line", a: roundPoint(centre(a)), b: roundPoint(centre(b))};
      });
      const ids = [...new Set(path.map(p => items[p.i].id).filter(x => x != null))];
      if (closed) loops.push({contour: weld(segs), ids, area: Math.abs(signedArea(segs))});
      else open.push({segments: segs, ids, ends: [centre(beginNode), centre(endNode)], idAt: [items[path[0].i].id, items[path.at(-1).i].id]});
    }
    // Gaps: pair each dangling end with its nearest other dangling end.
    const dangling = [];
    open.forEach((o, k) => { dangling.push({p: o.ends[0], k, id: o.idAt[0]}); dangling.push({p: o.ends[1], k, id: o.idAt[1]}); });
    const gaps = [], taken = new Uint8Array(dangling.length);
    const nearest = i => { let best = -1, bd = Infinity; for (let j = 0; j < dangling.length; j++) { if (j === i || taken[j]) continue; const d = dist(dangling[i].p, dangling[j].p); if (d < bd) { bd = d; best = j; } } return best; };
    if (dangling.length <= 4000) for (let i = 0; i < dangling.length; i++) {
      if (taken[i]) continue;
      const j = nearest(i); if (j < 0) continue;
      if (nearest(j) !== i) continue;
      taken[i] = taken[j] = 1;
      const a = dangling[i].p, b = dangling[j].p;
      gaps.push({from: roundPoint(a), to: roundPoint(b), at: roundPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), distance: dist(a, b), ids: [dangling[i].id, dangling[j].id].filter(x => x != null)});
    }
    for (let i = 0; i < dangling.length; i++) if (!taken[i]) gaps.push({from: roundPoint(dangling[i].p), to: null, at: roundPoint(dangling[i].p), distance: Infinity, ids: dangling[i].id != null ? [dangling[i].id] : []});
    gaps.sort((x, y) => x.distance - y.distance);
    loops.sort((x, y) => y.area - x.area);
    return {loops, open, gaps, branches};
  }
  // Largest loop is the board; loops inside it are cutouts.
  function shapeFromLoops(loops, source) {
    const warnings = [];
    loops = loops.filter(l => l.area > 1e-9);
    if (!loops.length) return {shape: null, warnings};
    const outer = loops[0].contour, cutouts = [], used = [loops[0]];
    const probe = c => { const g = c[0]; return g.kind === "arc" ? pointAt(g.c, g.r, g.start + sweep(g) / 2) : [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2]; };
    const outerShape = {contour: outer};
    let outside = 0, islands = 0;
    for (const l of loops.slice(1)) {
      if (l.area < 1e-9) continue;
      const p = probe(l.contour);
      if (!contains(outerShape, p) && !crossings(outer, p)) { outside++; continue; }
      if (cutouts.some(c => crossings(c, p))) { islands++; continue; }
      cutouts.push(l.contour); used.push(l);
    }
    if (outside) warnings.push(outside + " closed loop" + (outside === 1 ? " lies" : "s lie") + " outside the board shape and " + (outside === 1 ? "was" : "were") + " ignored.");
    if (islands) warnings.push(islands + " loop" + (islands === 1 ? "" : "s") + " inside a cutout " + (islands === 1 ? "was" : "were") + " ignored (islands are not supported).");
    return {shape: normalize({version: 1, contour: outer, cutouts, source}), warnings, used};
  }

  // ---------------------------------------------------------------------------
  // Sources: selected primitives, closed regions, component courtyard/body
  const PATH_KINDS = new Set(["graphic", "track", "polygon", "wire"]);
  function segmentsOf(points, closed, id, opt) {
    return polySegments(points, closed, opt).map(seg => ({seg, id}));
  }
  function itemSegments(item, opt = {}) {
    if (!item || !Array.isArray(item.points) || item.points.length < 2 || !PATH_KINDS.has(item.kind)) return [];
    const g = globalThis.Atrium?.pathArc(item);
    return g ? [{seg:g, id:item.id}] : segmentsOf(item.points, !!item.closed, item.id, opt);
  }
  function fromSegments(input, opt = {}) {
    const res = chain(input, opt);
    let {shape, warnings, used} = shapeFromLoops(res.loops, opt.source || "primitives");
    // Open primitives reaching beyond the largest loop mean the real outline
    // is the open one: refuse rather than define a board from an inner loop.
    if (shape && res.open.length) {
      const b = bounds(shape), o = [Infinity, Infinity, -Infinity, -Infinity], t = (opt.tolerance ?? CHAIN_TOL) + 1e-6;
      for (const c of res.open) contourBounds(c.segments, o);
      if (o[0] < b[0] - t || o[1] < b[1] - t || o[2] > b[2] + t || o[3] > b[3] + t) {
        warnings.push("The board outline does not close: open primitives reach beyond the largest closed loop. Close the gaps, or select only the board edge.");
        shape = null;
      }
    }
    if (res.branches.length) warnings.push(res.branches.length + " junction" + (res.branches.length === 1 ? " joins" : "s join") + " more than two primitives; the loop follows one branch.");
    if (res.duplicates) warnings.push(res.duplicates + " duplicate primitive" + (res.duplicates === 1 ? " was" : "s were") + " ignored.");
    if (res.bridged) warnings.push(res.bridged + " gap" + (res.bridged === 1 ? " was" : "s were") + " closed with a straight edge.");
    const result = {shape, loops: res.loops.length, gaps: res.gaps, open: res.open.length, openSegments: res.open.map(o => o.segments), loopSegments: shape ? [] : res.loops.map(l => l.contour), warnings, bridged: res.bridged, segments: input.length};
    if (opt.collectSourceIds && shape) Object.assign(result, {sourceIds: new Set((used || []).flatMap(loop => loop.ids))});
    return result;
  }
  // Selected objects (graphics, tracks, polygons, closed regions) of a doc.
  function fromItems(doc, ids, opt = {}) {
    const set = ids instanceof Set ? ids : new Set(ids || []), input = [];
    let skipped = 0;
    for (const item of doc.items) {
      if (!set.has(item.id)) continue;
      const s = itemSegments(item, {fitArcs: opt.fitArcs !== false, arcTolerance: opt.arcTolerance});
      if (s.length) input.push(...s); else skipped++;
    }
    const r = fromSegments(input, {...opt, source: opt.source || "primitives"});
    if (skipped) r.warnings.push(skipped + " selected object" + (skipped === 1 ? " is" : "s are") + " not a line, arc or region and " + (skipped === 1 ? "was" : "were") + " skipped.");
    return r;
  }
  const COURTYARD = l => /court|crtyd/i.test(l || "") || /^mechanical\s*15$/i.test(l || "");
  const BODY = (l, s) => /body|3d|assembly|package|fab/i.test(l || "") || /^mechanical\s*13$/i.test(l || "") || s?.style === "package";
  function fromComponent(doc, defs, partId, opt = {}) {
    const A = globalThis.Atrium, part = doc.items.find(i => i.id === partId && i.kind === "part");
    if (!part) throw Error("Select a component.");
    const fp = (defs.get ? defs.get(part.def) : defs[part.def])?.footprint;
    if (!fp) throw Error("The component has no footprint.");
    const world = p => A ? A.world(p, part) : [p[0] + part.x, p[1] + part.y];
    const want = opt.from || "auto", tries = want === "auto" ? ["courtyard", "body"] : [want];
    for (const t of tries) {
      const shapes = (fp.shapes || []).filter(s => t === "courtyard" ? COURTYARD(s.layer) : BODY(s.layer, s));
      const input = [];
      for (const s of shapes) {
        const g = A?.pathArc(s);
        if (g) input.push({seg:A.transformArc(g, world, part.angle || 0, !!part.mirror), id:part.id});
        else if (s.kind === "path" && s.points?.length >= 2) input.push(...segmentsOf(s.points.map(world), !!s.closed, part.id, {fitArcs: true}));
        else if (s.kind === "circle" && s.r > 0) { const c = world([s.x, s.y]); input.push({seg: arc(c, s.r, 0, 180, true), id: part.id}, {seg: arc(c, s.r, 180, 0, true), id: part.id}); }
      }
      if (!input.length) continue;
      const r = fromSegments(input, {tolerance: opt.tolerance, source: "component"});
      if (r.shape) { r.from = t; r.shape.cutouts = []; return r; }
    }
    // Fall back to the footprint extents.
    const pts = [];
    for (const s of fp.shapes || []) { if (s.points) pts.push(...s.points); else if (s.kind === "circle") pts.push([s.x - s.r, s.y - s.r], [s.x + s.r, s.y + s.r]); }
    for (const p of fp.pads || []) { const h = Math.max(p.w || 0, p.h || 0) / 2; pts.push([p.x - h, p.y - h], [p.x + h, p.y + h]); }
    if (!pts.length) throw Error("The footprint has no geometry.");
    const b = boundsOf(pts.map(world));
    return {shape: rect({x: b[0], y: b[3], width: b[2] - b[0], height: b[3] - b[1]}), from: "extents", loops: 0, gaps: [], warnings: ["The footprint has no closed courtyard or body outline; its extents were used."]};
  }
  // Gerber cut-ins must be horizontal or vertical. Join each hole to the first
  // edge to its right, splitting a circular edge at the exact ray intersection.
  function cutInContours(outer, holes) {
    let path = orient(outer, false).slice();
    const openings = holes.map(c => {
      const ring = orient(c, true), start = ring.reduce((k,s,i) => {
        const p = head(s), q = head(ring[k]); return p[0] > q[0] || p[0] === q[0] && p[1] < q[1] ? i : k;
      },0);
      return [...ring.slice(start), ...ring.slice(0,start)];
    }).sort((a,b) => head(b[0])[0]-head(a[0])[0]);
    for (const ring of openings) {
      const m = head(ring[0]); let edge = -1, x = Infinity;
      const hit = (i,v) => { if (v > m[0]+1e-9 && v < x) { edge = i; x = v; } };
      path.forEach((g,i) => {
        const a = head(g), b = tail(g);
        if (g.kind === "line") {
          if ((a[1] <= m[1]) !== (b[1] <= m[1])) hit(i, a[0]+(m[1]-a[1])*(b[0]-a[0])/(b[1]-a[1]));
          return;
        }
        const dy = m[1]-g.c[1], dx2 = g.r*g.r-dy*dy;
        if (dx2 <= 0) return;
        for (const v of [g.c[0]-Math.sqrt(dx2),g.c[0]+Math.sqrt(dx2)]) if (within(g,angleOf(g.c,[v,m[1]]))) hit(i,v);
      });
      if (edge < 0) return null;
      const g = path[edge], at = [x,m[1]], a = head(g), b = tail(g), angle = g.kind === "arc" ? angleOf(g.c,at) : 0;
      const split = [];
      if (dist(a,at) > 1e-9) split.push(g.kind === "arc" ? {...g,end:angle} : {kind:"line",a,b:at});
      split.push({kind:"line",a:at,b:m});
      for (const edge of ring) split.push(edge);
      split.push({kind:"line",a:m,b:at});
      if (dist(at,b) > 1e-9) split.push(g.kind === "arc" ? {...g,start:angle} : {kind:"line",a:at,b});
      else if (g.kind === "arc" && dist(a,at) <= 1e-9 && Math.abs(sweep(g)) === 360) split.push(g);
      path = [...path.slice(0,edge),...split,...path.slice(edge+1)];
    }
    return path;
  }
  return Object.assign(shape, {chain, shapeFromLoops, fromSegments, fromItems, fromComponent, itemSegments, cutInContours});
})();
