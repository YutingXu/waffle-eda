"use strict";

// Impedance plan (docs/design/impedance-directives.md, sections 6 and 10). For one impedance spec,
// the solution on each targeted copper layer (and each rigid-flex substack) of a board's stack-up:
// structure, references, width, gap and Z, whether the target is reachable within the fab limits,
// and, where it is not, ranked one-step fixes with their numbers. Pure and read-only: plan()
// reads a stack (AtriumStackup.get) and changes nothing; the suggestion list is computed only
// for layers that need it. MCP impedance_plan calls headless().
//
//   AtriumImpedancePlan.plan(stack, spec, opts) -> {spec, reachable, limits, layers:[row]}
//     spec  {target, kind:"se"|"diff", structure:"auto"|"cpw", tolerance (%), window (%),
//            layers: null (every signal layer) | ["outer"|"inner"|KEY|layer name ...],
//            overrides: [{layers, target?, structure?, tolerance?}], (per-layer targets: "inner 85")
//            zones: {SUBSTACK id | name | "flex" | "rigid": {target?, structure?, tolerance?}},
//            profile: an existing profile id or name (its stored rows and policy instead)}
//     opts  {limits:{track, space} (mm, AtriumStackup.fabLimits), clearance (mm), suggestions:false}
//     row   {key, name, stack, stackName, kind, structure, target, tolerance, window, reachable,
//            reason, error, width, gap, ground, z, reference:[above, below], model, minWidth,
//            maxWidth, warnMinWidth, warnMaxWidth, step, suggestions:[{rank, kind, text, ...}]}
//   suggestion kinds, in rank order (one undoable action each; nothing is applied here):
//     width       replace an out-of-tolerance fixed width                 {width, gap?}
//     avoidLayer  keep the signal off this layer (first when another targeted layer is reachable)
//     gap         change the pair gap at the fab minimum width            {gap, width}
//     coplanar    coplanar ground                                         {ground, width, structure}
//     reference   another reference plane; the copper between is voided   {reference, void, width}
//     dielectric  thicker or thinner dielectric to the reference          {layers:[{name, from, to}], h}
//     target      the nearest reachable target (offered, never preselected) {target, preselect:false}
globalThis.AtriumImpedancePlan = (() => {
  const S = () => globalThis.AtriumStackup || fail("The layer stack (stackup.js) is not loaded.");
  const I = () => globalThis.AtriumImpedance || fail("The impedance solver (impedance.js) is not loaded.");
  function fail(m) { throw Error(m); }
  const isCopper = l => !!l && (l.type === "Signal" || l.type === "Plane");
  const r4 = v => Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null;
  const r1 = v => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const MAX_W = 10, MAX_GAP = 5, KINDS = ["se", "diff"], STRUCTURES = ["auto", "cpw"];
  const GROUP = new Set(["outer", "inner", "all"]); // scope words that pick signal layers only (a plane is named to be targeted)
  const RANK = ["avoidLayer", "gap", "coplanar", "reference", "dielectric", "target"];

  // ---- spec ----
  // A clean copy of a spec, or a readable Error.
  function cleanSpec(raw) {
    if (!plain(raw)) fail("The impedance spec must be an object {target, kind, ...}.");
    const num = (v, lo, hi, what) => { if (v == null) return null; const x = Number(v); if (!(Number.isFinite(x) && x >= lo && x <= hi)) fail(what + " must be from " + lo + " to " + hi + "."); return x; };
    const spec = {target: num(raw.target, 1, 1000, "target"), kind: raw.kind == null ? "se" : raw.kind, structure: raw.structure == null ? "auto" : raw.structure,
      tolerance: num(raw.tolerance, 0, 100, "tolerance") ?? 10, window: num(raw.window, 0, 100, "window"), layers: null, overrides: [], zones: null, profile: null};
    if (raw.kind === "d" || raw.kind === "differential") spec.kind = "diff";
    if (raw.kind === "single" || raw.kind === "single-ended") spec.kind = "se";
    if (!KINDS.includes(spec.kind)) fail("kind must be se or diff.");
    if (!STRUCTURES.includes(spec.structure)) fail("structure must be auto or cpw.");
    const scopes = v => v == null ? null : Array.isArray(v) && v.length && v.every(x => typeof x === "string" && x.trim()) ? v.map(x => x.trim()) : fail("layers must be a list of names.");
    spec.layers = scopes(raw.layers);
    if (raw.overrides != null) {
      if (!Array.isArray(raw.overrides)) fail("overrides must be a list.");
      spec.overrides = raw.overrides.map(o => {
        if (!plain(o)) fail("Each override needs layers and a target or structure.");
        const out = {layers: scopes(o.layers) || fail("Each override needs layers.")};
        if (o.target != null) out.target = num(o.target, 1, 1000, "override target");
        if (o.tolerance != null) out.tolerance = num(o.tolerance, 0, 100, "override tolerance");
        if (o.structure != null) { if (!STRUCTURES.includes(o.structure)) fail("override structure must be auto or cpw."); out.structure = o.structure; }
        return out;
      });
    }
    if (raw.zones != null) {
      if (!plain(raw.zones)) fail("zones must map a substack to an override.");
      spec.zones = {};
      for (const [k, o] of Object.entries(raw.zones)) {
        if (!plain(o)) fail("Each zone needs a target or structure.");
        const z = {};
        if (o.target != null) z.target = num(o.target, 1, 1000, "zone target");
        if (o.tolerance != null) z.tolerance = num(o.tolerance, 0, 100, "zone tolerance");
        if (o.structure != null) { if (!STRUCTURES.includes(o.structure)) fail("zone structure must be auto or cpw."); z.structure = o.structure; }
        spec.zones[k] = z;
      }
    }
    if (typeof raw.profile === "string" && raw.profile.trim()) spec.profile = raw.profile.trim();
    if (spec.target == null && !spec.profile) fail("Give a target impedance or a profile.");
    return spec;
  }
  const profileType = (kind, structure) => structure === "cpw" ? (kind === "diff" ? "cpw-diff" : "cpw") : kind === "diff" ? "diff" : "single";
  // Does a scope word name this copper layer? outer, inner, a key or a layer name (any case).
  function inScope(word, layer, i, n) {
    const w = word.toLowerCase();
    if (w === "outer") return i === 0 || i === n - 1;
    if (w === "inner") return i > 0 && i < n - 1;
    if (w === "all") return true;
    return (layer.key || "").toLowerCase() === w || (layer.name || "").toLowerCase() === w || "l" + (i + 1) === w;
  }

  // ---- geometry helpers ----
  function geomOf(g, entry, type, L, hRef) {
    const geom = {structure: g.structure, t: g.t, er: g.er, tanD: g.tanD, h: g.h, h1: g.h1, h2: g.h2, cover: g.cover, etch: entry?.etch || 0};
    const dflt = Math.max(L.space, L.clearance || 0, hRef);
    if (type.includes("diff")) geom.s = entry?.gap > 0 ? entry.gap : dflt;
    if (type.startsWith("cpw")) geom.g = entry?.ground > 0 ? entry.ground : dflt;
    return geom;
  }
  const zOf = (geom, extra) => { const r = I().solve({...geom, ...extra}); return r.ok ? r.z : NaN; };
  // Width for the target within [track, MAX_W], or null.
  function widthFor(geom, target, L) { const r = I().synthesize(geom, {target, min: L.track, max: MAX_W}); return r.ok ? r.w : null; }

  // ---- suggestions for one row ----
  function suggest(stack, sub, row, ctx) {
    const out = [], Im = I(), {L, target, type} = ctx, key = row.key, layers = sub.layers;
    const cu = layers.map((l, i) => isCopper(l) ? i : -1).filter(i => i >= 0), at = cu.find(i => layers[i].key === key);
    const nameOf = k => layers.find(l => l.key === k)?.name || k;
    const g = row.geometryRaw, entry = ctx.entry;
    const hRef = g && g.structure !== "none" ? (g.structure === "stripline" ? Math.min(g.h1, g.h2) : g.h) : 0;
    const geom = g && g.structure !== "none" ? geomOf(g, entry, type, L, hRef) : null;
    const diff = type.includes("diff"), cop = type.startsWith("cpw");
    // Too high (needs a narrower track than the fab allows) or too low (wider than MAX_W)?
    const high = geom ? zOf(geom, {w: L.track}) < target : true;
    const w0 = high ? L.track : MAX_W;
    // Keep off the layer: always possible; first when another targeted layer reaches the target.
    out.push({kind: "avoidLayer", layer: key, text: "Don't route this signal on " + nameOf(key) + " (" + key + "): a Routing Layers rule for it.", others: ctx.reachableLayers.filter(k => k !== key)});
    if (geom && diff) {
      const r = Im.synthesize({...geom, w: w0}, {target, vary: "s", min: L.space, max: MAX_GAP});
      if (r.ok) out.push({kind: "gap", gap: r4(r.s), width: r4(w0), text: "Change the gap to " + r4(r.s) + " mm at width " + r4(w0) + " mm" + (r.s > 2 * w0 ? " (loosely coupled)" : "") + "."});
    }
    if (geom && !cop) {
      // Coplanar ground lowers Z: it helps a target below what the widest track gives.
      const cg = {...geom, g: Math.max(L.space, hRef)}, w = widthFor(cg, target, L);
      let gr = null;
      if (w != null) gr = cg.g;
      else { const r = Im.synthesize({...geom, w: high ? L.track : MAX_W}, {target, vary: "g", min: L.space, max: MAX_GAP}); if (r.ok) gr = r.g; }
      if (gr != null) {
        const wf = w ?? (high ? L.track : MAX_W);
        out.push({kind: "coplanar", structure: diff ? "cpw-diff" : "cpw", ground: r4(gr), width: r4(wf), text: "Use coplanar ground, g = " + r4(gr) + " mm (width " + r4(wf) + " mm)."});
      }
    }
    // Another reference: a farther plane on either side (the copper between is voided under the
    // route), or one side only for a stripline.
    {
      const idx = cu.indexOf(at), above = cu.slice(0, idx).reverse().map(i => layers[i].key), below = cu.slice(idx + 1).map(i => layers[i].key);
      const cur = g ? [g.refTop ?? null, g.refBottom ?? null] : [null, null];
      const tries = [];
      for (const b of below) if (b !== cur[1]) tries.push([cur[0], b], [null, b]);
      for (const a of above) if (a !== cur[0]) tries.push([a, cur[1]], [a, null]);
      if (cur[0] && cur[1]) tries.unshift([cur[0], null], [null, cur[1]]);
      const seen = new Set();
      for (const refs of tries) {
        const id = refs.join("|");
        if (seen.has(id) || (refs[0] === cur[0] && refs[1] === cur[1]) || (!refs[0] && !refs[1])) continue;
        seen.add(id);
        const g2 = Im.geometry(layers, key, refs);
        if (!g2 || g2.structure === "none") continue;
        const h2 = g2.structure === "stripline" ? Math.min(g2.h1, g2.h2) : g2.h, geo = geomOf(g2, entry, type, L, h2), w = widthFor(geo, target, L);
        if (w == null) continue;
        const keys = cu.map(i => layers[i].key), lo = refs[0] ? keys.indexOf(refs[0]) : idx, hi = refs[1] ? keys.indexOf(refs[1]) : idx;
        const voids = keys.filter((k, i) => i !== idx && i > lo && i < hi);
        const names = refs.filter(Boolean).map(nameOf).join(" and ");
        out.push({kind: "reference", reference: refs, void: voids, width: r4(w), gap: geo.s != null ? r4(geo.s) : null,
          text: "Reference " + names + (voids.length ? " (void " + voids.map(nameOf).join(", ") + " under the route; pour it out)" : "") + ": width " + r4(w) + " mm."});
        break;
      }
    }
    // Dielectric thickness to the nearer reference, at the fab minimum width (or the widest track).
    if (geom) {
      const side = geom.structure === "stripline" ? (geom.h1 <= geom.h2 ? "h1" : "h2") : "h", from = geom[side];
      const r = Im.synthesize({...geom, w: w0}, {target, vary: side, min: Math.max(0.01, from / 20), max: from * 20});
      if (r.ok) {
        const ref = side === "h1" || side === "h" && g.facing === "down" ? g.refTop : g.refBottom;
        const i0 = layers.findIndex(l => l.key === key), i1 = layers.findIndex(l => l.key === ref), [a, b] = i0 < i1 ? [i0, i1] : [i1, i0];
        const ins = layers.slice(a + 1, b).filter(l => !isCopper(l) && l.thickness > 0 && (l.type === "Dielectric" || l.type === "Adhesive"));
        const cuBetween = layers.slice(a + 1, b).filter(isCopper).reduce((s, l) => s + l.thickness, 0), insH = from - cuBetween;
        const k = insH > 0 ? (r[side] - cuBetween) / insH : 1;
        const rows = ins.map(l => ({name: l.name, from: r4(l.thickness), to: r4(l.thickness * k)}));
        if (rows.length && rows.every(x => x.to > 0)) out.push({kind: "dielectric", h: {from: r4(from), to: r4(r[side])}, width: r4(w0), layers: rows,
          text: (k > 1 ? "Thicken " : "Thin ") + rows.map(x => x.name + " " + x.from + " → " + x.to + " mm").join(", ") + " (" + nameOf(key) + " to " + nameOf(ref) + "; every signal on that layer moves)."});
      }
    }
    // The nearest reachable target, rounded inward (never preselected).
    if (geom) {
      let z = high ? zOf(geom, {w: L.track, ...(diff ? {s: Math.max(geom.s, 5 * hRef)} : null)}) : zOf(geom, {w: MAX_W});
      if (Number.isFinite(z)) {
        const t = high ? Math.floor(z) : Math.ceil(z);
        out.push({kind: "target", target: t, preselect: false, text: "Change the target to " + t + " Ω, the nearest " + nameOf(key) + " reaches."});
      }
    }
    // Rank: the documented order; keeping off the layer drops to just before the target change
    // when no other targeted layer reaches the target.
    const weight = x => x.kind === "avoidLayer" && !x.others.length ? 4.5 : RANK.indexOf(x.kind);
    return out.sort((a, b) => weight(a) - weight(b)).map((x, i) => ({rank: i + 1, ...x}));
  }

  // ---- plan ----
  function plan(stack, rawSpec, opts = {}) {
    const ST = S(), spec = cleanSpec(rawSpec);
    const L = (() => { const x = opts.limits || {}; return {track: +x.track > 0 ? +x.track : ST.DEFAULT_FAB.track, space: +x.space > 0 ? +x.space : ST.DEFAULT_FAB.space,
      clearance: +opts.clearance > 0 ? +opts.clearance : 0, source: x.source || (opts.limits ? "given" : "default")}; })();
    const master = stack.layers.filter(isCopper), n = master.length;
    let bound = null;
    if (spec.profile) {
      bound = (stack.impedanceProfiles || []).find(p => p.id === spec.profile || p.name === spec.profile);
      if (!bound) fail("No impedance profile " + spec.profile + " in the stack-up.");
    }
    const kind = bound ? (bound.type.includes("diff") ? "diff" : "se") : spec.kind;
    const keys = bound ? master.filter(l => bound.layers[l.key] && bound.layers[l.key].enabled !== false).map(l => l.key)
      : master.filter((l, i) => spec.layers ? spec.layers.some(w => inScope(w, l, i, n) && (l.type === "Signal" || !GROUP.has(w.toLowerCase()))) : l.type === "Signal").map(l => l.key);
    const subs = ST.substacks(stack);
    const rows = [], todo = [];
    for (const key of keys) {
      const i = master.findIndex(l => l.key === key), layer = master[i];
      let target = bound ? bound.target : spec.target, structure = bound ? (bound.type.startsWith("cpw") ? "cpw" : "auto") : spec.structure, tolerance = bound ? bound.tolerance : spec.tolerance;
      if (!bound) for (const o of spec.overrides) if (o.layers.some(w => inScope(w, layer, i, n))) { if (o.target != null) target = o.target; if (o.structure) structure = o.structure; if (o.tolerance != null) tolerance = o.tolerance; }
      for (const sub of subs) {
        if (!sub.layers.some(l => l.key === key)) continue;
        let t = target, st = structure, tol = tolerance;
        const z = spec.zones && (spec.zones[sub.id] || spec.zones[sub.name] || (sub.flex ? spec.zones.flex : spec.zones.rigid));
        if (z) { if (z.target != null) t = z.target; if (z.structure) st = z.structure; if (z.tolerance != null) tol = z.tolerance; }
        const type = profileType(kind, st), entry = bound ? bound.layers[key] : {enabled: true};
        const profile = bound && t === bound.target && st === (bound.type.startsWith("cpw") ? "cpw" : "auto") && tol === bound.tolerance ? bound
          : {id: "plan", name: "plan", type, target: t, tolerance: tol, ...(bound ? {} : spec.window != null ? {window: spec.window} : {}), policy: bound?.policy || "fab", layers: {[key]: entry}, ...(bound?.stack ? {stack: bound.stack} : {})};
        const v = ST.resolveProfileLayer(stack, profile, key, sub.id, {limits: L, clearance: L.clearance});
        const g = v?.geometry || null;
        const row = {key, name: layer.name, stack: sub.id, stackName: sub.name, kind, structure: type.startsWith("cpw") ? "cpw" : (g?.structure || "none"), target: t, tolerance: tol,
          reference: g && g.structure !== "none" ? [g.refTop ?? null, g.refBottom ?? null] : [null, null], reachable: !!(v && !v.error && v.within)};
        if (!v) { row.reachable = false; row.reason = "untargeted"; row.error = "The profile has no row for this layer."; }
        else if (v.error) { row.reason = v.unreachable ? v.reason : g ? "solve" : "reference"; row.error = v.error; if (v.need != null) row.need = v.need; }
        else Object.assign(row, {width: v.width, gap: v.gap, ground: v.ground, z: r1(v.z), model: v.result.model, minWidth: v.minWidth, maxWidth: v.maxWidth,
          warnMinWidth: v.warnMinWidth, warnMaxWidth: v.warnMaxWidth, window: v.window, step: v.step, delay: r4(v.result.delay), within: v.within,
          ...(v.gap != null ? {minGap: v.minGap, maxGap: v.maxGap, warnMinGap: v.warnMinGap, warnMaxGap: v.warnMaxGap} : null)});
        rows.push(row);
        if (v && !v.error && !v.within) {
          row.reason = "fixedWidth";
          row.warning = v.warning;
          if (opts.suggestions !== false) {
            const {width, ...auto} = entry;
            const adjusted = {...profile, layers: {...profile.layers, [key]: auto}};
            const w = ST.resolveProfileLayer(stack, adjusted, key, sub.id, {limits: L, clearance: L.clearance});
            if (w && !w.error) {
              const gap = w.gap != null && w.gap !== v.gap ? w.gap : null;
              const z = zOf(w.geom, {w: w.width, ...(gap != null ? {s: gap} : null)});
              // The dimensions in the advice must hit tolerance after rounding.
              if (Math.abs(z - t) <= t * tol / 100 * (1 + 1e-9) + 1e-9)
                row.suggestions = [{kind: "width", rank: 1, width: w.width, ...(gap != null ? {gap} : null),
                  text: "Set the profile width on " + layer.name + " to " + w.width + " mm" + (gap != null ? " with a " + gap + " mm gap." : ".")}];
            }
            if (!row.suggestions) todo.push({row, sub, ctx: {L, target: t, type, entry, bound: !!bound}});
          }
        } else if (!row.reachable) todo.push({row, sub, ctx: {L, target: t, type, entry, bound: !!bound}});
        row.geometryRaw = g || (() => { try { return I().geometry(sub.layers, key, entry?.reference || undefined); } catch { return null; } })();
      }
    }
    const reachableLayers = [...new Set(rows.filter(r => r.reachable).map(r => r.key))];
    if (opts.suggestions !== false) for (const t of todo) t.row.suggestions = suggest(stack, t.sub, t.row, {...t.ctx, reachableLayers});
    for (const r of rows) delete r.geometryRaw;
    return {spec, kind, profile: bound ? bound.id : null, limits: L, reachable: rows.length > 0 && rows.every(r => r.reachable), layers: rows,
      summary: rows.length ? rows.filter(r => r.reachable).length + " of " + rows.length + " layer rows reach " + (bound ? bound.target : spec.target) + " Ω" : "No targeted layers."};
  }

  // ---- MCP impedance_plan (read-only) ----
  // a = {document_id, spec | profile, clearance}; env = {project, board, defsOf}.
  function headless(a = {}, env = {}) {
    const p = env.project(), doc = env.board(p, a.document_id), ST = S();
    const spec = a.spec ? {...a.spec, ...(a.profile ? {profile: a.profile} : null)} : a.profile ? {profile: a.profile} : fail("impedance_plan needs a spec or a profile.");
    const stack = ST.get(doc, env.defsOf(p));
    const out = plan(stack, spec, {limits: ST.fabLimits(doc), clearance: a.clearance});
    return {document_id: doc.id, read_only: true, units: {length: "mm", z: "ohm", delay: "ps/mm"}, derived_stack: !!stack.derived, ...out};
  }

  return Object.freeze({plan, cleanSpec, headless});
})();
