"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {reopenAltium}=require("../support/altium-folder.cjs");
const end=require("../support/import-worker.cjs")({client:true});
const C=AtriumTranslatorClient;
const name="PiDP11IOExpander.PcbDoc";
const original={name,bytes:new Uint8Array(fs.readFileSync(path.join(__dirname,"../fixtures/altium/pidp11-io-expander",name)))};

function received(result) {
  // The JSC worker harness has separate realms and a JSON-only structuredClone shim.
  return {model:structuredClone(result.model),report:structuredClone(result.report),
    provenance:{...structuredClone({...result.provenance,files:[]}),files:result.provenance.files.map(f=>
      ({...structuredClone({...f,bytes:undefined}),bytes:new Uint8Array(f.bytes)}))}};
}
async function main(){
  const imported=received(await C.import([original],{translator:"altium"}));
  const firstBoard=imported.model.documents.find(d=>d.kind==="pcb");
  const initial=await C.export("altium-source-copy",imported.model,{scope:"document",documentId:firstBoard.id,
    original,provenance:[imported.provenance]});
  assert.deepEqual(initial.files[0].bytes,original.bytes,"source copy also works before the first native save");
  const saved=reopenAltium(imported,original,undefined,{loadModels:false});
  const project=saved.model, board=project.documents.find(d=>d.kind==="pcb");
  const copy=(model=project,groups=[saved.retained],input=original)=>C.export("altium-source-copy",model,
    {scope:"document",documentId:board.id,original:input,provenance:groups});
  const result=await copy();
  assert.deepEqual(result.files[0].bytes,original.bytes);
  assert.equal(saved.modelReads,0);
  for(const update of [
    group=>{group.precision.rows[0].fingerprint="f".repeat(64);},
    group=>{group.precision.rows[0].unit="untyped";},
    group=>{group.precision.documents=[];},
    group=>{group.precision.rows.push({...group.precision.rows[0]});}]) {
    const group=structuredClone(saved.retained);update(group);
    await assert.rejects(()=>copy(project,[group]),/retained precision/);
  }
  await assert.rejects(()=>copy(project,[saved.retained,saved.retained]),/unique retained binding/);
  await assert.rejects(()=>copy(project,[]),/imported from an Altium binary source/);
  const other={name,bytes:original.bytes.slice()};other.bytes[other.bytes.length-1]^=1;
  await assert.rejects(()=>copy(project,[saved.retained],other),/recorded import digest/);
  const changed=structuredClone(project), edited=changed.documents.find(d=>d.id===board.id);
  edited.outline[0][0]+=0.000001;
  await assert.rejects(()=>copy(changed),/outline field changed/);
  const changedTerminal=structuredClone(project), placed=board.items.find(i=>i.ref==="J4");
  const definition=changedTerminal.library.find(row=>row.id===placed.def);
  definition.footprint.pads[0].w+=0.0254;
  await assert.rejects(()=>copy(changedTerminal),/library definition for J4 differs from the source/);
  const polygonEdit=structuredClone(project), polygon=polygonEdit.documents.find(d=>d.id===board.id)
    .items.find(i=>i.kind==="polygon" && i.copperBasis);
  assert.ok(polygon?.points?.length,"the fixture contains a certified filled polygon");
  polygon.points[0][0]+=.0254;
  await assert.rejects(()=>copy(polygonEdit),/Only existing standalone copper tracks and vias/);
  const donor=structuredClone(project), alias=donor.documents.find(d=>d.id===board.id).bodyModels[0];
  alias.model.sha256="b".repeat(64);
  await assert.rejects(()=>copy(donor),/bodyModels field changed/);
  const replaced=structuredClone(project);
  replaced.documents.find(d=>d.id===board.id).bodyModels[0].stepText="different model";
  await assert.rejects(()=>copy(replaced),/bodyModels field changed/);
  const unlinked=structuredClone(saved.retained);
  for(const field of unlinked.fields) {
    if(field.type==="document" && field.id===board.id)delete field.values.sourceSha256;
    if(field.type==="item"){delete field.values.sourceRecord;delete field.values.schSource;}
  }
  const review=await copy(project,[unlinked]), binding=review.details.binding;
  assert.equal(review.files.length,0);
  assert.equal(binding.identities.length,board.items.length);
  const explicit={fields:[{type:"document",id:board.id,values:{sourceSha256:binding.sha256}},
    ...binding.identities.map(({id,...values})=>({type:"item",id,values}))]};
  assert.deepEqual((await copy(project,[explicit,unlinked])).files[0].bytes,original.bytes);
  const moved=structuredClone(project), active=moved.documents.find(d=>d.id===board.id);
  const track=active.items.find(i=>i.kind==="track" && i.layer==="Top" && !i.sourcePour);
  track.width+=.0254;
  await assert.rejects(()=>copy(moved,[unlinked]),/older import has edited or reordered/);
  const output=await copy(moved);
  assert.equal(output.details.records.length,1);
  const before=AtriumSourceFile.open(original.bytes), after=AtriumSourceFile.open(output.files[0].bytes);
  const changedStreams=before.paths().filter(p=>AtriumSourceFile.sha256(before.read(p))!==AtriumSourceFile.sha256(after.read(p)));
  assert.deepEqual(changedStreams.map(p=>p.toLowerCase()),["tracks6/data"]);
  assert.deepEqual((await copy()).files[0].bytes,original.bytes,"unchanged source and design still reproduce the original after rejected attempts");
  console.log("PASS retained Altium source copy through the registered worker: exact original, scoped precision, model identity and one edited stream");
  await pairedRepour();
}
async function pairedRepour() {
  const dir=path.join(__dirname,"../fixtures/altium/pidp11-io-expander");
  const inputs=["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc",name].map(n=>({name:n,bytes:new Uint8Array(fs.readFileSync(path.join(dir,n)))}));
  const imported=received(await C.import(inputs,{translator:"altium"})), working=imported.model;
  const first=reopenAltium(imported,original,undefined,{loadModels:false});
  const pcb=working.documents.find(d=>d.kind==="pcb");
  const field=imported.provenance.fields.find(r=>r.type==="item" && r.values.sourceRecord==="tracks6/data#131");
  const trace=pcb.items.find(i=>i.id===field.id);
  assert.equal(trace.width,.1524);
  const polygon=pcb.items.find(i=>i.kind==="polygon" && i.layer===trace.layer && !i.shelved && !i.cutout);
  assert.ok(polygon);
  const defs=new Map(working.library.map(d=>[d.id,d]));
  AtriumPolygonPour.adoptSourceCopper(working);
  trace.width=.1778;
  AtriumPolygonPour.apply(pcb,defs,{project:working,only:[polygon.id]});
  assert.ok(pcb.pcbDrawing.pours.some(r=>r.polygon===polygon.id && !Object.hasOwn(r,"source")));
  assert.ok(pcb.pcbDrawing.pours.some(r=>r.polygon!==polygon.id && r.source==="altium"));
  const copy=(model,proof)=>C.export("altium-source-copy",model,{documentId:pcb.id,provenance:[proof],original});
  const warm=await copy(working,first.retained), saved=reopenAltium(imported,original,first.entry,{loadModels:false});
  const board=p=>p.documents.find(d=>d.id===pcb.id);
  const fresh=board(saved.model);
  assert.ok(!fresh.pcbDrawing.pourSignatures);
  const result=await copy(saved.model,saved.retained);
  assert.deepEqual(result.files[0].bytes,warm.files[0].bytes);
  assert.deepEqual(Array.from(result.details.records),["tracks6/data#131"]);
  for (const key of ["inputs","contours"]) {
    const changed=structuredClone(saved.model), p=board(changed).items.find(i=>i.id===polygon.id);
    p.copperBasis[key]="unverified";
    await assert.rejects(()=>copy(changed,saved.retained),/pcbDrawing field changed/);
  }
  const other=structuredClone(saved.model), island=board(other).pcbDrawing.pours.find(r=>r.source==="altium");
  island.polygon=polygon.id;
  await assert.rejects(()=>copy(other,saved.retained),/pcbDrawing field changed/);
  const older=reopenAltium(imported,original,undefined,{loadModels:false});
  await assert.rejects(()=>copy(saved.model,older.retained),/retained precision/,
    "a proof from the edited conversion cannot impersonate the source");
  console.log("PASS paired Altium source and native repour keep independent precision, certified contours, owner and original bytes");
}
globalThis.__testDone=main().finally(end).catch(e=>{console.error(e);process.exitCode=1;});
