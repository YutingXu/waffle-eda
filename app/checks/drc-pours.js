"use strict";
// Pour clearance verification: poured copper against the
// Clearance rules. The pour engine offsets every obstacle by the polygon's own clearance, and DRC's
// Clearance check does not read poured copper, so a polygon whose `clearance` is below the rule, or a
// fill left stale by an edit, was never reported. Altium checks poured copper; so does this.
//
//   AtriumDRCPours.verify(doc, defs, rules, {project, regions?, polygons?, limit}) → {violations, checked, ms}
//   AtriumDRCPours.steps(...)   the same as a generator for idle slices (a yield after setup, after each
//                               region's edge index and every 64 features; no step is long on a 25k board)
//   AtriumDRCPours.session()    online: steps() re-checking only what changed since its last run (below)
// Violations have DRC's shape ({type: "pourClearance", ruleId, ruleName, id: polygon, otherId, actual,
// required, limit: "min", at, title}), so markers, the inspector, Problems and reports show them:
//   - copper of another net closer to a poured region than the Clearance rule asks (or inside it);
//   - a polygon whose own clearance is below the rule (the fill is then wrong wherever it is tight).
//   - a drilled object's barrel closer than the rule's hole cell (Poly-Hole), where one is authored.
// An internal plane (powerPlane) holds a drilled object of another net to its own clearance (the
// source's Plane Clearance) from the barrel, not to the Clearance rule.
// It runs lazily in idle slices after a refill (drc-view.js, the check scheduler, through a session) and
// always in full before outputs (fab-outputs.js), which report what it finds. Loaded with the rules engine
// (app/lazy.js).
globalThis.AtriumDRCPours = (() => {
  const G = globalThis, R = () => G.AtriumRules, P = () => G.AtriumPCBPours;
  const TYPE = "pourClearance", TITLE = "Pour Clearance";

  // ---------------------------------------------------------------- geometry
  function segDist(p, q, r, s) {
    // Exact distance between segments pq and rs (0 when they cross).
    const d1x = q[0] - p[0], d1y = q[1] - p[1], d2x = s[0] - r[0], d2y = s[1] - r[1];
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) > 1e-18) {
      const t = ((r[0] - p[0]) * d2y - (r[1] - p[1]) * d2x) / den, u = ((r[0] - p[0]) * d1y - (r[1] - p[1]) * d1x) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { const at = [p[0] + t * d1x, p[1] + t * d1y]; return {d: 0, a: at, b: at}; }
    }
    let best = null;
    const pt = (x, a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, u = l ? Math.max(0, Math.min(1, ((x[0] - a[0]) * dx + (x[1] - a[1]) * dy) / l)) : 0;
      const c = [a[0] + u * dx, a[1] + u * dy], d = Math.hypot(x[0] - c[0], x[1] - c[1]);
      return {d, a: x, b: c};
    };
    for (const c of [pt(p, r, s), pt(q, r, s), pt(r, p, q), pt(s, p, q)]) if (!best || c.d < best.d) best = c;
    return best;
  }
  const inside=(x,y,rings)=>rings.reduce((odd,ring)=>odd!==G.AtriumGeometry.inFlatRing(x,y,ring),false);
  const bandsOf=(rings,h)=>P().edgeBands(rings,h).inside;
  // The region's edges in a uniform grid, for neighbour queries.
  function edgeGrid(rings, cell) {
    const m = new Map(), key = (x, y) => x * 73856093 ^ y * 19349663;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r], n = ring.length >> 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, x0 = Math.min(ring[2 * i], ring[2 * j]), x1 = Math.max(ring[2 * i], ring[2 * j]), y0 = Math.min(ring[2 * i + 1], ring[2 * j + 1]), y1 = Math.max(ring[2 * i + 1], ring[2 * j + 1]);
        for (let x = Math.floor(x0 / cell); x <= Math.floor(x1 / cell); x++) for (let y = Math.floor(y0 / cell); y <= Math.floor(y1 / cell); y++) {
          const k = key(x, y); let l = m.get(k); if (!l) m.set(k, l = []); l.push(r, i);
        }
      }
    }
    let fast = null;
    return {inside: (x, y) => (fast ??= bandsOf(rings, cell))(x, y), prepare() { fast ??= bandsOf(rings, cell); }, query: gridQuery(m, cell, key)};
  }
  const gridQuery = (m, cell, key) => (b, fn) => {
    const seen = new Set();
    for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++) for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++) {
      const l = m.get(key(x, y)); if (!l) continue;
      for (let k = 0; k < l.length; k += 2) { const id = l[k] * 1e7 + l[k + 1]; if (seen.has(id)) continue; seen.add(id); fn(l[k], l[k + 1]); }
    }
  };
  // The ring boxes of a region ([x0, y0, x1, y1] per ring): the pour engine's (kept per run, shared by
  // every version of an island), else computed here and kept with the region's data.
  const ringBoxCache = new WeakMap();
  function ringBoxes(region, rings) {
    if (P()?.ringBoxes) return P().ringBoxes(region);
    const held = ringBoxCache.get(region);
    if (held && held.data === region.data && held.count === region.count) return held.boxes;
    const boxes = new Float64Array(rings.length * 4);
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { const x = ring[i], y = ring[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      boxes[4 * r] = x0; boxes[4 * r + 1] = y0; boxes[4 * r + 2] = x1; boxes[4 * r + 3] = y1;
    }
    ringBoxCache.set(region, {data: region.data, count: region.count, boxes});
    return boxes;
  }
  // edgeGrid() for queries inside `area` (boxes) only: the edges whose cells meet the area's cells, in
  // edgeGrid's order, so every query inside the area visits the same edges in the same order. Its
  // containment test is the same crossing test as edgeBands(), over the rings that can cross the ray.
  // An online re-check near a few objects costs the rings near them, not the whole region.
  function localGrid(rings, boxes, cell, area) {
    const m = new Map(), key = (x, y) => x * 73856093 ^ y * 19349663;
    const cells = area.map(b => [Math.floor(b[0] / cell), Math.floor(b[1] / cell), Math.floor(b[2] / cell), Math.floor(b[3] / cell)]);
    const hits = (x0, y0, x1, y1) => cells.some(c => x0 <= c[2] && x1 >= c[0] && y0 <= c[3] && y1 >= c[1]);
    for (let r = 0; r < rings.length; r++) {
      if (!hits(Math.floor(boxes[4 * r] / cell), Math.floor(boxes[4 * r + 1] / cell), Math.floor(boxes[4 * r + 2] / cell), Math.floor(boxes[4 * r + 3] / cell))) continue;
      const ring = rings[r], n = ring.length >> 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, x0 = Math.min(ring[2 * i], ring[2 * j]), x1 = Math.max(ring[2 * i], ring[2 * j]), y0 = Math.min(ring[2 * i + 1], ring[2 * j + 1]), y1 = Math.max(ring[2 * i + 1], ring[2 * j + 1]);
        const cx0 = Math.floor(x0 / cell), cx1 = Math.floor(x1 / cell), cy0 = Math.floor(y0 / cell), cy1 = Math.floor(y1 / cell);
        if (!hits(cx0, cy0, cx1, cy1)) continue;
        for (let x = cx0; x <= cx1; x++) for (let y = cy0; y <= cy1; y++) {
          const k = key(x, y); let l = m.get(k); if (!l) m.set(k, l = []); l.push(r, i);
        }
      }
    }
    function inside(x, y) {
      let odd = false;
      for (let r = 0; r < rings.length; r++) {
        if (!(boxes[4 * r + 1] <= y && boxes[4 * r + 3] > y && boxes[4 * r + 2] >= x)) continue;
        const ring = rings[r];
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const ax = ring[i], ay = ring[i + 1], bx = ring[j], by = ring[j + 1];
          if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) odd = !odd;
        }
      }
      return odd;
    }
    return {inside, prepare() {}, query: gridQuery(m, cell, key)};
  }
  // The gap between a DRC feature (convex pieces grown by a radius) and the poured region.
  function gapTo(f, rings, grid, need) {
    const pieces = f.pieces || [f];
    let best = {d: Infinity, at: null};
    for (const p of pieces) {
      const K = R().kit;
      // Copper of the feature inside the poured area, or the area inside the feature.
      if (grid?.inside ? grid.inside(p.core[0][0], p.core[0][1]) : inside(p.core[0][0], p.core[0][1], rings)) return {d: 0, at: p.core[0]};
      if (p.core.length > 2 && rings.length && K.containsConvex([rings[0][0], rings[0][1]], p.core)) return {d: 0, at: [rings[0][0], rings[0][1]]};
      const reach = p.radius + Math.min(need, best.d);
      grid.query([p.box[0] - need, p.box[1] - need, p.box[2] + need, p.box[3] + need], (r, i) => {
        const ring = rings[r], n = ring.length >> 1, j = (i + 1) % n, a = [ring[2 * i], ring[2 * i + 1]], b = [ring[2 * j], ring[2 * j + 1]];
        for (const [u, v] of p.edges) {
          const c = segDist(u, v, a, b), d = Math.max(0, c.d - p.radius);
          if (d < best.d) best = {d, at: [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]};
        }
      });
      void reach;
      if (!best.d) return best;
    }
    return best;
  }

  // ---------------------------------------------------------------- the check
  // One feature against one poured region: null when the pair is not checked, false when it keeps
  // the rule, else the violation (steps() and the online session share it).
  // One region against one copper object: null when no rule applies (or it is out of reach), false when
  // it keeps its clearance, else the violation. A hole clearance violation (what "Hole clearance") is
  // kept apart from the object's land (pairKey). polygons: the board's polygons by id.
  function pair(K, C, ties, planeIds, reach, region, idx, pour, rings, grid, f, polygons) {
    const b = region.bounds;
    if (f.net === region.net || idx < f.span[0] || idx > f.span[1] || ties && ties.skip(pour, f)) return null;
    if (f.box[0] > b[2] + reach || f.box[2] < b[0] - reach || f.box[1] > b[3] + reach || f.box[3] < b[1] - reach) return null;
    const r = C.clearanceRule(pour, f); if (!r) return null;
    // A drilled object passing through an internal plane has no land there: the plane keeps its own
    // clearance (Altium's Plane Clearance, imported as the polygon's clearance) from the barrel, as the
    // pour engine cuts it. The Clearance rule's polygon cells govern positive pours, not planes.
    const plane = planeIds.has(region.polygon) && f.planeHole ? polygons.get(region.polygon) : null;
    const need = plane && Number.isFinite(plane.clearance) && plane.clearance >= 0 ? plane.clearance : K.clearanceGap(r, "poly", f.ck);
    const report = (g, need, what, hole) => g.d + K.EPS >= need ? false : {type: TYPE, typeTitle: TITLE, ruleId: r.id, ruleName: r.name, id: region.polygon ?? null, otherId: f.id,
      title: "Poured copper " + (pour.polygon || region.net) + " (" + region.layer + ") ↔ " + f.label + (hole ? " hole" : ""), what, actual: g.d, required: need, limit: "min", at: g.at, otherAt: f.at || g.at, net: region.net};
    const v = report(gapTo(plane ? f.planeHole : f, rings, grid, need), need, plane ? "Plane clearance" : "Pour clearance");
    if (v) return v;
    // The barrel of a drilled object keeps the rule's hole cell (Poly-Hole) from the pour as well,
    // wherever that reaches past its land (as the pour engine cuts it), where the rule authors
    // one (rules.js clearanceLimit: no Hole cell, no hole clearance).
    const holeNeed = !plane && f.planeHole ? K.clearanceLimit(r, "poly", "hole") ?? 0 : 0;
    return holeNeed > need + K.EPS ? report(gapTo(f.planeHole, rings, grid, holeNeed), holeNeed, "Hole clearance", true) : false;
  }
  const pairKey = (polygon, obj, v) => polygon + "|" + obj + (v.what === "Hole clearance" ? "|hole" : "");
  function* steps(doc, defs, rules, o = {}) {
    const t0 = Date.now(), K = R()?.kit, out = [], cap = o.limit ?? 2000;
    if (!K || !P()?.contours || doc?.kind !== "pcb") return {violations: out, checked: 0, ms: 0};
    const regions = (o.regions || doc.pcbDrawing?.pours || []).filter(r => r && r.net && r.count && (!o.polygons || o.polygons.has(r.polygon)));
    const polygons = new Map();
    for (const item of doc.items) if (item.kind === "polygon" && (regions.length || item.clearance > 0)) polygons.set(item.id, item);
    if (!regions.length && !polygons.size) return {violations: out, checked: 0, ms: 0};
    if (globalThis.AtriumPolygonPour?.queryPending(doc,{project:o.project,rules:o.compiled?.set ?? rules}))
      return {violations:out,checked:0,ms:0,pending:true};
    const C = o.compiled ?? R().compiled(doc, {rules, defs, project:o.project});
    const CR = C.byType.clearance || [];
    if (!CR.length) return {violations: out, checked: 0, ms: 0};
    // Batch DRC shares the owning rule's cap with the rest of its findings.
    // Standalone verification retains its own result window.
    const onViolation = o.onViolation, emit = onViolation || (v => out.push(v));
    const pourOf = region => K.copperSubject(polygons.get(region.polygon) || {...region, kind: "polygon"}, null, "polygon");
    // A polygon's own clearance below the rule: its fill keeps less than the rule asks everywhere it is tight.
    for (const p of polygons.values()) {
      // An internal plane's clearance is the source's Plane Clearance, not a Clearance rule value (below).
      if (!(Number.isFinite(p.clearance) && p.clearance > 0) || !p.net || p.cutout || p.keepout || p.powerPlane || (o.polygons && !o.polygons.has(p.id))) continue;
      const idx = K.copperIndex(p.layer); if (idx == null) continue;
      const self = K.copperSubject(p, null, "polygon");
      const other = {net: "\u0000other", span: [idx, idx], kind: "track", ck: "track", layer: p.layer};
      const r = C.clearanceRule(self, other); if (!r) continue;
      const need = K.clearanceGap(r, "poly", "track");
      if (p.clearance + K.EPS < need) emit({type: TYPE, typeTitle: TITLE, ruleId: r.id, ruleName: r.name, id: p.id, what: "Polygon clearance",
        title: "Polygon " + (p.name || p.net) + " (" + p.layer + ") clearance " + p.clearance + " mm is below the rule", actual: p.clearance, required: need, limit: "min", at: p.points?.[0] || null});
    }
    if (!regions.length) return {violations: out, checked: 0, ms: Date.now() - t0};
    const planeIds = new Set([...polygons.values()].filter(p => p.powerPlane).map(p => p.id));
    const F = K.extract(doc, defs, {planeHoles: true, nettedCopperOnly: true}).copper;
    const reach = Math.max(...CR.map(K.clearanceMax));
    // Features by box in a coarse grid, so each region visits its neighbourhood only.
    const cell = Math.max(1, reach * 4), fgrid = new Map(), fk = (x, y) => x * 73856093 ^ y * 19349663;
    F.forEach((f, n) => { for (let x = Math.floor(f.box[0] / cell); x <= Math.floor(f.box[2] / cell); x++) for (let y = Math.floor(f.box[1] / cell); y <= Math.floor(f.box[3] / cell); y++) { const k = fk(x, y); let l = fgrid.get(k); if (!l) fgrid.set(k, l = []); l.push(n); } });
    const ties = G.AtriumNetTies?.drcTies?.(doc, defs) || null, best = new Map();
    let checked = 0, work = 0;
    yield {part: true};
    for (const region of regions) {
      const idx = K.copperIndex(region.layer);
      if (idx == null) continue;
      let rings;
      try { rings = P().contours(region); } catch { continue; }
      if (!rings?.length) continue;
      const pour = pourOf(region), grid = edgeGrid(rings, Math.max(.5, reach * 2)), b = region.bounds, seen = new Set();
      yield {region, part: true};
      grid.prepare();
      yield {region, part: true};
      for (let x = Math.floor((b[0] - reach) / cell); x <= Math.floor((b[2] + reach) / cell); x++) for (let y = Math.floor((b[1] - reach) / cell); y <= Math.floor((b[3] + reach) / cell); y++) {
        for (const n of fgrid.get(fk(x, y)) || []) {
          if (seen.has(n)) continue; seen.add(n);
          const f = F[n], v = pair(K, C, ties, planeIds, reach, region, idx, pour, rings, grid, f, polygons);
          if (v === null) continue;
          if (++work % 64 === 0) yield {region, part: true};   // a large region takes many slices
          if (!v) continue;
          const key = pairKey(region.polygon, f.obj, v), prev = best.get(key);
          if (!prev || v.actual < prev.actual) best.set(key, v);
        }
      }
      checked++;
      yield {region};
    }
    for (const v of best.values()) {
      if (!onViolation && out.length >= cap) break;
      emit(v);
    }
    return {violations: out, checked, ms: Date.now() - t0};
  }
  function verify(doc, defs, rules, o = {}) { const it = steps(doc, defs, rules, o); let r = it.next(); while (!r.done) r = it.next(); return r.value; }

  // ---------------------------------------------------------------- online: one session per board
  // session().steps(doc, defs, rules, {project, changes, key}) gives what steps() gives, the same
  // violations in the same order, re-checking only what an edit can have changed:
  //   changes  the items changed since the session's last completed run ({ids, items}, the undo
  //            journal's AtriumUndoStore.changed), or null when unknown;
  //   key      the board's other inputs (its floor, outer, project, parameters and library versions);
  //   seq      the journal position of `changes` (since() gives it back for the next run).
  // A run re-checks the copper objects of the changed items, the objects within the rule's reach of
  // copper that changed (AtriumPCBPours.copperChange) and every finding of a polygon whose regions
  // were replaced, against the regions near them (localGrid). Anything else or anything unknown (a
  // first run, other inputs, rules, polygons, rule scopes that read other objects) is a full run.
  // The session is updated only when a run completes, so an abandoned run changes nothing; a run
  // reads the board as it was when it started.
  // Objects are keyed by item and rank among the item's copper objects (steps(): the object index),
  // and findings are ordered as steps() orders them: by their first violating region, then the first
  // grid cell of that region's scan holding the object, then the object's place on the board.
  function session() {
    let st = null;
    const fk = (x, y) => x * 73856093 ^ y * 19349663;
    const cellsOf = (box, cell) => [Math.floor(box[0] / cell), Math.floor(box[1] / cell), Math.floor(box[2] / cell), Math.floor(box[3] / cell)];
    // Feature records of an extraction, by item (an item's copper objects are consecutive); null
    // when an id repeats (keys would collide).
    function records(F) {
      const byItem = new Map();
      let last, list = null, obj = null, rank = -1, seq = 0;
      for (const f of F) {
        if (list === null || f.id !== last) {
          if (byItem.has(f.id)) return null;
          byItem.set(f.id, list = []); last = f.id; obj = null; rank = -1; seq = 0;
        }
        if (f.obj !== obj) { obj = f.obj; rank++; }
        list.push({f, id: f.id, ref: f.id + "#" + rank, seq: seq++});
      }
      return byItem;
    }
    function gridEdit(grid, rec, cell, add) {
      const [x0, y0, x1, y1] = cellsOf(rec.f.box, cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = fk(x, y);
        let l = grid.get(k);
        if (add) { if (!l) grid.set(k, l = new Set()); l.add(rec); }
        else if (l) { l.delete(rec); if (!l.size) grid.delete(k); }
      }
    }
    // Rule scopes that read other objects (anchors, names, parts, geometry) are re-checked in full.
    function local(C) {
      const dep = C.recheckBoardItems;
      return !C.diagnostics?.length && !C.measurementIssues?.size && !!dep && !dep.length && !dep.bound && !dep.usesParts &&
        !dep.anchors?.size && !dep.names?.size && !C.dependencies?.has("geometry:body") && !C.dependencies?.has("geometry:origin");
    }
    function byPolygon(list) {
      const m = new Map();
      for (const r of list) { let l = m.get(r.polygon); if (!l) m.set(r.polygon, l = []); l.push(r); }
      return m;
    }
    function* run(doc, defs, rules, o = {}) {
      const t0 = Date.now(), K = R()?.kit, out = [], cap = o.limit ?? 2000;
      const done = (checked, mode) => ({violations: out, checked, ms: Date.now() - t0, mode});
      if (!K || !P()?.contours || doc?.kind !== "pcb") { st = null; return done(0, "full"); }
      const all = (doc.pcbDrawing?.pours || []).slice(), regions = all.filter(r => r && r.net && r.count);
      const polygons = new Map();
      for (const item of doc.items) if (item.kind === "polygon" && (regions.length || item.clearance > 0)) polygons.set(item.id, item);
      if (!regions.length && !polygons.size) { st = null; return done(0, "full"); }
      if (globalThis.AtriumPolygonPour?.queryPending(doc, {project: o.project, rules})) return {violations: out, checked: 0, ms: 0, pending: true};
      const C = R().compiled(doc, {rules, defs, project: o.project});
      const CR = C.byType.clearance || [];
      if (!CR.length) { st = null; return done(0, "full"); }
      const pourOf = region => K.copperSubject(polygons.get(region.polygon) || {...region, kind: "polygon"}, null, "polygon");
      // A polygon's own clearance below the rule (as steps()).
      for (const p of polygons.values()) {
        if (!(Number.isFinite(p.clearance) && p.clearance > 0) || !p.net || p.cutout || p.keepout || p.powerPlane) continue;
        const idx = K.copperIndex(p.layer); if (idx == null) continue;
        const self = K.copperSubject(p, null, "polygon");
        const other = {net: "\u0000other", span: [idx, idx], kind: "track", ck: "track", layer: p.layer};
        const r = C.clearanceRule(self, other); if (!r) continue;
        const need = K.clearanceGap(r, "poly", "track");
        if (p.clearance + K.EPS < need) out.push({type: TYPE, typeTitle: TITLE, ruleId: r.id, ruleName: r.name, id: p.id, what: "Polygon clearance",
          title: "Polygon " + (p.name || p.net) + " (" + p.layer + ") clearance " + p.clearance + " mm is below the rule", actual: p.clearance, required: need, limit: "min", at: p.points?.[0] || null});
      }
      if (!regions.length) { st = null; return done(0, "full"); }
      const planeIds = new Set([...polygons.values()].filter(p => p.powerPlane).map(p => p.id));
      const reach = Math.max(...CR.map(K.clearanceMax)), cell = Math.max(1, reach * 4), gcell = Math.max(.5, reach * 2);
      const ties = G.AtriumNetTies?.drcTies?.(doc, defs) || null, extractOptions = {planeHoles: true, nettedCopperOnly: true};
      const rulesSig = JSON.stringify(rules), polySig = JSON.stringify([...polygons.values()]), ids = o.changes?.ids;
      // The definitions are compared by the library version in o.key (the editor builds a new index
      // whenever the journal's outer count moves, with the same definitions).
      const same = !!st && st.doc === doc && o.key != null && st.key === o.key && st.rulesSig === rulesSig &&
        st.polySig === polySig && st.reach === reach && st.planes === planeIds.size > 0 && ids instanceof Set && local(C);
      const copper = same ? P().copperChange?.(st.pours, all) : null;
      // Everything a run reads is taken when it starts (the regions, the extracted objects, the board
      // order), so its result is the board's at its journal position o.seq even when the board changes
      // while it runs (a refill landing during the run): the next run continues from there.
      const order0 = doc.items.slice();
      let index = null;
      const itemIndex = id => (index ??= new Map(order0.map((item, k) => [item.id, k]))).get(id) ?? -1;
      const scanOrder = (a, b) => a.cx - b.cx || a.cy - b.cy || (a.rec.id === b.rec.id ? 0 : itemIndex(a.rec.id) - itemIndex(b.rec.id)) || a.rec.seq - b.rec.seq;
      // One region against feature records in the region's scan order (steps(): cells by x then y,
      // then the board order), with the whole region's edge grid (full) or one around them.
      function* region(r, recs, full, found) {
        const idx = K.copperIndex(r.layer);
        if (idx == null) return false;
        const b = r.bounds, rx0 = Math.floor((b[0] - reach) / cell), ry0 = Math.floor((b[1] - reach) / cell);
        const near = recs.filter(rec => !(rec.f.box[0] > b[2] + reach || rec.f.box[2] < b[0] - reach || rec.f.box[1] > b[3] + reach || rec.f.box[3] < b[1] - reach));
        // An online re-check reads only the regions near what it re-checks.
        if (!full && !near.length) return false;
        let rings;
        try { rings = P().contours(r); } catch { return false; }
        if (!rings?.length) return false;
        if (!near.length) return true;
        const pour = pourOf(r), grid = full ? edgeGrid(rings, gcell) :
          localGrid(rings, ringBoxes(r, rings), gcell, near.map(rec => [rec.f.box[0] - reach, rec.f.box[1] - reach, rec.f.box[2] + reach, rec.f.box[3] + reach]));
        if (full) { yield {region: r, part: true}; grid.prepare(); yield {region: r, part: true}; }
        const order = near.map(rec => { const c = cellsOf(rec.f.box, cell); return {rec, cx: Math.max(c[0], rx0), cy: Math.max(c[1], ry0)}; }).sort(scanOrder);
        let work = 0;
        for (const e of order) {
          const v = pair(K, C, ties, planeIds, reach, r, idx, pour, rings, grid, e.rec.f, polygons);
          if (v === null) continue;
          if (++work % 64 === 0) yield {region: r, part: true};
          if (v) found(e, v);
        }
        return true;
      }
      const note = (entries, r) => (e, v) => {
        const key = pairKey(r.polygon, e.rec.ref, v), prev = entries.get(key);
        if (!prev) entries.set(key, {v, region: r, polygon: r.polygon, cx: e.cx, cy: e.cy, rec: e.rec});
        else if (v.actual < prev.v.actual) prev.v = v;
      };
      let checked = 0, mode, next;
      const byItem0 = copper ? null : records(K.extract(doc, defs, extractOptions).copper);
      if (copper) {
        // ---- incremental: the changed items' objects, objects near changed copper, replaced polygons
        mode = "incremental";
        const removed = new Map(), added = new Map(), refs = new Set();
        for (const id of ids) {
          const old = st.byItem.get(id);
          if (old) { removed.set(id, old); for (const rec of old) refs.add(rec.ref); }
        }
        for (const id of ids) {
          const item = o.changes.items?.get(id);
          if (!item) continue;
          const recs = records(K.extract(doc, defs, {...extractOptions, items: [item]}).copper);
          if (!recs) { st = null; return yield* run(doc, defs, rules, {...o, changes: null}); }
          for (const [rid, list] of recs) { added.set(rid, list); for (const rec of list) refs.add(rec.ref); }
        }
        for (const {layer, boxes} of copper.changes) {
          const idx = K.copperIndex(layer);
          for (const box of boxes) {
            const q = [box[0] - reach, box[1] - reach, box[2] + reach, box[3] + reach];
            const hit = rec => (idx == null || idx >= rec.f.span[0] && idx <= rec.f.span[1]) &&
              !(rec.f.box[0] > q[2] || rec.f.box[2] < q[0] || rec.f.box[1] > q[3] || rec.f.box[3] < q[1]);
            const [x0, y0, x1, y1] = cellsOf(q, cell);
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
              for (const rec of st.grid.get(fk(x, y)) || []) if (!removed.has(rec.id) && !added.has(rec.id) && hit(rec)) refs.add(rec.ref);
            for (const list of added.values()) for (const rec of list) if (hit(rec)) refs.add(rec.ref);
          }
        }
        // Findings of a polygon whose regions changed in any way are re-checked (a tie between two
        // of its edges or regions is decided by their order).
        const before = byPolygon(st.pours), after = byPolygon(all), replaced = new Set();
        for (const key of new Set([...before.keys(), ...after.keys()])) {
          const a = before.get(key) || [], b = after.get(key) || [];
          if (a.length !== b.length || a.some((r, k) => r !== b[k])) replaced.add(key);
        }
        for (const e of st.entries.values()) if (replaced.has(e.polygon)) refs.add(e.rec.ref);
        const recs = [];
        for (const ref of refs) {
          const id = ref.slice(0, ref.lastIndexOf("#")), list = added.get(id) || (removed.has(id) ? null : st.byItem.get(id));
          for (const rec of list || []) if (rec.ref === ref) recs.push(rec);
        }
        const fresh = new Map();
        yield {part: true};
        if (recs.length) for (const r of regions) if (yield* region(r, recs, false, note(fresh, r))) checked++;
        // Commit (no yield from here on): records, their grid, findings in steps() order.
        const {byItem, grid} = st;
        for (const [id, list] of removed) { for (const rec of list) gridEdit(grid, rec, cell, false); byItem.delete(id); }
        for (const [id, list] of added) { for (const rec of list) gridEdit(grid, rec, cell, true); byItem.set(id, list); }
        const position = new Map(regions.map((r, k) => [r, k])), entries = [];
        for (const [key, e] of st.entries) if (!refs.has(e.rec.ref) && position.has(e.region)) entries.push([key, e]);
        entries.push(...fresh);
        entries.sort(([, a], [, b]) => position.get(a.region) - position.get(b.region) || scanOrder(a, b));
        next = {byItem, grid, entries: new Map(entries)};
      } else if (byItem0) {
        // ---- full: steps()'s scan, keyed by item, recorded for the next run
        mode = "full";
        const grid = new Map(), entries = new Map();
        for (const list of byItem0.values()) for (const rec of list) gridEdit(grid, rec, cell, true);
        yield {part: true};
        for (const r of regions) {
          const b = r.bounds, list = new Set();
          for (let x = Math.floor((b[0] - reach) / cell); x <= Math.floor((b[2] + reach) / cell); x++) for (let y = Math.floor((b[1] - reach) / cell); y <= Math.floor((b[3] + reach) / cell); y++)
            for (const rec of grid.get(fk(x, y)) || []) list.add(rec);
          if (yield* region(r, [...list], true, note(entries, r))) checked++;
          yield {region: r};
        }
        next = {byItem: byItem0, grid, entries};
      } else {
        // Item ids repeat: the plain check, no session.
        st = null;
        const r = yield* steps(doc, defs, rules, {project: o.project, limit: cap, compiled: C});
        return {...r, mode: "full"};
      }
      for (const e of next.entries.values()) { if (out.length >= cap) break; out.push(e.v); }
      st = {doc, defs, key: o.key, seq: o.seq ?? null, rulesSig, polySig, reach, planes: planeIds.size > 0, pours: all, ...next};
      return done(checked, mode);
    }
    return {steps: run, reset() { st = null; }, since: () => st?.seq ?? null, size: () => st ? {items: st.byItem.size, findings: st.entries.size} : null};
  }

  return Object.freeze({TYPE, TITLE, verify, steps, session, gapTo, inside, edgeGrid, bands: bandsOf});
})();
