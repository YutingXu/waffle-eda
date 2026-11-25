"use strict";

const assert = require("node:assert/strict");
const {F4,F5,mirroredLandPoint,mirroredTopRow,landContacts} = require("../support/a1-geometry.cjs");
const {parseGerber,parseExcellon,rasterize} = require("../formats/gerber-compare.cjs");
const {appFile} = require("../support/app-source-paths.cjs");
for (const name of ["model","spatial","pcb-appearance","stackup","viastack","pcb-edit","pcb-pours","board-shape",
  "path-record","canvas","canvas-board-batches","pdf","print"]) require(appFile(name+".js"));

const PCB=AtriumPCBAppearance, A=Atrium;
const top=PCB.color("Top"), bottom=PCB.color("Bottom");
const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).join();
const rounded=n=>Math.round(n*1e6)/1e6 || 0;
const points=pts=>[...new Set(pts.map(p=>p.map(rounded).join(",")))].sort();
const project=A.project("Pad geometry",[]);
const doc=project.documents.find(d=>d.kind==="pcb");
doc.outline=[[-20,-15],[20,-15],[20,15],[-20,15]];
const defs=new Map();

function paint({layer="Top",mode="single",batch=false,scale=20,flipped=false,netNames=true,center=[0,0]}={}) {
  const rec=AtriumPDF.recorder(800,600), view=AtriumCanvas.create(rec.canvas);
  view.restoreCamera({cx:center[0],cy:center[1],scale,referenceScale:scale,flipped});
  view.internals().lodForce=batch;
  view.render(doc,defs,{layer,layerMode:mode,noReuse:true,grid:false,origin:false,hidden:new Set(["Board"]),showUnrouted:false,netNames});
  assert.equal(view.internals().lodUsed,batch);
  function paths(ink) {
    return rec.list.filter(op=>op.k==="p" && op.fill && op.c?.slice(0,3).join()===rgb(ink)).map(op=>{
      const vertices=[];
      for(let n=0;n<op.d.length;){
        const command=op.d[n++];
        if(command===3)continue;
        if(command===2)n+=4;
        vertices.push(view.screenToWorld([op.d[n++],op.d[n++]]));
      }
      return vertices;
    });
  }
  return {paths,labels:rec.list.filter(op=>op.k==="t").map(op=>op.u),
    hit:at=>view.hit(doc,defs,at,{layer,layerMode:mode})};
}
function model(options={}) {
  return AtriumSTEP.model(project,doc,{components:false,copper:true,holes:true,
    fab:{pourFill:"stored",pourCheck:false},...options});
}
const copper=(scene,side)=>scene.layers.find(l=>l.kind==="copper" && l.side===side)?.prisms || [];
const outline=prism=>prism.loops[0].map(seg=>[seg.a[0],-seg.a[1]]);

// Ordinary analytic and polygon pads exercise both exact Canvas2D paths.
{
  const circle={id:"circle",kind:"pad",layer:"Top",x:-4,y:0,w:1.2,h:1.2,shape:"round"};
  const rect={id:"rect",kind:"pad",layer:"Top",x:4,y:0,w:2,h:1,shape:"rect",angle:90};
  doc.items=[circle,rect];
  const reference=paint().paths(top), batch=paint({batch:true}).paths(top);
  assert.deepEqual(points(batch.flat()),points(reference.flat()));
  assert.deepEqual(points(reference.flat()),points([
    [-3.4,0],[-4,.6],[-4.6,0],[-4,-.6],[3.5,-1],[4.5,-1],[4.5,1],[3.5,1]
  ]));
}

{
  const ellipse={id:"cold-ellipse",kind:"pad",layer:"Top",x:0,y:0,w:F5.w,h:F5.h,shape:"ellipse"};
  doc.items=[ellipse];
  const curves=globalThis.AtriumGeometryCurves;
  delete globalThis.AtriumGeometryCurves;
  try{
    const view=paint({scale:200});
    assert.equal(view.hit([0,0]),ellipse);
    assert.equal(view.hit(F5.witness),null);
    const a=F5.w/2,b=F5.h/2,k=Math.SQRT1_2,normal=Math.hypot(a,b);
    const point=[a*k+.004*b/normal,b*k+.004*a/normal];
    const land=AtriumResolvedLand.geometry(ellipse);
    assert.ok(Math.abs(AtriumResolvedLand.distance(land,point,[0,0])-.004)<1e-9,"outside ellipse distance follows its normal");
    assert.equal(globalThis.AtriumLandContours,undefined,"Canvas draws and hits before physical output loads");
  }finally{globalThis.AtriumGeometryCurves=curves;}
}
for(const name of ["fab-outputs","step-export","view3d","router"])require(appFile(name+".js"));

