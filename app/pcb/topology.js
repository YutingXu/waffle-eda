"use strict";
// Routing topology analysis and checks (Routing Topology rule; Allegro schedules, Altium
// RoutingTopology): daisy chains, fly-by, T-branch and starburst, on the routed copper.
//
//   analyze(board, defs, net, {source, order})  the routed tree of a net: source pad, loads in
//        trunk order with their attach distance and stub length, branch points (junctions) and
//        arm lengths, and the shape it actually has (chain | star | T | tree | unrouted).
//   check(a, rule, spec) -> [{kind, detail, at, actual, required}]  against a topology:
//        daisyChainSimple / flyBy   one trunk from the source to the far end (fly-by: the
//                                   terminator, a resistor to a supply, is last); loads on stubs
//                                   no longer than maxStub; the custom load order if one is set.
//        daisyChainMidDriven        two trunks leaving the source in different directions.
//        daisyChainBalanced         one trunk per direction; trunk lengths within branchTolerance.
//        starburst                  every load on its own arm from one hub (the source or one
//                                   junction); arms within branchTolerance.
//        tBranch                    one junction between the source and the loads; arms within
//                                   branchTolerance.
//   drc(doc, defs, {R, flag, notes})  rules.js: Routing Topology rules with a checked topology.
//   Custom order and source per net or xSignal class: board.lengthTuning.topologies =
//        {key: {source: "U1", order: ["U2", "U3", "R9"]}} (Constraint Manager › Topology, MCP).
//
// Graph: track vertices per layer, T-junctions where a track end lands on another segment,
// vias joining every layer, pads joining the tracks that end inside them. DOM-free.
globalThis.AtriumTopology = (() => {
  const EPS = 1e-6, SNAP = 1e-3;
  const A = () => globalThis.Atrium;
  // net-intent.js (isSupply) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const POWER_RE = /^(?:[ADPS]?GND\w*|GND\w*|VSS\w*|VCC\w*|VDD\w*|VEE\w*|VTT\w*|VREF\w*|VPP\w*|PWR\w*|[+-]?\d+V\d*\w*|[+-]?\d+(?:\.\d+)?V\w*|P\d+V\d*\w*|\+\w+)$/i;
  const POWER = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isSupply ? N.isSupply(String(n ?? "")) : POWER_RE.test(n); }};
  const CHECKED = ["daisyChainSimple", "daisyChainMidDriven", "daisyChainBalanced", "starburst", "flyBy", "tBranch"];
  const NAMES = {daisyChainSimple: "Daisy-Simple", daisyChainMidDriven: "Daisy-MidDriven", daisyChainBalanced: "Daisy-Balanced", starburst: "Starburst", flyBy: "Fly-by", tBranch: "T-branch"};
  const r4 = v => Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 + 0 : v;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: "base"});

  // ------------------------------------------------------------------ graph
  function padsOf(board, defs, net) {
    const out = [];
    for (const i of board.items || []) {
      if (i.kind === "pad" && i.net === net && Number.isFinite(i.x)) out.push({ref: "", pin: String(i.number ?? i.id), at: [i.x, i.y], r: Math.max(+i.w || 0, +i.h || 0, +i.diameter || 0) / 2 || .3, layer: i.drill > 0 ? "Multi" : i.layer || "Top", id: i.id, pins: 1});
      else if (i.kind === "part" && i.pinNets) {
        const hit = Object.entries(i.pinNets).filter(([, n]) => n === net); if (!hit.length) continue;
        const def = defs?.get ? defs.get(i.def) : defs?.[i.def]; let pins = [];
        try { pins = def && A()?.pins ? A().pins(i, def, "pcb") : []; } catch { pins = []; }
        const count = Object.keys(i.pinNets).length;
        for (const [num] of hit) {
          const p = pins.find(q => String(q.number) === String(num));
          if (!p) continue;
          out.push({ref: i.ref || "", pin: String(num), at: p.at, r: Math.max(+p.w || 0, +p.h || 0, +p.diameter || 0) / 2 || .3, layer: p.drill > 0 ? "Multi" : p.layer || i.layer || "Top", id: i.id, pins: count, part: i});
        }
      }
    }
    return out;
  }
  function build(board, defs, net) {
    const nodes = [], key = new Map(), adj = [];
    const node = (x, y, layer, extra) => {
      const k = layer + "|" + Math.round(x / SNAP) + "|" + Math.round(y / SNAP);
      let n = key.get(k); if (n != null) return n;
      n = nodes.length; nodes.push({at: [x, y], layer, ...extra}); adj.push([]); key.set(k, n); return n;
    };
    const edge = (a, b, w, id) => { if (a === b) return; adj[a].push({to: b, w, id}); adj[b].push({to: a, w, id}); };
    const tracks = (board.items || []).filter(i => i.kind === "track" && i.net === net && Array.isArray(i.points) && i.points.length > 1 && !i.keepout);
    // Segments with split points from T-junctions (another track's end on its interior).
    const segs = [];
    for (const t of tracks) for (let k = 1; k < t.points.length; k++) segs.push({t, a: t.points[k - 1], b: t.points[k], layer: t.layer || "Top", cuts: [0, 1]});
    const ends = [];
    for (const t of tracks) { ends.push({p: t.points[0], layer: t.layer || "Top"}); ends.push({p: t.points[t.points.length - 1], layer: t.layer || "Top"}); }
    for (const s of segs) {
      const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], L2 = dx * dx + dy * dy; if (!(L2 > EPS)) continue;
      const tol = Math.max(SNAP, (+s.t.width || .15) / 2);
      for (const e of ends) {
        if (e.layer !== s.layer) continue;
        const u = ((e.p[0] - s.a[0]) * dx + (e.p[1] - s.a[1]) * dy) / L2;
        if (u <= 1e-6 || u >= 1 - 1e-6) continue;
        if (Math.hypot(s.a[0] + u * dx - e.p[0], s.a[1] + u * dy - e.p[1]) <= tol) s.cuts.push(u);
      }
    }
    for (const s of segs) {
      const us = [...new Set(s.cuts)].sort((x, y) => x - y);
      const pt = u => [s.a[0] + (s.b[0] - s.a[0]) * u, s.a[1] + (s.b[1] - s.a[1]) * u];
      for (let k = 1; k < us.length; k++) {
        const p = pt(us[k - 1]), q = pt(us[k]);
        edge(node(p[0], p[1], s.layer), node(q[0], q[1], s.layer), dist(p, q), s.t.id);
      }
    }
    // A T-junction: the track end sits on the split point, which has the same key when exactly on
    // the centre line; join ends within half a width of a split point.
    const trackNodes = nodes.map((n, i) => i);
    const near = (p, r, layer, fn) => { for (const i of trackNodes) { const n = nodes[i]; if ((layer === "Multi" || n.layer === layer) && dist(n.at, p) <= r) fn(i); } };
    for (const e of ends) { const k = key.get(e.layer + "|" + Math.round(e.p[0] / SNAP) + "|" + Math.round(e.p[1] / SNAP)); if (k == null) continue; near(e.p, .02, e.layer, i => { if (i !== k) edge(k, i, dist(nodes[k].at, nodes[i].at), null); }); }
    // Vias: one node joining every layer's track vertex within the via radius.
    for (const v of board.items || []) {
      if (v.kind !== "via" || v.net !== net || !Number.isFinite(v.x)) continue;
      const n = node(v.x, v.y, "via:" + v.id, {via: v.id});
      near([v.x, v.y], (+v.diameter || .6) / 2 + SNAP, "Multi", i => edge(n, i, dist(nodes[i].at, [v.x, v.y]), v.id));
    }
    // Pads: one node per pad joining track vertices inside it (on its layer, or any for through-hole).
    const pads = padsOf(board, defs, net);
    for (const p of pads) {
      p.node = node(p.at[0], p.at[1], "pad:" + p.ref + "." + p.pin + ":" + p.id, {pad: p});
      near(p.at, p.r + SNAP, p.layer, i => { if (i !== p.node && !nodes[i].pad) edge(p.node, i, dist(nodes[i].at, p.at), null); });
    }
    return {nodes, adj, pads, tracks};
  }
  function dijkstra(g, src) {
    const n = g.nodes.length, d = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), via = new Array(n).fill(null), done = new Uint8Array(n);
    d[src] = 0;
    // Nets are small (hundreds of vertices): a simple O(V^2) scan is fine and allocation-free.
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && d[i] < best) { best = d[i]; u = i; }
      if (u < 0) break;
      done[u] = 1;
      for (const e of g.adj[u]) { const nd = d[u] + e.w; if (nd < d[e.to] - 1e-12) { d[e.to] = nd; prev[e.to] = u; via[e.to] = e.id; } }
    }
    return {d, prev, via};
  }

  // ------------------------------------------------------------------ analysis
  // Custom source / order: per net, else per xSignal class containing the net.
  function specFor(board, net, indexedParts) {
    const t = board?.lengthTuning, tops = t?.topologies || {};
    if (tops[net]) return tops[net];
    if (!Object.keys(tops).length) return null;
    const parts = indexedParts || new Map();
    if (!indexedParts) for (const i of board.items || []) if (i.kind === "part" && i.ref) parts.set(i.ref, i);
    const netsOf = x => Array.isArray(x.nets) && x.nets.length ? x.nets : [parts.get(x.from?.ref)?.pinNets?.[x.from?.pin], parts.get(x.to?.ref)?.pinNets?.[x.to?.pin]];
    const v = globalThis.AtriumSignals?.xsView?.(board) || {xSignals: [], xSignalClasses: {}};  // xSignals: the signal model's
    for (const [cls, names] of Object.entries(v.xSignalClasses)) {
      if (!tops[cls]) continue;
      for (const x of v.xSignals) if (names.includes(x.name) && netsOf(x).includes(net)) return tops[cls];
    }
    return null;
  }
  function analyze(board, defs, net, o = {}) {
    const g = build(board, defs, net), spec = {...(specFor(board, net) || {}), ...(o.source ? {source: o.source} : {}), ...(o.order ? {order: o.order} : {})};
    const res = {net, pads: g.pads.length, routed: !!g.tracks.length, source: null, loads: [], junctions: [], arms: [], shape: "unrouted", order: spec.order || null, unconnected: []};
    if (g.pads.length < 2) { res.shape = "point"; return res; }
    // Source: the custom source component, else the pad on the part with most pins.
    let src = spec.source ? g.pads.find(p => p.ref === spec.source || p.ref + "." + p.pin === spec.source) : null;
    src ||= [...g.pads].sort((a, b) => b.pins - a.pins || natural(a.ref, b.ref))[0];
    res.source = {ref: src.ref, pin: src.pin, at: src.at};
    if (!g.tracks.length) return res;
    const sp = dijkstra(g, src.node);
    const loads = g.pads.filter(p => p !== src);
    for (const p of loads) if (!(sp.d[p.node] < Infinity)) res.unconnected.push(p.ref + "." + p.pin);
    if (res.unconnected.length) { res.shape = "partial"; return res; }
    // Tree of the source-to-load paths: children per node, loads per node.
    const children = new Map(), count = new Map(), path = p => { const out = []; for (let v = p.node; v >= 0; v = sp.prev[v]) out.push(v); return out; };
    for (const p of loads) {
      const pts = path(p);
      for (let i = 0; i < pts.length; i++) {
        const v = pts[i]; count.set(v, (count.get(v) || 0) + 1);
        if (i > 0) { const parent = v, child = pts[i - 1]; if (!children.has(parent)) children.set(parent, new Set()); children.get(parent).add(child); }
      }
    }
    // Junctions: tree nodes with two or more children (the source counts when it has several).
    const fork = [...children.entries()].filter(([, c]) => c.size >= 2).map(([v]) => v);
    // Subtree depth from each junction child (to classify short stubs).
    const loadAt = new Map(loads.map(p => [p.node, p]));
    const depth = new Map();
    const deepest = v => { if (depth.has(v)) return depth.get(v); let best = 0; for (const c of children.get(v) || []) best = Math.max(best, sp.d[c] - sp.d[v] + deepest(c)); depth.set(v, best); return best; };
    for (const v of fork) {
      const arms = [...children.get(v)].map(c => ({child: c, length: sp.d[c] - sp.d[v] + deepest(c), loads: loads.filter(p => path(p).includes(c)).map(p => p.ref + "." + p.pin)}));
      res.junctions.push({at: [...g.nodes[v].at], node: v, distance: r4(sp.d[v]), atSource: v === src.node, arms: arms.map(a => ({length: r4(a.length), loads: a.loads}))});
    }
    // Loads in trunk order: farthest load defines the trunk; others attach where their path meets it.
    const far = [...loads].sort((a, b) => sp.d[b.node] - sp.d[a.node])[0];
    const trunk = new Set(path(far));
    for (const p of loads) {
      let v = p.node; while (v >= 0 && !trunk.has(v)) v = sp.prev[v];
      const attach = v < 0 ? src.node : v;
      res.loads.push({ref: p.ref, pin: p.pin, at: p.at, distance: r4(sp.d[p.node]), attach: r4(sp.d[attach]), stub: r4(sp.d[p.node] - sp.d[attach]), attachAt: [...g.nodes[attach].at],
        terminator: !!p.part && /^(R|RN|RA|RP)\d/i.test(p.ref) && Object.values(p.part.pinNets || {}).some(n => n !== net && POWER.test(n || ""))});
    }
    res.loads.sort((a, b) => a.attach - b.attach || a.distance - b.distance);
    res.trunk = r4(sp.d[far.node]);
    const realForks = res.junctions.filter(j => j.arms.filter(a => a.length > (o.maxStub ?? .5)).length >= 2);
    res.shape = !realForks.length ? "chain" : realForks.length === 1 && realForks[0].atSource ? "star" : realForks.length === 1 ? "T" : "tree";
    res.g = g; res.sp = sp; res.srcNode = src.node; res.loadNodes = loads.map(p => p.node); res.path = path;
    return res;
  }

  // ------------------------------------------------------------------ checks
  function check(a, topology, r = {}) {
    const out = [], maxStub = Number.isFinite(r.maxStub) ? r.maxStub : null, tol = Number.isFinite(r.branchTolerance) ? r.branchTolerance : null;
    if (!a || a.shape === "unrouted" || a.shape === "point" || a.shape === "partial") return out;
    const name = NAMES[topology] || topology, f = v => v.toFixed(3) + " mm";
    const chainLike = topology.startsWith("daisyChain") || topology === "flyBy";
    if (chainLike) {
      // Trunks: one per direction leaving the source for MidDriven / Balanced, else the farthest load.
      const {g, sp, srcNode, path} = a, loadNodes = a.loadNodes;
      let ends;
      const firstHop = v => { const p = path({node: v}); return p.length > 1 ? p[p.length - 2] : v; };
      if (topology === "flyBy") {
        const term = a.loads.find(l => l.terminator), order = a.order?.length ? a.order : null;
        const lastRef = order ? order[order.length - 1] : term?.ref;
        const endLoad = lastRef ? a.loads.find(l => l.ref === lastRef) : null;
        const node = endLoad ? loadNodes.find(n => g.nodes[n].pad?.ref === endLoad.ref) : null;
        ends = [node ?? [...loadNodes].sort((x, y) => sp.d[y] - sp.d[x])[0]];
        if (!order && !term) out.push({kind: "terminator", detail: name + ": no termination resistor (to a supply) on the net; the trunk ends at the farthest load", at: g.nodes[ends[0]].at, warn: true});
      } else if (topology === "daisyChainSimple") ends = [[...loadNodes].sort((x, y) => sp.d[y] - sp.d[x])[0]];
      else {
        const byDir = new Map();
        for (const n of loadNodes) { const h = firstHop(n); if (!byDir.has(h) || sp.d[n] > sp.d[byDir.get(h)]) byDir.set(h, n); }
        ends = [...byDir.values()];
        if (topology === "daisyChainMidDriven" && ends.length > 2) out.push({kind: "branches", detail: name + ": " + ends.length + " trunks leave the source; mid-driven allows two", at: g.nodes[srcNode].at, actual: ends.length, required: 2});
        if (topology === "daisyChainBalanced" && tol != null && ends.length > 1) {
          const L = ends.map(n => sp.d[n]), spread = Math.max(...L) - Math.min(...L);
          if (spread > tol + EPS) out.push({kind: "balance", detail: name + ": trunk lengths differ by " + f(spread) + " (tolerance " + f(tol) + ")", at: g.nodes[srcNode].at, actual: spread, required: tol});
        }
      }
      const trunk = new Set(); for (const e of ends) for (const v of path({node: e})) trunk.add(v);
      const visits = [];
      for (const n of loadNodes) {
        let v = n; while (v >= 0 && !trunk.has(v)) v = sp.prev[v];
        const attach = v < 0 ? srcNode : v, stub = sp.d[n] - sp.d[attach], pad = g.nodes[n].pad;
        visits.push({ref: pad.ref, pin: pad.pin, attach: sp.d[attach], end: ends.includes(n)});
        if (maxStub != null && stub > maxStub + EPS) out.push({kind: "stub", detail: name + ": " + pad.ref + "." + pad.pin + " hangs " + f(stub) + " off the trunk (max stub " + f(maxStub) + ")", at: g.nodes[attach].at, actual: stub, required: maxStub, load: pad.ref + "." + pad.pin});
      }
      // Load order along a single trunk (custom order, else fly-by: terminator last).
      if (ends.length === 1 && a.order?.length) {
        const seq = visits.sort((x, y) => x.attach - y.attach || (x.end - y.end)).map(v => v.ref).filter((r, i, s) => s.indexOf(r) === i);
        const want = a.order.filter(r => seq.includes(r)), got = seq.filter(r => want.includes(r));
        const bad = got.findIndex((r, i) => r !== want[i]);
        if (bad >= 0) out.push({kind: "order", detail: name + ": loads are reached " + got.join(" → ") + ", the order is " + want.join(" → "), at: a.source.at, actual: got.join(","), required: want.join(",")});
      } else if (topology === "flyBy") {
        const term = visits.find(v => a.loads.find(l => l.ref === v.ref)?.terminator);
        if (term && !term.end && visits.some(v => v.attach > term.attach + EPS)) out.push({kind: "order", detail: name + ": the terminator " + term.ref + " is not at the end of the trunk", at: a.source.at});
      }
      return out;
    }
    const forks = a.junctions.filter(j => j.arms.filter(x => maxStub == null || x.length > maxStub).length >= 2);
    if (topology === "starburst") {
      // The hub is the source, or a junction within the max stub length (default 0.5 mm) of it.
      const hub = forks.find(j => j.atSource) || forks.find(j => j.distance <= (maxStub ?? .5) + EPS);
      if (!hub && forks.length) out.push({kind: "branch", detail: name + ": the arms split " + forks[0].distance.toFixed(2) + " mm from the source; a star's arms leave the source", at: forks[0].at, actual: forks[0].distance, required: maxStub ?? .5});
      for (const j of forks) if (j !== hub && (hub || j !== forks[0])) out.push({kind: "branch", detail: name + ": a branch at " + j.distance.toFixed(2) + " mm from the source; every load needs its own arm from the hub", at: j.at});
      if (hub && tol != null) { const L = hub.arms.map(x => x.length), spread = Math.max(...L) - Math.min(...L); if (spread > tol + EPS) out.push({kind: "balance", detail: name + ": arm lengths differ by " + f(spread) + " (tolerance " + f(tol) + ")", at: hub.at, actual: spread, required: tol}); }
    } else if (topology === "tBranch") {
      if (!forks.length) out.push({kind: "branch", detail: name + ": the net is a chain; a T needs one branch point", at: a.source.at});
      for (const j of forks.slice(1)) out.push({kind: "branch", detail: name + ": an extra branch point at " + j.distance.toFixed(2) + " mm from the source", at: j.at});
      const j = forks.find(x => !x.atSource) || forks[0];
      if (j?.atSource && forks.length === 1) out.push({kind: "branch", detail: name + ": the branch point is at the source (a star); route a common trunk to the T", at: j.at, warn: true});
      if (j && tol != null) { const L = j.arms.map(x => x.length), spread = Math.max(...L) - Math.min(...L); if (spread > tol + EPS) out.push({kind: "balance", detail: name + ": arms differ by " + f(spread) + " (tolerance " + f(tol) + ")", at: j.at, actual: spread, required: tol}); }
    }
    return out;
  }
  function plain(a) {
    if (!a) return null;
    const {g, sp, path, srcNode, loadNodes, ...rest} = a;
    return {...rest, junctions: a.junctions.map(({node, ...j}) => j)};
  }

  // ------------------------------------------------------------------ DRC (rules.js)
  function boardNets(board) {
    const s = new Set();
    for (const i of board.items || []) { if (i.net) s.add(i.net); for (const n of Object.values(i.pinNets || {})) if (n) s.add(n); }
    return [...s].sort(natural);
  }
  function drc(doc, defs, {R, flag, notes}) {
    const rules = R.byType.routingTopology || [];
    let partial = 0;
    for (const net of boardNets(doc)) {
      if (POWER.test(net)) continue;
      const r = R.first("routingTopology", {net, pair: R.pairOfNet?.get(net)?.name});
      if (!r || !CHECKED.includes(r.topology)) continue;
      const a = analyze(doc, defs, net, {maxStub: r.maxStub});
      if (a.shape === "partial") { partial++; continue; }
      for (const v of check(a, r.topology, r)) {
        const near = a.g?.tracks?.[0];
        flag(r, {id: near?.id ?? null, title: "Net " + net + " (" + (NAMES[r.topology] || r.topology) + ")", what: "Topology", detail: v.detail, at: v.at, kind: v.kind,
          ...(Number.isFinite(v.actual) ? {actual: v.actual, required: v.required, limit: "max"} : {}), severity: v.warn ? "Warning" : undefined});
      }
    }
    if (partial) notes.push(partial + " net" + (partial === 1 ? "" : "s") + " with a routing topology rule " + (partial === 1 ? "is" : "are") + " not fully routed; topology is checked once all loads connect.");
    void rules;
  }

  // ------------------------------------------------------------------ order / source store
  function setSpec(board, key, spec) {
    board.lengthTuning ||= {version: 1, groups: [], targets: {}};
    const t = board.lengthTuning; t.topologies ||= {};
    if (!spec || (!spec.source && !spec.order?.length)) { delete t.topologies[key]; return null; }
    t.topologies[key] = {...(spec.source ? {source: String(spec.source)} : {}), ...(spec.order?.length ? {order: spec.order.map(String)} : {})};
    return t.topologies[key];
  }

  // ------------------------------------------------------------------ MCP (headless.js op "topology")
  function headless(a, H) {
    const action = a.action || "analyze";
    if (action === "set_order") {
      const p = H.mutable(), doc = H.board(p, a.document_id);
      const r = setSpec(doc, a.key || a.net || a.class, {source: a.source, order: a.order});
      H.touched(); return {document_id: doc.id, key: a.key || a.net || a.class, topology: r};
    }
    const p = H.project(), doc = H.board(p, a.document_id), defs = H.defsOf(p);
    const nets = a.nets || (a.net ? [a.net] : []);
    if (!nets.length) throw Error("Pass net or nets.");
    let R = null; try { R = globalThis.AtriumRules?.compiled?.(doc, {project: p}); } catch { R = null; }
    return {document_id: doc.id, units: "mm", nets: nets.map(n => {
      const r = R?.first("routingTopology", {net: n}) || null, topo = a.topology || r?.topology;
      const an = analyze(doc, defs, n, {maxStub: a.max_stub ?? r?.maxStub});
      const v = CHECKED.includes(topo) ? check(an, topo, {maxStub: a.max_stub ?? r?.maxStub, branchTolerance: a.branch_tolerance ?? r?.branchTolerance}) : [];
      return {...plain(an), rule: r ? {name: r.ruleName, topology: r.topology} : null, checked: CHECKED.includes(topo) ? topo : null, violations: v.map(x => ({...x, at: x.at?.map(r4), actual: r4(x.actual), required: r4(x.required)}))};
    })};
  }

  return Object.freeze({CHECKED, NAMES, build, analyze, check, drc, specFor, setSpec, plain, headless});
})();
