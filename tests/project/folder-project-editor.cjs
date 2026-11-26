"use strict";
// Exercise the real editor entry points with the real session/codec and an in-memory native host.
const assert = require("node:assert/strict");
const {setup} = require("../integration/integration.cjs");
const {createHash} = require("node:crypto");
const {Worker} = require("node:worker_threads");
const {execFileSync} = require("node:child_process");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const hash = b => createHash("sha256").update(b).digest("hex");
const td = new TextDecoder(), te = new TextEncoder();

(async () => {
  const {document,window} = await setup({demo:false});
  await AtriumLazy.need(["AtriumFormat2Closure","AtriumAI"]);
  const C = AtriumFormat2, M = AtriumFormat2Model, H = AtriumNavHost;
  const native = AtriumHost, writes = [], reads = [], acknowledgements = [], readGroups = [], closed = [];
  let leases = 0, refuseBatch = false, cancelWrite = false, lastPlan, rejectTableProof=false;
  const sentPlans=[], benchTables=process.argv.includes("--benchmark-table-save");
  const paths = new Map(), manifest = "Folder.waffle", entry = {grant:"root",manifest,name:"Folder"};
  const owner = {formatVersion:"2.0",kind:"project",name:"Folder",id:"abc",entryDocument:"sheet"};
  const r = (id,name,kind) => ({kind:"document",id,docKind:kind,name,path:name+(kind==="pcb"?".wpcb":".wsch")});
  const sheet = r("sheet","One","schematic"), board = r("board","Two","pcb");
  paths.set(manifest,C.serialize(C.create(owner,[sheet,board])));
  for (const ref of [sheet,board]) {
    paths.set(ref.path,C.serialize(M.createDocument({...Atrium.sheet(ref.docKind,ref.name),id:ref.id,
      items:[{kind:"netlabel",id:"name-"+ref.id,x:1.27,y:2.54,text:"Design"}]})));
  }
  const workerPool = globalThis.AtriumWorkerPool;
  function startWorker(name) {
    const worker = new Worker(`
      const {workerData,parentPort} = require("node:worker_threads");
      const {dirname, resolve} = require("node:path");
      globalThis.self = globalThis;
      globalThis.importScripts = (...files) => {
        for (const file of files) {
          const installed = require(resolve(dirname(workerData.entry), file));
          if (file === "../vendor/cfb.min.js") globalThis.CFB = installed;
        }
      };
      globalThis.postMessage = (result,transfer) => parentPort.postMessage(result,transfer);
      require(workerData.entry);
      parentPort.on("message",data => globalThis.onmessage({data}));
    `,{eval:true,workerData:{entry:path.join(__dirname,"../../app",name)}});
    const browser = {postMessage(message,...args){
      if(name==="workers/folder-project-worker.js" && message.op==="plan"){
        sentPlans.push(message.changes.map(({id,put,tableCells})=>({id,owners:put.length,cells:tableCells?.length??0})));
        if(rejectTableProof && message.changes.some(change=>change.tableCells?.length)){
          rejectTableProof=false;
          message={...message,changes:message.changes.map(change=>change.tableCells?.length?{...change,tableBase:"stale-proof"}:change)};
        }
      }
      worker.postMessage(message,...args);
    },terminate:()=>worker.terminate()};
    worker.on("message",data => browser.onmessage?.({data}));
    worker.on("error",error => browser.onerror?.(error));
    return browser;
  }
  globalThis.AtriumWorkerPool = {...workerPool,
    script(name) {return name === "workers/folder-project-worker.js" ? startWorker(name) : workerPool.script(name);},
    get(name, ...args) {
      // Run the calculation graph directly in the LinkeDOM harness. Folder saves still use a worker.
      return name === "calculations" ? {run:async task => AtriumCalculationGraph.task(task)} : workerPool.get(name,...args);
    }
  };
  globalThis.Worker = function(){return startWorker("workers/import-worker.js");};
  Object.assign(native,{
    async open() { return [{name:manifest,folderProject:entry}]; },
    finishedOpening(ok) { acknowledgements.push(ok); },
    async folderReadLease() { return {lease:"reader-"+ ++leases}; },
    async folderRead({lease,paths:list}) {
      readGroups.push({lease,paths:list});
      if (refuseBatch && list.length>1) throw Error("Mock native aggregate read byte limit.");
      if (list.some(path=>!paths.has(path))) throw Error("A project member is missing.");
      reads.push(...list);
      return {files:list.map(path=>({path,bytes:paths.get(path),sha256:hash(paths.get(path)),length:paths.get(path).length}))};
    },
    async folderRelease() {}, async folderAdopt() {return true;},
    async folderClose({grant}) {closed.push(grant);}, async folderLocalState(){return {}},
    async folderCommit({plan}) {
      if (cancelWrite) { cancelWrite = false; throw Error("Cancelled write"); }
      lastPlan = plan;
      writes.push(plan.map(r=>r.path));
      const hashes={};
      for (const item of plan) {
        const previous=paths.get(item.path);
        assert.equal(item.expected,previous?hash(previous):null);
        let text=td.decode(previous),out="",at=0;
        for (const {offset,remove,insert} of item.splice.edits) {out+=text.slice(at,offset)+insert;at=offset+remove;}
        const bytes=te.encode(out+text.slice(at));
        hashes[item.path]=hash(bytes);paths.set(item.path,bytes);
      }
      return {saved:true,transaction:"txn",hashes};
    }
  });
  async function until(f,message) {
    for(let t=Date.now()+4000;!f();){if(Date.now()>t)assert.fail(message+"; "+document.getElementById("status").textContent);await new Promise(r=>setTimeout(r,10));}
  }
  document.querySelector('[data-action="open"]').click();
  await until(()=>acknowledgements.length,"normal File Open acknowledged folder adoption");
  assert.deepEqual(acknowledgements,[true]);
  assert.ok(H.folderProject());
  assert.equal(H.currentId(), sheet.id);
  assert.deepEqual(reads.slice(0,2),[manifest,sheet.path]);
  assert.equal(H.doc().items[0].text,"Design");
  assert.deepEqual([H.doc().items[0].x,H.doc().items[0].y],[1.27,2.54]);
  const session=H.folderProject();
  {
    const power = AtriumPower.state();
    const savedSnapshot = () => session.requireClosure({purpose:"explicit saved verification",saved:true});
    AtriumPower.host({occluded:true});
    try {
      const start = readGroups.length;
      const saved = await savedSnapshot();
      const first = readGroups.slice(start);
      const group = first.find(call => call.paths.length>1);
      assert.deepEqual(new Set(group?.paths),new Set([sheet.path,board.path]));
      assert.ok(first.every(call => call.lease===group.lease));
      assert.equal(saved.project.documents.length,2);
      assert.equal(H.currentId(),sheet.id,"the saved verifier leaves the visible sheet selected");
      refuseBatch = true;
      const again = await savedSnapshot();
      assert.equal(again.version,saved.version,"splitting a refused batch verifies the same full snapshot");
      assert.deepEqual(again.project,saved.project);
      const original = paths.get(board.path);
      paths.delete(board.path);
      try { await assert.rejects(savedSnapshot(), /member is missing/); }
      finally { paths.set(board.path,original); }
    } finally {
      refuseBatch = false; AtriumPower.host({occluded:power.occluded});
    }
  }
  await H.selectDocument(board.id);
  assert.equal(H.currentId(),board.id);
  const item=H.doc().items[0];
  H.edit(()=>{item.text="Changed";},"Edit label",[item.id],{documents:[board.id],items:[item.id]});
  assert.equal(session.modified(board.id),true);
  const docs = H.project().documents, other = docs.findIndex(d => d.id === sheet.id);
  assert.ok(other >= 0);
  const own = Object.getOwnPropertyDescriptor(docs,other);
  let unrelated = 0, readerRefreshes = 0;
  const wasOccluded = AtriumPower.state().occluded;
  AtriumPower.host({occluded:true});
  // The edit already queued a Problems status update. Let it finish before watching Save.
  await Promise.resolve();
  Object.defineProperty(docs,other,{configurable:true,get() {
    unrelated++; throw Error("Saving a board visited an unrelated sheet.");
  }});
  const stopReaderRefresh = H.on("saved-write-pending", pending => {
    if (!pending) return;
    readerRefreshes++;
    H.moduleLoaded("AtriumStackup");
  });
  try { assert.equal(await H.saveProject(),true); }
  finally {
    stopReaderRefresh();
    Object.defineProperty(docs,other,own);
    AtriumPower.host({occluded:wasOccluded});
  }
  assert.equal(readerRefreshes,1,"the reader notification runs during the scoped write");
  assert.equal(unrelated,0);
  assert.deepEqual(writes,[[board.path]]);
  assert.equal(session.dirty,false);
  {
    const view = H.view(), pending = view.saveWritePending, states = [];
    view.saveWritePending = flag => {states.push(flag);pending(flag);};
    try {
      H.edit(()=>{item.text="Abandoned";},"Edit before a cancelled save",[item]);
      cancelWrite = true;
      const result = H.saveProject();
      assert.equal(states[0],true,"capturing the active-file row defers projections before posting to native");
      assert.equal(await result,false);
      assert.equal(states.at(-1),false,"the cancelled write releases the derived hold");
      assert.equal(session.modified(board.id),true,"the failed write leaves the new row dirty");
      assert.deepEqual(writes,[[board.path]]);
      H.act("undo");
      assert.equal(item.text,"Changed");
      await until(()=>!session.modified(board.id),"undo after the cancelled write returns to the durable row");
    } finally { view.saveWritePending = pending; }
  }
  H.act("undo");
  assert.equal(H.doc().items[0].text,"Design");
  assert.equal(session.modified(board.id),true,"Undo after a save creates a pending owner edit");
  await H.saveAll();
  assert.deepEqual(writes,[[board.path],[board.path]]);
  assert.match(td.decode(paths.get(board.path)),/"text":"Design"/);
  const project=H.project(), edited=structuredClone(project), originalSheet=paths.get(sheet.path);
  edited.documents.find(d=>d.id===board.id).items[0].text="Proposal value";
  const saved=await H.requireProjectClosure({saved:true,purpose:"proposal"});
  const {proposal}=AtriumProposal.build(project,edited,{source_sha256:saved.version,allowV1:false});
  proposal.format2_base={project_id:project.id};
  const reviewers={folderProject:session,project,currentProject:H.project,defs:H.defs(),edit:H.edit};
  await AtriumAI.prepareFolderProposal(reviewers,proposal);
  const savedSheet=M.parse(originalSheet,{kind:"schematic"});
  paths.set(sheet.path,C.serialize(C.edit(savedSheet,{put:[{...savedSheet.get("name-sheet"),text:"New saved sibling"}]})));
  await assert.rejects(AtriumAI.prepareFolderProposal(reviewers,proposal),/saved project changed/i);
  assert.equal(H.doc().items[0].text,"Design");
  paths.set(sheet.path,originalSheet);
  await AtriumAI.prepareFolderProposal(reviewers,proposal);
  assert.equal(AtriumAI.apply(reviewers,proposal),1);
  assert.equal(H.doc().items[0].text,"Proposal value");
  H.act("undo");
  assert.equal(H.doc().items[0].text,"Design");
  await until(()=>!session.dirty,"Undo to the saved row clears the unsaved marker");
  const disk = M.parse(paths.get(board.path),{kind:"pcb"});
  paths.set(board.path,C.serialize(C.edit(disk,{put:[{...disk.get("name-board"),text:"External edit"}]})));
  await session.synchronize([board.path]);
  assert.equal(H.doc().items[0],item,"disk refresh retains the authoring identity used by Undo");
  assert.equal(item.text,"External edit");
  assert.equal(H.isDirty(),false);
  const additive = JSON.parse(fs.readFileSync(path.join(__dirname,"../../native/tests/folder-transaction/additive.json"),"utf8"));
  for (const [name,text] of Object.entries(additive.files)) paths.set(name,te.encode(text));
  const withFuture = {grant:"additive",manifest:additive.manifest,name:"Forward sensor"};
  const beforeAdditive = reads.length;
  assert.equal(await H.openFiles([{name:additive.manifest,folderProject:withFuture}]),true);
  const sense = H.doc().items[0];
  assert.deepEqual([sense.x,sense.y,sense.text],[0.001,0.002,"SENSE"]);
  H.edit(() => Object.assign(sense,{x:0.0011,y:0.0022,text:"DRIVE"}),"Edit label",[sense.id],
    {documents:[H.currentId()],items:[sense.id]});
  assert.equal(await H.saveProject(),true);
  assert.deepEqual(writes.at(-1),[additive.member]);
  const moved = additive.files[additive.member], rowOffset = te.encode(moved.slice(0,moved.indexOf(additive.edit.from))).length;
  assert.deepEqual(lastPlan,[{path:additive.member,expected:additive.expected,splice:{base:additive.expected,
    edits:[{offset:rowOffset,remove:te.encode(additive.edit.from).length,insert:additive.edit.to}]}}]);
  assert.equal(hash(paths.get(additive.member)),additive.desired);
  assert.equal(td.decode(paths.get(additive.manifest)),additive.files[additive.manifest]);
  assert.equal(td.decode(paths.get(additive.opaque)),additive.files[additive.opaque]);
  assert.ok(!reads.slice(beforeAdditive).includes(additive.opaque));

  {
    await AtriumPrefs.set("labs.notebook",true);
    for (const feature of ["tables", "numericFields", "links"]) await AtriumPrefs.set("butter."+feature,true);
    await AtriumLazy.need(["AtriumButterEditor", "AtriumTableFormat", "AtriumSheetWidgets", "AtriumLinkRecord"]);
    const T = AtriumTableData, run = AtriumButterEditor.apply;
    const project = Atrium.project("Native binding edits");
    const a = Atrium.sheet("schematic","Table A"), b = Atrium.sheet("schematic","Table B");
    const untouched = project.documents[1];
    project.documents = [a,b,untouched];
    const prepare = doc => {
      const item = AtriumSheetWidgets.make("table",[1,1]);
      const large=benchTables&&doc===b;
      let state = T.create(large?1000:1,large?50:1,Atrium.id);
      const rowId = state.rows[0].id, columnId = state.columns[0].id;
      if(large)state=T.batch(state,state.rows.flatMap(row=>state.columns.slice(0,32).map(column=>({
        rowId:row.id,columnId:column.id,content:{kind:"literal",text:"1"}
      }))));
      else state = T.change(state,rowId,columnId,{content:{kind:"literal",text:"1"}});
      item.widget = {...item.widget,state}; doc.items.push(item);
      return {target:T.target(doc.id,item.id,rowId,columnId),rowId,columnId};
    };
    const first = prepare(a), second = prepare(b);
    const link = AtriumLinkRecord.authoredRecord({objectId:a.id,kind:"schematic"},{projectId:project.id,objectId:b.id},"Check sheet");
    project.links = {[link.id]:link};
    const nativeProject = M.fromEditor(project);
    for (const row of nativeProject.files) paths.set(row.path,C.serialize(row.file));
    const root = nativeProject.manifestPath;
    const raw = td.decode(paths.get(root)).replace('"projectId":"'+project.id+'"','"projectId":"'+project.id+'","x-opaque":9.1987e65');
    assert.match(raw,/"x-opaque":9\.1987e65/);
    paths.set(root,te.encode(raw));
    const refPath = id => nativeProject.files.find(r=>r.file.header.id===id).path;
    const unchanged = paths.get(refPath(untouched.id));
    let opens = 0;
    const openBindings = () => H.openFiles([{name:root,folderProject:{grant:"binding-"+ ++opens,manifest:root,name:project.name}}]);
    const savedBindings = async () => (await H.folderProject().requireClosure({purpose:"saved table test",saved:true})).project;
    const verify = (saved, data, text, source) => {
      const value = T.resolveTarget(saved,data.target)?.cell?.content;
      const binding = saved.numericExpressions?.find(entry=>entry.target.documentId===data.target.documentId);
      assert.equal(value?.text,text);
      assert.equal(binding?.source,source);
    };
    async function saveDependents(...expected) {
      const before = writes.length;
      const saving = H.saveProject();
      const approval = () => [...document.querySelectorAll("dialog[open] button")].find(node=>node.textContent==="Save All");
      await until(approval,"active Save requests approval for the related owners");
      assert.equal(writes.length,before);
      approval().click();
      assert.equal(await saving,true);
      assert.equal(writes.length,before+1);
      assert.deepEqual(new Set(writes.at(-1)),new Set([root,...expected.map(refPath)]));
      assert.deepEqual(paths.get(refPath(untouched.id)),unchanged);
      return savedBindings();
    }
    const set = async ({target},source) => assert.equal((await run("butter.numericFields.set",{target,source})).result.ok,true);
    assert.equal(await openBindings(),true);
    await H.selectDocument(a.id);
    assert.equal(H.currentId(),a.id);
    assert.equal((await run("butter.links.rebind",{recordId:link.id,url:`waffle://${project.id}/${untouched.id}`})).changes,1);
    assert.equal(await H.saveAll(),true);
    assert.deepEqual(writes.at(-1),[root]);
    assert.equal(td.decode(paths.get(root)),raw.replace('"objectId":"'+b.id+'"','"objectId":"'+untouched.id+'"'));
    assert.equal((await savedBindings()).links[link.id].id,link.id);
    await set(first,"=8+9");
    verify(await saveDependents(a.id),first,"17","8+9");
    assert.equal(await openBindings(),true);
    await H.selectDocument(a.id);
    verify(H.project(),first,"17","8+9");
    const replace = () => run("butter.tables.edit-cells",{documentId:a.id,itemId:first.target.itemId,
      cells:[{rowId:first.rowId,columnId:first.columnId,content:{kind:"literal",text:"12"}}]});
    assert.equal((await replace()).changes,2);
    verify(await saveDependents(a.id),first,"12",undefined);
    H.act("undo");
    verify(await saveDependents(a.id),first,"17","8+9");
    H.act("redo");
    verify(await saveDependents(a.id),first,"12",undefined);
    await set(first,"=9+9");
    await H.selectDocument(b.id);
    await set(second,"=2+3");
    assert.equal((await H.folderProject().save({documentId:b.id})).needsSaveAll,true);
    await H.selectDocument(a.id);
    const both = await saveDependents(a.id,b.id);
    verify(both,first,"18","9+9");
    verify(both,second,"5","2+3");
    assert.equal(await openBindings(),true);
    await H.selectDocument(a.id);
    await H.selectDocument(b.id);
    verify(H.project(),first,"18","9+9");
    verify(H.project(),second,"5","2+3");
    const active=H.folderProject(),target=H.doc().items.find(item=>item.id===second.target.itemId);
    const editCell=(text,scoped=true)=>{
      const prior=target.widget.state,state=T.change(prior,second.rowId,second.columnId,{content:text===null?null:{kind:"literal",text}});
      return H.edit(()=>{
        T.clearReplacedNumericTargets(H.project(),b.id,target,prior,state);
        target.widget={...target.widget,state};
      },"Edit table cell",scoped?[T.cellUndoScope(H.doc(),target,prior,state)]:[target]);
    };
    editCell("6");
    verify(await saveDependents(b.id),second,"6",undefined);
    assert.deepEqual(sentPlans.at(-1),[{id:b.id,owners:0,cells:1}]);
    H.act("undo");
    verify(await saveDependents(b.id),second,"5","2+3");
    assert.deepEqual(sentPlans.at(-1),[{id:b.id,owners:0,cells:1}]);
    H.act("redo");
    verify(await saveDependents(b.id),second,"6",undefined);
    assert.deepEqual(sentPlans.at(-1),[{id:b.id,owners:0,cells:1}]);
    const manifestSaved=paths.get(root),ownerPath=refPath(b.id);
    for(const scoped of benchTables?[true,false]:[true]){
      const samples=[],retained=globalThis.AtriumUndoStore;
      if(!scoped)globalThis.AtriumUndoStore={...retained,tableCellEdit:()=>null};
      try{
        for(let i=0;i<(benchTables?30:1);i++){
          const text=String(11+i),started=performance.now();
          const beforeRecord=globalThis.AtriumUndoStore.stats();
          editCell(text,scoped);
          const recordMs=performance.now()-started;
          const afterRecord=globalThis.AtriumUndoStore.stats();
          assert.equal(afterRecord.tableCells-beforeRecord.tableCells,Number(scoped));
          if(scoped)assert.equal(afterRecord.tableSnapshots,beforeRecord.tableSnapshots);
          assert.equal(await H.saveProject(),true);
          const measured=active.metrics().lastSave;
          samples.push({recordMs,editorMs:measured.editorMs,planMs:measured.planReady-measured.started,ackMs:measured.acknowledged-measured.started});
          assert.deepEqual(sentPlans.at(-1),[{id:b.id,owners:Number(!scoped),cells:Number(scoped)}]);
          assert.equal(measured.rowsEncoded,1);
          assert.equal(measured.splices,1);
          assert.deepEqual(writes.at(-1),[ownerPath]);
        }
      }finally{globalThis.AtriumUndoStore=retained;}
      if(benchTables){
        const summary=Object.fromEntries(Object.keys(samples[0]).map(key=>{
          const values=samples.map(row=>row[key]).sort((a,b)=>a-b);
          return [key,{median:(values[14]+values[15])/2,p95:values[28],max:values.at(-1)}];
        }));
        console.log("32,000 cells via Editor Save, "+(scoped?"certified cell":"whole table fallback")+" (mock native acknowledgement, milliseconds): "+JSON.stringify(summary));
      }
    }
    rejectTableProof=true;
    editCell("100");
    assert.equal(await H.saveProject(),true);
    assert.deepEqual(sentPlans.slice(-2),[[{id:b.id,owners:0,cells:1}],[{id:b.id,owners:1,cells:0}]]);
    assert.deepEqual(paths.get(root),manifestSaved);
    verify({...H.project(),documents:[M.document(M.parse(paths.get(ownerPath)))]},second,"100",undefined);
    editCell(null);
    assert.equal(await H.saveProject(),true);
    assert.deepEqual(sentPlans.at(-1),[{id:b.id,owners:0,cells:1}]);
    assert.equal(active.metrics().lastSave.splices,1);
    verify({...H.project(),documents:[M.document(M.parse(paths.get(ownerPath)))]},second,undefined,undefined);
    editCell("101");
    assert.equal(await H.saveProject(),true);
    assert.deepEqual(sentPlans.at(-1),[{id:b.id,owners:0,cells:1}]);
    assert.equal(active.metrics().lastSave.rowsEncoded,1);
    verify({...H.project(),documents:[M.document(M.parse(paths.get(ownerPath)))]},second,"101",undefined);
    const beforeUnsaved=AtriumUndoStore.stats().tableSnapshots;
    editCell("102");
    H.act("undo");assert.equal(active.modified(b.id),false);
    H.act("redo");assert.equal(active.modified(b.id),true);
    H.act("undo");assert.equal(active.modified(b.id),false);
    assert.equal(AtriumUndoStore.stats().tableSnapshots,beforeUnsaved);
    if(!benchTables){
      H.edit(()=>{H.doc().items.splice(H.doc().items.indexOf(target),1);},"Remove table",[target]);
      assert.equal(await H.saveProject(),true);
      assert.equal(M.document(M.parse(paths.get(ownerPath))).items.some(item=>item.id===target.id),false);
      H.act("undo");
      assert.equal(await H.saveProject(),true);
      verify({...H.project(),documents:[M.document(M.parse(paths.get(ownerPath)))]},second,"101",undefined);
    }
  }

  const large = {grant:"many-references",manifest:"Many.waffle",name:"Many"};
  const dormant = Array.from({length:1000},(_,i) => {
    const ref = r("dormant-"+i,"Dormant "+i,"schematic");
    return {...ref,path:"Dormant/"+ref.path,order:String(1000-i).padStart(4,"0")+"1"};
  });
  const target = dormant[0];
  paths.set(large.manifest,C.serialize(C.create(owner,[sheet,...dormant])));
  paths.set(target.path,C.serialize(M.createDocument({...Atrium.sheet("schematic",target.name),id:target.id,
    items:[{kind:"netlabel",id:"dormant-label",x:1.27,y:2.54,text:"Opened by Explorer"}]})));
  const power = AtriumPower.mode();
  AtriumPower.setMode("always");
  const tree = document.getElementById("documents");
  const rows = () => [...tree.querySelectorAll("button[data-doc]")].map(node => node.dataset.doc);
  let firstRows;
  const stopObserving = H.on("frame",() => {
    if (H.folderProject()?.grant === large.grant) firstRows ??= rows();
  });
  try {
    const before = reads.length;
    assert.equal(await H.openFiles([{name:large.manifest,folderProject:large}]),true);
    const largeSession = H.folderProject();
    const more = () => [...tree.querySelectorAll("button")].find(node => node.textContent === "Show more documents");
    await until(more,"the first Explorer page opens");
    assert.deepEqual(firstRows,[sheet.id],"the first frame has only the open document");
    assert.ok(rows().length <= 48,"the first page is bounded");
    assert.equal(H.currentId(),sheet.id);
    assert.equal(H.project().documents.length,1);
    assert.deepEqual(reads.slice(before),[large.manifest,sheet.path]);
    for (let page = 0; more() && page < 25; page++) more().click();
    assert.ok(!more(),"the last page is reachable");
    assert.deepEqual(rows(),[sheet.id,...dormant.toReversed().map(ref => ref.id)]);
    assert.deepEqual(reads.slice(before),[large.manifest,sheet.path],"paging reads only manifest metadata");
    tree.querySelector('[data-doc="'+target.id+'"]').click();
    await until(() => H.currentId() === target.id,"opening the last Explorer row reaches its real owner");
    assert.equal(H.doc().items[0].text,"Opened by Explorer");
    assert.deepEqual(reads.slice(before),[large.manifest,sheet.path,target.path]);
    for (const [name,ref,error] of [
      ["Duplicate",{...dormant[1],name:"dOrmanT 0",path:"dormant/dOrmanT 0.wsch"},/Duplicate manifest member path/],
      ["Private",{...target,path:".WAFFLE/private/"+target.name+".wsch"},/Private paths/],
      ["Traversal",{...target,path:"../"+target.path},/Invalid portable project path component/],
      ["Wrong name",{...target,path:"Dormant/Other.wsch"},/Invalid manifest member path/]
    ]) {
      const invalid = {grant:"invalid-"+name,manifest:name+".waffle",name};
      paths.set(invalid.manifest,C.serialize(C.create(owner,[sheet,ref,...dormant.filter(row => row.id !== ref.id)])));
      const beforeInvalid = reads.length;
      assert.equal(await H.openFiles([{name:invalid.manifest,folderProject:invalid}]),false);
      assert.match(document.getElementById("status").textContent,error);
      assert.deepEqual(reads.slice(beforeInvalid),[invalid.manifest]);
      assert.equal(closed.at(-1),invalid.grant);
      assert.equal(H.folderProject(),largeSession);
      assert.equal(H.currentId(),target.id);
      [...document.querySelectorAll("dialog\u005bopen\u005d button")].find(button => button.textContent === "Done").click();
    }
  } finally {stopObserving(); AtriumPower.setMode(power);}
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(),"waffle-sibling-proof-"));
  try {
    const old = path.join(__dirname,"../fixtures/compat/projects/v1.5-altium-geometry.waffle");
    const exact = fs.readFileSync(old), active = H.folderProject(), selected = H.currentId();
    let source = new File([exact],"Source.waffle"), published, copiedManifest, installs = 0;
    let choice = "cancel", prompts = 0, drafts = 0, retired = 0, bound, failInstall = false, cancelLocation = false, locations = [];
    globalThis.AtriumImportSaveView = {hint() {},clearHint() {},async firstSave(value) {
      prompts++; assert.equal(value.file,source); return choice;
    }};
    globalThis.AtriumImportExport = {async recall() { return null; }};
    globalThis.AtriumForeignDrafts = {...globalThis.AtriumForeignDrafts,
      needsReview: host => !!host.importSession(),
      schedule() {},
      async begin({pending,model,entries}) {
        assert.notEqual(H.project(),model,"private draft is prepared before replacing the editor");
        assert.equal(pending.id,entries[0].scopeId);
        assert.equal(pending.nativeKey,"source-proof");
        drafts++;
      },
      async retire() {retired++;}
    };
    Object.assign(native,{
      canConvertSibling:file => file === source,
      importSaveKey:file => file === source ? "source-proof" : null,
      bindImportSave({file,files}) {
        assert.equal(file,source);
        assert.equal(files.length,3);
        assert.equal(H.importSession()?.sourceKey,"source-proof");
        bound=file;
        return "source-proof";
      },
      async folderLocateImportSource() {return {git:null};},
      async folderConvertSibling({file,manifest:next,files,version,folderName,signal}) {
        assert.equal(file,source,"the authorized originally selected file is used");
        assert.equal(signal.aborted,false);
        locations.push(folderName);
        // The host's location panel was dismissed: nothing is written.
        if(cancelLocation)return false;
        if(failInstall)throw Error("Test installation failure.");
        const verified = JSON.parse(execFileSync("python3",["-c",`
import json, pathlib, sys
from native.project_archive import install
job = json.load(sys.stdin)
installed = install(pathlib.Path(job["parent"]).resolve(), job["manifest"], job["files"], job["version"])
print(json.dumps(str(installed)))
`],{cwd:path.join(__dirname,"../.."),input:JSON.stringify({parent:scratch,manifest:next,files,version}),encoding:"utf8"}));
        published = path.dirname(verified);
        copiedManifest = verified;
        for (const {path:member} of files) paths.set(member,new Uint8Array(fs.readFileSync(path.join(published,member))));
        const folderProject = {grant:"copy-"+(++installs),name:path.basename(published),manifest:next};
        return installs === 1 ? folderProject : {name:next,folderProject};
      }
    });
    async function openSelection(selection) {
      let opened;
      const opening = H.openFiles(selection).then(result => {opened=result; return result;});
      const replaceButton = () => [...document.querySelectorAll("dialog[open] button")].find(b=>b.textContent==="Replace project");
      await until(replaceButton,"editor confirms replacement");
      replaceButton().onclick();
      await until(()=>opened!==undefined,"normal source import finishes");
      assert.equal(await opening,true,document.getElementById("status").textContent);
    }
    assert.equal(await H.openFiles([source]),false);
    assert.equal(document.getElementById("status").textContent,AtriumObsoleteProject.note);
    assert.equal(H.folderProject(),active);
    assert.equal(H.currentId(),selected);
    assert.equal(installs,0);
    assert.deepEqual(fs.readFileSync(old),exact);
    [...document.querySelectorAll("dialog[open] button")].find(button=>button.textContent==="Done").click();
    const folder = path.join(__dirname,"../fixtures/altium/pidp11-io-expander");
    const originals = new Map(fs.readdirSync(folder).filter(name => /\.(PrjPcb|PcbDoc|SchDoc)$/i.test(name))
      .map(name => [name,fs.readFileSync(path.join(folder,name))]));
    const altium = [...originals].map(([name,bytes]) => {
      fs.writeFileSync(path.join(scratch,name),bytes);
      const chosen = new File([bytes],name);
      Object.defineProperty(chosen,"altiumPath",{value:name});
      return chosen;
    });
    source = altium.find(file => /\.PrjPcb$/i.test(file.name));
    await openSelection(altium);
    assert.equal(H.folderProject(),undefined);
    assert.equal(H.importSession().state,"unsaved");
    assert.equal(H.isDirty(),true);
    assert.equal(installs,0,"Open did not install a destination");
    assert.equal(prompts,0);
    assert.equal(drafts,1);
    assert.equal(bound,source);
    const pendingId = H.importSession().id;
    assert.equal(await H.saveProject(),false);
    assert.equal(H.importSession().id,pendingId);
    assert.equal(H.isDirty(),true);
    assert.equal(installs,0);
    assert.equal(retired,0);
    const authored = H.documentRefs().find(doc=>doc.kind==="schematic");
    await H.selectDocument(authored.id);
    H.edit(()=>H.doc().items.push({id:"first-save-edit",kind:"netlabel",x:25.4,y:12.7,text:"AFTER_IMPORT"}),"Place net label");
    choice="waffle";
    failInstall=true;
    assert.equal(await H.saveProject(),false);
    assert.equal(H.importSession().id,pendingId);
    assert.ok(H.isDirty() && H.doc().items.some(item=>item.id==="first-save-edit"));
    assert.equal(installs,0);
    assert.equal(retired,0);
    failInstall=false;
    // Cancelling the save-location choice keeps the import open, dirty and unwritten.
    cancelLocation=true;
    const scratchBefore=fs.readdirSync(scratch).sort();
    assert.equal(await H.saveProject(),false);
    assert.equal(H.importSession().id,pendingId);
    assert.ok(H.isDirty() && H.doc().items.some(item=>item.id==="first-save-edit"));
    assert.equal(H.folderProject(),undefined);
    assert.deepEqual(fs.readdirSync(scratch).sort(),scratchBefore,"a cancelled location writes nothing");
    assert.equal(installs,0);
    assert.equal(retired,0);
    assert.equal(locations.at(-1),"PCB-PiDP11IOExpander","the host suggests the first-save project name");
    cancelLocation=false;
    const first = H.saveProject(), second = H.saveAll();
    assert.deepEqual(await Promise.all([first,second]),[true,true]);
    assert.equal(prompts,4,"simultaneous saves share a single first-save decision");
    assert.equal(installs,1);
    assert.equal(retired,1);
    assert.equal(H.importSession(),null);
    assert.equal(H.isDirty(),false);
    assert.ok(H.doc().items.some(item=>item.id==="first-save-edit" && item.text==="AFTER_IMPORT"));
    const session2 = H.folderProject();
    assert.equal(H.currentId(),M.parse(fs.readFileSync(copiedManifest),{kind:"project"}).header.entryDocument);
    assert.deepEqual(session2.documents().map(doc => doc.kind).sort(),["pcb","schematic"]);
    assert.ok(session2.importIndexes().length > 0);
    assert.ok(fs.readdirSync(path.join(published,"models")).some(name => name.endsWith(".step.gz")));
    for (const [name,bytes] of originals) {
      assert.deepEqual(fs.readFileSync(path.join(scratch,name)),bytes);
      assert.deepEqual(fs.readFileSync(path.join(published,".waffle","imports",hash(bytes),"source")),bytes);
    }
    await H.folderProject().close();
  } finally {fs.rmSync(scratch,{recursive:true,force:true});}
  console.log("PASS folder editor Open, 1,000 dormant documents, invalid manifest isolation, Save, Undo, reload, additive 2.1 and explicit first Save of an imported design");
  void window;
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
