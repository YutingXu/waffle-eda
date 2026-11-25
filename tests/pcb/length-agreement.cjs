"use strict";
// One net-length engine (consolidation audit §6): Length DRC, the Length Manager (AtriumLength),
// Delay DRC / Timing, the Constraint Manager and MCP net_lengths / matched_length_report all
// report the same length for the same net. Before the fix, Length DRC and MCP measured with
// rules.netLengths (total copper, whole-stack via height including solder mask) while the
// Length Manager measured pad to pad with vias from copper centre to copper centre.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "stackup", "impedance", "altium-rules", "net-intent", "signals", "rules", "timing-vision", "length-tuning", "dfa", "constraints"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../../mcp/headless.js");
const R = AtriumRules, L = AtriumLength, K = AtriumConstraints, S = AtriumStackup;
const close = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-4, (m || "") + " " + a + " differs from " + b);

const track = (id, net, layer, points, width = .2) => ({id, kind: "track", net, layer, width, points});
const via = (id, net, x, y) => ({id, kind: "via", net, x, y, diameter: .6, drill: .3, layer: "Multi"});
const pad = (id, net, x, y, layer) => ({id, kind: "pad", net, number: "1", x, y, w: .8, h: .8, shape: "rect", layer, drill: 0});
const doc = {kind: "pcb", id: "b", name: "Board", grid: 1, notes: [], outline: [[0, 0], [60, 0], [60, 40], [0, 40]], stackup: {version: 1, layers: S.preset("4").layers}, items: [
  // CLK: pad (Top) -> 10 mm -> via -> 10 mm (Bottom) -> pad, plus a 3 mm dead-end stub on Top.
  pad("pa", "CLK", 0, 0, "Top"), track("t1", "CLK", "Top", [[0, 0], [10, 0]]), via("v1", "CLK", 10, 0),
  track("t2", "CLK", "Bottom", [[10, 0], [20, 0]]), pad("pb", "CLK", 20, 0, "Bottom"), track("st", "CLK", "Top", [[5, 0], [5, 3]]),
  // D0, D1: tracks only (no pads), measured as total copper.
  track("d0", "D0", "Top", [[0, 5], [30, 5]]), track("d1", "D1", "Top", [[0, 8], [28, 8]]),
  // A via with copper on one side only: a stub, no barrel length.
  via("v2", "D1", 28, 8)]};
const rules = R.create();
rules.netClasses = {Fast: ["CLK", "D0", "D1"]};
rules.list.push({id: "len-1", type: "length", name: "Length_Fast", comment: "", enabled: true, priority: 1, scope: {kind: "netclass", value: "Fast"}, min: 0, max: 1},
  {id: "ml-1", type: "matchedLengths", name: "Match_Fast", comment: "", enabled: true, priority: 1, scope: {kind: "netclass", value: "Fast"}, tolerance: .5, withinPair: false, pairTolerance: .127});
const project = {format: "atrium", version: 1, name: "P", library: [], documents: [doc]}, defs = new Map();
AtriumSignals.attach(project);
R.store(doc, project, rules);  // the project rule book; the Fast net class goes to the signal model
const nets = ["CLK", "D0", "D1"];

// The physical numbers: CLK runs pad to pad (the stub is left out) and its via counts from the Top copper
// centre to the Bottom copper centre of the 4-layer preset: 0.0175 + 0.2 + 0.035 + 1.04 + 0.035 + 0.2 + 0.0175.
const manager = new Map(nets.map(n => [n, L.netLength(doc, defs, n)]));
close(manager.get("CLK").length, 21.545, "CLK pad to pad");
assert.equal(manager.get("CLK").mode, "path");
close(manager.get("D0").length, 30); close(manager.get("D1").length, 28, "a one-sided via adds nothing");

// rules.netLengths is the same engine.
const drcLengths = R.netLengths(doc, defs);
for (const n of nets) close(drcLengths.get(n).length, manager.get(n).length, n + " rules.netLengths = Length Manager");
close(drcLengths.get("CLK").viaLength, 1.545); close(drcLengths.get("CLK").trackLength, 20);

// Length DRC reports the same actual value.
const out = R.drc(doc, defs, R.stored(doc, project), {types: ["length", "matchedLengths"]});
for (const n of nets) {
  const v = out.violations.find(x => x.type === "length" && x.title === "Net " + n);
  assert.ok(v, "length violation for " + n); close(v.actual, manager.get(n).length, n + " Length DRC = Length Manager");
}
const short = out.violations.filter(x => x.type === "matchedLengths").map(x => x.title.split(" ")[1]).sort();
assert.deepEqual(short, ["CLK", "D1"], "matched against D0 (30 mm): CLK 21.545 and D1 28 are short");

// Delay DRC / Timing reads the same length.
for (const n of nets) close(AtriumTiming.netTiming(doc, defs, n).length, manager.get(n).length, n + " Timing = Length Manager");

// Constraint Manager: length and delay columns from the same measurement.
const M = K.model(project, doc, defs), rows = M.rows("nets");
for (const n of nets) {
  const c = M.metrics("nets", rows.find(r => r.name === n)).cells, m = L.matchLength(doc, defs, n);
  close(c.length, m.length, n + " Constraint Manager length"); close(c.delay, m.delay, n + " Constraint Manager delay");
}

// MCP net_lengths and matched_length_report.
const call = (op, args = {}, body) => JSON.parse(AtriumHeadless(JSON.stringify({op, args}), body).split("\n")[0]);
call("load", {digest: "x"}, JSON.stringify(project));
const mcp = call("net_lengths").items;
for (const n of nets) close(mcp.find(r => r.net === n).length, manager.get(n).length, n + " MCP net_lengths");
close(mcp.find(r => r.net === "CLK").via_length, 1.545);
const report = call("matched_lengths").items[0];
close(report.longest, 30); assert.deepEqual(report.nets.filter(x => !x.ok).map(x => x.net).sort(), ["CLK", "D1"]);
close(call("net_lengths", {via_heights: false}).items.find(r => r.net === "CLK").length, 20, "via_heights:false");
console.log("PASS one length engine: Length DRC = Length Manager = Timing = Constraint Manager = MCP");
