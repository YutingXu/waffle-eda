"use strict";
// Z-axis clearance (rigid-flex and HDI): copper of different nets on two copper layers must be
// at least the rule's distance apart in 3D, through the dielectric between them. The vertical
// gap is the dielectric thickness from the layer stack (AtriumStackup: bottom of the upper
// copper to the top of the lower one); the lateral gap is the 2D edge-to-edge distance the
// clearance check uses. Distance = hypot(lateral, dielectric), so copper that overlaps in plan
// is exactly the dielectric thickness apart.
//
// Rule type zClearance (rules.js): {gap, adjacentOnly}. adjacentOnly (default) checks only
// neighbouring copper layers; otherwise every layer pair, with the full stack between.
// Single-layer copper is checked: tracks, SMD pads, copper regions and graphics. Vias and
// through-hole pads exist on every layer they span, so the ordinary clearance covers them.
// Poured copper (board.pcbDrawing.pours) is checked against other nets' single-layer copper on
// the other layer only by rules with `pours` on (off by default: a plane over signals is
// usually the stack's intent, so older boards report what they did).
//
//   AtriumZClearance.dielectric(doc, defs)        -> {gap(layerA, layerB), adjacent(a, b), layers}
//   AtriumZClearance.drc(doc, defs, ctx)           -> called by AtriumRules.drc
//   AtriumZClearance.check(doc, defs, rules?)      -> zClearance violations only
//   AtriumZClearance.overlay(doc, defs, list)      -> canvas overlay painter
globalThis.AtriumZClearance = (() => {
  const EPS = 1e-6;
  const keyOf = i => i === 0 ? "Top" : i === 127 ? "Bottom" : "Inner " + i;
  const name = l => globalThis.AtriumPCBAppearance?.name?.(l) || l;
  // Dielectric between copper layers, from the stored or derived layer stack.
  function dielectric(doc, defs) {
    const S = globalThis.AtriumStackup, info = new Map();
    let keys = [];
    try { keys = S?.copperLayers?.(doc, defs) || []; } catch { keys = []; }
    for (const k of keys) { try { const l = S.layerInfo(doc, k, defs); if (l?.copper) info.set(k, {z: l.z, t: l.thickness || 0, n: l.number}); } catch { /* unknown layer */ } }
    function gap(a, b) {
      const p = info.get(a), q = info.get(b);
      if (!p || !q || a === b) return null;
      const [u, v] = p.z <= q.z ? [p, q] : [q, p];
      return Math.max(0, v.z - (u.z + u.t));
    }
    function adjacent(a, b) { const p = info.get(a), q = info.get(b); return !!p && !!q && Math.abs(p.n - q.n) === 1; }
    return {gap, adjacent, layers: keys};
  }
  // ctx from rules.js: {geo, first(type, o), pairs(F, reach, visit), pieceGap(a, b, limit), flag, notes}
  function drc(doc, defs, ctx) {
    const Z = dielectric(doc, defs);
    if (Z.layers.length < 2) return 0;
    const F = ctx.geo.copper.filter(f => f.net && f.span && f.span[0] === f.span[1]);
    const rulesFor = f => {
      const layer = f.span ? keyOf(f.span[0]) : f.layer;
      try { return ctx.first("zClearance", f.layer === layer ? f : {...f, layer}); } catch { return null; }
    };
    const reach = Math.max(0, ...(ctx.rules || []).map(r => +r.gap || 0));
    const pours = (ctx.rules || []).some(r => r.pours === true);
    if (!(reach > 0) || F.length < (pours ? 1 : 2)) return 0;
    const found = new Map();
    let count = ctx.pairs(F, reach, (a, b) => {
      if (a.net === b.net || a.span[0] === b.span[0]) return;
      const la = keyOf(a.span[0]), lb = keyOf(b.span[0]);
      const ra = rulesFor(a), rb = rulesFor(b), r = !ra ? rb : !rb ? ra : (rb.gap > ra.gap ? rb : ra);
      if (!r) return;
      if (r.adjacentOnly !== false && !Z.adjacent(la, lb)) return;
      ctx.candidate?.(r,a,b);
      const dz = Z.gap(la, lb);
      if (dz == null || dz + EPS >= r.gap) return;
      const lateral = Math.sqrt(Math.max(0, r.gap * r.gap - dz * dz));
      if (a.box[0] - b.box[2] >= lateral || b.box[0] - a.box[2] >= lateral || a.box[1] - b.box[3] >= lateral || b.box[1] - a.box[3] >= lateral) return;
      const g = ctx.pieceGap(a, b, lateral);
      if (g.d + EPS >= lateral) return;
      const d = Math.hypot(Math.max(0, g.d), dz), key = Math.min(a.obj, b.obj) + ":" + Math.max(a.obj, b.obj);
      const v = {r, id: a.id, otherId: b.id, title: a.label + " ↔ " + b.label + " (Z: " + name(la) + "–" + name(lb) + ")", actual: d, required: r.gap, limit: "min",
        at: g.at || a.at, otherAt: g.at || b.at, layers: [la, lb], dielectric: dz, lateral: Math.max(0, g.d),
        detail: "Z-axis clearance " + d.toFixed(4) + " mm (lateral " + Math.max(0, g.d).toFixed(4) + " mm, dielectric " + dz.toFixed(4) + " mm) is below " + r.gap + " mm."};
      const p = found.get(key); if (!p || v.actual < p.actual) found.set(key, v);
    });
    if (pours) count += pourPass(doc, Z, F, ctx, rulesFor, found);
    for (const {r, ...v} of found.values()) ctx.flag(r, v);
    return count;
  }
  // ---------------------------------------------------------------- pours
  // Distance from a copper feature (core points, edges, radius) to a poured region on another
  // layer: 0 where the feature sits over the copper, else edge to edge in plan.
  function segSeg2(ax, ay, bx, by, cx, cy, dx, dy) {
    const pt = (px, py, x1, y1, x2, y2) => { const ex = x2 - x1, ey = y2 - y1, l = ex * ex + ey * ey; let u = l > 0 ? ((px - x1) * ex + (py - y1) * ey) / l : 0; u = u < 0 ? 0 : u > 1 ? 1 : u; const x = x1 + ex * u - px, y = y1 + ey * u - py; return [x * x + y * y, x1 + ex * u, y1 + ey * u]; };
    const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const d1 = o(ax, ay, bx, by, cx, cy), d2 = o(ax, ay, bx, by, dx, dy), d3 = o(cx, cy, dx, dy, ax, ay), d4 = o(cx, cy, dx, dy, bx, by);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return [0, (ax + bx) / 2, (ay + by) / 2];
    let best = pt(ax, ay, cx, cy, dx, dy);
    for (const c of [pt(bx, by, cx, cy, dx, dy), pt(cx, cy, ax, ay, bx, by), pt(dx, dy, ax, ay, bx, by)]) if (c[0] < best[0]) best = c;
    return best;
  }
  function pourRegions(doc) {
    const C = globalThis.AtriumPCBPours?.contours || globalThis.AtriumPolygonPour?.rings, out = [];
    if (!C) return out;
    for (const reg of doc.pcbDrawing?.pours || []) {
      if (!reg?.layer || !reg.net) continue;
      let rings; try { rings = C(reg); } catch { continue; }
      const X1 = [], Y1 = [], X2 = [], Y2 = [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const ring of rings) {
        const n = ring.length >> 1;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          X1.push(ring[2 * j]); Y1.push(ring[2 * j + 1]); X2.push(ring[2 * i]); Y2.push(ring[2 * i + 1]);
          x0 = Math.min(x0, ring[2 * i]); x1 = Math.max(x1, ring[2 * i]); y0 = Math.min(y0, ring[2 * i + 1]); y1 = Math.max(y1, ring[2 * i + 1]);
        }
      }
      if (!X1.length) continue;
      // Edge buckets on a 1 mm grid.
      const cs = 1, nx = Math.max(1, Math.ceil((x1 - x0) / cs) + 1), cells = new Map(), rows = new Map();
      for (let e = 0; e < X1.length; e++) {
        const c0 = Math.floor((Math.min(X1[e], X2[e]) - x0) / cs), c1 = Math.floor((Math.max(X1[e], X2[e]) - x0) / cs);
        const r0 = Math.floor((Math.min(Y1[e], Y2[e]) - y0) / cs), r1 = Math.floor((Math.max(Y1[e], Y2[e]) - y0) / cs);
        for (let r = r0; r <= r1; r++) { let w = rows.get(r); if (!w) rows.set(r, w = []); w.push(e); for (let c = c0; c <= c1; c++) { const k = r * nx + c; let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(e); } }
      }
      const inside = (x, y) => {
        if (x < x0 || x > x1 || y < y0 || y > y1) return false;
        let odd = false;
        for (const e of rows.get(Math.floor((y - y0) / cs)) || []) { const ay = Y1[e], by = Y2[e]; if ((ay > y) !== (by > y) && x < (X2[e] - X1[e]) * (y - ay) / (by - ay) + X1[e]) odd = !odd; }
        return odd;
      };
      // Nearest boundary within `reach` of a box: [d, x, y] for the feature's edges.
      const near = (f, reach) => {
        let best = null;
        const c0 = Math.floor((f.box[0] - reach - x0) / cs), c1 = Math.floor((f.box[2] + reach - x0) / cs), r0 = Math.floor((f.box[1] - reach - y0) / cs), r1 = Math.floor((f.box[3] + reach - y0) / cs);
        const seen = new Set();
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          if (c < 0 || c >= nx || r < 0) continue;
          for (const e of cells.get(r * nx + c) || []) {
            if (seen.has(e)) continue; seen.add(e);
            for (const [a, b] of f.edges || [[f.core[0], f.core[0]]]) {
              const g = segSeg2(a[0], a[1], b[0], b[1], X1[e], Y1[e], X2[e], Y2[e]);
              if (!best || g[0] < best[0]) best = g;
            }
          }
        }
        return best ? [Math.sqrt(best[0]), best[1], best[2]] : null;
      };
      out.push({reg, layer: reg.layer, net: reg.net, box: [x0, y0, x1, y1], inside, near});
    }
    return out;
  }
  function pourPass(doc, Z, F, ctx, rulesFor, found) {
    const regions = pourRegions(doc);
    if (!regions.length) return 0;
    let owners, count = 0, n = 0;
    const kit = globalThis.AtriumRules.kit;
    for (const P of regions) {
      n++;
      const id = P.reg.polygon;
      if (id != null) owners ??= new Map((doc.items || []).filter(i => i.kind === "polygon").map(i => [i.id, i]));
      const owner = owners?.get(id);
      // Unlinked imported copper still has its evaluated net, layer, and bounds.
      const source = owner && owner.net === P.net && owner.layer === P.layer ? owner :
        {...(owner || P.reg), id: owner?.id ?? id ?? P.reg.id, net: P.net, layer: P.layer};
      const subject = kit.copperSubject(source, null, "polygon"), rp = rulesFor(subject);
      for (const f of F) {
        if (f.net === P.net) continue;
        const lf = keyOf(f.span[0]);
        if (lf === P.layer) continue;
        const rf = rulesFor(f), r = !rp ? rf : !rf ? rp : (rf.gap > rp.gap ? rf : rp);
        if (!r || r.pours !== true) continue;
        if (r.adjacentOnly !== false && !Z.adjacent(lf, P.layer)) continue;
        ctx.candidate?.(r,f,subject);
        const dz = Z.gap(lf, P.layer);
        if (dz == null || dz + EPS >= r.gap) continue;
        const lateral = Math.sqrt(Math.max(0, r.gap * r.gap - dz * dz));
        if (f.box[0] - P.box[2] >= lateral || P.box[0] - f.box[2] >= lateral || f.box[1] - P.box[3] >= lateral || P.box[1] - f.box[3] >= lateral) continue;
        count++;
        // Over the copper: a core point inside the region (pieces of a compound region too).
        let g = null;
        for (const piece of f.pieces || [f]) { for (const q of piece.core || []) if (P.inside(q[0], q[1])) { g = [0, q[0], q[1]]; break; } if (g) break; }
        if (!g) {
          for (const piece of f.pieces || [f]) { const h = P.near(piece, lateral + (piece.radius || 0)); if (h && (!g || h[0] < g[0])) g = h; }
          if (!g) continue;
          g = [Math.max(0, g[0] - (f.radius || 0)), g[1], g[2]];
        }
        if (g[0] + EPS >= lateral) continue;
        const d = Math.hypot(g[0], dz), key = f.obj + ":pour" + n;
        const v = {r, id: f.id, otherId: P.reg.polygon || null, title: f.label + " ↔ Pour " + P.net + " (Z: " + name(lf) + "–" + name(P.layer) + ")", actual: d, required: r.gap, limit: "min",
          at: [g[1], g[2]], otherAt: [g[1], g[2]], layers: [lf, P.layer], dielectric: dz, lateral: g[0], pour: true,
          detail: "Z-axis clearance to poured " + P.net + " copper " + d.toFixed(4) + " mm (lateral " + g[0].toFixed(4) + " mm, dielectric " + dz.toFixed(4) + " mm) is below " + r.gap + " mm."};
        const p = found.get(key); if (!p || v.actual < p.actual) found.set(key, v);
      }
    }
    return count;
  }
  function check(doc, defs, rules) {
    const R = globalThis.AtriumRules;
    if (!R?.drc) throw Error("Z-axis clearance needs the rules module (rules.js).");
    return R.drc(doc, defs, rules ?? R.stored(doc) ?? R.defaults(), {types: ["zClearance"], limit: 5000}).violations.filter(v => v.type === "zClearance");
  }
  // Overlay: a ring and a cross-section tag at each violation, in world coordinates.
  function overlay(doc, defs, list) {
    return (ctx, view) => {
      const px = 1 / (view.scale * (view.dpr || 1));
      ctx.save();
      ctx.lineWidth = 2 * px; ctx.strokeStyle = "#ff3df2"; ctx.fillStyle = "rgba(255,61,242,.18)";
      ctx.font = (11 * px) + "px system-ui, sans-serif"; ctx.textBaseline = "bottom";
      for (const v of list) {
        const at = v.at; if (!at) continue;
        const r = Math.max(v.required, 6 * px);
        ctx.beginPath(); ctx.arc(at[0], at[1], r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(at[0] - r * .7, at[1]); ctx.lineTo(at[0] + r * .7, at[1]); ctx.moveTo(at[0], at[1] - r * .7); ctx.lineTo(at[0], at[1] + r * .7); ctx.stroke();
        const text = "Z " + v.actual.toFixed(3) + " < " + v.required + " mm · " + (v.layers || []).map(name).join("–") + " · ε " + (v.dielectric ?? 0).toFixed(3);
        ctx.fillStyle = "#ff3df2"; ctx.fillText(text, at[0] + r + 3 * px, at[1] - 2 * px); ctx.fillStyle = "rgba(255,61,242,.18)";
      }
      ctx.restore();
    };
  }
  // View → Z-Axis Clearance Overlay: violations of the board's zClearance rules, refreshed after edits.
  let enabled = false, host = null, cache = null;
  function list(d) {
    const rev = host?.revision?.();
    if (cache && cache.doc === d && cache.rev === rev) return cache.list;
    let out = [];
    try {
      const R = globalThis.AtriumRules, rules = R?.stored?.(d, host?.project?.()) ?? null, set = R?.migrate ? R.migrate(rules ?? R.defaults()) : null;
      out = (set?.list || []).some(r => r.type === "zClearance" && r.enabled !== false) ? check(d, host.defs(), rules ?? undefined) : [];
    } catch { out = []; }
    cache = {doc: d, rev, list: out};
    return out;
  }
  function attach(h) {
    host = h;
    h.registerAction?.("z-clearance-overlay", () => {
      enabled = !enabled; cache = null;
      globalThis.AtriumNavCommon?.setChecked?.("z-clearance-overlay", enabled);
      const d = h.doc(), n = enabled && d?.kind === "pcb" ? list(d).length : 0;
      h.info?.(enabled ? (n ? n + " Z-axis clearance violation" + (n === 1 ? "" : "s") + " shown." : "Z-axis clearance overlay on: no violations (add a Z-Axis Clearance rule in Design → Rules).") : "Z-axis clearance overlay off.");
      h.invalidate?.();
    });
    h.addRenderer?.(d => {
      if (!enabled || d?.kind !== "pcb") return null;
      const l = list(d);
      return l.length ? {overlay: overlay(d, h.defs(), l)} : null;
    });
    try { globalThis.AtriumNavCommon?.menuItem?.("view", "z-clearance-overlay", "Z-Axis Clearance Overlay", {after: "drc-markers", scope: "pcb", checkable: true}); } catch { /* no menu */ }
  }
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({dielectric, drc, check, overlay, attach, get enabled() { return enabled; }});
})();
