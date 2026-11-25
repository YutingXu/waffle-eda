"use strict";
// Run with node --expose-gc scripts/bench-design-query.cjs.
const assert=require("node:assert/strict"),os=require("node:os");
for(const name of ["core/model","library/parts","checks/design-query"])require("../app/"+name+".js");
require("../tests/pcb/dense-board.js");
const sample=(values,p)=>+values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)].toFixed(3);
const summary=times=>({p50:sample(times,.5),p95:sample(times,.95)});
function project() {
  const p=Atrium.project("Query density",AtriumParts.catalogue),{d}=makeAtriumBenchmarkBoard();
  p.documents=p.documents.map(v=>v.kind==="pcb"?d:v);
  for(const [i,row] of d.items.entries()) {
    if(row.kind==="part")row.pinNets={1:"N"+(i%64),2:"N"+((i+1)%64)};
    else if(row.kind!=="track")row.net="N"+(i%64);
  }
  for(let i=0;i<60;i++)p.documents.push(Atrium.sheet("schematic","Sheet "+(i+2)));
  return {p,d};
}
function harness() {
  const {p,d}=project();let seq=1,edit=null;
  const store={documentVersions:()=>({seq}),recordedChanges:()=>({ids:new Set([edit.id]),items:new Map([[edit.id,edit]])})};
  const ctx=AtriumDesignQuery.context(p,d,{store});
  const sources=['part where designator = "R1"','track on layer Top and width < 0.23 mm'];
  async function run(source) {
    const start=performance.now();
    const checked=AtriumDesignQuery.compile(source,ctx);
    assert.ok(checked.ok,JSON.stringify(checked.diagnostics));
    const ix=await AtriumDesignQueryIndex.documentIndex(p,d,ctx,checked.plan,{store,revision:seq});
    let first;
    const result=await checked.plan.run(ix,{limit:1,onPage:()=>{first??=performance.now();}});
    assert.ok(result.complete);assert.ok(first!=null);
    return {first:first-start,final:performance.now()-start,count:result.count,checked:result.checked};
  }
  return {run,sources,seq:()=>seq,touch(row){edit=row;seq++;},d,p,ctx};
}
async function main() {
  const cold=[],coldFinal=[],bytes=[];
  for(let i=0;i<10;i++) {
    const h=harness();global.gc?.();
    const before=process.memoryUsage().heapUsed,r=await h.run(h.sources[0]);
    assert.equal(r.count,1);cold.push(r.first);coldFinal.push(r.final);
    global.gc?.();bytes.push(process.memoryUsage().heapUsed-before);
  }
  const h=harness(),report={hardware:os.cpus()[0]?.model,node:process.version,objects:h.d.items.length,sheets:h.p.documents.length-1,
    cold:{runs:10,firstMs:summary(cold),finalMs:summary(coldFinal),retainedBytes:summary(bytes)},warm:{}};
  for(const [i,source] of h.sources.entries()) {
    await h.run(source);
    const first=[],final=[],visited=[];
    for(let j=0;j<24;j++){const r=await h.run(source);first.push(r.first);final.push(r.final);visited.push(r.checked);}
    report.warm[i?"complex":"exact"]={runs:24,source,firstMs:summary(first),finalMs:summary(final),visited:summary(visited)};
  }
  const fresh=[],visited=[];
  for(const part of h.d.items.filter(i=>i.kind==="part").slice(1,25)) {
    const r=await h.run("part where designator = "+JSON.stringify(part.ref));
    assert.equal(r.count,1);fresh.push(r.first);visited.push(r.checked);
  }
  report.warm.distinctExact={runs:fresh.length,firstMs:summary(fresh),visited:summary(visited)};
  const local="track where width < 0.23 mm";await h.run(local);
  const track=h.d.items.find(r=>r.kind==="track");track.width=.3;h.touch(track);
  const changed=await h.run(local);
  const note={id:"unrelated-note",kind:"note",color:"blue"};h.d.items.push(note);h.touch(note);
  const unrelated=await h.run(local);
  assert.equal(changed.checked,1);assert.equal(unrelated.checked,0);
  const countStart=performance.now(),aggregate=await AtriumDesignQuery.count('part where designator = "R1"',{project:h.p,revision:h.seq(),store:{documentVersions:()=>({seq:h.seq()})}});
  assert.equal(aggregate.count,1);
  report.delta={widthRows:changed.checked,noteRows:unrelated.checked};
  report.projectCount={documents:h.p.documents.length,count:aggregate.count,ms:+(performance.now()-countStart).toFixed(3)};
  console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
