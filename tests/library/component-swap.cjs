"use strict";
const assert=require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/library/component-swap.js");
const A=Atrium,S=AtriumSwap;
const fresh=()=>AtriumParts.example();
const defsOf=p=>new Map(p.library.map(d=>[d.id,d]));
const near=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-6,(m||"")+" "+a+" vs "+b);
const nearP=(a,b,m)=>{near(a[0],b[0],m);near(a[1],b[1],m);};
const byRef=(d,r)=>d.items.find(i=>i.ref===r);
const padAt=(d,defs,ref,n)=>A.pins(byRef(d,ref),defs.get(byRef(d,ref).def),d.kind).find(p=>p.number===String(n)).at;
const clone=x=>JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- swap two capacitors on the board
{
  const p=fresh(),[sch,pcb]=p.documents,defs=defsOf(p);
  const c1=clone(byRef(pcb,"C1")),c2=clone(byRef(pcb,"C2")),tracks=clone(pcb.items.filter(i=>i.kind==="track"));
  const pads={c1:[padAt(pcb,defs,"C1",1),padAt(pcb,defs,"C1",2)],c2:[padAt(pcb,defs,"C2",1),padAt(pcb,defs,"C2",2)]};
  const plan=S.planSwap(pcb,defs,[c1.id,c2.id]);
  assert.equal(plan.ok,true);assert.equal(plan.anchor,"centroid");assert.match(plan.message,/C1 ↔ C2/);
  assert.equal(JSON.parse(JSON.stringify(plan)).ops.length,2,"plans are plain JSON");
  S.apply(p,plan);
  nearP([byRef(pcb,"C1").x,byRef(pcb,"C1").y],[c2.x,c2.y],"C1 takes C2's place");nearP([byRef(pcb,"C2").x,byRef(pcb,"C2").y],[c1.x,c1.y]);
  assert.equal(byRef(pcb,"C1").angle,c2.angle);
  nearP(padAt(pcb,defs,"C1",1),pads.c2[0]);nearP(padAt(pcb,defs,"C2",2),pads.c1[1]);
  assert.deepEqual(byRef(pcb,"C1").pinNets,c1.pinNets,"nets stay with the component");assert.deepEqual(byRef(pcb,"C2").pinNets,c2.pinNets);
  assert.deepEqual(pcb.items.filter(i=>i.kind==="track"),tracks,"tracks are left as they are");
  assert.deepEqual(byRef(sch,"C1").x,94*1.27,"the schematic is untouched");
  A.validate(p);
}
// ---------------------------------------------------------------- centroid versus origin, side and text
{
  const p=fresh(),[,pcb]=p.documents;
  p.library.push({id:"off",name:"Offset part",prefix:"Q",footprint:{name:"OFF",shapes:[],pads:[{number:"1",x:2,y:0,w:1,h:1,drill:0,shape:"rect",angle:0},{number:"2",x:4,y:0,w:1,h:1,drill:0,shape:"rect",angle:0}]}});
  pcb.items.push({id:"q",kind:"part",def:"off",ref:"Q1",value:"Q",link:"lq",x:30,y:15,angle:90,layer:"Bottom",pinNets:{"1":"A","2":"B"},refAt:[1,2]});
  const defs=defsOf(p),r1=clone(byRef(pcb,"R1"));
  const centre=(item)=>{const b=A.bounds(A.itemPoints(item,defs.get(item.def),"pcb"));return [(b[0]+b[2])/2,(b[1]+b[3])/2];};
  const c={r:centre(byRef(pcb,"R1")),q:centre(byRef(pcb,"Q1"))};
  let q=S.apply(clone(p),S.planSwap(pcb,defs,["b-R1","q"])).documents[1];
  nearP(centre(byRef(q,"Q1")),c.r,"bodies land on each other (centroid)");nearP(centre(byRef(q,"R1")),c.q);
  assert.equal(byRef(q,"R1").layer,"Bottom");assert.equal(byRef(q,"Q1").layer,undefined,"sides are exchanged");
  assert.equal(byRef(q,"R1").angle,90);assert.deepEqual(byRef(q,"Q1").refAt,[1,2],"designator offsets stay by default");
  q=S.apply(clone(p),S.planSwap(pcb,defs,["b-R1","q"],{anchor:"origin",text:true,side:false})).documents[1];
  nearP([byRef(q,"Q1").x,byRef(q,"Q1").y],[r1.x,r1.y],"origin anchor");assert.equal(byRef(q,"R1").layer,undefined);
  assert.deepEqual(byRef(q,"R1").refAt,[1,2]);assert.equal(byRef(q,"Q1").refAt,undefined,"text offsets carried");
}
// ---------------------------------------------------------------- cycle swap
{
  const p=fresh(),[,pcb]=p.documents,defs=defsOf(p),before=Object.fromEntries(["C1","R1","R2"].map(r=>[r,clone(byRef(pcb,r))]));
  const plan=S.planSwap(pcb,defs,["b-R2","b-R1","b-C1"]);
  assert.match(plan.message,/C1 → R1 → R2 → C1/);S.apply(p,plan);
  for(const [a,b] of [["C1","R1"],["R1","R2"],["R2","C1"]]){nearP([byRef(pcb,a).x,byRef(pcb,a).y],[before[b].x,before[b].y],a+" takes "+b);assert.equal(byRef(pcb,a).angle,before[b].angle);}
  assert.equal(S.planSwap(pcb,defs,["b-R1","b-R2","b-U1"]).ok,false,"cycle swap needs one footprint");
  assert.equal(S.planSwap(pcb,defs,["b-R1"]).ok,false);
}
// ---------------------------------------------------------------- schematic: wires follow when nets survive, else stay
{
  const u=1.27;
  function fixture(d1,d2){
    const p=A.project("t",AtriumParts.catalogue),sch=p.documents[0];
    for(const [ref,x,y] of [["R1",0,0],["R2",0,20]])sch.items.push({id:"s-"+ref,kind:"part",def:"std-r",ref,value:"R",link:"l"+ref,x,y,angle:0,pinNets:{}});
    const lead=(from,d,name)=>{const to=[from[0]+d[0],from[1]+d[1]];sch.items.push({id:"w"+name,kind:"wire",points:[from,to]},{id:"n"+name,kind:"netlabel",text:name,x:to[0],y:to[1]});};
    lead([-4*u,0],d1[0],"A");lead([4*u,0],d1[1],"B");lead([-4*u,20],d2[0],"C");lead([4*u,20],d2[1],"D");
    return p;
  }
  const netsOf=(p,refs)=>{const d=p.documents[0],c=A.connectivity(d,defsOf(p)).byPin;return refs.map(r=>["1","2"].map(n=>c.get(byRef(d,r).id+"/"+n)).join("/"));};
  let p=fixture([[0,5],[0,5]],[[-5,0],[5,0]]);
  let plan=S.planSwap(p.documents[0],defsOf(p),["s-R1","s-R2"]);
  assert.equal(plan.ok,true);assert.equal(plan.netsExchanged,false);assert.ok(plan.wires.length>=4,"wire ends follow the pins");
  S.apply(p,plan);assert.deepEqual(netsOf(p,["R1","R2"]),["A/B","C/D"],"every pin keeps its net");
  assert.equal(byRef(p.documents[0],"R1").y,20);A.validate(p);
  // Wires that would cross the other part: follow refuses, auto keeps the wiring and exchanges nets.
  p=fixture([[-5,0],[5,0]],[[-5,0],[5,0]]);
  assert.equal(S.planSwap(p.documents[0],defsOf(p),["s-R1","s-R2"],{wiring:"follow"}).ok,false);
  plan=S.planSwap(p.documents[0],defsOf(p),["s-R1","s-R2"]);assert.equal(plan.netsExchanged,true);assert.equal(plan.wires.length,0);assert.match(plan.message,/ECO/);
  S.apply(p,plan);assert.deepEqual(netsOf(p,["R1","R2"]),["C/D","A/B"]);
  // The sample sheet: C1 and C2 sit across the op amp, so the wiring stays.
  p=fresh();const sch=p.documents[0],c1=clone(byRef(sch,"C1")),c2=clone(byRef(sch,"C2"));
  plan=S.planSwap(sch,defsOf(p),["s-C1","s-C2"]);assert.equal(plan.netsExchanged,true);S.apply(p,plan);
  nearP([byRef(sch,"C1").x,byRef(sch,"C1").y],[c2.x,c2.y]);nearP([byRef(sch,"C2").x,byRef(sch,"C2").y],[c1.x,c1.y]);A.validate(p);
}
// ---------------------------------------------------------------- footprint variants
{
  const p=fresh(),[sch,pcb]=p.documents,defs=defsOf(p);
  const list=S.variants(pcb,defs,"b-C1");
  assert.deepEqual(list.filter(v=>v.family).map(v=>v.code),["0201","0402","0603","0805","1206","1210","2512"]);
  assert.equal(list.find(v=>v.current).id,"std-c");assert.ok(list.some(v=>!v.family&&v.id==="std-r"),"other two-pad footprints are offered");
  assert.equal(S.nextVariant(pcb,defs,"b-C1"),"std-c@0805");assert.equal(S.nextVariant(pcb,defs,"b-C1",-1),"std-c@0402");
  const nets=clone(byRef(pcb,"C1").pinNets),at=clone(byRef(pcb,"C1"));
  const plan=S.planVariant(pcb,defs,"b-C1","std-c@0805",{project:p});
  assert.equal(plan.ok,true);assert.equal(plan.addDefs.length,1);assert.equal(plan.addDefs[0].footprint.name,"C_0805");
  assert.deepEqual(plan.ops.map(o=>o.id).sort(),["b-C1","s-C1"],"the linked schematic part follows");
  S.apply(p,plan);const d2=defsOf(p);
  assert.equal(byRef(pcb,"C1").def,"std-c@0805");assert.equal(byRef(sch,"C1").def,"std-c@0805");assert.equal(byRef(pcb,"C2").def,"std-c");
  assert.deepEqual(byRef(pcb,"C1").pinNets,nets,"pin nets keep their pad numbers");
  nearP(padAt(pcb,d2,"C1",1),A.world([-.9125,0],at),"0805 land pattern");
  A.validate(p);
  assert.equal(S.nextVariant(pcb,d2,"b-C1"),"std-c@1206");assert.equal(S.nextVariant(pcb,d2,"b-C1",-1),"std-c");
  S.apply(p,S.planVariant(pcb,d2,"b-C1","std-c",{project:p}));assert.equal(byRef(pcb,"C1").def,"std-c");assert.equal(byRef(sch,"C1").def,"std-c");
  assert.equal(p.library.filter(d=>d.id==="std-c@0805").length,1,"the created size stays in the library for reuse");
  // A library footprint of the family whose pads are listed in another order keeps the pin mapping by number.
  p.library.push({...clone(p.library.find(d=>d.id==="std-r")),id:"r0402",name:"Resistor 0402",
    footprint:{name:"R_0402",shapes:[],pads:[{number:"2",x:.485,y:0,w:.59,h:.64,drill:0,shape:"roundrect",angle:0},{number:"1",x:-.485,y:0,w:.59,h:.64,drill:0,shape:"roundrect",angle:0}]}});
  const d3=defsOf(p),fam=S.variants(pcb,d3,"b-R1").filter(v=>v.family);
  assert.equal(fam.find(v=>v.code==="0402").id,"r0402","library footprints win over created sizes");
  const rNets=clone(byRef(pcb,"R1").pinNets);S.apply(p,S.planVariant(pcb,d3,"b-R1","r0402"));
  assert.deepEqual(byRef(pcb,"R1").pinNets,rNets);nearP(padAt(pcb,d3,"R1",1),A.world([-.485,0],byRef(pcb,"R1")));
  assert.equal(S.planVariant(pcb,d3,"b-U1","std-c").ok,false,"pad counts must match");
}
// ---------------------------------------------------------------- library replacement keeps position and nets
{
  const p=fresh(),[sch,pcb]=p.documents;
  p.library.push({id:"diode",name:"Diode",prefix:"D",value:"1N4148",symbol:clone(p.library[0].symbol),
    footprint:{name:"D_0603",shapes:[],pads:[{number:"A",x:-.8,y:0,w:.9,h:.95,drill:0,shape:"rect",angle:0},{number:"K",x:.8,y:0,w:.9,h:.95,drill:0,shape:"rect",angle:0}]}});
  const defs=defsOf(p),r1=clone(byRef(pcb,"R1"));
  assert.ok(S.libraryCandidates(pcb,defs,"b-R1").some(c=>c.id==="diode"));assert.ok(!S.libraryCandidates(pcb,defs,"b-R1").some(c=>c.id==="std-opamp"));
  S.apply(p,S.planLibrary(pcb,defs,"b-R1","diode",{project:p}));
  const r=byRef(pcb,"R1");assert.equal(r.def,"diode");assert.equal(r.x,r1.x);assert.equal(r.value,"1N4148");
  assert.deepEqual(r.pinNets,{A:r1.pinNets["1"],K:r1.pinNets["2"]},"nets follow pad order when numbers differ");
  assert.equal(byRef(sch,"R1").def,"diode","the linked schematic part is replaced too");
  const before=A.connectivity(fresh().documents[0],defsOf(fresh())).byPin.get("s-R1/1");
  assert.equal(A.connectivity(sch,defs).byPin.get("s-R1/1"),before);
  A.validate(p);
}
console.log("PASS component swap: positions, rotation and side exchanged, centroid/origin anchors, cycle swap, nets preserved on boards, schematic wiring follows or stays, footprint variants with pin mapping, library replacement.");
