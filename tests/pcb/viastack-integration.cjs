"use strict";
// Integration of via stacks (Gerber 4:6 mm, so x*1e6 output units) with the patched fab-outputs.js, rules.js and canvas (scratch copies).
const assert=require("node:assert/strict");
for(const m of ["model","parts","pcb-pours","pcb-appearance","zip","stackup","rules","viastack","fab-outputs"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const A=Atrium,F=AtriumFabOutputs,V=AtriumViaStack,R=AtriumRules;
const date=new Date(2026,10,18,10,30,0);
const s=A.project("Vias",[]),board=s.documents.find(d=>d.kind==="pcb");board.name="Vias";board.outline=[[0,0],[40,0],[40,30],[0,30]];
board.stackup={version:1,layers:AtriumStackup.preset("6").layers};
const via=(id,x,extra={})=>({kind:"via",id,x,y:10,diameter:.6,drill:.3,layer:"Multi",net:"N",...extra});
// Every inner layer is used so the copper stack has six layers.
for(const [i,l] of ["Inner 1","Inner 2","Inner 3","Inner 4"].entries())board.items.push({kind:"track",id:"t"+i,net:"N",layer:l,width:.2,points:[[1,2+i],[3,2+i]]});
board.items.push(
  via("plain",5),
  via("tent",8,{tent:{top:true,bottom:true}}),
  via("ipc3",11,{ipc4761:"III"}),
  via("tmb",14,{stackMode:"tmb",padStack:{Top:{diameter:.8},Mid:{diameter:.45},Bottom:{diameter:.7}},diameter:.8}),
  via("bd",17,{backdrill:{from:"bottom",toLayer:"Inner 2",stubMax:.15,diameter:.55}}),
  via("uv",20,{diameter:.25,drill:.1,fromLayer:"Top",toLayer:"Inner 1"}),
  via("vip",23,{ipc4761:"VII",viaInPad:true,maskExpansion:0})
);
A.validate(JSON.parse(JSON.stringify(s)));
const flashesAt=(text,x)=>{const m=[...text.matchAll(/^X(-?\d+)Y(-?\d+)D03\*$/gm)].map(m=>+m[1]);return m.filter(v=>Math.abs(v-x*1e6)<500).length;};
let out=F.build(s,board,{date,tentVias:false}),get=suffix=>out.files.find(f=>f.name.endsWith(suffix))?.content;
const names=out.files.map(f=>f.name);
assert.ok(names.includes("Vias-BackDrill-IN3-BOT.TXT"),names.join(" "));
assert.ok(names.includes("Vias-Microvia-TOP-IN1.TXT"),names.join(" "));
// Mask: plain follows the option (open), tented is covered, Type III open, VII open with zero expansion.
const gts=get(".GTS"),gbs=get(".GBS");
assert.deepEqual([5,8,11,14,17,20,23].map(x=>flashesAt(gts,x)),[1,0,1,1,1,1,1]);
assert.deepEqual([5,8,11,14,17,20,23].map(x=>flashesAt(gbs,x)),[1,0,1,1,1,0,1],"the microvia does not reach the bottom");
out=F.build(s,board,{date,tentVias:true});get=suffix=>out.files.find(f=>f.name.endsWith(suffix))?.content;
assert.deepEqual([5,8,11,14,17,20,23].map(x=>flashesAt(get(".GTS"),x)),[0,0,1,0,0,0,1],"Tent vias covers only vias without their own choice");
// The back-drilled bottom clears the 0.55 mm back-drill hole plus the 0.1016 mm default expansion.
const bdMask=(text,x)=>{let cur=null;const codes={};for(const l of text.split("\n")){const d=/^%ADD(\d+)C,([\d.]+)\*%$/.exec(l);if(d)codes[d[1]]=+d[2];const sel=/^D(\d+)\*$/.exec(l);if(sel)cur=sel[1];const f=/^X(-?\d+)Y(-?\d+)D03\*$/.exec(l);if(f&&Math.abs(+f[1]-x*1e6)<500)return codes[cur];}return null;};
assert.equal(bdMask(get(".GBS"),17),.7532);assert.equal(bdMask(get(".GTS"),23),.6,"VII via-in-pad opening with its own zero expansion");
// Copper: per-layer lands; back-drilled layers lose their land.
const ap=(text,x)=>{const lines=text.split("\n");let cur=null;const codes={};for(const l of lines){const d=/^%ADD(\d+)C,([\d.]+)\*%$/.exec(l);if(d)codes[d[1]]=+d[2];const sel=/^D(\d+)\*$/.exec(l);if(sel)cur=sel[1];const f=/^X(-?\d+)Y(-?\d+)D03\*$/.exec(l);if(f&&Math.abs(+f[1]-x*1e6)<500)return codes[cur];}return null;};
assert.equal(ap(get(".GTL"),14),.8);assert.equal(ap(get(".G2"),14),.45);assert.equal(ap(get(".GBL"),14),.7);
assert.equal(ap(get(".G2"),17),.6);assert.equal(ap(get(".G3"),17),null,"Inner 3 is cut off by the back-drill");assert.equal(ap(get(".GBL"),17),null);
// Back-drill file: X2 function, aperture function, stop layer and stub.
const bdFile=get("-BackDrill-IN3-BOT.TXT");
assert.match(bdFile,/TF\.FileFunction,NonPlated,6,4,Blind,Drill/);
assert.match(bdFile,/TA\.AperFunction,BackDrill/);assert.match(bdFile,/;BACKDRILL=from bottom; keep Inner 2; max stub 0\.15 mm/);
assert.match(bdFile,/T01C0\.550/);
const mv=get("-Microvia-TOP-IN1.TXT");assert.match(mv,/TF\.FileFunction,Plated,1,2,Blind,Drill/);assert.match(mv,/T01C0\.100/);
// IPC-tagged tools in the through file.
const pth=get("-Plated.TXT");
assert.match(pth,/TA\.AperFunction,ViaDrill,IIIb/);
assert.match(pth,/TA\.AperFunction,ViaDrill,VII/);
assert.equal((pth.match(/^T\d\dC0\.300$/gm)||[]).length,3,"plain, IIIb and VII 0.3 mm vias use separate tools");
assert.ok(!/AperFunction/.test(F.build(A.project("Plain",[]),A.project("Plain",[]).documents[1],{date}).files.map(f=>f.content).join("")),"boards without stacks are unchanged");
// Rules: per-layer annular ring uses the smallest land.
const rules=R.create();rules.list.find(r=>r.type==="annularRing").min=.1;
const drc=R.drc(board,new Map(),rules,{types:["annularRing"]});
assert.deepEqual(drc.violations.map(v=>[v.id,+v.actual.toFixed(3)]).sort(),[["tmb",.075],["uv",.075]]);
console.log("PASS via stack integration: mask by tent/IPC type, per-layer copper, back-drill and microvia drill files, IPC drill tools, per-layer annular ring");
