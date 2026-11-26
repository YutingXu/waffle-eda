"use strict";
const assert = require("node:assert/strict");
for (const name of ["model", "pcb-appearance", "sch-appearance", "spatial", "canvas", "diagnostics"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

const frameQueue = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = fn => {frameQueue.set(++frameId,fn);return frameId;};
globalThis.cancelAnimationFrame = id => frameQueue.delete(id);
function renderer() {
  const strokes = [];
  const ctx = new Proxy({}, {get:(target,key)=>target[key] ?? ((...args)=>strokes.push([key,...args]))});
  const canvas = {isConnected:true,getContext:()=>ctx,getBoundingClientRect:()=>({width:800,height:600})};
  const view = AtriumCanvas.create(canvas);
  return {canvas,view,I:view.internals(),strokes};
}
const defs = new Map(), opts = {grid:false,origin:false,layer:"Top",editorPane:true};
const board = (count,x=0) => ({kind:"pcb",grid:.25,origin:[0,0],outline:[[x,0],[x+100,0],[x+100,100],[x,100]],
  items:Array.from({length:count},(_,id)=>{
    const a = x+4+(id%90), b = 2+Math.floor(id/256);
    return {id,kind:"track",layer:"Top",width:.2,points:[[a,b],[a+.35,b+.35]]};
  })});
const big = board(20480), tiny = board(10,1000);
const oracle = renderer(), shown = renderer();
oracle.view.fit(big,defs);
oracle.view.render(big,defs,{...opts,noReuse:true});
const trace = AtriumDiagnostics.startPerformance();
const recorded = kind => AtriumDiagnostics.performanceSnapshot().rows.find(row=>row.component===kind && row.operation==="draw")?.counts;
shown.view.fit(big,defs);
shown.view.onRepaint(()=>shown.view.render(big,defs,opts));
shown.canvas.inert=true;
shown.view.render(big,defs,opts);
assert.equal(shown.strokes.length,0,"the import report keeps the dense board covered");
assert.equal(recorded("pcb").cancelled,1);
assert.equal(recorded("pcb").visible,0);
shown.canvas.inert=false;
shown.view.render(big,defs,opts);
assert.ok(shown.I.openingOverview());
assert.equal(recorded("pcb").completed,1,"the bounded preview does not count as the complete view");
assert.equal(recorded("pcb").visible,0);
assert.ok(shown.strokes.length>100 && shown.strokes.length<oracle.strokes.length/10,"the opening draws board geometry in a bounded first pass");
shown.strokes.length=0;
const point = [4.2,2.2], expected = oracle.view.hit(big,defs,point);
assert.ok(expected);
assert.equal(shown.view.hit(big,defs,point),expected,"the first pick resolves the exact board before selection");
assert.equal(shown.I.openingOverview(),false);
assert.deepEqual(shown.strokes,oracle.strokes,"the final canvas uses the exact original rendering path");
assert.equal(frameQueue.size,0,"an early pick cancels the scheduled continuation");
assert.equal(recorded("pcb").visible,1);

const empty = renderer();
empty.I.size={w:0,h:0};
empty.view.render(tiny,defs,opts);
assert.equal(empty.strokes.length,0);
assert.equal(recorded("pcb").visible,1,"a zero-size canvas submits no frame");
assert.equal(recorded("pcb").cancelled,2);

const diagram = renderer(), schematic = Atrium.sheet("schematic","Draw test");
diagram.view.render(schematic,defs,opts);
assert.ok(diagram.strokes.length);
assert.equal(recorded("schematic").visible,1,"the schematic submits its own canvas draw");
const before=diagram.strokes.length;
diagram.view.moving();diagram.view.render(schematic,defs,opts);diagram.view.pausePaint();
assert.equal(diagram.strokes.length,before,"a stationary gesture submits no draw");
assert.equal(recorded("schematic").visible,1);
assert.equal(recorded("schematic").cancelled,1);
diagram.canvas.inert=true;
diagram.view.render(schematic,defs,opts);
assert.equal(recorded("schematic").completed,1,"draws under a cover are not visible submissions");
trace.stop();
diagram.canvas.inert=false;
diagram.view.render(schematic,defs,opts);
assert.equal(recorded("schematic").visible,1,"disabled recording does not collect a draw");

for(const recording of [false,true]){
  const lease=recording ? AtriumDiagnostics.startPerformance() : null;
  const prior=recorded("schematic"), motion=renderer();
  const move=()=>{motion.view.moving();motion.view.render(schematic,defs,opts);};
  try{
    motion.view.restoreCamera({cx:0,cy:0,scale:1,referenceScale:1});
    motion.view.render(schematic,defs,opts);
    motion.strokes.length=0;
    move();
    assert.equal(motion.strokes.length,0,"an unchanged camera submits no canvas work");
    for(let i=0;i<4;i++){motion.view.pan(.25,0);move();}
    const shifts=motion.strokes.filter(([name])=>name==="drawImage").map(([,surface,dx,dy])=>[surface===motion.canvas,dx,dy]);
    assert.deepEqual(shifts,[[true,1,0]],"fractional motion accumulates against the last painted pixel origin");
    assert.equal(motion.view.camera().cx,-1);
    if(lease){
      const {visible,cancelled}=recorded("schematic");
      assert.deepEqual([visible,cancelled],[2,4],"only the original paint and the whole-pixel shift submit a view");
    }else assert.deepEqual(recorded("schematic"),prior,"disabled recording leaves counters untouched");
    motion.strokes.length=0;
    motion.view.pan(401,0);move();
    assert.ok(motion.strokes.some(([name])=>name==="fillRect"),"a pan outside retained coverage paints a fresh frame");
    assert.ok(!motion.strokes.some(([name])=>name==="drawImage"));
    if(lease)assert.equal(recorded("schematic").visible,3);
  }finally{
    motion.view.pausePaint();lease?.stop();
  }
}

const switched = renderer();
let repaints = 0;
switched.view.onRepaint(()=>{repaints++;});
switched.view.fit(big,defs);switched.view.render(big,defs,opts);
const stale = frameQueue.values().next().value;
switched.view.fit(tiny,defs);switched.view.render(tiny,defs,opts);
stale();
assert.equal(frameQueue.size,0);
assert.equal(repaints,0,"an old board cannot request a replacement frame after a switch");
assert.equal(switched.I.frame()[0],tiny);
{
  const fs=require("node:fs"), vm=require("node:vm"), {appFile}=require("../support/app-source-paths.cjs");
  const source=fs.readFileSync(appFile("canvas-gpu.js"),"utf8"), fixture=vm.createContext({AtriumPCBAppearance});
  vm.runInContext(source.replace("Object.freeze({render, damage,","Object.freeze({render, damage, views,"),fixture);
  const gpu=fixture.AtriumCanvasGPU, retained=renderer(), previous=globalThis.AtriumCanvasGPU;
  retained.view.fit(tiny,defs);retained.view.render(tiny,defs,opts);
  const parked=new Map(), values=parked.values.bind(parked);
  let driverReads=0, bufferWalks=0;
  parked.values=()=>{bufferWalks++;return values();};
  const gl={getExtension(){driverReads++;return null;},getParameter(){driverReads++;return "";}};
  gpu.views.set(retained.I,{canvas:retained.canvas,gl,parked,stats:{acc:{n:0},pourBytes:0}});
  gpu.stats(retained.I);
  assert.deepEqual([driverReads,bufferWalks],[2,1],"control exercises renderer stats");
  driverReads=bufferWalks=0;
  globalThis.AtriumCanvasGPU={...gpu,render:()=>false};
  try {
    retained.view.onRepaint(()=>{});
    retained.view.fit(big,defs);retained.strokes.length=0;
    retained.view.render(big,defs,opts);
    assert.equal(retained.I.openingOverview(),false,"a retained GPU view bypasses the coarse overview");
    assert.deepEqual(retained.strokes,oracle.strokes,"the cold document renders the same exact pixels");
    assert.deepEqual([driverReads,bufferWalks],[0,0],"view existence needs no GPU stats or driver reads");
  } finally { globalThis.AtriumCanvasGPU=previous; }
}
console.log("PASS dense progressive artwork, exact final paint and first hit, covered report, and stale frame cancellation");
