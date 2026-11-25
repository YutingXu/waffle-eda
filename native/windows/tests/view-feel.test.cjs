"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {summarizeMotion, validateMotion, verifiedEditorSurface} = require("./view-feel.cjs");

test("only the expected Insights card can cover the measured canvas point", () => {
  const card = {canvasHit:false,openInsight:"returnPlane:one",insightAtPoint:true};
  assert.equal(verifiedEditorSurface(card,"returnPlane:one"),true);
  assert.equal(verifiedEditorSurface(card,"returnPlane:wrong"),false);
  assert.equal(verifiedEditorSurface({...card,canvasHit:true},"returnPlane:wrong"),false);
  assert.equal(verifiedEditorSurface({...card,insightAtPoint:false},"returnPlane:one"),false);
  assert.equal(verifiedEditorSurface(card),false);
  assert.equal(verifiedEditorSurface({...card,canvasHit:true},"returnPlane:one"),true);
});

function wheelTrial() {
  const start = {scale:10,cx:0,cy:0}, scale = 10*Math.exp(.64);
  const finish = {scale,cx:-70*(1/10-1/scale),cy:-30*(1/10-1/scale)};
  const prepared = {at:[430,370], rect:{left:0,top:0,width:1000,height:800}, revision:1,
    boardId:"public-board", scale:1, backing:[1500,1200], cssViewport:[1000,800,1000,800]};
  const steps = Array.from({length:72},(_,i)=>i%6<3 ? -40 : 40).concat(-40,-40);
  const inputs = steps.map((dy,i)=>({type:"wheel",trusted:true,accepted:true,canvas:true,pinchStyle:true,ctrl:true,
    dx:0,dy,mode:0,x:430,y:370,at:12+30*i}));
  const draws = inputs.map(e=>({changed:true,t:e.at+1,end:e.at+3,raf:e.at,inCallback:true}));
  draws.push({changed:false,t:2400,end:2402,raf:2400,inCallback:true});
  const raw = {start,finish,inputs,draws,work:draws.flatMap(d=>[d.t,d.end-d.t]),end:2810,
    ticks:Array.from({length:702},(_,i)=>i*4)};
  const metrics = summarizeMotion(raw,240);
  return {raw,metrics,prepared,after:prepared,pixels:{colors:15,changedFraction:.2},kind:"zoom",steps};
}

test("trusted sustained PCB movement with changing compositor pixels qualifies", () => {
  const trial = wheelTrial();
  assert.deepEqual(validateMotion(trial),[]);
  assert.ok(trial.metrics.paintFrameWork.n >= 20);
  assert.ok(trial.metrics.activeInputMs >= 2000);
  assert.equal(trial.metrics.terminalKind,"stationary draw");
});

test("camera movement and plausible frame timing cannot qualify frozen pixels", () => {
  const trial = wheelTrial();
  trial.pixels.changedFraction = 0;
  assert.deepEqual(validateMotion(trial),["nonblank changed compositor pixels"]);
  trial.raw.draws = [];
  trial.metrics = summarizeMotion(trial.raw,240);
  assert.ok(validateMotion(trial).includes("changed PCB draws"));
});

test("a pinch-style CDP stream cannot qualify as native wheel notches", () => {
  const trial = wheelTrial();
  trial.kind = "native-wheel";
  trial.steps = trial.steps.map(dy=>-Math.sign(dy)*120);
  trial.raw.tracedNotches = [];
  const verdict = validateMotion(trial);
  assert.ok(verdict.includes("trusted signed wheel delivery"));
  assert.ok(verdict.includes("native Control notches entered the editor's wheel timing path"));
});

function nativeTrial() {
  const trial = wheelTrial(), {raw,prepared} = trial;
  trial.kind = "native-wheel";
  prepared.dpr = 1.5;
  for (const event of raw.inputs) {
    event.dy = Math.sign(event.dy)*100;
    event.legacyDeltaY = -Math.sign(event.dy)*120;
    event.pinchStyle = false;
  }
  trial.steps = raw.inputs.map(event => event.legacyDeltaY);
  // One WebView2 event represents two emitted notches. Each signed notch still
  // contributes its own 100 px delta, and the zoom keeps the cursor anchor.
  raw.inputs[0].dy *= 2;
  raw.inputs[0].legacyDeltaY *= 2;
  raw.inputs.splice(1,1);
  raw.tracedNotches = raw.inputs.map(event => event.at);
  const delta = raw.inputs.reduce((sum,event) => sum+event.dy,0);
  const scale = raw.start.scale*Math.exp(-delta*.008);
  raw.finish = {scale,cx:-70*(1/raw.start.scale-1/scale),cy:-30*(1/raw.start.scale-1/scale)};
  trial.metrics = summarizeMotion(raw,240);
  return trial;
}