// An authored asymmetric outline is the same layer land in Canvas2D and STEP.
// Physical flip reflects the original board XY before projection. Camera
// reflection changes the picture only; undoing the side flip restores it.
{
  const pad={x:1.2,y:-.7,w:2.4,h:1.3,angle:42,shape:"custom",layer:"Top",number:"1",
    poly:[[-.94,-.43],[.91,-.17],[-.25,.59]]};
  const part={id:"part",kind:"part",def:"custom",ref:"U1",showRef:false,x:5,y:-2,angle:31,pinNets:{1:"SIG"}};
  const definition={id:part.def,name:"Custom",footprint:{pads:[pad],shapes:[]}};
  project.library=[definition];defs.set(definition.id,definition);
  doc.items=[part];
  const initial=points(pad.poly.map(vertex=>A.world(A.world(vertex,pad),part)));
  const reference=points(paint().paths(top).flat());
  assert.deepEqual(reference,initial);
  assert.deepEqual(paint({scale:50}).labels,["SIG","1"]);
  assert.deepEqual(paint({scale:50,netNames:false}).labels,["1"]);
  assert.deepEqual(paint({scale:10}).labels,[]);
  assert.deepEqual(points(paint({flipped:true}).paths(top).flat()),initial);
  assert.deepEqual(points(outline(copper(model(),"Top")[0])),initial,"STEP must preserve the custom land vertices");
  const flip=()=>AtriumPCBEdit.applyFlip(doc,project,AtriumPCBEdit.flipPlan(doc,defs,[part.id]),defs);
  flip();
  const reflected=points(initial.map(s=>s.split(",").map(Number)).map(([x,y])=>[2*part.x-x,y]));
  assert.deepEqual(points(paint({layer:"Bottom"}).paths(bottom).flat()),reflected);
  assert.deepEqual(points(outline(copper(model(),"Bottom")[0])),reflected,"STEP uses the physical reflection");
  assert.equal(copper(model(),"Top").length,0);
  require("../support/3d-geometry.cjs");
  const viewer=Atrium3D.meshFor(project,doc,1,true);
  assert.ok(viewer.layers.some(part=>part.kind==="copper"),"the 3D viewer builds the STEP land");
  flip();
  assert.deepEqual(points(paint().paths(top).flat()),initial);
}

// Copper can disappear while the common drill stays. The editor may still
// draw a dark cue out of span, while STEP only drills full-body holes.
{
  const pad={id:"stacked-pad",kind:"pad",layer:"Multi",x:-6,y:0,w:1.8,h:1.4,drill:.5,stackMode:"full",
    padStack:{Top:{w:0,h:0},Mid:{w:1.5,h:1}, "Inner 1":{w:1.2,h:.7,shape:"roundrect"},Bottom:{w:2,h:1.1}}};
  const via={id:"blind-via",kind:"via",layer:"Multi",x:5,y:0,diameter:.8,drill:.3,fromLayer:"Top",toLayer:"Inner 1",
    stackMode:"tmb",padStack:{Top:{diameter:.8},Mid:{diameter:.65},Bottom:{diameter:.55}}};
  doc.items=[pad,via];
  doc.stackup=AtriumStackup.build(Array(4).fill("Signal"));
  assert.equal(PCB.padGeometry(pad,"Top").holeOnly,true);
  assert.deepEqual([PCB.padGeometry(pad,"Inner 1").w,PCB.padGeometry(pad,"Inner 2").w],[1.2,1.5]);
  assert.equal(PCB.padGeometry(via,"Inner 1").w,.55);
  assert.equal(PCB.padGeometry(via,"Bottom").holeOnly,true);
  const at=PCB.padGeometry(pad,"Inner 1");
  assert.equal(PCB.padGeometry(pad,"Inner 1"),at,"reuse local geometry while its input is stable");
  pad.padStack["Inner 1"].w=1.3;
  assert.equal(PCB.padGeometry(pad,"Inner 1").w,1.3,"a same-object row edit invalidates its geometry");
  assert.equal(paint({layer:"Bottom"}).paths(PCB.system.hole).length,0);
  assert.equal(paint({layer:"Bottom",mode:"all"}).paths(PCB.system.hole).length,1);
  const scene=model();
  assert.deepEqual(scene.board.holes.filter(h=>h.bore.from==="Top" && h.bore.to==="Bottom").map(h=>[h.x,h.y||0,h.d]),[[-6,0,.5]]);
  assert.equal(copper(scene,"Top").length,1);
  assert.equal(copper(scene,"Bottom").length,1);
  assert.deepEqual(AtriumPCBEdit.mirrorPad(pad,2).padStack,{
    Bottom:{w:0,h:0},Mid:{w:1.5,h:1},"Inner 2":{w:1.3,h:.7,shape:"roundrect"},Top:{w:2,h:1.1}
  });
}

