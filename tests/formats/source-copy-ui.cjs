"use strict";

// Uses the production workbench and file IO with a simulated native picker/save target.
// Real source files are read-only. An optional outputs directory must already exist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { File } = require('node:buffer');
const { setup, option } = require('../integration/integration.cjs');

async function run() {
  const fixtures=option('--fixtures'), output=option('--output-dir');
  if(!fixtures)throw Error('Pass --fixtures DIRECTORY with Level.Shifter.SchDoc and qfsae-0.PcbDoc.');
  const {document,window,files,folders,ruleFiles,openPanel}=await setup();
  // Keep the design revision stable during source-copy review. A live repour
  // after moving a component is another edit and invalidates the review.
  AtriumPolygonPour.live.setMode("manual");
  const node=selector=>{const n=document.querySelector(selector);assert.ok(n,selector);return n;};
  const status=()=>document.getElementById('status').textContent;
  async function until(condition,label){
    const deadline=Date.now()+15000;
    while(!condition()){
      if(Date.now()>deadline)assert.fail(label+'; '+status()+'; '+(document.querySelector('dialog[open]')?.textContent||''));
      await new Promise(resolve=>setTimeout(resolve,6));
    }
  }
  const action=name=>node('[data-action="'+name+'"]').click();
  async function chooseComponent(ref,fromEnd=false){
    await openPanel('components');
    const list=node('#parts');
    if(fromEnd){
      const ids=new Set(AtriumNavHost.doc().items.filter(item=>item.kind==='part').map(item=>item.id));
      await until(()=>ids.has(list.querySelector('[data-part]')?.dataset.part),'show the imported board components');
      const key=new window.Event('keydown',{bubbles:true,cancelable:true});
      key.key='End';list.dispatchEvent(key);
    }
    const row=()=>[...list.querySelectorAll('[data-part]')].find(n=>n.firstElementChild?.textContent===ref);
    await until(row,'find imported component '+ref);
    row().click();await openPanel('properties');
  }
  function change(label,value){const input=node('[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new window.Event('change',{bubbles:true}));}
  function button(match){return [...document.querySelectorAll('dialog[open] button')].find(n=>match.test(n.textContent.trim()));}
  async function save(){
    const saved=await folders.saveImportedAsWaffle();
    await AtriumNavHost.folderProject().ensureImportReports();
    return AtriumTranslatorProvenance.toLegacy(saved,AtriumImportReports.provenance());
  }
  async function openCopyPanel(){
    action('export');
    await until(()=>[...node('[aria-label="Format"]').options].some(o=>o.value==='altium'),'load the retained source format');
    change('Format','altium');
  }
  async function savedFiles(){
    const lease=await AtriumProjectArchiveUI.acquireSavedExportSnapshot({project:AtriumNavHost.project(),host:AtriumNavHost});
    try {
      const zip=AtriumProjectArchive.zipDirectory((await lease.projectArchive()).bytes);
      const [root]=await zip.projects();
      return {manifest:root.manifest,files:(await AtriumProjectArchive.extract(zip,root,AtriumProjectArchive.verifyClosure)).files};
    } finally {await lease.release();}
  }
  async function openUnlinked(snapshot,docId){
    const members=new Map(snapshot.files);
    const {members:refs}=AtriumFormat2Model.manifest(AtriumFormat2Model.parse(members.get(snapshot.manifest)));
    const ref=refs.find(r=>r.kind==="import-index"), S=AtriumImportSidecars;
    const entry=S.restore(S.parse(members.get(ref.path),ref));
    assert.ok(entry.documents.includes(docId));
    delete entry.binding;
    // The original and all authored bytes remain intact. This independent fixture
    // simulates a retained foreign import whose source-layer links were never recorded.
    for(const row of entry.provenance.fields){
      if(row.type==="document" && row.id===docId)delete row.values.sourceSha256;
      if(row.type==="item"){delete row.values.sourceRecord;delete row.values.schSource;}
    }
    const modified=S.prepareSync([entry]);
    assert.equal(modified.refs[0].path,ref.path);
    members.set(ref.path,modified.files.get(ref.path));
    await folders.openFiles(snapshot.manifest,members);
    await AtriumNavHost.folderProject().ensureImportReports();
  }
  async function open(name,bytes,ok){
    const opened=()=>ok(status());
    files.clear();files.set(name,bytes);action('open');
    await until(()=>button(/^(Replace project|Don’t Save)$/)||opened(),'review '+name);
    button(/^(Replace project|Don’t Save)$/)?.click();await until(opened,'open '+name);
  }
  const results=[];
  let cancelSave=false;
  globalThis.AtriumHost.exportBinaryCopy=async(name,bytes,file)=>{
    if(cancelSave)return false;
    results.push({name,bytes,file});
    return true;
  };
  async function copy(name,original,wantChanges,rejectWrong){
    const count=results.length;await openCopyPanel();
    const choose=()=>{const b=button(/^Choose original/);assert.ok(b,'choose original button');return b.onclick();};
    assert.equal(button(/^Export$/).disabled,true);
    if(rejectWrong){
      await choose(); // Close the empty picker without selecting a file.
      assert.ok(button(/^Export$/).disabled);
      assert.equal(results.length,count);
      const wrong=new Uint8Array(original);wrong[wrong.length-1]^=4;
      ruleFiles.push(new File([wrong],name));choose();
      await until(()=>/differs from the imported original|recorded import digest|SHA-256 mismatch/i.test(node('dialog[open]').textContent),'stale original rejected');
      assert.equal(button(/^Export$/).disabled,true);assert.equal(results.length,count);
    }
    const file=new File([original],name);ruleFiles.push(file);choose();
    await until(()=>button(/^Export$/)?.disabled===false,'prepare '+name);
    const receipt=node('dialog[open]').textContent;
    for(const value of wantChanges)assert.ok(receipt.includes(value),'missing receipt value '+value+' in '+receipt);
    if(rejectWrong){
      cancelSave=true;
      await button(/^Export$/).onclick();
      assert.equal(results.length,count);assert.equal(button(/^Export$/).disabled,false);
      assert.equal(node('dialog[open]').textContent,receipt);
      cancelSave=false;
    }
    button(/^Export$/).click();await until(()=>results.length>count && !document.querySelector('dialog[open]'),'export '+name);
    const result=results.at(-1);assert.equal(result.file,file);assert.ok(result.bytes instanceof Uint8Array);
    assert.notEqual(result.name.toLowerCase(),name.toLowerCase());return result.bytes;
  }
  const schName='Level.Shifter.SchDoc',pcbName='qfsae-0.PcbDoc';
  const sch=fs.readFileSync(path.join(fixtures,schName)),pcb=fs.readFileSync(path.join(fixtures,pcbName));
  await open(schName,sch,()=>globalThis.AtriumImportReports?.sourceDocument(AtriumNavHost.doc()).sourceName===schName);
  const unedited=await copy(schName,sch,[],true);assert.deepEqual(Buffer.from(unedited),sch);
  await chooseComponent('C17');
  change('Designator','C1701');change('Comment','2.2 µF');
  const editedSch=await copy(schName,sch,['C1701','2.2 µF'],false);await save();
  const copiedComponent=AtriumIO.read(schName,editedSch).documents[0].items.find(i=>i.ref==='C1701');
  assert.equal(copiedComponent?.value,'2.2 µF','the exported component retains its edited designator and comment');
  await open(pcbName,pcb,()=>globalThis.AtriumImportReports?.sourceDocument(AtriumNavHost.doc()).sourceName===pcbName);
  await chooseComponent('Y2',true);
  change('X (mm)','38.481');change('Y (mm)','-93.472');
  const moved=await copy(pcbName,pcb,['components6/data#0','38.481','-93.472'],false);
  const reopened=AtriumIO.read(pcbName,moved),placed=reopened.documents[0].items.find(i=>i.ref==='Y2');
  assert.ok(Math.abs(placed.x-38.481)<1e-7&&Math.abs(placed.y+93.472)<1e-7);
  action('undo');action('undo');
  const project=await save(),board=project.documents.find(d=>d.sourceName===pcbName);assert.ok(board);
  const track=board.items.find(i=>i.sourceRecord==='tracks6/data#497'), via=board.items.find(i=>i.sourceRecord==='vias6/data#0');
  assert.equal(track.kind,'track');assert.equal(via.kind,'via');
  const certified=board.items.filter(item=>item.kind==="polygon" && item.copperBasis?.contours);
  assert.ok(certified.length,"the native PCB contains verified, owner-bound polygon copper");
  const pristine=await savedFiles();
  const authored=await folders.snapshot(), groups=AtriumImportReports.provenance();
  async function refuseCopperChange(change,message){
    const altered=structuredClone(authored), doc=altered.documents.find(d=>d.id===board.id);
    change(doc);
    await assert.rejects(()=>AtriumTranslatorClient.export("altium-source-copy",altered,{documentId:doc.id,
      provenance:groups,original:{name:pcbName,bytes:new Uint8Array(pcb)}}),message);
  }
  await refuseCopperChange(doc=>{
    const region=doc.pcbDrawing.pours.find(r=>certified.some(p=>p.id===r.polygon));
    const other=doc.items.find(item=>item.id!==region.polygon && item.kind==="polygon") || doc.items.find(item=>item.kind==="track");
    region.polygon=other.id;
  },/pcbDrawing field changed/);
  await refuseCopperChange(doc=>{
    doc.items.find(p=>p.id===certified[0].id).points[0][0]+=.001;
  },/standalone copper|polygon geometry/);
  const current=AtriumNavHost.doc(), updateTrack=current.items.find(i=>i.id===track.id), updateVia=current.items.find(i=>i.id===via.id);
  AtriumNavHost.edit(()=>{updateTrack.width=.3302;updateVia.drill=.6096;},"Edit width and drill",[updateTrack,updateVia]);
  await save();
  const modified=await savedFiles();
  await folders.reopen();
  await AtriumNavHost.folderProject().ensureImportReports();
  const b=document.querySelector('[data-doc="'+board.id+'"]');assert.ok(b);b.click();
  const editedPcb=await copy(pcbName,pcb,['0.3302','0.6096'],false);
  const copiedItems=AtriumIO.read(pcbName,editedPcb).documents[0].items;
  const copiedTrack=copiedItems.find(i=>i.sourceRecord===track.sourceRecord);
  const copiedVia=copiedItems.find(i=>i.sourceRecord===via.sourceRecord);
  assert.ok(Math.abs(copiedTrack.width-.3302)<1e-7,'the exported track retains its edited width');
  assert.ok(Math.abs(copiedVia.drill-.6096)<1e-7,'the exported via retains its edited drill');
  await openUnlinked(modified,board.id);
  node('[data-doc="'+board.id+'"]').click();await openCopyPanel();
  ruleFiles.push(new File([pcb],pcbName));await button(/^Choose original/).onclick();
  assert.match(node('dialog[open]').textContent,/older import has edited or reordered objects/i);
  assert.equal(button(/^Export$/).disabled,true);button(/^Cancel$/).click();
  await openUnlinked(pristine,board.id);
  node('[data-doc="'+board.id+'"]').click();await openCopyPanel();
  ruleFiles.push(new File([pcb],pcbName));await button(/^Choose original/).onclick();
  const link=button(/^Link source/);assert.equal(link.hidden,false,node('dialog[open]').textContent);assert.equal(button(/^Export$/).disabled,true);
  await link.onclick();assert.equal(button(/^Export$/).disabled,false);
  await button(/^Export$/).onclick();assert.deepEqual(Buffer.from(results.at(-1).bytes),pcb);
  const linked=(await save()).documents.find(d=>d.id===board.id);
  assert.match(linked.sourceSha256,/^[0-9a-f]{64}$/);assert.ok(linked.items.every(i=>i.sourceRecord));
  if(output){for(const [name,bytes] of [['Edited.SchDoc',editedSch],['Edited.PcbDoc',editedPcb]])fs.writeFileSync(path.join(output,name),bytes,{flag:'wx'});}
  assert.deepEqual(fs.readFileSync(path.join(fixtures,schName)),sch);assert.deepEqual(fs.readFileSync(path.join(fixtures,pcbName)),pcb);
  console.log('PASS native-copy workbench: picker and save cancellation, stale source refusal, exact no-op copy, receipt, schematic property edits, saved native PCB revisions and explicit original-source linking');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
