"use strict";
// Timing Vision and time-domain tuning (app/pcb/timing-vision.js): delay model with vias,
// delay-based matched groups, delay targets for the tuner, DRC delay rules, Constraint
// Manager delay columns, the status map Timing Vision colours tracks with, and the HUD.
// Node: node tests/analysis/timing.cjs   JSC: scripts/test-jsc.sh timing
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/checks/connectivity.js");
require("../../app/pcb/stackup.js");
require("../../app/analysis/impedance.js");
require("../../app/checks/rules.js");
require("../../app/pcb/timing-vision.js");
require("../../app/pcb/length-tuning.js");
require("../../app/checks/dfa.js");
require("../../app/checks/constraints.js");
const T = globalThis.AtriumTiming, L = globalThis.AtriumLength, R = globalThis.AtriumRules, A = globalThis.Atrium, CM = globalThis.AtriumConstraints;
const selectScope = AtriumDesignQueryRecord.selector;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || "") + " " + a + " vs " + b);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

const padDef = {id: "pad1", name: "Pad", footprint: {shapes: [], pads: [{number: "1", x: 0, y: 0, w: .6, h: .6, shape: "rect"}]}};
const thDef = {id: "th1", name: "TH", footprint: {shapes: [], pads: [{number: "1", x: 0, y: 0, w: .8, h: .8, shape: "round", drill: .4}]}};
const defs = new Map([[padDef.id, padDef], [thDef.id, thDef]]);
let uid = 0;
const id = () => "i" + (++uid);
const part = (ref, x, y, net, extra = {}) => ({id: id(), kind: "part", def: extra.def || "pad1", ref, value: ref, x, y, angle: 0, pinNets: {"1": net}, ...extra});
const track = (net, layer, points, width = .2) => ({id: id(), kind: "track", net, layer, width, points});
const via = (net, x, y) => ({id: id(), kind: "via", net, x, y, diameter: .6, drill: .3, fromLayer: "Top", toLayer: "Bottom"});
function board(items, extra = {}) { const d = A.sheet("pcb", "Test"); d.items.push(...items); return Object.assign(d, extra); }
// A net from (0,y) to (len,y) on a layer, with pads at both ends.
const line = (net, y, len, layer = "Top", width = .2) => [part("U" + net, 0, y, net, {def: layer === "Top" ? "pad1" : "th1"}), part("J" + net, len, y, net, {def: layer === "Top" ? "pad1" : "th1"}), track(net, layer, [[0, y], [len, y]], width)];
const rule = (type, name, props) => ({id: "t-" + name, type, name, comment: "", enabled: true, priority: 1, scope: selectScope("all"), ...props});
function rules(list, extra = {}) { const c = R.create(); c.list.push(...list); Object.assign(c, extra); R.validate(c); return c; }

test("delay model: per-layer εeff from the stack-up and a via model", () => {
  const b = board([]);
  const m = T.model(b, defs);
  const top = m.factor("Top", .2), inner = m.factor("Inner 1", .2);
  // FR-4 microstrip runs between √((εr+1)/2)/c and √εr/c.
  assert.ok(top > Math.sqrt(2.6) / T.C0 * .95 && top < Math.sqrt(4.6) / T.C0, "microstrip " + top);
  assert.equal(m.factor("Top", .2), top, "cached");
  assert.ok(inner >= top, "stripline is slower than microstrip");
  // Via: barrel × √εr/c plus the lumped pad term (≈ 11 ps for 0.6 mm pad, 1.1 mm antipad, 1.6 mm FR-4).
  const v = m.via({diameter: .6}, "Top", "Bottom");
  close(v.length, m.zOf("Bottom") - m.zOf("Top"), 1e-9, "full barrel, copper centre to centre"); assert.ok(v.length > 1.4 && v.length <= m.thickness);
  assert.ok(v.barrel > 9 && v.barrel < 13, "barrel " + v.barrel);
  assert.ok(v.lumped > 5 && v.lumped < 20, "lumped " + v.lumped);
  close(v.ps, v.barrel + v.lumped, 1e-9);
  // A blind via crosses only part of the stack.
  const blind = m.via({diameter: .6}, "Top", "Inner 1");
  assert.ok(blind.length < v.length && blind.ps < v.ps);
  // Settings: barrel-only model.
  const b2 = board([], {timing: {viaModel: "barrel"}});
  assert.equal(T.model(b2, defs).via({diameter: .6}).lumped, 0);
  assert.ok(m.typicalVia > 15 && m.typicalVia < 30, "typical via " + m.typicalVia);
});

