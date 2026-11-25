"use strict";
if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// Dynamic re-route on component drag (lazy: loads with AtriumRouter).
//
// While parts (or a selection of parts, vias and pads) are dragged, every routed track attached to a
// moving pad is re-routed live from the pad's new position back to its first fixed anchor: the
// nearest via, branch point or pad, or the point a configurable distance (the re-route depth) back
// along the track. Chains of end-to-end track pieces (one item per segment, as KiCad and Eagle
// imports have them) are followed through plain joints. Each re-route keeps the track's layer and
// width and the corner style (the router's current style, else the rule, else the track's own), and
// resolves conflicts in the current routing mode: walkaround, push (other copper is shoved and
// returned to the plan), hug, stop or ignore. Diff pairs are routed as one coupled ribbon at their
// gap. Copper that is not attached never moves, unless push shoves it.
//
// Performance: the session never routes more than the live cap (Preferences › Routing; default 32)
// while the pointer moves; the rest show as rubber-band airwires and are routed on the drop. Work
// runs in time-sliced, latest-wins jobs: each pointer move re-plans from scratch for the newest
// offset and routes connections in staleness order until the per-frame slice (3 ms) is spent; the
// rest continue in later slices (MessageChannel, re-armed per animation frame) and show their last
// route meanwhile. A move never waits on older work. Length-matched nets show their live Δ in a small
// label beside the parts (computed in idle slices). The drop routes everything once more, glosses
// the re-routed pieces and returns one plan (one undo step). Cancel (Esc) leaves the board untouched:
// nothing here writes to the model.
//
// API (the same shape as AtriumRouter.dragSession, which the editor falls back to):
//   s = AtriumDragReroute.dragSession(board, defs, ids, {revision, project, mode, corner, enabled,
//         maxConnections | cap, depth, frameMs, shift, onUpdate(preview)})
//   s.move([dx, dy]) -> preview   s.flush() -> preview (finish pending work now)   s.commit([dx,dy]) -> plan
//   s.cancel()   s.setShift(bool)   s.setEnabled(bool)   s.setMaxConnections(n)   s.state   s.restart(board, defs)
globalThis.AtriumDragReroute = (() => {
  const {segmentDistance} = globalThis.AtriumGeometry;
  const now = typeof performance !== "undefined" && performance.now ? () => performance.now()
    : typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const MODES = ["on", "off", "shift"];
  const MODE_NAMES = {on:"On", off:"Off", shift:"On with Shift"};
  const DEFAULTS = Object.freeze({mode:"on", cap:32, depth:2, frameMs:2});
  const TOL = 1e-4, MAXCHAIN = 120, SPLIT = 0.4, DROP_MS = 140;

  // ------------------------------------------------------------------ preferences
  function pref(key) { try { const v = globalThis.AtriumPref?.get?.(key); return v === undefined ? null : v; } catch { return null; } }
  function settings(o = {}) {
    let mode = MODES.includes(o.dragMode) ? o.dragMode : pref("routing.dragReroute");
    if (!MODES.includes(mode)) mode = DEFAULTS.mode;
    if (o.enabled === false) mode = "off";
    const capPref = pref("routing.dragRerouteCap"), depthPref = pref("routing.dragRerouteDepth");
    let cap = finite(o.cap) ? o.cap : capPref != null && finite(+capPref) ? +capPref : finite(o.maxConnections) ? o.maxConnections : DEFAULTS.cap;
    cap = Math.max(0, Math.min(1024, cap | 0));
    let depth = finite(o.depth) ? o.depth : finite(o.reach) ? o.reach : depthPref != null && finite(+depthPref) ? +depthPref : DEFAULTS.depth;
    depth = Math.max(0.05, Math.min(100, depth));
    const frameMs = finite(o.frameMs) ? Math.max(0.25, o.frameMs) : DEFAULTS.frameMs;
    return {mode, cap, depth, frameMs};
  }

  // ------------------------------------------------------------------ geometry helpers
  const unit = (a, b) => { const l = dist(a, b); return l > 1e-12 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null; };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  function plen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
  function polyDist(A, B) {
    let m = Infinity;
    for (let i = 1; i < A.length; i++) for (let j = 1; j < B.length; j++) {
      const distance = segmentDistance(A[i - 1], A[i], B[j - 1], B[j]);
      if (distance < m) m = distance;
    }
    return m;
  }
  // Smallest interior angle (radians) where segment u (arriving) meets v (leaving); PI is straight.
  function joinAngle(a, b, c) {
    const u = unit(b, a), v = unit(b, c);
    if (!u || !v) return Math.PI;
    return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
  }
  // A polyline that approximates an arc: many short segments turning the same way by small angles.
  function looksArc(pts) {
    let run = 0;
    for (let i = 2; i < pts.length; i++) {
      const t = Math.PI - joinAngle(pts[i - 2], pts[i - 1], pts[i]);
      if (t > 1e-3 && t < 0.35 && dist(pts[i - 1], pts[i]) < 0.6) { if (++run >= 3) return true; } else run = 0;
    }
    return false;
  }

  // ------------------------------------------------------------------ the session
  let current = null, probe = null;   // probe(t0, ms): each re-route slice between frames (scripts/perf-drag.py)
  // Live length labels: nets' targets and lengths per board revision, filled in idle slices.
  const lengthCache = new WeakMap();
  function hasLengthRules(board) {
    const lt = board.lengthTuning;
    if (lt && typeof lt === "object" && Object.values(lt).some(v => Array.isArray(v) ? v.length : v && typeof v === "object" && Object.keys(v).length)) return true;
    if (globalThis.AtriumSignals?.xsView?.(board).xSignals.length) return true;
    const set = globalThis.AtriumRules?.stored?.(board), list = set?.list || set;
    return Array.isArray(list) && list.some(r => r && r.enabled !== false && /length/i.test(String(r.type || "")));
  }
  // Diff pairs of a board (AtriumDiffPair.pairs scans every item): once per board revision.
  const pairCache = new WeakMap();
  function pairsCached(board, DP, revision) {
    const c = pairCache.get(board);
    if (c && revision != null && c.revision === revision && c.items === board.items) return c.list;
    const list = DP.pairs ? DP.pairs(board) : [];
    pairCache.set(board, {revision, items:board.items, list});
    return list;
  }
  function dragSession(board, defs, partIds, o = {}) {
    const RT = globalThis.AtriumRouter, C = RT?.core;
    if (!C) throw Error("The router is not loaded.");
    if (!board || board.kind && board.kind !== "pcb") throw Error("Open a PCB layout to drag components.");
    if (partIds && !Array.isArray(partIds) && !(partIds instanceof Set) && typeof partIds === "object") { o = partIds; partIds = o.ids || []; }
    const t0 = now(), cfg = settings(o);
    const W = C.worldFor(board, defs, o), rules = C.rulesFor(board, o.rules, o.project), sc = W.scene;
    sc.reset(); W.n = W.nPersist;
    const pn0 = W.pn, ids = new Set(partIds || []);
    const routeMode = C.MODES.includes(o.mode) ? o.mode : "walkaround";
    const cornerPref = C.CORNERS.includes(o.corner) ? o.corner : null;
    let shiftHeld = !!o.shift, alive = true;
    const enabledNow = () => cfg.mode === "on" || (cfg.mode === "shift" && shiftHeld);

    // Moving owners (parts' pads and shapes, selected vias, pads and tracks).
    const movingSet = new Set(), moving = [];
    for (let k = 0; k < W.owners.length; k++) {
      const rec = W.owners[k];
      if (!rec || rec.id == null || !ids.has(rec.id) || !rec.count || rec.kind === "outline" || (W.dead[rec.first] & 1)) continue;
      movingSet.add(k); moving.push(k);
    }
    // Same-net copper touching p on layer li, other than `self`: owner indices.
    function contacts(p, li, net, self) {
      const out = [], m = C.candidates(W, p[0], p[1], p[0], p[1], 1e-3, li, li), list = Array.from(W.qb.subarray(0, m));
      for (const g of list) {
        const to = W.own[g];
        if (to < 0 || to === self || W.net[g] !== net || out.includes(to)) continue;
        if (C.fdist(W, g, p[0], p[1], p[0], p[1]) <= TOL) out.push(to);
      }
      return out;
    }
    // Tracks with an end on a moving pad or via of their own net.
    const touched = new Map();
    for (const mo of moving) {
      const rec = W.owners[mo];
      if ((rec.kind !== "pad" && rec.kind !== "via") || rec.net < 0) continue;
      for (let f = rec.first; f < rec.first + rec.count; f++) {
        const cx = (W.x0[f] + W.x1[f]) / 2, cy = (W.y0[f] + W.y1[f]) / 2, rad = Math.hypot(W.x1[f] - W.x0[f], W.y1[f] - W.y0[f]) / 2 + 0.01;
        const m = C.candidates(W, cx, cy, cx, cy, rad, W.lo[f], W.hi[f]), list = Array.from(W.qb.subarray(0, m));
        for (const g of list) {
          const to = W.own[g]; if (to < 0 || movingSet.has(to)) continue;
          const tr = W.owners[to]; if (!tr || tr.kind !== "track" || tr.net !== rec.net || W.net[f] !== rec.net) continue;
          const pts = tr.item.points; if (!pts || pts.length < 2) continue;
          let t = touched.get(to); if (!t) touched.set(to, t = {owner:to, ends:[false, false], pads:[null, null], padOwner:[-1, -1]});
          for (const e of [0, 1]) {
            const p = pts[e ? pts.length - 1 : 0];
            if (!t.ends[e] && C.fdist(W, f, p[0], p[1], p[0], p[1]) <= TOL) { t.ends[e] = true; t.padOwner[e] = mo; if (rec.parent && rec.item) t.pads[e] = {part:rec.parent.id, number:rec.item.number}; }
          }
        }
      }
    }
    // Follows a track from its pad end through plain joints (exactly one other track of the same net,
    // layer and width ends there, nothing else touches) up to a fixed point, the far end, or MAXCHAIN mm.
    const claimed = new Set();
    function chainFrom(owner0, padEnd, padOwner) {
      const rec0 = W.owners[owner0], it0 = rec0.item, li = C.layerIndex(it0.layer), net = rec0.net, width = it0.width || 0;
      const items = [], pts = [], ends = [], inChain = new Set([owner0, padOwner]);
      let owner = owner0, rev = padEnd === 1, total = 0, rigid = false;
      for (let guard = 0; guard < 512; guard++) {
        const P = W.owners[owner].item.points, Q = rev ? P.slice().reverse() : P;
        for (let i = pts.length ? 1 : 0; i < Q.length; i++) { const q = [Q[i][0], Q[i][1]]; if (pts.length) total += dist(pts[pts.length - 1], q); pts.push(q); }
        items.push({owner, item:W.owners[owner].item, rev}); ends.push(pts.length - 1);
        if (total > MAXCHAIN) break;
        const end = pts[pts.length - 1], cs = contacts(end, li, net, owner).filter(k => !inChain.has(k));
        if (cs.some(k => movingSet.has(k))) { rigid = true; break; }
        if (cs.length !== 1 || W.owners[cs[0]].kind !== "track") break;
        const nk = cs[0], nit = W.owners[nk].item, np = nit.points;
        if (nit.locked || claimed.has(nk) || Math.abs((nit.width || 0) - width) > 1e-9 || nit.layer !== it0.layer || !np || np.length < 2) break;
        const atStart = dist(np[0], end) <= TOL, atEnd = dist(np[np.length - 1], end) <= TOL;
        if (!atStart && !atEnd) break;
        inChain.add(nk); owner = nk; rev = !atStart;
      }
      const n = pts.length, fixed = new Uint8Array(n), cum = new Float64Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + dist(pts[i - 1], pts[i]);
      for (let i = 1; i < n - 1 && !rigid; i++) {
        const cs = contacts(pts[i], li, net, -1).filter(k => !inChain.has(k));
        if (cs.some(k => movingSet.has(k))) rigid = true; else if (cs.length) fixed[i] = 1;
      }
      fixed[n - 1] = 1;
      return {items, pts, ends, cum, fixed, rigid, inChain};
    }
    const conns = [], rigidChains = [], locked = [];
    for (const t of touched.values()) {
      if (claimed.has(t.owner) || !t.ends[0] && !t.ends[1]) continue;
      const rec = W.owners[t.owner], it = rec.item;
      if (it.locked) { locked.push(it.id); claimed.add(t.owner); continue; }
      // Both ends on moving copper: it moves with the parts, unless both are in one pad (a stub inside the pad, whose chain goes on).
      if (t.ends[0] && t.ends[1] && t.padOwner[0] !== t.padOwner[1]) { rigidChains.push({items:[{owner:t.owner, item:it, rev:false}], pts:it.points.map(p => [p[0], p[1]])}); claimed.add(t.owner); continue; }
      const ch = chainFrom(t.owner, t.ends[0] ? 0 : 1, t.padOwner[t.ends[0] ? 0 : 1]);
      for (const x of ch.items) claimed.add(x.owner);
      if (ch.rigid) { for (const x of ch.items) rigidChains.push({items:[x], pts:x.item.points.map(p => [p[0], p[1]])}); continue; }
      const pts = ch.pts;
      const inferred = C.isOctilinear(pts, 0.01) ? (C.isOrthogonal(pts) ? "90" : "45") : looksArc(pts) ? "45arc" : "any";
      const ruleCorner = (() => { try { return rules.corners(it.net || ""); } catch { return {}; } })();
      const corner = cornerPref || ruleCorner.style || inferred, base = C.baseCorner(corner);
      const arcR = C.hasArc(corner) ? (finite(o.arcRadius) ? o.arcRadius : finite(ruleCorner.radius) && ruleCorner.radius > 0 ? ruleCorner.radius : Math.max(0.25, 2.5 * (it.width || 0))) : 0;
      conns.push({id:it.id, owner:t.owner, items:ch.items, pts, ends:ch.ends, cum:ch.cum, fixed:ch.fixed, li:C.layerIndex(it.layer), layer:it.layer, width:it.width || 0, hw:(it.width || 0) / 2,
        net:rec.net, netName:it.net || "", corner, base, arcR, pad:t.pads[t.ends[0] ? 0 : 1], ctx:null, res:null, prio:0, unit:null, live:false, cut:null, start:null});
    }
    // Kill the copper that moves or is replaced; it is re-added, shifted or re-routed, on each plan.
    const killed = [];
    const kill = k => { const r = W.owners[k]; for (let f = r.first, e = f + r.count; f < e; f++) if (!(W.dead[f] & 5)) { W.dead[f] |= 4; killed.push(f); } };
    for (const c of conns) for (const x of c.items) kill(x.owner);
    for (const ch of rigidChains) for (const x of ch.items) kill(x.owner);
    const shiftFeats = [];
    for (const k of moving) { const r = W.owners[k]; for (let f = r.first, e = f + r.count; f < e; f++) if (!(W.dead[f] & 1)) { if (!(W.dead[f] & 4)) { W.dead[f] |= 4; killed.push(f); } shiftFeats.push(f); } }
    const lockedIds = new Set(board.items.filter(i => i.locked).map(i => i.id));

    // Diff pairs: both nets attached to moving pads on one layer route as one coupled ribbon.
    const units = [], DP = globalThis.AtriumDiffPair, paired = new Set();
    if (DP?.find) {
      const byNet = new Map(); for (const c of conns) if (c.netName) (byNet.get(c.netName) || byNet.set(c.netName, []).get(c.netName)).push(c);
      const pairOf = new Map();
      if (conns.length) { let list = []; try { list = pairsCached(board, DP, o.revision); } catch { list = []; } for (const pr of list) { pairOf.set(pr.positive, pr); pairOf.set(pr.negative, pr); } }
      for (const c of conns) {
        if (paired.has(c) || !c.netName) continue;
        const pr = pairOf.get(c.netName) || null;
        if (!pr) continue;
        const other = pr.positive === c.netName ? pr.negative : pr.positive;
        const mate = (byNet.get(other) || []).filter(m => !paired.has(m) && m.layer === c.layer && (!c.pad || !m.pad || m.pad.part === c.pad.part))
          .sort((a, b) => dist(a.pts[0], c.pts[0]) - dist(b.pts[0], c.pts[0]))[0];
        if (!mate || dist(mate.pts[0], c.pts[0]) > 6) continue;
        const pos = pr.positive === c.netName ? c : mate, neg = pos === c ? mate : c;
        let rule = null; try { rule = rules.diffPair(pos.netName, neg.netName, pr.name || "", pos.layer); } catch { rule = null; }
        const w = Math.max(pos.width, neg.width);
        // The user's gap where the pair runs coupled (beyond the pads), else the rule's.
        let measured = Infinity;
        for (let i = 1; i < pos.pts.length; i++) if (pos.cum[i] > 0.3) measured = Math.min(measured, polyDist([pos.pts[i - 1], pos.pts[i]], neg.pts.filter((_, j) => neg.cum[j] > 0.3)) - w);
        const ruleGap = finite(rule?.gap) ? rule.gap : 0.15;
        const gap = finite(measured) && measured > 0.5 * ruleGap && measured < 2.5 * ruleGap ? measured : ruleGap;
        const u = {kind:"pair", conns:[pos, neg], gap, w, minGap:finite(rule?.minGap) ? rule.minGap : gap, name:pr.name || pos.netName, res:null, prio:0, ctx:null};
        pos.unit = neg.unit = u; paired.add(pos); paired.add(neg); units.push(u);
      }
    }
    for (const c of conns) if (!c.unit) { c.unit = {kind:"one", conns:[c], res:null, prio:0}; units.push(c.unit); }
    // Stable live set: pairs, then length-matched nets, then the shortest connections, up to the cap.
    const lengthNets = new Map();   // net -> {target, tolerance, base}
    for (const u of units) u.prio = (u.kind === "pair" ? 0 : 1e6) + Math.max(...u.conns.map(c => cutFor(c, cfg.depth).old));
    units.sort((a, b) => a.prio - b.prio);
    let cap = cfg.cap;
    function assignLive() {
      let n = 0;
      for (const u of units) { u.live = n + u.conns.length <= cap; if (u.live) n += u.conns.length; for (const c of u.conns) c.live = u.live; }
    }
    assignLive();

    // Original positions (for the plan of moved objects, and the bus group re-route).
    const origin = new Map(), trackFrom = new Map();
    for (const k of moving) {
      const rec = W.owners[k], it = rec.parent || rec.item;
      if (!it || origin.has(it.id)) continue;
      origin.set(it.id, finite(it.x) ? [it.x, it.y] : null);
      if (!rec.parent && Array.isArray(it.points)) trackFrom.set(it.id, it.points.map(p => [p[0], p[1]]));
    }
    // Bus ribbons (bus-route.js): its tracks re-route as a group through its API when it offers one.
    const BR = globalThis.AtriumBusRoute, bus = {records:[], conns:new Set()};
    if (BR?.owns) {
      const seen = new Set();
      for (const c of conns) {
        let owned = false; try { owned = BR.owns(c.id); } catch { owned = false; }
        if (!owned) continue;
        bus.conns.add(c);
        const rec = typeof BR.recordOf === "function" ? (() => { try { return BR.recordOf(board, c.id); } catch { return null; } })() : null;
        if (rec && typeof BR.reroutePlan === "function" && !seen.has(rec)) { seen.add(rec); bus.records.push(rec); }
      }
    }
    const setupMs = now() - t0;

    // ---------------------------------------------------------------- planning one offset
    let dx = 0, dy = 0, gen = 0, queue = [], qi = 0, mark = null, last = null, lastPreview = null;
    const shoves = new Map();   // owner -> geometry, accumulated in routing order for this offset
    const order = [];           // units routed for this offset, in order
    function addShifted(f) {
      if (C.addCapsule && C.addPolygon) {
        if (W.kind[f] === 0) C.addCapsule(W, W.own[f], W.ax[f] + dx, W.ay[f] + dy, W.bx[f] + dx, W.by[f] + dy, W.r[f], W.lo[f], W.hi[f], W.net[f]);
        else { const pts = []; for (let i = 0, off = W.poff[f]; i < W.plen[f]; i++) pts.push([W.pv[off + 2 * i] + dx, W.pv[off + 2 * i + 1] + dy]); C.addPolygon(W, W.own[f], pts, W.r[f], W.lo[f], W.hi[f], W.net[f]); }
        return;
      }
      // Without the router's builders: capsules along a polygon's edges give the same clearance distance.
      if (W.kind[f] === 0) { sc.addLine([[W.ax[f] + dx, W.ay[f] + dy], [W.bx[f] + dx, W.by[f] + dy]], W.r[f], W.lo[f], W.hi[f], W.net[f]); return; }
      const pts = []; for (let i = 0, off = W.poff[f]; i < W.plen[f]; i++) pts.push([W.pv[off + 2 * i] + dx, W.pv[off + 2 * i + 1] + dy]);
      pts.push(pts[0]); sc.addLine(pts, W.r[f], W.lo[f], W.hi[f], W.net[f]);
    }
    // Where the re-route ends for this offset: the first fixed vertex, or the point `reach` along.
    function cutFor(c, reach) {
      const P = c.pts, n = P.length;
      for (let i = 1; i < n; i++) {
        if (c.cum[i] >= reach) {
          const L = c.cum[i] - c.cum[i - 1];
          if (c.cum[i] - reach > SPLIT && L > 2 * SPLIT && reach - c.cum[i - 1] > 1e-6) {
            const at = lerp(P[i - 1], P[i], (reach - c.cum[i - 1]) / L);
            return {at, v:-1, next:i, old:reach};
          }
          return {at:P[i], v:i, next:i + 1, old:c.cum[i]};
        }
        if (c.fixed[i]) return {at:P[i], v:i, next:i + 1, old:c.cum[i]};
      }
      return {at:P[n - 1], v:n - 1, next:n, old:c.cum[n - 1]};
    }
    const restOf = c => [c.cut.at, ...c.pts.slice(c.cut.next)];
    function rebuild() {
      sc.reset(); W.n = W.nPersist; W.pn = pn0;
      for (const f of shiftFeats) addShifted(f);
      for (const ch of rigidChains) for (const x of ch.items) sc.addLine(x.item.points.map(p => [p[0] + dx, p[1] + dy]), (x.item.width || 0) / 2, C.layerIndex(x.item.layer), C.layerIndex(x.item.layer), W.owners[x.owner].net);
      for (const c of conns) { const r = restOf(c); if (r.length > 1) sc.addLine(r, c.hw, c.li, c.li, c.net); }
      for (const u of order) for (const c of u.conns) if (c.res?.path && c.res.path.length > 1 && c.res.status !== "rubber") sc.addLine(c.res.path, c.hw, c.li, c.li, c.net);
      for (const [k, g] of shoves) sc.set(k, g);
      sc.dirty = true;
      mark = {n:W.n, pn:W.pn};
    }
    const sceneStale = () => !mark || W.n !== mark.n || W.pn !== mark.pn;
    function plan(delta) {
      dx = finite(delta?.[0]) ? delta[0] : 0; dy = finite(delta?.[1]) ? delta[1] : 0;
      gen++;
      const reach = cfg.depth + 1.5 * Math.hypot(dx, dy);
      for (const c of conns) { c.cut = cutFor(c, reach); c.start = [c.pts[0][0] + dx, c.pts[0][1] + dy]; }
      shoves.clear(); order.length = 0;
      // Staleness first (latest-wins never starves a connection), then the stable priority.
      queue = enabledNow() ? units.filter(u => u.live).sort((a, b) => (a.gen ?? -1) - (b.gen ?? -1) || a.prio - b.prio) : [];
      qi = 0;
      rebuild();
    }

    // ---------------------------------------------------------------- routing
    function ctxFor(c) {
      if (!c.ctx || c.ctx.epoch !== W.hullEpoch) {
        c.ctx = C.makeContext(W, rules, {layer:c.layer, hw:c.hw, net:c.net, netName:c.netName, base:c.base, dirs:{"45":8, "90":4, any:16}[c.base]});
        c.ctx.epoch = W.hullEpoch;
      }
      const ctx = c.ctx; ctx.exempt = new Set(); ctx.endExempt.clear(); ctx.checks = 0;
      return ctx;
    }
    // Two-leg connector variants in the corner style, the one that turns smoothly into the rest first.
    function bends(c, a, b) {
      const rest = restOf(c), next = rest[1];
      const score = bend => { const p = C.connector(a, b, c.base, bend), k = p.length; let s = 0; if (next && k >= 2) { const ang = joinAngle(p[k - 2], p[k - 1], next); if (ang < Math.PI / 2 - 1e-6) s += 10; else if (ang < 3 * Math.PI / 4 - 1e-6) s += 1; } return s + (k - 2) * 0.1; };
      return score(false) <= score(true) ? [false, true] : [true, false];
    }
    // The original escape stub off the pad (its first segment), moved with the part, when it is short.
    function stubOf(c) { const s = stubsOf(c); return s.length ? s[0] : null; }
    // The original escape off the pad, moved with the part: the longest unfixed prefix of the track within
    // 1 mm (an import's piece inside the pad plus its exit, or a fanout stub), then shorter ones.
    function stubsOf(c) {
      const out = [], lim = Math.min(1.0, 0.6 * Math.max(cfg.depth, 0.5));
      let m = 0;
      while (m + 1 < c.pts.length - 1 && m + 2 < c.cut.next && !c.fixed[m + 1] && c.cum[m + 1] <= lim) m++;
      for (let k = m; k >= 1 && out.length < 2; k--) out.push(c.pts.slice(0, k + 1).map(p => [p[0] + dx, p[1] + dy]));
      return out;
    }
    function tryRoute(c, ctx, from, prefix, deadline, final) {
      const a = from, b = c.cut.at;
      ctx.deadline = deadline;
      const [b0, b1] = bends(c, a, b);
      const direct = C.connector(a, b, c.base, b0), direct2 = C.connector(a, b, c.base, b1);
      const clear = p => !C.pathHit(ctx, prefix ? [...prefix, ...p.slice(1)] : p, true);
      let path = null, status = "rubber", pushed = null;
      const shove = p => {
        const before = new Map(sc.mods), full = prefix ? [...prefix, ...p.slice(1)] : p;
        const r = C.shove(null, ctx, [{pts:full, hw:c.hw, net:c.net, net2:-99, lo:c.li, hi:c.li}], {ms:Math.max(0.5, Math.min(final ? 12 : 3, deadline - now())), shoves:final ? 48 : 16, locked:lockedIds});
        if (r.ok) { const m = new Map(); for (const [k, g] of sc.mods) if (before.get(k) !== g) m.set(k, g); return m; }
        rebuild(); return null;
      };
      const walk = () => { const r = C.walkaround(ctx, a, b, b0, {iterations:final ? 48 : 32, budget:final ? 120 : 24}); return r.ok || r.status === "violation" && !final ? r : null; };
      if (routeMode === "ignore") { path = direct; status = clear(direct) ? "routed" : "violation"; }
      else if (clear(direct)) { path = direct; status = "routed"; }
      else if (clear(direct2)) { path = direct2; status = "routed"; }
      else if (routeMode === "stop") { status = "blocked"; }
      else if (routeMode === "push") {
        const m = shove(direct);
        if (m) { path = direct; status = "pushed"; pushed = m; }
        else { const r = walk(); if (r) { path = r.path; status = r.ok ? "routed" : "violation"; } }
      } else if (routeMode === "hug") {
        const r = walk(), detour = r && plen(r.path) > 1.4 * plen(direct) + 0.5;
        if (!r || detour) { const m = shove(direct); if (m) { path = direct; status = "pushed"; pushed = m; } }
        if (!path && r) { path = r.path; status = r.ok ? "routed" : "violation"; }
      } else { const r = walk(); if (r) { path = r.path; status = r.ok ? "routed" : "violation"; } }
      if (path && dist(path[path.length - 1], b) > 1e-6) { path = null; status = "rubber"; pushed = null; }
      // A walk that wanders far around the board is not a re-route: leave the connection open instead.
      if (path && plen(path) > 3 * dist(a, b) + 6) { path = null; status = "rubber"; if (pushed) { rebuild(); pushed = null; } }
      if (path && prefix) path = C.simplify([...prefix, ...path.slice(1)]);
      return {path, status, pushed, timedOut:!path && now() >= deadline};
    }
    function finishPath(c, ctx, path, final) {
      if (final && path.length > 2 && !c.arcR) { ctx.deadline = now() + 6; path = C.optimize(ctx, path, c.base, 200); }
      if (c.arcR && path.length > 2) { const raw = path; path = routeMode === "ignore" ? C.fillet(raw, c.arcR, null) : C.fillet(raw, c.arcR, pts => C.pathClear(ctx, pts)); }
      return path;
    }
    function attempt(c, ctx, deadline, final) {
      let r = null;
      for (const stub of stubsOf(c)) {
        if (r?.path || now() >= deadline) break;
        if (!C.pathHit(ctx, stub, true)) r = tryRoute(c, ctx, stub[stub.length - 1], stub, deadline, final);
      }
      if (!r?.path && now() < deadline) r = tryRoute(c, ctx, c.start, null, deadline, final);
      if (!r) r = {path:null, status:"rubber", timedOut:true};
      return r;
    }
    function routeOne(c, ms, final) {
      const ctx = ctxFor(c), deadline = now() + ms;
      let r = attempt(c, ctx, deadline, final);
      // Blocked at this depth: re-route further back, to the first fixed point (more room to move in).
      if (!r.path && !r.timedOut) {
        const deeper = cutFor(c, Infinity);
        if (now() < deadline - 0.2 && (deeper.next > c.cut.next || deeper.v > c.cut.v && c.cut.v >= 0)) { c.cut = deeper; r = attempt(c, ctx, deadline, final); }
      }
      if (r.timedOut && !final) return false;
      if (r.path) {
        r.path = finishPath(c, ctx, r.path, final);
        if (r.pushed) for (const [k, g] of r.pushed) shoves.set(k, g);
        sc.addLine(r.path, c.hw, c.li, c.li, c.net);
        mark = {n:W.n, pn:W.pn};
      }
      c.res = {gen, path:r.path, status:r.path ? r.status : r.status === "blocked" ? "blocked" : "rubber", pushed:r.pushed};
      return true;
    }
    // A diff pair: the centreline is walked as one ribbon (half width = gap/2 + width), then offset to
    // each side; the short gathers to the pads and anchors are checked exactly, net by net.
    function routePair(u, ms, final) {
      const [p, n] = u.conns, deadline = now() + ms, d = (u.gap + u.w) / 2;
      if (!u.ctx || u.ctx.epoch !== W.hullEpoch) {
        u.ctx = C.makeContext(W, rules, {layer:p.layer, hw:d + u.w / 2, net:p.net, net2:n.net, netName:p.netName, net2Name:n.netName, base:p.base, dirs:{"45":8, "90":4, any:16}[p.base]});
        u.ctx.epoch = W.hullEpoch;
      }
      const cx = u.ctx, cP = ctxFor(p), cN = ctxFor(n);
      const clr = (() => { try { return rules.clearance(p.netName, n.netName, p.layer); } catch { return 0.15; } })();
      const off = DP?.offset || (pts => pts);
      // From the escape stubs when both pads have one (the ribbon starts clear of the pad row), else from the pads.
      const stubs = [stubOf(p), stubOf(n)], tries = stubs[0] && stubs[1] ? [stubs, [null, null]] : [[null, null]];
      let ok = false, pathP = null, pathN = null;
      for (const [sp, sn] of tries) {
        if (ok || now() >= deadline && !final) break;
        const a = sp ? sp[1] : p.start, b = sn ? sn[1] : n.start, sm0 = mid(a, b), am = mid(p.cut.at, n.cut.at);
        // The ribbon leaves straight along the escape direction for a moment, so both offsets start beside their pads.
        const u1 = unit(p.pts[0], p.pts[1]), u2 = unit(n.pts[0], n.pts[1]), ux = u1 && u2 ? [(u1[0] + u2[0]) / 2, (u1[1] + u2[1]) / 2] : null, ul = ux ? Math.hypot(ux[0], ux[1]) : 0;
        const sm = ul > .5 ? [sm0[0] + ux[0] / ul * 2 * d, sm0[1] + ux[1] / ul * 2 * d] : sm0;
        cx.exempt = new Set(); cx.endExempt.clear(); cx.deadline = deadline;
        let centre = null;
        const direct = C.connector(sm, am, p.base, false);
        if (routeMode === "ignore" || !C.pathHit(cx, direct, false)) centre = direct;
        else if (routeMode !== "stop") { const r = C.walkaround(cx, sm, am, false, {iterations:final ? 48 : 32, budget:final ? 120 : 24}); if ((r.ok || r.status === "violation") && dist(r.path[r.path.length - 1], am) < 1e-6) centre = r.path; }
        if (!centre) continue;
        if (final && centre.length > 2) { cx.deadline = now() + 6; centre = C.optimize(cx, centre, p.base, 200); }
        if (sm !== sm0) centre = C.simplify([sm0, ...centre]);
        if (p.arcR && centre.length > 2) centre = C.fillet(centre, p.arcR + d, pts => C.pathClear(cx, pts));
        const A = off(centre, d), B = off(centre, -d);
        const flip = dist(A[0], a) + dist(B[0], b) > dist(B[0], a) + dist(A[0], b);
        const LP = flip ? B : A, LN = flip ? A : B;
        pathP = C.simplify([...(sp || [p.start]), ...LP, p.cut.at]); pathN = C.simplify([...(sn || [n.start]), ...LN, n.cut.at]);
        ok = routeMode === "ignore" || (!C.pathHit(cP, pathP, true) && !C.pathHit(cN, pathN, true) && polyDist(pathP, pathN) - u.w >= clr - 1e-6);
      }
      if (!ok) {
        if (now() >= deadline && !final) return false;
        // Uncoupled fallback: each net on its own.
        routeOne(p, Math.max(0.3, deadline - now()), final); routeOne(n, Math.max(0.3, deadline - now()), final);
        u.coupled = false; u.res = {gen}; return true;
      }
      sc.addLine(pathP, p.hw, p.li, p.li, p.net); sc.addLine(pathN, n.hw, n.li, n.li, n.net);
      mark = {n:W.n, pn:W.pn};
      p.res = {gen, path:pathP, status:"routed", coupled:true}; n.res = {gen, path:pathN, status:"routed", coupled:true};
      u.coupled = true; u.res = {gen};
      return true;
    }
    function routeUnit(u, ms, final) {
      const ok = u.kind === "pair" ? routePair(u, ms, final) : routeOne(u.conns[0], ms, final);
      if (ok) { u.gen = gen; order.push(u); }
      return ok;
    }
    // Spends up to `ms` on the queue for the current offset. Returns whether anything changed.
    let retry = null;
    function advance(ms) {
      const end = now() + ms;
      let did = false;
      if (sceneStale()) rebuild();
      while (qi < queue.length) {
        const left = end - now();
        if (left <= 0.05 && did) break;
        const u = queue[qi];
        const give = Math.max(0.2, left);
        if (!routeUnit(u, give, false)) { if (retry === u) { for (const c of u.conns) c.res = {gen, path:null, status:"rubber"}; u.gen = gen; qi++; retry = null; did = true; continue; } retry = u; break; }
        retry = null; qi++; did = true;
      }
      return did;
    }
    const pending = () => qi < queue.length;

    // ---------------------------------------------------------------- live lengths (idle, cancellable)
    function lengthJob() {
      if (!alive || typeof o.lengths === "boolean" && !o.lengths) return;
      // Only boards with length constraints pay for this (and never inside a frame: idle slices only).
      if (o.lengths !== true && !hasLengthRules(board)) return;
      const L = globalThis.AtriumLength;
      const nets = [...new Set(conns.map(c => c.netName).filter(Boolean))];
      if (!nets.length) return;
      const cache = lengthCache.get(board), fresh = cache && o.revision != null && cache.revision === o.revision;
      if (fresh) { for (const n of nets) if (cache.map.has(n)) { const v = cache.map.get(n); if (v) lengthNets.set(n, v); } if (nets.every(n => cache.map.has(n))) return; }
      const store = fresh ? cache.map : new Map();
      if (o.revision != null) lengthCache.set(board, {revision:o.revision, map:store});
      if (!L?.targetFor) { const p = globalThis.AtriumLazy?.need?.("AtriumLength"); if (p?.then) p.then(() => { if (alive) idle(lengthJob); }, () => {}); return; }
      let i = 0;
      const step = deadline => {
        while (alive && i < nets.length && deadline() > 1) {
          const net = nets[i++];
          try {
            const t0 = store.has(net) ? null : L.targetFor(board, defs, net);
            let v = null;
            if (store.has(net)) v = store.get(net);
            else if (t0 && finite(t0.target)) { const m = (L.matchLength || L.netLength)(board, defs, net); if (m && finite(m.length)) v = {target:t0.target, tolerance:finite(t0.tolerance) ? t0.tolerance : 0.1, base:m.length}; }
            store.set(net, v);
            if (v) lengthNets.set(net, v);
          } catch { store.set(net, null); }
        }
        if (alive && i < nets.length) idle(step); else if (alive && lengthNets.size) emit();
      };
      idle(step);
    }
    const syncLengths = typeof o.lengths === "boolean" ? o.lengths : false;
    function idle(fn) {
      if (syncLengths || typeof requestIdleCallback !== "function" && typeof setTimeout !== "function") { fn(() => Infinity); return; }
      if (typeof requestIdleCallback === "function") requestIdleCallback(d => fn(() => d.timeRemaining()), {timeout:400});
      else setTimeout(() => { const t = now() + 6; fn(() => t - now()); }, 16);
    }

    // ---------------------------------------------------------------- scheduling (time slices, latest wins)
    // The routing share of a frame adapts to the render: the first slice after a frame's rAF phase sees how
    // long the render took (rAF to the next task), and routing keeps the frame inside one 120 Hz period.
    let frameSpent = 0, tickArmed = false, contArmed = false, tickAt = 0, renderEst = 0;
    const FRAME = 8.3, budget = () => Math.max(0.5, Math.min(cfg.frameMs, FRAME - 1.5 - renderEst));
    const hasFrames = typeof requestAnimationFrame === "function" && o.sync !== true;
    const chan = hasFrames && typeof MessageChannel === "function" ? new MessageChannel() : null;
    if (chan) chan.port1.onmessage = () => cont();
    function armTick() {
      if (tickArmed || !hasFrames) return;
      tickArmed = true;
      requestAnimationFrame(() => { tickArmed = false; frameSpent = 0; tickAt = now(); if (alive && pending()) post(); });
    }
    function post() { if (contArmed || !hasFrames) return; contArmed = true; if (chan) chan.port2.postMessage(0); else setTimeout(cont, 0); }
    function cont() {
      contArmed = false;
      if (tickAt) { renderEst = 0.7 * renderEst + 0.3 * Math.min(20, now() - tickAt); tickAt = 0; }
      if (!alive || !pending()) return;
      const left = budget() - frameSpent;
      if (left < 0.3) { armTick(); return; }
      const t = now(), did = advance(left);
      const sms = now() - t; frameSpent += sms; stats.slices++; stats.sliceMax = Math.max(stats.sliceMax, sms);
      if (probe) try { probe(t, sms); } catch { /* measurement only */ }
      if (did) emit();
      if (pending()) { if (frameSpent < budget() - 0.3) post(); else armTick(); }
    }
    const stats = {moves:0, slices:0, sliceMax:0, moveMax:0};
    function emit() { lastPreview = null; if (typeof o.onUpdate === "function") { try { o.onUpdate(preview()); } catch (e) { globalThis.console?.error?.(e); } } }

    // ---------------------------------------------------------------- results
    function headOf(c, final) {
      const r = c.res;
      if (!enabledNow() && !final) return null;
      if (r && r.gen === gen && r.path) return {path:r.path, status:r.status};
      // Routed for an earlier offset: shown from the new pad position until it is re-planned.
      if (r?.path && c.live && !final) return {path:C.simplify([c.start, ...r.path.slice(1)]), status:"stale"};
      return null;
    }
    function preview() {
      if (lastPreview) return lastPreview;
      const pushed = [], hidden = [], airwires = [];
      let routed = 0, rubber = 0, bad = 0, stale = 0, uncoupled = 0;
      const on = enabledNow();
      for (const c of conns) {
        for (const x of c.items) hidden.push(x.item.id);
        const rest = restOf(c), h = headOf(c, false);
        if (!on) {
          // Off (or Shift not held): the pad end stretches, as it will be committed.
          const pts = C.simplify([c.start, ...c.pts.slice(1)]);
          pushed.push({id:c.id, kind:"track", points:pts, width:c.width, layer:c.layer, net:c.netName, status:"rubber"});
          rubber++; continue;
        }
        if (h) {
          pushed.push({id:c.id, kind:"track", points:C.simplify([...h.path, ...rest.slice(1)]), width:c.width, layer:c.layer, net:c.netName, status:h.status});
          if (h.status === "stale") stale++; else routed++;
          if (h.status === "violation") bad++;
          if (c.unit.kind === "pair" && c.unit.coupled === false && c.unit.gen === gen) uncoupled++;
        } else {
          if (rest.length > 1) pushed.push({id:c.id, kind:"track", points:rest, width:c.width, layer:c.layer, net:c.netName, status:"rest"});
          airwires.push({from:c.start, to:c.cut.at, net:c.netName, live:c.live});
          rubber++;
        }
      }
      for (const ch of rigidChains) for (const x of ch.items) {
        pushed.push({id:x.item.id, kind:"track", points:x.item.points.map(p => [p[0] + dx, p[1] + dy]), width:x.item.width, layer:x.item.layer, net:x.item.net || "", status:"rigid"});
        hidden.push(x.item.id);
      }
      for (const [k, g] of shoves) {
        const it = W.owners[k].item;
        if (g.kind === "track") pushed.push({id:it.id, kind:"track", points:g.points, width:g.width, layer:g.layer, net:it.net || "", status:"shoved"});
        else pushed.push({id:it.id, kind:"via", x:g.x, y:g.y, diameter:g.diameter, drill:it.drill, net:it.net || "", status:"shoved"});
        hidden.push(it.id);
      }
      const labels = lengthLabels(false);
      const status = bad ? "violation" : on && (rubber || stale) ? "partial" : "ok";
      const parts = [];
      if (!on) parts.push(cfg.mode === "shift" ? "hold Shift to re-route" : "re-route off");
      if (routed) parts.push(routed + " re-routed");
      if (stale) parts.push(stale + " updating");
      if (on && rubber) parts.push(rubber + " as connection lines" + (units.some(u => !u.live) ? " (live limit " + cap + "; routed on drop)" : ""));
      if (rigidChains.length) parts.push(rigidChains.length + " moved with parts");
      if (locked.length) parts.push(locked.length + " locked");
      if (shoves.size) parts.push(shoves.size + " shoved");
      if (bad) parts.push(bad + " with violations");
      if (uncoupled) parts.push(uncoupled + " pair nets uncoupled");
      lastPreview = {preview:[], pushed, hidden, vias:[], airwires, labels, status, mode:"drag", modeName:"Drag re-route",
        statusName:status === "ok" ? "Re-routed" : status === "partial" ? "Re-routing" : "Violation",
        statusText:conns.length || rigidChains.length ? "Drag re-route · " + parts.join(" · ") : "",
        routed, rubber, stale, rigid:rigidChains.length, locked:locked.slice(), connections:conns.length, live:conns.filter(c => c.live).length,
        pending:pending(), shoved:shoves.size, gen, ms:last?.ms || 0, setupMs, enabled:on, delta:[dx, dy], box:box()};
      return lastPreview;
    }
    function lengthLabels(final) {
      if (!lengthNets.size) return [];
      const out = [];
      for (const c of conns) {
        const L = lengthNets.get(c.netName); if (!L) continue;
        const h = headOf(c, final), cut = c.cut;
        const now2 = h ? plen(h.path) : enabledNow() ? dist(c.start, cut.at) : plen(C.simplify([c.start, ...c.pts.slice(1, cut.next)]).concat([cut.at]));
        const length = L.base - cut.old + now2, delta = length - L.target, tol = L.tolerance;
        out.push({net:c.netName, length, target:L.target, delta, tolerance:tol, band:Math.abs(delta) <= tol ? "ok" : Math.abs(delta) <= 2 * tol ? "close" : "out", approx:!h || h.status === "stale"});
      }
      return out;
    }
    function box() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const f of shiftFeats) { x0 = Math.min(x0, W.x0[f] + dx); y0 = Math.min(y0, W.y0[f] + dy); x1 = Math.max(x1, W.x1[f] + dx); y1 = Math.max(y1, W.y1[f] + dy); }
      return x0 <= x1 ? [x0, y0, x1, y1] : null;
    }

    // ---------------------------------------------------------------- public
    function move(delta) {
      if (!alive) throw Error("This drag session has ended.");
      const nx = finite(delta?.[0]) ? delta[0] : 0, ny = finite(delta?.[1]) ? delta[1] : 0;
      if (last && last.dx === nx && last.dy === ny && last.on === enabledNow()) return preview();
      const t1 = now();
      plan([nx, ny]);
      if (!hasFrames) frameSpent = 0;
      // In the browser the pointer handler only re-plans (cheap); routing runs in the slices that follow,
      // sized to what the frame has left. Without frames (headless, tests) the move routes its own slice.
      if (!hasFrames) advance(Math.max(0.5, budget() - frameSpent));
      const ms = now() - t1;
      frameSpent += ms; stats.moves++; stats.moveMax = Math.max(stats.moveMax, ms);
      last = {dx:nx, dy:ny, ms, on:enabledNow()};
      lastPreview = null;
      if (pending()) post();
      armTick();
      return preview();
    }
    function flush() {
      if (!alive) throw Error("This drag session has ended.");
      if (!last) move([0, 0]);
      while (pending()) advance(1e3);
      if (syncLengths && !lengthNets.size) lengthJob();
      lastPreview = null;
      return preview();
    }
    // The bus group's own re-route from the moved pads, when bus-route.js offers one.
    function busPlans() {
      const out = [];
      if (!bus.records.length) return out;
      const moved = {...board, items:board.items.map(i => origin.has(i.id) && origin.get(i.id) ? {...i, x:origin.get(i.id)[0] + dx, y:origin.get(i.id)[1] + dy} : i)};
      for (const rec of bus.records) {
        try { const r = BR.reroutePlan(moved, defs, rec); if (r?.r?.plan) out.push({rec, add:r.r.plan.add || [], modify:r.r.plan.modify || [], remove:r.remove || rec.ids || []}); } catch { /* the members re-route one by one */ }
      }
      return out;
    }
    function commit(delta) {
      if (!alive) throw Error("This drag session has ended.");
      if (delta) { dx = finite(delta[0]) ? delta[0] : 0; dy = finite(delta[1]) ? delta[1] : 0; } else if (last) { dx = last.dx; dy = last.dy; }
      const t1 = now(), on = enabledNow(), buses = on ? busPlans() : [];
      const busIds = new Set(buses.flatMap(b => b.remove));
      // Everything, the over-cap connections included, for the final offset; then a quick gloss.
      plan([dx, dy]);
      if (on) {
        const all = units.filter(u => !u.conns.every(c => busIds.has(c.id))).sort((a, b) => a.prio - b.prio);
        // The drop's own budget: the first pass shares DROP_MS, a second pass gets what is left of 1.5x.
        const stop = t1 + DROP_MS, share = (end, i, n) => Math.max(0.6, Math.min(8, 2 * (end - now()) / Math.max(1, n - i)));
        all.forEach((u, i) => routeUnit(u, share(stop, i, all.length), true));
        // Blocked ones first in a second pass (they often fit when routed before their neighbours).
        const failed = all.filter(u => u.conns.some(c => !c.res?.path));
        if (failed.length && failed.length < all.length && now() < t1 + DROP_MS) {
          const keep = new Map(conns.map(c => [c, {res:c.res, cut:c.cut}])), keepShoves = new Map(shoves);
          plan([dx, dy]);
          const again = [...failed, ...all.filter(u => !failed.includes(u))];
          again.forEach((u, i) => routeUnit(u, share(t1 + 1.5 * DROP_MS, i, again.length), true));
          const miss = all.filter(u => u.conns.some(c => !c.res?.path)).length;
          if (miss >= failed.length) {
            // Not better: keep the first pass.
            for (const [c, v] of keep) { c.res = v.res; c.cut = v.cut; }
            shoves.clear(); for (const [k, g] of keepShoves) shoves.set(k, g);
            gen = Math.max(...conns.map(c => c.res?.gen ?? 0));
          }
        }
      }
      const modify = [], remove = [], add = [];
      const r6 = v => C.round6(v), pts6 = pts => pts.map(p => [r6(p[0]), r6(p[1])]);
      let routed = 0, rubber = 0, bad = 0, unrouted = 0;
      const orient = (x, pts) => x.rev ? pts.slice().reverse() : pts;
      for (const c of conns) {
        if (busIds.has(c.id)) continue;
        const h = on && c.res?.gen === gen && c.res.path ? c.res : null;
        if (!on) {
          // Re-route off: the pad end follows the pad (the rubber band), and nothing else changes.
          const P = c.items[0].item.points.map(p => [p[0], p[1]]), e = c.items[0].rev ? P.length - 1 : 0;
          P[e] = [P[e][0] + dx, P[e][1] + dy];
          modify.push({id:c.id, points:pts6(C.simplify(P))}); rubber++; continue;
        }
        if (h && h.status === "violation") bad++;
        // The anchor's piece j: pieces before it are replaced, its part beyond the anchor and every
        // piece after it keep their ids and points. A connection that found no clear route is cut
        // back to its anchor instead (an open that the connection lines show, never a short).
        const v = c.cut.v >= 0 ? c.cut.v : c.cut.next;
        let j = 0; while (j < c.ends.length - 1 && c.ends[j] < v) j++;
        const atEnd = c.cut.v >= 0 && c.cut.v === c.ends[j];
        const tail = C.simplify([c.cut.at, ...c.pts.slice(c.cut.next, c.ends[j] + 1)]);
        const head = h ? h.path : null;
        if (h) routed++; else unrouted++;
        if (atEnd || j === 0) {
          const P = head ? C.simplify([...head, ...(atEnd ? [] : tail.slice(1))]) : atEnd ? null : tail;
          if (P && P.length >= 2) modify.push({id:c.id, points:pts6(orient(c.items[0], P))}); else remove.push(c.id);
          for (let k = 1; k <= j; k++) remove.push(c.items[k].item.id);
        } else {
          if (head) modify.push({id:c.id, points:pts6(orient(c.items[0], head))}); else remove.push(c.id);
          for (let k = 1; k < j; k++) remove.push(c.items[k].item.id);
          if (tail.length >= 2) modify.push({id:c.items[j].item.id, points:pts6(orient(c.items[j], tail))}); else remove.push(c.items[j].item.id);
        }
      }
      // Copper between two moving pads moves with them; where that lands on other copper it is walked
      // around between its moved ends instead (or kept, and counted, when no clear walk exists).
      for (const ch of rigidChains) for (const x of ch.items) {
        let P = x.item.points.map(p => [p[0] + dx, p[1] + dy]);
        if (on && P.length >= 2 && (dx || dy)) {
          const rec = W.owners[x.owner], base = C.isOctilinear(P, 0.01) ? (C.isOrthogonal(P) ? "90" : "45") : "any";
          const ctx = C.makeContext(W, rules, {layer:x.item.layer, hw:(x.item.width || 0) / 2, net:rec.net, netName:x.item.net || "", base, dirs:{"45":8, "90":4, any:16}[base]});
          if (C.pathHit(ctx, P, true)) {
            ctx.deadline = now() + 6;
            const r = C.walkaround(ctx, P[0], P[P.length - 1], false, {iterations:48, budget:120});
            if (r.ok && dist(r.path[r.path.length - 1], P[P.length - 1]) < 1e-6 && plen(r.path) <= 3 * dist(P[0], P[P.length - 1]) + 6) P = r.path; else bad++;
          }
        }
        modify.push({id:x.item.id, points:pts6(P)});
      }
      for (const [k, g] of shoves) {
        const it = W.owners[k].item;
        if (g.kind === "track") modify.push({id:it.id, points:pts6(g.points)}); else modify.push({id:it.id, x:r6(g.x), y:r6(g.y)});
      }
      for (const b of buses) { remove.push(...b.remove.filter(id => board.items.some(i => i.id === id))); add.push(...b.add); modify.push(...b.modify); }
      // The moved objects, so the plan also stands on its own (headless use).
      for (const [id, at] of origin) {
        if (at) modify.push({id, x:r6(at[0] + dx), y:r6(at[1] + dy)});
        else if (trackFrom.has(id)) modify.push({id, points:pts6(trackFrom.get(id).map(p => [p[0] + dx, p[1] + dy]))});
      }
      const labels = lengthLabels(true), ms = now() - t1, out = preview();
      finish();
      const pairs = units.filter(u => u.kind === "pair");
      return {add, remove:[...new Set(remove)], modify, routed, rubber, rigid:rigidChains.length, shoved:shoves.size, status:bad ? "violation" : unrouted ? "partial" : "ok", violations:bad, unrouted,
        rigidIds:rigidChains.flatMap(ch => ch.items.map(x => x.item.id)), coupled:pairs.filter(u => u.coupled).length, pairs:pairs.length, buses:buses.length, labels, ms, glossed:on, ids:conns.map(c => c.id), statusText:out.statusText,
        message:on ? "Re-routed " + routed + " connection" + (routed === 1 ? "" : "s") + (unrouted ? " · " + unrouted + " left as connection lines (no clear route)" : "") + (shoves.size ? " · " + shoves.size + " shoved" : "") + (bad ? " · " + bad + " with violations" : "") : "Moved; tracks stretched (re-route off)"};
    }
    function finish() {
      if (!alive) return;
      alive = false; sc.reset(); W.n = W.nPersist; W.pn = pn0;
      for (const f of killed) W.dead[f] &= ~4;
      queue = []; qi = 0;
      if (chan) {
        chan.port1.onmessage = null;
        chan.port1.close(); chan.port2.close();
      }
      unlisten();
      if (current === api) current = null;
    }
    // Shift for "On with Shift": tracked on the window while the session lives.
    let unlisten = () => {};
    if (typeof addEventListener === "function" && cfg.mode === "shift") {
      const key = e => { if (e.key === "Shift") setShift(e.type === "keydown"); };
      const ptr = e => { if (typeof e.shiftKey === "boolean" && e.shiftKey !== shiftHeld) setShift(e.shiftKey); };
      addEventListener("keydown", key, true); addEventListener("keyup", key, true); addEventListener("pointermove", ptr, true);
      unlisten = () => { removeEventListener("keydown", key, true); removeEventListener("keyup", key, true); removeEventListener("pointermove", ptr, true); };
    }
    function setShift(v) {
      v = !!v; if (v === shiftHeld) return shiftHeld;
      shiftHeld = v;
      if (alive && last) { const d = [last.dx, last.dy]; last = null; move(d); emit(); }
      return shiftHeld;
    }
    const api = {
      get state() { return {enabled:enabledNow(), mode:cfg.mode, maxConnections:cap, cap, depth:cfg.depth, frameMs:cfg.frameMs, routeMode, connections:conns.length, live:conns.filter(c => c.live).length,
        rigid:rigidChains.length, locked:locked.length, pairs:units.filter(u => u.kind === "pair").length, buses:bus.records.length, busTracks:bus.conns.size, pending:alive && pending(), stats:{...stats}, setupMs}; },
      move, flush, commit, setShift,
      preview:() => preview(),
      setEnabled(v) { cfg.mode = v ? (cfg.mode === "off" ? "on" : cfg.mode) : "off"; last = null; lastPreview = null; return enabledNow(); },
      setMaxConnections(n) { if (finite(n) && n >= 0) { cap = n | 0; assignLive(); last = null; lastPreview = null; } return cap; },
      cancel() { finish(); last = null; },
      // The parts changed footprint mid-drag (flipped): start again on the new geometry at the same offset.
      restart(board2 = board, defs2 = defs) {
        const delta = last ? [last.dx, last.dy] : [0, 0];
        finish();
        const next = dragSession(board2, defs2, [...ids], {...o, world:undefined, revision:undefined, cap, dragMode:cfg.mode, shift:shiftHeld});
        for (const k of ["move", "flush", "commit", "cancel", "restart", "setShift", "setEnabled", "setMaxConnections", "preview"]) api[k] = next[k];
        Object.defineProperty(api, "state", {get:() => next.state, configurable:true, enumerable:true});
        api.world = next.world;
        return next.move(delta);
      },
      lengthLabels:() => lengthLabels(false),
      get alive() { return alive; },
      world:W
    };
    current = api;
    lengthJob();
    return api;
  }

  // ------------------------------------------------------------------ canvas overlay
  // Connection lines for connections not (yet) re-routed, and the live length labels beside the parts.
  const anim = new Map();   // net -> {shown, value, t}
  let themeCache = null, themeT = 0;
  function theme() {
    const t = now();
    if (themeCache && t - themeT < 2000) return themeCache;
    const fb = {ok:"#3fb950", close:"#d29922", out:"#f85149", panel:"rgba(24,24,28,.86)", ink:"#e6e6e6", wire:"#b4b4b4"};
    try {
      const cs = getComputedStyle(document.documentElement), v = (n, d) => cs.getPropertyValue(n).trim() || d;
      themeCache = {ok:v("--success", fb.ok), close:v("--warning", fb.close), out:v("--error", fb.out), panel:v("--overlay", fb.panel), ink:v("--text", fb.ink),
        wire:globalThis.AtriumPCBAppearance?.system?.connection || fb.wire};
    } catch { themeCache = fb; }
    themeT = t; return themeCache;
  }
  const motionLevel = () => { try { return globalThis.AtriumMotion?.level?.() || {off: "off", reduce: "reduced", full: "full"}[globalThis.document?.documentElement?.getAttribute?.("data-motion")] || (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "reduced" : "full"); } catch { return "full"; } };
  function draw(ctx, env, pv) {
    const T = theme(), scale = env.scale || 1;
    if (pv.airwires?.length) {
      ctx.save(); ctx.strokeStyle = T.wire; ctx.lineWidth = 1 / scale; ctx.lineCap = "butt"; ctx.globalAlpha = .9;
      ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.beginPath();
      for (const w of pv.airwires) { ctx.moveTo(w.from[0], w.from[1]); ctx.lineTo(w.to[0], w.to[1]); }
      ctx.stroke(); ctx.restore();
    }
    const labels = pv.labels || [];
    if (!labels.length || !pv.box) { anim.clear(); return; }
    // Labels: a small stack above and right of the parts, in screen space; values ease toward the
    // live Δ and each label fades in. Reduced or Off motion shows the value at once.
    const t = now(), level = motionLevel(), m = ctx.getTransform(), dpr = env.dpr || 1;
    const sx = (m.a * pv.box[2] + m.c * pv.box[1] + m.e) / dpr, sy = (m.b * pv.box[2] + m.d * pv.box[1] + m.f) / dpr;
    const rows = labels.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)), shown = rows.slice(0, 6);
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    const cw = ctx.canvas.width / dpr, ch = ctx.canvas.height / dpr, H = 17, Wd = 150;
    let x = sx + 14, y = sy - 10 - H * shown.length;
    if (x + Wd > cw - 4) x = Math.max(4, sx - Wd - 14 - (pv.box[2] - pv.box[0]) * scale);
    if (y < 4) y = Math.min(ch - H * shown.length - 4, sy + 10);
    let busy = false;
    const keep = new Set();
    shown.forEach((l, i) => {
      keep.add(l.net);
      let a = anim.get(l.net);
      if (!a) anim.set(l.net, a = {value:l.delta, t0:t, t});
      const dt = Math.min(64, t - a.t); a.t = t;
      if (level === "full") { const k = 1 - Math.exp(-dt / 70); a.value += (l.delta - a.value) * k; if (Math.abs(a.value - l.delta) > 1e-3) busy = true; } else a.value = l.delta;
      const fade = level === "off" ? 1 : Math.min(1, (t - a.t0) / 140); if (fade < 1) busy = true;
      const yy = y + i * H;
      ctx.globalAlpha = .9 * fade; ctx.fillStyle = T.panel;
      const r = 4; ctx.beginPath(); ctx.moveTo(x + r, yy); ctx.arcTo(x + Wd, yy, x + Wd, yy + H - 2, r); ctx.arcTo(x + Wd, yy + H - 2, x, yy + H - 2, r); ctx.arcTo(x, yy + H - 2, x, yy, r); ctx.arcTo(x, yy, x + Wd, yy, r); ctx.fill();
      // Band mark, shaped as in the bus readout (square in band, triangle close, cross out) so colour is not the only cue.
      ctx.globalAlpha = fade; ctx.fillStyle = ctx.strokeStyle = T[l.band] || T.ok; ctx.lineWidth = 1.6;
      const mx = x + 3, my = yy + (H - 2) / 2 - 3.5;
      if (l.band === "close") { ctx.beginPath(); ctx.moveTo(mx, my + 7); ctx.lineTo(mx + 3.5, my); ctx.lineTo(mx + 7, my + 7); ctx.closePath(); ctx.fill(); }
      else if (l.band === "out") { ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + 7, my + 7); ctx.moveTo(mx + 7, my); ctx.lineTo(mx, my + 7); ctx.stroke(); }
      else ctx.fillRect(mx, my, 7, 7);
      ctx.fillStyle = T.ink;
      const name = l.net.length > 10 ? l.net.slice(0, 9) + "…" : l.net, v = a.value;
      ctx.fillText(name, x + 11, yy + (H - 2) / 2);
      ctx.fillStyle = T[l.band] || T.ok; ctx.textAlign = "right";
      ctx.fillText((l.approx ? "≈" : "") + (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2) + " mm", x + Wd - 6, yy + (H - 2) / 2);
      ctx.textAlign = "left";
    });
    if (rows.length > shown.length) { ctx.globalAlpha = .8; ctx.fillStyle = T.ink; ctx.fillText("+" + (rows.length - shown.length) + " more matched nets", x + 4, y + shown.length * H + 6); }
    ctx.restore();
    for (const k of anim.keys()) if (!keep.has(k)) anim.delete(k);
    if (busy && env.redraw) env.redraw();
  }
  let host = null, raf = 0;
  function attach(h) {
    host = h;
    if (!h?.addRenderer) return;
    h.addRenderer((d, info) => {
      if (!info?.active || d?.kind !== "pcb" || !current?.alive) return null;
      const pv = current.preview();
      if (!pv.airwires?.length && !pv.labels?.length) return null;
      return {overlay:(ctx, env) => draw(ctx, {...env, redraw:() => { if (raf || typeof requestAnimationFrame !== "function") return; raf = requestAnimationFrame(() => { raf = 0; if (current?.alive) h.redrawOverlay?.(); }); }}, pv)};
    });
    // A pointer down or Move Selection is actual drag intent. Cancel the warm-up as
    // soon as the gesture, board, visibility or power mode changes.
    let ticket = null;
    const power = globalThis.AtriumPower, idle = globalThis.AtriumIdle;
    const active = () => power?.visible?.() !== false && !power?.efficient?.();
    function stop() {
      if (ticket == null) return;
      if (idle) idle.cancel(ticket);
      else if (globalThis.cancelIdleCallback) cancelIdleCallback(ticket);
      else clearTimeout(ticket);
      ticket = null;
    }
    h.on?.("move-intent", drag => {
      stop();
      const d = h.doc?.(), rev = h.revision?.();
      if (!active() || d?.kind !== "pcb" || !["part","pad","via"].includes(drag.item.kind)) return;
      const run = () => {
        ticket = null;
        if (active() && h.doc?.() === d && h.revision?.() === rev && h.drag?.() === drag && !drag.before)
          globalThis.AtriumRouter?.world(d,h.defs(),{revision:rev,project:h.project?.()});
      };
      ticket = idle ? idle.idle(run,{timeout:600}) : globalThis.requestIdleCallback ? requestIdleCallback(run,{timeout:600}) : setTimeout(run,50);
    });
    for (const event of ["move-end","change","replace","document"]) h.on?.(event,stop);
    power?.onChange?.(() => { if (!active()) stop(); });
  }
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({dragSession, settings, MODES:MODES.slice(), MODE_NAMES, DEFAULTS, draw, attach, get probe() { return probe; }, set probe(f) { probe = typeof f === "function" ? f : null; }});
})();
