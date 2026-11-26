"use strict";
// Exact airwires after an item moves within its existing contact graph.
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "board-shape", "net-ties", "undo-store", "engine-core", "connectivity", "diagnostics", "connectivity-live"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const U = AtriumUndoStore, C = AtriumConnectivity, L = AtriumConnectivityLive, A = Atrium;
const via = (id, x, y, net) => ({id,kind:"via",x,y,net,diameter:.8,drill:.3,layer:"Multi"});
const track = (id, x, y, net) => ({id,kind:"track",net,layer:"Top",width:.2,points:[[x,y],[x+3,y]]});
const d = A.sheet("pcb","Local projection");
const resistor = A.clone(AtriumParts.catalogue.find(def => def.id === "std-r"));
const part = {id:"part",kind:"part",def:resistor.id,ref:"R1",x:0,y:10,angle:0,pinNets:{"1":"A","2":"B"}};
const mover = via("mover",2,0,"A"), other = via("other",12,0,"A"), neighbour = track("join",0,0,"A");
const spare = track("unused",25,20,"");
d.items.push(part,mover,other,neighbour,spare,via("b",8,2,"B"),via("c",8,4,"C"),via("c2",12,4,"C"));
const defs = new Map([[resistor.id,resistor]]), project = {documents:[d],library:[resistor]}, history=[], future=[];
U.mark(project);
const fields = r => [r.nets,r.airwires,r.shorts,r.excluded,r.unassigned,r.stats.objects,r.stats.features,r.sourceNotes];
let last, lastBytes;
function drain(work) {
  let n=0, s=work.next(); while(!s.done){n++; s=work.next();}
  return {slices:n,result:s.value};
}
function check(label, local) {
  const {result,slices} = drain(L.stages(d,defs,U));
  const clone=A.clone(d), freshDefs=new Map(project.library.map(x=>[x.id,A.clone(x)]));
  const full=C.inspectFull(clone,freshDefs);
  assert.deepEqual(fields(result),fields(full),label);
  // Live contacts include every touching feature pair. Full inspect skips
  // already-joined pairs; a cold live solve provides the independent count.
  const fromScratch=L.inspect(clone,freshDefs);
  if(fromScratch)assert.equal(result.stats.contacts,fromScratch.stats.contacts,label+" contact count");
  if(last)assert.equal(JSON.stringify(fields(last)),lastBytes,label+" keeps the previous public result intact");
  if(local!=null)assert.equal(slices===1,local,label+" local projection");
  last=result;lastBytes=JSON.stringify(fields(last));
  return result;
}
function edit(label, fn, local) {
  const before=U.mark(project); fn(); U.checkpoint(history,future,before,label); U.record(project);
  return check(label,local);
}
check("seed",false);
const unrelated = last.airwires.find(w=>w.net==="C");
for(let k=0;k<6;k++){
  edit("part anchors "+k,()=>{part.x+=.15;},true);
  assert.equal(last.airwires.find(w=>w.net==="C"),unrelated,"an untouched net keeps its exact airwire");
  edit("via keeps its track contact "+k,()=>{mover.x+=.03;},true);
  edit("unnamed track "+k,()=>{spare.points[0][1]+=.1;},true);
}
edit("BOM-only edit",()=>{part.value="22k";},true);
assert.equal(last.stats.candidates,0);
edit("new contact and short",()=>{mover.x=8;mover.y=4;},false);
assert.ok(last.shorts.length);
edit("old short requires ordered witness pass",()=>{part.y+=.1;},false);
edit("remove the short",()=>{mover.x=20;mover.y=0;},false);
edit("hit a different existing island",()=>{mover.x=other.x;mover.y=other.y;},false);
edit("same neighbouring via",()=>{mover.x+=.01;},true);
edit("change the net but keep the neighbouring via",()=>{mover.net="B";},false);
assert.ok(last.shorts.length);
for(const direction of [-1,-1,1,1]){
  assert.ok(U.jump(history,future,U.mark(project),direction));U.record(project);check("undo or redo");
}
edit("clear short again",()=>{mover.net="A";},false);
edit("shape becomes masked from electrical layers",()=>{neighbour.layer="Mechanical";},false);
edit("restore shape",()=>{neighbour.layer="Top";},false);
edit("replace item with the same identifier",()=>{d.items[d.items.indexOf(spare)]={...spare,points:[[60,10],[61,10]]};},false);
edit("reorder actual item slots",()=>{d.items.reverse();},false);
edit("change a library pad in place",()=>{resistor.footprint.pads[0].x+=.33;},false);

