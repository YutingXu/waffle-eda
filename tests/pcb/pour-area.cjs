"use strict";

// Stored copper from a journaled local overlay is byte-identical to a fresh
// full refill, including closed holes, analytic arcs, links and dependent fills.
const assert=require("node:assert/strict");
for(const name of ["model","parts","spatial","pcb-appearance","pcb-pours","pcb-text-rich","pcb-text","vectorize",
  "stackup","net-intent","signals","query","rules","project-rules","viastack","board-shape","polygon-pour",
  "zip","fab-outputs","undo-store"])require(require("../support/app-source-paths.cjs").appFile(name+".js"));
try{require("../../app/engine-core.js");}catch{/* the JS core uses the same integer predicates */}

const A=Atrium,P=AtriumPolygonPour,U=AtriumUndoStore;
const box=(x,y,X,Y)=>[[x,y],[X,y],[X,Y],[x,Y]];
const via=(id,x,y,net="SIG")=>({kind:"via",id,layer:"Multi",x,y,net,diameter:1.1,drill:.45});
const pour=(id,points,settings)=>Object.assign(P.make(points,{layer:"Top",removeDeadCopper:false,arcApproximation:.008,...settings}),{id});
const project=A.project("Local polygon refill"),doc=project.documents.find(d=>d.kind==="pcb"),defs=new Map(project.library.map(d=>[d.id,d]));
const upper=pour("upper",box(1,1,89,63),{net:"GND",clearance:1.18,pourIndex:0,viaConnectStyle:"relief",removeDeadCopper:true});
const lower=pour("lower",box(7,5,83,59),{net:"VCC",clearance:.16,pourIndex:1});
const moved=via("moved",47.55,33.15),neighbour=via("neighbour",50.25,33.12),relief=via("relief",29.85,32.8,"GND");
doc.outline=box(0,0,90,64);
doc.items=[upper,lower,moved,neighbour,relief,via("right-anchor",61.3,26.3,"GND")];
for(let y=5;y<=59;y+=5)for(let x=5;x<=85;x+=5){
  if(Math.hypot(x-49,y-33)<5||Math.hypot(x-30,y-33)<2.5)continue;
  doc.items.push(via("via-"+x+"-"+y,x+(y%3)*.11,y+(x%3)*.13));
}
const imported=AtriumPCBPours.region([box(3,3,5,5)],"Bottom","STORED");
doc.pcbDrawing={pours:[imported],annotations:{}};
doc.pcbDrawing.importedPourSignature=P.signature({...doc,items:doc.items.filter(i=>i.kind!=="polygon")},defs);
const area={sessions:new Map(),dirtyBoxes:null,changedItems:null},options={project,reuse:false};
const copper=(r)=>JSON.stringify(r.regions);
const past=[],future=[];
const find=id=>doc.items.find(i=>i.id===id);
const dirty=(item)=>item?P._internal.itemBox(item,defs):null;
let steps=0;
function compare(name){
  const result=P.repourAll(doc,defs,{...options,area}),exact=P.repourAll(doc,defs,options);
  assert.equal(result.failed.length,0,name);
  assert.ok(copper(result)===copper(exact),name+" differs from the full stored contours, arcs or links");
  assert.deepEqual(result.signatures,exact.signatures,name+" signatures");
  steps++;
  return {result,exact};
}
function journalEdit(id,change){
  const seq=U.changed(doc).seq,before=dirty(find(id)),mark=U.mark(project,{current:doc.id});
  change();
  U.checkpoint(past,future,mark,"");
  U.touch(project);U.sync();
  const edits=U.changed(doc,seq);
  assert.ok(edits.ids?.has(id),"undo store recorded "+id);
  area.changedItems=edits.ids;
  area.dirtyBoxes=[before,dirty(find(id))].filter(Boolean);
}
function localWork(result,id,stage){
  const s=result.stats.polygons[id].area[stage];
  assert.equal(s.mode,"local",id+" "+stage+" should solve a bounded neighbourhood");
  assert.ok(s.mm2<s.fullMm2/10&&s.primitives<s.fullPrimitives/10,s);
  return s;
}
function fabrication(a,b){
  const gerber=result=>{
    const p=A.clone(project),d=p.documents.find(x=>x.id===doc.id),library=new Map(p.library.map(x=>[x.id,x]));
    P.apply(d,library,{project:p,result,detached:true});
    const files=AtriumFabOutputs.build(p,d,{date:new Date("2025-01-01T00:00:00Z")}).files;
    return files.filter(f=>/\.(GTL|GBL|G[0-9]+)$/.test(f.name)).map(f=>f.content);
  };
  const reference=gerber(b);
  assert.ok(reference.length>=2,"fabrication includes both outside copper layers");
  assert.deepEqual(gerber(a),reference,"plotted copper equals a full refill");
}

