"use strict";
// Session history and the clipboard draw through the editor's own canvas. One reusable surface
// holds the renderer. Visible DOM targets are the only source of scheduled work.
globalThis.AtriumHistoryArtwork = (() => {
  const G=globalThis;
  let stage, view, draws=0, scheduled=0, peak=0;
  function render(doc,defs,{w,h,stage:factor=1.4},bounds,assets) {
    if (!doc || !G.AtriumCanvas?.create) return null;
    if (!stage) {
      stage=document.createElement("canvas"); stage.className="history-art-stage";stage.setAttribute("aria-hidden","true");
      document.body.append(stage); view=G.AtriumCanvas.create(stage);
    }
    stage.style.width=w*factor+"px";stage.style.height=h*factor+"px";
    const rect={width:w*factor,height:h*factor};view.resized(rect);
    if (bounds) {
      const [x,y,u,v]=bounds,scale=Math.min(w*factor/Math.max(3,u-x),h*factor/Math.max(3,v-y))*.78;
      view.restoreCamera({...view.camera(),cx:(x+u)/2,cy:(y+v)/2,scale,referenceScale:scale});
    } else {view.fit(doc,defs,"objects",rect);view.zoom(1.18);}
    view.render(doc,defs,{noReuse:true,grid:false,origin:false,hidden:new Set(),layer:"Top",layerMode:"all",
      showUnrouted:false,netNames:false,selectedIds:new Set(),assets});
    const out=document.createElement("canvas"),ratio=Math.min(2,Math.max(1,G.devicePixelRatio||1));
    out.width=Math.round(w*ratio);out.height=Math.round(h*ratio);
    const ctx=out.getContext("2d");ctx.imageSmoothingQuality="high";ctx.drawImage(stage,0,0,out.width,out.height);
    view.invalidate();draws++;return out;
  }
  function releaseSurface() {
    if (!stage) return;
    view.onRepaint(null);view.invalidate();stage.remove();stage.width=stage.height=1;
    view=null;stage=null;
  }
  function watch(root) {
    const jobs=new Map(), visible=new Set();
    let frame=0, current=null;
    const active=()=>!document.hidden && G.AtriumPower?.visible?.()!==false && root.isConnected && !root.closest("[hidden]");
    function stopFrame() {
      if (frame) { cancelAnimationFrame(frame); frame=0; scheduled--; }
    }
    function abortCurrent() {
      current?.controller.abort();
    }
    function forget(node) {
      if (!node) return; // a row that never drew has no tile to forget
      jobs.delete(node); visible.delete(node); observer?.unobserve(node);
      if (current?.node===node) abortCurrent();
      if (!visible.size) stopFrame();
    }
    function pump() {
      if (!active()) { stopFrame(); abortCurrent(); return; }
      if (frame || current || !visible.size) return;
      scheduled++; peak=Math.max(peak,scheduled);
      frame=requestAnimationFrame(async()=>{
        frame=0; scheduled--;
        if (!active()) return;
        const node=visible.values().next().value, run=jobs.get(node);
        if (!run || !node.isConnected || node.closest("[hidden]")) {forget(node);pump();return;}
        const job=current={node,controller:new AbortController()};
        try { await run(job.controller.signal); }
        catch (error) { if (!job.controller.signal.aborted) node.dataset.failed="true"; }
        finally {
          current=null;
          if (!job.controller.signal.aborted && jobs.get(node)===run) forget(node);
          pump();
        }
      });
    }
    const observer=typeof IntersectionObserver==="function"?new IntersectionObserver(entries=>{
      for (const entry of entries) {
        if (entry.isIntersecting && jobs.has(entry.target)) visible.add(entry.target);
        else {
          visible.delete(entry.target);
          if (current?.node===entry.target) abortCurrent();
        }
      }
      pump();
    },{root}):null;
    const off=G.AtriumPower?.onChange?.(pump);
    document.addEventListener("visibilitychange",pump);
    function reset(){stopFrame();abortCurrent();observer?.disconnect();visible.clear();jobs.clear();releaseSurface();}
    return {
      add(node,fn){if(current?.node===node)abortCurrent();jobs.set(node,fn);if(observer)observer.observe(node);else{visible.add(node);pump();}},
      forget,reset,close(){reset();off?.();document.removeEventListener("visibilitychange",pump);}
    };
  }

  function copy(target,bitmap){
    if(!bitmap)return;target.width=bitmap.width;target.height=bitmap.height;
    target.getContext("2d").drawImage(bitmap,0,0);target.dataset.ready="true";
  }
  return Object.freeze({render,watch,copy,stats:()=>({draws,scheduled,peak})});
})();
