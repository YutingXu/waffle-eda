"use strict";
// An image is a schematic annotation. Its crop and marks use millionths of the
// full oriented image, independent of placement size, PDF page units and zoom.
globalThis.AtriumNotebookImages = (() => {
  const FULL = Object.freeze([0,0,1000000,1000000]);
  const {MEDIA,valid,validMark,extentOK,regionOK,displayName,refOK} = Atrium.notebookImage;
  const sessions = new WeakMap();
  const caches = new Set();
  const preparedPixels = new WeakMap();
  function matrix(i) {
    const [l,t,r,b]=i.crop||FULL;
    const sx=i.w/(r-l), sy=i.h/(b-t), angle=-(i.angle||0)*Math.PI/180, c=Math.cos(angle), s=Math.sin(angle);
    const x=i.x+i.w/2, y=i.y+i.h/2, du=-(l+r)/2,dv=-(t+b)/2;
    return [c*sx,s*sx,-s*sy,c*sy,x+c*sx*du-s*sy*dv,y+s*sx*du+c*sy*dv];
  }
  function projectPoint(m,[x,y]) {return [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];}
  function local(i,p) {
    const [a,b,c,d,e,f]=matrix(i), det=a*d-b*c, x=p[0]-e,y=p[1]-f;
    return [(d*x-c*y)/det,(a*y-b*x)/det];
  }
  function grips(i) {
    const [l,t,r,b]=i.crop||FULL, m=matrix(i), values=[];
    for (const v of [0,.5,1]) for(const u of [0,.5,1]) if(u!==.5||v!==.5)
      values.push({u,v,at:projectPoint(m,[l+(r-l)*u,t+(b-t)*v])});
    return values;
  }
  function hit(i,p) {
    const [l,t,r,b]=i.crop||FULL, [u,v]=local(i,p);
    return Math.hypot(Math.max(l-u,u-r,0)*i.w/(r-l),Math.max(t-v,v-b,0)*i.h/(b-t));
  }
  function resizeAt(i,g) {
    const was={x:i.x,y:i.y,w:i.w,h:i.h}, rad=-(i.angle||0)*Math.PI/180;
    const c=Math.cos(rad),s=Math.sin(rad),fixed=grips(i).find(q=>q.u===1-g.u&&q.v===1-g.v).at;
    return {grip:g,cancel:()=>Object.assign(i,was),move(q,grid=0) {
      const dx=q[0]-fixed[0],dy=q[1]-fixed[1];
      const snap=n=>Math.max(grid||.01,grid?Math.round(n/grid)*grid:n);
      const w=g.u===.5?was.w:snap((dx*c+dy*s)*(2*g.u-1));
      const h=g.v===.5?was.h:snap((-dx*s+dy*c)*(2*g.v-1));
      const x=(g.u-.5)*w,y=(g.v-.5)*h;
      Object.assign(i,{w,h,x:fixed[0]+c*x-s*y-w/2,y:fixed[1]+s*x+c*y-h/2});
      return i;
    }};
  }
  function bounds(i) {
    const [l,t,r,b]=i.crop||FULL, m=matrix(i);
    const points=[[l,t],[r,t],[r,b],[l,b]].map(p=>projectPoint(m,p));
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    const box=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
    if(i.caption)box[3]+=3;
    return box;
  }
  const intersects = (a,b)=>a[0]<=b[2] && b[0]<=a[2] && a[1]<=b[3] && b[1]<=a[3];
  const need = name => globalThis[name] ? Promise.resolve(globalThis[name]) : globalThis.AtriumLazy?.need(name);
  const session = () => globalThis.AtriumNavHost?.folderProject?.();
  const logicalKey=(ref,pixels)=>ref.sha256+":"+pixels;
  function scaleFor(i,scale) {
    const c=i.crop||FULL, ratio=Math.max(1000000/(c[2]-c[0]),1000000/(c[3]-c[1]));
    const want=Math.max(i.w,i.h)*Math.max(.25,scale||8)*ratio;
    return Math.min(4096, Math.max(128,2**Math.ceil(Math.log2(Math.max(1,want)))));
  }
  function state(s) {
    let st=sessions.get(s);
    if (!st || st.closed) {
      st={session:s,entries:new Map(),bytes:0,pending:0,queue:[],closed:false};
      sessions.set(s,st);caches.add(st);
      st.stop=globalThis.AtriumNavHost?.on?.("replace",()=>clear(s));
    }
    return st;
  }
  function retire(st, key, entry) {
    st.entries.delete(key);entry.controller.abort();entry.value?.close?.();st.bytes-=entry.cost||0;
  }
  function clear(s) {
    const list=s ? [sessions.get(s)] : Array.from(caches);
    for (const st of list) if (st) {
      st.closed=true;
      for (const [k,v] of st.entries) retire(st,k,v);
      st.queue.length=0;st.stop?.();caches.delete(st);
    }
    if (s) sessions.delete(s);
  }
  function trim(st) {
    for(const [key,e] of st.entries) {
      if(st.bytes<=32*1048576 && st.entries.size<=96)break;
      if(e.value||e.error)retire(st,key,e);
    }
  }
  function refresh(docId) {
    const host=globalThis.AtriumNavHost;
    if(host?.invalidateDocument)host.invalidateDocument(docId,true);else host?.redraw?.();
  }
  async function decode(owner,ref,pixels,purpose,resolveAsset,signal,assetSession) {
    if(signal?.aborted)throw new DOMException("Cancelled","AbortError");
    const codec=await need("AtriumNotebookMedia");
    if(signal?.aborted)throw new DOMException("Cancelled","AbortError");
    if(!codec)throw Error("Image decoder unavailable");
    const native=globalThis.AtriumHost;
    const derivatives=purpose==="display" && assetSession?.grant && native?.notebookDerivative;
    const scope={grant:assetSession?.grant,ownerId:owner,assetRef:ref,side:pixels};
    if(derivatives){
      try {
        const saved=await native.notebookDerivative({...scope,op:"read"});
        if(saved?.png && /^[0-9a-f]{64}$/.test(saved.sha256)){
          const bytes=codec.from64(saved.png);
          const surface=await codec.decode(bytes,{mediaType:"image/png",byteLength:bytes.length,sha256:saved.sha256},{pixels,signal,purpose:"display"});
          return surface;
        }
      } catch(e){if(signal?.aborted)throw e;}
    }
    const response=await resolveAsset({ownerId:owner,assetRef:ref,purpose,signal});
    if(signal?.aborted)throw new DOMException("Cancelled","AbortError");
    if(!response || response.assetRef?.sha256!==ref.sha256 || response.assetRef?.mediaType!==ref.mediaType ||
        response.assetRef?.byteLength!==ref.byteLength)throw Error("Image integrity could not be verified");
    const value=await codec.decode(response.bytes,ref,{pixels,signal,ownerId:owner,purpose:derivatives?"cache":purpose});
    if(derivatives && value.png && !signal?.aborted)native.notebookDerivative({...scope,op:"write",png:codec.to64(value.png)}).catch(()=>{});
    if(value.bitmap && value.rgba)preparedPixels.set(value.bitmap,value);
    return value;
  }
  function pump(st) {
    while (!st.closed && st.pending<2 && st.queue.length) {
      const job=st.queue.shift(), e=job.entry;
      if(e.controller.signal.aborted)continue;
      st.pending++;
      decode(job.docId,job.ref,job.pixels,"display",job.read,e.controller.signal,st.session).then(value=>{
        if(st.closed||e.controller.signal.aborted){value.close?.();return;}
        e.value=value;e.cost=4*value.width*value.height;st.bytes+=e.cost;
      }).catch(err=>{if(!e.controller.signal.aborted)e.error=String(err.message||err);}).finally(()=>{
        st.pending--;trim(st);pump(st);if(!st.closed&&!e.controller.signal.aborted)refresh(job.docId);
      });
    }
  }
  function visible(s,docId,ref,pixels) {
    if(!s?.readAsset)return {error:"Image source unavailable"};
    const st=state(s), key=docId+"/"+logicalKey(ref,pixels);
    let e=st.entries.get(key);
    if(e){st.entries.delete(key);st.entries.set(key,e);return e;}
    e={controller:new AbortController()};st.entries.set(key,e);
    st.queue.push({entry:e,docId,ref,pixels,read:o=>s.readAsset(o)});pump(st);
    return e;
  }
  function prepareAssets(project,{documentIds,windows,resolveAsset,decodeAsset,signal,scale=12,purpose="print"}={}) {
    return (async()=>{
      const ids=new Set(documentIds||project.documents.map(d=>d.id)), map=new Map(), requests=new Map(), notes=[];
      const assetSession=session();
      const read=resolveAsset || (assetSession?.readAsset ? args=>assetSession.readAsset(args) : null);
      for(const d of project.documents||[]) if(ids.has(d.id)) {
        const boxes = windows instanceof Map ? windows.get(d.id) : windows?.[d.id];
        for(const i of d.items||[]) {
          if (i.widget?.state?.tableVersion === 1) {
            const view = globalThis.AtriumTableVisual || await globalThis.AtriumLazy?.need?.("AtriumTableVisual");
            for (const entry of view?.imageRequests(project,d,i,boxes) || []) {
              const ref = entry.ref;
              if (!ref || !refOK(ref,MEDIA)) continue;
              const old = requests.get(ref.sha256), pixels = scaleFor(entry,scale);
              if (!old || old.pixels < pixels) requests.set(ref.sha256,{owner:d.id,ref,pixels});
            }
            continue;
          }
          const fallback=i.widget?.fallback || i.fallback;
          const ref=i.kind==="image"?i.asset:fallback?.type==="image"?fallback.assetRef:null;
          if(!ref||!refOK(ref,MEDIA))continue;
          if(boxes?.length && !boxes.some(b=>intersects(bounds(i),b)))continue;
          const old=requests.get(ref.sha256),pixels=scaleFor(i,scale);
          if(!old || old.pixels<pixels)requests.set(ref.sha256,{owner:d.id,ref,pixels});
        }
      }
      const release=()=>{for(const v of map.values())v.close?.();map.clear();};
      try {
        for(const [key,r] of requests) {
          if(signal?.aborted)throw new DOMException("Cancelled","AbortError");
          try {
            if (decodeAsset) map.set(key,await decodeAsset({ownerId:r.owner,assetRef:r.ref,pixels:r.pixels}));
            else {
              if(!read)throw Error("Image source unavailable");
              map.set(key,await decode(r.owner,r.ref,r.pixels,purpose,read,signal,assetSession));
            }
          }
          catch(e){
            if(signal?.aborted)throw e;
            const error=String(e.message||e);
            map.set(key,Object.freeze({error}));
            notes.push("Image "+key.slice(0,12)+": "+error);
          }
        }
        return Object.freeze({get:k=>map.get(k),release,notes});
      } catch(e) {release();throw e;}
    })();
  }
  function drawMark(ctx,mark,{doc,project}={}) {
    globalThis.AtriumSchNoteMarkup?.draw(ctx,mark,{colour:mark.colour,drawText:(g,a)=>{
      const label=typeof a.richText==="string"?a.richText:a.text || globalThis.AtriumNotebook?.bodyText?.(a.richText,project,doc)?.text || "";
      const w=Math.abs(a.to[0]-a.at[0]), h=Math.abs(a.to[1]-a.at[1]);
      g.font=Math.max(12000,h*.72)+"px sans-serif";g.textBaseline="top";
      g.fillText(label,Math.min(a.at[0],a.to[0]),Math.min(a.at[1],a.to[1]),Math.max(1,w));
    }});
  }
  function paintMarks(ctx,i,options) {
    if(!options.doc?.items)return;
    for(const mark of marksFor(options.doc,i.id))
      if(!options.policy?.visibleIn || options.policy.visibleIn(mark,i.id))drawMark(ctx,mark,options);
  }
  const markIndex=new WeakMap();
  function marksFor(doc,id) {
    const revision=globalThis.AtriumUndoStore?.documentVersion?.(doc.id)??globalThis.AtriumNavHost?.revision?.();
    const old=markIndex.get(doc);
    if(old && old.revision===revision && old.items===doc.items && old.count===doc.items.length)return old.map.get(id)||[];
    const map=new Map();
    for(const m of doc.items)if(m.kind==="imageMarkup"&&m.imageId){if(!map.has(m.imageId))map.set(m.imageId,[]);map.get(m.imageId).push(m);}
    markIndex.set(doc,{revision,items:doc.items,count:doc.items.length,map});return map.get(id)||[];
  }
  function draw(ctx,i,o={}) {
    const [l,t,r,b]=i.crop||FULL, m=matrix(i), box=bounds(i);
    if(o.policy?.visibleIn && !o.policy.visibleIn(i) || o.viewport && !intersects(box,o.viewport))return;
    const prepared=o.assets?.get?.(i.asset.sha256);
    const entry=prepared?null:o.assets?{error:"Image source unavailable"}:visible(o.session||session(),o.doc?.id,i.asset,scaleFor(i,o.scale));
    const val=prepared||entry?.value, error=val?.error||entry?.error;
    ctx.save();ctx.transform(...m);
    ctx.beginPath();ctx.rect(l,t,r-l,b-t);ctx.clip();
    if(val?.bitmap)ctx.drawImage(val.bitmap,0,0,1000000,1000000);
    else {ctx.fillStyle=o.placeholder||"#e4e4e4";ctx.fillRect(l,t,r-l,b-t);}
    paintMarks(ctx,i,o);ctx.restore();
    if(error||i.caption){
      ctx.save();ctx.fillStyle=o.ink||"#484848";ctx.textBaseline=error?"middle":"top";
      ctx.font="2px sans-serif";
      if(error)ctx.fillText(["Image unavailable",i.alt||i.name].filter(Boolean).join(" · "),box[0]+.6,(box[1]+box[3])/2,Math.max(.1,box[2]-box[0]-1.2));
      if(i.caption){ctx.textBaseline="top";ctx.fillText(i.caption,box[0],box[3]-2.7,Math.max(.1,box[2]-box[0]));}
      ctx.restore();
    }
  }
  function foreignImage(i,{doc,assets,scale=12,policy}={}) {
    const box=bounds(i),alt=i.alt||i.caption||i.name||"Image",preview=assets?.get(i.asset?.sha256);
    if(!preview?.bitmap)return {type:"text",text:i.caption||alt,box,reason:preview?.error||"Image pixels unavailable"};
    return staticRaster({box,alt,scale},g=>draw(g,i,{doc,assets,scale,policy}));
  }
  function staticRaster({box,alt,scale=12},paint) {
    const fallback=reason=>({type:"text",text:alt,box,reason});
    if(!globalThis.document?.createElement)return fallback("PNG encoding unavailable");
    const sw=box[2]-box[0],sh=box[3]-box[1];
    if(!(sw>0&&sh>0))return fallback("Empty drawing bounds");
    let px=Math.min(Math.max(scale,1),2048/Math.max(sw,sh));
    const canvas=document.createElement("canvas");
    try {
      // Keep the PNG within the portable image reader's byte limit even for noisy photographs.
      while(px>0){
        canvas.width=Math.max(1,Math.round(sw*px));canvas.height=Math.max(1,Math.round(sh*px));
        const g=canvas.getContext("2d");g.scale(canvas.width/sw,canvas.height/sh);g.translate(-box[0],-box[1]);
        paint(g);
        const url=canvas.toDataURL("image/png");
        if(!url.startsWith("data:image/png;base64,"))return fallback("PNG encoding unavailable");
        if(url.length-22<=7999900)return {type:"image",data:url.slice(22),mediaType:"image/png",width:canvas.width,height:canvas.height,
          box,alt};
        if(canvas.width===1&&canvas.height===1)return fallback("The static image exceeds the target byte limit.");
        px*=.7;
      }
    } catch(e) {return fallback(e.message||"Image encoding failed");}
    finally {canvas.width=canvas.height=0;}
  }
  globalThis.addEventListener?.("pagehide",()=>clear());
  globalThis.document?.addEventListener?.("visibilitychange",()=>{if(document.hidden)clear();});
  return {FULL,MEDIA,valid,validMark,grips,hit,resizeAt,pixelsOf:b=>preparedPixels.get(b),foreignImage,staticRaster,extentOK,regionOK,displayName,refOK,matrix,projectPoint,local,bounds,marksFor,
    scaleFor,clear,draw,drawMark,prepareAssets,visibleAsset:(docId,ref,w,h,scale)=>visible(session(),docId,ref,scaleFor({w,h},scale)).value};
})();
