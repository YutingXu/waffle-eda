"use strict";
const assert = require("node:assert/strict");
for (const name of ["model","board-shape","pcb-appearance","pcb-pours","spatial","connectivity","canvas"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

const defs = new Map();
function board() {
  const d = Atrium.sheet("pcb","Retained copper");
  AtriumBoardShape.apply(d,{...AtriumBoardShape.rect({x:0,y:10,width:20,height:10}),
    cutouts:[AtriumBoardShape.rect({x:9,y:7,width:2,height:4}).contour]});
  d.items = [["a",2],["b",4],["hole",10],["c",14]].map(([id,x])=>
    ({id,kind:"via",x,y:5,diameter:0.8,drill:0.3,layer:"Multi",net:"SIG"}));
  d.pcbDrawing = {pours:[AtriumPCBPours.region([[[1,4],[5,4],[5,6],[1,6]]],"Top","SIG",
    {links:[["a",0],["b",0]]})]};
  AtriumPCBPours.storeSignature(d,defs);
  return d;
}

let doc = board(), modified = false, requests = 0, inspected = 0, revision = 0;
let state = "stale", display = "source";
const physical = AtriumConnectivity;
globalThis.AtriumNavHost = {doc:()=>doc,revision:()=>revision,folderProject:()=>({modified:()=>modified})};
globalThis.AtriumLazy = {need(name) {
  assert.equal(name,"AtriumPolygonPour");
  requests++;
  return new Promise(()=>{});
}};
globalThis.AtriumConnectivity = {...physical,inspect(...args) { inspected++;return physical.inspect(...args); }};
const view = AtriumCanvas.create({getContext:()=>({})}), I=view.internals();
const overlay = () => I.airwireConnectivity(doc,defs);
const source = JSON.stringify(doc);
globalThis.AtriumPower = {visible:()=>false};
assert.equal(overlay(),null);
assert.equal(requests,0,"a hidden view starts no contact service");
delete globalThis.AtriumPower;
assert.equal(overlay(),null);
assert.equal(overlay(),null);
assert.equal(requests,1);
assert.equal(inspected,0);
globalThis.AtriumPolygonPour = {state:()=>state,displayState:()=>display,verifying:()=>state==="stale"&&display==="source",
  contactRegions:d=>state==="source"?d.pcbDrawing.pours:[]};
assert.equal(overlay(),null,"stale connections must not cover retained artwork on the initial frame");
state="source";
const ready=overlay();
assert.equal(ready.excluded,1,"the central via lies in the cutout");
assert.equal(ready.nets[0].islands,2);
assert.equal(ready.airwires.length,1);
assert.deepEqual(ready.airwires,physical.inspectFull(doc,defs).airwires);
assert.equal(JSON.stringify(doc),source);

modified=true;
state="stale";
doc.items[1].x=15;revision++;
view.invalidate(doc,[doc.items[1]]);
assert.equal(overlay().airwires.length,2,"a current copper edit immediately rechecks the real vias");
assert.deepEqual(overlay().airwires,physical.inspectFull(doc,defs).airwires);
doc.items[1].x=4;
state="source";
view.invalidate(doc,[doc.items[1]]);
assert.equal(overlay().airwires.length,1);

doc=board();modified=false;state="stale";display="source";
delete doc.pcbDrawing.pours[0].links;
assert.equal(overlay(),null,"a region can acquire its first links when initially stale copper is verified");

doc=board();modified=false;state="stale";display="stale";
assert.equal(overlay().airwires.length,2,"manually stale copper is excluded from a cold physical check");
doc=board();display="source";modified=true;
assert.equal(overlay(),null,"an unsaved import is not an edit: its stored copper is still being verified");
revision++;
assert.equal(overlay().airwires.length,2,"an edit made during initial acquisition gets its current physical graph");

doc=board();modified=false;delete globalThis.AtriumPolygonPour;
for(const item of doc.items)delete item.net;
assert.equal(overlay(),null);
assert.equal(requests,1,"an unassigned board starts no contact service");
console.log("PASS retained source pours, real cutout and route, cold/warm edits and netless board");
