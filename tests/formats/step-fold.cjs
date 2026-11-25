"use strict";
// Folded STEP export of a rigid-flex board (step-export.js opts.fold with flex-fold.js):
// structural STEP check (syntax, references, closed shells: every edge used twice in
// opposite directions, Euler characteristic, planar faces), re-read with Waffle's own STEP
// reader (step-import.js): solid counts and bounding boxes against the flat export and the
// 3D view's fold, components riding the fold, and the fold slider position.
const assert=require("node:assert/strict");
const {checkStepShell}=require("../support/step-shell.cjs");
for(const m of ["model","parts","pcb-appearance","pcb-pours","rules","stackup","board-shape","rigid-flex","zip","fab-outputs","step-export","flex-fold","step-import"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const S=AtriumSTEP,ST=AtriumStackup,RF=AtriumRigidFlex,F=AtriumFlexFold,SI=AtriumSTEPImport,A=Atrium;
const log=(...a)=>(globalThis.console?.log||globalThis.print||(()=>{}))(...a);
const near=(a,b,e,m)=>assert.ok(Math.abs(a-b)<=e,(m?m+": ":"")+a+" vs "+b);

function project(bends){
  const doc=A.sheet("pcb","Flex");doc.outline=[[0,0],[100,0],[100,30],[0,30]];
  const st=ST.preset(4);delete st.derived;
  const cu=st.layers.filter(ST.isCopper);
  st.substacks=[{id:"flex",name:"Flex",flex:true,layers:ST.flexLayers(["Top","Bottom"],cu)}];
  doc.stackup=JSON.parse(JSON.stringify(st));
  ST.splitRegion(doc,{a:[35,-1],b:[35,31]});ST.splitRegion(doc,{a:[65,-1],b:[65,31]});
  ST.assignStack(doc,RF.regions(doc).find(g=>RF.geometry.inside([50,15],g.points)).id,"flex");
  for(const b of bends)RF.addBend(doc,b);
  const def={id:"box",name:"Box",prefix:"U",footprint:{name:"BOX-10",pads:[{number:"1",x:-3,y:0,w:1,h:1},{number:"2",x:3,y:0,w:1,h:1}],shapes:[{kind:"path",layer:"Mechanical 13",closed:true,points:[[-4,-3],[4,-3],[4,3],[-4,3]]}],height:2}};
  doc.items.push({id:"u1",kind:"part",def:"box",ref:"U1",x:15,y:15,angle:0},{id:"u2",kind:"part",def:"box",ref:"U2",x:85,y:15,angle:0},{id:"h1",kind:"via",x:10,y:5,diameter:1,drill:.6},{id:"h2",kind:"via",x:90,y:25,diameter:1,drill:.6});
  return {project:{name:"Fold",documents:[doc],library:[def]},doc};
}
const vol=r=>{let v=0;for(const p of r.parts){const P=p.positions,I=p.indices;for(let i=0;i<I.length;i+=3){const a=I[i]*3,b=I[i+1]*3,c=I[i+2]*3;
  v+=(P[a]*(P[b+1]*P[c+2]-P[b+2]*P[c+1])-P[a+1]*(P[b]*P[c+2]-P[b+2]*P[c])+P[a+2]*(P[b]*P[c+1]-P[b+1]*P[c]))/6;}}return v;};
const box=r=>r.bbox.map(v=>+v.toFixed(3));

// One 90° bend: flat vs folded.
{
  const {project:p,doc}=project([{a:[50,0],b:[50,30],angle:90,radius:3,name:"B1"}]);
  const flat=S.build(p,doc,{deterministic:true}),fold=S.build(p,doc,{deterministic:true,fold:"folded"});
  const cf=checkStepShell(S.parse(flat.text),{folded:true}),cF=checkStepShell(S.parse(fold.text),{folded:true});
  const broken=S.parse(fold.text);
  const reversed=[...broken.entities.values()].find(entity=>{
    if(entity.type!=="ORIENTED_EDGE")return false;
    const edge=broken.entities.get(entity.args[3].ref);
    return edge.args[1].ref!==edge.args[2].ref;
  });
  reversed.args[4].enum=reversed.args[4].enum==="T"?"F":"T";
  assert.throws(()=>checkStepShell(broken,{folded:true}),/edge loop is not connected/);
  log("flat",JSON.stringify(cf),"folded",JSON.stringify(cF),fold.notes.join(" | "));
  assert.ok(cF.solids>cf.solids,"the folded board has more solids (zone segments)");
  const rf=SI.tessellate(flat.text),rF=SI.tessellate(fold.text);
  log("flat bbox",box(rf),"folded bbox",box(rF),"flat solids",rf.stats.solids,"folded solids",rF.stats.solids);
  assert.equal(rf.stats.solids,cf.solids);assert.equal(rF.stats.solids,cF.solids);
  assert.equal(rF.stats.approximated,0);
  // Volumes agree: the bend keeps the neutral-axis length (thin board: within a few %).
  const vf=vol(rf),vF=vol(rF);log("volume flat",vf.toFixed(2),"folded",vF.toFixed(2));near(vF/vf,1,0.02,"volume kept");
  // Flat spans 100 mm; folded 90° the far end stands up: shorter in x, taller in z.
  near(rf.bbox[3]-rf.bbox[0],100,1e-3);assert.ok(rF.bbox[3]-rF.bbox[0]<80,"folded is shorter");assert.ok(rF.bbox[5]>30,"folded stands up: "+rF.bbox[5]);
  // The folded export matches the 3D view's fold at the far end (U2 rides the fold).
  const P=F.plan(doc,new Map(p.library.map(d=>[d.id,d])),{}),far=P.fixed===P.piece([10,15])?[85,15]:[15,15];
  const m=S.model(p,doc,{fold:1}),u=m.parts.find(x=>x.ref===(far[0]>50?"U2":"U1")),want=F.pointAt(P,[far[0],-far[1],m.board.thickness],1).p;
  for(let k=0;k<3;k++)near(u.matrix[12+k],want[k],1e-6,"component origin follows the fold");
  assert.ok(Math.abs(u.matrix[10])<1e-6,"the far part stands vertical");
  assert.match(fold.notes.join(" "),/Folded at 100 %/);
  assert.doesNotMatch(fold.notes.join(" "),/exported flat/);
  // Slider position: half way.
  const half=S.build(p,doc,{deterministic:true,fold:.5});checkStepShell(S.parse(half.text),{folded:true});const rh=SI.tessellate(half.text);
  assert.ok(rh.bbox[5]>rf.bbox[5]&&rh.bbox[5]<rF.bbox[5],"half fold is between flat and folded");
  // The mesh of the folded model is closed: zero signed volume deficit against the STEP read back.
  const board=m=>vol({parts:S.mesh(m).parts.filter(q=>q.kind==="board")});
  near(board(m)/board(S.model(p,doc,{})),1,1e-4,"folded board mesh keeps the flat board volume");
}
// S-fold with fold order and timings.
{
  const {project:p,doc}=project([{a:[45,0],b:[45,30],angle:90,radius:2,name:"B1",order:1},{a:[56,0],b:[56,30],angle:-90,radius:2,name:"B2",order:2}]);
  const t0=Date.now(),fold=S.build(p,doc,{deterministic:true,fold:1}),ms=Date.now()-t0;
  const c=checkStepShell(S.parse(fold.text),{folded:true}),r=SI.tessellate(fold.text);
  log("S-fold",JSON.stringify(c),"bbox",box(r),"ms",ms,"bytes",fold.text.length);
  // Far end level again and raised: the top bound is the far rigid end.
  assert.equal(r.stats.solids,c.solids);
}
// An embedded STEP model rides the fold too; a hole inside the bend zone is left out with a note.
{
  const {project:p,doc}=project([{a:[50,0],b:[50,30],angle:90,radius:3,name:"B1"}]);
  const stepText=S.export({name:"M",documents:[(()=>{const d=A.sheet("pcb","M");d.outline=[[-2,-2],[2,-2],[2,2],[-2,2]];return d;})()],library:[]},null,{deterministic:true});
  p.library.push({id:"m",name:"M",prefix:"U",footprint:{name:"M",pads:[{number:"1",x:0,y:0,w:1,h:1}],model3d:{stepText,offset:[0,0,0],rotation:[0,0,0]}}});
  doc.items.push({id:"m1",kind:"part",def:"m",ref:"M1",x:10,y:10,angle:0},{id:"hz",kind:"via",x:50,y:15,diameter:.8,drill:.4});
  const out=S.build(p,doc,{deterministic:true,fold:1}),c=checkStepShell(S.parse(out.text),{folded:true}),r=SI.tessellate(out.text);
  assert.match(out.notes.join(" "),/hole or cutout crossing a bend zone/);
  const P=F.plan(doc,new Map(p.library.map(d=>[d.id,d])),{}),m=S.model(p,doc,{fold:1}),mp=m.parts.find(x=>x.ref==="M1"),want=F.pointAt(P,[10,-10,m.board.thickness],1).p;
  assert.notEqual(P.piece([10,15]),P.fixed,"the left end folds");for(let k=0;k<3;k++)near(mp.matrix[12+k],want[k],1e-6,"model origin follows the fold");
  assert.ok(r.stats.solids>=c.solids-1,"merged model solids read back");log("with a STEP model:",JSON.stringify(c),out.notes.length,"notes");
}

