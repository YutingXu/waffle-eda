"use strict";
const assert = require("node:assert/strict");
const {strip, inventory, placements} = require("./strip.cjs");
const {inspect, evaluate, delta} = require("./quality.cjs");
const {run} = require("./worker.cjs");
const {profiles} = require("./profiles.cjs");
const {fit, choose, compare} = require("./learn.cjs");

function board() {
  const p = Atrium.project("Two nets"), d = Atrium.sheet("pcb","Placement");
  d.outline = [[0,0],[18,0],[18,18],[0,18]];
  p.documents = [d]; p.library = [];
  for (const [id,x,y,net] of [["a",2,9,"A"],["b",16,9,"A"],["c",9,2,"B"],["d",9,16,"B"]]) {
    d.items.push({id,kind:"pad",x,y,net,number:id,w:1,h:1,shape:"round",drill:.35,layer:"Multi",angle:0});
  }
  p.library.push({id:"device",name:"rotated",prefix:"P",value:"footprint",footprint:{name:"rotated",pads:[
    {number:"1",x:1,y:.3,w:.8,h:.4,angle:45,layer:"Bottom",shape:"rect",drill:0}],shapes:[]}});
  d.items.push({id:"part",kind:"part",ref:"P1",value:"",def:"device",x:3,y:3,angle:90,layer:"Bottom",pinNets:{"1":"C"}});
  return p;
}
const track = (id,net,a,b) => ({id,net,kind:"track",layer:"Top",width:.25,points:[a,b]});
const via = (id,net,x,y) => ({id,net,kind:"via",layer:"Multi",x,y,diameter:.8,drill:.35});
function stripping() {
  const p = board(),d=p.documents[0];
  d.autorouter = {fixedNets:["A"]}; d.sourceSha256 = "0".repeat(64);
  d.pcbDrawing = {annotations:{},pours:[{net:"A",links:[["a","b"]]}],pourSignatures:{}};
  d.sourceDrillDrawing = {tools:[{x:10,y:7}]}; d.airwires=[{net:"A"}];
  d.items.push({...track("pre","A",[2,9],[8,9]),locked:true},via("v","A",8,9),
    {...track("arc","A",[3,4],[7,8]),arc:true}, {id:"zone",kind:"polygon",net:"A",layer:"Bottom",points:d.outline},
    {id:"fill",kind:"graphic",net:"",layer:"Bottom",fill:true,points:d.outline},
    {id:"keep",kind:"graphic",layer:"Bottom",keepout:true,keepoutRestrictions:2,points:[[10,4],[10,5]],width:1});
  const other=structuredClone(p);
  other.documents[0].items.find(i=>i.id==="pre").points = [[2,9],[16,9]];
  other.documents[0].pcbDrawing.pours[0].links.push(["c"]);
  const frozen=JSON.stringify(p),s=strip(p),i=inventory(s);
  assert.deepEqual(strip(other),s,"authored route leaked through strip");
  assert.equal(JSON.stringify(p),frozen);
  assert.deepEqual(placements(p),placements(s));
  assert.equal(i.bottom,1);assert.equal(i.keepouts,1);assert.equal(i.footprintCopper,0);
  assert.deepEqual([i.tracks,i.vias,i.arcs,i.fills,i.polygons,i.pouredRegions],[0,0,0,0,0,0]);
  for (const key of ["pcbDrawing","sourceDrillDrawing","sourceSha256","airwires","autorouter"]) assert(!Object.hasOwn(s.documents[0],key));
  const road = s.documents[0].items.find(i=>i.id==="keep");
  assert.equal(road.keepoutRestrictions,2);
}
function quality() {
  const s=strip(board()),base=inspect(s), a=track("ta","A",[2,9],[16,9]),b=track("tb","B",[9,2],[9,16]);
  assert.equal(base.opens,2);
  const short=evaluate(s,[a,b],base);
  assert(short.raw.shorts>0 && !short.raw.legal);
  assert(short.accepted.legal && short.accepted.opens===2 && short.accepted.shorts===0);
  const close=evaluate(s,[a,track("close","B",[3,9.3],[8,9.3])],base);
  assert(close.raw.newIssues.clearance>0 && close.accepted.legal);
  assert(evaluate(s,[track("outside","A",[2,9],[-2,9])],base).raw.newIssues.physicalBoundary>0);
  assert.equal(evaluate(s,[a],base).accepted.opens,1);
  const keep=structuredClone(s), foot=keep.library[0].footprint, part=keep.documents[0].items.find(i=>i.kind==="part");
  foot.shapes.push({kind:"path",keepout:true,layer:"Top",keepoutRestrictions:2,width:.4,points:[[-7,0],[7,0]],style:"body"});
  part.x=9;part.y=9;part.angle=90;
  assert(evaluate(keep,[a],inspect(keep)).raw.newIssues.footprintKeepout>0);
  const land=structuredClone(s);
  land.documents[0].items.push({id:"unassigned",kind:"pad",number:"",net:"",x:7,y:9.6,layer:"Top",shape:"round",w:.8,h:.8,drill:0});
  assert(evaluate(land,[a],inspect(land)).raw.newIssues.unassignedPadClearance>0);
  const cut=structuredClone(s), doc=cut.documents[0];
  doc.boardShape=AtriumBoardShape.fromPolygon(doc.outline);
  doc.boardShape.cutouts=[AtriumBoardShape.fromPolygon([[7,8],[11,8],[11,10],[7,10]]).contour];
  assert(evaluate(cut,[a],inspect(cut)).raw.newIssues.physicalBoundary>0);
  // A disappearing old violation cannot cancel a different newly introduced one of the same type.
  assert.equal(delta({keys:["new"],violations:[{type:"clearance"}]},{keys:["old"]}).length,1);
  const good={accepted:{legal:true,opens:1,vias:100,lengthMm:100},expansions:20};
  assert(compare(good,{accepted:{legal:false,opens:0,vias:0,lengthMm:0},expansions:0})<0);
  assert(compare(good,{accepted:{legal:true,opens:2,vias:0,lengthMm:0},expansions:0})<0);
}
function learning() {
  const mk=(family,v)=>({family,features:[v,0,0],runs:Object.fromEntries(profiles.map((p,i)=>[p.id,{
    accepted:{legal:true,opens:i===v?0:1,vias:0,lengthMm:1},expansions:2}]))});
  const train=[mk("one",0),mk("two",1)];
  assert.throws(()=>fit(train,"one"),/Held-out/);
  assert.throws(()=>fit([],"unseen"),/empty/);
  const group=[mk("one",0),mk("one",2),mk("two",1),mk("three",2)].map((b,i)=>({id:"board-"+i,...b}));
  const fold=boards=>require("./bench.cjs").folds(boards,true)[0];
  const before=fold(group),poison=structuredClone(group);
  for(const b of poison.filter(b=>b.family==="one"))b.runs.single.accepted.opens=1000;
  assert.deepEqual(fold(poison),before,"sibling or held-out labels reached training");
  const model=fit(train,"unseen");
  assert.deepEqual(model.families,["one","two"]);
  assert.equal(choose(model,[0,0,0]),profiles[0].id);
  assert.equal(choose(model,[1,0,0]),profiles[1].id);
}
stripping();quality();learning();
const p=strip(board()),a=run(p,["single","margin"]),b=run(p,["single","margin"]);
for(const id of ["single","margin"]){
  assert.equal(a.runs[id].geometrySha256,b.runs[id].geometrySha256);
  assert.equal(a.runs[id].expansions,b.runs[id].expansions);
  assert(a.runs[id].accepted.legal);
}
const held=require("./models.json");
for (const [name,row] of Object.entries(held.byFamily)) assert(!row.model.families.includes(name));
const {accessPoint,budget}=require("./rescue.cjs"), pad={pad:true,id:"a",net:"A",at:[0,0],item:{w:1,h:1},layers:["Top"]};
const neighbour={net:"B",layers:["Top"],shape:{k:0,c:[.45,0],r:.2}};
const access=accessPoint([0,0],"a",[4,0],"A",[pad,neighbour]);
assert(access[0]<=0 && Math.hypot(...access)<.5,"access stays inside the pad, away from its neighbour");
assert.equal(budget.calls,12);
console.log("Fixed-placement strip, legality, family holdout and reproducibility passed.");
