"use strict";
// The unified check engine (app/checks/checks.js):
//   - the registry covers every DRC rule type, ERC check, DFM check and Design Insight, under stable ids;
//   - the adapters turn each engine's own output into the one violation shape without losing or merging
//     anything, on the native design corpus and original public PiDP board (keys are stable, positions are not part of them, and a
//     DRC keys use rule type, rule name and the physical subject or net);
//   - the scheduler: an edit plans layout rules in the "rules" phase and hints and live ERC at idle, a
//     newer edit abandons a pass in flight, long passes run in slices, a covered window waits, nothing
//     runs while the documents are unchanged;
//   - live ERC: the sliced, graph-cached run equals a fresh run after edits; findings are hints until
//     Compile reports them, then keep their severity; the preference shows real severities.
// Run: scripts/test-jsc.sh checks   (or node tests/checks/checks.cjs)
const assert = require("node:assert/strict");
const {nativeCADCases}=require("../support/native-cad.cjs");
const {publicPiDP}=require("../support/public-pidp.cjs");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "nav-common", "spatial", "sch-objects", "hierarchy", "board-shape", "stackup", "pcb-appearance", "pcb-pours", "altium-rules",
  "pcb-draw", "component-classes", "rules", "signals", "viastack", "polygon-pour", "net-ties", "connectivity", "messages", "erc", "drc", "undo-store", "eco",
  "fab-presets", "fab-presets/jlcpcb", "pcb-text-rich", "pcb-text", "vectorize", "dfm", "insights", "insights-pcb", "insights-sch", "drc-fixes", "diagnostics", "checks", "drc-view"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../support/drc-geometry.cjs");
const K = AtriumChecks, A = Atrium, U = AtriumUndoStore, E = AtriumERC, R = AtriumRules;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const defsOf = p => new Map(p.library.map(d => [d.id, d]));

test("the registry covers every engine under namespaced ids", () => {
  for (const type of R.checkedTypes) assert.ok(K.check("layout." + type), "DRC type " + type);
  for (const type of Object.keys(R.types)) assert.ok(K.check("layout." + type), "rule type " + type);
  for (const c of E.CHECKS) assert.ok(K.check("schematic." + c.id), "ERC check " + c.id);
  assert.ok(K.check("schematic.pinMatrix"));
  for (const c of AtriumDFM.CHECKS) assert.equal(K.check("layout.fab." + c.id)?.origin, "fab", "DFM check " + c.id);
  for (const c of AtriumInsights.checks()) {
    const e = K.check((c.kind === "pcb" ? "layout" : "schematic") + ".hint." + c.id);
    assert.ok(e, "insight " + c.id); assert.deepEqual([...e.tiers], ["hint"]); assert.equal(e.incremental, c.scope);
  }
  for (const k of Object.keys(AtriumDRCFixes.EXTRA)) assert.ok(K.check("layout." + k), "extra " + k);
  assert.throws(() => K.register({id: "clearance"}), /namespaced/);
  assert.equal(K.title("layout.clearance"), R.types.clearance.title);
  assert.equal(K.title("schematic.floatingInputs"), "Floating input pins");
});

