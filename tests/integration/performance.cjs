"use strict";
const assert=require("node:assert/strict");
const {performance}=require("node:perf_hooks");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/core/spatial.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/canvas/canvas.js");
require("../../app/history/undo-store.js");
const A=Atrium, spatial=AtriumSpatial;
const argv=new Set(process.argv.slice(2));
function viewport(){
  const noop=()=>{};
  const ctx=new Proxy({}, {get:(t,k)=>t[k]??noop});
  return AtriumCanvas.create({width:0,height:0,getContext:()=>ctx,getBoundingClientRect:()=>({width:960,height:640})});
}
function intersect(a,b){return !(a[0]>b[2]||a[2]<b[0]||a[1]>b[3]||a[3]<b[1]);}
function checkIndex(){
  const boxes=[[0,0,20000,0],[-1,-1,0,0],[4,4,4,4],[-5,-20,-1,9],[0,0,1000000,1000000],[1e7,0,1.1e7,9],[0,0,.1,.1]];
  const entries=boxes.map((b,i)=>({id:i,b})),index=spatial.create(entries,i=>i.b);
  const queries=[[0,0,0,0],[-30,-30,0,0],[1e7,1,1e7,2],[-1e8,-1e8,1e8,1e8],[15000,-1,15001,1]];
  for(const q of queries)assert.deepEqual(index.query(q),entries.filter(e=>intersect(e.b,q)));
  entries[4].b=[-2e4,-2e4,-19998,-19998];index.update(entries[4]);
  for(const q of [...queries,entries[4].b])assert.deepEqual(index.query(q),entries.filter(e=>intersect(e.b,q)));
}
function checkSharedLibrary(){
  const p=A.project("Shared geometry",[{id:"shared",symbol:{parts:2,pins:[{part:1,x:0,y:0}],shapes:[]},
    footprint:{pads:[{x:0,y:0,w:1,h:1,layer:"Top"}],shapes:[]}}]);
  const d=p.documents[1],def=p.library[0],defs=new Map([[def.id,def]]);
  const part={id:"U1",kind:"part",def:def.id,x:2,y:2,showRef:false};d.items.push(part);
  const U=AtriumUndoStore,v=viewport(),near=x=>v.query(d,defs,[x-.2,1.8,x+.2,2.2]).includes(part);
  U.mark(p);
  const layers=()=>AtriumPCBAppearance.footprintLayers(part,def.footprint).map(x=>x.layer);
  assert.equal(near(2),true);assert.equal(near(12),false);assert.deepEqual(layers(),["Top"]);
  assert.equal(A.gate(def.symbol,part).pins.length,1);
  def.footprint.pads[0].x=10;def.footprint.pads[0].layer="Bottom";def.symbol.pins[0].part=2;
  U.touch(p);AtriumCanvas.edited();
  assert.equal(near(2),false);assert.equal(near(12),true);assert.deepEqual(layers(),["Bottom"]);
  assert.equal(A.gate(def.symbol,part).pins.length,0);
  let recorded=0;const off=U.onLibraryChange(()=>recorded++);
  U.sync();
  assert.equal(recorded,1);assert.equal(near(2),false);assert.equal(near(12),true);
  // Another same-identity mutation can be recorded before a pane receives an editor epoch.
  def.footprint.pads[0].x=20;U.record(p);
  assert.equal(near(12),false);assert.equal(near(22),true);assert.equal(recorded,2);
  part.x=3;U.record(p);assert.equal(recorded,2);
  off();U.reset();
}
function checkPouredConnections(){
  require("../../app/checks/connectivity.js");
  require("../../app/pcb/pcb-pours.js");
  require("../../app/pcb/polygon-pour.js");
  const p=A.project("Poured link"),d=p.documents[1],defs=new Map();
  d.items=["a","b"].map((id,n)=>({id,kind:"pad",layer:"Top",x:n*8,y:0,w:1,h:1,net:"N"}));
  const region=AtriumPCBPours.region([[[-1,-1],[9,-1],[9,1],[-1,1]]],"Top","N",{links:[["a",0],["b",0]]});
  d.pcbDrawing={annotations:{},pours:[region]};
  AtriumPCBPours.storeSignature(d,defs,p);
  const v=viewport(),U=AtriumUndoStore;
  U.mark(p);
  try{
    const cached=v.boardConnectivity(d,defs);
    assert.equal(cached.airwires.length,0);
    assert.equal(v.boardConnectivity(d,defs),cached,"an unchanged board reuses the cached graph");
    // The connection links change while the contour and its input stamp stay current.
    region.links=[["a",0]];U.record(p);AtriumCanvas.edited(false);
    assert.ok(AtriumPCBPours.matchesSignature(d,defs,p));
    const fresh=AtriumConnectivity.inspectFull(d,defs);
    assert.equal(fresh.airwires.length,1);
    const updated=v.boardConnectivity(d,defs);
    assert.notEqual(updated,cached);
    assert.deepEqual(updated.airwires,fresh.airwires);
  }finally{U.reset();}
}
require("../pcb/dense-board.js");
function run(){
  checkIndex();
  checkSharedLibrary();checkPouredConnections();
  const {d,defs}=makeAtriumBenchmarkBoard(),v=viewport();v.fit(d,defs);v.zoom(12);
  const probes=[];
  let state=27017;
  function random(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;}
  for(let i=0;i<550;i++)probes.push([random()*360,random()*262]);
  const tick=performance.now();v.query(d,defs,[0,0,1,1]);const build=performance.now()-tick;
  function query(p){return v.query(d,defs,[p[0]-14,p[1]-10,p[0]+14,p[1]+10]);}
  // Compare the indexed narrow-phase with the original document-order scan.
  const opts={routing:true,layer:"Top",hidden:new Set(["Bottom"])};
  const baseline=probes.slice(0,45);
  const robust=d.items.find(i=>i.kind==="part");
  robust.refAt=[-75,-30];v.invalidate(d,[robust]);
  baseline.push([robust.x-74,robust.y-30.3]);
  const indexed=baseline.map(p=>[v.hit(d,defs,p,opts)?.id,v.snapPoint(d,defs,p,opts)]);
  globalThis.AtriumSpatial=undefined;
  const linear=baseline.map(p=>[v.hit(d,defs,p,opts)?.id,v.snapPoint(d,defs,p,opts)]);
  globalThis.AtriumSpatial=spatial;
  assert.deepEqual(indexed,linear);
  const two={...robust,id:"duplicate",ref:"",refAt:undefined},one={...two,id:"first"};
  const overlap={...d,items:[one,two]},original=[two.x,two.y];
  const pad=A.pins(two,defs.get(two.def),"pcb")[0].at;
  assert.equal(v.hit(overlap,defs,pad).id,"duplicate");
  two.x+=80;two.y+=90;v.invalidate(overlap,[two]);
  assert.equal(v.hit(overlap,defs,pad).id,"first");
  assert.equal(v.hit(overlap,defs,A.pins(two,defs.get(two.def),"pcb")[0].at).id,"duplicate");
  two.x=original[0];two.y=original[1];v.invalidate(overlap,[two]);
  assert.equal(v.hit(overlap,defs,pad).id,"duplicate");
  const sch=AtriumParts.example(),sd=sch.documents[0],part=sd.items.find(i=>i.ref==="R1");
  const attached=v.connectedWires(sd,defs,part);
  assert.equal(attached.length,2);
  // Real render entry point, with a canvas stub to exercise culling and draw order.
  v.fit(d,defs);v.zoom(12);v.render(d,defs,{grid:false});
  console.log("PASS spatial queries, shared mutable definitions and copper links, document ordering, far labels, movement and cancellation, connected wires, culled render");
  if(!argv.has("--benchmark"))return;
  function timing(fn,points){
    const samples=[];for(const p of points){const t=performance.now();fn(p);samples.push(performance.now()-t);}
    samples.sort((a,b)=>a-b);
    return {p50_ms:+samples[Math.floor(samples.length*.5)].toFixed(4),p95_ms:+samples[Math.floor(samples.length*.95)].toFixed(4)};
  }
  const fullScanSamples=argv.has("--baseline")?probes.slice(0,80):[];
  const count=probes.map(p=>query(p).length).sort((a,b)=>a-b);
  const stats={objects:d.items.length,viewport_mm:[28,20],warm_queries:probes.length,index_build_ms:+build.toFixed(2),
    median_candidates:count[Math.floor(count.length*.5)],viewport_query:timing(query,probes),
    hit:timing(p=>v.hit(d,defs,p,opts),probes),snap:timing(p=>v.snapPoint(d,defs,p,opts),probes)};
  if(fullScanSamples.length){
    globalThis.AtriumSpatial=undefined;
    stats.linear_probe_count=fullScanSamples.length;
    stats.linear_hit=timing(p=>v.hit(d,defs,p,opts),fullScanSamples);
    stats.linear_snap=timing(p=>v.snapPoint(d,defs,p,opts),fullScanSamples);
    globalThis.AtriumSpatial=spatial;
  }
  console.log(JSON.stringify(stats,null,2));
}
run();
