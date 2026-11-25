"use strict";
// Scoped ERC rules from the project rule book (project.rules, app/checks/project-rules.js): ERC applies the
// first matching erc<Check> rule per finding (off drops it, a severity sets its class), by component,
// component class, net, net class, query and sheets; a scoped ercPinMatrix replaces matrix cells on its
// nets. A book without scoped ERC rules gives exactly what its unscoped rules give (the corpus gate is
// tests/formats/compat-corpus.cjs). Run: scripts/test-jsc.sh erc-scoped   (or node tests/checks/erc-scoped.cjs)
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "net-ties", "multichannel", "messages", "erc", "query", "component-classes", "altium-rules", "pcb-draw", "net-intent", "signals", "rules", "project-rules"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const E = AtriumERC, P = AtriumProjectRules;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const pin = (number, electrical, x) => ({number, name: number, x, y: 0, electrical});
const lib = [{id: "tp", name: "TP", prefix: "TP", symbol: {shapes: [], pins: [pin("1", 4, 0)]}, footprint: {shapes: [], pads: [{number: "1", x: 0, y: 0, w: 1, h: 1, shape: "round"}]}},
  {id: "drv", name: "Driver", prefix: "U", symbol: {shapes: [], pins: [pin("1", 2, 0), pin("2", 2, 10)]}, footprint: {shapes: [], pads: [{number: "1", x: 0, y: 0, w: 1, h: 1}, {number: "2", x: 2, y: 0, w: 1, h: 1}]}}];
function project(rules) {
  const sheet = {kind: "schematic", id: "s", name: "Sheet", items: [
    {kind: "part", id: "tp1", def: "tp", ref: "TP1", x: 0, y: 0, angle: 0}, {kind: "part", id: "tp2", def: "tp", ref: "TP2", x: 0, y: 20, angle: 0},
    {kind: "part", id: "u1", def: "drv", ref: "U1", x: 40, y: 0, angle: 0}, {kind: "part", id: "u2", def: "drv", ref: "U2", x: 40, y: 20, angle: 0},
    {kind: "wire", id: "w1", points: [[40, 0], [40, 20]]}]};
  const board = {kind: "pcb", id: "b", name: "Board", items: [], componentClasses: {TestPoints: ["TP1", "TP2"]}};
  const p = {format: "atrium", version: 1, formatVersion: "1.4", name: "Scoped", library: lib, documents: [sheet, board]};
  if (rules) p.rules = {format: "atrium-rules", version: 3, units: "mm", list: rules};
  return p;
}
const rule = (type, scope, extra = {}) => ({id: "r-" + type + "-" + (scope.value || "all") + (extra.priority || ""), type, name: type.slice(3), enabled: true, priority: 1, scope, where: "schematic", ...extra});
const findings = p => E.run(p).messages.filter(m => m.class !== "Info").map(m => m.check + ":" + m.class + ":" + m.text).sort();

test("a book without scoped ERC rules reports exactly what the default settings do", () => {
  const plain = findings(project());
  assert.ok(plain.some(x => x.startsWith("unconnectedPins:Warning:Unconnected pin TP1-1")));
  assert.ok(plain.some(x => x.startsWith("matrix:Error:")), "two outputs on one net");
  assert.deepEqual(findings(project([rule("ercUnconnectedPins", {kind: "all"}, {severity: "warning"})])), plain);
});

test("off for a component class (the test points), by query; a severity for one component", () => {
  const got = findings(project([rule("ercUnconnectedPins", {kind: "query", value: "InComponentClass('TestPoints')"}, {severity: "off"}),
    rule("ercUnconnectedPins", {kind: "component", value: "U2"}, {severity: "error"})]));
  assert.ok(!got.some(x => /TP1-1|TP2-1/.test(x)), "test points are not reported: " + got.join("\n"));
  assert.ok(got.some(x => x === "unconnectedPins:Error:Unconnected pin U2-2"), "U2 is an error");
  assert.ok(got.some(x => x === "unconnectedPins:Warning:Unconnected pin U1-2"), "U1 keeps the project setting");
  // The same by scope kind, and limited to sheets.
  const cc = findings(project([rule("ercUnconnectedPins", {kind: "componentclass", value: "TestPoints"}, {severity: "off"})]));
  assert.ok(!cc.some(x => /TP1-1/.test(x)));
  const elsewhere = findings(project([rule("ercUnconnectedPins", {kind: "componentclass", value: "TestPoints"}, {severity: "off", sheets: ["other"]})]));
  assert.ok(elsewhere.some(x => /TP1-1/.test(x)), "a rule for other sheets leaves this one alone");
});

test("a scoped connection matrix on one net; priorities", () => {
  const net = E.run(project()).messages.find(m => m.check === "matrix").net;
  assert.ok(net, "matrix findings name their net");
  const got = findings(project([rule("ercPinMatrix", {kind: "net", value: net}, {matrix: {"2,2": "off"}})]));
  assert.ok(!got.some(x => x.startsWith("matrix:")), "outputs allowed on that net");
  const pri = findings(project([rule("ercUnconnectedPins", {kind: "component", value: "U1"}, {severity: "off", priority: 2}),
    rule("ercUnconnectedPins", {kind: "query", value: "InComponent('U1')"}, {severity: "fatal", priority: 1})]));
  assert.ok(pri.some(x => x === "unconnectedPins:Fatal:Unconnected pin U1-2"), "priority 1 wins");
});

console.log(passed + " scoped ERC tests passed");
