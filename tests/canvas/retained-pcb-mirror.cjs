"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {nativeCAD}=require("../support/native-cad.cjs");
const {appFile}=require("../support/app-source-paths.cjs");
for(const name of ["spatial","pcb-appearance","stackup","pcb-pours","board-shape","path-record","canvas",
  "canvas-board-batches","pdf","print","fab-outputs","dfm","step-export","view3d","edit-selection","undo-store",
  "format-2-closure","folder-project-engine","import-sidecars","project-archive","browser-project","folder-project"])require(appFile(name+".js"));

const A=Atrium,PCB=AtriumPCBAppearance,U=AtriumUndoStore;
const project=nativeCAD("saved-mirror"), doc=project.documents.find(doc=>doc.kind==="pcb"), part=doc.items[0];
const defs=new Map(project.library.map(def=>[def.id,def])), saved=defs.get(part.def), source=defs.get(saved.mirrorOf);
const polygon=source.footprint.pads[0].poly;
const initialActor={...part,angle:360-part.angle};
const p=source.footprint.pads[0];
const reflect=([x,y])=>[2*part.x-x,y];
const points=vertices=>[...new Set(vertices.map(point=>point.map(n=>Math.round(n*1e6)/1e6 || 0).join(",")))].sort();
const reflected=points(polygon.map(local=>reflect(A.world(A.world(local,p),initialActor))));
const stored=JSON.stringify(project);
assert.match(saved.mirrorSig,/^[0-9a-f]{8}$/);
assert.deepEqual(saved.footprint.pads[0].poly,polygon,"the fixture was saved by the old flip algorithm");

function immutable(value){
  if(!value || typeof value!=="object" || Object.isFrozen(value))return;
  for(const child of Object.values(value))immutable(child);
  Object.freeze(value);
}
immutable(project);
U.reset();U.record(project);
const version=U.documentVersions(doc,project);

let unopened=0;
defs.set("unused",{id:"unused",footprint:{get pads(){unopened++;return [];}}});
const color=PCB.color("Bottom").slice(1).match(/../g).map(hex=>parseInt(hex,16)/255).join();
function firstPaint(board,lookup,batch){
  const rec=AtriumPDF.recorder(900,650),view=AtriumCanvas.create(rec.canvas);
  view.restoreCamera({cx:3,cy:-2,scale:30,referenceScale:30,flipped:true});
  view.internals().lodForce=batch;
  view.render(board,lookup,{layer:"Bottom",layerMode:"single",grid:false,origin:false,showUnrouted:false,noReuse:true});
  const land=rec.list.find(op=>op.k==="p" && op.fill && op.d.length===10 && op.c?.slice(0,3).join()===color);
  assert.ok(land,"a triangular land is present on the first Bottom paint");
  return points([0,3,6].map(i=>view.screenToWorld([land.d[i+1],land.d[i+2]])));
}
assert.deepEqual(firstPaint(doc,defs,false),reflected,"the saved mirror must be corrected for first Canvas2D paint");
assert.deepEqual(firstPaint(doc,defs,true),reflected);
assert.equal(unopened,0,"drawing never asks for the unused footprint's pads");
const projected=PCB.readDefinition(defs,part.def,doc);
assert.equal(PCB.readDefinition(defs,part.def,doc),projected,"retain only the used verified read projection");
assert.deepEqual(Object.fromEntries(Object.entries(projected.footprint.pads[1].padStack)),{
  Bottom:{w:1.2,h:.7},Top:{w:.9,h:.7},"Inner 2":{w:1.15,h:.75},"Inner 1":{w:.85,h:.6}
});

const fab=AtriumFabOutputs.analyse(project,doc,{pourFill:"stored",pourCheck:false});
const lands=(layer,pin)=>fab.layers.get(layer).find(f=>f.t==="flash" && f.pin===pin);
const flash=lands("Bottom","1");
assert.deepEqual(points(flash.pad.poly.map(q=>A.world(q,{x:flash.at[0],y:flash.at[1],angle:flash.pad.angle}))),reflected);
assert.equal(lands("Bottom","2").pad.w,1.2);
assert.equal(lands("Top","2").pad.w,.9);
assert.equal(lands("Inner 1","2").pad.w,.85);
const model=AtriumSTEP.model(project,doc,{components:false,copper:true,fab:{pourFill:"stored",pourCheck:false}});
const copper=model.layers.find(layer=>layer.kind==="copper"&&layer.side==="Bottom");
const triangular=copper.prisms.find(prism=>prism.loops[0].length===3);
assert.deepEqual(points(triangular.loops[0].map(edge=>[edge.a[0],-edge.a[1]])),reflected);
  require("../support/3d-geometry.cjs");
const viewer=Atrium3D.meshFor(project,doc,1,true);
assert.ok(viewer.layers.some(batch=>batch.kind==="copper"),"the first retained 3D scene consumes corrected copper");

const clipboard=AtriumEditSelection.capture(doc,defs,new Set([part.id]),false,null,project);
assert.equal(clipboard.library.length,1,"copy carries the repaired footprint without requiring its unselected source");
const inline=new Map(clipboard.library.map(def=>[def.id,def]));
assert.deepEqual(firstPaint({...doc,items:clipboard.items},inline,false),reflected);
const paste=AtriumEditSelection.prepare(project,doc,clipboard,defs);
assert.equal(paste.items[0].def,part.def,"copy in the same project still reuses the definition");
paste.cancel();
assert.equal(JSON.stringify(project),stored,"draw, physical model and copy leave stored data unchanged");
assert.deepEqual(U.documentVersions(doc,project),version,"the committed cursor stayed clean");

