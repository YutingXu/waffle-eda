"use strict";

// Live connectivity remembers each board's pour state while its inputs are unchanged. Those inputs
// include the project's rule book and the signal model, which live outside the board: editing an
// inherited connect style or clearance leaves every item and region as it was, yet makes the stored
// copper stale. The remembered "fresh" verdict then kept the pour's joins and hid an unrouted
// connection that the full pass reports.
const assert = require("node:assert/strict");
for (const name of ["model", "parts", "spatial", "sch-objects", "hierarchy", "board-shape", "stackup", "impedance",
  "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "design-query-record",
  "query", "net-intent", "signals", "rules", "viastack", "polygon-pour", "net-ties", "connectivity",
  "connectivity-live"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const {board} = require("../support/stitched-ground.cjs");

const R = AtriumRules, L = AtriumConnectivityLive, C = AtriumConnectivity;
const {project, doc, defs} = board();
const gnd = r => r.nets.find(n => n.name === "GND").missing;
const same = what => {
  const live = L.inspect(doc, defs), full = C.inspectFull(doc, defs);
  assert.deepEqual(live.nets, full.nets, what);
  assert.deepEqual(live.airwires, full.airwires, what);
  return gnd(full);
};
function edit(change) {
  const set = R.migrate(R.stored(doc, project));
  for (const r of set.list) if (r.id === "rule-power-relief") change(r);
  R.store(doc, project, set);
}

assert.equal(same("fresh copper"), 0, "the stored pour joins ground");
const items = doc.items, regions = doc.pcbDrawing.pours, before = JSON.stringify(doc);
edit(r => {r.airGap = .6;});
assert.equal(JSON.stringify(doc), before, "a project rule edit leaves the board itself unchanged");
assert.ok(doc.items === items && doc.pcbDrawing.pours === regions);
assert.equal(AtriumPolygonPour.state(doc, defs, {project}), "stale");
assert.equal(same("inherited rule edited"), 1, "the stale pour no longer joins ground");
edit(r => {r.airGap = .3;});
assert.equal(same("rule restored"), 0, "restoring the rule restores the fresh copper");
console.log("connectivity-rule-invalidation: project rule edits refresh the remembered pour state (0 -> 1 -> 0 ground airwires) OK");