test("adapters keep every finding of every engine on the corpus, with stable position-free keys", () => {
  let total=0;
  for (const [label,design] of [...nativeCADCases(),["PiDP-11",publicPiDP()]]) {
    const p=A.validate(design), defs=defsOf(p);
    for (const d of p.documents.filter(x => x.kind === "pcb")) {
      if (d.pcbDrawing?.sourceFill) AtriumPolygonPour.adopt(d, defs, {project: p});
      const r = R.drc(d, defs, R.stored(d, p) || R.defaults(), {limit: 100000, connections: () => AtriumConnectivity.inspect(d, defs)});
      const vs = r.violations.map(v => K.fromDRC(v, d));
      assert.equal(vs.length, r.violations.length, label + ": every DRC violation converts");
      for (const [i, v] of vs.entries()) {
        const x = r.violations[i];
        assert.equal(v.raw, x); assert.equal(v.check, "layout." + x.type); assert.equal(v.domain, "layout"); assert.ok(["error", "warning"].includes(v.severity));
        const legacy = K.keyOf("layout." + x.type, x.ruleName || "", [x.id, x.otherId]);
        const net = x.net || /^Net (\S+)/.exec(x.title || "")?.[1]; // as fromDRC: the violation's net, else its title
        const padIndex = x.type === "annularRing" ? x.subject?.padIndex : null;
        if (padIndex != null) {
          assert.equal(v.key, K.keyOf(v.check, x.ruleName || "", [x.id], x.subject.padKey));
          assert.ok(v.keys.includes(legacy), "saved component-wide ring waivers retain the original key");
        } else if (x.subject?.legendPrimitive) {
          assert.equal(v.key, K.keyOf(v.check, x.ruleName || "", [x.id,x.otherId], "legend:" + x.subject.legendPrimitive),
            "physical legend primitives on the same component keep distinct identities");
        } else assert.equal(v.key, ["unrouted", "length", "matchedLengths", "delay", "matchedDelays"].includes(x.type) && net ? K.keyOf(v.check, x.ruleName || "", [], "net:" + net) : legacy,
          "the remaining keys use their objects, or the net for net-wide checks");
        assert.ok(!JSON.stringify(v).includes('"raw"'), "the engine's object is not serialised");
        if (x.actual != null) assert.equal(v.measure.actual, x.actual);
      }
      // A move keeps the key.
      const moved = K.fromDRC({...r.violations[0], at: [999, 999]}, d);
      if (vs[0]) assert.equal(moved.key, vs[0].key);
      total += vs.length;
      const dfm = AtriumDFM.run(d, defs, AtriumFabPresets.limits("jlcpcb-2l"), {project: p});
      const fv = dfm.issues.map(i => K.fromDFM(i, d, "jlcpcb-2l"));
      assert.equal(fv.filter(Boolean).length, dfm.issues.length, label + ": every DFM issue converts");
      for (const v of fv) { assert.ok(v.check.startsWith("layout.fab.")); assert.equal(v.origin.kind, "fab"); assert.ok(K.check(v.check), v.check); }
      const ins = AtriumInsights.analyze(p, d, defs).insights.map(K.fromInsight);
      for (const v of ins) { assert.equal(v.severity, "hint"); assert.ok(K.check(v.check), v.check); }
    }
    const e = E.run(p), problems = e.messages.filter(m => ["Fatal", "Error", "Warning"].includes(m.class) && m.check);
    const ev = e.messages.map(m => K.fromERC(m)).filter(Boolean);
    assert.equal(ev.length, problems.length, label + ": every ERC problem converts, Info rows do not");
    for (const v of ev) { assert.ok(K.check(v.check), v.check); assert.equal(v.domain, "schematic"); assert.ok(["fatal", "error", "warning"].includes(v.severity)); }
    total += ev.length;
  }
  assert.ok(total > 50, "the corpus has findings to convert (" + total + ")");
});

test("the store publishes lazily and filters by document, source, domain and severity", () => {
  K.clear();
  let calls = 0;
  const adapt = v => { calls++; return K.fromDRC(v, "b1"); };
  const list = [{type: "clearance", ruleName: "Clearance", id: "a", otherId: "b", at: [1, 1], actual: .1, required: .2, limit: "min", title: "A ↔ B"},
    {type: "unrouted", ruleName: "Unrouted", id: "c", at: [2, 2], title: "Net N between A and B"}];
  K.publish("b1", "drc", list, adapt);
  assert.equal(calls, 0, "nothing converts on publish");
  assert.equal(K.violations({doc: "b1"}).length, 2); assert.equal(calls, 2);
  K.violations({doc: "b1"}); assert.equal(calls, 2, "conversion is cached until the next publish");
  assert.equal(K.publish("b1", "drc", list, adapt), false, "the same list publishes nothing");
  assert.deepEqual(K.violations({severity: "warning"}).map(v => v.check), ["layout.unrouted"]);
  const s = K.summary({doc: "b1"}); assert.equal(s.error, 1); assert.equal(s.warning, 1);
  K.publish("project", "erc", [{class: "Warning", check: "unconnectedPins", text: "Unconnected pin U1-1", documentId: "s1", objectId: "u1", point: [0, 0]}], m => K.fromERC(m));
  assert.equal(K.violations({domain: "schematic"}).length, 1); assert.equal(K.violations({doc: "s1"}).length, 1);
  K.clear("b1"); assert.equal(K.violations({domain: "layout"}).length, 0);
  K.clear();
});

