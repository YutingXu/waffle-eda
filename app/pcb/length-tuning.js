"use strict";
if (!globalThis.AtriumResolvedLand && typeof require === "function") require("./pcb-appearance.js");

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// Length tuning and matched-length management.
//
//   Engine    netLength / lengths / xSignalLength: routed pad-to-pad length from the
//             copper graph of each net, with per-layer breakdown, via barrels from the
//             stackup, pin package length and an approximate propagation delay.
//             Cached results use each net's own tracks, vias and pad records so
//             edits only recompute the affected nets.
//   Patterns  tune / tunePair / tuneSkew: meanders inserted into one straight track
//             segment (trombone, accordion one- or two-sided, sawtooth; mitered, arc,
//             rounded or square corners) that reach a target length, keep their legs a
//             gap apart and are capped wherever a clearance callback reports an obstacle.
//   Session   begin(...).move/key/set/commit for interactive tuning, with gauge data.
//   Manager   open(ctx): matched-length groups, targets, auto-tune and CSV export.
//
// The model is millimetres. Edit plans are {add, remove, modify:[{id, set:{points}}]}.
// Board data lives in board.lengthTuning = {version:1, groups:[], targets:{}}; xSignals are the signal model's
// (signals.js xsView).
globalThis.AtriumLength = (() => {
  const C0 = 0.299792458; // speed of light, mm per ps
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const DEFAULT_DK = 4.2, DEFAULT_THICKNESS = 1.6, DEFAULT_H = 0.2;

  // ------------------------------------------------------------------ geometry
  const {orientAt: orient, pointSegmentDistanceSquared: segPoint2, segmentDistanceSquared} = globalThis.AtriumGeometry;
  function polyLength(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return s;
  }
  const round6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const {index: layerIndex} = globalThis.AtriumPCBAppearance;
  const layerName = i => i === 0 ? "Top" : i === 127 ? "Bottom" : "Inner " + i;
  const defOf = (defs, id) => defs?.get ? defs.get(id) : defs?.[id];
  function spanOf(layer) {
    if (layer === "Multi") return [0, 127];
    const n = layerIndex(layer); return n < 0 ? null : [n, n];
  }
  function copperLookup(board, defs) {
    let layers;
    return () => layers ??= globalThis.AtriumStackup?.copperLayers(board, defs) || ["Top", "Bottom"];
  }
  function padRecord(p, part, net, index, copper) {
    const PCB = AtriumPCBAppearance, layer = PCB.padLayer(part, p), span = spanOf(layer);
    if (!span) return null;
    const L = AtriumResolvedLand, nominal = L.geometry(p), {at} = L.place(p, part);
    const unplated = p.drill > 0 && p.plated === false;
    const stacked = PCB.hasPadRows(p);
    if (!nominal && !stacked && !(p.drill > 0)) return null;
    const layers = PCB.padPlanes(p, layer, copper), lands = [];
    const physical = stacked ? (layer === "Multi" ? layers : copper()) : null;
    for (const key of layers) {
      const land = key == null ? nominal : L.geometry(p, key, physical);
      if (!land || land.holeOnly || unplated) continue;
      const {at, angle, mirror} = L.place(land, part), l = layerIndex(key);
      lands.push({land, at, angle, mirror, radius: L.radius(land), lo: key == null ? span[0] : l, hi: key == null ? span[1] : l});
    }
    const num = String(p.number ?? "");
    // Package pin length (mm) and/or delay (ps), e.g. from Design › xSignals Wizard › Import pin delays.
    const pd = +(part?.pinDelays?.[num] ?? p.pinDelay ?? NaN), dieDelay = Number.isFinite(pd) ? pd : null;
    const die = +(part?.pinLengths?.[num] ?? part?.packageLengths?.[num] ?? p.packageLength ?? p.dieLength ?? (dieDelay != null ? dieDelay / (Math.sqrt(DEFAULT_DK) / C0) : 0)) || 0;
    return {id: part ? part.id : p.id, ref: part ? part.ref : "", number: num, net, x: at[0], y: at[1], lands,
      holeOnly: unplated || p.holeOnly === true || (!lands.length && nominal?.holeOnly), lo: span[0], hi: span[1], die, dieDelay, index};
  }
  function touches(placed, x, y, tol) {
    const {at, land, angle, mirror, radius} = placed;
    return Math.hypot(x - at[0], y - at[1]) <= radius + tol &&
      AtriumResolvedLand.distance(land, [x, y], at, angle, mirror) <= tol;
  }

  // ------------------------------------------------------------------ external modules (feature-detected)
  function ruleQuery(board, type, o) {
    const R = globalThis.AtriumRules; if (!R?.query) return null;
    const names = {length: ["length", "Length"], matchedLengths: ["matchedLengths", "MatchedLengths"],
      diffPairsRouting: ["diffPairsRouting", "DiffPairsRouting"], clearance: ["clearance", "Clearance"]}[type] || [type];
    for (const n of names) { try { const r = R.query(board, n, o); if (r !== undefined) return r; } catch { /* try the next spelling */ } }
    return null;
  }
  const num = (...v) => { for (const x of v) if (typeof x === "number" && Number.isFinite(x)) return x; return null; };
  function clearanceRule(board, net, other, layer) {
    const r = ruleQuery(board, "clearance", {net, net2: other, layer});
    const v = num(r?.gap, r?.clearance, r?.value, r?.min);
    return v ?? 0.2;
  }
  function lengthRule(board, net) {
    const r = ruleQuery(board, "length", {net});
    if (!r) return null;
    const min = num(r.min, r.minLength, r.minimum), max = num(r.max, r.maxLength, r.maximum);
    return min == null && max == null ? null : {min: min ?? 0, max, name: r.ruleName || r.name || "Length"};
  }
  function pairRule(board, pair, layer) {
    const r = ruleQuery(board, "diffPairsRouting", {pairName: pair, layer});
    if (!r) return null;
    return {gap: num(r.gapPreferred, r.gap, r.gapMin), width: num(r.widthPreferred, r.width, r.widthMin), maxUncoupled: num(r.maxUncoupled, r.maxUncoupledLength)};
  }
  function diffPairList(board) {
    try { const list = globalThis.AtriumRules?.diffPairs?.(board); if (Array.isArray(list) && list.length) return list; } catch { /* no rules */ }
    return [];
  }
  function netClassList(board) {
    let c = null;
    try { c = globalThis.AtriumRules?.netClasses?.(board); } catch { /* no rules */ }
    c = c || board?.netClasses || null;
    if (!c) return [];
    if (Array.isArray(c)) return c.map(x => ({name: x.name, nets: [...(x.nets || x.members || [])]}));
    return Object.entries(c).map(([name, nets]) => ({name, nets: [...(Array.isArray(nets) ? nets : nets?.nets || [])]}));
  }
  function matchedRuleGroups(board, opts) {
    try { const g = globalThis.AtriumRules?.matchedGroups?.(board, {project: opts?.project, boardNames: opts?.routingIndex?.groups.keys()}); if (Array.isArray(g)) return g; } catch { /* no rules */ }
    return [];
  }

  // net -> {gap, profile} for every member of a differential pair with a gap or impedance profile to time it by.
  function pairCoupling(board) {
    const R = globalThis.AtriumRules, out = new Map();
    if (!R?.diffPairs || !R?.query) return out;
    let pairs = []; try { pairs = R.diffPairs(board) || []; } catch { pairs = []; }
    for (const p of pairs) {
      let r = null; try { r = R.query(board, "diffPairsRouting", {net: p.positive, pair: p.name}); } catch { r = null; }
      const gap = r?.gapPreferred > 0 ? r.gapPreferred : r?.gapMin > 0 ? r.gapMin : 0;
      if (!gap && !r?.impedanceProfile) continue;
      const o = {gap, profile: r?.impedanceProfile || null};
      out.set(p.positive, o); out.set(p.negative, o);
    }
    return out;
  }
  // Stackup: copper z for via barrels and per-layer propagation factors (ps/mm).
  function stackInfo(board, defs, usedLayers, index) {
    const S = globalThis.AtriumStackup, z = new Map();
    let thickness = null, source = "default";
    try {
      const stack = S?.get?.(board, defs, index), layers = stack?.layers;
      if (Array.isArray(layers) && layers.length) {
        const copper = layers.map((l, i) => (S.isCopper ? S.isCopper(l) : l.type === "Signal" || l.type === "Plane" || l.material === "Copper") ? i : -1).filter(i => i >= 0);
        let acc = 0; const at = [];
        for (const l of layers) { at.push(acc); acc += +l.thickness || 0; }
        thickness = acc;
        copper.forEach((li, n) => {
          const key = layers[li].key ?? (n === 0 ? "Top" : n === copper.length - 1 ? "Bottom" : "Inner " + n);
          const idx = layerIndex(key); if (idx < 0) return;
          z.set(idx, at[li] + (+layers[li].thickness || 0) / 2);
        });
        if (z.size) source = "stackup";
      }
    } catch { /* fall back to a uniform stack */ }
    if (!z.size) {
      try { const t = S?.thickness?.(board, defs); if (t > 0) thickness = t; } catch { /* default */ }
      thickness = thickness || (board?.thickness > 0 ? board.thickness : DEFAULT_THICKNESS);
      const used = [...new Set([0, 127, ...(usedLayers || [])])].sort((a, b) => a - b);
      used.forEach((l, i) => z.set(l, used.length > 1 ? thickness * i / (used.length - 1) : 0));
    }
    const factors = new Map();
    // odd: {gap, profile} of a differential pair's member (its odd-mode delay), else single-ended.
    function factor(layer, width, odd) {
      const key = layer * 1e4 + Math.round(width * 1000) + (odd ? "|" + Math.round((odd.gap || 0) * 1e4) + "|" + (odd.profile || "") : "");
      let f = factors.get(key);
      if (f !== undefined) return f;
      // Closed-form field solution of the layer (microstrip under mask, offset stripline; AtriumStackup.delay,
      // which falls back to AtriumImpedance.delayFallback), else that fallback alone (no stack-up module).
      let solved = null;
      try { solved = S?.delay?.(board, layer === 0 ? "Top" : layer === 127 ? "Bottom" : "Inner " + layer, width, defs, {gap: odd?.gap, profile: odd?.profile, index}); } catch { solved = null; }
      if (!(solved > 0)) solved = globalThis.AtriumImpedance?.delayFallback({outer: layer === 0 || layer === 127, w: width, h: DEFAULT_H, er: DEFAULT_DK}).delay;
      f = solved > 0 ? solved : Math.sqrt(DEFAULT_DK) / C0; // impedance.js not loaded: its inner-layer fallback
      factors.set(key, f); return f;
    }
    const zOf = l => z.has(l) ? z.get(l) : (l / 127) * (thickness || DEFAULT_THICKNESS);
    let sig = source + ":" + thickness + "|" + (S?.signature?.(board) || "");
    for (const [k, v] of z) sig += "," + k + ":" + v.toFixed(5);
    // Differential pair members are timed in odd mode: the pair's gap and impedance profile (Differential Pairs
    // Routing rule) by net; they enter the signature, so a gap edit re-times the pair.
    const odd = pairCoupling(board);
    for (const [n, o] of odd) sig += "|" + n + ":" + o.gap + ":" + (o.profile || "");
    const out = {zOf, factor, odd, viaFactor: Math.sqrt(DEFAULT_DK) / C0, thickness, source, sig};
    return globalThis.AtriumTiming?.wrapStack?.(board, defs, out, index) || out; // via delay model (timing-vision.js)
  }

  // ------------------------------------------------------------------ board index and net cache
  const caches = new WeakMap();
  function stateOf(board) {
    let s = caches.get(board);
    if (!s) { s = {revision: undefined, defs: null, nets: null, results: new Map(), graphs: new Map(), stack: null}; caches.set(board, s); }
    return s;
  }
  // 32-bit mixing of quantised numbers. Sums of item hashes are order-independent.
  function mix(h, v) { h = Math.imul(h ^ (Math.round(v * 1e5) | 0), 0x9e3779b1); return (h ^ (h >>> 15)) | 0; }
  function bucketOf(map, net) {
    let b = map.get(net);
    if (!b) { b = {net, tracks: [], vias: [], pads: [], hash: 0, layers: 0}; map.set(net, b); }
    return b;
  }
  function samePads(pads, previous) {
    if (pads.length !== previous.length) return false;
    for (let i = 0; i < pads.length; i++) {
      const a = pads[i], b = previous[i];
      if (a.x !== b.x || a.y !== b.y || a.lo !== b.lo || a.hi !== b.hi || a.lands.length !== b.lands.length ||
          a.id !== b.id || a.ref !== b.ref || a.number !== b.number || a.die !== b.die || a.dieDelay !== b.dieDelay) return false;
      for (let j = 0; j < a.lands.length; j++) {
        const x = a.lands[j], y = b.lands[j], g = x.land, h = y.land;
        if (x.at[0] !== y.at[0] || x.at[1] !== y.at[1] || x.angle !== y.angle || x.mirror !== y.mirror || x.lo !== y.lo || x.hi !== y.hi ||
            g.w !== h.w || g.h !== h.h || g.shape !== h.shape || g.r !== h.r || g.poly !== h.poly) return false;
      }
    }
    return true;
  }
  function addGeometry(nets, defs, used, i, copper, only) {
    if (i.kind === "track") {
      if (!i.net || (only && i.net !== only) || !Array.isArray(i.points) || i.points.length < 2) return;
      const l = layerIndex(i.layer); if (l < 0) return;
      const b = bucketOf(nets, i.net); b.tracks.push(i); used.add(l);
      let h = mix(0x51ed27, l); h = mix(h, i.width || 0);
      const p = i.points; for (let k = 0; k < p.length; k++) { h = mix(h, p[k][0]); h = mix(h, p[k][1]); }
      b.hash = (b.hash + h) | 0;
    } else if (i.kind === "via") {
      if (!i.net || (only && i.net !== only)) return;
      const b = bucketOf(nets, i.net); b.vias.push(i);
      let h = mix(0x7a11, i.x); h = mix(h, i.y); h = mix(h, i.diameter || 0); h = mix(h, layerIndex(i.fromLayer) * 64 + layerIndex(i.toLayer));
      b.hash = (b.hash + h) | 0;
      for (const k of [i.fromLayer, i.toLayer]) if (layerIndex(k) >= 0) used.add(layerIndex(k));
    } else if (i.kind === "pad") {
      if (!i.net || (only && i.net !== only)) return;
      const rec = padRecord(i, null, i.net, -1, copper); if (!rec) return;
      bucketOf(nets, i.net).pads.push(rec);
    } else if (i.kind === "part" && i.pinNets) {
      const fp = defOf(defs, i.def)?.footprint; if (!fp?.pads) return;
      for (let j = 0; j < fp.pads.length; j++) {
        const p = fp.pads[j], net = i.pinNets[p.number]; if (!net || (only && net !== only)) continue;
        const rec = padRecord(p, i, net, j, copper); if (!rec) continue;
        bucketOf(nets, net).pads.push(rec);
      }
    }
  }
  function rebucket(s, board, defs) {
    const nets = new Map(), used = new Set(), copper = copperLookup(board, defs);
    for (const item of board.items || []) addGeometry(nets, defs, used, item, copper);
    const stack = stackInfo(board, defs, used);
    if (!s.stack || s.stack.sig !== stack.sig) { s.results.clear(); s.graphs.clear(); }
    else {
      // Reuse the pad array as part of the cache key. Ordered, exact comparisons cover
      // pad contacts, endpoint selection and labels, and package length and delay.
      for (const [net, bucket] of nets) {
        const previous = s.nets.get(net)?.pads;
        if (previous && samePads(bucket.pads, previous)) bucket.pads = previous;
      }
    }
    s.stack = stack; s.nets = nets; s.defs = defs;
  }
  // A bus needs endpoint geometry, timing and series-pin connectivity for the same nets.
  // Build their shared source index on demand. Only previously requested nets have derived records.
  const routingIndexes = new WeakMap();
  function routingIndex(board, defs, opts = {}) {
    const journal = globalThis.AtriumUndoStore, host = globalThis.AtriumNavHost;
    const local = host?.doc?.() === board, moving = local && !!host.drag?.()?.before;
    const v = !moving && journal?.documentVersions?.(board, opts.project || undefined, true);
    const rev = moving ? null : opts.revision ?? (local ? host.revision() : null);
    let index = routingIndexes.get(board);
    const same = index && index.items === board.items && index.defs === defs;
    if (same && v && index.v && index.v.floor === v.floor && index.v.library === v.library) {
      const previous = index.v;
      if (previous.items !== v.items) {
        const ordered = journal.orderedItemChanges(board, previous.seq, id => index.rows.has(id));
        if (!ordered) index = null;
        else {
          const {change, append} = ordered;
          for (const id of change.ids) if (index.rows.has(id)) index.replace(index.rows.get(id), change.items.get(id));
          for (const item of append) index.replace(null, item);
          index.count = board.items.length;
        }
      }
      if (index) {
        if (previous.outer !== v.outer || previous.pours !== v.pours || previous.project !== v.project) index.timing = null;
        index.v = v; index.rev = rev;
        return index;
      }
    } else if (same && !v && rev != null && rev === index.rev && board.items.length === index.count) return index;

    const rows = new Map(), groups = new Map(), byId = new Map(), parts = new Map(), layers = new Map();
    const stackLayers = new Map(), footprintIds = new Map(), references = new Map();
    let nextOrder = 0;
    const adjust = (map, key, by) => { const n = (map.get(key) || 0) + by; if (n) map.set(key,n); else map.delete(key); };
    function include(item, order) {
      const names = new Set(Object.values(item.pinNets || {}).filter(Boolean));
      if (item.net) names.add(item.net);
      const used = (item.kind === "track" && item.net ? [item.layer] : item.kind === "via" && item.net ? [item.fromLayer, item.toLayer] : []).map(layerIndex).filter(l => l >= 0);
      const copper = [item.layer,item.fromLayer,item.toLayer].map(layerIndex).filter(l => l >= 0);
      const def = item.kind === "part" ? item.def : null;
      const row = {item, names, order, used, copper, def, ref: item.kind === "part" ? item.ref : null};
      rows.set(item.id, row); byId.set(item.id, item);
      if (row.ref) {
        let refs = references.get(row.ref);
        if (!refs) references.set(row.ref, refs = new Set());
        refs.add(row);
        const last = [...refs].reduce((a,b) => a.order > b.order ? a : b);
        parts.set(row.ref, last.item);
      }
      for (const l of used) adjust(layers,l,1);
      for (const l of copper) adjust(stackLayers,l,1);
      if (def) adjust(footprintIds,def,1);
      for (const name of names) {
        let group = groups.get(name);
        if (!group) groups.set(name, group = {rows: new Map()});
        group.rows.set(item.id, row); group.items = group.pins = group.endpoints = null;
      }
    }
    function replace(old, item) {
      const before = [...stackLayers.keys()].sort().join(",") + "|" + [...layers.keys()].sort().join(",");
      if (old) {
        for (const n of old.names) {
          const group = groups.get(n);
          group.rows.delete(old.item.id); group.items = group.pins = group.endpoints = null;
          if (!group.rows.size) groups.delete(n);
        }
        if (old.ref) {
          const refs = references.get(old.ref); refs.delete(old);
          if (!refs.size) { parts.delete(old.ref); references.delete(old.ref); }
          else parts.set(old.ref, [...refs].reduce((a,b) => a.order > b.order ? a : b).item);
        }
        for (const l of old.used) adjust(layers,l,-1);
        for (const l of old.copper) adjust(stackLayers,l,-1);
        if (old.def) adjust(footprintIds,old.def,-1);
        rows.delete(old.item.id); byId.delete(old.item.id);
      }
      if (item) include(item, old?.order ?? nextOrder++);
      const row = item && rows.get(item.id);
      if (old?.def !== row?.def || before !== [...stackLayers.keys()].sort().join(",") + "|" + [...layers.keys()].sort().join(",")) index.timing = null;
      if (index.timing) for (const n of [...old?.names || [], ...row?.names || []]) {
        index.timing.nets.delete(n); index.timing.results.delete(n); index.timing.graphs.delete(n);
      }
    }
    function itemsFor(net) {
      const group = groups.get(net);
      if (!group) return [];
      return group.items ||= [...group.rows.values()].sort((a, b) => a.order - b.order).map(row => row.item);
    }
    function pinsFor(net) {
      const group = groups.get(net); if (!group) return [];
      return group.pins ||= itemsFor(net).filter(i => i.kind === "part" && i.ref).flatMap(part =>
        Object.entries(part.pinNets || {}).filter(([, n]) => n === net).map(([pin]) => ({ref: part.ref, pin, part})));
    }
    index = {items: board.items, count: board.items.length, board, defs, v, rev, groups, rows, byId, parts, layers, stackLayers, footprintIds, replace, itemsFor, pinsFor, timing: null};
    for (const item of board.items) include(item, nextOrder++);
    if (v || rev != null) routingIndexes.set(board, index);
    return index;
  }
  function measuredBucket(s, net) {
    if (!s.routing || s.nets.has(net)) return s.nets.get(net);
    const used = new Set();
    for (const item of s.routing.itemsFor(net)) addGeometry(s.nets, s.defs, used, item, s.copper, net);
    return s.nets.get(net);
  }
  function ensure(board, defs, opts = {}) {
    const index = opts.routingIndex;
    if (index && index.board === board && index.defs === defs) {
      return index.timing ||= {nets: new Map(), results: new Map(), graphs: new Map(), routing: index, defs, copper: copperLookup(board, defs), stack: stackInfo(board, defs, index.layers.keys(), index)};
    }
    const s = stateOf(board), rev = opts.revision;
    if (s.nets && rev !== undefined && rev === s.revision && s.defs === defs) return s;
    rebucket(s, board, defs); s.revision = rev;
    return s;
  }
  // Capture the board's rates once for a tuning plan or cursor session. Use the
  // same layer, width, pair gap and profile as the committed copper measurement.
  function delayRates(board, defs, opts = {}) {
    const stack = ensure(board, defs, opts).stack;
    return (net, layer, width) => stack.factor(layerIndex(layer || "Top"), width || 0.15, stack.odd.get(net));
  }
  // Called by the editor after it changes copper. With no nets, the next query re-scans.
  function invalidate(board, nets) {
    pinCache.delete(board);
    const s = caches.get(board); if (!s) return;
    s.revision = undefined;
    if (nets) for (const n of nets) { s.results.delete(n); s.graphs.delete(n); }
  }

  // ------------------------------------------------------------------ net graph
  // Nodes: track vertices per layer, pads, and one node per (via, layer). Edges carry
  // a type (0 track, 1 via barrel, 2 zero-length contact) and the source segment.
  function buildGraph(s, bucket) {
    const tracks = bucket.tracks, pads = bucket.pads, vias = bucket.vias, stack = s.stack;
    const nx = [], ny = [], nl = [], nk = [], nhw = [], keyMap = new Map();
    function node(x, y, l, hw) {
      const kx = Math.round(x * 1000), ky = Math.round(y * 1000);
      const key = Math.abs(kx) < 2e6 && Math.abs(ky) < 2e6 ? (l * 4194304 + kx + 2097152) * 4194304 + ky + 2097152 : l + ":" + kx + "," + ky;
      let n = keyMap.get(key);
      if (n === undefined) { n = nx.length; keyMap.set(key, n); nx.push(x); ny.push(y); nl.push(l); nk.push(0); nhw.push(hw); }
      else if (hw > nhw[n]) nhw[n] = hw;
      return n;
    }
    const sa = [], sb = [], st = [], sk = [], sl = [], sw = [];
    let reach = 1;
    for (let t = 0; t < tracks.length; t++) {
      const tr = tracks[t], l = layerIndex(tr.layer), hw = (tr.width || 0) / 2, p = tr.points;
      reach = Math.max(reach, hw * .5 + 1e-6);
      let prev = node(p[0][0], p[0][1], l, hw);
      for (let k = 1; k < p.length; k++) {
        const cur = node(p[k][0], p[k][1], l, hw);
        if (cur !== prev) { sa.push(prev); sb.push(cur); st.push(t); sk.push(k - 1); sl.push(l); sw.push(tr.width || 0); }
        prev = cur;
      }
    }
    const vertexCount = nx.length, degree = new Int32Array(vertexCount);
    for (let i = 0; i < sa.length; i++) { degree[sa[i]]++; degree[sb[i]]++; }
    const ea = [], eb = [], elen = [], etype = [], eseg = [];
    const link = (a, b, len, type, seg) => { ea.push(a); eb.push(b); elen.push(len); etype.push(type); eseg.push(seg); };
    const attached = new Uint8Array(vertexCount);
    // Pads
    const padNode = new Int32Array(pads.length);
    for (let p = 0; p < pads.length; p++) {
      const pad = pads[p], n = nx.length; padNode[p] = n;
      nx.push(pad.x); ny.push(pad.y); nl.push(-1); nk.push(1); nhw.push(0);
    }
    const grid = vertexCount > 48 ? pointGrid(nx, ny, vertexCount, 1) : null;
    function nearVertices(x, y, r, visit) {
      if (grid) grid.near(x, y, r, visit);
      else for (let v = 0; v < vertexCount; v++) visit(v);
    }
    for (let p = 0; p < pads.length; p++) {
      for (const placed of pads[p].lands) nearVertices(...placed.at, placed.radius + reach, v => {
        if (nl[v] < placed.lo || nl[v] > placed.hi) return;
        if (touches(placed, nx[v], ny[v], nhw[v] * .5 + 1e-6)) { link(v, padNode[p], 0, 2, -1); attached[v] = 1; }
      });
    }
    // Vias: one node per connected layer, chained by barrel edges in z order.
    let viaCount = 0;
    for (const via of vias) {
      const lo = via.fromLayer && via.toLayer ? Math.min(layerIndex(via.fromLayer), layerIndex(via.toLayer)) : 0;
      const hi = via.fromLayer && via.toLayer ? Math.max(layerIndex(via.fromLayer), layerIndex(via.toLayer)) : 127;
      const r = (via.diameter || 0) / 2, byLayer = new Map();
      nearVertices(via.x, via.y, r + 1, v => {
        const l = nl[v]; if (l < lo || l > hi) return;
        const d2 = (nx[v] - via.x) ** 2 + (ny[v] - via.y) ** 2;
        if (d2 > (r + nhw[v] * 0.5 + 1e-6) ** 2) return;
        let n = byLayer.get(l);
        if (n === undefined) { n = nx.length; byLayer.set(l, n); nx.push(via.x); ny.push(via.y); nl.push(l); nk.push(2); nhw.push(0); }
        link(v, n, 0, 2, -1); attached[v] = 1;
      });
      for (let p = 0; p < pads.length; p++) {
        for (const placed of pads[p].lands) {
          if (!touches(placed, via.x, via.y, 1e-6)) continue;
          for (const [l, n] of byLayer) if (l >= placed.lo && l <= placed.hi) link(n, padNode[p], 0, 2, -1);
        }
      }
      if (byLayer.size) viaCount++;
      const chain = [...byLayer].sort((a, b) => stack.zOf(a[0]) - stack.zOf(b[0]));
      for (let i = 1; i < chain.length; i++) link(chain[i - 1][1], chain[i][1], Math.abs(stack.zOf(chain[i][0]) - stack.zOf(chain[i - 1][0])), 1, -1);
    }
    // T junctions: a free track end lying on another segment of the same layer splits it.
    const splits = new Map();
    let segCells = null;
    const SC = 2;
    if (sa.length > 32) {
      segCells = new Map();
      for (let i = 0; i < sa.length; i++) {
        const x0 = Math.floor((Math.min(nx[sa[i]], nx[sb[i]]) - sw[i]) / SC), x1 = Math.floor((Math.max(nx[sa[i]], nx[sb[i]]) + sw[i]) / SC);
        const y0 = Math.floor((Math.min(ny[sa[i]], ny[sb[i]]) - sw[i]) / SC), y1 = Math.floor((Math.max(ny[sa[i]], ny[sb[i]]) + sw[i]) / SC);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) { (segCells.get("big") || segCells.set("big", []).get("big")).push(i); continue; }
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x * 1048576 + y; let c = segCells.get(k); if (!c) segCells.set(k, c = []); c.push(i); }
      }
    }
    const candidates = v => {
      if (!segCells) return null;
      const k = Math.floor(nx[v] / SC) * 1048576 + Math.floor(ny[v] / SC);
      return [...(segCells.get(k) || []), ...(segCells.get("big") || [])];
    };
    for (let v = 0; v < vertexCount; v++) {
      if (degree[v] !== 1 || attached[v]) continue;
      const near = candidates(v), count = near ? near.length : sa.length;
      for (let j = 0; j < count; j++) {
        const i = near ? near[j] : j;
        if (sl[i] !== nl[v] || sa[i] === v || sb[i] === v) continue;
        const ax = nx[sa[i]], ay = ny[sa[i]], bx = nx[sb[i]], by = ny[sb[i]];
        const tol = Math.max(sw[i] / 2, nhw[v]) + 1e-6;
        if (segPoint2(nx[v], ny[v], ax, ay, bx, by) > tol * tol) continue;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((nx[v] - ax) * dx + (ny[v] - ay) * dy) / L2)) : 0;
        if (!splits.has(i)) splits.set(i, []);
        splits.get(i).push([t, v]); break;
      }
    }
    for (let i = 0; i < sa.length; i++) {
      const ax = nx[sa[i]], ay = ny[sa[i]], bx = nx[sb[i]], by = ny[sb[i]], L = Math.hypot(bx - ax, by - ay);
      const list = splits.get(i);
      if (!list) { link(sa[i], sb[i], L, 0, i); continue; }
      list.sort((p, q) => p[0] - q[0]);
      let prev = sa[i], pt = 0;
      for (const [t, v] of list) {
        const n = nx.length, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        nx.push(x); ny.push(y); nl.push(sl[i]); nk.push(0); nhw.push(0);
        link(prev, n, (t - pt) * L, 0, i);
        link(n, v, Math.hypot(nx[v] - x, ny[v] - y), 0, -2 - sl[i]);
        prev = n; pt = t;
      }
      link(prev, sb[i], (1 - pt) * L, 0, i);
    }
    // CSR adjacency
    const N = nx.length, E = ea.length, start = new Int32Array(N + 1), adj = new Int32Array(E * 2);
    for (let e = 0; e < E; e++) { start[ea[e] + 1]++; start[eb[e] + 1]++; }
    for (let i = 0; i < N; i++) start[i + 1] += start[i];
    const fill = start.slice(0, N);
    for (let e = 0; e < E; e++) { adj[fill[ea[e]]++] = e; adj[fill[eb[e]]++] = e; }
    // Islands
    const parent = new Int32Array(N); for (let i = 0; i < N; i++) parent[i] = i;
    const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let e = 0; e < E; e++) { const a = root(ea[e]), b = root(eb[e]); if (a !== b) parent[b] = a; }
    return {N, E, ea: Int32Array.from(ea), eb: Int32Array.from(eb), elen: Float64Array.from(elen), etype: Int8Array.from(etype), eseg: Int32Array.from(eseg),
      st, sk, sl, sw, nx, ny, nl, start, adj, root, padNode, pads, tracks, viaCount, vertexCount};
  }
  function pointGrid(xs, ys, count, cell) {
    const cells = new Map();
    for (let i = 0; i < count; i++) {
      const k = Math.floor(xs[i] / cell) * 1048576 + Math.floor(ys[i] / cell);
      let c = cells.get(k); if (!c) cells.set(k, c = []); c.push(i);
    }
    return {near(x, y, r, visit) {
      const x0 = Math.floor((x - r) / cell), x1 = Math.floor((x + r) / cell), y0 = Math.floor((y - r) / cell), y1 = Math.floor((y + r) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4 * count) {
        for (let i = 0; i < count; i++) visit(i);
        return;
      }
      for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const c = cells.get(i * 1048576 + j); if (c) for (const v of c) visit(v); }
    }};
  }
  function graphOf(s, net) {
    const b = measuredBucket(s, net); if (!b) return null;
    const hit = s.graphs.get(net);
    if (hit && hit.hash === b.hash && hit.graph.pads === b.pads) { s.graphs.delete(net); s.graphs.set(net, hit); return hit.graph; }
    const graph = buildGraph(s, b);
    s.graphs.set(net, {hash: b.hash, graph});
    if (s.graphs.size > 48) s.graphs.delete(s.graphs.keys().next().value);
    return graph;
  }
  // Dijkstra over the CSR graph with a binary heap on typed arrays.
  function shortest(g, source, viaWeight) {
    const dist = new Float64Array(g.N).fill(Infinity), prevEdge = new Int32Array(g.N).fill(-1);
    const heapN = new Int32Array(g.E * 2 + 2), heapD = new Float64Array(g.E * 2 + 2);
    let size = 0;
    const push = (n, d) => {
      let i = size++;
      while (i > 0) { const p = (i - 1) >> 1; if (heapD[p] <= d) break; heapN[i] = heapN[p]; heapD[i] = heapD[p]; i = p; }
      heapN[i] = n; heapD[i] = d;
    };
    const pop = () => {
      const top = heapN[0], n = heapN[--size], d = heapD[size];
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= size) break; if (c + 1 < size && heapD[c + 1] < heapD[c]) c++; if (heapD[c] >= d) break; heapN[i] = heapN[c]; heapD[i] = heapD[c]; i = c; }
      heapN[i] = n; heapD[i] = d; return top;
    };
    dist[source] = 0; push(source, 0);
    while (size) {
      const d0 = heapD[0], u = pop();
      if (d0 > dist[u]) continue;
      for (let k = g.start[u]; k < g.start[u + 1]; k++) {
        const e = g.adj[k], v = g.ea[e] === u ? g.eb[e] : g.ea[e];
        const w = g.etype[e] === 1 ? (viaWeight ? g.elen[e] : 1e-9) : g.elen[e];
        const nd = d0 + w;
        if (nd < dist[v]) { dist[v] = nd; prevEdge[v] = e; push(v, nd); }
      }
    }
    return {dist, prevEdge};
  }

  // ------------------------------------------------------------------ net length
  function breakdown(s, g, edges, viasOn, net) {
    const odd = net != null ? s.stack.odd?.get(net) : null;
    const out = {track: 0, via: 0, delay: 0, layers: {}, transitions: 0, segments: []};
    for (const e of edges) {
      const t = g.etype[e], len = g.elen[e];
      if (t === 0) {
        const seg = g.eseg[e], l = seg >= 0 ? g.sl[seg] : -2 - seg, w = seg >= 0 ? g.sw[seg] : 0.15;
        out.track += len; const name = layerName(l); out.layers[name] = (out.layers[name] || 0) + len;
        out.delay += len * s.stack.factor(l, w, odd);
        if (seg >= 0) out.segments.push(seg);
      } else if (t === 1) {
        out.transitions++;
        if (viasOn) { out.via += len; out.delay += len * s.stack.viaFactor + (s.stack.viaPs || 0); }
      }
    }
    return out;
  }
  function pathEdges(g, sp, target) {
    const edges = []; let v = target;
    while (sp.prevEdge[v] >= 0) { const e = sp.prevEdge[v]; edges.push(e); v = g.ea[e] === v ? g.eb[e] : g.ea[e]; }
    return edges;
  }
  const padLabel = p => p ? (p.ref ? p.ref + "." + p.number : "Pad " + (p.number || "?")) : "";
  function findPad(g, end) {
    if (end == null) return -1;
    if (typeof end === "number") return end;
    return g.pads.findIndex(p => (end.ref == null || p.ref === end.ref) && (end.pin == null || p.number === String(end.pin)) && (end.id == null || p.id === end.id));
  }
  function computeNet(s, net, opts) {
    const g = graphOf(s, net), viasOn = opts.vias !== false, dieOn = opts.die !== false;
    const empty = {net, length: 0, mode: "total", track: 0, via: 0, die: 0, delay: 0, layers: {}, vias: 0, pads: 0, islands: 0,
      unrouted: false, routed: 0, stub: 0, from: null, to: null, id: null, at: null, segments: []};
    if (!g) return empty;
    const all = []; for (let e = 0; e < g.E; e++) all.push(e);
    const total = breakdown(s, g, all, viasOn, net);
    const padRoots = new Set(); for (const n of g.padNode) padRoots.add(g.root(n));
    let islands = padRoots.size;
    const loose = new Set(); for (let v = 0; v < g.vertexCount; v++) { const r = g.root(v); if (!padRoots.has(r)) loose.add(r); }
    islands += loose.size;
    const dieAll = dieOn ? g.pads.reduce((a, p) => a + p.die, 0) : 0;
    const padPs = p => p.dieDelay ?? p.die * s.stack.viaFactor, dieAllPs = dieOn ? g.pads.reduce((a, p) => a + padPs(p), 0) : 0;
    const first = g.tracks[0], at = first ? [...first.points[Math.floor(first.points.length / 2)]] : g.pads[0] ? [g.pads[0].x, g.pads[0].y] : null;
    const res = {...empty, pads: g.pads.length, islands, unrouted: g.pads.length > 1 && islands > 1, routed: total.track + total.via,
      vias: g.viaCount, id: first?.id ?? g.pads[0]?.id ?? null, at};
    let a = findPad(g, opts.from), b = findPad(g, opts.to);
    const mode = opts.mode || "auto";
    if (mode !== "total" && a < 0 && b < 0 && g.pads.length === 2) { a = 0; b = 1; }
    if (mode !== "total" && a < 0 && b < 0 && g.pads.length > 2 && g.pads.length <= 16 && mode === "longest") {
      let best = -1;
      for (let i = 0; i < g.pads.length; i++) {
        const sp = shortest(g, g.padNode[i], viasOn);
        for (let j = i + 1; j < g.pads.length; j++) { const d = sp.dist[g.padNode[j]]; if (d < Infinity && d > best) { best = d; a = i; b = j; } }
      }
    }
    if (a >= 0 && b >= 0 && a !== b) {
      const sp = shortest(g, g.padNode[a], viasOn), tgt = g.padNode[b];
      if (sp.dist[tgt] < Infinity) {
        const pb = breakdown(s, g, pathEdges(g, sp, tgt), viasOn, net), die = dieOn ? g.pads[a].die + g.pads[b].die : 0;
        return {...res, mode: "path", length: pb.track + pb.via + die, track: pb.track, via: pb.via, die, layers: pb.layers,
          delay: pb.delay + (dieOn ? padPs(g.pads[a]) + padPs(g.pads[b]) : 0), transitions: pb.transitions, stub: Math.max(0, total.track - pb.track),
          from: padLabel(g.pads[a]), to: padLabel(g.pads[b]), segments: pb.segments, unrouted: res.unrouted};
      }
      res.unrouted = true;
    }
    return {...res, mode: "total", length: total.track + total.via + dieAll, track: total.track, via: total.via, die: dieAll,
      layers: total.layers, delay: total.delay + dieAllPs, transitions: total.transitions, segments: total.segments};
  }
  const optKey = o => (o.mode || "auto") + (o.vias === false ? "-v" : "+v") + (o.die === false ? "-d" : "+d") +
    (o.from ? JSON.stringify(o.from) : "") + (o.to ? JSON.stringify(o.to) : "");
  function lookup(s, net, opts) {
    const b = measuredBucket(s, net), hash = b?.hash ?? 0, pads = b?.pads, key = optKey(opts);
    let slot = s.results.get(net);
    if (!slot || slot.hash !== hash || slot.pads !== pads) {
      slot = {hash, pads, byKey: new Map()}; s.results.set(net, slot);
    }
    let r = slot.byKey.get(key);
    if (!r) { r = Object.freeze(computeNet(s, net, opts)); slot.byKey.set(key, r); }
    return r;
  }
  // Routed length of one net. opts: {mode:"auto"|"path"|"total"|"longest", from, to, vias, die, revision}.
  // "auto" measures pad to pad for two-pad nets and the total routed copper otherwise.
  function netLength(board, defs, net, opts = {}) { return lookup(ensure(board, defs, opts), net, opts); }
  function lengths(board, defs, opts = {}) {
    const s = ensure(board, defs, opts), out = new Map();
    for (const net of opts.nets || (s.routing ? s.routing.groups : s.nets).keys()) out.set(net, lookup(s, net, opts));
    return out;
  }
  // The one net-length measurement behind Length DRC, the Constraint Manager and MCP net_lengths
  // (rules.js netLengths forwards here), in their shape: Map net -> {net, length, trackLength,
  // viaLength, dieLength, delay, mode, tracks, vias, first, id}. Same numbers as netLength (with
  // opts.match, matchLength: the xSignal path). Nets without a track or via are left out;
  // opts.viaHeights === false leaves via barrels out.
  function netLengths(board, defs, opts = {}) {
    const o = opts.viaHeights === false ? {...opts, vias: false} : opts, s = ensure(board, defs, o), out = new Map();
    for (const net of (s.routing ? s.routing.groups : s.nets).keys()) {
      const b = measuredBucket(s,net);
      if (!b || !b.tracks.length && !b.vias.length) continue;
      const r = opts.match ? matchLength(board, defs, net, o, lookup(s, net, o)) : lookup(s, net, o), t = b.tracks[0], v = b.vias[0];
      out.set(net, {net, length: r.length, trackLength: r.track, viaLength: r.via, dieLength: r.die, delay: r.delay, mode: r.mode, unrouted: r.unrouted,
        tracks: b.tracks.length, vias: b.vias.length, first: t ? t.points[0] : [v.x, v.y], id: (t || v).id});
    }
    return out;
  }
  function netNames(board, defs, opts = {}) { const s = ensure(board, defs, opts); return [...(s.routing ? s.routing.groups : s.nets).keys()].sort(); }

  // ------------------------------------------------------------------ xSignals
  function store(board) { return board.lengthTuning && typeof board.lengthTuning === "object" ? board.lengthTuning : null; }
  function storeFor(board) {
    if (!store(board)) board.lengthTuning = {version: 1, groups: [], targets: {}};
    const t = board.lengthTuning; t.groups ||= []; t.targets ||= {};
    return t;
  }
  // xSignals are the signal model's (signals.js); this is the board's view of them (shared, read only).
  const xsList = board => globalThis.AtriumSignals?.xsView?.(board).xSignals || [];
  function xSignals(board) { return xsList(board).map(x => ({...x})); }
  const SERIES = /^(R|L|FB|C|RN|RP|J?P)\d/i;
  function partsByRef(board) {
    const m = new Map(); for (const i of board.items || []) if (i.kind === "part" && i.ref) m.set(i.ref, i); return m;
  }
  // Pad-to-pad path that may cross series parts (two pads on different nets).
  // xs: {name, from:{ref,pin}, to:{ref,pin}, through?:[refs]}.
  function xSignalLength(board, defs, xs, opts = {}) {
    const s = ensure(board, defs, opts), viasOn = opts.vias !== false, dieOn = opts.die !== false;
    const parts = opts.routingIndex?.parts || partsByRef(board), from = parts.get(xs.from?.ref), to = parts.get(xs.to?.ref);
    const fail = why => ({name: xs.name, length: 0, unrouted: true, reason: why, nets: [], through: [], track: 0, via: 0, die: 0, delay: 0, layers: {}});
    if (!from || !to) return fail("Missing component");
    const startNet = from.pinNets?.[xs.from.pin], endNet = to.pinNets?.[xs.to.pin];
    if (!startNet || !endNet) return fail("Unassigned pin");
    const allowed = xs.through ? new Set(xs.through) : null;
    const best = new Map(); // net -> {pad, dist, prev}
    const queue = [{net: startNet, pad: {ref: from.ref, pin: xs.from.pin}, d: 0, chain: [], parts: []}];
    let result = null, guard = 0;
    while (queue.length && guard++ < 64) {
      queue.sort((a, b) => a.d - b.d);
      const cur = queue.shift();
      if (best.has(cur.net)) continue;
      best.set(cur.net, cur);
      const g = graphOf(s, cur.net); if (!g) continue;
      const src = findPad(g, cur.pad); if (src < 0) continue;
      const sp = shortest(g, g.padNode[src], viasOn);
      if (cur.net === endNet) {
        const dst = findPad(g, {ref: to.ref, pin: xs.to.pin});
        if (dst >= 0 && sp.dist[g.padNode[dst]] < Infinity) {
          result = {cur, g, sp, dst}; break;
        }
      }
      for (let p = 0; p < g.pads.length; p++) {
        const pad = g.pads[p]; if (p === src || !pad.ref || sp.dist[g.padNode[p]] === Infinity) continue;
        const part = parts.get(pad.ref); if (!part || part === from && cur.chain.length === 0 && pad.number === String(xs.from.pin)) continue;
        if (allowed ? !allowed.has(pad.ref) : !SERIES.test(pad.ref)) continue;
        const fp = defOf(defs, part.def)?.footprint, padsOf = (fp?.pads || []).filter(q => part.pinNets?.[q.number]);
        if (padsOf.length !== 2) continue;
        const other = padsOf.find(q => String(q.number) !== pad.number), net = part.pinNets[other.number];
        if (!net || net === cur.net || best.has(net)) continue;
        queue.push({net, pad: {ref: part.ref, pin: other.number}, d: cur.d + sp.dist[g.padNode[p]],
          chain: [...cur.chain, {net: cur.net, src, dst: p}], parts: [...cur.parts, part.ref]});
      }
    }
    if (!result) return fail("No routed path");
    let track = 0, via = 0, die = 0, delay = 0, transitions = 0, series = 0, seriesDelay = 0; const layers = {}, nets = [];
    // Series parts (resistor, capacitor, ferrite, 0 Ω link): their own pad-to-pad length counts, with
    // the outer-layer delay, unless the part sets seriesLength (mm) or seriesDelay (ps), or
    // board.lengthTuning.seriesModel is "none".
    const model = store(board)?.seriesModel || "pads";
    let prevPad = null;
    const add = (net, g, sp, src, dst) => {
      const b = breakdown(s, g, pathEdges(g, sp, g.padNode[dst]), viasOn, net);
      track += b.track; via += b.via; delay += b.delay; transitions += b.transitions; nets.push(net);
      for (const [k, v] of Object.entries(b.layers)) layers[k] = (layers[k] || 0) + v;
      const start = g.pads[src];
      if (prevPad && start && model !== "none") {
        const part = parts.get(start.ref), own = Number.isFinite(+part?.seriesLength) ? +part.seriesLength : null, ps = Number.isFinite(+part?.seriesDelay) ? +part.seriesDelay : null;
        const len = own ?? (start.ref === prevPad.ref ? Math.hypot(start.x - prevPad.x, start.y - prevPad.y) : 0);
        series += len; seriesDelay += ps ?? len * s.stack.factor(start.lo === 127 ? 127 : 0, 0.2);
      }
      prevPad = g.pads[dst];
    };
    for (const c of result.cur.chain) { const g = graphOf(s, c.net); add(c.net, g, shortest(g, g.padNode[c.src], viasOn), c.src, c.dst); }
    add(endNet, result.g, result.sp, findPad(result.g, result.cur.pad), result.dst);
    delay += seriesDelay;
    if (dieOn) {
      const gs = graphOf(s, startNet), ge = result.g;
      const pa = gs.pads[findPad(gs, {ref: from.ref, pin: xs.from.pin})], pz = ge.pads[result.dst];
      die = (pa?.die || 0) + (pz?.die || 0);
      delay += (pa ? pa.dieDelay ?? pa.die * s.stack.viaFactor : 0) + (pz ? pz.dieDelay ?? pz.die * s.stack.viaFactor : 0);
    }
    return {name: xs.name, length: track + via + die + series, track, via, die, series, delay, layers, transitions, nets, through: result.cur.parts, unrouted: false};
  }
  // ------------------------------------------------------------------ series terminations (automatic xSignals)
  // A net matched for length or delay that runs point to point into a two-pin series part (a
  // series termination resistor, AC-coupling capacitor, ferrite or 0 Ω link) whose other net is
  // also point to point is measured source pin → part → load pin, as an xSignal, without having
  // to define one. Stored xSignals (xsignals.js) take precedence. board.lengthTuning.autoXSignals
  // = false turns this off.
  const SERIES_PART = /^(R|C|L|FB|JP|NT|Z|RN|RA|RP|RR)\d/i;
  // Rails and grounds: net-intent.js when loaded (isSupply), else this regex (one release).
  const POWER_RE = /^(?:[ADPS]?GND\w*|GND\w*|VSS\w*|VCC\w*|VDD\w*|VEE\w*|VBUS\w*|VBAT\w*|VIN\w*|VREF\w*|VTT\w*|VPP\w*|PWR\w*|[+-]?\d+V\d*\w*|[+-]?\d+(?:\.\d+)?V\w*|P\d+V\d*\w*|\+\w+)$/i;
  const POWER_NET = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isSupply ? N.isSupply(n) : POWER_RE.test(n); }};
  const pinCache = new WeakMap();
  // net -> [{ref, pin, part}] from the parts' pin nets; cached per items array and revision.
  function pinsOfNets(board, rev) {
    const c = pinCache.get(board);
    if (c && c.items === board.items && c.n === (board.items || []).length && c.rev === rev) return c.map;
    const map = new Map();
    for (const part of board.items || []) if (part.kind === "part" && part.ref) for (const [pin, net] of Object.entries(part.pinNets || {})) {
      if (!net) continue; if (!map.has(net)) map.set(net, []); map.get(net).push({ref: part.ref, pin: String(pin), part});
    }
    pinCache.set(board, {items: board.items, n: (board.items || []).length, rev, map});
    return map;
  }
  // The pin across a series part. signals.js decides when loaded (designator, resistor networks, the
  // SeriesPins parameter and the store's series overrides); the rule below is its fallback.
  function seriesOther(part, pin, store, defs) {
    const S = globalThis.AtriumSignals;
    if (S?.series) { const pp = S.series(part, defs?.get ? defs.get(part.def) : defs?.[part.def] || null, store); for (const [a, b] of pp) { if (a === String(pin)) return b; if (b === String(pin)) return a; } return null; }
    if (!SERIES_PART.test(part.ref)) return null;
    const pins = Object.keys(part.pinNets || {}).filter(k => part.pinNets[k]);
    if (pins.length === 2) return pins.find(k => k !== String(pin)) ?? null;
    if (/^(RN|RA|RP|RR)\d/i.test(part.ref)) {
      const all = Object.keys(part.pinNets || {}).map(Number).filter(Number.isFinite), n = all.length ? Math.max(...all) : 0, i = +pin;
      if (n >= 4 && n % 2 === 0 && Number.isFinite(i)) { const j = String(n + 1 - i); return part.pinNets[j] ? j : null; }
    }
    return null;
  }
  // The automatic xSignal through `net`, or null: {name, from, to, through, nets, auto:true}.
  function seriesXSignal(board, net, o = {}) {
    const sigStore = globalThis.AtriumSignals?.projectOf?.(board)?.signals || null;
    if (store(board)?.autoXSignals === false || !net || POWER_NET.test(net)) return null;
    const getPins = o.routingIndex ? o.routingIndex.pinsFor : n => pinsOfNets(board, o.revision).get(n), own = getPins(net);
    if (!own || own.length !== 2) return null;
    const seen = new Set([net]), through = [];
    // Walk outward from one pin of `net`: cross series parts into point-to-point nets.
    const extend = start => {
      let end = start; const nets = [];
      for (let k = 0; k < 3; k++) {
        const other = seriesOther(end.part, end.pin, sigStore, o.defs); if (other == null) break;
        const next = end.part.pinNets[other];
        if (!next || seen.has(next) || POWER_NET.test(next)) break;
        const np = getPins(next); if (!np || np.length !== 2) break;
        const far = np.find(q => !(q.ref === end.ref && q.pin === other)); if (!far) break;
        seen.add(next); nets.push(next); through.push(end.ref); end = far;
      }
      return {end, nets};
    };
    const A = extend(own[0]), B = extend(own[1]);
    if (!through.length || A.end.ref === B.end.ref) return null;
    // The end on the part with more pins is the source (controller), as the wizard does.
    const pc = q => Object.keys(q.part.pinNets || {}).length;
    const first = pc(A.end) !== pc(B.end) ? pc(A.end) > pc(B.end) : String(A.end.ref).localeCompare(String(B.end.ref), undefined, {numeric: true}) <= 0;
    const [src, dst, sNets, dNets] = first ? [A.end, B.end, A.nets, B.nets] : [B.end, A.end, B.nets, A.nets];
    const nets = [...sNets.reverse(), net, ...dNets];
    // Named after the source-side net, so it is the same whichever of its nets is asked about.
    return {name: nets[0], from: {ref: src.ref, pin: src.pin}, to: {ref: dst.ref, pin: dst.pin}, through: [...new Set(through)], nets, auto: true};
  }
  // The stored xSignal that runs through `net` (its stored nets, else its end pins' nets).
  function storedXSignalOf(board, net, index) {
    const list = xsList(board);
    if (!list.length) return null;
    const parts = index?.parts || partsByRef(board);
    for (const x of list) {
      const nets = Array.isArray(x.nets) && x.nets.length ? x.nets : [parts.get(x.from?.ref)?.pinNets?.[x.from?.pin], parts.get(x.to?.ref)?.pinNets?.[x.to?.pin]];
      if (nets.includes(net)) return x;
    }
    return null;
  }
  // Length and delay used for matching: the xSignal through `net` when there is one (stored, then
  // automatic through a series part), else the net itself. The default path for every matching
  // check (Length Manager, Constraint Manager, matched DRC, timing, tuning targets).
  // Returns netLength's fields plus {xSignal, auto, nets, through, series}.
  function matchLength(board, defs, net, o = {}, base = null) {
    const xs = (o.xSignals !== false && (storedXSignalOf(board, net, o.routingIndex) || seriesXSignal(board, net, o.defs ? o : {...o, defs}))) || null;
    base ||= netLength(board, defs, net, o);
    if (!xs) return base;
    const r = xSignalLength(board, defs, xs, o);
    if (r.unrouted) return {...base, xSignal: xs.name, auto: !!xs.auto, nets: xs.nets || r.nets, through: xs.through || [], unrouted: true, reason: r.reason, mode: "xsignal"};
    return {...base, ...r, xSignal: xs.name, auto: !!xs.auto, nets: r.nets, mode: "xsignal", vias: base.vias, id: base.id, at: base.at, net};
  }
  // Candidate xSignals from each pin of `fromRef` to pins of `toRef`, directly or through series parts.
  function discoverXSignals(board, defs, fromRef, toRef, opts = {}) {
    const parts = partsByRef(board), a = parts.get(fromRef), b = parts.get(toRef), out = [];
    if (!a || !b) return out;
    for (const [pin, net] of Object.entries(a.pinNets || {})) {
      if (!net) continue;
      for (const [pin2, net2] of Object.entries(b.pinNets || {})) {
        if (!net2) continue;
        const xs = {name: (opts.prefix || fromRef + "_" + toRef + "_") + net2, from: {ref: fromRef, pin}, to: {ref: toRef, pin: pin2}};
        if (net === net2 && !/^(GND|VCC|VDD|.*V\d)/i.test(net)) out.push(xs);
        else if (net !== net2) { const r = xSignalLength(board, defs, xs, opts); if (!r.unrouted && r.through.length) out.push({...xs, through: r.through}); }
      }
    }
    return out;
  }
  // New xSignals (by name) join the signal model (one edit); returns how many the board has.
  function addXSignals(board, list, project) {
    const S = globalThis.AtriumSignals, v = S?.xsView?.(board, project);
    if (!v) throw Error("Signals are not loaded.");
    const all = JSON.parse(JSON.stringify(v.xSignals)), names = new Set(all.map(x => x.name));
    for (const x of list) if (x?.name && !names.has(x.name)) { all.push(JSON.parse(JSON.stringify(x))); names.add(x.name); }
    if (all.length !== v.xSignals.length) S.applyClasses(project || S.projectOf(board) || (() => { throw Error("Open the board in a project to change its xSignals."); })(), board, {xSignals: all});
    invalidate(board);
    return all.length;
  }

  // ------------------------------------------------------------------ obstacles and clearance
  // Copper of other nets (and of the tuned net, at the meander gap) near a region, indexed
  // on a uniform grid. check(ax,ay,bx,by,halfWidth) is the clearance callback for tune().
  function obstacles(board, defs, opts = {}) {
    const rules = globalThis.AtriumRules?.resolver?.(board,{project:opts.project,defs}), kit = globalThis.AtriumRules?.kit;
    const cell = opts.cell || 1, list = [], holes = [], cells = new Map(), byId = new Map(), copper = copperLookup(board, defs);
    const margin = rules?.clearanceMax || 0, box = opts.box?.map((v,k)=>v+(k<2?-margin:margin));
    const inBox = (x0,y0,x1,y1) => !box || !(x1 < box[0] || x0 > box[2] || y1 < box[1] || y0 > box[3]);
    function buckets(o, fn) {
      const x0=Math.floor(o.x0/cell), x1=Math.floor(o.x1/cell), y0=Math.floor(o.y0/cell), y1=Math.floor(o.y1/cell);
      if ((x1-x0+1)*(y1-y0+1)>4096) { fn("big"); return; }
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)fn(x*1048576+y);
    }
    function put(o) {
      if (!inBox(o.x0,o.y0,o.x1,o.y1)) return;
      const i = holes.length ? holes.pop() : list.length; list[i]=o;
      if(o.subject) {
        const geometry = rules.spatialClearance ? kit.feature({},o.poly??[[o.ax,o.ay],[o.bx,o.by]],o.r) : {box:[o.x0,o.y0,o.x1,o.y1]};
        o.subject={...o.subject,...geometry};
      }
      let ids=byId.get(o.id); if (!ids) byId.set(o.id,ids=[]); ids.push(i);
      buckets(o,k=>{let c=cells.get(k);if(!c)cells.set(k,c=[]);c.push(i);});
    }
    function capsule(net,id,seg,lo,hi,ax,ay,bx,by,r,subject) {
      put({kind:0,net,id,seg,lo,hi,ax,ay,bx,by,r,subject,x0:Math.min(ax,bx)-r,y0:Math.min(ay,by)-r,x1:Math.max(ax,bx)+r,y1:Math.max(ay,by)+r});
    }
    function polygon(net,id,lo,hi,pts,r,subject) {
      const b=globalThis.Atrium.bounds(pts);
      put({kind:1,net,id,seg:-1,lo,hi,poly:pts,r,subject,x0:b[0]-r,y0:b[1]-r,x1:b[2]+r,y1:b[3]+r});
    }
    const subjectOf=(i,parent)=>rules?.typedClearance ? kit.copperSubject(i,parent) : null;
    function addTrack(t, points) {
      const l = layerIndex(t.layer); if (l < 0) return;
      const p = points || t.points, r = (t.width || 0) / 2;
      for (let k = 1; k < p.length; k++) capsule(t.net || "", t.id, k - 1, l, l, p[k - 1][0], p[k - 1][1], p[k][0], p[k][1], r, subjectOf(t));
    }
    function addPad(rec,pad,parent){
      const subject=subjectOf({...pad,kind:"pad"},parent), {x,y,holeOnly}=rec;
      if(pad.drill>0&&(holeOnly||rules?.holeClearance))
        capsule(rec.net,rec.id,-1,rec.lo,rec.hi,x,y,x,y,pad.drill/2,{...subject,ck:"hole",mechanical:holeOnly});
      for(const {land,at,angle,mirror,lo,hi} of rec.lands){
        const {core,r}=AtriumResolvedLand.core(land,at,angle,mirror);
        if(core.length>2)polygon(rec.net,rec.id,lo,hi,core,r,subject);
        else capsule(rec.net,rec.id,-1,lo,hi,...core[0],...core.at(-1),r,subject);
      }
    }
    function keepout(i,parent) {
      const all = /^keep-?out/i.test(i.layer||"");
      if ((!all&&!i.keepout)||!i.points?.length)return;
      const lo=all?0:layerIndex(i.layer), hi=all?127:lo;
      if(lo<0)return;
      const pts=parent?i.points.map(p=>globalThis.Atrium.world(p,parent)):i.points, r=(i.width||0)/2;
      if(i.fill&&pts.length>2)polygon("\0keepout",parent?.id||i.id,lo,hi,pts,r);
      else for(let k=1;k<pts.length+(i.closed?1:0);k++)capsule("\0keepout",parent?.id||i.id,k-1,lo,hi,...pts[k-1],...pts[k%pts.length],r);
    }
    for (const i of board.items || []) {
      if (i.keepout || /^keep-?out/i.test(i.layer||"")) {keepout(i);continue;}
      if (i.kind === "track" && Array.isArray(i.points)) {
        if (opts.override?.has(i.id)) continue;
        addTrack(i);
      } else if (i.kind === "via") {
        const lo = i.fromLayer && i.toLayer ? Math.min(layerIndex(i.fromLayer), layerIndex(i.toLayer)) : 0;
        const hi = i.fromLayer && i.toLayer ? Math.max(layerIndex(i.fromLayer), layerIndex(i.toLayer)) : 127;
        capsule(i.net || "", i.id, -1, lo, hi, i.x, i.y, i.x, i.y, (i.diameter || 0) / 2,subjectOf(i));
        if(rules?.holeClearance && i.drill>0)capsule(i.net||"",i.id,-1,lo,hi,i.x,i.y,i.x,i.y,i.drill/2,{...subjectOf(i),ck:"hole"});
      } else if (i.kind === "pad") {
        const rec = padRecord(i, null, i.net || "", -1, copper); if (rec) addPad(rec,i,null);
      } else if (i.kind === "part") {
        const fp = defOf(defs, i.def)?.footprint;
        for (const sh of fp?.shapes||[])keepout(sh,i);
        for (const p of fp?.pads || []) { const rec = padRecord(p, i, i.pinNets?.[p.number] ?? p.net ?? "", 0, copper); if (rec) addPad(rec,p,i); }
      }
    }
    if (opts.override) for (const [, t] of opts.override) addTrack(t, t.points);
    const outline = board.outline || [];
    for (let k = 0; k < outline.length && outline.length >= 3; k++) {
      const a = outline[k], b = outline[(k + 1) % outline.length];
      capsule("\u0000edge", "outline", k, 0, 127, a[0], a[1], b[0], b[1], 0);
    }
    for(const poly of globalThis.AtriumBoardShape?.holes?.(board)||[]) if(poly.length>2)
      polygon("\0edge","cutout",0,127,poly,0);
    let stamp = 1, seen = new Int32Array(list.length + 16);
    function visit(x0, y0, x1, y1, layer, fn) {
      stamp++;
      const gx0 = Math.floor(x0 / cell), gx1 = Math.floor(x1 / cell), gy0 = Math.floor(y0 / cell), gy1 = Math.floor(y1 / cell);
      const test = i => {
        if (seen[i] === stamp) return true; seen[i] = stamp;
        const o = list[i];
        if (o.lo > layer || o.hi < layer || o.dead || o.x1 < x0 || o.x0 > x1 || o.y1 < y0 || o.y0 > y1) return true;
        return fn(o);
      };
      for (const i of cells.get("big") || []) if (!test(i)) return false;
      for (let x = gx0; x <= gx1; x++) for (let y = gy0; y <= gy1; y++) {
        const c = cells.get(x * 1048576 + y); if (!c) continue;
        for (const i of c) if (!test(i)) return false;
      }
      return true;
    }
    function distance(o, ax, ay, bx, by) {
      if (o.kind === 0) return Math.sqrt(segmentDistanceSquared(ax, ay, bx, by, o.ax, o.ay, o.bx, o.by)) - o.r;
      const p = o.poly;
      let inside = false, d = Infinity;
      for (let k=0,j=p.length-1;k<p.length;j=k++) {
        const q=p[j], w=p[k];
        if ((q[1]>ay)!==(w[1]>ay) && ax<(w[0]-q[0])*(ay-q[1])/(w[1]-q[1])+q[0]) inside=!inside;
        d=Math.min(d,Math.sqrt(segmentDistanceSquared(ax,ay,bx,by,...q,...w)));
      }
      return (inside ? 0 : d) - o.r;
    }
    // Clearance callback for one tuned track: skips the tuned segments, trims the
    // adjacent segments of the same track near the shared joint, and keeps other copper
    // of the same net at `gap`.
    function checker(o) {
      const layer = layerIndex(o.layer), net = o.net, memo = new Map();
      const skip = o.skip || new Map(); // id -> Set(seg)
      const near = o.near || new Map(); // id -> Map(seg -> joint point)
      const required = other => {
        if (other === "\u0000edge") return o.edge ?? o.clearance ?? 0.2;
        if (other === net || other === o.partner) return other === net ? o.gap ?? 0 : o.pairGap ?? o.gap ?? 0;
        if (!other) return o.clearance ?? 0.2;
        let v = memo.get(other);
        if (v === undefined) { v = o.clearanceFor ? o.clearanceFor(other) : o.clearance ?? 0.2; memo.set(other, v); }
        return v;
      };
      const maxReq = Math.max(rules?.clearanceMax||0,o.clearance ?? 0.2,o.pairGap||0,o.gap ?? 0,o.edge ?? 0);
      const subject = {kind:"track",ck:"track",net,layer:o.layer,span:[layer,layer]};
      return function clear(ax, ay, bx, by, hw) {
        const m = hw + maxReq;
        subject.width = 2*hw;
        if(rules?.spatialClearance)Object.assign(subject,kit.feature({},[[ax,ay],[bx,by]],hw));
        return visit(Math.min(ax, bx) - m, Math.min(ay, by) - m, Math.max(ax, bx) + m, Math.max(ay, by) + m, layer, ob => {
          if (skip.get(ob.id)?.has(ob.seg)) return true;
          let req;
          if(ob.net==="\0keepout")req=0;
          else if(ob.net===net||ob.net===o.partner||!ob.subject||!rules?.typedClearance)req=required(ob.net);
          else req=rules.clearanceBetween(subject,ob.subject) ?? (ob.subject.ck==="hole"&&!ob.subject.mechanical ? -Infinity : 0);
          const joint = near.get(ob.id)?.get(ob.seg);
          if (joint) {
            // Ignore the part of an adjacent segment within the trim radius of the joint.
            const tr = joint[2], dx = ob.bx - ob.ax, dy = ob.by - ob.ay, L = Math.hypot(dx, dy);
            if (L <= tr) return true;
            const fromA = Math.hypot(ob.ax - joint[0], ob.ay - joint[1]) < 1e-6;
            const t = tr / L, cx = fromA ? ob.ax + dx * t : ob.ax, cy = fromA ? ob.ay + dy * t : ob.ay;
            const ex = fromA ? ob.bx : ob.bx - dx * t, ey = fromA ? ob.by : ob.by - dy * t;
            return Math.sqrt(segmentDistanceSquared(ax, ay, bx, by, cx, cy, ex, ey)) - ob.r - hw >= req - 1e-7;
          }
          return distance(ob, ax, ay, bx, by) - hw >= req - 1e-7;
        });
      };
    }
    // Swap a track's obstacles for new geometry. The id is kept, so callbacks can keep
    // skipping segments of the same track by their new indices.
    function replace(oldId, track, points) {
      for (const i of byId.get(oldId)||[]) {
        buckets(list[i],k=>{const c=cells.get(k),j=c.indexOf(i);c[j]=c[c.length-1];c.pop();if(!c.length)cells.delete(k);});
        list[i]=null;holes.push(i);
      }
      byId.delete(oldId);
      const id=track.id;
      addTrack(track,points);
      if (list.length > seen.length - 1) { const grow = new Int32Array(list.length * 2 + 16); grow.set(seen); seen = grow; }
      return {id, added: byId.get(id)?.length||0};
    }
    return {checker, replace, count: () => list.length};
  }
  function clearanceFor(board, defs, o) {
    const ob = obstacles(board, defs, {box: o.box});
    return ob.checker({...o, clearanceFor: other => clearanceRule(board, o.net, other, o.layer)});
  }

  // ------------------------------------------------------------------ pattern generator
  const STYLES = {
    mitered: {pattern: "trombone", corner: "mitered"}, miteredLines: {pattern: "trombone", corner: "mitered"}, trombone: {pattern: "trombone", corner: "mitered"},
    arcs: {pattern: "trombone", corner: "arc"}, miteredArcs: {pattern: "trombone", corner: "arc"},
    rounded: {pattern: "trombone", corner: "round"},
    accordion: {pattern: "accordion"}, sawtooth: {pattern: "sawtooth", corner: "square"}
  };
  const STYLE_NAMES = {accordion: "Accordion", trombone: "Trombone", sawtooth: "Sawtooth", mitered: "Mitered lines", arcs: "Mitered arcs", rounded: "Rounded"};
  // Sawtooth rounding: 0–50 % in 5 % steps. 50 % rounds every tooth corner fully.
  const ROUNDINGS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
  const roundingOf = v => { const n = +v; return Number.isFinite(n) ? Math.max(0, Math.min(50, Math.round(n / 5) * 5)) : 0; };
  function config(seg, o) {
    const w = seg.width > 0 ? seg.width : 0.15, st = STYLES[o.style] || STYLES.mitered;
    const pattern = o.pattern || st.pattern, corner = o.corner || st.corner || "mitered";
    const gap = o.gap > 0 ? o.gap : Math.max(2 * w, 0.2);
    const s = Math.max(o.pitch || 0, gap + w);
    const single = pattern === "trombone" && (o.style === "trombone" || o.pattern === "trombone");
    const bounded = single || pattern === "accordion";
    const maxA = o.maxAmplitude > 0 ? o.maxAmplitude : bounded && o.amplitude > 0 ? o.amplitude : Math.max(o.amplitude || 0, 4 * s);
    const amp = Math.min(maxA, o.amplitude > 0 ? o.amplitude : Math.max(2 * s, 1));
    const sides = pattern === "accordion" && (o.sides === 2 || o.sides === "double") ? 2 : (o.sides === 2 && pattern !== "accordion" ? 2 : 1);
    const minA = o.minAmplitude >= 0 && o.minAmplitude != null ? o.minAmplitude : Math.min(amp, Math.max(s / 2, w));
    return {w, hw: w / 2, gap, s, amp, maxA, minA, pattern, single, corner, sides, side: o.side < 0 ? -1 : 1,
      miter: o.miter != null ? Math.max(0, Math.min(1, o.miter)) : 0.5, slant: o.slant != null ? o.slant : 0.5,
      lead: o.lead != null ? o.lead : s, minSetback: o.minSetback || 0, arcStep: o.arcStep || Math.PI / 12,
      align: o.align || "center", reverse: !!o.reverse, clear: o.clearanceFn || null, pairHalf: o.pairHalf || 0,
      tolerance: o.tolerance != null ? o.tolerance : 0.005, bumpWidth: o.bumpWidth > 0 ? o.bumpWidth : 0,
      rounding: pattern === "sawtooth" ? roundingOf(o.rounding) / 100 : 0};
  }
  // Excursion slots along a baseline window [t0, t1] (mm from the segment start).
  function slots(t0, t1, c) {
    const top = c.bumpWidth || c.s, r = c.pattern === "sawtooth" ? c.slant * c.s : 0, foot = top + 2 * r;
    const base = c.sides === 2 && c.pattern === "accordion" ? 0 : c.s, stride = foot + base;
    const lo = Math.min(t0, t1) + c.lead, hi = Math.max(t0, t1) - c.lead, usable = hi - lo;
    const n = usable >= foot ? Math.floor((usable + base) / stride + 1e-9) : 0, out = [];
    const span = n ? n * stride - base : 0;
    for (let i = 0; i < n; i++) {
      let x0;
      if (c.align === "center") x0 = lo + (usable - span) / 2 + i * stride;
      else if (c.reverse) x0 = hi - foot - i * stride;
      else x0 = lo + i * stride;
      const side = c.sides === 2 && !c.single ? (i % 2 ? -c.side : c.side) : c.side;
      out.push({x0, x1: x0 + foot, r, side, cap: undefined});
    }
    if (c.align === "center") { const mid = (lo + hi) / 2; out.sort((p, q) => Math.abs(p.x0 + foot / 2 - mid) - Math.abs(q.x0 + foot / 2 - mid)); }
    return out;
  }
  // Skeleton of the excursions in local coordinates (x along the segment, y to the left).
  function skeleton(L, ex, amps) {
    const pts = [[0, 0]];
    const order = ex.map((e, i) => i).filter(i => amps[i] > 1e-9).sort((a, b) => ex[a].x0 - ex[b].x0);
    let lastX = 0, lastY = 0;
    for (const i of order) {
      const e = ex[i], y = e.side * amps[i];
      if (Math.abs(e.x0 - lastX) > 1e-9 || lastY === 0) { if (lastY !== 0) pts.push([lastX, 0]); pts.push([e.x0, 0]); }
      if (e.r > 0) { pts.push([e.x0 + e.r, y], [e.x1 - e.r, y], [e.x1, 0]); lastY = 0; }
      else { pts.push([e.x0, y], [e.x1, y]); lastY = y; }
      lastX = e.x1;
    }
    if (lastY !== 0) pts.push([lastX, 0]);
    pts.push([L, 0]);
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) { const p = pts[i], q = out[out.length - 1]; if (Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9) out.push(p); }
    return out;
  }
  // Mitered, arc or round corners at every interior vertex. Each segment lends at most
  // half its length to each end, the first and last (baseline) segments all of it.
  // A coupled pair cannot turn through a radius smaller than half its pitch.
  // On a shallow excursion two tangent arcs turn less than 90° and meet
  // without a vertical leg. The inner track then stays forward along every arc.
  function pairArcs(pts, c) {
    const out = [pts[0]];
    for (let i = 1; i + 2 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (Math.abs(b[0] - a[0]) > 1e-9) continue;
      const x = a[0], rise = Math.abs(b[1] - a[1]), sign = Math.sign(b[1] - a[1]);
      const room = Math.min((x - pts[i - 1][0]) / (i === 1 ? 1 : 2),
        (pts[i + 2][0] - x) / (i + 2 === pts.length - 1 ? 1 : 2), c.s / 2) - c.pairHalf * Math.tan(c.arcStep / 4);
      const wanted = Math.min(room, rise / 2) * (c.corner === "round" ? 1 : c.miter);
      const radius = Math.min(room, Math.max(c.pairHalf * 1.1, wanted));
      if (radius <= 0) continue;
      const angle = Math.acos(Math.max(0, 1 - rise / (2 * radius)));
      // A fixed subdivision keeps the length continuous as the solver varies the rise.
      const dx = radius * Math.sin(angle), steps = Math.max(2, Math.ceil(Math.PI / (2 * c.arcStep)));
      const first = [];
      for (let k = 0; k <= steps; k++) {
        const t = angle * k / steps;
        first.push([x - dx + radius * Math.sin(t), a[1] + sign * radius * (1 - Math.cos(t))]);
      }
      out.push(...first);
      for (let k = steps; k >= 0; k--) out.push([2 * x - first[k][0], a[1] + b[1] - first[k][1]]);
    }
    out.push(pts.at(-1));
    return dedupe(out);
  }
  function cornered(pts, c) {
    const rr = c.rounding > 0;
    if (c.corner === "square" && !c.minSetback && !rr || pts.length < 3) return pts;
    if (c.pairHalf && c.pattern !== "sawtooth" && (c.corner === "arc" || c.corner === "round")) return pairArcs(pts, c);
    const n = pts.length, len = new Float64Array(n - 1), dx = new Float64Array(n - 1), dy = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) { const x = pts[i + 1][0] - pts[i][0], y = pts[i + 1][1] - pts[i][1], l = Math.hypot(x, y); len[i] = l; dx[i] = x / l; dy[i] = y / l; }
    const out = [pts[0]];
    for (let i = 1; i < n - 1; i++) {
      const cos = dx[i - 1] * dx[i] + dy[i - 1] * dy[i], cross = dx[i - 1] * dy[i] - dy[i - 1] * dx[i];
      const theta = Math.atan2(Math.abs(cross), cos);
      if (theta < 1e-6) continue;
      // The two offsets of a mitered pair each consume h·tan(22.5°)
      // at a 45° turn. Leave that space at either end of a return leg.
      const reserve = c.pairHalf * (Math.SQRT2 - 1);
      const lend = k => {
        const end = k === 0 || k === n - 2;
        const share = end ? len[k] : len[k] / 2;
        return Math.max(0, share - (Math.abs(dy[k]) < 1e-8 ? reserve : 0));
      };
      const avail = Math.min(lend(i - 1), lend(i), c.s / 2);
      const P = pts[i];
      let t = c.corner === "round" ? avail : c.corner === "square" ? 0 : c.miter * avail;
      t = Math.min(avail, Math.max(t, c.minSetback));
      if (rr) {
        // Tooth corners: the setback is the rounding fraction of the shorter tooth edge
        // (both halves at 50 %), drawn as an arc whatever the corner style.
        const tooth = Math.min(i - 1 === 0 ? Infinity : len[i - 1] / 2, i === n - 2 ? Infinity : len[i] / 2);
        t = Math.min(Number.isFinite(tooth) ? tooth : avail, 2 * c.rounding * (Number.isFinite(tooth) ? tooth : avail));
      }
      if (t <= 1e-9) { out.push(P); continue; }
      const T1 = [P[0] - dx[i - 1] * t, P[1] - dy[i - 1] * t], T2 = [P[0] + dx[i] * t, P[1] + dy[i] * t];
      if (!rr && (c.corner === "mitered" || c.corner === "square")) { out.push(T1, T2); continue; }
      const r = t / Math.tan(theta / 2), sgn = cross > 0 ? 1 : -1;
      const cx = T1[0] - dy[i - 1] * r * sgn, cy = T1[1] + dx[i - 1] * r * sgn;
      const a0 = Math.atan2(T1[1] - cy, T1[0] - cx), steps = Math.max(2, Math.ceil(theta / c.arcStep));
      out.push(T1);
      for (let k = 1; k < steps; k++) { const a = a0 + sgn * theta * k / steps; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      out.push(T2);
    }
    out.push(pts[n - 1]);
    return dedupe(out);
  }
  function frame(a, b) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    return {L, ux, uy, vx: -uy, vy: ux, toWorld: (x, y) => [a[0] + ux * x - uy * y, a[1] + uy * x + ux * y]};
  }
  // Largest amplitude in [0, maxA] at which one excursion's skeleton is clear.
  function capOf(e, f, c) {
    if (!c.clear) return c.maxA;
    const test = A => {
      const y = e.side * A, pts = e.r > 0 ? [[e.x0, 0], [e.x0 + e.r, y], [e.x1 - e.r, y], [e.x1, 0]] : [[e.x0, Math.sign(y) * Math.min(Math.abs(y), c.hw)], [e.x0, y], [e.x1, y], [e.x1, Math.sign(y) * Math.min(Math.abs(y), c.hw)]];
      for (let k = 1; k < pts.length; k++) {
        const p = f.toWorld(pts[k - 1][0], pts[k - 1][1]), q = f.toWorld(pts[k][0], pts[k][1]);
        if (!c.clear(p[0], p[1], q[0], q[1], c.hw + c.pairHalf)) return false;
      }
      return true;
    };
    if (test(c.maxA)) return c.maxA;
    let lo = 0, hi = c.maxA;
    if (!test(c.minA)) return 0;
    lo = c.minA;
    for (let k = 0; k < 14 && hi - lo > 0.002; k++) { const m = (lo + hi) / 2; if (test(m)) lo = m; else hi = m; }
    return lo;
  }
  // Fit amplitudes to add `need` mm. Returns {amps, extra}.
  function solve(ex, need, f, c, extraOf) {
    const n = ex.length, caps = ex.map(e => e.cap);
    const ampAt = (i, A) => { const v = Math.min(A, caps[i]); return v >= c.minA - 1e-12 ? v : 0; };
    const vec = (k, A, last) => { const a = new Array(n).fill(0); for (let i = 0; i < k; i++) a[i] = ampAt(i, A); if (last != null && k) a[k - 1] = Math.min(last, caps[k - 1]); return a; };
    const total = a => extraOf(a);
    if (need <= c.tolerance * 0.5 || !n) return {amps: new Array(n).fill(0), extra: 0};
    const vec1 = v => { const a = new Array(n).fill(0); a[0] = v; return a; };
    const bisect = (lo, hi, fn) => { for (let i = 0; i < 40 && hi - lo > 1e-6; i++) { const m = (lo + hi) / 2; if (fn(m) < need) lo = m; else hi = m; } return hi; };
    // A residual smaller than one bump at minAmplitude: one lower bump hits it exactly.
    if (caps[0] > 0 && extraOf(vec1(Math.min(c.minA, caps[0]))) >= need) {
      const x = bisect(0, Math.min(c.minA, caps[0]), v => extraOf(vec1(v)));
      const a = vec1(x); return {amps: a, extra: total(a)};
    }
    const minimalK = A => { let lo = 1, hi = n; if (total(vec(n, A)) < need) return -1; while (lo < hi) { const m = (lo + hi) >> 1; if (total(vec(m, A)) >= need) hi = m; else lo = m + 1; } return lo; };
    if (c.pattern === "trombone") {
      const k = minimalK(c.maxA);
      if (k < 0) { const a = vec(n, c.maxA); return {amps: a, extra: total(a)}; }
      const lowest = total(vec(k, c.minA));
      if (lowest > need) return closest(need, [vec(k, c.minA), k > 1 ? vec(k - 1, c.maxA) : new Array(n).fill(0)], total);
      const A = bisect(c.minA, c.maxA, A => total(vec(k, A)));
      const a = vec(k, A); return {amps: a, extra: total(a)};
    }
    // accordion / sawtooth: fixed amplitude, count grows, the last excursion trims.
    let k = minimalK(c.amp);
    if (k < 0) {
      if (total(vec(n, c.maxA)) < need) { const a = vec(n, c.maxA); return {amps: a, extra: total(a)}; }
      const A = bisect(c.amp, c.maxA, A => total(vec(n, A)));
      const a = vec(n, A); return {amps: a, extra: total(a)};
    }
    const full = ampAt(k - 1, c.amp);
    const last = bisect(0, full, x => total(vec(k, c.amp, x)));
    if (last >= c.minA - 1e-9) { const a = vec(k, c.amp, last); return {amps: a, extra: total(a)}; }
    if (k > 1 && total(vec(k - 1, c.maxA)) >= need) {
      const A = bisect(c.amp, c.maxA, A => total(vec(k - 1, A)));
      const a = vec(k - 1, A); return {amps: a, extra: total(a)};
    }
    if (total(vec(k, c.minA)) <= need) {
      const A = bisect(c.minA, c.amp, A => total(vec(k, A)));
      const a = vec(k, A); return {amps: a, extra: total(a)};
    }
    return closest(need, [vec(k, c.minA), vec(k - 1, c.amp)], total);
  }
  function closest(need, options, total) {
    let best = null;
    for (const a of options) { const e = total(a); if (!best || Math.abs(e - need) < Math.abs(best.extra - need)) best = {amps: a, extra: e}; }
    return best;
  }
  // Insert a meander into one straight segment {a, b, width, length?} (length: the current
  // measured length that the target refers to). Returns the replacement polyline a..b.
  function tune(segment, opts = {}) {
    const t0 = now();
    const a = segment.a, b = segment.b, f = frame(a, b), c = config(segment, opts);
    const current = segment.length != null ? segment.length : f.L;
    const need = opts.extra != null ? opts.extra : opts.target != null ? opts.target - current : 0;
    const win = (opts.window || [0, f.L]).map(x => Math.max(0, Math.min(f.L, x)));
    if (c.single && !(opts.amplitude > 0 || opts.maxAmplitude > 0)) c.maxA = Math.max(c.maxA, need / 2 + c.s);
    let ex = need > 0 ? slots(win[0], win[1], c) : [];
    const memo = opts.capCache;
    for (const e of ex) {
      const key = memo ? Math.round(e.x0 * 1e4) + ":" + e.side : null;
      e.cap = memo?.has(key) ? memo.get(key) : capOf(e, f, c);
      if (memo) memo.set(key, e.cap);
    }
    // A trombone is one adjustable U. Prefer the first position with room for
    // the target, otherwise use the position with the most clearance.
    if (c.single && ex.length) {
      let best = ex[0];
      for (const e of ex) {
        if (e.cap > best.cap) best = e;
        if (e.cap > 0 && polyLength(cornered(skeleton(f.L, [e], [e.cap]), c)) - f.L >= need) { best = e; break; }
      }
      ex = [best];
    }
    const local = amps => cornered(skeleton(f.L, ex, amps), c);
    const extraOf = amps => polyLength(local(amps)) - f.L;
    let sol = solve(ex, need, f, c, extraOf), pts = local(sol.amps), violations = 0;
    // Verify the generated copper against the callback; shrink offending excursions.
    for (let round = 0; c.clear && round < 4; round++) {
      const bad = verify(pts, f, c, ex, sol.amps);
      if (!bad.size) break;
      violations++;
      for (const i of bad) ex[i].cap = sol.amps[i] > c.minA ? Math.max(0, sol.amps[i] * 0.8) : 0;
      sol = solve(ex, need, f, c, extraOf); pts = local(sol.amps);
      if (round === 3 && verify(pts, f, c, ex, sol.amps).size) { sol.amps.fill(0); pts = local(sol.amps); }
    }
    const world = pts.map(([x, y]) => { const p = f.toWorld(x, y); return [round6(p[0]), round6(p[1])]; });
    world[0] = [...a]; world[world.length - 1] = [...b];
    const added = polyLength(world) - f.L, length = current + added;
    const used = sol.amps.filter(v => v > 0);
    return {points: world, local: pts, added, length, target: opts.target ?? current + need, need,
      reached: Math.abs(added - need) <= Math.max(c.tolerance, 1e-4) || need <= 0, shortfall: Math.max(0, need - added),
      excursions: used.length, amplitude: used.length ? Math.max(...used) : 0, slots: ex.length, capped: ex.filter(e => e.cap < c.amp - 1e-9).length,
      pitch: c.s, gap: c.gap, style: opts.style || "mitered", pattern: c.pattern, corner: c.corner, ms: (now()) - t0, retries: violations};
  }
  function verify(pts, f, c, ex, amps) {
    const bad = new Set(); if (!c.clear) return bad;
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k - 1], q = pts[k];
      if (Math.abs(p[1]) < 1e-9 && Math.abs(q[1]) < 1e-9) continue;
      {
        const P = f.toWorld(p[0], p[1]), Q = f.toWorld(q[0], q[1]);
        if (c.clear(P[0], P[1], Q[0], Q[1], c.hw + c.pairHalf)) continue;
        const mid = (p[0] + q[0]) / 2;
        let best = -1, bd = Infinity;
        ex.forEach((e, i) => { if (amps[i] <= 0) return; const d = mid < e.x0 ? e.x0 - mid : mid > e.x1 ? mid - e.x1 : 0; if (d < bd) { bd = d; best = i; } });
        if (best >= 0) bad.add(best);
      }
    }
    return bad;
  }
  // Polyline offset with miter joins (positive = left of travel).
  function offset(pts, d) {
    const n = pts.length, out = [];
    const nrm = i => { const x = pts[i + 1][0] - pts[i][0], y = pts[i + 1][1] - pts[i][1], l = Math.hypot(x, y) || 1; return [-y / l, x / l]; };
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1) { const m = nrm(i === 0 ? 0 : n - 2); out.push([pts[i][0] + m[0] * d, pts[i][1] + m[1] * d]); continue; }
      const m1 = nrm(i - 1), m2 = nrm(i), k = 1 + m1[0] * m2[0] + m1[1] * m2[1];
      out.push([pts[i][0] + (m1[0] + m2[0]) * d / k, pts[i][1] + (m1[1] + m2[1]) * d / k]);
    }
    return out;
  }
  // Tune a coupled pair together. p and n are segments {a, b, width, length}; the pattern is
  // generated on their centreline and offset back, so the pair gap is kept on every leg.
  function tunePair(p, n, opts = {}) {
    const fp = frame(p.a, p.b), u = [fp.ux, fp.uy];
    const proj = q => (q[0] - p.a[0]) * u[0] + (q[1] - p.a[1]) * u[1];
    const across = q => (q[0] - p.a[0]) * fp.vx + (q[1] - p.a[1]) * fp.vy;
    const nA = proj(n.a), nB = proj(n.b), lo = Math.max(0, Math.min(nA, nB)), hi = Math.min(fp.L, Math.max(nA, nB));
    const sep = (across(n.a) + across(n.b)) / 2, d = Math.abs(sep), h = d / 2;
    if (hi - lo <= 0 || d < 1e-6 || Math.abs(across(n.a) - across(n.b)) > 1e-5) return {ok: false, reason: "The two tracks do not run side by side."};
    const w = Math.max(p.width || 0.15, n.width || 0.15), pairGap = d - ((p.width || .15) + (n.width || .15)) / 2;
    const gap = opts.gap > 0 ? opts.gap : Math.max(2 * w, pairGap * 2);
    const ca = [p.a[0] + u[0] * lo + fp.vx * sep / 2, p.a[1] + u[1] * lo + fp.vy * sep / 2];
    const cb = [p.a[0] + u[0] * hi + fp.vx * sep / 2, p.a[1] + u[1] * hi + fp.vy * sep / 2];
    const lp = p.length ?? fp.L, ln = n.length ?? Math.hypot(n.b[0] - n.a[0], n.b[1] - n.a[1]);
    const current = (lp + ln) / 2, need = opts.extra != null ? opts.extra : (opts.target ?? current) - current;
    const corner = opts.corner || STYLES[opts.style]?.corner || "mitered";
    const center = tune({a: ca, b: cb, width: w, length: current}, {...opts, window: opts.window?.map(x => x - lo), extra: need, target: undefined, pitch: d + w + gap, gap: d + gap,
      minSetback: corner === "square" ? 0 : h * 1.2, pairHalf: h, clearanceFn: opts.clearanceFn, tolerance: opts.tolerance,
      minAmplitude: opts.minAmplitude ?? Math.max(d + w + gap, h * 3)});
    // Adjacent bevels can meet on the same diagonal. A redundant vertex there
    // makes the adjacent offset appear to double back on shallow excursions.
    const guide = [];
    for (const q of center.local) {
      const i = guide.length;
      if (i >= 2) {
        const a = guide[i - 2], b = guide[i - 1];
        if (Math.abs(orient(...a, ...b, ...q)) < 1e-9 && (q[0] - b[0]) * (b[0] - a[0]) + (q[1] - b[1]) * (b[1] - a[1]) >= 0) guide.pop();
      }
      guide.push(q);
    }
    const pSide = sep > 0 ? -1 : 1; // p lies on the right of the centreline when n is to its left
    const pPath = offset(guide, pSide * h), nPath = offset(guide, -pSide * h);
    for (const line of [pPath, nPath]) for (let i = 1; i < line.length; i++) {
      const dx = guide[i][0] - guide[i - 1][0], dy = guide[i][1] - guide[i - 1][1];
      if ((line[i][0] - line[i - 1][0]) * dx + (line[i][1] - line[i - 1][1]) * dy < -1e-9)
        return {ok: false, reason: "There is too little room for the inner differential track at this corner."};
    }
    const f2 = frame(ca, cb);
    // Join the offset pattern to a track's own ends: replace the end point when the track
    // starts at the coupled window, otherwise keep the uncoupled stub before it.
    const join = (pts, A, B, startProj, endProj) => {
      const out = pts.map(([x, y]) => { const q = f2.toWorld(x, y); return [round6(q[0]), round6(q[1])]; });
      if (startProj < lo - 1e-6) out.unshift([...A]); else out[0] = [...A];
      if (endProj > hi + 1e-6) out.push([...B]); else out[out.length - 1] = [...B];
      return dedupe(out);
    };
    const pFinal = join(pPath, p.a, p.b, 0, fp.L);
    const flip = nA > nB, nOrdered = flip ? {a: n.b, b: n.a} : n;
    const nPts = join(nPath, nOrdered.a, nOrdered.b, Math.min(nA, nB), Math.max(nA, nB));
    if (flip) nPts.reverse();
    if (opts.clearanceFn) for (const [line, track] of [[pFinal, p], [nPts, n]]) {
      // A miter's outside vertex can extend past the centreline's envelope.
      // Recheck every displaced copper segment at its own width, after rounding.
      const hw = (track.width || .15) / 2;
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        if (segPoint2(...a, ...track.a, ...track.b) < 1e-12 && segPoint2(...b, ...track.a, ...track.b) < 1e-12) continue;
        if (!opts.clearanceFn(...a, ...b, hw)) return {ok: false, reason: "The tuned pair would enter the copper clearance."};
      }
    }
    const addedP = polyLength(pFinal) - fp.L, addedN = polyLength(nPts) - Math.hypot(n.b[0] - n.a[0], n.b[1] - n.a[1]);
    return {ok: true, p: pFinal, n: nPts, addedP, addedN, lengthP: lp + addedP, lengthN: ln + addedN, length: current + (addedP + addedN) / 2,
      skew: (lp + addedP) - (ln + addedN), need, reached: Math.abs((addedP + addedN) / 2 - need) <= Math.max(opts.tolerance ?? 0.01, 0.01),
      shortfall: Math.max(0, need - (addedP + addedN) / 2), pairGap, center: center.points, excursions: center.excursions, amplitude: center.amplitude, ms: center.ms};
  }
  function dedupe(pts) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i][0] - out[out.length - 1][0], pts[i][1] - out[out.length - 1][1]) > 1e-7) out.push(pts[i]);
    if (out.length > 1 && pts.length > 1) out[out.length - 1] = pts[pts.length - 1];
    return out;
  }
  // Intra-pair skew: small bumps on the outer side of the shorter track only. The added
  // uncoupled length (each bump's footprint) stays within maxUncoupled - uncoupledUsed.
  function tuneSkew(short, partnerSide, opts = {}) {
    const w = short.width || 0.15, pg = opts.pairGap > 0 ? opts.pairGap : w;
    const budget = opts.maxUncoupled != null ? Math.max(0, opts.maxUncoupled - (opts.uncoupledUsed || 0)) : Infinity;
    const amp = opts.amplitude > 0 ? opts.amplitude : Math.max(w + pg, 2 * w);
    const top = opts.bumpWidth > 0 ? opts.bumpWidth : Math.max(w + pg, 2 * w);
    const corner = opts.corner || "mitered", need = opts.extra ?? 0;
    const foot = top + 2 * Math.max(0, opts.slant ?? 0.5) * (pg + w);
    let maxBumps = Number.isFinite(budget) ? Math.floor(budget / (foot + 2 * amp) + 1e-9) : Infinity;
    const f = frame(short.a, short.b), win = opts.window || [0, f.L];
    if (maxBumps < 1) return {...tune(short, {extra: 0}), reason: "The uncoupled length limit leaves no room for skew bumps.", uncoupled: 0};
    if (Number.isFinite(maxBumps)) {
      const stride = foot + (pg + w), span = maxBumps * stride;
      const mid = (win[0] + win[1]) / 2; win[0] = Math.max(win[0], mid - span / 2 - w - pg); win[1] = Math.min(win[1], mid + span / 2 + w + pg);
    }
    const r = tune(short, {...opts, extra: need, target: undefined, style: "sawtooth", pattern: "sawtooth", corner, side: -partnerSide,
      amplitude: amp, maxAmplitude: opts.maxAmplitude ?? amp * 1.5, minAmplitude: opts.minAmplitude ?? Math.min(amp, w * 0.5), gap: pg, pitch: pg + w,
      bumpWidth: top, slant: opts.slant ?? 0.5, lead: opts.lead ?? (pg + w), window: win, align: "center"});
    return {...r, uncoupled: r.excursions * (foot + 2 * r.amplitude)};
  }

  // ------------------------------------------------------------------ net-level helpers
  function trackById(board, id) { return (board.items || []).find(i => i.id === id && i.kind === "track"); }
  function segmentOf(track, k) { return {a: track.points[k], b: track.points[k + 1], width: track.width, layer: track.layer, net: track.net, trackId: track.id, index: k}; }
  function nearestSegment(tracks, p) {
    let best = null, bd = Infinity;
    for (const t of tracks) for (let k = 1; k < t.points.length; k++) {
      const d = segPoint2(p[0], p[1], t.points[k - 1][0], t.points[k - 1][1], t.points[k][0], t.points[k][1]);
      if (d < bd) { bd = d; best = {track: t, k: k - 1}; }
    }
    return best;
  }
  // Straight segments that carry the measured path, longest first.
  function candidateSegments(board, defs, net, opts = {}) {
    const s = ensure(board, defs, opts), g = graphOf(s, net), r = lookup(s, net, opts);
    if (!g) return [];
    const seen = new Set(), out = [];
    for (const seg of r.segments.length ? r.segments : g.st.map((_, i) => i)) {
      const t = g.tracks[g.st[seg]], k = g.sk[seg], key = t.id + ":" + k;
      if (seen.has(key)) continue; seen.add(key);
      const a = t.points[k], b = t.points[k + 1];
      out.push({track: t, k, length: Math.hypot(b[0] - a[0], b[1] - a[1])});
    }
    return out.sort((x, y) => y.length - x.length);
  }
  function trackPlan(track, k, pts) {
    const points = [...track.points.slice(0, k).map(p => [...p]), ...pts, ...track.points.slice(k + 2).map(p => [...p])];
    return {id: track.id, set: {points}};
  }
  // Apply an edit plan to the board (call inside ctx.edit).
  function applyPlan(board, plan) {
    if (!plan) return;
    const byId = new Map((board.items || []).map(i => [i.id, i]));
    for (const m of plan.modify || []) { const i = byId.get(m.id); if (i) Object.assign(i, JSON.parse(JSON.stringify(m.set))); }
    if (plan.remove?.length) { const gone = new Set(plan.remove); board.items = board.items.filter(i => !gone.has(i.id)); }
    for (const i of plan.add || []) board.items.push(JSON.parse(JSON.stringify(i)));
    invalidate(board);
  }
  // Tune one net to `target` using its longest straight segments.
  function tuneNet(board, defs, net, opts = {}) {
    const t0 = now();
    const r = netLength(board, defs, net, opts), target = opts.target;
    const byDelay = Number.isFinite(opts.extraDelay), tol = byDelay ? opts.delayTolerance ?? .05 : opts.tolerance ?? .01;
    if (!byDelay && target == null) return {net, ok: false, reason: "No target"};
    const need = byDelay ? opts.extraDelay : target - r.length - (opts.currentOffset || 0);
    if (r.unrouted) return {net, ok: false, reason: "Net is not fully routed", need};
    if (need <= tol / 2) return {net, ok: need >= -tol, reason: need < 0 ? "Longer than target" : "", need, plan: {add: [], remove: [], modify: []}};
    const index = opts.index || obstacles(board, defs, {});
    const segs = candidateSegments(board, defs, net, opts).slice(0, opts.maxSegments || 8);
    const work = new Map(); // track id -> {track, points}
    const rate = byDelay ? opts.delayRates || delayRates(board, defs, opts) : null;
    const maxLength = byDelay ? lengthRule(board, net)?.max ?? Infinity : Infinity;
    let added = 0, progress = 0, last = null;
    // Segments of one track are tuned from the highest index down, so earlier indices stay valid.
    const chosen = [];
    for (const sg of segs) {
      if (sg.length < 3 * (opts.gap || 0.3)) continue;
      chosen.push(sg);
    }
    for (const sg of chosen) {
      if (need - progress <= tol / 2) break;
      const entry = work.get(sg.track.id) || {track: sg.track, points: sg.track.points.map(p => [...p]), offsets: [], live: sg.track.id};
      // Index shift from earlier replacements on lower segment indices of this track.
      let k = sg.k; for (const o of entry.offsets) if (o.k < sg.k) k += o.extra;
      const a = entry.points[k], b = entry.points[k + 1], trim = (opts.gap || 0.3) * 3;
      const skip = new Map([[entry.live, new Set([k])]]);
      const near = new Map([[entry.live, new Map([[k - 1, [a[0], a[1], trim]], [k + 1, [b[0], b[1], trim]]])]]);
      const layer = sg.track.layer;
      const check = index.checker({net, layer, clearance: clearanceRule(board, net, "", layer), gap: opts.gap ?? Math.max(2 * (sg.track.width || 0.15), 0.2),
        clearanceFor: other => clearanceRule(board, net, other, layer), skip, near, partner: opts.partner});
      const perMm = rate ? rate(net, layer, sg.track.width) : 1;
      const extra = Math.min((need - progress) / perMm, maxLength - r.length - added);
      if (extra <= 0) break;
      const pattern = {...opts, extra, tolerance: tol / perMm, target: undefined, clearanceFn: check, align: "center"};
      let res = tune({a, b, width: sg.track.width, length: 0}, pattern);
      if (!res.reached && opts.side == null) {
        const other = tune({a, b, width: sg.track.width, length: 0}, {...pattern, side: -1});
        if (other.added > res.added + 1e-6) res = other;
      }
      if (res.added <= 1e-6) continue;
      added += res.added; progress += res.added * perMm; last = res;
      const inner = res.points.slice(1, -1);
      entry.points.splice(k + 1, 0, ...inner);
      entry.offsets.push({k: sg.k, extra: inner.length});
      entry.live = index.replace(entry.live, sg.track, entry.points).id;
      work.set(sg.track.id, entry);
    }
    const modify = [...work.values()].map(e => ({id: e.track.id, set: {points: e.points}}));
    const reached = Math.abs(need - progress) <= Math.max(tol, 1e-5);
    return {net, ok: reached, need, added, length: r.length + added, target, plan: {add: [], remove: [], modify},
      reason: reached ? "" : added > 0 ? "Not enough clear space: " + (need - progress).toFixed(3) + (byDelay ? " ps" : " mm") + " short" : "No straight segment with room for a pattern",
      shortfall: Math.max(0, need - progress), ms: (now()) - t0, style: last?.style};
  }

  // Straight segments of `mine` running beside a segment of `theirs` on the same layer,
  // longest overlap first: {track, k, other, ok, len, side (+1: partner on the left), gap}.
  function coupledSegments(board, mine, theirs, layer) {
    const items = board.items || [], out = [];
    const own = items.filter(i => i.kind === "track" && i.net === mine && (!layer || i.layer === layer) && i.points?.length > 1);
    const byLayer = new Map();
    for (const i of items) if (i.kind === "track" && i.net === theirs && i.points?.length > 1) { if (!byLayer.has(i.layer)) byLayer.set(i.layer, []); byLayer.get(i.layer).push(i); }
    for (const t of own) {
      const other = byLayer.get(t.layer); if (!other) continue;
      for (let j = 1; j < t.points.length; j++) {
        const a = t.points[j - 1], b = t.points[j], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-6) continue;
        const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
        let best = null;
        for (const o of other) for (let m = 1; m < o.points.length; m++) {
          const q0 = o.points[m - 1], q1 = o.points[m], ql = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
          if (ql < 1e-6 || Math.abs(ux * (q1[1] - q0[1]) - uy * (q1[0] - q0[0])) / ql > 0.05) continue;
          const dist = Math.abs((q0[0] - a[0]) * -uy + (q0[1] - a[1]) * ux), w = ((t.width || 0.15) + (o.width || 0.15)) / 2;
          if (dist > 4 * w + 1) continue;
          const p0 = (q0[0] - a[0]) * ux + (q0[1] - a[1]) * uy, p1 = (q1[0] - a[0]) * ux + (q1[1] - a[1]) * uy;
          const overlap = Math.min(len, Math.max(p0, p1)) - Math.max(0, Math.min(p0, p1));
          if (overlap > 0 && (!best || overlap > best.overlap + 1e-9 || Math.abs(overlap - best.overlap) <= 1e-9 && dist < best.dist))
            best = {o, m, overlap, dist, w, side: Math.sign((q0[0] - a[0]) * -uy + (q0[1] - a[1]) * ux) || 1};
        }
        if (!best) continue;
        const ns = {track: best.o, k: best.m - 1}, overlap = best.overlap, dist = best.dist, w = best.w, q0 = best.o.points[best.m - 1];
        out.push({track: t, k: j - 1, other: ns.track, ok: ns.k, len: overlap, side: Math.sign((q0[0] - a[0]) * -uy + (q0[1] - a[1]) * ux) || 1, gap: dist - w});
      }
    }
    return out.sort((x, y) => y.len - x.len);
  }
  function pairChecker(board, index, c, mine, theirs, gap, both) {
    const trim = (gap || 0.3) * 3, t = c.track, o = c.other;
    const skip = new Map([[t.id, new Set([c.k])]]), near = new Map([[t.id, new Map([[c.k - 1, [...t.points[c.k], trim]], [c.k + 1, [...t.points[c.k + 1], trim]]])]]);
    if (both) { skip.set(o.id, new Set([c.ok])); near.set(o.id, new Map([[c.ok - 1, [...o.points[c.ok], trim]], [c.ok + 1, [...o.points[c.ok + 1], trim]]])); }
    return index.checker({net: mine, partner: theirs, pairGap: Math.max(0, c.gap - 1e-6), layer: t.layer, clearance: clearanceRule(board, mine, "", t.layer),
      gap: gap ?? Math.max(2 * (t.width || 0.15), 0.2), skip, near, clearanceFor: other => clearanceRule(board, mine, other, t.layer)});
  }
  // Lengthen both nets of a pair together on their longest coupled run.
  function tunePairNets(board, defs, index, P, N, need, opts = {}) {
    for (const c of coupledSegments(board, P, N)) {
      if (c.len < 4 * ((c.track.width || 0.15) * 2 + c.gap + (opts.gap || 0.3))) continue;
      const check = pairChecker(board, index, c, P, N, opts.gap, true);
      const extra = typeof need === "function" ? need(c.track, c.other) : need;
      if (!(extra > 0)) continue;
      const r = tunePair(segmentOf(c.track, c.k), segmentOf(c.other, c.ok), {...opts, extra, target: undefined, clearanceFn: check, align: "center"});
      if (!r.ok || (r.addedP + r.addedN) / 2 <= 1e-6) continue;
      return {r, modify: [trackPlan(c.track, c.k, r.p), trackPlan(c.other, c.ok, r.n)], tracks: [c.track, c.other], addedP: r.addedP, addedN: r.addedN};
    }
    return null;
  }
  // Intra-pair skew: bumps on the shorter net, away from its partner.
  function skewNets(board, defs, index, shortNet, longNet, need, opts = {}) {
    for (const c of coupledSegments(board, shortNet, longNet)) {
      const check = pairChecker(board, index, c, shortNet, longNet, opts.gap, false);
      const extra = typeof need === "function" ? need(c.track) : need;
      const r = tuneSkew(segmentOf(c.track, c.k), c.side, {...opts, extra, pairGap: c.gap, clearanceFn: check});
      if (r.added > 1e-6) return {r, modify: [trackPlan(c.track, c.k, r.points)], tracks: [c.track], added: r.added};
    }
    return null;
  }

  // ------------------------------------------------------------------ phase matching
  // Tracks of one net on one layer chained end to end: {pts, segs:[{track, k, rev}]}.
  function chainsOf(board, net, layer) {
    const tr = (board.items || []).filter(i => i.kind === "track" && i.net === net && i.layer === layer && i.points?.length > 1);
    const key = p => Math.round(p[0] * 1e4) + "," + Math.round(p[1] * 1e4), at = new Map();
    for (const t of tr) for (const e of [0, 1]) { const k = key(e ? t.points[t.points.length - 1] : t.points[0]); (at.get(k) || at.set(k, []).get(k)).push(t); }
    const deg = p => (at.get(key(p)) || []).length;
    const used = new Set(), out = [];
    const order = [...tr].sort((a, b) => Number(deg(a.points[0]) === 2 && deg(a.points.at(-1)) === 2) -
      Number(deg(b.points[0]) === 2 && deg(b.points.at(-1)) === 2));
    for (const seed of order) {
      if (used.has(seed)) continue;
      used.add(seed);
      const rev0 = deg(seed.points[0]) === 2 && deg(seed.points.at(-1)) !== 2;
      let pts = rev0 ? seed.points.slice().reverse() : seed.points.slice();
      const segs = [];
      for (let k = 0; k < seed.points.length - 1; k++) segs.push(rev0 ? {track: seed, k: seed.points.length - 2 - k, rev: true} : {track: seed, k, rev: false});
      for (;;) {
        const end = pts[pts.length - 1], list = at.get(key(end)) || [];
        if (list.length !== 2) break;
        const next = list.find(t => !used.has(t)); if (!next) break;
        used.add(next);
        const rev = key(next.points[0]) !== key(end), q = rev ? next.points.slice().reverse() : next.points;
        for (let k = 0; k < next.points.length - 1; k++) segs.push(rev ? {track: next, k: next.points.length - 2 - k, rev: true} : {track: next, k, rev: false});
        pts = pts.concat(q.slice(1));
      }
      out.push({pts, segs});
    }
    return out;
  }
  // Phase sites of a coupled run: at the end of each coupled P segment, the arc position
  // on P and on N of the same cross-section. skew = sP - sN (positive: P leads).
  function phaseSites(pc, nc, maxSep) {
    const cumP = [0], cumN = [0];
    for (let i = 1; i < pc.pts.length; i++) cumP.push(cumP[i - 1] + Math.hypot(pc.pts[i][0] - pc.pts[i - 1][0], pc.pts[i][1] - pc.pts[i - 1][1]));
    for (let i = 1; i < nc.pts.length; i++) cumN.push(cumN[i - 1] + Math.hypot(nc.pts[i][0] - nc.pts[i - 1][0], nc.pts[i][1] - nc.pts[i - 1][1]));
    const out = [];
    let mFrom = 0;
    for (let j = 1; j < pc.pts.length; j++) {
      const a = pc.pts[j - 1], b = pc.pts[j], L = cumP[j] - cumP[j - 1];
      if (L < 1e-6) continue;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      let best = null;
      for (let m = Math.max(1, mFrom); m < nc.pts.length; m++) {
        const q0 = nc.pts[m - 1], q1 = nc.pts[m], ql = cumN[m] - cumN[m - 1];
        if (ql < 1e-6 || Math.abs(ux * (q1[1] - q0[1]) - uy * (q1[0] - q0[0])) / ql > 0.02 || ux * (q1[0] - q0[0]) + uy * (q1[1] - q0[1]) <= 0) continue;
        const lat = (q0[0] - a[0]) * -uy + (q0[1] - a[1]) * ux; if (Math.abs(lat) > maxSep) continue;
        const p0 = (q0[0] - a[0]) * ux + (q0[1] - a[1]) * uy, p1 = (q1[0] - a[0]) * ux + (q1[1] - a[1]) * uy;
        const lo = Math.max(0, p0), hi = Math.min(L, p1);
        if (hi - lo < Math.min(0.3 * L, 0.3 * ql, 0.2)) continue;
        if (!best || Math.abs(lat) < Math.abs(best.lat) - 1e-9) best = {m: m - 1, lat, hi, p0};
      }
      if (!best) continue;
      mFrom = best.m + 1;
      const x = Math.max(0, best.hi - 1e-4), sP = cumP[j - 1] + x, sN = cumN[best.m] + (x - best.p0);
      out.push({j: j - 1, m: best.m, sP, sN, skew: sP - sN, at: [a[0] + ux * x, a[1] + uy * x], side: best.lat >= 0 ? 1 : -1, sep: Math.abs(best.lat)});
    }
    return out;
  }
  // Nearest point of a polyline to q: {p, s (arc length), i (segment), t}.
  function nearestOn(pts, q) {
    let best = null, s = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, L = Math.sqrt(l2);
      const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0, x = a[0] + dx * t, y = a[1] + dy * t, d = Math.hypot(x - q[0], y - q[1]);
      if (!best || d < best.d - 1e-12) best = {p: [x, y], s: s + t * L, i: i - 1, t, d};
      s += L;
    }
    return best || {p: q, s: 0, i: 0, t: 0, d: 0};
  }
  // Static phase matching: walks a pair's coupled run and, wherever the running skew
  // leaves the tolerance, adds skew bumps on the lagging trace within `distance` of the
  // bend that caused it. Mutates the tracks of `board` (a shadow) and the obstacle index.
  function phaseNets(board, defs, index, P, N, o = {}) {
    const tol = o.tolerance ?? 0.025, distance = o.distance ?? 5, maxIter = o.maxIter ?? 48, upTo = o.upTo ?? Infinity;
    const touched = new Map(), report = {sites: 0, bumps: 0, leads: 0, unfixed: 0, maxError: 0, addedP: 0, addedN: 0, uncoupled: 0, markers: []};
    let uncoupledUsed = o.uncoupledUsed || 0;
    const layers = new Set((board.items || []).filter(i => i.kind === "track" && i.net === P).map(i => i.layer));
    for (const layer of layers) {
      const runOf = () => {
        const pcs = chainsOf(board, P, layer), ncs = chainsOf(board, N, layer);
        let best = null;
        for (const pc of pcs) for (let nc of ncs) {
          if (Math.hypot(nc.pts[0][0] - pc.pts[0][0], nc.pts[0][1] - pc.pts[0][1]) > Math.hypot(nc.pts.at(-1)[0] - pc.pts[0][0], nc.pts.at(-1)[1] - pc.pts[0][1]))
            nc = {pts: nc.pts.slice().reverse(), segs: nc.segs.slice().reverse().map(s => ({...s, rev: !s.rev}))};
          const w = (pc.segs[0]?.track.width || 0.15);
          const sites = phaseSites(pc, nc, o.maxSep ?? Math.max(1, 6 * w));
          if (!best || sites.length > best.sites.length) best = {pc, nc, sites};
        }
        return best;
      };
      // Sites are fixed on the original geometry (just before each bend, with the bend that
      // feeds them as the source) and re-measured on the current copper after every bump.
      const run0 = runOf();
      if (!run0 || !run0.sites.length) continue;
      const sites = run0.sites.map(st => ({atP: st.at, atN: nearestOn(run0.nc.pts, st.at).p, srcP: run0.pc.pts[st.j], srcN: run0.nc.pts[st.m], sP0: st.sP - Math.hypot(st.at[0] - run0.pc.pts[st.j][0], st.at[1] - run0.pc.pts[st.j][1]), sep: st.sep,
        u: (() => { const a = run0.pc.pts[st.j], b = run0.pc.pts[st.j + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; })()}));
      const measure = run => sites.map(st => ({...st, error: nearestOn(run.pc.pts, st.atP).s - nearestOn(run.nc.pts, st.atN).s}));
      let iter = 0;
      for (const site of sites) {
        if (site.sP0 > upTo + 1e-9) break;
        for (let tries = 0; tries < 2 && iter < maxIter; tries++, iter++) {
          const run = runOf(); if (!run) break;
          const err = nearestOn(run.pc.pts, site.atP).s - nearestOn(run.nc.pts, site.atN).s;
          if (Math.abs(err) <= tol) break;
          const lagP = err < 0, lagNet = lagP ? P : N, lead = lagP ? N : P;
          if (o.only && o.only !== lagNet) { report.leads++; break; }
          const chain = lagP ? run.pc : run.nc, other = lagP ? run.nc : run.pc, src = lagP ? site.srcP : site.srcN;
          const probe = [src[0] + site.u[0] * 1e-3, src[1] + site.u[1] * 1e-3], hit = nearestOn(chain.pts, probe), hitO = nearestOn(other.pts, probe);
          const mine = chain.segs[hit.i], theirs = other.segs[hitO.i];
          if (!mine || !theirs) { report.unfixed++; break; }
          const t = mine.track, k = mine.k, seg = segmentOf(t, k), L = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
          // Local position of the source along the track segment, and a window after it.
          const along = mine.rev ? L - hit.t * L : hit.t * L, D = Math.min(distance, mine.rev ? along : L - along);
          const win = mine.rev ? [along - D, along] : [along, along + D];
          const ux = (seg.b[0] - seg.a[0]) / L, uy = (seg.b[1] - seg.a[1]) / L, q = theirs.track.points[theirs.k];
          const partnerSide = Math.sign((q[0] - seg.a[0]) * -uy + (q[1] - seg.a[1]) * ux) || 1;
          const pairGap = Math.max(0, site.sep - ((t.width || 0.15) + (theirs.track.width || 0.15)) / 2);
          const check = pairChecker(board, index, {track: t, k, other: theirs.track, ok: theirs.k, gap: pairGap}, lagNet, lead, o.gap, false);
          const r = tuneSkew(seg, partnerSide, {extra: Math.abs(err), pairGap, maxUncoupled: o.maxUncoupled, uncoupledUsed, clearanceFn: check, window: win, tolerance: Math.min(tol / 4, 0.01), rounding: o.rounding, corner: o.corner});
          if (!(r.added > 1e-6)) { report.unfixed++; break; }
          const pts = trackPlan(t, k, r.points).set.points;
          index.replace(t.id, t, pts); t.points = pts; touched.set(t.id, t);
          uncoupledUsed += r.uncoupled || 0; report.uncoupled += r.uncoupled || 0; report.bumps++;
          if (lagP) report.addedP += r.added; else report.addedN += r.added;
          report.markers.push({at: src, error: err, net: lagNet, added: r.added});
        }
      }
      const run = runOf();
      if (run) {
        const m = measure(run);
        report.sites += m.length;
        for (const st of m) if (st.sP0 <= upTo + 1e-9) report.maxError = Math.max(report.maxError, Math.abs(st.error));
        report.profile = m.map(st => ({at: st.atP, s: st.sP0, error: st.error}));
      }
    }
    report.modify = [...touched.values()].map(t => ({id: t.id, set: {points: t.points.map(p => [...p])}}));
    report.ok = report.maxError <= tol + 1e-9;
    return report;
  }
  // Interactive dynamic phase tuning: tunes the clicked net of a pair (bumps on that net
  // only) so the pair stays phase-aligned from its start up to the cursor.
  function phaseSession(board, defs, o = {}) {
    const track0 = o.trackId ? trackById(board, o.trackId) : null, net = track0?.net || o.net;
    if (!net) throw Error("Choose a routed track of a differential pair.");
    const pp = pairPartner(board, net);
    if (!pp) throw Error("This net is not part of a differential pair.");
    const partner = pp.partner, layer = track0?.layer || o.layer || "Top";
    const pairTracks = (board.items || []).filter(i => i.kind === "track" && (i.net === net || i.net === partner) && i.points?.length > 1);
    if (!pairTracks.some(t => t.net === partner && t.layer === layer)) throw Error("The partner net has no track on " + layer + ".");
    const rules = targetFor(board, defs, net, o);
    { const T = globalThis.AtriumTiming, tr = (board.items || []).find(i => i.id === o.trackId); // phase tolerance in ps
      if (T && o.toleranceDelay != null && o.tolerance == null) o = {...o, tolerance: o.toleranceDelay / T.model(board, defs).factor(tr?.layer || "Top", tr?.width)}; }
    let tolerance = o.tolerance ?? Math.min(rules.pairTolerance ?? 0.05, 0.05), distance = o.distance ?? 5;
    const params = {rounding: roundingOf(o.rounding), corner: o.corner};
    let box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const t of pairTracks) for (const p of t.points) { box[0] = Math.min(box[0], p[0]); box[1] = Math.min(box[1], p[1]); box[2] = Math.max(box[2], p[0]); box[3] = Math.max(box[3], p[1]); }
    box = [box[0] - 6, box[1] - 6, box[2] + 6, box[3] + 6];
    const index = obstacles(board, defs, {box,project:o.project});
    const orig = new Map(pairTracks.map(t => [t.id, t.points.map(p => [...p])]));
    const pr = pairRule(board, pp.name, layer);
    let last = null, cursor = o.at || track0?.points[0] || [0, 0];
    const shadowOf = () => ({...board, items: pairTracks.map(t => ({...t,points:orig.get(t.id)}))});
    const chain = chainsOf(shadowOf(),net,layer).sort((a,b)=>b.pts.length-a.pts.length)[0];
    function compute(p) {
      const shadow = shadowOf();
      // Arc position of the cursor along the tuned net's chain.
      let upTo = 0;
      if (chain) {
        let bd = Infinity, s = 0;
        for (let i = 1; i < chain.pts.length; i++) {
          const a = chain.pts[i - 1], b = chain.pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const d = segPoint2(p[0], p[1], a[0], a[1], b[0], b[1]);
          if (d < bd) { bd = d; const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (L * L))) : 0; upTo = s + t * L; }
          s += L;
        }
      }
      const [P, N] = net < partner ? [net, partner] : [partner, net];
      const ph = phaseNets(shadow, defs, index, P, N, {tolerance, distance, upTo, only: net, maxUncoupled: pr?.maxUncoupled, rounding: params.rounding, corner: params.corner});
      // Restore the shared index to the original geometry.
      for (const m of ph.modify) { const t = pairTracks.find(x => x.id === m.id); if (t) index.replace(t.id, t, orig.get(t.id)); }
      const preview = ph.modify.map(m => { const t = pairTracks.find(x => x.id === m.id); return {id: m.id, points: m.set.points, width: t.width, layer: t.layer, net: t.net}; });
      // Phase error at the cursor: the last site at or before it.
      const prof = ph.profile || [], here = [...prof].reverse().find(s => s.s <= upTo + 1e-9) || prof[0];
      const err = here ? (here.error * (net === P ? 1 : -1)) : 0, maxE = ph.maxError;
      const status = Math.abs(err) <= tolerance && maxE <= tolerance + 1e-9 ? "within" : err < 0 ? "short" : "long";
      const hi = Math.max(3 * tolerance, maxE, Math.abs(err)) * 1.1;
      const gauge = {kind: "phase", at: [...p], length: err, target: 0, tolerance, min: -tolerance, max: tolerance, ratio: 1, status,
        fraction: Math.max(0, Math.min(1, (err + hi) / (2 * hi))), windowFrom: (hi - tolerance) / (2 * hi), windowTo: (hi + tolerance) / (2 * hi),
        text: "Phase " + (err >= 0 ? "+" : "") + err.toFixed(3) + " mm · max " + maxE.toFixed(3) + " (±" + tolerance.toFixed(3) + ")" + (ph.bumps ? " · " + ph.bumps + " bump" + (ph.bumps > 1 ? "s" : "") : "") + (ph.leads ? " · " + ph.leads + " on " + partner : ""),
        delta: err, style: "Phase", amplitude: null, gap: null, miter: null, rounding: params.rounding, maxError: maxE, bumps: ph.bumps, leads: ph.leads};
      const plan = {add: [], remove: [], modify: ph.modify};
      last = {preview, length: err, target: 0, tolerance, progressRatio: 1, gauge, plan, result: ph, window: [], mode: "phase",
        sites: prof.map(s => ({at: s.at, error: s.error * (net === P ? 1 : -1), ok: Math.abs(s.error) <= tolerance + 1e-9, done: s.s <= upTo + 1e-9}))};
      return last;
    }
    const session = {
      net, mode: "phase", partner, track: track0?.id || null, target: 0, tolerance,
      move(p) { if(last && p[0]===cursor[0] && p[1]===cursor[1])return last; cursor = p.slice(); return compute(cursor); },
      set(next) { if (Number.isFinite(next.tolerance) && next.tolerance > 0) tolerance = next.tolerance; if (Number.isFinite(next.distance) && next.distance > 0) distance = next.distance; if ("rounding" in next) params.rounding = roundingOf(next.rounding); return compute(cursor); },
      key(k) {
        if (k === "1" || k === "2") distance = Math.max(0.5, distance + (k === "2" ? 0.5 : -0.5));
        else if (k === "3" || k === "4") tolerance = Math.max(0.001, +(tolerance * (k === "4" ? 1.25 : 0.8)).toFixed(4));
        else if (k === "[" || k === "]") params.rounding = roundingOf(params.rounding + (k === "]" ? 5 : -5));
        else if (k === "Tab") return {properties: session.properties()};
        else return null;
        return compute(cursor);
      },
      properties() { return {style: "sawtooth", phase: true, distance, tolerance, target: 0, rounding: params.rounding, styles: [{value: "sawtooth", label: "Sawtooth (phase)"}], roundings: ROUNDINGS.map(v => ({value: String(v), label: v + "%"}))}; },
      overlay() { return last ? {preview: last.preview, gauge: last.gauge, window: last.window, sites: last.sites} : null; },
      commit() { if (!last) compute(cursor); invalidate(board, [net, partner]); return last.plan; },
      cancel() { last = null; }
    };
    compute(cursor);
    return session;
  }

  // ------------------------------------------------------------------ interactive session
  // Name pairs of a board (rules.js detectDiffPairs), net -> pair; once per items list and length.
  const namePairCache = new WeakMap();
  function namePairs(board) {
    const hit = namePairCache.get(board);
    if (hit && hit.items === board.items && hit.n === (board.items || []).length) return hit.map;
    const nets = new Set(); for (const i of board.items || []) { if (i.net) nets.add(i.net); for (const n of Object.values(i.pinNets || {})) if (n) nets.add(n); }
    const map = new Map(); for (const p of globalThis.AtriumRules.detectDiffPairs([...nets])) { map.set(p.positive, p); map.set(p.negative, p); }
    namePairCache.set(board, {items: board.items, n: (board.items || []).length, map});
    return map;
  }
  function pairPartner(board, net) {
    for (const p of diffPairList(board)) {
      if (p.positive === net) return {name: p.name, partner: p.negative};
      if (p.negative === net) return {name: p.name, partner: p.positive};
    }
    // Name partner: the one recogniser (rules.js detectDiffPairs, net-intent.js) when loaded.
    const R = globalThis.AtriumRules;
    if (R?.detectDiffPairs && globalThis.AtriumNetIntent) {
      const p = namePairs(board).get(net);
      return p ? {name: p.name, partner: p.positive === net ? p.negative : p.positive} : null;
    }
    const m = /^(.*?)(_DP|_DN|_P|_N|\+|-|P|N)$/.exec(net || "");
    if (m) {
      const swap = {_DP: "_DN", _DN: "_DP", _P: "_N", _N: "_P", "+": "-", "-": "+", P: "N", N: "P"}[m[2]];
      if ((board.items || []).some(i => i.net === m[1] + swap)) return {name: m[1], partner: m[1] + swap};
    }
    return null;
  }
  function begin(board, defs, o = {}) {
    if (o.phase) return phaseSession(board, defs, o);
    let track = o.trackId ? trackById(board, o.trackId) : null;
    const net = track?.net || o.net;
    if (!net) throw Error("Choose a routed track to tune.");
    const tracks = (board.items || []).filter(i => i.kind === "track" && i.net === net && i.points?.length > 1);
    let k;
    if (o.at) { const ns = nearestSegment(track ? [track] : tracks, o.at); if (ns) { track = ns.track; k = ns.k; } }
    if (k == null) { const c = candidateSegments(board, defs, net, o)[0]; if (!c) throw Error("This net has no routed segment to tune."); track = c.track; k = c.k; }
    const base = netLength(board, defs, net, o), mode = o.pair ? (o.skew ? "skew" : "pair") : "single";
    let partner = null, pSeg = null, pairInfo = null, pairGapUsed;
    if (mode !== "single") {
      pairInfo = pairPartner(board, net);
      if (!pairInfo) throw Error("This net is not part of a differential pair.");
      const pt = (board.items || []).filter(i => i.kind === "track" && i.net === pairInfo.partner && i.layer === track.layer);
      const a = track.points[k], b = track.points[k + 1], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ns = nearestSegment(pt, mid);
      if (!ns) throw Error("The partner net has no track alongside on this layer.");
      partner = ns.track; pSeg = ns.k;
    }
    const partnerLen = partner ? netLength(board, defs, partner.net, o) : null;
    const timed = globalThis.AtriumTiming?.sessionTarget?.(board, defs, {net, track, partner, base, partnerLen, mode, o});
    // Skew bumps go on the shorter net's longest segment that runs beside the partner.
    let skewTarget = null;
    if (mode === "skew") {
      const shorter = timed ? timed.shorter : base.length <= partnerLen.length, mine = shorter ? net : partner.net, theirs = shorter ? partner.net : net;
      const c = coupledSegments(board, mine, theirs, track.layer)[0];
      const best = c ? {tTrack: c.track, tk: c.k, partnerSide: c.side} : null;
      if (!best) throw Error("No straight segment of the shorter net runs beside its partner.");
      skewTarget = {...best, shorter};
      if (!shorter) { const ns = nearestSegment([track], best.tTrack.points[best.tk]); partner = track; pSeg = ns ? ns.k : k; }
      track = best.tTrack; k = best.tk;
    }
    const rules = targetFor(board, defs, net, o);
    if (timed) o = {...o, target: o.target ?? timed.target, tolerance: o.tolerance ?? timed.tolerance, targetDelay: timed.targetDelay};
    let target = o.target ?? (mode === "skew" ? Math.max(base.length, partnerLen.length) : rules.target ?? base.length);
    let tolerance = o.tolerance ?? (mode === "skew" ? rules.pairTolerance : rules.tolerance) ?? 0.1;
    const startLength = mode === "pair" ? (base.length + partnerLen.length) / 2 :
      mode === "skew" && !skewTarget.shorter ? partnerLen.length : base.length;
    const params = {style: o.style || "mitered", amplitude: o.amplitude, gap: o.gap, miter: o.miter ?? 0.5, sides: o.sides || 1, rounding: roundingOf(o.rounding),
      minAmplitude: o.minAmplitude, maxAmplitude: o.maxAmplitude, side: o.side, amplitudeStep: o.amplitudeStep || 0.1, gapStep: o.gapStep || 0.05, corner: o.corner};
    const seg = segmentOf(track, k), f = frame(seg.a, seg.b);
    // Properties can extend a live trombone well beyond its initial amplitude.
    // Build the spatial index once and query only cells alongside each preview.
    const index = obstacles(board, defs, {project:o.project});
    const skip = new Map([[track.id, new Set([k])]]);
    if (partner && mode === "pair") skip.set(partner.id, new Set([pSeg]));
    const gapGuess = o.gap ?? Math.max(2 * (track.width || 0.15), 0.2);
    const near = new Map([[track.id, new Map([[k - 1, [seg.a[0], seg.a[1], gapGuess * 3]], [k + 1, [seg.b[0], seg.b[1], gapGuess * 3]]])]]);
    if (partner) { const pa = partner.points[pSeg], pb = partner.points[pSeg + 1]; near.set(partner.id, new Map([[pSeg - 1, [pa[0], pa[1], gapGuess * 3]], [pSeg + 1, [pb[0], pb[1], gapGuess * 3]]])); }
    const pr = pairInfo ? pairRule(board, pairInfo.name, track.layer) : null;
    if (pr || partner) {
      // Measured edge gap between the tuned segment and its partner bounds the pair gap.
      const a = track.points[k], b = track.points[k + 1], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ns = partner ? nearestSegment([partner], mid) : null;
      const measured = ns ? Math.sqrt(segPoint2(mid[0], mid[1], partner.points[ns.k][0], partner.points[ns.k][1], partner.points[ns.k + 1][0], partner.points[ns.k + 1][1])) - ((track.width || 0) + (partner.width || 0)) / 2 : null;
      const gapPair = Math.min(pr?.gap ?? Infinity, measured ?? Infinity);
      if (Number.isFinite(gapPair)) pairGapUsed = Math.max(0, gapPair - 1e-6);
    }
    let checkedGap, check;
    const anchor = Math.max(0, Math.min(f.L, o.at ? (o.at[0] - seg.a[0]) * f.ux + (o.at[1] - seg.a[1]) * f.uy : 0));
    let last = null, cursor = o.at || seg.a, capCache = new Map();
    function compute(p) {
      const gap = params.gap ?? gapGuess;
      if (checkedGap !== gap) {
        checkedGap = gap;
        for (const joints of near.values()) for (const joint of joints.values()) joint[2] = gap * 3;
        check = index.checker({net: track.net, layer: track.layer, clearance: clearanceRule(board, track.net, "", track.layer), gap, skip, near,
          partner: partner?.net, pairGap: pairGapUsed, clearanceFor: other => clearanceRule(board, track.net, other, track.layer)});
      }
      const t = (p[0] - seg.a[0]) * f.ux + (p[1] - seg.a[1]) * f.uy;
      const reverse = t < anchor, window = reverse ? [Math.max(0, t), anchor] : [anchor, Math.min(f.L, t)];
      const sideNow = params.side ?? ((p[0] - seg.a[0]) * f.vx + (p[1] - seg.a[1]) * f.vy >= 0 ? 1 : -1);
      const common = {...params, side: sideNow, window, align: "start", reverse, clearanceFn: check, capCache, tolerance: tolerance / 4};
      let preview, length, plan, result;
      if (mode === "single") {
        result = tune({...seg, length: base.length}, {...common, target, lead: Math.min(params.gap ?? gapGuess, 0.5)});
        length = base.length + result.added;
        preview = [{id: track.id, points: trackPlan(track, k, result.points).set.points, width: track.width, layer: track.layer, net}];
        plan = {add: [], remove: [], modify: [trackPlan(track, k, result.points)]};
      } else if (mode === "pair") {
        const ps = segmentOf(partner, pSeg);
        result = tunePair({...seg, length: base.length}, {...ps, length: partnerLen.length}, {...common, target, side: sideNow, lead: undefined});
        if (!result.ok) {
          last = {preview: [], length: startLength, target, progressRatio: 0, error: result.reason, plan: {add: [], remove: [], modify: []}};
          return last;
        }
        length = result.length;
        const mp = trackPlan(track, k, result.p), mn = trackPlan(partner, pSeg, result.n);
        preview = [{id: track.id, points: mp.set.points, width: track.width, layer: track.layer, net}, {id: partner.id, points: mn.set.points, width: partner.width, layer: partner.layer, net: partner.net}];
        plan = {add: [], remove: [], modify: [mp, mn]};
      } else {
        const {tTrack, tk, partnerSide} = skewTarget;
        const ts = segmentOf(tTrack, tk);
        const need = Math.max(0, target - startLength);
        result = tuneSkew(ts, partnerSide, {...common, side: undefined, extra: need, pairGap: pairGapUsed, maxUncoupled: pr?.maxUncoupled ?? o.maxUncoupled, uncoupledUsed: o.uncoupledUsed, window: undefined});
        const mp = trackPlan(tTrack, tk, result.points);
        const lp = (skewTarget.shorter ? base.length : partnerLen.length) + result.added;
        length = lp;
        preview = [{id: tTrack.id, points: mp.set.points, width: tTrack.width, layer: tTrack.layer, net: tTrack.net}];
        plan = {add: [], remove: [], modify: [mp]};
      }
      const ratio = target > 0 ? length / target : 1;
      const status = length < target - tolerance ? "short" : length > target + tolerance ? "long" : "within";
      const hi = Math.max(target + tolerance, length) * 1.08;
      // An xSignal (series part) member reads as the whole path: net length plus the rest of the path.
      const off = rules.offset || 0;
      const delay = timed ? timed.startDelay + (length - startLength) * timed.delayPerMm : null;
      const gauge = {at: [...p], length: length + off, target: target + off, tolerance, min: target + off - tolerance, max: target + off + tolerance, ratio, status,
        fraction: Math.min(1, length / hi), windowFrom: (target - tolerance) / hi, windowTo: Math.min(1, (target + tolerance) / hi), xSignal: rules.xSignal || null,
        text: (length + off).toFixed(3) + " / " + (target + off).toFixed(3) + " mm" + (rules.xSignal ? " (xSignal)" : "") + (o.targetDelay != null ? " · target " + o.targetDelay.toFixed(1) + " ps" : ""), delta: length - target, style: STYLE_NAMES[params.style] || params.style,
        amplitude: result.amplitude, gap: result.gap ?? params.gap ?? gapGuess, miter: params.miter, rounding: params.rounding, delay};
      // Tuning sleeve: the band along the segment the pattern may grow into (its current and largest
      // amplitude), and the part of it already used, coloured by the target status as it is dragged.
      const ampNow = result.amplitude ?? params.amplitude ?? 1, ampMax = Math.max(ampNow, params.maxAmplitude ?? ampNow * 1.5), two = params.sides === 2 || mode === "pair";
      const band = (t0, t1, a) => { const lo = two ? -a : 0, hi = a; return [f.toWorld(t0, lo * sideNow), f.toWorld(t1, lo * sideNow), f.toWorld(t1, hi * sideNow), f.toWorld(t0, hi * sideNow)]; };
      const sleeve = {outer: band(0, f.L, ampMax), used: band(window[0], window[1], ampNow), status, fraction: Math.min(1, Math.max(0, ratio))};
      last = {preview, length, target, tolerance, progressRatio: ratio, gauge, plan, result, window: window.map(x => f.toWorld(x, 0)), mode, sleeve};
      return last;
    }
    const session = {
      net, mode, track: track.id, segment: k, partner: partner?.id || null,
      get target() { return target; }, get tolerance() { return tolerance; },
      move(p) { if(last && p[0]===cursor[0] && p[1]===cursor[1])return last; cursor = p.slice(); return compute(cursor); },
      set(next) {
        Object.assign(params, next);
        if ("rounding" in next) params.rounding = roundingOf(next.rounding);
        if (Number.isFinite(next.target) && next.target > 0) {
          target = next.target;
          if (timed) o.targetDelay = timed.startDelay + (target - startLength) * timed.delayPerMm;
        }
        if (Number.isFinite(next.tolerance) && next.tolerance >= 0) tolerance = next.tolerance;
        capCache.clear(); return compute(cursor);
      },
      key(k) {
        const amp = params.amplitude ?? last?.gauge?.amplitude ?? 1, gap = params.gap ?? gapGuess;
        if (k === "1") params.amplitude = Math.max(params.amplitudeStep, amp - params.amplitudeStep);
        else if (k === "2") params.amplitude = amp + params.amplitudeStep;
        else if (k === "3") { params.gap = Math.max(0.05, gap - params.gapStep); capCache = new Map(); }
        else if (k === "4") { params.gap = gap + params.gapStep; capCache = new Map(); }
        else if (k === ",") params.miter = Math.max(0, +(params.miter - 0.1).toFixed(2));
        else if (k === ".") params.miter = Math.min(1, +(params.miter + 0.1).toFixed(2));
        else if (k === "[" || k === "]") { params.rounding = roundingOf((params.rounding || 0) + (k === "]" ? 5 : -5)); capCache = new Map(); }
        else if (k === "Tab") return {properties: session.properties()};
        else return null;
        if (params.maxAmplitude != null && params.amplitude > params.maxAmplitude) params.maxAmplitude = params.amplitude;
        capCache = new Map();
        return compute(cursor);
      },
      properties() { return {...params, target, tolerance, styles: Object.keys(STYLE_NAMES).map(k => ({value: k, label: STYLE_NAMES[k]})), roundings: ROUNDINGS.map(v => ({value: String(v), label: v + "%"}))}; },
      overlay() { return last?.gauge ? {preview: last.preview, gauge: last.gauge, window: last.window, segment: [seg.a, seg.b], sleeve: last.sleeve} : null; },
      commit() { if (!last) compute(cursor); invalidate(board, [net, partner?.net].filter(Boolean)); return last.plan; },
      cancel() { last = null; }
    };
    compute(cursor);
    return session;
  }
  // Canvas overlay: preview copper in world space, the gauge in screen space.
  // view: {scale, dpr, worldToScreen(p), copper(layer) -> css colour}.
  const SLEEVE = {short: "#3d8bff", within: "#2fbf71", long: "#ff4d4d"};
  function draw(g, overlay, view) {
    if (!overlay) return;
    g.save();
    // Tuning sleeve (world space): dashed outline of the available band, tinted fill of the used part.
    const sv = overlay.sleeve;
    if (sv) {
      const poly = pts => { g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); };
      const c = SLEEVE[sv.status] || SLEEVE.short;
      poly(sv.outer); g.globalAlpha = 0.08; g.fillStyle = c; g.fill();
      g.globalAlpha = 0.7; g.strokeStyle = c; g.lineWidth = 1 / view.scale; g.setLineDash?.([4 / view.scale, 3 / view.scale]); g.stroke(); g.setLineDash?.([]);
      poly(sv.used); g.globalAlpha = 0.18; g.fill();
      g.globalAlpha = 1;
    }
    for (const t of overlay.preview || []) {
      g.beginPath(); t.points.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
      g.strokeStyle = view.copper ? view.copper(t.layer) : "#ff0000"; g.globalAlpha = 0.85; g.lineWidth = Math.max(t.width || 0.15, 1.2 / view.scale);
      g.lineCap = "round"; g.lineJoin = "round"; g.stroke();
    }
    // Phase sites: green within tolerance, amber outside; hollow beyond the cursor.
    for (const st of overlay.sites || []) {
      const r = Math.max(0.12, 4 / view.scale);
      g.beginPath(); g.arc(st.at[0], st.at[1], r, 0, Math.PI * 2);
      g.globalAlpha = 0.9; g.lineWidth = 1.5 / view.scale;
      g.strokeStyle = g.fillStyle = st.ok ? "#7fd18f" : "#f0a32e";
      if (st.done) g.fill(); else g.stroke();
    }
    g.restore();
    const ga = overlay.gauge; if (!ga || !view.worldToScreen) return;
    const at = view.worldToScreen(ga.at), dpr = view.dpr || 1, W = 150, H = 8, x = at[0] + 18, y = at[1] + 18;
    g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "rgba(20,20,20,.86)"; g.fillRect(x - 6, y - 18, W + 12, H + 26);
    g.fillStyle = "#3a3a3a"; g.fillRect(x, y, W, H);
    g.fillStyle = "rgba(127,209,143,.35)"; g.fillRect(x + W * ga.windowFrom, y - 2, Math.max(2, W * (ga.windowTo - ga.windowFrom)), H + 4);
    g.fillStyle = ga.status === "within" ? "#7fd18f" : ga.status === "long" ? "#e8956e" : "#f0a32e"; g.fillRect(x, y, W * ga.fraction, H);
    g.font = "500 11px ui-monospace, Menlo, monospace"; g.fillStyle = "#e2e2e2"; g.textBaseline = "alphabetic";
    g.fillText(ga.text + "  " + (ga.delta >= 0 ? "+" : "") + ga.delta.toFixed(3), x, y - 5);
    g.restore();
  }

  // ------------------------------------------------------------------ groups, targets, evaluation
  function targetFor(board, defs, net, o = {}) {
    const out = {target: null, tolerance: null, pairTolerance: null};
    for (const g of o.groups || groups(board, defs, o)) {
      if (!g.members.some(m => m.nets.includes(net))) continue;
      const ev = evaluateGroup(board, defs, g, o), m = ev.members.find(x => x.nets.includes(net));
      out.target = ev.target; out.tolerance = ev.tolerance ?? g.tolerance; out.pairTolerance = ev.pairTolerance ?? g.pairTolerance;
      // An xSignal member: the net's own target is the path target less the rest of the path.
      if (m && m.kind === "xsignal" && !m.unrouted) { const own = netLength(board, defs, net, o).length; out.target = (m.lengthTarget ?? ev.target) - (m.length - own); out.xSignal = m.name; out.offset = m.length - own; }
      return out;
    }
    const lr = lengthRule(board, net);
    if (lr) { out.target = lr.max != null ? (lr.min + lr.max) / 2 : lr.min; out.tolerance = lr.max != null ? (lr.max - lr.min) / 2 : 0.1; }
    return out;
  }
  // Groups shown by the manager: Matched Lengths rule groups, diff-pair groups, net
  // classes and user groups (which may include xSignals by name).
  function groups(board, defs, opts = {}) {
    const out = [], stored = store(board), targets = stored?.targets || {}, xsAll = xsList(board), xs = new Map(xsAll.map(x => [x.name, x]));
    const pairs = diffPairList(board), pairOf = new Map();
    for (const p of pairs) { pairOf.set(p.positive, p); pairOf.set(p.negative, p); }
    // A net through a series part is matched as its automatic xSignal (source → part → load).
    const memberOf = net => {
      const x = opts.xSignals === false ? null : seriesXSignal(board, net, opts);
      if (x) return {name: net, kind: "xsignal", xs: x, nets: [net, ...x.nets.filter(n => n !== net)], pair: pairOf.get(net)?.name, auto: true};
      return {name: net, kind: "net", nets: [net], pair: pairOf.get(net)?.name};
    };
    for (const g of matchedRuleGroups(board, opts)) {
      const key = "rule:" + (g.ruleId || g.ruleName);
      out.push({key, kind: "matched", name: g.ruleName || "Matched lengths", tolerance: g.tolerance ?? 0.254, withinPair: !!g.withinPair,
        pairTolerance: g.pairTolerance ?? g.tolerance ?? 0.127, members: g.nets.map(memberOf), pairs: g.pairs || [], explicit: targets[key] ?? null, rule: true});
    }
    const classes = new Map();
    for (const p of pairs) for (const c of p.classes?.length ? p.classes : ["All differential pairs"]) { if (!classes.has(c)) classes.set(c, []); classes.get(c).push(p); }
    for (const [name, list] of classes) {
      const key = "pairs:" + name;
      out.push({key, kind: "pairs", name, tolerance: opts.tolerance ?? 0.254, withinPair: true, pairTolerance: opts.pairTolerance ?? 0.127,
        members: list.flatMap(p => [memberOf(p.positive), memberOf(p.negative)]), pairs: list, explicit: targets[key] ?? null, rule: false});
    }
    for (const c of netClassList(board)) {
      if (!c.nets.length || /^all ?nets$/i.test(c.name)) continue;
      const key = "class:" + c.name;
      out.push({key, kind: "class", name: c.name, tolerance: opts.tolerance ?? 0.254, withinPair: false, members: c.nets.map(memberOf), pairs: [], explicit: targets[key] ?? null, rule: false});
    }
    for (const g of stored?.groups || []) {
      const key = "group:" + g.name;
      const members = (g.members || []).map(m => typeof m === "string" ? (xs.has(m) ? {name: m, kind: "xsignal", xs: xs.get(m), nets: []} : memberOf(m))
        : m.xSignal ? {name: m.xSignal, kind: "xsignal", xs: xs.get(m.xSignal), nets: []} : memberOf(m.net));
      const names = new Set(members.filter(m => m.kind === "net").map(m => m.name)), found = [...(g.pairs || [])], seen = new Set(found.flatMap(p => [p.positive, p.negative]));
      for (const n of names) {
        if (seen.has(n)) continue;
        const pp = pairOf.get(n) || (() => { const x = pairPartner(board, n); return x ? {name: x.name, positive: n, negative: x.partner} : null; })();
        if (pp && names.has(pp.positive) && names.has(pp.negative)) { found.push({name: pp.name, positive: pp.positive, negative: pp.negative}); seen.add(pp.positive); seen.add(pp.negative); }
      }
      out.push({key, kind: "custom", name: g.name, tolerance: g.tolerance ?? opts.tolerance ?? 0.254, withinPair: g.withinPair ?? found.length > 0, pairTolerance: g.pairTolerance ?? 0.127,
        members, pairs: found, explicit: targets[key] ?? g.target ?? null, rule: false});
    }
    if (xsAll.length && !(stored?.groups || []).length) {
      const key = "xsignals";
      out.push({key, kind: "custom", name: "xSignals", tolerance: opts.tolerance ?? 0.254, members: xsAll.map(x => ({name: x.name, kind: "xsignal", xs: x, nets: []})), pairs: [], explicit: targets[key] ?? null, rule: false});
    }
    globalThis.AtriumTiming?.extraGroups?.(board, out, memberOf, opts); // Matched Delays rules
    // One member per automatic xSignal: the other net of the same series path is folded in.
    for (const g of out) {
      const covered = new Set(), autos = new Set();
      for (const m of g.members) if (m.auto && !m.nets.some(n => covered.has(n))) { autos.add(m); m.nets.forEach(n => covered.add(n)); }
      g.members = g.members.filter(m => m.auto ? autos.has(m) : !covered.has(m.nets[0]));
    }
    // Matched Lengths / Delays rules scoped to xSignals (xsignals.js): one group per rule, measured per xSignal.
    try { const X = globalThis.AtriumXSignals, RC = globalThis.AtriumRules?.compiled; if (X && RC && xsAll.length) out.push(...X.ruleGroups(board, RC(board,{project:opts.project}), opts.routingIndex?.parts)); } catch { /* no rules */ }
    return out;
  }
  function measure(board, defs, m, o) {
    if (m.kind === "xsignal") {
      if (!m.xs) return {name: m.name, length: 0, unrouted: true, reason: "Unknown xSignal", nets: [], delay: 0, vias: 0};
      const r = xSignalLength(board, defs, m.xs, o); if (!m.auto && !r.unrouted) m.nets = r.nets;
      if (!r.unrouted && !r.id) { const b = netLength(board, defs, m.nets[0], o); r.id = b.id; r.at = b.at; }
      return {...r, vias: r.transitions || 0};
    }
    return netLength(board, defs, m.nets[0], o);
  }
  function evaluateGroup(board, defs, g, o = {}) {
    const rows = g.members.map(m => ({member: m, r: measure(board, defs, m, o)}));
    const routed = rows.filter(x => !x.r.unrouted);
    const longest = routed.reduce((a, x) => Math.max(a, x.r.length), 0);
    const target = g.explicit ?? longest;
    const pairSkew = new Map();
    if (g.withinPair) for (const p of g.pairs || []) {
      const a = rows.find(x => x.member.nets[0] === p.positive), b = rows.find(x => x.member.nets[0] === p.negative);
      if (a && b) { const sk = a.r.length - b.r.length; pairSkew.set(p.positive, sk); pairSkew.set(p.negative, -sk); }
    }
    let fails = 0;
    const members = rows.map(({member, r}) => {
      const delta = Math.abs(r.length - target) < 5e-7 ? 0 : r.length - target, lr = member.kind === "net" ? lengthRule(board, member.nets[0]) : null;
      let status = "pass", note = "";
      if (r.unrouted) { status = "unrouted"; note = r.reason || "Not fully routed"; }
      else if (lr && (r.length < lr.min - 1e-6 || lr.max != null && r.length > lr.max + 1e-6)) { status = "length"; note = "Length rule " + lr.min.toFixed(2) + "–" + (lr.max ?? "∞") + " mm"; }
      else if (delta < -g.tolerance - 1e-6) { status = "short"; note = (-delta).toFixed(3) + " mm short"; }
      else if (delta > g.tolerance + 1e-6) { status = "long"; note = delta.toFixed(3) + " mm long"; }
      const skew = pairSkew.get(member.nets[0]);
      if (status === "pass" && skew != null && Math.abs(skew) > (g.pairTolerance ?? 0.127) + 1e-6) { status = "skew"; note = "Pair skew " + skew.toFixed(3) + " mm"; }
      if (status !== "pass") fails++;
      return {name: member.name, kind: member.kind, nets: member.nets, pair: member.pair, length: r.length, delta, delay: r.delay || 0,
        vias: r.vias ?? 0, transitions: r.transitions ?? 0, layers: r.layers || {}, mode: r.mode || "xsignal", status, note, skew, id: r.id, at: r.at, unrouted: !!r.unrouted};
    });
    const ev = {...g, target, longest, members, fails, spread: routed.length ? longest - routed.reduce((a, x) => Math.min(a, x.r.length), Infinity) : 0};
    return globalThis.AtriumTiming?.groupInDelay?.(board, defs, g, ev) || ev; // delay-based groups
  }
  function evaluate(board, defs, o = {}) { return groups(board, defs, o).map(g => evaluateGroup(board, defs, g, o)); }
  // Set each group's stored target from its longest member (call inside ctx.edit).
  function setTargetFromLongest(board, defs, keys, o = {}) {
    const t = storeFor(board);
    for (const g of evaluate(board, defs, o)) if (!keys || keys.includes(g.key)) {
      if (g.basis === "delay") t.targets[g.key + "#ps"] = +g.longestDelay.toFixed(6);
      else t.targets[g.key] = +g.longest.toFixed(6);
    }
    return t.targets;
  }
  // Tune every short member of every group (or of `keys`). Members of a pair that are
  // both short are tuned together; pair skew is fixed with intra-pair bumps.
  function autoTune(board, defs, o = {}) {
    const t0 = now();
    const index = obstacles(board, defs, {}), modify = new Map(), fixed = [], failed = [], phase = [];
    // Tune against a shadow copy whose tracks take each plan as it is made. A fixed revision
    // keeps the shadow's net cache: every net is tuned once and other nets do not change.
    const shadow = {...board, rules: globalThis.AtriumRules?.effective?.(board) ?? board.rules,
      items: (board.items || []).map(i => i.kind === "track" ? {...i} : i)}, byId = new Map(shadow.items.map(i => [i.id, i]));
    const done = new Set(), rev = {};
    o = {...o, revision: rev};
    const evaluated = evaluate(board, defs, {...o, revision: undefined});
    // A generated pair class also lists pairs from explicitly timed groups.
    // Satisfy those time constraints before marking their nets done.
    evaluated.sort((a, b) => Number(b.basis === "delay") - Number(a.basis === "delay"));
    for (const g of evaluated) {
      if (o.keys && !o.keys.includes(g.key)) continue;
      const byDelay = g.basis === "delay", rate = byDelay ? delayRates(board, defs, o) : null;
      const perMm = t => byDelay ? rate(t.net, t.layer, t.width) : 1;
      for (const p of g.pairs || []) {
        const a = g.members.find(m => m.nets[0] === p.positive), b = g.members.find(m => m.nets[0] === p.negative);
        if (!a || !b || done.has(p.positive) || done.has(p.negative)) continue;
        done.add(p.positive); done.add(p.negative);
        if (a.unrouted || b.unrouted) { failed.push({group: g.name, name: p.name, reason: "Pair is not fully routed"}); continue; }
        const ptol = byDelay ? g.pairDelayTolerance : g.pairTolerance ?? 0.127;
        const groupTol = byDelay ? g.delayTolerance : g.tolerance, tol = Math.min(g.tolerance / 2, o.tolerance ?? 0.02);
        const startP = byDelay ? a.delay : a.length, startN = byDelay ? b.delay : b.length;
        let vp = startP, vn = startN, added = 0;
        const want = byDelay ? g.targetDelay : clampRule(board, p.positive, g.target);
        const pr = pairRule(board, p.name);
        if (Math.min(vp, vn) < want - groupTol && Math.max(vp, vn) < want) {
          const need = (t, u) => Math.min((want - vp) / perMm(t), (want - vn) / perMm(u));
          const r = tunePairNets(shadow, defs, index, p.positive, p.negative, need, {...o, tolerance: tol});
          if (r) {
            for (const m of r.modify) { modify.set(m.id, m); const t = byId.get(m.id); if (t) t.points = m.set.points; }
            r.tracks.forEach((t, i) => index.replace(t.id, t, r.modify[i].set.points));
            vp += r.addedP * perMm(r.tracks[0]); vn += r.addedN * perMm(r.tracks[1]);
            added += r.addedP + r.addedN;
          }
        }
        if (o.phase) {
          // Static phase matching: compensate skew near each bend that creates it.
          const po = typeof o.phase === "object" ? o.phase : {};
          const ph = phaseNets(shadow, defs, index, p.positive, p.negative, {...po, tolerance: po.tolerance ?? Math.min(g.pairTolerance / 2, 0.025), maxUncoupled: pr?.maxUncoupled, rounding: o.rounding});
          for (const m of ph.modify) { modify.set(m.id, m); const t = byId.get(m.id); if (t) t.points = m.set.points; }
          if (byDelay) {
            vp = netLength(shadow, defs, p.positive).delay;
            vn = netLength(shadow, defs, p.negative).delay;
          } else { vp += ph.addedP; vn += ph.addedN; }
          added += ph.addedP + ph.addedN;
          phase.push({group: g.name, name: p.name, sites: ph.sites, bumps: ph.bumps, maxError: ph.maxError, ok: ph.ok, unfixed: ph.unfixed, markers: ph.markers});
        }
        const skew = Math.abs(vp - vn), shortNet = vp < vn ? p.positive : p.negative, longNet = shortNet === p.positive ? p.negative : p.positive;
        if (skew > Math.min(ptol / 2, groupTol / 2) && (g.withinPair || Math.min(vp, vn) < want - groupTol)) {
          const need = t => Math.min(skew, Math.max(0, want - Math.min(vp, vn))) / perMm(t);
          const r = skewNets(shadow, defs, index, shortNet, longNet, need, {...o, maxUncoupled: pr?.maxUncoupled, tolerance: Math.min((g.pairTolerance ?? .127) / 4, 0.01)});
          if (r) {
            for (const m of r.modify) { modify.set(m.id, m); const t = byId.get(m.id); if (t) t.points = m.set.points; }
            index.replace(r.tracks[0].id, r.tracks[0], r.modify[0].set.points);
            if (shortNet === p.positive) vp += r.added * perMm(r.tracks[0]); else vn += r.added * perMm(r.tracks[0]);
            added += r.added;
          }
        }
        const worst = Math.max(Math.abs(vp - want), Math.abs(vn - want));
        if (worst <= groupTol + 1e-6 && (!g.withinPair || Math.abs(vp - vn) <= ptol + 1e-6)) fixed.push({group: g.name, name: p.name, added});
        else failed.push({group: g.name, name: p.name, reason: "Pair target error " + worst.toFixed(3) + ", skew " + Math.abs(vp - vn).toFixed(3) + (byDelay ? " ps" : " mm") + " after tuning"});
      }
      const inXs = new Map();
      for (const m of g.members) if (m.kind === "xsignal") for (const n of m.nets) inXs.set(n, m.name);
      for (const m of g.members) {
        if (m.status === "pass" || m.status === "skew" || done.has(m.nets[0])) continue;
        if (m.kind === "net" && inXs.has(m.nets[0])) { failed.push({group: g.name, name: m.name, reason: "Also part of xSignal " + inXs.get(m.nets[0]) + " in this group; tune the xSignal instead."}); continue; }
        if (m.status === "unrouted") { failed.push({group: g.name, name: m.name, reason: m.note}); continue; }
        if (m.status === "long" || m.status === "length" && m.delta > 0) { failed.push({group: g.name, name: m.name, reason: "Longer than the target; reroute it or raise the target."}); continue; }
        // An xSignal is tuned once, whichever group lists it (a rule group and a net class group may both).
        if (m.kind === "xsignal" && m.nets.some(n => done.has(n))) continue;
        const net = m.kind === "xsignal" ? longestNet(shadow, defs, m.nets) : m.nets[0];
        if (!net || done.has(net)) continue;
        if (m.kind === "xsignal") for (const n of m.nets) done.add(n);
        const r = tuneNet(shadow, defs, net, {...o, target: m.kind === "xsignal" ? (m.lengthTarget ?? g.target) : clampRule(board, net, m.lengthTarget ?? g.target), currentOffset: m.kind === "xsignal" ? m.length - netLength(shadow, defs, net, o).length : 0,
          tolerance: Math.min(g.tolerance / 2, o.tolerance ?? 0.02), index,
          ...(byDelay ? {extraDelay: -m.deltaDelay, delayTolerance: g.delayTolerance / 2, delayRates: rate} : {})});
        done.add(net);
        if (r.plan) for (const mod of r.plan.modify) { modify.set(mod.id, mod); const t = byId.get(mod.id); if (t) t.points = mod.set.points; }
        if (r.ok) fixed.push({group: g.name, name: m.name, added: r.added});
        else failed.push({group: g.name, name: m.name, reason: r.reason, shortfall: r.shortfall});
      }
    }
    // A single group command promises a complete match. Measure the proposed copper
    // again, including physical Length rules and xSignals, before returning its edit.
    if (o.requireAll) {
      if (!failed.length) {
        const check = {...o, revision: {}};
        for (const g of groups(shadow, defs, check)) {
          if (o.keys && !o.keys.includes(g.key)) continue;
          for (const m of evaluateGroup(shadow, defs, g, check).members) {
            if (m.status !== "pass") failed.push({group: g.name, name: m.name, reason: m.note});
          }
        }
      }
      if (failed.length) { modify.clear(); fixed.length = 0; }
    }
    return {plan: {add: [], remove: [], modify: [...modify.values()]}, fixed, failed, phase, ms: (now()) - t0};
  }
  // A group target moved inside the member's own Length rule window.
  function clampRule(board, net, target) {
    const lr = lengthRule(board, net); if (!lr) return target;
    return Math.min(lr.max ?? Infinity, Math.max(lr.min, target));
  }
  function longestNet(board, defs, nets) {
    let best = null, bl = -1;
    for (const n of nets || []) { const c = candidateSegments(board, defs, n)[0]; if (c && c.length > bl) { bl = c.length; best = n; } }
    return best;
  }
  function csv(evaluated) {
    // Same rule as AtriumBOM.csvCell: text a spreadsheet would evaluate as a formula gets a leading ' (numbers pass).
    const q = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [["Group", "Member", "Kind", "Length (mm)", "Target (mm)", "Delta (mm)", "Delay (ps)", "Vias", "Status", "Note", "Target (ps)", "Delta (ps)"].join(",")];
    for (const g of evaluated) for (const m of g.members) {
      const timed = g.basis === "delay";
      lines.push([g.name, m.name, m.kind, m.length.toFixed(4), timed ? "" : g.target.toFixed(4), timed ? "" : m.delta.toFixed(4), m.delay.toFixed(1),
        m.vias, m.status, m.note, timed ? g.targetDelay.toFixed(4) : "", timed ? m.deltaDelay.toFixed(4) : ""].map(q).join(","));
    }
    return lines.join("\n") + "\n";
  }

  // ------------------------------------------------------------------ manager dialog
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, fn, title) { const b = el("button", text); b.classList.add("ui-button"); b.type = "button"; b.onclick = fn; if (title) b.title = title; return b; }
  globalThis.AtriumI18n?.scope?.(".length-dialog, .length-properties", ["tuning"]);
  function miterInput(value) {
    const input = el("input"); input.type="number";input.dataset.numericUnit="%";input.min="0";input.max="100"; input.step = "any"; input.required = true;
    input.value = String(Math.round(100 * (value ?? .5))); return input;
  }
  function properties(options, {unit, apply, closed}) {
    const dialog = el("dialog", null, "ui-dialog message-dialog length-properties"), form = el("form");
    dialog.setAttribute("aria-label", "Length tuning properties");
    form.method = "dialog";
    const title = el("h2", "Length tuning", "ui-dialog-title"), body = el("div", null, "ui-dialog-body");
    form.append(title, body);
    const fields = {};
    function field(label, key, choices) {
      const row = el("label", null, "length-prop ui-field-row"), control = key === "miter" ? miterInput(options.miter) : el(choices ? "select" : "input");
      control.classList.add("ui-field");
      const value = options[key];
      if (choices) {
        for (const choice of choices) {
          const option = el("option", choice.label);
          option.value = choice.value;
          control.append(option);
        }
        control.value = String(value ?? (key === "sides" ? 1 : 0));
      } else if (key !== "miter") {
        control.dataset.unit = unit;
        control.value = value == null ? "" : String(globalThis.Atrium.units.value(value, unit));
      }
      fields[key] = control; control.setAttribute("aria-label", label);
      row.append(el("span", label), control);
      body.append(row);
    }
    field("Pattern", "style", options.styles);
    if (!options.phase) field("Sides", "sides", [{value: "1", label: "One-sided"}, {value: "2", label: "Two-sided"}]);
    const lengths = options.phase ? [["distance", "Compensation distance"], ["tolerance", "Tolerance"]] :
      [["target", "Target length"], ["tolerance", "Tolerance"], ["amplitude", "Amplitude"], ["gap", "Gap"]];
    for (const [key, label] of lengths) field((globalThis.AtriumI18n?.text?.(label, ["tuning"]) || label) + " (" + unit + ")", key);
    if (!options.phase) field("Miter (%)", "miter");
    if (options.roundings) field("Sawtooth rounding", "rounding", options.roundings);
    const sync = () => {
      if (fields.sides) fields.sides.disabled = fields.style.value === "trombone";
      if (fields.miter) fields.miter.disabled = ["rounded", "sawtooth"].includes(fields.style.value);
      if (fields.rounding) fields.rounding.disabled = fields.style.value !== "sawtooth";
    };
    fields.style.onchange = sync; sync();
    const cancel = button("Cancel", () => dialog.close()), ok = el("button", "Apply", "ui-button");
    ok.dataset.variant = "primary";
    ok.type = "submit";
    const actions = el("div", null, "work-actions ui-dialog-actions"); actions.append(cancel, ok); form.append(actions);
    form.onsubmit = event => {
      event.preventDefault();
      const next = {style: fields.style.value};
      if (fields.sides) next.sides = +fields.sides.value;
      if (fields.miter && !fields.miter.disabled) next.miter = fields.miter.valueAsNumber / 100;
      if (fields.rounding) next.rounding = +fields.rounding.value;
      for (const [key] of lengths) {
        const text = fields[key].value.trim();
        if (!text) continue;
        const value = globalThis.Atrium.units.parse(text, unit);
        if (!Number.isFinite(value) || value < 0 || (!value && (options.phase || ["amplitude", "gap"].includes(key)))) {
          fields[key].setCustomValidity("Enter a positive length, such as 0.25 mm or 10 mil.");
          fields[key].reportValidity(); fields[key].oninput = () => fields[key].setCustomValidity(""); return;
        }
        next[key] = value;
      }
      dialog.close();
      apply(next);
    };
    dialog.append(form); document.body.append(dialog);
    dialog.onclose = () => {dialog.remove(); closed();};
    globalThis.AtriumShell?.adoptDialog?.(dialog, {initialFocus: fields.style, actions}); dialog.showModal(); fields.style.focus();
  }
  const STATUS = {pass: "Pass", short: "Short", long: "Long", unrouted: "Unrouted", length: "Length rule", skew: "Pair skew"};
  function open(ctx) {
    const board = ctx.doc?.kind === "pcb" ? ctx.doc : ctx.project?.documents?.find(d => d.kind === "pcb");
    if (!board) { ctx.info?.("Open a board layout first."); return; }
    const defs = ctx.defs;
    const d = el("dialog", null, "ui-dialog work-dialog length-dialog"); d.setAttribute("aria-label", "Length tuning");
    const opener = document.activeElement;
    d.onclose = () => { d.remove(); (opener?.getClientRects?.().length && opener !== document.body ? opener : globalThis.AtriumNavHost?.canvas?.())?.focus?.(); };
    const head = el("div", null, "length-head"); head.append(el("h2", "Matched lengths", "ui-dialog-title"));
    const summary = el("p", null, "length-summary"); summary.setAttribute("role", "status");
    const tools = el("div", null, "length-tools");
    const search = el("input", null, "ui-field"); search.type = "search"; search.placeholder = "Filter nets or groups"; search.setAttribute("aria-label", "Filter nets or groups");
    const style = el("select"); style.setAttribute("aria-label", "Pattern style");
    for (const [k, v] of Object.entries(STYLE_NAMES)) style.add(new Option(v, k));
    const amp = el("input"); amp.type="number";amp.dataset.numericUnit="mm";amp.step = "any"; amp.min = "0"; amp.value = "1.0"; amp.title = "Amplitude (mm)"; amp.setAttribute("aria-label", "Amplitude in millimetres");
    const gap = el("input"); gap.type="number";gap.dataset.numericUnit="mm";gap.step = "any"; gap.min = "0"; gap.value = "0.3"; gap.title = "Gap (mm)"; gap.setAttribute("aria-label", "Gap in millimetres");
    for (const field of [amp, gap]) field.oninput = () => field.setCustomValidity(field.valueAsNumber === 0 ? "Enter a positive length." : "");
    const vias = el("label", null, "length-check"); const viaBox = el("input", null, "ui-checkbox"); viaBox.type = "checkbox"; viaBox.checked = true; vias.append(viaBox, el("span", "Via length"));
    const rounding = el("select"); rounding.setAttribute("aria-label", "Sawtooth rounding"); rounding.title = "Corner rounding of sawtooth teeth, 0–50 % in 5 % steps";
    for (const v of ROUNDINGS) rounding.add(new Option(v + " %", String(v)));
    const miter = miterInput(.5), sided = el("select");
    for (const [value, label] of [["1", "One-sided"], ["2", "Two-sided"]]) sided.add(new Option(label, value));
    const syncPattern = () => { rounding.disabled = style.value !== "sawtooth"; sided.disabled = style.value === "trombone"; miter.disabled = ["sawtooth", "rounded"].includes(style.value); };
    style.addEventListener("change", syncPattern); syncPattern();
    const phase = el("label", null, "length-check"); const phaseBox = el("input", null, "ui-checkbox"); phaseBox.type = "checkbox"; phase.append(phaseBox, el("span", "Phase match pairs"));
    phase.title = "Static phase matching: compensate each pair's skew near the bend that creates it";
    tools.append(labelled("Pattern", style), labelled("Sides", sided), labelled("Amplitude (mm)", amp), labelled("Gap (mm)", gap), labelled("Miter (%)", miter), labelled("Rounding", rounding));
    const filters = el("div", null, "length-options"); filters.append(search, vias, phase);
    const list = el("div", null, "length-list ui-dialog-body");
    const report = el("div", null, "length-report"); report.setAttribute("aria-live", "polite");
    const foot = el("div", null, "work-actions ui-dialog-actions");
    let evaluated = [];
    const opts = () => ({vias: viaBox.checked, revision: ctx.revision?.()});
    function labelled(text, control) { const l = el("label", null, "length-field"); control.classList.add("ui-field"); l.append(el("span", text), control); return l; }
    function locate(m) { if (!m.id) return; d.close(); ctx.locate?.(m.id, m.at); }
    function paint() {
      evaluated = evaluate(board, defs, opts());
      const action = document.activeElement?.getAttribute("data-group-action");
      const focusGroup = action && document.activeElement.closest(".length-group")?.getAttribute("data-group");
      const q = search.value.trim().toLowerCase(); list.replaceChildren();
      let visible = 0, members = 0, fails = 0;
      for (const g of evaluated) {
        const rows = g.members.filter(m => !q || g.name.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        if (!rows.length) continue;
        visible++; members += rows.length; fails += rows.filter(m => m.status !== "pass").length;
        const box = el("section", null, "length-group"); box.dataset.group = g.key;
        const gh = el("div", null, "length-group-head");
        const timed = g.basis === "delay", unit = timed ? " ps" : " mm", prec = timed ? 2 : 3;
        const target = timed ? g.targetDelay : g.target, tolerance = timed ? g.delayTolerance : g.tolerance;
        const title = el("div"); title.append(el("strong", g.name), el("small", (({matched: "Matched Lengths rule", delay: "Matched Delays rule", pairs: "Differential pairs", class: "Net class", custom: "Group"})[g.kind] || "Group") +
          " · target " + target.toFixed(prec) + unit + " ±" + tolerance.toFixed(prec) + unit + " · " + (g.fails ? g.fails + " failing" : "all pass")));
        const acts = el("div", null, "length-group-actions");
        const fromMax = button(timed ? "Target from slowest" : "Target from longest", () => { ctx.edit(() => setTargetFromLongest(board, defs, [g.key], opts())); invalidate(board); paint(); }, "Store this group's largest measured value as its target");
        const tuneGroup = button("Tune group", () => runTune([g.key]), "Add patterns to every short member of this group");
        fromMax.dataset.groupAction = "target"; tuneGroup.dataset.groupAction = "tune";
        acts.append(fromMax, tuneGroup);
        gh.append(title, acts); box.append(gh);
        const table = el("table", null, "length-table"), thead = el("thead"), tr = el("tr");
        for (const h of ["Member", "Length (mm)", "Δ target (" + unit.trim() + ")", "Delay (ps)", "Vias", "Status"]) tr.append(el("th", h));
        const locateHead = el("th"); locateHead.append(el("span", "Locate", "visually-hidden")); tr.append(locateHead);
        thead.append(tr); table.append(thead);
        const body = el("tbody");
        for (const m of rows.slice(0, 400)) {
          const row = el("tr"); row.dataset.status = m.status;
          const name = el("td"); name.append(el("span", m.name)); if (m.kind === "xsignal") name.append(el("small", " xSignal · " + m.nets.join(" → ")));
          const layers = Object.entries(m.layers).map(([k, v]) => k + " " + v.toFixed(2)).join(", ");
          const len = el("td", m.unrouted ? "—" : m.length.toFixed(3)); len.title = layers + (m.mode === "total" ? " · total routed copper" : "");
          const deltaValue = timed ? m.deltaDelay : m.delta;
          const delta = el("td", m.unrouted ? "—" : (deltaValue >= 0 ? "+" : "") + deltaValue.toFixed(prec));
          const delay = el("td", m.unrouted ? "—" : m.delay.toFixed(2));
          const st = el("td"); const badge = el("span", STATUS[m.status] || m.status, "length-status"); badge.dataset.status = m.status; if (m.note) badge.title = m.note; st.append(badge);
          const loc = el("td"); loc.append(button("Locate", () => locate(m), "Show " + m.name + " on the board"));
          row.append(name, len, delta, delay, el("td", String(m.vias)), st, loc); body.append(row);
        }
        table.append(body); box.append(table);
        if (rows.length > 400) box.append(el("small", "Showing 400 of " + rows.length + " members. Filter to narrow the list."));
        list.append(box);
        if (focusGroup === g.key) (action === "tune" ? tuneGroup : fromMax).focus();
      }
      if (!list.childNodes.length) list.append(el("p", q ? "No matching nets." : "No length groups. Add Matched Lengths rules, differential pairs, net classes or xSignals to compare lengths."));
      summary.textContent = visible + " group" + (visible === 1 ? "" : "s") + " · " + members + " members · " + (fails ? fails + " failing" : "all within tolerance");
    }
    async function runTune(keys) {
      const fields=globalThis.AtriumNumericFields;
      if(fields?.pending(d) && !await fields.flush(d))return;
      for (const field of [amp, gap, miter]) if (!field.disabled && !field.reportValidity()) return;
      const res = autoTune(board, defs, {...opts(), keys, requireAll: !!keys, style: style.value, amplitude: +amp.value || undefined, gap: +gap.value || undefined,
        sides: +sided.value, miter: miter.valueAsNumber / 100, rounding: +rounding.value || 0, ...(phaseBox.checked ? {phase: {tolerance: .025, distance: 5}} : {})});
      const ids = new Set(res.plan.modify.map(m => m.id)), touched = board.items.filter(i => ids.has(i.id));
      if (touched.length) ctx.edit(() => applyPlan(board, res.plan), "Tune matched group", touched);
      const netCount = new Set(touched.map(i => i.net)).size;
      invalidate(board);
      report.replaceChildren();
      const result = keys && res.failed.length ? "Group unchanged." : "Tuned " + netCount + " net" + (netCount === 1 ? "" : "s") + " in " + res.ms.toFixed(0) + " ms.";
      report.append(el("p", result + (res.failed.length ? " " + res.failed.length + " could not be fixed:" : "")));
      if (res.failed.length) { const ul = el("ul"); for (const f of res.failed.slice(0, 60)) ul.append(el("li", f.group + " · " + f.name + ": " + f.reason)); report.append(ul); }
      paint();
    }
    const done = button("Done", () => d.close());
    done.dataset.variant = "primary";
    foot.append(button("Set group targets", () => { ctx.edit(() => setTargetFromLongest(board, defs, null, opts())); invalidate(board); paint(); }, "Use the longest length or slowest delay in each group"),
      button("Auto-tune all", () => runTune(null)),
      button("Export CSV", async () => { try { await ctx.exportFile?.((board.name || "board") + " lengths.csv", csv(evaluated)); } catch (e) { ctx.info?.(e.message); } }),
      done);
    search.oninput = paint; viaBox.onchange = paint;
    d.append(head, summary, tools, filters, list, report, foot); document.body.append(d);
    paint(); globalThis.AtriumShell?.adoptDialog?.(d, {defaultAction: false}); d.showModal?.();
    return d;
  }

  function matchPhase(doc, defs, {rounding, edit, info}) {
    const result = autoTune(doc, defs, {phase: {tolerance: .025, distance: 5}, rounding});
    if (result.plan.modify.length) edit(() => applyPlan(doc, result.plan));
    const bumps = result.phase.reduce((count, pair) => count + pair.bumps, 0);
    const bad = result.phase.filter(pair => !pair.ok).length;
    info(result.phase.length ? "Static phase matching: " + bumps + " compensation" + (bumps === 1 ? "" : "s") +
      " on " + result.phase.length + " pair" + (result.phase.length === 1 ? "" : "s") +
      (bad ? " · " + bad + " still out of phase" : "") : "No differential pairs in matched-length groups.");
  }

  return Object.freeze({routingIndex, matchPhase, netLength, lengths, netLengths, netNames, invalidate, xSignals, xSignalLength, discoverXSignals, addXSignals,
    tune, tunePair, tuneSkew, tuneNet, autoTune, phaseNets, phaseSession, chainsOf, ROUNDINGS: ROUNDINGS.slice(), roundingOf, applyPlan, candidateSegments, obstacles, clearanceFor, delayRates, begin, draw,
    seriesXSignal, matchLength, targetFor, groups, evaluate, evaluateGroup, setTargetFromLongest, csv, open, properties, offset, STYLES: STYLE_NAMES, layerIndex});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumLength;
