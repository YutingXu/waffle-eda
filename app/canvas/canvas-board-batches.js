"use strict";

// Used when the visible board contains enough objects to batch.
globalThis.AtriumCanvasBoardBatches = { create({A,PCB,T,chosen,netInk,boardLayer,union,appendArc}) {
  // Level of detail for big board views. Static copper and footprint primitives are batched
  // into one Path2D per layer, kind and width (or ink group), in spatial chunks that rebuild
  // only when their items change. Selected, highlighted and net-coloured objects, large pads
  // that show their text and footprint text are still drawn one by one on top, exactly.
  const TEXT_MIN=1.5, HOLE_MIN=1, SMALL_PX=2.5, PAD_TEXT=PCB.padCaptionMinPx;
  function batchPad(p){
    if(PCB.hasPadRows(p))return null;
    const g=PCB.padGeometry(p);
    if(!g || g.holeOnly || g.drill>0 && PCB.partialSpan(p))return null;
    if((g.shape==="roundrect" || g.shape==="obround") && (!Path2D.prototype.roundRect || typeof DOMMatrix!=="function"))return null;
    return g;
  }
  const repKey=o=>(o?.fromLayer||"")+">"+(o?.toLayer||"");
  const rep=o=>({fromLayer:o?.fromLayer,toLayer:o?.toLayer});
  function lodClassify(i,defs,box,doc){
    if(i.kind==="track" || i.kind==="graphic"){
      if(!i.points?.length || i.fill || i.dimension || i.keepout)return null;
      return {box,kind:"t"};
    }
    if(i.kind==="via" || i.kind==="pad"){
      // Tenting draws nothing of its own (canvas.js drawPad), so tented vias batch like any other.
      if(i.kind==="via" && (i.stackMode || i.ipc4761 || i.backdrill || i.viaInPad))return null;
      const geom=batchPad(i);
      return geom?{box,kind:"p",geom}:null;
    }
    if(i.kind!=="part")return null;
    const fp=PCB.readDefinition(defs,i.def,doc)?.footprint;
    if(!fp)return null;
    const info={box,kind:"part",groups:[],texts:[],maxText:0,pads:[],maxPad:0,nets:new Set()};
    for(const group of PCB.footprintLayers(i,fp)){
      const shapes=[],texts=[],pads=[],guides=[];
      for(const s of group.shapes){
        if(s.net)info.nets.add(s.net);
        if(s.cutout){guides.push(s);continue;}
        if(s.kind==="text"){texts.push(s);info.maxText=Math.max(info.maxText,!T || s.font==="barcode"?Infinity:s.size>0?s.size:.75);continue;}
        // Only a leading filled shape keeps the per-footprint fill-then-stroke order.
        if(s.keepout||s.regionShape||s.fill && shapes.length)return null;
        shapes.push(s);
      }
      for(const p of group.pads){
        const geom=batchPad(p);
        if(!geom)return null;
        const net=PCB.padNet(p,i);if(net)info.nets.add(net);
        pads.push({p,geom});info.pads.push({layer:group.layer,p,min:geom.min});
      }
      info.groups.push({layer:group.layer,shapes,pads});
      if(texts.length)info.texts.push({layer:group.layer,shapes:texts,pads:[]});
      if(guides.length)(info.guides||=[]).push({layer:group.layer,shapes:guides,pads:[]});
    }
    info.pads.sort((a,b)=>b.min-a.min);info.maxPad=info.pads[0]?.min||0;
    return info;
  }
  // True when an object must be drawn one by one this frame.
  function lodSpecial(i,info,opts,scale){
    if(chosen(i,opts))return true;
    if(info.kind==="part")return !!opts.highlight && info.nets.has(opts.highlight);
    if(opts.highlight && i.net===opts.highlight)return true;
    if(info.kind==="t")return !!netInk(i,opts);
    return PCB.padCaption(i,null,info.geom,scale,opts);
  }
  // Keep editor guides outside the physical artwork paths so opening or printing a
  // cutout-bearing footprint uses the same geometry and batching at every zoom.
  function lodGroups(info,scale,opts){
    const out=info.maxText*scale>=TEXT_MIN?info.texts.slice():[];
    if(info.guides&&!opts.hideRegionGuides)out.push(...info.guides);
    if(info.maxPad*scale>PAD_TEXT){
      const by=new Map();
      for(const q of info.pads){if(q.min*scale<=PAD_TEXT)break;if(!by.has(q.layer))by.set(q.layer,[]);by.get(q.layer).push(q.p);}
      for(const [layer,pads] of by)out.push({layer,shapes:[],pads});
    }
    return out;
  }
  const localRoundRects=new Map();
  function addPoly(path,pts,closed,fill){
    if(!pts.length)return;
    if(fill){let a=0;for(let n=0;n<pts.length;n++){const p=pts[n],q=pts[(n+1)%pts.length];a+=p[0]*q[1]-q[0]*p[1];}if(a<0)pts=pts.slice().reverse();}
    path.moveTo(pts[0][0],pts[0][1]);
    for(let n=1;n<pts.length;n++)path.lineTo(pts[n][0],pts[n][1]);
    // Fill-only paths stay open: filling closes each subpath, and Chrome's Path2D.closePath
    // costs time proportional to the whole path, so closing every land of a chunk was quadratic.
    if(closed && !fill)path.closePath();
  }
  // A pad land in world space: the same outline drawPad makes with translate and rotate.
  function addLand(path,X,Y,rot,g){
    const {w,h,shape,r}=g;
    const c=Math.cos(rot),s=Math.sin(rot),at=(x,y)=>[X+x*c-y*s,Y+x*s+y*c];
    if(shape==="circle" || shape==="ellipse"){path.moveTo(X+w/2*c,Y+w/2*s);path.ellipse(X,Y,w/2,h/2,rot,0,Math.PI*2);return;}
    if(shape==="obround" || shape==="roundrect"){
      const k=w+","+h+","+r;let local=localRoundRects.get(k);
      if(!local){if(localRoundRects.size>512)localRoundRects.clear();local=new Path2D();local.roundRect(-w/2,-h/2,w,h,r);localRoundRects.set(k,local);}
      path.addPath(local,new DOMMatrix([c,s,-s,c,X,Y]));return;
    }
    addPoly(path,PCB.padPolygon(g).map(q=>at(q[0],q[1])),true,true);
  }
  function lodEntry(ch,layer,cat,key,make){
    let L=ch.layers.get(layer);
    if(!L){L={t:new Map(),li:new Map(),hi:new Map(),pf:new Map(),ps:new Map(),pl:new Map(),ph:new Map()};ch.layers.set(layer,L);}
    let e=L[cat].get(key);
    if(!e){e=make();L[cat].set(key,e);}
    return e;
  }
  const lodSlot=(ch,layer,cat,key,make)=>{const e=lodEntry(ch,layer,cat,key,make);return e.path??=new Path2D();};
  // Lands keep their placements and build the outline path, or below SMALL_PX on screen a
  // plain-rectangle path of the same area, on first use.
  function landPath(e,simple){
    const path=new Path2D(),q=e.prims;
    for(let n=0;n<q.length;n+=4){
      const {w,h,shape}=q[n+3];
      if(simple && shape!=="custom"){
        const k=shape==="circle" || shape==="obround" || shape==="ellipse" ? .886 : 1;
        addLand(path,q[n],q[n+1],q[n+2],{w:w*k,h:h*k,shape:"rect"});
      }
      else addLand(path,q[n],q[n+1],q[n+2],q[n+3]);
    }
    return path;
  }
  function lodEmitPad(ch,layer,cats,alpha,p,geom,X,Y,rot,holeColor){
    const big=Math.max(geom.w,geom.h),e=lodEntry(ch,layer,cats[0],alpha+"|"+repKey(p)+"|"+Math.ceil(Math.log2(big)*2),()=>({alpha,rep:rep(p),max:0,prims:[]}));
    e.max=Math.max(e.max,big);e.prims.push(X,Y,rot,geom);
    if(geom.drill>0){
      const hole=lodSlot(ch,layer,cats[1],alpha+"|"+holeColor+"|"+geom.drill,()=>({alpha,drill:geom.drill,color:holeColor}));
      hole.moveTo(X+geom.drill/2,Y);hole.arc(X,Y,geom.drill/2,0,Math.PI*2);
    }
  }
  function lodEmit(ch,i,info){
    if(info.kind==="t"){
      const layer=boardLayer(i),arc=A.pathArc(i);
      const stroke=(layer,w,alpha)=>{
        if(w===null)return;
        const path=lodSlot(ch,layer,"t",w+"|"+alpha+"|"+repKey(i),()=>({w,alpha,min:1,rep:rep(i)}));
        if(arc)appendArc(path,arc);else addPoly(path,i.points,!!i.closed,false);
      };
      stroke(layer,PCB.boardStrokeWidth(i),i.kind==="track"?"track":"");
      for(const opening of PCB.traceOpenings(i,layer))stroke(opening.layer,opening.width,"");
      return;
    }
    if(info.kind==="p"){
      lodEmitPad(ch,boardLayer(i),["li","hi"],i.kind==="via"?"via":"pad",i,info.geom,i.x,i.y,A.rad(i.angle || 0),i.kind==="via"?"hole":"padHole");
      return;
    }
    const {angle:ia,at,mirror}=PCB.footprintPlacement(i);
    for(const g of info.groups){
      for(const sh of g.shapes){
        const w=PCB.shapeStrokeWidth(sh),pts=sh.kind==="circle"?null:sh.points;
        if(sh.kind!=="circle" && !pts?.length)continue;
        const paths=[];
        if(w!==null)paths.push(lodSlot(ch,g.layer,"ps",String(w)+"|"+repKey(sh),()=>({w,min:.9,rep:rep(sh)})));
        let fillPath;
        if(sh.fill){
          const pkg=sh.style==="package";
          fillPath=lodSlot(ch,g.layer,"pf",pkg+"|"+repKey(sh),()=>({pkg,rep:rep(sh)}));
          paths.push(fillPath);
        }
        if(sh.kind==="circle"){
          const [x,y]=at([sh.x,sh.y]),r=Math.max(0,sh.r);
          for(const path of paths){path.moveTo(x+r,y);path.arc(x,y,r,0,Math.PI*2);}
          continue;
        }
        const arc=A.pathArc(sh);
        if(arc){
          const placed=A.transformArc(arc,at,i.angle||0,mirror);
          for(const path of paths)appendArc(path,placed);
        }else{
          const points=pts.map(at);
          for(const path of paths)addPoly(path,points,!!sh.closed,path===fillPath);
        }
      }
      for(const {p,geom} of g.pads){
        const [x,y]=at([p.x,p.y]);
        const land=mirror && geom.shape==="custom" && geom.poly ? {...geom,poly:geom.poly.map(([x,y])=>[-x,y])} : geom;
        const local=A.rad(p.angle||0);
        lodEmitPad(ch,g.layer,["pl","ph"],"pad",p,land,x,y,ia+(mirror?-local:local),p.kind==="via"?"hole":"padHole");
      }
    }
  }
  function lodRebuild(lod,ch){
    ch.layers=new Map();let box=null;
    for(const i of ch.items){const info=lod.info.get(i);box=box?union(box,info.box):info.box.slice();lodEmit(ch,i,info);}
    ch.box=box;ch.dirty=false;
    for(const l of ch.layers.keys())lod.layers.add(l);
  }
  const chunkKey=(lod,box)=>Math.floor((box[0]+box[2])/2/lod.size)+","+Math.floor((box[1]+box[3])/2/lod.size);
  function lodAdd(lod,i,defs,box,doc){
    if(!box)return;
    const info=lodClassify(i,defs,box,doc);
    if(!info)return;
    const key=chunkKey(lod,box);
    let ch=lod.chunks.get(key);
    if(!ch){ch={items:new Set(),layers:new Map(),box:null,dirty:true};lod.chunks.set(key,ch);}
    ch.items.add(i);ch.dirty=true;info.chunk=ch;lod.info.set(i,info);
  }
  // A replacement in the same chunk preserves first-encounter order for tied layer and ink passes.
  function lodReplace(lod,i,defs,box,doc){
    const prior=lod.info.get(i),info=box&&lodClassify(i,defs,box,doc);
    if(!prior&&!info)return true;
    if(!prior || !info || lod.chunks.get(chunkKey(lod,box))!==prior.chunk)return false;
    info.chunk=prior.chunk;info.chunk.dirty=true;lod.info.set(i,info);lod.refreshLayers=true;
    return true;
  }
  function lodRemove(lod,i){
    const info=lod.info.get(i);
    if(!info)return;
    info.chunk.items.delete(i);info.chunk.dirty=true;lod.info.delete(i);
  }
  // Draw one layer's batches of the given categories, chunk by chunk.
  function drawLOD(ctx,lod,layer,cats,scale,opts,fade,see){
    for(const cat of cats)for(const ch of lod.chunks){
      const L=ch.layers.get(layer);
      if(!L || !L[cat].size)continue;
      for(const e of L[cat].values()){
        if(!PCB.visible(layer,e.rep,opts))continue;
        fade(e.alpha?see[e.alpha]??1:1);
        if(cat==="t" || cat==="ps"){ctx.lineWidth=Math.max(e.min/scale,e.w);ctx.strokeStyle=PCB.ink(layer,e.rep,opts,false);ctx.stroke(e.path);}
        else if(cat==="hi" || cat==="ph"){if(e.drill*scale<HOLE_MIN)continue;ctx.fillStyle=PCB.system[e.color];ctx.fill(e.path);}
        else if(e.prims){ctx.fillStyle=e.alpha==="via"?PCB.viaInk(e.rep,opts,false):PCB.ink(layer,e.rep,opts,false);ctx.fill(e.max*scale<SMALL_PX?e.simple??=landPath(e,true):e.path??=landPath(e,false));}
        else{ctx.fillStyle=e.pkg?PCB.system.board:PCB.ink(layer,e.rep,opts,false);ctx.fill(e.path);}
      }
    }
    fade(1);
  }
  return {special:lodSpecial, groups:lodGroups, add:lodAdd, replace:lodReplace, remove:lodRemove, rebuild:lodRebuild, draw:drawLOD};
}};
