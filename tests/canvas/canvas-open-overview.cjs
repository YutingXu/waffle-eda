"use strict";
const assert = require("node:assert/strict");
for (const name of ["model", "pcb-appearance", "spatial", "canvas"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

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
const defs = new Map(), opts = {grid:false,origin:false,layer:"Top"};
const board = (count,x=0) => ({kind:"pcb",grid:.25,origin:[0,0],outline:[[x,0],[x+100,0],[x+100,100],[x,100]],
  items:Array.from({length:count},(_,id)=>{
    const a = x+4+(id%90), b = 2+Math.floor(id/256);
    return {id,kind:"track",layer:"Top",width:.2,points:[[a,b],[a+.35,b+.35]]};
  })});
const big = board(20480), tiny = board(10,1000);
const oracle = renderer(), shown = renderer();
oracle.view.fit(big,defs);
oracle.view.render(big,defs,{...opts,noReuse:true});
shown.view.fit(big,defs);
shown.view.onRepaint(()=>shown.view.render(big,defs,opts));
shown.canvas.inert=true;
shown.view.render(big,defs,opts);
assert.equal(shown.strokes.length,0,"the import report keeps the dense board covered");
shown.canvas.inert=false;
shown.view.render(big,defs,opts);
assert.ok(shown.I.openingOverview());
assert.ok(shown.strokes.length>100 && shown.strokes.length<oracle.strokes.length/10,"the opening draws board geometry in a bounded first pass");
shown.strokes.length=0;
const point = [4.2,2.2], expected = oracle.view.hit(big,defs,point);
assert.ok(expected);
assert.equal(shown.view.hit(big,defs,point),expected,"the first pick resolves the exact board before selection");
assert.equal(shown.I.openingOverview(),false);
assert.deepEqual(shown.strokes,oracle.strokes,"the final canvas uses the exact original rendering path");
assert.equal(frameQueue.size,0,"an early pick cancels the scheduled continuation");

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
console.log("PASS dense progressive artwork, exact final paint and first hit, covered report, and stale frame cancellation");
