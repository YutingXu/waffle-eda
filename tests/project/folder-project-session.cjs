"use strict";
// Scope and acknowledgement of the editor's folder session, using the actual save planner and
// exact native ABI shape with a stub codec. Codec/product integration is covered by the workers.
const assert = require("node:assert/strict"), crypto = require("node:crypto");
require("../../app/project/source-file.js");
require("../../app/formats/format-2-codec.js");
require("../../app/formats/format-2-units.js");
require("../../app/formats/format-2-values.js");
require("../../app/formats/format-2-model.js");
require("../../app/formats/format-2-closure.js");
require("../../app/project/folder-project-engine.js");
require("../../app/project/folder-project.js");
require("../../app/editor/i18n.js");
require("../../app/project/editor-files.js");

const F = AtriumFolderProjectEngine, C = AtriumFolderProject;
const encode = text => new TextEncoder().encode(text);
const codec = AtriumFormat2;
const make = (header, children) => codec.create({formatVersion: "2.0", ...header}, children);
const model = {
  parse: codec.parse,
  manifest(file) { return {project:{id:file.header.id,name:file.header.name,documents:[],library:[]},
    members:codec.manifestMembers(file),entryDocument:file.header.entryDocument}; },
  documentWithDependencies(file,{name}) {
    const items = [...file.records()];
    return {owner:{...file.header,name,items}, dependencies:{libraries:items.filter(r=>r.kind==="part").map(r=>r.def),assets:[]}};
  },
  library(file) { return file.header; },
  documentEdits(_, __, {put,remove}) {return {put,remove};},
  createDocument(d) {return make({id:d.id,kind:d.kind},d.items.slice());},
};
const workerFactory = () => {
  const e = F.create(codec,model);
  return {run:(op,m,read) => e.run({op,...m,read}),close() {}};
};
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
function mock({formatVersion="2.0"} = {}) {
  const paths = new Map(), reads = [], writes = [], leases = new Set(), staged = new Map();
  const manifests = new Set();
  let next = 0, gate, state;
  const manifest = "Fixture.waffle", doc = i => "Board " + i + ".wpcb";
  const header = {kind:"project",id:"project",name:"Fixture",entryDocument:"doc-1",formatVersion};
  const source = {id:"layout-library",kind:"library",path:"libraries/part.wlib"};
  const owners = Array.from({length:6}, (_, i) => ({id:"doc-"+(i+1),kind:"document",docKind:"pcb",name:"Board "+(i+1),path:doc(i+1)}));
  paths.set(manifest, codec.serialize(make(header,[...owners,source])));
  paths.set(source.path,codec.serialize(make({kind:"library",id:source.id,name:"Fixture part"},[])));
  for (const r of owners) paths.set(r.path,codec.serialize(make({kind:"pcb",id:r.id},[{kind:"part",id:"part-"+r.id,def:source.id,x:0,y:0}])));
  const host = {
    async folderReadLease() { const lease = "lease-"+(++next); leases.add(lease); return {lease}; },
    async folderRead({lease,paths:requested}) {
      assert.ok(leases.has(lease)); reads.push(...requested);
      if (formatVersion !== "2.0" && !manifests.has(lease)) {
        assert.equal(requested[0],manifest,"a later-version member is scoped by the same lease's manifest");
        manifests.add(lease);
      }
      return {files: requested.filter(path=>paths.has(path)).map(path=>({path,bytes:paths.get(path),length:paths.get(path).length,sha256:hash(paths.get(path))}))};
    },
    async folderRelease({lease}) { assert.ok(leases.delete(lease)); },
    async folderReadAsset({lease,ownerId,assetToken,assetRef,offset,length}) {
      assert.ok(leases.has(lease)); assert.equal(ownerId,"doc-2");
      const bytes = assetToken ? staged.get(assetToken) : paths.get("assets/"+assetRef.sha256);
      const cut = bytes.subarray(offset,offset+length);
      return {data:F.dataOf(cut),offset,length:cut.length,eof:offset+cut.length===bytes.length};
    },
    async folderLocalState({localState:next}) { if (next) state=next; else return state; },
    async folderCommit({plan}) {
      writes.push(plan); if (gate) await gate;
      const result = new Map();
      for (const item of plan) {
        const before = paths.get(item.path), asText = before && new TextDecoder().decode(before);
        assert.equal(item.expected, before ? hash(before) : null);
        if (item.remove) result.set(item.path,null);
        else if (item.assetToken) result.set(item.path,staged.get(item.assetToken));
        else if (item.data) result.set(item.path,F.bytesOf(item));
        else {
          assert.ok(item.splice); assert.equal(item.splice.base,item.expected);
          // All test records use ASCII, so code unit and byte offsets coincide.
          let pos=0,out="";
          for (const edit of item.splice.edits) {out+=asText.slice(pos,edit.offset)+edit.insert; pos=edit.offset+edit.remove;}
          result.set(item.path,encode(out+asText.slice(pos)));
        }
      }
      for (const [path,bytes] of result) if (bytes) paths.set(path,bytes); else paths.delete(path);
      return {saved:true,transaction:"save-"+writes.length,hashes:Object.fromEntries([...result].map(([p,b])=>[p,b?hash(b):null]))};
    },
    async folderClose() {assert.equal(leases.size,0);}
  };
  return {host,paths,reads,writes,manifest,doc,staged,open: {grant:"root", manifest, name:"Fixture"},
    hold(p) { gate=p; }};
}
globalThis.__testDone = (async () => {
  {
    const view = mock(), panel = {kind:"document",docKind:"panel",id:"panel",name:"Assembly",path:"Assembly.wpanel"};
    const original = codec.parse(view.paths.get(view.manifest));
    view.paths.set(view.manifest,codec.serialize(codec.create(original.header,[...original.records(),panel])));
    view.paths.set(panel.path,codec.serialize(make({kind:"panel",id:panel.id,panel:{board:"doc-2"}},[])));
    const project = await C.open(view.open,{host:view.host,workerFactory});
    try {
      const [assembly, source] = await project.workspaceDocuments(panel.id);
      assert.equal(assembly.id,panel.id);
      assert.equal(source.id,"doc-2");
      assembly.panel = {board:"doc-3",cells:{"0,1":{board:"doc-4"}}};
      project.record([{id:assembly.id,kind:assembly.kind,settings:true}]);
      assert.deepEqual((await project.workspaceDocuments(panel.id)).map(row=>row.id),[panel.id,"doc-3","doc-4"]);
    } finally { await project.close(); }
  }
  {
    const view = mock(), p = await C.open(view.open,{host:view.host,workerFactory});
    try {
      const owner = {id:"exact-copy",name:"Future circuit",kind:"pcb",items:[]};
      const bytes = encode(codec.canonical({kind:owner.kind,id:owner.id,formatVersion:"2.0",
        requires:["future-overlay"],readerRequires:{"future-overlay":"2.8"}}) + "\r\n");
      const proof = {grant:"selected-source",sha256:hash(bytes)}, path = "Future circuit.wpcb";
      (await p.prepareNativeCopy(owner,owner.kind,bytes,proof))();
      const add = {id:owner.id,kind:owner.kind,owner,name:owner.name};
      p.record([add]);
      await p.save({documentId:owner.id});
      assert.deepEqual(view.writes.at(-1)[0],{path,expected:null,data:F.dataOf(bytes),nativeCopy:proof});
      assert.deepEqual(view.paths.get(path),bytes);
      assert.equal(p.canEdit(owner.id),false);
      p.record([{id:owner.id,kind:owner.kind,deleted:true}]);
      await p.save({all:true});
      assert.deepEqual(view.writes.at(-1)[0],{path,expected:proof.sha256,remove:true,nativeCopy:proof});
      assert.equal(view.paths.has(path),false);
      p.record([add]);
      await p.save({documentId:owner.id});
      assert.deepEqual(view.paths.get(path),bytes);
    } finally { await p.close(); }
  }
  {
    const view = mock();
    let restore;
    const state = new Promise(resolve => {restore = resolve;});
    view.host.folderLocalState = () => state;
    const opening = C.open(view.open,{host:view.host,workerFactory});
    await new Promise(resolve => setTimeout(resolve,0));
    const beforeRestore = view.reads.slice();
    restore({activeDocument:"doc-6"});
    const restored = await opening;
    try {
      assert.deepEqual(beforeRestore,[view.manifest],"manifest validation can begin while local view state is pending");
      assert.equal(restored.activeId,"doc-6");
      assert.deepEqual(view.reads,[view.manifest,view.doc(6),"libraries/part.wlib"]);
      const active = restored.project.documents[0];
      await restored.ensureDocument("doc-2");
      assert.deepEqual(restored.project.documents.map(d => d.id),["doc-2","doc-6"]);
      const complete = await restored.requireClosure({purpose:"comparison"});
      assert.deepEqual(complete.documents.map(d => d.id),["doc-1","doc-2","doc-3","doc-4","doc-5","doc-6"]);
      assert.equal(complete.documents[5],active);
      assert.equal(restored.activeId,active.id);
      assert.equal(restored.dirty,false);
    } finally { await restored.close(); }
  }
  const disk = mock(), acknowledgements = [];
  let p;
  disk.host.finishedOpening = ok => acknowledgements.push(ok);
  globalThis.AtriumHost = disk.host;
  try {
    const folderUI = async () => ({async open(folder) {
      p = await C.open(folder,{host:disk.host,workerFactory});
      return true;
    }});
    const selection = [{name:disk.manifest,folderProject:disk.open}];
    assert.equal(await AtriumEditorFiles.open(selection,{},{
      folderUI, folderContext:()=>({}), info(){}
    }),true);
    assert.deepEqual(acknowledgements,[true],"the native open is acknowledged after the session opens");
  } finally {delete globalThis.AtriumHost;}
  assert.deepEqual(disk.reads,[disk.manifest,disk.doc(1),"libraries/part.wlib"]);
  assert.equal(p.project.documents.length,1);
  assert.equal(p.documents().length,6);
  assert.equal(p.activeId,"doc-1");
  await p.activate("doc-2");
  assert.deepEqual(disk.reads.slice(-1),[disk.doc(2)]);
  assert.equal(p.project.documents.length,2);
  await p.setView({activeDocument:"doc-2"});
  const readBoth = await p.requireClosure({purpose:"compare"});
  assert.equal(readBoth.documents.length,6);
  assert.equal(p.dirty,false,"hydrating documents does not create edits");
  const a = p.project.documents.find(d=>d.id==="doc-1"), b = p.project.documents.find(d=>d.id==="doc-2");
  const change = (d,x) => ({id:d.id,kind:d.kind,put:[{...d.items[0],x}]});
  p.record([change(a,1)]); p.record([change(b,2)]);
  let resume;
  disk.hold(new Promise(resolve=>{resume=resolve;}));
  const first = p.save({documentId:a.id});
  assert.equal(p.pendingSave,true);
  p.record([change(a,3)]); // New edit to the same record while the captured save is in flight.
  resume();
  await first;
  assert.equal(p.modified(a.id),true); assert.equal(p.modified(b.id),true);
  assert.deepEqual(disk.writes[0].map(x=>x.path),[disk.doc(1)]);
  assert.equal(disk.writes[0][0].splice.edits.length,1);
  p.record([change(a,1)]); // Undo the pending move to the saved cursor.
  await p.save({documentId:a.id});
  assert.equal(disk.writes.length,1,"undo to saved cursor produces no disk writes");
  assert.equal(p.modified(a.id),false); assert.equal(p.modified(b.id),true);
  p.record([change(a,4),change(b,5)],{atomic:true});
  assert.equal((await p.save({documentId:a.id})).needsSaveAll,true);
  await p.save({all:true});
  assert.deepEqual(disk.writes[1].map(x=>x.path).sort(),[disk.doc(1),disk.doc(2)]);

  const bytes=encode("photo"), assetRef={sha256:hash(bytes),mediaType:"image/png",byteLength:bytes.length}, assetPath="assets/"+assetRef.sha256;
  disk.staged.set("one",bytes);
  const preview = await p.readAsset({ownerId:b.id,assetRef,assetToken:"one"});
  assert.deepEqual(preview.bytes,bytes,"a staged image can be previewed before authoring its row");
  p.stageAttachment({ownerId:b.id,assetRef,assetToken:"one"});
  const image={id:"asset",kind:"image",asset:assetRef,x:0,y:0};
  p.record([{id:b.id,kind:b.kind,put:[image]}]);
  await p.save({documentId:b.id});
  assert.deepEqual(disk.writes[2].map(x=>x.path),[assetPath,disk.doc(2)]);
  assert.equal(hash(disk.paths.get(assetPath)),assetRef.sha256);
  const savedImage=await p.readAsset({ownerId:b.id,assetRef});
  assert.deepEqual(savedImage.bytes,bytes,"the read path uses committed bytes after acknowledge");
  const inode = codec.parse(disk.paths.get(disk.doc(2)));
  const altered = codec.edit(inode,{put:[{id:"ext",kind:"label",x:2,y:0,text:"External"}]});
  disk.paths.set(disk.doc(2),codec.serialize(altered));
  const otherRead = disk.reads.length;
  p.record([change(b,6)]);
  await p.synchronize([disk.doc(2)]);
  assert.deepEqual(disk.reads.slice(otherRead),[disk.doc(2)],"the watcher reads only the changed document");
  assert.ok(p.conflicts.has(b.id));
  await assert.rejects(p.save({documentId:b.id}),/resolve/i);
  await p.resolveConflict(b.id,"merge");
  const merged = p.project.documents.find(d=>d.id===b.id);
  assert.equal(merged.items.find(i=>i.id===b.items[0].id).x,6);
  assert.ok(merged.items.some(i=>i.id==="ext"));
  await p.save({documentId:b.id});
  assert.deepEqual(disk.writes[3].map(x=>x.path),[disk.doc(2)]);
  assert.equal(p.metrics().lastSave.rowsEncoded,1);
  const lease=await p.readLease();
  const closure=await p.requireClosure({purpose:"zip",saved:true,lease});
  assert.ok(closure.members.some(x=>x.path===assetPath));
  assert.equal(closure.project.documents.length,6);
  await lease.release();
  const earlier = disk.paths.get(disk.doc(2));
  p.record([change(b,32)]);
  const copy = await p.copyTo("Different.waffle");
  assert.equal(copy.projectId,"project");
  assert.ok(copy.plan.some(row => row.path === "Different.waffle"));
  assert.ok(copy.plan.some(row => row.path === assetPath));
  const copied = F.bytesOf(copy.plan.find(row => row.path === disk.doc(2)));
  assert.equal(codec.parse(copied).get("part-doc-2").x,32);
  assert.equal(disk.paths.get(disk.doc(2)),earlier,"Save As keeps the original owner untouched");
  assert.equal(p.modified(b.id),true);
  const missing = disk.doc(3), preserved = disk.paths.get(missing);
  disk.paths.delete(missing);
  await p.synchronize([missing]);
  assert.ok(p.conflicts.has("doc-3"));
  await assert.rejects(p.restoreMissing("doc-3",earlier),/id|identity/i);
  assert.equal(disk.paths.has(missing),false);
  assert.ok(await p.restoreMissing("doc-3"));
  assert.deepEqual(disk.paths.get(missing),preserved);
  assert.equal(p.conflicts.has("doc-3"),false);
  const workspace = {activeDocument:b.id,openTabs:[b.id],split:{doc:a.id,orientation:"right",ratio:0.6}};
  await p.setView(workspace);
  await p.close();
  const reopenedAt = disk.reads.length;
  const reopened = await C.open(disk.open,{host:disk.host,workerFactory});
  try {
    assert.equal(reopened.activeId,b.id);
    assert.deepEqual(reopened.localState,workspace);
    assert.deepEqual(disk.reads.slice(reopenedAt),[disk.manifest,disk.doc(2),"libraries/part.wlib"],
      "restoring open tabs does not eagerly hydrate the split pane");
  } finally { await reopened.close(); }
  const future = mock({formatVersion:"2.1"});
  const versioned = await C.open(future.open,{host:future.host,workerFactory});
  assert.deepEqual(future.reads,[future.manifest,future.doc(1),"libraries/part.wlib"]);
  const navigation = future.reads.length;
  await versioned.activate("doc-2");
  assert.deepEqual(future.reads.slice(navigation),[future.manifest,future.doc(2)]);
  const previous = codec.parse(future.paths.get(future.manifest));
  const revised = codec.edit(previous,{header:{...previous.header,name:"Updated manifest"}});
  future.paths.set(future.manifest,codec.serialize(revised));
  await assert.rejects(versioned.activate("doc-3"),/manifest changed/i);
  assert.equal(versioned.activeId,"doc-2");
  await versioned.synchronize([future.manifest]);
  await versioned.activate("doc-3");
  assert.equal(versioned.activeId,"doc-3");
  await versioned.close();
  console.log("PASS visible-only folder open, six boards, coherent leases, document scope, Undo, concurrent Save, atomic asset and Save All");
})().catch(error=>{console.error(error);process.exitCode=1;});
