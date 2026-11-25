"use strict";
// 3D component clearance (collision-3d.js, rule componentClearance): horizontal and vertical
// clearance between generated bodies and STEP model boxes, opposite sides, the rigid-flex fold
// (parallel pieces exact, other pieces by GJK on convex hulls, bodies against the folded
// board), rule scopes through DRC, and the broad + narrow phase on the 25.6k-object board.
const assert=require("node:assert/strict");
for(const m of ["model","parts","pcb-appearance","pcb-pours","altium-rules","pcb-draw","component-classes","query","rules","stackup","board-shape","rigid-flex","zip","fab-outputs","step-export","flex-fold","step-import","collision-3d"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
require("../pcb/dense-board.js");
const A=Atrium,S=AtriumSTEP,C=AtriumCollision3D,ST=AtriumStackup,RF=AtriumRigidFlex,R=AtriumRules;
const log=(...a)=>(globalThis.console?.log||globalThis.print||(()=>{}))(...a);
const near=(a,b,e,m)=>assert.ok(Math.abs(a-b)<=e,(m?m+": ":"")+a+" vs "+b);
const now=()=>globalThis.performance?.now?performance.now():Date.now();
const box=(id,w,h,height)=>({id,name:id,prefix:"U",footprint:{name:id,pads:[{number:"1",x:-w/2+.3,y:0,w:.5,h:.5},{number:"2",x:w/2-.3,y:0,w:.5,h:.5}],shapes:[{kind:"path",layer:"Mechanical 13",closed:true,points:[[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]]}],height}});
function flat(items,lib=[box("b4",4,2,1),box("tall",4,2,3)]){
  const doc=A.sheet("pcb","Board");doc.outline=[[0,0],[60,0],[60,40],[0,40]];
  doc.items.push(...items.map((i,k)=>({id:"p"+k,kind:"part",ref:"U"+(k+1),angle:0,...i})));
  return {doc,defs:new Map(lib.map(d=>[d.id,d])),project:{name:"B",documents:[doc],library:lib}};
}
const kinds=r=>r.findings.map(f=>f.kind+":"+f.a.ref+"-"+(f.b?.ref||"board")).sort();

// Horizontal: 0.1 mm apart is too close for 0.25; 0.3 mm is fine; overlapping collides.
{
  let {doc,defs}=flat([{def:"b4",x:10,y:10},{def:"b4",x:14.1,y:10}]);
  let r=C.check(doc,defs,{gap:.25,vertical:.25});assert.deepEqual(kinds(r),["horizontal:U1-U2"]);near(r.findings[0].actual,.1,1e-6);
  ({doc,defs}=flat([{def:"b4",x:10,y:10},{def:"b4",x:14.3,y:10}]));assert.equal(C.check(doc,defs,{gap:.25,vertical:.25}).findings.length,0);
  ({doc,defs}=flat([{def:"b4",x:10,y:10},{def:"b4",x:12,y:10.5,angle:30}]));r=C.check(doc,defs,{gap:.25,vertical:.25});assert.deepEqual(kinds(r),["collision:U1-U2"]);
  // Bounding boxes: a round body's box reaches further than the body.
  const disc={id:"disc",name:"disc",prefix:"U",footprint:{name:"disc",pads:[{number:"1",x:0,y:0,w:.5,h:.5}],shapes:[{kind:"circle",layer:"Mechanical 13",x:0,y:0,r:2}],height:1}};
  ({doc,defs}=flat([{def:"disc",x:10,y:10},{def:"b4",x:14.1,y:12.1}],[box("b4",4,2,1),disc]));
  assert.equal(C.check(doc,defs,{gap:.25,vertical:.25}).findings.length,0,"round body clear");assert.equal(C.check(doc,defs,{gap:.25,vertical:.25,mode:"boxes"}).findings.length,1,"its box is not");
}
// The default 1.51 mm dielectric and 35 µm foil on each side set the
// opposite seating faces. The two 10.16 µm mask faces are outside this gap.
{
  const {doc,defs}=flat([{def:"b4",x:10,y:10},{def:"b4",x:10,y:10,layer:"Bottom"}]);
  assert.equal(C.check(doc,defs,{gap:.25,vertical:.25}).findings.length,0,"opposite sides clear");
  const r=C.check(doc,defs,{gap:.25,vertical:2});
  assert.deepEqual(kinds(r),["vertical:U1-U2"]);
  near(r.findings[0].actual,1.58,1e-6,"opposite copper seating planes");
}
// Authored standoff stays relative to the exposed foil; asymmetric foil and
// thick mask make both the former resin anchor and nominal thickness detectable.
{
  const authored=box("authored",4,2,1), mechanical=box("mechanical",4,2,1);
  authored.footprint.bodies3d=[{type:"extruded",side:"Top",ownerSide:"Top",minZ:.1,maxZ:1.1,
    sourceRecord:"authored extrusion",rings:[[[-2,-1],[2,-1],[2,1],[-2,1]]]}];
  mechanical.footprint.pads=[{number:"P",x:0,y:0,w:0,h:0,drill:.5,plated:false}];
  const {doc,defs,project}=flat([{def:"authored",x:10,y:10},
    {def:"authored",x:10,y:10,layer:"Bottom"},{def:"mechanical",x:25,y:10,layer:"Bottom"}],[authored,mechanical]);
  doc.stackup=ST.build(["Signal","Signal"]);
  doc.stackup.layers.find(l=>l.type==="Dielectric").thickness=1.8;
  doc.stackup.layers.find(l=>l.key==="Top").thickness=.07;
  doc.stackup.layers.find(l=>l.key==="Bottom").thickness=.015;
  doc.stackup.layers.find(l=>l.type==="Solder Mask").thickness=.03;
  const scene=opts=>S.model(project,doc,{holes:false,...opts});
  const before=scene(), after=scene({copper:true,maskOpenings:true,fab:{maskExpansion:.2,pasteExpansion:.1,overrideExpansions:true}});
  const seats=m=>m.parts.map(part=>+part.placement.origin[2].toFixed(6));
  assert.deepEqual(seats(before),[1.87,-.015,0],"NPTH-only geometry retains its bare resin seat");
  assert.deepEqual(seats(after),seats(before),"plotting extra film introduces no mounting offset");
  const nearSide=before.parts.map(p=>+(p.placement.origin[2]+(p.side==="Top"?p.body.z0:p.body.z1)).toFixed(6));
  assert.deepEqual(nearSide,[1.97,-.115,0],"authored standoffs apply on both sides");
  const r=C.check(doc,defs,{gap:.25,vertical:3},{project});
  near(r.findings.find(f=>f.a.ref==="U1"&&f.b?.ref==="U2").actual,2.085,1e-6,"collision measures the same authored outside faces");
}
// A board whose source requires actual body shapes can check two authored
// extrusions. An unresolved STEP envelope or a generated box is not solid proof.
{
  const {doc,defs}=flat([0,1,2,3].map(i=>({def:"b4",x:10+.1*i,y:10})));
  const original=globalThis.AtriumSTEP;
  try{
    globalThis.AtriumSTEP={...original,model(...args){
      const scene=original.model(...args);scene.parts.forEach((p,i)=>p.source=["extruded","extruded","envelope","generated"][i]);return scene;
    }};
    const run=skip=>C.check(doc,defs,{mode:"authored",skipMissingBody:skip,gap:.254,vertical:.254,board:false});
    const checked=run(true);assert.equal(checked.findings.length,1);assert.equal(checked.stats.unassessedComponents,1);
    assert.equal(run(false).stats.unassessedComponents,2);
    assert.ok(C.check(doc,defs,{gap:.254,vertical:.254}).findings.length>1,"native envelope check remains available");
  }finally{globalThis.AtriumSTEP=original;}
}
// An embedded STEP model is its bounding box (here a 6 x 6 x 2 model offset 1 mm up).
{
  const md=flat([{def:"b4",x:0,y:0}],[box("b4",6,6,2)]);md.doc.outline=[[-10,-10],[10,-10],[10,10],[-10,10]];
  const stepText=S.export(md.project,md.doc,{deterministic:true,generated:true});
  const m={id:"mdl",name:"MDL",prefix:"U",footprint:{name:"MDL",pads:[{number:"1",x:0,y:0,w:1,h:1}],model3d:{stepText,offset:[0,0,1],rotation:[0,0,0]}}};
  const {doc,defs}=flat([{def:"mdl",x:20,y:20},{def:"tall",x:20,y:20,layer:"Bottom"},{def:"b4",x:20,y:31}],[box("b4",4,2,1),box("tall",4,2,3),m]);
  const B=C.bodies(doc,defs,{});const mb=B.list.find(b=>b.source==="model");assert.ok(mb,"model body");
  assert.ok(mb.z1-mb.z0>2.5,"the model box spans the exported assembly height: "+(mb.z1-mb.z0));
  const r=C.check(doc,defs,{gap:.25,vertical:.25});log("model box",kinds(r).join(" "));
  assert.ok(r.findings.some(f=>f.a.source==="model"||f.b?.source==="model"),"the model box reaches the neighbour");
}
// Rigid-flex: two parts clear when flat collide when folded 180° (S.parts face each other).
function flexBoard(angle,hA,hB,xA=12,xB=88){
  const lib=[box("ha",8,6,hA),box("hb",8,6,hB)];
  const doc=A.sheet("pcb","Flex");doc.outline=[[0,0],[100,0],[100,30],[0,30]];
  const st=ST.preset(4);delete st.derived;const cu=st.layers.filter(ST.isCopper);
  st.substacks=[{id:"flex",name:"Flex",flex:true,layers:ST.flexLayers(["Top","Bottom"],cu)}];doc.stackup=JSON.parse(JSON.stringify(st));
  ST.splitRegion(doc,{a:[30,-1],b:[30,31]});ST.splitRegion(doc,{a:[70,-1],b:[70,31]});
  ST.assignStack(doc,RF.regions(doc).find(g=>RF.geometry.inside([50,15],g.points)).id,"flex");
  RF.addBend(doc,{a:[50,0],b:[50,30],angle,radius:2,name:"B1"});
  doc.items.push({id:"a",kind:"part",def:"ha",ref:"UA",x:xA,y:15,angle:0},{id:"b",kind:"part",def:"hb",ref:"UB",x:xB,y:15,angle:0});
  return {doc,defs:new Map(lib.map(d=>[d.id,d])),project:{name:"F",documents:[doc],library:lib}};
}
{
  // 180°: the far end comes back over the fixed end; its top faces down.
  let {doc,defs}=flexBoard(180,1,1);
  assert.equal(C.check(doc,defs,{gap:.25,vertical:.25}).findings.length,0,"flat: clear");
  let r=C.check(doc,defs,{gap:.25,vertical:.25,t:1});assert.equal(r.folded,true);log("180°, 1 mm parts:",kinds(r).join(" ")||"clear",r.stats);
  assert.equal(r.findings.length,0,"short parts clear when folded");
  ({doc,defs}=flexBoard(180,3,3));r=C.check(doc,defs,{gap:.25,vertical:.25,t:1});log("180°, 3 mm parts:",kinds(r).join(" "));
  assert.ok(r.findings.some(f=>f.kind==="collision"||f.kind==="vertical"),"tall parts collide when folded");assert.equal(r.stats.exact,1,"parallel pieces use the exact test");
  // A body taller than the fold gap hits the folded flap itself.
  ({doc,defs}=flexBoard(180,6,.5,12,60));r=C.check(doc,defs,{gap:.25,vertical:.25,t:1});log("180°, 6 mm part under the flap:",kinds(r).join(" "));
  assert.ok(r.findings.some(f=>f.kind==="board"&&f.a.ref==="UA"),"the folded board hits the tall part");
  // 90°: the far end stands up; a part near the bend on the fixed side meets the standing part (GJK).
  ({doc,defs}=flexBoard(90,2,2,40,58));
  const B=C.bodies(doc,defs,{t:1});log("90° bodies",B.list.map(b=>b.ref+" "+b.box.map(v=>v.toFixed(1)).join(",")).join(" | "));
  r=C.check(doc,defs,{gap:5,vertical:5,t:1,board:false});log("90°, 5 mm clearance:",kinds(r).join(" ")||"clear",JSON.stringify(r.stats));
  assert.ok(r.stats.hull>=1,"non-parallel pair tested with GJK");assert.deepEqual(kinds(r),["3d:UA-UB"]);
  const f=r.findings[0],[a,b]=[f.a.box,f.b.box],dx=Math.max(0,b[0]-a[3],a[0]-b[3]),dz=Math.max(0,b[2]-a[5],a[2]-b[5]);
  near(f.actual,Math.hypot(dx,dz),1e-6,"GJK distance of the boxes (axis aligned here)");
  assert.equal(C.check(doc,defs,{gap:.25,vertical:.25,t:1,board:false}).findings.length,0);
}
// GJK sanity: unit cubes 2 mm apart, touching, overlapping.
{
  const cube=(x,y,z)=>{const o=[];for(let i=0;i<8;i++)o.push(x+(i&1),y+(i>>1&1),z+(i>>2&1));return o;};
  near(C.gjk(cube(0,0,0),cube(3,0,0)),2,1e-9);near(C.gjk(cube(0,0,0),cube(2,2,0)),Math.SQRT2,1e-9);assert.equal(C.gjk(cube(0,0,0),cube(.5,.5,.5)),0);
  near(C.gjk(cube(0,0,0),[3,3,3, 4,3,3, 3,4,3]),Math.sqrt(12),1e-9,"cube to triangle");
}
// DRC: the rule type with scopes; findings in the DRC result with 3D points.
{
  const {doc,defs,project}=flat([{def:"b4",x:10,y:10},{def:"b4",x:14.1,y:10},{def:"b4",x:30,y:10},{def:"b4",x:34.1,y:10}]);
  const set=R.create();set.list=set.list.filter(r=>r.type!=="componentClearance");
  assert.ok(R.types.componentClearance,"rule type");assert.equal(R.types.componentClearance.altium,"ComponentClearance");
  set.list.push({id:"cc1",type:"componentClearance",name:"ComponentClearance",comment:"",enabled:true,priority:1,scope:AtriumDesignQueryRecord.create('part where component.designator = "U1"'),scope2:AtriumDesignQueryRecord.selector("all"),gap:.25,vertical:.25,mode:"bodies",fold:"both",board:true});
  R.validate(set);
  const out=R.drc(doc,defs,set,{types:["componentClearance"],project});
  const v=out.violations.filter(x=>x.type==="componentClearance");log("DRC",v.map(x=>x.title+" "+x.detail).join(" | "));
  assert.equal(v.length,1,"only the scoped pair (U1 ↔ U2), not U3 ↔ U4");assert.equal(v[0].id,"p0");assert.ok(v[0].at3d&&v[0].otherAt3d,"3D points for the 3D view");
  assert.ok(out.rules.some(r=>r.type==="componentClearance"&&r.count===1));
  // Default rule sets do not add the rule (it starts empty, as dfaSpacing).
  assert.equal(R.create().list.filter(r=>r.type==="componentClearance").length,0);
}
// Performance: the 25.6k-object board (2,134 parts).
{
  const {d,defs}=makeAtriumBenchmarkBoard(160);
  const t0=now(),B=C.bodies(d,defs,{}),t1=now();
  let best=Infinity,r;for(let k=0;k<3;k++){const a=now();r=C.check(d,defs,{gap:.254,vertical:.254});best=Math.min(best,r.stats.ms-r.stats.buildMs);void a;}
  log("25.6k board:",B.list.length,"bodies; bodies",Math.round(t1-t0),"ms; broad+narrow",Math.round(best),"ms;",r.stats.pairs,"pairs,",r.findings.length,"findings; total",Math.round(r.stats.ms),"ms");
  assert.ok(B.list.length>2000);assert.ok(best<200,"broad + narrow phase under 200 ms: "+best);
  // A wide clearance makes every neighbour a candidate (worst case for the narrow phase).
  let wide=Infinity,rw;for(let k=0;k<3;k++){rw=C.check(d,defs,{gap:3,vertical:3});wide=Math.min(wide,rw.stats.ms-rw.stats.buildMs);}
  log("25.6k board, 3 mm clearance:",rw.stats.pairs,"pairs,",rw.stats.exact,"exact,",rw.findings.length,"findings; broad+narrow",Math.round(wide),"ms; with bodies",Math.round(rw.stats.ms),"ms");
  assert.ok(rw.stats.pairs>2000&&wide<200,"wide clearance: broad + narrow under 200 ms: "+wide);
  // Through DRC with the default rules plus Component Clearance.
  const set=R.create();set.list.push({id:"cc",type:"componentClearance",name:"ComponentClearance",comment:"",enabled:true,priority:1,scope:AtriumDesignQueryRecord.selector("all"),scope2:AtriumDesignQueryRecord.selector("all"),gap:.254,vertical:.254,mode:"bodies",fold:"both",board:true});
  const t2=now(),out=R.drc(d,defs,set,{types:["componentClearance"]});log("25.6k board DRC (componentClearance only):",Math.round(now()-t2),"ms,",out.violations.length,"violations");
}
