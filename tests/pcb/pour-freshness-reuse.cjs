"use strict";

const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
for (const name of ["model", "spatial", "pcb-appearance", "pcb-pours", "rules", "board-shape", "polygon-pour", "fab-outputs", "panel", "undo-store"]) {
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

{
  const p = AtriumSignals.attach(A.project("Ordered pour signatures"));
  const d = p.documents.find(row => row.kind === "pcb");
  d.outline = rectangle(-10,-10,270,40);
  // Many authored rows far from each of nine pours, with a movable row at a page boundary.
  const trace = (i,x,y) => ({kind:"track",id:"trace-"+i,layer:"Top",net:"VCC",width:.2125,points:[[x,y],[x+2,y]]});
  const fixed = trace("first",2,3), sliding = trace("boundary",253,4);
  const footprint = {id:"definition",kind:"component",footprint:{pads:[
    {number:"1",x:0,y:0,w:1.1234567890123,h:1,shape:"rect",layer:"Top"}
  ],shapes:[]}};
  p.library.push(footprint);
  const lookup = new Map([[footprint.id,footprint]]);
  const zones = Array.from({length:9},(_,i) => P.make(rectangle(30*i,0,30*i+12,12),{
    id:"zone-"+i, net:"GND", layer:"Top", pourIndex:i===8?0:1
  }));
  d.items = [fixed,...Array.from({length:15},(_,i) => trace(i,258,26)),sliding,
    {id:"placed",kind:"part",def:footprint.id,layer:"Top",x:6,y:4,angle:0,ref:"R1",pinNets:{1:"VCC"}},
    ...Array.from({length:113},(_,i) => trace(i+15,256,20)),...zones];
  const signature = () => P.polygonSignatures(d,lookup,{project:p});
  const before = signature(), digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.deepEqual(Object.keys(before),["zone-8",...zones.slice(0,-1).map(z => z.id)],"equal priorities retain authored order");
  assert.equal(digest(before),"acafde8c295871e54a2d048b15b39b18a0c109a9c049ac39416c45196830cb6b",
    "version 4 signatures retain their saved wire format and order");
  assert.deepEqual(signature(),before);
  const drain = iterator => {
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
  };
  let itemHashes;
  const keepItemHashes = hashes => { itemHashes = hashes; };
  assert.deepEqual(drain(P.polygonSignatureSteps(d,lookup,{project:p,keepItemHashes},21)),before);
  assert.deepEqual(drain(P.polygonSignatureSteps(d,lookup,{project:p,itemHashes},21)),before,
    "the sliced live commit visits the same rows when it reuses item hashes");
  const U = AtriumUndoStore, history = [], future = [];
  U.reset(p);
  try {
    const originalX = sliding.points[0][0];
    for (const scoped of [true,false]) {
      const mark = U.mark(p);
      U.duringEdit(() => { sliding.points[0][0] = 8; sliding.points[1][0] = 10; });
      U.checkpoint(history,future,mark,"Cross a pour boundary");
      U.record(p,scoped?{doc:d,items:[sliding]}:undefined);
      const moved = signature();
      assert.deepEqual(Object.keys(moved).filter(id => moved[id]!==before[id]),["zone-8","zone-0"],"in-place movement reaches both placement neighborhoods");
      U.jump(history,future,U.mark(p),-1);
      assert.equal(sliding.points[0][0],originalX);
      assert.deepEqual(signature(),before);
      U.jump(history,future,U.mark(p),1);
      assert.deepEqual(signature(),moved);
      U.jump(history,future,U.mark(p),-1);
    }
    d.items[0] = {...fixed,width:.6};
    assert.notEqual(signature()["zone-0"],before["zone-0"],"same-id replacement changes the signature");
    d.items[0] = fixed;
    footprint.footprint.pads[0].w += .25;
    assert.notEqual(signature()["zone-0"],before["zone-0"],"in-place definition geometry changes the signature");
  } finally { U.reset(); }
}

console.log("pour freshness reuse: detached output, status, compatible rule checks and repeated panel cells");
