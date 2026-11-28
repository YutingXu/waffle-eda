"use strict";
const assert = require("node:assert/strict");
// The command-line JavaScriptCore runner has no Web Crypto global. This test needs unique window
// identities only; the signed WebKit acceptance exercises real random IDs and native receipts.
if (!globalThis.crypto) { let id=0; globalThis.crypto={randomUUID:() => "test-window-"+(++id)}; }
if (!globalThis.AtriumFolderDrafts) require("../../app/project/folder-drafts.js");
const D = globalThis.AtriumFolderDrafts;
function shelf() {
  const data = new Map();
  let fail;
  return { set fail(value) {fail=value;}, data,
    async write(scope,writer,prior,head,rows=[],assets=[]) {
      if (fail) throw Error(fail);
      const key = JSON.stringify([scope,writer]), old = data.get(key);
      if (old?.head.stamp !== prior) throw Object.assign(Error("stale draft"),{code:old ? "" : "draft-removed"});
      if (!head) {data.delete(key);return;}
      const members = new Map(old?.members), originals = new Map(old?.originals);
      for (const r of rows) members.set(r.id,r);
      for (const r of assets) originals.set(r.key,r);
      data.set(key,{head:JSON.parse(JSON.stringify(head)),members,originals});
    },
    async list(scope) {return [...data.values()].map(r=>r.head).filter(h=>h.scope===scope);},
    async read(head) {
      const entry = data.get(JSON.stringify([head.scope,head.writer]));
      if (entry?.head.stamp !== head.stamp) throw Error("stale draft");
      return {header:entry.head,rows:[...entry.members.values()],originals:[...entry.originals.values()]};
    },
  };
}
async function restoreLayoutBlocks() {
  for (const m of ["i18n","model","source-file","format-2-codec","format-2-units","format-2-values","format-2-model","leave-project","folder-project-ui"])
    require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const A=Atrium, saved=A.project("Draft layout"), previous=globalThis.AtriumFolderProject;
  const block=(name)=>({id:A.id(),format:"atrium-block",version:1,name,size:[3,2],library:[],items:[
    {id:"track",kind:"track",points:[[.5,1],[2.5,1]],width:.2,layer:"Top",net:"SIG"}]});
  const a=block("Saved block"), b=block("Saved owner");
  saved.layoutBlocks=[a,b];
  const bare=A.clone(saved), session={project:saved};
  let restore, replaced;
  globalThis.AtriumFolderProject={async open(_folder,opts){restore=opts.restoreDraft;throw Error("Captured draft callback");}};
  const host={edit:fn=>fn(),replaceProject:async copy=>{replaced=copy;return true;},markUnsaved(){}};
  try {
    await assert.rejects(AtriumFolderProjectUI.open({host:{}},{session:()=>session,host:()=>host}),/Captured draft callback/);
  } finally {globalThis.AtriumFolderProject=previous;}
  const {documents,library,blobs,...settings}=saved;
  const bundle={header:{settings:{value:{...settings,notes:"From draft",layoutBlocks:[{...a,name:"Edited block"},b]}}},
    rows:[{id:b.id,kind:"block",owner:{...b,name:"Edited owner"}}],originals:[]};
  const names=value=>value.layoutBlocks.map(row=>row.name);
  assert.equal(await restore({separate:false,session,bundle}),true);
  assert.equal(saved.notes,"From draft");
  assert.deepEqual(names(saved),["Edited block","Edited owner"]);
  assert.equal(await restore({separate:true,session,bundle:A.clone(bundle),copy:{project:bare,binary:new Map()}}),null);
  assert.deepEqual(names(replaced),["Edited block","Edited owner"]);
  for(const result of [saved,replaced]){
    const layout=AtriumFormat2Model.fromEditor(result).files.find(row=>row.path.endsWith("Edited block.wblock"));
    assert.ok(layout,"saving the recovered project writes the block as an owner file");
    const reopened=AtriumFormat2Model.parse(AtriumFormat2.serialize(layout.file),{kind:"block"});
    assert.equal(AtriumFormat2Model.block(reopened).name,"Edited block");
  }
}
async function main() {
  require("../../app/checks/diagnostics.js");
  const recording = AtriumDiagnostics.startPerformance();
  const counts = component => AtriumDiagnostics.performanceSnapshot().rows.find(row => row.component === component)?.counts;
  const store = shelf(), disk = new Map([["s1","original"]]), diagnostics = [];
  let seq = 0;
  function window(scope="physical folder one") {
    const rows = new Map(), work = new Map(), visited = [], acks = new Map();
    let recovery;
    const editor = D.bind({scope,projectId:"copyable-id",store,diagnose:e=>diagnostics.push(e),
      cursor:() => ({rows:[...rows.values()],current:()=>true}),
      snapshot:async changes => {visited.push(changes.map(x=>x.id));
        return {rows:changes.map(r=>({...r,owner:{id:r.id,working:r.desiredHash},originals:[]})),assets:[]};},
      classify:async h => h.rows.every(r=>r.desiredHash===disk.get(r.id)) ? "saved" :
        h.rows.every(r=>!rows.has(r.id) && r.baseHash===disk.get(r.id)) ? "matches" : "changed",
      restore:(b,separate) => {
        recovery = b;
        if (separate) return;
        for (const row of b.rows) put(row.id,row.owner.working);
        const captured=[...rows.values()];
        return ()=>captured.every(r=>(acks.get(r.id)||0)>=r.seq);
      }});
    function put(id,value) {work.set(id,value);rows.set(id,{id,seq:++seq,baseHash:disk.get(id),desiredHash:value});editor.changed();}
    function saved(id) {const row=rows.get(id);disk.set(id,row.desiredHash);acks.set(id,row.seq);rows.delete(id);editor.changed(true);}
    return {editor,put,saved,rows,work,visited,get recovery(){return recovery;}};
  }
  const a=window(), b=window(), copy=window("equally named different directory");
  assert.deepEqual(a.editor.metrics(),{writes:0,pending:false,error:undefined});
  a.put("s1","A");b.put("s1","B");await Promise.all([a.editor.flush(),b.editor.flush()]);
  assert.equal(counts("autosave").completed,2);
  assert.equal(counts("autosave").durable,0,"private draft transactions do not claim a native Save receipt");
  assert.equal(store.data.size,2);assert.equal(a.rows.size,1);assert.equal(disk.get("s1"),"original");
  assert.deepEqual(await copy.editor.list(),[]);assert.equal(copy.editor.metrics().writes,0);
  const afterCrash=window();let offers=await afterCrash.editor.list();
  assert.deepEqual(offers.map(o=>o.state),["matches","matches"]);
  assert.notEqual(offers[0].head.writer,offers[1].head.writer);
  await afterCrash.editor.decide(offers[0],"keep");assert.equal(store.data.size,2);
  a.put("s1","newer A");await a.editor.flush();
  await assert.rejects(afterCrash.editor.decide(offers[0],"discard"),/stale/);
  offers=await afterCrash.editor.list();const first=offers.find(o=>o.head.rows[0].desiredHash==="newer A");
  await afterCrash.editor.decide(first,"restore");assert.equal(afterCrash.work.get("s1"),"newer A");
  assert.equal(counts("project").completed,1);
  assert.equal(disk.get("s1"),"original");assert.equal(store.data.size,2);
  afterCrash.saved("s1");await afterCrash.editor.flush();assert.equal(store.data.size,1,"durable Save retires the restored version even before a new local snapshot");
  offers=await afterCrash.editor.list();assert.equal(offers[0].state,"changed");
  await assert.rejects(afterCrash.editor.decide(offers[0],"restore"),/separately/);
  assert.equal(counts("project").cancelled,1);
  await afterCrash.editor.decide(offers[0],"separate");assert.equal(afterCrash.recovery.rows[0].owner.working,"B");
  assert.equal(disk.get("s1"),"newer A");assert.equal(store.data.size,1);
  await afterCrash.editor.decide(offers[0],"discard");assert.equal(store.data.size,0);
  b.put("s1","after discard");await b.editor.flush();assert.equal(store.data.size,1,"a still-open tab can recover after its reviewed version was discarded");
  b.put("s2","unsaved sibling");await b.editor.flush();assert.deepEqual(b.visited.at(-1),["s2"]);
  // A previous Save acknowledges an older revision of the same owner during the next edit.
  // The edit's own sequence stays fixed, but its private base must advance to the receipt.
  b.rows.set("s1",{...b.rows.get("s1"),baseHash:"acknowledged predecessor"});
  b.editor.changed(true);await b.editor.flush();assert.deepEqual(b.visited.at(-1),["s1"]);
  assert.equal([...store.data.values()][0].head.rows.find(r=>r.id==="s1").baseHash,"acknowledged predecessor");
  b.put("s1","quota failure");store.fail="Private store is full";
  await assert.rejects(b.editor.flush(),/full/);assert.equal(diagnostics.length,1);assert.equal(b.rows.size,2);
  assert.equal(counts("autosave").failed,1);
  assert.equal([...store.data.values()][0].head.rows.find(r=>r.id==="s1").desiredHash,"after discard");
  store.fail=null;await b.editor.flush();assert.equal([...store.data.values()][0].head.rows.find(r=>r.id==="s1").desiredHash,"quota failure");
  assert.equal(b.editor.metrics().pending,false);
  b.saved("s2");await b.editor.flush();assert.deepEqual([...store.data.values()][0].head.rows.map(r=>r.id),["s1"]);
  await Promise.all([a.editor.close(),b.editor.close(),afterCrash.editor.close(),copy.editor.close()]);
  const prefs = globalThis.AtriumPref;
  try {
    globalThis.AtriumPref = {get:(name,fallback)=>name === "general.autosave" ? false : fallback};
    const writer = window("detached recovery"), reopened = window("detached recovery");
    const before = disk.get("s1");
    writer.put("s1", "acknowledged detached edit");
    await writer.editor.flush();
    assert.equal(writer.editor.metrics().writes,0);
    await writer.editor.checkpoint();
    const [offer] = await reopened.editor.list();
    assert.equal(offer.state,"matches");
    await reopened.editor.decide(offer,"restore");
    assert.equal(reopened.work.get("s1"),"acknowledged detached edit");
    assert.equal(disk.get("s1"),before);
    writer.saved("s1");
    await writer.editor.checkpoint();
    assert.deepEqual(await reopened.editor.list(),[]);
    assert.equal(writer.editor.metrics().writes,2);
    await Promise.all([writer.editor.close(),reopened.editor.close()]);
  } finally {globalThis.AtriumPref = prefs;}
  let now=0;
  const timers=[],set=globalThis.setTimeout,clear=globalThis.clearTimeout,clock=Date.now,power=globalThis.AtriumPower;
  const quiet=window("efficiency");
  try {
    globalThis.setTimeout=(f,ms)=>{timers.push(ms);return timers.length;};
    globalThis.clearTimeout=()=>{};
    globalThis.AtriumPower={delay:ms=>ms*2}; Date.now=()=>now;
    assert.equal(timers.length,0);
    quiet.put("s3","one");assert.equal(timers.at(-1),3000);
    now=19500;quiet.put("s3","two");assert.equal(timers.at(-1),500,"continuous edits still reach the 20-second maximum");
    await quiet.editor.flush();assert.equal(quiet.editor.metrics().pending,false);
    assert.deepEqual(timers,[3000,500],"clean and idle windows schedule no polling");
  } finally {
    globalThis.setTimeout=set;globalThis.clearTimeout=clear;Date.now=clock;globalThis.AtriumPower=power;
    await quiet.editor.close();
  }
  recording.stop();
  await restoreLayoutBlocks();
  console.log("PASS private per-window draft lifecycle, durable acknowledgement, covered owners, conflicting bases, live-tab retirement, failed storage and copy isolation");
}
module.exports = {shelf};
if (require.main === module) globalThis.__testDone = main().catch(e=>{console.error(e);process.exitCode=1;});
