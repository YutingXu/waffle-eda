"use strict";
// High-speed suite: xSignals (wizard, classes, query functions, rules), series terminations
// matched source pin → part → load pin, package pin delays, routing topology checks, the Parallel
// Segment and Return Path rules, and the tuning sleeve.
// JSC: scripts/test-jsc.sh high-speed
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "connectivity", "stackup", "impedance", "rigid-flex", "query", "net-intent", "signals", "rules", "timing-vision", "length-tuning", "si",
  "xsignals", "topology", "parallel-segment", "return-path", "dfa", "constraints"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, R = AtriumRules, L = AtriumLength, X = AtriumXSignals, T = AtriumTopology, S = AtriumStackup;
const Scopes = AtriumDesignQueryRecord, scope = Scopes.selector;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || "") + " " + a + " vs " + b);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
// A board in a project: rule writers (the xSignals wizard) store into the project rule book (project-rules.js).
const inProject = b => { const p = {name: "HS", library: [], documents: [b]}; AtriumSignals.attach(p); return p; };

const ic = {id: "ic", name: "IC", footprint: {shapes: [], pads: Array.from({length: 8}, (_, i) => ({number: String(i + 1), x: 0, y: 3 * i, w: .6, h: .6, shape: "rect"}))}};
const r2 = {id: "r2", name: "R", footprint: {shapes: [], pads: [{number: "1", x: -.5, y: 0, w: .5, h: .6, shape: "rect"}, {number: "2", x: .5, y: 0, w: .5, h: .6, shape: "rect"}]}};
const pad1 = {id: "pad1", name: "Pad", footprint: {shapes: [], pads: [{number: "1", x: 0, y: 0, w: .6, h: .6, shape: "rect"}]}};
const defs = new Map([[ic.id, ic], [r2.id, r2], [pad1.id, pad1]]);
let uid = 0;
const id = () => "h" + (++uid);
const part = (ref, def, x, y, pinNets) => ({id: id(), kind: "part", def, ref, value: ref, x, y, angle: 0, pinNets});
const track = (net, layer, points, width = .2) => ({id: id(), kind: "track", net, layer, width, points});
function board(items, extra = {}) { const d = A.sheet("pcb", "HS"); d.items.push(...items); return Object.assign(d, extra); }
const rule = (type, name, props) => ({id: "r-" + name, type, name, comment: "", enabled: true, priority: 1, scope: scope("all"), ...props});
function ruleSet(list, extra = {}) { const c = R.create(); c.list.push(...list); Object.assign(c, extra); return R.validate(R.normalize(c)); }

// DDR byte lane: controller U1 → DRAM U2. DQ0 runs through a 22 Ω series resistor R1 (DQ0 → R1 →
// DQ0_R); DQ1–DQ3 are direct with a small detour. Pins: 1–4 DQ0–3, 5/6 DQS0_P/N, 7/8 A0/A1.
const PIN = ["DQ0", "DQ1", "DQ2", "DQ3", "DQS0_P", "DQS0_N", "A0", "A1"];
function ddr() {
  const u1 = {}, u2 = {};
  PIN.forEach((n, i) => { u1[i + 1] = n; u2[i + 1] = n; });
  u2[1] = "DQ0_R";
  const items = [part("U1", "ic", 0, 0, u1), part("U2", "ic", 40, 0, u2), part("R1", "r2", 15, 0, {"1": "DQ0", "2": "DQ0_R"}),
    track("DQ0", "Top", [[0, 0], [14.5, 0]]), track("DQ0_R", "Top", [[15.5, 0], [40, 0]])];
  for (const i of [1, 2, 3]) { const y = 3 * i; items.push(track(PIN[i], "Top", [[0, y], [20, y], [21, y + 1], [22, y], [40, y]])); }
  return board(items);
}
const detour = 40 - 2 + 2 * Math.SQRT2;

