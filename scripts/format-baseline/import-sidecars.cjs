"use strict";
// Historical storage replay. Run from the recorded 8251601d product checkout.
// Input JSON on stdin: {translator,destination?,files:[{name,path?,selectedPath?,data?}]}.
// data is base64 of the exact authorised input. selectedPath lets the host verify provenance
// against destination, or supplies the contents if data is absent. Output is aggregate only.
const fs=require("node:fs"),path=require("node:path"),{execFileSync}=require("node:child_process");
const root=path.resolve(__dirname,"../.."),app=path.join(root,"app");
globalThis.CFB=require(path.join(app,"vendor/cfb.min.js"));
require(path.join(app,"translator-worker-modules.js"));
for(const group of ["core","source-file","import-formats","import-rules"])for(const file of AtriumTranslatorWorkerModules[group]||[]){
  if(file!=="vendor/cfb.min.js")require(path.join(app,file));
}
for(const name of ["translator-table","translator-registry","translator-provenance","translator-adapters","translators",
  "format-2-codec","format-2-units","format-2-values","format-2-model","import-sidecars"])require(path.join(app,name+".js"));
async function measure(q){
  if(!Array.isArray(q.files)||q.files.length>500)throw Error("Choose a bounded source set.");
  const selected=q.files.map(f=>({name:f.name,...(f.path?{path:f.path}:{}),
    bytes:f.data ? new Uint8Array(Buffer.from(f.data,"base64")) : new Uint8Array(fs.readFileSync(f.selectedPath))}));
  const input=AtriumTranslators.import(selected,{translator:q.translator});
  const native=AtriumFormat2Model.fromLegacy(input);
  const e={scopeId:"05aaab15-4e8d-45ab-8b6d-000000000001",names:selected.map(f=>f.name),documents:input.model.documents.map(d=>d.id),
    adopted:true,report:input.report,provenance:input.provenance,residuals:native.residuals};
  const original=new Map(input.provenance.files.map((f,i)=>[f,q.files[i]]));
  const S=AtriumImportSidecars;
  async function costs(p){
    const index=p.refs.map(r=>S.parse(p.files.get(r.path),r)),rows=index.flatMap(r=>r.inputs);
    const recovered=S.restore(index[0]);
    const {files:originals,...originalProjection}=e.provenance,{files:readFiles,...readProjection}=recovered.provenance;
    function identical(a,b){return S.canonical(a)===S.canonical(b);}
    if(!identical(recovered.residuals||[],e.residuals||[])||!identical(recovered.report,e.report)||
       !identical(originalProjection,readProjection)||!identical(recovered.documents,e.documents)||
       !identical(recovered.names,e.names)||originals.some((f,i)=>readFiles[i].sha256!==f.sha256))
      throw Error("Retained report, source projection or precision binding failed exact logical readback.");
    const total=Array.from(p.files.values()).reduce((n,b)=>n+b.length,0),meta=p.refs.reduce((n,r)=>n+p.files.get(r.path).length,0);
    const F=AtriumFormat2,updated=F.applyDelta(native.manifest,{put:p.refs}).file;
    const manifestReferenceBytes=F.serialize(updated).length-F.serialize(native.manifest).length;
    const ignoreBytes=new TextEncoder().encode(S.ignoreText).length;
    return {verifiedResiduals:recovered.residuals?.length||0,manifestReferenceBytes,ignoreBytes,bindingBytes:meta,copiedBytes:total-meta,sidecarBytes:total,sourceBindings:rows.length,gitBindings:rows.filter(r=>r.git).length,
      distinctOriginals:p.originals.size,originalBytes:[...p.originals.values()].reduce((n,b)=>n+b.length,0)};
  }
  const copied=await costs(await S.prepare([e])),answer={copied,documents:e.documents.length,nativeMembers:native.files.length,precisionResiduals:native.residuals.length};
  if(q.destination){
    const plan=await S.prepare([e],{locate:async grant=>{
      const selected=original.get(grant.file);
      if(!selected?.selectedPath)throw Error("A selected path is required to measure Git retention.");
      const result=execFileSync(process.env.PYTHON||"python3",["-I","-B",path.join(root,"native/project_archive.py"),"locate"],
        {input:JSON.stringify({root:q.destination,source:selected.selectedPath,sha256:grant.sha256,byteLength:grant.byteLength}),
          encoding:"utf8",stdio:["pipe","pipe","pipe"]});
      return JSON.parse(result).git;
    }});
    answer.verifiedWorktree=await costs(plan);
  }
  return answer;
}
if(require.main===module)measure(JSON.parse(fs.readFileSync(0,"utf8"))).then(v=>console.log(JSON.stringify(v))).catch(e=>{
  // Report operation and category; input names and project content belong to the caller.
  console.error("Sidecar measurement failed: "+(e.code||e.name||"verification error"));process.exitCode=1;});
module.exports={measure};
