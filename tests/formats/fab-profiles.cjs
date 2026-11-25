"use strict";
// Fab capability profiles (AtriumFabProfiles): built-in data, rule sets from a
// profile, the board comparison and .waffle-fab import/export.
const assert=require("node:assert/strict");
const mem=new Map();globalThis.localStorage={getItem:k=>mem.has(k)?mem.get(k):null,setItem:(k,v)=>mem.set(k,String(v)),removeItem:k=>mem.delete(k)};
for(const m of ["model","stackup","rules","viastack","fab-presets","fab-presets/jlcpcb","fab-profiles"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const F=AtriumFabProfiles,R=AtriumRules,V=AtriumViaStack;
const board=(items,extra={})=>({kind:"pcb",name:"T",id:"b",grid:1,items,notes:[],outline:[[0,0],[60,0],[60,40],[0,40]],...extra});
const track=(id,net,points,width=.2,layer="Top")=>({kind:"track",id,net,points,width,layer});
const via=(id,net,x,y,diameter=.6,drill=.3,extra={})=>({kind:"via",id,net,x,y,diameter,drill,layer:"Multi",...extra});

// ---- built-in list --------------------------------------------------------------
const ids=F.BUILTIN.map(p=>p.id);
assert.deepEqual(ids,["jlcpcb-2l","jlcpcb-4l","jlcpcb-6l","pcbway-standard","pcbway-advanced","oshpark-2l","oshpark-4l","eurocircuits-6","eurocircuits-8","ipc-class2","ipc-class3"]);
for(const p of F.BUILTIN){
  assert.equal(p.approximate,true,p.id+" is marked approximate");
  for(const k of ["track","space","viaDrill","viaDiameter","annularRing","minHole","holeToHole","maxAspect","maskWeb","silkWidth","silkHeight","edgeClearance"])assert.ok(p[k]>0,p.id+" "+k);
  assert.ok(p.maskExpansion>=0,p.id+" maskExpansion (JLCPCB opens the mask 1:1)");
  assert.ok(p.viaDiameter>=p.viaDrill+2*p.annularRing-1e-6||p.viaDiameter>p.viaDrill,p.id+" via diameter leaves a ring");
  for(const k of ["blind","buried","microvia","viaInPad"])assert.equal(typeof p[k],"boolean");
  assert.ok(p.thickness.length&&p.copper.length&&p.layers.length===2);
  assert.deepEqual(F.cleanProfile(p).track,p.track,"built-ins pass the user-profile validator");
}
assert.match(F.APPROX,/approximate/i);

// ---- applying a profile -----------------------------------------------------------
const items=[track("thin","A",[[5,5],[20,5]],.08),track("ok","B",[[5,10],[20,10]],.2),via("v1","A",30,20,.6,.3),via("v2","B",40,20,.6,.3)];
const b=board(items),proj={name:"P",library:[],documents:[b]};   // installing writes the project rule book
let res=F.applyProfile(b,"jlcpcb-2l",{mode:"replace",project:proj});
R.validate(res.rules);
const named=t=>res.rules.list.filter(r=>r.type===t);
// The JLCPCB profiles are the sourced fab presets (app/fab-presets/jlcpcb.json): the same rules as Design › Fab Preset….
for(const [type,label] of [["clearance","Clearance"],["width","Width"],["viaStyle","Routing Vias"],["holeSize","Hole Size"],["holeToHole","Hole To Hole"],["boardOutlineClearance","Board Outline Clearance"],["solderMask","Solder Mask Expansion"],["silkToMask","Silk To Mask"]]){
  assert.deepEqual(named(type).map(r=>r.name),["JLCPCB – "+label],type+" is replaced by the preset rule");
  assert.match(named(type)[0].comment,/From fab preset JLCPCB 2-layer \(cheapest\) \(2026\.11\.19\)/);
}
assert.deepEqual(named("annularRing").map(r=>[r.name,r.min]),[["JLCPCB – Annular Ring (PTH)",.18],["JLCPCB – Annular Ring (vias)",.05]],"the PTH ring rule stays ahead of the via ring");
assert.equal(named("width")[0].min,.1);assert.equal(named("width")[0].preferred,.25);assert.equal(named("clearance")[0].gap,.1);
assert.deepEqual([named("viaStyle")[0].holeMin,named("viaStyle")[0].diameterMin,named("viaStyle")[0].holePreferred,named("viaStyle")[0].diameterPreferred],[.15,.25,.3,.6]);
assert.deepEqual([named("holeSize")[0].min,named("holeToHole")[0].gap,named("solderMask")[0].expansion],[.15,.2,0]);
assert.ok(res.rules.list.some(r=>r.type==="routingTopology"),"other rule types are kept");
assert.deepEqual(res.templates.map(t=>t.name),["JLC 2L 0.6/0.3 Through","JLC 2L 0.6/0.3 Tented"],"the standard via is the preset's preferred routing via");
assert.ok(res.notes.some(n=>/approximate/i.test(n)));
// DRC with the installed profile flags the deliberately thin track.
F.install(b,res,proj);
let out=R.drc(b,new Map(),R.stored(b,proj));
assert.deepEqual(out.violations.filter(v=>v.type==="width").map(v=>[v.id,v.actual,v.required]),[["thin",.08,.1]]);
assert.equal(b.fabProfile.id,"jlcpcb-2l");assert.equal(b.fabProfile.maxAspect,8);
assert.equal(V.library(b).list.length,2);assert.equal(V.library(b).defaults.via,"fab-jlcpcb-2l-std");
assert.equal(V.place(b,{id:"n",x:1,y:1,net:"A"}).diameter,.6,"the via tool now uses the profile template");
// Re-applying does not duplicate rules or templates.
F.install(b,F.applyProfile(b,"jlcpcb-2l",{mode:"merge",project:proj}),proj);
assert.equal(R.stored(b,proj).list.filter(r=>r.type==="width").length,1);assert.equal(V.library(b).list.length,2);

// Merge keeps scoped rules ahead of the profile; replace drops them.
const scoped=R.create();
scoped.list.push({id:"pw",type:"width",name:"Power width",comment:"",enabled:true,priority:1,scope:{kind:"net",value:"VCC"},min:.5,preferred:null,max:null});
const sb=board([track("p","VCC",[[5,5],[9,5]],.3),track("s","SIG",[[5,9],[9,9]],.1)],{rules:R.normalize(scoped)});
res=F.applyProfile(sb,"oshpark-2l",{mode:"merge"});
assert.deepEqual(res.rules.list.filter(r=>r.type==="width").map(r=>[r.name,r.priority]),[["Power width",1],["OSHPark 2L – Width",2]]);
assert.ok(res.removed.includes("Width"),"the board-wide stock rule is replaced");
out=R.drc({...sb,rules:res.rules},new Map(),res.rules,{types:["width"]});
assert.deepEqual(out.violations.map(v=>[v.id,v.required]).sort(),[["p",.5],["s",.1524]]);
res=F.applyProfile(sb,"oshpark-2l",{mode:"replace"});
assert.deepEqual(res.rules.list.filter(r=>r.type==="width").map(r=>r.name),["OSHPark 2L – Width"]);
res=F.applyProfile(sb,"oshpark-2l",{mode:"merge",priority:"highest"});
assert.equal(res.rules.list.filter(r=>r.type==="width")[0].name,"OSHPark 2L – Width");
// Advanced profile: microvia hole limits and templates.
res=F.applyProfile(board([]),"pcbway-advanced");
assert.equal(res.rules.list.find(r=>r.type==="viaStyle").holeMin,.1);
assert.ok(res.templates.some(t=>t.microvia&&t.fromLayer==="Top"&&t.toLayer==="Inner 1"));
assert.ok(res.templates.some(t=>t.ipc4761==="VII"&&t.viaInPad));
// Every built-in profile yields a valid rule set.
for(const p of F.BUILTIN)R.validate(F.applyProfile(board([]),p.id).rules);

// ---- comparing a board -------------------------------------------------------------
const cb=board([track("thin","A",[[5,5],[20,5]],.08),track("edge","B",[[0.1,20],[10,20]],.2),
  via("small","A",30,20,.2,.1),via("vip","B",40,20,.6,.3,{viaInPad:true}),via("bl","C",45,20,.4,.15,{fromLayer:"Top",toLayer:"Inner 1"})],{stackup:{version:1,layers:AtriumStackup.preset("4").layers}});
let cmp=F.compare(cb,"jlcpcb-2l");
assert.equal(cmp.rows.find(r=>r.key==="track").status,"ok","stock rules 0.15 ≥ 0.1");
assert.equal(cmp.rows.find(r=>r.key==="space").current,.2);
assert.ok(cmp.byType.width>=1,"the thin track would fail");
assert.ok(cmp.byType.viaStyle>=1,"0.1 mm via holes are below 0.15");
assert.ok(cmp.capability.some(c=>/4 copper layers/.test(c.text)));
assert.ok(cmp.capability.some(c=>/via-in-pad/.test(c.text)));
assert.ok(cmp.capability.some(c=>/microvia|blind/.test(c.text)),JSON.stringify(cmp.capability));
assert.deepEqual(cmp.edge.map(e=>e.id),["edge"]);
assert.ok(cmp.total>=3);
cmp=F.compare(cb,"pcbway-advanced");
assert.ok(!cmp.capability.some(c=>/does not offer/.test(c.text)),JSON.stringify(cmp.capability));
// A board looser than the profile is reported as such.
const loose=R.create();loose.list.find(r=>r.type==="width").min=.05;
cmp=F.compare(board([],{rules:R.normalize(loose)}),"ipc-class3");
assert.equal(cmp.rows.find(r=>r.key==="track").status,"looser");

// ---- user profiles: save, export, import ------------------------------------------
const saved=F.saveUser(F.fromBoard(b,"Shop A",{project:proj}));
assert.equal(saved.track,.1);assert.equal(saved.space,.1);assert.equal(saved.viaDrill,.15);assert.equal(saved.maxAspect,8);
assert.ok(F.list().some(p=>p.id===saved.id&&!p.builtin));
const text=F.exportText([saved]);
assert.equal(JSON.parse(text).format,"atrium-fab");
mem.clear();assert.equal(F.userProfiles().length,0);
const got=F.importText(text);assert.equal(got.length,1);F.saveUser(got[0]);
assert.deepEqual(F.get(saved.id).track,.1);
assert.equal(F.applyProfile(board([]),saved.id).rules.list.find(r=>r.type==="width").name,"Shop A – Width");
assert.throws(()=>F.importText("{\"format\":\"other\"}"),/atrium-fab/);
assert.throws(()=>F.importText(JSON.stringify({format:"atrium-fab",version:1,profiles:[{name:"x",track:-1}]})),/track/);
assert.equal(F.importText(JSON.stringify({format:"atrium-fab",version:1,profiles:[{...F.BUILTIN[0]}]}))[0].id,"user-jlcpcb-2l","imports cannot shadow built-ins");
assert.equal(F.removeUser(saved.id),true);

// ---- PTH annular ring (JLC: 0.18 mm on 2-layer, review L5) ---------------------------
{
  assert.equal(F.get("jlcpcb-2l").pthRing,.18);assert.equal(F.get("jlcpcb-4-6l").pthRing,.15);
  assert.equal(F.get("jlcpcb-4-6l").backdrill,false,"back-drilling is a special JLCPCB option, not in the preset");
  const def={id:"tht",name:"THT",footprint:{pads:[{number:"1",x:0,y:0,w:1.2,h:1.2,drill:.9,shape:"round"},{number:"2",x:2.54,y:0,w:1.6,h:1.6,drill:.9,shape:"round"}]}};
  const pb=board([{kind:"part",id:"J1",ref:"J1",def:"tht",x:20,y:20}]);
  const c=F.compare(pb,"jlcpcb-2l",{defs:new Map([["tht",def]])});
  assert.ok(c.capability.some(x=>/1 plated component hole has an annular ring below 0.18 mm \(smallest 0.15 mm\)/.test(x.text)),JSON.stringify(c.capability));
  assert.ok(!F.compare(pb,"pcbway-standard",{defs:new Map([["tht",def]])}).capability.some(x=>/plated component/.test(x.text)),"profiles without pthRing skip the check");
}

// ---- speed ------------------------------------------------------------------------
const big=[];for(let i=0;i<5000;i++)big.push(track("t"+i,"N"+(i%50),[[1+(i%100)*.5,1+Math.floor(i/100)*.7],[1.3+(i%100)*.5,1+Math.floor(i/100)*.7]],.15));
let t0=Date.now();cmp=F.compare(board(big),"jlcpcb-4-6l");const ms=Date.now()-t0;
assert.ok(ms<3000,"compare on 5k tracks took "+ms+" ms");
console.log("PASS fab profiles: built-ins, apply (replace/merge), DRC on a too-thin track, compare, edge clearance, user profile round trip ("+ms+" ms compare on 5k tracks)");
