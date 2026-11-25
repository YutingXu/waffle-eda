"use strict";

// Low-resolution crops of real sheet artwork. An open pane supplies its pixels
// or spatial index. Other sheets are indexed only as visible thumbnails request
// them, in cancellable slices. Neither path switches the editor's document.
globalThis.AtriumConnectionThumbnails = (() => {
  const G = globalThis, W = 96, H = 54, LIMIT = 96;
  let sheets = new WeakMap();
  const images = new Map(), jobs = new Set();
  let idle = 0;
  function bounds(t) {
    if (t.entry) return G.AtriumSchObjects.entryBox(t.item, t.entry);
    if (t.item.kind === "netlabel") return G.AtriumSchAppearance.labelBox(G.AtriumSchAppearance.displayItem(t.doc,t.item));
    if (G.AtriumSchObjects.KINDS.has(t.item.kind)) return G.AtriumSchObjects.box(t.item);
    return G.AtriumNavCommon.itemBox(t.doc, G.AtriumNavHost.defs(), t.item);
  }
  function state(host, doc) {
    const v = G.AtriumUndoStore?.documentVersions(doc, host.project());
    const stamp = v ? [v.floor,v.items,v.outer,v.library,v.parameters].join("/") : "r" + host.revision();
    let s = sheets.get(doc);
    if (!s || s.stamp !== stamp || s.items !== doc.items) {
      s = {stamp, items:doc.items, scanned:0}; sheets.set(doc, s);
    }
    return s;
  }
  function* crop(host, t, s) {
    const b = bounds(t), cx = (b[0]+b[2])/2, cy=(b[1]+b[3])/2;
    const scale = Math.min(W/Math.max(19,(b[2]-b[0])*1.55), H/Math.max(10,(b[3]-b[1])*1.85));
    const box = [cx-W/(2*scale),cy-H/(2*scale),cx+W/(2*scale),cy+H/(2*scale)];
    const canvas = document.createElement("canvas"); canvas.width=W; canvas.height=H;
    const ctx = canvas.getContext("2d"), defs = host.defs(), art = G.AtriumCanvas.schematicArtwork;
    const pane = host.panes().find(p => p.docId === t.doc.id && p.view.internals().frame()?.[0] === t.doc);
    let copied = false;
    if (pane) {
      const from=pane.view.worldToScreen(box.slice(0,2)), to=pane.view.worldToScreen(box.slice(2));
      const w=pane.canvas.clientWidth, h=pane.canvas.clientHeight;
      if (from[0]>=0 && from[1]>=0 && to[0]<=w && to[1]<=h && to[0]-from[0]>=W*.8) {
        const dx=pane.canvas.width/w, dy=pane.canvas.height/h;
        ctx.drawImage(pane.canvas,from[0]*dx,from[1]*dy,(to[0]-from[0])*dx,(to[1]-from[1])*dy,0,0,W,H);
        copied = true;
      }
    }
    ctx.setTransform(scale,0,0,scale,W/2-cx*scale,H/2-cy*scale);
    if (!copied) {
      let items;
      if (pane) items = pane.view.query(t.doc, defs, box);
      else {
        art.prepare();
        s.index ??= G.AtriumSpatial.create([], item=>art.box(item,t.doc,defs),10);
        while (s.scanned < s.items.length) {
          const n=s.scanned++;
          s.index.insert(s.items[n], n);
          if (s.scanned % 24 === 0) yield;
        }
        items=s.index.query(box);
      }
      ctx.fillStyle=G.AtriumSchAppearance.paper; ctx.fillRect(...box.slice(0,2),W/scale,H/scale);
      ctx.lineCap="round"; ctx.lineJoin="round";
      const opts={wireHops:t.doc.hopOvers ? G.AtriumSchObjects.hops({...t.doc,items}) : null};
      const layers=[[],[],[],[],[]];
      for (const i of items) layers[art.order(i)].push(i);
      let count=0;
      for (const layer of layers) for (const i of layer) {
        art.draw(ctx,i,t.doc,defs,scale,opts,false);
        if (++count % 8 === 0) yield;
      }
    }
    ctx.strokeStyle=G.AtriumSchAppearance.marquee; ctx.lineWidth=1.6/scale;
    const pad=2/scale;
    ctx.strokeRect(b[0]-pad,b[1]-pad,b[2]-b[0]+2*pad,b[3]-b[1]+2*pad);
    return canvas;
  }
  function paint(node, image) {
    node.width=W; node.height=H;
    node.getContext("2d").drawImage(image,0,0);
    node.dataset.ready="true";
  }
  function run() {
    idle=0;
    const until=performance.now()+3;
    for (const job of jobs) {
      if (job.signal.aborted || !job.node.isConnected) {jobs.delete(job); continue;}
      let step;
      do {step=job.it.next();} while (!step.done && performance.now()<until);
      if (step.done) {
        jobs.delete(job);
        if (sheets.get(job.t.doc)===job.state && !job.signal.aborted) {
          images.delete(job.key); images.set(job.key,{state:job.state,image:step.value});
          if (images.size>LIMIT) images.delete(images.keys().next().value);
          paint(job.node,step.value);
        }
      }
      if (performance.now()>=until) break;
    }
    if (jobs.size) idle = G.AtriumIdle.idle(run,{timeout:100});
  }
  function request(host, node, t, signal) {
    if (signal.aborted || !node.isConnected) return;
    const s=state(host,t.doc), key=t.entry || t.item, saved=images.get(key);
    if (saved?.state===s) {images.delete(key); images.set(key,saved); paint(node,saved.image); return;}
    jobs.add({node,t,key,state:s,signal,it:crop(host,t,s)});
    if (!idle) idle=G.AtriumIdle.idle(run,{timeout:100});
  }
  function reset() {
    if (idle) G.AtriumIdle.cancel(idle);
    idle=0; jobs.clear(); images.clear(); sheets=new WeakMap();
  }
  return {bounds, request, reset};
})();
