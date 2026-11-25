"use strict";
// AtriumSIChannel: routed copper → a segmented transmission-line model.
//
// Input: what api.simulation.channel(net) returns for one or more nets (tracks with layer, width
// and points; vias with span, stub and back-drill data; the pads of every part on the net; the
// stack-up with each copper layer's cross-section; neighbouring tracks of other nets).
//
// graph(data) joins track vertices that touch (same layer, within a quarter of the narrower width),
// splits tracks at T-junctions, attaches vertices to vias (within the via land) and pads (within the
// pad), and returns nodes and edges:
//   track edges  {kind:"track", a, b, layer, width, length, segs:[{track, from, to}]}
//   via edges    {kind:"via", a, b, via, length (barrel mm), from, to}  between the copper layers a
//                via actually connects, and {kind:"stub", a, via, length} for each unused barrel end
//                (after back-drilling).
// Consecutive track edges with the same cross-section and no branch between them are merged.
//
// crossSections(graph) lists the (layer, width) cross-sections to solve; coupling(data, …) finds
// neighbour tracks running parallel within a gap, with the coupled length per victim net.
//
// Via models (lumped): barrel inductance L = 0.2·h·(ln(4h/d) + 1) nH (h, d in mm; Johnson and
// Graham, "High-Speed Digital Design", 1993, 7.2.3), capacitance C = 1.41·εr·T·D1/(D2 − D1) pF
// (T in inches; D1 the land, D2 the antipad = land + 2 × the plane clearance), shared out along
// the barrel. A stub is the unused barrel: L and C of its length, open at the far end.
(function () {
  const near = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const LIMIT_SEGMENTS = 20000;

  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return {d: Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t};
  }
  function layerIndex(data) {
    const m = new Map();
    (data.stackup?.layers || []).forEach((l, i) => m.set(l.key, {i, ...l}));
    return m;
  }

  // ------------------------------------------------------------------ graph
  // data: one channel record; or {nets: [records]} for several nets joined through series parts.
  // opts.couple: {track, seg, from, to, victim, gap} marks part of one segment as a coupled run.
  function graph(input, opts = {}) {
    const recs = Array.isArray(input.nets) ? input.nets : [input];
    const base = recs[0], L = layerIndex(base);
    const warnings = [];
    // Segments.
    const segs = [];
    for (const r of recs) for (const t of r.tracks || []) {
      const pts = t.points || [];
      for (let i = 1; i < pts.length; i++) {
        if (dist(pts[i - 1], pts[i]) < 1e-6) continue;
        segs.push({track: t.id, net: r.net, layer: t.layer, width: t.width || 0.1, profile: t.profile || null, p: pts[i - 1].slice(), q: pts[i].slice(), seg: i - 1});
      }
    }
    if (segs.length > LIMIT_SEGMENTS) throw Error("The net has more than " + LIMIT_SEGMENTS + " track segments.");
    // Coupled run: split its segment at the run's ends.
    if (opts.couple) {
      const c = opts.couple, k = segs.findIndex(s => s.track === c.track && s.seg === c.seg);
      if (k >= 0) {
        const s = segs[k], len = dist(s.p, s.q), f0 = Math.max(0, Math.min(1, c.from / len)), f1 = Math.max(f0, Math.min(1, c.to / len));
        const lerp = f => [s.p[0] + (s.q[0] - s.p[0]) * f, s.p[1] + (s.q[1] - s.p[1]) * f];
        const parts = [];
        if (f0 > 1e-6) parts.push({...s, q: lerp(f0)});
        parts.push({...s, p: lerp(f0), q: lerp(f1), coupled: true});
        if (f1 < 1 - 1e-6) parts.push({...s, p: lerp(f1)});
        segs.splice(k, 1, ...parts);
      }
    }
    // T-junctions: an end of one segment on the inside of another (same layer) splits the other.
    const ends = [];
    for (const s of segs) ends.push({layer: s.layer, p: s.p, w: s.width}, {layer: s.layer, p: s.q, w: s.width});
    for (let changed = true, guard = 0; changed && guard < 4; guard++) {
      changed = false;
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        for (const e of ends) {
          if (e.layer !== s.layer) continue;
          const tol = Math.max(1e-3, Math.min(e.w, s.width) / 4);
          if (near(e.p, s.p, tol) || near(e.p, s.q, tol)) continue;
          const h = segDist(e.p, s.p, s.q);
          if (h.d <= tol && h.t > 1e-6 && h.t < 1 - 1e-6 && !s.coupled) {
            const m = [s.p[0] + (s.q[0] - s.p[0]) * h.t, s.p[1] + (s.q[1] - s.p[1]) * h.t];
            segs.splice(k, 1, {...s, q: m}, {...s, p: m});
            changed = true; break;
          }
        }
      }
    }
    // Vertices clustered per layer (grid hash).
    const nodes = [], parent = [];
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; return a; };
    const grid = new Map(), cell = 0.05;
    const vertex = (layer, p, w) => {
      const tol = Math.max(1e-3, w / 4), gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const k of grid.get(layer + "|" + (gx + dx) + "|" + (gy + dy)) || [])
        if (near(nodes[k].p, p, Math.max(tol, nodes[k].tol))) return k;
      const k = nodes.length;
      nodes.push({p: p.slice(), layer, tol, attach: null}); parent.push(k);
      const key = layer + "|" + gx + "|" + gy;
      (grid.get(key) || grid.set(key, []).get(key)).push(k);
      return k;
    };
    for (const s of segs) { s.a = vertex(s.layer, s.p, s.width); s.b = vertex(s.layer, s.q, s.width); }
    // Vias: one node per connected layer.
    const viaRecs = [];
    for (const r of recs) for (const v of r.vias || []) {
      const span = (v.span || [v.from || "Top", v.to || "Bottom"]).map(k => L.get(k)?.i ?? (k === "Top" ? 0 : Infinity));
      const lo = Math.min(...span), hi = Math.max(...span), rad = (v.diameter || v.drill || 0.3) / 2;
      const at = new Map();
      for (let k = 0; k < nodes.length; k++) {
        const nd = nodes[k], li = L.get(nd.layer)?.i;
        if (li === undefined || li < lo || li > hi) continue;
        if (dist(nd.p, [v.x, v.y]) <= rad + nd.tol) at.set(nd.layer, at.has(nd.layer) ? unite(at.get(nd.layer), k) : k);
      }
      viaRecs.push({v, net: r.net, at, lo, hi});
    }
    // Pads.
    const padRecs = [];
    for (const r of recs) for (const pd of r.pads || []) {
      const multi = !/^(Top|Bottom)$/.test(pd.layer || "Top") || pd.drill > 0;
      const rad = Math.max(pd.w || 0.5, pd.h || 0.5) / 2;
      let node = null;
      for (let k = 0; k < nodes.length; k++) {
        const nd = nodes[k];
        if (!multi && nd.layer !== pd.layer) continue;
        if (!multi || L.has(nd.layer)) {
          const inside = Math.abs(nd.p[0] - pd.x) <= rad + nd.tol && Math.abs(nd.p[1] - pd.y) <= rad + nd.tol;
          if (inside) node = node === null ? k : unite(node, k);
        }
      }
      // Via in pad.
      for (const vr of viaRecs) if (dist([vr.v.x, vr.v.y], [pd.x, pd.y]) <= rad && vr.net === r.net) {
        const layer = multi ? null : pd.layer, k = layer ? vr.at.get(layer) : [...vr.at.values()][0];
        if (k !== undefined) node = node === null ? k : unite(node, k);
        else if (layer && L.has(layer)) { const nk = vertex(layer, [vr.v.x, vr.v.y], 0.1); vr.at.set(layer, nk); node = node === null ? nk : unite(node, nk); }
      }
      padRecs.push({...pd, net: r.net, node});
    }
    // Final node ids.
    const id = new Map(), out = [];
    const nodeOf = k => { const root = find(k); if (!id.has(root)) { id.set(root, out.length); out.push({id: out.length, layer: nodes[root].layer, p: nodes[root].p, pads: [], via: null}); } return id.get(root); };
    const edges = [];
    for (const s of segs) {
      const a = nodeOf(s.a), b = nodeOf(s.b);
      if (a === b) continue;
      edges.push({kind: "track", a, b, layer: s.layer, width: s.width, profile: s.profile || null, net: s.net, length: dist(s.p, s.q), coupled: !!s.coupled, segs: [{track: s.track, seg: s.seg, p: s.p, q: s.q}]});
    }
    for (const pd of padRecs) {
      if (pd.node === null) continue;
      const n = nodeOf(pd.node);
      out[n].pads.push(pd.ref + "." + pd.pin);
      pd.nodeId = n;
    }
    const z = key => L.get(key)?.z ?? 0;
    const layerAt = i => [...L.values()].find(l => l.i === i);
    const thickness = base.stackup?.thickness || 1.6;
    for (const vr of viaRecs) {
      const used = [...vr.at.keys()].sort((a, b) => L.get(a).i - L.get(b).i);
      if (!used.length) { warnings.push("Via " + vr.v.id + " is not connected to a track."); continue; }
      const ids = used.map(k => nodeOf(vr.at.get(k)));
      for (const n of ids) out[n].via = vr.v.id;
      for (let i = 1; i < used.length; i++) if (ids[i] !== ids[i - 1])
        edges.push({kind: "via", a: ids[i - 1], b: ids[i], via: vr.v, net: vr.net, from: used[i - 1], to: used[i], length: Math.abs(z(used[i]) - z(used[i - 1]))});
      // Stubs: the barrel beyond the outermost connected layers, less any back-drill.
      const top = layerAt(vr.lo), bot = layerAt(vr.hi === Infinity ? L.size - 1 : vr.hi);
      let stubTop = vr.v.stub?.top ?? Math.max(0, z(used[0]) - (top ? z(top.key) : 0));
      let stubBot = vr.v.stub?.bottom ?? Math.max(0, (bot ? z(bot.key) : thickness) - z(used[used.length - 1]));
      const bd = vr.v.backdrill;
      if (bd && vr.v.stub?.residual != null) { if (bd.from === "top") stubTop = vr.v.stub.residual; else stubBot = vr.v.stub.residual; }
      if (stubTop > 0.005) edges.push({kind: "stub", a: ids[0], via: vr.v, net: vr.net, length: stubTop, side: "top"});
      if (stubBot > 0.005) edges.push({kind: "stub", a: ids[ids.length - 1], via: vr.v, net: vr.net, length: stubBot, side: "bottom"});
    }
    const unrouted = padRecs.filter(p => p.node === null);
    const g = {nodes: out, edges, pads: padRecs, unrouted, warnings, stackup: base.stackup, recs};
    merge(g);
    return g;
  }
  // Merge chains of same-cross-section track edges through plain degree-2 nodes.
  function merge(g) {
    for (let again = true; again;) {
      again = false;
      const inc = g.nodes.map(() => []);
      g.edges.forEach((e, i) => { inc[e.a].push(i); if (e.b !== undefined) inc[e.b].push(i); });
      for (const nd of g.nodes) {
        const list = inc[nd.id];
        if (list.length !== 2 || nd.pads.length || nd.via) continue;
        const [e1, e2] = list.map(i => g.edges[i]);
        if (e1.kind !== "track" || e2.kind !== "track" || e1.coupled || e2.coupled || e1.layer !== e2.layer || Math.abs(e1.width - e2.width) > 1e-6 || e1.net !== e2.net || e1.profile !== e2.profile) continue;
        const a = e1.a === nd.id ? e1.b : e1.a, b = e2.a === nd.id ? e2.b : e2.a;
        if (a === b) continue;
        const m = {...e1, a, b, length: e1.length + e2.length, segs: [...e1.segs, ...e2.segs]};
        g.edges = g.edges.filter(e => e !== e1 && e !== e2).concat(m);
        again = true; break;
      }
    }
    // Drop nodes no edge or pad uses, and renumber.
    const used = new Set();
    for (const e of g.edges) { used.add(e.a); if (e.b !== undefined) used.add(e.b); }
    for (const p of g.pads) if (p.nodeId !== undefined) used.add(p.nodeId);
    const map = new Map(), nodes = [];
    for (const nd of g.nodes) if (used.has(nd.id)) { map.set(nd.id, nodes.length); nodes.push({...nd, id: nodes.length}); }
    for (const e of g.edges) { e.a = map.get(e.a); if (e.b !== undefined) e.b = map.get(e.b); }
    for (const p of g.pads) if (p.nodeId !== undefined) p.nodeId = map.get(p.nodeId);
    g.nodes = nodes;
  }

  // Shortest routed distance (mm) from a node to every node.
  function distances(g, root) {
    const d = new Array(g.nodes.length).fill(Infinity), adj = g.nodes.map(() => []);
    for (const e of g.edges) if (e.b !== undefined) { adj[e.a].push([e.b, e.length]); adj[e.b].push([e.a, e.length]); }
    d[root] = 0;
    const q = [root];
    while (q.length) {
      q.sort((x, y) => d[y] - d[x]);
      const u = q.pop();
      for (const [w, l] of adj[u]) if (d[u] + l < d[w]) { d[w] = d[u] + l; q.push(w); }
    }
    return d;
  }

  // ------------------------------------------------------------------ cross-sections
  const round = (v, k = 1e4) => Math.round(v * k) / k;
  function layerGeometry(stackup, layer) {
    const l = (stackup?.layers || []).find(x => x.key === layer);
    return l?.geometry || null;
  }
  const xsKey = (layer, width, gap, profile) => layer + "|" + round(width) + (gap != null ? "|" + round(gap) : "") + (profile ? "|p:" + profile : "");
  // Field-solver geometry for a (layer, width[, gap]) cross-section, or null without a reference plane.
  // With an impedance profile (stackup.profiles[profile][layer], from api.simulation.channel) its
  // cross-section is used, as DRC and the Layer Stack Manager solve it: the profile's references,
  // etch factor and coplanar ground gap; roughness (rough, rms mm) is passed on when given.
  function solverGeometry(stackup, layer, width, gap, profile) {
    const g = (profile && stackup?.profiles?.[profile]?.[layer]) || layerGeometry(stackup, layer);
    if (!g || g.structure === "none" || !g.structure) return null;
    const base = {t: g.t || 0.035, er: g.er || 4.2, tanD: g.tanD ?? 0.02, w: round(width)};
    for (const k of ["etch", "g", "rough"]) if (g[k] > 0) base[k] = g[k];
    let geom;
    if (g.structure === "stripline") geom = {...base, structure: gap != null ? "coupled-stripline" : "stripline", h1: g.h1, h2: g.h2};
    else geom = {...base, structure: gap != null ? "coupled-microstrip" : "microstrip", h: g.h, ...(g.cover ? {cover: {t: g.cover.t, er: g.cover.er, tanD: g.cover.tanD ?? 0.02}} : {})};
    if (gap != null) geom.s = round(gap);
    return geom;
  }
  function crossSections(g) {
    const out = new Map();
    for (const e of g.edges) if (e.kind === "track") {
      const k = xsKey(e.layer, e.width, null, e.profile);
      if (!out.has(k)) out.set(k, {key: k, layer: e.layer, width: e.width, profile: e.profile || null, geometry: solverGeometry(g.stackup, e.layer, e.width, null, e.profile)});
    }
    return [...out.values()];
  }

  // ------------------------------------------------------------------ coupling
  // Parallel runs of other nets' tracks within maxGap (edge to edge) on the same layer.
  // Returns [{net, length, gap, layer, width, track, seg, from, to, runs}] sorted by strength.
  function coupling(data, opts = {}) {
    const maxGap = opts.maxGap ?? 0.5, minLength = opts.minLength ?? 1, maxAngle = Math.cos((opts.maxAngle ?? 10) * Math.PI / 180);
    const own = [];
    for (const t of data.tracks || []) for (let i = 1; i < t.points.length; i++) own.push({track: t.id, seg: i - 1, layer: t.layer, width: t.width || 0.1, p: t.points[i - 1], q: t.points[i]});
    const victims = new Map();
    for (const nb of data.neighbours || []) {
      if (nb.net === data.net) continue;
      for (let j = 1; j < (nb.points || []).length; j++) {
        const p = nb.points[j - 1], q = nb.points[j];
        for (const s of own) {
          if (s.layer !== nb.layer) continue;
          const dx = s.q[0] - s.p[0], dy = s.q[1] - s.p[1], len = Math.hypot(dx, dy);
          if (len < 1e-6) continue;
          const ux = dx / len, uy = dy / len, ex = q[0] - p[0], ey = q[1] - p[1], el = Math.hypot(ex, ey);
          if (el < 1e-6 || Math.abs((ux * ex + uy * ey) / el) < maxAngle) continue;
          // Projections of the neighbour segment onto this one, and its perpendicular offset.
          const a = (p[0] - s.p[0]) * ux + (p[1] - s.p[1]) * uy, b = (q[0] - s.p[0]) * ux + (q[1] - s.p[1]) * uy;
          const from = Math.max(0, Math.min(a, b)), to = Math.min(len, Math.max(a, b));
          if (to - from <= 1e-3) continue;
          const mid = (from + to) / 2, f = (mid - Math.min(a, b)) / (Math.abs(b - a) || 1), px = p[0] + (q[0] - p[0]) * (a <= b ? f : 1 - f), py = p[1] + (q[1] - p[1]) * (a <= b ? f : 1 - f);
          const off = Math.abs((px - s.p[0]) * -uy + (py - s.p[1]) * ux), gap = off - (s.width + (nb.width || 0.1)) / 2;
          if (gap <= 0 || gap > maxGap) continue;
          let v = victims.get(nb.net);
          if (!v) victims.set(nb.net, v = {net: nb.net, length: 0, gapLen: 0, runs: [], layer: s.layer, width: s.width});
          v.length += to - from; v.gapLen += gap * (to - from);
          v.runs.push({track: s.track, seg: s.seg, from, to, gap, layer: s.layer, width: s.width, victimTrack: nb.id, victimWidth: nb.width || 0.1});
        }
      }
    }
    const list = [];
    for (const v of victims.values()) {
      if (v.length < minLength) continue;
      v.gap = v.gapLen / v.length; delete v.gapLen;
      const best = v.runs.reduce((x, y) => (y.to - y.from > x.to - x.from ? y : x));
      Object.assign(v, {track: best.track, seg: best.seg, from: best.from, to: best.to, layer: best.layer, width: best.width, victimWidth: best.victimWidth, longest: best.to - best.from});
      v.strength = v.length / Math.max(0.01, v.gap + v.width);
      list.push(v);
    }
    return list.sort((a, b) => b.strength - a.strength);
  }

  // ------------------------------------------------------------------ lumped models
  // Barrel inductance (H) of h mm with drill d mm.
  const viaL = (h, d) => (h > 0 && d > 0 ? 0.2e-9 * h * (Math.log(4 * h / d) + 1) : 0);
  // Barrel capacitance (F) of a barrel of t mm with land d1 and antipad d2 (mm) in εr.
  const viaC = (t, d1, d2, er) => (t > 0 && d2 > d1 ? 1.41e-12 * er * (t / 25.4) * d1 / (d2 - d1) : 0);
  // A component value such as 33R, 4k7, 22Ω, 10nF, 100n, 1uH, 0R → number (base units), or NaN.
  function value(text) {
    let s = String(text ?? "").trim().replace(/[Ωω]|ohms?/gi, "").replace(/[µμ]/g, "u").replace(/\s+/g, "");
    const rk = /^(\d+)([RKkMmunp])(\d+)$/.exec(s);
    if (rk) s = rk[1] + "." + rk[3] + (/[Rr]/.test(rk[2]) ? "" : rk[2]);
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|[TGMKkmunpfR])?(F|H|R)?$/i.exec(s);
    if (!m) return NaN;
    const mult = {meg: 1e6, T: 1e12, G: 1e9, M: 1e6, K: 1e3, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, R: 1, r: 1}[m[2] === undefined ? "" : /^meg$/i.test(m[2]) ? "meg" : m[2]] ?? 1;
    // An upper-case M on a resistor means mega; on a capacitor or inductor milli is unlikely either way.
    return Number(m[1]) * mult;
  }
  // Rail voltage from a net name: GND → 0, +3V3 / 3V3 / 3.3V / VCC_1V8 → the voltage, VTT → null.
  function railVoltage(name) {
    const s = String(name || "").toUpperCase();
    if (/^(GND|AGND|DGND|PGND|SGND|VSS|0V|EARTH|CHASSIS)\b/.test(s) || s === "0") return 0;
    const a = /(\d+)V(\d+)/.exec(s);
    if (a) return Number(a[1] + "." + a[2]);
    const b = /(\d+(?:\.\d+)?)V(?![A-Z0-9])/.exec(s);
    return b ? Number(b[1]) : null;
  }
  const isGround = n => railVoltage(n) === 0;
  const isRail = n => isGround(n) || /^(\+|-)?\d+V\d*|^(\+|-)\d|^(VCC|VDD|VIO|VDDQ|VTT|VREF|VPP|VBAT|VIN|PWR|VBUS)/i.test(String(n || ""));

  const api = {version: "1.0.0", graph, merge, distances, crossSections, solverGeometry, xsKey, coupling, viaL, viaC, value, railVoltage, isGround, isRail};
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof globalThis === "object" && globalThis) globalThis.AtriumSIChannel = api;
})();
