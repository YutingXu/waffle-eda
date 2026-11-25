"use strict";
// Shared in Chromium and WKWebView. Direct PointerEvents here are deliberately scripted.
globalThis.WaffleInputProbe = async function () {
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const results=[], check=(yes,what,details)=>{if(!yes)throw Error(what+(details?" "+JSON.stringify(details):""));results.push(what);};
  await AtriumLazy.need(["AtriumCamera","AtriumSchPlace","AtriumContextMenu"]);
  if(AtriumLazy.modules().includes("AtriumTouchPrecision"))await AtriumLazy.need("AtriumTouchPrecision");
  const H=AtriumNavHost,P=Atrium.project("Input probe"),D=P.documents[0];
  D.grid=.1;
  D.items=[{id:"line",kind:"wire",points:[[-4,0],[4,0]]},{id:"label",kind:"netlabel",text:"IN",x:-4,y:0},
    {id:"check",kind:"textframe",x:9,y:-12,w:8,h:4,text:"Open"}];
  await H.replaceProject(P,{force:true,dirty:false});
  H.selectDocument(D.id);H.setTool("select");
  const c=H.canvas(),v=H.view(), state=()=>JSON.stringify(H.doc().items), baseline=state();
  const view=()=>v.camera(), start={...view(),cx:0,cy:0,scale:12}, reset=()=>{v.restoreCamera(start);H.redraw();};
  const close=(a,b,t=.001)=>Math.abs(a-b)<t;
  const near=(a,b,t=.01)=>a.every((v,i)=>close(v,b[i],t));
  const center=()=>[c.clientWidth/2,c.clientHeight/2];
  const world=at=>v.screenToWorld(at);
  const client=at=>{const r=c.getBoundingClientRect();return [at[0]+r.left,at[1]+r.top];};
  const event=(type,id,at,pen=false,extra={})=>{
    const [clientX,clientY]=client(at);
    const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:pen?"pen":"touch",isPrimary:true,
      button:type==="pointermove"?-1:0,buttons:type==="pointerup"||type==="pointercancel"?0:1,clientX,clientY,
      pressure:pen?.63:.5,tiltX:pen?17:0,tiltY:pen?-11:0,...extra});c.dispatchEvent(e);
  };
  const down=(id,at,pen)=>event("pointerdown",id,at,pen),move=(id,at,pen)=>event("pointermove",id,at,pen);
  const up=(id,at,pen)=>event("pointerup",id,at,pen),cancel=(id,at,pen)=>event("pointercancel",id,at,pen);
  const tap=(id,at,pen)=>{down(id,at,pen);up(id,at,pen);};
  const offset=(p,x,y)=>[p[0]+x,p[1]+y];
  const gesture=(type,scale,at,rotation=0)=>{const [clientX,clientY]=client(at);const e=Object.assign(new Event(type,{bubbles:true,cancelable:true}),{clientX,clientY,scale,rotation});c.dispatchEvent(e);};
  const wheel=(at,x,y,ctrl=false)=>{const [clientX,clientY]=client(at);c.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,clientX,clientY,deltaMode:0,deltaX:x,deltaY:y,ctrlKey:ctrl}));};
  const pref=(k,x)=>AtriumCamera.setPref(k,x);
  pref("camera.animate",false); pref("camera.rotate",false);pref("camera.momentum",true);
  reset(); await sleep(60);
  const mid=center(),on=v.worldToScreen([1.5,0]),empty=offset(mid,90,65),at=[];
  const phase=e=>at.push(e.detail);
  c.addEventListener("waffle-touch-edit",phase);
  tap(10,on,true);check(H.selection().includes("line")&&at.at(-1).pointerType==="pen","unclaimed pen selects through the normal precise tool");
  H.select([]);const still=view();down(111,on);move(111,offset(on,22,24));up(111,offset(on,22,24));
  check(state()===baseline&&!H.selection().length&&view().cx!==still.cx,"one finger on an unselected wire pans and edits nothing");reset();
  H.select(["line"]);down(11,on);move(11,offset(on,22,24));check(state()!==baseline,"one finger drags the actual selected wire");
  cancel(11,offset(on,22,24));check(state()===baseline&&at.at(-1).phase==="cancel"&&!H.drag(),"pointercancel rolls a live edit back without an undo step");

  const exposedTilt=new PointerEvent("pointermove",{pointerType:"pen",tiltX:17,tiltY:-11}).tiltX;
  const sketch=[],claim=e=>{const d=e.detail;sketch.push(d);if(d.phase==="start")e.preventDefault();};
  c.addEventListener("waffle-sketch-input",claim);
  H.select([]);const cam=view(),editCount=at.length;
  down(12,empty);down(13,on,true);down(14,offset(on,20,0));
  move(12,offset(empty,40,0));move(14,offset(on,35,0));move(13,offset(on,7,3),true);
  up(13,offset(on,7,3),true);move(14,offset(on,60,6));up(12,empty);up(14,on);
  check(sketch.map(d=>d.phase).join(",")==="start,move,end"&&near(sketch[1].samples[0].world,world(offset(on,7,3)))&&close(sketch[1].samples[0].pressure,.63,.02)&&sketch[1].tiltX===exposedTilt,"claimed sketch receives ordered pressure and tilt samples",{phases:sketch.map(d=>d.phase),sample:sketch[1]?.samples[0],expected:world(offset(on,7,3))});
  check(state()===baseline&&at.length===editCount&&JSON.stringify(view())===JSON.stringify(cam),"palms arriving before or during an active pen cannot edit or move its canvas");
  c.removeEventListener("waffle-sketch-input",claim);

  const menuOpen=()=>AtriumContextMenu.isOpen();
  H.select([]);down(15,empty);await sleep(520);up(15,empty);await sleep(30);
  check(menuOpen()&&state()===baseline&&!H.selection().length,"an empty-space hold released in place opens the context menu");
  AtriumContextMenu.close(false);
  const beforePan=view(), afterSlop=offset(empty,15,0);
  down(16,empty);move(16,afterSlop);await sleep(520);
  const lifted=!!document.querySelector(".touch-lift");
  up(16,afterSlop);await sleep(0); // The release schedules its menu callback on the timer queue.
  check(!lifted&&!menuOpen()&&close((beforePan.cx-view().cx)*beforePan.scale,15)&&state()===baseline&&!H.selection().length,
    "moving past slop disarms the hold");
  reset();down(18,on);await sleep(520);up(18,on);await sleep(30);
  check(menuOpen()&&H.selection().includes("line"),"a held object released in place opens its normal context menu");
  AtriumContextMenu.close(false);
  H.select(["line"]);tap(19,on);tap(20,on);check(view().scale===start.scale&&H.selection().join()==="line","tapping the only object under the finger keeps it selected and never zooms");
  reset();H.select(["line"]);H.act("camera-zoom-selection");check(view().scale>start.scale,"command palette fits the selected object");reset();

  const control=v.worldToScreen([10,-11]),body=v.worldToScreen([15,-11]),taps=[];
  const checkItem=()=>H.doc().items.find(i=>i.id==="check");
  function activateControl(e){
    const d=e.detail;taps.push(d);
    if(e.target!==c || d.itemId!=="check" || d.point[0]>12)return;
    e.preventDefault(); H.edit(()=>{checkItem().text=checkItem().text==="Open"?"Done":"Open";},"Toggle review checkbox",[checkItem()]);
  }
  window.addEventListener("waffle-canvas-tap",activateControl);
  try{
    H.select([]);const steps=H.undoSteps().history.length;
    tap(101,control);const [clientX,clientY]=client(control);
    c.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,clientX,clientY}));
    check(taps.length===1&&taps[0].source==="tap"&&taps[0].pointerType==="touch"&&taps[0].docId===D.id&&near(taps[0].point,[10,-11],.12)&&
      checkItem().text==="Done"&&H.undoSteps().history.length===steps+1&&!H.selection().length,"a claimed touch control makes one undoable edit and skips ordinary selection");
    tap(102,control);check(taps.length===2&&view().scale===start.scale&&checkItem().text==="Open","a second tap activates the control again and never zooms");
    H.act("undo");H.act("undo");reset();check(state()===baseline,"one Undo per activation restores the control");
    tap(103,control,true);check(taps.length===3&&taps.at(-1).pointerType==="pen"&&checkItem().text==="Done","a precise pen tap can activate the same control");
    H.act("undo");tap(104,body);check(taps.length===4&&H.selection().includes("check")&&checkItem().text==="Open","declining a paper-body hit preserves ordinary selection");
    tap(105,on);down(106,control);cancel(106,control);
    down(107,control);down(108,offset(control,35,0));move(108,offset(control,55,0));up(107,control);up(108,offset(control,55,0));
    check(taps.length===4,"electrical selection, cancellation and multi-contact navigation cannot activate a paper control");
  }finally{window.removeEventListener("waffle-canvas-tap",activateControl);reset();}

  const a=offset(mid,-30,0),b=offset(mid,30,0),top=offset(mid,0,-30),bottom=offset(mid,0,30);
  function turnPair(id){ down(id,a);down(id+1,b);move(id,top);move(id+1,bottom);up(id,top);up(id+1,bottom); }
  turnPair(21);check(!view().rotation,"two-finger rotation is disabled initially");reset();
  pref("camera.rotate",true);const pivot=world(mid),east=offset(pivot,1,0);turnPair(23);
  check(close(view().rotation,Math.PI/2)&&near(v.worldToScreen(east),offset(mid,0,12),.8)&&near(world(offset(mid,0,12)),east,.08),"opt-in ninety-degree rotation keeps painting and picking in the same coordinate system",{cam:view(),mid,expected:offset(mid,0,12),actual:v.worldToScreen(east),world:world(offset(mid,0,12))});
  for(const kind of ["schematic","pcb"]){
    const tile=document.createElement("canvas");tile.getBoundingClientRect=()=>({left:0,top:0,width:210,height:160});
    const draw=AtriumCanvas.create(tile),sheet=Atrium.sheet(kind,"Rotation sample");
    draw.resized();draw.restoreCamera({cx:0,cy:0,scale:10,referenceScale:10,rotation:Math.PI/4});
    draw.render(sheet,new Map(),{grid:false,origin:false,overlay:[ctx=>{ctx.fillStyle="#ff00ad";ctx.fillRect(3,-1,2,2);}]});
    const xy=draw.worldToScreen([4,0]).map(n=>Math.round(n*tile.width/210)),pixel=tile.getContext("2d").getImageData(...xy,1,1).data;
    check(pixel[0]===255&&pixel[1]===0&&pixel[2]===173,kind+" rotated artwork lands at its actual hit-test pixel");
  }
  H.act("camera-turn-reset");check(!view().rotation,"keyboard-accessible reset restores the camera orientation");pref("camera.rotate",false);
  reset();
  const anchored=world(empty);wheel(empty,0,-4,true);gesture("gesturestart",1,empty);
  gesture("gesturechange",1.25,offset(empty,3,2));wheel(empty,0,-4,true);
  gesture("gestureend",1.25,offset(empty,3,2));wheel(empty,0,-4,true);
  check(close(view().scale,15)&&near(v.worldToScreen(anchored),offset(empty,3,2),.8),"WebKit pinch ignores duplicate control-wheel before, during and immediately after the gesture");

  function swipe(id,dx,abort=false,count=3) {
    const points=Array.from({length:count},(_,i)=>offset(mid,10+i*18,65));
    points.forEach((pt,i)=>down(id+i,pt));points.forEach((pt,i)=>move(id+i,offset(pt,dx,2)));
    points.forEach((pt,i)=>(i===1&&abort?cancel:up)(id+i,offset(pt,dx,2)));
  }
  reset();H.setTool("label");tap(31,empty);H.setTool("select");const placed=state();check(placed!==baseline,"single tap commits an armed electrical placement");
  swipe(32,-84,true);swipe(36,-84,false,4);check(state()===placed,"cancelled and four-finger swipes leave history alone");
  swipe(41,-84);check(state()===baseline,"three-finger swipe left uses the document Undo command");
  swipe(44,84);check(state()===placed,"three-finger swipe right restores the identical edit");
  H.act("undo");

  await sleep(65);H.setTool("label");const beforeLegacy=H.doc().items.length;
  function oldTouch(type,id,at){
    const [clientX,clientY]=client(at),e=new Event(type,{bubbles:true,cancelable:true});
    Object.defineProperty(e,"changedTouches",{value:[{identifier:id,target:c,clientX,clientY,radiusX:3,radiusY:3,force:.45}]});c.dispatchEvent(e);
  }
  oldTouch("touchstart",61,empty);oldTouch("touchend",61,empty);
  check(H.doc().items.length===beforeLegacy+1,"legacy Touch Events reuse the electrical placement path");
  oldTouch("touchstart",62,empty);down(75,empty);up(75,empty);oldTouch("touchend",62,empty);
  check(H.doc().items.length===beforeLegacy+2,"touch-first dual delivery places once");
  down(76,empty);oldTouch("touchstart",63,empty);up(76,empty);oldTouch("touchend",63,empty);
  check(H.doc().items.length===beforeLegacy+3,"pointer-first dual delivery places once");
  H.act("undo");H.act("undo");H.act("undo");H.setTool("select");
  for(const [type,id] of [["waffle-sketch-input",80],["waffle-canvas-tool-input",83]]){
    const arm=type==="waffle-sketch-input"?AtriumCanvasInput.setSketchActive:AtriumCanvasInput.setToolActive,seq=[];
    const claim=e=>{seq.push(e.detail.phase);if(e.detail.phase==="start")e.preventDefault();};c.addEventListener(type,claim);arm(c,true);
    down(id,empty);move(id,offset(empty,5,5));down(id+1,offset(empty,40,0));
    cancel(id,empty);up(id+1,offset(empty,40,0));arm(c,false);c.removeEventListener(type,claim);
    check(seq.join(",")==="start,move,cancel"&&state()===baseline,"second finger cancels an opted-in "+(type==="waffle-sketch-input"?"ink":"markup")+" stroke before navigation");
  }
  reset();pref("camera.animate",true);document.documentElement.setAttribute("data-motion","full");
  const m=offset(mid,-30,60),n=offset(mid,30,60);
  const times=[performance.now()];down(51,m);down(52,n);await sleep(18);times.push(performance.now());move(51,offset(m,25,0));await sleep(16);times.push(performance.now());move(52,offset(n,25,0));
  up(52,offset(n,25,0));up(51,offset(m,25,0));const released=view();
  await sleep(65);times.push(performance.now());const coast=view();
  check(document.hidden?coast.cx===released.cx:coast.cx<released.cx,document.hidden?"background WebView schedules no momentum":"two-finger pan coasts in the release direction",{times,released,coast,animated:AtriumCamera.animate(),visible:document.visibilityState});
  down(53,empty);const stopped=view();await sleep(85);
  check(JSON.stringify(stopped)===JSON.stringify(view()),"a new finger stops momentum immediately");
  cancel(53,empty);pref("camera.animate",false);
  c.removeEventListener("waffle-touch-edit",phase);
  return {checks:results,capabilities:{pointer:typeof PointerEvent==="function",gesture:typeof GestureEvent==="function",
    coalesced:typeof PointerEvent.prototype.getCoalescedEvents==="function",syntheticTilt:exposedTilt,maxTouchPoints:navigator.maxTouchPoints,ua:navigator.userAgent}};
};

globalThis.WaffleInputProbe.waitFor = async (ready, message, frames=120) => {
  for(let n=0;n<frames&&(n===0||!ready());n++)await new Promise(requestAnimationFrame);
  if(!ready())throw Error(message);
};
