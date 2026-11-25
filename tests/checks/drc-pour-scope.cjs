"use strict";
// A refill re-runs only the checks that read poured copper (app/checks/drc-view.js online): with a Polygon Connect rule in the rule set, a pour-only change used to
// make online DRC re-run every check on the board (its copper dependency is the whole pours list). Now
// only Polygon Connect, Return Path and Creepage Distance run again, and the result equals a full check.
// Run: scripts/test-jsc.sh drc-pour-scope   (or node tests/checks/drc-pour-scope.cjs)
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "nav-common", "spatial", "board-shape", "stackup", "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "net-intent", "signals",
  "rules", "viastack", "polygon-pour", "connectivity", "drc", "checks", "drc-view", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../support/drc-geometry.cjs");
const V = AtriumDRCView, PP = AtriumPolygonPour, R = AtriumRules;
const defs = new Map(AtriumParts.catalogue.map(p => [p.id, p]));
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const doc = Atrium.sheet("pcb", "Scope");
doc.outline = rect(0, 0, 30, 20);
doc.items = [
  {...PP.make(rect(1, 1, 29, 19), {net: "GND", layer: "Top", pourIndex: 0}), id: "poly"},
  {id: "r1", kind: "part", def: "std-r", ref: "R1", x: 10, y: 10, angle: 0, pinNets: {"1": "GND", "2": "SIG"}},
  {id: "t1", kind: "track", layer: "Top", width: .25, net: "SIG", points: [[11, 10], [20, 10]]},
  {id: "t2", kind: "track", layer: "Top", width: .25, net: "OTHER", points: [[11, 10.3], [20, 10.3]]}]; // a clearance violation to keep
const rules = R.migrate({format: "atrium-rules", version: 1, units: "mm", defaults: {clearance: .2, trackWidth: .15, viaDrill: .3}, nets: {}});
assert.ok(rules.list.some(r => r.type === "polygonConnect"), "the migrated rule set has a Polygon Connect rule");
const pour = () => { doc.pcbDrawing = {...(doc.pcbDrawing || {}), pours: PP.repourAll(doc, defs, {rules, reuse: false}).regions}; };
pour();
const E = V.online();
const calls = [], drc0 = R.drc;
R.drc = (d, f, r, o) => { calls.push(o?.types ? o.types.slice().sort().join(",") : "all"); return drc0(d, f, r, o); };
try {
  let r = E.update(doc, defs, rules, {from: null, to: 1, ids: null, items: null, outer: "o", pours: 1});
  assert.equal(r.mode, "full");
  const types = E.types();
  // A refill: only pcbDrawing.pours changes (the journal's pours count moves; no item changed).
  doc.items[0].reliefAirGap = .3; pour();
  calls.length = 0;
  r = E.update(doc, defs, rules, {from: 1, to: 2, ids: new Set(), items: new Map(), outer: "o", pours: 2});
  assert.equal(r.mode, "copper", "a refill re-runs the copper checks only");
  assert.deepEqual(calls, ["creepage,polygonConnect,returnPath"].map(x => x.split(",").filter(t => types.includes(t)).join(",")), "no Clearance, Width or other check runs: " + JSON.stringify(calls));
  const full = drc0(doc, defs, rules, {types, limit: 5000}).violations, key = v => JSON.stringify([v.type, v.ruleId, v.id, v.otherId, v.title]);
  assert.deepEqual(r.violations.map(key).sort(), full.map(key).sort(), "the result equals a full check");
  assert.ok(r.violations.some(v => v.type === "clearance"), "other checks' results are kept");
  // Nothing changed: no check runs.
  calls.length = 0;
  r = E.update(doc, defs, rules, {from: 2, to: 3, ids: new Set(), items: new Map(), outer: "o", pours: 2});
  assert.equal(r.mode, "none"); assert.deepEqual(calls, []);
  console.log("ok - a refill re-runs only Polygon Connect, Return Path and Creepage Distance, and equals a full check");
} finally { R.drc = drc0; }
