"use strict";
// Online Creepage Distance after a refill (app/checks/drc-view.js with app/checks/creepage.js): creepage measures poured
// copper (pcbDrawing.pours, creepage.js regionFeatures), so a refill must re-run it like the other checks
// that read pours. Deleting a track lets a 400 V pour refill closer to a ground track; the online marker
// appears with the refill, without another edit, and equals a full check.
// Run: node tests/checks/drc-creepage-refill.cjs   (or scripts/test-jsc.sh drc-creepage-refill)
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "nav-common", "spatial", "connectivity", "sch-objects", "hierarchy", "net-intent", "altium-rules", "query", "signals", "rules", "project-rules",
  "stroke-font","vectorize","pcb-text-rich","pcb-text","pcb/mask-openings","pcb/resolved-geometry-curves","pcb/geometry-material","pcb/resolved-geometry",
  "pcb-pours", "stackup", "board-shape", "pcb-appearance", "pcb-draw", "component-classes", "viastack", "polygon-pour", "net-intent-index", "erc", "drc", "checks", "drc-pours", "creepage", "drc-view", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, V = AtriumDRCView, R = AtriumRules, PR = AtriumProjectRules, PP = AtriumPolygonPour;
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const track = (id, net, points) => ({id, kind: "track", net, layer: "Top", width: .3, points});
const p = A.project("Creepage refill", []), pcb = p.documents[1], defs = new Map();
pcb.outline = rect(0, 0, 60, 40);
// DCLINK is confirmed 400 V (a tag with a voltage): IEC 62368-1 asks 4 mm creepage to ground.
p.signals = {version: 1, signals: [], tags: [{name: "HV", params: {voltage: 400}}], nets: {DCLINK: {tags: ["HV"]}}};
AtriumSignals.attach(p);
pcb.items.push(
  {id: "hv", kind: "polygon", net: "DCLINK", layer: "Top", points: rect(5, 5, 45, 25), clearance: .5, removeDeadCopper: true},
  track("feed", "DCLINK", [[10, 10], [40, 10]]),
  // A track of another net (no voltage, not checked) across the pour's top: the pour stops 0.65 mm below
  // it, and the strip above it is dead copper.
  track("obst", "OBST", [[3, 24], [47, 24]]),
  // Ground outside the pour: 4.3 mm from the pour's edge now, 2.65 mm once the pour fills to its outline.
  track("gnd", "GND", [[5, 27.8], [45, 27.8]]));
PR.edit(p, b => { b.list.push({id: "creep-1", type: "creepage", name: "Creepage", comment: "", enabled: true, priority: 1, scope: {kind: "all"}, scope2: {kind: "all"},
  ...R.types.creepage.fields.reduce((o, f) => (o[f.key] = f.def, o), {}), unknown: "skip"}); });
const rules = R.stored(pcb, p);
assert.ok(rules.list.some(r => r.type === "creepage"), "the board's rules hold the Creepage Distance rule");
const refill = () => PP.apply(pcb,defs);
refill();
const creep = list => list.filter(v => v.type === "creepage");
const fullCheck = () => creep(R.drc(pcb, defs, rules, {types: V.online().types(), limit: 5000}).violations);
assert.equal(fullCheck().length, 0, "with the track in place, the pour keeps 4.3 mm to ground");

const E=V.online(), U=AtriumUndoStore;
function update(){
  U.record(p);
  const v=U.documentVersions(pcb,p,true), from=E.at(), {seq,ids,items}=U.recordedChanges(pcb,from);
  const geometry=AtriumResolvedGeometry.read({kind:"editor",project:p,root:pcb});
  return E.update(pcb,defs,rules,{from,to:seq,ids,items,outer:[v.floor,v.outer,v.project,v.library].join("/"),
    library:v.library,floor:v.floor,pours:v.pours,project:p,journal:U,geometry});
}
let r=update();
assert.equal(r.mode, "full");
assert.equal(creep(r.violations).length, 0);
// Delete the track: the pour has not refilled yet (a refill follows the edit), so nothing changes.
const gone = pcb.items.find(i => i.id === "obst");
pcb.items.splice(pcb.items.indexOf(gone), 1);
r=update();
assert.equal(creep(r.violations).length, 0, "before the refill the pour is where it was");
// The refill: only pcbDrawing.pours changes. Creepage runs again with the other pour-reading checks.
refill();
const calls = [], drc0 = R.drc;
R.drc = (d, f, rr, o) => { calls.push(o?.types ? o.types.slice().sort().join(",") : "all"); return drc0(d, f, rr, o); };
try {r=update();} finally { R.drc=drc0; }
assert.equal(r.mode, "copper", "a refill re-runs the copper checks only");
assert.ok(calls.length === 1 && calls[0].split(",").includes("creepage") && !calls[0].split(",").includes("clearance"), "creepage, not clearance: " + JSON.stringify(calls));
const marks = creep(r.violations), full = fullCheck();
assert.ok(marks.length >= 1, "the refilled pour is 2.65 mm from ground: the online creepage marker appears without another edit");
assert.ok(marks.some(v => [v.id, v.otherId].includes("hv") && [v.id, v.otherId].includes("gnd")), "between the pour and the ground track: " + JSON.stringify(marks.map(v => v.title)));
const key = v => JSON.stringify([v.type, v.ruleId, v.id, v.otherId, v.title, v.actual]);
assert.deepEqual(marks.map(key).sort(), full.map(key).sort(), "the online result equals a full check");

pcb.items.find(i => i.id === "hv").points = rect(5,5,45,24);
U.record(p);
refill();
r=update();
assert.equal(r.mode,"incremental");
const edited = fullCheck();
assert.ok(edited.length > 0 && edited[0].actual !== full[0].actual);
assert.deepEqual(creep(r.violations).map(key).sort(),edited.map(key).sort(),"an authored edit retains the fresh board-wide findings");
U.reset();
console.log("ok - a refill re-runs Creepage Distance: the pour that refilled closer to ground is marked without another edit");