U.reset();U.touch(project);U.sync();
compare("warm full solve");
journalEdit("moved",()=>{moved.x+=.2;moved.y-=.15;});
const first=compare("overlapping clearance move");
const early=localWork(first.result,"upper","stage1");
assert.ok(early.shapes>1,"unchanged neighbouring clearance shapes enter the local overlay");
assert.equal(first.result.stats.polygons.upper.preparedItems.rebuilt,1);
assert.ok(first.result.regions.some(r=>r.arcs?.length),"the local fill retains analytic arcs");
localWork(first.result,"lower","stage2");
assert.ok(first.result.stats.polygons.lower.preparedOffsets.reused>100);
fabrication(first.result,first.exact);

journalEdit("moved",()=>doc.items.splice(doc.items.indexOf(moved),1));
localWork(compare("deleted obstacle").result,"upper","stage1");
const seq=U.changed(doc).seq,here=U.mark(project,{current:doc.id});
U.jump(past,future,here,-1);U.touch(project);U.sync();
area.changedItems=U.changed(doc,seq).ids;
assert.ok(area.changedItems?.has("moved")&&find("moved"),"undo restores the obstacle");
area.dirtyBoxes=[dirty(find("moved"))];
localWork(compare("undo of obstacle delete").result,"lower","stage2");

journalEdit("relief",()=>{find("relief").y+=.61;});
const thermal=compare("moved four-spoke thermal");
localWork(thermal.result,"upper","stage1");
assert.ok(thermal.result.regions.some(r=>r.links.some(l=>l[0]==="relief")),"the relocated thermal links to copper");

// A cut the full height of the polygon splits islands, and the earlier
// copper read by the dependent fill may change along that entire cut.
const split={kind:"polygon",id:"split",cutout:true,layer:"Multi",points:box(41,0,43,64)};
journalEdit("split",()=>doc.items.push(split));
const cut=compare("split that reaches the polygon boundary").result;
assert.equal(cut.stats.polygons.upper.area.stage1.mode,"full");
assert.ok(cut.regions.filter(r=>r.polygon==="upper").length>1);
journalEdit("relief",()=>doc.items.splice(doc.items.indexOf(find("relief")),1));
const dead=compare("deleting an isolated island's only anchor").result;
localWork(dead,"upper","stage1");
assert.equal(dead.regions.filter(r=>r.polygon==="upper").length,1,"the split island loses its only same-net anchor");
assert.equal(dead.stats.polygons.lower.area.stage2.mode,"full","the dependent refill sees the lost island");

// Global edits are explicitly sent through the ordinary full worker solve.
area.dirtyBoxes=null;area.changedItems=null;
find("lower").clearance=null;
doc.rules={format:"atrium-rules",version:1,units:"mm",defaults:{clearance:.32}};
find("lower").pourIndex=-1;
find("upper").layer="Inner 1";
find("upper").powerPlane={sourceLayer:"PLANE1",via:{expansion:.3,width:.25,airGap:.25,entries:4}};
const plane=compare("rules, priority and split-plane change");
assert.equal(plane.result.stats.polygons.upper.area.stage1.mode,"full");
assert.ok(plane.result.regions.some(r=>r.layer==="Inner 1"));
fabrication(plane.result,plane.exact);

// A wide outline uses a coarser integer grid even inside a small pour.
area.sessions.clear();area.dirtyBoxes=null;area.changedItems=null;
doc.outline=box(-138,0,90,64);
U.touch(project);U.sync();

const coarse=compare("coarse grid initial fill").result;
assert.ok(coarse.stats.polygons.lower.scale<1e5,"the lower pour uses a coarse grid");
journalEdit("neighbour",()=>{find("neighbour").x+=.1;});
const bounded=compare("one obstacle on a stable coarse grid").result;
assert.equal(bounded.stats.polygons.lower.preparedItems.rebuilt,1,"the coarse grid rebuilds only the edited source");
assert.equal(bounded.stats.polygons.lower.scale,coarse.stats.polygons.lower.scale);
localWork(bounded,"lower","stage1");
journalEdit("long-track",()=>doc.items.push({id:"long-track",kind:"track",layer:"Top",net:"SIG",width:.2,points:[[12,10],[240,10]]}));
const {result:reframed,exact}=compare("a track increases the integer extent");
assert.ok(reframed.stats.polygons.lower.scale<bounded.stats.polygons.lower.scale);
assert.equal(reframed.stats.polygons.lower.preparedItems.reused,0,"a change of grid discards prepared coordinates");
fabrication(reframed,exact);

// An off-board polygon still reports the connection decisions from its outline.
const outside=pour("outside",box(105,4,115,12),{net:"SIG",clearance:.25}),testVia=via("outside-via",110,8);
const disjoint={...doc,outline:box(0,0,90,64),items:[outside,testVia]},contrib=new Set();
const noCopper=P._internal.prepare(disjoint,defs,outside,{project,area,contrib});
assert.equal(noCopper.task,undefined);
assert.deepEqual(noCopper.stats.connections.map(row=>row.id),[testVia.id]);
assert.deepEqual([...contrib],[testVia.id]);
U.reset();
console.log("pour-area: "+steps+" fills match full contours, links, arcs, signatures and fabrication");