const missing=new Map([[saved.id,saved]]);
assert.equal(PCB.readDefinition(missing,saved.id,doc),saved,"a missing source keeps the retained definition");
const changedSource=A.clone(source);
changedSource.footprint.pads[0].poly[0][0]+=.2;
assert.equal(PCB.readDefinition(new Map([[saved.id,saved],[source.id,changedSource]]),saved.id,doc),saved,"an edited source cannot prove the old derivation");
const changedSaved=A.clone(saved);
changedSaved.footprint.pads[0].poly[1][1]+=.2;
assert.equal(PCB.readDefinition(new Map([[saved.id,changedSaved],[source.id,source]]),saved.id,doc),changedSaved,"an edited mirror is authoritative");

{
  const track = {id:"mirror-mask-probe",kind:"track",net:"PROBE",layer:"Bottom",width:.03,
    points:[[3.52,-2.8],[3.53,-2.72]]};
  const board = {...doc,items:[...doc.items,track]};
  const DFM = AtriumDFM, Fab = AtriumFabOutputs, cache = DFM.createCache();
  const authored = def => points(def.footprint.pads[0].poly.map(q => A.world(A.world(q,def.footprint.pads[0]),part)));
  for (const [library, expected, overlap] of [
    [[saved,source],reflected,true],
    [[saved],authored(saved),false],
    [[changedSaved,source],authored(changedSaved),false],
    [[saved,source],reflected,true],
  ]) {
    const snapshot = {...project,library,documents:project.documents.map(d => d === doc ? board : d)};
    const before = JSON.stringify(snapshot), lookup = new Map(library.map(d => [d.id,d]));
    const check = DFM.run(board,lookup,{maskToTrace:.03},{checks:["maskTrace"],cache,project:snapshot});
    assert.deepEqual(check.issues.map(i => [i.id,i.maskSide,i.actual]),overlap ? [[track.id,"bottom",0]] : [],
      "DFM checks the corrected first mask and invalidates its cached footprint on fallback or replacement");
    const output = Fab.analyse(snapshot,board,{pourFill:"stored",pourCheck:false});
    const flash = output.layers.get("Bottom mask").find(f => f.pad?.shape === "custom");
    const aperture = Fab.plotPad(flash,{maskExpansion:0,overrideExpansions:true});
    assert.deepEqual(points(aperture.poly.map(q => A.world(q,{x:flash.at[0],y:flash.at[1],angle:aperture.angle}))),expected);
    assert.equal(JSON.stringify(snapshot),before,"DFM and fabrication do not edit the saved footprint");
  }
}

globalThis.__testDone=(async()=>{
  const fixture=path.join(__dirname,"../fixtures/cad-native/saved-mirror");
  const load=member=>new Uint8Array(fs.readFileSync(path.join(fixture,member)));
  const manifest=AtriumFormat2Model.manifest(AtriumFormat2Model.parse(load("Project.waffle")));
  const originalPath=manifest.members.find(row=>row.id===source.id).path;
  const files=new Map([["Project.waffle",load("Project.waffle")],...manifest.members.map(row=>[row.path,load(row.path)])]);
  for(const hideOriginal of [false,true]){
    const volume=AtriumBrowserProject.create("Project.waffle",files);
    let writes=0;
    const host={...volume.host,folderCommit(request){writes++;return volume.host.folderCommit(request);},
      folderRead(request){
        return volume.host.folderRead(hideOriginal ? {...request,paths:request.paths.filter(path=>path!==originalPath)} : request);
      }};
    const engine=AtriumFolderProjectEngine.create();
    const session=await AtriumFolderProject.open({...volume,memberPath:"Board layout.wpcb"},{host,workerFactory:()=>({
      run:(op,message,read,readBatch)=>engine.run({op,...message,read,readBatch}),close(){}
    })});
    try {
      assert.equal(session.dirty,false);
      assert.equal(writes,0);
      const loaded=session.project, board=loaded.documents.find(d=>d.id===doc.id);
      const lookup=new Map(loaded.library.map(d=>[d.id,d]));
      const reads=session.metrics().reads;
      assert.equal(reads.filter(row=>row.path===originalPath && row.beforePresentation && row.purpose==="mirror-source").length,hideOriginal?0:1);
      assert.ok(reads.every(row=>!row.path.includes("Unused footprint") && !row.path.endsWith(".wsch")));
      if(hideOriginal) {
        assert.ok(!lookup.has(source.id));
        assert.deepEqual(firstPaint(board,lookup,false),points(saved.footprint.pads[0].poly.map(q=>A.world(A.world(q,saved.footprint.pads[0]),part))));
      } else {
        assert.ok(lookup.has(source.id),"load just the original that can prove the retained mirror");
        assert.deepEqual(firstPaint(board,lookup,false),reflected);
      }
      assert.equal(session.dirty,false);
      assert.equal(writes,0);
    } finally {await session.close();}
  }
  console.log("PASS retained Format 2 PCB mirror: first paint, fabrication and DFM mask parity, 3D, clipboard, scoped folder hydration and zero writes");
})();
