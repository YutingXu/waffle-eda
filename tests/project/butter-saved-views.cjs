"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const name of ["uuid-v7","model","source-file","format-2-codec","format-2-units","format-2-values","format-2-model",
  "design-query-record","link-record","saved-views","parts","sch-objects","pcb-appearance","net-intent","signals","rules",
  "design-query","query","butter-query-service","proposal","butter","drawing"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
require("../../app/project/saved-view-commands.js");

const {AtriumFormat2:F,AtriumFormat2Model:M,AtriumSavedViews:V,AtriumButter:B,AtriumProposal:P} = globalThis;
const dir = path.join(__dirname,"../fixtures/butter-acceptance/saved-views"), read = name => fs.readFileSync(path.join(dir,name));
const manifest = M.parse(read("Saved-view study.waffle"));
const {project,members} = M.manifest(manifest);
for (const member of members) {
  if (!["pcb","schematic","drawing","panel","library"].includes(member.kind)) continue;
  const file = M.parse(read(member.path));
  if (member.kind === "library") project.library.push(M.library(file));
  else project.documents.push(M.document(file,{name:member.name}));
}
const descriptor = require("../../app/automation/descriptors/saved-views.json"), [copper, schematic] = project.savedViews;
const command = (name, args, context = {}) => B.invoke("savedViews", descriptor.commands.find(s => s.id === name), args,
  {project, source:"mcp", revision:1, scope:project, ...context}, (receipt, {ops, file, commit}) => {commit();return {...receipt, ops, file};});

async function exportBatch() {
  const id = n => "018cc251-f400-7000-8000-" + String(9900 + n).padStart(12, "0");
  let reads = 0, spare = 0;
  const board = project.documents.find(doc => doc.id === copper.documentId);
  const drawing = project.documents.find(doc => doc.kind === "drawing");
  const dense = {...board, items:Array.from({length:1000},(_,n) => ({get id() {reads++; return "item-" + n;}}))};
  const unrelated = {id:"unrelated-sheet", kind:"schematic", get items() {spare++; return [];}};
  const frame = drawing.drawing.views[0].id;
  const {filter:_filter, ...record} = copper;
  const views = Array.from({length:24},(_,n) => ({...record, id:id(n), name:"Page " + n,
    selection:["item-" + (999 - n), "removed-" + n, "item-5"]}));
  views.push(...[24,25].map(n => ({...schematic,id:id(n),name:"Drawing " + n,documentId:drawing.id,
    selection:n === 24 ? [frame,"deleted-drawing-object"] : [frame]})));
  const synthetic = {...project, savedViews:views, documents:[dense,drawing,unrelated]};
  const ids = views.map(view => view.id).reverse();
  let jobs, outputVariant;
  globalThis.AtriumPrint = {prepareDocument(source, options, providers, consume) {
    assert.equal(options.color,"mono");
    assert.equal(options.attachments,false);
    outputVariant = source.activeVariant;
    jobs = options.presentation;
    return consume({pages:jobs.map(job => ({viewId:job.id,title:job.title,doc:job.documentId,w:600,h:450})),
      notes:["Prepared print receipt"], links:jobs.length, bytes:() => new Uint8Array([1])});
  }};
  try {
    const args = {ids,color:"mono"}, ctx = {project:synthetic,mode:"write",allowWrite:true};
    assert.deepEqual((await command("export-pdf",args,{project:synthetic})).result.viewIds,ids);
    assert.equal(reads,0,"planning views does not read their authored items");
    const receipt = await command("export-pdf",args,ctx);
    assert.equal(reads,dense.items.length,"a batch searches a shared board once");
    assert.equal(spare,0,"an unrelated sheet need not be inspected");
    assert.deepEqual(receipt.result.pages.map(page=>page.id),ids);
    assert.equal(receipt.result.notes.length,26);
    assert.equal(receipt.result.notes.at(-1),"Prepared print receipt");
    assert.equal(receipt.file.binary,true);
    const expected = ids.map(viewId=>V.resolve(synthetic,viewId));
    assert.deepEqual(jobs.map(({title,camera,uri,...job}) => ({...job, camera:V.camera(camera)})),expected);
    assert.deepEqual(jobs.slice(0,2).map(job=>job.selection),[[frame],[frame]]);
    assert.equal(jobs[0].uri,AtriumLinkRecord.format({projectId:synthetic.id,objectId:id(25)}));
    assert.equal(outputVariant,synthetic.activeVariant);
    dense.items[dense.items.length - 1] = {id:"replacement"};
    await command("export-pdf",args,{...ctx,project:{...synthetic,activeVariant:"Assembly Lite"}});
    assert.deepEqual(jobs.at(-1).missingSelection,["item-999","removed-0"],"an export after an edit rechecks selections");
    assert.equal(outputVariant,"Assembly Lite","prepared Print sees the current variant on each export");
  } finally { delete globalThis.AtriumPrint; }
}

