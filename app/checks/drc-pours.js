"use strict";
// Pour clearance verification: poured copper against the
// Clearance rules. The pour engine offsets every obstacle by the polygon's own clearance, and DRC's
// Clearance check does not read poured copper, so a polygon whose `clearance` is below the rule, or a
// fill left stale by an edit, was never reported. Altium checks poured copper; so does this.
//
//   AtriumDRCPours.verify(doc, defs, rules, {project, regions?, polygons?, limit}) → {violations, checked, ms}
//   AtriumDRCPours.steps(...)   the same as a generator for idle slices (a yield after setup, after each
//                               region's edge index and every 64 features; no step is long on a 25k board)
// Violations have DRC's shape ({type: "pourClearance", ruleId, ruleName, id: polygon, otherId, actual,
// required, limit: "min", at, title}), so markers, the inspector, Problems and reports show them:
//   - copper of another net closer to a poured region than the Clearance rule asks (or inside it);
//   - a polygon whose own clearance is below the rule (the fill is then wrong wherever it is tight).
//   - a drilled object's barrel closer than the rule's hole cell (Poly-Hole), where one is authored.
// An internal plane (powerPlane) holds a drilled object of another net to its own clearance (the
// source's Plane Clearance) from the barrel, not to the Clearance rule.
// It runs lazily in idle slices after a refill (drc-view.js, the check scheduler) and always before
// outputs (fab-outputs.js), which report what it finds. Loaded with the rules engine (app/lazy.js).
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
    return {inside: (x, y) => (fast ??= bandsOf(rings, cell))(x, y), prepare() { fast ??= bandsOf(rings, cell); }, query(b, fn) {
      const seen = new Set();
      for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++) for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++) {
        const l = m.get(key(x, y)); if (!l) continue;
        for (let k = 0; k < l.length; k += 2) { const id = l[k] * 1e7 + l[k + 1]; if (seen.has(id)) continue; seen.add(id); fn(l[k], l[k + 1]); }
      }
    }};
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
          const f = F[n];
          if (f.net === region.net || idx < f.span[0] || idx > f.span[1] || ties && ties.skip(pour, f)) continue;
          if (f.box[0] > b[2] + reach || f.box[2] < b[0] - reach || f.box[1] > b[3] + reach || f.box[3] < b[1] - reach) continue;
          const r = C.clearanceRule(pour, f); if (!r) continue;
          // A drilled object passing through an internal plane has no land there: the plane keeps its own
          // clearance (Altium's Plane Clearance, imported as the polygon's clearance) from the barrel, as the
          // pour engine cuts it. The Clearance rule's polygon cells govern positive pours, not planes.
          const plane = planeIds.has(region.polygon) && f.planeHole ? polygons.get(region.polygon) : null;
          const need = plane && Number.isFinite(plane.clearance) && plane.clearance >= 0 ? plane.clearance : K.clearanceGap(r, "poly", f.ck);
          if (++work % 64 === 0) yield {region, part: true};   // a large region takes many slices
          const report = (g, need, what, hole) => {
            if (g.d + K.EPS >= need) return false;
            const key = region.polygon + "|" + f.obj + (hole ? "|hole" : ""), prev = best.get(key);
            if (!prev || g.d < prev.actual) best.set(key, {type: TYPE, typeTitle: TITLE, ruleId: r.id, ruleName: r.name, id: region.polygon ?? null, otherId: f.id,
              title: "Poured copper " + (pour.polygon || region.net) + " (" + region.layer + ") ↔ " + f.label + (hole ? " hole" : ""), what, actual: g.d, required: need, limit: "min", at: g.at, otherAt: f.at || g.at, net: region.net});
            return true;
          };
          if (report(gapTo(plane ? f.planeHole : f, rings, grid, need), need, plane ? "Plane clearance" : "Pour clearance")) continue;
          // The barrel of a drilled object keeps the rule's hole cell (Poly-Hole) from the pour as well,
          // wherever that reaches past its land (as the pour engine cuts it).
          const holeNeed = !plane && f.planeHole ? K.clearanceGap(r, "poly", "hole") : 0;
          if (holeNeed > need + K.EPS) report(gapTo(f.planeHole, rings, grid, holeNeed), holeNeed, "Hole clearance", true);
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

  return Object.freeze({TYPE, TITLE, verify, steps, gapTo, inside, edgeGrid, bands: bandsOf});
})();
