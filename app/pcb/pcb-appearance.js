"use strict";

if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("./resolved-geometry-curves.js");

// The 2D board view uses copper, overlay and drill colors by layer. These
// display preferences never alter the design geometry or the source document.
// Defaults follow Altium Designer's 2D color scheme; a user's overrides from
// View Configuration (Ctrl+L) are kept per browser in localStorage.
globalThis.AtriumPCBAppearance = (() => {
  const STORE="atrium.pcbView.v1";
  // Altium Designer default 2D layer colors.
  const defaultColors=Object.freeze({
    Top:"#ff0000", Bottom:"#0000ff", Silk:"#ffff00", "Bottom silk":"#808000",
    Multi:"#c0c0c0", "Top mask":"#800080", "Bottom mask":"#ff00ff",
    "Top paste":"#808080", "Bottom paste":"#800000", Keepout:"#ff00fe",
    Mechanical:"#ff00fd", "Drill guide":"#800001", "Drill drawing":"#ff002a"
  });
  // Altium's mid-layer and mechanical-layer default cycles.
  const inner=["#bc8e00","#70dbfa","#00cc66","#9b9bff","#00ffff","#800081","#ff8000","#008080","#a0a000","#c080ff","#00ff80","#ff80c0"];
  const mechanical=["#ff00fd","#800082","#008000","#808001","#ff00fc","#808002","#808081","#ff80ff","#ffc000","#40c0c0","#c08040","#8080ff","#c000c0","#80c000","#c0c0ff","#ff8080"];
  // System colors. Every value stays distinct from every layer default so
  // the selection, dim and hole inks can be told apart from layer artwork.
  const defaultSystem=Object.freeze({
    workspace:"#3b3b3b", workspaceGrid:"#444444", workspaceGridCoarse:"#4d4d4d",
    board:"#000000", boardGrid:"#1e1e1e", boardGridCoarse:"#363636", edge:"#a3a3a3",
    hole:"#2c2e33", padHole:"#1d6d8c", drillEdge:"#9c9c9c", dim:"#545454", selection:"#ffffff",
    connection:"#b4b4b4", origin:"#e8e8e8", padText:"#fffffe", marquee:"#4f9bff"
  });
  const defaultOpacity=Object.freeze({track:1,pad:1,via:1,pour:.55});
  const overrides={colors:{},system:{},opacity:{}};
  // System colours the UI theme supplies (AtriumTheme.canvasPalette("pcb")), e.g. a
  // black workspace for high contrast. They sit between the Altium defaults and the
  // user's own View Configuration overrides, and are never saved here.
  const themeBase={};
  // Layer colours a colour theme supplies (palette.layers): above the Altium defaults, below the user's own.
  const themeLayers={};
  const baseSystem=key=>themeBase[key]??defaultSystem[key];
  // `system` and `opacity` stay the same objects for the page's lifetime so
  // callers holding a reference always read the current values.
  const system={...defaultSystem}, opacity={...defaultOpacity};
  // Per-layer opacity (View Configuration layer rows), 0–1, multiplied by the object-kind
  // opacity above. Stored with the object opacities as "layer:<key>" so a settings export,
  // import and reset carry both. Layers at 1 are absent.
  const layerOpacity={};
  const LAYER="layer:",layerKey=k=>typeof k==="string"&&k.startsWith(LAYER)&&k.length>LAYER.length&&k.length<80;
  const names={Top:"Top Layer",Bottom:"Bottom Layer",Silk:"Top Overlay","Bottom silk":"Bottom Overlay",Multi:"Multi-Layer",
    "Top mask":"Top Solder","Bottom mask":"Bottom Solder","Top paste":"Top Paste","Bottom paste":"Bottom Paste",
    Keepout:"Keep-Out Layer",Mechanical:"Mechanical 1","Drill guide":"Drill Guide","Drill drawing":"Drill Drawing"};
  const copperIndices=new Map([["Top",0],["Bottom",127]]);
  for(let i=1;i<=126;i++)copperIndices.set("Inner "+i,i);
  const index=layer=>copperIndices.get(layer)??-1;
  const hex=/^#[0-9a-f]{6}$/;
  function defaultColor(layer){
    if(Object.hasOwn(themeLayers,layer))return themeLayers[layer];
    const cyc=/^Inner (\d+)$/.exec(layer||"");if(cyc&&+cyc[1]>12&&Object.hasOwn(themeLayers,"Inner "+((+cyc[1]-1)%12+1)))return themeLayers["Inner "+((+cyc[1]-1)%12+1)];
    if(Object.hasOwn(defaultColors,layer))return defaultColors[layer];
    const mid=index(layer);
    if(mid>0)return inner[(mid-1)%inner.length];
    const mech=/^Mechanical (\d+)$/.exec(layer||"");
    if(mech)return mechanical[(Math.max(1,+mech[1])-1)%mechanical.length];
    if(/^Mechanical/.test(layer))return defaultColors.Mechanical;
    return "#92a6a6";
  }
  function color(layer){
    const own=overrides.colors[layer];
    return own || defaultColor(layer);
  }
  function name(layer){
    if(names[layer])return names[layer];
    const mid=index(layer);
    if(mid>0)return "Mid-Layer "+mid;
    return layer;
  }
  // Persistence and change notification.
  const listeners=new Set();
  function save(){
    try{globalThis.localStorage?.setItem(STORE,JSON.stringify(overrides));}catch{}
  }
  function load(){
    let raw=null;
    try{raw=globalThis.localStorage?.getItem(STORE);}catch{}
    if(!raw)return;
    let data;try{data=JSON.parse(raw);}catch{return;}
    if(!data || typeof data!=="object")return;
    for(const [k,v] of Object.entries(data.colors||{}))if(typeof v==="string"&&hex.test(v))overrides.colors[k]=v;
    for(const [k,v] of Object.entries(data.system||{}))if(Object.hasOwn(defaultSystem,k)&&typeof v==="string"&&hex.test(v)){overrides.system[k]=v;system[k]=v;}
    themeSync(false);
    for(const [k,v] of Object.entries(data.opacity||{})){
      if(!Number.isFinite(v))continue;
      const o=Math.max(0,Math.min(1,v));
      if(Object.hasOwn(defaultOpacity,k)){overrides.opacity[k]=o;opacity[k]=o;}
      else if(layerKey(k)&&o<1){overrides.opacity[k]=o;layerOpacity[k.slice(LAYER.length)]=o;}
    }
  }
  function changed(kind){
    save();
    for(const fn of listeners){try{fn(kind);}catch{}}
    try{
      if(typeof globalThis.dispatchEvent==="function"&&typeof CustomEvent==="function")
        globalThis.dispatchEvent(new CustomEvent("atrium-pcb-appearance",{detail:{kind}}));
    }catch{}
  }
  function setColor(layer,value){
    value=String(value||"").toLowerCase();
    if(!hex.test(value))return false;
    if(value===defaultColor(layer))delete overrides.colors[layer];else overrides.colors[layer]=value;
    changed("color");return true;
  }
  function setSystem(key,value){
    value=String(value||"").toLowerCase();
    if(!Object.hasOwn(defaultSystem,key)||!hex.test(value))return false;
    system[key]=value;
    if(value===baseSystem(key))delete overrides.system[key];else overrides.system[key]=value;
    changed("system");return true;
  }
  function setOpacity(key,value){
    if(layerKey(key))return setLayerOpacity(key.slice(LAYER.length),value);
    if(!Object.hasOwn(defaultOpacity,key)||!Number.isFinite(+value))return false;
    const v=Math.max(0,Math.min(1,+value));opacity[key]=v;
    if(v===defaultOpacity[key])delete overrides.opacity[key];else overrides.opacity[key]=v;
    changed("opacity");return true;
  }
  function setLayerOpacity(layer,value){
    if(typeof layer!=="string"||!layer||layer.length>=80-LAYER.length||!Number.isFinite(+value))return false;
    const v=Math.max(0,Math.min(1,+value));
    if(v===1){delete layerOpacity[layer];delete overrides.opacity[LAYER+layer];}
    else{layerOpacity[layer]=v;overrides.opacity[LAYER+layer]=v;}
    changed("opacity");return true;
  }
  const layerAlpha=layer=>layerOpacity[layer]??1;
  function reset(){
    for(const k of Object.keys(overrides.colors))delete overrides.colors[k];
    for(const k of Object.keys(overrides.system))delete overrides.system[k];
    for(const k of Object.keys(overrides.opacity))delete overrides.opacity[k];
    for(const k of Object.keys(layerOpacity))delete layerOpacity[k];
    for(const k of Object.keys(defaultSystem))system[k]=baseSystem(k);Object.assign(opacity,defaultOpacity);
    changed("reset");
  }
  function onChange(fn){listeners.add(fn);return ()=>listeners.delete(fn);}
  // Replace the theme's system colours; unknown keys and non-hex values are ignored.
  // Notifies ("theme") only when an effective colour changed.
  function themeSync(notify){
    let moved=false;
    for(const k of Object.keys(defaultSystem)){
      const v=overrides.system[k]??baseSystem(k);
      if(system[k]!==v){system[k]=v;moved=true;}
    }
    if(moved&&notify)changed("theme");
    return moved;
  }
  function setThemeBase(palette){
    for(const k of Object.keys(themeBase))delete themeBase[k];
    const was=JSON.stringify(themeLayers);for(const k of Object.keys(themeLayers))delete themeLayers[k];
    for(const [k,v] of Object.entries(palette?.layers||{})){const c=String(v||"").toLowerCase();if(typeof k==="string"&&k.length<40&&hex.test(c))themeLayers[k]=c;}
    const layersMoved=was!==JSON.stringify(themeLayers);
    for(const [k,v] of Object.entries(palette||{})){
      const c=String(v||"").toLowerCase();
      if(Object.hasOwn(defaultSystem,k)&&hex.test(c))themeBase[k]=c;
    }
    const moved=themeSync(true);if(layersMoved&&!moved)changed("theme");return moved||layersMoved;
  }
  // Render with another theme's colours (theme thumbnails): no events, nothing saved, user overrides ignored.
  function withPalette(palette,fn){
    const sys={...system},base={...themeBase},lay={...themeLayers},ov=overrides.colors;
    try{
      const {layers,...colors}=palette||{};
      Object.assign(system,defaultSystem,colors);
      for(const k of Object.keys(themeLayers))delete themeLayers[k];
      Object.assign(themeLayers,layers||{});overrides.colors={};return fn();
    }
    finally{Object.assign(system,sys);Object.assign(themeBase,base);for(const k of Object.keys(themeLayers))delete themeLayers[k];Object.assign(themeLayers,lay);overrides.colors=ov;}
  }
  const themeLayerColors=()=>({...themeLayers});
  const isCustomSystem=key=>Object.hasOwn(overrides.system,key);
  const isCustom=layer=>Object.hasOwn(overrides.colors,layer);
  try{setThemeBase(globalThis.AtriumTheme?.canvasPalette?.("pcb"));}catch{}
  load();

  // A row selects geometry fields; the authored pad and its drill remain unchanged.
  const hasPadRows=p=>!!(p.padStack && p.stackMode && p.stackMode!=="simple");
  function padPlanes(p,layer,copper){
    return !hasPadRows(p)?[undefined]:layer==="Multi"?copper():[layer];
  }
  function padStackRow(p,layer,copperLayers){
    if(!hasPadRows(p))return null;
    const n=Array.isArray(copperLayers)?copperLayers.indexOf(layer):index(layer);
    const inner=n>0&&layer!=="Bottom";
    return p.padStack[layer] ?? (inner?p.padStack.Mid:null);
  }
  function effectivePad(p,layer,copperLayers){
    if(layer==null)return p;
    if(p.kind==="via"){
      const land=globalThis.AtriumViaStack?.padOn(p,layer);
      return land?{...p,...land,w:land.diameter,h:land.diameter}:p;
    }
    const row=padStackRow(p,layer,copperLayers);
    if(!row)return p;
    return {...p,w:row.w??p.w??p.diameter,h:row.h??p.h??p.diameter,
      shape:row.shape??p.shape,roundrectRadiusRatio:row.roundrectRadiusRatio??p.roundrectRadiusRatio,
      x:row.x??p.x,y:row.y??p.y,angle:row.angle??p.angle,poly:row.poly??p.poly};
  }
  function displayPad(p,active,declared){
    if(p.kind!=="via"&&index(declared)>=0)active=declared;
    if(p.kind==="via"){
      const source=globalThis.AtriumViaStack?.display(p,active);
      return source&&source!==p?{...source,w:source.diameter,h:source.diameter}:p;
    }
    const land=effectivePad(p,active);
    if(!land.holeOnly&&(land.w??land.diameter)>0&&(land.h??land.diameter)>0)return land;
    if(!(p.drill>0))return land;
    return {...p,w:p.drill,h:p.drill,shape:"round",holeOnly:true};
  }
  const padLayer=(item,p)=>p.layer || (p.kind==="via"||p.drill>0?"Multi":item?.layer||"Top");
  const boardLayer=i=>i.layer || (i.kind==="via" || i.kind==="pad"?padLayer(null,i):i.kind==="label"?"Silk":"Top");
  const overlay=item=>item.layer==="Bottom"?"Bottom silk":"Silk";
  const shapeLayer=(item,s)=>s.layer || (s.style==="package"?"Mechanical":s.style==="silk"?overlay(item):item.layer||"Top");
  function copperInterval(from,to,lookup=index){
    const a=lookup(from),b=lookup(to);
    return [Math.min(a,b),Math.max(a,b)];
  }
  function copperSpan(item, lookup=index, last=127){
    if(item?.fromLayer==null && item?.toLayer==null)return [0,last];
    const span=copperInterval(item.fromLayer,item.toLayer,lookup);
    return span[0]>=0 && span[0]!==span[1] ? span : null;
  }
  function onLayer(layer,active,item){
    if(layer===active)return true;
    const c=index(active);
    if(layer!=="Multi" || c<0)return false;
    const span=copperSpan(item);
    return span!==null && span[0]<=c && c<=span[1];
  }
  function throughSpan(p){
    const span=copperSpan(p);
    return span?.[0]===0 && span[1]===127;
  }
  const partialSpan=p=>index(p.fromLayer)>=0 && index(p.toLayer)>=0 && !throughSpan(p);
  function visible(layer,item,opts){
    if (opts.visibleLayers && (!opts.visibleLayers.includes(layer) || layer==="Multi" && item && !onLayer(layer,opts.layer,item))) return false;
    return !opts.hidden?.has(layer) && (opts.layerMode!=="single" || onLayer(layer,opts.layer||"Top",item));
  }
  // Altium's "monochrome other layers" single-layer look for dim mode.
  function ink(layer,item,opts,selected){
    if(selected)return system.selection;
    if(opts.layerMode==="dim" && !onLayer(layer,opts.layer||"Top",item))return system.dim;
    return color(layer);
  }
  // A via's copper reads as copper: the current copper layer's colour where the via reaches it, else
  // its own first copper layer (a blind or buried via elsewhere in the stack); dimmed off the current
  // layer in the dimmed mode. With a non-copper layer current, the Multi-Layer colour, as before.
  // canvas.js drawPad, canvas-board-batches.js and canvas-gpu.js all take it from here.
  function viaInk(via,opts,selected){
    if(selected)return system.selection;
    const active=opts.layer||"Top";
    if(opts.layerMode==="dim" && !onLayer("Multi",active,via))return system.dim;
    if(index(active)<0)return color("Multi");
    if(onLayer("Multi",active,via))return color(active);
    return color(index(via?.fromLayer)>=0?via.fromLayer:"Top");
  }
  // Paint order, bottom to top. The current copper layer sits above the other
  // copper; with other layers dimmed or hidden it is drawn above everything,
  // as in Altium's single-layer modes.
  function order(layer,active,mode){
    const n=index(layer);
    if(layer===active && (n<0 || mode==="dim" || mode==="single"))return 200;
    if(n>=0)return layer===active?70:40-n/4;
    if(layer==="Multi")return 100;
    if(layer==="Silk"||layer==="Bottom silk")return layer==="Silk"?82:81;
    if(/mask|paste/i.test(layer))return 75;
    return 1;
  }
  const oppositeLayers={Top:"Bottom",Bottom:"Top",Silk:"Bottom silk","Bottom silk":"Silk","Top mask":"Bottom mask","Bottom mask":"Top mask","Top paste":"Bottom paste","Bottom paste":"Top paste"};
  const oppositeLayer=l=>oppositeLayers[l] || (/^Inner \d+$/.test(l)?"Inner "+(127-+l.slice(6)):l);
  function layerRank(layer,opts,flipped=opts.flipped){
    const active=opts.layer||"Top";
    return order(flipped?oppositeLayer(layer):layer,flipped?oppositeLayer(active):active,opts.layerMode);
  }
  // The board stores expansion on the copper path. The editor and plotter both
  // derive openings from its current geometry, including after a routing edit.
  function traceOpenings(shape,layer){
    if(!Number.isFinite(shape.maskExpansion) && !Number.isFinite(shape.pasteExpansion))return empty;
    if((layer!=="Top" && layer!=="Bottom") || !shape.points?.length || shape.fill || shape.keepout || !(shape.width>0))return empty;
    const openings=[];
    for(const [field,film] of [["maskExpansion"," mask"],["pasteExpansion"," paste"]]){
      if(!Number.isFinite(shape[field]))continue;
      const width=shape.width+2*shape[field];
      if(width>0)openings.push({...shape,kind:shape.kind==="path"?"path":"graphic",layer:layer+film,width,net:""});
    }
    return openings;
  }
  function curvedRegion(shape){
    if(!shape.regionShape)return null;
    const region=globalThis.AtriumBoardShape?.regionOf?.(shape);
    return region && [region.contour,...region.cutouts].some(c=>c.some(g=>g.kind==="arc")) ? region : null;
  }
  // Closed regions without a pen use a hairline unless filled. Overlay and
  // package artwork retain their default pen, with explicit zero-width fills/curves unstroked.
  function shapeStrokeWidth(shape,exact){
    if(shape.width)return shape.width;
    if(shape.cutout)return 0;
    const region=(shape.closed||shape.fill)&&shape.style!=="package"&&shape.style!=="silk"&&!/silk|overlay/i.test(shape.layer||"");
    if(region)return shape.fill?null:0;
    if(shape.width===0&&(shape.fill||(exact??curvedRegion(shape))))return null;
    return .11;
  }
  function boardStrokeWidth(item){
    if(item.kind==="track")return item.width>0?item.width:null;
    if(item.fill&&!item.width)return null;
    if(item.kind==="polygon"||item.closed&&!item.width)return 0;
    return item.width||item.schPaint?.width||.18;
  }
  const padShapes=new Map(Object.entries({
    round:"round",circle:"round",circular:"round",oval:"round",oblong:"round",obround:"round",ellipse:"ellipse",
    rect:"rect",rectangle:"rect",square:"rect",roundrect:"roundrect",roundedrect:"roundrect",rounded:"roundrect",roundedrectangle:"roundrect",
    octagon:"octagon",octagonal:"octagon",custom:"custom"
  }));
  function padShape(raw,w,h,strict=false){
    const kind=padShapes.get(String(raw||"round").toLowerCase());
    return kind==="round"?(w===h?"circle":"obround"):kind==="ellipse"&&w===h?"circle":kind??(strict?null:"rect");
  }
  function padProfile(shape,w,h,angle,p){
    const min=Math.min(w,h);
    const poly=shape==="custom"&&p?.poly?.length>2&&p.poly.every(q=>Number.isFinite(q?.[0])&&Number.isFinite(q?.[1]))?p.poly:undefined;
    if(shape==="custom"&&!poly)shape="rect";
    return {shape,w,h,angle:angle||0,min,
      r:shape==="roundrect"?min*Atrium.padCornerRatio(p):shape==="circle"||shape==="obround"?min/2:0,
      t:shape==="octagon"?min*.25:0,...(poly?{poly}:null)};
  }
  // A display cue can keep the drill while the physical row suppresses copper.
  // Cache the resolved scalar values so in-place edits and active-layer changes are visible.
  const padGeometries=new WeakMap();
  function geometry(p,source){
    const w=source.w??source.diameter,h=source.h??source.diameter;
    if(!(w>0&&h>0))return null;
    const {x,y,shape:raw,roundrectRadiusRatio:ratio,drill,poly}=source,angle=source.angle||0;
    const holeOnly=source.holeOnly===true||drill>=Math.min(w,h)-.00001;
    const prior=padGeometries.get(p);
    if(prior?.w===w&&prior.h===h&&prior.raw===raw&&prior.ratio===ratio&&prior.drill===drill&&prior.poly===poly&&
        prior.x===x&&prior.y===y&&prior.angle===angle&&prior.holeOnly===holeOnly)return prior;
    const result={...padProfile(padShape(raw,w,h),w,h,angle,source),x,y,raw,ratio,drill,holeOnly};
    padGeometries.set(p,result);
    return result;
  }
  function landGeometry(p,layer,copperLayers){
    const source=effectivePad(p,layer,copperLayers);
    return source.holeOnly?null:geometry(p,source);
  }
  const padGeometry=(p,layer,declared=p.layer)=>geometry(p,layer==null?p:displayPad(p,layer,declared));
  function padPolygon({shape,w,h,t,poly}){
    if(shape==="custom"&&poly)return poly;
    const x=w/2,y=h/2;
    return shape==="octagon"?[[-x+t,-y],[x-t,-y],[x,-y+t],[x,y-t],[x-t,y],[-x+t,y],[-x,y-t],[-x,-y+t]]:
      [[-x,-y],[x,-y],[x,y],[-x,y]];
  }
  function padPlacement(g,parent){
    return {at:padCenter(g,parent),angle:padTurn(g,parent),mirror:parent?.mirror===true};
  }
  const localToBoard=({at,angle,mirror})=>q=>Atrium.world(q,{x:at[0],y:at[1],angle,mirror});
  const ellipse=g=>({kind:"ellipseArc",center:[0,0],cosineAxis:[g.w/2,0],sineAxis:[0,-g.h/2],start:90,sweep:-360});
  const localOutline=g=>g.shape==="ellipse"?AtriumGeometryCurves.flatten([ellipse(g)],.002).slice(0,-1):padPolygon(g);
  function landCore(g,at,angle=g.angle,mirror=false){
    const map=localToBoard({at,angle,mirror});
    if(g.shape==="ellipse"||g.shape==="custom")return {core:localOutline(g).map(map),r:0};
    const a=g.w/2-g.r,b=g.h/2-g.r,r=g.r;
    if(a<=1e-9||b<=1e-9)return {core:a<=1e-9&&b<=1e-9?[at]:[map([-a,-b]),map([a,b])],r};
    return {core:padPolygon({...g,w:2*a,h:2*b}).map(map),r};
  }
  function ellipseDistance(x,y,a,b){
    if(x===0||y===0)return Math.max(0,Math.abs(x)-a,Math.abs(y)-b);
    if(Math.hypot(x/a,y/b)<=1)return 0;
    // The nearest boundary point solves the ellipse constraint at a single
    // nonnegative multiplier, which decreases both normalized coordinates.
    const aa=a*a,bb=b*b,ax=a*x,by=b*y;
    let lo=0,hi=Math.hypot(ax,by);
    for(;;){
      const t=lo+(hi-lo)/2;
      // Finish when the bracket cannot shrink in floating point. Use the
      // residual directly to avoid subtracting nearly equal coordinates.
      if(!(lo<t&&t<hi))return Math.hypot(x*(t/(t+aa)),y*(t/(t+bb)));
      const u=ax/(t+aa),v=by/(t+bb);
      if(u*u+v*v>1)lo=t;
      else hi=t;
    }
  }
  function landDistance(g,point,at,angle=g.angle,mirror=false){
    const q=Atrium.rotate([point[0]-at[0],point[1]-at[1]],-angle),[x,y]=q, r=g.r;
    if(g.shape==="ellipse")return ellipseDistance(x,y,g.w/2,g.h/2);
    if(g.shape!=="custom"&&g.shape!=="octagon")
      return Math.max(0,Math.hypot(Math.max(0,Math.abs(x)-g.w/2+r),Math.max(0,Math.abs(y)-g.h/2+r))-r);
    if(mirror)q[0]=-x;
    const poly=padPolygon(g);
    let distance=Infinity,inside=false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      const a=poly[j],b=poly[i];
      if((a[1]>y)!==(b[1]>y)&&q[0]<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
      distance=Math.min(distance,Atrium.nearSegment(q,a,b));
    }
    return inside?0:distance;
  }
  const landRadius=g=>g.poly?g.poly.reduce((r,[x,y])=>Math.max(r,Math.hypot(x,y)),0):Math.hypot(g.w,g.h)/2;
  function filmLand(p,layer,copperLayers){
    const land=landGeometry(p,layer,copperLayers);
    return land&&(!(p.drill>0)||p.drill<land.min-1e-6||p.plotLand===true)?land:null;
  }
  globalThis.AtriumResolvedLand=Object.freeze({row:padStackRow,effective:effectivePad,geometry:landGeometry,film:filmLand,
    shape:padShape,profile:padProfile,place:padPlacement,ellipse,core:landCore,distance:landDistance,radius:landRadius});
  const padCenter=(p,parent)=>parent?Atrium.world([p.x,p.y],parent):[p.x,p.y];
  const footprintPlacement=part=>Atrium.placement(part,true);
  const padTurn=(p,parent)=>(parent?.angle||0)+(parent?.mirror===true?-1:1)*(p.angle||0);
  const padDrillCore=(p,parent,at=padCenter(p,parent))=>Atrium.drillCore(p,at,padTurn(p,parent),parent?.mirror===true);
  const padNet=(p,parent)=>parent?.pinNets?.[p.number]??p.net;
  function padPlated(p,parent,layer=padLayer(parent,p)){
    const hole=p.drill>0 && p.drill>=Math.min(p.w||0,p.h||0)-1e-6;
    return !(p.plated===false || layer==="Mechanical" || hole && p.plated!==true && !p.number && !padNet(p,parent));
  }
  const padCaptionMinPx=15;
  function padCaption(p,parent,g,scale,opts){
    if(!g || g.holeOnly || g.min*scale<=padCaptionMinPx)return false;
    if(parent && String(p.number??""))return true;
    return opts.netNames!==false && !!padNet(p,parent) && (!(g.drill>0) || !parent && p.kind==="via");
  }
  const legacyMirror=/^(p2:)?[0-9a-f]{8}(?:\/i(\d+))?$/;
  const mirrorReads=new WeakMap();
  const padArtwork=p=>p.poly||p.padStack;
  function retainedMirrorSource(def){
    const legacy=def?.mirrorOf&&legacyMirror.exec(def.mirrorSig||"");
    return legacy&&def.footprint?.pads?.some(p=>Atrium.pcbMirror.rotatedSlot(p)||!legacy[1]&&padArtwork(p))?def.mirrorOf:null;
  }
  function sameGeometry(a,b,depth=0){
    if(a===b)return true;
    if(!a || !b || typeof a!=="object" || typeof b!=="object" || Array.isArray(a)!==Array.isArray(b) || depth>64)return false;
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length && keys.every(k=>Object.hasOwn(b,k) && sameGeometry(a[k],b[k],depth+1));
  }
  function definitionArtwork(def){
    const {id,mirrorOf,mirrorSig,...value}=Atrium.definitionGeometry(def);
    return value;
  }
  // A native reopen can change field order and terminal row IDs. Prove the
  // retained definition is exactly the old derivation before projecting a
  // correction. Source edits and local overrides remain authoritative.
  function readDefinition(defs,id,doc){
    const def=defs?.get(id);
    if(!def?.mirrorOf)return def;
    const legacy=legacyMirror.exec(def.mirrorSig||"");
    if(!legacy)return def;
    const source=defs.get(def.mirrorOf);
    if(!source?.footprint || source.stub || source.mirrorOf || !def.footprint)return def;
    const innerBefore=+legacy[2]||0;
    const inner=Array.isArray(doc?.stackup?.layers) ? doc.stackup.layers.filter(l=>/^Inner \d+$/.test(l?.key)).length : innerBefore;
    const committed=doc && globalThis.AtriumUndoStore?.documentVersions?.(doc);
    const prior=committed && mirrorReads.get(def);
    if(prior?.source===source && prior.inner===inner && prior.version===committed.library)return prior.value;
    const pads=def.footprint.pads||[], mirror=Atrium.pcbMirror;
    const fixArtwork=!legacy[1] && pads.some(padArtwork) &&
      (inner || !pads.some(p=>Object.keys(p.padStack||{}).some(k=>/^Inner \d+$/.test(k))));
    let value=def;
    if(fixArtwork || pads.some(mirror.rotatedSlot)){
      const authored=definitionArtwork(source);
      const footprint=mirror.footprint(authored.footprint,innerBefore,true);
      if(legacy[1])footprint.pads=footprint.pads.map(p=>mirror.padArtwork(p,innerBefore));
      if(sameGeometry({...authored,footprint},definitionArtwork(def))){
        const corrected=pads.map(p=>{
          const q=fixArtwork?mirror.padArtwork(p,inner):p;
          return mirror.rotatedSlot(q)?{...q,slotAngle:-q.slotAngle}:q;
        });
        if(!sameGeometry(pads,corrected))value={...def,footprint:{...def.footprint,pads:corrected}};
      }
    }
    if(committed)mirrorReads.set(def,{source,inner,version:committed.library,value});
    return value;
  }
  let geometryLayers=new WeakMap(),geometryVersion;
  function footprintLayers(item,g){
    if(!g)return [];
    const store=globalThis.AtriumUndoStore,version=store?.libraryVersion?.();
    if(version!==geometryVersion){geometryVersion=version;geometryLayers=new WeakMap();}
    let sides=store?.unrecorded?.()?new Map():geometryLayers.get(g);
    if(!sides){sides=new Map();geometryLayers.set(g,sides);}
    const side=item.layer||"Top";
    if(sides.has(side))return sides.get(side);
    const layers=new Map();
    function group(layer){
      let found=layers.get(layer);
      if(!found){found={layer,shapes:[],pads:[]};layers.set(layer,found);}
      return found;
    }
    for(const shape of g.shapes||[]){
      const layer=shapeLayer(item,shape);
      group(layer).shapes.push(shape);
      for(const opening of traceOpenings(shape,layer))group(opening.layer).shapes.push(opening);
    }
    for(const pad of g.pads||[])group(padLayer(item,pad)).pads.push(pad);
    const result=[...layers.values()];sides.set(side,result);return result;
  }
  const empty=Object.freeze([]),checkedLabels=new WeakSet();
  function sourceLabelRows(doc,item){
    const table=doc.pcbDrawing?.annotations;
    const local=Array.isArray(item.boardLabels);
    if(!local && (!table || !item.sourceRecord || !/^components(?:6)?\/data#\d+$/.test(item.sourceRecord)))return null;
    const rows=(local?item.boardLabels:table[item.sourceRecord])||empty;
    if(!Array.isArray(rows))return empty;
    if(!checkedLabels.has(rows)){
      if(!rows.every(a=>a && (a.field==="ref" || a.field==="value") && Array.isArray(a.at) && a.at.length===2 &&
          a.at.every(Number.isFinite) && Number.isFinite(a.angle) && Number.isFinite(a.size) && a.size>0 && typeof a.layer==="string"))return empty;
      checkedLabels.add(rows);
    }
    return rows;
  }
  function sourceLabels(doc,item){
    const rows=sourceLabelRows(doc,item);
    if(!rows)return null;
    if(Array.isArray(item.hiddenBoardLabels) && (item.showRef===true || item.showValue===true)){
      const enabled=item.hiddenBoardLabels.filter(a=>a.field==="ref"?item.showRef===true:item.showValue===true);
      if(enabled.length)return [...rows,...enabled];
    }
    return rows;
  }
  const textAnchors=Object.freeze(["top-left","top-center","top-right","middle-left","center","middle-right","bottom-left","bottom-center","bottom-right"]);
  const textJustification=item=>textAnchors.includes(item.justify)?item.justify:
    item.align==="center"?"bottom-center":item.align==="right"?"bottom-right":"bottom-left";
  const textMirrored=(item,layer)=>typeof item.mirrored==="boolean"?item.mirrored:/^Bottom/.test(layer ?? item.layer ?? "");
  function textPose(item,angle,layer){
    const anchor=textJustification(item);
    // Invert the effective anchor together with the half-turn so the ink stays on its side.
    const turn=item.upright && ((angle+90)%360+360)%360>=180;
    return {angle:turn?angle+180:angle,justify:turn?textAnchors[textAnchors.length-1-textAnchors.indexOf(anchor)]:anchor,mirrored:textMirrored(item,layer)};
  }
  function placeText(item,frame,layer){
    const at=[item.x||0,item.y||0], [x,y]=frame?Atrium.world(at,frame):at;
    // The footprint frame places the anchor. Glyph reflection belongs to the text row.
    const pose=textPose(item,(frame?.angle||0)+(item.angle||0),layer);
    // Resolved fields and native lettering can inherit their authored text properties.
    return {__proto__:Object.getPrototypeOf(item),...item,...pose,x,y,upright:false};
  }
  const annotationItem=(part,a)=>({...a,kind:"text",text:String(part[a.field]||""),x:a.at[0],y:a.at[1]});
  // Source-format writers can ask for the same pose in footprint coordinates.
  function annotationText(part,a,local=true) {
    const source=annotationItem(part,a), placed=placeText(source,part,a.layer);
    if(!local)return placed;
    const authored=(part.angle||0)+a.angle;
    return {...placed,x:source.x,y:source.y,angle:placed.angle===authored?a.angle:a.angle+180};
  }
  const annotationVisible=(part,a)=>!!part[a.field] && (a.field==="ref"?part.showRef!==false && !part.designator:part.showValue!==false);
  let localBoxes=new WeakMap(), boundsVersion;
  function localBounds(g){
    const store=globalThis.AtriumUndoStore, version=store?.libraryVersion?.();
    if(version!==boundsVersion){boundsVersion=version;localBoxes=new WeakMap();}
    const cache=g && !store?.unrecorded?.();
    const cached=cache && localBoxes.get(g);
    if(cached)return cached;
    const bounds=Atrium.bounds(Atrium.symbolPoints(g))||[-.5,-.5,.5,.5];
    if(cache)localBoxes.set(g,bounds);
    return bounds;
  }
  function placedBounds(part,[l,t,r,b]){
    const {at}=Atrium.placement(part);
    return Atrium.bounds([at([l,t]),at([r,t]),at([r,b]),at([l,b])]);
  }
  function partBounds(part,geometry){
    return placedBounds(part,localBounds(geometry));
  }
  // The order probe, band planner and painter all read the same implicit
  // reference position as the camera moves. Its bounds and pose come from
  // the board and library, so a new camera needs no new transform.
  const referencePositions=new WeakMap();
  function referenceAnchor(part,geometry){
    const box=localBounds(geometry), {x,y}=part, angle=part.angle||0, mirror=!!part.mirror;
    const prior=referencePositions.get(part);
    if(prior?.box===box && Object.is(prior.x,x) && Object.is(prior.y,y) && prior.angle===angle && prior.mirror===mirror)
      return prior.anchor;
    const [l,t,r]=placedBounds(part,box), anchor=[(l+r)/2,t-.39];
    referencePositions.set(part,{box,x,y,angle,mirror,anchor});
    return anchor;
  }
  function* partText(doc,part,def,authoredPart=part){
    const native=sourceLabels(doc,authoredPart);
    if(part.designator){
      const D=globalThis.AtriumDesignators, placed=D?.label(part,def);
      if(placed)yield {kind:"designator",field:"ref",member:["reference"],authoredDegrees:part.designator.angle||0,
        text:D.textShape(placed),box:placed.box,center:placed.center};
    }else if(!native && part.showRef!==false && part.ref){
      const layer=overlay(part);
      const [x,y]=part.refAt?Atrium.world(part.refAt,part):referenceAnchor(part,def?.footprint);
      const text={kind:"text",text:part.ref,x,y,size:.68,angle:0,layer,justify:part.refAt?"bottom-left":"bottom-center",
        mirrored:textMirrored({},layer)};
      yield {kind:"reference",field:"ref",member:["reference"],authoredDegrees:0,text};
    }
    if(native)for(const [i,a] of native.entries()){
      if(!annotationVisible(part,a))continue;
      const text=annotationText(part,a,false), hidden=authoredPart.hiddenBoardLabels?.indexOf(a)??-1;
      const member=hidden<0?["label",String(i)]:["hiddenBoardLabels",String(hidden)];
      yield {kind:"annotation",field:a.field,member,authoredDegrees:a.angle,text,row:a,index:i};
    }
  }
  // Altium's View Configuration groups. Layers not listed fall into "Other".
  function group(layer){
    if(index(layer)>=0)return "Signal Layers";
    if(/^Mechanical/.test(layer))return "Mechanical Layers";
    return "Other Layers";
  }
  const systemNames=Object.freeze({
    connection:"Connection Lines", selection:"Selection/Highlight", boardGrid:"Default Grid Color - Small",
    boardGridCoarse:"Default Grid Color - Large", padHole:"Pad Holes", hole:"Via Holes",
    edge:"Board Line", board:"Board Area", workspace:"Workspace", workspaceGrid:"Workspace Grid - Small",
    workspaceGridCoarse:"Workspace Grid - Large", dim:"Dimmed Layers", origin:"Origin Marker",
    drillEdge:"Non-plated Hole Edge", padText:"Pad Numbers and Nets", marquee:"Selection Box"
  });
  return Object.freeze({sourceLabelRows,sourceLabels,annotationText,annotationVisible,partText,partBounds,localBounds,placeText,textAnchors,textJustification,textMirrored,color,name,system,index,order,layerRank,displayPad,padGeometry,padPolygon,padCenter,footprintPlacement,padTurn,padDrillCore,padNet,padPlated,padCaption,padCaptionMinPx,readDefinition,retainedMirrorSource,copperInterval,copperSpan,throughSpan,partialSpan,padLayer,hasPadRows,padPlanes,boardLayer,shapeLayer,overlay,traceOpenings,curvedRegion,shapeStrokeWidth,boardStrokeWidth,onLayer,visible,ink,viaInk,footprintLayers,
    defaultColor,defaultSystem,defaultOpacity,opacity,layerOpacity,layerAlpha,setLayerOpacity,setColor,setSystem,setOpacity,reset,onChange,isCustom,
    setThemeBase,withPalette,themeLayerColors,baseSystem,isCustomSystem,themeBase:()=>({...themeBase}),group,systemNames,storageKey:STORE});
})();