test("series resistors are detected and matched source pin → part → load pin", () => {
  const b = ddr();
  const x = L.seriesXSignal(b, "DQ0");
  assert.ok(x, "DQ0 runs through R1");
  assert.deepEqual(x.through, ["R1"]); assert.deepEqual(x.nets, ["DQ0", "DQ0_R"]);
  assert.equal(x.from.ref, "U1"); assert.equal(x.to.ref, "U2");
  assert.deepEqual(L.seriesXSignal(b, "DQ0_R").nets, ["DQ0", "DQ0_R"], "found from either net " + JSON.stringify(L.seriesXSignal(b, "DQ0_R")));
  assert.equal(L.seriesXSignal(b, "DQ1"), null, "a direct net has none");
  const m = L.matchLength(b, defs, "DQ0_R");
  close(m.length, 14.5 + 1 + 24.5, 1e-9, "both nets plus R1's pad-to-pad length");
  close(m.series, 1, 1e-9); assert.equal(m.xSignal, "DQ0"); assert.ok(m.delay > L.netLength(b, defs, "DQ0").delay + L.netLength(b, defs, "DQ0_R").delay, "R1 adds delay");
  // Configurable: the part's own delay, or no series model at all.
  b.items.find(i => i.ref === "R1").seriesDelay = 3;
  const ps = L.matchLength(b, defs, "DQ0").delay; L.invalidate(b);
  b.lengthTuning = {version: 1, groups: [], targets: {}, seriesModel: "none"};
  close(L.matchLength(b, defs, "DQ0").length, 39, 1e-9, "seriesModel none");
  b.lengthTuning.autoXSignals = false;
  assert.equal(L.matchLength(b, defs, "DQ0").xSignal, undefined, "automatic xSignals can be turned off");
  assert.ok(ps > 0);
});

test("a DDR DQ line with a 22 Ω series resistor tunes to the group target", () => {
  const b = ddr();
  b.rules = ruleSet([rule("matchedLengths", "BYTE0", {tolerance: .1, scope: scope("netclass", "BYTE0")})], {netClasses: {BYTE0: ["DQ0", "DQ0_R", "DQ1", "DQ2", "DQ3"]}});
  let g = L.evaluate(b, defs).find(x => x.name === "BYTE0");
  assert.equal(g.members.length, 4, "DQ0 and DQ0_R are one member: " + g.members.map(m => m.name));
  const dq0 = g.members.find(m => m.name === "DQ0");
  assert.equal(dq0.kind, "xsignal"); close(dq0.length, 40, 1e-9); close(g.target, detour, 1e-9); assert.equal(dq0.status, "short");
  // DRC measures the xSignal, not the bare net (DQ0_R alone is 24.5 mm).
  let d = R.drc(b, defs, b.rules).violations.filter(v => v.type === "matchedLengths");
  assert.equal(d.length, 1, JSON.stringify(d.map(v => v.title))); close(d[0].actual, 40, 1e-9);
  // Interactive tuning target for the net is the path target less the rest of the path.
  const s = L.begin(b, defs, {net: "DQ0_R", at: [30, 0]});
  close(s.target, detour - (40 - 24.5), 1e-9, "net target");
  const ov = s.move([35, .8]); assert.equal(ov.gauge.xSignal, "DQ0"); close(ov.gauge.target, detour, 1e-9, "gauge reads the whole path");
  assert.ok(s.overlay().sleeve.outer.length === 4, "tuning sleeve");
  // Auto-tune the group.
  const res = L.autoTune(b, defs, {style: "mitered", amplitude: 1, gap: .3});
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  L.applyPlan(b, res.plan); L.invalidate(b);
  g = L.evaluate(b, defs).find(x => x.name === "BYTE0");
  assert.equal(g.fails, 0, JSON.stringify(g.members.map(m => [m.name, m.length, m.status])));
  close(g.members.find(m => m.name === "DQ0").length, detour, .1, "DQ0 path at the target");
  assert.ok(L.netLength(b, defs, "DQ0_R").length > 24.5 + .5, "the meander went on a net of the path");
  d = R.drc(b, defs, b.rules).violations.filter(v => v.type === "matchedLengths");
  assert.equal(d.length, 0, JSON.stringify(d));
});

