"use strict";
// Evaluate this expression in the desktop WebView after opening a scratch project.
// All inputs below are synthetic. The returned capabilities describe this WebView and display.
(async () => {
  const h=AtriumNavHost, p=Atrium.project("Touch capability probe"), d=p.documents[0];
  d.grid=1; d.items=[{id:"lead",kind:"wire",points:[[-10,0],[10,0]]}];
  await h.replaceProject(p,{force:true,dirty:false});h.selectDocument(d.id);
  await AtriumLazy.need(["AtriumCamera","AtriumTouchPrecision"]);
  const c=h.canvas(),v=h.view();AtriumCamera.takeCamera(v);h.select(["lead"]);
  v.restoreCamera({...v.camera(),cx:0,cy:0,scale:10});h.redraw();
  const frame=()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));
  await frame();
  const r=c.getBoundingClientRect(),from=v.worldToScreen([-10,0]);
  const x=r.left+from[0],y=r.top+from[1]-20;
  function contact(type,cx,cy,kind,id) {
    c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:kind,pointerId:id,isPrimary:true,
      button:type==="pointermove"?-1:0,buttons:type==="pointerup"?0:1,clientX:cx,clientY:cy,pressure:.65,tiltX:24}));
  }
  contact("pointerdown",x,y,"touch",12);contact("pointermove",x+20,y+40,"touch",12);await frame();
  const loupe=!!c.parentNode.querySelector(".touch-loupe:not([hidden])");
  contact("pointerup",x+20,y+40,"touch",12);
  const tip=h.doc().items[0].points[0];h.act("undo");const restored=h.doc().items[0].points[0];
  let pen=false;c.addEventListener("waffle-sketch-input",e=>{pen=e.detail.pointerType==="pen"&&Math.abs(e.detail.samples[0].pressure-.65)<.01;},{once:true});
  contact("pointerdown",x,y,"pen",13);contact("pointerup",x,y,"pen",13);
  const scale=v.scale();
  for (const [type,s] of [["gesturestart",1],["gesturechange",1.25],["gestureend",1.25]])
    c.dispatchEvent(Object.assign(new Event(type,{bubbles:true,cancelable:true}),{scale:s,clientX:x,clientY:y}));
  const b=c.parentNode.querySelector(".touch-modifiers button");
  return {pointer:typeof PointerEvent==="function",capture:typeof c.setPointerCapture==="function",coalesced:typeof PointerEvent.prototype.getCoalescedEvents==="function",
    visualViewport:!!window.visualViewport,maxTouchPoints:navigator.maxTouchPoints,coarse:matchMedia("(any-pointer: coarse)").matches,
    gestureConstructor:typeof globalThis.GestureEvent,virtualKeyboard:!!navigator.virtualKeyboard,
    synthetic:{loupe,grip:tip[0]===-8&&tip[1]===4,undo:restored[0]===-10&&restored[1]===0,pen,pinch:v.scale()/scale,
      button:[getComputedStyle(b).minInlineSize,getComputedStyle(b).minBlockSize]}};
})()
