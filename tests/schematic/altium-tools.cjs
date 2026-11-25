"use strict";
// Altium selection, align and room tools (app/schematic/altium-tools.js), headless.
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/editor/nav-common.js");require("../../app/pcb/smart-guides.js");require("../../app/schematic/altium-tools.js");
const T=AtriumAltiumTools,defs=new Map();
const pad=(id,x,y=0,net="N")=>({id,kind:"pad",x,y,w:1,h:1,net,layer:"Top"});
const track=(id,pts,layer="Top",net="N")=>({id,kind:"track",points:pts,width:.25,layer,net});
const via=(id,x,y,net="N")=>({id,kind:"via",x,y,diameter:.6,drill:.3,layer:"Multi",net});

// ------------------------------------------------------------ S T: touching line
const sheet={id:"s",kind:"pcb",items:[track("h1",[[0,0],[10,0]]),track("h2",[[0,5],[10,5]]),track("far",[[20,20],[30,20]]),via("v",5,10),
  {id:"poly",kind:"polygon",points:[[-5,-10],[-1,-10],[-1,-6],[-5,-6]],layer:"Top",net:"N"}]};
let ids=T.touching(sheet,defs,[5,-1],[5,11],{tol:.01}).sort();
assert.deepEqual(ids,["h1","h2","v"],"the line crosses both tracks and the via, not the far track");
assert.deepEqual(T.touching(sheet,defs,[-3,-8],[-2,-8],{tol:0}),["poly"],"a line inside a filled shape touches it");
assert.deepEqual(T.touching(sheet,defs,[5,1],[5,4],{tol:0}),[],"a line between tracks touches nothing");
assert.deepEqual(T.touching(sheet,defs,[5,-1],[5,11],{tol:.01,filter:i=>i.kind==="via"}),["v"],"the selection filter applies");

// ------------------------------------------------------------ S C / S P: connection vs physical connection
// A ── t1 ── t2 ── B ── t3 ── C, and a branch through a via to the bottom layer from t1's end.
const board={id:"b",kind:"pcb",items:[pad("A",0),pad("B",10),pad("C",20),
  track("t1",[[0,0],[5,0]]),track("t2",[[5,0],[10,0]]),track("t3",[[10,0],[20,0]]),
  via("v1",5,0),track("t4",[[5,0],[5,8]],"Bottom"),track("o",[[0,30],[5,30]],"Top","M")]};
const sorted=a=>[...a].sort();
assert.deepEqual(sorted(T.connection(board,defs,["t1"])),["t1","t2","t4","v1"],"a connection stops at pad B");
assert.deepEqual(sorted(T.connection(board,defs,["t3"])),["t3"]);
assert.deepEqual(sorted(T.connection(board,defs,["t1"],{physical:true})),["A","B","C","t1","t2","t3","t4","v1"],"physical connection runs through pads");
assert.deepEqual(sorted(T.connection(board,defs,["B"],{physical:false})),["t1","t2","t3","t4","v1"],"a pad seed starts from the copper on it");
assert.ok(!T.connection(board,defs,["t1"],{physical:true}).includes("o"),"other nets stay out");

// ------------------------------------------------------------ Align… plans
const parts={id:"p",kind:"pcb",grid:1,items:[{id:"a",kind:"via",x:0,y:0,diameter:1},{id:"b",kind:"via",x:3,y:2,diameter:1},{id:"c",kind:"via",x:10,y:5,diameter:1}]};
let plan=T.alignPlan(parts,defs,["a","b","c"],{h:"left",v:"bottom"});
const mv=id=>plan.moves.find(m=>m.id===id)||{dx:0,dy:0};
assert.deepEqual([mv("b").dx,mv("b").dy],[-3,3],"left and bottom combine in one plan");
assert.deepEqual([mv("c").dx,mv("c").dy],[-10,0]);
plan=T.alignPlan(parts,defs,["a","b","c"],{h:"gap",hGap:2});
assert.deepEqual([mv("b").dx,mv("c").dx],[0,-4],"space equally by 2 keeps the first object");
plan=T.alignPlan(parts,defs,["a","b","c"],{h:"none",v:"none"});
assert.equal(plan.moves.length,0);
assert.equal(Math.round(T.currentGap(parts,defs,["a","b","c"],"x")*1e6)/1e6,4,"average gap between neighbours");
parts.items[2].locked=true;assert.deepEqual(T.alignPlan(parts,defs,["a","b","c"],{h:"left"}).locked,["c"]);

// ------------------------------------------------------------ rooms, corner modes, layer cycle
const rb={id:"r",kind:"pcb",items:[{id:"u1",kind:"part",x:1,y:1},{id:"u2",kind:"part",x:9,y:9},{id:"u3",kind:"part",x:50,y:50}],
  rooms:[{id:"r1",name:"Left",points:[[0,0],[10,0],[10,10],[0,10]]}]};
assert.deepEqual(T.roomParts(rb,defs,rb.rooms[0]).sort(),["u1","u2"]);
assert.equal(T.roomAt(rb,defs,[],[5,5]).id,"r1");assert.equal(T.roomAt(rb,defs,["u3"],null),null);
assert.deepEqual(T.constrain("90",[0,0],[5,2]),[5,0]);assert.deepEqual(T.constrain("90",[0,0],[1,4]),[0,4]);
const d45=T.constrain("45",[0,0],[4,3.6]);assert.ok(Math.abs(d45[0]-d45[1])<1e-9,"45° snaps to the diagonal");
assert.deepEqual(T.constrain(null,[0,0],[4,3]),[4,3]);
assert.equal(T.layerCycle(["Top","Bottom"],["Silk","Mechanical"],"Bottom",1),"Silk","+ moves from the last copper layer to the first shown non-copper layer");
assert.equal(T.layerCycle(["Top","Bottom"],["Silk"],"Silk",1),"Top","and wraps back to copper");
assert.equal(T.layerCycle(["Top","Bottom"],["Silk"],"Top",-1),"Silk");
assert.equal(T.layerCycle([],[],"Top",1),null);
console.log("PASS altium-tools: touching line, connection scopes, align plans, rooms, corner modes, layer cycle");