test("xSignals wizard: DDR4 byte lane, address/command, pairs and rules", () => {
  const b = ddr();
  const p = X.plan(b, defs, {preset: "ddr4", from: "U1", to: ["U2"]});
  assert.equal(p.xSignals.length, 8);
  const dq0 = p.xSignals.find(x => x.name === "DQ0");
  assert.deepEqual(dq0.through, ["R1"]); assert.deepEqual(dq0.nets, ["DQ0", "DQ0_R"]);
  assert.deepEqual(p.classes.DDR4_BYTE0.sort(), ["DQ0", "DQ1", "DQ2", "DQ3", "DQS0_N", "DQS0_P"]);
  assert.deepEqual(p.classes.DDR4_ADDR_CMD.sort(), ["A0", "A1"]);
  assert.deepEqual(p.pairs, [{positive: "DQS0_P", negative: "DQS0_N"}]);
  const match = p.rules.find(r => r.type === "matchedDelays" && r.withinPair);
  assert.deepEqual(match?.scope, scope("xsignalclass", "DDR4_BYTE0"));
  const proj = inProject(b), res = X.apply(b, p, {project: proj});
  assert.equal(res.added, 8); assert.ok(res.rules >= 2);
  assert.ok(R.stored(b, proj).list.some(r => r.name === "DDR4_BYTE0_Match"));
  // Classification of common net spellings.
  assert.deepEqual(X.classify("DDR_DQS3_T"), {role: "dqs", lane: 3, polarity: "P"});
  assert.equal(X.classify("MEM_DQ[17]").lane, 2); assert.equal(X.classify("DM1").role, "dm"); assert.equal(X.classify("CK_C").role, "clk");
  assert.equal(X.classify("BA1").role, "acc"); assert.equal(X.classify("CKE0").role, "acc");
  // Query functions match every net the xSignal runs through.
  const Q = AtriumQuery, ctx = Q.context({library: [], documents: [b]}, b, {defs});
  const hit = text => b.items.filter(i => i.kind === "track" && Q.matcher(text, ctx)(i)).map(i => i.net).sort();
  assert.deepEqual(hit("InxSignal('DQ0')"), ["DQ0", "DQ0_R"]);
  assert.deepEqual(hit("InxSignalClass('DDR4_BYTE0')"), ["DQ0", "DQ0_R", "DQ1", "DQ2", "DQ3"]);
  const C = R.compiled(b), md = C.byType.matchedDelays.find(r => r.name === "DDR4_BYTE0_Match");
  assert.ok(md.m1({net: "DQ0_R"}) && md.m1({net: "x", xSignal: "DQS0_P"}) && !md.m1({net: "A0"}) && !md.m1({net: "x", xSignal: "A0"}));
});