test("duplicate checks merge: one finding per object, the stricter limit, old ids as aliases", () => {
  K.clear();
  const drc = [{type: "annularRing", ruleId: "r", ruleName: "MinimumAnnularRing", id: "v1", at: [0, 0], actual: .05, required: .1, limit: "min", title: "Via v1"},
    {type: "holeToHole", ruleId: "h", ruleName: "HoleToHole", id: "v3", otherId: "v4", at: [5, 5], actual: .2, required: .3, limit: "min", title: "Via ↔ Via"}];
  K.publish("b", "drc", drc, v => K.fromDRC(v, "b"));
  K.publish("b", "dfm", [{check: "ring", level: "error", title: "Annular ring", text: "Via: annular ring 0.05 mm is below the 0.13 mm via minimum.", id: "v1", at: [0, 0], actual: .05, required: .13},
    {check: "holeToHole", level: "error", title: "Pad hole to hole", text: "holes 0.2 mm apart (minimum 0.25 mm).", id: "v3", otherId: "v4", at: [5, 5], actual: .2, required: .25}], i => K.fromDFM(i, "b", "jlcpcb-2l"));
  K.publish("b", "insights", [{check: "ringMin", kind: "pcb", severity: "tip", message: "Ring at the minimum", objects: ["v1"], at: [0, 0], doc: "b", key: "ringMin:aa"},
    {check: "ringMin", kind: "pcb", severity: "tip", message: "Ring at the minimum", objects: ["v2"], at: [3, 0], doc: "b", key: "ringMin:bb"}], K.fromInsight);
  const merged = K.violations({doc: "b", merge: true});
  const ring = merged.filter(v => v.check === "layout.annularRing");
  assert.equal(ring.length, 2, "v1 once (DRC, DFM and the hint together) and v2's hint");
  const v1 = ring.find(v => v.objects[0].id === "v1");
  assert.equal(v1.severity, "error"); assert.equal(v1.measure.required, .13, "the stricter limit (the fab's 0.13 mm over the rule's 0.1 mm)");
  assert.equal(v1.bound, "fab"); assert.ok(v1.fab); assert.match(v1.text, /the fab's limit \(jlcpcb-2l\) applied/); assert.deepEqual(v1.merged, ["layout.annularRing"]);
  const v2 = ring.find(v => v.objects[0].id === "v2");
  assert.equal(v2.severity, "hint"); assert.equal(v2.alias, "layout.hint.ringMin");
  const h = merged.filter(v => v.check === "layout.holeToHole");
  assert.equal(h.length, 1); assert.equal(h[0].measure.required, .3, "the rule's 0.3 mm is stricter here"); assert.equal(h[0].bound, "rule");
  assert.equal(K.violations({doc: "b", merge: true, check: "layout.fab.ring"}).length, 2, "the old id filters the merged check");
  assert.equal(K.violations({doc: "b"}).length, 6, "without merge every engine's finding is there");
  assert.ok(K.shadowed(K.fromInsight({check: "ringMin", kind: "pcb", objects: ["v1"], at: [0, 0], doc: "b", key: "ringMin:aa"})), "the v1 hint's marker is left out");
  assert.ok(!K.shadowed(K.fromInsight({check: "ringMin", kind: "pcb", objects: ["v2"], at: [3, 0], doc: "b", key: "ringMin:bb"})));
  K.clear();
});

// Review regressions (2026-11-20): pair checks, same-engine findings, waived rows, keys.
test("merge groups pair checks by both objects and never merges two findings of one engine", () => {
  const drc = [
    {type: "silkToMask", ruleName: "SilkToMask", id: "S1", otherId: "P1", actual: 0, required: .1, limit: "min", at: [0, 0], title: "S1 ↔ P1"},
    {type: "silkToMask", ruleName: "SilkToMask", id: "S1", otherId: "P2", actual: .05, required: .1, limit: "min", at: [1, 0], title: "S1 ↔ P2"},
    {type: "holeToHole", ruleName: "H2H", id: "V9", otherId: "V1", actual: .2, required: .25, limit: "min", at: [5, 5], title: "V9 ↔ V1"},
    {type: "holeToHole", ruleName: "H2H", id: "V9", otherId: "V2", actual: .2, required: .25, limit: "min", at: [6, 5], title: "V9 ↔ V2"}].map(x => K.fromDRC(x, "B"));
  const dfm = [K.fromDFM({check: "holeToHole", level: "error", title: "Hole to hole", text: "x", id: "V1", otherId: "V9", actual: .2, required: .3, at: [5, 5]}, "B", "jlc"),
    K.fromDFM({check: "acid", level: "warning", title: "Acid trap", text: "j1", id: "T1", at: [0, 0], actual: 30, required: 45, unit: "°"}, "B", "jlc"),
    K.fromDFM({check: "acid", level: "warning", title: "Acid trap", text: "j2", id: "T1", at: [9, 9], actual: 20, required: 45, unit: "°"}, "B", "jlc")];
  const m = K.merge([...drc, ...dfm]);
  assert.equal(m.length, 6, "S1↔P1, S1↔P2, V9↔V1 (DRC and DFM, in either order), V9↔V2 and both acid traps");
  const h = m.filter(v => v.check === "layout.holeToHole");
  assert.equal(h.length, 2);
  const both = h.find(v => v.objects.some(o => o.id === "V1"));
  assert.equal(both.measure.required, .3); assert.equal(both.bound, "fab"); assert.ok(both.keys.includes(drc[2].key), "the merged problem answers to the DRC finding's key too");
  assert.ok(!m.filter(v => v.alias === "layout.fab.acid" || v.check === "layout.fab.acid").some(v => /stricter/.test(v.text)), "one engine's two findings are not 'stricter of' each other");
  assert.equal(m.filter(v => v.check === "layout.silkToMask").length, 2);
});

test("ERC keys: structured, not the message text; net-wide DRC keyed on the net", () => {
  const e1 = {class: "Warning", check: "danglingWires", text: "Unconnected wire end on net Net-7", sig: "end:0", documentId: "S", objectId: "W1", point: [0, 0]};
  assert.equal(K.fromERC(e1).key, K.fromERC({...e1, text: "Unconnected wire end on net Net-8"}).key, "an auto net renumbered by an unrelated edit keeps the key");
  assert.notEqual(K.fromERC(e1).key, K.fromERC({...e1, sig: "end:1"}).key, "the two ends of one wire are two findings");
  // A real wire dangling at both ends.
  const sheet = {kind: "schematic", id: "s", name: "S", items: [{kind: "wire", id: "w", points: [[0, 0], [10, 0]]}]};
  const keys = E.run({format: "atrium", name: "P", library: [], documents: [sheet]}).messages.filter(m => m.check === "danglingWires").map(m => K.fromERC(m).key);
  assert.equal(new Set(keys).size, 2);
  const len = (id, title) => K.fromDRC({type: "matchedLengths", ruleName: "DDR", id, actual: 48, required: 49, limit: "min", title}, "B");
  const a = len("T1", "Net A against longest 50 mm"), b = len("T7", "Net A against longest 52 mm");
  assert.equal(a.key, b.key, "a net-wide finding keeps its key when its representative track or target changes");
  assert.deepEqual(a.subject, {net: "A"});
});

test("waived board violations are neither problems nor counted, and are listed once on request", () => {
  K.clear();
  const dv = {type: "clearance", ruleName: "Clearance", id: "t1", otherId: "t2", actual: .1, required: .2, limit: "min", at: [1, 1], title: "t1 ↔ t2"}, a = v => K.fromDRC(v, "b");
  K.publish("b", "drc", [], a);
  K.publish("b", "drc-waived", [{...dv, waived: {id: "w1", note: "ok"}}], a);
  assert.equal(K.violations({}).length, 0); assert.equal(K.summary({}).error, 0);
  assert.equal(K.violations({waived: true}).length, 1); assert.equal(K.violations({source: "drc-waived"}).length, 1);
  K.clear();
});

test("the status and Problems share an incremental report across documents, sources and waivers", () => {
  K.clear();
  require("../../app/checks/waivers.js");
  const W = AtriumWaivers, p = A.project("Two boards");
  const first = p.documents.find(doc => doc.kind === "pcb"), other = A.sheet("pcb", "Other board");
  p.documents.push(other);
  for (const board of [first, other]) board.items.push({id:A.id(), kind:"via", x:1, y:1, w:.4, drill:.2});
  const ring = (id, required) => ({type:"annularRing",ruleName:"Ring",id,at:[1,1],actual:.05,required,limit:"min",title:"Via"});
  const fab = id => ({check:"ring",level:"error",title:"Ring",text:"Fab ring",id,actual:.05,required:.13,at:[1,1]});
  let reads = 0;
  for (const board of [first, other]) {
    K.publish(board.id, "drc", [ring(board.items[0].id,.1)], finding => {
      if (board === other) reads++;
      return K.fromDRC(finding, board);
    });
    K.publish(board.id, "dfm", [fab(board.items[0].id)], finding => {
      if (board === other) reads++;
      return K.fromDFM(finding, board, "sample");
    });
  }
  const initial = K.problemReport(p);
  assert.equal(initial.total, 2);
  assert.strictEqual(initial, K.problemReport(p), "the status and the panel reuse the report at the same revision");
  const stable = initial.active.find(v => v.doc === other.id);
  assert.equal(stable.merged.length, 1, "the unaffected scope actually has a cross-source merged record");
  W.waive(p, initial.active.find(v => v.doc === first.id), {holds:"always"});
  assert.equal(K.problemReport(p).total, 1, "the project-level view honors a real board waiver immediately");
  const oldReads = reads;
  K.publish(first.id, "drc", [ring(first.items[0].id,.15)], finding => K.fromDRC(finding, first));
  const next = K.problemReport(p);
  assert.equal(reads, oldReads, "a publication does not adapt untouched raw records again");
  assert.strictEqual(next.active.find(v => v.doc === other.id), stable, "the unaffected merge result is reused");
  const full = K.violations({merge:true}), waived = new Set(W.match(p, full).waived.map(match => match.violation));
  const keys = list => list.map(v => [v.key,v.source,v.measure?.required].join("|")).sort();
  assert.deepEqual(keys(next.active), keys(full.filter(v => !waived.has(v))));
  assert.deepEqual(keys(next.waived), keys([...waived]));
  assert.equal(next.total, next.active.length + next.stale.length);
  K.clear();
});

// ---------------------------------------------------------------- the scheduler
const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
const timers = new Map(), jobs = new Map(), listeners = new Map();
let serial = 0, visible = true;
const powerFns = new Set();
function harness(project, panes) {
  globalThis.setTimeout = (fn, delay) => { const id = ++serial; timers.set(id, {fn, delay}); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.AtriumPower = {visible: () => visible, efficient: () => false, onChange: fn => { powerFns.add(fn); return () => powerFns.delete(fn); }};
  const host = {project: () => project.value, doc: () => panes.value[0], panes: () => panes.value.map(d => ({docId: d.id})), docById: id => project.value.documents.find(d => d.id === id),
    defs: () => defsOf(project.value), invalidate() {}, invalidateDocument() {}, registerAction() {}, addRenderer() {}, units: () => "mm", info() {},
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    stageEdit(phase, key, fn) { const job = {phase, key, fn}; jobs.set(key, job); return {cancel() { if (jobs.get(key) === job) jobs.delete(key); }}; }};
  return host;
}
const emit = name => { for (const f of listeners.get(name) || []) f(); };
const timersOut = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } };
function drain(budget = 100, order = []) {
  for (let guard = 0; guard < 500; guard++) {
    timersOut();
    const rank = {connectivity: 0, airwires: 1, pours: 2, rules: 3, idle: 4};
    const next = [...jobs.values()].sort((a, b) => rank[a.phase] - rank[b.phase])[0];
    if (!next) return order;
    jobs.delete(next.key); order.push(next.phase + ":" + next.key);
    next.fn(() => true, {timeRemaining: () => budget});
  }
  throw Error("the scheduler does not settle");
}

