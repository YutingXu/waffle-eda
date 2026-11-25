"use strict";
if (!globalThis.AtriumResolvedLand && typeof require === "function") require("./pcb-appearance.js");
// Interactive Bus Routing (Route › Interactive Bus Routing, P M; MCP route_bus). Lazy: app/lazy.js loads it with the
// router on the first use of "route-bus" (or the older "route-multi"). A whole memory byte lane or address/command group
// is routed as one ribbon that follows the cursor like a single track. See docs/bus-routing.md.
//
//   AtriumBusRoute.begin(board, defs, o) -> session, the same shape as AtriumRouter.begin (editor routeSession):
//     move(p) click() back() cancel() commit() switchLayer(layer) addVia() complete(p) cycleCorner() cycleMode()
//     setMode() setCorner() toggleBend() setWidth() setArcRadius() presets() state
//     bus-only: toggleNeck() cycleViaPattern() reverse() setOrder(nets) key(k) readout()
//     o.members [{net, at:[x,y], layer, r}]  start of every member (pads, track ends or vias), or
//     o.nets + o.near  every net starts from its copper end nearest `near`
//     o.layer, o.mode (walkaround|push|hug|stop|ignore), o.corner (45|45arc|90|90arc|any), o.width, o.gap, o.order (nets),
//     o.viaPattern (inline|staggered), o.target/o.tolerance (else the matched-length group of the nets), o.rules, o.project
//   AtriumBusRoute.route(board, defs, o) -> headless: o.waypoints [[x,y],...], o.layers [{after:i, layer, pattern}],
//     o.finish {to:[x,y]} (connect to the destination pads, swapping pins where allowed), o.tune -> {ok, plan, members, ...}
//   AtriumBusRoute.tuneGroup(board, defs, nets, o) -> {plan, before, after, fixed, failed}: accordion/trombone patterns
//     from length-tuning.js bring every member within the tolerance of the group target (or the longest member).
//   AtriumBusRoute.groups(board, defs, project), busNets(board, defs, spec), gather(...), offsetPath(...)
//
// How it works. The ribbon has a centreline (the spine). Each member is a parallel offset of the spine at its lane offset:
// lanes sit at width + gap from the rules (the clearance between neighbouring nets, the diff-pair gap inside a pair), so
// 45° corners mitre exactly and arc corners become concentric arcs whose inner and outer lengths follow from the geometry.
// The spine is walked round obstacles with the router's own hull walker (router.js core.walkaround) as one wide track
// whose half width is the half width of the ribbon; in push mode the member offsets are handed to the router's shove
// (core.shove) together as heads, so other nets are shoved exactly as by the single-track router, with walkaround as the
// fallback. Every member is then checked with exact clearances; a blocked head is cut back to its longest clear prefix.
// From pads (or vias) the members converge onto their lanes with 45° jogs whose diagonals are stacked so no two members
// cross or come closer than the clearance ("gather"); the same construction, run backwards, spreads the ribbon to a via
// array or to the destination pads. A layer change drops a via array (in-line or staggered, at the via-to-via clearance)
// and continues on the new layer. Nothing in router.js changes.
globalThis.AtriumBusRoute = (() => {
  const fail = m => { throw Error(m); };
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const now = typeof performance !== "undefined" && performance.now ? () => performance.now() : () => Date.now();
  const RT = () => globalThis.AtriumRouter || fail("Bus routing needs the router (router.js).");
  const MAX = 64, EPS = 1e-6, SQ2 = Math.SQRT2, SLACK = 5e-5;   // SLACK: lanes sit this far outside the exact gap (survives rounding)
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const plen = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; };
  const PATTERNS = ["inline", "staggered"];
  const PATTERN_NAMES = {inline: "In-line via array", staggered: "Staggered via array"};

  // ---------------------------------------------------------------- bus discovery
  // Differential pairs among the nets: the rules' pair list, else _P/_N, +/- name pairs.
  function pairsOf(board, nets) {
    const out = new Map(), have = new Set(nets);
    let list = [];
    try { list = globalThis.AtriumRules?.diffPairs?.(board) || []; } catch { list = []; }
    for (const p of list) if (have.has(p.positive) && have.has(p.negative)) { const x = {name: p.name, positive: p.positive, negative: p.negative}; out.set(p.positive, x); out.set(p.negative, x); }
    for (const n of nets) {
      if (out.has(n)) continue;
      const m = /^(.*?)(_P|_N|\+|-|P|N)$/.exec(n);
      if (!m) continue;
      const other = {"_P": "_N", "_N": "_P", "+": "-", "-": "+", P: "N", N: "P"}[m[2]], partner = m[1] + other;
      if (!have.has(partner) || out.has(partner) || !m[1]) continue;
      const pos = /P|\+/.test(m[2]) ? n : partner, neg = pos === n ? partner : n, x = {name: m[1], positive: pos, negative: neg};
      out.set(pos, x); out.set(neg, x);
    }
    return out;
  }
  // Groups a bus can be picked from: net classes, matched-length groups (incl. xSignals and timing groups), pair classes.
  function groups(board, defs, project) {
    const out = [], seen = new Set(), L = globalThis.AtriumLength;
    const routingIndex = L?.routingIndex?.(board,defs,{project});
    const add = (name, kind, nets) => { nets = [...new Set(nets)].filter(Boolean); const k = kind + ":" + name; if (nets.length < 2 || seen.has(k)) return; seen.add(k); out.push({name, kind, nets}); };
    try { for (const [name, nets] of Object.entries(globalThis.AtriumRules?.netClasses?.(board, project ? {project} : {}) || {})) add(name, "class", nets); } catch { /* no rules */ }
    try {
      for (const g of L?.groups?.(board, defs, {project,routingIndex}) || []) add(g.name, g.kind === "class" ? "class" : "matched", g.members.flatMap(m => m.nets?.length ? m.nets : m.xs?.nets || []));
    } catch { /* no length module */ }
    // xSignal classes (xsignals.js): the nets of their xSignals that leave the class's source.
    try {
      const X = globalThis.AtriumXSignals;
      if (X?.classes) { const all = X.list(board, routingIndex?.parts), byName = new Map(all.map(x => [x.name, x])); for (const [name, xs] of Object.entries(X.classes(board))) add(name, "xsignal", xs.map(n => byName.get(n)?.nets?.[0])); }
    } catch { /* no xSignals */ }
    return out;
  }
  // The nets of a bus from a spec: {nets}, {netClass}, {group}, or {query: "InNetClass('DDR_BYTE0')"}.
  function busNets(board, defs, spec = {}, project = null) {
    if (Array.isArray(spec.nets) && spec.nets.length) return [...new Set(spec.nets.map(String))];
    const name = spec.netClass || spec.group;
    if (name) {
      const list = groups(board, defs, project);
      const g = list.find(x => x.name === name) || list.find(x => x.name.toLowerCase() === String(name).toLowerCase());
      if (g) return g.nets;
      fail("No net class or length group named " + name + ".");
    }
    const q = String(spec.query || "").trim();
    if (q) {
      const m = /^In(?:NetClass|xSignalClass)\(\s*['"](.+?)['"]\s*\)$/i.exec(q);
      if (m) return busNets(board, defs, {netClass: m[1]}, project);
      const Q = globalThis.AtriumQuery;
      if (!Q?.run) fail("The query engine is not loaded; give the nets or a net class.");
      const r = Q.run(project || {documents: [board], library: []}, board, q, {defs});
      const ids = new Set(r.ids || []), nets = new Set();
      for (const it of board.items) if (ids.has(it.id) && it.net) nets.add(it.net);
      for (const s of r.subs || []) if (s.net) nets.add(s.net);
      if (nets.size < 2) fail("The query matches " + nets.size + " net" + (nets.size === 1 ? "" : "s") + "; a bus needs two or more.");
      return [...nets];
    }
    fail("Choose the bus: nets, a net class or a query.");
  }
  // Copper ends of a net: pads (footprints and free pads), vias and dangling track ends.
  function endpoints(board, defs, net) {
    const L = AtriumResolvedLand, out = [], pads = new Map();
    const defOf = id => defs?.get ? defs.get(id) : defs?.[id];
    function addPad(p, part, pin) {
      // Preserve the lead radius used to space candidate bus starts.
      const {at} = L.place(p, part), w = p.w || p.diameter || .5, h = p.h || (part ? p.diameter || .5 : w);
      const round = (part ? /round|circle|oval|obround/i : /round|circle/i).test(p.shape || "round");
      const layer = p.drill > 0 || p.layer === "Multi" ? null : p.layer || part?.layer || "Top";
      const e = {at, layer, r: round ? Math.max(w, h) / 2 : Math.hypot(w, h) / 2, kind: "pad",
        ...(part ? {part: part.id, ref: part.ref, pad: pin} : {id: p.id})};
      out.push(e); pads.set(e, {p, part});
    }
    for (const it of board.items) {
      if (it.kind === "part" && it.pinNets) {
        let fp = null;
        for (const [num, n] of Object.entries(it.pinNets)) {
          if (n !== net) continue;
          fp ||= defOf(it.def)?.footprint?.pads || [];
          for (const p of fp) if (String(p.number) === num && !p.holeOnly) addPad(p,it,num);
        }
      } else if (it.kind === "pad" && !it.holeOnly && it.net === net) addPad(it);
      else if (it.kind === "via" && it.net === net) out.push({at: [it.x, it.y], layer: null, r: (it.diameter || 0.6) / 2, kind: "via", id: it.id, via: it});
    }
    const tracks = board.items.filter(i => i.kind === "track" && i.net === net && i.points?.length > 1);
    // Nearby pads and vertices determine whether a track end is already connected.
    // Include only this net; a crowded rail can contain thousands of segments.
    const coverage = new Map(), vertices = new Map(), large = [];
    const cellKey = (x, y) => x + "," + y;
    const put = (map, key, obj) => { let list = map.get(key); if (!list) map.set(key, list = []); list.push(obj); };
    function cover(e) {
      const r = e.r + 1e-6, [x, y] = e.at;
      if (r > 4) { large.push(e); return; }
      for (let i = Math.floor(x-r); i <= Math.floor(x+r); i++)
        for (let j = Math.floor(y-r); j <= Math.floor(y+r); j++) put(coverage, cellKey(i,j), e);
    }
    const layers = new Set(tracks.map(t => t.layer));
    for (const e of out) {
      const source = pads.get(e);
      if (!source) { cover(e); continue; }
      const {p, part} = source, declared = AtriumPCBAppearance.padLayer(part, p);
      if (p.drill > 0 && p.plated === false) continue;
      for (const layer of layers) {
        if (declared !== "Multi" && declared !== layer) continue;
        const land = L.geometry(p, layer);
        if (land && !land.holeOnly) cover({...L.place(land, part), land, layer, r: L.radius(land)});
      }
    }
    for (const t of tracks) for (const at of t.points) put(vertices, cellKey(Math.floor(at[0]),Math.floor(at[1])), {at,t});
    function covered(p, layer) {
      const meets = e => onLayer(e, layer) && (e.land ? L.distance(e.land, p, e.at, e.angle, e.mirror) : dist(e.at, p) - e.r) <= 1e-6;
      if (large.some(meets) || coverage.get(cellKey(Math.floor(p[0]),Math.floor(p[1])))?.some(meets)) return true;
      let first = null;
      for (let i = Math.floor(p[0]-1e-6); i <= Math.floor(p[0]+1e-6); i++) {
        for (let j = Math.floor(p[1]-1e-6); j <= Math.floor(p[1]+1e-6); j++) {
          for (const {at,t} of vertices.get(cellKey(i,j)) || []) {
            if (t.layer !== layer || dist(at,p) >= 1e-6) continue;
            if (first && first !== t) return true;
            first = t;
          }
        }
      }
      return false;
    }
    for (const t of tracks) for (const p of [t.points[0], t.points[t.points.length - 1]]) {
      if (covered(p,t.layer)) continue;
      const e = {at: p.slice(), layer: t.layer, r: t.width / 2, kind: "track", id: t.id};
      out.push(e); cover(e);
    }
    return out;
  }
  // One pass over the board serves all ribbon lanes. The session holds this read-only
  // inventory until it ends; a new command sees the then-current board and definitions.
  function laneInventory(board, defs, nets, opts = {}) {
    const index = globalThis.AtriumLength?.routingIndex?.(board, defs, opts);
    if (index) {
      const ends = new Map(), groups = new Map();
      for (const net of nets) {
        const group = index.groups.get(net), items = index.itemsFor(net);
        groups.set(net, items);
        if (group) group.endpoints ||= endpoints({items}, defs, net);
        ends.set(net, group?.endpoints || []);
      }
      return {ends, groups, byId: index.byId, parts: index.parts, index};
    }
    const groups = new Map(nets.map(n => [n, []])), byId = new Map(), parts = new Map();
    for (const it of board.items) {
      if (it.kind === "part") {
        byId.set(it.id, it); parts.set(it.ref, it);
        for (const net of new Set(Object.values(it.pinNets || {}))) groups.get(net)?.push(it);
      } else if (it.kind === "pad" || it.kind === "via" || it.kind === "track") groups.get(it.net)?.push(it);
    }
    const ends = new Map();
    for (const [net, items] of groups) ends.set(net, endpoints({items}, defs, net));
    return {ends, groups, byId, parts};
  }
  function onLayer(end, layer) {
    if (!layer) return true;
    if (end.layer) return end.layer === layer;
    if (!end.via) return true;
    const stack = globalThis.AtriumViaStack;
    if (stack) return stack.padOn(end.via, layer).diameter > 0;
    if (!end.via.fromLayer || !end.via.toLayer) return true;
    const li = RT().core.layerIndex, from = li(end.via.fromLayer), to = li(end.via.toLayer), k = li(layer);
    return k >= Math.min(from,to) && k <= Math.max(from,to);
  }
  // X distance bounds Euclidean distance. Walk outwards from the queried X and stop when
  // neither side can improve the best result. Equal distances keep the original board order.
  const orderedEnds = new WeakMap();
  function nearestEnd(ends, at, accept) {
    let best = null, bestD = Infinity, bestOrder = Infinity;
    function consider(e, order) {
      if (accept && !accept(e)) return;
      const d = dist(e.at,at);
      if (d < bestD || (d === bestD && order < bestOrder)) { best = e; bestD = d; bestOrder = order; }
    }
    if (ends.length < 32) ends.forEach(consider);
    else {
      let ordered = orderedEnds.get(ends);
      if (!ordered) {
        ordered = ends.map((e,order) => ({e,order})).sort((a,b) => a.e.at[0]-b.e.at[0] || a.order-b.order);
        orderedEnds.set(ends,ordered);
      }
      let lo=0, hi=ordered.length;
      while (lo<hi) { const mid=(lo+hi)>>>1; if (ordered[mid].e.at[0]<at[0]) lo=mid+1; else hi=mid; }
      let left=lo-1, right=lo;
      while (left>=0 || right<ordered.length) {
        const dxL=left>=0 ? at[0]-ordered[left].e.at[0] : Infinity;
        const dxR=right<ordered.length ? ordered[right].e.at[0]-at[0] : Infinity;
        if (Math.min(dxL,dxR)>bestD) break;
        const row=dxL<=dxR ? ordered[left--] : ordered[right++]; consider(row.e,row.order);
      }
    }
    return best;
  }
  // Per net, the copper end nearest `near` (or the end of the given item ids).
  function membersNear(board, defs, nets, near, o = {}) {
    const ids = o.ids ? new Set(o.ids) : null, out = [], inventory = o.inventory || laneInventory(board, defs, nets, o);
    for (const net of nets) {
      let list = inventory.ends.get(net) || [];
      if (ids) {
        const mine = list.filter(e => onLayer(e,o.layer) && ((e.id && ids.has(e.id)) || (e.part && ids.has(e.part))));
        if (mine.length) list = mine;
      }
      const e = nearestEnd(list,near,end => onLayer(end,o.layer) && !o.exclude?.some(p=>dist(p,end.at)<1e-6) && !o.skip?.(end));
      if (!e) continue;
      out.push({net, at: [e.at[0], e.at[1]], layer: e.layer, r: e.r, kind: e.kind, part: e.part, pad: e.pad, ref: e.ref});
    }
    return out;
  }
  // Starts from selected tracks and vias (Interactive Multi-Routing's selection), one per net.
  function membersFromSelection(board, ids, target) {
    const M = globalThis.AtriumMultiRoute;
    const list = M?.startsFrom ? M.startsFrom(board, ids, target) : [];
    return list.map(s => {
      const it = board.items.find(i => i.net === s.net && (i.kind === "via" ? dist([i.x, i.y], s.at) < 1e-6 : i.kind === "track" && (dist(i.points[0], s.at) < 1e-6 || dist(i.points[i.points.length - 1], s.at) < 1e-6)));
      return {net: s.net, at: s.at, layer: s.layer, r: it?.kind === "via" ? (it.diameter || 0.6) / 2 : (it?.width || 0.2) / 2, kind: it?.kind || "track"};
    });
  }

  // ---------------------------------------------------------------- geometry
  // Octilinear unit vector nearest to the direction (dx, dy).
  function octant(dx, dy) {
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const c = Math.cos(a), s = Math.sin(a);
    return [Math.abs(c) < 1e-12 ? 0 : c, Math.abs(s) < 1e-12 ? 0 : s];
  }
  // Parallel offset of a polyline, left of travel for d > 0, mitred. Segments that would reverse (a corner tighter than
  // the offset) are folded away by intersecting their neighbours. Returns {pts, src} (src: spine vertex of each point).
  function offsetPath(pts, d) {
    if (pts.length < 2) return {pts: pts.map(p => [p[0], p[1]]), src: pts.map((p, i) => i)};
    if (Math.abs(d) < 1e-12) return {pts: pts.map(p => [p[0], p[1]]), src: pts.map((p, i) => i)};
    // Offset lines per segment: point + direction.
    let segs = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], l = dist(a, b);
      if (l < 1e-12) continue;
      const u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], nn = [-u[1], u[0]];
      segs.push({a: [a[0] + nn[0] * d, a[1] + nn[1] * d], b: [b[0] + nn[0] * d, b[1] + nn[1] * d], u, i0: i - 1, i1: i});
    }
    if (!segs.length) return {pts: [pts[0].slice()], src: [0]};
    const meet = (s, t) => {
      const den = s.u[0] * t.u[1] - s.u[1] * t.u[0];
      if (Math.abs(den) < 1e-12) return null;   // parallel: no corner
      const wx = t.a[0] - s.a[0], wy = t.a[1] - s.a[1], k = (wx * t.u[1] - wy * t.u[0]) / den;
      return [s.a[0] + s.u[0] * k, s.a[1] + s.u[1] * k];
    };
    for (let guard = 0; guard < 4 * segs.length + 4; guard++) {
      // Vertices: first start, joints, last end.
      const V = [segs[0].a];
      for (let i = 1; i < segs.length; i++) {
        const m = meet(segs[i - 1], segs[i]);
        V.push(m || segs[i].a);
      }
      V.push(segs[segs.length - 1].b);
      let bad = -1;
      for (let i = 0; i < segs.length; i++) {
        const v = [V[i + 1][0] - V[i][0], V[i + 1][1] - V[i][1]];
        if (v[0] * segs[i].u[0] + v[1] * segs[i].u[1] < -1e-9) { bad = i; break; }
      }
      if (bad < 0 || segs.length <= 1) {
        const src = [segs[0].i0, ...segs.slice(1).map(s => s.i0), segs[segs.length - 1].i1];
        return {pts: V, src};
      }
      // A reversed end segment: drop it (the ribbon end is then the neighbour's end); else fold it away.
      segs.splice(bad, 1);
    }
    return {pts: segs.length ? [segs[0].a, segs[segs.length - 1].b] : [pts[0]], src: [0, pts.length - 1]};
  }
  // Converges members from start points onto parallel lanes along direction u (a unit octilinear vector).
  //   starts[k] {at, r}: start point and the radius of the copper there (pad, via or track end)
  //   lanes[k]: lane offset of member k across the ribbon (left of travel positive)
  //   widths[k], gapOf(i, j): edge gap between members i and j
  //   o.c: lane centre across (default: the centre of the starts), o.lead: minimum straight lead from a start
  // Returns {paths[k] (world, ending on the launch line), L (centre of the launch line), D, crossing, frame}.
  function gather(starts, lanes, widths, gapOf, u, o = {}) {
    const n = starts.length, nrm = [-u[1], u[0]];
    const O = o.origin || [starts.reduce((s, q) => s + q.at[0], 0) / n, starts.reduce((s, q) => s + q.at[1], 0) / n];
    const a = starts.map(s => (s.at[0] - O[0]) * nrm[0] + (s.at[1] - O[1]) * nrm[1]);
    const y = starts.map(s => (s.at[0] - O[0]) * u[0] + (s.at[1] - O[1]) * u[1]);
    const lanesMid = (Math.min(...lanes) + Math.max(...lanes)) / 2;
    const c = finite(o.c) ? o.c : (Math.min(...a) + Math.max(...a)) / 2 - lanesMid;
    const l = lanes.map(v => c + v), dx = l.map((v, k) => v - a[k]);
    const lead = starts.map(s => Math.max(o.lead ?? 0, s.r || 0));
    const right = [], left = [];
    for (let k = 0; k < n; k++) { if (dx[k] > EPS) right.push(k); else if (dx[k] < -EPS) left.push(k); }
    const cR = new Array(n).fill(-Infinity), cL = new Array(n).fill(-Infinity);
    const need = (k, m) => (starts[m].r || 0) + gapOf(k, m) + widths[k] / 2;
    // Right movers (along = across + c): from the rightmost lane, each next one stacked above its neighbour.
    right.sort((p, q) => l[q] - l[p]);
    let prev = -1;
    for (const k of right) {
      let v = y[k] + lead[k] - a[k];
      for (let m = 0; m < n; m++) if (m !== k && a[m] > a[k] - EPS && a[m] < l[k] + need(k, m)) v = Math.max(v, y[m] - a[m] + SQ2 * need(k, m));
      if (prev >= 0) v = Math.max(v, cR[prev] + SQ2 * (widths[k] / 2 + gapOf(k, prev) + widths[prev] / 2));
      cR[k] = v; prev = k;
    }
    // Left movers (along = -across + c): from the leftmost lane.
    left.sort((p, q) => l[p] - l[q]);
    prev = -1;
    for (const k of left) {
      let v = y[k] + lead[k] + a[k];
      for (let m = 0; m < n; m++) if (m !== k && a[m] < a[k] + EPS && a[m] > l[k] - need(k, m)) v = Math.max(v, y[m] + a[m] + SQ2 * need(k, m));
      if (prev >= 0) v = Math.max(v, cL[prev] + SQ2 * (widths[k] / 2 + gapOf(k, prev) + widths[prev] / 2));
      cL[k] = v; prev = k;
    }
    const entry = new Array(n);
    for (let k = 0; k < n; k++) entry[k] = dx[k] > EPS ? cR[k] + l[k] : dx[k] < -EPS ? cL[k] - l[k] : y[k] + lead[k];
    let D = Math.max(...entry);
    if (finite(o.minD)) D = Math.max(D, o.minD);
    const W = (x, al) => [O[0] + nrm[0] * x + u[0] * al, O[1] + nrm[1] * x + u[1] * al];
    const paths = [];
    for (let k = 0; k < n; k++) {
      const p = [starts[k].at.slice()];
      if (dx[k] > EPS) { p.push(W(a[k], cR[k] + a[k]), W(l[k], cR[k] + l[k])); }
      else if (dx[k] < -EPS) { p.push(W(a[k], cL[k] - a[k]), W(l[k], cL[k] - l[k])); }
      p.push(W(l[k], D));
      paths.push(RT().core.simplify(p));
    }
    // Crossing: the order of the starts across differs from the order of the lanes.
    const byA = [...Array(n).keys()].sort((p, q) => a[p] - a[q]), byL = [...Array(n).keys()].sort((p, q) => l[p] - l[q]);
    const crossing = byA.some((k, i) => k !== byL[i]);
    return {paths, L: W(c, D), D, c, crossing, u: u.slice(), n: nrm, O};
  }

  // ---------------------------------------------------------------- rules and lanes
  // The matched-length group of the nets: target (explicit only) and tolerance.
  function groupTarget(board, defs, nets, o = {}) {
    let target = finite(o.target) ? o.target : null, tolerance = finite(o.tolerance) ? o.tolerance : null, name = null;
    // targetFor (high-speed suite): the tolerance that applies to the net, xSignal and delay groups included.
    try {
      const L = globalThis.AtriumLength;
      const groups = L?.groups?.(board, defs, o) || [];
      if (tolerance == null) {
        const t = L?.targetFor?.(board, defs, nets[0], {...o, groups});
        if (finite(t?.tolerance)) tolerance = t.tolerance;
      }
      for (const g of groups) {
        const mine = g.members.flatMap(m => m.nets || []);
        if (!nets.some(n => mine.includes(n))) continue;
        if (tolerance == null && finite(g.tolerance)) tolerance = g.tolerance;
        if (target == null && finite(g.explicit)) target = g.explicit;
        name = g.name; break;
      }
    } catch { /* no length module */ }
    return {target, tolerance: tolerance ?? 0.254, name};
  }
  const bandOf = (delta, tol) => Math.abs(delta) <= tol + 1e-9 ? "ok" : Math.abs(delta) <= 2 * tol + 1e-9 ? "close" : "out";

  // ---------------------------------------------------------------- session
  function begin(board, defs, o = {}) {
    const R = RT(), C = R.core;
    if (!board || board.kind && board.kind !== "pcb") fail("Open a PCB layout to route a bus.");
    let members = (o.members || []).map((m, k) => {
      if (!m || !Array.isArray(m.at) || !finite(m.at[0]) || !finite(m.at[1])) fail("Bus member " + (k + 1) + " needs a start point.");
      return {net: String(m.net || ""), at: [m.at[0], m.at[1]], layer: m.layer || null, r: finite(m.r) ? m.r : 0.1, kind: m.kind || "point", part: m.part, pad: m.pad};
    });
    const inventory = laneInventory(board, defs, members.length ? members.map(m => m.net) : o.nets || [], o);
    if (inventory.index) o = {...o, routingIndex: inventory.index};
    if (!members.length && Array.isArray(o.nets)) members = membersNear(board, defs, o.nets, o.near || [0, 0], {inventory});
    if (members.length < 2) fail("A bus needs two or more nets with copper to start from.");
    if (members.length > MAX) fail("A bus takes at most " + MAX + " nets.");
    const nets = members.map(m => m.net);
    if (nets.some(n => !n)) fail("Every bus member must be on a net.");
    if (new Set(nets).size !== nets.length) fail("Each bus member must be on its own net.");
    const W = R.world(board, defs, {revision:o.revision,project:o.project,rules:o.rules}), rules = C.rulesFor(board, o.rules, o.project, defs);
    W.scene.reset();
    let layer = o.layer && C.layerIndex(o.layer) >= 0 ? o.layer : members.find(m => m.layer)?.layer || "Top";
    const NET0 = (() => { const c = C.makeContext(W, rules, {layer, hw: 0.1, net: -1, netName: ""}); return c.clr.length - W.netNames.length; })();
    const netId = net => W.netIds.has(net) ? W.netIds.get(net) : 1e9;
    const pairs = pairsOf(board, nets);
    const grp = groupTarget(board, defs, nets, o);
    const corner0 = rules.corners(nets[0]);
    // Each member's destination (its nearest other copper end): the readout projects lengths onto it while routing.
    const guessDests = () => members.map(m => {
      const e = nearestEnd(inventory.ends.get(m.net),m.at,end=>dist(end.at,m.at)>1);
      return e ? {at:e.at,d:dist(e.at,m.at)} : null;
    });
    const st = {
      mode: C.MODES.includes(o.mode) ? o.mode : "walkaround",
      corner: C.CORNERS.includes(o.corner) ? o.corner : corner0.style || "45",
      bend: !!o.bend, fixedBend: typeof o.bend === "boolean", neck: false, pattern: PATTERNS.includes(o.viaPattern) ? o.viaPattern : "staggered",
      width: finite(o.width) && o.width > 0 ? o.width : null, gap: finite(o.gap) && o.gap >= 0 ? o.gap : null,
      arcRadius: finite(o.arcRadius) ? o.arcRadius : finite(corner0.radius) && corner0.radius > 0 ? corner0.radius : null,
      via: o.viaStyle && finite(o.viaStyle.diameter) ? {...o.viaStyle} : (() => { const v = rules.via(nets); return {diameter: v.diameter, drill: v.drill}; })(),
      order: null, manualOrder: Array.isArray(o.order) ? o.order.slice() : null,
      legs: [], vias: [], undo: [], base: new Map(), last: null, cursor: null, done: false, swaps: [], dests: null, visited: [], hop: 0, arrivals: [], clicks: [],
      pushMs: finite(o.pushBudgetMs) ? o.pushBudgetMs : 6, moveMs: finite(o.moveBudgetMs) ? o.moveBudgetMs : 8, maxShoves: o.maxShoves || 64, locked: new Set(o.locked || [])
    };
    // Lane configuration for an order: widths, offsets (centred) and the ribbon half width.
    function cfgFor(order, neck, lay) {
      const n = order.length, widths = new Array(n), offsets = new Array(n);
      const wOf = k => {
        const net = nets[k], p = pairs.get(net);
        if (p) { const d = rules.diffPair(p.positive, p.negative, p.name, lay); return neck ? Math.min(d.minWidth ?? d.width, d.width) : d.width; }
        const w = rules.width(net, lay);
        return neck ? w.min : st.width ?? w.preferred;
      };
      for (const k of order) widths[k] = wOf(k);
      let pos = 0;
      order.forEach((k, s) => {
        if (s > 0) {
          const j = order[s - 1], p = pairs.get(nets[k]);
          let g;
          if (p && pairs.get(nets[j]) === p) { const d = rules.diffPair(p.positive, p.negative, p.name, lay); g = neck ? Math.min(d.minGap ?? d.gap, d.gap) : d.gap; }
          else { g = rules.clearance(nets[j], nets[k], lay); if (!neck && st.gap != null) g = Math.max(g, st.gap); }
          pos += widths[j] / 2 + g + SLACK + widths[k] / 2;
        }
        offsets[k] = pos;
      });
      const mid = (offsets[order[0]] + offsets[order[n - 1]]) / 2;
      for (const k of order) offsets[k] -= mid;
      const half = Math.max(...order.map(k => Math.abs(offsets[k]) + widths[k] / 2));
      return {widths, offsets, half, neck, order: order.slice()};
    }
    const gapOf = lay => (i, j) => {
      const p = pairs.get(nets[i]);
      if (p && pairs.get(nets[j]) === p) { const d = rules.diffPair(p.positive, p.negative, p.name, lay); return Math.min(d.gap, d.minGap ?? d.gap) + SLACK; }
      return rules.clearance(nets[i], nets[j], lay) + SLACK;
    };
    // Members ordered across the direction u: pairs stay adjacent (positive first along the across axis).
    function autoOrder(starts, u) {
      const nrm = [-u[1], u[0]], across = s => s.at[0] * nrm[0] + s.at[1] * nrm[1];
      if (st.manualOrder) {
        const idx = st.manualOrder.map(n => nets.indexOf(n)).filter(k => k >= 0);
        if (idx.length === nets.length && new Set(idx).size === idx.length) return idx;
      }
      const units = [], used = new Set();
      for (let k = 0; k < nets.length; k++) {
        if (used.has(k)) continue;
        const p = pairs.get(nets[k]);
        const mate = p ? nets.indexOf(p.positive === nets[k] ? p.negative : p.positive) : -1;
        if (mate >= 0 && !used.has(mate)) {
          used.add(k); used.add(mate);
          const ks = [k, mate].sort((x, y) => across(starts[x]) - across(starts[y]));
          units.push({ks, at: (across(starts[k]) + across(starts[mate])) / 2});
        } else { used.add(k); units.push({ks: [k], at: across(starts[k])}); }
      }
      units.sort((x, y) => x.at - y.at);
      return units.flatMap(x => x.ks);
    }
    function newLeg(lay, starts, cfg) {
      return {layer: lay, starts: starts.map(s => ({at: s.at.slice(), r: s.r})), cfg, u: null, gather: null, spine: [], frozen: false, tails: null, neck: !!cfg?.neck, hop: st.hop};
    }
    try { const g = guessDests(); if (g.every(Boolean)) st.dests = g; } catch { /* no destinations */ }
    st.legs.push(newLeg(layer, members, null));
    const leg = () => st.legs[st.legs.length - 1];
    // Direction of a leg: frozen after its first anchor, else the octant toward the cursor.
    let launch = null;
    function legGeometry(L, p) {
      if (L.frozen) return L;
      const n = L.starts.length, cx = L.starts.reduce((s, q) => s + q.at[0], 0) / n, cy = L.starts.reduce((s, q) => s + q.at[1], 0) / n;
      let dx = p[0] - cx, dy = p[1] - cy;
      if (Math.hypot(dx, dy) < 1e-6) { dx = 1; dy = 0; }
      let u = L.fixedU || octant(dx, dy);
      if (launch?.leg === L && !L.fixedU) {
        // Near an octant boundary, keep the gather until the pointer moves one lane
        // width towards the new direction. Both directions still follow the cursor.
        const old = launch.geometry.u;
        if (dx * (u[0] - old[0]) + dy * (u[1] - old[1]) < Math.min(...launch.geometry.cfg.widths)) u = old;
      }
      if (launch?.leg === L && launch.neck === L.neck && launch.order === st.manualOrder &&
          launch.width === st.width && launch.gap === st.gap && launch.geometry.u[0] === u[0] && launch.geometry.u[1] === u[1]) return launch.geometry;
      const order = st.legs.length === 1 && !L.fixedOrder ? autoOrder(L.starts, u) : L.cfg.order;
      const cfg = st.legs.length === 1 && !L.fixedOrder ? cfgFor(order, L.neck, L.layer) : L.cfg;
      const g = gather(L.starts, cfg.offsets, cfg.widths, gapOf(L.layer), u, {c: L.fixedC, lead: 0});
      const geometry = {...L, u, cfg, gather: g};
      launch = {leg:L, neck:L.neck, order:st.manualOrder, width:st.width, gap:st.gap, geometry};
      return geometry;
    }
    // Contexts: the wide spine (member nets exempt) and one per member, cached per layer.
    const ctxCache = new Map();
    function spineCtx(lay, cfg) {
      const hw = cfg.half, key = "s|" + lay + "|" + hw.toFixed(6) + "|" + C.baseCorner(st.corner);
      let c = ctxCache.get(key);
      if (!c || c.epoch !== W.hullEpoch) {
        c = C.makeContext(W, rules, {layer: lay, hw, net: netId(nets[0]), netName: nets[0], base: C.baseCorner(st.corner), dirs: {"45": 8, "90": 4, any: 16}[C.baseCorner(st.corner)]});
        for (const n of nets) { const id = netId(n); if (id < 1e9 && id + NET0 < c.clr.length) c.clr[id + NET0] = -hw - 1; }
        c.epoch = W.hullEpoch; ctxCache.set(key, c);
      }
      c.exempt = new Set(); c.endExempt = new Set();
      return c;
    }
    function memberCtx(lay, k, w) {
      const key = "m|" + lay + "|" + k + "|" + w.toFixed(6);
      let c = ctxCache.get(key);
      if (!c || c.epoch !== W.hullEpoch) {
        c = C.makeContext(W, rules, {layer: lay, hw: w / 2, net: netId(nets[k]), netName: nets[k], base: C.baseCorner(st.corner), dirs: 8});
        c.epoch = W.hullEpoch; ctxCache.set(key, c);
      }
      c.exempt = new Set(); c.endExempt = new Set();
      return c;
    }
    function restoreScene() { const sc = W.scene; sc.reset(); for (const [ow, g] of st.base) sc.set(ow, g); }
    // Arc corners on the spine: a radius large enough that the innermost member keeps a positive radius.
    function rounded(spine, cfg, okFn) {
      if (!C.hasArc(st.corner) || spine.length < 3) return spine;
      const Rr = Math.max(st.arcRadius || 0, cfg.half + Math.max(...cfg.widths) * 1.5, 2.5 * Math.max(...cfg.widths));
      return C.fillet(spine, Rr, okFn || null);
    }
    // Member polylines of a leg for a spine: gather + offset (+ tail). heads mark where the unanchored head begins.
    function memberLines(L, spine, cfg) {
      const out = [];
      for (let k = 0; k < nets.length; k++) {
        const off = offsetPath(spine, cfg.offsets[k]);
        const g = L.gather.paths[k];
        // Spreading out of a neck: the transition keeps the narrow width until the members are at the wide pitch.
        const pw = L.preWidths?.[k], pre = pw != null && pw < cfg.widths[k] - 1e-9 && g.length > 1 ? {pts: g, width: pw} : null;
        let pts = pre ? [g[g.length - 1], ...off.pts.slice(1)] : [...g, ...off.pts.slice(1)];
        if (L.tails?.[k]) pts = [...pts, ...L.tails[k].slice(1)];
        out.push({k, net: nets[k], pts, width: cfg.widths[k], layer: L.layer, headFrom: off, gatherLen: pre ? 1 : g.length, pre});
      }
      return out;
    }
    // The spine of the current leg toward p: launch lead, then the corner-style connector or the hull walk.
    function computeSpine(L, p, c, bend) {
      const base = C.baseCorner(st.corner), anchored = L.spine.length ? L.spine : [L.gather.L];
      const a = anchored[anchored.length - 1];
      let head, status = "ok", side = 0;
      const lead = L.spine.length ? 0 : Math.max(L.cfg.half, 0.2);
      const start = L.spine.length ? a : [a[0] + L.u[0] * lead, a[1] + L.u[1] * lead];
      const ahead = (p[0] - a[0]) * L.u[0] + (p[1] - a[1]) * L.u[1];
      if (!L.spine.length && ahead < lead + 1e-6) return {spine: [a, start], head: [a, start], status: "ok", anchoredLen: 1};
      const direct = C.simplify([...(L.spine.length ? [] : [a]), ...C.connector(start, p, base, bend)]);
      if (!c) head = direct;
      else {
        c.deadline = now() + st.moveMs;
        const last = st.last, sameLaunch = last?.L.gather === L.gather && last.L.spine === L.spine;
        const r = C.walkaround(c, start, p, bend, {side:sameLaunch ? last.side : 0, slack:L.cfg.half + c.maxClr});
        if (r.ok) side = r.side;
        head = C.simplify([...(L.spine.length ? [] : [a]), ...r.path]);
        status = r.status;
      }
      const spine = C.simplify([...anchored.slice(0, -1), ...head]);
      return {spine, head, status, side, anchoredLen: anchored.length};
    }
    const scMax = rules.maxClearance() ?? Infinity;
    // Validates member lines against the board (exact clearance): first failing member and segment, or null.
    function firstHit(lines, pendingJoin = false) {
      for (const m of lines) {
        const c = memberCtx(m.layer, m.k, m.width);
        const h = C.pathHit(c, m.pts, true);
        if (h) return {k: m.k, seg: h.seg, f: h.f};
        if (m.pre) { const hp = C.pathHit(memberCtx(m.layer, m.k, m.pre.width), m.pre.pts, true); if (hp) return {k: m.k, seg: 0, f: hp.f}; }
      }
      if (pendingJoin) return null; // the final incoming fan changes the offset joints and is verified as a whole
      const segments = [];
      for (const m of lines) {
        const pieces = m.pre ? [[m.pts, m.width], [m.pre.pts, m.pre.width]] : [[m.pts, m.width]];
        for (const [pts, width] of pieces) for (let i = 1; i < pts.length; i++) {
          const a = pts[i-1], b = pts[i], r = width / 2;
          segments.push({a,b,r,k:m.k,net:m.net,layer:m.layer,seg:i-1,box:[Math.min(a[0],b[0])-r,Math.min(a[1],b[1])-r,Math.max(a[0],b[0])+r,Math.max(a[1],b[1])+r]});
        }
      }
      segments.sort((a, b) => a.box[0] - b.box[0]);
      const broad = scMax;
      const subject = s => ({kind:"track",ck:"track",net:s.net,layer:s.layer,width:2*s.r,span:[C.layerIndex(s.layer),C.layerIndex(s.layer)],box:s.box});
      for (let i = 0; i < segments.length; i++) {
        const a = segments[i], A = a.box;
        for (let j = i+1; j < segments.length; j++) {
          const b = segments[j], B = b.box;
          if (A[2]+broad < B[0]) break;
          if (a.k === b.k || a.layer !== b.layer || A[3]+broad < B[1] || B[3]+broad < A[1]) continue;
          const gap = rules.physical ? rules.physical(subject(a),subject(b)) ?? 0 : rules.clearance(a.net,b.net,a.layer);
          const need = Math.max(0,a.r+b.r+gap-1e-6);
          if (C.segSeg2(...a.a,...a.b,...b.a,...b.b) < need*need) return {k:b.k,seg:b.seg,f:-1};
        }
      }
      return null;
    }
    function anchoredLines(li) {
      const out = [];
      for (let i = 0; i < st.legs.length - 1; i++) {
        const L = st.legs[i];
        if (C.layerIndex(L.layer) !== li) continue;
        for (const m of L.lines || []) { out.push({pts: m.pts, hw: m.width / 2, net: netId(m.net), net2: -99, lo: li, hi: li}); if (m.pre) out.push({pts: m.pre.pts, hw: m.pre.width / 2, net: netId(m.net), net2: -99, lo: li, hi: li}); }
      }
      for (const v of st.vias) if (v.lo <= li && v.hi >= li) out.push({pts: [[v.x, v.y]], hw: v.diameter / 2, net: netId(v.net), net2: -99, lo: v.lo, hi: v.hi});
      return out;
    }
    function compute(p, pendingJoin = false) {
      const test = lines => firstHit(lines, pendingJoin);
      const t0 = now();
      restoreScene();
      const L = legGeometry(leg(), p), cfg = L.cfg, lay = L.layer, li = C.layerIndex(lay);
      const sc = spineCtx(lay, cfg);
      let pushed = false, status = "ok", res = null;
      const tryPush = sp => {
        const lines = memberLines(L, sp.spine, cfg);
        const c0 = memberCtx(lay, 0, cfg.widths[0]); c0.deadline = now() + st.moveMs;
        const heads = [...lines.flatMap(m => [{pts: m.pts, hw: m.width / 2, net: netId(m.net), net2: -99, lo: li, hi: li}, ...m.pre ? [{pts: m.pre.pts, hw: m.pre.width / 2, net: netId(m.net), net2: -99, lo: li, hi: li}] : []]), ...anchoredLines(li)];
        const r = C.shove(null, c0, heads, {ms: st.pushMs, shoves: st.maxShoves, locked: st.locked});
        if (r.ok) return lines;
        restoreScene(); return null;
      };
      const continuing = st.last?.L.gather === L.gather && st.last.L.spine === L.spine;
      let bend = !st.fixedBend && continuing ? st.last.bend : st.bend;
      let direct = computeSpine(L, p, null, bend);
      res = {sp: direct, lines: memberLines(L, direct.spine, cfg)};
      if (st.mode !== "ignore") {
        res.hit = test(res.lines);
        // Both 45° elbows have the same shortest length. Keep the last legal bend;
        // when it hits copper, test the other before taking a detour or moving a neighbour.
        if (res.hit && !st.fixedBend && (st.mode === "walkaround" || st.mode === "hug")) {
          const alternate = computeSpine(L, p, null, !bend);
          if (alternate.head.length > 2 && (alternate.head.length !== direct.head.length || dist(alternate.head.at(-2), direct.head.at(-2)) > EPS)) {
            const lines = memberLines(L, alternate.spine, cfg);
            if (!test(lines)) { bend = !bend; direct = alternate; res = {sp: direct, lines, hit: null}; }
          }
        }
        if (res.hit && st.mode !== "stop") {
          const walk = () => {
            const sp = computeSpine(L, p, sc, bend);
            return {sp, lines: memberLines(L, sp.spine, cfg)};
          };
          if (st.mode === "push") {
            pushed = !!tryPush(direct);
            if (!pushed) res = walk(); else delete res.hit;
          } else {
            res = walk();
            if (st.mode === "hug" && (res.sp.status !== "ok" || plen(res.sp.head) > 1.4 * plen(direct.head) + 0.5 || test(res.lines))) {
              pushed = !!tryPush(direct);
              if (pushed) res = {sp: direct, lines: memberLines(L, direct.spine, cfg)};
            }
          }
        }
      }
      status = pushed ? "pushed" : res.sp.status;
      // Arc corners: fillet the spine where every member stays clear.
      if (C.hasArc(st.corner) && res.sp.spine.length > 2) {
        const okFn = st.mode === "ignore" ? null : pts => !test(memberLines(L, pts, cfg));
        const sp2 = rounded(res.sp.spine, cfg, okFn);
        res = {sp: {...res.sp, spine: sp2}, lines: memberLines(L, sp2, cfg)};
      }
      // Exact check; a blocked head is cut back to its longest clear prefix (anchored copper is never cut).
      if (st.mode !== "ignore") {
        const hit = "hit" in res ? res.hit : test(res.lines);
        if (hit) {
          const anchoredSpine = res.sp.spine.slice(0, Math.max(1, res.sp.anchoredLen));
          const headPart = res.sp.spine.slice(Math.max(0, res.sp.anchoredLen - 1));
          const total = plen(headPart);
          const cut = t => { const out = [headPart[0]]; let left = t * total; for (let i = 1; i < headPart.length; i++) { const s = dist(headPart[i - 1], headPart[i]); if (left >= s) { out.push(headPart[i]); left -= s; } else { const f = left / s; out.push([headPart[i - 1][0] + (headPart[i][0] - headPart[i - 1][0]) * f, headPart[i - 1][1] + (headPart[i][1] - headPart[i - 1][1]) * f]); break; } } return C.simplify([...anchoredSpine.slice(0, -1), ...out]); };
          let lo = 0, hi = 1, best = null;
          const zero = cut(0), zl = memberLines(L, zero.length > 1 ? zero : [zero[0], zero[0]], cfg);
          if (test(zl)) { status = "violation"; }
          else {
            for (let i = 0; i < 18; i++) { const t = (lo + hi) / 2, s = cut(t); if (s.length > 1 && !test(memberLines(L, s, cfg))) { lo = t; best = s; } else hi = t; }
            if (best && plen(best) > 1e-6) res = {sp: {...res.sp, spine: best}, lines: memberLines(L, best, cfg)};
            else res = {sp: {...res.sp, spine: zero}, lines: zl};
            status = "blocked";
          }
        }
      }
      return {L, cfg, bend, side:res.sp.side, spine: res.sp.spine, anchoredLen: res.sp.anchoredLen, lines: res.lines, status, pushed, ms: now() - t0, cursor: p};
    }
    // Length of member k so far: earlier legs, this leg and the copper it started from.
    const preLen = members.map(m => m.kind === "track" || m.kind === "via" ? inventory.groups.get(m.net).filter(i => i.kind === "track" && i.points?.length > 1).reduce((s, t) => s + (globalThis.Atrium?.pathLength?.(t) ?? plen(t.points)), 0) : 0);
    const lengthEngine = globalThis.AtriumLength, timing = globalThis.AtriumTiming?.model?.(board, defs, o.routingIndex);
    const rates = lengthEngine?.delayRates?.(board, defs, o) || ((net, layer, width) => timing?.factor(layer, width) || (layer === "Top" || layer === "Bottom" ? 5.9 : 6.9));
    const preDelay = nets.map((net, k) => preLen[k] * rates(net, layer, rules.width(net, layer).preferred));
    for (let k = 0; k < nets.length; k++) {
      const net = nets[k], atEnd = preLen[k] > 0, measured = lengthEngine?.matchLength?.(board, defs, net, o);
      if (atEnd && measured && !measured.unrouted && measured.length > 0) {
        preLen[k] = measured.length; preDelay[k] = measured.delay;
      } else if (!atEnd && measured?.xSignal && !measured.unrouted) {
        const own = lengthEngine.netLength(board, defs, net, o);
        preLen[k] += measured.length - own.length; preDelay[k] += measured.delay - own.delay;
      }
    }
    function readout(r) {
      const lens = preLen.slice(), dly = preDelay.slice();
      const addLine = m => {
        const len = plen(m.pts), pre = m.pre ? plen(m.pre.pts) : 0;
        lens[m.k] += len + pre;
        dly[m.k] += len * rates(m.net, m.layer, m.width);
        if (pre) dly[m.k] += pre * rates(m.net, m.layer, m.pre.width);
      };
      for (let i = 0; i < st.legs.length - 1; i++) for (const m of st.legs[i].lines || []) addLine(m);
      for (const m of r?.lines || []) addLine(m);
      if (timing) for (const via of st.vias) {
        const k = nets.indexOf(via.net), barrel = timing.via(via);
        lens[k] += barrel.length; dly[k] += barrel.ps;
      }
      const ends = (r?.lines || []).map(m => m.pts[m.pts.length - 1]);
      // With destinations known, compare projected lengths (so far + straight to the destination).
      const proj = lens.map((l, k) => st.dests?.[k] && ends[k] && !st.done ? l + dist(ends[k], st.dests[k].at) : l);
      const ref = grp.target != null && st.done ? grp.target : Math.max(...proj);
      return nets.map((net, k) => ({net, length: r6(lens[k]), delay: r6(dly[k]), projected: r6(proj[k]), delta: r6(proj[k] - ref), band: bandOf(proj[k] - ref, grp.tolerance), end: ends[k] || null}));
    }
    function result(r) {
      const preview = [];
      for (let i = 0; i < st.legs.length - 1; i++) for (const m of st.legs[i].lines || []) { if (m.pre) preview.push({points: m.pre.pts, width: m.pre.width, layer: m.layer, net: m.net}); preview.push({points: m.pts, width: m.width, layer: m.layer, net: m.net}); }
      for (const m of r?.lines || []) {
        if (m.pre) preview.push({points: m.pre.pts, width: m.pre.width, layer: m.layer, net: m.net});
        // The anchored part of the current leg, then the head.
        const off = m.headFrom, cut = off.src.findIndex(s => s >= (r.anchoredLen || 1) - 1);
        const split = cut >= 0 ? m.gatherLen - 1 + cut : m.pts.length - 1;
        const a = m.pts.slice(0, split + 1), h = m.pts.slice(split);
        if (a.length > 1) preview.push({points: a, width: m.width, layer: m.layer, net: m.net});
        if (h.length > 1) preview.push({points: h, width: m.width, layer: m.layer, net: m.net, head: true});
      }
      const pushedItems = [], hidden = [];
      for (const [ow, g] of W.scene.mods) {
        const rec = W.owners[ow]; hidden.push(rec.id);
        if (g.kind === "track") pushedItems.push({id: rec.id, kind: "track", points: g.points, width: g.width, layer: g.layer, net: W.netName(g.net)});
        else pushedItems.push({id: rec.id, kind: "via", x: g.x, y: g.y, diameter: g.diameter, drill: rec.item.drill, net: W.netName(g.net)});
      }
      const rows = readout(r), L = r?.L || leg();
      const cfg = r?.cfg || L.cfg || {half: 0.5, widths: [0.2]};
      const clr = rules.clearance(nets[0], "", L.layer);
      const end = r?.spine ? r.spine[r.spine.length - 1] : members[0].at;
      const longest = Math.max(...rows.map(x => x.length));
      const out = {preview, vias: st.vias.map(v => ({x: v.x, y: v.y, diameter: v.diameter, drill: v.drill, fromLayer: v.fromLayer, toLayer: v.toLayer})),
        pushed: pushedItems, hidden, status: r ? r.status : "ok", reached: st.done, end, length: longest, headLength: r ? plen(r.spine || []) : 0,
        mode: st.mode, modeName: C.MODE_NAMES[st.mode], corner: st.corner, cornerName: C.CORNER_NAMES[st.corner], layer: L.layer, width: Math.max(...(cfg.widths || [0.2]).filter(finite)), via: {...st.via}, ms: r ? r.ms : 0,
        halo: r?.spine && r.spine.length > 1 ? {points: r.spine, width: 2 * cfg.half + 2 * clr, layer: L.layer} : null, boundaries: [],
        bus: {nets: nets.slice(), order: (cfg.order || []).map(k => nets[k]), members: rows, target: grp.target, tolerance: grp.tolerance, group: grp.name, neck: !!cfg.neck,
          pattern: st.pattern, patternName: PATTERN_NAMES[st.pattern], pitch: cfg.order?.length > 1 ? r6(Math.abs(cfg.offsets[cfg.order[1]] - cfg.offsets[cfg.order[0]])) : 0,
          half: cfg.half, crossing: !!r?.L?.gather?.crossing, swaps: st.swaps.map(s => s.label), done: st.done,
          width: Math.max(...(cfg.widths || [0.1]).filter(finite)), gap: cfg.order?.length > 1 ? r6(Math.abs(cfg.offsets[cfg.order[1]] - cfg.offsets[cfg.order[0]]) - (cfg.widths[cfg.order[0]] + cfg.widths[cfg.order[1]]) / 2) : 0,
          orderFixed: st.legs.length > 1 || !!leg().frozen, hop: st.hop + 1, loads: st.visited.map(id => inventory.byId.get(id)?.ref).filter(Boolean),
          next: (() => { try { const n = loads()[0]; return n ? inventory.byId.get(n)?.ref || null : null; } catch { return null; } })(), stub: st.visited.length ? 0 : null,
          flyBy: st.visited.length > 0 || (() => { try { return loads().length > 1; } catch { return false; } })()},
        notes: ["Bus " + nets.length + " nets", cfg.neck ? "Necked" : "", st.visited.length ? "Fly-by hop " + (st.hop + 1) : "", st.swaps.length ? st.swaps.length + " pin swap" + (st.swaps.length === 1 ? "" : "s") : "", r?.L?.gather?.crossing ? "Crossing: reorder or swap pins" : ""].filter(Boolean)};
      // One preview object for the whole session, updated in place: a bus key can change the ribbon and redraw it
      // without the editor asking for a new preview.
      for (const k of Object.keys(live)) delete live[k];
      return Object.assign(live, out);
    }
    const live = {};
    function snapshot() {
      return {legs: st.legs.map(L => ({...L, starts: L.starts.map(s => ({...s})), spine: L.spine.map(q => q.slice()), tails: L.tails ? L.tails.map(t => t && t.map(q => q.slice())) : null, lines: L.lines})),
        vias: st.vias.slice(), base: new Map(st.base), done: st.done, swaps: st.swaps.slice(), dests: st.dests, visited: st.visited.slice(), hop: st.hop, arrivals: st.arrivals.slice(), clicks: st.clicks.slice()};
    }
    function restore(s) { st.legs = s.legs; st.vias = s.vias; st.base = s.base; st.done = s.done; st.swaps = s.swaps; st.dests = s.dests; st.visited = s.visited; st.hop = s.hop; st.arrivals = s.arrivals; st.clicks = s.clicks; st.last = null; ctxCache.clear(); }
    // Freezes the current computation into the leg: direction, lanes, gather and spine.
    function anchor(r) {
      const L = leg();
      if (!L.frozen) { Object.assign(L, {u: r.L.u, cfg: r.cfg, gather: r.L.gather, frozen: true}); }
      L.spine = r.spine.map(q => q.slice());
      st.base = new Map(W.scene.mods);
      L.lines = r.lines.map(m => ({k: m.k, net: m.net, pts: m.pts, width: m.width, layer: m.layer, pre: m.pre}));
    }
    // Destination copper per member: pads of the member's net nearest `near`, not its start.
    // Fly-by: the loads in order (AtriumTopology.specFor: custom source and order, terminator last), else every part
    // other than the source that has pads of most members, nearest first. Visited loads drop out.
    const sourceParts = new Set(members.map(m => m.part).filter(Boolean));
    // Cached per number of visited loads: the readout asks on every move, and a scan of every pad is not free on big boards.
    let loadsKey = -1, loadsVal = null;
    function loads() {
      if (loadsKey === st.visited.length && loadsVal) return loadsVal;
      loadsVal = loads0(); loadsKey = st.visited.length; return loadsVal;
    }
    const topologyOrder = globalThis.AtriumTopology?.specFor?.(board, nets[0], inventory.parts)?.order;
    function loads0() {
      const order = topologyOrder;
      let ids;
      if (order?.length) ids = order.map(r => inventory.parts.get(r)?.id).filter(Boolean);
      else {
        const count = new Map();
        for (const n of nets) for (const e of new Set(inventory.ends.get(n).map(e => e.part).filter(Boolean))) count.set(e, (count.get(e) || 0) + 1);
        const c0 = [members.reduce((a, m) => a + m.at[0], 0) / members.length, members.reduce((a, m) => a + m.at[1], 0) / members.length];
        const at = id => { const p = inventory.byId.get(id); return [p.x, p.y]; };
        ids = [...count].filter(([, c]) => c >= nets.length / 2).map(([id]) => id).sort((a, b) => dist(at(a), c0) - dist(at(b), c0));
      }
      return ids.filter(id => !sourceParts.has(id) && !st.visited.includes(id));
    }
    function padsOn(partId) {
      const out = nets.map(n => inventory.ends.get(n).find(e => e.part === partId) || null);
      return out.every(Boolean) ? out.map((e, k) => ({net: nets[k], at: e.at, layer: e.layer, r: e.r, part: e.part, pad: e.pad, ref: e.ref})) : null;
    }
    function destinations(near) {
      // A fly-by with a known load order goes to the next load; otherwise the copper nearest the click.
      const next = loads();
      if (topologyOrder?.length && next.length) return padsOn(next[0]);
      const starts = members.map(m => m.at), visited = new Set(st.visited);
      const list = membersNear(board, defs, nets, near, {inventory, exclude: starts, skip: e => visited.has(e.part) || sourceParts.has(e.part) && !next.length});
      if (list.length !== nets.length) return null;
      return nets.map(n => list.find(x => x.net === n));
    }
    // Pin swaps that make the destination order follow the ribbon order, where the part allows it (pin-swap.js).
    function swapPlans(dest, wantOrderPads) {
      const PS = globalThis.AtriumPinSwap;
      if (!PS?.peers) return null;
      const parts = new Set(dest.map(d => d.part));
      if (parts.size !== 1 || dest.some(d => !d.part)) return null;
      const part = inventory.byId.get(dest[0].part), def = defs?.get ? defs.get(part.def) : defs?.[part.def];
      // wantOrderPads[k] = pad that member k should land on. Decompose the permutation into transpositions.
      const cur = new Map(dest.map((d, k) => [k, d.pad])), plans = [];
      const padNet = new Map(Object.entries(part.pinNets || {}));
      for (let k = 0; k < dest.length; k++) {
        const want = wantOrderPads[k], have = cur.get(k);
        if (want === have) continue;
        if (!PS.peers(def, have).includes(want)) return null;
        const j = [...cur.entries()].find(([, p]) => p === want)?.[0];
        plans.push({kind: "pin", partId: part.id, ref: part.ref, pairs: [[have, want]], label: part.ref + " " + have + " ↔ " + want});
        cur.set(k, want); if (j != null) cur.set(j, have);
        const a = padNet.get(have), b = padNet.get(want); padNet.set(have, b); padNet.set(want, a);
      }
      return plans;
    }
    // While a finished bus lands on swapped pads, the world carries the swapped pad nets (restored on undo or commit).
    function swapWorld(list) {
      const changes = [];
      list.forEach((d, k) => {
        const id = netId(nets[k]);
        const range = W.itemOwners.get(d.part); if (!range) return;
        for (let ow = range[0]; ow < range[1]; ow++) {
          const rec = W.owners[ow];
          if (rec.parent?.id !== d.part || String(rec.item?.number) !== String(d.pad)) continue;
          for (let f = rec.first; f < rec.first + rec.count; f++) { changes.push([f, W.net[f]]); W.net[f] = id; }
          changes.push([-1 - ow, rec.net]); rec.net = id;
        }
      });
      st.worldSwap = {depth: st.undo.length, changes};
      W.hullEpoch = (W.hullEpoch || 0) + 1; ctxCache.clear();
    }
    function unswapWorld() {
      const ws = st.worldSwap; if (!ws) return;
      for (let i = ws.changes.length - 1; i >= 0; i--) { const [f, v] = ws.changes[i]; if (f >= 0) W.net[f] = v; else W.owners[-1 - f].net = v; }
      st.worldSwap = null; W.hullEpoch = (W.hullEpoch || 0) + 1; ctxCache.clear();
    }
    const api = {
      bus: true,
      get state() {
        const L = leg();
        return {mode: st.mode, corner: st.corner, bend: st.bend, layer: L.layer, width: st.width ?? (L.cfg ? Math.max(...L.cfg.widths) : rules.width(nets[0], L.layer).preferred), via: {...st.via},
          net: nets[0], nets: nets.slice(), arcRadius: st.arcRadius, anchors: st.undo.length, neck: !!L.neck, pattern: st.pattern, bus: true, start: members[0].at};
      },
      members: () => members.map(m => ({...m})),
      get cursor() { return st.cursor; },
      // Recompute the preview at the last cursor (bus keys, the Properties panel).
      refresh() { st.last = null; if (st.cursor) st.last = compute(st.cursor); return result(st.last); },
      setGap(g) { if (finite(g) && g >= 0 && !leg().frozen && st.legs.length === 1) { st.gap = g; st.last = null; } return st.gap; },
      setPattern(p) { if (PATTERNS.includes(p)) st.pattern = p; return st.pattern; },
      canReorder: () => st.legs.length === 1 && !leg().frozen,
      record: () => ({nets: nets.slice(), members: members.map(m => ({...m})), mode: st.mode, corner: st.corner, width: st.width, gap: st.gap,
        clicks: st.clicks.slice(), layer: st.legs[0].layer, finished: st.done, loadParts: st.visited.slice()}),
      move(p) {
        const m = st.memo;
        if (m && m.last === st.last && m.gen === W.scene.gen && m.via === st.via && m.pattern === st.pattern &&
            st.cursor[0] === p[0] && st.cursor[1] === p[1]) return live;
        st.cursor = [p[0], p[1]]; st.last = compute(st.cursor);
        st.memo = {last:st.last, gen:W.scene.gen, via:st.via, pattern:st.pattern};
        return result(st.last);
      },
      click() {
        if (st.done) return {anchored: false, done: true};
        if (!st.last && st.cursor) st.last = compute(st.cursor);
        const r = st.last;
        if (!r || r.status === "violation" && st.mode !== "ignore" || !r.spine || r.spine.length < 2) return {anchored: false, done: false};
        st.undo.push(snapshot());
        anchor(r);
        st.clicks.push({kind: "click", at: r.spine[r.spine.length - 1].slice()});
        st.last = null;
        return {anchored: true, done: false, status: r.status};
      },
      back() {
        const u = st.undo.pop();
        if (!u) return false;
        if (st.worldSwap && st.undo.length < st.worldSwap.depth) unswapWorld();
        restore(u);
        if (st.cursor) st.last = compute(st.cursor);
        return true;
      },
      // Neck down (minimum widths and gaps from the rules) or spread back out: a transition on the same layer.
      toggleNeck() {
        const L = leg();
        if (st.last && st.last.spine.length > 1) api.click();
        if (!L.frozen) { L.neck = !L.neck; st.last = null; return L.neck; }
        const ends = (L.lines || []).map(m => m.pts[m.pts.length - 1]);
        st.undo.push(snapshot());
        const neck = !L.neck, cfg = cfgFor(L.cfg.order, neck, L.layer);
        const nl = newLeg(L.layer, ends.map((at, k) => ({at, r: L.cfg.widths[k] / 2})), cfg);
        nl.neck = neck; nl.fixedOrder = true; nl.fixedU = L.gather ? octant(...dirOf(L.spine)) : null;
        if (!neck) nl.preWidths = L.cfg.widths.slice();
        st.clicks.push({kind: "neck"});
        st.legs.push(nl); st.last = null;
        return neck;
      },
      cycleViaPattern(step = 1) { st.pattern = PATTERNS[(PATTERNS.indexOf(st.pattern) + PATTERNS.length + step) % PATTERNS.length]; return st.pattern; },
      // Reorders the members (leg 1 only, before its first anchor).
      setOrder(order) {
        const idx = (order || []).map(n => nets.indexOf(String(n)));
        if (idx.length !== nets.length || idx.some(k => k < 0) || new Set(idx).size !== idx.length) return false;
        st.manualOrder = order.map(String); st.last = null; return true;
      },
      reverse() {
        if (st.legs.length > 1 || leg().frozen) return false;
        const cur = st.last?.cfg?.order || leg().cfg?.order;
        if (!cur) return false;
        return api.setOrder(cur.map(k => nets[k]).reverse());
      },
      // A via array at the ribbon end, then the next leg on `next`. Staggered or in-line, at the via-to-via clearance.
      switchLayer(next, style) {
        if (C.layerIndex(next) < 0) return {ok: false, message: "Choose a copper layer."};
        const L0 = leg();
        if (next === L0.layer) return {ok: false, message: "Already routing on " + next + "."};
        if (st.done) return {ok: false, message: "The bus is finished."};
        const viaStyle = style && finite(style.diameter) ? style : st.via;
        if (!rules.via(nets,viaStyle).legal) return {ok:false,message:"No shared via of this diameter and drill meets the member nets' design rules."};
        if (st.last && st.last.spine && st.last.spine.length > 1) api.click();
        const L = leg();
        if (!L.frozen || !L.lines) return {ok: false, message: "Route the bus away from its start before changing layer."};
        const v = style && finite(style.diameter) ? style : st.via, span = C.viaSpan(board, L.layer, next);
        const u = octant(...dirOf(L.spine)), nrm = [-u[1], u[0]], E = L.spine[L.spine.length - 1], cfg = L.cfg, order = cfg.order, n = order.length;
        const vgap = Math.max(...nets.map((a, i) => Math.max(...nets.map((b, j) => i === j ? 0 : rules.clearance(a, b, L.layer))))), wmax = Math.max(...cfg.widths);
        const pv = v.diameter + vgap;
        // Via positions per slot (across, along) relative to the ribbon end.
        const pos = new Array(nets.length);
        if (st.pattern === "staggered") {
          const sx = Math.max(pv / 2, (v.diameter + 2 * vgap + wmax) / 2), sy = Math.sqrt(Math.max(0, pv * pv - sx * sx)) + 1e-3;
          order.forEach((k, s) => { pos[k] = [(s - (n - 1) / 2) * sx, (s % 2) * Math.max(sy, pv * 0.5)]; });
        } else order.forEach((k, s) => { pos[k] = [(s - (n - 1) / 2) * pv, 0]; });
        // Spread on the old layer: the gather from the vias back toward the ribbon end, shifted so it lands on it.
        const back = [-u[0], -u[1]], at = (x, al) => [E[0] + nrm[0] * x + u[0] * al, E[1] + nrm[1] * x + u[1] * al];
        const lanesBack = cfg.offsets.map(x => -x);
        const trial = shift => {
          const starts = nets.map((_, k) => ({at: at(pos[k][0], pos[k][1] + shift), r: v.diameter / 2}));
          return {starts, g: gather(starts, lanesBack, cfg.widths, gapOf(L.layer), back, {c: 0, origin: E})};
        };
        const D0 = trial(0).g.D;
        let shift = D0, placed = null;
        const netIdOf = k => netId(nets[k]);
        for (let tries = 0; tries < 40 && !placed; tries++, shift += pv / 4) {
          const t = trial(shift);
          const okVias = t.starts.every((s, k) => rules.via(nets[k],v,s.at,[span.lo,span.hi]).legal && C.viaClear(W, rules, netIdOf(k), nets[k], s.at, v.diameter / 2, span.lo, span.hi, st.mode === "ignore"))
            && t.starts.every((s, k) => t.starts.every((q, j) => j === k || dist(s.at, q.at) >= v.diameter + rules.clearance(nets[k], nets[j], L.layer) - 1e-9));
          if (!okVias) continue;
          // Tails: reversed spread paths, extended along the ribbon if the vias were moved further out.
          const tails = t.g.paths.map(pth => { const rev = pth.slice().reverse(); const lane = rev[0]; const back0 = [lane[0] + u[0] * t.g.D, lane[1] + u[1] * t.g.D]; return C.simplify([back0, ...rev]); });
          const test = tails.map((tl, k) => ({k, net: nets[k], pts: tl, width: cfg.widths[k], layer: L.layer}));
          if (st.mode !== "ignore" && firstHit(test)) continue;
          placed = {t, tails};
        }
        if (!placed) return {ok: false, message: "No room for a " + (st.pattern === "staggered" ? "staggered" : "in-line") + " via array here."};
        st.undo.push(snapshot());
        L.tails = placed.tails;
        L.lines = L.lines.map(m => ({...m, pts: C.simplify([...m.pts, ...placed.tails[m.k].slice(1)])}));
        placed.t.starts.forEach((s, k) => st.vias.push({x: s.at[0], y: s.at[1], diameter: v.diameter, drill: v.drill, lo: span.lo, hi: span.hi, fromLayer: span.fromLayer, toLayer: span.toLayer, net: nets[k],
          ...span.parts ? {parts: span.parts} : {}, ...span.extra ? {extra: span.extra} : {}}));
        const nl = newLeg(next, placed.t.starts, cfgFor(order, L.neck, next));
        nl.neck = L.neck; nl.fixedOrder = true; nl.fixedU = u;
        st.legs.push(nl); st.last = null; ctxCache.clear();
        st.clicks.push({kind: "layer", layer: next, pattern: st.pattern});
        if (st.cursor) st.last = compute(st.cursor);
        return {ok: true, layer: next, vias: placed.t.starts.length, pattern: st.pattern, message: PATTERN_NAMES[st.pattern] + " · " + placed.t.starts.length + " vias · " + next};
      },
      addVia() { return {ok: false, message: "Change layer (L or + / −) to drop a via array under the bus."}; },
      // Ctrl+click: connect the ribbon to the destination pads nearest p, spreading to them; swaps pins to remove crossings.
      complete(p, opt = {}) {
        if (st.done) return {ok: true, done: true};
        const L = leg();
        if (!L.frozen && !L.fixedOrder) return {ok: false, message: "Route the bus away from its start first."};
        const dest = destinations(p);
        if (!dest) return {ok: false, message: "Every member needs a destination pad near the click."};
        if (dest.some(d => d.layer && d.layer !== L.layer)) return {ok: false, message: "The destination pads are on " + dest.find(d => d.layer && d.layer !== L.layer).layer + "; change layer first."};
        const cfg = L.cfg, E = L.spine.length ? L.spine[L.spine.length - 1] : [L.starts.reduce((s, q) => s + q.at[0], 0) / L.starts.length, L.starts.reduce((s, q) => s + q.at[1], 0) / L.starts.length];
        const cx = dest.reduce((s, d) => s + d.at[0], 0) / dest.length, cy = dest.reduce((s, d) => s + d.at[1], 0) / dest.length;
        const v = octant(E[0] - cx, E[1] - cy), lanes = cfg.offsets.map(x => -x);
        let starts = dest.map(d => ({at: d.at, r: d.r}));
        let g = gather(starts, lanes, cfg.widths, gapOf(L.layer), v, {lead: 0});
        let swaps = [], want2pads = null;
        if (g.crossing) {
          // Destination slots in the ribbon's order: the pad at across rank s goes to the member with lane rank s.
          const nrm = [-v[1], v[0]], across = q => q[0] * nrm[0] + q[1] * nrm[1];
          const padsByAcross = dest.map((d, k) => k).sort((a, b) => across(dest[a].at) - across(dest[b].at));
          const memByLane = nets.map((_, k) => k).sort((a, b) => lanes[a] - lanes[b]);
          const want = new Array(nets.length);
          memByLane.forEach((k, s) => { want[k] = dest[padsByAcross[s]]; });
          const plans = opt.swap === false || loads().length > 1 ? null : swapPlans(dest, want.map(d => d.pad));
          if (!plans) return {ok: false, crossing: true, message: "The destination pins are in a different order; the bus would cross. Reorder the bus (Alt+/) at its start, or allow pin swaps (Swap group) on " + (dest[0].ref || "the part") + "."};
          swaps = plans;
          want2pads = want.map(d => ({part: d.part, pad: d.pad}));
          starts = want.map(d => ({at: d.at, r: d.r}));
          g = gather(starts, lanes, cfg.widths, gapOf(L.layer), v, {lead: 0});
          if (g.crossing) return {ok: false, crossing: true, message: "Pin swapping cannot remove every crossing."};
        }
        // Spine to the destination launch line, arriving along -v.
        const lead = Math.max(cfg.half, 0.2), T = [g.L[0] + v[0] * lead, g.L[1] + v[1] * lead];
        st.undo.push(snapshot());
        // An anchored ribbon that already reaches past the approach is cut back to it (undo restores it).
        if (L.spine.length > 1) {
          const side = q => (q[0] - g.L[0]) * v[0] + (q[1] - g.L[1]) * v[1], need = lead + cfg.half, sp = L.spine;
          if (side(sp[sp.length - 1]) < need) {
            let i = sp.length - 2;
            while (i >= 0 && side(sp[i]) < need) i--;
            if (i < 1 && !(i === 0 && sp.length > 1 && side(sp[1]) >= need)) { st.undo.pop(); return {ok: false, message: "The bus is too close to the destination to fan into it; Backspace and finish from further away."}; }
            const a = sp[i], b = sp[i + 1], t = (side(a) - need) / (side(a) - side(b));
            L.spine = C.simplify([...sp.slice(0, i + 1), [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]]);
            if (L.spine.length < 2) { const u0 = L.u; L.spine = [sp[0], [sp[0][0] + u0[0] * 1e-3, sp[0][1] + u0[1] * 1e-3]]; }
          }
        }
        if (swaps.length) swapWorld(want2pads);
        const r = compute(T, true);
        const reachedT = r.spine.length > 1 && dist(r.spine[r.spine.length - 1], T) < 1e-6 && r.status !== "blocked" && r.status !== "violation";
        if (!reachedT) { restore(st.undo.pop()); unswapWorld(); return {ok: false, message: r.status === "ok" ? "The bus is too close to the destination to fan into it; Backspace and finish from further away." : "The bus can't reach the destination from here (" + r.status + "). Route closer first."}; }
        const spine = C.simplify([...r.spine, g.L]);
        const lines = memberLines(r.L, spine, r.cfg).map(m => ({...m, pts: C.simplify([...m.pts, ...g.paths[m.k].slice().reverse().slice(1)])}));
        const finalRes = {...r, spine, lines};
        if (st.mode !== "ignore") {
          const hit = firstHit(lines);
          if (hit) { restoreScene(); unswapWorld(); restore(st.undo.pop()); return {ok: false, message: "The breakout into the destination pads is blocked for " + nets[hit.k] + "."}; }
        }
        anchor(finalRes);
        st.swaps = st.swaps.concat(swaps); st.last = finalRes;
        const partId = dest[0].part, ref = dest[0].ref;
        if (partId) st.visited.push(partId);
        st.clicks.push({kind: "visit", to: [p[0], p[1]]});
        st.arrivals.push({ref: ref || null, lengths: readout(null).map(x => x.length)});
        // Fly-by: more loads to visit, so the ribbon carries on from these pads (the trace passes through each load's
        // pad, so its stub is zero) on the same layer, with the same lanes.
        const more = partId ? loads() : [];
        if (more.length && !swaps.length) {
          st.hop++;
          const nl = newLeg(L.layer, starts, cfgFor(L.cfg.order, L.neck, L.layer));
          nl.fixedOrder = true;
          st.legs.push(nl);
          const nx = padsOn(more[0]);
          st.dests = nx ? nx.map(e => ({at: e.at})) : null;
          st.last = null; ctxCache.clear();
          if (st.cursor) st.last = compute(st.cursor);
          const nextRef = board.items.find(i => i.id === more[0])?.ref;
          return {ok: true, anchored: true, done: false, reached: true, visited: ref, next: nextRef, swaps: [], message: "Fly-by: " + (ref || "load") + " reached (stub 0 mm); on to " + (nextRef || "the next load") + "."};
        }
        st.dests = starts.map(q => ({at: q.at})); st.done = true;
        return {ok: true, anchored: true, done: true, reached: true, visited: ref, swaps: swaps.map(x => x.label)};
      },
      cycleCorner(step = 1) { st.corner = C.CORNERS[(C.CORNERS.indexOf(st.corner) + C.CORNERS.length + step) % C.CORNERS.length]; st.last = null; ctxCache.clear(); return st.corner; },
      toggleBend() { st.fixedBend = true; st.bend = !st.bend; st.last = null; return st.bend; },
      cycleMode(step = 1) { st.mode = C.MODES[(C.MODES.indexOf(st.mode) + C.MODES.length + step) % C.MODES.length]; st.last = null; return st.mode; },
      setMode(m) { if (C.MODES.includes(m)) { st.mode = m; st.last = null; } return st.mode; },
      setCorner(c) { if (C.CORNERS.includes(c)) { st.corner = c; st.last = null; ctxCache.clear(); } return st.corner; },
      setWidth(w) { if (finite(w) && w > 0 && !leg().frozen && st.legs.length === 1) { st.width = w; st.last = null; } return st.width; },
      setVia(vv) { if (vv && finite(vv.diameter) && vv.diameter > 0) st.via = {diameter: vv.diameter, drill: finite(vv.drill) ? vv.drill : vv.diameter / 2}; return {...st.via}; },
      setArcRadius(r) { st.arcRadius = finite(r) && r > 0 ? r : null; st.last = null; return st.arcRadius; },
      presets() { return R.presets(board, nets[0], leg().layer, {rules:o.rules,project:o.project,nets}); },
      nextVia(step = 1) { const list = api.presets().vias; if (!list.length) return {...st.via}; let i = list.findIndex(x => Math.abs(x.diameter - st.via.diameter) < 1e-9); i = (i + step + list.length) % list.length; return api.setVia(list[i]); },
      // Bus keys (editor action bus-key): N neck, V via pattern, / reverse order.
      key(k) {
        if (k === "neck") return {neck: api.toggleNeck(), message: leg().neck ? "Bus necked down to the minimum width and gap" : "Bus spread back to the preferred width and gap"};
        if (k === "pattern") { const p = api.cycleViaPattern(1); return {pattern: p, message: PATTERN_NAMES[p] + " for the next layer change"}; }
        if (k === "reverse") { const ok = api.reverse(); return {ok, message: ok ? "Bus order reversed" : "The order is fixed once the bus has left its start."}; }
        return null;
      },
      readout: () => readout(st.last),
      // Returns {add, remove, modify, length, swaps, message}. Pass {head:true} to include the unanchored head.
      commit(opt = {}) {
        if (opt.head && st.last && st.last.spine && st.last.spine.length > 1 && !st.done) api.click();
        const add = [], idOf = opt.makeId || (() => globalThis.Atrium?.id?.() || "b" + Math.random().toString(36).slice(2));
        const hops = [];
        for (const L of st.legs) for (const m of L.lines || []) for (const part of m.pre ? [m.pre, m] : [m]) {
          const pts = C.simplify(part.pts).map(q => [r6(q[0]), r6(q[1])]);
          if (pts.length >= 2 && plen(pts) > 1e-6) { const t = {id: idOf(), kind: "track", points: pts, width: part.width, layer: m.layer, net: m.net}; add.push(t); (hops[L.hop || 0] ||= []).push(t.id); }
        }
        for (const v of st.vias) for (const part of v.parts || [v]) {
          const via = {id: idOf(), kind: "via", x: r6(v.x), y: r6(v.y), diameter: v.diameter, drill: v.drill, layer: "Multi", net: v.net};
          if (part.fromLayer) { via.fromLayer = part.fromLayer; via.toLayer = part.toLayer; }
          if (part.extra) Object.assign(via, part.extra);
          add.push(via);
        }
        const modify = [];
        for (const [ow, g] of st.base) {
          const rec = W.owners[ow];
          if (g.kind === "track") modify.push({id: rec.id, points: g.points.map(q => [r6(q[0]), r6(q[1])])});
          else modify.push({id: rec.id, x: r6(g.x), y: r6(g.y)});
        }
        W.scene.reset();
        unswapWorld();
        const rows = readout(null);
        const longest = Math.max(...rows.map(x => x.length));
        const plan = {add, remove: [], modify, length: longest, swaps: st.swaps.slice(), nets: nets.slice(), done: st.done, hops: hops.filter(Boolean), loads: st.visited.map(id => inventory.byId.get(id)?.ref).filter(Boolean),
          message: add.length ? "Bus placed: " + nets.length + " nets" + (st.vias.length ? ", " + st.vias.length + " vias" : "") + (st.swaps.length ? ", " + st.swaps.length + " pin swaps" : "") + (st.done ? "" : " (unfinished)") + ". Route › Tune Bus Group matches the lengths." : ""};
        // The editor applies pin swaps (pin-swap.js, with back-annotation) in the same undo step, before the copper.
        if (st.swaps.length) plan.beforeApply = (project, doc, defs2) => { const PS = globalThis.AtriumPinSwap; if (PS?.applyPlans) PS.applyPlans(project, doc, defs2, st.swaps); else applySwapsToBoard(doc, st.swaps); };
        return plan;
      },
      cancel() { unswapWorld(); W.scene.reset(); st.last = null; st.legs.length = 1; Object.assign(st.legs[0], {frozen: false, spine: [], lines: null, tails: null}); st.vias.length = 0; st.base = new Map(); st.undo.length = 0; st.done = false; st.swaps = []; },
      world: W
    };
    if (o.cursor) api.move(o.cursor);
    return api;
  }
  function dirOf(spine) {
    for (let i = spine.length - 1; i > 0; i--) { const a = spine[i - 1], b = spine[i], l = dist(a, b); if (l > 1e-9) return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }
    return [1, 0];
  }
  // Pin swaps without pin-swap.js (headless): exchange the pads' nets.
  function applySwapsToBoard(board, swaps) {
    for (const s of swaps) {
      const part = board.items.find(i => i.id === s.partId); if (!part?.pinNets) continue;
      for (const [a, b] of s.pairs) { const x = part.pinNets[a]; part.pinNets[a] = part.pinNets[b]; part.pinNets[b] = x; }
    }
  }

  // ---------------------------------------------------------------- tune group
  // Brings every member within the tolerance of the group target (explicit, else the longest member). A packed ribbon
  // has no room beside a member for a pattern, so the bus is tuned in a tuning zone: on its longest straight parallel
  // run the members spread apart (45° jogs, the gather construction), each runs a trombone/accordion of its own
  // amplitude in its own band, and they converge again. Members still short afterwards go to the length tuning
  // engine (length-tuning.js autoTune). Returns a plan in the router's format (modify: [{id, points}]).
  function trackLength(board, net) { return board.items.filter(i => i.kind === "track" && i.net === net && i.points?.length > 1).reduce((s, t) => s + plen(t.points), 0); }
  function measureNets(board, defs, nets) {
    const L = globalThis.AtriumLength;
    return nets.map(n => {
      // matchLength: the whole xSignal path through series parts (high-speed suite); netLength on older builds.
      const f = L?.matchLength || L?.netLength;
      if (f) { const r = f(board, defs, n, {}); return {net: n, length: r6(r.length || 0), delay: r.delay, unrouted: !!r.unrouted}; }
      return {net: n, length: r6(trackLength(board, n)), unrouted: false};
    });
  }
  // Straight runs where every member has a parallel segment: {layer, u, n, from, to, segs:[{k, track, i, c}]}, longest first.
  function zones(board, nets, minLen, keep = null) {
    const out = [], byLayer = new Map();
    for (const t of board.items) {
      if (t.kind !== "track" || !nets.includes(t.net) || !(t.points?.length > 1) || keep && !keep(t)) continue;
      if (!byLayer.has(t.layer)) byLayer.set(t.layer, []);
      byLayer.get(t.layer).push(t);
    }
    for (const [layer, tracks] of byLayer) {
      const dirs = new Map();
      for (const t of tracks) for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1], b = t.points[i], l = dist(a, b);
        if (l < minLen) continue;
        let u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
        if (u[0] < -1e-9 || (Math.abs(u[0]) < 1e-9 && u[1] < 0)) u = [-u[0], -u[1]];
        const key = Math.round(Math.atan2(u[1], u[0]) * 1e4);
        if (!dirs.has(key)) dirs.set(key, {u, segs: []});
        const n = [-u[1], u[0]], s0 = a[0] * u[0] + a[1] * u[1], s1 = b[0] * u[0] + b[1] * u[1];
        dirs.get(key).segs.push({k: nets.indexOf(t.net), track: t, i, c: a[0] * n[0] + a[1] * n[1], lo: Math.min(s0, s1), hi: Math.max(s0, s1)});
      }
      for (const {u, segs} of dirs.values()) {
        // Sweep: for each member, segments sorted; find the best common overlap.
        const per = nets.map((_, k) => segs.filter(x => x.k === k));
        if (per.some(l => !l.length)) continue;
        for (const base of per[0]) {
          let lo = base.lo, hi = base.hi; const pick = [base];
          for (let k = 1; k < nets.length && hi - lo >= minLen; k++) {
            let best = null;
            for (const x of per[k]) { const ov = Math.min(hi, x.hi) - Math.max(lo, x.lo); if (ov > (best ? best.ov : 0) && Math.abs(x.c - base.c) < 2 * nets.length) best = {x, ov}; }
            if (!best) { hi = lo; break; }
            lo = Math.max(lo, best.x.lo); hi = Math.min(hi, best.x.hi); pick.push(best.x);
          }
          if (hi - lo >= minLen) out.push({layer, u, n: [-u[1], u[0]], from: lo, to: hi, segs: pick});
        }
      }
    }
    return out.sort((a, b) => (b.to - b.from) - (a.to - a.from));
  }
  // One tuning zone: spread, trombones of amplitude A per unit (a member, or a diff pair as one coupled unit whose
  // members are offsets of one centre meander, so the pair stays coupled and skew-free), converge.
  function zoneGeometry(z, need, rules, nets, o = {}) {
    const R = RT(), C = R.core, n = nets.length, u = z.u, nrm = z.n, pairs = o.pairs || new Map();
    const segs = z.segs.slice().sort((a, b) => a.c - b.c), order = segs.map(x => x.k), cOf = new Map(segs.map(x => [x.k, x.c]));
    const widths = new Array(n), gapOf = (i, j) => rules.clearance(nets[i], nets[j], z.layer) + SLACK;
    for (const x of segs) widths[x.k] = x.track.width;
    const units = [];
    for (let s = 0; s < n; s++) {
      const k = order[s], j = order[s + 1], p = pairs.get(nets[k]);
      if (p && j != null && pairs.get(nets[j]) === p) { units.push({ks: [k, j], d: (cOf.get(j) - cOf.get(k)) / 2, w: Math.max(widths[k], widths[j])}); s++; }
      else units.push({ks: [k], d: 0, w: widths[k]});
    }
    const U = units.length, margin = 0.2, s0 = z.from + margin, s1 = z.to - margin;
    const P = (k, s) => [u[0] * s + nrm[0] * cOf.get(k), u[1] * s + nrm[1] * cOf.get(k)];
    const lenOf = k => need[k].length;
    const unitNeed = x => x.ks.reduce((a, k) => a + lenOf(k), 0) / x.ks.length;
    const longest = Math.max(o.target ?? 0, ...need.map(x => x.length));
    const A = new Array(U).fill(0), Nk = new Array(U).fill(0);
    // Pair skew: a few short bumps on the shorter member of a pair (hsU on the upper member toward +n, hsD on the lower
    // toward -n), ahead of the pair's coupled meander; the band grows by them.
    const hsU = new Array(U).fill(0), hsD = new Array(U).fill(0), Ns = units.map(x => {
      if (x.ks.length !== 2) return 0;
      const sk = Math.abs(lenOf(x.ks[1]) - lenOf(x.ks[0]));
      return sk > (o.tolerance ?? 0.254) / 4 ? Math.max(1, Math.round(sk / (2 * Math.max(x.w, 0.15)))) : 0;
    });
    const pitchS = x => 2 * (x.w + gapOf(x.ks[0], x.ks[x.ks.length - 1])), reserve = i => Ns[i] ? Ns[i] * pitchS(units[i]) + 0.2 : 0;
    const pitchOf = x => 2 * (x.ks.length === 2 ? 2 * x.d + x.w + gapOf(x.ks[0], x.ks[1]) : x.w + Math.max(x.w, gapOf(x.ks[0], x.ks[0])));
    let result = null;
    for (let iter = 0; iter < 60; iter++) {
      // Unit centres: each band (lower member edge .. upper member edge + amplitude) sits a gap above the previous one.
      const Yc = new Array(U);
      for (let i = 0; i < U; i++) {
        const x = units[i];
        if (!i) { Yc[i] = cOf.get(x.ks[0]) + x.d; continue; }
        const p = units[i - 1], g = gapOf(p.ks[p.ks.length - 1], x.ks[0]);
        Yc[i] = Yc[i - 1] + p.d + Math.max(A[i - 1], hsU[i - 1]) + p.w / 2 + g + x.w / 2 + x.d + hsD[i];
      }
      const top = Yc[U - 1] + units[U - 1].d + Math.max(A[U - 1], hsU[U - 1]), bottom = Yc[0] - units[0].d - hsD[0];
      const c0 = cOf.get(order[0]), cn = cOf.get(order[n - 1]);
      const shift = o.anchor === "low" ? 0 : o.anchor === "high" ? cn - top : (c0 + cn) / 2 - (bottom + top) / 2;
      for (let i = 0; i < U; i++) Yc[i] += shift;
      const Y = new Array(n);
      units.forEach((x, i) => { if (x.ks.length === 2) { Y[x.ks[0]] = Yc[i] - x.d; Y[x.ks[1]] = Yc[i] + x.d; } else Y[x.ks[0]] = Yc[i]; });
      const gin = gather(nets.map((_, k) => ({at: P(k, s0), r: widths[k] / 2})), Y, widths, gapOf, u, {origin: [0, 0], c: 0});
      const gout = gather(nets.map((_, k) => ({at: P(k, s1), r: widths[k] / 2})), Y.map(y => -y), widths, gapOf, [-u[0], -u[1]], {origin: [0, 0], c: 0});
      const z0 = gin.D, z1 = -gout.D, span = z1 - z0 - 2 * margin;
      const Nmax = units.map((x, i) => Math.floor((span - reserve(i)) / pitchOf(x)));
      if (Math.min(...Nmax) < 1) return result;
      // Bumps per unit: about Apref high each, so short members get a few tall bumps rather than many tiny ones. Every
      // band displaces the members beyond it, whose 45° jogs then grow longer (2(√2−1) per mm); enough bumps per unit
      // keep that feedback well below one so the amplitudes converge.
      if (iter === 0) {
        const Apref = (o.apref ?? 3) * Math.max(...widths);
        units.forEach((x, i) => { const e = longest - unitNeed(x); Nk[i] = e <= (o.tolerance ?? 0.254) / 4 ? 0 : Apref > 0 ? Math.max(1, Math.min(Nmax[i], Math.round(e / (2 * Apref)))) : Nmax[i]; });
        const gain = () => 2 * (SQ2 - 1) * Nk.reduce((s, v) => s + (v ? 1 / (2 * v) : 0), 0);
        for (let g = 0; g < 64 && gain() > 0.4; g++) units.forEach((x, i) => { if (Nk[i] && Nk[i] < Nmax[i]) Nk[i]++; });
      }
      units.forEach((x, i) => { Nk[i] = Math.min(Nk[i], Nmax[i]); });
      // Low or high anchor: start from the exact solution of the linear model (a band of height A displaces the units
      // beyond it by A, and a displacement costs 2(√2−1) per mm in the 45° jogs), then refine on the real geometry.
      if (iter === 0 && (o.anchor === "low" || o.anchor === "high")) {
        const beta = 2 * (SQ2 - 1), seq = o.anchor === "low" ? units.map((x, i) => i) : units.map((x, i) => U - 1 - i);
        const base = units.map(unitNeed);
        for (let pass = 0; pass < U; pass++) {
          // A[u] = a[u] T + b[u], sequentially from the anchored edge (disp of unit u = sum of A before it in seq).
          const a = new Array(U).fill(0), b = new Array(U).fill(0);
          let sa = 0, sb = 0, lo = -Infinity, ok = true;
          for (const u of seq) {
            // Units displaced by the high anchor also move by their own band: disp includes A[u] itself.
            const self = o.anchor === "high" ? 1 : 0;
            if (Nk[u]) {
              const den = 2 * Nk[u] + beta * self;
              a[u] = (1 - beta * sa) / den; b[u] = (-base[u] - beta * sb) / den;
            } else {
              const k = 1 - beta * sa;
              if (k <= 1e-6) { ok = false; break; }
              lo = Math.max(lo, (base[u] + beta * sb) / k);
            }
            sa += a[u]; sb += b[u];
          }
          if (!ok) break;
          const T = Math.max(lo, o.target ?? -Infinity), Tm = Number.isFinite(T) ? T : Math.max(...base);
          let neg = false;
          units.forEach((x, u) => { if (Nk[u]) { A[u] = a[u] * Tm + b[u]; if (A[u] < 0) { Nk[u] = 0; A[u] = 0; neg = true; } } });
          if (!neg) break;
        }
        units.forEach((x, u) => { A[u] = Math.max(0, Math.min(o.maxAmplitude ?? 3, A[u])); });
        continue;
      }
      const lines = new Array(n);
      units.forEach((x, i) => {
        const at = s => [u[0] * s + nrm[0] * Yc[i], u[1] * s + nrm[1] * Yc[i]], up = q => [q[0] + nrm[0] * A[i], q[1] + nrm[1] * A[i]];
        const centre = [at(z0)];
        if (A[i] > 1e-4 && Nk[i] > 0) {
          const pitch = pitchOf(x), first = z0 + margin + reserve(i) + (span - reserve(i) - Nk[i] * pitch) / 2;
          for (let j = 0; j < Nk[i]; j++) { const t = first + j * pitch; centre.push(at(t), up(at(t)), up(at(t + pitch / 2)), at(t + pitch / 2)); }
        }
        centre.push(at(z1));
        const mid = C.simplify(centre);
        x.ks.forEach((k, m) => {
          const off = x.ks.length === 2 ? offsetPath(mid, m ? x.d : -x.d).pts : mid;
          const h = m ? hsU[i] : hsD[i];
          if (x.ks.length === 2 && h > 1e-4) {
            const sgn = m ? 1 : -1, ps = pitchS(x), atm = t => [u[0] * t + nrm[0] * (Yc[i] + sgn * x.d), u[1] * t + nrm[1] * (Yc[i] + sgn * x.d)], hop = q => [q[0] + nrm[0] * sgn * h, q[1] + nrm[1] * sgn * h];
            const bumps = [];
            for (let j = 0; j < Ns[i]; j++) { const t = z0 + margin + j * ps; bumps.push(atm(t), hop(atm(t)), hop(atm(t + ps / 2)), atm(t + ps / 2)); }
            off.splice(1, 0, ...bumps);
          }
          lines[k] = C.simplify([...gin.paths[k], ...off.slice(1, -1), ...gout.paths[k].slice().reverse()]);
        });
      });
      const lens = lines.map((l, k) => lenOf(k) + plen(l) - (s1 - s0));
      // The target follows the units (a pair by its mean): a pair's own skew must not drive the whole group longer.
      const T = Math.max(o.target ?? 0, ...units.map(x => x.ks.reduce((a, k) => a + lens[k], 0) / x.ks.length));
      result = {lines, lens, bumps: units.flatMap((x, i) => x.ks.map(() => Nk[i])), A: units.flatMap((x, i) => x.ks.map(() => A[i])), s0, s1, order};
      const err = units.map(x => T - x.ks.reduce((a, k) => a + lens[k], 0) / x.ks.length);
      if (err.every(e => Math.abs(e) <= (o.tolerance ?? 0.254) / 8) && units.every(x => x.ks.length < 2 || Math.abs(lens[x.ks[0]] - lens[x.ks[1]]) <= (o.tolerance ?? 0.254) / 4)) break;
      // A unit without bumps that falls short (the others' bands displaced the longest member past it) gets bumps too.
      units.forEach((x, i) => { if (!Nk[i] && err[i] > (o.tolerance ?? 0.254) / 4) Nk[i] = Math.max(1, Math.min(Nmax[i], Math.max(...Nk))); });
      units.forEach((x, i) => { if (Nk[i]) A[i] = Math.max(0, Math.min(o.maxAmplitude ?? 3, A[i] + err[i] / (2 * Nk[i]))); });
      units.forEach((x, i) => {
        if (!Ns[i]) return;
        const v = hsU[i] - hsD[i] + (lens[x.ks[0]] - lens[x.ks[1]]) / (2 * Ns[i]);
        hsU[i] = Math.min(o.maxAmplitude ?? 3, Math.max(v, 0)); hsD[i] = Math.min(o.maxAmplitude ?? 3, Math.max(-v, 0));
      });
    }
    return result;
  }
  function tuneGroup(board, defs, nets, o = {}) {
    const t0 = now(), R = RT(), C = R.core, Lm = globalThis.AtriumLength;
    const grp = groupTarget(board, defs, nets, o);
    const before = measureNets(board, defs, nets);
    const longest = Math.max(...before.map(x => x.length));
    const rules = C.rulesFor(board, o.rules, o.project, defs);
    // Tuning zones, up to five rounds per scope: each round takes the best clean zone (smallest remaining spread) on the
    // bus as it now is, so a run too short for the whole correction is helped by the next one. Long runs are tried first,
    // then shorter ones (2 mm, then 1.2 mm) when no long run is left. A fly-by is tuned hop by hop (o.hops: the track ids
    // of each hop), so every load sees its members arrive matched.
    const byMod = new Map(), zonesUsed = [], pairs = pairsOf(board, nets), notes = [];
    let work = board;
    const hopSets = Array.isArray(o.hops) && o.hops.length > 1 ? o.hops.map(ids => new Set(ids)) : null;
    const scopes = hopSets ? hopSets.map((set, h) => ({h, keep: t => set.has(t.id), measure: b => nets.map(n => ({net: n, length: b.items.filter(t => t.kind === "track" && t.net === n && set.has(t.id)).reduce((a, t) => a + plen(t.points), 0)}))}))
      : [{h: null, keep: null, measure: b => measureNets(b, defs, nets)}];
    const hopReport = [];
    for (const sc of scopes) {
      for (let round = 0; round < 5; round++) {
        const cur = sc.measure(work), top = Math.max(sc.h == null ? grp.target ?? 0 : o.hopTargets?.[sc.h] ?? 0, ...cur.map(x => x.length));
        if (!cur.some(x => top - x.length > grp.tolerance / 2)) break;
        let best = null, longestRun = 0;
        for (const minLen of [4, 2, 1.2]) {
          const zs = zones(work, nets, minLen, sc.keep).slice(0, 6);
          for (const z of zs) longestRun = Math.max(longestRun, z.to - z.from);
          const tries = zs.flatMap(z => [3, 1, 0].flatMap(apref => ["low", "high", "centre"].map(a => [z, a, apref])));
          for (const [z, anchor, apref] of tries) {
            if (now() - t0 > (o.budgetMs ?? 4000)) break;
            const g = zoneGeometry(z, cur, rules, nets, {tolerance: grp.tolerance, target: sc.h == null ? grp.target : o.hopTargets?.[sc.h], anchor, apref, pairs});
            if (!g) continue;
            const spread = Math.max(...g.lens) - Math.min(...g.lens);
            if (best && spread >= best.spread - 1e-6) continue;
            const mods = z.segs.map(sg => {
              const t = sg.track, a = t.points[sg.i - 1], b = t.points[sg.i], forward = (b[0] - a[0]) * z.u[0] + (b[1] - a[1]) * z.u[1] > 0;
              const mid = forward ? g.lines[sg.k] : g.lines[sg.k].slice().reverse();
              return {id: t.id, points: C.simplify([...t.points.slice(0, sg.i), ...mid, ...t.points.slice(sg.i)]).map(q => [r6(q[0]), r6(q[1])])};
            });
            // Exact clearance of every rebuilt member against the board with the rebuilt bus.
            const copy = {...work, items: work.items.map(i => i.kind === "track" ? {...i} : i)}, byId = new Map(copy.items.map(i => [i.id, i]));
            for (const m of mods) byId.get(m.id).points = m.points;
            const W = R.world(copy, defs);
            if (!mods.every(m => R.check(W, rules, byId.get(m.id)).ok)) continue;
            best = {spread, mods, copy, zone: {layer: z.layer, hop: sc.h, from: r6(g.s0), to: r6(g.s1), bumps: g.bumps, amplitudes: g.A.map(r6)}};
            if (spread <= grp.tolerance / 4) break;
          }
          if (best) break;
        }
        if (!best) { notes.push((sc.h != null ? "hop " + (sc.h + 1) + ": " : "") + (longestRun ? "no clean tuning zone (longest parallel run " + longestRun.toFixed(1) + " mm)" : "no straight parallel run of 1.2 mm or more")); break; }
        for (const m of best.mods) byMod.set(m.id, m);
        zonesUsed.push(best.zone); work = best.copy;
      }
      if (sc.h != null) { const m = sc.measure(work), top = Math.max(...m.map(x => x.length)); hopReport.push({hop: sc.h + 1, lengths: m.map(x => r6(x.length)), spread: r6(top - Math.min(...m.map(x => x.length)))}); }
    }
    let modify = [...byMod.values()];
    const zoneUsed = zonesUsed[0] ? {...zonesUsed[0], zones: zonesUsed} : null;
    // Leftovers: the length engine's patterns on a shadow board that already has the zone.
    let fixed = [], failed = [];
    const shadowItems = board.items.map(i => i.kind === "track" ? {...i} : i), sById = new Map(shadowItems.map(i => [i.id, i]));
    for (const m of modify) sById.get(m.id).points = m.points;
    const shadow0 = {...board, items: shadowItems};
    const mid = measureNets(shadow0, defs, nets);
    const target = grp.target != null ? Math.max(grp.target, ...mid.map(x => x.length)) : Math.max(...mid.map(x => x.length));
    if (!hopSets && Lm?.autoTune && mid.some(x => target - x.length > grp.tolerance / 2)) {
      const name = "__bus__" + nets.length;
      const store = board.lengthTuning && typeof board.lengthTuning === "object" ? board.lengthTuning : {version: 1, groups: [], targets: {}};
      const shadow = {...shadow0, lengthTuning: {...store, groups: [...(store.groups || []).filter(g => g.name !== name), {name, members: nets.slice(), tolerance: grp.tolerance, target}], targets: {...(store.targets || {}), ["group:" + name]: target}}};
      const r = Lm.autoTune(shadow, defs, {keys: ["group:" + name], tolerance: Math.min(grp.tolerance / 4, 0.02), style: o.style, gap: o.gap});
      fixed = r.fixed; failed = r.failed;
      const byMod = new Map(modify.map(m => [m.id, m]));
      for (const m of r.plan.modify) byMod.set(m.id, {id: m.id, points: m.set.points.map(q => [r6(q[0]), r6(q[1])])});
      modify = [...byMod.values()];
    }
    const copy = {...board, items: board.items.map(i => i.kind === "track" ? {...i} : i)}, byId = new Map(copy.items.map(i => [i.id, i]));
    for (const m of modify) { const t = byId.get(m.id); if (t) t.points = m.points; }
    const after = measureNets(copy, defs, nets);
    const tgt = grp.target != null ? Math.max(grp.target, ...after.map(x => x.length)) : Math.max(...after.map(x => x.length));
    const within = hopSets ? hopReport.every(h => h.spread <= grp.tolerance + 1e-6) : after.every(x => !x.unrouted && Math.abs(x.length - tgt) <= grp.tolerance + 1e-6);
    // A plain-language report: how many are in tolerance, who is short by how much, and why.
    const shortOnes = hopSets ? [] : after.filter(x => tgt - x.length > grp.tolerance + 1e-6).map(x => x.net + " " + (tgt - x.length).toFixed(2) + " mm short");
    const inTol = hopSets ? hopReport.filter(h => h.spread <= grp.tolerance + 1e-6).length : after.length - shortOnes.length;
    const report = hopSets ? inTol + " of " + hopReport.length + " hops matched within ±" + grp.tolerance + " mm" + (notes.length ? " · " + notes.join("; ") : "")
      : inTol + " of " + after.length + " within ±" + grp.tolerance + " mm of " + tgt.toFixed(3) + " mm" + (shortOnes.length ? " · " + shortOnes.join(", ") : "") + (notes.length && shortOnes.length ? " · " + notes.join("; ") + ": lengthen a straight run or give the bus room" : "");
    return {ok: within, target: r6(tgt), tolerance: grp.tolerance, group: grp.name, before, after, hops: hopSets ? hopReport : null, zone: zoneUsed, report, plan: {add: [], remove: [], modify}, fixed, failed, ms: Math.round(now() - t0)};
  }

  // ---------------------------------------------------------------- headless
  // Routes a bus along waypoints with optional layer changes, finishing at the destination pads; optionally tunes it.
  function route(board, defs, o = {}) {
    const t0 = now();
    const nets = o.nets ? busNets(board, defs, {nets: o.nets}) : o.members ? null : busNets(board, defs, o, o.project);
    const wps = (o.waypoints || []).filter(p => Array.isArray(p) && finite(p[0]) && finite(p[1]));
    let members = o.members;
    if (!members) {
      const near = o.from || wps[0] || fail("Give from (a point near the bus start) or waypoints.");
      members = membersNear(board, defs, nets, near);
      if (members.length !== nets.length) fail("Some nets have no copper to start from: " + nets.filter(n => !members.some(m => m.net === n)).join(", ") + ".");
    }
    const s = begin(board, defs, {...o, members});
    const changes = new Map((o.layers || []).map(c => [c.after, c])), visits = new Map((o.visits || []).map(v => [v.after, v]));
    const log = [];
    for (let i = 0; i < wps.length; i++) {
      const r = s.move(wps[i]);
      if (r.status === "violation") fail("The bus is blocked at its start: a member would violate clearance.");
      s.click();
      log.push({waypoint: i, status: r.status, end: r.end.map(r6)});
      const c = changes.get(i);
      if (c) {
        if (c.pattern) while (s.state.pattern !== c.pattern) s.cycleViaPattern(1);
        const v = s.switchLayer(c.layer);
        if (!v.ok) fail("Layer change after waypoint " + (i + 1) + ": " + v.message);
        log.push({waypoint: i, layer: c.layer, vias: v.vias, pattern: v.pattern});
      }
      if (o.neckAt?.includes?.(i)) s.toggleNeck();
      // Fly-by: reach a load here (Ctrl+click) and carry on from its pads.
      const vi = visits.get(i);
      if (vi) { const r2 = s.complete(vi.to, {swap: false}); if (!r2.ok) fail("Load after waypoint " + (i + 1) + ": " + r2.message); log.push({waypoint: i, visited: r2.visited || null, next: r2.next || null}); }
    }
    let finished = null;
    if (o.finish) {
      const to = Array.isArray(o.finish) ? o.finish : o.finish.to || o.to;
      finished = s.complete(to, {swap: o.swap !== false});
      if (!finished.ok) fail(finished.message);
    }
    const last = s.readout();
    const plan = s.commit({makeId: o.makeId});
    let tune = null;
    if (o.tune) {
      const copy = JSON.parse(JSON.stringify(board));
      if (plan.swaps?.length) applySwapsToBoard(copy, plan.swaps);
      RT().apply(copy, plan);
      globalThis.AtriumLength?.invalidate?.(copy);
      tune = tuneGroup(copy, defs, plan.nets, {...o, hops: plan.hops});
      const byId = new Map(plan.add.map(i => [i.id, i]));
      for (const m of tune.plan.modify) { const t = byId.get(m.id); if (t) t.points = m.points; else plan.modify.push(m); }
    }
    const members2 = (tune ? tune.after : last).map(x => ({net: x.net, length: x.length, delta: x.delta ?? null, band: x.band ?? null}));
    return {ok: !!(finished?.ok ?? true) && (!tune || tune.ok), plan: {add: plan.add, remove: plan.remove, modify: plan.modify}, swaps: plan.swaps, nets: plan.nets, done: plan.done, hops: plan.hops, loads: plan.loads,
      members: members2, steps: log, tune: tune && {ok: tune.ok, target: tune.target, tolerance: tune.tolerance, before: tune.before, after: tune.after, hops: tune.hops, report: tune.report, failed: tune.failed},
      vias: plan.add.filter(i => i.kind === "via").length, tracks: plan.add.filter(i => i.kind === "track").length, ms: Math.round(now() - t0)};
  }

  // ---------------------------------------------------------------- editor
  let host = null, lastNets = null, tunePreview = null, offRenderer = null, hintShown = false;
  const HINT_KEY = "atrium.busRoute.hint";
  function busShortcut(action) {
    const K = globalThis.AtriumKeymap, id = "bus:" + action;
    const state = {kind: host.doc().kind, tool: host.tool(), canvas: true, interactive: true,
      busRouting: !!host.routeSessionNow?.()?.bus || !!host.liveRoute?.()?.preview?.bus, canProperties: true};
    return K?.bindingsFor(id).find(binding => K.resolve(binding.key, state) === id)?.key;
  }
  function coach() {
    if (hintShown || typeof document === "undefined") return;
    hintShown = true;
    try { if (globalThis.localStorage?.getItem(HINT_KEY)) return; globalThis.localStorage?.setItem(HINT_KEY, "shown"); } catch { /* private mode */ }
    const anchor = document.getElementById("status"); if (!anchor) return;
    const box = document.createElement("span"); box.className = "bus-route-hint"; box.setAttribute("role", "status");
    const hint = binding => AtriumShortcut.render(binding, {variant:"inline"});
    box.append("Bus routing: the ribbon follows the cursor. Click anchors · ", hint("Backspace"), " undoes · ", hint("+"), " / ", hint("-"), " change layer with a via array");
    for (const [action, label] of [["neck", " necks down"], ["via-pattern", " changes the via pattern"], ["reverse", " reverses the order"]]) {
      const key = busShortcut(action);
      if (key) box.append(" · ", hint(key), label);
    }
    box.append(" · Ctrl+click reaches the next load or finishes · ", hint("Escape"), " ends.");
    const x = document.createElement("button"); x.type = "button"; x.className = "ui-button"; x.dataset.size = "sm"; x.textContent = "Got it"; x.onclick = e => { e.stopPropagation(); box.remove(); };
    box.append(x); anchor.after(box);
    setTimeout(() => box.remove(), 20000);
  }
  // Colours from the theme's tokens (every theme, Clearview included), read at most once a second; the band also has a
  // shape (square, triangle, cross) and a dash, so it never relies on colour alone.
  let themeCache = null, themeT = -1e9;
  function theme() {
    const t = now();
    if (themeCache && t - themeT < 1000) return themeCache;
    const fb = {ok: "#3fb950", close: "#d29922", out: "#f85149", panel: "rgba(22,27,34,.92)", ink: "#c9d1d9", tune: "#58a6ff"};
    try {
      const cs = getComputedStyle(document.documentElement), v = (n, d) => cs.getPropertyValue(n).trim() || d;
      themeCache = {ok: v("--success", fb.ok), close: v("--warning", fb.close), out: v("--error", fb.out), panel: v("--overlay", fb.panel), ink: v("--text", fb.ink), tune: v("--accent", fb.tune)};
    } catch { themeCache = fb; }
    themeT = t; return themeCache;
  }
  const DASH = {ok: [], close: [4, 2], out: [1.5, 2]};
  function swatch(ctx, band, x, y, T) {
    ctx.fillStyle = ctx.strokeStyle = T[band] || T.ok; ctx.lineWidth = 1.6;
    if (band === "ok") ctx.fillRect(x, y + 2, 7, 7);
    else if (band === "close") { ctx.beginPath(); ctx.moveTo(x, y + 9); ctx.lineTo(x + 3.5, y + 2); ctx.lineTo(x + 7, y + 9); ctx.closePath(); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(x, y + 2); ctx.lineTo(x + 7, y + 9); ctx.moveTo(x + 7, y + 2); ctx.lineTo(x, y + 9); ctx.stroke(); }
  }
  // Canvas overlay: a colour band per member along its head, the order at the start, and the live length readout.
  function overlay() {
    return (ctx, env) => {
      const live = host?.liveRoute?.(), r = live?.preview;
      const T = theme();
      if (tunePreview) {
        ctx.save(); ctx.globalAlpha = .9; ctx.lineCap = "round"; ctx.lineJoin = "round";
        for (const t of tunePreview.tracks) { ctx.strokeStyle = T.tune; ctx.lineWidth = Math.max(t.width, 2 / env.scale); ctx.beginPath(); t.points.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.stroke(); }
        ctx.restore();
      }
      if (!r?.bus) return;
      ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
      const rows = r.bus.members, byNet = new Map(rows.map(x => [x.net, x]));
      for (const t of r.preview) {
        if (!t.head) continue;
        const b = byNet.get(t.net); if (!b) continue;
        ctx.globalAlpha = .6; ctx.strokeStyle = T[b.band] || T.ok; ctx.lineWidth = Math.max(t.width * 0.45, 1.5 / env.scale);
        ctx.setLineDash((DASH[b.band] || []).map(v => v / env.scale));
        ctx.beginPath(); t.points.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.stroke();
      }
      ctx.restore();
      // Screen-space readout beside the head.
      const head = r.end; if (!head) return;
      // The head in CSS pixels from the current world transform, then a panel above and right of it, kept on the canvas.
      const m = ctx.getTransform(), dpr = env.dpr || 1, sx = (m.a * head[0] + m.c * head[1] + m.e) / dpr, sy = (m.b * head[0] + m.d * head[1] + m.f) / dpr;
      ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const lineH = 14, w = 214, h = 18 + lineH * rows.length, cw = ctx.canvas.width / dpr, ch = ctx.canvas.height / dpr;
      let x = sx + 28, y = sy - h - 28;
      if (x + w > cw - 4) x = sx - w - 28;
      if (y < 4) y = Math.min(ch - h - 4, sy + 28);
      ctx.globalAlpha = .92; ctx.fillStyle = T.panel; ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1; ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace"; ctx.textBaseline = "top"; ctx.textAlign = "left";
      ctx.fillStyle = T.ink; ctx.fillText((r.bus.group ? r.bus.group + " · " : "") + "±" + r.bus.tolerance.toFixed(3) + (r.bus.target != null ? " → " + r.bus.target.toFixed(2) : "") + (r.bus.loads?.length ? " · hop " + r.bus.hop + (r.bus.next ? " → " + r.bus.next : "") : ""), x + 6, y + 3);
      rows.forEach((m, i) => {
        const yy = y + 16 + i * lineH;
        swatch(ctx, m.band, x + 6, yy, T);
        ctx.fillStyle = T.ink;
        ctx.fillText((m.net.length > 9 ? m.net.slice(0, 9) : m.net).padEnd(9) + " " + m.length.toFixed(2).padStart(7) + " " + (m.delta >= 0 ? "+" : "") + m.delta.toFixed(2).padStart(5) + " " + (m.delay / 1).toFixed(0).padStart(4) + "ps", x + 16, yy);
      });
      ctx.restore();
    };
  }
  function ensureRenderer() {
    if (offRenderer || !host?.addRenderer) return;
    offRenderer = host.addRenderer((d, info) => {
      // Each frame: keep the Properties panel's Bus section in step with the live session (cheap when unchanged).
      if (info?.active && (current || panelShown)) { try { panelSync(); } catch { /* the panel is optional */ } }
      return info?.active && d?.kind === "pcb" && (tunePreview || host.liveRoute?.()?.preview?.bus) ? {overlay: overlay()} : null;
    });
  }
  // The live session (handed to the editor with navHost.startRoute). Its commit and cancel are wrapped here so the
  // editor needs no bus-specific code: pin swaps join the plan as pad-net changes (same undo step), the schematic is
  // back-annotated right after, the status line gets the bus's own message, and the bus is remembered for Re-route Bus.
  let current = null;
  function startSession(d, members, o = {}) {
    const defs = host.defs();
    const s = begin(d, defs, {members, layer: host.activeLayer?.() || o.layer || members.find(m => m.layer)?.layer, project: host.project(), revision: host.revision?.(), ...o.opts});
    lastNets = members.map(m => m.net);
    ensureRenderer();
    if (!host.startRoute) return false;
    const commit0 = s.commit, cancel0 = s.cancel;
    s.commit = opt => {
      const rec = s.record(), plan = commit0(opt);
      current = null; panelSync();
      if (!plan.add.length) return plan;
      const byPart = new Map();
      for (const sw of plan.swaps || []) {
        const part = d.items.find(i => i.id === sw.partId); if (!part) continue;
        const pn = byPart.get(sw.partId) || {...part.pinNets};
        for (const [a, b] of sw.pairs) { const x = pn[a]; pn[a] = pn[b]; pn[b] = x; }
        byPart.set(sw.partId, pn);
      }
      for (const [id, pinNets] of byPart) plan.modify.push({id, pinNets});
      remember(d, rec, plan);
      setTimeout(() => {
        const P = host.project(), PS = globalThis.AtriumPinSwap;
        // derive: part of the route's undo step (one undo restores board and schematic together), and only once the
        // editor has applied the swaps (a refused edit leaves the board as it was).
        const swapped = [...byPart].some(([id, pn]) => { const part = d.items.find(i => i.id === id); return part && Object.keys(pn).every(k => part.pinNets?.[k] === pn[k]); });
        if (swapped && PS?.backAnnotate && P.documents.some(x => x.kind === "schematic")) try { (host.derive || host.edit)(() => PS.backAnnotate(P, d)); } catch { /* the board keeps the swap */ }
        if (plan.message) host.info(plan.message);
      }, 0);
      return plan;
    };
    s.cancel = () => { current = null; cancel0(); panelSync(); };
    current = s;
    host.startRoute(s);
    if (o.at) host.redraw?.();
    coach(); panelSync();
    return true;
  }
  // Bus keys (N, B, /) and Properties-panel edits change the live session and redraw it in place.
  function busKey(k) {
    const s = current;
    if (!s || (host.routeSessionNow ? host.routeSessionNow() !== s : !host.liveRoute?.()?.preview?.bus)) return;
    const r = s.key(k); s.refresh(); host.redraw?.(); panelSync(true);
    if (r?.message) host.info(r.message);
  }
  // Properties panel: while a bus is live, a Bus section above the router's own (member width and gap, neck-down,
  // via array pattern, order and the fly-by hop).
  let observer = null, panelShown = false;
  function panelSync(force) {
    if (typeof document === "undefined") return;
    const panel = document.getElementById("inspector"); if (!panel) return;
    if (!observer && typeof MutationObserver === "function") { observer = new MutationObserver(() => panelSync()); observer.observe(panel, {childList: true}); }
    const old = panel.querySelector(".bus-route-props");
    const live = current && host.liveRoute?.()?.preview?.bus ? current : null;
    panelShown = !!live;
    if (!live) { old?.remove(); return; }
    const b = host.liveRoute().preview.bus, sig = [b.orderFixed, b.neck, b.pattern, b.hop, b.width, b.gap, b.order.join(","), b.next].join("|");
    if (old && !force && old.dataset.sig === sig) return;
    const s = live, sec = document.createElement("section");
    sec.dataset.sig = sig;
    sec.className = "inspect-section bus-route-props";
    const h = document.createElement("h3"); h.textContent = "Bus · " + b.nets.length + " nets"; sec.append(h);
    const field = (label, input) => { const l = document.createElement("label"); l.className = "property-row"; const t = document.createElement("span"); t.textContent = label; l.append(t, input); sec.append(l); return input; };
    const num = (label, value, fn, disabled) => { const i = document.createElement("input"); i.type = "number"; i.step = "0.005"; i.min = "0"; i.dataset.numericUnit = "mm"; i.value = String(+value.toFixed(3)); i.disabled = !!disabled;
      i.onchange = () => { const v = parseFloat(i.value); if (Number.isFinite(v) && v >= 0) { fn(v); s.refresh(); host.redraw?.(); panelSync(true); } }; return field(label, i); };
    const fixed = b.orderFixed;
    const C = globalThis.AtriumNavCommon, neckKey = busShortcut("neck");
    const withKey = (input, label, key) => {
      if (key) {const badge = AtriumShortcut.render(key, {variant:"inline"});badge.setAttribute("aria-hidden", "true");input.previousElementSibling.append(" ", badge);}
      C.shortcutTitle(input, label, key);
    };
    const width = num("Member width (mm)", b.width, v => s.setWidth(v), fixed);
    if (fixed) C.shortcutTitle(width, "Set before the first click. Then use Neck down", neckKey);
    else width.title = "Width of every member (pairs keep their pair width)";
    num("Gap (mm)", b.gap, v => s.setGap(v), fixed).title = "Edge-to-edge gap between neighbours; never below the clearance rule";
    const neck = document.createElement("input"); neck.type = "checkbox"; neck.checked = !!b.neck; neck.onchange = () => busKey("neck");
    withKey(field("Neck down", neck), "Neck down", neckKey);
    const pat = document.createElement("select");
    for (const pp of PATTERNS) { const op = document.createElement("option"); op.value = pp; op.textContent = PATTERN_NAMES[pp]; op.selected = pp === b.pattern; pat.append(op); }
    pat.onchange = () => { s.setPattern(pat.value); host.info(PATTERN_NAMES[pat.value] + " for the next layer change"); };
    withKey(field("Via array", pat), "Via array", busShortcut("via-pattern"));
    if (b.flyBy) { const sp = document.createElement("strong"); sp.textContent = "hop " + b.hop + (b.next ? " → " + b.next : " (last)") + " · stub 0 mm"; field("Fly-by", sp); }
    const ol = document.createElement("ol"); ol.className = "bus-route-order ui-dialog-body";
    const order = b.order.slice(), can = s.canReorder();
    order.forEach((n, i) => {
      const li = document.createElement("li"); li.append(document.createTextNode(n));
      for (const [txt, d] of [["↑", -1], ["↓", 1]]) {
        const bt = document.createElement("button"); bt.type = "button"; bt.textContent = txt; bt.disabled = !can || !order[i + d];
        bt.onclick = () => { const o2 = order.slice(); [o2[i], o2[i + d]] = [o2[i + d], o2[i]]; s.setOrder(o2); s.refresh(); host.redraw?.(); panelSync(true); };
        li.append(bt);
      }
      ol.append(li);
    });
    const rev = document.createElement("button"); rev.type = "button"; rev.textContent = "Reverse order"; rev.disabled = !can; rev.onclick = () => busKey("reverse");
    const reverseKey = busShortcut("reverse");
    if (reverseKey) {
      const badge = AtriumShortcut.render(reverseKey, {variant:"inline"}); badge.setAttribute("aria-hidden", "true");
      rev.append(" ", badge);
    }
    C.shortcutTitle(rev, "Reverse order", reverseKey);
    const t2 = document.createElement("span"); t2.className = "bus-route-msg"; t2.textContent = can ? "Order, from the pin geometry; change it before the first click." : "The order is fixed once the bus has left its start.";
    sec.append(ol, rev, t2);
    if (old) old.replaceWith(sec); else panel.prepend(sec);
  }
  // Re-route Bus: each committed bus is remembered (per board, for this session) with its clicks, layer changes, neck
  // toggles and loads, so it can be routed again from its pads' current positions after parts move.
  const routes = new WeakMap();
  function remember(d, rec, plan) {
    const list = routes.get(d) || []; routes.set(d, list);
    list.push({...rec, ids: plan.add.map(i => i.id), hops: plan.hops, name: rec.nets.length + " nets (" + rec.nets[0] + "…)", sig: null});
  }
  function recordOf(d, id) { return (routes.get(d) || []).find(r => r.ids.includes(id)) || null; }
  function owns(id) { const d = host?.doc?.(); return !!(d && id && recordOf(d, id)); }
  function padNow(d, defs, m) {
    if (!m.part) return m.at;
    const e = endpoints(d, defs, m.net).find(x => x.part === m.part && String(x.pad) === String(m.pad));
    return e ? e.at : m.at;
  }
  // Where the bus's pads are now: its start pads and every pad of its nets on the loads it reached.
  function padSig(d, rec) {
    const defs = host?.defs?.(), parts = new Set([...rec.members.map(m => m.part), ...rec.loadParts || []].filter(Boolean)), out = [];
    for (const m of rec.members) {
      out.push(padNow(d, defs, m).map(v => v.toFixed(3)).join(","));
      for (const e of endpoints(d, defs, m.net)) if (e.part && parts.has(e.part) && e.part !== m.part) out.push(e.at.map(v => v.toFixed(3)).join(","));
    }
    return out.join(";");
  }
  function reroutePlan(d, defs, rec) {
    const members = rec.members.map(m => ({...m, at: padNow(d, defs, m)}));
    const wps = [], layers = [], visits = [], neckAt = [];
    let finish = null;
    const visitSteps = rec.clicks.filter(c => c.kind === "visit");
    for (const c of rec.clicks) {
      if (c.kind === "click") wps.push(c.at);
      else if (c.kind === "layer") layers.push({after: wps.length - 1, layer: c.layer, pattern: c.pattern});
      else if (c.kind === "neck") neckAt.push(wps.length - 1);
      else if (c.kind === "visit") { if (c === visitSteps[visitSteps.length - 1] && rec.finished) finish = {to: c.to}; else visits.push({after: wps.length - 1, to: c.to}); }
    }
    const without = {...d, items: d.items.filter(i => !rec.ids.includes(i.id))};
    const r = route(without, defs, {members, layer: rec.layer, mode: rec.mode, corner: rec.corner, width: rec.width ?? undefined, gap: rec.gap ?? undefined, waypoints: wps, layers, visits, neckAt, finish, swap: false, project: host?.project?.()});
    return {r, remove: rec.ids.filter(id => d.items.some(i => i.id === id))};
  }
  function reroute(id) {
    const d = host?.doc?.(); if (d?.kind !== "pcb") return;
    const sel = host.selection?.() || [], rec = recordOf(d, id) || sel.map(x => recordOf(d, x)).find(Boolean);
    if (!rec) { host.info("Select a track of a bus routed in this session (Route › Interactive Bus Routing)."); return; }
    let out;
    try { out = reroutePlan(d, host.defs(), rec); } catch (e) { host.info("Re-route bus: " + e.message + " The bus is unchanged."); return; }
    const plan = {add: out.r.plan.add, remove: out.remove, modify: out.r.plan.modify};
    host.edit(() => RT().apply(d, plan)); RT().invalidate?.(d);
    rec.ids = plan.add.map(i => i.id); rec.hops = out.r.hops; rec.sig = padSig(d, rec);
    host.info("Bus re-routed from its pads' new positions: " + out.r.tracks + " tracks, " + out.r.vias + " vias" + (out.r.done ? "." : " (unfinished, as before).") + " Tune Bus Group matches the lengths again.");
  }
  // After an edit, a bus whose pads moved offers Re-route Bus in the status bar (and on its tracks' right-click menu).
  let offered = "";
  function watchMoves() {
    const d = host?.doc?.(), list = d && routes.get(d);
    if (!list?.length || typeof document === "undefined") return;
    for (const rec of list) {
      if (!rec.ids.some(id => d.items.some(i => i.id === id))) continue;
      const sig = padSig(d, rec);
      // The first look after the commit (whose pin swaps change pad nets) sets the reference.
      if (rec.sig == null) { rec.sig = sig; continue; }
      if (sig === rec.sig || offered === sig) continue;
      offered = sig;
      const anchor = document.getElementById("status"); if (!anchor) return;
      const box = document.createElement("span"); box.className = "bus-route-hint"; box.setAttribute("role", "status");
      const b = (t, fn, cls) => { const x = document.createElement("button"); x.type = "button"; x.textContent = t; x.className = "ui-button"; x.dataset.size = "sm"; if (cls) { x.classList.add(cls); x.dataset.variant = "primary"; } x.onclick = e => { e.stopPropagation(); box.remove(); fn(); }; return x; };
      box.append(document.createTextNode("Parts of bus " + rec.name + " moved. "), b("Re-route bus", () => reroute(rec.ids[0]), "is-primary"), b("Keep", () => { rec.sig = sig; }));
      anchor.after(box); setTimeout(() => box.remove(), 30000);
      return;
    }
  }
  // Route › Interactive Bus Routing: from selected tracks/vias, else a bus picked from a group or query.
  async function interactive() {
    if (!host) return;
    await globalThis.AtriumLazy?.need?.(["AtriumLength", "AtriumPinSwap", "AtriumQuery"]).catch(() => null);
    const d = host.doc?.();
    if (d?.kind !== "pcb") { host.info("Open a board layout to route a bus."); return; }
    const ids = host.selection?.() || [];
    const options = {project: host.project(), revision: host.revision?.()};
    const index = ids.length ? globalThis.AtriumLength?.routingIndex?.(d, host.defs(), options) : null;
    const selected = !ids.length ? [] : index ? ids.map(id => index.byId.get(id)).filter(Boolean) : d.items.filter(i => ids.includes(i.id));
    const selNets = new Set(selected.filter(i => i.net && (i.kind === "track" || i.kind === "via")).map(i => i.net));
    if (selNets.size >= 2) {
      const cx = selected.filter(i => i.kind === "via").map(i => [i.x, i.y]).concat(selected.filter(i => i.kind === "track").map(t => t.points.at(-1)));
      const c = cx.length ? [cx.reduce((s, q) => s + q[0], 0) / cx.length, cx.reduce((s, q) => s + q[1], 0) / cx.length] : [0, 0];
      const members = membersFromSelection({items: selected}, ids, c);
      if (members.length >= 2 && host.startRoute) { startSession(d, members, {at: c}); return; }
      // Older editor without startRoute: Interactive Multi-Routing's click-to-end flow.
      return globalThis.AtriumMultiRoute?.legacy?.();
    }
    const pick = await chooseBus(d);
    if (!pick) return;
    const at = await host.pickPoint?.("Bus " + pick.nets.length + " nets: click near the source end (the pads or fanout to start from). Escape cancels.");
    if (!at) return;
    if (host.doc?.() !== d) { host.info("The board changed. Run Interactive Bus Routing again."); return; }
    const members = membersNear(d, host.defs(), pick.nets, at, {...options, layer:host.activeLayer?.()});
    if (members.length < 2) { host.info("Fewer than two of these nets have copper near there."); return; }
    try { startSession(d, members, {at, opts: {order: pick.order}}); } catch (e) { host.info(e.message); }
  }
  // Picker: groups, a query, and the member order with reordering.
  function chooseBus(d) {
    return new Promise(resolve => {
      if (typeof document === "undefined") { resolve(null); return; }
      const defs = host.defs(), list = groups(d, defs, host.project());
      const dlg = document.createElement("dialog"); dlg.className = "ui-dialog work-dialog bus-route-dialog"; dlg.setAttribute("aria-label", "Interactive bus routing");
      const h = document.createElement("h2"); h.textContent = "Interactive Bus Routing"; h.className = "ui-dialog-title";
      const sel = document.createElement("select"); sel.className = "ui-field"; sel.setAttribute("aria-label", "Group");
      for (const g of list) { const op = document.createElement("option"); op.value = g.kind + ":" + g.name; op.textContent = g.name + " (" + g.nets.length + " nets, " + (g.kind === "class" ? "net class" : "length group") + ")"; sel.append(op); }
      const q = document.createElement("input"); q.type = "text"; q.className = "ui-field"; q.placeholder = "Or a query, e.g. InNetClass('DDR_BYTE0')"; q.setAttribute("aria-label", "Query");
      const ol = document.createElement("ol"); ol.className = "bus-route-order ui-dialog-body";
      const msg = document.createElement("p"); msg.className = "bus-route-msg";
      let nets = [];
      const render = () => {
        ol.replaceChildren(...nets.map((n, i) => {
          const li = document.createElement("li"); li.textContent = n;
          const up = document.createElement("button"); up.type = "button"; up.className = "ui-button"; up.dataset.size = "sm"; up.textContent = "↑"; up.title = "Move up"; up.disabled = i === 0;
          up.onclick = () => { [nets[i - 1], nets[i]] = [nets[i], nets[i - 1]]; render(); };
          const dn = document.createElement("button"); dn.type = "button"; dn.className = "ui-button"; dn.dataset.size = "sm"; dn.textContent = "↓"; dn.title = "Move down"; dn.disabled = i === nets.length - 1;
          dn.onclick = () => { [nets[i + 1], nets[i]] = [nets[i], nets[i + 1]]; render(); };
          li.append(up, dn); return li;
        }));
      };
      const refresh = () => {
        try {
          nets = q.value.trim() ? busNets(d, defs, {query: q.value}, host.project()) : list.find(g => g.kind + ":" + g.name === sel.value)?.nets.slice() || [];
          msg.textContent = nets.length + " nets. The order is set from the pin geometry when you start; reorder here to override.";
          manual = false;
        } catch (e) { nets = []; msg.textContent = e.message; }
        if (!nets.length && !q.value.trim() && !list.length) msg.textContent = "No net classes or length groups yet: type a query, or select tracks or vias of the bus first.";
        sel.hidden = !list.length; ol.hidden = !nets.length; go.disabled = nets.length < 2;
        render();
      };
      let manual = false;
      ol.addEventListener("click", () => { manual = true; });
      sel.onchange = refresh; q.oninput = refresh;
      const row = document.createElement("div"); row.className = "dialog-actions work-actions ui-dialog-actions";
      const go = document.createElement("button"); go.type = "button"; go.className = "ui-button"; go.dataset.variant = "primary"; go.textContent = "Start";
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "ui-button"; cancel.textContent = "Cancel";
      const done = v => { dlg.close(); dlg.remove(); resolve(v); };
      go.onclick = () => nets.length >= 2 ? done({nets: nets.slice(), order: manual ? nets.slice() : null}) : (msg.textContent = "Choose two or more nets.");
      cancel.onclick = () => done(null);
      dlg.addEventListener("cancel", e => { e.preventDefault(); done(null); });
      row.append(cancel, go);
      dlg.append(h, sel, q, ol, msg, row);
      document.body.append(dlg);
      refresh();
      globalThis.AtriumShell?.adoptDialog?.(dlg, {initialFocus: list.length ? sel : q});
      dlg.showModal();
    });
  }
  // A click with the bus tool and no session: start the last bus again from its copper nearest the click.
  function restart(p) {
    if (!host || !lastNets) { host?.info?.("Run Route › Interactive Bus Routing to pick a bus."); return; }
    const d = host.doc?.(); if (d?.kind !== "pcb") return;
    const members = membersNear(d, host.defs(), lastNets, p, {project:host.project(), revision:host.revision?.(), layer:host.activeLayer?.()});
    if (members.length < 2) { host.info("No copper of the last bus near there."); return; }
    try { startSession(d, members, {at: p}); } catch (e) { host.info(e.message); }
  }
  // Route › Tune Bus Group: the selected tracks' nets, or the last bus; previewed, then accepted as one undo step.
  async function tuneInteractive() {
    if (!host) return;
    await globalThis.AtriumLazy?.need?.(["AtriumLength"]).catch(() => null);
    const d = host.doc?.();
    if (d?.kind !== "pcb") { host.info("Open a board layout first."); return; }
    const ids = host.selection?.() || [];
    let nets = [...new Set(d.items.filter(i => ids.includes(i.id) && i.net && (i.kind === "track" || i.kind === "via")).map(i => i.net))];
    // A selected track of a remembered bus means that whole bus.
    const own = ids.map(id => recordOf(d, id)).find(Boolean);
    if (own) nets = own.nets.slice();
    if (nets.length < 2) nets = lastNets || [];
    if (nets.length < 2) { host.info("Select tracks of the bus (two or more nets), or route a bus first."); return; }
    let r;
    const rec = (routes.get(d) || []).slice().reverse().find(x => x.nets.length === nets.length && x.nets.every(n => nets.includes(n)));
    const hops = rec?.hops?.length > 1 ? rec.hops.map(h => h.filter(id => d.items.some(i => i.id === id))) : null;
    try { r = tuneGroup(d, host.defs(), nets, hops ? {hops} : {}); } catch (e) { host.info(e.message); return; }
    if (!r.plan.modify.length) { host.info(r.ok ? "Every member is already within ±" + r.tolerance + " mm" + (r.hops ? " on every hop." : " of " + r.target.toFixed(3) + " mm.") : "Nothing to tune: " + r.report + "."); return; }
    const byId = new Map(d.items.map(i => [i.id, i]));
    tunePreview = {tracks: r.plan.modify.map(m => ({points: m.points, width: byId.get(m.id)?.width || 0.15}))};
    ensureRenderer(); host.redraw?.();
    const summary = "Tune bus: " + r.report;
    const accept = () => { tunePreview = null; host.edit(() => RT().apply(d, r.plan)); RT().invalidate?.(d); host.info(summary + ". Accepted."); };
    const discard = () => { tunePreview = null; host.redraw?.(); host.info("Tuning discarded."); };
    if (typeof document === "undefined" || !document.getElementById("status")) { accept(); return; }
    const box = document.createElement("span"); box.className = "bus-route-hint"; box.setAttribute("role", "status");
    const b = (t, fn, cls) => { const x = document.createElement("button"); x.type = "button"; x.textContent = t; x.className = "ui-button"; x.dataset.size = "sm"; if (cls) { x.classList.add(cls); x.dataset.variant = "primary"; } x.onclick = e => { e.stopPropagation(); box.remove(); fn(); }; return x; };
    box.append(document.createTextNode(summary + ". "), b("Accept", accept, "is-primary"), b("Discard", discard));
    document.getElementById("status").after(box);
    host.info(summary + " (preview).");
  }
  function attach(h) {
    host = h;
    h.registerAction("route-bus", () => { interactive().catch(e => h.info?.(e.message)); });
    // Interactive Multi-Routing's action id (multi-route.js) keeps working and opens the bus router.
    for (const alias of ["route-multi"]) h.registerAction(alias, () => { interactive().catch(e => h.info?.(e.message)); });
    h.registerAction("bus-tune-group", () => { tuneInteractive().catch(e => h.info?.(e.message)); });
    for (const [action, , , param] of KEYS) h.registerAction(action, () => busKey(param));
    const reAction = "bus-reroute";
    h.registerAction(reAction, () => reroute((h.selection?.() || [])[0]));
    h.on?.("change", () => { try { watchMoves(); } catch { /* never block an edit */ } });
    globalThis.AtriumKeymap?.onChange(() => { if (panelShown) panelSync(true); });
  }
  // Keys inside a bus session (editor action bus-key), and the menu commands if lazy.js has not stubbed them.
  const KEYS = [["bus-neck", "Bus routing: neck down / spread out", "N", "neck"], ["bus-via-pattern", "Bus routing: cycle via array pattern (in-line, staggered)", "B", "pattern"],
    ["bus-reverse", "Bus routing: reverse the member order", "Alt+/", "reverse"]];
  function registerKeys() {
    const K = globalThis.AtriumKeymap;
    if (!K?.registerCommand) return;
    const when = "pcb && busRouting";
    for (const [action, title, key] of KEYS) try { const id = "bus:" + action.slice(4); if (!K.command?.(id)) K.registerCommand({id, title, category: "Routing", action, when, defaultKeys: [{key, when}]}); } catch { /* registered */ }
    for (const [id, action, title, category, key] of [["bus:route-bus", "route-bus", "Interactive bus routing", "Place", "P M"], ["bus:tune-group", "bus-tune-group", "Tune bus group", "Routing", null],
      ["bus:reroute", "bus-reroute", "Re-route bus", "Routing", null]])
      try { if (!K.command?.(id)) K.registerCommand({id, title, category, action, when: "pcb", defaultKeys: key ? [key] : []}); } catch { /* registered */ }
  }
  registerKeys();
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({begin, route, tuneGroup, owns, recordOf, reroutePlan, zones, zoneGeometry, applySwaps: applySwapsToBoard, groups, busNets, endpoints, membersNear, membersFromSelection, gather, offsetPath, pairsOf, octant, restart, interactive,
    PATTERNS: PATTERNS.slice(), PATTERN_NAMES, attach});
})();