// Real plotting and hit testing, sampled independently of the shared aperture builder.
const film = ext => AtriumFabOutputs.build(project,doc,{origin:"absolute",overrideExpansions:true,maskExpansion:0})
  .files.find(f=>f.name.endsWith(ext)).content;
const filled = (art,[x,y]) => !!rasterize(art.shapes,{x0:x-.0005,y0:-y-.0005,w:1,h:1,s:.001})[0];
{
  const p={...F4.pad,number:"1",layer:"Multi",stackMode:"full",padStack:A.clone(F4.stack)};
  const part={...F4.part,kind:"part",id:"F4",def:"f4",ref:"U4",showRef:false,pinNets:{1:"F4"}};
  const def={id:"f4",name:"Stacked land",footprint:{pads:[p],shapes:[]}};
  doc.stackup=AtriumStackup.build(Array(4).fill("Signal"));
  project.library=[def];defs.set(def.id,def);doc.items=[part];
  const a=F4.clockwiseDegrees*Math.PI/180, at=([x,y])=>[F4.center[0]+x*Math.cos(a)-y*Math.sin(a),F4.center[1]+x*Math.sin(a)+y*Math.cos(a)];
  const corners=[[-.55,-.7],[.55,-.7],[.55,.7],[-.55,.7]].map(at);
  assert.deepEqual(points(paint().paths(PCB.color("Multi")).flat()),points(corners),"F4 width-only Canvas2D land");
  for(const ext of [".GTL",".GTS"]){
    const art=parseGerber(film(ext));
    assert.equal(filled(art,at([.53,.65])),true,ext+" retains height");
    assert.equal(filled(art,at([.58,.65])),false,ext+" uses the narrower width");
  }
  assert.equal(paint({scale:150}).hit(at([.53,.65])),part,"rotated physical land is selectable");
  const smaller=[[-.46,-.44],[.46,-.44],[.46,.44],[-.46,.44]].map(at);
  assert.deepEqual(points(paint({layer:"Inner 2"}).paths(PCB.color("Multi")).flat()),points(smaller));
  p.layer="Top";
  assert.deepEqual(points(paint({layer:"Inner 2",mode:"all"}).paths(top).flat()),points(corners),
    "a Top-only land retains its Top row with an inner layer active");
  p.layer="Multi";
  const middle=parseGerber(film(".G2"));
  assert.equal(filled(middle,at([.42,.40])),true,"an explicit Inner 2 row beats Mid");
  assert.equal(filled(middle,at([.50,.20])),false);
  delete p.padStack["Inner 2"];delete p.padStack.Mid;
  assert.equal(filled(parseGerber(film(".G2")),at([.90,.60])),true,"a missing row uses the nominal land");
  p.padStack.Top={w:1.1,x:2.5,angle:-30};
  const localCos=Math.sqrt(3)/2, shifted=[4+2.5*localCos-.35,-3+1.25+.7*localCos];
  const shiftedFilm=parseGerber(film(".GTL"));
  assert.equal(filled(shiftedFilm,[shifted[0]+.53,shifted[1]+.65]),true,"row position and turn are applied independently");
  assert.equal(filled(shiftedFilm,[shifted[0]+.58,shifted[1]+.65]),false);
  p.padStack.Top={w:0};
  assert.equal(filled(parseGerber(film(".GTL")),F4.center),false,"one explicit zero suppresses copper");
  const nc=parseExcellon(film(".TXT"));
  assert.ok(nc.hits.some(hit=>Math.abs(hit.d-.28)<1e-6&&Math.hypot(hit.x-F4.center[0],hit.y+F4.center[1])<.000075),"the 0.28 mm drill stays on its nominal axis");
  assert.ok(paint().paths(PCB.system.padHole).length,"drill-only display cue remains");
}
{
  const p={id:"F5",kind:"pad",layer:"Top",x:0,y:0,w:F5.w,h:F5.h,net:"F5"};
  const rec=AtriumPDF.recorder(1000,1000),view=AtriumCanvas.create(rec.canvas);
  const opts={grid:false,layer:"Top",noReuse:true};
  for(const shape of [...F5.aliases,"ellipse","roundrect","roundedrectangle"]){
    const obj={...p,shape,roundrectRadiusRatio:F5.radiusRatio};
    doc.items=[obj];project.library=[];
    view.restoreCamera({cx:0,cy:0,scale:200,referenceScale:200});
    view.invalidate(doc);view.render(doc,defs,opts);
    const expected=shape!=="ellipse";
    assert.equal(view.hit(doc,defs,F5.witness,opts)===obj,expected,shape+" Canvas2D hit");
    for(const ext of [".GTL",".GTS",".GTP"])assert.equal(filled(parseGerber(film(ext)),F5.witness),expected,shape+" "+ext+" occupancy");
    const exact=points(paint().paths(top).flat());
    assert.deepEqual(points(paint({batch:true}).paths(top).flat()),exact,shape+" batched Canvas geometry");
    if(shape==="roundrect"||shape==="roundedrectangle")
      assert.ok(exact.includes(rounded(F5.w/2-F5.cornerRadius)+","+(-F5.h/2)),shape+" authored corner radius");
    const R=AtriumRouter, rules=R.core.rulesFor(doc,{clearance:.005}), W=R.core.buildWorld(doc,defs,false);
    const [x,y]=F5.witness;
    assert.equal(R.check(W,rules,{layer:"Top",points:[[x,y],[x+.001,y]],width:.005,net:"probe"}).ok,!expected,shape+" router occupancy");
  }
}