test("net delay follows the layer mix and counts vias with the via model", () => {
  const items = [part("U1", 0, 0, "S"), part("U2", 20, 0, "S"), track("S", "Top", [[0, 0], [10, 0]]), via("S", 10, 0), track("S", "Bottom", [[10, 0], [20, 0]])];
  const b = board(items), m = T.model(b, defs);
  const t = T.netTiming(b, defs, "S");
  const want = 10 * m.factor("Top", .2) + 10 * m.factor("Bottom", .2) + m.via({diameter: .6}).barrel + m.viaPs;
  close(t.delay, want, 0.05, "delay");
  close(T.netDelay(b, defs, "S"), t.delay, 1e-9);
  // Without the length engine the fallback agrees on the same simple net.
  const save = globalThis.AtriumLength; globalThis.AtriumLength = undefined;
  try { close(T.netTiming(b, defs, "S").delay, want, .3, "fallback"); } finally { globalThis.AtriumLength = save; }
  // speed and lengthFor invert each other.
  const target = t.delay + 30, len = T.lengthFor(b, defs, "S", target);
  close(t.length + (target - t.delay) / T.speedOf(b, defs, "S"), len, 1e-9);
});

test("DRC: Propagation Delay and Matched Delays rules, with pair phase", () => {
  const items = [...line("A", 0, 20), ...line("B", 3, 30), ...line("P_P", 6, 25), ...line("P_N", 7, 24)];
  const b = board(items);
  const set = rules([rule("delay", "Delay", {min: 150, max: 160, scope: selectScope("net", "A")}), rule("delay", "DelayB", {min: 150, max: 160, scope: selectScope("net", "B")}), rule("matchedDelays", "MD", {tolerance: 5, withinPair: true, pairTolerance: 1})],
    {diffPairs: [{name: "P", positive: "P_P", negative: "P_N"}]});
  b.rules = set;
  const out = R.drc(b, defs, set);
  const d = out.violations.filter(v => v.type === "delay"), md = out.violations.filter(v => v.type === "matchedDelays");
  const tA = T.netDelay(b, defs, "A"), tB = T.netDelay(b, defs, "B");
  assert.ok(tA < 150 && tB > 160, "fixture " + tA + " " + tB);
  assert.deepEqual(d.map(v => [v.title, v.delay.limit]).sort(), [["Net A", "min"], ["Net B", "max"]]);
  assert.ok(d.every(v => /ps/.test(v.detail) && v.unit === "ps" && v.at && v.actual == null), "ps detail, not mm measurements");
  // Matched delays: everyone but the slowest (B) is short; the pair skews by about 1 mm ≈ 6 ps.
  assert.deepEqual(md.filter(v => v.what === "Delay").map(v => v.title.split(" ")[1]).sort(), ["A", "P_N", "P_P"]);
  const skew = md.find(v => v.what === "Phase skew");
  assert.ok(skew && skew.delay.actual > 4 && skew.delay.actual < 9, "phase skew " + skew?.delay.actual);
  assert.ok(out.rules.filter(r => r.type === "delay").every(r => r.count === 1));
  assert.ok(out.notes.some(n => /Delay from the/.test(n)));
  // Descriptions and validation of ps fields.
  assert.match(R.describe(set.list.find(r => r.type === "delay")), /Propagation Delay Constraint \(Min delay=150ps Max delay=160ps\)/);
  assert.throws(() => rules([rule("delay", "Bad", {min: -1, max: null})]), /delay from 0/);
  rules([rule("delay", "Open", {min: 10, max: null})]);
  // The online subset types exclude net-wide delay checks.
  assert.ok(R.types.delay && R.checkedTypes.includes("delay") && R.checkedTypes.includes("matchedDelays"));
});

