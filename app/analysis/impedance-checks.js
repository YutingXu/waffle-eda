"use strict";

// Impedance checks (docs/design/impedance-directives.md, section 7): standalone, pure check functions
// over plain inputs, so a unified check registry can run them as they are; drc() is the thin
// adapter that runs them in today's DRC (rules.js calls it for Width and Differential Pairs Routing
// rules that name an impedance profile).
//
// Every check is check(inputs, opts) -> violations[]. Shared inputs:
//   tracks   [{id, net, layer, width, points:[[x,y]...], profile?}]  copper of profiled signals
//   values   track -> profile values on its layer (AtriumStackup.profileValues: width, minWidth,
//            maxWidth, warnMinWidth, warnMaxWidth, geometry {refTop, refBottom, h | h1, h2, ...}),
//            null where the profile has no row for the layer
// A violation: {check, severity:"error"|"warning", id, net, layer, at:[x,y], message, ...numbers}.
//
//   windowCheck({tracks, values}, {skip})            width inside the spec tolerance (DRC flags
//                                                    outside it) but outside the design window
//   neckCheck({tracks, ends, values, budget})        segments narrower than the window, connected
//                                                    to a pad, against the neck-down budget per end
//   referenceCheck({tracks, values, copperAt, holes}, {step, minLength})
//                                                    no copper on the reference layer under the
//                                                    track over w + 2 * 3h
//   referenceChangeCheck({vias, tracks, values, refNet, stitches, caps}, {distance, capDistance})
//                                                    the nearest reference changes layer at a via
//                                                    with no stitching via (same net) or capacitor
//                                                    (different nets) within d (default 3h)
//   untargetedLayerCheck({tracks, values})           a profiled signal on a layer the profile has
//                                                    no row for
globalThis.AtriumImpedanceChecks = (() => {
  const EPS = 1e-6, NECK_DEFAULT = 2.5;
  const r3 = v => Math.round(v * 1000) / 1000 + 0;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const ok = v => !!v && !v.error && v.width > 0;
  const segsOf = t => { const out = []; for (let i = 1; i < (t.points || []).length; i++) if (dist(t.points[i - 1], t.points[i]) > EPS) out.push([t.points[i - 1], t.points[i]]); return out; };
  const lengthOf = t => segsOf(t).reduce((s, [a, b]) => s + dist(a, b), 0);
  // Dielectric height from the track to a reference layer (geometry of resolveProfileLayer).
  function heightTo(g, ref) {
    if (!g) return 0;
    if (g.structure === "stripline") return ref === g.refTop ? g.h1 : g.h2;
    return g.h || 0;
  }
  const refsOf = v => ok(v) && v.geometry ? [v.geometry.refTop, v.geometry.refBottom].filter(Boolean) : [];
  // The nearest reference of a layer and its height.
  function nearest(v) {
    const g = v?.geometry;
    if (!ok(v) || !g) return null;
    if (g.structure === "stripline") return g.h1 <= g.h2 ? {layer: g.refTop, h: g.h1} : {layer: g.refBottom, h: g.h2};
    const layer = g.refBottom || g.refTop;
    return layer ? {layer, h: g.h} : null;
  }

  // ---- window: flagged outside the tolerance by the DRC, warned outside the window here ----
  function windowCheck({tracks, values}, {skip} = {}) {
    const out = [];
    for (const t of tracks) {
      if (skip?.has(t.id)) continue;
      const v = values(t);
      if (!ok(v) || !(v.warnMinWidth > 0) || !(t.width > 0)) continue;
      const flagged = t.width + EPS < v.minWidth || t.width - EPS > v.maxWidth;
      if (flagged) continue; // the Width / pair width check reports it
      const low = t.width + EPS < v.warnMinWidth, high = t.width - EPS > v.warnMaxWidth;
      if (!low && !high) continue;
      out.push({check: "impedanceWindow", severity: "warning", id: t.id, net: t.net, layer: t.layer, at: t.points?.length > 1 ? mid(t.points[0], t.points[1]) : t.points?.[0],
        actual: t.width, required: low ? v.warnMinWidth : v.warnMaxWidth, limit: low ? "min" : "max", window: v.window, tolerance: v.tolerance,
        message: "Width " + r3(t.width) + " mm is inside ±" + v.tolerance + " % but outside the ±" + v.window + " % design window (" + r3(v.warnMinWidth) + "–" + r3(v.warnMaxWidth) + " mm)."});
    }
    return out;
  }

  // ---- neck-down budget per signal end ----
  // ends: [{id, net, at, r, layer?}] pads (r: the pad's reach; a track end within r touches it).
  // budget(end) -> mm (default 2.5). A neck is a run of segments narrower than the window minimum
  // that starts at the pad; its total length per end must stay within the budget.
  // Returns violations; neckCheck.necks(...) also gives the ids of tracks counted as necks.
  function walkNecks({tracks, ends, values}) {
    const byNet = new Map();
    for (const t of tracks) {
      const v = values(t), floor = ok(v) ? (v.warnMinWidth > 0 ? v.warnMinWidth : v.minWidth) : null;
      if (!(floor > 0) || !(t.width > 0)) continue;
      const narrow = t.width + EPS < floor;
      for (const [a, b] of segsOf(t)) {
        let list = byNet.get(t.net);
        if (!list) byNet.set(t.net, list = []);
        list.push({t, a, b, len: dist(a, b), narrow, layer: t.layer});
      }
    }
    const runs = [];
    const key = p => Math.round(p[0] * 1e3) + "," + Math.round(p[1] * 1e3);
    for (const e of ends) {
      const list = byNet.get(e.net);
      if (!list) continue;
      const nodes = new Map();
      for (const s of list) for (const p of [s.a, s.b]) { const k = key(p); if (!nodes.has(k)) nodes.set(k, []); nodes.get(k).push(s); }
      const seen = new Set(), ids = new Set();
      let length = 0;
      const stack = list.filter(s => s.narrow && (e.layer == null || e.layer === "Multi" || s.layer === e.layer) && Math.min(dist(s.a, e.at), dist(s.b, e.at)) <= (e.r || 0) + s.t.width / 2 + EPS);
      while (stack.length) {
        const s = stack.pop();
        if (seen.has(s)) continue;
        seen.add(s); length += s.len; ids.add(s.t.id);
        for (const p of [s.a, s.b]) for (const n of nodes.get(key(p)) || []) if (n.narrow && !seen.has(n) && n.layer === s.layer) stack.push(n);
      }
      if (seen.size) runs.push({end: e, length, ids, at: [...seen][0].a});
    }
    return runs;
  }
  function neckCheck(inputs) {
    const out = [];
    for (const run of walkNecks(inputs)) {
      const budget = inputs.budget ? inputs.budget(run.end) : NECK_DEFAULT;
      if (!(run.length > budget + EPS)) continue;
      out.push({check: "neckBudget", severity: "error", id: [...run.ids][0], ids: [...run.ids], end: run.end.id, net: run.end.net, at: run.end.at,
        actual: r3(run.length), required: budget, limit: "max",
        message: "Neck-down at " + (run.end.label || run.end.id) + ": " + r3(run.length) + " mm narrower than the window, budget " + budget + " mm per end."});
    }
    return out;
  }
  neckCheck.necks = inputs => { const ids = new Set(); for (const run of walkNecks(inputs)) { const b = inputs.budget ? inputs.budget(run.end) : NECK_DEFAULT; if (run.length <= b + EPS) for (const id of run.ids) ids.add(id); } return ids; };

  // ---- missing reference under a track ----
  // Parameter boundaries along a segment inside the signal's expected antipad.
  function holeCuts(a, dx, dy, lengthSquared, hole, radius, cuts) {
    const ox = hole.at[0] - a[0], oy = hole.at[1] - a[1];
    const t = (ox * dx + oy * dy) / lengthSquared;
    const d2 = (ox - t * dx) ** 2 + (oy - t * dy) ** 2;
    const span2 = (radius * radius - d2) / lengthSquared;
    if (span2 <= 0) return;
    const span = Math.sqrt(span2);
    const entry = t - span, exit = t + span;
    if (entry > EPS && entry < 1 - EPS) cuts.push(entry);
    if (exit > EPS && exit < 1 - EPS) cuts.push(exit);
  }
  // copperAt(layer, x, y) -> true where the layer has copper; holes: [{net, at, r}] (the signal's own
  // vias: their antipads are expected voids). Use indexed copper edges when provided, otherwise
  // sample every `step` mm. Check the centre and +/- (w/2 + 3h); ignore runs below minLength.
  function referenceCheck({tracks, values, copperAt, copperCuts, holes = []}, {step = 0.25, minLength = 0.2} = {}) {
    const out = [];
    if (!copperAt) return out;
    const holesByNet = new Map();
    for (const hole of holes) {
      if (!holesByNet.has(hole.net)) holesByNet.set(hole.net, []);
      holesByNet.get(hole.net).push(hole);
    }
    const cuts = [], noHoles = [];
    for (const t of tracks) {
      const v = values(t), ownHoles = holesByNet.get(t.net) || noHoles;
      for (const ref of refsOf(v)) {
        const h = heightTo(v.geometry, ref), off = t.width / 2 + 3 * h;
        let run = 0, total = 0, first = null, worst = 0, start = null;
        const close = () => { if (run >= minLength - EPS) { total += run; worst = Math.max(worst, run); first ||= start; } run = 0; start = null; };
        for (const [a, b] of segsOf(t)) {
          const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
          const nx = -dy * off / L, ny = dx * off / L;
          if (copperCuts) {
            cuts.length = 0;
            copperCuts(ref, a[0], a[1], b[0], b[1], cuts);
            copperCuts(ref, a[0] + nx, a[1] + ny, b[0] + nx, b[1] + ny, cuts);
            copperCuts(ref, a[0] - nx, a[1] - ny, b[0] - nx, b[1] - ny, cuts);
            for (const o of ownHoles) holeCuts(a, dx, dy, L * L, o, o.r + 3 * h, cuts);
            if (cuts.length > 1) cuts.sort((x, y) => x - y);
            cuts.push(1);
          }
          const n = copperCuts ? cuts.length : Math.max(1, Math.ceil(L / step));
          for (let i = 0, t0 = 0; i < n; i++) {
            const t1 = copperCuts ? cuts[i] : (i + 1) / n, lo = t0;
            t0 = t1;
            if (t1 - lo <= EPS) continue;
            const tm = (lo + t1) / 2, x = a[0] + dx * tm, y = a[1] + dy * tm;
            if (ownHoles.some(o => Math.hypot(o.at[0] - x, o.at[1] - y) <= o.r + 3 * h)) { close(); continue; }
            if (copperAt(ref, x, y) && copperAt(ref, x + nx, y + ny) && copperAt(ref, x - nx, y - ny)) close();
            else {
              if (!run) {
                const first = Math.min(tm, lo + .5 / Math.max(1, Math.ceil(L / step)));
                start = [a[0] + dx * first, a[1] + dy * first];
              }
              run += L * (t1 - lo);
            }
          }
        }
        close();
        if (total > 0) out.push({check: "missingReference", severity: "error", id: t.id, net: t.net, layer: t.layer, reference: ref, at: first,
          actual: r3(total), longest: r3(worst), width: r3(2 * off),
          message: r3(total) + " mm of " + t.net + " on " + t.layer + " has no reference copper on " + ref + " across " + r3(2 * off) + " mm (w + 2·3h)."});
      }
    }
    return out;
  }

  // ---- reference change at a via ----
  // vias: [{id, net, at, r}] signal vias; tracks touching a via on two layers make a transition.
  // refNet(layer, at) -> the net of the reference copper there, or null. stitches: [{id, net, at,
  // covers(layer) -> bool}] vias of other nets; caps: [{id, at, nets:Set}]. distance: mm (default 3h
  // of the farther reference); capDistance: mm (default 5).
  function referenceChangeCheck({vias, tracks, values, refNet, stitches = [], caps = []}, {distance = null, capDistance = 5} = {}) {
    const out = [], byNet = new Map();
    for (const t of tracks) { if (!byNet.has(t.net)) byNet.set(t.net, []); byNet.get(t.net).push(t); }
    for (const via of vias) {
      const touching = (byNet.get(via.net) || []).filter(t => { const p = t.points || []; return p.length && Math.min(dist(p[0], via.at), dist(p.at(-1), via.at)) <= (via.r || 0) + t.width / 2 + EPS; });
      const layers = new Map();
      for (const t of touching) if (!layers.has(t.layer)) { const n = nearest(values(t)); if (n) layers.set(t.layer, {t, ...n}); }
      const list = [...layers.values()];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        if (A.layer === B.layer) continue;
        const na = refNet ? refNet(A.layer, via.at) : null, nb = refNet ? refNet(B.layer, via.at) : null;
        if (na == null || nb == null) continue; // no copper there: the missing-reference check reports it
        const d = distance > 0 ? distance : 3 * Math.max(A.h, B.h);
        const from = A.t.layer, to = B.t.layer;
        if (na === nb) {
          const near = stitches.filter(s => s.net === na && s.covers(A.layer) && s.covers(B.layer)).map(s => dist(s.at, via.at)).sort((x, y) => x - y)[0];
          if (near != null && near <= d + EPS) continue;
          out.push({check: "referenceChange", severity: "error", id: via.id, net: via.net, layer: from, toLayer: to, at: via.at, need: "via", referenceNet: na, references: [A.layer, B.layer],
            actual: near != null ? r3(near) : null, required: r3(d), limit: "max",
            message: via.net + " changes " + from + " → " + to + " and its reference " + A.layer + " → " + B.layer + " with no " + na + " stitching via within " + r3(d) + " mm."});
        } else {
          const near = caps.filter(c => c.nets.has(na) && c.nets.has(nb)).map(c => dist(c.at, via.at)).sort((x, y) => x - y)[0];
          if (near != null && near <= capDistance + EPS) continue;
          out.push({check: "referenceChange", severity: "error", id: via.id, net: via.net, layer: from, toLayer: to, at: via.at, need: "cap", referenceNets: [na, nb], references: [A.layer, B.layer],
            actual: near != null ? r3(near) : null, required: capDistance, limit: "max",
            message: via.net + " changes " + from + " → " + to + "; its reference changes net (" + na + " → " + nb + ") with no stitching capacitor within " + capDistance + " mm."});
        }
      }
    }
    return out;
  }

  // ---- routed on a layer the profile does not cover ----
  function untargetedLayerCheck({tracks, values}) {
    const out = [], seen = new Set();
    for (const t of tracks) {
      if (!t.profile || t.known === false || values(t) !== null) continue;
      const k = t.net + "\u0001" + t.layer;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({check: "untargetedLayer", severity: "error", id: t.id, net: t.net, layer: t.layer, profile: t.profile, at: t.points?.length > 1 ? mid(t.points[0], t.points[1]) : t.points?.[0],
        actual: r3(lengthOf(t)), message: t.net + " on " + t.layer + ": " + (t.profileName || t.profile) + " has no row for " + t.layer + "."});
    }
    return out;
  }

  // ---- adapter: today's DRC (rules.js drc) ----
  // env = {geo, R, flag, notes, sideSpan, project}: rules.js's extracted geometry and compiled
  // rules. Violations are reported under the Width or Differential Pairs Routing rule that names
  // the profile, with `what` naming the check; warnings carry severity "warning".
  const WHAT = {impedanceWindow: "Impedance window", neckBudget: "Neck-down budget", missingReference: "Missing reference", referenceChange: "Reference change", untargetedLayer: "Untargeted layer"};
  function drc(doc, defs, env) {
    const {geo, R, flag, notes} = env, S = globalThis.AtriumStackup;
    if (!S || !R || !geo) return 0;
    const named = t => (R.byType[t] || []).some(r => r.impedanceProfile);
    if (!named("width") && !named("diffPairsRouting")) return 0;
    const side = env.sideSpan || (l => l === "Top" ? [0, 0] : l === "Bottom" ? [127, 127] : [0, 127]);
    const profiles = new Map(S.impedanceProfiles(doc, defs).map(p => [p.id, p]));
    const tracks = [], ruleOf = new Map(), stackAt = p => S.stackAt(doc, p, defs) || undefined;
    for (const t of geo.tracks) {
      if (!t.net || !(t.width > 0) || t.points.length < 2) continue;
      const layer = t.item.layer || "Top", pair = R.pairOfNet?.get(t.net);
      const r = pair ? R.first("diffPairsRouting", {net: t.net, pair: pair.name, layer, span: side(layer)}) : R.first("width", t);
      if (!r?.impedanceProfile) continue;
      const p = profiles.get(r.impedanceProfile) || [...profiles.values()].find(x => x.name === r.impedanceProfile);
      const row = {id: t.id, net: t.net, layer, width: t.width, points: t.points, profile: r.impedanceProfile, profileName: p?.name, known: !!p, stack: stackAt(t.at), neck: p?.neck?.maxLength, rule: r, label: t.label};
      tracks.push(row); ruleOf.set(t.id, r);
    }
    if (!tracks.length) return 0;
    const memo = new Map();
    const values = t => {
      const k = t.profile + "\u0001" + t.layer + "\u0001" + (t.stack || "");
      if (!memo.has(k)) { let v = null; try { v = S.profileValues(doc, t.profile, t.layer, defs, t.stack); } catch { v = null; } memo.set(k, v); }
      return memo.get(k);
    };
    const profiledNets = new Set(tracks.map(t => t.net));
    const ends = geo.pads.filter(p => profiledNets.has(p.net)).map(p => ({id: p.id, net: p.net, at: p.at, r: p.radius || 0, layer: p.layer, label: p.label}));
    const byId = new Map(tracks.map(t => [t.id, t]));
    // The one neck-down length per end (rules.js neckLength: the rule's, else its profile's, else 2.5 mm).
    const NL = globalThis.AtriumRules?.neckLength;
    const budget = e => { const t = tracks.find(x => x.net === e.net && x.rule) || tracks.find(x => x.net === e.net);
      return NL && t?.rule ? NL(doc, t.rule) : t?.rule?.neckLength ?? t?.neck ?? NECK_DEFAULT; };
    const necks = neckCheck.necks({tracks, ends, values, budget});
    const found = [...untargetedLayerCheck({tracks, values}), ...neckCheck({tracks, ends, values, budget}), ...windowCheck({tracks, values}, {skip: necks})];
    // Reference copper: si.js's copper index of each layer (pours, polygons, Plane layers).
    const SI = globalThis.AtriumSI;
    if (SI?.copperIndex) {
      const stack = S.get(doc, defs), typeOf = new Map(stack.layers.filter(S.isCopper).map(l => [l.key, l.type])), idx = new Map(), local = new Set();
      const layerIdx = k => { if (!idx.has(k)) idx.set(k, SI.copperIndex(doc, defs, k, typeOf.get(k), local)); return idx.get(k); };
      const copperAt = (k, x, y) => layerIdx(k).at(x, y) >= 0, refNet = (k, p) => { const L = layerIdx(k), r = L.at(p[0], p[1]); return r >= 0 ? L.net(r) : null; };
      const keys = stack.layers.filter(S.isCopper).map(l => l.key), order = new Map(keys.map((k, i) => [k, i]));
      const spanOf = v => { const a = v.item.fromLayer, b = v.item.toLayer; if (!a && !b) return [0, keys.length - 1]; const i = order.get(a || keys[0]), j = order.get(b || keys.at(-1)); return i == null || j == null ? [0, keys.length - 1] : [Math.min(i, j), Math.max(i, j)]; };
      const allVias = geo.vias.map(v => ({id: v.id, net: v.net, at: v.at, r: (v.diameter || .6) / 2, span: spanOf(v)}));
      const vias = allVias.filter(v => profiledNets.has(v.net));
      const stitches = allVias.filter(v => !profiledNets.has(v.net)).map(v => ({...v, covers: k => { const i = order.get(k); return i != null && i >= v.span[0] && i <= v.span[1]; }}));
      const caps = [];
      for (const i of doc.items || []) if (i.kind === "part" && /^C\d/i.test(i.ref || "") && i.pinNets) caps.push({id: i.id, at: [i.x, i.y], nets: new Set(Object.values(i.pinNets).filter(Boolean))});
      const copperCuts = (k, ax, ay, bx, by, out) => layerIdx(k).cuts(ax, ay, bx, by, out);
      found.push(...referenceCheck({tracks, values, copperAt, copperCuts, holes: vias}), ...referenceChangeCheck({vias, tracks, values, refNet, stitches, caps}));
      for (const n of local) notes?.push?.(n);
    } else notes?.push?.("Reference plane checks for impedance profiles need the signal integrity module (si.js).");
    let count = 0;
    for (const v of found) {
      const t = byId.get(v.id) || tracks.find(x => x.net === v.net), r = t && ruleOf.get(t.id);
      if (!r) continue;
      const {check, severity, message, ...rest} = v;
      flag(r, {...rest, title: (t.label || t.id) + " · " + message, what: WHAT[check], detail: message, check, ...(severity === "warning" ? {severity} : null), profile: t.profile});
      count++;
    }
    return count;
  }

  return Object.freeze({windowCheck, neckCheck, referenceCheck, referenceChangeCheck, untargetedLayerCheck, drc, NECK_DEFAULT, WHAT});
})();
