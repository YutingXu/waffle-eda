"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const cp = require("node:child_process");
for (const name of ["model","source-file","format-2-codec","format-2-units","format-2-values","format-2-model",
  "folder-project-engine","collab-crdt","widget-fallback","widget-catalogue","sheet-widgets","table-data","table-format"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const F=AtriumFormat2,M=AtriumFormat2Model,T=AtriumTableData,C=AtriumCollabCRDT,E=AtriumFolderProjectEngine;
const text=file=>new TextDecoder().decode(F.serialize(file));
const p=Atrium.project("Table test"),d=Atrium.sheet("schematic","Table"),second=Atrium.sheet("pcb","Board"),old=AtriumSheetWidgets.make("table",[1,2]);
p.documents=[d,second];p.library=[];
d.items=[old];
const copy=structuredClone, initial=M.createDocument(d),original=text(initial);
assert.equal(initial.header.formatVersion,"2.0");
const item=T.upgrade(old),s=item.widget.state;
assert.deepEqual(s.rows.map(r=>r.id),old.widget.state.rows.map(r=>r.id));
const patch=(file,item)=>M.documentEdits(file,d,{put:[item]});
const upgraded=F.applyDelta(initial,patch(initial,item)).file;
assert.deepEqual(upgraded.header.requires,["notebook.table.v1"]);
const edit=(item,r,c,value)=>({...item,widget:{...item.widget,state:T.change(item.widget.state,r,c,{content:{kind:"literal",text:value}})}});
const rowId=s.rows[0].id,colId=s.columns[0].id,col2=s.columns[1].id,target=T.target(d.id,item.id,rowId,colId);
const inEditor={documents:[{...d,items:[item]}]};
assert.equal(target.scope,"item");assert.deepEqual(target.path,["cells",rowId,colId,"value"]);
assert.equal(T.readTarget(inEditor,target).value,null);
const byAddress=T.writeTarget(inEditor,target,{kind:"literal",text:"4 mm"});
assert.equal(T.get(byAddress,rowId,colId).content.text,"4 mm");
const first=edit(item,rowId,colId,"left"),saved=F.applyDelta(upgraded,patch(upgraded,first));
assert.equal(saved.changedRows,1);assert.equal(saved.splices.length,1);assert.equal(saved.headerChanged,false);
const secondEdit=edit(first,rowId,colId,"calibrated"),next=F.applyDelta(saved.file,patch(saved.file,secondEdit));
assert.equal(next.changedRows,1);assert.equal(next.splices.length,1);assert.match(next.splices[0].insert,/"kind":"tableCell"/);
const restored=M.document(M.parse(F.serialize(next.file)));
assert.equal(T.resolveTarget({documents:[restored]},target).cell.content.text,"calibrated");
assert.equal(text(F.applyDelta(next.file,patch(next.file,old)).file),original);
assert.equal(F.applyDelta(next.file,M.documentEdits(next.file,d,{remove:[item.id]})).file.header.formatVersion,"2.0");
assert.throws(()=>F.create({kind:"schematic",id:"s",formatVersion:"2.0"},[{kind:"tableCell",id:"c"}]),/table.v1/);
assert.throws(()=>F.withTable({kind:"pcb",id:"pcb",formatVersion:"2.0"},true),/cannot safely/);
assert.throws(()=>F.withTable({kind:"schematic",id:"unknown",formatVersion:"2.1"},true),/cannot safely/);
const sibling={kind:"project",id:"mixed",name:"Mixed",formatVersion:"2.1",requires:["id-natural-order-v1"]};
assert.deepEqual(F.withTable(F.withTable(sibling,true),false),sibling);
assert.throws(()=>F.checkMemberVersion(M.createManifest(p,{id:"old"}),upgraded),e=>e.code==="invalid-member");

let frozenReader;
if (process.argv.includes("--frozen-preview")) {
  const ctx=vm.createContext({TextEncoder,TextDecoder,Uint8Array,ArrayBuffer});
  for (const name of ["source-file","format-2-codec","format-2-units","format-2-values","format-2-model"])
    vm.runInContext(cp.execFileSync("git",["show","ebbc017b:app/"+name+".js"],{encoding:"utf8"}),ctx);
  frozenReader=ctx.AtriumFormat2Model;
  assert.equal(text(initial),new TextDecoder().decode(ctx.AtriumFormat2.serialize(ctx.AtriumFormat2Model.parse(original))));
  assert.throws(()=>ctx.AtriumFormat2Model.parse(text(next.file)),err=>err.code==="unsupported-feature" && /notebook.table.v1/.test(err.message));
  const [header,...lines]=text(next.file).split("\n");
  const counterexample=[F.canonical({...JSON.parse(header),compatibleWith:"2.0"}),...lines].join("\n");
  const oldReader=ctx.AtriumFormat2Model.parse(counterexample);
  assert.equal(oldReader.readOnly,true);
  assert.equal(new TextDecoder().decode(ctx.AtriumFormat2.serialize(oldReader)),counterexample);
  assert.throws(()=>ctx.AtriumFormat2.applyDelta(oldReader,{}),err=>err.code==="read-only-format");
  assert.equal(ctx.AtriumFormat2Model.document(oldReader).items.length,0);
}
d.items=[item];
const a=C.create({replica:"a",project:p}),b=C.create({replica:"b",project:p}),ap=copy(a.project()),bp=copy(b.project());
ap.documents[0].items[0]=edit(ap.documents[0].items[0],rowId,colId,"left");
bp.documents[0].items[0]=edit(bp.documents[0].items[0],rowId,col2,"right");
const aa=a.commit(ap),bb=b.commit(bp); a.receive(bb);b.receive(aa);
assert.equal(C.canon(a.project()),C.canon(b.project()));
const converged=a.project().documents[0].items[0].widget.state;
assert.equal(T.get(converged,rowId,colId).content.text,"left");assert.equal(T.get(converged,rowId,col2).content.text,"right");

function fullFallback() {
  const extended={...first,widget:{...first.widget,state:T.axis(first.widget.state,"rows",1,1,true,()=>"extra-row")}};
  const withCells=edit(extended,rowId,col2,"remove this cell");
  const neighbor={...copy(withCells),id:"neighbor-table"};
  const label={kind:"label",id:"ordinary-label",x:0,y:0,text:"Before"};
  const doc={...d,items:[withCells,neighbor,label]};
  const baseline=M.createDocument(doc), settings=[...baseline.records()].find(r=>r.kind==="documentSettings");
  const change=owner=>{
    const table=owner.items[0], state=table.widget.state, otherRow=state.rows[1].id;
    return [
      {...table,widget:{...table.widget,state:T.batch(state,[
        {rowId,columnId:colId,content:{kind:"literal",text:"After"},style:{bold:true}},
        {rowId,columnId:col2,content:null},
        {rowId:otherRow,columnId:col2,content:{kind:"literal",text:"Added"}}])}},
      {...owner.items[2],text:"After"}
    ];
  };
  const owner=M.document(baseline), [newTable,newLabel]=change(owner);
  const patch={put:[newTable,newLabel]};
  const full=M.createDocument({...owner,items:[newTable,owner.items[1],newLabel]}, {allocate:()=>settings.id});
  // Both a parsed-and-opened file and a file sent straight to the encoder can plan the edit.
  for (const base of [baseline,M.parse(F.serialize(baseline))]){
    const saved=F.applyDelta(base,M.documentEdits(base,owner,patch));
    assert.equal(saved.changedRows,4);
    assert.equal(text(saved.file),text(full),"whole-table Save matches full encoding");
  }
  for(const forged of [
    cell=>({...cell,content:{kind:"literal",text:42}}),
    cell=>({...cell,style:{bold:"yes"}}),
    cell=>({...cell,rowId:"extra-row"}),
    cell=>({...cell,id:"arbitrary-id"}),
  ]){
    const invalid=copy(newTable);
    invalid.widget.state.cells[0]=forged(invalid.widget.state.cells[0]);
    assert.throws(()=>M.documentEdits(baseline,owner,{put:[invalid]}),/Invalid table cell/);
  }
  const duplicate=copy(newTable);
  duplicate.widget.state.cells.push(duplicate.widget.state.cells[0]);
  assert.throws(()=>M.documentEdits(baseline,owner,{put:[duplicate]}),/duplicate table record ID/);
  const arbitrary={...copy(newTable.widget.state),cells:[{...newTable.widget.state.cells[0],id:"forged"}]};
  assert.throws(()=>T.validate(arbitrary,()=>true),/Invalid table cell/);
  assert.throws(()=>T.validateNativeCells(arbitrary,()=>({localId:"forged",rowId,columnId:colId})),/Invalid table cell/);

  const cellId=AtriumTableFormat.physicalId(withCells.id,"tableCell",T.cellId(rowId,colId));
  const line=baseline.rawRecord(cellId), opaque='{"kind":"futurePayload","id":"zz-future-table-data","value":[1.2300e-4]}\n';
  const ext='"x-table-extension":{"repeat":1.2300e-4,"marker":"\\u0061"}';
  const retained=M.parse(text(baseline).replace(line,line.trimEnd().slice(0,-1)+","+ext+"}\n")+opaque);
  const retainedOwner=M.document(retained), put=change(retainedOwner);
  const saved=F.applyDelta(retained,M.documentEdits(retained,retainedOwner,{put})).file;
  assert.ok(saved.rawRecord(cellId).includes(ext),"known cell edits preserve the extension's exact native bytes");
  assert.equal(saved.rawRecord("zz-future-table-data"),opaque);
  for (const record of retained.records())if(record.tableId===neighbor.id)
    assert.equal(saved.rawRecord(record.id),retained.rawRecord(record.id),"an untouched table keeps its physical bytes");
  assert.equal(text(M.parse(F.serialize(saved))),text(saved),"the retained owner reopens byte for byte");
}
fullFallback();

async function folder() {
  const ref=(doc,path)=>({kind:"document",id:doc.id,name:doc.name,docKind:doc.kind,path});
  const path="Table.wsch",manifest="Test.waffle",other="Board.wpcb",engine=E.create();
  const root=M.createManifest(p,{id:"p",references:[ref(d,path),ref(second,other)]});
  const disk=new Map([[manifest,Buffer.from(F.serialize(root))],[path,Buffer.from(F.serialize(initial))],[other,Buffer.from(F.serialize(M.createDocument(second)))]]);
  const record=path=>({path,bytes:new Uint8Array(disk.get(path)),sha256:F.sha256(disk.get(path))});
  const info=await engine.run({op:"manifest",record:record(manifest)});
  await engine.run({op:"owner",ref:info.members.find(r=>r.id===d.id),record:record(path)});
  async function submit(item, serialized=false) {
    const sent=serialized ? JSON.stringify(item) : item, parse=JSON.parse;
    let decodes=0, proposed;
    JSON.parse=(value,...rest)=>{if(value===sent)decodes++;return parse(value,...rest);};
    try { proposed=await engine.run({op:"plan",changes:[{id:d.id,kind:d.kind,put:[sent],remove:[]}],attachments:[]}); }
    finally { JSON.parse=parse; }
    if(serialized)assert.equal(decodes,1,"save and attachment checks share one decoded editor item");
    const hashes={};
    for (const entry of proposed.plan) {
      assert.equal(entry.expected,F.sha256(disk.get(entry.path)));
      let bytes=disk.get(entry.path);
      for (const sp of entry.splice.edits.toReversed()) bytes=Buffer.concat([bytes.subarray(0,sp.offset),Buffer.from(sp.insert),bytes.subarray(sp.offset+sp.remove)]);
      disk.set(entry.path,bytes);hashes[entry.path]=F.sha256(bytes);
    }
    await engine.run({op:"accepted",token:proposed.token,hashes});
    return proposed;
  }
  const firstPlan=await submit(item);
  assert.deepEqual(firstPlan.plan.map(r=>r.path).sort(),[path,manifest].sort());
  assert.deepEqual(M.parse(disk.get(manifest)).header.requires,[F.tableFeature]);
  if(frozenReader)assert.throws(()=>frozenReader.parse(disk.get(manifest).toString()),e=>e.code==="unsupported-feature"&&/notebook.table.v1/.test(e.message));
  assert.equal((await submit(first)).plan.length,1);
  assert.equal((await submit(secondEdit,true)).metrics.rowsEncoded,1);
  const source={sha256:"c".repeat(64),byteLength:128,mediaType:"image/png"};
  const image={...secondEdit,widget:{...secondEdit.widget,
    state:T.change(secondEdit.widget.state,rowId,colId,{content:{kind:"image",assetRef:source,alt:"Reference"}})}};
  const attachment=await engine.run({op:"plan",changes:[{id:d.id,kind:d.kind,put:[JSON.stringify(image)],remove:[]}],
    attachments:[{ownerId:d.id,assetRef:source,assetToken:"original"}]});
  assert.equal(attachment.plan.find(entry=>entry.path===M.assetPath(source)).assetToken,"original");
  assert.deepEqual(attachment.existingAssets,[]);
  await engine.run({op:"aborted",token:attachment.token});
  assert.equal((await submit(old)).plan.length,2);
  assert.equal(disk.get(path).toString(),original);
  assert.equal(disk.get(manifest).toString(),text(root));
  console.log("Guarded table storage: first 2 owners, subsequent cell edit 1 encoded row, exact legacy undo, 2 peers converged.");
}
async function tableAttachments() {
  const ref=(letter,mediaType="image/png",byteLength=128)=>({sha256:letter.repeat(64),mediaType,byteLength});
  const image=(assetRef,alt="Reference")=>({kind:"image",assetRef,alt});
  const set=(table,columnId,content)=>({...table,widget:{...table.widget,
    state:T.change(table.widget.state,rowId,columnId,{content})}});
  const a=ref("a"), b=ref("b"), added=ref("c");
  const left=set(item,colId,image(a)), right=set({...copy(item),id:"right-table"},colId,image(b));
  const {manifest,files}=M.fromEditor({...p,documents:[{...d,items:[left,right]}]});
  const {path,file}=files.find(entry=>entry.file.header.id===d.id), engine=E.create();
  const load=(path,file)=>{const bytes=F.serialize(file);return {path,bytes,sha256:F.sha256(bytes)};};
  const opened=await engine.run({op:"manifest",record:load("Attachments.waffle",manifest)});
  const ownerRef=opened.members.find(ref=>ref.path===path);
  let saved=load(path,file);
  const {owner}=await engine.run({op:"owner",ref:ownerRef,record:saved});
  const [first,second]=owner.items;
  const propose=(put,tableCells=[],attachments=[])=>engine.run({op:"plan",changes:[{id:d.id,kind:d.kind,remove:[],
    put:put.map(value=>JSON.stringify(value)),tableCells,tableBase:saved.sha256}],attachments});
  const cert=(before,after,columnId)=>({id:before.id,
    before:T.get(before.widget.state,rowId,columnId),after:T.get(after.widget.state,rowId,columnId)});
  const abort=plan=>engine.run({op:"aborted",token:plan.token});
  const attach={ownerId:d.id,assetRef:added,assetToken:"verified-original"};

  const ordinary=await propose([set(first,col2,{kind:"literal",text:"Math"}),set(second,colId,image(b,"New alt"))]);
  assert.deepEqual(ordinary.existingAssets,[],"existing missing assets remain placeholders across two edited tables");
  assert.deepEqual(ordinary.plan.map(target=>target.path),[path]);
  await abort(ordinary);

  for (const wrong of [ref("a","image/jpeg"),ref("a","image/png",129)]) {
    const inconsistent=set(first,col2,image(wrong));
    await assert.rejects(propose([inconsistent]),/Conflicting asset references/);
    await assert.rejects(propose([],[cert(first,inconsistent,col2)]),/Conflicting asset references/);
  }
  const nextLeft=set(first,col2,image(added)), nextRight=set(second,col2,image(added));
  const unverified=await propose([nextRight]);
  assert.deepEqual(unverified.existingAssets.map(asset=>asset.sha256),[added.sha256],
    "the new reference requires actual bytes with or without a cell proof");
  await abort(unverified);
  const wrongRight=set(second,col2,image(ref("c","image/jpeg")));
  await assert.rejects(propose([],[cert(first,nextLeft,col2),cert(second,wrongRight,col2)],[attach]),
    /Conflicting asset references/);

  const pair=[cert(first,nextLeft,col2),cert(second,nextRight,col2)];
  const staged=await propose([],pair,[attach]);
  assert.deepEqual(staged.existingAssets,[]);
  assert.deepEqual(staged.plan.map(target=>target.path),[M.assetPath(added),path]);
  assert.equal(staged.plan[0].assetToken,attach.assetToken);
  await abort(staged);
  const wrongLeft=set(first,colId,image(ref("c","image/jpeg")));
  const afterAbort=await propose([],[cert(first,wrongLeft,colId)]);
  assert.deepEqual(afterAbort.existingAssets.map(asset=>asset.mediaType),["image/jpeg"],
    "an aborted plan adds neither an asset grant nor a persisted table dependency");
  await abort(afterAbort);

  const committed=await propose([],pair,[attach]);
  const next=F.applyDelta(file,M.documentEdits(file,owner,{put:[nextLeft,nextRight]})).file;
  saved=load(path,next);
  await engine.run({op:"accepted",token:committed.token,hashes:{[path]:saved.sha256}});
  await engine.run({op:"invalidateAsset",sha256:added.sha256});
  const reopened=M.document(M.parse(saved.bytes));
  const active=reopened.items[0], repaint=set(active,colId,image(ref("c","image/jpeg")));
  await assert.rejects(propose([],[cert(active,repaint,colId)]),/Conflicting asset references/,
    "the accepted native edit advances its dependency index without rereading the owner");
}

globalThis.__testDone=folder().then(tableAttachments).catch(e=>{console.error(e);process.exitCode=1;});