test("DRC: rules scoped to xSignals check xSignal delay and length", () => {
  const b = ddr();
  const proj = inProject(b);
  X.apply(b, X.plan(b, defs, {preset: "ddr4", from: "U1", to: ["U2"]}), {project: proj});
  // Tighten the byte lane to 1 ps: DQ0 (40 mm) is ~5.6 ps faster than the detoured DQ1–3.
  const set = JSON.parse(JSON.stringify(R.effective(b, proj))); set.list.find(r => r.name === "DDR4_BYTE0_Match").tolerance = 1;
  set.list.push(rule("length", "XS_LEN", {min: 0, max: 39.5, scope: scope("xsignal", "DQ0")}));
  R.store(b, proj, set);
  const out = R.drc(b, defs, R.stored(b, proj)), md = out.violations.filter(v => v.type === "matchedDelays");
  assert.equal(md.length, 1, JSON.stringify(md)); assert.equal(md[0].xSignal, "DQ0"); assert.equal(md[0].unit, "ps");
  const len = out.violations.filter(v => v.ruleName === "XS_LEN");
  assert.equal(len.length, 1); close(len[0].actual, 40, 1e-9, "Length rule on the xSignal");
  assert.ok(out.notes.some(n => /not routed end to end/.test(n)), "unrouted DQS/A members are noted");
  // The Length Manager shows one group per xSignal rule, measured per xSignal.
  // Length Manager reads the effective native rule plan to add xSignal rule groups.
  assert.equal(typeof R.compiled, "function", "AtriumRules.compiled is exported");
  assert.ok(L.groups(b, defs).some(x => x.key === "rule:" + R.stored(b, proj).list.find(r => r.name === "DDR4_BYTE0_Match").id && x.members.every(m => m.kind === "xsignal")), "xSignal rule group in groups()");
  const g = L.evaluate(b, defs).find(x => x.name === "DDR4_BYTE0_Match");
  assert.ok(g && g.members.every(m => m.kind === "xsignal") && g.basis === "delay");
});

test("package pin delays from CSV", () => {
  const b = ddr();
  const r = X.importPinDelays(b, "Designator,Pin,Delay (ps),Length (mil)\nU1,1,12.5,\nU2,1,,100\nU9,1,3,\n");
  assert.equal(r.pins, 2); assert.deepEqual(r.unknown, ["U9"]);
  const u1 = b.items.find(i => i.ref === "U1"), u2 = b.items.find(i => i.ref === "U2");
  assert.equal(u1.pinDelays["1"], 12.5); close(u2.pinLengths["1"], 2.54, 1e-9);
  const m = L.matchLength(b, defs, "DQ0");
  close(m.die, 2.54 + 12.5 / (Math.sqrt(4.2) / .299792458), 1e-6, "pin lengths and delays in the path");
  assert.ok(m.delay > 12.5);
});

// Fly-by: controller U1 (pin 1 = A0) → U2, U3 on stubs from a trunk → R9 to VTT.
function flyBy(stub3) {
  return board([part("U1", "ic", 0, 0, {"1": "A0", "2": "X1", "3": "X2"}), part("U2", "pad1", 10, 4, {"1": "A0"}), part("U3", "pad1", 20, 5 - stub3, {"1": "A0"}),
    part("R9", "r2", 30, 0, {"1": "A0", "2": "VTT"}),
    track("A0", "Top", [[0, 0], [0, 5], [29.5, 5], [29.5, 0]]), track("A0", "Top", [[10, 5], [10, 4]]), track("A0", "Top", [[20, 5], [20, 5 - stub3]])]);
}
test("topology: fly-by stubs, terminator and load order", () => {
  const b = flyBy(3);
  const a = T.analyze(b, defs, "A0");
  assert.equal(a.source.ref, "U1"); assert.deepEqual(a.loads.map(l => l.ref), ["U2", "U3", "R9"]);
  close(a.loads.find(l => l.ref === "U3").stub, 3, 1e-9); assert.ok(a.loads.find(l => l.ref === "R9").terminator);
  let v = T.check(a, "flyBy", {maxStub: 1.5});
  assert.equal(v.length, 1, JSON.stringify(v) + JSON.stringify(T.plain(a))); assert.equal(v[0].kind, "stub"); close(v[0].actual, 3, 1e-9);
  assert.equal(T.check(T.analyze(flyBy(1), defs, "A0"), "flyBy", {maxStub: 1.5}).length, 0);
  T.setSpec(b, "A0", {source: "U1", order: ["U3", "U2", "R9"]});
  v = T.check(T.analyze(b, defs, "A0"), "flyBy", {});
  assert.ok(v.some(x => x.kind === "order"), JSON.stringify(v));
  // The Routing Topology rule runs in DRC.
  const c = flyBy(3);
  c.rules = ruleSet([rule("routingTopology", "FlyBy", {topology: "flyBy", maxStub: 1.5, priority: 0, scope: scope("net", "A0")})]);
  const out = R.drc(c, defs, c.rules), tv = out.violations.filter(x => x.type === "routingTopology");
  assert.equal(tv.length, 1); assert.ok(out.rules.some(r => r.type === "routingTopology" && r.count === 1));
  // T-branch: trunk to one point, two balanced arms; star: arms from the source.
  const t = board([part("U1", "ic", 0, 0, {"1": "C"}), part("U2", "pad1", 20, 5, {"1": "C"}), part("U3", "pad1", 20, -5, {"1": "C"}),
    track("C", "Top", [[0, 0], [10, 0]]), track("C", "Top", [[10, 0], [15, 5], [20, 5]]), track("C", "Top", [[10, 0], [15, -5], [20, -5]])]);
  const ta = T.analyze(t, defs, "C");
  assert.equal(ta.shape, "T"); assert.equal(T.check(ta, "tBranch", {branchTolerance: .1}).length, 0);
  assert.ok(T.check(ta, "starburst", {}).some(x => x.kind === "branch"), "a T is not a star");
  assert.ok(T.check(ta, "daisyChainSimple", {maxStub: 1}).some(x => x.kind === "stub"), "nor a daisy chain");
});