test("delay-based matched groups: targets, statuses, auto-tune reaches the delay", () => {
  // Same lengths, different layers: in length they match, in time they do not.
  const items = [...line("D0", 0, 30, "Top"), ...line("D1", 4, 30, "Inner 1"), ...line("D2", 8, 28, "Top")];
  const b = board(items);
  b.lengthTuning = {version: 1, targets: {}, groups: [{name: "BYTE0", members: ["D0", "D1", "D2"], basis: "delay", delayTolerance: 3}]};
  const g = L.evaluate(b, defs).find(x => x.key === "group:BYTE0");
  assert.equal(g.basis, "delay");
  const d1 = T.netDelay(b, defs, "D1");
  close(g.targetDelay, Math.max(...["D0", "D1", "D2"].map(n => T.netDelay(b, defs, n))), 1e-6, "slowest member");
  close(g.targetDelay, d1, 1e-6, "inner layer is slowest");
  const st = Object.fromEntries(g.members.map(m => [m.name, m.status]));
  assert.deepEqual(st, {D0: "short", D1: "pass", D2: "short"});
  assert.ok(g.members.every(m => m.lengthTarget != null && m.deltaDelay != null));
  // D0 must grow by Δps / (ps/mm on Top).
  const d0 = g.members.find(m => m.name === "D0");
  close(d0.lengthTarget, 30 + (d1 - T.netDelay(b, defs, "D0")) / T.model(b, defs).factor("Top", .2), .05);
  // Auto-tune the group: the short members gain length until their delay is within tolerance.
  const res = L.autoTune(b, defs, {keys: ["group:BYTE0"]});
  assert.ok(res.plan.modify.length >= 2, JSON.stringify(res.failed));
  L.applyPlan(b, res.plan); L.invalidate(b);
  const after = L.evaluate(b, defs).find(x => x.key === "group:BYTE0");
  assert.ok(after.members.every(m => m.status === "pass"), JSON.stringify(after.members.map(m => [m.name, m.delay, m.status])));
  // An explicit delay target.
  b.lengthTuning.groups[0].targetDelay = after.targetDelay + 50;
  const g2 = L.evaluate(b, defs).find(x => x.key === "group:BYTE0");
  close(g2.targetDelay, after.targetDelay + 50, 1e-9);
  assert.ok(g2.members.every(m => m.status === "short"));
});

test("Matched Delays rules become length-tuning groups", () => {
  const items = [...line("Q0", 0, 30), ...line("Q1", 4, 20)];
  const b = board(items);
  b.rules = rules([rule("matchedDelays", "MD", {tolerance: 2, withinPair: false, pairTolerance: 1})]);
  const g = L.evaluate(b, defs).find(x => x.kind === "delay");
  assert.ok(g, "delay group");
  assert.equal(g.name, "MD"); assert.equal(g.basis, "delay"); assert.equal(g.delayTolerance, 2);
  assert.deepEqual(g.members.map(m => [m.name, m.status]), [["Q0", "pass"], ["Q1", "short"]]);
});

