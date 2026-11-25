"use strict";
const assert = require("node:assert/strict");
for(const mod of ["model","parts","stackup","viastack","query","rules","connectivity","router","diffpair","length-tuning","multi-route","bus-route","autorouter"]) require(require("../support/app-source-paths.cjs").appFile(mod+".js"));
const A=Atrium, R=AtriumRouter, Q=AtriumRules, batch=AtriumAutorouter, defs=new Map();
const d=A.sheet("pcb","Opposite copper layers"), rules=Q.create();
const annulus=rules.list.find(r=>r.type==="annularRing");
Object.assign(annulus,{min:.1,scope:AtriumDesignQueryRecord.create('via')});
const style=rules.list.find(r=>r.type==="viaStyle");
Object.assign(style,{diameterMin:.35,diameterPreferred:.45,diameterMax:.55,holeMin:.22,holePreferred:.30,holeMax:.35});
d.rules=rules;
d.outline=[[0,0],[22,0],[22,12],[0,12]];
const pad=(id,x,y,layer,net)=>({id,kind:"pad",number:"1",net,layer,x,y,w:.5,h:.5,shape:"rect"});
d.items=[pad("src",3,3,"Top","SIG"),pad("dst",19,3,"Bottom","SIG")];
const check=p=>Q.drc({...d,items:[...d.items,...p.add]},defs,Q.stored(d),{types:["viaStyle","holeSize","annularRing"]}).violations;
function verify(p) {
  const vias=p.add.filter(i=>i.kind==="via");
  assert.ok(vias.length);
  assert.deepEqual(check(p),[]);
  for(const v of vias){assert.ok(v.diameter<=style.diameterMax+1e-8);assert.ok(v.drill>=style.holeMin-1e-8);assert.ok((v.diameter-v.drill)/2>=annulus.min-1e-8);}
}
function plan(doc){return batch.routeBoard(doc,defs,{layers:["Top","Bottom"],router:{grid:.3,iterations:3},vias:true});}
const legacyStyle=batch.netStyle({query(type) {
  return type==="viaStyle" ? {diameterPreferred:.45,holePreferred:.3,diameterMax:.55} : type==="annularRing" ? {min:.1} : null;
}},["Top","Bottom"],{viaDiameter:0})("SIG");
assert.equal(legacyStyle.vd,.5);assert.equal(legacyStyle.vh,.3);
{
  const planes=["Top","Bottom"];
  const provider={query(type) {
    return ({
      viaStyle:{diameterMin:.42,diameterMax:.7,holeMin:.2,holeMax:.36},
      holeSize:{min:.25,max:.32},annularRing:{min:.1}
    })[type]||null;
  }};
  const expectStock=style=>assert.deepEqual([style.vd,style.vh,style.vias],[.6,.3,true]);
  expectStock(batch.netStyle(provider,planes)("SIG")); // legal minima alone are not preferences
  const compiled={...provider,available:false,viaLimits:()=>({diameter:.51,drill:.27,ring:.1})};
  const explicit=batch.netStyle(compiled,planes)("SIG");
  assert.deepEqual([explicit.vd,explicit.vh],[.51,.27]);
  const impossible={query:type=>type==="annularRing"?{min:.3}:provider.query(type)};
  assert.equal(batch.netStyle(impossible,planes)("SIG").vias,false);
  const previous=globalThis.AtriumRules;
  try {
    globalThis.AtriumRules={query:(_,type)=>provider.query(type)};
    expectStock(batch.netStyle(batch.rulesFor(d),planes)("SIG"));
    delete globalThis.AtriumRules;
    expectStock(batch.netStyle(provider,planes)("SIG"));
    assert.equal(batch.netStyle(batch.rulesFor(d),planes,{viaDrill:.5})("SIG").vd,.6);
  } finally { globalThis.AtriumRules=previous; }
}
const legacy={id:"old",kind:"via",net:"SIG",layer:"Multi",x:8,y:3,diameter:.45,drill:.30};
assert.ok(Math.abs(check({add:[legacy]})[0].actual-.075)<1e-8);
const fresh=plan(d);
assert.equal(fresh.report.routed,1);verify(fresh);
const manual=AtriumViaStack.place(d,{id:"manual",x:10,y:8,net:"SIG"},{obeyRules:true,defs});
verify({add:[manual]});
const prep=batch.prepare(d,defs,{layers:["Top","Bottom"]}), stale=batch.core.runSync(prep.job);
assert.ok(stale.vias.length);
stale.vias[0].d=.45;
const guarded=batch.plan(prep,stale,{remove:["keep"],original:{...d,items:[...d.items,{...legacy,id:"keep"}]}});
assert.equal(guarded.report.routed,0);assert.equal(guarded.report.failures.length,1);
assert.deepEqual(guarded.add,[]);assert.deepEqual(guarded.remove,[]);
const single=R.begin(d,defs,{net:"SIG",start:[3,3],layer:"Top"});
single.move([9,3]); assert.equal(single.switchLayer("Bottom").ok,true);
single.move([19,3]);single.click();verify(single.commit());
Object.assign(style,{diameterPreferred:.45,diameterMax:.45}); // hold the land and reduce the drill, within its range
const reduced=plan(d);verify(reduced);
assert.ok(reduced.add.filter(i=>i.kind==="via").every(v=>Math.abs(v.drill-.25)<1e-7));
Object.assign(style,{diameterMax:.45,holeMin:.30});
const impossible=plan(d);
assert.equal(impossible.report.routed,0);
assert.equal(impossible.add.length,0);
const board={...d,rules:JSON.parse(JSON.stringify(rules))};
const sig=JSON.stringify(board.items);
assert.throws(()=>AtriumViaStack.place(board,{id:"refused",x:10,y:8,net:"SIG"},{obeyRules:true,defs}),/via/i);
const sessions=[
 R.begin(board,defs,{net:"SIG",layer:"Top",start:[3,3]}),
 AtriumDiffPair.begin(board,defs,{pair:{name:"CLK",positive:"CLK_P",negative:"CLK_N"},startP:[3,6],startN:[3,6.6],layer:"Top"}),
 AtriumBusRoute.begin(board,defs,{members:[{net:"A",at:[3,8]},{net:"B",at:[3,8.6]}],layer:"Top"})
];
for(const session of sessions) {
 session.move([12,6]);
 const before=session.state.anchors;
 assert.equal(session.switchLayer("Bottom").ok,false);
 assert.equal(session.state.anchors,before);
 session.cancel();
}
assert.equal(JSON.stringify(board.items),sig);
console.log("PASS legal land/drill tradeoff and impossible annulus across board routing, single track, pair and bus; explicit DRC on proposed copper");
