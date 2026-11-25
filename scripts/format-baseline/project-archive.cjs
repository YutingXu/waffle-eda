"use strict";
// Historical archive replay. Run from the recorded da175c2c product checkout.
// Read a previously converted folder {folder, manifest}, or normal original inputs in the
// import-sidecars.cjs input format plus storage:"tracked"|"copied". Print only aggregate
// results. Extraction and readback take place in a disposable folder outside the input tree.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const root=path.resolve(__dirname,"../.."),native=path.join(root,"native");
require("./import-sidecars.cjs");
for(const script of ["core/zip","vendor/zipjs-deflate","formats/format-2-models","formats/format-2-closure","project/project-archive"])
  require(path.join(root,"app",script+".js"));
const F=AtriumFormat2,S=AtriumImportSidecars,Z=AtriumProjectArchive;
const encoder=new TextEncoder();
function helper(args,input) {
  return execFileSync(process.env.PYTHON||"python3",["-I","-B",...args],{
    input:JSON.stringify(input),encoding:"utf8",maxBuffer:512*1048576,stdio:["pipe","pipe","pipe"]
  });
}
function command(op,query) {
  return JSON.parse(helper([path.join(native,"project_archive.py"),op],query));
}
function readPinned(destination,row) {
  const code="import base64,json,sys;sys.path.insert(0,sys.argv[1]);from import_sources import read_pinned;"+
    "r=json.load(sys.stdin);print(base64.b64encode(read_pinned(sys.argv[2],r['git'],r['sha256'],r['byteLength'])).decode())";
  return Buffer.from(helper(["-c",code,native,destination],row).trim(),"base64");
}
function folderInput(q) {
  const folder=fs.realpathSync(q.folder),manifestPath=F.portablePath(q.manifest||"project.waffle");
  function read(member) {
    let file=folder;
    for(const component of F.portablePath(member).split("/")){
      file=path.join(file,component);
      if(!fs.existsSync(file))return;
      assert.ok(!fs.lstatSync(file).isSymbolicLink(),"A saved member must stay in the selected folder.");
    }
    return fs.readFileSync(file);
  }
  return {manifestPath,read,original:(binding,row)=>Buffer.from(command("original",{
    root:folder,manifest:manifestPath,bindingPath:binding.ref.path,inputId:row.id
  }).data,"base64")};
}
async function translatedInput(q) {
  assert.ok(Array.isArray(q.files)&&q.files.length>0&&q.files.length<=500,"Choose a bounded source set.");
  assert.ok(["tracked","copied"].includes(q.storage),"Choose a retention mode.");
  const files=q.files.map(f=>({name:f.name,...(f.path?{path:f.path}:{}),
    bytes:new Uint8Array(f.data?Buffer.from(f.data,"base64"):fs.readFileSync(f.selectedPath))}));
  const input=AtriumTranslators.import(files,{translator:q.translator});
  const model=AtriumFormat2Model.fromLegacy(input);
  const entry={scopeId:"validation",names:files.map(file=>file.name),documents:input.model.documents.map(d=>d.id),
    adopted:true,provenance:input.provenance,report:input.report,residuals:model.residuals};
  const originalSelections=new Map(input.provenance.files.map((file,i)=>[file,q.files[i]]));
  const tracked=q.storage==="tracked";
  const prepared=await S.prepare([entry],{locate:tracked?async ({file,sha256,byteLength})=>{
    const source=originalSelections.get(file)?.selectedPath;
    assert.ok(source&&q.destination,"Select a file in the case working tree.");
    const {git}=command("locate",{root:q.destination,source,sha256,byteLength});
    assert.ok(git,"The selected source needs a verified commit in this mode.");
    return git;
  }:undefined});
  const manifest=F.applyDelta(model.manifest,{put:prepared.refs}).file;
  const members=new Map(model.files.map(({path,file})=>[path,F.serialize(file)]));
  for(const file of [...model.assets,...model.models])members.set(file.path,file.bytes);
  for(const [path,bytes] of prepared.files)members.set(path,bytes);
  members.set(model.manifestPath,F.serialize(manifest));
  return {manifestPath:model.manifestPath,read:member=>members.get(member),expectedResiduals:model.residuals,
    original:tracked?(_binding,row)=>readPinned(q.destination,row):undefined};
}
async function verifyArchive(q) {
  const input=q.folder?folderInput(q):await translatedInput(q);
  const closure=await Z.verifyClosure(input);
  const ignore=await input.read(S.IGNORE)??encoder.encode(S.ignoreText);
  const source={...closure,read:member=>member===S.IGNORE?ignore:closure.files.get(member)};
  const archive=await Z.archive(source);
  assert.deepEqual((await Z.archive(source)).bytes,archive.bytes);
  const zip=Z.zipDirectory(archive.bytes),projects=await zip.projects();
  assert.equal(projects.length,1);
  const expanded=await Z.extract(zip,projects[0],Z.verifyClosure);
  assert.equal(expanded.version,closure.version);
  const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"waffle-archive-qa-")));
  try{
    const result=command("install",{parent:tmp,manifest:expanded.manifest,version:expanded.version,
      files:[...expanded.files].map(([path,bytes])=>({path,data:Buffer.from(bytes).toString("base64")}))});
    const installed=folderInput({folder:path.dirname(result.manifest),manifest:path.basename(result.manifest)});
    const reopened=await Z.verifyClosure(installed);
    assert.equal(reopened.version,closure.version);
    let originals=0;
    const recovered=[];
    for(const binding of reopened.indexes){
      const rows=S.exportProvenance(S.restore(binding)).precision?.rows || [];
      for(const row of rows)recovered.push(row);
      for(const row of binding.inputs){
        const raw=await installed.original(binding,row);
        assert.equal(raw.byteLength,row.byteLength);assert.equal(await S.sha(raw),row.sha256);
        originals++;
      }
    }
    if(input.expectedResiduals)assert.deepEqual(recovered,input.expectedResiduals,"The original precision records changed during portable readback.");
    return {members:expanded.files.size,models:closure.members.filter(m=>m.kind==="model").length,
      importScopes:reopened.indexes.length,verifiedOriginals:originals,verifiedResiduals:recovered.length,
      zipBytes:archive.bytes.length,deterministic:true,sameVersion:true,nativeReopened:true};
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
}
if(require.main===module)verifyArchive(JSON.parse(fs.readFileSync(0,"utf8"))).then(result=>console.log(JSON.stringify(result))).catch(error=>{
  console.error("Portable project verification failed ("+(error.code||error.name||"verification")+")");process.exitCode=1;
});
module.exports={verifyArchive};
