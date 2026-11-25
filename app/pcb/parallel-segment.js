"use strict";
// Parallel Segment rule (Altium ParallelSegment): a crosstalk screen, not a simulation.
// Track segments of different nets (rule scope 1 × scope 2) that run parallel with an edge gap at
// or below the rule's parallel gap may do so for at most the parallel limit: per segment pair, or
// summed per net pair ("Sum per net pair"). Layer checking: the same copper layer, broadside on
// adjacent copper layers (lateral edge gap), or both.
//
//   scan(doc, defs, {rules, pick(a, b) -> rule|null, adjacent(l1, l2)}) -> [{a, b, length, gap, relation, at, rule}]
//   drc(doc, defs, {R, rules, flag, notes}) -> candidate pairs examined (rules.js)
// DOM-free; a uniform grid limits the pairs examined.
globalThis.AtriumParallelSegment = (() => {
  const EPS = 1e-6, COS_MAX = Math.cos(2 * Math.PI / 180); // parallel within 2°
  const r4 = v => Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 + 0 : v;
  const copperRank = name => name === "Top" ? 0 : name === "Bottom" ? 10000 : (/^Inner (\d+)$/.exec(name || "") || [])[1] != null ? +/^Inner (\d+)$/.exec(name)[1] : null;
  function layerOrder(doc, defs) {
    try {
      const S = globalThis.AtriumStackup, st = S?.get?.(doc, defs);
      const keys = st?.layers?.filter(l => S.isCopper ? S.isCopper(l) : l.type === "Signal" || l.type === "Plane").map(l => l.key).filter(Boolean);
      if (keys?.length) return new Map(keys.map((k, i) => [k, i]));
    } catch { /* fall back to names */ }
    const used = [...new Set((doc.items || []).filter(i => i.kind === "track").map(i => i.layer || "Top"))].filter(l => copperRank(l) != null).sort((a, b) => copperRank(a) - copperRank(b));
    return new Map(used.map((k, i) => [k, i]));
  }
  function segments(doc, nets) {
    const out = [];
    for (const t of doc.items || []) {
      if (t.kind !== "track" || !t.net || !nets.has(t.net) || !Array.isArray(t.points) || t.keepout || t.fill) continue;
      for (let k = 1; k < t.points.length; k++) {
        const a = t.points[k - 1], b = t.points[k], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L > EPS) out.push({id: t.id, net: t.net, layer: t.layer || "Top", w: +t.width || .15, a, b, L, ux: (b[0] - a[0]) / L, uy: (b[1] - a[1]) / L});
      }
    }
    return out;
  }
  // Overlap length and centre-line separation of two near-parallel segments, or null.
  function parallel(s, t) {
    const dot = s.ux * t.ux + s.uy * t.uy;
    if (Math.abs(dot) < COS_MAX) return null;
    const pa = (t.a[0] - s.a[0]) * s.ux + (t.a[1] - s.a[1]) * s.uy, pb = (t.b[0] - s.a[0]) * s.ux + (t.b[1] - s.a[1]) * s.uy;
    const lo = Math.max(0, Math.min(pa, pb)), hi = Math.min(s.L, Math.max(pa, pb));
    if (hi - lo <= EPS) return null;
    const mid = (lo + hi) / 2, mx = s.a[0] + s.ux * mid, my = s.a[1] + s.uy * mid;
    // Perpendicular distance from the overlap midpoint to t's line.
    const sep = Math.abs((mx - t.a[0]) * t.uy - (my - t.a[1]) * t.ux);
    return {length: hi - lo, sep, at: [mx, my]};
  }
  function scan(doc, defs, o) {
    const nets = new Set(); for (const i of doc.items || []) if (i.kind === "track" && i.net) nets.add(i.net);
    const segs = segments(doc, nets), order = layerOrder(doc, defs), reach = Math.max(.1, ...o.rules.map(r => r.gap));
    const CELL = Math.max(1, reach * 4), grid = new Map(), key = (x, y) => x * 73856093 ^ y * 19349663;
    segs.forEach((s, i) => {
      const m = reach + s.w;
      const x0 = Math.floor((Math.min(s.a[0], s.b[0]) - m) / CELL), x1 = Math.floor((Math.max(s.a[0], s.b[0]) + m) / CELL);
      const y0 = Math.floor((Math.min(s.a[1], s.b[1]) - m) / CELL), y1 = Math.floor((Math.max(s.a[1], s.b[1]) + m) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = key(x, y); let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(i); }
    });
    const seen = new Set(), out = [];
    let candidates = 0;
    for (const cell of grid.values()) for (let p = 0; p < cell.length; p++) for (let q = p + 1; q < cell.length; q++) {
      const i = Math.min(cell[p], cell[q]), j = Math.max(cell[p], cell[q]), s = segs[i], t = segs[j];
      if (s.net === t.net) continue;
      const pk = i * 4194304 + j; if (seen.has(pk)) continue; seen.add(pk);
      const li = order.get(s.layer), lj = order.get(t.layer);
      const relation = s.layer === t.layer ? "same" : li != null && lj != null && Math.abs(li - lj) === 1 ? "adjacent" : null;
      if (!relation) continue;
      const rule = o.pick(s, t, relation); if (!rule) continue;
      candidates++;
      const pr = parallel(s, t); if (!pr) continue;
      const gap = Math.max(0, pr.sep - (s.w + t.w) / 2);
      if (gap > rule.gap + EPS) continue;
      out.push({a: s, b: t, length: pr.length, gap, relation, at: pr.at, rule});
    }
    out.candidates = candidates;
    return out;
  }
  function drc(doc, defs, {rules, flag}) {
    const ok = (r, rel) => r.layers === "both" || r.layers === rel || (!r.layers && rel === "same");
    const pick = (s, t, rel) => { for (const r of rules) if (ok(r, rel) && (r.m1({net: s.net, layer: s.layer}) && r.m2({net: t.net, layer: t.layer}) || r.m1({net: t.net, layer: t.layer}) && r.m2({net: s.net, layer: s.layer}))) return r; return null; };
    const hits = scan(doc, defs, {rules, pick});
    const sums = new Map();
    for (const h of hits) {
      const r = h.rule;
      if (r.accumulate) {
        const k = r.id + "\u0001" + [h.a.net, h.b.net].sort().join("\u0001") + "\u0001" + h.relation;
        const e = sums.get(k) || {r, a: h.a, b: h.b, length: 0, gap: Infinity, relation: h.relation, at: h.at};
        e.length += h.length; if (h.gap < e.gap) { e.gap = h.gap; e.at = h.at; } sums.set(k, e);
      } else if (h.length > r.limit + EPS) report(flag, r, h);
    }
    for (const e of sums.values()) if (e.length > e.r.limit + EPS) report(flag, e.r, e, true);
    return hits.candidates || 0;
  }
  function report(flag, r, h, sum) {
    const where = h.relation === "same" ? h.a.layer : h.a.layer + " / " + h.b.layer;
    flag(r, {id: h.a.id, otherId: h.b.id, title: "Net " + h.a.net + " ↔ " + h.b.net + " (" + where + ")", what: "Parallel length",
      detail: (sum ? "Summed parallel run " : "Parallel run ") + r4(h.length) + " mm at a gap of " + r4(h.gap) + " mm" + (h.relation === "adjacent" ? " (broadside)" : "") + "; limit " + r.limit + " mm below " + r.gap + " mm. Increase the spacing or shorten the shared run.",
      actual: h.length, required: r.limit, limit: "max", at: h.at, otherAt: h.at, gap: h.gap, relation: h.relation});
  }
  return Object.freeze({scan, parallel, drc, layerOrder});
})();
