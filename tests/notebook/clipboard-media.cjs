"use strict";
const assert=require("node:assert/strict");
globalThis.AtriumClipHistory={contains:()=>true,persistMedia:()=>false};
require("../../app/notebook/clipboard-media.js");
const M=AtriumClipboardMedia, sha="0".repeat(64),ref={sha256:sha,mediaType:"image/png",size:3};
const bytes=new Uint8Array([2,3,5]),source={id:"a"},target={id:"b"};
const clip={items:[{kind:"image",asset:ref}]},staged=[],freed=[];
let doc=target;
const original={readAsset:async({ownerId})=>{assert.equal(ownerId,"a");return {bytes};}};
const dest={grant:"g",stageAttachment:r=>staged.push(r),releaseAsset:async r=>freed.push(r.assetToken),readAsset:async()=>{throw Error("unknown asset");}};
const host={folderProject:()=>dest,doc:()=>doc};
globalThis.File ||= class File {constructor(parts,name,{type}){this.parts=parts;this.type=type;}};
let waiting,blocked=false;
globalThis.AtriumHost={notebookTransfer:async({grant,ownerId,mediaType,file})=>{
  assert.equal(grant,"g");assert.equal(ownerId,"b");assert.equal(mediaType,ref.mediaType);assert.equal(file.type,mediaType);
  if(blocked)await new Promise(resolve=>{waiting=resolve;});
  return {assetRef:ref,assetToken:"original",ownerId};
}};
async function run(){
  await M.capture({id:"first"},original,source,clip.items);
  assert.equal(M.bytes(),3);
  await M.prepare("first",clip,host);
  assert.equal(staged.length,0,"no design asset recorded before placement");
  M.commit(clip,target);assert.equal(staged.length,1);
  await M.prepare("first",clip,host);M.cancel();
  assert.deepEqual(freed,["original"]);assert.throws(()=>M.commit(clip,target));
  blocked=true;const delayed=M.prepare("first",clip,host);
  while(!waiting)await Promise.resolve();
  doc=source;waiting();
  await assert.rejects(delayed);assert.equal(freed.length,2);assert.equal(staged.length,1);
  await M.forget("first");assert.equal(M.bytes(),0);
  console.log("PASS cross-project verified original image, one committed transfer, cancelled/pending cleanup");
}
globalThis.__testDone=run().catch(e=>{console.error(e);process.exitCode=1;});
