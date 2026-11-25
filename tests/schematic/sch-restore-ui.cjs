"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {File}=require("node:buffer"),{setup,option}=require("../integration/integration.cjs");

async function run(){
  const fixture=option("--fixtures");
  if(!fixture)throw Error("Pass --fixtures DIRECTORY containing Level.Shifter.SchDoc");
  const {document,folders,ruleFiles}=await setup({demo:false});
  const sourceName="Level.Shifter.SchDoc",bytes=fs.readFileSync(path.join(fixture,sourceName));
  const parsed=AtriumSCH.read(sourceName,AtriumIO.streams(bytes),null,{appearance:false});
  const old=parsed.documents[0],project=Atrium.project("Previous release",parsed.library);
  old.sourceSha256=AtriumSourceFile.sha256(bytes);project.documents=[old];
  old.items.find(i=>i.ref==="IC5").value="Custom value";
  const status=()=>document.getElementById("status").textContent;
  const action=name=>document.querySelector('[data-action="'+name+'"]').click();
  async function wait(test){
    const deadline=Date.now()+5000;
    while(!test()){if(Date.now()>deadline)assert.fail(status());await new Promise(r=>setTimeout(r,5));}
  }
  const save=folders.save;
  function restoreButton(){
    return [...document.querySelectorAll(".import-report button")].find(n=>n.textContent.startsWith("Restore source appearance") && !n.closest("[hidden]"));
  }
  async function chooseSource(file){
    const button=restoreButton();
    assert.ok(button?.isConnected&&!button.disabled,"Restore source appearance is available");
    if(file)ruleFiles.push(file);
    button.click();assert.ok(button.disabled,"the picker is active");
    await wait(()=>!button.disabled);
  }
  const sourceImport=await AtriumTranslatorClient.import([{name:sourceName,bytes}]);
  const origin={name:sourceName,bytes,sha256:old.sourceSha256,documents:[old.id],library:project.library.map(d=>d.id)};
  const provenance={version:1,files:[origin]};
  const editable=AtriumTranslatorProvenance.separate(Atrium.clone(project),provenance);
  const entry={scopeId:"appearance-source",adopted:true,names:[sourceName],documents:[old.id],report:sourceImport.report,provenance};
  const sidecars=await AtriumImportSidecars.prepare([entry]);
  const native=AtriumFormat2Model.fromEditor({model:editable,provenance},{manifestPath:"Recovered.waffle",importIndexes:sidecars.refs});
  const members=new Map(sidecars.files);
  for(const row of native.files)members.set(row.path,AtriumFormat2.serialize(row.file));
  for(const row of [...native.models,...native.assets])members.set(row.path,row.bytes);
  await folders.openFiles(native.manifestPath,members);
  assert.equal(AtriumImportReports.recent(old.id),null,"Opening the folder leaves retained source metadata on disk");
  action("import-report");
  await wait(()=>restoreButton());
  const article=restoreButton().closest("article");
  const before=await save(),sheet=before.documents[0];
  const currentSheet=()=>JSON.parse(JSON.stringify(AtriumNavHost.doc()));
  const opened=currentSheet();
  assert.equal(sheet.schRestored,undefined);
  assert.equal(sheet.items.find(i=>i.ref==="IC5").value,"Custom value");
  await chooseSource();
  assert.deepEqual(currentSheet(),opened,"Cancel keeps the sheet unchanged");
  const wrong=new Uint8Array(bytes);wrong[wrong.length-1]^=4;
  await chooseSource(new File([wrong],sourceName));assert.match(status(),/differs from the original/);
  assert.deepEqual(currentSheet(),opened,"The rejected source keeps the sheet unchanged");
  await chooseSource(new File([bytes],sourceName));assert.match(status(),/Restored sheet appearance/);
  const saved=await save(),state=saved.documents[0];
  const source=JSON.parse(AtriumSaveCache.serialize(AtriumIO.read(sourceName,bytes))).documents[0];
  assert.deepEqual(state.schRestored.sheet,source.schDrawing);
  const wire=state.items.find(i=>i.kind==="wire");
  const record=provenance.fields.find(f=>f.type==="item"&&f.id===wire.id).values.schSource.record;
  const originalWire=source.items.find(i=>i.kind==="wire"&&i.schSource.record===record);
  assert.deepEqual(AtriumSchAppearance.displayItem(state,wire).schPaint,originalWire.schPaint);
  const ic=state.items.find(i=>i.ref==="IC5"),def=saved.library.find(d=>d.id===ic.def);
  const pins=AtriumSchAppearance.displayDef(state,ic,def).schDrawing.pins;
  assert.equal(pins.find(pin=>pin.name==="VCCA")?.number,"1");
  assert.deepEqual(state.items,sheet.items);
  assert.deepEqual(saved.library,before.library);assert.ok(!restoreButton());
  action("undo");assert.ok(restoreButton());const undone=await save();
  assert.equal(restoreButton().closest("article"),article,"Undo preserves the open report and its source references");
  assert.deepEqual(undone.documents[0],sheet);assert.deepEqual(undone.library,before.library);
  action("redo");assert.ok(!restoreButton());const redone=await save();
  assert.deepEqual(redone.documents[0],state);assert.deepEqual(redone.library,before.library);
  const viewId=article.closest("[role=tabpanel]").dataset.view;
  document.querySelector('[role=tab][data-view="'+viewId+'"] .view-tab-close').click();
  action("import-report");
  await wait(()=>document.querySelector(".import-report-details"));
  assert.ok(!restoreButton(),"a reopened report reflects the saved restoration");
  action("undo");await wait(()=>restoreButton());
  await chooseSource(new File([bytes],sourceName));
  assert.deepEqual((await save()).documents[0],state,"a second restoration applies to the current Undo revision");
  console.log("PASS saved project Import Report appearance picker, cancel, source verification, retained edits, saved appearance, undo and redo");
}
run().catch(error=>{console.error(error);process.exitCode=1;});
