"use strict";
// Dispatch two real DOM contacts against the normal editor. Measure input dispatch, actual canvas
// rendering CPU time, and the compositor's frame intervals separately.
globalThis.WaffleInputStress=async function({scale=6,rotation=0}={}){
  const H=AtriumNavHost,P=Atrium.project("Dense contact stress"),{d}=makeAtriumBenchmarkBoard(160);
  P.documents[P.documents.findIndex(doc=>doc.kind==="pcb")]=d;
  await H.replaceProject(P,{force:true,dirty:false});await H.selectDocument(d.id);
  await AtriumLazy.need("AtriumCamera");
  const c=H.canvas(),v=H.view(),r=c.getBoundingClientRect(),x=r.left+r.width*.45,y=r.top+r.height*.5;
  const f=()=>new Promise(resolve=>requestAnimationFrame(resolve)), renderer=v.internals();
  const cam=v.camera();v.restoreCamera({...cam,cx:180,cy:124,scale,rotation});H.redraw();await f();
  const ready=()=>renderer.frame()?.[0]?.id===d.id&&!renderer.openingOverview();
  for(let n=0;n<120&&!ready();n++)await f();
  if(!ready())throw Error("Dense board did not reach its exact first frame");
  const raw=v.render,moving=v.moving,settle=v.settle,paints=[],dispatch=[],intervals=[];
  let gesture=false,movingPaints=0;
  v.moving=()=>{gesture=true;moving();};v.settle=()=>{gesture=false;settle();};
  function event(type,id,px,py){c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:"touch",isPrimary:id===140,
    button:type==="pointermove"?-1:0,buttons:type==="pointercancel"?0:1,clientX:px,clientY:py}));}
  v.render=(...args)=>{if(gesture)movingPaints++;gesture=false;const t=performance.now();try{return raw(...args);}finally{paints.push(performance.now()-t);}};
  let dx=0,dy=0;
  try{
    event("pointerdown",140,x,y);event("pointerdown",141,x+60,y);
    let last=await f();
    for(let i=1;i<=100;i++){
      const t=performance.now();dx=Math.round(35*Math.sin(i/14));dy=Math.round(18*Math.sin(i/23));
      event("pointermove",140,x+dx,y+dy);event("pointermove",141,x+60+dx,y+dy);
      dispatch.push(performance.now()-t);
      const time=await f();intervals.push(time-last);last=time;
    }
    event("pointercancel",140,x+dx,y+dy);event("pointercancel",141,x+60+dx,y+dy);
  }finally{v.render=raw;v.moving=moving;v.settle=settle;}
  const p95=list=>+list.sort((a,b)=>a-b)[Math.max(0,Math.ceil(list.length*.95)-1)].toFixed(3);
  const max=list=>+Math.max(...list).toFixed(3);
  return {items:d.items.length,moves:dispatch.length*2,paints:paints.length,movingPaints,
    inputP95ms:p95(dispatch),inputMaxMs:max(dispatch),paintP95ms:p95(paints),paintMaxMs:max(paints),
    paintsOver16ms:paints.filter(ms=>ms>16).length,frameIntervalP95ms:p95(intervals)};
};
