"use strict";
const assert=require("node:assert/strict");
require("../../app/canvas/canvas-input.js");
require("../../app/editor/editor-motion.js");
const input=AtriumCanvasInput;
globalThis.window=globalThis;
class EventData {
  constructor(type,opts={}){this.type=type;Object.assign(this,opts);this.defaultPrevented=false;}
  preventDefault(){this.defaultPrevented=true;}
}
globalThis.CustomEvent=globalThis.PointerEvent=EventData;
globalThis.AtriumCamera={cfg:{"camera.momentum":true,"camera.rotate":false},animate:()=>true,takeCamera(){}};
function testSurface(){
  let now=0,serial=0,draws=0;const jobs=new Map(),events=[],history=[];
  const job=(fn,delay)=>{const id=++serial;jobs.set(id,{fn,t:now+delay});return id;};
  const time={now:()=>now,later:job,clear:id=>jobs.delete(id),frame:fn=>job(fn,16),stop:id=>jobs.delete(id)};
  globalThis.performance={now:time.now};
  globalThis.requestAnimationFrame=time.frame;
  globalThis.cancelAnimationFrame=time.stop;
  function advance(ms){
    const end=now+ms;
    while(jobs.size){const next=[...jobs].sort((a,b)=>a[1].t-b[1].t)[0];if(next[1].t>end)break;
      now=next[1].t;jobs.delete(next[0]);next[1].fn(now);}
    now=end;
  }
  const doc={id:"sheet",kind:"schematic"},cam={x:0,y:0,scale:1};
  const c={isConnected:true,getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}),setPointerCapture(){},
    dispatchEvent(e){events.push(e);if(e.type==="waffle-sketch-input"||e.type==="waffle-canvas-tool-input"){
        if(e.detail.phase==="start"&&c.claim===e.type)e.preventDefault();
      }else if(e.type==="waffle-insert-request"||e.type==="waffle-canvas-hold")e.preventDefault();return !e.defaultPrevented;}};
  const v={screenToWorld:p=>[(p[0]-cam.x)/cam.scale,(p[1]-cam.y)/cam.scale],pan:(x,y)=>{cam.x+=x;cam.y+=y;},zoom:k=>{cam.scale*=k;},camera:()=>({...cam})};
  const h={tool:()=>"select",hit:()=>({doc,item:null}),act:id=>history.push(id),selection:()=>[],select(){},currentId:()=>doc.id};
  const p={canvas:c,view:v},api=input.create({host:()=>h,docId:()=>doc.id,active:()=>true,frame:()=>draws++},time);
  const send=(type,id,x,y=0,pointerType="touch")=>api.handle({type,pointerId:id,pointerType,clientX:x,clientY:y,button:0,
    buttons:type==="pointerup"||type==="pointercancel"?0:1,pressure:.7,tiltX:7,tiltY:8,timeStamp:now},p);
  const legacy=(type,...rows)=>api.handle({type,changedTouches:rows.map(([identifier,clientX,clientY])=>({identifier,clientX,clientY})),timeStamp:now},p);
  return {c,p,api,send,legacy,advance,events,history,jobs,cam,draws:()=>draws};
}
{
  const t=testSurface();t.send("pointerdown",1,100);t.send("pointerdown",2,160);
  t.advance(18);t.send("pointermove",1,126);t.advance(16);t.send("pointermove",2,186);
  t.send("pointerup",2,186);t.send("pointerup",1,126);const released=t.cam.x;
  t.advance(48);assert.ok(t.cam.x>released&&t.cam.x<released+160);
  t.advance(450);assert.equal(t.jobs.size,0,"the compositor returns to zero queued frames");
  const settled=t.draws();t.advance(10000);assert.equal(t.draws(),settled);
}
{
  const t=testSurface();t.send("pointerdown",1,100);t.send("pointerdown",2,160);
  t.advance(20);t.send("pointermove",1,132);t.advance(20);t.send("pointermove",2,192);
  t.send("pointerup",1,132);t.send("pointerup",2,192);t.send("pointerdown",3,0,0,"mouse");
  const released=t.cam.x;t.advance(1000);assert.equal(t.cam.x,released,"mouse input cancels a pending coast");
}
for(const kind of ["mouse","touch","pen"]){
  const t=testSurface();input.setSketchActive(t.c,true);t.c.claim="waffle-sketch-input";
  t.send("pointerdown",4,20,10,kind);t.send("pointermove",4,40,20,kind);
  if(kind==="touch"){
    t.send("pointerdown",5,80);assert.deepEqual(t.events.filter(e=>e.type===t.c.claim).map(e=>e.detail.phase),["start","move","cancel"]);
    t.send("pointercancel",4,40,20,kind);t.send("pointerup",5,80);
  }else{
    t.send("pointerup",4,40,20,kind);assert.deepEqual(t.events.filter(e=>e.type===t.c.claim).map(e=>e.detail.phase),["start","move","end"]);
  }
  assert.equal(t.events.filter(e=>e.type==="pointerdown").length,0,"claimed ink is exclusive");
  input.setSketchActive(t.c,false);
}
{
  const t=testSurface();input.setToolActive(t.c,true);t.c.claim="waffle-canvas-tool-input";
  t.send("pointerdown",7,0);t.send("pointermove",7,4);input.setToolActive(t.c,false);t.send("pointerup",7,4);
  assert.deepEqual(t.events.filter(e=>e.type===t.c.claim).map(e=>e.detail.phase),["start","move","cancel"]);
}
{
  const t=testSurface();input.setSketchActive(t.c,true);t.c.claim="waffle-sketch-input";
  t.send("pointerdown",9,0,0,"pen");
  const samples=[.25,.5,.7].map((pressure,i)=>({clientX:i*4,clientY:i,pressure,tiltX:10+i,tiltY:-7,twist:2,timeStamp:i+10}));
  t.api.handle({type:"pointermove",pointerType:"pen",pointerId:9,clientX:8,clientY:2,getCoalescedEvents:()=>samples},t.p);
  const stroke=t.events.at(-1).detail.samples;
  assert.deepEqual(stroke.map(s=>[s.world,s.pressure,s.tiltX,s.timeStamp]),samples.map(s=>[[s.clientX,s.clientY],s.pressure,s.tiltX,s.timeStamp]));
  t.send("pointercancel",9,8,2,"pen");input.setSketchActive(t.c,false);
}
for(const ordering of ["legacy","pointer-first","touch-first"]){
  const t=testSurface();
  if(ordering==="pointer-first")t.send("pointerdown",11,30,40);
  t.legacy("touchstart",[1,30,40]);
  if(ordering==="touch-first")t.send("pointerdown",11,30,40);
  if(ordering!=="legacy")t.send("pointerup",11,30,40);
  t.legacy("touchend",[1,30,40]);
  if(ordering==="legacy"){t.send("pointerdown",1,30,40,"mouse");t.send("pointerup",1,30,40,"mouse");}
  assert.equal(t.events.filter(e=>e.type==="pointerdown").length,1,ordering+" produces one editor action");
  assert.equal(t.events.filter(e=>e.type==="pointerup").length,1);
}
{
  const t=testSurface();t.legacy("touchstart",[1,10,10]);t.legacy("touchcancel",[1,10,10]);t.advance(800);
  assert.equal(t.events.filter(e=>e.type==="waffle-insert-request"||e.type==="pointerdown").length,0);
  t.send("pointerdown",4,10,0);t.api.clear();t.advance(600);assert.equal(t.jobs.size,0);
}
{
  // A hold released in place opens the context menu at the first contact; nothing opens at the timer.
  const t=testSurface(),menus=[];globalThis.AtriumContextMenu={open:(h,x,y,o)=>menus.push({x,y,o})};
  t.send("pointerdown",6,40,28);t.cam.x=100;t.cam.scale=2;t.advance(460);
  assert.equal(menus.length,0,"the hold opens nothing while the finger is down");
  assert.equal(t.events.filter(e=>e.type==="waffle-insert-request"||e.type==="waffle-canvas-hold").length,0);
  t.send("pointermove",6,44,30);t.send("pointerup",6,44,30);t.advance(1);
  assert.deepEqual(menus.map(m=>[m.x,m.y]),[[40,28]],"the menu opens where the finger first pressed");
  delete globalThis.AtriumContextMenu;
}
{
  // A hold then a drag picks up: an empty-space press replays as a press at the first contact (box select).
  const t=testSurface();t.send("pointerdown",8,40,28);t.advance(460);
  t.send("pointermove",8,80,60);t.send("pointerup",8,80,60);
  assert.deepEqual(t.events.filter(e=>e.type.startsWith("pointer")).map(e=>e.type),["pointerdown","pointermove","pointerup"]);
  assert.deepEqual([t.cam.x,t.cam.y],[0,0],"a pick-up never pans");
}
{
  // Without the hold, the same drag pans and replays nothing.
  const t=testSurface();t.send("pointerdown",9,40,28);t.advance(200);t.send("pointermove",9,80,60);t.send("pointerup",9,80,60);
  assert.equal(t.events.filter(e=>e.type.startsWith("pointer")).length,0);assert.deepEqual([t.cam.x,t.cam.y],[40,32]);
}
{
  // Two- and three-finger taps run the commands in GESTURES; travel or a slow release does not.
  const t=testSurface();
  t.send("pointerdown",31,100);t.send("pointerdown",32,160);t.advance(120);t.send("pointerup",31,100);t.send("pointerup",32,160);
  t.advance(400);
  t.send("pointerdown",33,100);t.send("pointerdown",34,140);t.send("pointerdown",35,180);t.advance(90);
  t.send("pointerup",33,100);t.send("pointerup",34,140);t.send("pointerup",35,180);t.advance(400);
  t.send("pointerdown",36,100);t.send("pointerdown",37,160);t.send("pointermove",37,175);t.send("pointerup",36,100);t.send("pointerup",37,175);t.advance(400);
  t.send("pointerdown",38,100);t.send("pointerdown",39,160);t.advance(300);t.send("pointerup",38,100);t.send("pointerup",39,160);
  assert.deepEqual(t.history,["undo","redo"]);
  assert.equal(input.GESTURES["two-finger-tap"],"undo");assert.equal(input.GESTURES["three-finger-tap"],"redo");
  assert.equal(input.TOUCH.slop,8);assert.equal(input.TOUCH.hold,450);
}
{
  const t=testSurface(),needs=()=>t.api.needsTouchPrecision(t.c);
  assert.equal(needs(),true);t.send("pointerdown",25,10,5,"pen");assert.equal(needs(),false);
  t.send("pointerup",25,10,5,"pen");assert.equal(needs(),true);
  for(const arm of [input.setSketchActive,input.setToolActive]){arm(t.c,true);assert.equal(needs(),false);arm(t.c,false);assert.equal(needs(),true);}
}
const angle=input.orientation(Math.PI/3),xy=[12,16],screen=angle.point(xy,420,300);
assert.ok(angle.point(screen,420,300,true).every((v,i)=>Math.abs(xy[i]-v)<1e-9));
assert.equal(input.orientation(0),null);
console.log("PASS cancel, finite momentum, idle, exclusive sketch/tool claims, pen/touch/mouse and both legacy delivery orders");