test("the interactive tuner takes a delay target", () => {
  const items = [...line("S", 0, 30)];
  const b = board(items), tr = items[2];
  const base = T.netTiming(b, defs, "S"), want = base.delay + 40;
  const s = L.begin(b, defs, {trackId: tr.id, at: [5, 0], targetDelay: want, toleranceDelay: 1, style: "trombone"});
  const f = T.model(b, defs).factor("Top", .2);
  close(s.target, base.length + 40 / f, 1e-6, "length target from the delay target");
  close(s.tolerance, 1 / f, 1e-9);
  const r = s.move([28, 3]);
  assert.match(r.gauge.text, /target \d+\.\d ps/);
  const plan = s.commit();
  L.applyPlan(b, plan); L.invalidate(b);
  close(T.netDelay(b, defs, "S"), want, 2, "tuned delay");
  // A Propagation Delay rule is the default target when nothing else is set.
  const b2 = board([...line("S", 0, 30)]);
  b2.rules = rules([rule("delay", "D", {min: 230, max: 240})]);
  const s2 = L.begin(b2, defs, {trackId: b2.items[2].id, at: [5, 0]});
  const t2 = T.netTiming(b2, defs, "S");
  close(s2.target, t2.length + (235 - t2.delay) / f, 1e-6, "rule midpoint");
  close(s2.tolerance, 5 / f, 1e-6);
});

test("Timing Vision status: same targets as DRC and the Constraint Manager", () => {
  const items = [...line("A", 0, 20), ...line("B", 3, 30), ...line("C", 6, 25), ...line("E", 9, 10)];
  const b = board(items);
  b.rules = rules([rule("length", "Len", {min: 24, max: 26, scope: selectScope("net", "C")}), rule("length", "LenA", {min: 24, max: 26, scope: selectScope("net", "A")}),
    rule("delay", "Del", {min: 150, max: 170, scope: selectScope("net", "B")})]);
  const map = T.targets(b, defs);
  assert.equal(map.get("A").state, "short"); assert.equal(map.get("A").unit, "mm");
  assert.equal(map.get("C").state, "ok");
  const tB = T.netDelay(b, defs, "B");
  assert.equal(map.get("B").basis, "delay"); assert.equal(map.get("B").state, tB > 170 ? "long" : tB < 150 ? "short" : "ok");
  assert.ok(!map.has("E"), "unconstrained nets are not coloured");
  assert.equal(T.judge(map.get("C"), 30), "long");
  // Cached per revision.
  assert.equal(T.targets(b, defs, {revision: 7}), T.targets(b, defs, {revision: 7}));
  // DRC agrees on the same board.
  const out = R.drc(b, defs, b.rules);
  assert.deepEqual(out.violations.filter(v => v.type === "length").map(v => v.title), ["Net A"]);
  // HUD model with the tolerance band.
  const h = T.hudModel({net: "A", kind: "route", value: 22, length: 22, delay: 140, rec: map.get("A"), state: "short"});
  assert.match(h.lines[0], /22\.000 mm \/ 25\.000 mm ±1\.000/);
  assert.match(h.lines[1], /140\.0 ps · Len/);
  assert.ok(h.bar.value < h.bar.from, "value left of the band");
  assert.ok(h.bar.to > h.bar.from);
  const hp = T.hudModel({net: "B", kind: "tune", value: tB, length: 30, delay: tB, rec: map.get("B"), state: map.get("B").state});
  assert.match(hp.lines[0], / ps \/ 160\.0 ps ±10\.0/);
});

