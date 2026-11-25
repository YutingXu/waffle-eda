"use strict";

const assert = require("node:assert/strict");
for (const name of ["model", "spatial", "pcb-appearance", "pcb-pours", "rules", "board-shape", "polygon-pour", "fab-outputs", "panel"]) {
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
}

const A = Atrium, P = AtriumPolygonPour, R = AtriumRules, F = AtriumFabOutputs;
const rectangle = (x, y, right, bottom) => [[x,y],[right,y],[right,bottom],[x,bottom]];
const project = AtriumSignals.attach(A.project("Scoped freshness"));
const board = project.documents.find(d => d.kind === "pcb"), defs = new Map();
const track = {id:"trace", kind:"track", layer:"Top", net:"POWER", width:.4, points:[[4,4],[9,5]]};
board.outline = rectangle(0,0,20,15);
board.items = [track,P.make(rectangle(1,1,15,13),{id:"copper",layer:"Top",net:"GND",removeDeadCopper:false})];
const setClearance = (p, gap) => AtriumProjectRules.edit(p, book => {
  book.list.find(rule => rule.type === "clearance" && AtriumDesignQueryRecord.isAll(rule.scope)).gap = gap;
});
setClearance(project,.2);
P.apply(board,defs,{project,reuse:false});
const oldGap = A.clone(project);

const points = track.points;
let geometryReads = 0;
Object.defineProperty(track,"points",{enumerable:true,get() { geometryReads++; return points; }});
points[1][1] = 6;

function measured(run) {
  run(); // Both calls read the same already prepared item signatures.
  geometryReads = 0;
  const value = run();
  return {value,reads:geometryReads};
}

const signatureCheck = measured(() => P.stale(board,defs,{project}));
assert.deepEqual(signatureCheck.value,["copper"]);
assert.ok(signatureCheck.reads > 0);
const outputCheck = measured(() => P.outputCopper(board,defs,{project,solve:false}));
assert.deepEqual(outputCheck.value.pending,signatureCheck.value);
assert.equal(outputCheck.reads,signatureCheck.reads,"detached fabrication reads geometry once");

const manager = measured(() => P.stateOf(board,defs));
assert.equal(manager.value.state,"stale");
assert.deepEqual(manager.value.stale,signatureCheck.value);
assert.equal(manager.reads,signatureCheck.reads,"detached status reads geometry once");

const ruleSet = R.create();
ruleSet.list.push({id:"modified",type:"modifiedPolygon",name:"Modified Polygon",enabled:true,priority:1,
  scope:AtriumDesignQueryRecord.selector("all"),allowModified:false,allowShelved:false});
const both = ["modifiedPolygon","polygonConnect"];
const drc = (types, rulesProject, extra = {}) => R.drc(board,defs,ruleSet,{project:rulesProject,types,...extra});
const fixedGeo = R.kit.extract(board,defs);
const onlyChanged = measured(() => drc([both[0]],project,{geo:fixedGeo}));
const combined = measured(() => drc(both,project,{geo:fixedGeo}));
assert.deepEqual(combined.value.violations,onlyChanged.value.violations);
assert.match(combined.value.notes.join("\n"),/out of date/);
assert.equal(combined.reads,onlyChanged.reads,"compatible DRC rules share the geometry read");

points[1][1] = 5;
setClearance(oldGap,1.2);
assert.deepEqual(P.outputCopper(board,defs,{project:oldGap,solve:false}).pending,["copper"]);
assert.equal(P.outputCopper(board,defs,{project:oldGap,rules:R.stored(board,project),solve:false}).state,"current",
  "an explicit rule book takes precedence over the supplied project rules");
const differentProject = drc(both,oldGap);
assert.deepEqual(differentProject.violations.map(row => row.id),["copper"]);
assert.ok(differentProject.notes.some(note => /out of date/.test(note)),"both checks verify against the explicit project");
const throughCallback = drc([...both,"short"],project,{connections() {
  setClearance(project,1.2);
  return {shorts:[]};
}});
assert.match(throughCallback.notes.join("\n"),/out of date/,"an intervening callback can change rule inputs");
setClearance(project,.2);

const panel = AtriumPanel.create(project,{board:board.id,rows:1,cols:4,separation:"vscore"});
project.documents.push(panel);
let statusChecks = 0;
globalThis.AtriumFabOutputs = {...F,pourStatus(...args) { statusChecks++; return F.pourStatus(...args); }};
try {
  const flatten = () => AtriumPanel.flatten(project,panel,defs).doc;
  assert.equal(flatten().pcbDrawing.pours.length,4 * board.pcbDrawing.pours.length);
  assert.equal(statusChecks,1,"repeated cells check their template once");
  points[1][1] = 6;
  assert.ok(!flatten().pcbDrawing?.pours?.length,"another request sees the edited template");
  assert.equal(statusChecks,2,"freshness is shared within each request");
} finally { globalThis.AtriumFabOutputs = F; }

console.log("pour freshness reuse: detached output, status, compatible rule checks and repeated panel cells");