test("a coalesced but pure native notch stream can prove the actual editor endpoint", () => {
  const trial = nativeTrial();
  assert.equal(trial.raw.inputs.length,trial.steps.length-1);
  assert.deepEqual(validateMotion(trial),[]);
});

test("a trusted zero-delta Control event prevents pure native notch qualification", () => {
  const trial = nativeTrial();
  const source = trial.raw.inputs[2];
  trial.raw.inputs.splice(2,0,{...source,at:source.at-.1,dy:0,legacyDeltaY:0,pinchStyle:true});
  assert.deepEqual(validateMotion(trial),["trusted signed wheel delivery"]);
});

test("landing at the delivered scale does not excuse a missing intended physical detent", () => {
  const trial = nativeTrial();
  trial.steps.push(120);
  assert.deepEqual(validateMotion(trial),["zoom endpoint and pointer anchor"]);
});

test("plain native wheel scroll pans without changing scale", () => {
  const trial=nativeTrial(),{raw}=trial;
  trial.kind="native-scroll";
  for (const input of raw.inputs) input.ctrl=false;
  const delta=raw.inputs.reduce((sum,e)=>sum+e.dy,0);
  raw.finish={...raw.start,cy:raw.start.cy+delta/raw.start.scale};
  assert.deepEqual(validateMotion(trial),[]);
  raw.finish.scale*=2;
  assert.deepEqual(validateMotion(trial),["plain wheel vertical pan endpoint"]);
});

test("the last partial interval remains separate from the preceding observed interval", () => {
  const raw = {inputs:[{at:5},{at:20}],ticks:[0,12,24],end:40,work:[13,16,24,14],draws:[
    {changed:true,t:14,end:17,raf:12,inCallback:true},
    {changed:false,t:24,end:35,raf:24,inCallback:true},
  ]};
  const stats = summarizeMotion(raw,240);
  assert.equal(stats.terminal.p95,14);
  assert.deepEqual(stats.samples.settle,[16,14]);
});

test("paint and terminal work include their own draw across a rAF-label boundary", () => {
  const changed = {changed:true,t:23.9999999993,end:25.25,raf:24,inCallback:true};
  const terminal = {changed:false,t:35.9999999993,end:40,raf:36,inCallback:true};
  const raw = {inputs:[{at:8},{at:20}],ticks:[0,12,24,36,48],end:50,
    work:[22,4,35.5,5],draws:[changed,terminal]};
  const stats = summarizeMotion(raw,240);
  assert.deepEqual(stats.samples.paintFrameWork,[4]);
  assert.deepEqual(stats.samples.terminal,[5]);
  assert.ok(stats.paintFrameWork.p95 >= changed.end-changed.t);
  assert.ok(stats.terminal.p95 >= terminal.end-terminal.t);
  assert.equal(stats.unattributedPaintDraws,0);
});

test("draws claimed inside a callback need observable callback ownership", () => {
  const trial = wheelTrial();
  trial.raw.work = trial.raw.work.slice(2);
  trial.metrics = summarizeMotion(trial.raw,240);
  assert.equal(trial.metrics.unattributedPaintDraws,1);
  assert.ok(validateMotion(trial).includes("measured paint draws must be charged to their owning callbacks"));
});

test("missing fixed refresh leaves app work and observed cadence measurable", () => {
  const trial = wheelTrial();
  const fixed = trial.metrics;
  trial.metrics = summarizeMotion(trial.raw,null);
  assert.deepEqual(validateMotion(trial),[]);
  assert.deepEqual(trial.metrics.work,fixed.work);
  assert.deepEqual(trial.metrics.cadence,fixed.cadence);
  assert.equal(typeof fixed.estimatedMissedCallbackSlots,"number");
  assert.equal(trial.metrics.estimatedMissedCallbackSlots,null);
});