test("Parallel Segment rule: same layer and broadside", () => {
  const b = board([track("P", "Top", [[0, 0], [10, 0]]), track("Q", "Top", [[2, .35], [12, .35]]), track("Z", "Top", [[0, 5], [10, 5]]), track("W", "Bottom", [[0, 5.1], [10, 5.1]])]);
  b.rules = ruleSet([rule("parallelSegment", "PS", {scope2: scope("all"), gap: .25, limit: 5, layers: "same", accumulate: false})]);
  let v = R.drc(b, defs, b.rules).violations.filter(x => x.type === "parallelSegment");
  assert.equal(v.length, 1, JSON.stringify(v)); close(v[0].actual, 8, 1e-9, "overlap"); close(v[0].gap, .15, 1e-9, "edge gap");
  b.rules = ruleSet([rule("parallelSegment", "PS", {scope2: scope("all"), gap: .25, limit: 9, layers: "same", accumulate: false})]);
  assert.equal(R.drc(b, defs, b.rules).violations.filter(x => x.type === "parallelSegment").length, 0);
  // Adjacent layers (two-layer board: Top and Bottom are adjacent copper).
  b.rules = ruleSet([rule("parallelSegment", "PS", {scope2: scope("all"), gap: .25, limit: 5, layers: "adjacent", accumulate: false})]);
  v = R.drc(b, defs, b.rules).violations.filter(x => x.type === "parallelSegment");
  assert.ok(v.some(x => x.relation === "adjacent" && /Z|W/.test(x.title)), JSON.stringify(v));
  // Summed per net pair: two 3 mm runs exceed a 5 mm limit together.
  const c = board([track("P", "Top", [[0, 0], [3, 0]]), track("Q", "Top", [[0, .35], [3, .35]]), track("P", "Top", [[6, 0], [9, 0]]), track("Q", "Top", [[6, .35], [9, .35]])]);
  c.rules = ruleSet([rule("parallelSegment", "PS", {scope2: scope("all"), gap: .25, limit: 5, layers: "same", accumulate: true})]);
  assert.equal(R.drc(c, defs, c.rules).violations.filter(x => x.type === "parallelSegment").length, 1);
});

