"use strict";
// Open minimap-damage.html in a browser. This drives the actual lazy minimap host and compares its
// composed artwork, including structural updates, with an independent full Canvas 2D rendering.
(() => {
  const events = new Map(), idle = new Map(), frames = new Map();
  const surface = document.getElementById("view"), powerListeners = new Set();
  let seq = 0, project, doc, hidden = new Set(), renderer, visible = true, center = [0,0], zoom = 1, drag = null;
  const change = name => events.get(name)?.();
  const drain = queue => {
    while (queue.size) {
      const [id, work] = queue.entries().next().value;
      queue.delete(id);
      work();
    }
  };
  globalThis.AtriumIdle = {idle(fn) { idle.set(++seq,fn); return seq; }, cancel(id) { idle.delete(id); }};
  globalThis.requestAnimationFrame = fn => { frames.set(++seq,fn); return seq; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.AtriumPower = {visible:() => visible, onChange:fn => powerListeners.add(fn)};
  globalThis.AtriumNavHost = {
    doc:() => doc, project:() => project, hiddenLayers:() => hidden, canvas:() => surface, drag:() => drag,
    view:() => ({screenToWorld:([x,y]) => [center[0]+x/(8*zoom),center[1]+y/(8*zoom)]}),
    registerAction(){}, addRenderer(fn) { renderer=fn; }, on(name,fn) { events.set(name,fn); }
  };
  AtriumNavCommon.ready = fn => fn(AtriumNavHost);

  function makeReference(d) {
    const c = document.createElement("canvas"), ratio = Math.min(2,devicePixelRatio || 1);
    c.width=220*ratio; c.height=150*ratio;
    const g=c.getContext("2d"), PCB=d.kind==="pcb" && AtriumPCBAppearance, m=AtriumMinimap.mapping(d);
    const tokens=getComputedStyle(document.documentElement), color=(n,fallback) => tokens.getPropertyValue(n).trim() || fallback;
    const ink=layer => PCB ? PCB.color(layer || "Top") : color("--muted","#9a9a9a");
    g.setTransform(ratio,0,0,ratio,0,0);
    g.fillStyle=PCB ? PCB.system.workspace : color("--canvas-bg","#202020"); g.fillRect(0,0,220,150);
    function path(points) {
      g.beginPath(); g.moveTo(...m.to(points[0]));
      for (const p of points.slice(1)) g.lineTo(...m.to(p));
    }
    if (PCB && d.outline?.length>=3) {
      path(d.outline); g.closePath(); g.fillStyle=PCB.system.board; g.fill();
      g.strokeStyle=PCB.system.edge; g.lineWidth=1; g.stroke();
    }
    g.lineCap="round";
    for (const i of d.items) {
      if (PCB && i.layer && hidden.has(i.layer)) continue;
      const alpha=PCB ? PCB.layerAlpha(i.layer) : 1;
      if (i.points?.length>1 && ["track","wire","graphic"].includes(i.kind)) {
        g.globalAlpha=.9*alpha; g.strokeStyle=ink(i.layer); g.lineWidth=Math.max(.6,(i.width||.2)*m.k);
        path(i.points); g.stroke();
      } else if (Number.isFinite(i.x)) {
        const [x,y]=m.to([i.x,i.y]), size=i.kind==="part" ? 2.2 : 1.4;
        g.globalAlpha=.85*alpha; g.fillStyle=ink(i.kind==="via" ? "Multi" : i.layer);
        g.fillRect(x-size/2,y-size/2,size,size);
      }
    }
    return c;
  }
  const rect=(x0,y0,x1,y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  const track=(id,points,layer="Top",width=.22) => ({id,kind:"track",points,layer,width});
  const flush=() => { drain(idle); drain(frames); };
  const baseJobs=() => [...idle.values()].filter(fn => String(fn).includes("paintBase()")).length;
  function assert(ok,message) { if(!ok) throw Error(message); }
  const base=() => document.querySelector(".cam-minimap-base");
  const overlay=() => document.querySelector(".cam-minimap-view");
  const data=c => c.getContext("2d").getImageData(0,0,c.width,c.height).data;
  function difference(a,b) {
    assert(a.length===b.length,"Canvas dimensions differ");
    let count=0;
    for(let n=0;n<a.length;n+=4) if(a[n]!==b[n]||a[n+1]!==b[n+1]||a[n+2]!==b[n+2]||a[n+3]!==b[n+3]) count++;
    return count;
  }
  function scene(d, other=[]) {
    hidden=new Set(); doc=d; project={name:"Minimap test",documents:[d,...other],library:[]};
    AtriumUndoStore.reset(); AtriumUndoStore.record(project);
    AtriumMinimap.show(false);
    const started=performance.now();
    AtriumMinimap.show(true); flush(); base().getContext("2d").getImageData(0,0,1,1);
    const firstPaint=performance.now()-started;
    const history=[], redo=[];
    return {
      firstPaint,
      edit(fn, notify=true) {
        const mark=AtriumUndoStore.mark(project); fn(); AtriumUndoStore.checkpoint(history,redo,mark);
        AtriumUndoStore.record(project); if(notify) change("change");
      },
      undo(n) { AtriumUndoStore.jump(history,redo,AtriumUndoStore.mark(project),n); change("change"); }
    };
  }

  globalThis.checkAtriumMinimap = function (benchmarkOnly) {
    const cases=[], ctx=CanvasRenderingContext2D.prototype;
    const saved={fillRect:ctx.fillRect,stroke:ctx.stroke,drawImage:ctx.drawImage};
    // Repeated pixel readback can change Chromium's backing-store rasterizer.
    // Use the same readback-friendly renderer for the base, scratch and reference.
    const canvases=HTMLCanvasElement.prototype,getContext=canvases.getContext;
    canvases.getContext=function (type,...options) {
      return type==="2d" ? getContext.call(this,type,{...options[0],willReadFrequently:true}) : getContext.call(this,type,...options);
    };
    const spatial=AtriumSpatial;
    let work, indexes=0;
    globalThis.AtriumSpatial={...spatial,create(...args) { indexes++; return spatial.create(...args); }};
    for(const method of Object.keys(saved)) ctx[method]=function (...args) {
      if(work) {
        if(method==="drawImage" && this.canvas===base()) work.patches++;
        if(method!=="drawImage") work.paint++;
      }
      return saved[method].apply(this,args);
    };
    function compare(name, expected, update=()=>drain(idle)) {
      work={paint:0,patches:0}; update(); const {paint,patches}=work; work=null;
      const wanted=expected==="patch" ? patches===1 && paint>0 : expected==="full" ? patches===0 && paint>0 : patches===0 && paint===0;
      assert(wanted,`${name}: expected ${expected}, observed ${paint} paint calls and ${patches} patches`);
      const changed=difference(data(base()),data(makeReference(doc)));
      assert(changed===0,`${name}: ${changed} different pixels`);
      cases.push({name,mode:expected,paint});
      drain(frames);
    }
    try {
      if(!benchmarkOnly) {
        const d=Atrium.sheet("pcb","Minimap board"), other=Atrium.sheet("schematic","Other sheet");
        d.outline=rect(0,0,90,60);
        const behind=track("behind",[[7.2,30.1],[72,34.6]],"Bottom",1.9);
        const mover=track("move",[[32.6,29.3],[44.1,33.6],[33.1,29.9]],"Top",.75);
        const pad={id:"pad",kind:"via",layer:"Multi",x:37.6,y:30.1};
        const part={id:"part",kind:"part",x:48.6,y:36.9,value:"R"};
        d.items.push(behind,mover,pad,part);
        const s=scene(d,[other]);
        renderer(doc,{active:true}); flush();
        assert(indexes===0,"Showing and moving the viewport rectangle does not build an index");
        s.edit(()=>{mover.points[0][0]+=.4; mover.points[1][1]+=1.2;});
        compare("Moved sharp track with overlapping translucent copper","patch");
        assert(indexes===1,"The first visible damage queries one new index");
        s.edit(()=>d.items.splice(1,1)); compare("Delete from middle of paint order","patch");
        s.undo(-1); compare("Undo re-inserts the same item and restores paint order","patch");
        s.undo(1); compare("Redo removes it again","patch");
        const before=track("insert",[[35,27.3],[45,33.6]],"Top",1.1);
        s.edit(()=>d.items.splice(0,0,before)); compare("Insert behind existing geometry","patch");
        s.edit(()=>{[d.items[0],d.items[1]]=[d.items[1],d.items[0]];}); compare("Reordered overlapping geometry","patch");
        s.edit(()=>{pad.x+=.7;}); s.edit(()=>{before.points[0][1]+=.6;});
        assert(idle.size===1,"Two edits coalesce into one pending minimap job");
        compare("Two committed edits before one redraw","patch");
        s.edit(()=>{pad.net="U1";});
        assert(baseJobs()===0,"Small committed metadata edits skip minimap preparation");
        compare("PCB metadata edit leaves bitmap alone","reuse");
        s.edit(()=>{part.value="A longer component comment";});
        assert(baseJobs()===0,"A part comment with unchanged projection schedules no idle work");
        compare("PCB comment and full paint have the same pixels","reuse");
        s.undo(-1);assert(baseJobs()===0,"Undo of a certified comment edit schedules no idle work");
        compare("Undo comment preserves the base bitmap","reuse");
        s.undo(1);assert(baseJobs()===0,"Redo of a certified comment edit schedules no idle work");
        compare("Redo comment preserves the base bitmap","reuse");
        drag={before:true};s.edit(()=>{part.value="Comment during drag";});
        assert(baseJobs()===1,"An active drag keeps its normal idle update");
        compare("Drag fallback keeps identical committed pixels","reuse");drag=null;
        for(let n=0;n<9;n++)s.edit(()=>{part.value="Deferred "+n;},false);
        change("change");assert(baseJobs()===1,"A larger journal batch stays off the foreground path");
        compare("Large metadata batch retains existing pixels","reuse");
        AtriumUndoStore.reset();AtriumUndoStore.record(project);change("change");
        assert(baseJobs()===1,"A journal gap requires an idle update");
        compare("Journal gap falls back to a full paint","full");
        s.edit(()=>{other.items.push({id:"w",kind:"wire",points:[[5,5],[10,5]]});});
        compare("Edit on another document leaves bitmap alone","reuse");
        s.edit(()=>{project.library.push({id:"R",footprint:{pads:[{x:1,y:1}]}});});
        s.edit(()=>{project.library[0].footprint.pads[0].x=3;});
        compare("Footprint changes leave the minimap's anchor dots alone","reuse");
        const prior=data(overlay()); center=[8,11]; zoom=1.2; renderer(doc,{active:true});
        assert(idle.size===0,"Camera changes may not schedule a base paint");
        drain(frames); assert(difference(prior,data(overlay()))>0,"Camera rectangle must move");
        compare("Pan and zoom retain identical base pixels","reuse");
        hidden.add("Bottom"); renderer(doc,{active:true}); compare("Visibility change refreshes base without a model edit","full");
        s.edit(()=>{behind.points[0][0]+=.8;}); compare("Movement on a hidden layer leaves base alone","reuse");
        s.edit(()=>{behind.layer="Top";}); compare("A formerly hidden item joins the paint order","patch");
        AtriumPCBAppearance.setLayerOpacity("Top",.48);
        compare("Layer opacity refreshes base","full");
        const theme=() => globalThis.dispatchEvent(new CustomEvent("atrium-theme",{detail:{reason:"change"}}));
        theme(); compare("A theme setting without new board colours leaves the bitmap alone","reuse");
        s.edit(()=>{d.outline[1][1]=2;}); compare("Outline changes refresh base even with the same extent","full");

        s.edit(()=>{pad.y+=.8;}); renderer(doc,{active:true});
        const stale=[...idle.values()]; visible=false; for(const f of powerListeners) f();
        assert(idle.size===0 && frames.size===0,"Occlusion cancels pending minimap work");
        const old=data(base()); for(const f of stale) f(); renderer(doc,{active:true});
        assert(idle.size===0 && frames.size===0 && difference(old,data(base()))===0,"Stale hidden callbacks may not draw");
        visible=true; for(const f of powerListeners) f(); compare("Only latest damage is painted on return","patch");
        s.edit(()=>{pad.y+=.8;}); AtriumMinimap.show(false);
        assert(idle.size===0 && frames.size===0,"Closing cancels queued base and overlay work");
        s.edit(()=>{pad.y+=.8;}); renderer(doc,{active:true});
        assert(idle.size===0 && frames.size===0,"Closed minimap does not schedule work");
        AtriumMinimap.show(true); compare("Reopening shows the current model","full");

        const outlineFree=Atrium.sheet("pcb","Outline not yet drawn");
        const inner=track("interior",[[30,27],[50,35]]), limit=track("bounds",[[10,10],[80,55]],"Bottom");
        outlineFree.items.push(inner,limit);
        const fallback=scene(outlineFree);
        fallback.edit(()=>{inner.points[0][0]++;}); compare("Outline-free board with unchanged extents","patch");
        fallback.edit(()=>{limit.points[0][0]-=4;}); compare("Moved extent recalculates mapping","full");
        fallback.edit(()=>outlineFree.items.pop()); compare("Deleting an extremal item recalculates mapping","full");
        fallback.undo(-1); compare("Undo of the extent deletion recalculates mapping","full");

        const schematic=Atrium.sheet("schematic","Schematic minimap");
        const line={id:"wire",kind:"wire",points:[[60,70],[85,70],[86,71]]}; schematic.items.push(line);
        const schematicEdit=scene(schematic);
        schematicEdit.edit(()=>{line.points[0][0]+=2;}); compare("Schematic wire edit reuses the sheet bounds","patch");
        schematicEdit.edit(()=>{schematic.sheet={size:"ANSI C",orientation:"portrait"};});
        compare("Schematic page size remaps the artwork","full");
        schematicEdit.edit(()=>{line.net="Metadata on a finite page";});
        assert(baseJobs()===0,"A certified finite schematic edit skips base work");
        compare("Finite schematic metadata leaves the base alone","reuse");
        theme(); compare("A motion or density change leaves the sheet bitmap alone","reuse");
        document.documentElement.style.setProperty("--muted","#7a8a9a"); theme();
        compare("A new sheet ink refreshes the base","full");
        document.documentElement.style.removeProperty("--muted"); theme(); drain(idle);
        line.points[0][0]+=4; AtriumUndoStore.touch(project); change("change");
        // Run the explicit visible paint before the pending journal can offer a complete cursor.
        compare("Unrecorded edit falls back safely","full",()=>AtriumMinimap.repaint());
        flush();
        const infinite=Atrium.sheet("schematic","Infinite minimap");infinite.sheet={infinite:true};
        const w={id:"infinite-wire",kind:"wire",points:[[4,4],[20,10]]};infinite.items.push(w);
        const openSheet=scene(infinite);
        openSheet.edit(()=>{w.net="Reference to more canvas artwork";});
        assert(baseJobs()===1,"An infinite schematic continues to resolve its drawing bounds at idle");
        compare("Infinite schematic rechecks the canvas ink bounds","reuse");
        openSheet.edit(()=>{w.points[0][0]-=12;});
        compare("Changed infinite ink extent remaps the base","full");
      }

      AtriumPCBAppearance.setLayerOpacity("Top",1);
      const dense=makeAtriumBenchmarkBoard().d, denseScene=scene(dense), item=dense.items.find(i=>i.id==="o13001");
      const samples=[], n=32;
      let patches=0, firstEdit;
      for(let i=0;i<n+1;i++) {
        denseScene.edit(()=>{if(item.points) item.points[0][0]+=i%2 ? .2 : -.2; else item.x+=i%2 ? .2 : -.2;},false);
        work={paint:0,patches:0};
        const start=performance.now();
        AtriumMinimap.repaint(); base().getContext("2d").getImageData(0,0,1,1);
        if(i) { samples.push(performance.now()-start); patches+=work.patches; }
        else firstEdit=performance.now()-start;
        work=null;
        drain(frames);
      }
      samples.sort((a,b)=>a-b);
      return {dpr:devicePixelRatio, cases, timing:{objects:dense.items.length,samples:n,patches,firstPaint:+denseScene.firstPaint.toFixed(2),firstEdit:+firstEdit.toFixed(2),p50:+samples[Math.ceil(n*.5)-1].toFixed(2),p95:+samples[Math.ceil(n*.95)-1].toFixed(2)}};
    } finally {
      for(const method of Object.keys(saved)) ctx[method]=saved[method];
      canvases.getContext=getContext;
      globalThis.AtriumSpatial=spatial;
      AtriumMinimap.show(false); AtriumUndoStore.reset();
    }
  };
})();