// Monotone undo ids cover both aborted and superseding projections. An
// abandoned stage may already have updated its physical contact graph.
part.y+=.1;U.record(project);const abandoned=L.stages(d,defs,U);abandoned.next();
mover.x+=.01;U.record(project);check("superseded move",false);abandoned.return();
edit("after the cancellation has been reconciled",()=>{part.y+=.1;},true);

let state="source";
globalThis.AtriumPolygonPour={state:()=>state};
d.pcbDrawing={pours:[{links:[[part.id,"pad0"],[other.id,0]]}]};U.record(project);
check("pour joins two islands",false);
state="stale";edit("a stale pour drops its links",()=>{part.x+=.1;},false);
state="source";edit("fresh copper reinstates the links",()=>{part.x+=.1;},false);
edit("duplicate region endpoints use the full projection",()=>{d.pcbDrawing.pours[0].links=[[other.id,0],[other.id,0]];},false);
edit("single endpoint stops making any joins",()=>{d.pcbDrawing.pours[0].links=[[other.id,0]];},false);
edit("one-endpoint region",()=>{part.y+=.1;},true);
edit("a new pair of endpoints broadens the scope",()=>{d.pcbDrawing.pours[0].links.push([part.id,"pad0"]);},false);
edit("no remaining links",()=>{d.pcbDrawing.pours=[];},false);
edit("project replacement or expired cursor",()=>{project.documents.push(A.sheet("schematic","S"));},false);
// quick(): the edit frame's pass. Finished within its budget, it equals the full inspection;
// unfinished, deferAirwires continues the same pass in the edit pipeline.
{
  const before=U.mark(project); mover.x+=.2; U.checkpoint(history,future,before,"quick"); U.record(project);
  const q=L.quick(d,defs,U,1e9);
  assert.ok(q.result,"a generous budget finishes now");
  assert.deepEqual(fields(q.result),fields(C.inspectFull(A.clone(d),new Map(project.library.map(x=>[x.id,A.clone(x)])))),"quick equals full");
  const before2=U.mark(project); mover.x-=.2; U.checkpoint(history,future,before2,"quick later"); U.record(project);
  const started=L.quick(d,defs,U,-1);
  assert.ok(started.work&&!started.result,"no budget: the pass waits");
  const jobs=[];let published=null;
  const stage=(phase,key,fn)=>{const job={current:()=>true,cancel(){},run:()=>fn(job.current,{timeRemaining:()=>50})};jobs.push(job);return job;};
  const recording=AtriumDiagnostics.startPerformance();
  const obsolete=L.deferAirwires(d,defs,U,stage,"other-canvas",()=>false,()=>assert.fail("stale connectivity was published"));
  obsolete.cancel();
  jobs.shift();
  L.deferAirwires(d,defs,U,stage,"canvas",()=>true,result=>{published=result;},started);
  while(jobs.length&&!published)jobs.shift().run();
  assert.ok(published,"the pipeline finishes the started pass");
  assert.deepEqual(fields(published),fields(C.inspectFull(A.clone(d),new Map(project.library.map(x=>[x.id,A.clone(x)])))),"continued pass equals full");
  recording.stop();
  const rows=AtriumDiagnostics.performanceSnapshot().rows;
  assert.deepEqual(rows.find(row=>row.component==="connectivity"&&row.operation==="compute").counts,
    {queued:2,started:1,ready:1,visible:0,durable:0,completed:1,cancelled:1,failed:0});
  assert.equal(rows.find(row=>row.component==="connectivity"&&row.operation==="publish").counts.completed,1);
}
U.reset();
console.log("PASS exact local airwires: reused nets, moves, short witnesses, masks, pours, history, supersession and the edit frame's pass");
