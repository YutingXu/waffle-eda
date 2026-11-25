"use strict";
// AtriumChecks: one check registry, one violation shape, one live store and one scheduler for every
// design check in both editors (docs/design/unified-rules-and-checks.md §2). Lazy (app/lazy.js): the
// online DRC view and Design Insights load it as a dependency; nothing here is eager.
//
// Registry (§2.1). Every check has a stable, namespaced id that is never renamed:
//   layout.<rule type>       a DRC rule type (rules.js TYPES), plus layout.netAntennae, layout.courtyard
//   layout.fab.<id>          a DFM check against the board's fab limits (dfm.js; origin fab)
//   schematic.<id>           an ERC check (erc.js CHECKS), schematic.pinMatrix the connection matrix
//   layout.hint.<id>         a Design Insight on a board (insights-pcb.js), always the hint tier
//   schematic.hint.<id>      a Design Insight on a sheet (insights-sch.js)
// Entries are metadata only ({id, source, ruleTypes, domains, tiers, module, incremental, cost});
// the check code stays in its module and loads on the first run that needs it.
//
// One violation (§2.2), made by the adapters from each engine's own shape (the original is kept as
// the non-enumerable `raw`, so markers, the inspector, fixes and the old MCP tools read what they
// always read):
//   {key, check, source, ruleId?, ruleName?, ruleSet?, origin?, severity: fatal|error|warning|hint,
//    domain: schematic|layout, doc, objects: [{doc, id, role?}], at: [{doc, point}], subject?,
//    measure?: {actual, required, limit: min|max, unit}, text, hint?, waiver?: {id, state}}
//   key = check + ":" + hash(rule name | sorted object ids | meaning signature). The signature never
//   holds positions, so a waiver or a dismissal keyed by it survives a move (§2.5).
//
// Store: engines publish what they found per document (or "project") and source; the Problems view,
// F8, the status bar and MCP `check` read one list. Conversion to the shape above is lazy and cached
// per published list, so an online DRC pass costs nothing extra here.
//   publish(scope, source, raw, adapt, meta)   violations(filter) summary(filter) on(fn) clear(scope?)
//
// Scheduler (§2.3): one for every live check, replacing the online-DRC and Design Insights runners.
// An edit commit (the editor's "change"), a document or pane change, visibility and Efficiency mode
// re-plan it; nothing runs while the documents are unchanged (each client reads the undo journal
// from its own cursor, AtriumUndoStore.changed(doc, since)). Work runs in the edit pipeline's phases
// (host.stageEdit): layout rules first, right after the edit's first frame (first markers within
// about 30 ms), then hints and live ERC at idle. Each client's task is an iterator: every next() is a
// checkpoint where a slice ends (8 ms in idle time, 6 ms when forced) and where a newer edit abandons
// it (the finished parts stay with the client).
//   scheduler.attach(host)   scheduler.client({id, key(doc), phase(doc), delay(), enabled(), docs(),
//     due(doc), start(doc, slice) -> iterator, unrecorded: "idle"|"sync", heavy?, manual?})
//     manual: only queue(id, doc) runs it (an edit neither re-plans nor abandons it); a task that
//     yields scheduler.WAIT ends its slice early (polygon-pour.js: a pour solve without a worker).
//   scheduler.plan(id?, o)   scheduler.cancel(id?)   scheduler.stats()
//
// Live ERC (§2.3 step 5): the schematic checks re-run at idle after a schematic edit through
// AtriumERC.steps (sliced; each sheet's connectivity graph is cached by its journal version). Until
// Compile reports a finding it shows at the hint tier (quiet violet, no red while wiring); a finding
// the last Compile reported keeps its configured severity. Preferences › Design Checks › Live
// schematic severities ("checks.liveSeverity": hint | real) shows real severities at once.
globalThis.AtriumChecks = (() => {
  const G = globalThis, now = () => G.performance?.now?.() ?? Date.now();
  const AtriumI18n = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = AtriumI18n.define({
    "checks.status.one": "1 problem",
    "checks.status.many": "{count} problems",
    "checks.status.open": "{summary}. Open Problems.",
    "checks.pref.title": "Design Checks",
    "checks.pref.live": "Live checking",
    "checks.pref.live_severity": "Live schematic severities",
    "checks.pref.live_hint": "Hints until Compile",
    "checks.pref.live_real": "Real severities while editing",
    "checks.pref.live_help": "Show hints until Compile confirms a finding.",
    "checks.pref.live_erc": "Check the schematic while editing"
  });
  const pref = (k, d) => { try { const v = G.AtriumPref?.get?.(k, d); return v ?? d; } catch { return d; } };
  const efficient = () => { try { return !!G.AtriumPower?.efficient?.(); } catch { return false; } };

  // ---------------------------------------------------------------- registry
  const REG = new Map(), DOMAINS = ["schematic", "layout"], TIERS = ["fatal", "error", "warning", "hint"];
  const ID = /^(?:schematic|layout|cross)\.[A-Za-z][\w.-]{0,60}$/;
  function register(spec) {
    if (!spec || !ID.test(spec.id || "")) throw Error("A check needs a namespaced id (schematic.*, layout.* or cross.*).");
    const e = Object.freeze({ruleTypes: [], domains: [spec.id.split(".")[0]], tiers: ["error", "warning"], incremental: "doc", cost: "cheap", ...spec,
      ruleTypes: Object.freeze([...(spec.ruleTypes || [])]), tiers: Object.freeze([...(spec.tiers || ["error", "warning"])])});
    REG.set(e.id, e);
    return e;
  }
  // DRC rule types (rules.js TYPES); the net-wide ones are checked by batch DRC and listed in Problems,
  // never as online markers (drc-view.js NET_WIDE).
  const DRC_TYPES = ("clearance zClearance creepage short currentCapacity unrouted:net modifiedPolygon:net componentHeight width routingTopology routingPriority routingLayers routingCorners viaStyle " +
    "fanoutControl diffPairsRouting solderMask pasteMask supplyNets fabricationTestpoint polygonConnect annularRing holeSize holeToHole layerPairs hdiVias boardOutlineClearance " +
    "silkToMask silkToSilk length:net matchedLengths:net returnPathVia delay:net matchedDelays:net parallelSegment returnPath viaStub dfaSpacing " +
    "componentClearance flexLayers flexVias bendKeepout bendCrossing bendRadius flexCopper stiffener flexRouting flexBuild").split(" ");
  for (const s of DRC_TYPES) {
    const [type, inc] = s.split(":");
    register({id: "layout." + type, source: "drc", ruleTypes: [type], domains: ["layout"], tiers: ["error", "warning"], module: "AtriumRules", incremental: inc || "area", cost: "cheap"});
  }
  register({id: "layout.netAntennae", source: "drc", domains: ["layout"], tiers: ["warning"], module: "AtriumDRCFixes", incremental: "area"});
  register({id: "layout.courtyard", source: "drc", domains: ["layout"], tiers: ["warning"], module: "AtriumDRCFixes", incremental: "area"});
  // Poured copper against the Clearance rules (drc-pours.js): after a refill, in idle slices, and before outputs.
  register({id: "layout.pourClearance", title: "Pour Clearance", source: "drc", ruleTypes: ["clearance"], domains: ["layout"], tiers: ["error"], module: "AtriumDRCPours", incremental: "pour", cost: "heavy"});
  const DFM_IDS = "acid sliver maskSliver maskWeb maskTrace ring silkPad drillCopper drillEdge holeToHole minHole slot thermal panel text".split(" ");
  for (const id of DFM_IDS) register({id: "layout.fab." + id, source: "dfm", domains: ["layout"], tiers: ["error", "warning"], module: "AtriumDFM", incremental: "doc", cost: "heavy", origin: "fab"});
  const ERC_IDS = ("duplicateDesignators unannotated missingFootprint floatingInputs unconnectedPins singlePinNets multipleNames netTies duplicateNets floatingLabels " +
    "floatingPower danglingWires noDriver duplicateGate missingPowerGate boardMismatch missingSheet hierarchyLoop unmatchedEntries busWidth pinMatrix hierarchy calculationAssertion").split(" ");
  // Rule types (project-rules.js): erc<Check> per check, ercPinMatrix for the matrix; "hierarchy" has none.
  const ercRuleType = id => id === "pinMatrix" ? "ercPinMatrix" : id === "hierarchy" ? null : "erc" + id.charAt(0).toUpperCase() + id.slice(1);
  for (const id of ERC_IDS) register({id: "schematic." + id, source: "erc", ruleTypes: ercRuleType(id) ? [ercRuleType(id)] : [], domains: id === "boardMismatch" ? ["schematic", "layout"] : ["schematic"], tiers: ["fatal", "error", "warning", "hint"], module: "AtriumERC", incremental: "project"});
  const HINTS = {layout: "neck:pour:heavy returnPlane:net:heavy acuteAngle:area stub:net widthCurrent:net thermalCurrent:net viaInPad:area decap:doc diffPair:net:heavy crosstalk:net:heavy silk:area ringMin:area edgeCopper:area",
    schematic: "netTypo:doc decoupling:doc i2cPullup:doc wireNearPin:doc singlePin:doc floatingInput:doc"};
  for (const [domain, list] of Object.entries(HINTS)) for (const s of list.split(" ")) {
    const [id, inc, heavy] = s.split(":");
    register({id: domain + ".hint." + id, source: "insights", domains: [domain], tiers: ["hint"], module: "AtriumInsights", incremental: inc, cost: heavy ? "heavy" : "cheap"});
  }
  // Insight checks other modules register (placeholder-parts.js ...) join the registry when first seen.
  function syncInsights() {
    for (const c of G.AtriumInsights?.checks?.() || []) {
      const id = (c.kind === "pcb" ? "layout" : "schematic") + ".hint." + c.id;
      if (!REG.has(id) && ID.test(id)) register({id, source: "insights", domains: [c.kind === "pcb" ? "layout" : "schematic"], tiers: ["hint"], module: "AtriumInsights", incremental: c.scope || "doc", cost: c.heavy ? "heavy" : "cheap"});
    }
  }
  const lookup = id => REG.get(id) || (/\.hint\./.test(id) ? (syncInsights(), REG.get(id)) : undefined) || null;
  const ERC_CHECK = m => m === "matrix" ? "pinMatrix" : m;
  const checkId = {drc: v => "layout." + v.type, erc: m => "schematic." + ERC_CHECK(m.check), dfm: i => "layout.fab." + i.check,
    insights: x => (x.kind === "pcb" ? "layout" : "schematic") + ".hint." + x.check};
  // Display title of a check: the engine's own when it is loaded.
  function title(id) {
    const e = lookup(id), rest = id.slice(id.indexOf(".") + 1);
    if (!e) return id;
    if (e.title) return e.title;
    try {
      if (e.source === "drc") return G.AtriumRules?.types?.[e.ruleTypes[0]]?.title || G.AtriumDRCFixes?.EXTRA?.[rest]?.title || rest;
      if (e.source === "erc") return G.AtriumERC?.CHECKS?.find(c => c.id === rest)?.name || (rest === "pinMatrix" ? "Connection matrix" : rest);
      if (e.source === "dfm") return G.AtriumDFM?.CHECKS?.find(c => "fab." + c.id === rest)?.title || rest;
      if (e.source === "insights") return G.AtriumInsights?.check?.(rest.slice(5))?.title || rest.slice(5);
    } catch { /* fall back */ }
    return rest;
  }

  // ---------------------------------------------------------------- violations
  // Short, stable hash (two FNV-like lanes, as drc-waivers.js and insights.js).
  function hash(s) {
    let h1 = 2166136261, h2 = 5381;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2, 33) ^ c; }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  }
  const idsOf = list => [...new Set(list.filter(x => typeof x === "string" && x))].sort();
  // The identity of a violation: check, rule name, the objects and a meaning signature (no positions).
  const keyOf = (check, rule, ids, sig = "") => check + ":" + hash(String(rule ?? "") + "|" + idsOf(ids).join(",") + "|" + String(sig ?? ""));
  const r3 = v => Math.round(v * 1000) / 1000 + 0;
  const pt = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [r3(p[0]), r3(p[1])] : null;
  function make(fields, raw) {
    const v = {key: fields.key, check: fields.check, source: fields.source, severity: fields.severity, domain: fields.domain, doc: fields.doc ?? null,
      objects: fields.objects || [], at: fields.at || [], text: String(fields.text ?? "")};
    for (const k of ["ruleId", "ruleName", "ruleSet", "origin", "subject", "measure", "hint", "detail", "waiver"]) if (fields[k] != null && fields[k] !== "") v[k] = fields[k];
    // Other keys the same finding had (a waiver made under one of them still finds it).
    if (fields.keys?.length) Object.defineProperty(v, "keys", {value: fields.keys, enumerable: false});
    Object.defineProperty(v, "raw", {value: raw, enumerable: false});
    return v;
  }
  // DRC {type, ruleId, ruleName, id, otherId, actual, required, limit, at, otherAt, title, warning?, waived?}.
  const NET_KEYED = new Set(["length", "matchedLengths", "delay", "matchedDelays", "unrouted"]);
  const ANNULAR_RING = "layout.annularRing";
  function padAliases(check, rule, ids, subject) {
    return [...(subject.padFallback ? [keyOf(check, rule, ids, subject.padFallback)] : []), keyOf(check, rule, ids)];
  }
  function fromDRC(x, doc) {
    if (!x || !x.type) return null;
    const d = typeof doc === "string" ? doc : doc?.id ?? null, check = checkId.drc(x), ids = idsOf([x.id, x.otherId]);
    const objects = [], at = [];
    if (x.id) objects.push({doc: d, id: x.id, role: "a"});
    if (x.otherId && x.otherId !== x.id) objects.push({doc: d, id: x.otherId, role: "b"});
    for (const p of [x.at, x.otherAt]) { const q = pt(p); if (q && !at.some(a => a.point[0] === q[0] && a.point[1] === q[1])) at.push({doc: d, point: q}); }
    const measure = x.delay ? {actual: x.delay.actual, required: x.delay.required, limit: x.delay.limit, unit: "ps"} :
      x.actual != null ? {actual: x.actual, required: x.required ?? null, limit: x.limit || "min", unit: "mm"} : null;
    // Net-wide checks (length, delay, unrouted) report on a representative track: their identity is the net.
    const net = x.net || (NET_KEYED.has(x.type) ? /^Net (\S+)/.exec(x.title || "")?.[1] : null);
    const subject = net ? {...x.subject, net} : x.subject, pad = check === ANNULAR_RING ? subject?.padKey : null;
    const primitive = subject?.legendPrimitive, sig = pad ?? (primitive ? "legend:" + primitive : "");
    const key = NET_KEYED.has(x.type) && net ? keyOf(check, x.ruleName || "", [], "net:" + net) : keyOf(check, x.ruleName || "", ids, sig);
    // Legacy component-wide ring waivers retain their original scope. New waivers use the pad key.
    const keys = pad ? padAliases(check, x.ruleName || "", ids, subject) : null;
    return make({key, keys, check, source: "drc", ruleId: x.ruleId, ruleName: x.ruleName, ruleSet: x.ruleSet,
      severity: x.type === "unrouted" || x.warning ? "warning" : "error", domain: "layout", doc: d, objects, at, measure, detail: x.detail,
      subject, text: (x.ruleName || x.typeTitle || title(check)) + ": " + (x.title || ""),
      waiver: x.waived ? {id: x.waived.id, state: "holds"} : null}, x);
  }
  // ERC Messages rows {class, check, text, documentId, objectId, point}; Info rows (summary, notices) are not violations.
  const ERC_SEV = {Fatal: "fatal", Error: "error", Warning: "warning"};
  // The identity of an ERC finding: its object and what erc.js says it is about (pin number, wire end,
  // gate, the net names a user gave); the text (designators, auto net names) only when there is no sig.
  const ercKey = (m, check = checkId.erc(m)) => keyOf(check, m.ruleId || "", [m.objectId], m.sig ?? m.text);
  function fromERC(m, o = {}) {
    if (!m || !ERC_SEV[m.class] || !m.check) return null;
    const check = checkId.erc(m), d = m.documentId ?? null, q = pt(m.point), key = ercKey(m, check);
    const real = m.severity || ERC_SEV[m.class], severity = o.live && !(o.compiled?.has?.(key)) && !o.real ? "hint" : real;
    return make({key, check, source: "erc", severity, domain: "schematic", doc: d,
      objects: m.objectId ? [{doc: d, id: m.objectId}] : [], at: q ? [{doc: d, point: q}] : [], text: m.text,
      ruleId: m.ruleId, ruleName: m.ruleName, origin: m.origin, detail: m.detail,
      ...(severity !== real ? {hint: real} : {})}, m);
  }
  // Design Insights {check, kind, severity: tip|advice, message, objects, at, doc, sig, key, net?}.
  function fromInsight(x) {
    if (!x || !x.check) return null;
    const check = checkId.insights(x), d = x.doc ?? null, q = pt(x.at), h = String(x.key || "").slice(String(x.key || "").indexOf(":") + 1) || hash((x.objects || []).join(",") + "|" + (x.sig ?? ""));
    return make({key: check + ":" + h, check, source: "insights", severity: "hint", hint: x.severity, domain: x.kind === "pcb" ? "layout" : "schematic", doc: d,
      objects: (x.objects || []).map(id => ({doc: d, id})), at: q ? [{doc: d, point: q}] : [], text: x.message, subject: x.net ? {...x.subject, net: x.net} : x.subject}, x);
  }
  // DFM issues {check, level, title, text, fix, id, otherId?, at}.
  function fromDFM(i, doc, preset) {
    if (!i || !i.check) return null;
    const d = typeof doc === "string" ? doc : doc?.id ?? null, check = checkId.dfm(i), q = pt(i.at), ids = idsOf([i.id, i.otherId]);
    const subject = i.subject, pad = i.check === "ring" ? subject?.padKey : null;
    const keys = pad ? padAliases(check, "", ids, subject) : null;
    return make({key: keyOf(check, "", ids, pad), keys, check, source: "dfm", origin: {kind: "fab", preset: preset || null}, severity: i.level === "error" ? "error" : "warning",
      domain: "layout", doc: d, objects: ids.map(id => ({doc: d, id})), at: q ? [{doc: d, point: q}] : [], subject, text: i.title + ": " + i.text,
      measure: i.actual != null && i.required != null ? {actual: i.actual, required: i.required, limit: i.limit || "min", unit: i.unit || "mm"} : null}, i);
  }
  const adapters = Object.freeze({drc: fromDRC, erc: fromERC, insights: fromInsight, dfm: fromDFM});

  // ---------------------------------------------------------------- one check per physical question (§0.2)
  // The same question answered by DRC, DFM and an insight is one check: per object the strictest
  // finding is kept (error over warning over hint; between a rule and the fab's limit, the larger
  // requirement), its message says which limit applied, and a hint is dropped where a rule or the fab
  // already reports the object. The merged checks' old ids stay valid as aliases (filters, MCP).
  const MERGES = {
    [ANNULAR_RING]: ["layout.fab.ring", "layout.hint.ringMin"],
    "layout.holeToHole": ["layout.fab.holeToHole"],
    "layout.silkToMask": ["layout.fab.silkPad", "layout.hint.silk"],
    "layout.boardOutlineClearance": ["layout.hint.edgeCopper"],
    "layout.fab.acid": ["layout.hint.acuteAngle"],
    "schematic.floatingInputs": ["schematic.hint.floatingInput"],
    "schematic.singlePinNets": ["schematic.hint.singlePin"]
  };
  const MERGED_INTO = new Map(Object.entries(MERGES).flatMap(([to, from]) => from.map(f => [f, to])));
  const mergedId = id => MERGED_INTO.get(id) || id;
  const TIER_RANK = {fatal: 0, error: 1, warning: 2, hint: 3};
  function mergeGroup(v, check) {
    const ids = v.objects.length ? v.objects.map(o => o.id).sort().join(",") : v.key;
    // Ring producers use (land - drill)/2 in mm. Equal lands give equal values without rounding.
    // Stacked lands with different measured rings, and separate footprint drills, keep their own rows.
    if (check === ANNULAR_RING) return JSON.stringify([check, v.doc, ids, v.subject?.padIndex, v.subject?.ring]);
    if (v.subject?.legendPrimitive) return JSON.stringify([check, v.doc, ids, v.subject.legendPrimitive]);
    const at = v.domain === "schematic" ? v.at[0]?.point?.map(x => Math.round(x * 100)).join(",") ?? "" : "";
    return check + "|" + (v.doc ?? "") + "|" + ids + "|" + at;
  }
  // violations → the merged list (others pass through unchanged, in order).
  function merge(list) {
    const groups = new Map(), out = [];
    for (const v of list) {
      const m = mergedId(v.check);
      if (!MERGES[m]) { out.push(v); continue; }
      const k = mergeGroup(v, m);
      let g = groups.get(k);
      if (!g) { groups.set(k, g = []); out.push(g); }
      g.push(v);
    }
    return out.flatMap(x => Array.isArray(x) ? [].concat(pick(x)) : [x]);
  }
  // Findings of different engines about the same objects merge; two of one engine (two acid traps on one
  // track) are separate findings and stay apart.
  function pick(g) {
    if (g.length === 1) return mergedView(g[0], g);
    const sources = new Map();
    for (const v of g) sources.set(v.source, (sources.get(v.source) || 0) + 1);
    if ([...sources.values()].some(n => n > 1)) return g.map(v => mergedView(v, [v]));
    const best = g.slice().sort((a, b) => TIER_RANK[a.severity] - TIER_RANK[b.severity] || ((b.measure?.required ?? -Infinity) - (a.measure?.required ?? -Infinity)) * (a.measure?.limit === "max" ? -1 : 1))[0];
    return mergedView(best, g);
  }
  // The kept finding under the merged check id; which limit bound it, and the others it stands for.
  function mergedView(v, g) {
    const m = mergedId(v.check), others = g.filter(x => x !== v && x.severity !== "hint");
    if (m === v.check && !others.length) return v;
    const out = {...v};
    Object.defineProperty(out, "raw", {value: v.raw, enumerable: false});
    // The merged finding answers to every member's key, so a waiver holds whichever engine is stricter.
    Object.defineProperty(out, "keys", {value: [...new Set(g.flatMap(x => [x.key, ...(x.keys || [])]).filter(k => k !== v.key))], enumerable: false});
    Object.defineProperty(out, "member", {value: v, enumerable: false});
    Object.defineProperty(out, "members", {value: g, enumerable: false});
    out.check = m;
    if (v.check !== m) out.alias = v.check;
    if (others.length || v.source === "dfm") {
      const fab = v.origin?.kind === "fab", by = fab ? "the fab's limit" + (v.origin.preset ? " (" + v.origin.preset + ")" : "") : "rule " + (v.ruleName || title(v.check));
      out.text = v.text + (others.length ? " · stricter of the rule and the fab's limit: " + by + " applied" : "");
      out.bound = fab ? "fab" : "rule";
      if (fab || others.some(x => x.origin?.kind === "fab")) out.fab = true;
      if (others.length) out.merged = others.map(x => x.check);
    }
    return out;
  }

  // ---------------------------------------------------------------- the live store
  const layers = new Map(), listeners = new Set();
  let revision = 0, notifying = false;
  function notify() {
    if (notifying) return;
    notifying = true;
    const fire = () => { notifying = false; for (const f of [...listeners]) try { f(revision); } catch (e) { G.console?.error?.(e); } };
    if (typeof queueMicrotask === "function") queueMicrotask(fire); else Promise.resolve().then(fire);
  }
  // raw: the engine's own list; adapt(raw item) → violation (lazy, cached until the next publish).
  function publish(scope, source, raw, adapt, meta = {}) {
    const k = scope + "|" + source, old = layers.get(k), list = Array.isArray(raw) ? raw : [];
    if (old && old.raw === list && old.adapt === adapt && JSON.stringify(old.meta) === JSON.stringify(meta)) return false;
    layers.set(k, {scope, source, raw: list, adapt, meta, list: null, at: Date.now()});
    revision++; notify();
    return true;
  }
  // After an edit: layers of documents that are gone, and DFM results of a board that changed since its
  // DFM run (DFM is not re-run live; Check Design or Tools › DFM Check run it again).
  function pruneLayers() {
    const p = scheduler.host?.()?.project?.();
    if (!p) return;
    const ids = new Set((p.documents || []).map(d => d.id));
    let n = 0;
    for (const [k, l] of [...layers]) {
      if (l.scope !== "project" && !ids.has(l.scope)) { layers.delete(k); n++; continue; }
      if (l.source === "dfm" && l.meta?.version != null) { const d = p.documents.find(x => x.id === l.scope); if (docVersion(d, p) !== l.meta.version) { layers.delete(k); n++; } }
    }
    if (n) { revision++; notify(); }
  }
  function docVersion(d, p) { const v = d && G.AtriumUndoStore?.documentVersions?.(d, p); return v ? v.floor + "/" + v.items + "/" + v.outer : null; }
  function clear(scope, source) {
    let n = 0;
    for (const [k, l] of [...layers]) if ((scope == null || l.scope === scope) && (source == null || l.source === source)) { layers.delete(k); n++; }
    if (n) { revision++; notify(); }
    return n;
  }
  function listOf(l) {
    if (!l.list) { const out = []; for (const x of l.raw) { let v = null; try { v = l.adapt(x); } catch { v = null; } if (v) out.push(v); } l.list = out; }
    return l.list;
  }
  const SEV_RANK = {fatal: 0, error: 1, warning: 2, hint: 3};
  // filter: {doc?, docs?, scope?, source?, sources?, domain?, severity? (one or a list), check?, checks?}
  function match(v, f) {
    if (f.domain && v.domain !== f.domain) return false;
    if (f.severity && ![].concat(f.severity).includes(v.severity)) return false;
    if (f.check && v.check !== f.check && v.alias !== f.check && mergedId(f.check) !== v.check) return false;
    if (f.checks && !f.checks.some(c => v.check === c || v.alias === c || mergedId(c) === v.check || v.check.startsWith(c + "."))) return false;
    if (f.doc && v.doc !== f.doc && !v.objects.some(o => o.doc === f.doc)) return false;
    if (f.docs && !f.docs.includes(v.doc)) return false;
    return true;
  }
  // f.merge: one finding per object for the questions DRC, DFM and the insights share (Problems, MCP check).
  // Waived board violations (the "drc-waived" layer) are left out unless f.waived or f.source asks for them.
  function violations(f = {}) {
    let out = [];
    const pre = f.merge ? {...f, check: undefined, checks: undefined} : f;
    for (const l of layers.values()) {
      if (f.scope != null && l.scope !== f.scope) continue;
      if (l.source === "drc-waived" && !f.waived && f.source !== "drc-waived") continue;
      if (f.source && l.source !== f.source) continue;
      if (f.sources && !f.sources.includes(l.source)) continue;
      for (const v of listOf(l)) if (match(v, pre)) out.push(v);
    }
    if (f.merge) out = merge(out).filter(v => match(v, f));
    return out;
  }
  // A hint that a stricter finding of the same question already reports (insights-ui leaves its marker out).
  let shadowCache = {rev: -1, set: null};
  function shadowed(v) {
    const m = MERGED_INTO.get(v?.check);
    if (!m) return false;
    if (shadowCache.rev !== revision) {
      const set = new Set();
      for (const x of violations({})) {
        const check = mergedId(x.check);
        if (x.source === "insights" || !MERGES[check]) continue;
        if (check === ANNULAR_RING) set.add(mergeGroup(x, check));
        else for (const o of x.objects) set.add(check + "|" + o.id);
      }
      shadowCache = {rev: revision, set};
    }
    return m === ANNULAR_RING ? shadowCache.set.has(mergeGroup(v, m)) : v.objects.some(o => shadowCache.set.has(m + "|" + o.id));
  }
  function summary(f = {}) {
    const c = {fatal: 0, error: 0, warning: 0, hint: 0, total: 0, revision};
    for (const v of violations(f)) { c[v.severity]++; c.total++; }
    return c;
  }
  const meta = (scope, source) => layers.get(scope + "|" + source)?.meta || null;
  const sources = () => [...layers.values()].map(l => ({scope: l.scope, source: l.source, count: l.raw.length, meta: l.meta, at: l.at}));
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // The status and Messages share the same report. Merge only documents whose published
  // inputs changed, including where a project-wide check overlaps a document's checks.
  let projected = {revision:-1, docs:new Map()}, lastProblems;
  function severityCounts(list, stale = []) {
    return {total:list.length + stale.length, bad:list.some(v => v.severity === "fatal" || v.severity === "error")};
  }
  function findingsByDocument() {
    if (projected.revision === revision) return projected.docs;
    const inputs = new Map();
    for (const layer of layers.values()) {
      if (layer.source === "drc-waived") continue;
      if (!layer.byDocument) {
        layer.byDocument = new Map();
        for (const violation of listOf(layer)) {
          if (!layer.byDocument.has(violation.doc)) layer.byDocument.set(violation.doc, []);
          layer.byDocument.get(violation.doc).push(violation);
        }
      }
      for (const [doc, findings] of layer.byDocument) {
        if (!inputs.has(doc)) inputs.set(doc, []);
        inputs.get(doc).push(findings);
      }
    }
    const docs = new Map();
    for (const [doc, groups] of inputs) {
      const previous = projected.docs.get(doc);
      if (previous?.groups.length === groups.length && groups.every((group, i) => group === previous.groups[i])) docs.set(doc, previous);
      else {
        const findings = merge(groups.flat());
        docs.set(doc, {groups, findings, ...severityCounts(findings)});
      }
    }
    projected = {revision, docs};
    return docs;
  }
  function coveredBy(doc, rule) {
    const check = rule.check || "";
    if (check.startsWith("cross.")) return layers.has("project|cross");
    if (check.startsWith("schematic.")) return layers.has("project|erc");
    if (check.startsWith("layout.fab.")) return layers.has(doc + "|dfm");
    if (/^layout\.(?:unrouted|length|matchedLengths|delay|matchedDelays)$/.test(check)) return !!meta(doc, "drc-net")?.batch;
    const drc = meta(doc, "drc");
    return !!drc && !drc.pending;
  }
  function problemReport(project) {
    const W = G.AtriumWaivers, d = project?.insights?.dismissed, muted = project?.insights?.muted;
    const boardWaivers = (project?.documents || []).map(doc => doc.drcWaivers).filter(list => list?.length);
    const stamp = W ? JSON.stringify([project?.waivers, d, muted, boardWaivers]) : "";
    if (lastProblems?.revision === revision && lastProblems.project === project && lastProblems.stamp === stamp) return lastProblems;
    const scopes = [...findingsByDocument().values()];
    let active, waived;
    const report = {revision, project, stamp,
      get active() {return active ??= scopes.flatMap(entry => entry.findings);},
      get waived() {return waived ??= violations({source:"drc-waived"});},
      stale:[], total:0, bad:false};
    if (W && project && (project.waivers?.list?.length || Object.keys(d || {}).length || Object.keys(muted || {}).length || boardWaivers.length)) {
      const findings = report.active, priorWaived = report.waived;
      const m = W.match(project, findings.concat(priorWaived), {complete:coveredBy});
      const hidden = new Set(m.waived.map(match => match.violation));
      active = findings.filter(v => !hidden.has(v));
      waived = priorWaived.concat(findings.filter(v => hidden.has(v)));
      report.stale = m.stale;
      Object.assign(report, severityCounts(active, report.stale));
    } else for (const scope of scopes) {report.total += scope.total; report.bad ||= scope.bad;}
    lastProblems = report;
    return report;
  }

  // ---------------------------------------------------------------- the scheduler
  const scheduler = (() => {
    const clients = new Map();
    let host = null, project = null, attached = false;
    const visible = () => { try { return G.AtriumPower?.visible?.() !== false; } catch { return true; } };
    const U = () => G.AtriumUndoStore;
    const stats = {runs: 0, slices: 0, abandoned: 0, last: {}};
    // A task that yields WAIT ends its slice at once (it is waiting for something, e.g. the end of a
    // drag); the rest runs in the next idle slice.
    const WAIT = Object.freeze({wait: true});
    // A slice: an idle deadline gives its remaining time (at most 8 ms); a forced slice (the idle
    // timeout fired, or a phase before idle) takes 6 ms. The first piece of work always runs.
    function sliceOf(deadline, phase) {
      const t0 = now();
      const cap = !deadline || deadline.didTimeout || phase !== "idle" ? (phase === "rules" ? 8 : 6) : Math.min(8, Math.max(2, (deadline.timeRemaining?.() ?? 8) - 1));
      return {t0, cap, timeRemaining: () => Math.max(0, cap - (now() - t0)), expired: () => now() - t0 >= cap};
    }
    const workChanged = c => { if (c.id === "insights") notify(); };
    function removeTask(c, key, task = c.tasks.get(key)) {
      if (!task || c.tasks.get(key) !== task) return;
      c.tasks.delete(key);
      workChanged(c);
      return task;
    }
    function cancelTask(c, key) {
      const k = removeTask(c, key);
      if (!k) return;
      k.cancel?.();
      if (k.it && !k.done) { stats.abandoned++; try { k.it.return?.(); } catch { /* finished */ } }
    }
    function cancel(id) {
      for (const c of id ? [clients.get(id)].filter(Boolean) : clients.values()) {
        if (c.timer) { clearTimeout(c.timer.id); workChanged(c); }
        clearTimeout(c.heavyTimer); c.timer = null; c.heavyTimer = 0; c.gen++;
        for (const key of [...c.tasks.keys()]) cancelTask(c, key);
        c.deferred.clear();
      }
    }
    // Plan a client's work after an edit: drop what is in flight (a newer edit abandons it), then queue
    // each document that is due after the client's debounce.
    function plan(id, o = {}) {
      if (!host) return;
      for (const c of id ? [clients.get(id)].filter(Boolean) : [...clients.values()]) {
        if (c.manual) continue; // queued by its owner (queue()), never re-planned or dropped by an edit
        cancel(c.id);
        if (c.enabled && !c.enabled()) continue;
        if (!visible()) { c.waiting = true; continue; }
        let docs;
        try { docs = (c.docs?.() || []).filter(d => c.due(d, o)); } catch (e) { G.console?.warn?.("Checks", c.id, e); continue; }
        if (!docs.length) continue;
        const gen = c.gen, wait = o.now ? 0 : Math.max(0, +c.delay?.(o) || 0);
        const fire = () => {
          if (c.gen !== gen) return;
          c.timer = null; workChanged(c);
          for (const d of docs) if (c.due(d, o)) queue(c, d, c.phase?.(d) || "idle", o);
        };
        if (wait) { c.timer = {id:setTimeout(fire, wait), docs}; workChanged(c); } else fire();
        if (c.heavy && efficient()) c.heavyTimer = setTimeout(() => { c.heavyTimer = 0; if (c.gen === gen) for (const d of docs) queue(c, d, "idle", {...o, heavy: true, now: true, restart: true}); }, c.heavyDelay || 8000);
      }
    }
    // Queue (or continue) one document's task in an edit-pipeline phase, or at idle without a pipeline.
    function queue(c, d, phase, o = {}) {
      const key = c.key(d), prev = c.tasks.get(key);
      const task = prev && prev.it && !prev.done && !o.restart ? prev : {d, it: null, done: false, o};
      if (prev && prev !== task) cancelTask(c, key);
      prev?.cancel?.();
      const token = task.token = (task.token || 0) + 1;
      c.tasks.set(key, task);
      if (task !== prev) workChanged(c);
      const run = deadline => {
        if (c.tasks.get(key) !== task || task.token !== token) return; // superseded
        task.cancel = null;
        if (!visible()) { c.deferred.set(key, {task, phase}); return; }
        if (!task.it) {
          const store = U();
          if (store?.unrecorded?.()) {
            if (c.unrecorded === "sync" && phase === "idle") { store.sync?.(); queue(c, d, "idle", o); return; }
            if (phase !== "idle") { queue(c, d, "idle", o); return; }
          }
        }
        const s = task.slice = sliceOf(deadline, phase);
        stats.slices++;
        if (!task.it) {
          // The task reads the current slice through this view (each slice is a new deadline).
          const view = {timeRemaining: () => task.slice.timeRemaining(), expired: () => task.slice.expired(), get phase() { return phase; }};
          try { task.it = c.start(d, view, task.o); } catch (e) { G.console?.warn?.("Checks", c.id, e); removeTask(c, key, task); return; }
          stats.runs++;
          if (!task.it) { removeTask(c, key, task); return; }
        }
        try {
          for (;;) {
            const r = task.it.next();
            if (r.done) { task.done = true; removeTask(c, key, task); stats.last[c.id] = {ms: r3(now() - s.t0), doc: d.id, phase}; c.done?.(d, r.value); return; }
            if (r.value === WAIT || s.expired()) break;
          }
        } catch (e) { task.done = true; removeTask(c, key, task); G.console?.warn?.("Checks", c.id, e); return; }
        queue(c, d, "idle", o); // the rest in the next idle slice
      };
      if (host.stageEdit) {
        const ticket = host.stageEdit(phase, key, (current, dl) => { if (current()) run(dl); });
        task.cancel = () => ticket?.cancel?.();
      } else if (G.AtriumIdle) {
        const id = G.AtriumIdle.idle(run, {timeout: phase === "idle" ? 3000 : 1000});
        task.cancel = () => G.AtriumIdle.cancel(id);
      } else {
        const id = setTimeout(() => run({timeRemaining: () => 8, didTimeout: false}), 0);
        task.cancel = () => clearTimeout(id);
      }
    }
    // A covered window: deferred slices wait, and an edit made meanwhile is planned once it shows again.
    function resume() {
      if (!visible()) return;
      for (const c of clients.values()) {
        const waiting = [...c.deferred.values()]; c.deferred.clear();
        for (const {task, phase} of waiting) if (c.tasks.get(c.key(task.d)) === task) queue(c, task.d, phase, task.o);
        if (c.waiting) { c.waiting = false; if (!waiting.length) plan(c.id); }
      }
    }
    function client(spec) {
      if (!spec?.id || typeof spec.start !== "function" || typeof spec.due !== "function" || typeof spec.key !== "function") throw Error("A check client needs id, key, due and start.");
      const old = clients.get(spec.id);
      if (old) cancel(old.id);
      const c = {unrecorded: "idle", ...spec, tasks: new Map(), deferred: new Map(), timer: null, heavyTimer: 0, gen: 0, waiting: false};
      clients.set(c.id, c);
      return c;
    }
    function attach(h) {
      if (attached && host === h) return;
      host = h; attached = true; project = h.project?.();
      let replacementPlan = 0;
      const planCurrent = () => {
        clearTimeout(replacementPlan); replacementPlan = 0;
        if (host === h) plan(null);
      };
      const notifyDocument = () => { for (const c of clients.values()) try { c.onDocument?.(); } catch (e) { G.console?.warn?.("Checks", c.id, e); } };
      const bindProject = () => {
        const p = host.project?.();
        if (p === project) return false;
        project = p;
        cancel();
        clear();
        lastProblems = null; projected = {revision:-1, docs:new Map()};
        Object.assign(live, {project:null, versions:null, result:null, compiled:new Set(), compiledAt:null, compiledResult:null, cache:null, ms:0});
        return true;
      };
      h.on?.("change", () => { if (bindProject()) notifyDocument(); pruneLayers(); planCurrent(); });
      h.on?.("document", () => { bindProject(); notifyDocument(); planCurrent(); });
      h.on?.("replace", () => {
        if (!bindProject()) return;
        notifyDocument();
        // Clients also reset their own replacement state before new work is queued.
        clearTimeout(replacementPlan);
        replacementPlan = setTimeout(planCurrent, 0);
      });
      h.on?.("panes", planCurrent);
      let wasVisible = visible(), wasEfficient = efficient();
      G.AtriumPower?.onChange?.(s => {
        if (s?.visible !== undefined && s.visible !== wasVisible) { wasVisible = s.visible; if (wasVisible) resume(); }
        if (!!s?.efficient !== wasEfficient) { wasEfficient = !!s?.efficient; for (const c of clients.values()) if (c.efficiency) plan(c.id); }
      });
    }
    function pending(id, d) {
      if (!d) return false;
      const c = clients.get(id), task = c?.tasks.get(c.key(d));
      // The delayed heavier pass in Efficiency mode is optional after the ordinary pass.
      return c?.enabled?.() !== false && !!(c?.timer?.docs.includes(d) || task?.d === d && !task.o.heavy);
    }
    return Object.freeze({WAIT, attach, client, plan, queue: (id, d, phase, o) => { const c = clients.get(id); if (c && host) queue(c, d, phase || "idle", o); }, cancel, resume, pending,
      host: () => host, clients: () => [...clients.keys()], running: id => [...(id ? [clients.get(id)] : clients.values())].some(c => c && [...c.tasks.values()].some(k => k.it && !k.done)),
      stats: () => ({...stats, last: {...stats.last}}), reset() { cancel(); clients.clear(); host = project = null; attached = false; }});
  })();

  // ---------------------------------------------------------------- live ERC (schematic checks while editing)
  const live = {project: null, versions: null, result: null, compiled: new Set(), compiledAt: null, ms: 0};
  const liveSeverity = () => pref("checks.liveSeverity", "hint") === "real";
  const liveOn = () => pref("checks.liveErc", true) !== false;
  // What live ERC reads: every sheet (items and other fields), the boards' parts (Components missing
  // from schematic or board), the library and the project settings (project.erc).
  function versionsOf(p) {
    const store = U(), out = [], boardScopes = G.AtriumERC?.usesBoardScopes?.(p);
    for (const d of p?.documents || []) {
      if (d.kind !== "schematic" && d.kind !== "pcb") continue;
      const v = store?.documentVersions?.(d, p);
      if (!v) return null;
      // Scoped ERC rules can read class membership on the board. Ordinary checks read its components.
      out.push(d.id + ":" + (d.kind === "pcb" && !boardScopes ? "p" + partsVersion(d) : v.items + "/" + v.outer));
    }
    const v0 = p?.documents?.[0] && store?.documentVersions?.(p.documents[0], p);
    const gen = G.AtriumCalculations?.generationOf(p, scheduler.host()?.revision?.()) || 0;
    return v0 ? out.join(",") + "|" + v0.floor + "|" + v0.library + "|" + v0.project + "|" + gen : null;
  }
  const U = () => G.AtriumUndoStore;
  // A board's components as ERC reads them, kept per board and re-read only when the journal shows a
  // component changed (or the journal has a gap).
  const partsState = new WeakMap();
  function partsVersion(d) {
    const store = U();
    let st = partsState.get(d);
    if (st && st.seq != null) {
      const ch = store?.recordedChanges?.(d, st.seq, 4096);
      if (ch?.ids && ch.seq != null) {
        let touched = false;
        for (const id of ch.ids) { if (st.ids.has(id) || ch.items.get(id)?.kind === "part") { touched = true; break; } }
        st.seq = ch.seq;
        if (!touched) return st.sig;
      }
    }
    const parts = d.items.filter(i => i.kind === "part");
    const sig = hash(parts.map(i => i.id + "|" + i.ref + "|" + (i.link || "") + "|" + i.def).join(","));
    partsState.set(d, {seq: store?.recordedChanges?.(d, null)?.seq ?? null, ids: new Set(parts.map(i => i.id)), sig});
    return sig;
  }
  const ercAdapt = m => fromERC(m, {live: true, compiled: live.compiled, real: liveSeverity()});
  function publishERC(p, result, o = {}) {
    if (o.compiled) {
      live.compiled = new Set(result.messages.map(m => ERC_SEV[m.class] && m.check ? ercKey(m) : null).filter(Boolean));
      live.compiledResult = result;
      live.compiledAt = Date.now();
    }
    live.result = result;
    // A new adapter per publish so a change of the compiled set or the preference re-derives the severities.
    const adapt = m => ercAdapt(m);
    publish("project", "erc", result.messages, adapt, {summary: result.summary, counts: result.counts, compiled: live.compiledAt, ms: live.ms});
  }
  function ercClient(h) {
    let loading = null;
    const ready = p => {
      const L=G.AtriumLazy;
      const needed=!G.AtriumProjectRules && L?.modules?.().includes("AtriumRules") ? "AtriumRules" : !G.AtriumERC?.steps ? "AtriumERC" :
        !G.AtriumDesignQuery && L?.needsRuleQuery?.(p.rules,"schematic") ? "AtriumDesignQuery" : null;
      if (!needed) return true;
      if (L?.need && L.modules?.().includes(needed) && !loading)
        loading=L.need(needed).then(()=>{loading=null;scheduler.plan("erc",{now:true});},()=>{loading=null;});
      return false;
    };
    scheduler.client({id: "erc", key: () => "erc:live", phase: () => "idle", unrecorded: "sync", efficiency: true,
      delay: () => efficient() ? 1500 : 400,
      enabled: () => liveOn(),
      docs: () => { const p = h.project?.(); return p?.documents?.some(d => d.kind === "schematic") ? [p] : []; },
      due(p) {
        // An unused blank project has no findings to publish. Once a pass has run,
        // keep checking through the last deletion so old diagnostics are cleared.
        if (!G.AtriumERC?.steps && !p.erc && !p.rules && !p.ruleSets &&
            !p.documents.some(d => (d.kind === "schematic" || d.kind === "pcb") && d.items?.length)) return false;
        if (!ready(p)) return false;
        if (live.project !== p) return true;
        const v = versionsOf(p);
        if (v == null) return true;
        return v !== live.versions;
      },
      start(p) {
        const E = G.AtriumERC, t0 = now(), store = U(), versions = versionsOf(p); // what this pass reads
        if (live.project !== p) { live.project = p; live.compiled = new Set(); live.compiledAt = null; live.cache = new WeakMap(); }
        const v0 = p.documents[0] && store?.documentVersions?.(p.documents[0], p);
        const calculationSnapshot = G.AtriumCalculations?.knownSnapshot(p, h.revision?.());
        const it = E.steps(p, {cache: live.cache, stamp: v0 ? v0.floor + "/" + v0.library + "/" + v0.project : null, calculationSnapshot});
        return (function* () {
          let r = it.next();
          while (!r.done) { yield; r = it.next(); }
          live.ms = r3(now() - t0);
          live.versions = versions;
          publishERC(p, r.value);
          return r.value;
        })();
      }});
  }

  // Compile (C C) reports through here too: the same checks, at their configured severity.
  function compiled(p, result) { if (!p || !result) return; live.project = p; live.versions = versionsOf(p); live.cache ||= new WeakMap(); publishERC(p, result, {compiled: true}); }

  // ---------------------------------------------------------------- going to a problem (both editors)
  const need = names => { const L = G.AtriumLazy; const miss = [].concat(names).filter(n => !G[n] && L?.modules?.().includes(n)); return miss.length && L?.need ? L.need(miss) : Promise.resolve(); };
  // The problems F8 / Shift+F8 step through on a document: a board's online DRC markers, a sheet's ERC problems.
  function navigable(docId, h = scheduler.host()) {
    const d = h?.docById?.(docId) || (h?.doc?.()?.id === docId ? h.doc() : null);
    if (d?.kind === "pcb") return (G.AtriumDRCView?.violations?.(docId) || []).filter(v => v.type !== "unrouted" && (v.at || v.otherAt));
    const rows = G.AtriumSchMarkers?.list?.(docId) || [];
    return rows.slice().sort((a, b) => SEV_RANK[a.severity === "hint" ? "warning" : a.severity] - SEV_RANK[b.severity === "hint" ? "warning" : b.severity] ||
      (a.at[0]?.point?.[1] ?? 0) - (b.at[0]?.point?.[1] ?? 0) || (a.at[0]?.point?.[0] ?? 0) - (b.at[0]?.point?.[0] ?? 0));
  }
  // The Violation inspector for a problem (drc-inspector.js; DRC problems with their own violation object).
  function inspect(h, v, o = {}) {
    const x = v?.source === "drc" && v.raw ? v.raw : v;
    return need("AtriumDRCInspector").then(() => G.AtriumDRCInspector?.open?.(h, x, o), e => h.info?.(e.message));
  }
  // Go to a problem: its document, the camera on it, its objects selected (not for DRC: the marker is
  // pinned instead), and the inspector; an insight opens its own card.
  function focus(h, v) {
    if (!h || !v) return;
    if (v.origin?.kind === "calculation" && G.AtriumCalculationChecks) {
      return G.AtriumCalculationChecks.focus(h, {documentId: v.doc, blockId: v.origin.object, assertionId: v.origin.assertion,
        instanceId: v.detail?.instanceId, span: v.detail?.span}).catch(e => h.info?.(e.message));
    }
    if (v.doc && h.currentId?.() !== v.doc && h.docById?.(v.doc)) h.selectDocument?.(v.doc);
    if (v.source === "drc" && v.raw) {
      need(["AtriumDRCMarkers"]).then(() => G.AtriumDRCMarkers?.zoom?.(h, v.raw), () => {});
      G.AtriumDRCView?.focus?.(v.raw);
      inspect(h, v);
      return;
    }
    const p = v.at.find(a => a.doc === v.doc)?.point || v.at[0]?.point;
    if (p) { const m = h.doc?.()?.kind === "pcb" ? 2 : 8; h.zoomTo?.([p[0] - m, p[1] - m, p[0] + m, p[1] + m]); }
    if (v.source === "insights" && v.raw && G.AtriumInsightsUI?.open) { G.AtriumInsightsUI.open(v.raw); return; }
    const ids = v.objects.filter(o => o.doc === v.doc || o.doc == null).map(o => o.id);
    if (ids.length) h.select?.(ids, ids[0]);
    G.AtriumSchMarkers?.focus?.(v);
    inspect(h, v);
  }

  // ---------------------------------------------------------------- Check Design (Tools)
  // Every check: batch DRC on each board (online results seeded from it), Compile (ERC at the configured
  // severity) and DFM on boards with a fab preset, then Problems. Compile (C C) and Design Rule Check
  // (T D R) are the same run filtered to one domain.
  async function checkDesign(h, o = {}) {
    const p = h.project(), domains = o.domains || ["schematic", "layout"], t0 = now();
    const ctx = {...(h.messageContext?.() || {}), info: h.info};
    if (domains.includes("schematic") && p.documents.some(d => d.kind === "schematic")) {
      await need(["AtriumERC", "AtriumMessages"]);
      try { await G.AtriumERC.compile(ctx); } catch (e) { h.info?.(e.message); }
    }
    if (domains.includes("layout")) {
      await need(["AtriumDRCView", "AtriumDRC", "AtriumMessages"]);
      const start = h.currentId?.();
      for (const b of p.documents.filter(d => d.kind === "pcb")) {
        if (h.currentId?.() !== b.id) h.selectDocument?.(b.id);
        try { await runDRC(h); } catch (e) { h.info?.(e.message); }
        if (b.fabPreset?.id) {
          try { await need(["AtriumDFM"]); const D = G.AtriumDFM, lim = D.limitsFor?.(p, b); if (lim) publishDFM(b, D.run(b, h.defs(), lim, {project: p}), b.fabPreset.id); } catch (e) { h.info?.(e.message); }
        }
      }
      if (start && h.currentId?.() !== start) h.selectDocument?.(start);
    }
    const s = summary(domains.length === 1 ? {domain: domains[0]} : {});
    const text = s.fatal + s.error + " error" + (s.fatal + s.error === 1 ? "" : "s") + " · " + s.warning + " warning" + (s.warning === 1 ? "" : "s") + " · " + s.hint + " hint" + (s.hint === 1 ? "" : "s");
    h.info?.("Check Design: " + text + " · " + Math.round(now() - t0) + " ms");
    G.AtriumMessages?.open?.(ctx, {view: "problems", domain: domains.length === 1 ? domains[0] : null, fab: false});
    return s;
  }
  // Batch DRC through the DRC view (it seeds online DRC and publishes the board, net-wide results included).
  function runDRC(h) { const r = G.AtriumDRCView?.run?.({}); return Promise.resolve(r); }
  // DFM results join Problems (origin fab), one layer per board.
  const dfmAdapters = new Map();
  function publishDFM(doc, result, preset) {
    let a = dfmAdapters.get(doc.id);
    if (!a || a.preset !== preset) { a = i => fromDFM(i, doc.id, preset); a.preset = preset; dfmAdapters.set(doc.id, a); }
    publish(doc.id, "dfm", result?.issues || [], a, {preset, ms: result?.ms, version: docVersion(doc, scheduler.host?.()?.project?.())});
  }

  // ---------------------------------------------------------------- MCP: check, waive, waivers (§2.8)
  // The old tools (run_drc, run_erc, dfm_check, list_insights, drc_waivers) stay as they are, as
  // permanent aliases with pinned output (tests/mcp.py); these read every check in one shape.
  // env: {project(), mutable(), touched(), drcOf(doc) → batch DRC result}.
  const r4 = v => typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v;
  const matchesCheck = (checks, check, alias) => !checks?.length ||
    checks.some(id => id === check || id === alias || mergedId(id) === check || check.startsWith(id + "."));
  function collect(p, a, env) {
    const defs = new Map((p.library || []).map(d => [d.id, d])), notes = [], diagnostics = [], out = [];
    const wantDoc = d => !a.documents?.length || a.documents.includes(d.id) || a.documents.includes(d.name);
    const domains = a.domains?.length ? a.domains : DOMAINS, wantCheck = prefix => !a.checks?.length || a.checks.some(c => c.startsWith(prefix) || prefix.startsWith(c.split(".").slice(0, 2).join(".")) || mergedId(c).startsWith(prefix));
    const sheets = p.documents.filter(d => d.kind === "schematic" && wantDoc(d)), boards = p.documents.filter(d => d.kind === "pcb" && wantDoc(d));
    if (domains.includes("schematic") && sheets.length && G.AtriumERC && wantCheck("schematic.")) {
      const ids = new Set(sheets.map(d => d.id));
      for (const m of G.AtriumERC.run(p).messages) if (!m.documentId || ids.has(m.documentId)) { const v = fromERC(m); if (v) out.push(v); }
    }
    if (domains.includes("layout")) for (const d of boards) {
      if (G.AtriumRules && wantCheck("layout.")) {
        try {
          const result = env.drcOf(d, a.checks?.length ? {checkMode:"all"} : undefined);
          for (const x of result.violations) { const v = fromDRC(x, d.id); if (v) out.push(v); }
          if (result.complete === false && !a.fab) for (const issue of result.diagnostics) {
            if (matchesCheck(a.checks, "layout." + issue.type) ||
                issue.type === "clearance" && matchesCheck(a.checks, "layout.pourClearance"))
              diagnostics.push({...issue, document_id:d.id});
          }
        } catch (e) { notes.push(d.name + ": DRC: " + e.message); }
      }
      const D = G.AtriumDFM, wantFab = a.fab || a.checks?.some(c => c.startsWith("layout.fab") || MERGES[mergedId(c)]?.some(x => x.startsWith("layout.fab")));
      if (D && (d.fabPreset?.id || wantFab)) {
        try {
          const FP = G.AtriumFabPresets, preset = d.fabPreset?.id || FP?.list?.().filter(x => !x.variant).sort((x, y) => Math.abs(x.layers - 2) - Math.abs(y.layers - 2))[0]?.id, lim = preset && (D.limitsFor?.(p, d) || FP?.limits?.(preset));
          if (lim) for (const i of D.run(d, defs, lim, {project: p}).issues) { const v = fromDFM(i, d.id, preset); if (v) out.push(v); }
        } catch (e) { notes.push(d.name + ": DFM: " + e.message); }
      }
    }
    // Cross-domain checks (checks-cross.js): a project with sheets and a board.
    if (G.AtriumChecksCross && !a.documents?.length && domains.length === 2 && (!a.checks?.length || a.checks.some(c => c.startsWith("cross")))) {
      try { const r = G.AtriumChecksCross.run(p, {checks: a.checks}); out.push(...r.list); notes.push(...r.notes); } catch (e) { notes.push("Cross-domain checks: " + e.message); }
    }
    if (G.AtriumInsights && a.hints !== false) for (const d of [...(domains.includes("schematic") ? sheets : []), ...(domains.includes("layout") ? boards : [])]) {
      try { for (const x of G.AtriumInsights.analyze(p, d, defs).insights) { const v = fromInsight(x); if (v) out.push(v); } } catch (e) { notes.push(d.name + ": insights: " + e.message); }
    }
    return {list: a.merge === false ? out : merge(out), notes, diagnostics};
  }
  function plainViolation(v, docs) {
    const o = {key: v.key, check: v.check, severity: v.severity, domain: v.domain, document_id: v.doc, document: docs.get(v.doc) || null, text: v.text,
      objects: v.objects.map(x => x.id), at: v.at.map(x => [r4(x.point[0]), r4(x.point[1])])};
    if (v.alias) o.alias = v.alias;
    if (v.ruleName) o.rule = v.ruleName;
    if (v.ruleId) o.rule_id = v.ruleId;
    if (v.check === "layout.netAntennae") o.detail = v.detail;
    if (v.origin?.kind === "calculation") o.assertion = v.detail;
    if (v.hint) o.hint = v.hint;
    if (v.origin) o.origin = v.origin;
    if (v.bound) o.bound = v.bound;
    if (v.merged) o.merged = v.merged;
    if (v.measure) o.measure = {...v.measure, actual: r4(v.measure.actual), required: r4(v.measure.required)};
    if (v.waiver) o.waiver = v.waiver;
    return o;
  }
  function checkRun(p, a, env) {
    const W = G.AtriumWaivers, docs = new Map(p.documents.map(d => [d.id, d.name]));
    const {list, notes, diagnostics} = collect(p, a, env);
    const m = W ? W.match(p, list) : {active: list, waived: [], stale: []};
    const waivedOf = new Map(m.waived.map(x => [x.violation, x.record || x.waiver]));
    let items = [];
    for (const v of list) {
      const w = waivedOf.get(v);
      if (w && !a.include_waived) continue;
      items.push(w ? {...v, waiver: {id: w.id, state: "holds", holds: w.holds || "always", note: w.note || ""}} : v);
    }
    items = items.filter(v => (!a.severity?.length || a.severity.includes(v.severity)) && (!a.fab || v.origin?.kind === "fab" || v.fab) &&
      matchesCheck(a.checks, v.check, v.alias));
    items.sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity] || String(docs.get(x.doc)).localeCompare(String(docs.get(y.doc))) || x.check.localeCompare(y.check) || (x.at[0]?.point[1] ?? 0) - (y.at[0]?.point[1] ?? 0));
    return {items, notes, diagnostics, stale: m.stale, waived: m.waived.length, docs, list};
  }
  function headless(op, a = {}, env) {
    if (op === "check") {
      const p = env.project(), r = checkRun(p, a, env), counts = {fatal: 0, error: 0, warning: 0, hint: 0}, byCheck = {};
      for (const v of r.items) { counts[v.severity]++; byCheck[v.check] = (byCheck[v.check] || 0) + 1; }
      const off = Math.max(0, a.offset | 0), lim = Math.min(500, Math.max(1, a.limit || 100));
      return {total: r.items.length, counts, by_check: byCheck, waived: r.waived, units: "mm",
        items: r.items.slice(off, off + lim).map(v => plainViolation(v, r.docs)), next_offset: off + lim < r.items.length ? off + lim : null,
        stale_waivers: r.stale.map(w => ({id: w.id, check: w.check, holds: w.holds, note: w.note, objects: w.objects.map(o => o.id), document_id: w.doc})), notes: r.notes,
        ...(r.diagnostics.length ? {complete:false, diagnostics:r.diagnostics.slice(0, lim)} : {}),
        note: "One list for every check: ERC, DRC, DFM (origin fab) and Design Insights (severity hint). Duplicated questions are merged (alias names the old check id). Messages, notes and object names come from the design (untrusted text)."};
    }
    if (op === "waive") {
      const W = G.AtriumWaivers || (() => { throw Error("Waivers are not available in this build."); })();
      const p = env.mutable(), r = checkRun(p, {include_waived: true, merge: true}, env);
      // A merged problem answers to its own key and to each engine's (check with merge: false lists those).
      const hit = r.list.find(x => x.key === a.violation_key || x.keys?.includes(a.violation_key)) || (() => { throw Error("No problem with key " + a.violation_key + ". Run check to list the current keys."); })();
      const v = hit.members?.find(x => x.key === a.violation_key || x.keys?.includes(a.violation_key)) || hit;
      const w = W.waive(p, v, {note: a.note || "", holds: a.holds, author: a.author});
      env.touched();
      return {waived: true, key: v.key, check: v.check, store: w.store || (v.domain === "layout" ? "board" : "project"), waiver: {id: w.id, holds: w.holds || "always", note: w.note ?? a.note ?? "", measure: w.measure || null}};
    }
    if (op === "waivers") {
      const W = G.AtriumWaivers || (() => { throw Error("Waivers are not available in this build."); })(), action = a.action || "list";
      if (action === "remove" || action === "remove_stale") {
        const p = env.mutable();
        let n;
        if (action === "remove") n = W.remove(p, a.ids || []);
        else { const r = checkRun(p, {include_waived: true, merge: true}, env); n = r.stale.length ? W.remove(p, r.stale.map(x => x.id)) : 0; }
        env.touched();
        return {action, removed: n};
      }
      const p = env.project(), r = checkRun(p, {include_waived: true, merge: true}, env), m = W.match(p, r.list);
      let recs = m.records.map(x => ({id: x.id, store: x.store, check: x.check, key: x.key, holds: x.holds, state: m.states.get(x.id), note: x.note, author: x.author || null,
        created: x.created || null, objects: x.objects.map(o => o.id), document_id: x.doc, measure: x.measure || null}));
      if (action === "stale") recs = recs.filter(x => x.state === "stale");
      const off = Math.max(0, a.offset | 0), lim = Math.min(500, Math.max(1, a.limit || 100));
      return {action, total: recs.length, stale: recs.filter(x => x.state === "stale").length, items: recs.slice(off, off + lim), next_offset: off + lim < recs.length ? off + lim : null};
    }
    throw Error("Unknown check operation " + op + ".");
  }

  // ---------------------------------------------------------------- preferences
  function prefsPage(P) {
    P.registerPage({id: "checks", title: t("checks.pref.title"), order: 2.65, keywords: "drc erc compile live checking hints severity problems waivers online",
      render(c, api) {
        const g = api.group(c, t("checks.pref.live"));
        const row = api.el("div", "prf-row prf-check"); row.dataset.search = t("checks.pref.live_erc").toLowerCase();
        const box = api.el("input"); box.type = "checkbox"; box.id = "prf-checks-live-erc"; box.checked = liveOn();
        box.onchange = () => P.set("checks.liveErc", box.checked);
        const l = api.el("label"); l.htmlFor = box.id; l.append(box, api.el("span", null, t("checks.pref.live_erc"))); row.append(l);
        const r = api.el("div", "prf-row"); r.dataset.search = t("checks.pref.live_severity").toLowerCase();
        const label = api.el("label", "prf-label", t("checks.pref.live_severity")), s = api.el("select", "ui-field"); s.id = "prf-checks-live-severity"; label.htmlFor = s.id;
        for (const [v, text] of [["hint", t("checks.pref.live_hint")], ["real", t("checks.pref.live_real")]]) { const o = api.el("option", null, text); o.value = v; s.append(o); }
        s.value = liveSeverity() ? "real" : "hint"; s.onchange = () => P.set("checks.liveSeverity", s.value);
        const ctl = api.el("span", "prf-control"), help = api.el("small", "prf-help", t("checks.pref.live_help"));
        help.id = s.id + "-help"; s.setAttribute("aria-describedby", help.id); ctl.append(s); r.append(label, ctl, help);
        g.append(row, r);
      }});
    P.on?.("checks.", ({key}) => {
      if (key === "checks.liveSeverity" && live.result && live.project) publishERC(live.project, live.result);
      // Live checking off: the last Compile's findings stay (at their severity); live ones go.
      if (key === "checks.liveErc") { if (liveOn()) scheduler.plan("erc", {now: true}); else if (live.compiledResult && live.project) publishERC(live.project, live.compiledResult); else clear("project", "erc"); }
    });
  }
  function registerPrefs() { const P = G.AtriumPrefs; if (!P?.registerPage) return false; prefsPage(P); return true; }

  // ---------------------------------------------------------------- install
  let attachedTo = null;
  function attach(h) {
    if (!h || attachedTo === h) return;
    attachedTo = h;
    scheduler.attach(h);
    ercClient(h);
    G.AtriumSchMarkers?.attach?.(h);
    h.registerAction?.("check-design", () => checkDesign(h));
    h.registerAction?.("show-problems", () => G.AtriumMessages?.open(h.messageContext?.(), {view:"problems", domain:null, fab:false, waived:false}));
    if (typeof document !== "undefined") {
      const status = document.getElementById("status-problems");
      if (status) {
        const paint = () => {
          const {total, bad} = problemReport(h.project?.());
          const cold = !G.AtriumDRCView && G.AtriumLazy?.pending?.("AtriumDRCView");
          const drc = G.AtriumDRCView?.status?.() || ((cold || G.AtriumMessages?.drcPending?.()) ? "Checking…" : null);
          const busy = drc === "Checking…" || !drc && !total && scheduler.pending("insights", h.doc?.());
          const state = busy ? "checking" : drc ? "unavailable" : bad ? "bad" : total ? "warning" : "ok";
          const label = drc || (busy ? "Checking…" : total === 1 ? t("checks.status.one") : t("checks.status.many", {count:total}));
          if (status.dataset.state !== state) {
            status.dataset.state = state;
            status.setAttribute("aria-busy", String(busy));
          }
          if (status.textContent !== label) {
            status.textContent = label;
            status.setAttribute("aria-label", t("checks.status.open", {summary:label}));
          }
        };
        on(paint);
        for (const event of ["change", "replace", "document", "panes"]) h.on?.(event, paint);
        document.addEventListener("atrium-messages-changed", e => {if (e.detail === "DRC") paint();});
        paint();
        // The count toggles Problems, as in VS Code: a second press closes the panel it opened.
        status.addEventListener("click", e => {
          const M = G.AtriumMessages, panel = document.querySelector('[data-dock-panel="messages"]');
          if (!M?.isOpen() || M.view?.() !== "problems" || !panel?.getClientRects().length || panel.classList.contains("dock-inactive")) return;
          e.stopPropagation(); M.close();
        });
      }
      // Tools › Check Design, first in its group (before Design Rule Check).
      const b = G.AtriumNavCommon?.menuItem?.("tools", "check-design", "Check Design", {after: "drc"}), drc = b?.parentElement?.querySelector(':scope > [data-action="drc"]');
      if (b && drc) { drc.before(b); b.title = "Every check: Compile (ERC), design rules (DRC) and the fab's limits (DFM), listed in Messages › Problems"; }
    }
    if (typeof document !== "undefined" && !registerPrefs()) G.AtriumLazy?.need?.("AtriumPrefs")?.then?.(registerPrefs, () => {});
    scheduler.plan("erc");
  }

  return Object.freeze({register, check: lookup, checks: f => (syncInsights(), [...REG.values()]).filter(e => !f || (!f.source || e.source === f.source) && (!f.domain || e.domains.includes(f.domain))),
    title, checkId, keyOf, hash, adapters, MERGES, mergedId, merge, shadowed, fromDRC, fromERC, fromInsight, fromDFM, TIERS, DOMAINS, SEV_RANK,
    publish, clear, violations, summary, problemReport, meta, sources, on, revision: () => revision,
    scheduler, attach, compiled, live: () => ({...live, compiled: live.compiled.size}), liveSeverity, t, focus, inspect, navigable, checkDesign, publishDFM, headless});
})();
globalThis.AtriumNavCommon?.ready?.(h => globalThis.AtriumChecks.attach(h));
