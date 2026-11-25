"use strict";
const assert = require("node:assert/strict");
require("../../app/project/drop-receiver.js");
const D = AtriumDrop;
const content = new TextEncoder().encode("%PDF-1.7\nexample");
const source = (bytes = content) => ({files:[{name:"About PCB.pdf", mime:"application/pdf", size:bytes.length, bytes}]});
const sheet = {kind:"sheet",id:"selected-sheet",point:[12,-2]};
const code = expected => error => error?.code === expected;

async function main() {
  const pdf = source().files[0];
  assert.equal(D.fileMetadata(pdf).kind,"pdf");
  assert.deepEqual((await D.readBytes(pdf)).bytes,content);
  const bom = Uint8Array.from([239,187,191,...content]);
  assert.deepEqual((await D.readBytes(source(bom).files[0])).bytes,bom);
  await assert.rejects(D.readBytes({...pdf, bytes:new Uint8Array(content.length)}),code("invalid_payload"));
  await assert.rejects(D.readBytes({...pdf, size:content.length + 1}),code("invalid_payload"));
  assert.throws(()=>D.fileMetadata({...pdf,name:"../report.pdf"}),code("invalid_name"));
  assert.throws(()=>D.fileMetadata({...pdf,mime:"image/svg+xml"}),code("invalid_payload"));
  assert.throws(()=>D.fileMetadata({...pdf,size:129 * 1024 ** 2}),code("resource_limit"));
  assert.throws(()=>D.describe({kind:"pdf",id:"no-file"},sheet),code("ungranted_source"));
  assert.throws(()=>D.describe(source(),{kind:"board"}),code("unsupported_target"));
  assert.throws(()=>D.describe(source(),{...sheet,point:[Infinity,25]}),code("invalid_target"));
  assert.throws(()=>D.describe({files:Array(33).fill(pdf)},sheet),code("resource_limit"));
  assert.equal(D.describe({kind:"bom-row",id:"row-5"},{kind:"board"}).route,"place-library");
  assert.equal(D.describe({kind:"net",id:"net-7"},{kind:"rule"}).route,"scope-rule");

  let streamed = 0, stopped = 0;
  const stream = chunks => ({getReader(){
    let i = 0;
    return {async read(){streamed++; return i < chunks.length ? {done:false,value:chunks[i++]} : {done:true};},
      async cancel(){stopped++;}, releaseLock(){}};
  }});
  const {bytes:unused,...metadata} = pdf;
  const inChunks = {...metadata,stream:()=>stream([content.subarray(0,8),content.subarray(8)])};
  assert.deepEqual((await D.readBytes(inChunks)).bytes,content);
  assert.equal(streamed,3);
  assert.equal(stopped,0);
  await assert.rejects(D.readBytes({...metadata,stream:()=>stream([new Uint8Array(content.length + 1)])}),code("invalid_payload"));
  assert.equal(stopped,1);

  let enabled = false, reads = 0, edited = 0, released = 0;
  const scope = {}, replacement = {};
  let active = scope;
  const receiver = D.createReceiver({enabled:()=>enabled,current:token=>token===active,handlers:{
    "insert-pdf": ({inputs,target,signal}) => {
      assert.equal(signal.aborted,false);
      assert.deepEqual(inputs[0].bytes,content);
      assert.deepEqual(target,sheet);
      return {apply:()=>{edited++; return {inserted:true};}, release:()=>{released++;}};
    }
  }});
  assert.throws(()=>receiver.capture(source(),sheet,scope), code("butter_disabled"));
  enabled = true;
  const choose = () => receiver.capture({files:[{...metadata,stream(){reads++;return stream([content]);}}]},sheet,scope);
  const blocked = choose();
  await assert.rejects(receiver.apply(blocked),code("consent_required"));
  assert.equal(reads,0);
  await assert.rejects(receiver.apply(blocked,()=>false),code("consent_required"));
  assert.equal(reads,0);
  assert.equal(receiver.inspect(blocked).state,"cancelled");

  const kept = choose();
  const publicInfo = receiver.inspect(kept);
  assert.equal(JSON.stringify(publicInfo).includes("%PDF"),false);
  assert.equal(publicInfo.files[0].name,"About PCB.pdf");
  publicInfo.target.point[0] = 90;
  assert.deepEqual(await receiver.apply(kept,()=>true),{inserted:true});
  assert.equal(receiver.inspect(kept).state,"complete");
  assert.equal(edited,1);
  assert.equal(released,1);
  await assert.rejects(receiver.apply(kept,()=>true),code("ungranted_source"));

  const stale = choose();
  await assert.rejects(receiver.apply(stale,()=>{ active = replacement; return true; }),code("stale_target"));
  assert.equal(reads,1);
  active = scope;
  const cancelled = choose();
  let allow;
  const pending = receiver.apply(cancelled,()=>new Promise(resolve=>{allow=resolve;}));
  assert.equal(receiver.cancel(cancelled),true);
  allow(true);
  await assert.rejects(pending,code("cancelled"));
  assert.equal(edited,1);
  assert.equal(released,1);

  let allowCommit, grant, enter;
  const entered = new Promise(resolve=>{enter=resolve;});
  const deferred = D.createReceiver({enabled:()=>true,current:token=>token===active,handlers:{
    "insert-pdf": ({inputs})=>({apply:async ({commit})=>{
      grant = inputs[0];
      await new Promise(resolve=>{allowCommit=resolve;enter();});
      commit();
      edited++;
    }})
  }});
  const preparing = deferred.capture({files:[pdf]},sheet,scope);
  const started = deferred.apply(preparing,()=>true);
  await Promise.race([entered,started]);
  assert.equal(deferred.inspect(preparing).state,"preparing");
  assert.throws(()=>D.consumeMedia(grant,{...pdf}),code("ungranted_source"));
  assert.deepEqual(D.consumeMedia(grant,pdf),content);
  assert.throws(()=>D.consumeMedia(grant,pdf),code("ungranted_source"));
  assert.equal(deferred.cancel(preparing),true);
  allowCommit();
  await assert.rejects(started,code("cancelled"));
  assert.equal(edited,1,"cancelling during application preparation cannot commit a later edit");
  console.log("PASS drop registry, bounded PDF bytes, one-shot consent, stale-target and cancellation checks");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
