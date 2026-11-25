"use strict";
// Flex routing and flex construction checks (rule types flexRouting and flexBuild in
// rules.js). AtriumRules.drc calls drc() on boards with board regions or substacks, after the
// rigid-flex checks in rigid-flex.js (layer availability, vias in flex, bend keepouts, bend
// crossing, bend radius, hatched copper, stiffener placement).
//
// flexRouting {requireTeardrops, staggerLayers, minStackRun, bendTermination}
//   - a track that meets a pad or via inside a flex region has a teardrop there (teardrops.js
//     tags: teardropTrack + teardropAnchor), unless the track is as wide as the land;
//   - tracks on different copper layers of a flex region are staggered: copper stacked over
//     copper for more than minStackRun mm makes an I-beam that cracks when flexed (warning);
//   - no track starts, ends or changes width inside a bend zone (warning).
// flexBuild {transition, stiffenerGap, coverlayExpansion, minWeb}
//   - a bend zone keeps `transition` mm from every rigid region (the rigid-flex interface);
//   - stiffeners stay `stiffenerGap` mm clear of bend zones;
//   - bend zones do not overlap, and every bend line cuts across its flex region;
//   - coverlay webs between neighbouring pad openings (pads grown by coverlayExpansion) are at
//     least minWeb wide, or the openings touch and can be ganged into one (warning).
//
// The defaults are common flex-fabricator design guidance (about 1.5 mm from bend to rigid
// edge, 0.25 mm minimum coverlay web, 0.1 mm coverlay opening growth); the rule fields
// override them.
globalThis.AtriumFlexDRC = (() => {
  const EPS = 1e-6, DEG = Math.PI / 180;
  const RF = () => globalThis.AtriumRigidFlex;
  const A = () => globalThis.Atrium;
  const layerKey = i => i === 0 ? "Top" : i === 127 ? "Bottom" : "Inner " + i;
  const layerNo = l => l === "Top" ? 0 : l === "Bottom" ? 127 : /^Inner \d+$/.test(l || "") ? +l.slice(6) : null;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const boxOf = pts => {let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of pts) {a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]);} return [a, b, c, d];};
  const meet = (a, b, m = 0) => a[0] <= b[2] + m && b[0] <= a[2] + m && a[1] <= b[3] + m && b[1] <= a[3] + m;

  // Pads and vias with world centre, land size, net, copper layers and the teardrop anchor id.
  function anchors(doc, defs) {
    const out = [];
    const span = (layer, drill) => {const n = layerNo(layer); return layer === "Multi" || drill > 0 && !layer ? [0, 127] : n == null ? [0, 0] : [n, n];};
    for (const i of doc.items || []) {
      if (i.kind === "via") {
        const a = layerNo(i.fromLayer), b = layerNo(i.toLayer);
        out.push({id:i.id, owner:i.id, label:"Via", at:[i.x, i.y], size:i.diameter || 0, w:i.diameter || 0, h:i.diameter || 0, angle:0, round:true, net:i.net || "", span:a != null && b != null ? [Math.min(a, b), Math.max(a, b)] : [0, 127], via:true});
      } else if (i.kind === "pad") {
        out.push({id:i.id, owner:i.id, label:"Pad " + (i.number || i.id), at:[i.x, i.y], size:Math.min(i.w || 0, i.h || 0), w:i.w || 0, h:i.h || 0, angle:i.angle || 0, round:/round|circle|oval|ellipse/i.test(i.shape || "round"), net:i.net || "", span:span(i.layer || (i.drill > 0 ? "Multi" : "Top"), i.drill)});
      } else if (i.kind === "part") {
        for (const p of defs?.get?.(i.def)?.footprint?.pads || []) {
          let layer = p.layer || (p.drill > 0 ? "Multi" : i.layer || "Top");
          if (i.layer === "Bottom" && !p.layer && !(p.drill > 0)) layer = "Bottom";
          out.push({id:i.id + ":" + p.number, owner:i.id, label:"Pad " + (i.ref || i.id) + "-" + p.number, at:A().world([p.x, p.y], i), size:Math.min(p.w || 0, p.h || 0), w:p.w || 0, h:p.h || 0,
            angle:(p.angle || 0) + (i.angle || 0), round:/round|circle|oval|ellipse/i.test(p.shape || "round"), net:(i.pinNets?.[p.number] ?? p.net) || "", span:span(layer, p.drill)});
        }
      }
    }
    return out;
  }
  // Outline of an anchor's land grown by g (rectangles rotated; round lands as 16-gons).
  function land(a, g) {
    const w = a.w + 2 * g, h = a.h + 2 * g, c = Math.cos(a.angle * DEG), s = Math.sin(a.angle * DEG), pts = [];
    if (a.round) for (let k = 0; k < 16; k++) {const t = k / 16 * 2 * Math.PI; pts.push([w / 2 * Math.cos(t), h / 2 * Math.sin(t)]);}
    else pts.push([-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]);
    return pts.map(p => [a.at[0] + p[0] * c - p[1] * s, a.at[1] + p[0] * s + p[1] * c]);
  }
  function polyGap(P, Q) {
    const G = RF().geometry;
    if (G.polyOverlap(P, Q)) return 0;
    let d = Infinity;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) for (let k = 0, l = Q.length - 1; k < Q.length; l = k++) d = Math.min(d, G.segSegDist(P[j], P[i], Q[l], Q[k]));
    return d;
  }
  // Grow a bend zone (4 points: a+n, b+n, b-n, a-n) by m across and along.
  function grownZone(b, m) {
    const n = b.axis.normal, d = b.axis.direction, hw = b.width / 2 + m;
    return [[b.a[0] + n[0] * hw - d[0] * m, b.a[1] + n[1] * hw - d[1] * m], [b.b[0] + n[0] * hw + d[0] * m, b.b[1] + n[1] * hw + d[1] * m],
      [b.b[0] - n[0] * hw + d[0] * m, b.b[1] - n[1] * hw + d[1] * m], [b.a[0] - n[0] * hw - d[0] * m, b.a[1] - n[1] * hw - d[1] * m]];
  }

  // ---------------------------------------------------------------- flexRouting
  function routing(doc, defs, R, api) {
    const {geo, first, flag} = api, G = RF().geometry, flexRegs = R.regions.filter(g => g.flex);
    if (!flexRegs.length) return;
    const flexAt = p => {const g = R.regionAt(p); return g?.flex ? g : null;};
    const tracks = geo.tracks.filter(t => t.points.length >= 2 && t.span && t.span[0] === t.span[1]);
    // Teardrops on pads and vias in flex.
    const drops = new Set((doc.items || []).filter(i => i.kind === "graphic" && i.teardrop === true).map(i => i.teardropTrack + "|" + i.teardropAnchor));
    const lands = anchors(doc, defs).filter(a => a.size > 0 && flexAt(a.at));
    if (lands.length) {
      const cell = 2, grid = new Map(), key = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
      for (const a of lands) {const k = key(...a.at); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(a);}
      const near = p => {const out = [], cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell); for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) out.push(...grid.get((cx + x) + "," + (cy + y)) || []); return out;};
      for (const t of tracks) {
        const r = first("flexRouting", t);
        if (!r?.requireTeardrops) continue;
        const li = t.span[0];
        for (const end of [t.points[0], t.points.at(-1)]) {
          for (const a of near(end)) {
            if (li < a.span[0] || li > a.span[1] || dist(end, a.at) > a.size / 2 + EPS || (a.net && t.net && a.net !== t.net)) continue;
            if (!(t.width < a.size - EPS)) continue;
            if (drops.has(t.id + "|" + a.id)) continue;
            const g = flexAt(a.at);
            flag(r, {id:t.id, title:t.label + " at " + a.label + " in " + g.name, detail:"No teardrop where the track meets the " + (a.via ? "via" : "pad") + " in flex region " + g.name + "; add one (Tools › Teardrops…)", at:a.at});
            break;
          }
        }
      }
    }
    // Stacked traces across flex copper layers (I-beam).
    const segs = [];
    for (const t of tracks) {
      const r = first("flexRouting", t);
      if (!r?.staggerLayers) continue;
      for (let n = 1; n < t.points.length; n++) {
        const a = t.points[n - 1], b = t.points[n], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], g = flexAt(m);
        if (g && dist(a, b) > EPS) segs.push({t, r, a, b, g, layer:t.span[0], box:boxOf([a, b]), w:t.width || 0});
      }
    }
    const reported = new Set();
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i], q = segs[j];
      if (p.layer === q.layer || p.g !== q.g || !meet(p.box, q.box, (p.w + q.w) / 2) || reported.has(p.t.id + "|" + q.t.id)) continue;
      const L = dist(p.a, p.b), u = [(p.b[0] - p.a[0]) / L, (p.b[1] - p.a[1]) / L], lq = dist(q.a, q.b), v = [(q.b[0] - q.a[0]) / lq, (q.b[1] - q.a[1]) / lq];
      if (Math.abs(u[0] * v[0] + u[1] * v[1]) < Math.cos(20 * DEG)) continue;
      const ta = (q.a[0] - p.a[0]) * u[0] + (q.a[1] - p.a[1]) * u[1], tb = (q.b[0] - p.a[0]) * u[0] + (q.b[1] - p.a[1]) * u[1];
      const lo = Math.max(0, Math.min(ta, tb)), hi = Math.min(L, Math.max(ta, tb)), run = hi - lo;
      const r = p.r.minStackRun <= q.r.minStackRun ? p.r : q.r;
      if (!(run > r.minStackRun + EPS)) continue;
      const mid = [p.a[0] + u[0] * (lo + hi) / 2, p.a[1] + u[1] * (lo + hi) / 2], lateral = G.segDist(mid, q.a, q.b);
      if (lateral >= (p.w + q.w) / 2 - EPS) continue;
      reported.add(p.t.id + "|" + q.t.id);
      const name = l => globalThis.AtriumRules?.layerLabel?.(layerKey(l)) || layerKey(l);
      flag(r, {id:p.t.id, title:p.t.label + " over " + q.t.label + " in " + p.g.name, detail:"Warning: copper stacked on " + name(p.layer) + " and " + name(q.layer) + " for " + run.toFixed(2) + " mm in flex region " + p.g.name + " (I-beam); stagger the traces", at:mid, severity:"warning", warning:true});
    }
    // Track ends and width changes inside bend zones.
    if (R.bends.length) for (const t of tracks) {
      const r = first("flexRouting", t);
      if (!r?.bendTermination) continue;
      for (const end of [t.points[0], t.points.at(-1)]) {
        const b = R.bends.find(b => G.inside(end, b.zone));
        if (!b) continue;
        // A track continuing with the same width on the same layer is a joint, not an end.
        const joined = tracks.some(o => o !== t && o.span[0] === t.span[0] && Math.abs((o.width || 0) - (t.width || 0)) < EPS && (dist(o.points[0], end) < EPS || dist(o.points.at(-1), end) < EPS));
        if (joined) continue;
        const widthChange = tracks.some(o => o !== t && o.span[0] === t.span[0] && (dist(o.points[0], end) < EPS || dist(o.points.at(-1), end) < EPS));
        flag(r, {id:t.id, title:t.label + " in " + b.name, detail:"Warning: track " + (widthChange ? "changes width" : "ends") + " inside the bend zone of " + b.name + "; keep tracks continuous and of one width through bends", at:end, severity:"warning", warning:true});
        break;
      }
    }
  }

  // ---------------------------------------------------------------- flexBuild
  function build(doc, defs, R, api) {
    const {first, flag, notes} = api, G = RF().geometry, r = first("flexBuild", {net:"", span:[0, 127]});
    if (!r) return;
    const rigid = R.regions.filter(g => !g.flex);
    for (const b of R.bends) {
      if (!b.region) continue;
      const reg = R.regions.find(g => g.id === b.region);
      // The bend line must cut across its region to fold.
      const d = b.axis.direction, e = 0.05, pieces = RF().splitPolygon(reg.points, [b.a[0] - d[0] * e, b.a[1] - d[1] * e], [b.b[0] + d[0] * e, b.b[1] + d[1] * e]);
      if (reg.flex && pieces.length < 2) flag(r, {id:b.id, title:"Bend " + b.name, detail:"Bend line ends inside flex region " + reg.name + "; extend it across the region so it can fold", at:b.a});
      // Distance from the bend zone to rigid regions.
      if (reg.flex && r.transition > 0) {
        let worst = Infinity, at = null;
        for (const g of rigid) {
          if (!meet(G.box(b.zone), g.box, r.transition)) continue;
          const gap = polyGap(b.zone, g.points);
          if (gap < worst) {worst = gap; at = g;}
        }
        if (at && worst < r.transition - EPS) flag(r, {id:b.id, title:"Bend " + b.name + " near " + at.name, what:"Bend zone to rigid region", actual:Math.max(0, worst), required:r.transition, limit:"min", at:b.a});
      }
      // Stiffeners clear of the bend zone.
      for (const g of R.regions) {
        if (!g.stiffeners.length || !meet(G.box(b.zone), g.box, r.stiffenerGap)) continue;
        const gap = polyGap(b.zone, g.points);
        if (gap < r.stiffenerGap - EPS && (gap > 0 || G.areaOverlap(b.zone, g.points))) {flag(r, {id:b.id, title:"Bend " + b.name + " near stiffener of " + g.name, what:"Bend zone to stiffener", actual:Math.max(0, gap), required:r.stiffenerGap, limit:"min", at:b.a}); break;}
      }
    }
    // Overlapping bend zones.
    for (let i = 0; i < R.bends.length; i++) for (let j = i + 1; j < R.bends.length; j++) {
      const p = R.bends[i], q = R.bends[j];
      if (p.width > 0 && q.width > 0 && G.convexOverlap(p.zone, q.zone) && G.areaOverlap(p.zone, q.zone)) flag(r, {id:q.id, title:"Bends " + p.name + " and " + q.name, detail:"Bend zones overlap; separate the bend lines so each zone folds on its own", at:q.a});
    }
    // Coverlay webs between pad openings.
    if (r.minWeb > 0) {
      const lands = anchors(doc, defs).filter(a => !a.via && a.size > 0);
      for (const side of ["Top", "Bottom"]) {
        const li = side === "Top" ? 0 : 127, regs = R.regions.filter(g => g.flex && g.coverlay[side]);
        if (!regs.length) continue;
        const open = [];
        for (const a of lands) {
          if (li < a.span[0] || li > a.span[1]) continue;
          const g = regs.find(g => G.inside(a.at, g.points));
          if (g) {const poly = land(a, r.coverlayExpansion); open.push({a, g, poly, box:G.box(poly)});}
        }
        let count = 0;
        for (let i = 0; i < open.length && count < 500; i++) for (let j = i + 1; j < open.length; j++) {
          const p = open[i], q = open[j];
          if (!meet(p.box, q.box, r.minWeb)) continue;
          const gap = polyGap(p.poly, q.poly);
          if (gap > EPS && gap < r.minWeb - EPS) {
            count++;
            flag(r, {id:p.a.owner, title:"Coverlay web " + p.a.label + " – " + q.a.label + " (" + side + ")", detail:"Warning: " + gap.toFixed(3) + " mm of coverlay between the openings in " + p.g.name + " (minimum " + r.minWeb + " mm); space the pads or gang the openings",
              at:[(p.a.at[0] + q.a.at[0]) / 2, (p.a.at[1] + q.a.at[1]) / 2], severity:"warning", warning:true});
          }
        }
        if (count >= 500) notes.push("Coverlay web check stopped after 500 findings.");
      }
    }
  }

  // Called by AtriumRules.drc with {geo, active(type), first(type, o), flag(rule, v), notes}.
  function drc(doc, defs, api) {
    let R;
    try {R = RF().regionsResolved(doc, defs);} catch (e) {api.notes.push("Flex checks skipped: " + e.message); return;}
    if (!R.split) return;
    if (api.active("flexRouting")) routing(doc, defs, R, api);
    if (api.active("flexBuild")) build(doc, defs, R, api);
  }
  return Object.freeze({drc, anchors});
})();