test("Return Path rule: splits, voids and a stitching via fix", () => {
  const stack = {version: 1, layers: S.build(["Signal", "Plane", "Plane", "Signal"]).layers};
  const poly = (net, layer, x0, y0, x1, y1) => ({id: id(), kind: "polygon", net, layer, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]});
  const mk = items => board(items, {outline: [[0, 0], [60, 0], [60, 40], [0, 40]], stackup: JSON.parse(JSON.stringify(stack))});
  // Inner 1 split GND | VCC under a Top track.
  const b = mk([poly("GND", "Inner 1", 0, 0, 20, 40), poly("VCC", "Inner 1", 20.5, 0, 60, 40), poly("GND", "Inner 2", 0, 0, 60, 40), track("SIG", "Top", [[5, 5], [35, 5]])]);
  b.rules = ruleSet([rule("returnPath", "RP", {voids: true, splits: true, layerChange: true, distance: 1, capDistance: 5, minVoid: .1})]);
  const v = R.drc(b, defs, b.rules).violations.filter(x => x.type === "returnPath");
  assert.ok(v.some(x => x.kind === "split-crossing") && v.some(x => x.kind === "void"), JSON.stringify(v.map(x => x.kind)));
  assert.ok(v.every(x => /Fix:/.test(x.detail) && x.at));
  // Top → Bottom through a via: references Inner 1 GND and Inner 2 GND need a GND via nearby.
  const c = mk([poly("GND", "Inner 1", 0, 0, 60, 40), poly("GND", "Inner 2", 0, 0, 60, 40), track("S2", "Top", [[5, 10], [20, 10]]),
    {id: "sv", kind: "via", net: "S2", x: 20, y: 10, diameter: .6, drill: .3}, track("S2", "Bottom", [[20, 10], [35, 10]])]);
  c.rules = b.rules;
  const rv = R.drc(c, defs, c.rules).violations.filter(x => x.type === "returnPath");
  const miss = rv.find(x => x.kind === "missing-via");
  assert.ok(miss && miss.fix && miss.fix.net === "GND", JSON.stringify(rv));
  assert.ok(Math.hypot(miss.fix.at[0] - 20, miss.fix.at[1] - 10) <= 1, "within the rule distance");
  AtriumReturnPath.apply(c, miss.fix);
  assert.equal(R.drc(c, defs, c.rules).violations.filter(x => x.type === "returnPath" && x.kind === "missing-via").length, 0, "the fix clears it");
});

test("Constraint Manager: xSignals tab with series paths, groups and topology", () => {
  const b = ddr(), project = {library: [ic, r2, pad1], documents: [b]};
  R.store(b, project, ruleSet([rule("matchedLengths", "BYTE0", {tolerance: .1, scope: scope("netclass", "BYTE0")})], {netClasses: {BYTE0: ["DQ0", "DQ0_R", "DQ1", "DQ2", "DQ3"]}}));
  const CM = AtriumConstraints, M = CM.model(project, b, defs);
  const rows = M.rows("xsignals");
  assert.deepEqual(rows.map(r => r.name), ["DQ0"], "the series path is listed automatically");
  const m = M.metrics("xsignals", rows[0]); m.heavy();
  close(m.cells.length, 40, 1e-9); close(m.cells.series, 1, 1e-9); assert.equal(m.cells.group, "BYTE0"); assert.equal(m.status, "fail");
  const set = JSON.parse(JSON.stringify(R.effective(b, project)));
  CM.setCell(set, "xsignals", rows[0], "topology", "Fly-by", M); CM.setCell(set, "xsignals", rows[0], "maxStub", 1.5, M);
  const v = R.validate(R.normalize(set)), t = v.list.find(r => r.type === "routingTopology" && Scopes.toSelector(r.scope)?.value === "DQ0");
  assert.deepEqual(t?.scope, scope("net", "DQ0"));
  assert.ok(t && t.topology === "flyBy" && t.maxStub === 1.5);
  assert.throws(() => CM.setCell(set, "xsignals", rows[0], "topology", "zigzag", M), /Topology must be one of/);
});

console.log("PASS " + passed + " high-speed tests");