test("Constraint Manager: delay min/max columns, delay matches DRC", () => {
  const items = [...line("A", 0, 20), ...line("B", 3, 30)];
  const b = board(items);
  const project = {documents: [b], library: []};
  R.store(b, project, rules([rule("delay", "Del", {min: 150, max: null, scope: selectScope("net", "A")})]));
  const M = CM.model(project, b, defs);
  const cols = CM.COLUMNS.nets.map(c => c.key);
  assert.ok(cols.includes("delayMin") && cols.includes("delayMax") && cols.includes("delay"));
  const m = M.metrics("nets", {key: "A", name: "A"});
  assert.equal(m.cells.delayMin, 150);
  close(m.cells.delay, T.netDelay(b, defs, "A"), 1e-9, "CM delay is the DRC delay");
  assert.equal(m.status, "fail"); assert.ok(m.fails.has("delay"));
  assert.equal(M.metrics("nets", {key: "B", name: "B"}).cells.delayMin, null);
  // Editing a delay cell writes a Propagation Delay rule.
  assert.equal(CM.parseValue(CM.COLUMNS.nets.find(c => c.key === "delayMax"), "0.2 ns"), 200);
  assert.equal(CM.parseValue(CM.COLUMNS.nets.find(c => c.key === "delayMax"), "180ps"), 180);
  const set = JSON.parse(JSON.stringify(R.stored(b, project)));
  const msg = CM.setCell(set, "nets", {key: "B", name: "B"}, "delayMax", 190, M);
  assert.match(msg, /190 ps/);

  const written = set.list.find(r => r.type === "delay" && r.max === 190);
  assert.deepEqual(written?.scope, selectScope("net", "B"));
  assert.ok(CM.COLUMNS.groups.some(c => c.key === "delayTarget"));
});

test("concrete net scopes agree in DRC, Timing Vision, the tuner and the Constraint Manager", () => {
  const b = board([...line("A", 0, 20), ...line("B", 3, 30), ...line("C", 6, 25)]);
  const project = AtriumSignals.attach({documents: [b], library: [...defs.values()]});
  const query = AtriumDesignQueryRecord.create;
  R.store(b, project, rules([
    rule("length", "Run", {min: 24, max: 26, scope: query('net where name = "A"')}),
    rule("delay", "Clock", {min: 230, max: 240, scope: query('net where name = "B" and length > 25 mm')})
  ]));
  const batch = R.drc(b, defs, R.stored(b, project), {project, types: ["length", "delay"]});
  assert.deepEqual(batch.violations.map(v => v.title).sort(), ["Net A", "Net B"]);
  assert.equal(R.query(b, "delay", {kind: "track", net: "B"}), null);
  const targets = T.targets(b, defs);
  assert.equal(targets.get("A")?.target, 25); assert.equal(targets.get("B")?.target, 235);
  assert.ok(!targets.has("C"));
  const M = CM.model(project, b, defs);
  assert.equal(M.metrics("nets", {key: "A", name: "A"}).cells.lengthMin, 24);
  assert.equal(M.metrics("nets", {key: "B", name: "B"}).cells.delayMax, 240);
  const t = T.netTiming(b, defs, "B"), f = T.model(b, defs).factor("Top", .2);
  const session = L.begin(b, defs, {trackId: b.items.find(v => v.kind === "track" && v.net === "B").id, at: [5, 3]});
  close(session.target, t.length + (235 - t.delay) / f, 1e-6);
  const groupScope = query('net where name = "A" or name = "B"');
  R.store(b, project, rules([
    rule("matchedDelays", "Clock group", {tolerance: 1, withinPair: false, pairTolerance: .5, scope: groupScope}),
    rule("matchedLengths", "Run group", {tolerance: .1, withinPair: false, pairTolerance: .05, scope: groupScope})
  ]));
  const groups = L.groups(b, defs);
  for (const name of ["Clock group", "Run group"]) {
    const group = groups.find(g => g.name === name);
    assert.deepEqual(group?.members.map(m => m.name).sort(), ["A", "B"]);
  }
});

test("benchmark: status map for 400 constrained nets", () => {
  const items = [];
  for (let k = 0; k < 400; k++) items.push(...line("N" + k, k * .5, 10 + (k % 7)));
  const b = board(items);
  b.rules = rules([rule("length", "Len", {min: 12, max: 14}), rule("delay", "Del", {min: 70, max: 90, scope: selectScope("net", "N3")})]);
  const t0 = Date.now();
  const map = T.targets(b, defs);
  const ms = Date.now() - t0;
  assert.equal(map.size, 400);
  console.log("  targets for 400 nets: " + ms + " ms");
  assert.ok(ms < 3000, "targets " + ms + " ms");
});

console.log(passed + " timing tests passed");
