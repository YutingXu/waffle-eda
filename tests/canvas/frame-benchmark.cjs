"use strict";
const assert=require("node:assert/strict");
const path=require("node:path");
const fs=require("node:fs");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../pcb/dense-board.js");require("./frame-benchmark.js");
const B=AtriumFrameBenchmark;
async function main(){
  const board=makeAtriumBenchmarkBoard();assert.equal(board.d.items.length,25600);
  const histogram=Object.create(null);
  for(const i of board.d.items)histogram[i.kind]=(histogram[i.kind]||0)+1;
  assert.deepEqual(Object.keys(histogram).sort(),["pad","part","track","via"]);
  assert.equal(new Set(board.d.items.map(i=>i.id)).size,25600);
  assert.deepEqual(B.percentiles([40,0,10,30,20]),{p50:20,p95:38,p99:39.6});
  assert.equal(B.settings.measurementMs,8000);
  for(const phase of ["baseline","warmup","measuring"])assert.deepEqual(B.controls(phase,true),{start:false,stop:true,export:false});
  assert.deepEqual(B.controls("idle",false),{start:true,stop:false,export:false});
  assert.deepEqual(B.controls("complete",true),{start:true,stop:false,export:true});
  const r=B.summarize([10,10,10,10,10],[10,20,30],[2,3,4],[1,1,1],[3,4,5]);
  assert.equal(r.baseline_hz,100);assert.equal(r.measured_frames,3);assert.equal(r.elapsed_ms,60);
  assert.equal(r.estimated_missed_refresh_slots,3);assert.equal(r.estimated_missed_refresh_percent,50);
  assert.deepEqual(JSON.parse(B.encode(r)),r);
  assert.throws(()=>B.summarize([0,0,0,0,0],[],[],[],[]));
  assert.throws(()=>B.summarize([10,10,10,10,10],[10],[5,5],[3],[8]));
  const ctrl=new AbortController(),queue=new Map();let id=0;
  const api={signal:ctrl.signal,schedule(cb){queue.set(++id,cb);return id;},cancel(id){queue.delete(id);}};
  const ticks=[],done=B.timeline(30,api,(t,dt,last)=>ticks.push([t,dt,last]));
  for(const timestamp of [100,110,130]){
    const [job,fn]=queue.entries().next().value;queue.delete(job);fn(timestamp);
  }
  await done;assert.deepEqual(ticks,[[0,null,false],[1/3,10,false],[1,20,true]]);assert.equal(queue.size,0);
  const interrupted=B.timeline(500,api,()=>assert.fail("called after abort"));
  ctrl.abort("test cancelled");await assert.rejects(interrupted,/test cancelled/);assert.equal(queue.size,0);
  const html=fs.readFileSync(path.join(__dirname,"frame-benchmark.html"),"utf8");
  for(const [,file] of html.matchAll(/<script src="([^"]+)"/g))assert.ok(fs.existsSync(path.resolve(__dirname,file)),file);
  console.log("PASS deterministic 25,600-object workload, percentiles, missed-slot estimates, JSON, UI state, phase timing and cancellation");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
