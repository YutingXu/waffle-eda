"use strict";
// Constraint Manager (Design › Constraint Manager…), after Allegro's Constraint Manager:
// one spreadsheet of every net, net class, differential pair and matched group with its
// constraints, the actual values and live pass/fail; a Physical sheet (width and via
// limits per class or layer), a Spacing sheet (class-to-class clearance matrix) and the
// DFA package spacing matrix (dfa.js).
//
// Constraints are the board's design rules (rules.js, version 2): a cell edit writes a rule
// scoped to that row (Net, Net class, Differential pair, Layer…), creating an override rule
// at the top priority when the row has none of its own. Each edit is one undo step.
//
// ECSet-style templates: a template is a net class (or differential pair class) whose
// rules are marked "ECSet template". Create one from a net or pair (its effective
// constraints are copied into class rules) and apply it to many nets or pairs (they join
// the class). Templates live in the rules file, so DRC, routers and MCP see them as rules.
//
// Performance: one pass over the board builds a per-net index; per-row metrics (length,
// delay, width range, vias, impedance, coupling) are computed only for rows that are
// painted, sorted or exported, and cached per board revision.
//
// API (pure, DOM-free):
//   AtriumConstraints.model(project, doc, defs, {revision}) -> M
//   M.rows(tab) -> [row];  M.metrics(tab, row) -> {cells, fails, status}
//   AtriumConstraints.COLUMNS[tab]; setCell(set, tab, row, key, value, M) (mutates a rules set)
//   AtriumConstraints.templates(set) / createTemplate(set, name, from, M) / applyTemplate(set, name, members)
//   AtriumConstraints.csv(M, tab, {keys, rows}); headless(args, host) (MCP `constraints`)
//   AtriumConstraints.open(ctx)
globalThis.AtriumConstraints = (() => {
  const R = () => globalThis.AtriumRules || fail("Design rules (rules.js) are not loaded.");
  const fail = m => { throw Error(m); };
  const EPS = 1e-6, C0 = 0.299792458, DK = 4.2, MARK = "ECSet template";
  const clone = v => JSON.parse(JSON.stringify(v));
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const tokens = s => String(s ?? "").match(/\d+|\D+/g) || [];
  function natural(a, b) {
    const x = tokens(a), y = tokens(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const p = x[i], q = y[i], pd = /^\d/.test(p), qd = /^\d/.test(q);
      if (pd && qd) { const d = Number(p) - Number(q); if (d) return d; }
      else if (p !== q) { const m = p.toLowerCase(), n = q.toLowerCase(); if (m !== n) return m < n ? -1 : 1; }
    }
    return x.length - y.length;
  }
  const r4 = v => typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 + 0 : v;
  const copperIndex = l => l === "Top" ? 0 : l === "Bottom" ? 127 : (/^Inner (\d+)$/.exec(l || "") || [])[1] ? +/^Inner (\d+)$/.exec(l)[1] : null;

  // ------------------------------------------------------------------ columns
  // kind: text | len (mm) | num | ps | ohm | status. edit: [rule type, field] for an editable constraint.
  // actual: true for measured values. heavy: computed per visible row only.
  const col = (key, label, kind, extra = {}) => ({key, label, kind, ...extra});
  const COLUMNS = {
    nets: [col("name", "Net", "text"), col("status", "Status", "status"), col("classes", "Net classes", "text"), col("pair", "Diff pair", "text"),
      col("widthMin", "Width min", "len", {edit: ["width", "min"]}), col("widthMax", "Width max", "len", {edit: ["width", "max"]}),
      col("widthActual", "Width actual", "text", {actual: true}),
      col("lengthMin", "Length min", "len", {edit: ["length", "min"]}), col("lengthMax", "Length max", "len", {edit: ["length", "max"]}),
      col("length", "Length", "len", {actual: true}), col("delayMin", "Delay min", "ps", {edit: ["delay", "min"]}), col("delayMax", "Delay max", "ps", {edit: ["delay", "max"]}),
      col("delay", "Delay", "ps", {actual: true}), col("vias", "Vias", "num", {actual: true}),
      col("clearance", "Clearance", "len", {edit: ["clearance", "gap"]}), col("profile", "Z profile", "text", {edit: ["width", "impedanceProfile"]}),
      col("zTarget", "Z target", "text"), col("z", "Z achieved", "ohm", {actual: true, heavy: true}), col("rules", "Rules", "text", {hidden: true})],
    classes: [col("name", "Net class", "text"), col("status", "Status", "status"), col("members", "Nets", "num"), col("failing", "Failing nets", "num", {actual: true}),
      col("template", "Template", "text"),
      col("widthMin", "Width min", "len", {edit: ["width", "min"]}), col("widthMax", "Width max", "len", {edit: ["width", "max"]}),
      col("lengthMin", "Length min", "len", {edit: ["length", "min"]}), col("lengthMax", "Length max", "len", {edit: ["length", "max"]}),
      col("tolerance", "Match tolerance", "len", {edit: ["matchedLengths", "tolerance"]}),
      col("clearance", "Clearance", "len", {edit: ["clearance", "gap"]}), col("profile", "Z profile", "text", {edit: ["width", "impedanceProfile"]}),
      col("longest", "Longest", "len", {actual: true}), col("spread", "Length spread", "len", {actual: true})],
    // Signals and tags (signals.js): constraints scoped InSignal('…') / HasTag('…'), measured over their nets.
    signals: [col("name", "Signal", "text"), col("status", "Status", "status"), col("kind", "Kind", "text"), col("members", "Nets", "num"), col("tags", "Tags", "text"),
      col("failing", "Failing nets", "num", {actual: true}),
      col("widthMin", "Width min", "len", {edit: ["width", "min"]}), col("widthMax", "Width max", "len", {edit: ["width", "max"]}),
      col("lengthMin", "Length min", "len", {edit: ["length", "min"]}), col("lengthMax", "Length max", "len", {edit: ["length", "max"]}),
      col("tolerance", "Match tolerance", "len", {edit: ["matchedLengths", "tolerance"]}),
      col("clearance", "Clearance", "len", {edit: ["clearance", "gap"]}), col("profile", "Z profile", "text", {edit: ["width", "impedanceProfile"]}),
      col("longest", "Longest", "len", {actual: true}), col("spread", "Length spread", "len", {actual: true}), col("list", "Member nets", "text", {hidden: true})],
    tags: [col("name", "Tag", "text"), col("status", "Status", "status"), col("roles", "Roles", "text"), col("members", "Nets", "num"),
      col("failing", "Failing nets", "num", {actual: true}),
      col("widthMin", "Width min", "len", {edit: ["width", "min"]}), col("widthMax", "Width max", "len", {edit: ["width", "max"]}),
      col("lengthMin", "Length min", "len", {edit: ["length", "min"]}), col("lengthMax", "Length max", "len", {edit: ["length", "max"]}),
      col("tolerance", "Match tolerance", "len", {edit: ["matchedLengths", "tolerance"]}),
      col("clearance", "Clearance", "len", {edit: ["clearance", "gap"]}), col("profile", "Z profile", "text", {edit: ["width", "impedanceProfile"]}),
      col("longest", "Longest", "len", {actual: true}), col("spread", "Length spread", "len", {actual: true}), col("list", "Member nets", "text", {hidden: true})],
    pairs: [col("name", "Diff pair", "text"), col("status", "Status", "status"), col("positive", "Positive", "text"), col("negative", "Negative", "text"), col("classes", "Pair classes", "text"),
      col("widthMin", "Width min", "len", {edit: ["diffPairsRouting", "widthMin"]}), col("widthMax", "Width max", "len", {edit: ["diffPairsRouting", "widthMax"]}),
      col("gapMin", "Gap min", "len", {edit: ["diffPairsRouting", "gapMin"]}), col("gapMax", "Gap max", "len", {edit: ["diffPairsRouting", "gapMax"]}),
      col("gapActual", "Gap actual", "len", {actual: true, heavy: true}),
      col("maxUncoupled", "Max uncoupled", "len", {edit: ["diffPairsRouting", "maxUncoupled"]}), col("uncoupled", "Uncoupled", "len", {actual: true, heavy: true}),
      col("skewMax", "Max skew", "len", {edit: ["matchedLengths", "pairTolerance"]}), col("skew", "Skew", "len", {actual: true}),
      col("lengthP", "Length +", "len", {actual: true}), col("lengthN", "Length −", "len", {actual: true}), col("delaySkew", "Delay skew", "ps", {actual: true}),
      col("vias", "Vias", "num", {actual: true}), col("profile", "Z profile", "text", {edit: ["diffPairsRouting", "impedanceProfile"]}),
      col("zTarget", "Zdiff target", "text"), col("z", "Zdiff achieved", "ohm", {actual: true, heavy: true})],
    groups: [col("name", "Group", "text"), col("status", "Status", "status"), col("kind", "Kind", "text"), col("members", "Members", "num"),
      col("tolerance", "Tolerance", "len", {edit: ["matchedLengths", "tolerance"]}), col("pairTolerance", "Pair tolerance", "len", {edit: ["matchedLengths", "pairTolerance"]}),
      col("target", "Target", "len", {actual: true}), col("longest", "Longest", "len", {actual: true}), col("shortest", "Shortest", "len", {actual: true}),
      col("spread", "Spread", "len", {actual: true}), col("delaySpread", "Delay spread", "ps", {actual: true}), col("delayTarget", "Delay target", "ps", {actual: true}), col("worstSkew", "Worst pair skew", "len", {actual: true}),
      col("failing", "Failing", "num", {actual: true}), col("list", "Member nets", "text", {hidden: true})],
    // hs: xSignals (xsignals.js) and automatic series-part paths (length-tuning.js seriesXSignal).
    xsignals: [col("name", "xSignal", "text"), col("status", "Status", "status"), col("source", "Kind", "text"), col("classes", "Classes", "text"),
      col("from", "From", "text"), col("to", "To", "text"), col("through", "Through", "text"), col("nets", "Nets", "text"),
      col("length", "Path length", "len", {actual: true, heavy: true}), col("series", "Series parts", "len", {actual: true, heavy: true}), col("delay", "Delay", "ps", {actual: true, heavy: true}),
      col("group", "Match group", "text", {heavy: true}), col("target", "Target", "len", {actual: true, heavy: true}), col("delta", "Δ target", "len", {actual: true, heavy: true}),
      col("topology", "Topology", "text", {edit: ["routingTopology", "topology"]}), col("maxStub", "Max stub", "len", {edit: ["routingTopology", "maxStub"]})],
    physical: [col("name", "Scope", "text"), col("status", "Status", "status"), col("scopeKind", "Kind", "text"),
      col("widthMin", "Width min", "len", {edit: ["width", "min"]}), col("widthPref", "Width preferred", "len", {edit: ["width", "preferred"]}), col("widthMax", "Width max", "len", {edit: ["width", "max"]}),
      col("profile", "Z profile", "text", {edit: ["width", "impedanceProfile"]}),
      col("viaMin", "Via dia min", "len", {edit: ["viaStyle", "diameterMin"]}), col("viaPref", "Via dia preferred", "len", {edit: ["viaStyle", "diameterPreferred"]}), col("viaMax", "Via dia max", "len", {edit: ["viaStyle", "diameterMax"]}),
      col("holeMin", "Via hole min", "len", {edit: ["viaStyle", "holeMin"]}), col("holePref", "Via hole preferred", "len", {edit: ["viaStyle", "holePreferred"]}), col("holeMax", "Via hole max", "len", {edit: ["viaStyle", "holeMax"]}),
      col("tracks", "Tracks", "num", {actual: true, heavy: true}), col("narrowest", "Narrowest", "len", {actual: true, heavy: true}), col("widest", "Widest", "len", {actual: true, heavy: true}),
      col("viaCount", "Vias", "num", {actual: true, heavy: true}), col("violations", "Violations", "num", {actual: true, heavy: true})]
  };
  const TABS = [["nets", "Nets"], ["signals", "Signals"], ["classes", "Net Classes"], ["tags", "Tags"], ["pairs", "Differential Pairs"], ["groups", "Matched Groups"], ["xsignals", "xSignals"], ["physical", "Physical"], ["spacing", "Spacing"], ["dfa", "DFA"]];

  // ------------------------------------------------------------------ board index
  // One pass: per net its tracks (layer, width, length), vias and items.
  function buildIndex(doc) {
    const nets = new Map(), all = {tracks: [], vias: []};
    const entry = n => { let e = nets.get(n); if (!e) nets.set(n, e = {tracks: [], vias: [], ids: [], pins: 0}); return e; };
    for (const i of doc.items || []) {
      if (i.kind === "track" && Array.isArray(i.points) && copperIndex(i.layer || "Top") != null) {
        let len = 0; for (let k = 1; k < i.points.length; k++) len += Math.hypot(i.points[k][0] - i.points[k - 1][0], i.points[k][1] - i.points[k - 1][1]);
        const t = {id: i.id, net: i.net || "", layer: i.layer || "Top", width: i.width, points: i.points, len};
        all.tracks.push(t);
        if (i.net) { const e = entry(i.net); e.tracks.push(t); e.ids.push(i.id); }
      } else if (i.kind === "via") {
        const v = {id: i.id, net: i.net || "", diameter: i.diameter, drill: i.drill, from: i.fromLayer, to: i.toLayer};
        all.vias.push(v);
        if (i.net) { const e = entry(i.net); e.vias.push(v); e.ids.push(i.id); }
      } else if (i.kind === "part") { for (const n of Object.values(i.pinNets || {})) if (n) entry(n).pins++; }
      else if (i.net && (i.kind === "pad" || i.kind === "polygon")) entry(i.net).ids.push(i.id);
    }
    return {nets, all};
  }

  // ------------------------------------------------------------------ model
  function model(project, doc, defs, opts = {}) {
    if (doc?.kind !== "pcb") fail("Open a PCB layout to manage constraints.");
    const Rl = R(), set = clone(Rl.effective(doc, project)), q = Rl.resolver(doc, {project, rules: set});
    const S = globalThis.AtriumStackup, I = globalThis.AtriumImpedance;
    let idx = null, lengths = null, groups = null, rowsCache = new Map();
    const metrics = new Map();
    const M = {project, doc, defs, set, q, revision: opts.revision ?? 0};
    M.index = () => idx ||= buildIndex(doc);
    M.lengths = () => lengths ||= Rl.netLengths(doc, defs, opts.revision != null ? {match: true, revision: opts.revision} : {match: true}); // the length engine, as the delay column (matchLength); a revision keeps its buckets
    const classMap = new Map(), pairOf = new Map(), pairClasses = new Map();
    for (const [c, nets] of Object.entries(set.netClasses || {})) for (const n of nets) { if (!classMap.has(n)) classMap.set(n, []); classMap.get(n).push(c); }
    for (const p of set.diffPairs || []) { pairOf.set(p.positive, p); pairOf.set(p.negative, p); }
    for (const [c, ps] of Object.entries(set.diffPairClasses || {})) for (const p of ps) { if (!pairClasses.has(p)) pairClasses.set(p, []); pairClasses.get(p).push(c); }
    M.classesOf = n => classMap.get(n) || [];
    M.pairOf = n => pairOf.get(n) || null;
    M.templates = () => templates(set);
    // ---- delay (ps/mm) per layer and width; vias at the outer-layer Dk.
    const factors = new Map();
    function factor(layer, width) {
      const k = layer + "|" + Math.round((width || .15) * 1e4);
      if (factors.has(k)) return factors.get(k);
      let f = null;
      try { f = S?.delay?.(doc, layer, width, defs) || null; } catch { f = null; }
      if (!(f > 0)) f = I?.delayFallback({outer: layer === "Top" || layer === "Bottom", w: width, h: .2, er: DK}).delay || Math.sqrt(DK) / C0; // AtriumImpedance's one fallback
      factors.set(k, f);
      return f;
    }
    const viaFactor = Math.sqrt(DK) / C0;
    // ---- impedance of a track (or a coupled pair with gap) from the profile geometry, else the stack geometry.
    const zCache = new Map();
    function impedance(layer, w, gap, profile) {
      const k = layer + "|" + r4(w) + "|" + r4(gap ?? -1) + "|" + (profile || "");
      if (zCache.has(k)) return zCache.get(k);
      let z = null;
      try {
        let geom = null;
        if (profile) { const p = S?.profileValues?.(doc, profile, layer, defs); if (p && !p.error) geom = p.geom; }
        if (!geom && S && I) { const st = S.get(doc, defs), g = I.geometry(st.layers, layer); if (g && g.structure !== "none") geom = {...g}; }
        if (geom && I) { const r = I.solve({...geom, w, ...(gap != null ? {s: gap} : {})}); if (r?.ok) z = gap != null ? r.zdiff ?? null : r.z; }
      } catch { z = null; }
      zCache.set(k, z);
      return z;
    }
    M.impedance = impedance;
    // ---- per-net measurements
    function netActual(net) {
      const e = M.index().nets.get(net), L = M.lengths().get(net);
      const out = {length: L?.length || 0, vias: e?.vias.length || 0, tracks: e?.tracks.length || 0, wmin: null, wmax: null, layers: new Map(), delay: 0, layer: null, width: null};
      if (!e) return out;
      let best = -1;
      for (const t of e.tracks) {
        if (Number.isFinite(t.width)) { out.wmin = out.wmin == null ? t.width : Math.min(out.wmin, t.width); out.wmax = out.wmax == null ? t.width : Math.max(out.wmax, t.width); }
        const l = out.layers.get(t.layer) || {len: 0, wmin: Infinity, wmax: -Infinity};
        l.len += t.len; l.wmin = Math.min(l.wmin, t.width); l.wmax = Math.max(l.wmax, t.width); out.layers.set(t.layer, l);
        out.delay += t.len * factor(t.layer, t.width);
        if (t.len > best) { best = t.len; out.layer = t.layer; out.width = t.width; }
      }
      out.delay += (L?.viaLength || 0) * viaFactor;
      if (globalThis.AtriumTiming) { try { out.delay = AtriumTiming.netDelay(doc, defs, net); } catch { /* keep the estimate */ } } // same delay as DRC
      return out;
    }
    const fmtRange = (a, b) => a == null ? "—" : Math.abs(a - b) < EPS ? String(r4(a)) : r4(a) + "–" + r4(b);
    const zText = c => c?.impedance ? c.impedance.target + " Ω ±" + c.impedance.tolerance + "%" : "";
    // ---- rows
    function netNames() {
      const names = new Set(M.index().nets.keys());
      for (const n of classMap.keys()) names.add(n);
      for (const n of pairOf.keys()) names.add(n);
      return [...names].sort(natural);
    }
    M.rows = tab => {
      if (rowsCache.has(tab)) return rowsCache.get(tab);
      let rows = [];
      if (tab === "nets") rows = netNames().map(n => ({key: n, name: n, classes: M.classesOf(n).join(", "), pair: M.pairOf(n)?.name || ""}));
      else if (tab === "classes") rows = Object.keys(set.netClasses || {}).sort(natural).map(c => ({key: c, name: c, nets: set.netClasses[c], members: set.netClasses[c].length, template: isTemplate(set, "netclass", c) ? "ECSet" : ""}));
      else if (tab === "pairs") rows = (set.diffPairs || []).slice().sort((a, b) => natural(a.name, b.name)).map(p => ({key: p.name, name: p.name, positive: p.positive, negative: p.negative, classes: (pairClasses.get(p.name) || []).join(", ")}));
      else if (tab === "signals" || tab === "tags") rows = signalRows(tab);
      else if (tab === "groups") rows = groupRows();
      else if (tab === "xsignals") rows = xsRows();
      else if (tab === "physical") {
        rows = [{key: "all", name: "All", scope: {kind: "all"}, scopeKind: "All"}];
        for (const c of Object.keys(set.netClasses || {}).sort(natural)) rows.push({key: "netclass:" + c, name: c, scope: {kind: "netclass", value: c}, scopeKind: "Net class"});
        const layers = new Set(["Top", "Bottom"]);
        for (const t of M.index().all.tracks) layers.add(t.layer);
        for (const l of [...layers].sort((a, b) => copperIndex(a) - copperIndex(b))) rows.push({key: "layer:" + l, name: Rl.layerLabel(l), layer: l, scope: {kind: "layer", value: l}, scopeKind: "Layer"});
      }
      rowsCache.set(tab, rows);
      return rows;
    };
    function groupRows() {
      const L = globalThis.AtriumLength;
      if (L?.evaluate) {
        try { groups = L.evaluate(doc, defs, {revision: M.revision}); } catch { groups = null; }
      }
      if (!groups) {
        const len = M.lengths();
        groups = Rl.matchedGroups(doc, {rules: set}).map(g => {
          const members = g.nets.map(n => ({name: n, nets: [n], length: len.get(n)?.length || 0, delay: 0, status: "pass"}));
          const longest = Math.max(0, ...members.map(m => m.length));
          for (const m of members) if (longest - m.length > g.tolerance + EPS) m.status = "short";
          return {key: "rule:" + g.ruleId, kind: "matched", rule: true, name: g.ruleName, tolerance: g.tolerance, pairTolerance: g.pairTolerance, withinPair: g.withinPair,
            members, pairs: g.pairs, target: longest, longest, fails: members.filter(m => m.status !== "pass").length};
        });
      }
      const ruleIdOf = g => g.rule ? (set.list.find(r => "rule:" + (r.id) === g.key || "rule:" + r.name === g.key) || null) : null;
      return groups.map(g => ({key: g.key, name: g.name, kind: {matched: "Matched Lengths rule", pairs: "Pair class", class: "Net class", custom: "xSignal group"}[g.kind] || g.kind,
        group: g, rule: ruleIdOf(g), members: g.members.length, list: g.members.map(m => m.name).join(", ")}));
    }
    // Signals and tags of the signal model (signals.js): each with the nets it covers.
    function signalRows(tab) {
      const S = globalThis.AtriumSignals;
      let SM = null; try { SM = S?.model ? S.model(project, doc) : null; } catch { SM = null; }
      if (!SM) return [];
      const row = (name, nets, extra) => ({key: name, name, nets, members: nets.length, list: nets.join(", "), ...extra});
      if (tab === "signals") return [...SM.signals].sort((a, b) => natural(a.name, b.name)).map(x => {
        const nets = [...SM.netsOfSignal(x.name)].sort(natural);
        return row(x.name, nets, {kind: {single: "Single-ended", diff: "Differential", bus: "Bus"}[x.kind] || x.kind, tags: x.tags.join(", "), derived: !!x.derived});
      });
      const names = new Map();
      for (const t of SM.store.tags || []) names.set(t.name.toLowerCase(), t);
      for (const n of netNames()) for (const t of SM.tagNames(n)) if (!names.has(t.toLowerCase())) names.set(t.toLowerCase(), {name: t});
      return [...names.values()].sort((a, b) => natural(a.name, b.name)).map(t => {
        const roles = t.as ? ["net", "pair", "xsignal"].filter(k => t.as[k]).map(k => ({net: "net class", pair: "pair class", xsignal: "xSignal class"})[k]) : ["net class"];
        return row(t.name, [...SM.netsOfTag(t.name)].sort(natural), {roles: roles.join(", ")});
      });
    }
    // Stored xSignals, then nets that run through a series part (automatic xSignals).
    function xsRows() {
      const X = globalThis.AtriumXSignals, L = globalThis.AtriumLength, out = [], seen = new Set();
      const row = (x, source) => ({key: source + ":" + x.name, name: x.name, xs: x, source, classes: (x.classes || []).join(", "), from: x.from.ref + "." + x.from.pin, to: x.to.ref + "." + x.to.pin,
        through: (x.through || []).join(", ") || "—", netList: x.nets || [], nets: (x.nets || []).join(" → "), scope: {kind: "net", value: (x.nets || [])[0] || ""}});
      for (const x of X?.list?.(doc) || []) { out.push(row(x, "xSignal")); for (const n of x.nets || []) seen.add(n); }
      if (L?.seriesXSignal) for (const n of netNames()) {
        if (seen.has(n)) continue;
        let a = null; try { a = L.seriesXSignal(doc, n, {revision: M.revision}); } catch { a = null; }
        if (!a) continue;
        for (const m of a.nets) seen.add(m);
        out.push(row(a, "Series (auto)"));
      }
      return out.sort((a, b) => natural(a.name, b.name));
    }
    function xsMetrics(row) {
      const cells = {name: row.name, source: row.source, classes: row.classes, from: row.from, to: row.to, through: row.through, nets: row.nets}, fails = new Set(), net = row.netList[0];
      const topo = net ? q("routingTopology", {net}) : null;
      if (topo) { cells.topology = topo.topology; cells.maxStub = topo.maxStub ?? null; }
      const out = finish(cells, fails, false);
      out.heavy = () => {
        if (out.heavyDone) return; out.heavyDone = true;
        const L = globalThis.AtriumLength; if (!L?.xSignalLength) return;
        let r = null; try { r = L.xSignalLength(doc, defs, row.xs, {revision: M.revision}); } catch { r = null; }
        if (r && !r.unrouted) { cells.length = r.length; cells.series = r.series ?? 0; cells.delay = r.delay; }
        if (!groups) groupRows();
        for (const g of groups || []) {
          const m = g.members.find(x => x.kind === "xsignal" && row.netList.some(n => x.nets.includes(n)));
          if (!m) continue;
          cells.group = g.name; cells.target = m.lengthTarget ?? g.target; cells.delta = m.unrouted ? null : m.delta;
          if (m.status && m.status !== "pass" && m.status !== "unrouted") { fails.add("delta"); fails.add("length"); }
          out.status = fails.size ? "fail" : "pass";
          break;
        }
      };
      return out;
    }
    // ---- metrics (cells, fails, status) per row, cached per model (one model per revision)
    M.metrics = (tab, row) => {
      const k = tab + "\u0001" + row.key;
      let m = metrics.get(k);
      if (!m) { m = compute(tab, row); metrics.set(k, m); }
      return m;
    };
    M.cached = (tab, row) => metrics.get(tab + "\u0001" + row.key) || null;
    function finish(cells, fails, checked) { return {cells, fails, status: fails.size ? "fail" : checked ? "pass" : "none"}; }
    function compute(tab, row) {
      if (tab === "nets") return netMetrics(row.name);
      if (tab === "classes") return classMetrics(row);
      if (tab === "signals" || tab === "tags") return classMetrics(row, SCOPES[tab](row));
      if (tab === "pairs") return pairMetrics(row);
      if (tab === "groups") return groupMetrics(row);
      if (tab === "xsignals") return xsMetrics(row);
      if (tab === "physical") return physicalMetrics(row);
      return finish({}, new Set(), false);
    }
    function netMetrics(net) {
      const a = netActual(net), cells = {}, fails = new Set();
      let checked = false;
      const layer = a.layer || "Top";
      const w = q("width", {net, layer}), len = q("length", {net}), clr = q("clearance", {net, net2: "", layer});
      cells.widthMin = w?.min ?? null; cells.widthMax = w?.max ?? null; cells.profile = w?.impedanceProfile || ""; cells.zTarget = zText(w);
      cells.widthActual = fmtRange(a.wmin, a.wmax);
      // Width: every layer the net uses against its own effective rule there.
      for (const [l, v] of a.layers) {
        const c = l === layer ? w : q("width", {net, layer: l});
        if (!c) continue;
        checked = true;
        if (c.min != null && v.wmin + EPS < c.min || c.max != null && v.wmax - EPS > c.max) fails.add("widthActual");
      }
      cells.lengthMin = len?.min ?? null; cells.lengthMax = len?.max ?? null;
      cells.length = a.length; cells.delay = a.delay; cells.vias = a.vias;
      const dl = Rl.types.delay ? q("delay", {net}) : null; cells.delayMin = dl?.min ?? null; cells.delayMax = dl?.max ?? null;
      if (dl && a.length > EPS) { checked = true; if (dl.min != null && a.delay + EPS < dl.min || dl.max != null && a.delay - EPS > dl.max) fails.add("delay"); }
      if (len) { checked = true; if (a.length + EPS < len.min || len.max != null && a.length - EPS > len.max) fails.add("length"); }
      cells.clearance = clr?.gap ?? null;
      if (w?.impedance && a.width) {
        checked = true;
        const z = impedance(layer, a.width, null, w.impedanceProfile);
        cells.z = z;
        if (z != null && Math.abs(z - w.impedance.target) > w.impedance.target * w.impedance.tolerance / 100 + 1e-9) fails.add("z");
      } else cells.z = null;
      cells.rules = [w, len, clr].filter(Boolean).map(c => c.ruleName).join(", ");
      cells.name = net; cells.classes = M.classesOf(net).join(", "); cells.pair = M.pairOf(net)?.name || "";
      const out = finish(cells, fails, checked);
      out.heavy = () => { if (cells.z == null && a.width && !w?.impedance) cells.z = impedance(layer, a.width, null, null); };
      out.actual = a;
      return out;
    }
    function classMetrics(row, scope = {kind: "netclass", value: row.name}) {
      const c = row.name, cells = {name: c, members: row.members, template: row.template, kind: row.kind, tags: row.tags, roles: row.roles, list: row.list}, fails = new Set();
      const w = ruleFor("width", scope), len = ruleFor("length", scope), ml = ruleFor("matchedLengths", scope), clr = ruleFor("clearance", scope);
      const shown = (r, eff, k) => r ? r[k] : eff?.[k] ?? null;
      const any = row.nets[0] || "";
      const ew = q("width", {net: any}), el = q("length", {net: any}), ec = q("clearance", {net: any, net2: ""});
      cells.widthMin = shown(w, ew, "min"); cells.widthMax = shown(w, ew, "max"); cells.profile = (w || ew)?.impedanceProfile || "";
      cells.lengthMin = shown(len, el, "min"); cells.lengthMax = shown(len, el, "max"); cells.tolerance = ml?.tolerance ?? null; cells.clearance = shown(clr, ec, "gap");
      cells.inherited = {widthMin: !w, widthMax: !w, profile: !w, lengthMin: !len, lengthMax: !len, clearance: !clr};
      let failing = 0, longest = 0, shortest = Infinity, checked = false;
      for (const n of row.nets) {
        const m = M.metrics("nets", {key: n, name: n});
        if (m.status === "fail") failing++;
        if (m.status !== "none") checked = true;
        const l = m.cells.length || 0; longest = Math.max(longest, l); shortest = Math.min(shortest, l);
      }
      cells.failing = failing; cells.longest = longest; cells.spread = row.nets.length ? longest - shortest : 0;
      if (failing) fails.add("failing");
      if (ml && row.nets.length && longest - shortest > ml.tolerance + EPS) { fails.add("spread"); checked = true; }
      return finish(cells, fails, checked);
    }
    // Coupled gap (length-weighted mean of near-parallel segment gaps) and uncoupled length (sampled, as DRC).
    function coupling(P, N, gapMax) {
      let gapSum = 0, gapLen = 0, uncoupled = 0;
      const segs = ts => { const out = []; for (const t of ts) for (let k = 1; k < t.points.length; k++) out.push({a: t.points[k - 1], b: t.points[k], w: t.width || 0, layer: t.layer}); return out; };
      const p = segs(P), n = segs(N);
      const proj = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy; let t = l ? ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy); };
      for (const [own, other] of [[p, n], [n, p]]) {
        let un = 0;
        for (const s of own) {
          const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), steps = Math.max(1, Math.min(100, Math.ceil(len / .2)));
          const mates = other.filter(o => o.layer === s.layer);
          for (let k = 0; k < steps; k++) {
            const qq = [s.a[0] + (s.b[0] - s.a[0]) * (k + .5) / steps, s.a[1] + (s.b[1] - s.a[1]) * (k + .5) / steps];
            let g = Infinity; for (const o of mates) g = Math.min(g, proj(qq, o.a, o.b) - o.w / 2 - s.w / 2);
            if (g <= (gapMax ?? .3) + EPS) { gapSum += Math.max(0, g) * len / steps; gapLen += len / steps; } else un += len / steps;
          }
        }
        uncoupled = Math.max(uncoupled, un);
      }
      return {gap: gapLen > EPS ? gapSum / gapLen : null, uncoupled};
    }
    function pairMetrics(row) {
      const pos = netActual(row.positive), neg = netActual(row.negative), cells = {...row}, fails = new Set();
      const layer = pos.layer || neg.layer || "Top";
      const dp = q("diffPairsRouting", {pairName: row.name, layer});
      let checked = false;
      for (const k of ["widthMin", "widthMax", "gapMin", "gapMax", "maxUncoupled"]) cells[k] = dp?.[k] ?? null;
      cells.profile = dp?.impedanceProfile || ""; cells.zTarget = zText(dp);
      cells.lengthP = pos.length; cells.lengthN = neg.length; cells.skew = Math.abs(pos.length - neg.length); cells.delaySkew = Math.abs(pos.delay - neg.delay);
      cells.vias = pos.vias + neg.vias;
      const grp = Rl.matchedGroups(doc, {rules: set, nets: [row.positive, row.negative]}).find(g => g.withinPair && g.pairs.some(p => p.name === row.name));
      cells.skewMax = grp ? grp.pairTolerance : null;
      if (grp) { checked = true; if (cells.skew > grp.pairTolerance + EPS) fails.add("skew"); }
      if (dp) {
        checked = true;
        const wmin = Math.min(pos.wmin ?? Infinity, neg.wmin ?? Infinity), wmax = Math.max(pos.wmax ?? -Infinity, neg.wmax ?? -Infinity);
        if (Number.isFinite(wmin) && wmin + EPS < dp.widthMin) fails.add("widthMin");
        if (Number.isFinite(wmax) && dp.widthMax != null && wmax - EPS > dp.widthMax) fails.add("widthMax");
      }
      const out = finish(cells, fails, checked);
      // Coupling and impedance: per painted row.
      out.heavy = () => {
        if (out.heavyDone) return; out.heavyDone = true;
        const e = M.index().nets;
        const c = coupling(e.get(row.positive)?.tracks || [], e.get(row.negative)?.tracks || [], dp?.gapMax);
        cells.gapActual = c.gap; cells.uncoupled = c.uncoupled;
        if (dp) {
          if (c.gap != null && c.gap + EPS < dp.gapMin) fails.add("gapActual");
          if (dp.maxUncoupled != null && c.uncoupled - EPS > dp.maxUncoupled) fails.add("uncoupled");
        }
        const w = pos.width || neg.width;
        cells.z = w && c.gap != null ? impedance(layer, w, c.gap, dp?.impedanceProfile) : null;
        if (dp?.impedance && cells.z != null && Math.abs(cells.z - dp.impedance.target) > dp.impedance.target * dp.impedance.tolerance / 100 + 1e-9) fails.add("z");
        out.status = fails.size ? "fail" : out.status;
      };
      return out;
    }
    function groupMetrics(row) {
      const g = row.group, cells = {name: row.name, kind: row.kind, members: row.members, list: row.list}, fails = new Set();
      cells.tolerance = row.rule?.tolerance ?? g.tolerance ?? null; cells.pairTolerance = row.rule ? (row.rule.withinPair ? row.rule.pairTolerance : null) : g.withinPair ? g.pairTolerance : null;
      const routed = g.members.filter(m => !m.unrouted);
      cells.target = g.target; cells.longest = g.longest ?? Math.max(0, ...routed.map(m => m.length));
      cells.shortest = routed.length ? Math.min(...routed.map(m => m.length)) : 0; cells.spread = cells.longest - cells.shortest;
      const delays = routed.map(m => m.delay || 0); cells.delaySpread = delays.length ? Math.max(...delays) - Math.min(...delays) : 0;
      cells.delayTarget = g.basis === "delay" ? g.targetDelay : null; if (g.basis === "delay" && g.delaySpread != null) cells.delaySpread = g.delaySpread;
      cells.worstSkew = Math.max(0, ...g.members.map(m => Math.abs(m.skew || 0)));
      cells.failing = g.members.filter(m => m.status && m.status !== "pass").length;
      if (cells.failing) fails.add("failing");
      if (g.members.some(m => m.status === "short" || m.status === "long")) fails.add("spread");
      if (g.members.some(m => m.status === "skew")) fails.add("worstSkew");
      return finish(cells, fails, true);
    }
    function ruleFor(type, scope) {
      return set.list.filter(r => r.type === type && r.enabled && sameScope(r.scope, scope) && (!r.scope2 || globalThis.AtriumDesignQueryRecord.isAll(r.scope2))).sort((a, b) => a.priority - b.priority)[0] || null;
    }
    M.ruleFor = ruleFor;
    function physicalMetrics(row) {
      const cells = {name: row.name, scopeKind: row.scopeKind}, fails = new Set(), inherited = {};
      const w = ruleFor("width", row.scope), v = ruleFor("viaStyle", row.scope);
      const sample = row.scope.kind === "netclass" ? {net: set.netClasses[row.scope.value]?.[0] || "", layer: "Top"} : row.scope.kind === "layer" ? {net: "", layer: row.layer} : {net: "", layer: "Top"};
      const ew = w || q("width", sample), ev = v || q("viaStyle", {net: sample.net});
      const map = [["widthMin", ew, "min", w], ["widthPref", ew, "preferred", w], ["widthMax", ew, "max", w], ["profile", ew, "impedanceProfile", w],
        ["viaMin", ev, "diameterMin", v], ["viaPref", ev, "diameterPreferred", v], ["viaMax", ev, "diameterMax", v], ["holeMin", ev, "holeMin", v], ["holePref", ev, "holePreferred", v], ["holeMax", ev, "holeMax", v]];
      for (const [k, src, f, own] of map) { cells[k] = src?.[f] ?? (k === "profile" ? "" : null); inherited[k] = !own; }
      cells.inherited = inherited;
      const out = finish(cells, fails, !!(w || v));
      out.heavy = () => {
        if (out.heavyDone) return; out.heavyDone = true;
        const all = M.index().all, members = row.scope.kind === "netclass" ? new Set(set.netClasses[row.scope.value] || []) : null;
        const inScope = t => row.scope.kind === "all" || (members ? members.has(t.net) : t.layer === row.layer);
        let n = 0, lo = Infinity, hi = -Infinity, bad = 0, vias = 0;
        const wc = new Map(), vc = new Map();
        for (const t of all.tracks) {
          if (!inScope(t)) continue;
          n++; lo = Math.min(lo, t.width); hi = Math.max(hi, t.width);
          const key = t.net + "\u0001" + t.layer;
          let c = wc.get(key); if (c === undefined) wc.set(key, c = q("width", {net: t.net, layer: t.layer}));
          if (c && (c.min != null && t.width + EPS < c.min || c.max != null && t.width - EPS > c.max)) bad++;
        }
        if (row.scope.kind !== "layer") for (const x of all.vias) {
          if (members && !members.has(x.net)) continue;
          vias++;
          let c = vc.get(x.net); if (c === undefined) vc.set(x.net, c = q("viaStyle", {net: x.net}));
          if (c && (c.holeMin != null && x.drill + EPS < c.holeMin || c.holeMax != null && x.drill - EPS > c.holeMax || c.diameterMin != null && x.diameter + EPS < c.diameterMin || c.diameterMax != null && x.diameter - EPS > c.diameterMax)) bad++;
        }
        cells.tracks = n; cells.narrowest = n ? lo : null; cells.widest = n ? hi : null; cells.viaCount = row.scope.kind === "layer" ? null : vias; cells.violations = bad;
        if (bad) { fails.add("violations"); out.status = "fail"; } else if (out.status === "none" && n) out.status = "pass";
      };
      return out;
    }
    // ---- clearance matrix (Spacing): rule cells between class pairs.
    M.spacing = () => {
      const names = ["All", ...Object.keys(set.netClasses || {}).sort(natural)];
      const scopeOf = n => n === "All" ? {kind: "all"} : {kind: "netclass", value: n};
      const cell = (a, b) => {
        const sa = scopeOf(a), sb = scopeOf(b);
        const r = set.list.filter(x => x.type === "clearance" && x.enabled && (sameScope(x.scope, sa) && sameScope(x.scope2, sb) || sameScope(x.scope, sb) && sameScope(x.scope2, sa))).sort((x, y) => x.priority - y.priority)[0];
        if (r) return {gap: r.gap, rule: r.name, own: true};
        const na = a === "All" ? "" : set.netClasses[a]?.[0] || "", nb = b === "All" ? "" : set.netClasses[b]?.[0] || "";
        const e = q("clearance", {net: na, net2: nb});
        return {gap: e?.gap ?? null, rule: e?.ruleName || "", own: false};
      };
      return {names, cell};
    };
    return M;
  }
  const pickerScope = scope => scope?.languageVersion !== undefined ? globalThis.AtriumDesignQueryRecord.toSelector(scope) : scope;
  function sameScope(a, b) {
    const left = pickerScope(a), right = pickerScope(b);
    return !!left && !!right && left.kind === right.kind && (left.kind === "all" || left.value === right.value);
  }
  function isTemplate(set, kind, name) { return set.list.some(r => sameScope(r.scope, {kind, value: name}) && String(r.comment || "").startsWith(MARK)); }

  // ------------------------------------------------------------------ writing rules
  function uniqueName(set, base) {
    const taken = new Set(set.list.map(r => r.name.toLowerCase()));
    base = String(base).replace(/\s+/g, "_").slice(0, 120);
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!taken.has((base + "_" + n).toLowerCase())) return base + "_" + n;
  }
  function uniqueId(set, type) { const ids = new Set(set.list.map(r => r.id)); let n = 1; while (ids.has("cm-" + type + "-" + n)) n++; return "cm-" + type + "-" + n; }
  const scopeLabel = s => s.kind === "all" ? "All" : s.value;
  // The rule of `type` scoped exactly to `scope` (scope2 All or `scope2`), created at the top
  // priority from `base` (the effective rule for that scope) when missing.
  function ownRule(set, type, scope, scope2, base, comment) {
    const T = R().types[type];
    let r = set.list.filter(x => x.type === type && sameScope(x.scope, scope) && (!T.two || sameScope(x.scope2 || {kind: "all"}, scope2 || {kind: "all"}))).sort((a, b) => a.priority - b.priority)[0];
    if (r) return promote(set, r);
    const src = base?.ruleId ? set.list.find(x => x.id === base.ruleId) : null;
    r = {id: uniqueId(set, type), type, name: uniqueName(set, T.altium + "_" + scopeLabel(scope) + (T.two && scope2 && scope2.kind !== "all" ? "_" + scopeLabel(scope2) : "")),
      comment: comment || "Constraint Manager override", enabled: true, priority: .5, scope: globalThis.AtriumDesignQueryRecord.fromSelector(scope)};
    if (T.two) r.scope2 = globalThis.AtriumDesignQueryRecord.fromSelector(scope2);
    for (const f of T.fields) { const v = src && src[f.key] !== undefined ? src[f.key] : f.def; if (!(f.omitNull && v == null)) r[f.key] = v == null ? (f.optional ? null : v) : clone(v); }
    set.list.push(r);
    return r;
  }
  // An edited rule must be the one that applies: enable it and lift it above every other rule of
  // its type that is as broad or broader (it is scoped exactly to the edited row). The status message says so.
  const promotedBy = new WeakMap();
  function promote(set, r) {
    const notes = [];
    if (r.enabled === false) { r.enabled = true; notes.push("enabled"); }
    // Only rules as broad or broader than this one (All < class < net): more specific rules keep winning where they apply.
    const rank = x => [x.scope, x.scope2].reduce((n, sc) => {
      const kind = pickerScope(sc)?.kind;
      return n + (!sc || kind === "all" ? 0 : kind?.endsWith("class") ? 1 : 2);
    }, 0);
    const others = set.list.filter(x => x !== r && x.type === r.type && rank(x) <= rank(r)).map(x => x.priority);
    if (others.length && r.priority >= Math.min(...others)) { r.priority = Math.min(...others) - .5; notes.push("moved to the top priority"); }
    if (notes.length) promotedBy.set(r, notes);
    return r;
  }
  const promoted = r => promotedBy.has(r) ? " (" + promotedBy.get(r).join(", ") + " so it applies)" : "";
  const SCOPES = {nets: row => ({kind: "net", value: row.name}), classes: row => ({kind: "netclass", value: row.name}), pairs: row => ({kind: "diffpair", value: row.name}), physical: row => row.scope,
    signals: row => ({kind: "signal", value: row.name}), tags: row => ({kind: "tag", value: row.name}),
    xsignals: row => row.source === "xSignal" ? {kind: "xsignal", value: row.name} : {kind: "net", value: row.netList[0]}};
  // Parse a typed value for a column: lengths in `unit` (blank clears an optional value), profiles by name.
  function parseValue(c, text, unit = "mm") {
    if (text == null || typeof text === "number") return text;
    const s = String(text).trim();
    if (c.key === "profile") return s || null;
    if (!s) return null;
    if (c.kind === "ps") { const t = /^(\d*\.?\d+)\s*(ps|ns)?$/i.exec(s); if (!t) fail("Enter a delay, e.g. 120 ps or 0.5 ns."); return +t[1] * (/ns/i.test(t[2] || "") ? 1000 : 1); }
    const v = R().units.parse(s, unit);
    if (!Number.isFinite(v)) fail("Enter a length, e.g. 0.2 or 8 mil.");
    return v;
  }
  // Write one cell into a (cloned, effective) rules set. Returns a description of the change.
  function setCell(set, tab, row, key, value, M) {
    const c = (COLUMNS[tab] || []).find(x => x.key === key);
    if (!c?.edit) fail("The " + (c?.label || key) + " column is not editable.");
    const [type, field] = c.edit, T = R().types[type], f = T.fields.find(x => x.key === field);
    if (value == null && !(f.optional || f.omitNull) && !(type === "matchedLengths" && field === "pairTolerance")) fail(c.label + " needs a value.");
    let r;
    if (tab === "groups") {
      r = row.rule ? set.list.find(x => x.id === row.rule.id) : null;
      if (!r) fail("Group " + row.name + " is not a Matched Lengths rule. Add a Matched Lengths rule for it in the Rules editor.");
      if (field === "pairTolerance") r.withinPair = value != null;
      if (value != null) r[field] = value;
    } else if (type === "matchedLengths" && tab === "pairs") {
      r = ownRule(set, type, SCOPES.pairs(row), null, null);
      r.withinPair = value != null; if (value != null) { r.pairTolerance = value; r.tolerance = Math.max(r.tolerance ?? value, value); }
    } else {
      const scope = SCOPES[tab](row);
      // Topology typed as its label (Fly-by, T-branch, Daisy-Simple ...) or its key.
      if (type === "routingTopology" && field === "topology" && typeof value === "string") {
        const k = value.toLowerCase().replace(/[^a-z]/g, ""), opt = f.options.find(([key, label]) => key.toLowerCase() === k || label.toLowerCase().replace(/[^a-z]/g, "") === k);
        if (!opt) fail("Topology must be one of " + f.options.map(o => o[1]).join(", ") + ".");
        value = opt[0];
      }
      const probe = tab === "xsignals" ? {net: row.netList[0] || ""} : tab === "nets" ? {net: row.name} : tab === "pairs" ? {pairName: row.name} : tab === "classes" ? {net: set.netClasses?.[row.name]?.[0] || ""} : tab === "signals" || tab === "tags" ? {net: row.nets?.[0] || ""} : {net: "", layer: row.layer};
      const base = M?.q ? M.q(type, T.two ? {...probe, net2: ""} : probe) : null;
      r = ownRule(set, type, scope, null, base);
      if (field === "impedanceProfile" && value == null) delete r.impedanceProfile; else r[field] = value;
    }
    return (r.name + " · " + f.label + " = " + (value == null ? "none" : typeof value === "number" ? r4(value) + (c.kind === "ps" ? " ps" : " mm") : value)) + promoted(r);
  }
  // Spacing: clearance between two scopes ("All" or a class name).
  function setSpacing(set, a, b, gap) {
    const sc = n => n === "All" ? {kind: "all"} : {kind: "netclass", value: n};
    if (gap == null) fail("Clearance needs a value.");
    const sa = sc(a), sb = sc(b);
    let r = set.list.filter(x => x.type === "clearance" && (sameScope(x.scope, sa) && sameScope(x.scope2, sb) || sameScope(x.scope, sb) && sameScope(x.scope2, sa))).sort((x, y) => x.priority - y.priority)[0];
    if (!r) r = ownRule(set, "clearance", sa, sb, null); else promote(set, r);
    r.gap = gap;
    return r.name + " · gap = " + r4(gap) + " mm" + promoted(r);
  }
  // DFA: the first dfaSpacing rule (created from the default matrix when missing).
  function dfaRule(set, create) {
    let r = set.list.filter(x => x.type === "dfaSpacing").sort((a, b) => a.priority - b.priority)[0];
    if (!r && create) {
      const D = globalThis.AtriumDFA;
      if (!R().types.dfaSpacing) fail("This build has no DFA spacing rule.");
      r = D ? D.defaultRule({id: uniqueId(set, "dfaSpacing"), name: uniqueName(set, "DFASpacing")}) : null;
      if (!r) { r = {id: uniqueId(set, "dfaSpacing"), type: "dfaSpacing", name: uniqueName(set, "DFASpacing"), comment: "", enabled: true, priority: 1, scope: globalThis.AtriumDesignQueryRecord.selector("all")}; for (const f of R().types.dfaSpacing.fields) r[f.key] = clone(f.def); }
      set.list.push(r);
    }
    return r || null;
  }
  function setDfa(set, change) {
    const r = dfaRule(set, true), D = globalThis.AtriumDFA;
    if (change.a && change.b) {
      if (D) D.setGap(r, change.a, change.b, change.gap ?? null);
      else { r.matrix = r.matrix.filter(e => !(e.a === change.a && e.b === change.b || e.a === change.b && e.b === change.a)); if (change.gap != null) r.matrix.push({a: change.a, b: change.b, gap: change.gap}); }
      return r.name + " · " + change.a + "–" + change.b + " = " + (change.gap == null ? "removed" : r4(change.gap) + " mm");
    }
    for (const k of ["defaultGap", "measure", "sides", "enabled"]) if (change[k] !== undefined) r[k] = change[k];
    return r.name + " updated";
  }

  // ------------------------------------------------------------------ templates (ECSets)
  function templates(set) {
    const out = [];
    for (const [kind, key, member] of [["netclass", "netClasses", "net"], ["diffpairclass", "diffPairClasses", "pair"]])
      for (const [name, members] of Object.entries(set[key] || {})) if (isTemplate(set, kind, name))
        out.push({name, kind: member, members: [...members], rules: set.list.filter(r => sameScope(r.scope, {kind, value: name})).map(r => r.name)});
    return out.sort((a, b) => natural(a.name, b.name));
  }
  // from: {net} or {pair}. Copies the effective constraints of that net or pair into class rules.
  function createTemplate(set, name, from, M) {
    if (typeof name !== "string" || !name.trim() || name.trim() !== name || name.length > 128) fail("Name the template (up to 128 characters).");
    if (set.netClasses?.[name] || set.diffPairClasses?.[name]) fail("A class is already named " + name + ".");
    const q = M?.q || R().resolver(M?.doc || null, {rules: set});
    const made = [];
    const add = (type, scope, eff, keys) => {
      if (!eff) return;
      const T = R().types[type], src = eff.ruleId ? set.list.find(x => x.id === eff.ruleId) : null;
      const r = {id: uniqueId(set, type), type, name: uniqueName(set, name + "_" + T.altium), comment: MARK + " " + name + ".", enabled: true, priority: .5, scope: globalThis.AtriumDesignQueryRecord.fromSelector(scope)};
      if (T.two) r.scope2 = globalThis.AtriumDesignQueryRecord.selector("all");
      for (const f of T.fields) { const v = src?.[f.key] !== undefined ? src[f.key] : eff[f.key] !== undefined && keys.includes(f.key) ? eff[f.key] : f.def; if (!(f.omitNull && v == null)) r[f.key] = v == null ? null : clone(v); }
      set.list.push(r); made.push(r.name);
    };
    if (from.net) {
      const net = from.net, scope = {kind: "netclass", value: name};
      (set.netClasses ||= {})[name] = [net];
      add("width", scope, q("width", {net}), ["min", "preferred", "max"]);
      add("length", scope, q("length", {net}), ["min", "max"]);
      add("clearance", scope, q("clearance", {net, net2: ""}), ["gap"]);
      add("viaStyle", scope, q("viaStyle", {net}), ["holeMin", "holeMax", "diameterMin", "diameterMax"]);
      if (!made.length) fail("Net " + net + " has no constraints to copy.");
    } else if (from.pair) {
      const p = (set.diffPairs || []).find(x => x.name === from.pair) || fail("No differential pair is named " + from.pair + ".");
      const scope = {kind: "diffpairclass", value: name};
      (set.diffPairClasses ||= {})[name] = [p.name];
      add("diffPairsRouting", scope, q("diffPairsRouting", {pairName: p.name}), ["widthMin", "widthPreferred", "widthMax", "gapMin", "gapPreferred", "gapMax", "maxUncoupled"]);
      const g = R().matchedGroups(null, {rules: set, nets: [p.positive, p.negative]}).find(x => x.pairs.some(y => y.name === p.name));
      if (g) add("matchedLengths", scope, {tolerance: g.tolerance, withinPair: g.withinPair, pairTolerance: g.pairTolerance}, ["tolerance", "withinPair", "pairTolerance"]);
      if (!made.length) fail("Pair " + p.name + " has no constraints to copy.");
    } else fail("Create a template from a net or a differential pair.");
    return {template: name, rules: made};
  }
  function applyTemplate(set, name, members) {
    const t = templates(set).find(x => x.name === name) || fail("No template is named " + name + ".");
    const key = t.kind === "pair" ? "diffPairClasses" : "netClasses", list = set[key][name], have = new Set(list);
    if (t.kind === "pair") { const pairs = new Set((set.diffPairs || []).map(p => p.name)); for (const m of members) if (!pairs.has(m)) fail("No differential pair is named " + m + "."); }
    let added = 0;
    for (const m of members) if (!have.has(m)) { list.push(m); have.add(m); added++; }
    return {template: name, kind: t.kind, added, members: list.length};
  }

  // ------------------------------------------------------------------ CSV
  function csvCell(v) {
    let s = v == null ? "" : typeof v === "number" ? String(r4(v)) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v !== "number") s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv(M, tab, o = {}) {
    if (tab === "spacing") {
      const sp = M.spacing();
      return [["", ...sp.names], ...sp.names.map(a => [a, ...sp.names.map(b => sp.cell(a, b).gap)])].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    }
    const cols = (o.keys ? o.keys.map(k => COLUMNS[tab].find(c => c.key === k)).filter(Boolean) : COLUMNS[tab].filter(c => !c.hidden));
    const rows = o.rows || M.rows(tab), lines = [cols.map(c => csvCell(c.label + (c.kind === "len" ? " (mm)" : c.kind === "ps" ? " (ps)" : c.kind === "ohm" ? " (Ω)" : ""))).join(",")];
    for (const row of rows) {
      const m = M.metrics(tab, row); m.heavy?.();
      lines.push(cols.map(c => csvCell(c.key === "status" ? m.status : m.cells[c.key] ?? row[c.key])).join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  // ------------------------------------------------------------------ MCP (headless.js op "constraints")
  function headless(a, H) {
    const p = a.action === "list" ? H.project() : H.mutable(), doc = H.board(p, a.document_id), defs = H.defsOf(p);
    const tab = a.tab || "nets";
    if (a.action === "list") {
      const M = model(p, doc, defs);
      if (tab === "templates") return {document_id: doc.id, tab, ...H.page(templates(M.set), a)};
      if (tab === "spacing") { const sp = M.spacing(); return {document_id: doc.id, tab, units: "mm", classes: sp.names, matrix: sp.names.map(x => sp.names.map(y => r4(sp.cell(x, y).gap)))}; }
      if (tab === "dfa") {
        const D = globalThis.AtriumDFA, r = dfaRule(M.set, false);
        const types = D ? [...D.boardTypes(doc, defs)].map(([type, count]) => ({type, count})) : [];
        const res = r && D ? D.check(doc, defs, r, {limit: 500}) : {violations: []};
        return {document_id: doc.id, tab, units: "mm", rule: r ? {name: r.name, enabled: r.enabled, measure: r.measure, sides: r.sides, default_gap: r.defaultGap, matrix: r.matrix} : null,
          package_types: types, ...H.page(res.violations.map(v => ({refs: v.refs, types: v.types, actual: r4(v.actual), required: r4(v.required), at: v.at.map(r4)})), a)};
      }
      if (!COLUMNS[tab]) fail("Unknown tab " + tab + ". Use nets, signals, classes, tags, pairs, groups, xsignals, physical, spacing, dfa or templates.");
      const f = String(a.filter || "").toLowerCase();
      let rows = M.rows(tab).filter(r => !f || String(r.name).toLowerCase().includes(f));
      const cols = COLUMNS[tab];
      let items = rows.map(r => { const m = M.metrics(tab, r); m.heavy?.(); const o = {name: r.name, status: m.status}; for (const c of cols) if (c.key !== "name" && c.key !== "status") { const v = m.cells[c.key] ?? r[c.key]; if (v != null && v !== "") o[c.key] = typeof v === "number" ? r4(v) : v; } if (m.fails.size) o.failing = [...m.fails]; return o; });
      if (a.failing_only) items = items.filter(x => x.status === "fail");
      return {document_id: doc.id, tab, units: "mm", columns: cols.map(c => ({key: c.key, label: c.label, editable: !!c.edit, ...(c.edit ? {rule_type: c.edit[0], field: c.edit[1]} : {})})), ...H.page(items, a)};
    }
    const set = clone(R().effective(doc, p)), done = [];
    if (a.action === "set") {
      const M = model(p, doc, defs);
      for (const ch of a.changes || [a]) {
        const t = ch.tab || tab;
        if (t === "spacing") done.push(setSpacing(set, ch.name, ch.other || ch.key, ch.value));
        else if (t === "dfa") done.push(setDfa(set, {a: ch.name, b: ch.other || ch.key, gap: ch.value, ...(ch.settings || {})}));
        else {
          const row = M.rows(t).find(r => r.name === ch.name || r.key === ch.name) || fail("No " + t + " row is named " + ch.name + ".");
          done.push(setCell(set, t, row, ch.key, typeof ch.value === "string" ? parseValue(COLUMNS[t].find(c => c.key === ch.key) || {}, ch.value) : ch.value, M));
        }
      }
    } else if (a.action === "apply_template") {
      if (!templates(set).some(t => t.name === a.template)) {
        if (!a.create_from) fail("No template is named " + a.template + ". Pass create_from {net} or {pair} to create it.");
        done.push("Created template " + a.template + ": " + createTemplate(set, a.template, a.create_from, model(p, doc, defs)).rules.join(", "));
      }
      if ((a.members || []).length) { const r = applyTemplate(set, a.template, a.members); done.push("Applied " + a.template + " to " + r.added + " " + r.kind + (r.added === 1 ? "" : "s")); }
    } else fail("Unknown constraints action " + a.action + ".");
    R().store(doc, p, set);
    H.touched();
    return {document_id: doc.id, action: a.action, applied: done};
  }

  // ------------------------------------------------------------------ UI
  const STORE = "atrium-constraints-v1";
  const loadPrefs = () => { try { const v = JSON.parse(globalThis.localStorage?.getItem(STORE) || "null"); return plain(v) ? v : {}; } catch { return {}; } };
  const savePrefs = v => { try { globalThis.localStorage?.setItem(STORE, JSON.stringify(v)); } catch { /* private window */ } };
  let openDialog = null;
  function open(ctx) {
    const host = globalThis.AtriumNavHost;
    if (openDialog?.isConnected) { openDialog.querySelector(".cm-search")?.focus(); return openDialog; }
    const project = () => host?.project?.() || ctx.project;
    const board0 = ctx.doc?.kind === "pcb" ? ctx.doc : project().documents.find(d => d.kind === "pcb");
    if (!board0) { ctx.info?.("Open a board layout first."); return null; }
    const boardId = board0.id, board = () => project().documents.find(d => d.id === boardId) || board0;
    const defs = () => host?.defs?.() || ctx.defs, revision = () => host?.revision?.() ?? ctx.revision?.() ?? 0, unit = () => host?.units?.() || "mm";
    const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
    const button = (text, fn, cls, title) => { const b = el("button", text, cls); if (!b.classList.contains("ui-tab")) b.classList.add("ui-button"); if (cls === "primary") b.dataset.variant = "primary"; b.type = "button"; b.onclick = fn; if (title) b.title = title; return b; };
    const prefs = loadPrefs();
    const state = {tab: TABS.some(([k]) => k === prefs.tab) ? prefs.tab : "nets", query: "", failing: false, sel: new Set(), anchor: null, per: {}};
    const per = tab => state.per[tab] ||= {order: Array.isArray(prefs[tab]?.order) ? prefs[tab].order : COLUMNS[tab]?.map(c => c.key) || [],
      hidden: new Set(Array.isArray(prefs[tab]?.hidden) ? prefs[tab].hidden : (COLUMNS[tab] || []).filter(c => c.hidden).map(c => c.key)),
      widths: plain(prefs[tab]?.widths) ? prefs[tab].widths : {}, sort: plain(prefs[tab]?.sort) ? prefs[tab].sort : {key: "name", dir: 1}, filters: {}};
    const remember = () => { const out = {tab: state.tab}; for (const [k, v] of Object.entries(state.per)) out[k] = {order: v.order, hidden: [...v.hidden], widths: v.widths, sort: v.sort}; savePrefs(out); };
    let M = null, mRev = -1;
    const getModel = () => { const r = revision(); if (!M || mRev !== r || M.doc !== board()) { M = model(project(), board(), defs(), {revision: r}); mRev = r; } return M; };

    const d = el("dialog", null, "ui-dialog ui-sheet work-dialog cm-dialog"); d.dataset.grid = ""; d.setAttribute("aria-label", "Constraint Manager");
    const grip = el("div", null, "cm-grip"); grip.title = "Drag to resize";
    const head = el("div", null, "cm-head"), titles = el("div"), summary = el("p", null, "cm-summary"); summary.setAttribute("role", "status");
    titles.append(el("h2", "Constraint Manager", "ui-dialog-title ui-sheet-title"), summary);
    const tabs = el("div", null, "cm-tabs ui-tabs"); tabs.dataset.boxed = ""; tabs.setAttribute("role", "tablist");
    for (const [k, label] of TABS) { const b = button(label, () => switchTab(k), "cm-tab ui-tab"); b.setAttribute("role", "tab"); b.dataset.tab = k; tabs.append(b); }
    const close = button("×", () => d.close(), "ui-close cm-close", "Close"); close.setAttribute("aria-label", "Close");
    head.append(titles, tabs, close);
    const tools = el("div", null, "cm-toolbar");
    const search = el("input", null, "cm-search ui-field"); search.type = "search"; search.placeholder = "Filter rows"; search.setAttribute("aria-label", "Filter rows");
    const failing = button("Failing only", () => { state.failing = !state.failing; failing.setAttribute("aria-pressed", String(state.failing)); repaint(); }, "cm-toggle", "Show only rows that fail a constraint");
    failing.setAttribute("aria-pressed", "false"); failing.dataset.variant = "secondary"; // the library's pressed toggle face
    const colsBtn = button("Columns", () => toggleColumns(), null, "Show, hide and reorder columns");
    const tplBtn = button("Templates", () => toggleTemplates(), null, "ECSet-style templates: create from the selected net or pair, apply to the selected rows");
    const csvBtn = button("Export CSV", () => exportCsv(), null, "Export this sheet as CSV");
    const runBtn = button("Check clearance", () => runClearance(), null, "Run the clearance check and count violations per class pair");
    tools.append(AtriumUI.searchField(search, {cls: "cm-find", type: true}), failing, colsBtn, tplBtn, runBtn, csvBtn);
    const body = el("div", null, "cm-body ui-dialog-body"), wrap = el("div", null, "cm-grid-wrap"); wrap.tabIndex = 0;
    const table = el("table", null, "cm-grid"), colgroup = el("colgroup"), thead = el("thead"), tbody = el("tbody");
    table.append(colgroup, thead, tbody); wrap.append(table);
    const side = el("div", null, "cm-side"); side.hidden = true;
    const matrix = el("div", null, "cm-matrix"); matrix.hidden = true;
    body.append(wrap, matrix, side);
    const status = el("p", null, "cm-status"); status.setAttribute("aria-live", "polite");
    d.append(grip, head, tools, body, status);
    d.addEventListener("close", () => { remember(); off.forEach(f => f?.()); openDialog = null; d.remove(); }, {once: true});
    const say = (t, bad) => { status.textContent = t; status.classList.toggle("bad", !!bad); };

    // -------- writing
    function commit(label, fn) {
      try {
        const doc = board(), set = clone(R().effective(doc, project()));
        const what = fn(set, getModel());
        R().validate(R().normalize(clone(set)));
        (host?.edit || ctx.edit)(() => { R().store(board(), project(), set); });
        say(Array.isArray(what) ? what.join("; ") : what || label);
        return true;
      } catch (e) { say(e.message, true); return false; }
    }

    // -------- grid
    const fmt = (c, v) => {
      if (v == null || v === "") return "";
      if (typeof v === "function") return "";
      if (c.kind === "len") return typeof v === "number" ? String(R().units.value(v, unit())) : String(v);
      if (c.kind === "ps") return typeof v === "number" ? v.toFixed(1) : String(v);
      if (c.kind === "ohm") return typeof v === "number" ? v.toFixed(1) : String(v);
      if (c.kind === "num") return typeof v === "number" ? String(r4(v)) : String(v);
      return String(v);
    };
    const visibleCols = () => { const p = per(state.tab), all = COLUMNS[state.tab]; const order = [...p.order.filter(k => all.some(c => c.key === k)), ...all.map(c => c.key).filter(k => !p.order.includes(k))]; return order.map(k => all.find(c => c.key === k)).filter(c => !p.hidden.has(c.key)); };
    let cols = [], rows = [];
    const widthOf = c => per(state.tab).widths[c.key] || (c.key === "name" ? 160 : c.kind === "text" ? 120 : c.key === "status" ? 70 : Math.max(84, Math.round((c.label.length + unitLabel(c).length) * 6.4 + 22)));
    const unitLabel = c => c.kind === "len" ? " (" + (unit() === "mil" ? "mil" : "mm") + ")" : c.kind === "ps" ? " (ps)" : c.kind === "ohm" ? " (Ω)" : "";
    function paintHead() {
      colgroup.replaceChildren(); let total = 0;
      for (const c of cols) { const g = el("col"); g.style.width = widthOf(c) + "px"; total += widthOf(c); colgroup.append(g); }
      table.style.width = total + "px";
      const p = per(state.tab), tr = el("tr"), fr = el("tr", null, "cm-filter-row");
      for (const c of cols) {
        const th = el("th"); th.scope = "col"; th.dataset.key = c.key; th.draggable = true;
        if (c.kind !== "text" && c.kind !== "status") th.classList.add("num");
        if (c.edit) th.classList.add("editable"); if (c.actual) th.classList.add("actual");
        th.setAttribute("aria-sort", p.sort.key === c.key ? (p.sort.dir < 0 ? "descending" : "ascending") : "none");
        const b = el("button", c.label + unitLabel(c), "cm-sort"); b.type = "button"; b.dataset.key = c.key; b.tabIndex = -1;
        b.title = (c.edit ? "Constraint (" + R().types[c.edit[0]].title + "). Double-click a cell to edit. " : c.actual ? "Actual value from the board. " : "") + "Click to sort · drag to move";
        if (p.sort.key === c.key) b.dataset.dir = p.sort.dir < 0 ? "▼" : "▲";
        const rs = el("span", null, "cm-resize"); rs.dataset.key = c.key;
        th.append(b, rs); tr.append(th);
        const fth = el("th"), input = el("input", null, "cm-filter ui-field"); input.dataset.key = c.key; input.value = p.filters[c.key] || ""; input.placeholder = c.key === "status" ? "fail / pass" : "Filter";
        input.setAttribute("aria-label", "Filter " + c.label); fth.append(input); fr.append(fth);
      }
      thead.replaceChildren(tr, fr);
    }
    thead.onclick = e => {
      const b = e.target.closest(".cm-sort"); if (!b) return;
      const p = per(state.tab), k = b.dataset.key;
      p.sort = {key: k, dir: p.sort.key === k ? -p.sort.dir : 1}; remember(); repaint();
    };
    let ft = 0;
    thead.oninput = e => { const i = e.target.closest(".cm-filter"); if (!i) return; const p = per(state.tab); if (i.value.trim()) p.filters[i.dataset.key] = i.value; else delete p.filters[i.dataset.key]; clearTimeout(ft); ft = setTimeout(repaint, 120); };
    thead.onpointerdown = e => {
      const g = e.target.closest(".cm-resize"); if (!g) return;
      e.preventDefault(); e.stopPropagation();
      const c = cols.find(x => x.key === g.dataset.key), x0 = e.clientX, w0 = widthOf(c), colEl = colgroup.children[cols.indexOf(c)];
      g.setPointerCapture?.(e.pointerId);
      const move = ev => { per(state.tab).widths[c.key] = Math.max(40, Math.min(600, Math.round(w0 + ev.clientX - x0))); colEl.style.width = widthOf(c) + "px"; table.style.width = cols.reduce((n, x) => n + widthOf(x), 0) + "px"; };
      const up = () => { g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); remember(); };
      g.addEventListener("pointermove", move); g.addEventListener("pointerup", up);
    };
    let dragKey = null;
    const dropOf = e => e.target.closest?.("th[data-key], .cm-colitem[data-key]");
    function onDragStart(e) { if (e.target.closest?.(".cm-resize")) { e.preventDefault(); return; } const t = dropOf(e); if (!t) return; dragKey = t.dataset.key; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragKey); } catch { /* old engines */ } }
    function onDragOver(e) {
      const t = dropOf(e); if (!dragKey || !t) return; e.preventDefault();
      const r = t.getBoundingClientRect(), vertical = t.classList.contains("cm-colitem"), before = vertical ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
      for (const x of d.querySelectorAll(".drop-before,.drop-after")) x.classList.remove("drop-before", "drop-after");
      t.classList.add(before ? "drop-before" : "drop-after");
    }
    function onDrop(e) {
      const t = dropOf(e); if (!dragKey || !t) return; e.preventDefault();
      const p = per(state.tab), after = t.classList.contains("drop-after"), to = t.dataset.key;
      if (to !== dragKey) { const order = visibleOrder(); order.splice(order.indexOf(dragKey), 1); order.splice(order.indexOf(to) + (after ? 1 : 0), 0, dragKey); p.order = order; remember(); repaint(); if (!side.hidden && side.dataset.kind === "columns") paintColumns(); }
      dragKey = null;
    }
    const visibleOrder = () => { const p = per(state.tab), all = COLUMNS[state.tab].map(c => c.key); return [...p.order.filter(k => all.includes(k)), ...all.filter(k => !p.order.includes(k))]; };
    const onDragEnd = () => { dragKey = null; for (const x of d.querySelectorAll(".drop-before,.drop-after")) x.classList.remove("drop-before", "drop-after"); };
    for (const h of [thead, side]) { h.ondragstart = onDragStart; h.ondragover = onDragOver; h.ondrop = onDrop; h.ondragend = onDragEnd; }

    const value = (row, m, c) => c.key === "status" ? m.status : m.cells[c.key] ?? row[c.key];
    function sortedRows() {
      const Mo = getModel(), p = per(state.tab), q = state.query.trim().toLowerCase();
      let list = Mo.rows(state.tab);
      if (q) list = list.filter(r => String(r.name).toLowerCase().includes(q) || String(r.classes || r.list || "").toLowerCase().includes(q));
      const filters = Object.entries(p.filters).map(([k, v]) => [COLUMNS[state.tab].find(c => c.key === k), v.trim().toLowerCase()]).filter(([c, v]) => c && v);
      // Sorting, filtering by a computed column or Failing only measure every row (cheap columns first; heavy ones on demand).
      const needs = state.failing || filters.some(([c]) => c.key !== "name") || p.sort.key !== "name";
      if (needs) {
        const sc = COLUMNS[state.tab].find(c => c.key === p.sort.key);
        list = list.map(r => { const m = Mo.metrics(state.tab, r); if (sc?.heavy || state.failing || filters.some(([c]) => c.heavy)) m.heavy?.(); return r; });
      }
      if (state.failing) list = list.filter(r => Mo.metrics(state.tab, r).status === "fail");
      for (const [c, v] of filters) list = list.filter(r => {
        const m = c.key === "name" ? null : Mo.metrics(state.tab, r), x = m ? value(r, m, c) : r.name;
        const s = typeof x === "number" ? fmt(c, x) : String(x ?? "");
        if (/^[<>]=?\s*[\d.]/.test(v) && typeof x === "number") { const n = parseFloat(v.replace(/^[<>]=?/, "")), y = c.kind === "len" ? R().units.value(x, unit()) : x; return v[0] === "<" ? (v[1] === "=" ? y <= n : y < n) : (v[1] === "=" ? y >= n : y > n); }
        return s.toLowerCase().includes(v);
      });
      const sc = COLUMNS[state.tab].find(c => c.key === p.sort.key) || COLUMNS[state.tab][0], dir = p.sort.dir || 1;
      const rank = {fail: 0, pass: 1, none: 2};
      const keyOf = r => { if (sc.key === "name") return r.name; const m = Mo.metrics(state.tab, r), v = value(r, m, sc); return sc.key === "status" ? rank[v] : v; };
      const decorated = list.map(r => [keyOf(r), r]);
      decorated.sort((a, b) => { const x = a[0], y = b[0]; if (x == null || x === "") return y == null || y === "" ? natural(a[1].name, b[1].name) : 1; if (y == null || y === "") return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : natural(String(x), String(y)); return (c || natural(a[1].name, b[1].name)) * dir; });
      return decorated.map(x => x[1]);
    }
    const C = globalThis.AtriumNavCommon;
    const grid = AtriumWindowedTable(wrap, tbody, () => cols.length, paintRow, {rowHeight: 24});
    function paintRow(tr, row, i) {
      const Mo = getModel(), m = Mo.metrics(state.tab, row);
      m.heavy?.();
      tr.dataset.key = row.key; tr.className = (i % 2 ? "odd" : "") + (state.sel.has(row.key) ? " sel" : "");
      for (const c of cols) {
        const v = value(row, m, c), td = el("td");
        td.dataset.c = c.key;
        if (c.key === "status") { const s = el("span", m.status === "fail" ? "Fail" : m.status === "pass" ? "Pass" : "—", "ui-badge cm-badge"); if (m.status === "fail" || m.status === "pass") s.dataset.tone = m.status === "fail" ? "danger" : "success"; td.append(s); }
        else td.textContent = fmt(c, v);
        if (c.kind !== "text" && c.kind !== "status") td.classList.add("num");
        if (c.edit) { td.classList.add("editable"); if (m.cells.inherited?.[c.key]) td.classList.add("inherited"); }
        if (m.fails.has(c.key)) td.classList.add("bad");
        if (c.actual && m.status === "pass" && !m.fails.has(c.key) && v != null && v !== "") td.classList.add("ok");
        if (td.textContent.length > 14) td.title = td.textContent;
        tr.append(td);
      }
    }
    function paintSummary() {
      const Mo = getModel(), all = Mo.rows(state.tab);
      let fails = 0, known = 0;
      for (const r of all) { const m = Mo.cached(state.tab, r); if (m) { known++; if (m.status === "fail") fails++; } }
      const name = TABS.find(([k]) => k === state.tab)[1];
      summary.textContent = board().name + " · " + name + ": " + all.length + " row" + (all.length === 1 ? "" : "s") + (rows.length !== all.length ? " (" + rows.length + " shown)" : "") +
        (known ? " · " + fails + " failing" + (known < all.length ? " of " + known + " checked" : "") : "") + " · " + (project().rules ? "project rules" : "default rules");
    }
    // Background: measure rows in chunks so the summary counts every failing row without blocking.
    let bgTimer = 0;
    function background() {
      clearTimeout(bgTimer);
      const tab = state.tab, Mo = getModel(), list = Mo.rows(tab);
      let i = 0;
      const step = () => {
        if (state.tab !== tab || Mo !== M || !d.isConnected) return;
        const end = Math.min(list.length, i + 300);
        for (; i < end; i++) Mo.metrics(tab, list[i]);
        paintSummary();
        if (i < list.length) bgTimer = setTimeout(step, 0);
      };
      bgTimer = setTimeout(step, 30);
    }
    function repaint() {
      if (state.tab === "spacing" || state.tab === "dfa") { wrap.hidden = true; matrix.hidden = false; paintMatrix(); return; }
      wrap.hidden = false; matrix.hidden = true;
      cols = visibleCols(); paintHead();
      try { rows = sortedRows(); } catch (e) { rows = []; say(e.message, true); }
      grid.refresh(rows); paintSummary(); background();
    }
    function switchTab(k) {
      state.tab = k; state.sel.clear(); state.anchor = null; closeEditor();
      for (const b of tabs.children) {
        const selected = b.dataset.tab === k;
        b.setAttribute("aria-selected", String(selected));
        b.tabIndex = selected ? 0 : -1;
      }
      runBtn.hidden = k !== "spacing"; failing.hidden = colsBtn.hidden = k === "spacing" || k === "dfa"; tplBtn.hidden = k !== "nets" && k !== "pairs" && k !== "classes";
      if (!side.hidden && (side.dataset.kind === "columns" && (k === "spacing" || k === "dfa") || side.dataset.kind === "templates" && tplBtn.hidden)) side.hidden = true;
      if (!side.hidden) side.dataset.kind === "columns" ? paintColumns() : paintTemplates();
      wrap.scrollTop = 0; remember(); repaint();
    }
    search.oninput = () => { state.query = search.value; clearTimeout(ft); ft = setTimeout(repaint, 120); };

    // -------- selection and cross-probe
    function rowItems(row) {
      const Mo = getModel(), idx = Mo.index().nets, ids = [];
      const nets = state.tab === "nets" ? [row.name] : state.tab === "pairs" ? [row.positive, row.negative] : state.tab === "classes" || state.tab === "signals" || state.tab === "tags" ? row.nets : state.tab === "groups" ? row.group.members.flatMap(m => m.nets || []) : state.tab === "xsignals" ? row.netList : [];
      for (const n of nets) ids.push(...(idx.get(n)?.ids || []));
      return {ids, nets};
    }
    function crossProbe(row) {
      if (!host) return;
      const {ids, nets} = rowItems(row);
      if (host.currentId?.() !== boardId) host.selectDocument?.(boardId);
      if (nets.length === 1 || state.tab === "pairs") host.setHighlight?.(nets[0] || "");
      host.select?.(ids.slice(0, 20000));
    }
    wrap.onclick = e => {
      const tr = e.target.closest("tr[data-key]"); if (!tr) return;
      const key = tr.dataset.key, i = rows.findIndex(r => r.key === key);
      if (e.shiftKey && state.anchor != null) { const a = rows.findIndex(r => r.key === state.anchor); state.sel = new Set(rows.slice(Math.min(a, i), Math.max(a, i) + 1).map(r => r.key)); }
      else if (e.metaKey || e.ctrlKey) { state.sel.has(key) ? state.sel.delete(key) : state.sel.add(key); state.anchor = key; }
      else { state.sel = new Set([key]); state.anchor = key; }
      grid.refresh();
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) crossProbe(rows[i]);
      if (!side.hidden && side.dataset.kind === "templates") paintTemplates();
    };
    // -------- inline editing
    let editor = null;
    function closeEditor() { if (editor) { editor.remove(); editor = null; } }
    function beginEdit(td) {
      const key = td.parentElement.dataset.key, c = cols.find(x => x.key === td.dataset.c), row = rows.find(r => r.key === key);
      if (!c?.edit || !row) return;
      if (state.tab === "groups" && !row.rule) { say("Group " + row.name + " is not a Matched Lengths rule; its tolerance comes from the length tuning manager.", true); return; }
      closeEditor();
      const Mo = getModel(), m = Mo.metrics(state.tab, row), v = m.cells[c.key];
      const input = el("input", null, "ui-field"); input.dataset.gridEditing = ""; input.value = c.kind === "len" && typeof v === "number" ? String(R().units.value(v, unit())) : v ?? "";
      input.setAttribute("aria-label", c.label + " for " + row.name);
      input.placeholder = c.key === "profile" ? "Profile name (blank: none)" : unit();
      td.replaceChildren(input); editor = input; input.focus(); input.select();
      let done = false;
      const finish = ok => {
        if (done) return; done = true;
        if (ok) {
          let val;
          try { val = parseValue(c, input.value, unit()); } catch (e) { say(e.message, true); closeEditor(); grid.refresh(); return; }
          commit("", set => setCell(set, state.tab, row, c.key, val, getModel()));
        }
        editor = null; grid.refresh(); wrap.focus();
      };
      input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } };
      input.onblur = () => finish(true);
    }
    wrap.ondblclick = e => { const td = e.target.closest("td.editable"); if (td) beginEdit(td); };
    wrap.onkeydown = e => {
      if (e.target !== wrap) return;
      const i = rows.findIndex(r => r.key === state.anchor);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); const n = Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        if (!rows[n]) return; state.sel = new Set([rows[n].key]); state.anchor = rows[n].key; grid.scrollTo(n); crossProbe(rows[n]);
      } else if (e.key === "F2" || e.key === "Enter") {
        const tr = tbody.querySelector('tr[data-key="' + CSS.escape(state.anchor || "") + '"]'), td = tr?.querySelector("td.editable");
        if (td) { e.preventDefault(); beginEdit(td); }
      }
    };

    // -------- columns panel
    function toggleColumns() { if (!side.hidden && side.dataset.kind === "columns") { side.hidden = true; return; } side.dataset.kind = "columns"; side.hidden = false; paintColumns(); }
    function paintColumns() {
      const p = per(state.tab), list = el("div", null, "cm-collist"); list.setAttribute("role", "list");
      for (const k of visibleOrder()) {
        const c = COLUMNS[state.tab].find(x => x.key === k), item = el("label", null, "cm-colitem"); item.dataset.key = k; item.draggable = true; item.setAttribute("role", "listitem");
        const box = el("input"); box.type = "checkbox"; box.checked = !p.hidden.has(k); box.disabled = k === "name";
        box.onchange = () => { box.checked ? p.hidden.delete(k) : p.hidden.add(k); remember(); repaint(); };
        item.append(box, el("span", c.label + (c.edit ? " ✎" : "")));
        list.append(item);
      }
      side.replaceChildren(el("h3", "Columns"), el("p", "Drag to reorder. ✎ marks constraints you can edit.", "cm-hint"), list,
        button("Reset columns", () => { delete state.per[state.tab]; delete prefs[state.tab]; remember(); repaint(); paintColumns(); }));
    }
    // -------- templates panel (ECSets)
    function toggleTemplates() { if (!side.hidden && side.dataset.kind === "templates") { side.hidden = true; return; } side.dataset.kind = "templates"; side.hidden = false; paintTemplates(); }
    function paintTemplates() {
      const Mo = getModel(), list = templates(Mo.set), kind = state.tab === "pairs" ? "pair" : "net";
      const picked = rows.filter(r => state.sel.has(r.key));
      const memberNames = state.tab === "classes" ? picked.flatMap(r => r.nets) : picked.map(r => r.name);
      const box = el("div", null, "cm-tpl");
      box.append(el("h3", "Templates (ECSets)"), el("p", "A template is a net class or pair class whose rules carry its constraints. Nets or pairs that join it follow them.", "cm-hint"));
      const name = el("input"); name.placeholder = "New template name"; name.setAttribute("aria-label", "New template name");
      const one = picked.length === 1 && state.tab !== "classes" ? picked[0] : null;
      const make = button("Create from " + (one ? one.name : "selected " + kind), () => {
        if (!one) { say("Select one " + kind + " row to copy its constraints.", true); return; }
        if (commit("", set => { const r = createTemplate(set, name.value.trim(), kind === "pair" ? {pair: one.name} : {net: one.name}, getModel()); return "Template " + r.template + " created: " + r.rules.join(", "); })) paintTemplates();
      });
      make.disabled = !one;
      box.append(el("label", "From the selected row", "cm-hint"), name, make);
      const ul = el("div", null, "cm-tpl-list");
      for (const t of list.filter(t => t.kind === kind)) {
        const item = el("div", null, "cm-tpl-item");
        const ap = button("Apply to " + memberNames.length + " selected", () => {
          if (!memberNames.length) { say("Select the " + kind + " rows to apply " + t.name + " to.", true); return; }
          if (commit("", set => { const r = applyTemplate(set, t.name, memberNames); return "Applied " + t.name + " to " + r.added + " more " + kind + (r.added === 1 ? "" : "s") + " (" + r.members + " in all)."; })) paintTemplates();
        });
        ap.disabled = !memberNames.length;
        item.append(el("strong", t.name), el("span", t.members.length + " " + kind + (t.members.length === 1 ? "" : "s") + " · " + t.rules.length + " rules", "cm-hint"), ap);
        item.title = t.rules.join(", ");
        ul.append(item);
      }
      if (!ul.children.length) ul.append(el("p", "No " + kind + " templates yet.", "cm-hint"));
      box.append(ul);
      side.replaceChildren(box);
    }
    // -------- spacing and DFA matrices
    let clearanceHits = null;
    function runClearance() {
      try {
        const doc = board(), out = R().drc(doc, defs(), R().effective(doc, project()), {types: ["clearance"], limit: 5000});
        const Mo = getModel(), cls = Object.entries(Mo.set.netClasses || {}), byNet = new Map();
        for (const [c, ns] of cls) for (const n of ns) { if (!byNet.has(n)) byNet.set(n, []); byNet.get(n).push(c); }
        const netOf = new Map(); for (const i of doc.items) if (i.net) netOf.set(i.id, i.net);
        clearanceHits = new Map();
        for (const v of out.violations) {
          const a = byNet.get(netOf.get(v.id)) || ["All"], b = byNet.get(netOf.get(v.otherId)) || ["All"];
          for (const x of a) for (const y of b) { const k = [x, y].sort().join("\u0001"); clearanceHits.set(k, (clearanceHits.get(k) || 0) + 1); }
        }
        say(out.total + " clearance violation" + (out.total === 1 ? "" : "s") + " (" + out.stats.ms + " ms)." , out.total > 0);
        paintMatrix();
      } catch (e) { say(e.message, true); }
    }
    function matrixInput(valueMm, placeholder, onSet, label, source) {
      const i = el("input", null, source ? "ui-field ui-field-number" : "ui-field");
      if (source) i.dataset.valueSource = source;
      i.value = valueMm == null ? "" : String(R().units.value(valueMm, unit())); i.placeholder = placeholder ?? ""; i.setAttribute("aria-label", label);
      i.onchange = () => { let v; try { v = parseValue({key: "x"}, i.value, unit()); } catch (e) { say(e.message, true); return; } onSet(v); };
      i.onkeydown = e => { if (e.key === "Enter") i.blur(); };
      return i;
    }
    function paintMatrix() {
      const Mo = getModel();
      if (state.tab === "spacing") {
        const sp = Mo.spacing(), t = el("table", null, "cm-mtx");
        const hr = el("tr"); hr.append(el("th", "Clearance (" + unit() + ")"));
        for (const n of sp.names) hr.append(el("th", n));
        t.append(hr);
        sp.names.forEach((a, i) => {
          const tr = el("tr"); tr.append(el("th", a));
          sp.names.forEach((b, j) => {
            const td = el("td");
            if (j < i) { td.className = "mirror"; td.textContent = ""; tr.append(td); return; }
            const c = sp.cell(a, b), hits = clearanceHits?.get([a, b].sort().join("\u0001")) || 0;
            const inp = matrixInput(c.own ? c.gap : null, c.gap != null ? String(R().units.value(c.gap, unit())) : "", v => commit("", set => setSpacing(set, a, b, v)), "Clearance " + a + " to " + b, c.own ? "authored" : "inherited");
            td.title = c.own ? "Rule " + c.rule : "Inherited from " + (c.rule || "defaults") + ". Type a value to add a class-to-class rule.";
            td.append(inp);
            if (clearanceHits) { const b2 = el("span", hits ? String(hits) : "✓", "cm-hits " + (hits ? "fail" : "pass")); b2.title = hits ? hits + " violations" : "No violations"; td.append(b2); }
            tr.append(td);
          });
          t.append(tr);
        });
        matrix.replaceChildren(el("p", "Class-to-class clearance. Blank cells inherit (grey). The lower triangle mirrors the upper one. Check clearance counts violations per pair.", "cm-hint"), t);
        return;
      }
      // DFA
      const D = globalThis.AtriumDFA, r = dfaRule(Mo.set, false);
      const head2 = el("div", null, "cm-dfa-head");
      if (!D) { matrix.replaceChildren(el("p", "The DFA module (dfa.js) is not loaded.", "cm-hint")); return; }
      if (!r) {
        head2.append(el("p", "This board has no DFA spacing rule. Add one with the starter package matrix (0402–0402 0.2 mm, BGA–any 1.0 mm …).", "cm-hint"),
          button("Add DFA rule", () => { if (commit("", set => { dfaRule(set, true); return "DFA spacing rule added with the starter matrix."; })) repaint(); }, "primary"));
        matrix.replaceChildren(head2); return;
      }
      const en = el("input"); en.type = "checkbox"; en.checked = r.enabled; en.onchange = () => commit("", set => setDfa(set, {enabled: en.checked}));
      const mSel = el("select"); for (const [k, v] of [["body", "Body to body"], ["courtyard", "Courtyard to courtyard"]]) mSel.add(new Option(v, k)); mSel.value = r.measure;
      mSel.onchange = () => commit("", set => setDfa(set, {measure: mSel.value}));
      const sSel = el("select"); for (const [k, v] of [["same", "Same side (through-hole: both)"], ["both", "Both sides"]]) sSel.add(new Option(v, k)); sSel.value = r.sides;
      sSel.onchange = () => commit("", set => setDfa(set, {sides: sSel.value}));
      const dg = matrixInput(r.defaultGap, "", v => { if (v == null) return say("Default gap needs a value.", true); commit("", set => setDfa(set, {defaultGap: v})); }, "Default gap");
      const lab = (t, c) => { const l = el("label", null, "cm-field"); l.append(el("span", t), c); return l; };
      head2.append(lab("Enabled", en), lab("Measure", mSel), lab("Sides", sSel), lab("Default gap (" + unit() + ")", dg));
      const counts = D.boardTypes(board(), defs());
      const showAll = state.dfaAll === true;
      const types = ["any", ...D.TYPES.map(([k]) => k).filter(k => showAll || counts.has(k) || r.matrix.some(e => e.a === k || e.b === k))];
      const allBtn = button(showAll ? "Board package types" : "All package types", () => { state.dfaAll = !showAll; paintMatrix(); });
      head2.append(allBtn);
      const t = el("table", null, "cm-mtx");
      const hr = el("tr"); hr.append(el("th", "Gap (" + unit() + ")"));
      for (const k of types) { const th = el("th", D.label(k)); th.title = counts.get(k) ? counts.get(k) + " on this board" : ""; hr.append(th); }
      t.append(hr);
      types.forEach((a, i) => {
        const tr = el("tr"), th = el("th", D.label(a) + (counts.get(a) ? " · " + counts.get(a) : "")); tr.append(th);
        types.forEach((b, j) => {
          const td = el("td");
          if (j < i) { td.className = "mirror"; tr.append(td); return; }
          const e = r.matrix.find(x => x.a === a && x.b === b || x.a === b && x.b === a);
          const eff = a === "any" || b === "any" ? (e?.gap ?? null) : D.gapFor(r, a, b);
          td.append(matrixInput(e ? e.gap : null, eff != null ? String(R().units.value(eff, unit())) : "", v => commit("", set => setDfa(set, {a, b, gap: v})), "DFA gap " + a + " to " + b, e ? "authored" : "inherited"));
          tr.append(td);
        });
        t.append(tr);
      });
      const res = D.check(board(), defs(), r, {limit: 1000});
      const vt = el("table", null, "cm-dfa-list"), vh = el("tr");
      for (const h of ["Components", "Packages", "Gap", "Required"]) vh.append(el("th", h));
      vt.append(vh);
      for (const v of res.violations.slice(0, 300)) {
        const tr = el("tr"); tr.tabIndex = 0;
        tr.append(el("td", v.refs.join(" ↔ ")), el("td", v.types.map(D.label).join(" ↔ ")), el("td", String(R().units.value(v.actual, unit())), "num bad"), el("td", String(R().units.value(v.required, unit())), "num"));
        tr.onclick = () => { if (host) { if (host.currentId?.() !== boardId) host.selectDocument?.(boardId); host.select?.([v.id, v.otherId], v.id); host.centerOn?.(v.at); } };
        vt.append(tr);
      }
      const note = el("p", res.violations.length ? res.violations.length + " DFA violation" + (res.violations.length === 1 ? "" : "s") + " among " + res.parts + " components (" + res.ms + " ms). Click one to show it." : "No DFA violations among " + res.parts + " components.", "cm-hint" + (res.violations.length ? " bad" : ""));
      matrix.replaceChildren(head2, el("p", "Package-pair gaps. Blank cells use the type–any entries, then the default gap (grey shows the effective value). Live while placing and dragging (Tools › Live DFA Spacing Check).", "cm-hint"), t, note, vt);
    }
    // -------- CSV
    async function exportCsv() {
      try {
        const Mo = getModel(), text = state.tab === "dfa" ? "" : csv(Mo, state.tab, {keys: cols.map(c => c.key), rows});
        const name = (board().name || "Board").replace(/[\\/:*?"<>|]/g, "-") + "-constraints-" + state.tab + ".csv";
        const out = state.tab !== "dfa" ? text : [["a", "b", "gap (mm)"], ...(dfaRule(Mo.set, false)?.matrix || []).map(e => [e.a, e.b, e.gap])].map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
        await (host?.exportFile || ctx.exportFile)(name, out);
        say("Exported " + name);
      } catch (e) { say(e.message, true); }
    }
    // -------- resizing the docked panel
    grip.onpointerdown = e => {
      e.preventDefault(); const y0 = e.clientY, h0 = d.getBoundingClientRect().height;
      grip.setPointerCapture?.(e.pointerId);
      const move = ev => { d.style.height = Math.max(200, Math.min(innerHeight - 60, h0 - (ev.clientY - y0))) + "px"; grid.refresh(); };
      const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); };
      grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
    };
    d.addEventListener("keydown", e => { if (e.key === "Escape" && !editor) { e.preventDefault(); d.close(); } });
    // -------- live updates: edits, undo, other tools
    let rt = 0;
    const off = [host?.on?.("change", () => { clearTimeout(rt); rt = setTimeout(() => { if (d.isConnected && !editor) { if (!side.hidden) side.dataset.kind === "templates" ? paintTemplates() : null; repaint(); } }, 150); }),
      host?.on?.("document", () => { if (host.currentId?.() !== boardId && !project().documents.some(x => x.id === boardId)) d.close(); })];
    document.body.append(d);
    openDialog = d;
    globalThis.AtriumShell?.adoptDialog?.(d, {initialFocus: search}); d.show();
    switchTab(state.tab);
    search.focus();
    return d;
  }

  // Design › Constraint Manager… (editor action "constraints", loaded on first use by AtriumLazy).
  if (globalThis.AtriumNavCommon?.ready && typeof document !== "undefined")
    AtriumNavCommon.ready(h => h.registerAction("constraints", () => open({project: h.project(), doc: h.doc(), defs: h.defs(), info: h.info, edit: h.edit, exportFile: h.exportFile})));

  return Object.freeze({COLUMNS, TABS, model, buildIndex, setCell, setSpacing, setDfa, dfaRule, parseValue, templates, createTemplate, applyTemplate, csv, headless, open, MARK});
})();
