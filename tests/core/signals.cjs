"use strict";
// Signals (app/core/signals.js): series parts, spanning, stages, paths, tags,
// class keys and xSignals as signals and tags (applyClasses, fromLegacy), adoption and class edits.
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/checks/rules.js");
require("../../app/core/signals.js");
const S = AtriumSignals;
let uid = 0;
const part = (ref, pinNets, extra = {}) => ({id: "p-" + ref, kind: "part", ref, def: "d", value: "", x: 0, y: 0, pinNets, ...extra});
const board = (items, extra = {}) => ({id: "b" + (++uid), kind: "pcb", name: "Board", items, ...extra});
const project = (...docs) => ({format: "atrium", documents: docs, library: []});
const ic = (ref, nets) => part(ref, Object.fromEntries(nets.map((n, i) => [String(i + 1), n])));
const sorted = s => [...s].sort();
// The store is replaced, never edited in place (edit() and undo replace it): tests that edit it do the same.
const replace = p => { p.signals = JSON.parse(JSON.stringify(p.signals)); };

// ---------------------------------------------------------------- series()
{
  assert.deepEqual(S.series(part("R1", {1: "A", 2: "B"})), [["1", "2"]]);
  assert.deepEqual(S.series(part("C7", {1: "A", 2: "B"})), [["1", "2"]]);
  assert.deepEqual(S.series(part("U1", {1: "A", 2: "B"})), [], "not a series designator");
  assert.deepEqual(S.series(part("R2", {1: "A", 2: "B", 3: "C"})), [], "three connected pins");
  assert.deepEqual(S.series(part("RN1", {1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F", 7: "G", 8: "H"})), [["1", "8"], ["2", "7"], ["3", "6"], ["4", "5"]]);
  const cmc = part("L3", {1: "A", 2: "B", 3: "C", 4: "D"}, {parameters: {"Series Pins": "1-4, 2-3"}});
  assert.deepEqual(S.series(cmc), [["1", "4"], ["2", "3"]], "SeriesPins parameter");
  assert.deepEqual(S.series(cmc, null, {series: {"p-L3": false}}), [], "store override: never series");
  assert.deepEqual(S.series(part("FL1", {1: "A", 2: "B", 3: "C", 4: "D"}), {parameters: {SeriesPins: "1:2 3:4"}}), [["1", "2"], ["3", "4"]], "library parameter");
}

// ---------------------------------------------------------------- an AC-coupled PCIe lane
const lane = () => board([
  ic("U1", ["TX_P", "TX_N", "GND", "3V3", "X5", "X6", "X7", "X8"]),
  part("C1", {1: "TX_P", 2: "TX_P_C"}), part("C2", {1: "TX_N", 2: "TX_N_C"}),
  part("R9", {1: "TX_P", 2: "3V3"}),               // pull-up to a rail: never crossed
  part("C9", {1: "TX_N_C", 2: "GND"}),             // shunt to ground: never crossed
  ic("J1", ["TX_P_C", "TX_N_C", "GND"])
]);
const diff = (extra = {}) => ({id: "s-1", name: "PCIE_TX0", kind: "diff", legs: [{polarity: 1, nets: ["TX_P"]}, {polarity: -1, nets: ["TX_N"]}], ...extra});
{
  const b = lane(), p = project(b);
  p.signals = {version: 1, signals: [diff({tags: ["PCIe"]})], tags: [], nets: {}};
  const M = S.model(p, b);
  const sig = M.signals[0];
  assert.deepEqual(sig.legs[0].nets, ["TX_P", "TX_P_C"], "the plus leg spans C1");
  assert.deepEqual(sig.legs[1].nets, ["TX_N", "TX_N_C"], "the minus leg spans C2, not C9 to ground");
  assert.deepEqual(M.stages().map(x => [x.name, x.positive, x.negative, x.stage]), [["PCIE_TX0", "TX_P", "TX_N", 0], ["PCIE_TX0.1", "TX_P_C", "TX_N_C", 1]]);
  assert.equal(M.pairOf("TX_N_C").name, "PCIE_TX0.1");
  assert.deepEqual(M.signalOf("TX_P_C"), {id: "s-1", name: "PCIE_TX0", kind: "diff", polarity: 1, leg: 0, stage: 1});
  assert.equal(M.signalOf("3V3"), null);
  assert.deepEqual(sorted(M.netsOfSignal("pcie_tx0")), ["TX_N", "TX_N_C", "TX_P", "TX_P_C"]);
  assert.deepEqual(sorted(M.netsOfTag("pcie")), ["TX_N", "TX_N_C", "TX_P", "TX_P_C"], "a signal tag follows the span");
  // Automatic paths: source (U1, more pins) to load through the series part, named after the source net.
  const paths = M.paths();
  assert.deepEqual(paths.map(x => [x.name, x.from.part, x.to.part, x.through.join(), x.auto]), [["TX_P", "p-U1", "p-J1", "C1", true], ["TX_N", "p-U1", "p-J1", "C2", true]]);
  // Legacy view: both stages are pairs; the tag is a net class and a pair class.
  const L = M.legacy();
  assert.deepEqual(L.diffPairs.map(x => x.name), ["PCIE_TX0", "PCIE_TX0.1"]);
  assert.deepEqual(L.netClasses.PCIe, ["TX_N", "TX_N_C", "TX_P", "TX_P_C"]);
  assert.deepEqual(L.diffPairClasses.PCIe, ["PCIE_TX0", "PCIE_TX0.1"]);
  assert.deepEqual(L.xSignals, [], "automatic paths are not stored xSignals");
  // Stored stage names (an Altium import or a merge) name the pairs.
  p.signals.signals[0].stages = ["PCIE_TX0", "PCIE_TX0_C"]; replace(p);
  assert.deepEqual(S.model(p, b).stages().map(x => x.name), ["PCIE_TX0", "PCIE_TX0_C"]);
  // Split at a part: excluding C1 leaves the plus leg one net and the second stage unpaired.
  p.signals.signals[0].exclude = ["p-C1"]; replace(p);
  const M2 = S.model(p, b);
  assert.deepEqual(M2.signals[0].legs[0].nets, ["TX_P"]);
  assert.deepEqual(M2.stages().map(x => x.name), ["PCIE_TX0"]);
  assert.ok(M2.issues.some(i => i.kind === "stage" && i.stage === 1));
  // span: false keeps the seeds only (legacy pairs and imports).
  delete p.signals.signals[0].exclude; p.signals.signals[0].span = false; replace(p);
  assert.deepEqual(S.model(p, b).stages().map(x => x.name), ["PCIE_TX0"]);
  // Polarity flip is a store edit.
  p.signals.signals[0] = diff({legs: [{polarity: -1, nets: ["TX_P"]}, {polarity: 1, nets: ["TX_N"]}]}); replace(p);
  assert.equal(S.model(p, b).stages()[0].positive, "TX_N");
  assert.equal(S.model(p, b).signalOf("TX_P").polarity, -1);
}

// ---------------------------------------------------------------- conflicts, depth, choke, bus
{
  // Two declared signals racing for the middle net: the earlier one wins, and both are told.
  const b = board([ic("U1", ["X", "Q1", "Q2", "Q3"]), part("R1", {1: "X", 2: "Y"}), part("R2", {1: "Y", 2: "Z"}), ic("U2", ["Z", "Q4", "Q5", "Q6"])]), p = project(b);
  p.signals = {version: 1, signals: [{id: "a", name: "A", kind: "single", legs: [{nets: ["X"]}]}, {id: "b", name: "B", kind: "single", legs: [{nets: ["Z"]}]}]};
  const M = S.model(p, b);
  assert.deepEqual(M.signals[0].legs[0].nets, ["X", "Y"]);
  assert.deepEqual(M.signals[1].legs[0].nets, ["Z"]);
  assert.ok(M.issues.some(i => i.kind === "conflict" && i.ref === "R2"), "R2 joins A and B");
  // Seeds are fixed: a signal never spans into another signal's seed.
  p.signals.signals[1].legs[0].nets = ["Y"]; replace(p);
  assert.deepEqual(S.model(p, b).signals[0].legs[0].nets, ["X"]);
}
{
  const chain = [ic("U1", ["N0", "a", "b", "c"])];
  for (let i = 0; i < 5; i++) chain.push(part("R" + (i + 1), {1: "N" + i, 2: "N" + (i + 1)}));
  const b = board(chain), p = project(b);
  p.signals = {version: 1, signals: [{id: "c", name: "CH", kind: "single", legs: [{nets: ["N0"]}]}]};
  assert.deepEqual(S.model(p, b).signals[0].legs[0].nets, ["N0", "N1", "N2", "N3"], "at most three crossings");
}
{
  // A USB common-mode choke: crossed only with its SeriesPins map; then one signal spans both sides.
  const cmc = part("L1", {1: "USB_DP", 2: "USB_C_DP", 3: "USB_DN", 4: "USB_C_DN"});
  const b = board([ic("U1", ["USB_DP", "USB_DN", "a", "b"]), cmc, ic("J1", ["USB_C_DP", "USB_C_DN", "VBUS", "GND"])]), p = project(b);
  p.signals = {version: 1, signals: [{id: "u", name: "USB", kind: "diff", legs: [{polarity: 1, nets: ["USB_DP"]}, {polarity: -1, nets: ["USB_DN"]}]}]};
  assert.equal(S.model(p, b).stages().length, 1, "no default map for a four-pin choke");
  cmc.parameters = {SeriesPins: "1-2,3-4"};
  assert.deepEqual(S.model(p, b, {revision: 2}).stages().map(x => [x.positive, x.negative]), [["USB_DP", "USB_DN"], ["USB_C_DP", "USB_C_DN"]]);
  p.signals.series = {"p-L1": false}; replace(p);
  assert.equal(S.model(p, b, {revision: 3}).stages().length, 1, "store override wins");
  p.signals.series = {"p-L1": [["1", "2"]]};
  p.signals.signals[0].through = []; replace(p);
  const M = S.model(p, b, {revision: 4});
  assert.deepEqual(M.signals[0].legs[0].nets, ["USB_DP", "USB_C_DP"]);
  assert.deepEqual(M.signals[0].legs[1].nets, ["USB_DN"]);
}
{
  // Bus: member signals inherit the bus tags; the bus name selects every member net.
  const b = board([ic("U1", ["D0", "D1", "D2", "x"])]), p = project(b);
  p.signals = {version: 1, signals: [{id: "d0", name: "D0", kind: "single", legs: [{nets: ["D0"]}]}, {id: "d1", name: "D1", kind: "single", legs: [{nets: ["D1"]}], tags: ["Fast"]},
    {id: "bus", name: "DATA", kind: "bus", members: ["d0", "d1"], tags: ["DDR"]}], nets: {D2: {tags: ["DDR"]}}};
  const M = S.model(p, b);
  assert.deepEqual(sorted(M.netsOfSignal("DATA")), ["D0", "D1"]);
  assert.deepEqual(sorted(M.netsOfTag("DDR")), ["D0", "D1", "D2"], "bus tag plus a net-level tag");
  assert.deepEqual(sorted(M.tagsOf("D1")), ["ddr", "fast"]);
  const env = S.scopeEnv(b, p);
  assert.ok(env.hasTag("D0", "ddr") && env.inSignal("D1", "DATA") && !env.inSignal("D2", "DATA"));
  assert.deepEqual(sorted(env.classes.get("DDR")), ["D0", "D1", "D2"]);
  assert.equal(S.scopeEnv(b, project(b)), null, "no store: the legacy keys are exact, no env");
}

// ---------------------------------------------------------------- validation
{
  const ok = {version: 1, signals: [diff()], tags: [{name: "PCIe", color: "#4cc9f0"}], nets: {A: {tags: ["X"]}}, series: {"p-L1": [["1", "2"]], "p-R9": false}};
  assert.equal(S.validate(ok), ok);
  const bad = [
    {...ok, extra: 1},
    {...ok, version: 2},
    {...ok, signals: [diff(), diff({id: "s-2"})]},                                                  // duplicate name
    {...ok, signals: [diff({legs: [{polarity: 1, nets: ["A"]}, {polarity: 1, nets: ["B"]}]})]},     // same polarity
    {...ok, signals: [{id: "x", name: "X", kind: "single", legs: [{polarity: 1, nets: ["A"]}]}]},  // polarity on a single leg
    {...ok, signals: [{id: "x", name: "X", kind: "bus", members: ["nope"]}]},
    {...ok, tags: [{name: "T"}, {name: "t"}]},
    {...ok, series: {"p-R1": [["1"]]}},
    {...ok, signals: [diff({paths: [{name: "P", from: {pin: "1"}, to: {part: "p", pin: "2"}}]})]}
  ];
  for (const b of bad) assert.throws(() => S.validate(JSON.parse(JSON.stringify(b))), JSON.stringify(b).slice(0, 80));
  let called = 0;
  assert.throws(() => S.validate({...ok, extra: 1}, () => called++));
  assert.equal(called, 1, "invalid() is called");
  assert.doesNotThrow(() => S.validate({...ok, extra: 1, signals: [{...diff(), future: true}]}, null, true), "lenient keeps unknown fields");
}

// ---------------------------------------------------------------- class keys round trip (applyClasses)
// Net classes, pairs and pair classes (an importer's or an editor's class view) become signals and tags.
const classBoard = () => board([
  ic("U1", ["USB_P", "USB_N", "DQ0", "DQ1", "CLK_P", "CLK_N", "PWR", "GND"]), part("R1", {1: "DQ0", 2: "DQ0_R"}), ic("U2", ["DQ0_R", "DQ1", "CLK_P", "CLK_N", "a", "b", "c", "d"])]);
const KEYS = {netClasses: {HS: ["USB_P", "USB_N", "CLK_P", "CLK_N"], Power: ["PWR"], Empty: [], Mixed: ["DQ0"]},
  diffPairs: [{name: "USB", positive: "USB_P", negative: "USB_N"}, {name: "CLK", positive: "CLK_P", negative: "CLK_N"}, {name: "Lone", positive: "L_P", negative: "L_N"}],
  diffPairClasses: {HS: ["USB", "CLK"], Mixed: ["Lone"], Ghost: ["NoSuchPair"]}};
const classView = L => ({netClasses: L.netClasses, diffPairs: L.diffPairs, diffPairClasses: L.diffPairClasses});
{
  const b = classBoard(), p = project(b);
  assert.equal(S.applyClasses(p, b, KEYS), true, "one edit");
  const store = p.signals;
  S.validate(store);
  assert.deepEqual(classView(S.model(p, b).legacy()), classView(S.canonicalLegacy(KEYS)), "the model gives back exactly the classes it was given");
  assert.equal(S.applyClasses(p, b, KEYS), false, "the same classes again change nothing");
  assert.equal(p.signals, store);
  // Same-name classes that agree share a tag; those that disagree are split so the export is exact.
  const tag = n => store.tags.find(t => t.name === n);
  assert.deepEqual(tag("HS").as, {net: "HS", pair: "HS", xsignal: null});
  assert.deepEqual(tag("Mixed (pairs)").as, {net: null, pair: "Mixed", xsignal: null});
  assert.equal(store.signals.find(s => s.name === "USB").span, false, "pairs from class keys do not span");
  assert.equal(store.nets.PWR.tags[0], "Power");
  assert.equal(b.rules, undefined, "nothing is written on the board");
}
// ---------------------------------------------------------------- xSignals round trip (applyClasses)
const XS = {xSignals: [
  {name: "DQ0_U2", from: {ref: "U1", pin: "3"}, to: {ref: "U2", pin: "1"}, through: ["R1"], nets: ["DQ0", "DQ0_R"], class: "BYTE0"},
  {name: "DQ1_U2", from: {ref: "U1", pin: "4"}, to: {ref: "U2", pin: "2"}},
  {name: "CLK_U2", from: {ref: "U1", pin: "5"}, to: {ref: "U2", pin: "3"}, nets: ["CLK_P"]}],
  xSignalClasses: {BYTE0: ["DQ1_U2", "Missing_X"], HS: ["CLK_U2"]}};
const xsBoard = () => board(classBoard().items);
{
  const b = xsBoard(), p = project(b);
  assert.deepEqual(S.xsView(b, p).xSignals, [], "no xSignals until the model has them");
  assert.ok(S.applyClasses(p, b, XS), "xSignals join the model");
  S.validate(p.signals);
  const L = S.model(p, b).legacy(), want = S.canonicalLegacy({...XS});
  assert.deepEqual({xSignals: L.xSignals, xSignalClasses: L.xSignalClasses}, {xSignals: want.xSignals, xSignalClasses: want.xSignalClasses}, "the model gives the xSignals back exactly");
  assert.equal(p.signals.signals.find(s => s.name === "DQ0").paths[0].from.part, "p-U1", "path ends become part ids");
  assert.equal(S.applyClasses(p, b, XS), false, "the same xSignals again change nothing");
  assert.equal(b.lengthTuning, undefined, "nothing is written on the board");
}

// ---------------------------------------------------------------- adoption and class edits
{
  const b = classBoard(), p = project(b);
  S.applyClasses(p, b, KEYS);
  assert.ok(p.signals && p.signals.mirror === undefined, "adopted; no mirror");
  assert.equal(S.effective(p), p.signals, "the store is used as is");
  // A signals edit: tag DQ1 and give USB a series exclusion; the rules see it at once.
  S.edit(p, st => { st.signals.find(s => s.name === "USB").exclude = ["p-C1"]; st.tags.push({name: "Debug"}); (st.nets.DQ1 ||= {tags: []}).tags.push("Debug"); });
  assert.deepEqual(AtriumRules.effective(b, p).netClasses.Debug, ["DQ1"]);
  AtriumRules.validate(AtriumRules.effective(b, p));
  // A class edit: a net added to HS, the CLK pair dropped.
  const cur = AtriumRules.effective(b, p), ids = p.signals.signals.find(s => s.name === "USB").id;
  S.applyClasses(p, b, {netClasses: {...cur.netClasses, HS: [...cur.netClasses.HS, "DQ1"]}, diffPairs: cur.diffPairs.filter(x => x.name !== "CLK"), diffPairClasses: {...cur.diffPairClasses, HS: ["USB"]}});
  const L = S.model(p, b).legacy();
  assert.deepEqual(L.netClasses.HS, ["CLK_N", "CLK_P", "DQ1", "USB_N", "USB_P"]);
  assert.deepEqual(L.diffPairs.map(x => x.name), ["Lone", "USB"]);
  assert.deepEqual(L.diffPairClasses.HS, ["USB"]);
  const usb = p.signals.signals.find(s => s.name === "USB");
  assert.deepEqual(usb.exclude, ["p-C1"], "store-only data survives a class edit");
  assert.equal(usb.id, ids, "ids are kept");
  // An xSignal added (the xSignals wizard's view): it joins the store; classes and store-only data stay.
  const xs = S.xsView(b, p);
  assert.ok(S.applyClasses(p, b, {xSignals: [...xs.xSignals, {name: "NEW_X", from: {ref: "U1", pin: "8"}, to: {ref: "U2", pin: "5"}}]}));
  assert.ok(p.signals.signals.some(s => (s.paths || []).some(x => x.name === "NEW_X")));
  assert.deepEqual(S.model(p, b).legacy().netClasses.HS, ["CLK_N", "CLK_P", "DQ1", "USB_N", "USB_P"]);
  assert.deepEqual(p.signals.signals.find(s => s.name === "USB").exclude, ["p-C1"]);
  assert.equal(b.lengthTuning, undefined, "nothing is written on the board");
}
{
  // Topology changes the span between edits: the classes the rules read follow at once.
  const b = lane(), p = project(b);
  S.edit(p, st => { st.signals.push(diff({tags: ["PCIe"]})); });
  assert.deepEqual(AtriumRules.effective(b, p).netClasses.PCIe, ["TX_N", "TX_N_C", "TX_P", "TX_P_C"]);
  b.items = [...b.items, part("R5", {1: "TX_P_C", 2: "TX_P_J"}), part("R6", {1: "TX_N_C", 2: "TX_N_J"})];
  assert.deepEqual(AtriumRules.effective(b, p).netClasses.PCIe, ["TX_N", "TX_N_C", "TX_N_J", "TX_P", "TX_P_C", "TX_P_J"]);
  assert.deepEqual(AtriumRules.effective(b, p).diffPairs.map(x => x.name), ["PCIE_TX0", "PCIE_TX0.1", "PCIE_TX0.2"]);
}
{
  // Renames.
  const st = {version: 1, signals: [diff({paths: [{name: "P", from: {part: "a", pin: "1"}, to: {part: "b", pin: "2"}, nets: ["TX_P"]}]})], nets: {TX_P: {tags: ["X"]}}};
  assert.equal(S.renameNet(st, "TX_P", "TX0_P"), 3);
  assert.deepEqual(st.signals[0].legs[0].nets, ["TX0_P"]);
  assert.deepEqual(st.signals[0].paths[0].nets, ["TX0_P"]);
  assert.deepEqual(Object.keys(st.nets), ["TX0_P"]);
}
{
  // Two boards: the same pair on both is one record; differing net classes are scoped per board.
  const mk = () => board([ic("U1", ["A", "B", "C", "D"])]);
  const b1 = mk(), b2 = mk(), p = project(b1, b2), pair = [{name: "P", positive: "A", negative: "B"}];
  S.applyClasses(p, b1, {netClasses: {X: ["A"]}, diffPairs: pair});
  S.applyClasses(p, b2, {netClasses: {X: ["C"]}, diffPairs: pair});
  const st = p.signals;
  assert.deepEqual(st.signals.map(s => s.name), ["P"], "the same pair on both boards is one record");
  assert.deepEqual(st.nets.A, {tags: ["X"], boards: [b1.id]});
  assert.deepEqual(S.model(p, b1).legacy().netClasses, {X: ["A"]});
  assert.deepEqual(S.model(p, b2).legacy().netClasses, {X: ["C"]});
  assert.equal(b1.rules, undefined); assert.equal(b2.rules, undefined);
}
console.log("signals ok");
