"use strict";
const assert=require("node:assert/strict");
for(const n of ["model","obsolete-project","source-file","sexpr","revisions","format-2-codec","format-2-units","format-2-values","format-2-model","format-2-closure","import-sidecars","zip","project-archive"])require(require("../support/app-source-paths.cjs").appFile(n+".js"));
const S=AtriumImportSidecars,Z=AtriumProjectArchive,F=AtriumFormat2;
const enc=new TextEncoder(),dec=new TextDecoder();
async function main(){
  const source=enc.encode("(kicad_pcb (version 20240108) (generator pcbnew))\n");
  const sha=await S.sha(source), shared="repeat";
  const origin={name:"sample.kicad_pcb",bytes:source,sha256:sha,documents:["pcb"],library:[]};
  const entry={scopeId:"scope-1",adopted:true,names:[origin.name],documents:["pcb"],
    report:{translator:"kicad",version:1,kinds:[]},provenance:{version:1,files:[origin,{...origin,path:"other/"+origin.name}],
      fields:[{type:"document",id:"pcb",values:{sourceRules:["opaque rule"],kicadUuid:"old-id"}}]}};
  const git={algorithm:"sha1",commit:"a".repeat(40),path:"sources/sample.kicad_pcb"};
  const p=await S.prepare([entry],{locate:async()=>git});
  assert.equal(p.files.size,1);const r=p.refs[0], binding=S.parse(p.files.get(r.path),r);
  assert.equal(S.dependencies(binding).length,2);assert.equal(S.dependencies(binding)[0].path,S.logical(sha));
  assert.equal(binding.inputs[0].git.commit,git.commit);
  const restored=S.restore(binding),again=await S.prepare([restored]);
  assert.deepEqual(again.refs,p.refs);assert.deepEqual([...again.files],[...p.files]);
  assert.equal(restored.provenance.fields[0].values.sourceRules[0],"opaque rule");
  assert.ok(!dec.decode(p.files.get(r.path)).includes("(kicad_pcb"));
  assert.deepEqual(S.removed([binding],[binding]),[]);
  const copied=await S.prepare([{...entry,scopeId:"scope-2"}]); assert.equal(copied.files.size,2);
  const other=S.parse(copied.files.get(copied.refs[0].path),copied.refs[0]);
  assert.deepEqual(S.removed([binding,other],[other]),[r.path]);
  const residuals=Array.from({length:350},(_,i)=>{
    const row={owner:"board",id:"stable-component-"+(i%17),property:"/points/"+(i%55)+"/x",nativeValue:(i%30)-9,
      unit:"nm",numerator:String((i%3)+1),denominator:"10",...(i%3 ? {recordKind:i%2?"track":"pad"} : {})};
    const fingerprint=F.sha256(enc.encode(F.canonical({owner:row.owner,id:row.id,property:row.property,value:row.nativeValue})));
    return {...row,fingerprint};
  });
  const sortKeys={"𐀀":7,"\ue000":6,"é":5,"e\u0301":4,"2":3,"10":2,id:"binding",kind:"fixture"};
  assert.equal(S.canonical(sortKeys),'{"kind":"fixture","id":"binding","10":2,"2":3,"e\u0301":4,"é":5,"\ue000":6,"𐀀":7}');
  const dictionary=["𐀀-source-binding", "\ue000-source-binding", "é-source-binding", "e\u0301-source-binding"];
  const large={...entry,residuals,report:{...entry.report,notes:["🚀 parts","🚀 spare","different"]},
    provenance:{...entry.provenance,fields:Array.from({length:180},(_,i)=>({id:"stable-component-"+(i%17),type:"item",
      values:{sourceRecord:"Pads6/Data#"+i,metadata:[i,null,"a",["s",2],{"safe":false,...sortKeys}],
        label:dictionary[i%dictionary.length]}}))}};
  const encoded=await S.prepare([large]),compactBytes=encoded.files.get(encoded.refs[0].path);
  assert.equal(await S.sha(compactBytes),"8f4b0281d6abcbd97760ed005b92225fd73a45570d4658799d6d804e28f9693e");
  assert.deepEqual(S.prepareSync([large]).files.get(encoded.refs[0].path),compactBytes);
  assert.match(dec.decode(compactBytes),/"table":/);const output=S.parse(compactBytes,encoded.refs[0]);
  assert.deepEqual(output.metadata.residuals,residuals);assert.deepEqual(output.metadata.provenance.fields,large.provenance.fields);
  assert.deepEqual(output.metadata.report,large.report);assert.ok(compactBytes.length<S.canonical(residuals).length/2);
  const changed=output.metadata.residuals[2];
  assert.notEqual(changed.fingerprint,F.sha256(enc.encode(F.canonical({owner:changed.owner,id:changed.id,property:changed.property,value:changed.nativeValue+1}))));
  assert.notEqual(changed.fingerprint,F.sha256(enc.encode(F.canonical({owner:"other-scope",id:changed.id,property:changed.property,value:changed.nativeValue}))));
  const nested={...large,binding:{residuals,modelDiagnostics:["retained"]}};delete nested.residuals;
  const older=await S.prepare([nested]),olderRef=older.refs[0];
  const legacyEntry=S.restore(S.parse(older.files.get(olderRef.path),olderRef));
  const selected=S.exportProvenance(legacyEntry);
  assert.equal(selected.precision.scopeId,nested.scopeId);assert.deepEqual(selected.precision.documents,nested.documents);
  assert.deepEqual(selected.precision.rows,residuals);
  assert.deepEqual((await S.prepare([legacyEntry])).files.get(olderRef.path),older.files.get(olderRef.path));
  const prior=dec.decode(compactBytes).trimEnd().split("\n");
  prior[prior.length-1]=S.canonical(output.metadata);
  assert.deepEqual(S.parse(enc.encode(prior.join("\n")+"\n"),encoded.refs[0]).metadata.residuals,residuals);
  const project=Atrium.project("Board",[]),[sheet,pcb]=project.documents;
  sheet.id="sch";pcb.id="pcb";pcb.name="Layout";
  sheet.items.push({id:"photo",kind:"image",x:1,y:1,w:3,h:2,src:"data:image/png;base64,AQIV"});
  AtriumRevisions.freeze(project,{letter:"A",date:"2026-01-01",time:1});
  sheet.items=[]; // The release alone keeps this image reachable.
  const native=AtriumFormat2Model.fromEditor(project,{importIndexes:[r]});
  const assetPath="assets/"+await S.sha(Uint8Array.of(1,2,21));
  const all=new Map([...native.files.map(f=>[f.path,F.serialize(f.file)]),...native.assets.map(a=>[a.path,a.bytes]),
    [r.path,p.files.get(r.path)],[S.IGNORE,enc.encode(S.ignoreText+"# team comment\n")],
    [".waffle/cache/work",enc.encode(shared)],["untracked.wsch",enc.encode(shared)]]);
  const read=async k=>all.get(k),verify=()=>Z.verifyClosure({manifestPath:"Board.waffle",read,original:async()=>source});
  const checked=await verify();assert.ok(checked.files.has(assetPath));assert.equal(checked.members.filter(k=>k.path===S.logical(sha)).length,1);
  const origins=[];
  const grouped=await AtriumFormat2Closure.verify(native.manifest, (path,ref) => {
    if(ref.kind!=="source")return read(path);
    origins.push({path,bindingPath:ref.bindingPath,inputId:ref.inputId});
    return source;
  },{readBatch(paths) {
    assert.ok(!paths.includes(S.logical(sha)),"a retained original is never a generic batch read");
    return Promise.all(paths.map(read));
  }});
  assert.equal(grouped.sha256,checked.version);
  assert.deepEqual(origins,[{path:S.logical(sha),bindingPath:r.path,inputId:binding.inputs[0].id}]);

  assert.equal(checked.members.some(m=>m.path===S.IGNORE),false);
  const closed={...checked,snapshotId:"opaque-lease",read:async k=>checked.files.get(k)||read(k)};
  const a=await Z.archive(closed),b=await Z.archive(closed);assert.deepEqual(a.bytes,b.bytes);assert.equal(a.snapshotId,"opaque-lease");
  const z=Z.zipDirectory(a.bytes),found=await z.projects();assert.deepEqual(found,[{manifest:"Board.waffle",prefix:"Board/",name:"Board"}]);
  const got=await Z.extract(z,found[0],Z.verifyClosure);assert.equal(got.version,checked.version);
  assert.deepEqual([...got.files.keys()].sort(),[...checked.files.keys(),S.IGNORE].sort());
  assert.deepEqual(got.files.get(S.logical(sha)),source);
  assert.deepEqual(got.files.get(r.path),all.get(r.path));assert.equal(dec.decode(got.files.get(S.IGNORE)),S.ignoreText+"# team comment\n");
  assert.ok(!dec.decode(got.files.get("Layout.wpcb")).includes("sourceRules"));
  assert.equal((await S.originalFiles(binding,async f=>got.files.get(f.sourcePath))).length,2);
  // The saved PDF and optional attached ZIP share an opaque read lease. A PDF-only lease
  // must not visit original inputs, models or release payloads until their use is requested.
  require("../../app/project/project-archive-ui.js");
  const expandedLF=enc.encode(prior.join("\n")+"\n"),expandedCRLF=enc.encode(prior.join("\r\n")+"\r\n");
  const physical=new Map([[olderRef.path,expandedCRLF],[S.IGNORE,enc.encode(S.ignoreText)]]);
  const oldEntry=S.restore(S.parse(expandedCRLF,olderRef));
  const sibling=await AtriumProjectArchiveUI.sidecarPlan({entries:[oldEntry,{...entry,scopeId:"next-scope"}],
    prior:[olderRef],read:async p=>physical.get(p)});
  assert.ok(!sibling.plan.some(p=>p.path===olderRef.path),"An unrelated import retains the old physical index byte for byte.");
  assert.equal(sibling.members.find(p=>p.path===olderRef.path).sha256,await S.sha(expandedLF));
  const used=[], archiveReads=[], raw=Uint8Array.of(1,2,21), ref={sha256:assetPath.slice(7),byteLength:3,mediaType:"image/png"};
  const fakeLease={grant:"root",lease:"held",read:async paths=>paths.map(path=>({path,bytes:all.get(path)})),
    async readBatch(paths) {archiveReads.push(paths);return this.read(paths);},
    release:async()=>used.push("release")};
  const session={readLease:async()=>fakeLease,async requireClosure(o){assert.equal(o.assets,false);assert.equal(o.lease,fakeLease);return {
    project,manifestPath:"Board.waffle",members:[{path:"Board.waffle",data:Buffer.from(all.get("Board.waffle")).toString("base64")}]};}};
  const H={project:()=>project,folderProject:()=>session};
  globalThis.AtriumHost={async folderReadAsset(q){used.push(q.lease);assert.equal(q.ownerId,"sch");assert.equal(q.grant,"root");
      return {data:"AQIV",offset:0,length:3,eof:true};},
    async folderReadImportSource(q){used.push("original");assert.equal(q.lease,"held");return {data:Buffer.from(source).toString("base64")};}};
  const saved=await AtriumProjectArchiveUI.acquireSavedExportSnapshot({project,host:H});
  assert.deepEqual(used,[]);const img=await saved.resolveAsset({owner:"sch",ref,purpose:"PDF"});
  assert.deepEqual(img.bytes,raw);assert.equal(img.snapshotId,saved.snapshotId);
  assert.deepEqual(used,["held"]);
  assert.deepEqual(archiveReads,[],"the saved PDF projection leaves ZIP members unread");
  const exported=await saved.projectArchive();assert.equal(exported.snapshotId,saved.snapshotId);assert.deepEqual(exported.bytes,a.bytes);
  assert.ok(archiveReads.some(group=>group.length>1),"ZIP batches closure members from the checked lease");
  assert.ok(archiveReads.every(group=>group.length<=8 && !group.includes(S.logical(sha))),"batch bounds and retained-source authorization apply to ZIP");
  assert.deepEqual(used,["held","original"]);await saved.release();await saved.release();
  await assert.rejects(saved.projectArchive(),/stale/);await assert.rejects(saved.resolveAsset({owner:"sch",ref}),/stale/);
  assert.deepEqual(used,["held","original","release"]);
  delete globalThis.AtriumHost;
  all.delete(assetPath);await assert.rejects(verify(),/Missing required.*assets/);
  for(const path of ["../outside","C:/a","dir/.git/config","one/CON.txt","one/link."]){
    assert.throws(()=>Z.portable(path));}
  const joined=AtriumZip.create([{name:"One.wsch",data:"a"},{name:"one.wsch",data:"b"}]);assert.throws(()=>Z.zipDirectory(joined),/colliding/);
  const ab=new AbortController();ab.abort();await assert.rejects(Z.archive(closed,{signal:ab.signal}));
  console.log("Portable project ZIP, retained source scope, exact portable bytes, transitive release assets and coherent identity passed.");
}
globalThis.__testDone=main().catch(e=>{console.error(e);process.exitCode=1;});