async function main() {
  assert.equal(manifest.header.formatVersion,"2.1");
  assert.equal(manifest.header.requires, undefined);
  assert.equal(AtriumUUID.isV7(copper.id),true);
  assert.deepEqual(copper.camera,{center:[5,4],flipped:true,referenceScale:40,rotationRadians:.125,scale:45});
  assert.deepEqual(V.camera(V.restore(copper.camera)),copper.camera);
  assert.deepEqual(V.resolve(project,copper.id).missingSelection,[]);
  assert.equal(V.resolve(project,copper.id).status,"partial", "a missing query adapter is visible");
  const exact = command("apply", {id:copper.id});
  assert.equal(exact.result.status,"ready");
  assert.deepEqual(exact.result.filter.rows,[{id:"run"}]);
  assert.deepEqual(exact.result.selection,["run"]);
  assert.equal(exact.result.netHighlight,"SENSE");
  assert.deepEqual(exact.result.layers,{active:"Top",hidden:["Bottom"],mode:"single"});
  assert.deepEqual(exact.result.camera,copper.camera);
  assert.equal(command("apply",{id:"018cc251-f400-7000-8000-000000000004"}).result.status,"missing-view");

  const named = await AtriumQueryService.save({name:"Top copper",query:copper.filter.scope.source,scope:{documentId:"board"}},
    {project,enabled:true,revision:1,yieldTask:()=>Promise.resolve()});
  assert.equal(named.result.status,"complete");
  const namedProject = {...project,savedQueries:[named.result.record],savedViews:[{...copper,filter:{...copper.filter,
    scope:{savedQueryId:named.result.record.id}}},schematic]};
  const disabledFilter = command("apply",{id:copper.id},{project:namedProject,enabled:()=>false}).result;
  assert.equal(disabledFilter.status,"partial");
  assert.equal(disabledFilter.filter.status,"disabled");
  const enabledFilter = (await command("apply",{id:copper.id},{project:namedProject,enabled:key=>key==="query"})).result;
  assert.equal(enabledFilter.status,"ready");
  assert.deepEqual(enabledFilter.filter.rows.map(row=>[row.documentId,row.id]),[["board","run"]]);

  const copy = JSON.parse(JSON.stringify(project));
  const board = copy.documents.find(d => d.id === copper.documentId);
  board.items = board.items.filter(i => i.id !== "run");
  assert.deepEqual(V.resolve(copy,copper.id).missingSelection,["run"]);
  copy.documents = copy.documents.filter(d => d.id !== copper.documentId);
  assert.equal(V.resolve(copy,copper.id).status,"missing-document");
  assert.equal(V.resolve({...copy,documents:[{id:copper.documentId}]},copper.id).status,"loading-document");

  assert.throws(() => command("present",{ids:[copper.id,copper.id]}), /invalid entries|distinct/);
  assert.throws(() => command("apply",{id:copper.id},{mode:"write"}), /explicit write grant/);
  const opts = {allowWrite:true,mode:"write"};
  assert.equal(command("present",{ids:[schematic.id,copper.id]},opts).result.current.id,schematic.id);
  assert.equal(command("step",{},opts).result.current.id,copper.id);
  assert.equal(command("step",{direction:-1},opts).result.current.id,schematic.id);
  assert.equal(command("step",{direction:-1},opts).result.index,0);
  await exportBatch();

  const capture = command("capture",{name:"Review probe",view:{documentId:copper.documentId, camera:copper.camera,
    viewport:copper.viewport, selection:["probe"]}});
  assert.equal(capture.ops[0].path[0],"savedViews");
  assert.equal(capture.ops.length,1);
  assert.ok(AtriumUUID.isV7(capture.result.view.id));
  assert.notEqual(capture.result.view.id,copper.id);
  assert.equal(project.savedViews.length,2,"planning must keep the source unchanged");
  const target = JSON.parse(JSON.stringify(project));
  P.apply(target,B.proposal(project,"butter.savedViews.capture",capture.ops));
  assert.equal(target.savedViews.length,3);
  const savedDelta = M.manifestEdits(manifest,target);
  assert.deepEqual(savedDelta.put.map(row => [row.kind,row.id]),[["savedView",capture.result.view.id]]);
  assert.deepEqual(savedDelta.remove,[]);
  const reopened = M.manifest(M.parse(F.serialize(F.edit(manifest,savedDelta)))).project;
  assert.deepEqual(reopened.savedViews,target.savedViews);
  assert.equal(reopened.savedViews[0].id,copper.id);

  const native = manifest.get(copper.id), withOpaque = F.edit(manifest,{put:[{...native,value:{...native.value,"x-private-view":{"precision":42}}}]});
  const old = {...project,savedViews:M.manifest(withOpaque).project.savedViews};
  const renamed = JSON.parse(JSON.stringify(old)), renaming = V.rename(old,copper.id,"Probe overview");
  P.apply(renamed,B.proposal(old,"butter.savedViews.rename",renaming.ops));
  const revised = F.edit(withOpaque,M.manifestEdits(withOpaque,renamed));
  assert.equal(revised.get(copper.id).value.name,"Probe overview");
  assert.equal(revised.get(copper.id).value["x-private-view"].precision,42);
  assert.equal(revised.get(schematic.id),withOpaque.get(schematic.id),"an unrelated saved view retains its record");
  assert.throws(() => M.checkSavedView({...copper,id:schematic.id},copper.id), /identity/);
  assert.throws(() => M.checkSavedView({...copper,camera:{...copper.camera,scale:Infinity}}), /camera/);
  assert.throws(() => M.checkSavedView({...copper,layers:{...copper.layers,hidden:["Top","Top"]}}), /layers/);
  console.log("PASS saved-view typed records, identity, native filter/layers/camera, guarded writes and state sequence");
}

main().catch(error => {console.error(error);process.exitCode=1;});
