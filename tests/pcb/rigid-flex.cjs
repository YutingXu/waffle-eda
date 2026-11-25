"use strict";
// Rigid-flex: substacks, board regions, bend lines, rigid-flex DRC, fab layers,
// impedance profiles through the rules resolver, and key remapping.
const assert=require("node:assert/strict");
for(const m of ["model","rules","impedance","stackup","rigid-flex"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const S=AtriumStackup,RF=AtriumRigidFlex,R=AtriumRules,A=Atrium;
const close=(a,b,eps=1e-9,m)=>assert.ok(Math.abs(a-b)<=eps,(m?m+": ":"")+a+" vs "+b);
const now=()=>globalThis.performance?.now?performance.now():Date.now();

function board(){
  const doc=A.sheet("pcb","Flex");
  doc.outline=[[0,0],[60,0],[60,20],[0,20]];
  const st=S.preset(4);delete st.derived;
  const cu=st.layers.filter(S.isCopper);
  st.substacks=[{id:"flex",name:"Flex",flex:true,layers:S.flexLayers(["Top","Bottom"],cu)},
    {id:"flex-stiff",name:"Flex + stiffener",flex:true,layers:[...S.flexLayers(["Top","Bottom"],cu),{type:"Stiffener",name:"Bottom Stiffener",material:"FR-4",thickness:.3}]}];
  doc.stackup=JSON.parse(JSON.stringify(st));
  return doc;
}
// Segment distance in mm, including origins where reconstructing a global
// nearest point would round off the perpendicular distance.
{
  const origin=1e7,ulp=2**-29;
  const examples=[
    [[3,4],[0,0],[0,0],5],
    [[-3,4],[0,0],[5,0],5],
    [[7,4],[0,0],[4,0],5],
    [[3,4],[0,0],[6,0],4],
    [[1e-120,1e-120],[0,0],[2e-120,0],1e-120],
    [[origin+ulp,-origin+2*ulp],[origin,-origin],[origin+4*ulp,-origin+4*ulp],Math.hypot(ulp/2,ulp/2)]
  ];
  for(const [point,first,last,expected] of examples) {
    assert.equal(A.nearSegment(point,first,last),expected);
    assert.equal(RF.geometry.segDist(point,first,last),expected);
    assert.equal(RF.geometry.segDist(point,last,first),expected);
  }
  assert.equal(RF.geometry.segSegDist([2,3],[2,3],[0,0],[4,0]),3);
}

// Stored format: substacks round-trip; old single stacks are unchanged.
{
  const doc=board(),st=S.stored(doc);
  assert.equal(st.substacks.length,2);assert.deepEqual(st.substacks[0].layers.filter(S.isCopper).map(l=>l.key),["Top","Bottom"]);
  assert.deepEqual(S.normalize(JSON.parse(JSON.stringify(st))),st,"normalize is idempotent");
  assert.deepEqual(S.substacks(st).map(s=>[s.id,s.flex]),[["main",false],["flex",true],["flex-stiff",true]]);
  assert.equal(S.substacks(st)[0].name,"Rigid");
  assert.equal(S.normalize(S.preset(2)).substacks,undefined,"single stacks stay single");
  // Shared copper must exist in the main stack and keep its order.
  const bad=JSON.parse(JSON.stringify(doc.stackup));bad.substacks[0].layers.find(S.isCopper).key="Inner 9";
  assert.throws(()=>S.normalize(bad),/must share a copper layer/);
  const swapped=JSON.parse(JSON.stringify(doc.stackup)),cu=swapped.substacks[0].layers.filter(S.isCopper);[cu[0].key,cu[1].key]=[cu[1].key,cu[0].key];
  assert.throws(()=>S.normalize(swapped),/keep the main stack order/);
  // A single-layer flex substack is valid; a substack without copper is not.
  const one=JSON.parse(JSON.stringify(doc.stackup));one.substacks[0].layers=S.flexLayers(["Top"],S.stored(doc).layers.filter(S.isCopper));S.normalize(one);
  one.substacks[0].layers=one.substacks[0].layers.filter(l=>!S.isCopper(l));assert.throws(()=>S.normalize(one),/at least one copper layer/);
  assert.equal(S.layerInfo(doc,"Top coverlay").fileFunction,"Other,CoverlayTop");assert.equal(S.layerInfo(doc,"Bottom stiffener").fileFunction,"Other,StiffenerBot");
  assert.equal(S.layerInfo(S.normalize(S.preset(2))&&A.sheet("pcb","x"),"Top coverlay"),null);
  // The project validator accepts the stored record.
  const project=A.project("Flex");project.documents.push(doc);A.validate(JSON.parse(JSON.stringify(project)));
}
// Regions: split, assign, resolve z-ranges and coverage.
const doc=board(),defs=new Map();
{
  assert.equal(RF.regions(doc).length,1);assert.equal(RF.regions(doc)[0].implicit,true);
  assert.equal(S.splitRegion(doc,{a:[70,0],b:[70,20]}).ok,false,"a line outside the board splits nothing");
  let r=S.splitRegion(doc,{a:[20,0],b:[20,20]});assert.equal(r.ok,true);assert.equal(r.created.length,1);
  r=S.splitRegion(doc,[[40,-1],[40,21]]);assert.equal(r.ok,true);
  const regs=RF.regions(doc);assert.equal(regs.length,3);
  const mid=regs.find(g=>RF.geometry.inside([30,10],g.points)),end=regs.find(g=>RF.geometry.inside([50,10],g.points));
  S.assignStack(doc,mid.id,"flex");S.assignStack(doc,end.id,"flex-stiff");
  assert.throws(()=>S.assignStack(doc,mid.id,"nope"),/Unknown substack/);
  const res=S.regionsResolved(doc,defs);
  assert.ok(res.coverage.ok,"regions cover the outline");close(res.coverage.regionArea,1200,1e-6);
  const f=res.regions.find(g=>g.id===mid.id),rigid=res.regions.find(g=>g.stack==="main");
  assert.equal(f.flex,true);assert.deepEqual(f.copper,["Top","Bottom"]);assert.equal(rigid.copper.length,4);
  const masterTop=S.layerInfo(doc,"Top").z,flexTop=f.layers.find(l=>l.key==="Top");
  close(flexTop.z0,masterTop,1e-9,"shared copper lines up in z");
  close(f.thickness,2*.0125+2*.025+2*S.stored(doc).layers.find(l=>l.key==="Top").thickness+.05,1e-9,"flex thickness");
  assert.deepEqual(res.regions.find(g=>g.id===end.id).stiffeners.map(s=>s.side),["Bottom"]);
  // Bends with axes for 3D/STEP.
  RF.addBend(doc,{a:[30,0],b:[30,20],angle:90,radius:.5,name:"B1"});
  const b=S.regionsResolved(doc,defs).bends[0];
  assert.equal(b.region,mid.id);assert.deepEqual(b.axis.direction,[0,1]);close(b.width,.5*Math.PI/2,1e-12,"zone = arc length");
  assert.equal(b.copperCount,2);assert.ok(b.zone.length===4);
  // IPC-2223 ratios.
  assert.deepEqual(RF.minBendRadius(.1,2,false),{ratio:10,radius:1});assert.equal(RF.minBendRadius(.1,1,true).ratio,100);assert.equal(RF.minBendRadius(.1,2,true).ratio,150);assert.equal(RF.minBendRadius(.1,3,true).ratio,200);assert.equal(RF.minBendRadius(.1,4,false).ratio,15);
}
// Rigid-flex DRC.
{
  const flexRules=R.create();
  assert.ok(["flexLayers","flexVias","bendKeepout","bendCrossing","bendRadius","flexCopper","stiffener"].every(t=>flexRules.list.some(r=>r.type===t)));
  R.validate(JSON.parse(JSON.stringify(flexRules)));
  const T=(id,points,layer="Top",net="S")=>({id,kind:"track",net,points,width:.2,layer});
  doc.items.push(
    T("inner",[[10,5],[35,5]],"Inner 1"),                       // Inner 1 runs into flex
    T("skew",[[25,2],[35,12]]),                                  // 45 deg across the bend
    T("straight",[[25,15],[35,15]]),                             // perpendicular: fine
    T("corner",[[22,8],[26,8],[26,11]]),                         // 90 deg corner in flex
    {id:"v1",kind:"via",x:24,y:17,diameter:.6,drill:.3,layer:"Multi",net:"S"},  // via in flex
    {id:"v2",kind:"via",x:10,y:17,diameter:.6,drill:.3,layer:"Multi",net:"S",fromLayer:"Top",toLayer:"Inner 1"}, // blind via in rigid: fine
    {id:"pp",kind:"polygon",layer:"Bottom",net:"GND",points:[[22,1],[38,1],[38,4],[22,4]],closed:true});
  const fp={id:"fp",name:"Conn",footprint:{shapes:[],pads:[{x:0,y:0,w:.6,h:1.2,number:"1",shape:"rect",layer:"Top"},{x:1,y:0,w:.6,h:1.2,number:"2",shape:"rect",layer:"Top"}]}};
  const lib=new Map([["fp",fp]]);
  doc.items.push({id:"U1",kind:"part",def:"fp",ref:"U1",value:"",x:29.8,y:8,angle:0,pinNets:{}},  // in the bend zone
    {id:"J1",kind:"part",def:"fp",ref:"J1",value:"",x:26,y:16,angle:0,pinNets:{}},                // connector in flex, no stiffener
    {id:"J2",kind:"part",def:"fp",ref:"J2",value:"",x:50,y:10,angle:0,pinNets:{}},                // backed by the bottom stiffener
    {id:"J3",kind:"part",def:"fp",ref:"J3",value:"",x:50,y:14,angle:0,pinNets:{},layer:"Bottom"}); // on the stiffener side
  const t0=now(),out=R.drc(doc,lib,flexRules,{types:["flexLayers","flexVias","bendKeepout","bendCrossing","bendRadius","flexCopper","stiffener"]}),ms=now()-t0;
  const by=t=>out.violations.filter(v=>v.type===t);
  assert.deepEqual(by("flexLayers").map(v=>v.id),["inner"]);
  assert.deepEqual(by("flexVias").map(v=>v.id),["v1"]);
  assert.deepEqual(by("bendKeepout").map(v=>v.id),["U1"]);
  assert.deepEqual(by("bendCrossing").map(v=>[v.id,v.severity||"error"]).sort(),[["corner","warning"],["skew","error"]]);
  const radius=by("bendRadius");assert.equal(radius.length,1);close(radius[0].required,10*S.regionsResolved(doc,lib).regions.find(g=>g.stack==="flex").thickness,1e-9);
  assert.equal(radius[0].actual,.5);
  assert.deepEqual(by("flexCopper").map(v=>v.id),["pp"]);
  assert.deepEqual(by("stiffener").map(v=>[v.id,v.severity||"error"]).sort(),[["J1","warning"],["J3","error"]]);
  // Hatched pours are fine; vias may be allowed in flex.
  doc.items.find(i=>i.id==="pp").fillMode="hatched";
  const set=JSON.parse(JSON.stringify(flexRules));set.list.find(r=>r.type==="flexVias").allowInFlex=true;
  const again=R.drc(doc,lib,set,{types:["flexVias","flexCopper"]});assert.equal(again.total,0);
  // Rigid-flex rules are only listed for boards with regions.
  const plain=A.sheet("pcb","Plain");plain.outline=doc.outline;
  assert.ok(!R.drc(plain,lib,flexRules).rules.some(r=>r.type==="bendRadius"));assert.ok(out.rules.some(r=>r.type==="bendRadius"));
  // Fab layers: coverlay both sides with pad openings, stiffener, region drawing.
  const fab=RF.fabLayers(doc,lib);
  assert.deepEqual(fab.layers.map(l=>[l.ext,l.fileFunction]),[["GCT","Other,CoverlayTop"],["GCB","Other,CoverlayBot"],["GSTB","Other,StiffenerBot"],["GM15","OtherDrawing,BoardRegions"]]);
  const top=fab.layers[0];assert.equal(top.features.length,2,"one coverlay region per flex region");
  assert.ok(top.features.some(f=>f.rings.length>1),"pad openings cut the coverlay");
  assert.ok(fab.layers[3].features.length>3&&fab.layers[3].labels.length===4+fab.notes.length);
  const {F5}=require("../support/a1-geometry.cjs"), witness=[24+F5.witness[0],10+F5.witness[1]];
  const pcbItems=doc.items;
  for(const shape of ["oblong","ellipse"]){
    doc.items=[{kind:"pad",id:"F5",x:24,y:10,w:F5.w,h:F5.h,shape,layer:"Top"}];
    const apertures=RF.fabLayers(doc,lib,{coverlayOnly:true,coverlayExpansion:0}).layers.find(f=>f.key==="Top coverlay").openings;
    assert.equal(apertures.length,1);
    assert.equal(RF.geometry.inside(witness,apertures[0].poly),shape==="oblong","F5 coverlay aperture "+shape);
  }
  doc.items=pcbItems;
  // Fabrication notes: build-ups, the bend with its IPC-2223 minimum, coverlay and stiffener.
  const notes=fab.notes.join("\n");
  assert.match(notes,/^RIGID-FLEX FABRICATION NOTES/);assert.match(notes,/Flex build-up "Flex"/);assert.match(notes,/Bend B1: 90 deg, inside radius 0.5 mm, static \(IPC-2223 minimum/);
  assert.match(notes,/Coverlay on top and bottom/);assert.match(notes,/Stiffeners: Bottom FR-4 0.3 mm/);
  assert.deepEqual(RF.fabNotes(A.sheet("pcb","none"),lib),[]);
  console.log("rigid-flex DRC "+ms.toFixed(1)+" ms");
}
// Performance: 20k tracks on a 3-region flex board.
{
  const big=board();S.splitRegion(big,{a:[20,0],b:[20,20]});S.assignStack(big,RF.regions(big).find(g=>RF.geometry.inside([30,10],g.points)).id,"flex");
  RF.addBend(big,{a:[30,0],b:[30,20],angle:60,radius:3});
  for(let i=0;i<20000;i++){const y=(i%200)/10,x=(i/200|0)*.6;big.items.push({id:"t"+i,kind:"track",net:"N"+(i%50),points:[[x,y],[x+.5,y+.05]],width:.1,layer:i%3?"Top":"Inner 1"});}
  const rules=R.create(),types=["flexLayers","flexVias","bendKeepout","bendCrossing","bendRadius","flexCopper","stiffener"];
  const t0=now(),out=R.drc(big,new Map(),rules,{types}),ms=now()-t0;
  assert.ok(out.violations.length>0);assert.ok(ms<3000,"20k-track rigid-flex DRC took "+ms+" ms");
  console.log("rigid-flex DRC, 20k tracks: "+ms.toFixed(0)+" ms");
}
// Impedance profiles drive router widths through AtriumRules.resolver.
{
  const b=board();
  b.stackup.impedanceProfiles=[{id:"se50",name:"SE 50",type:"single",target:50,tolerance:10,layers:{Top:{enabled:true},Bottom:{enabled:true,width:.3}}},
    {id:"d90",name:"USB 90",type:"diff",target:90,tolerance:10,layers:{Top:{gap:.15},"Inner 2":{reference:["Inner 1","Bottom"]}}}];
  const profiles=S.impedanceProfiles(b);assert.equal(profiles.length,2);
  const v=S.profileValues(b,"se50","Top");assert.ok(v.solved);close(v.z,50,1e-6);assert.ok(v.minWidth<v.width&&v.width<v.maxWidth);
  const fixed=S.profileValues(b,"se50","Bottom");assert.equal(fixed.width,.3);assert.equal(fixed.solved,false);
  assert.equal(S.profileValues(b,"se50","Inner 1"),null,"layer not in the profile");
  const d=S.profileValues(b,"d90","Inner 2");assert.equal(d.geometry.structure,"stripline");close(d.result.zdiff,90,1e-6);assert.ok(d.minGap<=d.gap&&d.gap<=d.maxGap);
  const rules=R.create();
  rules.list.find(r=>r.type==="width").impedanceProfile="se50";
  rules.list.find(r=>r.type==="diffPairsRouting").impedanceProfile="d90";
  rules.diffPairs=[{name:"USB",positive:"USB_P",negative:"USB_N"}];
  R.validate(JSON.parse(JSON.stringify(rules)));
  const q=R.resolver(b,{rules});
  const w=q("width",{net:"X",layer:"Top"});assert.equal(w.preferred,v.width);assert.equal(w.min,v.minWidth);assert.equal(w.impedance.target,50);
  assert.equal(q("width",{net:"X"}).preferred,null,"no layer: the rule's own values");
  const dp=q("diffPairsRouting",{net:"USB_P",pairName:"USB",layer:"Inner 2"});assert.equal(dp.widthPreferred,d.width);assert.equal(dp.gapPreferred,d.gap);
  // Without a profile the stored rule omits the key (older readers stay compatible).
  const plain=R.normalize(R.create());assert.ok(plain.list.filter(r=>r.type==="width").every(r=>!("impedanceProfile" in r)));
  assert.equal(R.normalize(rules).list.find(r=>r.type==="width").impedanceProfile,"se50");
  // DRC: a too-narrow track on Top violates the profile; the right width passes.
  b.items.push({id:"n",kind:"track",net:"X",points:[[1,1],[5,1]],width:+(v.minWidth*.8).toFixed(4),layer:"Top"},{id:"ok",kind:"track",net:"X",points:[[1,3],[5,3]],width:v.width,layer:"Top"});
  const out=R.drc(b,new Map(),rules,{types:["width"]});
  assert.deepEqual(out.violations.map(x=>[x.id,x.what,x.limit]),[["n","Impedance width","min"]]);assert.match(out.violations[0].title,/Z \d+\.\d Ω \(profile 50 Ω ±10 %\)/);
  // Delay from the solver.
  const ps=S.delay(b,"Inner 1",.15);assert.ok(ps>6&&ps<8);
  // Renumbering: a new top layer moves profile and substack keys with their layers.
  const list=S.stored(b).layers.map(l=>S.isCopper(l)?{...l,source:l.key}:{...l}),first=list.findIndex(S.isCopper);
  list.splice(first,0,S.blank("Signal","New"),S.blank("Prepreg"));
  const p=S.plan(b,new Map(),list);assert.equal(p.ok,true,p.problems.join(" "));S.apply(b,new Map(),p);
  const st=S.stored(b);
  assert.deepEqual(Object.keys(st.impedanceProfiles[0].layers),["Inner 1","Bottom"]);
  assert.deepEqual(st.impedanceProfiles[1].layers["Inner 3"].reference,["Inner 2","Bottom"]);
  assert.deepEqual(st.substacks[0].layers.filter(S.isCopper).map(l=>l.key),["Inner 1","Bottom"]);
  // Removing a layer a substack shares drops it from the substack (here leaving one copper).
  const less=S.stored(b).layers.map(l=>S.isCopper(l)?{...l,source:l.key}:{...l}),bi=less.findIndex(l=>l.source==="Inner 1");less.splice(bi,2);
  b.items=b.items.filter(i=>i.layer!=="Inner 1");
  const p2=S.plan(b,new Map(),less);assert.equal(p2.ok,true,p2.problems.join(" "));
  assert.deepEqual(p2.stackup.substacks[0].layers.filter(S.isCopper).map(l=>l.key),["Bottom"]);
}
// Review fixes.
function split3(){
  const d=board();S.splitRegion(d,{a:[20,-1],b:[20,21]});S.splitRegion(d,{a:[40,-1],b:[40,21]});
  S.assignStack(d,RF.regions(d).find(g=>RF.geometry.inside([30,10],g.points)).id,"flex");return d;
}
const flexTypes=["flexLayers","flexVias","bendKeepout","bendCrossing","bendRadius","flexCopper","stiffener"];
const ids=(d,types=flexTypes,lib=new Map())=>R.drc(d,lib,R.create(),{types}).violations.map(v=>v.type+":"+v.id);
// #8 no false positives on the rigid/flex boundary; #13 vias whose land reaches flex, bends running into rigid.
{
  const T=(id,points,layer="Top")=>({id,kind:"track",net:"S",points,width:.2,layer});
  let d=split3();d.items.push(T("ends",[[10,5],[20,5]],"Inner 1"),T("along",[[20,2],[20,18]],"Inner 1"));assert.deepEqual(ids(d),[]);
  d=split3();d.items.push(T("into",[[10,5],[20.5,5]],"Inner 1"));assert.deepEqual(ids(d),["flexLayers:into"]);
  d=split3();d.items.push({id:"pin",kind:"polygon",layer:"Inner 1",net:"GND",points:[[0,0],[20,0],[20,20],[0,20]],closed:true});assert.deepEqual(ids(d),[],"pour bounded by the rigid region");
  d=split3();d.items.push({id:"over",kind:"polygon",layer:"Inner 1",net:"GND",points:[[0,0],[21,0],[21,20],[0,20]],closed:true});assert.deepEqual(ids(d),["flexLayers:over"]);
  // flexCopper only for layers the flex region has (flexLayers reports the others).
  d=split3();d.items.push({id:"inner",kind:"polygon",layer:"Inner 1",net:"GND",points:[[22,1],[38,1],[38,4],[22,4]],closed:true});assert.deepEqual(ids(d),["flexLayers:inner"]);
  d=split3();d.items.push({id:"vOut",kind:"via",x:19.8,y:10,diameter:.6,drill:.3,layer:"Multi",net:"S"});assert.deepEqual(ids(d),["flexVias:vOut"],"land overlaps flex");
  d=split3();d.items.push({id:"vClear",kind:"via",x:19,y:10,diameter:.6,drill:.3,layer:"Multi",net:"S"});assert.deepEqual(ids(d),[]);
  d=split3();RF.addBend(d,{a:[25,10],b:[45,10],angle:90,radius:5});assert.deepEqual(ids(d),["bendRadius:bend-1"]);
  assert.match(R.drc(d,new Map(),R.create(),{types:flexTypes}).violations[0].detail,/runs into rigid region/);
}
// #6 a hatched pour that was poured solid counts as solid copper.
{
  const d=split3();d.items.push({id:"hp",kind:"polygon",layer:"Top",net:"GND",points:[[22,1],[38,1],[38,4],[22,4]],closed:true,fillMode:"hatched"});
  assert.deepEqual(ids(d),[]);
  d.pcbDrawing={annotations:{},pours:[{layer:"Top",net:"GND",polygon:"hp",hatchSkipped:true,bounds:[22,1,38,4],count:1,data:""}]};
  assert.deepEqual(ids(d),["flexCopper:hp"]);assert.match(R.drc(d,new Map(),R.create(),{types:flexTypes}).violations[0].detail,/poured solid/);
}
// #11 coverage: overlapping regions plus an equal-area gap are not a tiling; #12 in-place outline edits; #14 slivers.
{
  const d=split3(),regs=d.stackup.regions,r=regs.find(g=>RF.geometry.inside([10,10],g.points));
  assert.ok(S.regionsResolved(d).coverage.ok);
  r.points=r.points.map(p=>[p[0]===20?25:p[0],p[1]]);                       // overlaps flex by 5 x 20
  const f=regs.find(g=>RF.geometry.inside([50,10],g.points));f.points=f.points.map(p=>[p[0]===60?55:p[0],p[1]]); // equal-area gap
  S.touch(d); // in-place stack edits announce themselves (stackup.js revision)
  const cov=S.regionsResolved(d).coverage;close(cov.regionArea,1200,1e-6);assert.equal(cov.ok,false);assert.equal(cov.overlaps,1);
  const e=split3(),before=S.regionsResolved(e).coverage.ok;e.outline[1][0]=70;e.outline[2][0]=70;
  assert.equal(before,true);assert.equal(S.regionsResolved(e).coverage.ok,false,"in-place outline edit is seen");
  const sq=[[0,0],[20,0],[20,20],[0,20]];
  assert.equal(RF.splitPolygon(sq,[1e-8,-1],[1e-8,21]).length,1,"no sliver region");assert.equal(RF.splitPolygon(sq,[5,-1],[5,21]).length,2);
}
// #2 profiles by region: a main-stack 50 ohm width is 11.5 ohm in a 2-layer polyimide flex.
{
  const d=board();
  d.stackup.impedanceProfiles=[{id:"se50",name:"SE 50",type:"single",target:50,tolerance:10,layers:{Top:{},Bottom:{width:.6}}},{id:"t0",name:"t0",type:"single",target:50,tolerance:0,layers:{Top:{}}}];
  const diel=d.stackup.layers.find(l=>l.type==="Dielectric");diel.dk=4.5;diel.thickness*=2; // the review's case (rules1.cjs)
  S.splitRegion(d,{a:[20,-1],b:[20,21]});const fr=RF.regions(d).find(g=>RF.geometry.inside([40,10],g.points));S.assignStack(d,fr.id,"flex");
  const main=S.profileValues(d,"se50","Top"),flex=S.profileValues(d,"se50","Top",undefined,"flex");
  assert.equal(main.stack,"main");assert.equal(flex.stack,"flex");close(flex.z,50,1e-6);assert.ok(flex.width<main.width/5);
  const zMainOnFlex=AtriumImpedance.solve({...flex.geom,w:main.width}).z;close(zMainOnFlex,11.5,.05,"main-stack width on flex");
  // Along a track: one entry per substack it passes through.
  const along=S.profileAlong(d,"se50","Top",[[5,5],[50,5]]);
  assert.deepEqual(along.map(a=>a.stack),["main","flex"]);assert.equal(along[1].values.width,flex.width);
  assert.deepEqual(RF.stacksAlong(d,[[5,5],[20,5]]).map(a=>a.stack),["main"],"ending on the edge stays in main");
  assert.deepEqual(RF.piecesAlong(d,[[5,5],[50,5]]).map(p=>[p.stack,p.a[0],p.b[0]]),[["main",5,20],["flex",20,50]]);
  assert.equal(S.stackAt(d,[40,5]),"flex");{const pb=A.sheet("pcb","P");pb.outline=[[0,0],[10,0],[10,10],[0,10]];assert.equal(S.stackAt(pb,[5,5]),null,"no regions");}
  // A fixed row width belongs to the profile's own substack; elsewhere the width is solved.
  const fb=S.profileValues(d,"se50","Bottom",undefined,"flex");assert.equal(fb.solved,true);close(fb.z,50,1e-6);
  // #7 a fixed width outside tolerance never widens the window; it is flagged instead.
  const fixed=S.profileValues(d,"se50","Bottom");
  assert.equal(fixed.within,false);assert.ok(fixed.maxWidth<.6&&fixed.minWidth<fixed.maxWidth);assert.match(fixed.warning,/outside 50/);
  close(AtriumImpedance.solve({...fixed.geom,w:fixed.maxWidth}).z,45,.01);close(AtriumImpedance.solve({...fixed.geom,w:fixed.minWidth}).z,55,.01);
  // #15 tolerance 0: a solved width is within.
  const t0=S.profileValues(d,"t0","Top");assert.equal(t0.within,true);assert.equal(t0.minWidth,t0.maxWidth);
  // #3 the stack-up signature (router rule cache key) changes on in-place edits, which call touch().
  {const sig=S.signature(d);assert.equal(S.signature(d),sig,"stable without edits");d.stackup.layers.find(l=>l.type==="Dielectric").thickness+=.01;S.touch(d);assert.notEqual(S.signature(d),sig);d.stackup.layers.find(l=>l.type==="Dielectric").thickness-=.01;S.touch(d);}
  // DRC and resolver (needs scratchpad/agent-flex/flex-rules-router.py applied to rules.js).
  const rules=R.create();rules.list.find(r=>r.type==="width").impedanceProfile="se50";
  d.items.push({id:"tf",kind:"track",net:"X",points:[[30,5],[50,5]],width:main.width,layer:"Top"},{id:"tm",kind:"track",net:"X",points:[[2,5],[15,5]],width:main.width,layer:"Top"},
    {id:"tok",kind:"track",net:"X",points:[[30,8],[50,8]],width:flex.width,layer:"Top"});
  const out=R.drc(d,new Map(),rules,{types:["width"]}).violations.map(v=>v.id);
  if(String(R.drc).includes("stacksAlong")||/stacksAlong/.test(String(R.resolver))||out.includes("tf")){
    assert.deepEqual(out,["tf"],"flex-region track checked against the flex profile");
    const q=R.resolver(d,{rules});close(q("width",{net:"X",layer:"Top",at:[40,5]}).preferred,flex.width,1e-9);close(q("width",{net:"X",layer:"Top",at:[5,5]}).preferred,main.width,1e-9);
  }else console.log("SKIP region-aware width DRC: apply scratchpad/agent-flex/flex-rules-router.py to rules.js");
}
console.log("PASS rigid-flex: substacks, regions, bends, z-ranges, DRC (layers, vias, bend zones, crossings, IPC-2223 radius, hatching, stiffeners), fab layers, impedance profiles in rules, key remapping.");
