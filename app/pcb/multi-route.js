"use strict";
// Interactive Multi-Routing, first version (MCP multi_route; the editor action route-multi now opens Interactive Bus Routing). Lazy: app/lazy.js
// loads it as a dependency of the bus router (bus-route.js).
//
//   AtriumMultiRoute.plan(board, defs, o) -> {ok, plan:{add, remove, modify}, members, width, gap, pitch, order, ms}
//     o.starts  [{at:[x,y], net, layer}]  two to 32 start points (pads, track ends or vias), one per net
//     o.to      [x,y]  where the middle of the bus ends; the ends fan out across it at the pitch, or
//     o.ends    [[x,y], ...]  one end per start, in the same order
//     o.layer   copper layer (default: the first start's layer, else Top)
//     o.width   track width (default: the widest preferred width of the members' nets)
//     o.gap     edge-to-edge gap between neighbours (default: the largest clearance between member nets)
//     o.budgetMs per member (default 400), o.rules, o.project as for AtriumRouter.route
//
// How it works. The bus is ordered across its direction of travel (start centroid to target) so neighbours never
// cross, and each member is routed with the existing walkaround router (AtriumRouter.route, walkaround only) into a
// working copy of the board in which the members already routed are obstacles. A member therefore hugs its
// neighbour at exactly the clearance rule wherever the bus bends round an obstacle, and runs parallel at the pitch
// elsewhere, which is the group walkaround. Both orders (left to right, right to left) are tried and the one that
// routes more members, then the shorter total, wins. Nothing in router.js changes, so the single-track router is
// untouched. The interactive editor flow is now Interactive Bus Routing (app/bus-route.js: a live ribbon with group push,
// via arrays, arcs, length readout and tuning); plan() stays the headless engine of the MCP multi_route tool.
globalThis.AtriumMultiRoute = (() => {
  const fail = m => { throw Error(m); };
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const now = typeof performance !== "undefined" && performance.now ? () => performance.now() : () => Date.now();
  const RT = () => globalThis.AtriumRouter || fail("Multi-routing needs the router (router.js).");
  const MAX = 32;

  function plan(board, defs, o = {}) {
    const R = RT(), t0 = now();
    const starts = (o.starts || []).map((s, k) => {
      if (!s || !Array.isArray(s.at) || !finite(s.at[0]) || !finite(s.at[1])) fail("Start " + (k + 1) + " needs a point.");
      return {at: [s.at[0], s.at[1]], net: String(s.net || ""), layer: s.layer || null, index: k};
    });
    if (starts.length < 2) fail("Multi-routing needs at least two start points.");
    if (starts.length > MAX) fail("Multi-routing takes at most " + MAX + " tracks at once.");
    const nets = starts.map(s => s.net);
    if (nets.some(n => !n)) fail("Every start point must be on a net.");
    if (new Set(nets).size !== nets.length) fail("Each start must be on its own net: " + nets.filter((n, i) => nets.indexOf(n) !== i).join(", ") + " repeats.");
    const layer = o.layer || starts[0].layer || "Top";
    if (R.core.layerIndex(layer) < 0) fail("Choose a copper layer to route on.");
    const rules = R.core.rulesFor(board, o.rules, o.project);
    const width = finite(o.width) && o.width > 0 ? o.width : Math.max(...nets.map(n => rules.width(n, layer).preferred));
    let gap = 0;
    for (let i = 0; i < nets.length; i++) for (let j = i + 1; j < nets.length; j++) gap = Math.max(gap, rules.clearance(nets[i], nets[j], layer));
    if (finite(o.gap)) {
      if (o.gap + 1e-9 < gap) fail("The gap " + o.gap + " mm is below the clearance rule between these nets (" + r6(gap) + " mm).");
      gap = o.gap;
    }
    // The router walks a hair outside the exact clearance boundary, so the ends get a micrometre of slack.
    const pitch = width + gap, SLACK = 0.001;
    // Ends: given, or fanned out across the target at the pitch, in the order the starts sit across the bus.
    let ends, order;
    const cx = starts.reduce((s, q) => s + q.at[0], 0) / starts.length, cy = starts.reduce((s, q) => s + q.at[1], 0) / starts.length;
    if (Array.isArray(o.ends)) {
      if (o.ends.length !== starts.length) fail("Give one end per start.");
      ends = o.ends.map((e, k) => { if (!Array.isArray(e) || !finite(e[0]) || !finite(e[1])) fail("End " + (k + 1) + " needs a point."); return [e[0], e[1]]; });
      order = starts.map((s, k) => k);
    } else {
      if (!Array.isArray(o.to) || !finite(o.to[0]) || !finite(o.to[1])) fail("Give the bus end point (to) or one end per start (ends).");
      let dx = o.to[0] - cx, dy = o.to[1] - cy;
      const len = Math.hypot(dx, dy);
      if (len < pitch) fail("The end point is too close to the start points.");
      dx /= len; dy /= len;
      const nx = -dy, ny = dx, across = s => (s.at[0] - cx) * nx + (s.at[1] - cy) * ny;
      order = starts.map((s, k) => k).sort((a, b) => across(starts[a]) - across(starts[b]));
      ends = new Array(starts.length);
      order.forEach((k, slot) => { const off = (slot - (starts.length - 1) / 2) * (pitch + SLACK); ends[k] = [r6(o.to[0] + nx * off), r6(o.to[1] + ny * off)]; });
    }
    const budget = finite(o.budgetMs) ? o.budgetMs : 400;
    function attempt(sequence) {
      // A working copy: routed members become obstacles for the next one.
      const work = {...board, items: board.items.slice()}, W = R.world(work, defs);
      const members = [], add = [];
      let total = 0, routed = 0;
      for (const k of sequence) {
        const s = starts[k], idOf = o.makeId;
        let r;
        try {
          r = R.route(work, defs, {from: s.at, to: ends[k], net: s.net, layer, width, method: "walkaround", fallback: false, budgetMs: budget,
            walkBudgetMs: budget, world: W, rules: o.rules, project: o.project, makeId: idOf, removeLoops: false});
        } catch (e) { r = {ok: false, status: e.message}; }
        if (r.ok && r.plan) {
          R.apply(work, r.plan); R.updateWorld(W, r.plan, defs);
          for (const it of r.plan.add || []) add.push(it);
          total += r.length || 0; routed++;
          members.push({index: k, net: s.net, ok: true, length: r6(r.length || 0), from: s.at.map(r6), to: ends[k]});
        } else members.push({index: k, net: s.net, ok: false, status: r.status || "blocked", from: s.at.map(r6), to: ends[k]});
      }
      members.sort((a, b) => a.index - b.index);
      return {members, add, total, routed};
    }
    // Trunk: the bus as one wide centreline (width = the whole bus), walked round obstacles by the router from a launch
    // point just ahead of the starts, then split into its members as parallel offsets at the pitch. Each member joins
    // its offset from its start with a straight fan-in. Every member is then checked against the clearance rules.
    function trunk() {
      if (Array.isArray(o.ends)) return null;
      const n = starts.length, step = pitch + SLACK, B = width + (n - 1) * step;
      let dx = o.to[0] - cx, dy = o.to[1] - cy;
      const len = Math.hypot(dx, dy); dx /= len; dy /= len;
      // The launch point sits far enough ahead that every member can reach its lane with one 45° jog.
      const nx0 = -dy, ny0 = dx;
      const ahead = Math.max(...starts.map(q => (q.at[0] - cx) * dx + (q.at[1] - cy) * dy)) + Math.max(B / 2 + gap + 0.5,
        ...order.map((k, slot) => Math.abs((slot - (n - 1) / 2) * step - ((starts[k].at[0] - cx) * nx0 + (starts[k].at[1] - cy) * ny0)) + width + gap));
      // The trunk leaves straight along the bus direction for a short lead before the router may bend it.
      const lead = Math.max(pitch, B / 2);
      if (ahead + lead + pitch >= len) return null;
      const p0 = [r6(cx + dx * ahead), r6(cy + dy * ahead)], launch = [r6(p0[0] + dx * lead), r6(p0[1] + dy * lead)], work = {...board, items: board.items.slice()}, W = R.world(work, defs);
      let c;
      try {
        c = R.route(work, defs, {from: launch, to: [o.to[0], o.to[1]], net: "", layer, width: B, method: "walkaround", fallback: false, budgetMs: budget * 2,
          walkBudgetMs: budget * 2, world: W, rules: o.rules, project: o.project, removeLoops: false});
      } catch { return null; }
      const routed = c.ok && c.plan?.add?.[0]?.points;
      if (!routed || routed.length < 2) return null;
      const centre = [p0, ...routed];
      const add = [], members = [], idOf = o.makeId || (() => globalThis.Atrium?.id?.() || "mr" + Math.random().toString(36).slice(2));
      const ul = Math.hypot(centre[1][0] - centre[0][0], centre[1][1] - centre[0][1]);
      const u = [(centre[1][0] - centre[0][0]) / ul, (centre[1][1] - centre[0][1]) / ul], nn = [-u[1], u[0]];
      for (const [slot, k] of order.entries()) {
        const off = (slot - (n - 1) / 2) * step, path = offset(centre, off);
        if (!path) return null;
        // Fan-in: a 45° jog from the start onto the member's lane, then along the lane to the trunk.
        const rel = [starts[k].at[0] - centre[0][0], starts[k].at[1] - centre[0][1]], lat = off - (rel[0] * nn[0] + rel[1] * nn[1]);
        if (rel[0] * u[0] + rel[1] * u[1] + Math.abs(lat) > 1e-6) return null;
        const entry = [starts[k].at[0] + u[0] * Math.abs(lat) + nn[0] * lat, starts[k].at[1] + u[1] * Math.abs(lat) + nn[1] * lat];
        const pts = [starts[k].at, entry, ...path].map(q => [r6(q[0]), r6(q[1])]).filter((q, i, l) => !i || Math.hypot(q[0] - l[i - 1][0], q[1] - l[i - 1][1]) > 1e-9);
        if (R.core.simplify) { const sp = R.core.simplify(pts); if (sp.length >= 2) pts.splice(0, pts.length, ...sp); }
        add.push({id: idOf(), kind: "track", points: pts, width, layer, net: starts[k].net});
        ends[k] = pts[pts.length - 1];
      }
      R.apply(work, {add}); R.updateWorld(W, {add}, defs);
      let total = 0;
      for (const t of add) {
        if (!R.check(W, rules, t).ok) return null;
        let l = 0; for (let i = 1; i < t.points.length; i++) l += Math.hypot(t.points[i][0] - t.points[i - 1][0], t.points[i][1] - t.points[i - 1][1]);
        total += l;
        members.push({index: starts.findIndex(q => q.net === t.net), net: t.net, ok: true, length: r6(l), from: t.points[0], to: t.points[t.points.length - 1]});
      }
      members.sort((a, b) => a.index - b.index);
      return {members, add, total, routed: add.length, strategy: "trunk"};
    }
    const group = trunk();
    let best = group;
    if (!best) {
      const forward = attempt(order), backward = attempt(order.slice().reverse());
      best = backward.routed > forward.routed || (backward.routed === forward.routed && backward.total < forward.total - 1e-6) ? backward : forward;
      best.strategy = "sequential";
    }
    return {ok: best.routed === starts.length, routed: best.routed, plan: {add: best.add, remove: [], modify: []}, members: best.members, strategy: best.strategy,
      layer, width: r6(width), gap: r6(gap), pitch: r6(pitch), order: order.map(k => starts[k].net), length: r6(best.total), ms: Math.round(now() - t0)};
  }

  // A parallel offset of a polyline (left of travel for d > 0) with mitred corners; null when an offset segment
  // would reverse (the bend is too tight for this member), so the caller falls back to routing one by one.
  function offset(pts, d) {
    pts = pts.filter((p, i) => !i || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-12);
    if (pts.length < 2) return null;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(pts.length - 1, i + 1)];
      let n1 = null, n2 = null;
      if (i > 0) { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); n1 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; }
      if (i < pts.length - 1) { const l = Math.hypot(c[0] - b[0], c[1] - b[1]); n2 = [-(c[1] - b[1]) / l, (c[0] - b[0]) / l]; }
      if (!n1) n1 = n2; if (!n2) n2 = n1;
      let mx = n1[0] + n2[0], my = n1[1] + n2[1]; const ml = Math.hypot(mx, my);
      if (ml < 1e-9) return null;
      mx /= ml; my /= ml;
      const k = d / Math.max(0.3, mx * n1[0] + my * n1[1]);
      out.push([b[0] + mx * k, b[1] + my * k]);
    }
    for (let i = 1; i < out.length; i++) {
      const u = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]], v = [out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]];
      if (u[0] * v[0] + u[1] * v[1] <= 1e-9) return null;
    }
    return out;
  }

  // ---------------------------------------------------------------- editor
  // Starts from the selection: tracks (their end nearest the clicked end point) and vias, one per net.
  function startsFrom(board, ids, target) {
    const want = new Set(ids), byNet = new Map();
    for (const it of board.items) {
      if (!want.has(it.id) || !it.net) continue;
      let at = null, layer = it.layer || null;
      if (it.kind === "track" && it.points?.length > 1) {
        const a = it.points[0], b = it.points[it.points.length - 1];
        at = Math.hypot(a[0] - target[0], a[1] - target[1]) <= Math.hypot(b[0] - target[0], b[1] - target[1]) ? a : b;
      } else if (it.kind === "via") { at = [it.x, it.y]; layer = null; }
      if (!at) continue;
      const had = byNet.get(it.net), d = Math.hypot(at[0] - target[0], at[1] - target[1]);
      if (!had || d < had.d) byNet.set(it.net, {at: [at[0], at[1]], net: it.net, layer, d});
    }
    return [...byNet.values()].map(({d, ...s}) => s);
  }
  let host = null;
  async function interactive() {
    if (!host) return;
    const d = host.doc?.();
    if (d?.kind !== "pcb") { host.info("Open a board layout to multi-route."); return; }
    const ids = host.selection?.() || [];
    const nets = new Set(d.items.filter(i => ids.includes(i.id) && i.net && (i.kind === "track" || i.kind === "via")).map(i => i.net));
    if (nets.size < 2) { host.info("Interactive Multi-Routing: select tracks or vias on two or more nets first, then run it again."); return; }
    const to = await host.pickPoint?.("Multi-route " + nets.size + " nets: click where the bus should end. Escape cancels.");
    if (!to) return;
    // The board may have changed (or been replaced by undo) while the point was picked.
    if (host.doc?.() !== d) { host.info("The board changed while the end point was picked. Run Interactive Multi-Routing again."); return; }
    try {
      const starts = startsFrom(d, ids, to), layer = host.activeLayer?.();
      const r = plan(d, host.defs(), {starts, to, layer: R6Layer(layer, starts), project: host.project()});
      if (!r.routed) { host.info("No track of the bus could be routed to that point (" + (r.members[0]?.status || "blocked") + ")."); return; }
      host.edit(() => { RT().apply(d, r.plan); });
      RT().invalidate?.(d);
      const failed = r.members.filter(m => !m.ok).map(m => m.net);
      host.info("Multi-routed " + r.routed + " of " + r.members.length + " nets at " + r.width + " mm, gap " + r.gap + " mm" + (failed.length ? " · not routed: " + failed.join(", ") : "") + ".");
    } catch (e) { host.info(e.message); }
  }
  const R6Layer = (layer, starts) => RT().core.layerIndex(layer) >= 0 ? layer : starts.find(s => s.layer)?.layer || "Top";
  // The action id stays: Route › Interactive Bus Routing (bus-route.js, which loads this module first) registers it again and
  // runs the live ribbon router. This click-to-end flow remains for builds without bus-route.js.
  const ACTION = "route-multi";
  function attach(h) { host = h; h.registerAction(ACTION, () => { (globalThis.AtriumBusRoute?.interactive || interactive)().catch(e => h.info?.(e.message)); }); }
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({plan, startsFrom, attach, legacy: () => interactive()});
})();
