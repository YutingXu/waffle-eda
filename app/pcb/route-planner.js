"use strict";
// Routing proposals: a planner around the autorouter (autorouter.js) and fanout (fanout.js).
//
// run(doc, defs, {project, nets, classes, strategy, layers, timeLimitMs, fanout, critical})
// edits `doc` in place (callers pass a working copy) and returns a report:
//   1. Scope: the unrouted connections of the given nets and/or net classes (default all).
//   2. Priority groups, routed in order so earlier groups get the clean board:
//      power (supply and ground nets, or a "Power" net class), differential pairs (rules
//      diffPairs), critical (constraints `critical`, net classes or names such as CLK,
//      USB, DDR, RF, high-speed), then the rest.
//   3. Fanout first for BGAs, and for QFN/QFP parts on boards with inner layers (or when
//      fanout: true), for the components that have unrouted connections in scope.
//   4. One autorouter pass per group (its share of half the time limit), then a completion
//      pass over whatever is still open. If connections stay open, every net in scope is also
//      routed together (negotiated rip-up and reroute) on the fanned-out board, and the result
//      with fewer open connections is kept (report.method "priority" or "joint"; joint: false
//      keeps priority order only).
//   5. Same-net vias closer than the hole-to-hole rule are merged into one.
//   6. Unrouted connections with a reason (the router's, else "not reached in the time limit").
// Every result is a reviewable proposal: the MCP tool turns the working copy into an
// .waffle-ai file, the editor and the AI Assistant show it in the review dialog.
globalThis.AtriumRoutePlanner = (() => {
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const fail = m => { throw Error(m); };
  const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d + 0 : v);
  const natural = typeof Intl !== "undefined" ? new Intl.Collator("en", {numeric: true}).compare : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const CRITICAL = /(?:^|[_\-./ ])(?:CLK|CLOCK|XTAL|OSC|MCLK|SCLK|USB|DDR|PCIE|SATA|HDMI|LVDS|MIPI|ETH|RF|ANT|RESET|RST)(?:\d|[_\-./ PN+]|$)|^(?:D[PN]|USB_?D[PN])$/i;
  const CRITICAL_CLASS = /critical|clock|clk|fast|high.?speed|\bhs\b|rf|usb|ddr|impedance/i;
  const POWER_CLASS = /power|pwr|supply|gnd|ground/i;
  const GROUPS = [["power", "Power and ground"], ["diffpair", "Differential pairs"], ["critical", "Critical"], ["other", "Other signals"]];
  const LIMITS = {timeMs: 30000, maxTimeMs: 600000};

  const ruleSet = (doc, project) => globalThis.AtriumRules?.stored?.(doc, project) ?? null;
  function classes(doc, project) {
    // The rule engine's views (signals.js when the project has a signals store), else the stored keys.
    const R = globalThis.AtriumRules;
    if (R?.netClasses && R?.diffPairs) try { return {netClasses: R.netClasses(doc, {project}) || {}, diffPairs: R.diffPairs(doc, {project}) || []}; } catch { /* stored keys */ }
    const set = ruleSet(doc, project) || {};
    return {netClasses: set.netClasses || {}, diffPairs: Array.isArray(set.diffPairs) ? set.diffPairs : []};
  }
  function isPowerNet(n) {
    const P = globalThis.AtriumAutoplace;
    if (P) return P.isPower(n) || P.isGround(n);
    return !!globalThis.AtriumAutorouter?.POWER?.test?.(n);
  }
  /** Group nets into priority groups. Returns {power, diffpair, critical, other, classOf}. */
  function classify(nets, doc, project, o = {}) {
    const {netClasses, diffPairs} = classes(doc, project);
    const classOf = new Map();
    for (const [c, members] of Object.entries(netClasses)) for (const n of members || []) if (!classOf.has(n)) classOf.set(n, c);
    const pairNets = new Set(diffPairs.flatMap(p => [p.positive, p.negative]).filter(Boolean));
    const critical = new Set(o.critical || []);
    const out = {power: [], diffpair: [], critical: [], other: [], classOf};
    for (const n of [...nets].sort(natural)) {
      const c = classOf.get(n) || "";
      if (isPowerNet(n) || POWER_CLASS.test(c)) out.power.push(n);
      else if (pairNets.has(n)) out.diffpair.push(n);
      else if (critical.has(n) || CRITICAL_CLASS.test(c) || CRITICAL.test(n)) out.critical.push(n);
      else out.other.push(n);
    }
    return out;
  }
  function fanoutCandidates(doc, defs, airwires, layers, force) {
    const F = globalThis.AtriumFanout;
    if (!F || force === false) return [];
    const want = new Set();
    for (const a of airwires) { want.add(a.fromId); want.add(a.toId); }
    const out = [];
    for (const i of doc.items) {
      if (i.kind !== "part") continue;
      const def = defs.get(i.def);
      if (!def?.footprint) continue;
      const pads = F.partPads(i, def), c = F.classify(pads);
      const linked = want.has(i.id) || pads.some(p => want.has(i.id + "/" + p.number));
      if (!linked && !airwires.some(a => (a.fromLabel || "").startsWith((i.ref || "\u0000") + ".") || (a.toLabel || "").startsWith((i.ref || "\u0000") + "."))) continue;
      if (c.kind === "bga" || (force === true && (c.kind === "qfp" || c.kind === "other")) || (layers > 2 && c.kind === "qfp" && c.pitch <= 0.65 + 1e-6)) out.push({id: i.id, kind: c.kind});
    }
    return out;
  }
  function scopeAirwires(doc, defs, nets) {
    const C = globalThis.AtriumConnectivity || fail("Connectivity is unavailable in this build.");
    const all = C.inspect(doc, defs).airwires;
    return nets ? all.filter(a => nets.has(a.net)) : all;
  }

  // Two new vias of one net closer than the hole-to-hole rule (the router can drop a second
  // via next to the first): keep the earlier one and move the other's track ends onto it.
  function mergeVias(doc, keepIds, project) {
    let gap = 0.254;
    try { const r = globalThis.AtriumRules?.query?.(doc, "holeToHole", {project}); if (Number.isFinite(r?.gap)) gap = r.gap; } catch { /* default */ }
    const vias = doc.items.filter(i => i.kind === "via" && !keepIds.has(i.id) && i.net), gone = new Set();
    let merged = 0;
    for (let i = 0; i < vias.length; i++) {
      const a = vias[i]; if (gone.has(a.id)) continue;
      for (let j = i + 1; j < vias.length; j++) {
        const b = vias[j];
        if (gone.has(b.id) || b.net !== a.net || (b.fromLayer || a.fromLayer) && (b.fromLayer !== a.fromLayer || b.toLayer !== a.toLayer)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) - (+a.drill || 0) / 2 - (+b.drill || 0) / 2 >= gap - 1e-6) continue;
        for (const t of doc.items) {
          if (t.kind !== "track" || t.net !== a.net || keepIds.has(t.id)) continue;
          for (const k of [0, t.points.length - 1]) if (Math.hypot(t.points[k][0] - b.x, t.points[k][1] - b.y) < 1e-6) t.points[k] = [a.x, a.y];
        }
        gone.add(b.id); merged++;
      }
    }
    if (gone.size) doc.items = doc.items.filter(i => !gone.has(i.id) && !(i.kind === "track" && !keepIds.has(i.id) && i.points.length === 2 && Math.hypot(i.points[0][0] - i.points[1][0], i.points[0][1] - i.points[1][1]) < 1e-6));
    return merged;
  }

  /**
   * Route a board in priority order (in place). o: {project, nets, classes, strategy, layers,
   * timeLimitMs, fanout (true | false | undefined = auto), critical: [net], completion}.
   */
  function run(doc, defs, o = {}) {
    const t0 = now(), AR = globalThis.AtriumAutorouter || fail("The autorouter is unavailable in this build.");
    if (!doc || doc.kind !== "pcb") fail("Choose a PCB layout to route.");
    const {netClasses} = classes(doc, o.project);
    let nets = null;
    if (o.nets || o.classes) {
      nets = new Set(o.nets || []);
      for (const c of o.classes || []) {
        if (!Object.hasOwn(netClasses, c)) fail("The board has no net class " + c + ". Classes: " + (Object.keys(netClasses).join(", ") || "none") + ".");
        for (const n of netClasses[c] || []) nets.add(n);
      }
    }
    const layers = AR.boardLayers(doc, defs);
    const strategy = AR.STRATEGIES.find(s => s.id === (o.strategy || (layers.length > 2 ? "multi" : "default2"))) || fail("Unknown strategy " + o.strategy + ". Strategies: " + AR.STRATEGIES.map(s => s.id).join(", ") + ".");
    const limit = Math.min(LIMITS.maxTimeMs, Math.max(500, o.timeLimitMs ?? LIMITS.timeMs));
    const before = scopeAirwires(doc, defs, nets);
    const report = {strategy: strategy.id, layers: o.layers || layers, groups: [], fanout: null, connections: before.length, routed: 0, unrouted: [], tracks: 0, vias: 0, ms: 0, notes: []};
    if (nets) for (const n of nets) if (!before.some(a => a.net === n) && !doc.items.some(i => i.net === n || (i.kind === "part" && Object.values(i.pinNets || {}).includes(n)))) report.notes.push("A requested net is not on this board.");
    if (!before.length) { report.ms = Math.round(now() - t0); report.notes.push("Nothing to route: every connection in scope is already routed."); return report; }
    const startIds = new Set(doc.items.map(i => i.id));
    // Fanout.
    const fan = fanoutCandidates(doc, defs, before, layers.length, o.fanout);
    if (fan.length && globalThis.AtriumFanout) {
      const plan = AtriumFanout.plan(doc, defs, {project: o.project, components: fan.map(f => f.id)});
      AR.apply(doc, plan);
      report.fanout = {components: fan.length, kinds: [...new Set(fan.map(f => f.kind))], tracks: plan.add.filter(i => i.kind === "track").length, vias: plan.add.filter(i => i.kind === "via").length};
    }
    // Priority groups. With joint fallback allowed, they get half the time: the other half
    // routes every net in scope together on the fanned-out board when priority order leaves
    // connections open, and the result with fewer open connections wins.
    const joint = o.joint !== false, fanned = joint ? JSON.stringify(doc.items) : null;
    const seqLimit = joint ? limit * 0.5 : limit;
    const g = classify(new Set(before.map(a => a.net)), doc, o.project, o);
    const weights = {power: 0.2, diffpair: 0.2, critical: 0.2, other: 0.4};
    const active = GROUPS.map(([id]) => id).filter(id => g[id].length);
    const lastReason = new Map();
    const router = {...strategy.router};
    for (const [id, label] of GROUPS) {
      const list = g[id];
      if (!list.length) continue;
      const open = scopeAirwires(doc, defs, new Set(list));
      const row = {group: id, label, nets: list.length, connections: open.length, routed: 0, failed: 0, ms: 0};
      report.groups.push(row);
      if (!open.length) continue;
      const left = seqLimit - (now() - t0);
      if (left < 200) { row.skipped = "time limit"; continue; }
      // This group's share of what is left; the completion pass keeps 15 %.
      const rest = active.slice(active.indexOf(id)).reduce((s, k) => s + weights[k], 0) + 0.15;
      const ms = Math.max(200, left * weights[id] / rest);
      const t1 = now();
      const plan = AR.routeBoard(doc, defs, {project: o.project, scope: {nets: new Set(list)}, layers: o.layers, fanout: false, router: {...router, timeLimit: ms}});
      AR.apply(doc, plan);
      const r = plan.report || {};
      row.routed = r.routed || 0; row.failed = (r.failures || []).length; row.ms = Math.round(now() - t1);
      for (const f of r.failures || []) lastReason.set(f.net + "|" + (f.fromLabel || "") + "|" + (f.toLabel || ""), f.reason);
      for (const n of r.notes || []) if (!report.notes.includes(n)) report.notes.push(n);
    }
    // Completion: everything still open, all nets together.
    let open = scopeAirwires(doc, defs, nets);
    if (open.length && o.completion !== false && seqLimit - (now() - t0) > 300) {
      const t1 = now(), names = new Set(open.map(a => a.net));
      const plan = AR.routeBoard(doc, defs, {project: o.project, scope: {nets: names}, layers: o.layers, fanout: false, router: {...router, timeLimit: Math.max(300, seqLimit - (now() - t0))}});
      AR.apply(doc, plan);
      const r = plan.report || {};
      for (const f of r.failures || []) lastReason.set(f.net + "|" + (f.fromLabel || "") + "|" + (f.toLabel || ""), f.reason);
      report.groups.push({group: "completion", label: "Completion (all open connections)", nets: names.size, connections: open.length, routed: r.routed || 0, failed: (r.failures || []).length, ms: Math.round(now() - t1)});
      open = scopeAirwires(doc, defs, nets);
    }
    report.method = "priority";
    if (open.length && joint && limit - (now() - t0) > 500) {
      const t1 = now(), alt = {...doc, items: JSON.parse(fanned)}, names = new Set(before.map(a => a.net));
      const plan = AR.routeBoard(alt, defs, {project: o.project, scope: {nets: names}, layers: o.layers, fanout: false, router: {...router, timeLimit: Math.max(500, limit - (now() - t0))}});
      AR.apply(alt, plan);
      const left = scopeAirwires(alt, defs, nets), r = plan.report || {};
      report.groups.push({group: "joint", label: "All nets together (negotiated)", nets: names.size, connections: before.length, routed: r.routed || 0, failed: (r.failures || []).length, ms: Math.round(now() - t1)});
      if (left.length < open.length) {
        doc.items = alt.items; open = left; report.method = "joint";
        lastReason.clear();
        for (const f of r.failures || []) lastReason.set(f.net + "|" + (f.fromLabel || "") + "|" + (f.toLabel || ""), f.reason);
        report.notes.push("Routing every net together left fewer connections open than priority order, so that result is proposed.");
      }
    }
    report.merged_vias = mergeVias(doc, startIds, o.project);
    const added = doc.items.filter(i => !startIds.has(i.id));
    report.tracks = added.filter(i => i.kind === "track").length;
    report.vias = added.filter(i => i.kind === "via").length;
    report.length = round(added.filter(i => i.kind === "track").reduce((s, t) => s + t.points.slice(1).reduce((l, p, k) => l + Math.hypot(p[0] - t.points[k][0], p[1] - t.points[k][1]), 0), 0), 2);
    report.routed = Math.max(0, before.length - open.length);
    report.unrouted = open.map(a => ({net: a.net, from: a.fromLabel || "", to: a.toLabel || "", at: [round(a.from[0]), round(a.from[1])], to_at: [round(a.to[0]), round(a.to[1])],
      reason: lastReason.get(a.net + "|" + (a.fromLabel || "") + "|" + (a.toLabel || "")) || lastReason.get([...lastReason.keys()].find(k => k.startsWith(a.net + "|")) || "") || "not reached within the time limit"}));
    report.classes = Object.fromEntries(GROUPS.map(([id]) => [id, g[id].length]));
    report.ms = Math.round(now() - t0);
    return report;
  }

  // MCP / AI result: net names and pad labels are design text, under untrusted_design_text.
  function summary(r) {
    return {strategy: r.strategy, method: r.method || "priority", connections: r.connections, routed: r.routed, unrouted_count: r.unrouted.length, tracks: r.tracks, vias: r.vias, length_mm: r.length ?? 0,
      groups: r.groups.map(g => ({group: g.group, nets: g.nets, connections: g.connections, routed: g.routed, failed: g.failed, ms: g.ms, ...(g.skipped ? {skipped: g.skipped} : {})})),
      fanout: r.fanout, merged_vias: r.merged_vias || 0, classes: r.classes || null, ms: r.ms, notes: r.notes,
      unrouted: r.unrouted.slice(0, 200).map((u, n) => ({index: n, at: u.at, to_at: u.to_at, reason: u.reason})),
      untrusted_design_text: {layers: r.layers, unrouted: r.unrouted.slice(0, 200).map((u, n) => ({index: n, net: u.net, from: u.from, to: u.to}))}};
  }
  const KEYS = {time_limit_ms: "timeLimitMs"};
  /** MCP op: a = {document_id, nets, classes, strategy, layers, time_limit_ms, fanout, critical, mode}. */
  function headless(a, h) {
    const planOnly = a.mode === "plan", p = planOnly ? JSON.parse(JSON.stringify(h.project())) : h.mutable(), doc = h.board(p, a.document_id), defs = h.defsOf(p);
    const o = {project: p};
    for (const [k, v] of Object.entries(a)) if (!["document_id", "mode"].includes(k)) o[KEYS[k] || k] = v;
    const r = run(doc, defs, o);
    if (!planOnly && (r.tracks || r.vias || r.fanout)) h.touched();
    return {document_id: doc.id, mode: planOnly ? "plan" : a.mode || "proposal", ...summary(r)};
  }
  return Object.freeze({GROUPS, classify, run, summary, headless, fanoutCandidates});
})();