// A track under the probe distinguishes a copper hit from a part-body fallback.
{
  const def={id:"g17-pad",name:"G17",footprint:{pads:[],shapes:[]}};
  function flippedPad(pad){
    const part={...F4.part,angle:-F4.part.angle,id:"G17",kind:"part",def:def.id,showRef:false,pinNets:{"1":"LAND"}};
    doc.items=[part];project.library=[def];
    defs.clear();defs.set(def.id,def);
    def.footprint.pads=[{...F4.pad,number:"1",layer:"Bottom",drill:0,...pad}];
    AtriumPCBEdit.applyFlip(doc,project,AtriumPCBEdit.flipPlan(doc,defs,[part.id]),defs);
    return part;
  }
  function probe(pad,local,row,inside,label){
    const target=mirroredLandPoint(local,row);
    const cursor=mirroredLandPoint([local[0]+.7,local[1]+.5],row);
    const part=flippedPad(pad);
    const path={kind:"track",id:"probe-track",layer:"Top",net:"PROBE",points:[target,cursor],width:.004};
    doc.items=[part,path];
    assert.equal(paint({scale:250,center:target}).hit(target),inside?part:path,label+" selectable copper");
    doc.items=[part];
    const router=AtriumRouter.begin(doc,defs,{net:"PROBE",layer:"Top",mode:"stop",corner:"any",start:cursor,
      width:.004,rules:{clearance:.005,trackWidth:.004},moveBudgetMs:25});
    const moved=router.move(target), end=moved.end;
    assert.equal(moved.status,inside?"blocked":"ok",label+" interactive route");
    assert.equal(Math.hypot(end[0]-target[0],end[1]-target[1])<1e-8,!inside,label+" route reaches cursor");
    if(label==="roundedrectangle") {
      doc.items=[part,path];
      assert.equal(paint({scale:140,center:target}).hit(target),part,"five screen pixels can reach the rounded corner from outside copper");
    }
  }
  for(const {shape,poly,point,inside} of landContacts)
    probe({shape,poly,w:F5.w,h:F5.h,roundrectRadiusRatio:F5.radiusRatio},point,{},inside,shape);
  const pad={stackMode:"full",padStack:{Bottom:mirroredTopRow}};
  probe(pad,[.53,.64],mirroredTopRow,true,"width-only shifted Top row");
  probe(pad,[.62,.64],mirroredTopRow,false,"narrow Top row excludes the old width");
  probe(pad,[.75,.22],{},false,"nominal outline at the unshifted anchor");
}

console.log("PASS physical PCB lands: exact and batched Canvas2D, Gerber mask/paste, routing, custom STEP land, flip, stack rows and drill-only cues");
