"use strict";
// Rule scopes and queries over the signal model (rules.js compile, query.js):
// legacy keywords as views, InSignal / HasTag / Signal / Polarity, the signal and tag scope kinds, the
// working-copy rule (a rules copy with other classes keeps its own), and pair detection by net-intent.js.
const assert = require("node:assert/strict");
for (const f of ["model", "design-query-record", "net-intent", "query-exchange", "query", "rules", "signals"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const R = AtriumRules, S = AtriumSignals, Q = AtriumQuery;
const scope=AtriumDesignQueryRecord.selector;
function fromClassic(text) {
  const result=AtriumQueryExchange.fromClassic(text);
  assert.ok(result.ok && AtriumDesignQueryRecord.valid(result.scope),text);
  return result.scope;
}
const part = (ref, pinNets) => ({id: "p-" + ref, kind: "part", ref, def: "d", value: "", x: 0, y: 0, pinNets});
const ic = (ref, nets) => part(ref, Object.fromEntries(nets.map((n, i) => [String(i + 1), n])));
const track = (id, net) => ({id, kind: "track", net, layer: "Top", width: .2, points: [[0, 0], [1, 0]]});
function setup(withStore = true) {
  const b = {id: "b1", kind: "pcb", name: "Board", grid: 1, outline: [], notes: [], items: [
    ic("U1", ["TX_P", "TX_N", "GND", "3V3", "CLK", "x6", "x7", "x8"]), part("C1", {1: "TX_P", 2: "TX_P_C"}), part("C2", {1: "TX_N", 2: "TX_N_C"}),
    ic("J1", ["TX_P_C", "TX_N_C", "GND"]), track("t1", "TX_P_C"), track("t2", "TX_N"), track("t3", "CLK")]};
  const p = {format: "atrium", version: 1, name: "P", library: [], documents: [b]};
  if (withStore) S.edit(p, st => {
    st.signals.push({id: "s1", name: "PCIE_TX0", kind: "diff", legs: [{polarity: 1, nets: ["TX_P"]}, {polarity: -1, nets: ["TX_N"]}], tags: ["PCIe"], stages: ["PCIE_TX0", "PCIE_TX0_C"]});
    st.signals.push({id: "s2", name: "SYSCLK", kind: "single", legs: [{nets: ["CLK"]}]});
    st.tags.push({name: "PCIe"}); st.nets.CLK = {tags: ["Clocks"]};
  });
  return {b, p};
}
const rule = (id, scope, extra = {}) => ({id, type: "width", name: id, enabled: true, priority: 1, scope, min: .1, preferred: .1, max: 1, ...extra});
const widthOf = (b, p, net, rules) => R.query(b, "width", {net}, {project: p, rules})?.ruleName ?? null;
const withRules = (b, list) => R.normalize({...R.effective(b), list: [...list, ...R.effective(b).list.filter(r => r.type !== "width")]});

{
  const {b, p} = setup();
  // Views: the live model's classes and pairs; classes follow the span.
  assert.deepEqual(R.netClasses(b, {project: p}), {Clocks: ["CLK"], PCIe: ["TX_N", "TX_N_C", "TX_P", "TX_P_C"]});
  assert.deepEqual(R.diffPairs(b, {project: p}).map(x => [x.name, x.positive, x.signal, x.classes.join()]), [["PCIE_TX0", "TX_P", "PCIE_TX0", "PCIe"], ["PCIE_TX0_C", "TX_P_C", "PCIE_TX0", "PCIe"]]);
  // Scope kinds and queries.
  const set = withRules(b, [
    rule("bySignal", scope("signal","PCIE_TX0"), {priority: 1}),
    rule("byTag", scope("tag","Clocks"), {priority: 2}),
    rule("byStage", scope("diffpair","PCIE_TX0_C"), {priority: 3}),
    rule("fallback", scope("all"), {priority: 4})]);
  R.validate(set);
  for (const [net, want] of [["TX_P", "bySignal"], ["TX_N_C", "bySignal"], ["CLK", "byTag"], ["GND", "fallback"]]) assert.equal(widthOf(b, p, net, set), want, net);
  const stage = withRules(b, [rule("byStage", scope("diffpair","PCIE_TX0_C")), rule("all", scope("all"), {priority: 2})]);
  assert.equal(widthOf(b, p, "TX_P_C", stage), "byStage", "a stage name selects that stage");
  assert.equal(widthOf(b, p, "TX_P", stage), "all");
  const bySig = withRules(b, [rule("pair", scope("diffpair","PCIE_TX0")), rule("all", scope("all"), {priority: 2})]);
  assert.equal(widthOf(b, p, "TX_N_C", bySig), "pair", "a diff signal's name covers all its stages");
  const q = text => withRules(b, [rule("q", fromClassic(text)), rule("all", scope("all"), {priority: 2})]);
  for (const [text, net, want] of [["InSignal('pcie_tx0')", "TX_N_C", "q"], ["HasTag('PCIe')", "TX_P_C", "q"], ["HasTag('Clocks')", "TX_P", "all"], ["InNetClass('PCIe')", "TX_N_C", "q"],
    ["InDifferentialPairClass('PCIe')", "TX_P_C", "q"], ["IsDiffPair", "CLK", "all"], ["Polarity = '-'", "TX_N_C", "q"], ["Polarity = '-'", "TX_P", "all"], ["Signal = 'SYSCLK'", "CLK", "q"]])
    assert.equal(widthOf(b, p, net, q(text)), want, text + " on " + net);
  // Filter panel queries see the same model.
  const ids = text => Q.run(p, b, text).ids.sort();
  assert.deepEqual(ids("HasTag('PCIe') And IsTrack"), ["t1", "t2"]);
  assert.deepEqual(ids("InSignal('SYSCLK')"), ["t3"]);
  assert.deepEqual(ids("IsTrack And Polarity = '+'"), ["t1"]);
  assert.deepEqual(ids("InNetClass('PCIe') And IsTrack"), ["t1", "t2"]);
  // effective() carries the model's current view; storing it back (a rules editor's OK) changes no signal.
  b.items.push(part("R7", {1: "TX_P_C", 2: "TX_P_J"}), part("R8", {1: "TX_N_C", 2: "TX_N_J"}));
  const eff = R.effective(b, p);
  assert.deepEqual(eff.netClasses.PCIe, ["TX_N", "TX_N_C", "TX_N_J", "TX_P", "TX_P_C", "TX_P_J"], "the span grew: the view follows");
  const store = p.signals;
  R.store(b, p, eff);
  assert.equal(p.signals, store, "storing the current view back changes nothing");
  assert.equal(widthOf(b, p, "TX_N_J", withRules(b, [rule("pair", scope("diffpair","PCIE_TX0")), rule("all", scope("all"), {priority: 2})])), "pair", "and the model still applies");
  b.items.splice(-2);
  // A rules copy with different classes (an editor's working copy) keeps its own classes.
  const copy = {...R.effective(b, p), netClasses: {PCIe: ["CLK"]}};
  assert.deepEqual(R.netClasses(b, {project: p, rules: copy}), {PCIe: ["CLK"]});
}
{
  // Without a store, rules handed in with their own classes and pairs (an editor's working copy, an imported
  // set): HasTag is a class of any kind; InSignal a pair or an xSignal.
  const {b, p} = setup(false);
  const base = R.normalize({...R.migrate(null), netClasses: {HS: ["CLK"]}, diffPairs: [{name: "TX", positive: "TX_P", negative: "TX_N"}], diffPairClasses: {Lanes: ["TX"]}});
  const withBase = list => R.normalize({...base, list: [...list, ...base.list.filter(r => r.type !== "width")]});
  const q = text => withBase([rule("q", fromClassic(text)), rule("all", scope("all"), {priority: 2})]);
  for (const [text, net, want] of [["HasTag('HS')", "CLK", "q"], ["HasTag('Lanes')", "TX_N", "q"], ["HasTag('Lanes')", "CLK", "all"], ["InSignal('TX')", "TX_P", "q"], ["InSignal('TX')", "TX_P_C", "all"]])
    assert.equal(widthOf(b, p, net, q(text)), want, "legacy " + text + " on " + net);
  assert.equal(S.scopeEnv(b, p), null);
  assert.equal(widthOf(b, p, "CLK", withBase([rule("t", scope("tag","HS")), rule("all", scope("all"), {priority: 2})])), "t");
}
{
  // Pair detection: one recogniser (net-intent.js).
  const d = R.detectDiffPairs(["USB_DP", "USB_DM", "CANH", "CANL", "CAP", "CAN", "TX_P", "TX_N"]);
  assert.deepEqual(d.map(x => [x.positive, x.negative]).sort(), [["CANH", "CANL"], ["TX_P", "TX_N"], ["USB_DP", "USB_DM"]]);
  for (const x of d) assert.deepEqual(Object.keys(x).sort(), ["name", "negative", "positive"], "only the three fields");
}
console.log("signals-rules ok");
