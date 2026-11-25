"use strict";
// Autorouter engine v2 (Route › Auto Route with Engine: v2, MCP autoroute/fanout engine "v2").
// Lazy: loads with AtriumAutorouter (app/lazy.js). Shares the routing core (AtriumRouteCore in
// autorouter.js, which runs in a Worker) with engine v1 and adds, around it:
//
//   1. Safety.   Locked copper is never touched; fixed nets (options.fixedNets, or
//                doc.autorouter.fixedNets) are left out of scope. The result is a proposal
//                {add, remove, modify, report} that the caller previews and applies as one undo step.
//   2. Fanout.   AtriumFanout.planV2 on multi-layer boards with BGAs (ring-by-ring escape layers,
//                quadrant dog-bones, via-in-pad / microvias on HDI boards, plane vias for power,
//                symmetric pair escapes). Its escape layers become the nets' preferred layers.
//   3. Order.    Criticality: differential pairs, then matched-length group members, then the
//                Routing Priority rule, then short connections before long ones.
//   4. Global.   PathFinder on a coarse grid of routing cells per layer (congestion-aware channel
//                and layer assignment) gives each net a corridor; the detailed negotiated-congestion
//                router (PathFinder rip-up and retry on the fine grid) prefers it.
//   5. Detail.   The fine-grid router with hole-to-hole aware vias, coupled pairs, then a via
//                minimisation pass (single-layer and high-via-cost reroutes against everything else)
//                and octilinear pad entries (straight then 45°).
//   6. Retry.    When connections are left, alternate configurations (a finer grid; no guides)
//                route the same job and the best complete, cleanest result wins.
//   7. Shove.    Connections still open try AtriumRouter's interactive push-and-shove engine, which
//                may only move the proposal's own tracks.
//   8. Post.     Glossing of the proposal's tracks (AtriumRouter.gloss, each change verified
//                exactly), matched-length groups tuned with AtriumLength.autoTune, teardrops when asked.
//   9. Report.   Completion, length, vias, bends, 45° share and per-layer counts; pairs coupling and
//                group spread; the change list for the diff view.
//
// API
//   routeBoard(doc, defs, options) -> plan (synchronous; tests, MCP, the benchmark)
//   start(doc, defs, options, {onProgress, onLanded}) -> {promise, cancel} (Worker when possible)
//   preview: {show(doc, plan|landed), clear()}   canvas overlay of a proposal or of routes landing
//   applyPlan(doc, plan)  apply {add, remove, modify} in place (call inside one ctx.edit)
//   strategy(layers)      the core options v2 uses
globalThis.AtriumAutorouterV2 = (() => {
  const AR = () => globalThis.AtriumAutorouter;
  const now = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const VERSION = 2;

  // ---------------------------------------------------------------- strategy
  function strategy(layerCount, o = {}) {
    const multi = layerCount > 2;
    // Global routing guides are one of the retry configurations (ALTERNATES): on the benchmark they
    // cost time and vias as the first pass, so the first pass goes without.
    return {viaCost: multi ? 10 : 14, againstCost: multi ? 1.0 : 0.6, global: o.global === true, viaMinimize: true, octEntry: true,
      guidePenalty: 0.3, guideDiscount: 0.8, gcellTracks: 6, globalIterations: 6, prefPenalty: 0.5, maxIterations: 40, live: !!o.live};
  }

  // ---------------------------------------------------------------- scope and safety
  function fixedNets(doc, options) {
    return new Set([...(options.fixedNets || []), ...(doc.autorouter?.fixedNets || [])]);
  }
  function scopeWithoutFixed(doc, defs, options, fixed) {
    const scope = {...(options.scope || {})};
    if (!fixed.size) return scope;
    if (scope.nets) { scope.nets = [...scope.nets].filter(n => !fixed.has(n)); return scope; }
    const nets = new Set();
    try { for (const a of globalThis.AtriumConnectivity.inspect(doc, defs).airwires) if (!fixed.has(a.net)) nets.add(a.net); } catch { /* no connectivity */ }
    scope.nets = [...nets];
    return scope;
  }
  function wantsFanout(doc, defs, layers, options) {
    if (options.fanout === false) return false;
    if (options.fanout === true) return true;
    if ((layers?.length || AR().boardLayers(doc, defs).length) <= 2) return false;
    // Automatic: any BGA on the board.
    const F = globalThis.AtriumFanout;
    if (!F) return false;
    for (const i of doc.items) if (i.kind === "part") {
      const def = defs.get(i.def);
      if (!def?.footprint?.pads?.length || def.footprint.pads.length < 16) continue;
      try { if (F.classify(F.partPads(i, def)).kind === "bga") return true; } catch { /* skip */ }
    }
    return false;
  }

  // ---------------------------------------------------------------- criticality
  function prioritise(prep, doc, defs, options, prefLayers) {
    const job = prep.job, id = new Map(prep.netNames.map((n, i) => [n, i]));
    for (const pr of job.pairs || []) { job.nets[pr.p].priority = (job.nets[pr.p].priority || 0) + 300; job.nets[pr.n].priority = (job.nets[pr.n].priority || 0) + 300; }
    const L = globalThis.AtriumLength;
    if (L?.groups) {
      try {
        for (const g of L.groups(doc, defs)) {
          if (g.kind === "class" && options.lengthGroups == null) continue;
          if (options.lengthGroups && !options.lengthGroups.includes(g.key)) continue;
          for (const m of g.members) for (const n of m.nets || []) { const i = id.get(n); if (i > 0) job.nets[i].priority = Math.max(job.nets[i].priority || 0, 200); }
        }
      } catch { /* length module optional */ }
    }
    for (const [net, layer] of Object.entries(prefLayers || {})) {
      const i = id.get(net), li = prep.layers.indexOf(layer);
      if (i > 0 && li >= 0) job.nets[i].pref = 1 << li;
    }
  }

  // ---------------------------------------------------------------- exact checker
  // Copper of the working board plus the proposal, for verifying post-processing changes.
  function checker(prep, items) {
    const G = AR().core.geometry, job = prep.job;
    const b = job.bounds, idx = G.bucketIndex(b[0] - 5, b[1] - 5, b[2] + 5, b[3] + 5, 1);
    const netId = new Map(prep.netNames.map((n, i) => [n, i])), layerBit = new Map(prep.layers.map((l, i) => [l, 1 << i])), all = (1 << prep.layers.length) - 1;
    for (const o of job.obstacles) idx.add({k: o.k, c: o.c, r: o.r, lm: o.lm, net: o.net, clr: o.clr, fixed: true});
    const edges = [];
    const ol = job.outline;
    if (ol) for (let i = 0, n = ol.length >> 1; i < n; i++) { const j = (i + 1) % n; edges.push({k: 1, c: [ol[2 * i], ol[2 * i + 1], ol[2 * j], ol[2 * j + 1]], r: 0}); }
    for (const cut of job.cutouts || []) for (let i = 0, n = cut.length >> 1; i < n; i++) { const j = (i + 1) % n; edges.push({k: 1, c: [cut[2 * i], cut[2 * i + 1], cut[2 * j], cut[2 * j + 1]], r: 0}); }
    const recs = new Map();
    const shapesOf = it => {
      const n = netId.get(it.net) || 0;
      if (it.kind === "track") {
        const lm = layerBit.get(it.layer) || 0, out = [];
        for (let i = 1; i < it.points.length; i++) out.push({k: 1, c: [it.points[i - 1][0], it.points[i - 1][1], it.points[i][0], it.points[i][1]], r: it.width / 2, lm, net: n, id: it.id});
        return out;
      }
      if (it.kind === "via") return [{k: 0, c: [it.x, it.y], r: it.diameter / 2, lm: all, net: n, id: it.id}];
      return [];
    };
    function put(it) { const list = shapesOf(it).map(s => idx.add(s)); recs.set(it.id, list); }
    function drop(id) { for (const r of recs.get(id) || []) idx.remove(r); recs.delete(id); }
    for (const it of items) put(it);
    const clrOf = n => n > 0 ? job.nets[n].c : job.defaultClearance;
    const inside = (x, y) => !ol || G.inside(x, y, ol);
    // Does item `it` (with its current geometry) keep clearance from everything else?
    const reach = Math.max(job.nets.reduce((v, n) => Math.max(v, n.c || 0), job.defaultClearance), job.obstacles.reduce((v, o) => Math.max(v, o.clr || 0), 0));
    function ok(it) {
      for (const S of shapesOf(it)) {
        S.bb = G.box(S);
        for (let i = 0; i < S.c.length; i += 2) if (!inside(S.c[i], S.c[i + 1])) return false;
        for (const e of edges) if (G.shapeDist(S, e) < job.edgeClearance - 1e-7) return false;
        const bad = idx.query(S.bb, reach, o => {
          if (!(o.lm & S.lm) || o.id === it.id) return false;
          if (o.net > 0 && o.net === S.net) return false;
          const need = Math.max(clrOf(S.net), o.fixed ? (o.net > 0 ? clrOf(o.net) : Math.max(o.clr || 0, clrOf(S.net))) : clrOf(o.net));
          return G.shapeDist(S, o) < need - 1e-7;
        });
        if (bad) return false;
      }
      return true;
    }
    return {put, drop, ok};
  }

  // ---------------------------------------------------------------- plans
  function applyPlan(doc, plan) {
    if (plan.remove?.length) { const gone = new Set(plan.remove); doc.items = doc.items.filter(i => !gone.has(i.id)); }
    for (const item of plan.add || []) doc.items.push(item);
    if (plan.modify?.length) {
      const by = new Map(doc.items.map(i => [i.id, i]));
      for (const m of plan.modify) { const it = by.get(m.id); if (it) Object.assign(it, m.set || Object.fromEntries(Object.entries(m).filter(([k]) => k !== "id"))); }
    }
  }
  const clone = o => JSON.parse(JSON.stringify(o));

  // ---------------------------------------------------------------- post-processing
  // A routed island can have several legal ways out. Try a direct 45° route on
  // copper common to both actual terminals before keeping grid detours or vias.
  // Only replace a single completed connection, so branches and pair coupling survive.
  function shortenConnections(prep, out, work, defs, options, chk) {
    const R = globalThis.AtriumRouter;
    if (!R || out.report.fanout || prep.job.options.recorner === false || options.gloss === false) return;
    const job = prep.job, byNet = new Map(), connections = new Map(), replaced = new Set(), add = [];
    const skip = new Set(out.report.failures.map(f => f.net));
    for (const pair of job.pairs || []) {
      skip.add(prep.netNames[pair.p]);
      skip.add(prep.netNames[pair.n]);
    }
    for (const item of out.add) {
      if (!byNet.has(item.net)) byNet.set(item.net, []);
      byNet.get(item.net).push(item);
    }
    for (const c of prep.conns) {
      if (connections.has(c.net)) skip.add(prep.netNames[c.net]);
      else connections.set(c.net, c);
    }
    const rules = R.core.rulesFor(work, {}, options.project, defs);
    const viaCost = (job.options.viaCost ?? 12) * (out.report.grid?.pitch || .25);
    const count = {tested: 0, walks: 0, changed: 0, removedVias: 0, shorterMm: 0};
    let world;
    const scene = () => world ||= R.world({...work, items: [...work.items, ...out.add]}, defs, {project: options.project});
    for (const [n, c] of connections) {
      const name = prep.netNames[n], old = byNet.get(name), spec = job.nets[n];
      if (!old?.length || skip.has(name)) continue;
      const mask = spec.lm & job.obstacles[job.terms[c.a].obs].lm & job.obstacles[job.terms[c.b].obs].lm;
      const a = c.wire.from, b = c.wire.to, dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]);
      const lower = Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
      const oldLength = old.reduce((v, t) => v + (t.points ? R.core.pathLength(t.points) : 0), 0);
      const vias = old.filter(i => i.kind === "via").length;
      let bestCost = oldLength + vias * viaCost, chosen = null;
      if (!mask || lower < 1e-6 || lower >= bestCost - 1e-6) continue;
      for (let k = 0; k < prep.layers.length && bestCost > lower + 1e-6; k++) {
        if (!(mask & (1 << k)) || (spec.pref && !(spec.pref & (1 << k)))) continue;
        const layer = prep.layers[k], width = spec.w;
        const consider = points => {
          const cost = R.core.pathLength(points);
          const track = {id: old[0].id, kind: "track", layer, net: name, width, points};
          count.tested++;
          if (cost >= bestCost - 1e-6 || !chk.ok(track) || !R.check(scene(), rules, track).ok) return;
          chosen = track;
          bestCost = cost;
        };
        for (const bend of [false, true]) consider(R.core.connector(a, b, "45", bend));
        if (bestCost <= lower + 1e-6 || !vias || count.walks >= 48) continue;
        const ctx = R.core.makeContext(scene(), rules, {layer, net: world.nid(name), netName: name, hw: width / 2, base: "45", dirs: 8});
        for (const bend of [false, true]) {
          ctx.deadline = now() + 4;
          const walk = R.core.walkaround(ctx, a, b, bend, {iterations: 24, budget: 32});
          count.walks++;
          if (walk.ok) consider(walk.path);
          if (bestCost <= lower + 1e-6 || count.walks >= 48) break;
        }
      }
      if (!chosen) continue;
      for (const t of old) { replaced.add(t); chk.drop(t.id); }
      add.push(chosen);
      chk.put(chosen);
      R.updateWorld(world, {remove: old.map(t => t.id), add: [chosen], modify: []}, defs);
      count.changed++;
      count.removedVias += vias;
      count.shorterMm += oldLength - bestCost;
    }
    if (replaced.size) out.add = out.add.filter(t => !replaced.has(t)).concat(add);
    out.report.directConnections = count;
  }
  // Rewrites `out.add` tracks in place (the proposal only; existing copper is never changed).
  function postProcess(prep, out, work, defs, options, log) {
    const t0 = now();
    const fresh = () => ({...work, items: [...work.items, ...out.add]});
    const chk = checker(prep, out.add);
    shortenConnections(prep, out, work, defs, options, chk);
    const own = new Map(out.add.map(i => [i.id, i]));
    const R = globalThis.AtriumRouter;
    // Gloss: merge pieces, drop redundant vertices, shortcut wiggles; each change verified.
    if (options.gloss !== false && R?.gloss) {
      // Pair nets keep their coupled geometry: glossing one side alone would change the gap.
      const pairNets = new Set((prep.job.pairs || []).flatMap(p => [prep.netNames[p.p], prep.netNames[p.n]]));
      const tracks = out.add.filter(i => i.kind === "track" && !pairNets.has(i.net));
      let changed = 0, reverted = 0;
      try {
        const g = R.gloss(fresh(), defs, {ids: tracks.map(t => t.id), project: options.project, budgetMs: 15, merge: false});
        for (const m of g.modify) {
          const it = own.get(m.id);
          if (!it) continue;
          const old = it.points;
          chk.drop(it.id); it.points = m.points; chk.put(it);
          if (!chk.ok(it) || it.points.length < 2) { chk.drop(it.id); it.points = old; chk.put(it); reverted++; }
          else changed++;
        }
      } catch (e) { log.push("Gloss skipped: " + e.message); }
      out.report.gloss = {changed, reverted};
    }
    // Length groups: tune short members with meanders, proposal tracks only, verified.
    const LT = globalThis.AtriumLength;
    if (options.tune !== false && LT?.autoTune) {
      try {
        // Matched Lengths rule groups and the board's own groups; net classes and the automatic
        // differential-pair groups only when named (pair tuning adds uncoupled length).
        const doc2 = fresh(), keys = options.lengthGroups || LT.groups(doc2, defs).filter(g => g.kind === "matched" || g.kind === "custom").map(g => g.key);
        if (keys.length) {
          const r = LT.autoTune(doc2, defs, {keys, project: options.project});
          let tuned = 0, reverted = 0;
          // A net is tuned all or nothing: if one of its changed tracks fails the check, none change.
          const byNet = new Map();
          for (const m of r.plan.modify) { const it = own.get(m.id); if (!it || !m.set?.points) continue; if (!byNet.has(it.net)) byNet.set(it.net, []); byNet.get(it.net).push([it, m.set.points]); }
          for (const [, list] of byNet) {
            const old = list.map(([it]) => it.points);
            for (const [it, pts] of list) { chk.drop(it.id); it.points = pts; chk.put(it); }
            if (list.every(([it]) => chk.ok(it))) { tuned++; continue; }
            list.forEach(([it], i) => { chk.drop(it.id); it.points = old[i]; chk.put(it); });
            reverted++;
          }
          out.report.tuning = {groups: keys.length, nets: tuned, reverted, fixed: r.fixed.length, failed: r.failed.length};
        }
      } catch (e) { log.push("Length tuning skipped: " + e.message); }
    }
    // Teardrops on the proposal's pad and via entries (when asked).
    const TD = globalThis.AtriumTeardrops;
    if (options.teardrops && TD?.plan) {
      try {
        const doc2 = fresh(), r = TD.plan(doc2, defs, {...(typeof options.teardrops === "object" ? options.teardrops : {}), project: options.project, ids: out.add.filter(i => i.kind === "track").map(i => i.id)});
        const drops = (r.add || []).filter(i => i.teardrop);
        out.add.push(...drops);
        out.report.teardrops = drops.length;
      } catch (e) { log.push("Teardrops skipped: " + e.message); }
    }
    out.report.passes.push({name: "Post-processing", ms: now() - t0});
  }

  // ---------------------------------------------------------------- shove completion
  // Remaining connections: AtriumRouter's push-and-shove engine, allowed to move only the
  // proposal's own tracks. Each result is verified exactly before it joins the proposal.
  function shoveCompletion(prep, out, work, defs, options, log) {
    const R = globalThis.AtriumRouter;
    if (!R?.begin || !out.report.failures.length || options.shove === false) return;
    const t0 = now(), budget = options.shoveBudgetMs ?? 1500;
    const chk = checker(prep, out.add);
    let done = 0;
    const locked = work.items.filter(i => i.kind === "track" || i.kind === "via").map(i => i.id);
    const keep = [];
    for (const f of out.report.failures) {
      if (now() - t0 > budget) { keep.push(f); continue; }
      const board = {...work, items: [...work.items, ...out.add]};
      let s = null, ok = false;
      try {
        const conn = prep.conns.find(c => c.wire.fromId===f.fromId && c.wire.toId===f.toId && prep.netNames[c.net]===f.net);
        if(!conn){keep.push(f);continue;}
        const job=prep.job, mask=job.nets[conn.net].lm & job.obstacles[job.terms[conn.a].obs].lm & job.obstacles[job.terms[conn.b].obs].lm;
        const layer=prep.layers.find((_,i)=>mask & (1<<i));
        if(!layer){keep.push(f);continue;}
        s = R.begin(board, defs, {layer, start: f.from, net: f.net, mode: "push", corner: "45", locked, project: options.project, moveBudgetMs: 40, pushBudgetMs: 30});
        const r = s.move(f.to);
        if (r.status === "ok" || r.status === "pushed") {
          if (Math.hypot(r.end[0] - f.to[0], r.end[1] - f.to[1]) < 1e-6) {
            s.click();
            const plan = s.commit({makeId: () => globalThis.Atrium.id()});
            const mods = plan.modify || [], adds = plan.add || [];
            if (mods.every(m => out.add.some(i => i.id === m.id)) && !(plan.remove || []).some(id => !out.add.some(i => i.id === id))) {
              const saved = mods.map(m => { const it = out.add.find(i => i.id === m.id); return [it, it.points, it.x, it.y]; });
              for (const m of mods) { const it = out.add.find(i => i.id === m.id); chk.drop(it.id); if (m.points) it.points = m.points; else { it.x = m.x; it.y = m.y; } chk.put(it); }
              for (const a of adds) chk.put(a);
              if ([...adds, ...mods.map(m => out.add.find(i => i.id === m.id))].every(it => chk.ok(it))) {
                out.add.push(...adds.map(a => ({...a, net: f.net})));
                if (plan.remove?.length) { const gone = new Set(plan.remove); out.add = out.add.filter(i => !gone.has(i.id)); }
                ok = true; done++;
              } else {
                for (const a of adds) chk.drop(a.id);
                for (const [it, pts, x, y] of saved) { chk.drop(it.id); if (pts) it.points = pts; else { it.x = x; it.y = y; } chk.put(it); }
              }
            }
          }
        }
      } catch (e) { log.push("Shove: " + e.message); }
      finally { try { if (!ok) s?.cancel?.(); } catch { /* ignore */ } }
      if (!ok) keep.push(f);
    }
    if (done) { out.report.failures = keep; out.report.routed += done; }
    out.report.shove = {tried: out.report.failures.length + done, routed: done, ms: now() - t0};
  }

  // ---------------------------------------------------------------- HDI vias
  // On a board with an HDI build-up (doc.hdi), each routed via becomes the via (or stacked chain)
  // AtriumViaStack.hdi.routeSpan picks for the layers its tracks actually use: laser microvias for
  // build-up layer changes, a stack only while the HDI Vias rule's limit allows (else the through
  // via stays). Narrower spans and smaller lands only free copper, so clearance still holds.
  // Boards without doc.hdi are left exactly as they are.
  function hdiVias(out, work, defs, options, fan, rules) {
    const H = globalThis.AtriumViaStack?.hdi;
    let c = null;
    try { c = H?.config?.(work, defs) || null; } catch { c = null; }
    if (!c || !H.routeSpan) return;
    const R = globalThis.AtriumRules;
    let maxStacked = 2;
    try { const r = R?.query?.(work, "hdiVias", {project: options.project}); if (Number.isInteger(r?.maxStacked)) maxStacked = r.maxStacked; } catch { /* default */ }
    const fanIds = new Set((fan?.add || []).map(i => i.id));
    const ends = new Map();
    const key = (x, y) => x.toFixed(5) + "," + y.toFixed(5);
    for (const t of out.add) if (t.kind === "track") for (const q of [t.points[0], t.points[t.points.length - 1]]) { const k = t.net + "|" + key(q[0], q[1]); if (!ends.has(k)) ends.set(k, new Set()); ends.get(k).add(t.layer); }
    const keys = c.keys, next = [];
    let changed = 0;
    for (const v of out.add) {
      if (v.kind !== "via" || v.fromLayer || v.microvia || fanIds.has(v.id)) { next.push(v); continue; }
      const used = [...(ends.get(v.net + "|" + key(v.x, v.y)) || [])].map(l => keys.indexOf(l)).filter(i => i >= 0);
      if (used.length < 2) { next.push(v); continue; }
      const lo = Math.min(...used), hi = Math.max(...used);
      if (lo === 0 && hi === keys.length - 1) { next.push(v); continue; }
      let sp = null;
      try { sp = H.routeSpan(work, keys[lo], keys[hi], defs); } catch { sp = null; }
      const parts = sp ? (sp.parts || [sp]) : null;
      const lasers = parts ? parts.filter(q => q.extra?.microvia).length : 0;
      if (!parts || (parts.length > 1 && (c.stacking === "staggered" || lasers > maxStacked)) || parts.some(q => (q.extra?.diameter ?? v.diameter) > v.diameter + 1e-9)) { next.push(v); continue; }
      if (parts.some(q => {
        const a = AR().copperIndex(q.fromLayer), b = AR().copperIndex(q.toLayer);
        return !rules.permitsVia(v.net,{...v,...q.extra},[v.x,v.y],a >= 0 && b >= 0 ? [Math.min(a,b),Math.max(a,b)] : [0,127]);
      })) { next.push(v); continue; }
      parts.forEach((q, i) => {
        const nv = {...v, id: i ? globalThis.Atrium.id() : v.id};
        if (q.fromLayer) { nv.fromLayer = q.fromLayer; nv.toLayer = q.toLayer; }
        if (q.extra) Object.assign(nv, q.extra);
        next.push(nv);
      });
      changed++;
    }
    out.add = next;
    if (changed) out.report.hdi = {vias: changed, buildUp: H.name?.(c) || ""};
  }

  // Differential Pairs Routing rule (gap, width, max uncoupled length) on the proposal's pairs.
  function pairCheck(prep, out, work, defs, options) {
    const R = globalThis.AtriumRules;
    if (!prep.job.pairs?.length || !R?.drc) return;
    try {
      const doc2 = {...work, items: [...work.items, ...out.add]};
      const res = R.drc(doc2, defs, R.stored(work, options.project) || R.defaults(), {project: options.project, types: ["diffPairsRouting"], scopes: false});
      out.report.pairViolations = res.violations.length;
    } catch { /* rule check optional */ }
  }

  // ---------------------------------------------------------------- quality report
  function quality(add, failures, total) {
    let segs = 0, oct = 0, bends = 0, acute = 0, length = 0;
    const layers = {};
    for (const t of add) {
      if (t.kind !== "track") continue;
      const p = t.points;
      for (let i = 1; i < p.length; i++) {
        const dx = p[i][0] - p[i - 1][0], dy = p[i][1] - p[i - 1][1], d = Math.hypot(dx, dy);
        if (d < 1e-6) continue;
        segs++; length += d; layers[t.layer] = (layers[t.layer] || 0) + d;
        const a = Math.atan2(dy, dx) * 180 / Math.PI, m = ((a % 45) + 45) % 45;
        if (m < 0.5 || m > 44.5) oct++;
        if (i >= 2) { bends++; const ex = p[i - 1][0] - p[i - 2][0], ey = p[i - 1][1] - p[i - 2][1]; if (ex * dx + ey * dy < -1e-9) acute++; }
      }
    }
    const vias = add.filter(i => i.kind === "via").length, routed = total - failures.length;
    return {completion: total ? routed / total : 1, routed, total, length, vias, bends, bendsPerConnection: routed ? bends / routed : 0, oct45: segs ? oct / segs : 1, acute,
      layers: Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, Math.round(v * 10) / 10]))};
  }
  // Change list for the diff view: what the proposal adds, removes and modifies, per net.
  function changes(doc, plan) {
    const byNet = new Map(), row = n => { if (!byNet.has(n)) byNet.set(n, {net: n, tracks: 0, vias: 0, length: 0, removed: 0, modified: 0}); return byNet.get(n); };
    for (const i of plan.add) { const r = row(i.net || ""); if (i.kind === "track") { r.tracks++; for (let k = 1; k < i.points.length; k++) r.length += Math.hypot(i.points[k][0] - i.points[k - 1][0], i.points[k][1] - i.points[k - 1][1]); } else if (i.kind === "via") r.vias++; }
    const ids = new Map(doc.items.map(i => [i.id, i]));
    for (const id of plan.remove || []) row(ids.get(id)?.net || "").removed++;
    for (const m of plan.modify || []) row(ids.get(m.id)?.net || "").modified++;
    return [...byNet.values()].sort((a, b) => a.net.localeCompare(b.net, undefined, {numeric: true}));
  }

  // ---------------------------------------------------------------- pipeline
  // Builds the working board and the job; `run(job)` routes it (sync or async); `finish` builds the plan.
  function setup(doc, defs, options = {}) {
    const A = AR(), t0 = now(), log = [];
    const fixed = fixedNets(doc, options);
    let work = doc, remove = [];
    const scope = scopeWithoutFixed(doc, defs, options, fixed);
    if (options.lockPreroutes === false) {
      remove = A.unlockedRoutes(doc, scope.nets ? new Set(scope.nets) : null).filter(id => !fixed.has(doc.items.find(i => i.id === id)?.net));
      const gone = new Set(remove);
      work = {...doc, items: doc.items.filter(i => !gone.has(i.id))};
    }
    let layers = options.layers?.length ? options.layers : null;
    let fan = null;
    if (wantsFanout(work, defs, layers, options) && globalThis.AtriumFanout?.planV2) {
      try {
        fan = AtriumFanout.planV2(work, defs, {...(options.fanoutOptions || {}), project: options.project, auto: options.fanoutOptions?.auto ?? "bga", layers: layers || undefined,
          components: scope.components, power: options.powerNets, powerNets: options.powerNets === false ? false : undefined});
        // Fixed nets are never fanned.
        if (fixed.size) fan.add = fan.add.filter(i => !fixed.has(i.net));
        if (fan.add.length) work = {...work, items: [...work.items, ...fan.add]};
      } catch (e) { log.push("Fanout skipped: " + e.message); fan = null; }
    }
    const L = (layers || A.boardLayers(work, defs)).length;
    const prep = A.prepare(work, defs, {...options, scope, router: {...strategy(L, options), ...(options.router || {})}});
    prioritise(prep, work, defs, options, fan?.report.prefLayers);
    return {prep, work, fan, remove, log, t0, scope};
  }
  const better = (a, b) => !b || a.stats.routed > b.stats.routed || (a.stats.routed === b.stats.routed && (a.stats.vias < b.stats.vias || (a.stats.vias === b.stats.vias && a.stats.length < b.stats.length)));
  // Alternate configurations tried when connections are left.
  const ALTERNATES = [{gridDiv: 3, name: "finer grid"}, {global: true, name: "global routing guides"}, {gridDiv: 3, viaCost: 6, name: "finer grid, cheap vias"}];
  function finish(S, result, doc, defs, options) {
    const A = AR(), {prep, work, fan, remove, log} = S;
    const out = A.plan(prep, result, {remove,original:doc});
    out.modify = [];
    if (fan) { out.add.unshift(...fan.add.map(i => ({...i}))); out.report.fanout = fan.report; }
    out.report.engine = "v2";
    out.report.notes = [...(out.report.notes || []), ...log];
    if (result.stats.global) out.report.global = result.stats.global;
    if (result.stats.viaMinimize) out.report.viaMinimize = result.stats.viaMinimize;
    if (result.alternate) out.report.alternate = result.alternate;
    shoveCompletion(prep, out, work, defs, options, out.report.notes);
    postProcess(prep, out, work, defs, options, out.report.notes);
    hdiVias(out, work, defs, options, fan, prep.rules);
    pairCheck(prep, out, work, defs, options);
    out.report.vias = out.add.filter(i => i.kind === "via").length - (fan?.add.filter(i => i.kind === "via").length || 0);
    out.report.quality = quality(out.add, out.report.failures, out.report.total);
    out.report.length = out.report.quality.length;
    out.report.changes = changes(doc, out);
    out.report.ms = now() - S.t0;
    out.report.proposal = true;
    return out;
  }

  function routeBoard(doc, defs, options = {}) {
    const S = setup(doc, defs, options), A = AR();
    const budget = options.router?.timeLimit ?? 60000;
    const base = clone(S.prep.job);
    let best = A.core.runSync(S.prep.job, options.onProgress);
    if (best.stats.routed < best.stats.total && options.alternates !== false) {
      for (const alt of ALTERNATES) {
        if (now() - S.t0 > budget * 0.8) break;
        const job = clone(base);
        job.options = {...job.options, ...alt, timeLimit: Math.max(2000, budget - (now() - S.t0))};
        const r = A.core.runSync(job);
        if (better(r, best)) { r.alternate = alt.name; best = r; }
        if (best.stats.routed === best.stats.total) break;
      }
    }
    let out = finish(S, best, doc, defs, options);
    // Pairs that break their routing rule (usually max uncoupled length): one retry with v1's via cost.
    if (out.report.pairViolations > 0 && options.alternates !== false) {
      const job = clone(base);
      job.options = {...job.options, ...PAIR_RETRY};
      const r = A.core.runSync(job), o2 = finish(S, r, doc, defs, options);
      if (o2.report.pairViolations < out.report.pairViolations && o2.report.routed >= out.report.routed) { o2.report.alternate = PAIR_RETRY.name; out = o2; }
    }
    return out;
  }
  const PAIR_RETRY = {viaCost: 12, againstCost: 0.6, name: "pair-friendly via cost"};

  // Asynchronous run for the editor: the core in a Worker (AtriumAutorouter.run), the rest on the
  // main thread. onProgress(e) gets the core's events (e.landed: routes that just landed).
  function start(doc, defs, options = {}, {onProgress} = {}) {
    let cancelled = false, current = null;
    const promise = (async () => {
      // Post-processing modules (push-and-shove and gloss, length tuning, teardrops) load on demand.
      try { await globalThis.AtriumLazy?.need?.(["AtriumRouter", "AtriumLength", ...(options.teardrops ? ["AtriumTeardrops"] : [])]); } catch { /* each step is optional */ }
      if (cancelled) throw Object.assign(Error("Routing cancelled."), {cancelled: true});
      const S = setup(doc, defs, {...options, live: true});
      const A = AR(), budget = options.router?.timeLimit ?? 120000;
      const base = clone(S.prep.job);
      // Progress events carry the layer names and net widths so a view can draw landed routes.
      const layers = S.prep.layers, widths = S.prep.job.nets.map(n => ({w: n.w, vd: n.vd}));
      if (S.fan?.add.length) onProgress?.({type: "progress", phase: "Fanout", fraction: 1, landed: fanLanded(S.fan.add, layers), layers, widths});
      const prog = e => onProgress?.({...e, layers, widths});
      const runOne = job => { current = A.run(job, {onProgress: prog}); return current.promise; };
      let best = await runOne(S.prep.job);
      if (best.stats.routed < best.stats.total && options.alternates !== false) {
        for (const alt of ALTERNATES) {
          if (cancelled || now() - S.t0 > budget * 0.8) break;
          prog({type: "progress", phase: "Retry (" + alt.name + ")", fraction: 0});
          const job = clone(base);
          job.options = {...job.options, ...alt, live: false, timeLimit: Math.max(2000, budget - (now() - S.t0))};
          const r = await runOne(job);
          if (better(r, best)) { r.alternate = alt.name; best = r; }
          if (best.stats.routed === best.stats.total) break;
        }
      }
      if (cancelled) throw Object.assign(Error("Routing cancelled."), {cancelled: true});
      prog({type: "progress", phase: "Post-processing", fraction: 1});
      let out = finish(S, best, doc, defs, options);
      if (out.report.pairViolations > 0 && options.alternates !== false && !cancelled) {
        const job = clone(base);
        job.options = {...job.options, ...PAIR_RETRY, live: false};
        const r = await runOne(job), o2 = finish(S, r, doc, defs, options);
        if (o2.report.pairViolations < out.report.pairViolations && o2.report.routed >= out.report.routed) { o2.report.alternate = PAIR_RETRY.name; out = o2; }
      }
      return out;
    })();
    return {promise, cancel() { cancelled = true; current?.cancel(); }};
  }

  // Fanout items as landed-route deltas (one per net, keyed by name so they never collide with core net ids).
  function fanLanded(items, layers) {
    const by = new Map();
    for (const it of items) {
      const k = "fan:" + it.net;
      if (!by.has(k)) by.set(k, {net: k, segs: [], vias: []});
      const g = by.get(k);
      if (it.kind === "track") for (let i = 1; i < it.points.length; i++) g.segs.push([Math.max(0, layers.indexOf(it.layer)), it.points[i - 1][0], it.points[i - 1][1], it.points[i][0], it.points[i][1]]);
      else if (it.kind === "via") g.vias.push([it.x, it.y]);
    }
    return [...by.values()];
  }

  // ---------------------------------------------------------------- canvas preview
  // Draws the proposal (or the routes landed so far) over the board, in each layer's colour,
  // new routes easing in with the routing-feel motion tokens (--motion-settle, --motion-via).
  const preview = (() => {
    let off = null, docId = null, nets = new Map(), born = new Map(), layers = [], raf = 0;
    const colour = l => { try { return globalThis.AtriumPCBAppearance?.colour?.(l) || globalThis.AtriumCanvas?.layerColor?.(l); } catch { return null; } };
    const FALLBACK = {Top: "#d33a2f", Bottom: "#3466c4"};
    const motionOK = () => { try { return globalThis.AtriumRouteFeel?.motionOK?.() ?? globalThis.AtriumMotion?.moves?.() ?? (document.documentElement.getAttribute("data-motion") || (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "reduce" : "full")) === "full"; } catch { return false; } };
    const tokens = () => { try { return globalThis.AtriumRouteFeel?.tokens?.() || {settle: 220, via: 260}; } catch { return {settle: 220, via: 260}; } };
    function draw(ctx, {scale}) {
      const t = now(), TK = tokens(), motion = motionOK(), px = 1 / (scale || 1);
      let animating = false;
      ctx.save();
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const [net, g] of nets) {
        const age = t - (born.get(net) || 0), k = motion ? Math.min(1, age / TK.settle) : 1;
        if (k < 1) animating = true;
        ctx.globalAlpha = 0.35 + 0.5 * (1 - Math.pow(1 - k, 3));
        for (const s of g.segs) {
          const name = layers[s[0]] ?? s[0];
          ctx.strokeStyle = colour(name) || FALLBACK[name] || "#d9a33a";
          ctx.lineWidth = Math.max(g.w || 0.15, px);
          // Segments draw in from their start while the route settles.
          const x1 = s[1] + (s[3] - s[1]) * k, y1 = s[2] + (s[4] - s[2]) * k;
          ctx.beginPath(); ctx.moveTo(s[1], s[2]); ctx.lineTo(x1, y1); ctx.stroke();
        }
        const vk = motion ? Math.min(1, age / TK.via) : 1;
        ctx.fillStyle = "#c8c8c8";
        for (const v of g.vias) { ctx.beginPath(); ctx.arc(v[0], v[1], Math.max((g.vd || 0.5) / 2 * (0.6 + 0.4 * vk), px), 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.restore();
      if (animating && !raf && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(() => { raf = 0; globalThis.AtriumNavHost?.redraw?.(); });
    }
    function attach(doc) {
      const H = globalThis.AtriumNavHost;
      if (!H?.addRenderer || typeof document === "undefined") return false;
      docId = doc.id;
      if (!off) off = H.addRenderer(d => (nets.size && d?.id === docId ? {overlay: draw} : null));
      return true;
    }
    return {
      // Routes landing during a run: deltas from the core ({net, segs:[[l,x0,y0,x1,y1]], vias}).
      landed(doc, deltas, layerNames, widths) {
        if (!attach(doc)) return;
        layers = layerNames || layers;
        const t = now();
        for (const d of deltas || []) {
          if (!d.segs.length && !d.vias.length) { nets.delete(d.net); born.delete(d.net); continue; }
          nets.set(d.net, {segs: d.segs, vias: d.vias, w: widths?.[d.net]?.w, vd: widths?.[d.net]?.vd});
          born.set(d.net, t);
        }
        globalThis.AtriumNavHost?.redraw?.();
      },
      // A whole proposal (its tracks and vias) shown for review.
      show(doc, plan) {
        if (!attach(doc)) return;
        nets = new Map(); born = new Map(); layers = [];
        const names = [];
        const li = l => { let i = names.indexOf(l); if (i < 0) { names.push(l); i = names.length - 1; } return i; };
        for (const it of plan.add) {
          const key = it.net || "";
          if (!nets.has(key)) nets.set(key, {segs: [], vias: [], w: 0, vd: 0});
          const g = nets.get(key);
          if (it.kind === "track") { g.w = it.width; for (let i = 1; i < it.points.length; i++) g.segs.push([li(it.layer), it.points[i - 1][0], it.points[i - 1][1], it.points[i][0], it.points[i][1]]); }
          else if (it.kind === "via") { g.vd = it.diameter; g.vias.push([it.x, it.y]); }
        }
        layers = names;
        const t = now() - 1e6;
        for (const k of nets.keys()) born.set(k, t);
        globalThis.AtriumNavHost?.redraw?.();
      },
      clear() { nets = new Map(); born = new Map(); if (off) { off(); off = null; } globalThis.AtriumNavHost?.redraw?.(); },
      get size() { return nets.size; }
    };
  })();

  return Object.freeze({VERSION, routeBoard, start, setup, finish, strategy, applyPlan, preview, quality, changes, checker, fixedNets, ALTERNATES});
})();
