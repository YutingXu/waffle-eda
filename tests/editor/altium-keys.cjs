"use strict";
// Altium chord helpers (app/editor/altium-keys.js), headless: Un-Route scopes and the net highlight mask.
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/formats/import-link.js");require("../../app/checks/connectivity.js");
require("../../app/editor/nav-common.js");require("../../app/editor/crossprobe.js");require("../../app/editor/altium-keys.js");
const K=AtriumAltiumKeys;

// ------------------------------------------------------------ Un-Route scopes on a synthetic board
const pad=(id,x,net="N")=>({id,kind:"pad",x,y:0,w:1,h:1,net,layer:"Top"});
const track=(id,pts,layer="Top",net="N",extra={})=>({id,kind:"track",points:pts,width:.25,layer,net,...extra});
const board={id:"b",kind:"pcb",items:[
  pad("A",0),pad("B",10),pad("C",20),
  track("t1",[[0,0],[5,0]]),track("t2",[[5,0],[10,0]]),track("t3",[[10,0],[20,0]]),
  track("t4",[[0,10],[5,10]]),{id:"v1",kind:"via",x:5,y:10,diameter:.6,drill:.3,layer:"Multi",net:"N"},track("t5",[[5,10],[9,10]],"Bottom"),
  track("t6",[[0,-5],[4,-5]],"Top","M"),track("lk",[[30,0],[31,0]],"Top","N",{locked:true}),
  track("free",[[0,-9],[3,-9]],"Top",""),track("ko",[[0,-12],[3,-12]],"Top","N",{keepout:true})],
  rooms:[{id:"r1",name:"Left",points:[[-1,-1],[11,-1],[11,1],[-1,1]]}]};
const defs=new Map();
const ids=r=>[...r.ids].sort();
let r=K.unroute(board,defs,"all");
assert.deepEqual(ids(r),["t1","t2","t3","t4","t5","t6","v1"],"all routed copper, not netless tracks, keep-outs or locked copper");
assert.equal(r.locked,1);assert.match(r.message,/Un-routed 7 .* \(1 locked kept\)/);
assert.deepEqual(ids(K.unroute(board,defs,"net",{ids:["t6"]})),["t6"]);
assert.match(K.unroute(board,defs,"net",{ids:[]}).message,/Select a track/);
assert.deepEqual(ids(K.unroute(board,defs,"connection",{ids:["t1"]})),["t1","t2"],"a connection runs pad to pad: it stops at pad B");
assert.deepEqual(ids(K.unroute(board,defs,"connection",{ids:["t3"]})),["t3"]);
assert.deepEqual(ids(K.unroute(board,defs,"connection",{ids:["t4"]})),["t4","t5","v1"],"through a via to the other layer");
assert.deepEqual(ids(K.unroute(board,defs,"room",{ids:["t1"]})),["t1","t2"],"copper wholly inside the room");
assert.deepEqual(ids(K.unroute(board,defs,"room",{point:[2,0]})),["t1","t2"]);
assert.match(K.unroute(board,defs,"room",{point:[50,50]}).message,/inside a room/);

// ------------------------------------------------------------ the sample board: component scope and mask
const project=AtriumParts.example(),pdefs=new Map(project.library.map(d=>[d.id,d]));
const pcb=project.documents.find(d=>d.kind==="pcb"),sch=project.documents.find(d=>d.kind==="schematic");
const routedNet=pcb.items.find(i=>i.kind==="track"&&i.net)?.net;
if(routedNet){
  const part=pcb.items.find(i=>i.kind==="part"&&Object.values(i.pinNets||{}).includes(routedNet));
  const c=K.unroute(pcb,pdefs,"component",{ids:[part.id]});
  assert.ok(c.ids.length>0,"un-route component finds the copper on "+part.ref);
  const nets=new Set(Object.values(part.pinNets));
  assert.ok(c.ids.every(id=>nets.has(pcb.items.find(i=>i.id===id).net)),"only copper on the component's nets");
  const m=K.maskShapes(pcb,pdefs,routedNet);
  const tracks=pcb.items.filter(i=>i.kind==="track"&&i.net===routedNet).length;
  assert.equal(m.strokes.reduce((n,[,l])=>n+l.length,0),tracks,"every track of the net is cut out of the mask");
  assert.ok(m.fills.length>=2,"the net's pads are cut out too");
}else console.log("sample board has no routed tracks: component and mask checks skipped");
const net=A_net(sch);
const sm=K.maskShapes(sch,pdefs,net);
assert.ok(sm.strokes.length&&sm.fills.length,"schematic mask: wires and pins of "+net);
function A_net(d){return Atrium.connectivity(d,pdefs).nets.find(n=>n.name&&n.name!=="GND")?.name||"GND";}
console.log("PASS Un-Route all/net/connection/component/room (pad-to-pad, vias, locked kept) and the net highlight mask.");
