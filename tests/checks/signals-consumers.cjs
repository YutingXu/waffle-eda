"use strict";
// Consumers of the signal model: the router's pair list, length tuning's
// automatic xSignals and the xSignals wizard share one definition of a series part (signals.js series());
// declared stages reach the router and the length manager; legacy name pairs stay suggestions.
const assert = require("node:assert/strict");
for (const f of ["model", "net-intent", "query", "stackup", "rules", "signals", "timing-vision", "xsignals", "length-tuning", "router", "diffpair"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const S = AtriumSignals, DP = AtriumDiffPair, L = AtriumLength, X = AtriumXSignals;
const part = (ref, pinNets, extra = {}) => ({id: "p-" + ref, kind: "part", ref, def: "d", value: "", x: 0, y: 0, pinNets, ...extra});
const ic = (ref, nets) => part(ref, Object.fromEntries(nets.map((n, i) => [String(i + 1), n])));
function setup() {
  const b = {id: "b1", kind: "pcb", name: "Board", grid: 1, outline: [], notes: [], items: [
    ic("U1", ["TX_P", "TX_N", "DQ0", "GND", "a", "b", "c", "d"]), part("C1", {1: "TX_P", 2: "TX_P_C"}), part("C2", {1: "TX_N", 2: "TX_N_C"}),
    part("R1", {1: "DQ0", 2: "DQ0_R"}), ic("J1", ["TX_P_C", "TX_N_C", "GND"]), ic("U2", ["DQ0_R", "x", "y", "z"]),
    part("L1", {1: "USB_DP", 2: "USB_C_DP", 3: "USB_DN", 4: "USB_C_DN"}, {parameters: {SeriesPins: "1-2,3-4"}}), ic("U3", ["USB_DP", "USB_DN", "q", "r"]), ic("J2", ["USB_C_DP", "USB_C_DN", "s"])]};
  const p = {format: "atrium", version: 1, name: "P", library: [], documents: [b]};
  return {b, p};
}
{
  const {b, p} = setup();
  S.attach(p);
  // Legacy board: name pairs are suggestions (source "names"), as before.
  const names = DP.pairs(b);
  assert.ok(names.some(x => x.positive === "TX_P" && x.negative === "TX_N" && x.source === "names"));
  // Declared AC-coupled pair: both stages come from the model (source "rules"); no duplicate name pair.
  S.edit(p, st => st.signals.push({id: "s1", name: "PCIE_TX0", kind: "diff", legs: [{polarity: 1, nets: ["TX_P"]}, {polarity: -1, nets: ["TX_N"]}]}));
  const declared = DP.pairs(b).filter(x => x.source === "rules");
  assert.deepEqual(declared.map(x => [x.name, x.positive, x.negative]), [["PCIE_TX0", "TX_P", "TX_N"], ["PCIE_TX0.1", "TX_P_C", "TX_N_C"]]);
  assert.equal(DP.find(b, "TX_N_C").name, "PCIE_TX0.1");
  assert.ok(!DP.pairs(b).some(x => x.source === "names" && x.positive === "TX_P"));
}
{
  // One series definition: a SeriesPins choke is crossed by the wizard's discovery and by the length
  // engine's automatic xSignal; a store override (never series) turns both off.
  const {b, p} = setup();
  S.attach(p);
  const found = X.discover(b, null, "U3", ["J2"]);
  assert.deepEqual(found.map(x => [x.from.pin, x.to.pin, x.through.join()]).sort(), [["1", "1", "L1"], ["2", "2", "L1"]]);
  assert.deepEqual(L.matchLength(b, null, "DQ0", {revision: 1}).through, ["R1"], "series resistor: an automatic xSignal");
  S.edit(p, st => { st.series = {"p-R1": false, "p-L1": false}; });
  assert.equal(L.matchLength(b, null, "DQ0", {revision: 2}).xSignal, undefined, "the store override applies to length too");
  assert.deepEqual(X.discover(b, null, "U3", ["J2"]), []);
}
console.log("signals-consumers ok");
