"use strict";
// Reads frozen native snapshots and their SHA-256 receipts. Reports only totals.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
for(const name of ["core/model","schematic/sch-appearance","schematic/sch-objects","core/spatial","pcb/pcb-appearance","canvas/canvas","editor/edit-selection","history/undo-store","project/hierarchy","canvas/minimap"])
  require("../app/"+name+".js");
const directory=process.argv[2]; if(!directory)throw Error("Pass the frozen native snapshot directory.");
const names=fs.readdirSync(directory).filter(n=>n.endsWith(".waffle")).sort();
const summary={projects:0,nativeSheets:0,seededSheets:0,fixedSheets:0,groupedMoves:0,undoRestorations:0};
for(const name of names){
  const bytes=fs.readFileSync(path.join(directory,name)), receipt=JSON.parse(fs.readFileSync(path.join(directory,name.replace(/\.waffle$/,".input.json"))));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),receipt.sha256,"snapshot must match its read-only receipt");
  const project=JSON.parse(bytes),defs=new Map(project.library.map(d=>[d.id,d])),sheets=project.documents.filter(d=>d.kind==="schematic");
  if(!sheets.length){
    const d=Atrium.sheet("schematic","Fixture sheet");
    d.items.push({id:Atrium.id(),kind:"wire",points:[[-18,2],[-9,2]]});
    project.documents.push(d);sheets.push(d);summary.seededSheets++;
  }else summary.nativeSheets+=sheets.length;
  for(const doc of sheets){
    const P=AtriumSchAppearance,S=AtriumSchObjects,source=JSON.stringify(doc);
    const fixed=P.pageBounds(doc,defs),settings=doc.sheet;
    if(!P.isInfinite(doc))summary.fixedSheets++;
    const ctx=new Proxy({},{get:(o,k)=>o[k]||(()=>{})});
    const view=AtriumCanvas.create({getContext:()=>ctx,getBoundingClientRect:()=>({width:1000,height:700})});
    const frame=S.make("frame",[-50.8,-50.8],{w:20.32,h:20.32,text:"Fixture frame"});
    const anchor={id:Atrium.id(),kind:"junction",x:-41,y:-42};
    const before=doc.items.length;
    doc.items.push(frame,anchor);doc.sheet={...settings,infinite:true};
    const check=()=>assert.deepEqual(view.drawingBounds(doc,defs),P.drawingBounds(doc,defs));
    check();view.fit(doc,defs,"document");
    const members=S.frameContents(doc,frame,defs,view.query(doc,defs,S.frameBounds(frame)));assert.ok(members.includes(anchor));
    AtriumUndoStore.reset();
    const mark=AtriumUndoStore.mark(project),history=[],future=[];
    const move=AtriumEditSelection.translation(doc,defs,[frame],part=>view.connectedWires(doc,defs,part),{query:b=>view.query(doc,defs,b)});
    move.apply(-3,1);assert.deepEqual([anchor.x,anchor.y],[-44,-41]);summary.groupedMoves++;
    AtriumUndoStore.checkpoint(history,future,mark);AtriumUndoStore.record(project,{doc,items:move.affected});view.invalidate(doc,move.affected);check();
    assert.ok(AtriumUndoStore.jump(history,future,AtriumUndoStore.mark(project),-1));AtriumUndoStore.record(project);view.invalidate(doc);check();
    const restored=doc.items.find(i=>i.id===anchor.id);
    assert.deepEqual([restored.x,restored.y],[-41,-42]);summary.undoRestorations++;
    doc.items.splice(before);if(settings===undefined)delete doc.sheet;else doc.sheet=settings;
    assert.deepEqual(P.pageBounds(doc,defs),fixed);
    assert.equal(JSON.stringify(doc),source,"the restored working copy must retain every source field");
  }
  summary.projects++;
}
console.log(JSON.stringify(summary));