test("one scheduler: layout rules first, hints and live ERC at idle, abandon, slices, covered windows", () => {
  require("../../app/canvas/canvas-hover.js");
  require("../../app/checks/problem-marks.js");
  require("../../app/checks/insights-ui.js");
  const pkg = {id: "pkg", footprint: {pads: [{kind: "pad", number: "1", layer: "Top", x: 0, y: 0, w: .5, h: 1, shape: "rect"}], shapes: []}};
  const res = {id: "res", name: "R", prefix: "R", symbol: {pins: [{number: "1", name: "1", x: 0, y: 0, electrical: 4}, {number: "2", name: "2", x: 10, y: 0, electrical: 4}]}, footprint: pkg.footprint};
  const sheet = {kind: "schematic", id: "s", name: "Sheet", items: [{kind: "part", id: "r1", def: "res", ref: "R1", x: 0, y: 0, angle: 0}]};
  const board = {kind: "pcb", id: "b", name: "Board", outline: [[-15, -15], [15, -15], [15, 15], [-15, 15]], items: [
    {kind: "part", id: "p", def: "pkg", ref: "U1", x: 0, y: 0, angle: 0, layer: "Top", pinNets: {"1": "A"}},
    {kind: "track", id: "t", net: "B", width: .2, layer: "Top", points: [[.4, -.25], [.4, .25]]}]};
  const project = {value: {format: "atrium", name: "Sched", library: [pkg, res], documents: [sheet, board]}}, panes = {value: [board]};
  const realPerformance = globalThis.performance;
  try {
    // As when a project opens: its first state is not recorded yet when the checks first run.
    U.reset(); U.touch(project.value);
    K.scheduler.reset(); K.clear();
    const host = harness(project, panes);
    const recording = AtriumDiagnostics.startPerformance();
    let first;
    try {
      AtriumNavCommon.hostReady(host); // checks.js, drc-view.js and insights-ui.js attach as in the editor
      first = drain();
      const rows = AtriumDiagnostics.performanceSnapshot().rows;
      for (const component of ["drc", "erc", "insights"]) {
        const check = rows.find(row => row.component === component && row.operation === "check");
        const publish = rows.find(row => row.component === component && row.operation === "publish");
        assert.ok(check.counts.queued >= 1 && check.counts.ready >= 1 && check.counts.completed >= 1, component + " ran through the live scheduler");
        assert.ok(publish.counts.completed >= 1, component + " published to the live store");
      }
    } finally { recording.stop(); }
    assert.ok(first.includes("idle:online-drc:b"), "a board's first check waits for idle: " + first);
    assert.ok(first.includes("idle:erc:live"), "live ERC runs at idle: " + first);
    assert.ok(first.includes("idle:insights:b"), "Design Insights run at idle");
    assert.ok(K.violations({doc: "b", source: "drc"}).some(v => v.check === "layout.clearance"), "online DRC publishes to the store");
    assert.ok(K.violations({source: "erc"}).some(v => v.check === "schematic.unconnectedPins" && v.severity === "hint" && v.hint === "warning"), "live ERC is the hint tier until Compile");

    // An edit: layout rules in the rules phase, before the idle work. The first edit after opening is
    // incremental: the first check recorded the journal, so the board's versions are known.
    const drc0 = AtriumRules.drc, whole = [];
    AtriumRules.drc = (d, ...rest) => { whole.push(d === board); return drc0(d, ...rest); };
    board.items[1].points = [[8.4, -.25], [8.4, .25]]; U.touch(project.value); U.sync(project.value); emit("change");
    let order;
    try { order = drain(); } finally { AtriumRules.drc = drc0; }
    assert.ok(whole.length && !whole.includes(true), "the first edit after opening re-checks a sub-board, not the whole board: " + JSON.stringify(whole));
    assert.equal(order[0], "rules:online-drc:b", "the layout rules of an edit run first, right after its frame: " + order);
    assert.ok(order.includes("idle:insights:b"), "then the hints of the edit");
    assert.ok(!order.includes("idle:erc:live"), "a board edit with no sheet open leaves live ERC alone: " + order);
    assert.ok(!K.violations({doc: "b", source: "drc"}).some(v => v.check === "layout.clearance"));

    // Nothing runs while the documents are unchanged.
    emit("change"); assert.deepEqual(drain(), [], "no work without a change");

    // A schematic edit re-runs live ERC (sliced), and a newer edit abandons the pass in flight.
    panes.value = [sheet, board]; emit("panes"); drain();
    sheet.items.push({kind: "part", id: "r2", def: "res", ref: "R2", x: 40, y: 0, angle: 0}); U.touch(project.value); U.sync(project.value); emit("change");
    timersOut();
    assert.ok(jobs.get("erc:live"), "live ERC is queued after a sheet edit");
    // Slices: a task of 3 ms steps gets one step per slice when the idle period has no time left.
    let steps = 0, elapsed = 0;
    globalThis.performance = {now: () => elapsed};
    K.scheduler.client({id: "slow", key: d => "slow:" + d.id, phase: () => "idle", docs: () => [board], due: () => true,
      start: () => (function* () { for (let i = 0; i < 4; i++) { elapsed += 3; steps++; yield; } })()});
    K.scheduler.plan("slow"); timersOut();
    jobs.get("slow:b").fn(() => true, {timeRemaining: () => 0});
    assert.equal(steps, 1, "one step per slice when the idle period has no time left");
    assert.ok(K.scheduler.running("slow") && jobs.has("slow:b"), "the rest continues in the next idle slice");
    jobs.get("slow:b").fn(() => true, {timeRemaining: () => 100});
    assert.equal(steps, 4, "an idle period with time runs up to 8 ms");
    // A newer edit abandons a pass in flight.
    K.scheduler.plan("slow"); timersOut(); jobs.get("slow:b").fn(() => true, {timeRemaining: () => 0});
    const abandoned = K.scheduler.stats().abandoned;
    sheet.items.push({kind: "part", id: "r3", def: "res", ref: "R3", x: 80, y: 0, angle: 0}); U.touch(project.value); U.sync(project.value); emit("change");
    assert.ok(K.scheduler.stats().abandoned > abandoned, "a newer edit abandons the pass in flight");
    assert.ok(!jobs.has("slow:b") || !K.scheduler.running("slow") || steps === 5, "the abandoned pass does not continue");
    const before = steps;
    drain();
    assert.ok(steps - before <= 4, "a fresh pass starts after the edit");
    K.scheduler.client({id: "slow", key: d => "slow:" + d.id, docs: () => [], due: () => false, start: () => null});
    globalThis.performance = realPerformance;
    const live = K.violations({source: "erc"});
    const fresh = E.run(project.value).messages.filter(m => ["Error", "Warning", "Fatal"].includes(m.class));
    assert.equal(live.length, fresh.length, "the sliced, cached live run equals a fresh run");
    assert.ok(live.some(v => v.text.includes("R3")));

    // Compile: its findings keep their severity while live; a new finding is a hint until the next Compile.
    K.compiled(project.value, E.run(project.value));
    assert.ok(K.violations({source: "erc"}).every(v => v.severity !== "hint"), "Compile reports at the configured severity");
    sheet.items.push({kind: "part", id: "r4", def: "res", ref: "R4", x: 120, y: 0, angle: 0}); U.touch(project.value); U.sync(project.value); emit("change"); drain();
    const after = K.violations({source: "erc"});
    assert.ok(after.filter(v => v.text.includes("R4")).every(v => v.severity === "hint"), "a finding since Compile is a hint");
    assert.ok(after.filter(v => v.text.includes("R3")).every(v => v.severity === "warning"), "a compiled finding keeps its severity");

    // A covered window: the edit waits until the window shows again.
    visible = false; for (const f of powerFns) f({visible: false});
    board.items[1].points = [[.4, -.25], [.4, .25]]; U.touch(project.value); U.sync(project.value); emit("change");
    assert.deepEqual(drain(), [], "a covered window sleeps through the edit");
    visible = true; for (const f of powerFns) f({visible: true});
    assert.ok(drain().includes("rules:online-drc:b"), "the edit is checked once the window shows");
    assert.ok(K.violations({doc: "b", source: "drc"}).some(v => v.check === "layout.clearance"));

    let closed = 0, completed = 0;
    K.scheduler.client({id:"owned-check", key:d => "owned:" + d.id, manual:true, docs:() => [], due:() => false,
      start:() => (function* () { try { yield K.scheduler.WAIT; } finally { closed++; } })(), done() {completed++;}});
    K.scheduler.queue("owned-check", board, "idle");
    jobs.get("owned:b").fn(() => true, {timeRemaining:() => 0});
    const previousTask = jobs.get("owned:b");
    const previousFindings = K.violations({doc:"b", source:"drc"});
    const browserDocument = globalThis.document;
    if (!browserDocument) globalThis.document = {removeEventListener() {}};
    try {emit("document");}
    finally {if (!browserDocument) delete globalThis.document;}
    assert.equal(closed,0,"navigation within the same project keeps a project-owned check running");
    assert.deepEqual(K.violations({doc:"b",source:"drc"}),previousFindings);
    const replacement = {...board, items:[]};
    project.value = {format:"atrium",name:"Replacement", library:[pkg,res], documents:[replacement]};
    panes.value = [replacement];
    U.reset(); U.touch(project.value); U.sync(project.value);
    emit("replace");
    assert.equal(closed,1,"replacement releases a pending check from the previous project");
    assert.equal(completed,0);
    assert.deepEqual(K.violations({}),[],"old findings clear even when the replacement reuses the document ID");
    previousTask.fn(() => true,{timeRemaining:() => 100});
    assert.equal(completed,0,"the old callback cannot publish after replacement");
    const replacementChecks = drain();
    assert.ok(replacementChecks.includes("idle:online-drc:b"),"a clean project replacement schedules its own check");
    assert.ok(replacementChecks.includes("idle:insights:b"),"Insights runs after its replacement hook clears the old work");
    assert.deepEqual(K.violations({doc:"b",source:"drc"}),[]);
  } finally {
    globalThis.performance = realPerformance;
    K.scheduler.reset(); U.reset(); globalThis.setTimeout = setTimer; globalThis.clearTimeout = clearTimer; delete globalThis.AtriumPower;
  }
});

console.log(passed + " checks tests passed");
