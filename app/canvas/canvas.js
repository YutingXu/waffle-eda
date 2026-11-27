"use strict";
if (!globalThis.AtriumBoardShape && typeof require === "function") require("../pcb/board-shape-core.js");

globalThis.AtriumCanvas = (() => {
  const A = Atrium, PCB = AtriumPCBAppearance, SCH=globalThis.AtriumSchAppearance;
  let T = globalThis.AtriumPCBText;
  const color = {
    field: "#f8f9f7", grid: "#c5ccc6", board: "#22463f", edge: "#47695c",
    silk: "#f2edd7", top: "#ed9b84", bottom: "#7fadd0", inner: "#b598c8",
    pad: "#e1bf80", padEdge: "#f3d8a1", package: "#253230", packageEdge: "#78827a",
    ink: "#25353b", wire: "#406f60", note: "#64716b", select: "#087d82", lightSelect: "#a0efe2"
  };
  const labelFont = 'system-ui, -apple-system, BlinkMacSystemFont, "DejaVu Sans", sans-serif';
  const monoFont = 'ui-monospace, "SFMono-Regular", Menlo, "DejaVu Sans Mono", monospace';
  const bounded = (x, low, high) => Math.max(low, Math.min(high, x));
  const getDef = (defs, item, doc) => doc?.kind==="pcb" ? PCB.readDefinition(defs,item.def,doc) : defs.get(item.def);
  const layerOf = PCB.padLayer;
  const visible = (item, hidden) => item.kind === "part" || !hidden?.has(item.layer || "");
  const silkLayer = PCB.overlay, shapeLayer=PCB.shapeLayer, copperIndex=PCB.index;
  const chosen=(item,opts)=>item.id===opts.selected || opts.selectedIds?.has(item.id);
  const {boardLayer,layerRank}=PCB;
  function projectedPanel(doc,defs){
    const flat=AtriumPanel.view(doc,defs)||doc;
    return [flat,AtriumPanel.definitionsFor(flat,defs)];
  }
  const boardVisible=(i,opts)=>i.kind==="part" || PCB.visible(boardLayer(i),i,opts);
  const mayHaveViaMark=i=>i.kind==="via" && (i.backdrill || i.ipc4761 && i.ipc4761!=="none");
  function routingLayers(doc,defs) {
    const names=new Set(["Top","Bottom"]),footprints=new Set();
    // A stored layer stack lists every copper layer, used or not.
    for(const key of globalThis.AtriumStackup?.stored(doc)?.layers.map(l=>l.key).filter(Boolean)||[])names.add(key);
    function collect(item) {
      for(const name of [item.layer,item.fromLayer,item.toLayer])if(copperIndex(name)>=0)names.add(name);
    }
    for(const item of doc.items){
      collect(item);
      if(item.kind==="part"&&!footprints.has(item.def)){
        footprints.add(item.def);
        const fp=getDef(defs,item,doc)?.footprint;
        fp?.pads?.forEach(collect);
        fp?.shapes?.forEach(collect);
      }
    }
    return [...names].sort((a,b)=>copperIndex(a)-copperIndex(b));
  }
  function canContact(item,parent,opts) {
    const declared=layerOf(parent,item);
    if(item.hidden || !PCB.visible(declared,item,opts))return false;
    if(!opts.routing)return true;
    const active=copperIndex(opts.layer);
    if(active<0 || opts.hidden?.has(opts.layer))return false;
    if(item.kind==="via"){
      if(!item.fromLayer&&!item.toLayer)return true;
      const [from,to]=PCB.copperInterval(item.fromLayer,item.toLayer);
      return from>=0 && active>=from && active<=to;
    }
    if(item.drill>0 && (item.plated===false || item.drill>=Math.min(item.w,item.h)))return false;
    return declared===opts.layer || (declared==="Multi" && item.drill>0);
  }
  function filteredFootprint(item,g,opts){
    if(!g || (!opts.hidden?.size && opts.layerMode!=="single"))return g;
    return {shapes:g.shapes.filter(s=>PCB.visible(shapeLayer(item,s),s,opts)),pads:g.pads.filter(p=>PCB.visible(layerOf(item,p),p,opts))};
  }
  const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const localBox=PCB.localBounds, partBox=PCB.partBounds;
  function boxCorners(b) { return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]; }
  function drawPath(ctx, points, closed = false) {
    if (!points?.length) return false;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let n = 1; n < points.length; n++) ctx.lineTo(points[n][0], points[n][1]);
    if (closed) ctx.closePath();
    return true;
  }
  // Board perimeter plus its cutouts (AtriumBoardShape) as one path. Fill and
  // clip it with the even-odd rule so cutouts read as non-board.
  // Returns the fill rule to use.
  function boardPath(ctx, contours, exact) {
    if (exact) {
      ctx.beginPath();
      for (const contour of contours) exact.traceContour(ctx, contour, true);
      return contours.length > 1 ? "evenodd" : "nonzero";
    }
    drawPath(ctx, contours[0], true);
    let rule = "nonzero";
    for (let i = 1; i < contours.length; i++) {
      const h = contours[i];
      if (h.length < 3) continue;
      ctx.moveTo(h[0][0], h[0][1]);
      for (let n = 1; n < h.length; n++) ctx.lineTo(h[n][0], h[n][1]);
      ctx.closePath();
      rule = "evenodd";
    }
    return rule;
  }
  function appendArc(ctx, g) {
    const start = A.arcPoint(g, g.start);
    ctx.moveTo(start[0], start[1]);
    ctx.arc(g.c[0], g.c[1], g.r, -A.rad(g.start), -A.rad(g.start + A.arcSweep(g)), g.ccw);
  }
  function drawItemPath(ctx, item) {
    const arc = A.pathArc(item);
    if (!arc) return drawPath(ctx, item.points, item.closed);
    ctx.beginPath();
    appendArc(ctx, arc);
    return true;
  }
  function circle(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  }
  function textAt(ctx, text, x, y, size, ink, align = "left", weight = 500, mono = false) {
    ctx.font = weight + " " + size + "px " + (mono ? monoFont : labelFont);
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = ink;
    ctx.fillText(text, x, y);
  }
  const copper=PCB.color;
  function drawPad(ctx, p, scale, selected, boardView, parent = null, opts={}) {
    const layer=layerOf(parent,p), geometry=PCB.padGeometry(p,boardView?opts.layer||"Top":null,layer);
    if(!geometry)return;
    const {w,h,r:radius,shape,holeOnly:isHole,drill}=geometry;
    ctx.save();
    ctx.translate(geometry.x, geometry.y);
    ctx.rotate(A.rad(geometry.angle));
    const via=boardView&&!parent&&p.kind==="via",land=via?PCB.viaInk(p,opts,selected):PCB.ink(layer,p,opts,selected);
    ctx.fillStyle=land;
    ctx.beginPath();
    if (shape==="circle" || shape==="ellipse") ctx.ellipse(0,0,w/2,h/2,0,0,Math.PI*2);
    else if (shape==="obround" || shape==="roundrect") {
      if(ctx.roundRect)ctx.roundRect(-w/2,-h/2,w,h,radius);
      else {
        const x=w/2,y=h/2;
        ctx.moveTo(-x+radius,-y);
        ctx.arcTo(x,-y,x,y,radius);ctx.arcTo(x,y,-x,y,radius);
        ctx.arcTo(-x,y,-x,-y,radius);ctx.arcTo(-x,-y,x,-y,radius);ctx.closePath();
      }
    }
    else if(shape==="octagon" || shape==="custom" && geometry.poly?.length>2)drawPath(ctx,PCB.padPolygon(geometry),true);
    else ctx.rect(-w/2,-h/2,w,h);
    if (!isHole) ctx.fill();
    // A via is its copper ring and one dark drill. A blind or buried via, once it is 8 px across, splits
    // its ring into the two copper colours of its span (the first layer's on top), its one extra cue;
    // tenting, fill and back-drill stay in the inspector (viastack.js paintMarks draws fill and back-drill at zoom).
    if (via && !isHole && PCB.partialSpan(p) && geometry.min*scale>=8 && !selected && land!==PCB.system.dim) {
      ctx.fillStyle=copper(p.fromLayer);ctx.fill();
      ctx.beginPath();ctx.ellipse(0,0,w/2,h/2,0,0,Math.PI);ctx.closePath();ctx.fillStyle=copper(p.toLayer);ctx.fill();
    }
    if (drill > 0) {
      const [dx,dy]=A.rotate([p.x-geometry.x,p.y-geometry.y],-geometry.angle);
      circle(ctx, dx, dy, drill/2);
      // Via holes and pad holes have their own system colours.
      ctx.fillStyle=boardView ? (p.kind==="via" ? PCB.system.hole : PCB.system.padHole) : "#f4f5f6";ctx.fill();
      if(isHole){circle(ctx,dx,dy,drill/2);ctx.strokeStyle=PCB.system.drillEdge;ctx.lineWidth=.8/scale;ctx.stroke();}
    }
    if (boardView && PCB.padCaption(p,parent,geometry,scale,opts)) padText(ctx,p,geometry,scale,opts,parent,land);
    else if (!isHole && !boardView && parent && p.number && (selected || Math.min(w,h) * scale > 23)) {
      ctx.rotate(-A.rad((p.angle || 0) + (parent.angle || 0)));
      const fontSize = Math.min(h*.56, w*1.3/(String(p.number).length+1));
      textAt(ctx, p.number, 0, fontSize*.34, fontSize, "#161719", "center", 600, true);
    }
    ctx.restore();
  }
  // Pad numbers and net names, drawn upright over the land as Altium does
  // once a pad is large enough on screen. Text contrast follows the land ink.
  const lightness=new Map();
  function light(ink){
    let v=lightness.get(ink);
    if(v===undefined){
      const n=/^#[0-9a-f]{6}$/i.test(ink)?parseInt(ink.slice(1),16):0;
      v=(.299*(n>>16&255)+.587*(n>>8&255)+.114*(n&255))/255>.6;
      if(lightness.size>256)lightness.clear();
      lightness.set(ink,v);
    }
    return v;
  }
  // Screen px (WebKit rounds tiny fonts); net over number by cap height, no overlap.
  function padText(ctx,p,g,scale,opts,parent,land,layer){
    const number=parent?String(p.number??""):"", net=opts.netNames===false?"":String(PCB.padNet(p,parent)||"");
    const {at,angle,mirror}=AtriumResolvedLand.place(g,parent);
    if(land===undefined){
      // A retained caption band starts in board space, with no layer or item opacity applied.
      ctx.translate(...at);
      const via=!parent&&p.kind==="via";
      const selected=chosen(parent||p,opts)||opts.highlight&&PCB.padNet(p,parent)===opts.highlight;
      ctx.globalAlpha*=PCB.layerAlpha(layer)*(via?PCB.opacity.via:PCB.opacity.pad);
      land=via?PCB.viaInk(p,opts,selected):PCB.ink(layer,p,opts,selected);
    }else{
      // The exact painter is already at the land, in its rotated and possibly mirrored frame.
      if(mirror)ctx.scale(-1,1);
      ctx.rotate(-A.rad(angle));
    }
    if(opts.flipped)ctx.scale(-1,1);
    const quarter=Math.abs(Math.round(angle/90))%2===1;
    const sw=(quarter?g.h:g.w)*scale, sh=(quarter?g.w:g.h)*scale;
    ctx.scale(1/scale,1/scale);
    const ink=light(land)?"#000000":PCB.system.padText;
    const hole=p.drill>0, fit=(t,k)=>Math.min(sh*k,sw*.85/(.62*t.length+.3)), c=.74;
    const ns=fit(net,.24), us=fit(number,.22), half=((ns+us)*c+.22*Math.max(ns,us))/2;
    if(net && number && !hole && ns>=6 && us>=6){
      textAt(ctx,net,0,ns*c-half,ns,ink,"center",500,true);
      textAt(ctx,number,0,half,us,ink,"center",600,true);
      return;
    }
    const text=number||(hole&&(parent||p.kind!=="via")?"":net), size=fit(text,.45);
    if(text && size>=5)textAt(ctx,text,0,size*c/2,size,ink,"center",600,true);
  }
  function drawRegionPath(ctx,item) {
    const region=PCB.curvedRegion(item);
    if(!region)return false;
    ctx.beginPath();
    for(const contour of [region.contour,...region.cutouts])AtriumBoardShape.traceContour(ctx,contour,true);
    return true;
  }
  function drawShape(ctx, s, kind, scale, selected, substrate, boardInk, layer, bandBounds) {
    const pcb = kind === "pcb";
    const silk = s.style === "silk" || /silk|overlay/i.test(s.layer || "");
    const packageBody=s.style==="package";
    const ink = boardInk || (selected ? (pcb ? color.lightSelect : color.select) :
      pcb ? (packageBody ? color.packageEdge : silk ? (substrate ? color.silk : "#64736b") : copper(s.layer)) : color.ink);
    ctx.strokeStyle=ink;
    if (s.kind === "text" && pcb && T) { T.draw(ctx,s,scale,ink,{layer:layer??s.layer},bandBounds); return; }
    if (s.kind === "text") {
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(A.rad(s.angle || 0));
      textAt(ctx,s.text,0,0,s.size || (pcb ? .7 : 1.5),ink,s.align || "left",500,pcb);
      ctx.restore(); return;
    }
    if(pcb&&s.keepout&&globalThis.AtriumPCBDraw){AtriumPCBDraw.drawKeepout(ctx,s,{scale,ink});return;}
    if(pcb&&s.cutout){
      if(drawPath(ctx,s.points,true)){ctx.save();ctx.lineWidth=Math.max(1/scale,s.width||0);ctx.setLineDash?.([4/scale,3/scale]);ctx.stroke();ctx.restore();}
      return;
    }
    const exact=pcb&&s.regionShape&&drawRegionPath(ctx,s);
    if (s.kind === "circle") circle(ctx,s.x,s.y,s.r);
    else if (!exact && !drawItemPath(ctx,s)) return;
    if (s.fill) {
      ctx.fillStyle = pcb ? (packageBody ? (boardInk ? PCB.system.board : color.package) : ink) : (selected ? "#e0f4ee" : "#fafbf8");
      if(exact)ctx.fill("evenodd");else ctx.fill();
    }
    const stroke=pcb?PCB.shapeStrokeWidth(s,!!exact):s.width||.24;
    if(stroke!==null){ctx.lineWidth=Math.max(.9/scale,stroke);ctx.stroke();}
  }
  function referencePositions(item, def, kind, scale) {
    const b = partBox(item,A.geometries(def,kind));
    if (kind === "pcb") {
      const h = .68;
      return {ref:[(b[0]+b[2])/2,b[1]-.39],refSize:h,align:"center"};
    }
    const upright = (Math.abs(Math.round((item.angle || 0)/90)) % 2) !== 0;
    const x = upright ? b[2]+.9 : (b[0]+b[2])/2;
    // Altium places the Designator above a horizontal part and the Comment below it.
    const refSize = SCH?.fontSize || 1.72, valSize = SCH?.fontSize || 1.45;
    if (upright) return {ref:[x,item.y-.4],value:[x,item.y+refSize*1.15],refSize,valSize,align:"left"};
    return {ref:[x,b[1]-.9],value:[x,b[3]+valSize*1.15],refSize,valSize,align:"center"};
  }
  // Symbol text on a mirrored part: the mirrored anchor, readable glyphs (sch-place.js).
  function mirrorText(s){const flip=a=>Math.abs(Math.cos(A.rad(s.angle||0)))>.5?({left:"right",right:"left"})[a||"left"]||a:a;
    const out={...s,x:-s.x,align:flip(s.align)};if(s.schPaint)out.schPaint={...s.schPaint,align:flip(s.schPaint.align)};return out;}
  function drawPart(ctx,i,def,kind,scale,opts,substrate,preview=false) {
    const g = A.gate ? A.gate(A.geometries(def,kind),i) : A.geometries(def,kind);
    if (!g) return;
    const pcb = kind === "pcb", selected = chosen(i,opts);
    ctx.save();
    ctx.translate(i.x,i.y); ctx.rotate(A.rad(i.angle || 0));
    const flipX=!!i.mirror;if(flipX)ctx.scale(-1,1);
    for (const s0 of g.shapes || []) {
      if(opts.hideRegionGuides&&s0.cutout)continue;
      if (pcb && opts.hidden?.has(shapeLayer(i,s0))) continue;
      // Library and catalogue previews: ".Designator" reads as the prefix ("R?"); other special strings are hidden.
      if(preview && s0.kind==="text" && typeof s0.text==="string" && s0.text[0]==="." && s0.text!==".Designator")continue;
      const s1=preview && s0.kind==="text" && s0.text===".Designator"?{...s0,text:(def.prefix||"U")+"?"}:s0;
      const s=flipX&&s1.kind==="text"?mirrorText(s1):s1;if(s!==s1){ctx.save();ctx.scale(-1,1);}
      if(!pcb && SCH)SCH.shape(ctx,A.special?A.special(s,i):s,scale,selected);
      else drawShape(ctx,s,kind,scale,selected,substrate,undefined,pcb?shapeLayer(i,s):undefined);
      if(s!==s1)ctx.restore();
    }
    if (pcb) for (const p of g.pads || []) {
      if (opts.hidden?.has(layerOf(i,p))) continue;
      const lit = opts.highlight && (i.pinNets?.[p.number] ?? p.net) === opts.highlight;
      drawPad(ctx,p,scale,selected || lit,substrate,i,opts);
    }
    if (!pcb && selected) {
      ctx.fillStyle = "#fcfffc"; ctx.strokeStyle = color.select; ctx.lineWidth = 1.2/scale;
      for (const p of g.pins || []) { if(p.hidden)continue; if(SCH){SCH.grip(ctx,[p.x,p.y],scale);continue;} circle(ctx,p.x,p.y,2.5/scale); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
    if(!pcb && SCH)SCH.pinText(ctx,i,def,scale,selected);
    if (preview || pcb && opts.hidden?.has(silkLayer(i))) return;
    const pos = referencePositions(i,def,kind,scale);
    if(!pcb && SCH){SCH.refs(ctx,A.gateLabel?A.gateLabel(i,def):i,pos,scale,selected);globalThis.AtriumSchObjects?.drawParams(ctx,i,pos,scale,selected);return;}
    const refAt = i.refAt ? A.world(i.refAt,i) : pos.ref;
    const valAt = i.valueAt ? A.world(i.valueAt,i) : pos.value;
    const ink = pcb ? (substrate ? color.silk : color.ink) : color.ink;
    if (i.showRef!==false && i.ref && pos.refSize*scale > 3.3) textAt(ctx,i.ref,refAt[0],refAt[1],pos.refSize,ink,i.refAt?"left":pos.align,650,pcb);
    if (!pcb && i.showValue!==false && i.value && pos.valSize*scale > 3.3) textAt(ctx,i.value,valAt[0],valAt[1],pos.valSize,color.note,i.valueAt?"left":pos.align);
  }
  function circleAt(ctx, p, r, ink) { circle(ctx,p[0],p[1],r);ctx.fillStyle=ink;ctx.fill(); }
  // Altium marks a selected component with its primitives in the selection
  // color and a thin rectangle around its extent.
  function boardSelectionBox(ctx, b, scale) {
    const pad = 2/scale;
    ctx.save();ctx.globalAlpha*=.7;ctx.strokeStyle=PCB.system.selection;ctx.lineWidth=1/scale;
    ctx.beginPath();ctx.rect(b[0]-pad,b[1]-pad,b[2]-b[0]+pad*2,b[3]-b[1]+pad*2);ctx.stroke();ctx.restore();
  }
  // Rubber-band selection: blue for enclosed objects, green for touching.
  // Selection marquee: a fill and a device-pixel edge in the palette's marquee ink.
  function marquee(ctx,b,c,dpr){
    const m=ctx.getTransform(),k=Math.max(1,Math.round(dpr*1.5)),p=(x,y)=>[Math.round(x*m.a+y*m.c+m.e)+k%2/2,Math.round(x*m.b+y*m.d+m.f)+k%2/2];
    if(m.b||m.c){ctx.save();ctx.fillStyle=ctx.strokeStyle=c;ctx.globalAlpha=.16;ctx.fillRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);ctx.globalAlpha=1;ctx.lineWidth=k/Math.hypot(m.a,m.b);ctx.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);ctx.restore();return;}
    const [x,y]=p(b[0],b[1]),[X,Y]=p(b[2],b[3]);
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle=ctx.strokeStyle=c;ctx.globalAlpha=.16;ctx.fillRect(x,y,X-x,Y-y);
    ctx.globalAlpha=1;ctx.lineWidth=k;ctx.strokeRect(x,y,X-x,Y-y);ctx.restore();
  }
  // #rrggbb a over b at opacity t (grid fading, both renderers).
  const tint=(a,b,t)=>"rgb("+[1,3,5].map(i=>Math.round(parseInt(b.slice(i,i+2),16)*(1-t)+parseInt(a.slice(i,i+2),16)*t))+")";
  function labelAnchor(ctx,i,scale,emphasize){
    // A hollow anchor remains distinct from a filled electrical junction.
    ctx.save();circle(ctx,i.x,i.y,(emphasize?4.1:2.5)/scale);
    ctx.strokeStyle="#fff";ctx.lineWidth=3/scale;ctx.stroke();
    ctx.strokeStyle=emphasize?color.select:SCH?.wire||color.wire;ctx.lineWidth=1.4/scale;ctx.stroke();ctx.restore();
  }
  function selectionBox(ctx, b, scale, overBoard) {
    const pad = 4/scale, x=b[0]-pad, y=b[1]-pad, w=b[2]-b[0]+pad*2, h=b[3]-b[1]+pad*2;
    ctx.strokeStyle = overBoard ? color.lightSelect : color.select;
    ctx.lineWidth = 1.1/scale;
    const r = Math.min(6/scale,w/3,h/3);
    for (const [cx,cy,dx,dy] of [[x,y,1,1],[x+w,y,-1,1],[x,y+h,1,-1],[x+w,y+h,-1,-1]]) {
      drawPath(ctx,[[cx+r*dx,cy],[cx,cy],[cx,cy+r*dy]]);
      ctx.stroke();
    }
  }
  function labelData(i, pcb) {
    const net = i.kind === "netlabel", size=i.size || (pcb ? .75 : net ? 1.45 : 2.0);
    return {size,dx:0,dy:net ? (i.at==="below" ? 1.4*size : -.52*size) : 0,align:net ? "center" : "left"};
  }
  const textProjects=new WeakMap(),textRevisions=new WeakMap();
  function textProject(doc){
    const explicit=textProjects.get(doc);if(explicit)return explicit;
    const active=globalThis.AtriumNavHost?.project?.();return active?.documents?.includes(doc)?active:null;
  }
  function boardText(i,doc){
    if(i.sourceTextBox?.letterSet!=null && T)i=T.withLetters(i,doc);
    if(!T?.hasProjectText?.(i))return i;
    const project=textProject(doc),state=textRevisions.get(doc);
    return T.projectItem(i,project,state?.project===project?state?.version:null);
  }
  function fallbackLabel(text){
    const [vertical,horizontal]=text.justify==="center"?["middle","center"]:text.justify.split("-");
    return {x:text.x,y:text.y,angle:text.angle,mirror:text.mirrored,vertical,horizontal};
  }
  function partTextBounds(row,doc){
    const text=row.text;
    if(row.box)return expand(row.box,text.size*.35);
    if(T)return T.paintBox(boardText(text,doc));
    const {vertical,horizontal}=fallbackLabel(text);
    return paintedTextBox(text.text,text.size,text.mirrored&&horizontal!=="center"?
      (horizontal==="left"?"right":"left"):horizontal,[text.x,text.y],text.angle,vertical);
  }
  function partTextDistance(row,doc,p){
    if(T && !row.box)return T.hitDistance(boardText(row.text,doc),p);
    const b=row.box||partTextBounds(row,doc);
    return Math.max(b[0]-p[0],p[0]-b[2],b[1]-p[1],p[1]-b[3],0);
  }
  function footprintText(shape,part,doc){
    return shape.kind==="text"?boardText(A.special(shape,part),doc):shape;
  }
  function textBox(i, pcb) {
    if(!pcb&&SCH)return SCH.labelBox(i);
    if(pcb&&T&&i.kind==="label")return T.hitBox(i);
    const v=labelData(i,pcb);
    const w=String(i.text).length*v.size*.65;
    const x=v.align==="center"?-w/2:0;
    return A.bounds(boxCorners([x,v.dy-v.size,x+w,v.dy+.2*v.size]).map(p=>A.world(p,i)));
  }
  const expand=(b,amount)=>[b[0]-amount,b[1]-amount,b[2]+amount,b[3]+amount];
  const union=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])];
  function paintedTextBox(text,size,align,origin,angle=0,baseline="alphabetic") {
    // Generous glyph envelope includes wide Unicode and fallback fonts.
    const width=(String(text).length+1)*size*1.6;
    const x=align==="center"?-width/2:align==="right"?-width:0;
    const frame={x:origin[0],y:origin[1],angle};
    const top=baseline==="top"||baseline==="hanging"?-.4:-1.45;
    const bottom=baseline==="top"||baseline==="hanging"?1.6:baseline==="middle"?1.2:.4;
    return A.bounds(boxCorners([x-size*.3,top*size,x+width,bottom*size]).map(p=>A.world(p,frame)));
  }
  function textHalo(text,size) {
    return text ? (String(text).length+1)*size*1.6 : 0;
  }
  function schematicObjectBox(i,objects) {
    let b=objects.box(i);const size=SCH?.fontSize||2.032;
    if(i.kind==="sheetsymbol"){
      // The title and an entry name can extend outside the symbol's interactive rectangle.
      let pad=Math.max(.25,textHalo(i.name,size),textHalo(i.file,size));
      for(const entry of i.entries||[])pad=Math.max(pad,3+textHalo(entry.name,size)*1.35);
      return expand(b,pad);
    }
    if(i.text&&i.kind==="offsheet"&&A.offsheetIO(i.io)==="unspecified"){
      const angle=((i.angle||0)%360+360)%360;
      b=union(b,paintedTextBox(i.text,size,angle===180?"right":"left",A.world([2.9,0],i),angle===90||angle===270?-90:0,"middle"));
    }else if(i.text&&(i.kind==="port"||i.kind==="offsheet")){
      const angle=i.kind==="offsheet"?A.offsheetAngle(i):i.angle||0;
      const center=A.world([objects.portShape(i).textX,0],{x:i.x,y:i.y,angle});
      b=union(b,paintedTextBox(i.text,size*.9,"center",center,angle%180?-90:0,"middle"));
    }else if(i.text&&i.kind==="power"&&i.showName!==false){
      const rotation=-(i.direction||0)*90,d=A.rotate([1,0],rotation),mark=objects.POWER[i.style];
      const offset=A.rotate([mark===4||mark===8?5.3:3.25,0],rotation),at=[i.x+offset[0],i.y+offset[1]];
      b=union(b,paintedTextBox(i.text,size,d[0]>.5?"left":d[0]<-.5?"right":"center",at,0,d[1]>.5?"top":d[1]<-.5?"bottom":"middle"));
    }
    return expand(b,.25);
  }
  const discBox=(x,y,r)=>[x-r,y-r,x+r,y+r];
  // A custom land and the active-layer pad stack can both exceed the nominal pad rectangle.
  function padOverhang(p) {
    const r=(p.drill||0)*(p.tent ? .6 : .5);
    let b=discBox(p.x,p.y,r);
    const L=AtriumResolvedLand;
    const nominal=L.geometry(p);
    if(nominal?.poly)b=union(b,A.bounds(nominal.poly.map(q=>A.world(q,p))));
    if(p.padStack)for(const layer of Object.keys(p.padStack)){
      const g=L.geometry(p,layer);
      if(!g)continue;
      b=union(b,A.bounds((g.poly||boxCorners([-g.w/2,-g.h/2,g.w/2,g.h/2])).map(q=>A.world(q,g))));
    }
    return b;
  }
  let paintBoxes=new WeakMap(),variableFootprintText=new WeakMap(),paintVersion,paintPending=0;
  function syncPaintGeometry(){
    if(!T&&globalThis.AtriumPCBText){
      T=globalThis.AtriumPCBText;
      batches=undefined;pendingGeometry++;
    }
    const version=globalThis.AtriumUndoStore?.libraryVersion?.();
    if(version!==paintVersion || paintPending!==pendingGeometry){
      paintVersion=version;paintPending=pendingGeometry;
      paintBoxes=new WeakMap();variableFootprintText=new WeakMap();
    }
    return version;
  }
  function geometryPaintBox(g,pcb) {
    if (!g)return [-.5,-.5,.5,.5];
    if (!paintBoxes.has(g)){
      let b=localBox(g),stroke=.25;
      for(const s of g.shapes||[]){
        if(s.kind==="text"){
          if(/^\.(?:designator|comment)$/i.test(s.text) || pcb && T?.hasProjectText?.(s)){
            if(!variableFootprintText.has(g))variableFootprintText.set(g,[]);
            variableFootprintText.get(g).push(s);
            continue;
          }
          const bounds=pcb&&T?union(T.paintBox(s,{layer:"Silk"}),T.paintBox(s,{layer:"Bottom silk"})):discBox(s.x,s.y,textHalo(s.text,s.schPaint?.size||s.size||(pcb?.7:1.5)));
          b=union(b,bounds);
        }
        stroke=Math.max(stroke,s.schPaint?.width||s.width||0);
      }
      if(pcb)for(const p of g.pads||[])if(p.drill||p.padStack||p.poly)b=union(b,padOverhang(p));
      paintBoxes.set(g,expand(b,stroke/2));
    }
    return paintBoxes.get(g);
  }
  function objectBox(i,doc,defs) {
    if(i.kind==="imageMarkup")return null;
    if(doc.schRestored && SCH)i=SCH.displayItem(doc,i);
    const pcb=doc.kind==="pcb";
    const objects=pcb?null:globalThis.AtriumSchObjects;
    if(objects?.KINDS.has(i.kind))return schematicObjectBox(i,objects);
    if(i.points){
      const region=pcb&&PCB.curvedRegion(i),arc=A.pathArc(i);
      let b=region?AtriumBoardShape.bounds(region):arc?AtriumBoardShape.contourBounds([arc]):A.bounds(i.points);
      const draw=pcb&&i.dimension&&globalThis.AtriumPCBDraw;
      if(draw)for(const units of ["mm","mil"]){
        const g=draw.dimensionGeometry(i,{units});
        b=union(b,A.bounds([...g.lines.flat(),...g.arrows.flat(),...i.points]));
        if(g.text)b=union(b,expand(paintedTextBox(g.label,g.text.size,"center",g.text.at,g.text.angle),g.text.size*.2));
      }
      let width=Math.max(.254,i.width||i.schPaint?.width||0);
      if(pcb)for(const opening of PCB.traceOpenings(i,boardLayer(i)))width=Math.max(width,opening.width);
      return b&&expand(b,width/2);
    }
    if(i.kind==="part"){
      const def=doc.schRestored&&SCH?SCH.displayDef(doc,i,getDef(defs,i,doc)):getDef(defs,i,doc),geom=A.geometries(def,doc.kind);
      let b=A.bounds(boxCorners(geometryPaintBox(geom,pcb)).map(p=>A.world(p,i)));
      const labels=pcb&&i.mirror?geom?.shapes:variableFootprintText.get(geom);
      for(const s of labels||[]){
        if(s.kind!=="text")continue;
        const shape=pcb?footprintText(s,i,doc):A.special(s,i),at=A.world([s.x,s.y],i);
        b=union(b,pcb&&T?T.paintBox(shape,{frame:i,layer:PCB.shapeLayer(i,s)}):discBox(...at,textHalo(shape.text,shape.schPaint?.size||shape.size||1.5)));
      }
      if(pcb){
        for(const row of PCB.partText(doc,i,def))b=union(b,partTextBounds(row,doc));
        return b;
      }
      const pos=referencePositions(i,def,doc.kind);
      const ref=A.gateLabel(i,def).ref;
      for(const [key,text,offset,defaultAt,size,show] of [["ref",ref,i.refAt,pos.ref,pos.refSize,i.showRef],["value",i.value,i.valueAt,pos.value,pos.valSize,i.showValue]]){
        if(!text||!size||show===false)continue;
        const style=i.schPaint?.[key];
        b=union(b,paintedTextBox(text,style?.size||size,style?.align||(offset?"left":pos.align),offset?A.world(offset,i):defaultAt,
          style?(style.angle||0)+(i.angle||0):0,style?.baseline));
      }
      for(const [name,paint] of Object.entries(i.schPaint?.parameters||{})){
        if(i.paramShow?.[name])b=union(b,expand(paintedTextBox((paint.caption?paint.caption+": ":"")+(i.parameters?.[name]??paint.text),paint.size,paint.align,A.world(paint.at,i),(paint.angle||0)+(i.angle||0)),paint.size));
      }
      if(!pcb&&SCH&&!def?.sourceSymbolShapes)for(const pin of def?.schDrawing?.pins||[]){
        if(pin.part>0&&pin.part!==(i.unit||i.part||1))continue;
        const start=A.world(pin.start,i),end=A.world(pin.end,i),mid=[(start[0]+end[0])/2,(start[1]+end[1])/2];
        const font=def.schDrawing.pinFont;
        if(pin.name)b=union(b,discBox(...start,(font?Math.abs(pin.nameMargin??1.778):.6)+textHalo(pin.name,pin.nameFont?.size||font?.size||SCH.fontSize)));
        if(pin.number)b=union(b,discBox(...(font?start:mid),(font?Math.abs(pin.numberMargin??2.032):.25)+textHalo(pin.number,pin.numberFont?.size||font?.size||SCH.fontSize*.9)));
      }
      return b;
    }
    if(i.kind==="label"||i.kind==="netlabel"){
      if(!pcb && SCH)return union([i.x,i.y,i.x,i.y],expand(SCH.labelBox(i),textHalo(i.text,i.schPaint?.size||i.size||SCH.fontSize)*.7));
      if(pcb&&T&&i.kind==="label")return union([i.x,i.y,i.x,i.y],expand(T.paintBox(boardText(i,doc)),.05));
      const d=labelData(i,pcb),position=A.world([d.dx,d.dy],i);
      return union([i.x,i.y,i.x,i.y],paintedTextBox(i.text,d.size,d.align,position,i.angle));
    }
    if(i.kind==="pad"||i.kind==="via"){
      const b=padOverhang(i),land=A.bounds(A.itemPoints(i,null,doc.kind));
      return land?union(land,b):b;
    }
    return [i.x-.4,i.y-.4,i.x+.4,i.y+.4];
  }
  // Pure full rebuild for print/export and callers without a live view.
  function artBounds(doc,defs){
    syncPaintGeometry();
    let bounds=null;
    for(const item of doc.items){
      const b=objectBox(item,doc,defs);
      if(b && b.every(Number.isFinite))bounds=bounds?union(bounds,b):b;
    }
    return bounds;
  }
  // Net colour override (Nets panel, F5): tracks and polygons of a coloured net, except on dimmed layers.
  function netInk(i,opts){
    if(!opts.netColors||!i.net||(i.kind!=="track"&&i.kind!=="polygon"))return null;
    const c=opts.netColors.get(i.net);if(!c)return null;
    return opts.layerMode==="dim"&&!PCB.onLayer(boardLayer(i),opts.layer||"Top",i)?null:c;
  }
  const schematicStrokeWidth=i=>i.width||i.schPaint?.width||(i.kind==="wire"?.254:.2);
  function drawItem(ctx,i,doc,defs,scale,opts,substrate,bandBounds) {
    if(opts.hideRegionGuides&&i.cutout)return;
    if(doc.schRestored && SCH)i=SCH.displayItem(doc,i);
    if(i.kind==="imageMarkup")return;
    const selected = chosen(i,opts), pcb=doc.kind === "pcb";
    const scoped=!pcb&&opts.schematicHighlightIds;
    const lit=scoped?scoped.has(i.id):opts.highlight && (i.net || opts.netByWire?.get(i.id) || (i.kind==="netlabel" ? i.text : ""))===opts.highlight;
    const accent=pcb ? PCB.system.selection : SCH?.select||color.select;
    const schBox=(b)=>SCH?SCH.selection(ctx,b,scale):selectionBox(ctx,b,scale,false);
    const schObj=!pcb&&globalThis.AtriumSchObjects;
    if(!pcb && globalThis.AtriumLabs?.notebookEnabled()===false && A.notebookItemKind(i)){
      const compat=globalThis.AtriumNotebookCompat;
      if(compat)compat.draw(ctx,i,doc,{...opts,scale,selected,schBox});
      else if(!globalThis.AtriumLazy?.pending?.("AtriumNotebookCompat"))globalThis.AtriumLazy?.need?.("AtriumNotebookCompat").then(()=>globalThis.AtriumNavHost?.invalidate?.(),()=>{});
      return;
    }
    const markup=pcb?null:globalThis.AtriumMarkup;
    if(markup?.kind(i)){
      if(opts.notesDeferred)return;
      markup.draw(ctx,i,doc,defs,{...opts,scale});
      if(selected && markup.policy(doc,opts).hit({kind:markup.kind(i),id:i.id}))schBox(markup.rect(i));
      return;
    }
    if (schObj&&schObj.KINDS.has(i.kind)) {
      schObj.draw(ctx,i,{doc,defs,project:opts.project,purpose:opts.purpose,print:opts.print,calculationRecords:opts.calculationRecords,widgetViews:opts.widgetViews,assets:opts.assets,policy:opts.notePolicy,viewport:opts.imageViewport,
        scale,selected,lit:lit||!scoped&&!!opts.highlight&&i.text===opts.highlight,select:accent,schBox});
      return;
    }
    if (i.kind==="part") {
      drawPart(ctx,i,doc.schRestored&&SCH?SCH.displayDef(doc,i,getDef(defs,i,doc)):getDef(defs,i,doc),doc.kind,scale,opts,substrate);
      if (selected) pcb ? boardSelectionBox(ctx,partBox(i,A.geometries(getDef(defs,i,doc),doc.kind)),scale) : schBox(partBox(i,A.geometries(getDef(defs,i,doc),doc.kind)));
    } else if (i.keepout===true && pcb && i.points && globalThis.AtriumPCBDraw) {
      AtriumPCBDraw.drawKeepout(ctx,i,{scale,ink:selected||lit?accent:PCB.ink(boardLayer(i),i,opts,false)});
    } else if (i.dimension && pcb && globalThis.AtriumPCBDraw) {
      AtriumPCBDraw.drawDimension(ctx,i,{scale,ink:selected||lit?accent:PCB.ink(boardLayer(i),i,opts,false)});
    } else if (i.points) {
      const stroke=pcb?PCB.boardStrokeWidth(i):schematicStrokeWidth(i);
      const exact=pcb&&i.regionShape&&drawRegionPath(ctx,i);
      if (!exact && !(i.kind==="wire"&&schObj&&schObj.hopPath(ctx,i,doc,opts.wireHops)) && !drawItemPath(ctx,i)) return;
      if(i.fill){ctx.fillStyle=pcb?PCB.ink(boardLayer(i),i,opts,selected||lit):i.schPaint?.fill||"#ffffb0";if(exact)ctx.fill("evenodd");else ctx.fill();}
      if(stroke!==null){
        ctx.strokeStyle = (selected || lit) ? accent : pcb ? netInk(i,opts)||PCB.ink(boardLayer(i),i,opts,false) : i.schPaint?.ink || (i.kind==="wire" ? SCH?.wire||color.wire : SCH?.body||color.ink);
        ctx.lineWidth = Math.max(1/scale,stroke);ctx.stroke();
      }
      if (selected && i.kind!=="graphic" && pcb) {
        // Altium's square edit handles.
        const r=3/scale;ctx.fillStyle=PCB.system.selection;ctx.strokeStyle=PCB.system.board;ctx.lineWidth=1/scale;
        for(const p of i.points){ctx.beginPath();ctx.rect(p[0]-r,p[1]-r,r*2,r*2);ctx.fill();ctx.stroke();}
      } else if (selected && i.kind!=="graphic") {
        ctx.fillStyle=color.field;ctx.strokeStyle=accent;ctx.lineWidth=1.2/scale;
        for(const p of i.points){if(SCH){SCH.grip(ctx,p,scale);continue;}circle(ctx,p[0],p[1],2.6/scale);ctx.fill();ctx.stroke();}
      }
    } else if (i.kind==="via" || i.kind==="pad") {
      // Via stacks: T-M-B and full-stack vias show the land of the active layer;
      // filled and back-drilled vias get a mark once the hole is visible.
      const VS=i.kind==="via"&&globalThis.AtriumViaStack;
      drawPad(ctx,i,scale,selected || lit,true,null,opts);
      if(VS&&opts.viaMarks!==false&&mayHaveViaMark(i))VS.paintMarks(ctx,i,scale,opts.recordViaMark);
      if (selected) pcb ? boardSelectionBox(ctx,A.bounds(A.itemPoints(i,null,doc.kind)),scale) : schBox(A.bounds(A.itemPoints(i,null,doc.kind)));
    } else if (i.kind==="junction") {
      circleAt(ctx,[i.x,i.y],Math.max(.40,1.9/scale),selected||lit?accent:i.schPaint?.ink||SCH?.body||color.wire);
    } else if (i.kind==="label" || i.kind==="netlabel") {
      if(!pcb && SCH){
        SCH.label(ctx,i,scale,selected||lit);
        if(selected)schBox(SCH.labelBox(i));
        if(i.kind==="netlabel" && (opts.editorPane || "reuseBase" in opts))labelAnchor(ctx,i,scale,selected||i===opts.ghost);
        return;
      }
      if(pcb&&T&&i.kind==="label"){
        const text=boardText(i,doc);
        T.draw(ctx,text,scale,selected || lit ? accent : PCB.ink(boardLayer(i),i,opts,false),{layer:boardLayer(i)},bandBounds);
        if(selected)boardSelectionBox(ctx,T.hitBox(text),scale);
        return bandBounds && !selected;
      }
      ctx.save();ctx.translate(i.x,i.y);ctx.rotate(A.rad(i.angle || 0));
      const d=labelData(i,pcb), ink=selected || lit ? accent : pcb ? PCB.ink(boardLayer(i),i,opts,false) : i.kind==="netlabel"?color.wire:color.ink;
      if(d.size*scale>2.8) textAt(ctx,i.text,d.dx,d.dy,d.size,ink,d.align,pcb?590:530,pcb || i.kind==="netlabel");
      ctx.restore();
      if(selected) pcb ? boardSelectionBox(ctx,textBox(i,pcb),scale) : schBox(textBox(i,pcb));
    }
  }
  // Layers tied in PCB.order paint in the order met. Local paints share the full viewport's order.
  const boardOrder={force:null,last:null};
  function collectBoardLayers(items,doc,defs,scale,opts,pours,viewport,lod,orderOnly=false){
    const names=orderOnly?new Set():null, layers=orderOnly?null:new Map(), selectedParts=orderOnly?null:[];
    function bucket(layer){
      if(names){names.add(layer);return;}
      let found=layers.get(layer);
      if(!found){found={layer,items:[],parts:[],labels:[],pours:[]};layers.set(layer,found);}
      return found;
    }
    for(const region of pours||[]){
      if(!region || !Array.isArray(region.bounds) || region.bounds.length!==4 || !PCB.visible(region.layer,region,opts))continue;
      const b=region.bounds;
      if(b[0]>viewport[2] || b[1]>viewport[3] || b[2]<viewport[0] || b[3]<viewport[1])continue;
      bucket(region.layer)?.pours.push(region);
    }
    for(const i of items){
      if(opts.hide?.has(i))continue; // collab-object-motion.js
      const batched=lod?.info.get(i),skip=batched&&lod.skip?.has(batched.chunk);
      if(i.kind!=="part"){
        if(batched && !skip && !batches.special(i,batched,opts,scale) || opts.gpu?.(i))continue;
        const layer=boardLayer(i);
        if(!names?.has(layer) && boardVisible(i,opts))bucket(layer)?.items.push(i);
        for(const opening of PCB.traceOpenings(i,layer))if(boardVisible(opening,opts))bucket(opening.layer)?.items.push(opening);
        continue;
      }
      const def=getDef(defs,i,doc),fp=def?.footprint;
      if(!fp)continue;
      let shown=false;
      const groups=batched && !skip && !batches.special(i,batched,opts,scale)?batches.groups(batched,scale,opts):PCB.footprintLayers(i,fp);
      for(const group of groups){
        if(!PCB.visible(group.layer,null,opts))continue;
        if(!opts.gpu || group.shapes.some(s=>s.kind==="text"||s.cutout||s.keepout))bucket(group.layer)?.parts.push(i,group);
        if(selectedParts)shown=shown || group.shapes.length>0 || group.pads.some(p=>PCB.visible(group.layer,p,opts));
      }
      for(const row of PCB.partText(doc,i,def)){
        if(!PCB.visible(row.text.layer,i,opts))continue;
        bucket(row.text.layer)?.labels.push(i,row);shown=true;
      }
      if(selectedParts && shown && !opts.skipPartBoxes && chosen(i,opts))selectedParts.push(i);
    }
    if(lod)for(const l of lod.layers)bucket(l);
    // Flipped board: bottom layers paint above top layers.
    if(names)return [...names].sort((a,b)=>layerRank(a,opts,opts.flipped)-layerRank(b,opts,opts.flipped));
    const ordered=[...layers.values()].sort((a,b)=>layerRank(a.layer,opts,opts.flipped)-layerRank(b.layer,opts,opts.flipped));
    return {ordered,selectedParts};
  }
  function drawBoard(ctx,items,doc,defs,scale,opts,pours,viewport,lod,painted,bandBounds){
    const {ordered,selectedParts}=collectBoardLayers(items,doc,defs,scale,opts,pours,viewport,lod);
    if(bandBounds && (lod || selectedParts.length)) bandBounds(null);
    if(opts.partBoxesOnly){
      for(const i of selectedParts)boardSelectionBox(ctx,partBox(i,getDef(defs,i,doc).footprint),scale);
      return;
    }
    if(boardOrder.force){const at=boardOrder.force;ordered.sort((a,b)=>(at.get(a.layer)??1e9)-(at.get(b.layer)??1e9));}
    else boardOrder.last=ordered.map(p=>p.layer);
    // Preserve preview alpha across physical layer passes recorded by Smart PDF.
    const outer=typeof ctx.globalAlpha==="number"?ctx.globalAlpha:1,see=PCB.opacity,layerAlpha=PCB.layerAlpha||(()=>1);
    let base=outer,alpha=base;
    const fade=a=>{const v=base*a;if(v!==alpha){ctx.globalAlpha=alpha=v;}};
    for(const pass of ordered){
      opts.recordLayer?.(pass.layer);
      base=outer*layerAlpha(pass.layer);fade(1);
      const clip = opts.clipLayer?.(pass.layer,viewport);
      if (clip) {ctx.save();boardPath(ctx,clip,AtriumBoardShape);ctx.clip("evenodd");}
      if(pass.pours.length){
        bandBounds?.(null);
        ctx.save();ctx.globalAlpha=base*see.pour;
        for(const region of pass.pours){
          painted?.(region,region.bounds);
          ctx.fillStyle=PCB.ink(region.layer,region,opts,opts.highlight && opts.highlight===region.net);
          if(!(viewport&&hasPath2D&&globalThis.AtriumCanvasFast?.paintPour(ctx,region,viewport)))AtriumPCBPours.paint(ctx,region);
        }
        ctx.restore();
      }
      if(lod)batches.draw(ctx,lod,pass.layer,LOD_CATS_ITEMS,scale,opts,fade,see);
      for(const i of pass.items){
        fade(i.kind==="track"?see.track:i.kind==="via"?see.via:i.kind==="pad"?see.pad:1);
        painted?.(i);
        const bounded=drawItem(ctx,i,doc,defs,scale,opts,true,bandBounds);
        if(bandBounds && !bounded)bandBounds(null);
      }
      fade(1);
      if(lod)batches.draw(ctx,lod,pass.layer,LOD_CATS_PARTS,scale,opts,fade,see);
      for(let n=0;n<pass.parts.length;n+=2){
        const i=pass.parts[n],group=pass.parts[n+1],selected=chosen(i,opts);
        ctx.save();ctx.translate(i.x,i.y);ctx.rotate(A.rad(i.angle||0));if(i.mirror)ctx.scale(-1,1);
        for(const s of group.shapes){
          if(opts.hideRegionGuides&&s.cutout || opts.gpu && s.kind!=="text"&&!s.cutout&&!s.keepout)continue;
          const lit=opts.highlight && s.net===opts.highlight,ink=PCB.ink(pass.layer,s,opts,selected||lit);
          const shape=footprintText(s,i,doc);
          if(painted)painted(i,s.kind==="text"&&T?T.paintBox(shape,{frame:i,layer:pass.layer}):null);
          if(bandBounds && (s.kind!=="text" || !T)) bandBounds(null);
          if(s.kind==="text" && (i.mirror || T && s.upright)){
            ctx.save();if(i.mirror)ctx.scale(-1,1);ctx.rotate(-A.rad(i.angle||0));ctx.translate(-i.x,-i.y);
            if(T)T.draw(ctx,shape,scale,ink,{frame:i,layer:pass.layer},bandBounds);
            else drawShape(ctx,PCB.placeText(shape,i,pass.layer),"pcb",scale,selected,true,ink,pass.layer);
            ctx.restore();
          }else drawShape(ctx,shape,"pcb",scale,selected,true,ink,pass.layer,bandBounds);
        }
        if(group.pads.length)fade(see.pad);
        for(const p of group.pads){
          if(opts.gpu || !PCB.visible(pass.layer,p,opts))continue;
          const lit=opts.highlight && (i.pinNets?.[p.number]??p.net)===opts.highlight;
          painted?.(i);
          bandBounds?.(null);
          drawPad(ctx,p,scale,selected||lit,true,i,opts);
        }
        fade(1);
        ctx.restore();
      }
      for(let n=0;n<pass.labels.length;n+=2){
        const i=pass.labels[n],row=pass.labels[n+1],text=row.text;
        if(text.size*scale<=(row.kind==="designator"?2.4:3.3))continue;
        if(painted)painted(i,partTextBounds(row,doc));
        const ink=PCB.ink(pass.layer,i,opts,chosen(i,opts));
        if(T)T.draw(ctx,boardText(text,doc),scale,ink,{lod:0},bandBounds);
        else{
          bandBounds?.(null);
          const {x,y,angle,mirror,vertical,horizontal}=fallbackLabel(text);
          ctx.save();ctx.translate(x,y);ctx.rotate(A.rad(angle));if(mirror)ctx.scale(-1,1);
          const baseline=vertical==="top"?text.size:vertical==="middle"?text.size/2:0;
          textAt(ctx,text.text,0,baseline,text.size,ink,horizontal,600,true);ctx.restore();
        }
      }
      if (clip) ctx.restore();
    }
    opts.recordLayer?.(null);base=outer;fade(1);
    for(const i of selectedParts)boardSelectionBox(ctx,partBox(i,getDef(defs,i,doc).footprint),scale);
  }
  function drawingOrder(item) {
    if(globalThis.AtriumMarkup?.kind(item))return 5;
    if(item.kind==="sheetsymbol"||item.kind==="textframe"||item.kind==="image")return 0;
    if(item.kind==="track" || item.kind==="graphic") return item.layer==="Bottom" ? 0 : 1;
    if(item.kind==="wire")return 1;
    if(item.kind==="via" || item.kind==="pad")return 2;
    if(item.kind==="part")return 3;
    return 4;
  }
  function distanceToPad(point,pad,layer,declared){
    const g=PCB.padGeometry(pad,layer,declared);
    return g?AtriumResolvedLand.distance(g,point,[g.x,g.y]):Infinity;
  }
  function distanceToShape(p,s) {
    if(s.kind==="circle") {
      const d=gap(p,[s.x,s.y])-s.r;
      return s.fill?Math.max(0,d):Math.abs(d);
    }
    if(s.kind==="text") {
      const q=A.rotate([p[0]-s.x,p[1]-s.y],-(s.angle||0)),height=s.size||1.5;
      const width=s.text.length*height*.65,left=s.align==="center"?-width/2:0;
      return Math.hypot(Math.max(left-q[0],q[0]-left-width,0),Math.max(-height-q[1],q[1]-.2*height,0));
    }
    const ps=s.points;
    if(!ps?.length)return Infinity;
    if(s.fill && AtriumBoardShape.polyContains(ps,p))return 0;
    let d=s.closed?A.nearSegment(p,ps[ps.length-1],ps[0]):Infinity;
    for(let n=1;n<ps.length;n++)d=Math.min(d,A.nearSegment(p,ps[n-1],ps[n]));
    return Math.max(0,d-(s.width||0)/2);
  }
  function distanceToArc(p,arc) {
    const S=AtriumBoardShape;
    if(S.within(arc,S.angleOf(arc.c,p)))return Math.abs(gap(p,arc.c)-arc.r);
    const [a,b]=S.ends(arc);
    return Math.min(gap(p,a),gap(p,b));
  }
  function contourContains(contour,p) {
    const arc=contour.length===1 && contour[0];
    if(arc?.kind==="arc" && Math.abs(A.arcSweep(arc))===360)return gap(p,arc.c)<arc.r;
    return AtriumBoardShape.crossings(contour,p);
  }
  function distanceToWireHop(i,p,doc,wireHops) {
    let last,distance=Infinity;
    // Measure the path emitted by the wire painter, including its replaced straight spans.
    const path={
      beginPath(){},
      moveTo(x,y){last=[x,y];},
      lineTo(x,y){
        const next=[x,y];
        distance=Math.min(distance,A.nearSegment(p,last,next));
        last=next;
      },
      arc(x,y,r,start,end,ccw){
        distance=Math.min(distance,distanceToArc(p,{kind:"arc",c:[x,y],r,start:-start*180/Math.PI,end:-end*180/Math.PI,ccw}));
        last=[x+r*Math.cos(end),y+r*Math.sin(end)];
      }
    };
    return globalThis.AtriumSchObjects?.hopPath(path,i,doc,wireHops)?distance:null;
  }
  let bodyHit=false;
  function hitDistance(i, p, defs, doc, tol, scale, opts) {
    if(doc.schRestored && SCH)i=SCH.displayItem(doc,i);
    if(doc.kind==="schematic" && globalThis.AtriumLabs?.notebookEnabled()!==false && globalThis.AtriumMarkup?.kind(i))return AtriumMarkup.hit(i,doc,p,tol,opts);
    if(i.dimension && doc.kind==="pcb" && globalThis.AtriumPCBDraw)return AtriumPCBDraw.dimensionHit(i,p);
    if(doc.kind!=="pcb"&&globalThis.AtriumSchObjects?.KINDS.has(i.kind))return AtriumSchObjects.hit(i,p,tol);
    if (i.points) {
      if(doc.kind==="schematic" && doc.hopOvers && i.kind==="wire"){
        const distance=distanceToWireHop(i,p,doc,opts.wireHops);
        if(distance!==null)return distance-Math.max(1/scale,schematicStrokeWidth(i))/2;
      }
      const region=doc.kind==="pcb"&&PCB.curvedRegion(i);
      if(region){
        const contours=[region.contour,...region.cutouts];
        let filled=false,distance=Infinity;
        for(const contour of contours){
          if(i.fill && contourContains(contour,p))filled=!filled;
          for(const segment of contour)distance=Math.min(distance,segment.kind==="arc"
            ?distanceToArc(p,segment):A.nearSegment(p,segment.a,segment.b));
        }
        if(filled)return tol;
        const width=PCB.boardStrokeWidth(i);
        return distance-(width===null?0:Math.max(1/scale,width)/2);
      }
      const arc=A.pathArc(i);
      if(arc){
        if(i.fill){
          const [a,b]=AtriumBoardShape.ends(arc);
          const contour=Math.abs(A.arcSweep(arc))===360?[arc]:[arc,{kind:"line",a:b,b:a}];
          if(contourContains(contour,p))return tol;
        }
        const width=doc.kind==="pcb"?PCB.boardStrokeWidth(i):schematicStrokeWidth(i);
        return distanceToArc(p,arc)-(width===null?0:Math.max(1/scale,width)/2);
      }
      if(i.fill && AtriumBoardShape.polyContains(i.points,p)) return tol;
      let distance=Infinity;
      for(let n=1;n<i.points.length;n++) distance=Math.min(distance,A.nearSegment(p,i.points[n-1],i.points[n]));
      if(i.closed && i.points.length>2)distance=Math.min(distance,A.nearSegment(p,i.points.at(-1),i.points[0]));
      const width=doc.kind==="schematic"&&i.kind==="wire"?Math.max(1/scale,schematicStrokeWidth(i)):i.width||0;
      return distance-width/2;
    }
    let b;
    if(i.kind==="part"){
      const def=getDef(defs,i,doc),g=A.geometries(def,doc.kind);
      const q=A.rotate([p[0]-i.x,p[1]-i.y],-(i.angle || 0));if(i.mirror)q[0]=-q[0];
      const filtered=doc.kind==="pcb"?filteredFootprint(i,g,opts):g;
      const bodyVisible=filtered && (filtered.shapes.length || filtered.pads?.length || filtered.pins?.length);
      if(doc.kind==="pcb" && T && filtered){
        // An inscription can extend far past every pad and shape anchor.
        // The flipped PCB definition already carries side and mirror properties.
        for(const shape of filtered.shapes)if(shape.kind==="text"){
          const distance=T.hitDistance(footprintText(shape,i,doc),p,{frame:i,layer:PCB.shapeLayer(i,shape)});
          if(distance<=tol)return distance;
        }
      }
      const box=localBox(filtered);
      const dist=Math.hypot(Math.max(box[0]-q[0],q[0]-box[2],0),Math.max(box[1]-q[1],q[1]-box[3],0));
      if(bodyVisible && (dist<=tol||doc.kind==="pcb"&&filtered.pads?.some(p=>p.padStack||p.poly))){
        let nearest=Infinity;
        for(const pad of filtered.pads || [])nearest=Math.min(nearest,distanceToPad(q,pad,opts.layer||"Top",layerOf(i,pad)));
        for(const shape of filtered.shapes)if(doc.kind!=="pcb" || !T || shape.kind!=="text")nearest=Math.min(nearest,distanceToShape(q,shape));
        for(const pin of filtered.pins || [])if(!pin.hidden)nearest=Math.min(nearest,gap(q,[pin.x,pin.y]));
        if(nearest<=tol)return nearest;
      }
      // Inside its body (courtyard, else footprint box) a part is picked below anything over it; the smaller body wins.
      if(doc.kind==="pcb"&&bodyVisible){const c=def?.footprint?.courtyard;if(c?.length>2?AtriumBoardShape.polyContains(c,q):!dist){bodyHit=true;const a=(box[2]-box[0])*(box[3]-box[1]);return tol*a/(a+100);}}
      if(doc.kind==="pcb"){
        for(const row of PCB.partText(doc,i,def)){
          if(!PCB.visible(row.text.layer,i,opts) || row.kind==="annotation" && row.text.size*scale<=3.3)continue;
          const distance=partTextDistance(row,doc,p);
          if(distance<=tol)return row.kind==="reference" && T?distance:tol;
        }
        return Infinity;
      }
      const pos=referencePositions(i,def,doc.kind,scale);
      const labels=[[i.ref,i.refAt,pos.ref,pos.refSize,i.showRef],[i.value,i.valueAt,pos.value,pos.valSize,i.showValue]];
      for(const [name,offset,defaultAt,size,show] of labels) {
        const at=offset?A.world(offset,i):defaultAt;
        if(show===false || !name || !at || !size)continue;
        const w=size*.64*name.length,start=!offset && pos.align==="center"?at[0]-w/2:at[0];
        if(p[0]>=start && p[0]<=start+w && p[1]>=at[1]-size && p[1]<=at[1]+size*.15)return tol;
      }
      return Infinity;
    }
    if(i.kind==="label"&&doc.kind==="pcb"&&T)return T.hitDistance(boardText(i,doc),p);
    if(i.kind==="label" || i.kind==="netlabel")b=textBox(i,doc.kind==="pcb");
    else if(i.kind==="via" || i.kind==="pad")return distanceToPad(p,i,opts.layer||"Top");
    else return gap(p,[i.x,i.y]);
    const boxDistance=Math.hypot(Math.max(b[0]-p[0],p[0]-b[2],0),Math.max(b[1]-p[1],p[1]-b[3],0));
    return i.kind==="netlabel"&&doc.kind==="schematic"?Math.min(boxDistance,gap(p,[i.x,i.y])):boxDistance;
  }
  // ---- Large boards: cache keys, content snapshots and level of detail ----
  // Library revision: one number per distinct library content (def, footprint and symbol
  // identities), so each edit's fresh defs map and every split pane share caches.
  const objectIds=new WeakMap(),libraryKeys=new Map(),libraryRevs=new WeakMap();let nextObject=0,nextLibrary=0;
  // Edit epoch: the editor keeps one defs map per library content, so a host that changed items in
  // place calls edited() (editor.js refreshDefs) and each view's next sync() compares its items with their snapshots.
  let editEpoch=0,pendingGeometry=0;
  const oid=o=>{if(!o||typeof o!=="object")return 0;let n=objectIds.get(o);if(!n){n=++nextObject;objectIds.set(o,n);}return n;};
  function libraryRevision(defs){
    if(!defs || typeof defs!=="object")return 0;
    let rev=libraryRevs.get(defs);
    if(rev===undefined){
      let sig="";
      if(typeof defs[Symbol.iterator]==="function")for(const [k,d] of defs)sig+=k+":"+oid(d)+"."+oid(d?.footprint)+"."+oid(d?.symbol)+";";
      rev=libraryKeys.get(sig);
      if(rev===undefined){if(libraryKeys.size>64)libraryKeys.clear();rev=++nextLibrary;libraryKeys.set(sig,rev);}
      libraryRevs.set(defs,rev);
    }
    return rev;
  }
  // Content snapshots: an item's own data flattened into an array. An edit that keeps the item
  // array but changes items in place is found by walking each item against its snapshot.
  const ARR={},OBJ={},END={};
  function flatten(v,out,depth){
    if(typeof v!=="object" || v===null || depth>12){out.push(v);return out;}
    if(Array.isArray(v)){
      out.push(ARR,v.length);
      for(let n=0;n<v.length;n++){const x=v[n];if(typeof x==="object" && x!==null)flatten(x,out,depth+1);else out.push(x);}
      return out;
    }
    out.push(OBJ);
    for(const k in v){const x=v[k];out.push(k);if(typeof x==="object" && x!==null)flatten(x,out,depth+1);else out.push(x);}
    out.push(END);
    return out;
  }
  let walk=null,at=0;
  const same=(x,v)=>x===v || (x!==x && v!==v);
  function matches(v,depth){
    if(typeof v!=="object" || v===null || depth>12)return same(walk[at++],v);
    if(Array.isArray(v)){
      if(walk[at++]!==ARR || walk[at++]!==v.length)return false;
      for(let n=0;n<v.length;n++){const x=v[n];if(typeof x==="object" && x!==null){if(!matches(x,depth+1))return false;}else if(!same(walk[at++],x))return false;}
      return true;
    }
    if(walk[at++]!==OBJ)return false;
    for(const k in v){
      if(walk[at++]!==k)return false;
      const x=v[k];
      if(typeof x==="object" && x!==null){if(!matches(x,depth+1))return false;}else if(!same(walk[at++],x))return false;
    }
    return walk[at++]===END;
  }
  const snapshot=i=>flatten(i,[],0);
  function unchanged(i,s){if(!s)return false;walk=s;at=0;const ok=matches(i,0) && at===s.length;walk=null;return ok;}
  // Document-level data (outline, rules, drawing tables) as one 32-bit hash.
  const f64=new Float64Array(1),u32=new Uint32Array(f64.buffer),FNV=16777619;
  function hashInto(h,v,depth){
    if(typeof v==="number"){f64[0]=v;return Math.imul(Math.imul(h^u32[0],FNV)^u32[1],FNV);}
    if(typeof v==="string"){h=Math.imul(h^v.length,FNV);for(let n=0;n<v.length;n++)h=Math.imul(h^v.charCodeAt(n),FNV);return h;}
    if(typeof v!=="object" || v===null || depth>12)return Math.imul(h^(v===true?1:v===false?2:v===null?3:4),FNV);
    if(Array.isArray(v)){h=Math.imul(h^v.length^0x54,FNV);for(let n=0;n<v.length;n++)h=hashInto(h,v[n],depth+1);return h;}
    let c=0;for(const k in v){c++;h=hashInto(hashInto(h,k,depth+1),v[k],depth+1);}
    return Math.imul(h^c,FNV);
  }
  // Poured copper and its signatures are left out: no item cache reads them, and hashing every
  // pour's encoded contours on each edit was slow. pourPrint() tracks them by identity instead.
  const POUR_KEYS=new Set(["pours","pourSignatures","pourSignatureVersion","importedPourSignature","sourceHatchSignature"]);
  function docPrint(doc){
    let h=0x811c9dc5;
    for(const k in doc){
      if(k==="items" || k==="sourcePourSignature")continue;
      h=hashInto(h,k,0);
      const v=doc[k];
      if(k==="pcbDrawing" && v && typeof v==="object" && !Array.isArray(v)){
        let c=0;for(const n in v)if(!POUR_KEYS.has(n)&&!globalThis.AtriumPourMarker?.isKey(n)){c++;h=hashInto(hashInto(h,n,2),v[n],2);}
        h=Math.imul(h^c,FNV);
      }else h=hashInto(h,v,1);
    }
    return h;
  }
  function pourPrint(doc){
    const d=doc.pcbDrawing,pours=d?.pours,out=[d,doc.sourcePourSignature,d?.pourSignatures,d?.pourSignatureVersion,globalThis.AtriumPourMarker?.read(d),d?.importedPourSignature,d?.sourceHatchSignature,pours,Array.isArray(pours)?pours.length:-1];
    const k=globalThis.AtriumPCBPours?.dataKey,data=r=>k?k(r):r?.data;
    if(Array.isArray(pours))for(const r of pours)out.push(r,data(r),r?.count,r?.polygon,r?.net,r?.layer,r?.links,...(r?.bounds||[]));
    return out;
  }
  const samePrint=(a,b)=>a.length===b.length && a.every((v,n)=>same(v,b[n]));
  const LOD_MIN=1500, LOD_CATS_ITEMS=["t","li","hi"], LOD_CATS_PARTS=["pf","ps","pl","ph"];
  const OPEN_OVERVIEW_MIN=20000, OPEN_OVERVIEW_ITEMS=900;
  const hasPath2D=typeof Path2D==="function";
  const needsBoardBatches=doc=>doc?.kind==="pcb" && doc.items?.length>=LOD_MIN;
  // Shrink before growing the other axis so neither assignment allocates an oversized intermediate.
  function resizeBacking(canvas,w,h){
    if(canvas.height>h)canvas.height=h;
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
  }
  let batches;
  function boardBatches(){
    return batches ||= globalThis.AtriumCanvasBoardBatches?.create({A,PCB,T,chosen,netInk,boardLayer,union,appendArc});
  }
  // Both renderers round grid lines here, before a conversion to GPU floats.
  function eachGridLine(origin,limit,spacing,dpr,pass,draw){
    const major=pass&1,odd=pass<2;
    for(let k=Math.ceil(-origin/spacing);;k++){
      const position=origin+k*spacing;if(position>limit)break;
      if(((k%5)===0)==major&&((k&1)!==0)===odd)draw(Math.round(position*dpr));
    }
  }
  function create(canvas) {
    let ctx=canvas.getContext("2d");
    let scale=8, referenceScale=8, cx=0, cy=0, width=0,height=0,dpr=1;
    // This view's internals for canvas-fast.js (lazy).
    const I={netLabels:()=>netLabels,canvas,paint,sync,worldToScreen,drawItem,frame:()=>last,openingOverview:()=>!!openingOverview,armIdle:()=>armIdle(),repaint:()=>repaint?.(),surfacesLost(){finishGesture();shown=null;},size:null,drawBoard,paintTop,query,lodFor,canBatch,paintLayers,paintOrder,pourState,pourFrame,airwireConnectivity,padText,cam:()=>[cx,cy,scale,flipped,width,height,dpr],
      // Runs f with the camera at (x, y, s), then restores it (canvas-gpu.js prepares a wider gesture layer).
      withCamera(x,y,s,f){const a=cx,b=cy,k=scale;cx=x;cy=y;scale=s;try{return f();}finally{cx=a;cy=b;scale=k;}},
      // Exposed pan strips in the caller's units, [x0, y0, x1, y1]. The full-width strip owns the corner.
      exposedPanStrips(width,height,ax,ay,opts){
        const top=ay>0?ay:0,bottom=ay<0?height+ay:height,strips=[];
        if(ay>0)strips.push([0,0,width,ay]);else if(ay<0)strips.push([0,height+ay,width,height]);
        if(ax>0)strips.push([0,top,ax,bottom]);else if(ax<0)strips.push([width+ax,top,width,bottom]);
        for (const overlay of opts?.overlay || []) {
          if (typeof overlay?.panDamage !== "function") continue;
          const frame = {canvas, scale, dpr, worldToScreen, worldViewport, selectable, options: opts, copper, width, height};
          for (const rect of overlay.panDamage(frame, ax, ay)) appendPanDamage(strips, rect, width, height);
        }
        return strips;
      },
      layerRank:(l,opts)=>layerRank(l,opts,flipped),
      boardTransform(){const o=worldToScreen([0,0]),k=scale*dpr,f=flipped?-k:k,c=rotation?.cos??1,s=rotation?.sin??0;ctx.setTransform(f*c,f*s,-k*s,k*c,o[0]*dpr,o[1]*dpr);ctx.lineJoin="round";ctx.lineCap="round";},
      get ctx(){return ctx},set ctx(v){ctx=v},get cache(){return cache},set cache(v){cache=v},
      get connectivity(){return connectivity},set connectivity(v){connectivity=v},get pourCache(){return pourCache},set pourCache(v){pourCache=v},
      get lodUsed(){return lodUsed},set lodUsed(v){lodUsed=v},get orderUsed(){return orderUsed},set orderUsed(v){orderUsed=v},
      set lodForce(v){lodForce=v},set orderForce(v){boardOrder.force=v&&new Map(v.map((l,i)=>[l,i]))},get exactNext(){return exactNext},drawAirwires,artworkViewport};
    let cache=null, connectivity=null, pourCache=null, revs=0, repaint=null, deferred=null, preparing=null, openingOverview=null;
    const openedBoards=new WeakSet();
    let writePending=false, waitForSave=false, heldPourDoc=null;
    // View → Flip Board: the camera mirrors X (viewed from the bottom); the model is untouched.
    let flipped=false,rotation=null;
    // The spatial index and every content cache are keyed on the document, its item array and the
    // library revision. An edit that keeps those (a fresh defs map from the same library) is found
    // by comparing each item with its snapshot, and only the changed items are re-indexed.
    function rememberProjectText(map,doc,item,defs){
      if(doc.kind!=="pcb" || !T?.hasProjectText)return;
      let uses;
      function add(shape){
        if(T.hasProjectText(shape))(uses||=new Map()).set(shape.text,boardText(shape,doc).text);
      }
      if(item.kind==="label")add(item);
      if(item.kind==="part"){
        for(const shape of variableFootprintText.get(getDef(defs,item,doc)?.footprint)||[])add(A.special(shape,item));
        if(T.hasProjectText({text:item.value}) || T.hasProjectText({text:item.ref}))
          for(const row of PCB.partText(doc,item,getDef(defs,item,doc)))if(row.kind==="annotation")add(row.text);
      }
      if(uses)map.set(item,uses);else map.delete(item);
    }
    function rebuild(doc,defs,lib,capturePrints=false){
      const from=cache?.doc===doc?cache.rev:null;
      const boxes=new Map(),prints=new Map(),byId=new Map(),parameterLabels=new Map(),viaMarks=new Set(),all=[];let bounds=null;
      // Bounds and artwork come from the entire board on the first frame. The change
      // snapshots and pick grid can follow in idle slices without delaying that frame.
      const preparation=doc.kind==="pcb" && doc.items.length>=1000 && repaint && canvas.isConnected &&
        globalThis.AtriumIdle && globalThis.AtriumSpatial ? {next:0,index:null} : null;
      for(const i of doc.items){
        if(!preparation || capturePrints)prints.set(i,snapshot(i));
        byId.set(i.id,i);
        if(mayHaveViaMark(i))viaMarks.add(i);
        const b=objectBox(i,doc,defs);
        rememberProjectText(parameterLabels,doc,i,defs);
        if(b && b.every(Number.isFinite)){boxes.set(i,b);all.push(i);bounds=bounds?union(bounds,b):b.slice();}
      }
      const store=globalThis.AtriumUndoStore;
      const panel=doc.panelView && globalThis.AtriumPanel?.projectionOf(doc);
      cache={doc,defs,items:doc.items,length:doc.items.length,lib,index:null,boxes,prints,byId,all,bounds,parameterLabels,viaMarks,docSig:docPrint(doc),pourSig:pourPrint(doc),rev:++revs,lod:null,epoch:editEpoch,preparation,
        panel:panel?.records?panel:null,panelRevision:panel?.revision,
        seq:store?.recordedChanges?.(doc,null).seq,outer:store?.outer?.(),libraryVersion:store?.libraryVersion?.(),pendingGeometry,delta:null};
      if(from!=null)globalThis.AtriumCanvasFast?.damage?.(I,doc,{from,to:cache.rev,known:false});
    }
    // A whole-design view needs bounds only. A partial view or a hit builds the grid on demand.
    function spatial(c){
      if(!c.index && globalThis.AtriumSpatial)c.index=AtriumSpatial.create(c.doc.items,i=>c.boxes.get(i),c.doc.kind==="pcb"?4:10);
      return c.index;
    }
    function cancelPreparation(){
      if(!preparing)return;
      globalThis.AtriumIdle.cancel(preparing.id);preparing=null;
    }
    function prepareGeometry(){
      const c=cache,pending=c?.preparation,idle=globalThis.AtriumIdle;
      if(preparing?.cache!==c || preparing?.pending!==pending)cancelPreparation();
      if(preparing || !pending || last?.[0]!==c.doc || globalThis.AtriumPower?.visible?.()===false)return;
      const job=preparing={cache:c,pending,id:null};
      job.id=idle.idle(deadline=>{
        if(preparing!==job)return;
        preparing=null;
        if(cache!==c || c.preparation!==pending || last?.[0]!==c.doc || c.epoch!==editEpoch ||
          !repaint || !canvas.isConnected || globalThis.AtriumPower?.visible?.()===false)return;
        const start=clock();
        pending.index??=AtriumSpatial.create([],i=>c.boxes.get(i),4);
        while(pending.next<c.items.length){
          const at=pending.next++,i=c.items[at];
          if(!c.prints.has(i))c.prints.set(i,snapshot(i));
          pending.index.insert(i,at);
          if(pending.next%32===0 && (clock()-start>=4 || (deadline.timeRemaining?.()??0)<1))break;
        }
        if(pending.next===c.items.length){c.index=pending.index;c.preparation=null;}
        else prepareGeometry();
      });
    }
    // Built only after an infinite sheet changes. Each moved item replaces one leaf.
    // Recomputing its ancestors lets an extremum shrink without walking the document.
    function extentTree(boxes){
      let base=1;while(base<boxes.size)base*=2;
      const tree=new Array(base*2), leaves=new Map();let pos=base;
      const combine=n=>{const a=tree[n*2],b=tree[n*2+1];tree[n]=a&&b?union(a,b):a||b;};
      for(const [item,box] of boxes){leaves.set(item,pos);tree[pos++]=box;}
      for(let n=base-1;n>0;n--)combine(n);
      return {bounds:()=>tree[1]||null,update(item,box){
        let n=leaves.get(item);if(n==null)return;
        tree[n]=box;while((n=Math.floor(n/2))>0)combine(n);
      }};
    }
    // complete: the changed list is exact without the undo journal's ids (a full scan compared every item
    // with its print, or the editor named the items it changed in place); structural changes need known ids.
    function apply(changed,poursChanged=false,known=false,removed=[],complete=known,exact=false){
      const c=cache,priorBounds=c.bounds;let box=null,shrinking=false,sizeDelta=0;
      const added=changed.filter(i=>c.byId.get(i.id)!==i),structural=!!(added.length || removed.length);
      if(!exact && c.preparation && (changed.length || removed.length))c.incrementalGeometry=true;
      let appendOnly=true;
      if(structural){
        if(!known){cache=null;return;}
        const gone=new Set(removed.map(r=>r.item)),fresh=new Set(added),before=c.all.filter(i=>!gone.has(i));
        let pos=0,sawNew=false;
        for(const i of c.doc.items){
          if(fresh.has(i)){sawNew=true;continue;}
          if(!c.boxes.has(i))continue;
          if(before[pos++]!==i){cache=null;return;}
          if(sawNew)appendOnly=false;
        }
        if(pos!==before.length){cache=null;return;}
        for(const {id,item} of removed){
          const old=c.boxes.get(item);if(old)box=box?union(box,old):old.slice();
          c.index?.remove(item);if(c.lod)batches.remove(c.lod,item);
          sizeDelta-=c.prints.get(item)?.length||0;
          c.boxes.delete(item);c.prints.delete(item);c.byId.delete(id);c.parameterLabels.delete(item);c.viaMarks.delete(item);
        }
      }
      if(c.airwireWitness===null)c.airwireWitness=namedCopper(changed,c.defs,c.doc);
      else if(c.airwireWitness && (changed.includes(c.airwireWitness) || removed.some(r=>r.item===c.airwireWitness)))
        c.airwireWitness=undefined;
      for(const i of changed){
        const old=c.boxes.get(i);
        const print=snapshot(i),before=c.prints.get(i);
        if(before || c.byId.get(i.id)!==i)sizeDelta+=print.length-(before?.length||0);
        c.byId.set(i.id,i);c.prints.set(i,print);
        if(mayHaveViaMark(i))c.viaMarks.add(i);else c.viaMarks.delete(i);
        const b=objectBox(i,c.doc,c.defs);
        rememberProjectText(c.parameterLabels,c.doc,i,c.defs);
        const valid=b&&b.every(Number.isFinite);
        if(!structural && !!old!==!!valid){cache=null;return;}
        if(exact && old?.some((v,n)=>v===priorBounds[n] && v!==b[n]))shrinking=true;
        if(old)box=box?union(box,old):old.slice();
        if(valid){c.boxes.set(i,b);c.bounds=c.bounds?union(c.bounds,b):b.slice();box=box?union(box,b):b.slice();}
        else c.boxes.delete(i);
        c.index?.update(i);
        c.preparation?.index?.update(i);
        if(c.lod){
          if(exact){
            if(!batches.replace(c.lod,i,c.defs,c.boxes.get(i),c.doc))c.lod=null;
          }else{
            batches.remove(c.lod,i);batches.add(c.lod,i,c.defs,c.boxes.get(i),c.doc);
          }
        }
      }
      if(exact){
        if(shrinking){
          c.bounds=null;
          for(const b of c.boxes.values())c.bounds=c.bounds?union(c.bounds,b):b.slice();
        }
        if(c.bounds && !samePrint(priorBounds,c.bounds))c.lod=null;
      }
      if(structural){c.length=c.doc.items.length;c.all=c.doc.items.filter(i=>c.boxes.has(i));c.index?.reorder(c.doc.items);
        if(c.preparation)c.preparation={next:0,index:null};}
      if(SCH?.isInfinite(c.doc) && (changed.length || removed.length)){
        if(structural || !c.extents)c.extents=extentTree(c.boxes);
        else for(const item of changed)c.extents.update(item,c.boxes.get(item));
        c.bounds=c.extents.bounds();
        // When the right or bottom edge moves, the title block moves too.
        if(c.doc.sheet.titleBlock && c.doc.sheet.titleBlock!=="none" &&
          (priorBounds?.[2]!==c.bounds?.[2] || priorBounds?.[3]!==c.bounds?.[3]))known=false;
      }
      // itemsKnown: changed and removed are every item that changed (box covers them), even when the
      // pours changed too; known also says the pours did not change.
      c.delta={from:c.rev,to:++revs,changed,removed,appendOnly,box,poursChanged,known:known&&!poursChanged,itemsKnown:known||complete&&!structural,sizeDelta};c.rev=c.delta.to;
      globalThis.AtriumCanvasFast?.damage?.(I,c.doc,c.delta);
      globalThis.AtriumCanvasGPU?.damage?.(I,c,c.delta);
    }
    function sync(doc,defs){
      if(doc.kind==="pcb"){
        const explicit=last?.[0]===doc && last[2]?.project;
        if(explicit)textProjects.set(doc,explicit);else textProjects.delete(doc);
      }
      if(cache && cache.doc!==doc)globalThis.AtriumCanvasFast?.park(I,doc);
      const version=syncPaintGeometry();
      const lib=libraryRevision(defs);
      const store=globalThis.AtriumUndoStore;
      const prior=cache?.doc===doc && cache.parameterVersions;
      const project=doc.kind==="pcb" && cache?.doc===doc && cache.parameterLabels.size?textProject(doc):null;
      const committed=project?store?.documentVersions?.(doc,project):null;
      const panel=cache?.doc===doc && cache.panel;
      const ink=panel && panel.revision!==cache.panelRevision && AtriumPanel.projectedChanges(panel,cache.panelRevision);
      if(ink?.kind==="incremental" && cache.items===doc.items && cache.pendingGeometry===pendingGeometry){
        cache.panelRevision=panel.revision;cache.defs=defs;cache.lib=lib;cache.libraryVersion=version;cache.epoch=editEpoch;
        const items=ink.owners.map(owner=>cache.byId.get(AtriumPanel.projectedItem(panel,owner))).filter(Boolean);
        if(items.length)apply(items,false,true,[],true,true);
        if(!cache)rebuild(doc,defs,lib);
      }else if(!cache || cache.doc!==doc || cache.items!==doc.items || cache.lib!==lib || cache.libraryVersion!==version ||
        cache.pendingGeometry!==pendingGeometry || ink)rebuild(doc,defs,lib);
      else if(cache.length!==doc.items.length || cache.defs!==defs || cache.epoch!==editEpoch){
        const changes=store?.recordedChanges?.(doc,cache.seq),outer=store?.outer?.();
        const projectOnly=committed && prior && project===cache.parameterProject && committed.parameters!==prior.parameters &&
          committed.items===prior.items && committed.outer===prior.outer && committed.pours===prior.pours &&
          changes?.ids?.size===0 && cache.length===doc.items.length;
        const docChanged=!projectOnly && (outer!==cache.outer || !changes?.ids?.size) && docPrint(doc)!==cache.docSig;
        const known=!docChanged && changes?.ids?.size>0 && (cache.defs===defs || version!=null);
        if(changes?.seq!=null)cache.seq=changes.seq;
        cache.outer=outer;
        cache.defs=defs;cache.epoch=editEpoch;
        // An unjournaled edit needs a complete baseline. Capture it once without building the grid.
        const exactFallback=!!cache.preparation && !known && !projectOnly;
        const noBaseline=exactFallback && (cache.prints.size!==cache.length || cache.incrementalGeometry);
        if(docChanged || !known && (cache.length!==doc.items.length || noBaseline))
          rebuild(doc,defs,lib,exactFallback);
        else if(!projectOnly){
          // New copper or signatures: a new revision for the caches that read them (pour state,
          // connectivity, the board layer), without re-indexing the items.
          const ps=pourPrint(doc),poursChanged=!samePrint(ps,cache.pourSig);if(poursChanged)cache.pourSig=ps;
          const changed=[],removed=[];
          if(known)for(const id of changes.ids){const prior=cache.byId.get(id);if(prior && prior!==changes.items.get(id))removed.push({id,item:prior});}
          const all=cache.all, allHaveBounds=all.length===doc.items.length;
          let at=0,reordered=false;
          for(const i of known?changes.items.values():doc.items){
            if(!known && (allHaveBounds || cache.boxes.has(i)) && all[at++]!==i){reordered=true;break;}
            if(!unchanged(i,cache.prints.get(i)))changed.push(i);
          }
          if(reordered)rebuild(doc,defs,lib,exactFallback);
          else{
            if(changed.length || removed.length || poursChanged)apply(changed,poursChanged,known,removed,known || cache.length===doc.items.length,exactFallback);
            if(!cache)rebuild(doc,defs,lib,exactFallback);
          }
        }
      }
      if(cache.parameterLabels.size){
        const project=textProject(doc),versions=committed || store?.documentVersions?.(doc,project),version=versions?.parameters;
        if(version==null || version!==cache.parameterVersions?.parameters || project!==cache.parameterProject){
          cache.parameterProject=project;
          textRevisions.set(doc,{project,version});
          const changed=[],values=new Map();
          for(const [item,uses] of cache.parameterLabels)for(const [expression,prior] of uses){
            if(!values.has(expression))values.set(expression,A.projectText(project,expression));
            if(values.get(expression)!==prior){changed.push(item);break;}
          }
          if(changed.length){
            const before=cache.rev;
            apply(changed,false,true);
            if(connectivity?.doc===doc && connectivity.rev===before)connectivity.rev=cache.rev;
            if(pourCache?.doc===doc && pourCache.rev===before)pourCache.rev=cache.rev;
          }
        }
        cache.parameterVersions=versions;
      }
      return cache;
    }
    function pourState(doc,defs){
      if(globalThis.AtriumPourAnim?.active?.(doc))return "source";
      if(!Array.isArray(doc.pcbDrawing?.pours) || !doc.pcbDrawing.pours.length || !globalThis.AtriumPCBPours)return "none";
      const {rev,pourSig}=sync(doc,defs);
      // A verdict from the board stamp alone is replaced once the pour engine has loaded.
      if(!pourCache || pourCache.doc!==doc || pourCache.rev!==rev || !pourCache.engine&&globalThis.AtriumPolygonPour){
        // The edit frame paints the changed objects with the retained artwork.
        // Recheck its copper signature when the save releases the projection.
        if(writePending&&repaint&&pourCache?.doc===doc&&pourCache.pourSig&&
          (pourCache.pourSig===pourSig||samePrint(pourCache.pourSig,pourSig))){
          heldPourDoc=doc;return pourCache.state;
        }
        // The pour engine also flags settings-only polygon changes as stale.
        const state=globalThis.AtriumPolygonPour?(AtriumPolygonPour.displayState||AtriumPolygonPour.state)(doc,defs):AtriumPCBPours.matchesSignature(doc,defs)?"source":"stale";
        pourCache={doc,rev,state,pourSig,engine:!!globalThis.AtriumPolygonPour};
        if(heldPourDoc===doc)heldPourDoc=null;
      }
      return pourCache.state;
    }
    // The renderer, its layer-order lookup and overlays read the same list in
    // this frame. Do not resolve live copper for views that never paint it.
    function pourFrame(doc,defs,opts){
      let state,pours;
      return {
        get state(){return state??=pourState(doc,defs);},
        get pours(){
          if(pours!==undefined)return pours;
          const live=globalThis.AtriumPolygonPour;
          const show=!opts.hidden?.has("Source pours") &&
            (!opts.transientGeometry || !!live?.tiles?.dragVisible?.(doc)) && this.state==="source";
          return pours=show?(live?.displayPours?.(doc)||doc.pcbDrawing?.pours||null):null;
        }
      };
    }
    const clock=()=>globalThis.performance?.now?.()??0;
    function saveConnectivity(doc,rev,result,cost){connectivity={doc,rev,result,index:null,cost};}
    const showingAirwires=()=>last?.[0].kind==="pcb"&&last[2].showUnrouted&&!last[2].transientGeometry;
    function cancelAirwires(){
      const job=deferred?.job;deferred=null;job?.cancel();
    }
    // The save's acknowledgement wakes the requested derived display.
    // Continue drawing geometry and the last completed overlay meanwhile.
    function saveWritePending(pending){
      if(writePending===pending)return;
      writePending=pending;
      if(pending){
        waitForSave=!!deferred;cancelAirwires();
      }else{
        const repaintAirwires=waitForSave&&showingAirwires();
        const repaintPours=heldPourDoc&&last?.[0]===heldPourDoc&&!last[2].hidden?.has("Source pours");
        waitForSave=false;
        heldPourDoc=null;
        if(repaintAirwires||repaintPours)repaint?.();
      }
    }
    function boardConnectivity(doc,defs) {
      if(doc.kind!=="pcb")return null;
      const rev=sync(doc,defs).rev;
      if(!connectivity || connectivity.doc!==doc || connectivity.rev!==rev){
        if(deferred?.doc===doc)cancelAirwires();
        if(last?.[0]===doc)waitForSave=false;
        const t=clock(),result=AtriumConnectivity.inspect(doc,defs);
        saveConnectivity(doc,rev,result,clock()-t);
      }
      return connectivity.result;
    }
    // The physical inspector groups named entities into islands. With no net on any board item,
    // placed pin or used footprint, the airwire overlay is empty for every possible contact graph.
    function namedCopper(items,defs,doc){
      const footprints=new Set();
      for(const item of items){
        if(item.net || item.pinNets && Object.values(item.pinNets).some(Boolean))return item;
        if(item.kind!=="part")continue;
        const fp=getDef(defs,item,doc)?.footprint;
        if(fp && !footprints.has(fp)){
          if(fp.pads?.some(p=>p.net) || fp.shapes?.some(s=>s.net))return item;
          footprints.add(fp);
        }
      }
      return null;
    }
    function hasAirwireSource(c){
      if(c.airwireWitness===undefined)c.airwireWitness=namedCopper(c.doc.items,c.defs,c.doc);
      if(c.airwireWitness)return true;
      if(connectivity && (connectivity.doc!==c.doc || connectivity.rev!==c.rev))connectivity=null;
      if(deferred)cancelAirwires();
      waitForSave=false;
      return false;
    }
    // Airwires update after the changed copper is painted. Explicit connectivity queries
    // still use boardConnectivity() directly when the caller needs an immediate result.
    const acquiredPourGraphs=new WeakMap();
    function waitingForInitialPourContacts(c) {
      const doc=c.doc;
      if(acquiredPourGraphs.get(doc)===true || !hasAirwireSource(c))return false;
      const host=globalThis.AtriumNavHost,rev=host?.revision?.();
      if(host?.doc?.()!==doc)return false;
      // An unsaved import is not an edit; a later revision is.
      if(!acquiredPourGraphs.has(doc))acquiredPourGraphs.set(doc,rev);
      const folder=host.folderProject?.();
      if(acquiredPourGraphs.get(doc)!==rev && (folder ? folder.modified(doc.id) : host.isDirty?.())){
        acquiredPourGraphs.set(doc,true);
        return false;
      }
      const pours=globalThis.AtriumPolygonPour;
      if(!pours){
        if(!c.requestedPourContacts && globalThis.AtriumLazy?.need && globalThis.AtriumPower?.visible?.()!==false){
          c.requestedPourContacts=true;
          // Loading a board service already requests the editor's next frame.
          globalThis.AtriumLazy.need("AtriumPolygonPour").catch(error=>{
            c.requestedPourContacts=false;
            globalThis.AtriumDiagnostics?.failed?.(error);
          });
        }
        return true;
      }
      if(pours.live?.prepare?.(doc,c.defs)||pours.verifying(doc,c.defs))return true;
      acquiredPourGraphs.set(doc,true);
      return false;
    }
    function airwireConnectivity(doc,defs){
      const c=sync(doc,defs),rev=c.rev;
      const current=connectivity?.doc===doc && connectivity.rev===rev;
      if(!current && !hasAirwireSource(c))return null;
      if(doc.pcbDrawing?.pours?.length && waitingForInitialPourContacts(c)){
        if(connectivity?.doc===doc)connectivity=null;
        if(deferred?.doc===doc)cancelAirwires();
        return null;
      }
      if(current)return connectivity.result;
      if(writePending&&repaint){
        waitForSave=true;
        return connectivity?.doc===doc?connectivity.result:null;
      }
      const slow=connectivity?.doc===doc?connectivity.cost>12:doc.items.length>6000;
      const stage=globalThis.AtriumNavHost?.stageEdit;
      if(!repaint||!stage&&(!slow||typeof setTimeout!=="function"))return boardConnectivity(doc,defs);
      if(deferred?.doc!==doc||deferred.rev!==rev||!deferred.job?.current()){
        cancelAirwires();
        const request=deferred={doc,rev,job:null};
        const ready=()=>deferred===request&&cache?.doc===doc&&cache.rev===rev&&cache.epoch===editEpoch&&
          last?.[0]===doc&&showingAirwires()&&repaint&&!writePending&&(connectivity?.doc!==doc||connectivity.rev!==rev);
        const run=()=>{
          if(deferred!==request)return;
          const use=ready();
          cancelAirwires();
          if(use){boardConnectivity(doc,cache.defs);repaint();}
        };
        if(stage)request.job=globalThis.AtriumConnectivityLive?.deferAirwires?.(doc,cache.defs,globalThis.AtriumUndoStore,stage,canvas,ready,
          (result,cost,now)=>{deferred=null;saveConnectivity(doc,rev,result,cost);if(!now)repaint();},4)||stage("airwires",canvas,run);
        else{const timer=setTimeout(run,30);request.job={current:()=>deferred===request,cancel:()=>clearTimeout(timer)};}
      }
      return connectivity?.doc===doc?connectivity.result:null;
    }
    function drawAirwires(doc,defs,viewport,highlight,substrate,netColors) {
      const result=airwireConnectivity(doc,defs);
      if(!result?.airwires.length)return;
      const box=wire=>[Math.min(wire.from[0],wire.to[0]),Math.min(wire.from[1],wire.to[1]),
        Math.max(wire.from[0],wire.to[0]),Math.max(wire.from[1],wire.to[1])];
      if(!connectivity.index && result.airwires.length>128)globalThis.AtriumCanvasFast?.later(I,connectivity,box);
      const candidates=connectivity.index?connectivity.index.query(viewport):result.airwires;
      ctx.save();ctx.beginPath();let count=0;const tinted=netColors?.size?new Map():null;
      for(const w of candidates){
        if(highlight && w.net!==highlight)continue;
        if(!connectivity.index){
          const b=box(w);
          if(b[0]>viewport[2]||b[2]<viewport[0]||b[1]>viewport[3]||b[3]<viewport[1])continue;
        }
        const tint=tinted&&netColors.get(w.net);
        if(tint){if(!tinted.has(tint))tinted.set(tint,[]);tinted.get(tint).push(w);continue;}
        ctx.moveTo(w.from[0],w.from[1]);ctx.lineTo(w.to[0],w.to[1]);count++;
      }
      if(count){
        // Altium's "Connection Lines": thin, solid, one system color.
        ctx.strokeStyle=PCB.system.connection;
        ctx.lineWidth=(highlight?1.5:1)/scale;ctx.lineCap="butt";ctx.stroke();
      }
      if(tinted)for(const [tint,list] of tinted){
        ctx.beginPath();for(const w of list){ctx.moveTo(w.from[0],w.from[1]);ctx.lineTo(w.to[0],w.to[1]);}
        ctx.strokeStyle=tint;ctx.lineWidth=(highlight?2:1.5)/scale;ctx.lineCap="butt";ctx.stroke();
      }
      ctx.restore();
    }
    function query(doc,defs,box){
      if(!globalThis.AtriumSpatial)return doc.items;
      const c=sync(doc,defs),b=c.bounds;
      // A view that holds the whole design skips the grid walk and the sort.
      if(b && box[0]<=b[0] && box[1]<=b[1] && box[2]>=b[2] && box[3]>=b[3])return c.all.slice();
      // While the grid is being built, query every exact cached bound in document order.
      // Selection, snapping and the frame never consume a partial grid.
      if(c.preparation)return c.all.filter(item=>AtriumSpatial.overlaps(c.boxes.get(item),box));
      return spatial(c).query(box);
    }
    function paintLayers(doc,defs,i){
      if(i.kind!=="part"){
        const layer=boardLayer(i),openings=PCB.traceOpenings(i,layer);
        return openings.length?[layer,...openings.map(o=>o.layer)]:[layer];
      }
      const def=getDef(defs,i,doc), fp=def?.footprint;if(!fp)return [];
      return [...new Set([...PCB.footprintLayers(i,fp).map(g=>g.layer),...Array.from(PCB.partText(doc,i,def),r=>r.text.layer)])];
    }
    function canBatch(count,opts){return hasPath2D && !!globalThis.AtriumSpatial && count>=LOD_MIN && !opts.routePreview?.hidden?.length && !!boardBatches();}
    // Batched drawing for this frame, or null when the view shows few objects.
    function lodFor(doc,candidates,opts,viewport){
      const c=cache;
      if(c?.doc!==doc || !(lodForce==null?canBatch(candidates.length,opts):lodForce && boardBatches()))return null;
      if(!c.lod){
        const b=c.bounds||[0,0,1,1],size=Math.max(1,Math.sqrt(Math.max(1,(b[2]-b[0])*(b[3]-b[1]))*600/Math.max(1,c.all.length)));
        c.lod={size,chunks:new Map(),info:new Map(),layers:new Set()};
        for(const i of c.all)batches.add(c.lod,i,c.defs,c.boxes.get(i),c.doc);
      }
      const chunks=[],skip=opts.hide&&new Set([...opts.hide].map(i=>c.lod.info.get(i)?.chunk));
      const layers=c.lod.refreshLayers&&new Set();
      for(const ch of c.lod.chunks.values()){
        if(ch.dirty)batches.rebuild(c.lod,ch);
        if(layers)for(const layer of ch.layers.keys())layers.add(layer);
        const b=ch.box;
        if(b && !skip?.has(ch) && !(b[0]>viewport[2] || b[1]>viewport[3] || b[2]<viewport[0] || b[3]<viewport[1]))chunks.push(ch);
      }
      if(layers){c.lod.layers=layers;c.lod.refreshLayers=false;}
      return {info:c.lod.info,layers:c.lod.layers,chunks,skip};
    }
    function invalidate(doc,changed){
      globalThis.AtriumCanvasFast?.invalidate(I,doc,!!changed?.length);
      if(!doc||deferred?.doc===doc)cancelAirwires();
      if(!doc || connectivity?.doc===doc)connectivity=null;
      if(!doc || pourCache?.doc===doc)pourCache=null;
      if(!cache || (doc && cache.doc!==doc))return;
      if(!changed){cancelPreparation();cache=null;return;}
      // The editor names every item it changed in place (a live drag); the GPU scene updates exactly those.
      apply(changed,false,false,[],true);
    }
    function connectedWires(doc,defs,item){
      if(doc.kind!=="schematic"||item.kind!=="part")return [];
      const found=new Set();
      for(const pin of A.pins(item,getDef(defs,item,doc),doc.kind)){
        const [x,y]=pin.at,eps=.0001;
        for(const w of query(doc,defs,[x-eps,y-eps,x+eps,y+eps])){
          if(w.kind==="wire" && (A.same(w.points[0],pin.at)||A.same(w.points.at(-1),pin.at)))found.add(w);
        }
      }
      return [...found];
    }
    function dimensions(measured){
      // The size canvas-fast.js's ResizeObserver reports (no forced layout), else measured.
      globalThis.AtriumCanvasFast?.observe(I);
      const z=I.size,rect=measured?.width>=0&&measured?.height>=0?measured:z?null:canvas.getBoundingClientRect();
      width=rect?rect.width:z.w; height=rect?rect.height:z.h;
      dpr=bounded(globalThis.devicePixelRatio || 1,1,4);
      const w=Math.round(width*dpr),h=Math.round(height*dpr);
      resizeBacking(canvas,w,h);
    }
    function screenToWorld([x,y]) {if(rotation)[x,y]=rotation.point([x,y],width,height,true);return [(flipped?width/2-x:x-width/2)/scale+cx,(y-height/2)/scale+cy];}
    function worldToScreen([x,y]) {const p=[(flipped?cx-x:x-cx)*scale+width/2,(y-cy)*scale+height/2];return rotation?rotation.point(p,width,height):p;}
    function fit(doc,defs,scope,measured) {
      if(doc.kind==="panel" && globalThis.AtriumPanel)[doc,defs]=projectedPanel(doc,defs);
      dimensions(measured);
      let b;
      if(scope==="board" && doc.kind==="pcb" && doc.outline?.length>=3)b=A.bounds(doc.outline);
      const infinite=SCH?.isInfinite(doc);
      if(infinite)b=scope==="objects"?sync(doc,defs).bounds:drawingBounds(doc,defs);
      else if(scope==="document" && doc.kind==="schematic" && SCH)b=SCH.pageBounds(doc,defs);
      if(scope==="document" && doc.kind==="pcb"){
        b=A.bounds(doc.outline||[]);
        for(const i of doc.items){const itemBounds=objectBox(i,doc,defs);if(itemBounds)b=b?union(b,itemBounds):itemBounds;}
      }
      if(!b && scope==="objects" && doc.kind==="schematic" && SCH){
        for(const i of doc.items){const ext=objectBox(i,doc,defs);if(ext)b=b?union(b,ext):ext;}
      }
      b=b || A.docBounds(doc,defs);
      let w=Math.max(1.5,b[2]-b[0]),h=Math.max(1.5,b[3]-b[1]);if(rotation)[w,h]=rotation.span(w,h);
      const px=bounded(width*.09,24,78),py=bounded(height*.12,26,80);
      referenceScale=scale=bounded(Math.min(Math.max(20,width-2*px)/w,Math.max(20,height-2*py)/h),infinite?1e-9:.002,160);
      cx=(b[0]+b[2])/2;cy=(b[1]+b[3])/2;
      return scale;
    }
    const zoomScale=next=>bounded(next,Math.min(referenceScale,.0001),2000);
    function zoom(factor,anchor=[width/2,height/2]) {
      if(!Number.isFinite(factor) || factor<=0)return;
      const p=screenToWorld(anchor);scale=zoomScale(scale*factor);
      const q=screenToWorld(anchor);cx+=p[0]-q[0];cy+=p[1]-q[1];
    }
    function rotate(rad,at=[width/2,height/2]){
      const a=screenToWorld(at);setAngle((rotation?.rad||0)+rad);
      const b=screenToWorld(at);cx+=a[0]-b[0];cy+=a[1]-b[1];
    }
    function setAngle(rad){if((rotation?.rad||0)!==rad){rotation=globalThis.AtriumCanvasInput?.orientation(rad);shown=null;}}
    function angledGrid(step,fine,coarse){
      ctx.save();I.boardTransform();rotation.grid(ctx,artworkViewport(),step,scale,dpr,fine,coarse);ctx.restore();
    }
    // Maintain the model-space snap pitch as the minimum visible spacing.
    // At overview zoom each dot represents an integer multiple of the snap grid.
    function grid(step,ink=color.grid) {
      if(rotation)return angledGrid(step,ink);
      let spacing=step*scale;
      if(!(spacing>0 && Number.isFinite(spacing)))return;
      while(spacing<12)spacing*=2;

      const origin=worldToScreen([0,0]);
      const startX=((origin[0]%spacing)+spacing)%spacing, startY=((origin[1]%spacing)+spacing)%spacing;
      ctx.fillStyle=ink;
      const dot=1.15;
      for(let x=startX;x<width;x+=spacing)for(let y=startY;y<height;y+=spacing)ctx.fillRect(x-dot/2,y-dot/2,dot,dot);
    }
    // Altium-style line grid: fine lines on the snap pitch and a coarse line
    // every fifth. Spacing doubles until fine lines are at least 12 px apart; odd
    // lines fade out on the way. Lines are one device pixel, painted with fillRect.
    function lineGrid(step,fine,coarse,bg) {
      if(rotation)return angledGrid(step,fine,coarse);
      let spacing=step*scale;
      if(!(spacing>0 && Number.isFinite(spacing)))return;
      while(spacing<12)spacing*=2;
      const origin=worldToScreen([0,0]),W=width*dpr,H=height*dpr;
      ctx.save();ctx.setTransform(1,0,0,1,0,0);
      const fade=Math.min(1,(spacing-12)/12);
      // Faint odd lines go under the rest; past half strength, coarse over fine.
      for(const pass of fade<.5?[0,1,2,3]:[0,2,1,3]){
        const major=pass&1,odd=pass<2;
        if(odd&&fade<=0)continue;
        ctx.fillStyle=odd?tint(major?coarse:fine,bg,fade):major?coarse:fine;
        eachGridLine(origin[0],width,spacing,dpr,pass,x=>ctx.fillRect(x,0,1,H));
        eachGridLine(origin[1],height,spacing,dpr,pass,y=>ctx.fillRect(0,y,W,1));
      }
      ctx.restore();
    }
    // Altium's origin marker: a small circle with a cross at (0, 0).
    function originMarker(at=[0,0]) {
      const [x,y]=worldToScreen(at);
      if(x<-12 || y<-12 || x>width+12 || y>height+12)return;
      ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.strokeStyle=PCB.system.origin;ctx.lineWidth=1;
      ctx.beginPath();ctx.arc(Math.round(x)+.5,Math.round(y)+.5,5,0,Math.PI*2);
      ctx.moveTo(Math.round(x)-9,Math.round(y)+.5);ctx.lineTo(Math.round(x)+10,Math.round(y)+.5);
      ctx.moveTo(Math.round(x)+.5,Math.round(y)-9);ctx.lineTo(Math.round(x)+.5,Math.round(y)+10);
      ctx.stroke();ctx.restore();
    }
    // Board-shape edit handles: squares on vertices, circles on edge midpoints.
    function boardHandles(list,active) {
      ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.lineWidth=1;ctx.strokeStyle=PCB.system.selection;
      for(const h of list){
        const [x,y]=worldToScreen(h.at);if(x<-8||y<-8||x>width+8||y>height+8)continue;
        const on=!!active&&h.type===active.type&&h.ref.contour===active.ref.contour&&h.ref.index===active.ref.index;
        ctx.fillStyle=on?PCB.system.selection:PCB.system.workspace;ctx.beginPath();
        if(h.type==="vertex")ctx.rect(Math.round(x)-3.5,Math.round(y)-3.5,7,7);else ctx.arc(Math.round(x)+.5,Math.round(y)+.5,3,0,Math.PI*2);
        ctx.fill();ctx.stroke();
      }
      ctx.restore();
    }
    function scaleBar() {
      if(width<220 || height<130)return;
      const targetPx=Math.min(84,width*.19);
      const targetMm=targetPx/scale;
      const magnitude=10**Math.floor(Math.log10(targetMm));
      const ratio=targetMm/magnitude;
      const mm=(ratio>=5?5:ratio>=2?2:1)*magnitude;
      const unit=mm<1?"µm":mm>=1000?"m":"mm";
      const amount=unit==="µm"?mm*1000:unit==="m"?mm/1000:mm;
      const label="Scale "+Number(amount.toPrecision(6))+" "+unit;
      const right=width-18,left=right-mm*scale,top=17,bottom=21,mid=(right+left)/2;
      ctx.save();
      ctx.setTransform(dpr,0,0,dpr,0,0);
      // A thin halo keeps the readout visible over copper and the light canvas.
      ctx.beginPath();
      ctx.moveTo(left,top);ctx.lineTo(left,bottom);ctx.lineTo(right,bottom);ctx.lineTo(right,top);
      ctx.moveTo(mid,bottom);ctx.lineTo(mid,bottom-2.5);
      ctx.lineJoin="round";ctx.lineCap="butt";
      ctx.strokeStyle="rgba(18,21,26,.75)";ctx.lineWidth=2.7;ctx.stroke();
      ctx.strokeStyle="#b8c0c3";ctx.lineWidth=1;ctx.stroke();
      ctx.font="500 10px "+monoFont;ctx.textAlign="center";ctx.textBaseline="top";
      ctx.strokeStyle="#22262a";ctx.lineWidth=2.3;ctx.strokeText(label,mid,bottom+4);
      ctx.fillStyle="#d7dcdf";ctx.fillText(label,mid,bottom+4);
      ctx.restore();
    }
    // Interactive router preview (AtriumRouter / AtriumDiffPair session.move result), drawn in world space:
    // clearance outlines, the route's own clearance halo, shoved copper, the route itself and new vias.
    function drawRoutePreview(r,pointer){
      ctx.save();ctx.lineCap="round";ctx.lineJoin="round";
      const line=(pts,w)=>{if(!pts?.length)return;ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);for(let k=1;k<pts.length;k++)ctx.lineTo(pts[k][0],pts[k][1]);ctx.lineWidth=w;ctx.stroke();};
      const disc=(x,y,d,fill)=>{ctx.beginPath();ctx.arc(x,y,d/2,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();};
      ctx.globalAlpha=.18;ctx.strokeStyle=ctx.fillStyle="#9a9a9a";
      for(const b of r.boundaries||[]){
        if(b.points){ctx.beginPath();b.points.forEach(([x,y],k)=>k?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fill();ctx.lineWidth=2*b.r;ctx.stroke();}
        else line([b.a,b.b],2*b.r);
      }
      ctx.globalAlpha=1;
      if(r.halo?.points){ctx.strokeStyle="rgba(255,255,255,.12)";line(r.halo.points,r.halo.width);}
      ctx.globalAlpha=.9;
      for(const q of r.pushed||[]){
        if(q.points){ctx.strokeStyle=copper(q.layer||"Top");line(q.points,q.width||.25);}
        else if(Number.isFinite(q.x)){disc(q.x,q.y,q.diameter||.6,copper("Multi"));disc(q.x,q.y,q.drill||.3,PCB.system.hole);}
      }
      // Auto-shrink necks: an amber band along the narrowed section of the pair.
      ctx.globalAlpha=.35;ctx.strokeStyle="#f0a32e";
      for(const n of r.necks||[])line(n.points,n.gap+2*n.width+.12);
      ctx.globalAlpha=.9;
      const bad=r.status==="violation";
      for(const t of r.preview||[]){ctx.globalAlpha=t.head?.85:1;ctx.strokeStyle=bad&&t.head?"#ff4d4d":copper(t.layer||"Top");line(t.points,t.width||.25);}
      ctx.globalAlpha=1;
      for(const v of r.vias||[]){disc(v.x??v.at?.[0],v.y??v.at?.[1],v.diameter||.6,copper("Multi"));disc(v.x??v.at?.[0],v.y??v.at?.[1],v.drill||.3,PCB.system.hole);}
      if(r.status==="blocked"&&pointer){const k=4/scale,[x,y]=pointer;ctx.strokeStyle="#ff4d4d";ctx.lineWidth=1.5/scale;ctx.beginPath();ctx.moveTo(x-k,y-k);ctx.lineTo(x+k,y+k);ctx.moveTo(x+k,y-k);ctx.lineTo(x-k,y+k);ctx.stroke();}
      ctx.restore();
    }
    // A pan shifts the last frame by whole device pixels. For expensive zoom frames only
    // the design artwork is cached; the grid, page and tool overlays use the current camera.
    let gesture=false,shown=null,idle=0,last=null;
    const zoomLayers=[];
    const now=()=>globalThis.performance?.now?.()??Date.now();
    function armIdle(){
      if(typeof setTimeout!=="function")return;
      if(idle)clearTimeout(idle);
      idle=setTimeout(()=>{idle=0;exactNext=true;if(repaint)repaint();else if(last)render(...last);},140);
    }
    function finishGesture(){
      if(idle){clearTimeout(idle);idle=0;}
      for(const layer of zoomLayers)layer.canvas.width=layer.canvas.height=1;
      zoomLayers.length=0;
    }
    function zoomMarkKey(doc,defs,opts,frame){
      const key=globalThis.AtriumCanvasFast?.keyOf(I,doc,defs,opts,[],frame) ||
        [opts, opts.viaMarks, opts.layer, opts.layerMode, ...Object.values(PCB.system),
          ...Object.values(PCB.opacity), ...Object.entries(PCB.layerOpacity).flat(), ...(opts.hidden||[]), ...(opts.hide||[])];
      key.push(globalThis.AtriumViaStack,opts.selected,...(opts.selectedIds||[]));
      return key;
    }
    // Find the visible suffix at a camera scale without visiting unchanged marks.
    function visibleMarks(marks,scale){
      let low=0,high=marks.length;
      while(low<high){
        const mid=(low+high)>>>1,m=marks[mid];
        if(m.diameter*scale>=m.minDrillPx)high=mid;else low=mid+1;
      }
      return low;
    }
    function viaMarkDamage({layer,z},W,H){
      const marks=layer.marks;
      if(!marks?.length)return null;
      const before=layer.visibleMarks, after=visibleMarks(marks,scale);
      if(before===after)return null;
      const tiles=new Map(), size=Math.ceil(48*dpr),columns=Math.ceil(W/size);
      const margin=2*dpr+Math.ceil(Math.max(z,1));
      for(let n=Math.min(before,after),end=Math.max(before,after);n<end;n++){
        const {x,y,diameter}=marks[n],[sx,sy]=worldToScreen([x,y]),r=diameter*scale*dpr/2+margin;
        const [a,b,c,d]=[Math.max(0,Math.floor(sx*dpr-r)),Math.max(0,Math.floor(sy*dpr-r)),
          Math.min(W,Math.ceil(sx*dpr+r)),Math.min(H,Math.ceil(sy*dpr+r))];
        if(a>=c || b>=d)continue;
        for(let row=Math.floor(b/size);row*size<d;row++)for(let col=Math.floor(a/size);col*size<c;col++){
          const key=row*columns+col;
          const box=[Math.max(a,col*size),Math.max(b,row*size),Math.min(c,(col+1)*size),Math.min(d,(row+1)*size)];
          const prior=tiles.get(key);tiles.set(key,prior?union(prior,box):box);
        }
      }
      return tiles.size?tiles:null;
    }
    function paintZoomRepairs(tiles,layer,doc,defs,opts,substrate,frame){
      const prior=boardOrder.force, batching=lodForce, oldLOD=lodUsed,oldOrder=orderUsed;
      boardOrder.force=layer.order;lodForce=layer.lod;
      try{
        for(const box of tiles.values()){
          const [x0,y0,x1,y1]=box;
          ctx.save();
          try{
            ctx.setTransform(1,0,0,1,0,0);ctx.beginPath();ctx.rect(x0,y0,x1-x0,y1-y0);ctx.clip();
            I.boardTransform();paintArtwork(doc,defs,opts,box.map(x=>x/dpr),true,substrate,undefined,undefined,frame);
          }finally{ctx.restore();}
        }
      }finally{boardOrder.force=prior;lodForce=batching;lodUsed=oldLOD;orderUsed=oldOrder;}
    }
    function blit(doc,defs,opts,pourView){
      const s=shown,W=canvas.width,H=canvas.height;
      if(!s || s.doc!==doc || s.w!==W || s.h!==H || s.dpr!==dpr || s.flipped!==flipped || typeof ctx.drawImage!=="function")return false;
      const pcb=doc.kind==="pcb";
      if(pcb && (s.rev!==cache?.rev || cache?.items!==doc.items || cache.length!==doc.items.length || cache.epoch!==editEpoch))return false;
      if(s.markKey && (!samePrint(s.markKey,zoomMarkKey(doc,defs,opts,pourView)) || s.rev!==cache?.rev))return false;
      const f=flipped?-1:1;
      if(s.scale===scale && !zoomLayers.length){
        const DX=Math.round(f*(s.cx-cx)*scale*dpr),DY=Math.round((s.cy-cy)*scale*dpr);
        if(Math.abs(DX)>=W/2 || Math.abs(DY)>=H/2)return false;
        // Keep subpixel motion relative to the last pixels actually painted.
        if(!DX && !DY)return null;
        ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation="source-over";
        ctx.drawImage(canvas,DX,DY);
        ctx.restore();
        // Strips are drawn with the camera that matches the shifted pixels exactly.
        const ax=DX/dpr,ay=DY/dpr,tx=cx,ty=cy;
        cx=s.cx-ax/(f*scale);cy=s.cy-ay/scale;
        for(const strip of I.exposedPanStrips(width,height,ax,ay,opts))paint(doc,defs,opts,strip,false,false,pourView);
        s.cx=cx;s.cy=cy;cx=tx;cy=ty;
        return true;
      }
      if(!zoomLayers.length && s.paintMs<4)return false;
      const substrate=hasSubstrate(doc,opts);
      const project=layer=>{
        const z=scale/layer.scale;
        return {layer,z,x:width/2*(1-z)+f*(layer.cx-cx)*scale,y:height/2*(1-z)+(layer.cy-cy)*scale};
      };
      // Reversing the wheel can immediately reuse either the overview or the detail.
      let frame=zoomLayers.map(project).filter(({layer,z,x,y})=>z<=3 && (layer.whole || (x<=0 && y<=0 && x+width*z>=width && y+height*z>=height)))
        .sort((a,b)=>b.layer.scale-a.layer.scale)[0];
      if(!frame){
        let c=zoomLayers.length===2?zoomLayers.pop().canvas:null;
        if(!c){try{c=typeof OffscreenCanvas==="function"?new OffscreenCanvas(W,H):globalThis.document?.createElement("canvas");}catch{return false;}}
        const g=c?.getContext("2d");if(!g)return false;
        if(c.width!==W)c.width=W;
        if(c.height!==H)c.height=H;
        const main=ctx,target=scale;
        let layer;
        try{
          ctx=g;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,W,H);
          if(!zoomLayers.length && target>=s.scale && target<=s.scale*2)scale=s.scale*.9;
          else scale=target*(target < s.scale ? .7 : .9);
          const marks=s.markKey && opts.viaMarks!==false?[]:null;
          const options=marks?{...opts,recordViaMark:(via,mark)=>marks.push({x:via.x,y:via.y,diameter:mark.diameter,minDrillPx:mark.minDrillPx})}:opts;
          I.boardTransform();paintArtwork(doc,defs,options,null,pcb,substrate,undefined,undefined,pourView);
          const b=cache?.bounds,p=b&&worldToScreen([b[0],b[1]]),q=b&&worldToScreen([b[2],b[3]]);
          const whole=b && Math.min(p[0],q[0])>=8 && Math.min(p[1],q[1])>=8 && Math.max(p[0],q[0])<=width-8 && Math.max(p[1],q[1])<=height-8;
          layer={canvas:c,cx,cy,scale,whole};
          if(marks?.length){
            marks.sort((a,b)=>a.diameter-b.diameter);
            Object.assign(layer,{marks,visibleMarks:visibleMarks(marks,scale),lod:lodUsed,
              order:new Map(orderUsed?.map((name,index)=>[name,index]))});
          }
        }finally{scale=target;ctx=main;}
        zoomLayers.push(layer);zoomLayers.sort((a,b)=>a.scale-b.scale);frame=project(layer);
      }
      const repairs=viaMarkDamage(frame,W,H);
      paintBackdrop(doc,defs,opts,pcb,substrate);
      ctx.save();
      if(repairs){
        // Leave the current backdrop in each clip. Replaying the physical passes
        // there preserves the mark's alpha and the copper that covers it.
        ctx.setTransform(1,0,0,1,0,0);ctx.beginPath();ctx.rect(0,0,W,H);
        for(const [x0,y0,x1,y1] of repairs.values())ctx.rect(x0,y0,x1-x0,y1-y0);
        ctx.clip("evenodd");
      }
      ctx.setTransform(frame.z,0,0,frame.z,frame.x*dpr,frame.y*dpr);ctx.drawImage(frame.layer.canvas,0,0);ctx.restore();
      if(repairs)paintZoomRepairs(repairs,frame.layer,doc,defs,opts,substrate,pourView);
      paintTop(doc,defs,opts,null,pcb,substrate,undefined,null,pourView);
      shown={...s,cx,cy,scale,rev:cache?.rev};
      return true;
    }
    // An overlay representative can change inside the retained area. Add its device pixels once,
    // removing every portion already covered by an exposed strip or another overlay repair.
    function appendPanDamage(strips, [left, top, right, bottom], viewWidth, viewHeight) {
      const x0 = Math.max(0, Math.floor(left * dpr) / dpr), y0 = Math.max(0, Math.floor(top * dpr) / dpr);
      const x1 = Math.min(viewWidth, Math.ceil(right * dpr) / dpr), y1 = Math.min(viewHeight, Math.ceil(bottom * dpr) / dpr);
      if (x0 >= x1 || y0 >= y1) return;
      let uncovered = [[x0, y0, x1, y1]];
      for (const covered of strips) {
        uncovered = uncovered.flatMap(rect => {
          const [l, t, r, b] = rect;
          const left = Math.max(l, covered[0]), top = Math.max(t, covered[1]);
          const right = Math.min(r, covered[2]), bottom = Math.min(b, covered[3]);
          if (left >= right || top >= bottom) return [rect];
          const pieces = [];
          if (t < top) pieces.push([l, t, r, top]);
          if (bottom < b) pieces.push([l, bottom, r, b]);
          if (l < left) pieces.push([l, top, left, bottom]);
          if (right < r) pieces.push([right, top, r, bottom]);
          return pieces;
        });
        if (!uncovered.length) return;
      }
      strips.push(...uncovered);
    }
    let lodForce=null,lodUsed=false,orderUsed=null,exactNext=false;
    let viewNote=null;
    function noteView(doc,opts){
      const pours=globalThis.AtriumPolygonPour;
      if(doc.kind!=="pcb" || !pours?.noteView || !("reuseBase" in opts || opts.editorPane))return;
      if(!viewNote || viewNote.cx!==cx || viewNote.cy!==cy || viewNote.scale!==scale || viewNote.width!==width || viewNote.height!==height || viewNote.rotation!==rotation){
        const dx=width/(2*scale),dy=height/(2*scale);
        viewNote={cx,cy,scale,width,height,rotation,box:rotation?artworkViewport():[cx-dx,cy-dy,cx+dx,cy+dy]};
      }
      pours.noteView(viewNote.box,scale*dpr,doc);
    }
    function cancelOpeningOverview(){
      if(!openingOverview)return;
      cancelAnimationFrame(openingOverview.frame);openingOverview=null;
    }
    function paintOpeningOverview(doc,defs,opts){
      syncPaintGeometry();
      const viewport=artworkViewport(null),items=[],step=Math.ceil(doc.items.length/OPEN_OVERVIEW_ITEMS);
      const active=opts.layer||"Top",options=flipped?{...opts,flipped:true}:opts;
      // The first frame uses actual copper and footprints spread across the view.
      // Choose a small representative set before building the full layer paths.
      for(let n=0;n<doc.items.length;n+=step){
        const item=doc.items[n];
        if(item.kind!=="part" && item.kind!=="via" && (item.kind!=="track" && item.kind!=="pad" || boardLayer(item)!==active))continue;
        if(item.poly?.length>16 || item.points?.length>16 || opts.hide?.has(item) || !selectable(item,doc,options,defs))continue;
        if(item.kind==="part"){
          const fp=getDef(defs,item,doc)?.footprint;
          if(!fp || (fp.pads?.length||0)+(fp.shapes?.length||0)>32 || fp.shapes?.some(shape=>shape.points?.length>16))continue;
        }
        const box=objectBox(item,doc,defs);
        if(box && AtriumSpatial.overlaps(box,viewport))items.push(item);
      }
      if(!items.length)return false;
      finishGesture();shown=null;
      paintBackdrop(doc,defs,opts,true,true);
      drawBoard(ctx,items,doc,defs,scale,options,null,viewport,null);
      const job=openingOverview={doc,frame:0};
      // Give the canvas a presentation opportunity before preparing the exact frame.
      job.frame=requestAnimationFrame(()=>{
        if(openingOverview!==job)return;
        job.frame=requestAnimationFrame(()=>{
          if(openingOverview===job && last?.[0]===doc)repaint?.();
        });
      });
      return true;
    }
    function finishOpeningOverview(doc){
      // Precise input always sees the full artwork. The editor's source model is
      // complete before either frame and can undergo the normal edit transaction.
      if(openingOverview?.doc===doc && last?.[0]===doc)render(...last);
    }
    function render(doc,defs,opts={}) {
      const perf=globalThis.AtriumDiagnostics?.performance;
      if(!perf)return renderFrame(doc,defs,opts);
      const kind=doc.kind;
      const span=!opts.print && canvas.isConnected && ("reuseBase" in opts || opts.editorPane) &&
        (kind==="pcb" || kind==="schematic" || kind==="panel" && globalThis.AtriumPanel) ? perf.begin(kind,"draw") : null;
      if(!span)return renderFrame(doc,defs,opts);
      try{return renderFrame(doc,defs,opts,span);}
      catch(error){span.end("failed");throw error;}
    }
    function finishDraw(span,partial=false){
      if(!span)return;
      span.ready();
      // A bounded opening preview or work under a covered pane does not publish a complete view.
      span.end(partial || canvas.inert || canvas.closest?.("[hidden], [inert]") ||
        globalThis.AtriumPower?.visible?.()===false || globalThis.document?.visibilityState==="hidden" ? "completed" : "visible");
    }
    function renderFrame(doc,defs,opts,span) {
      if(doc.kind==="panel" && globalThis.AtriumPanel)[doc,defs]=projectedPanel(doc,defs);
      const g=gesture, cold=last?.[0]!==doc;
      const overview=cold && !g && !opts.noReuse && !opts.print && !rotation && repaint &&
        doc.kind==="pcb" && doc.items.length>=OPEN_OVERVIEW_MIN && !openedBoards.has(doc) && doc.outline?.length>=3 &&
        !opts.hidden?.has("Board") && globalThis.AtriumSpatial && typeof requestAnimationFrame==="function" &&
        !globalThis.AtriumCanvasGPU?.hasView?.(I);
      cancelOpeningOverview();
      if(overview && canvas.inert){span?.end("cancelled");return;} // A foreground report covers the new board.
      gesture=false;last=[doc,defs,opts];
      if(deferred&&(deferred.doc!==doc||!showingAirwires()))cancelAirwires();
      if(!showingAirwires())waitForSave=false;
      dimensions();
      if(!width || !height){span?.end("cancelled");return;}
      if(doc.kind!=="pcb")flipped=false;
      noteView(doc,opts);
      if(doc.kind==="pcb" && doc.items.length>=OPEN_OVERVIEW_MIN)openedBoards.add(doc);
      if(overview && paintOpeningOverview(doc,defs,opts)){finishDraw(span,true);return;}
      const frame=doc.kind==="pcb"?pourFrame(doc,defs,opts):null;
      // WebGL2 board renderer (canvas-gpu.js; Preferences › Display › Renderer): it draws the frame when it is in use.
      if(globalThis.AtriumCanvasGPU?.render(I,doc,defs,rotation?null:opts,g,frame)){
        if(shown){finishGesture();globalThis.AtriumCanvasFast?.releasePixels(I);shown=null;exactNext=false;}
        finishDraw(span);
        prepareGeometry();
        return;
      }
      if(g && !rotation && !opts.noReuse){
        const painted=blit(doc,defs,opts,frame);
        if(painted!==false){
          if(painted)finishDraw(span);else span?.end("cancelled");
          armIdle();return;
        }
      }
      finishGesture();
      const t=now(), reused=paint(doc,defs,opts,null,false,false,frame);exactNext=false;
      shown={doc,w:canvas.width,h:canvas.height,dpr,flipped,cx,cy,scale,paintMs:now()-t,rev:cache?.rev,
        markKey:cache?.viaMarks?.size?zoomMarkKey(doc,defs,opts,frame):null};
      finishDraw(span);
      prepareGeometry();
      return reused;
    }
    const hasSubstrate=(doc,opts)=>doc.kind==="pcb" && doc.outline?.length>=3 && !opts.hidden?.has("Board");
    function drawingBounds(doc,defs){return SCH.drawingBounds(doc,defs,sync(doc,defs).bounds);}
    function paintBackdrop(doc,defs,opts,pcb,substrate){
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.fillStyle=pcb?PCB.system.workspace:SCH?SCH.workspace||"#cececa":color.field;ctx.fillRect(0,0,width,height);
      if(opts.grid!==false && pcb)lineGrid(doc.grid,PCB.system.workspaceGrid,PCB.system.workspaceGridCoarse,PCB.system.workspace);
      else if(opts.grid!==false && !SCH)grid(doc.grid,color.grid);
      I.boardTransform();
      if(!pcb && SCH)SCH.page(ctx,doc,scale,opts.grid===false?null:(step,ink)=>{
        ctx.setTransform(dpr,0,0,dpr,0,0);grid(step,ink);
      },rotation?artworkViewport():[...screenToWorld([0,0]),...screenToWorld([width,height])],opts.project,
        SCH.isInfinite(doc) && doc.sheet.titleBlock && doc.sheet.titleBlock!=="none" ? drawingBounds(doc,defs) : undefined, opts.titleBlockParameters);
      if(substrate) {
        const S=globalThis.AtriumBoardShape, exact=S?.screenProfile(doc,opts.exactProfile);
        const contours=exact?S.profileContours(exact):[doc.outline,...(S?.holes(doc)||[])];
        const rule=boardPath(ctx,contours,exact&&S);
        ctx.fillStyle=PCB.system.board;ctx.fill(rule);
        if(opts.grid!==false){
          ctx.save();ctx.clip(rule);lineGrid(doc.grid,PCB.system.boardGrid,PCB.system.boardGridCoarse,PCB.system.board);ctx.restore();
          boardPath(ctx,contours,exact&&S);
        }
        ctx.strokeStyle=PCB.system.edge;ctx.lineWidth=1.25/scale;ctx.stroke();
      }
      if(pcb && opts.origin!==false)originMarker(doc.origin);
      if(pcb && opts.boardHandles)boardHandles(opts.boardHandles,opts.boardHandleActive);
    }
    // bare: the board layer only (canvas-fast.js repaints selection boxes into its copy).
    function paint(doc,defs,opts,area,bare,unclipped=false,frame=doc.kind==="pcb"?pourFrame(doc,defs,opts):null) {
      const pcb=doc.kind==="pcb",substrate=hasSubstrate(doc,opts);
      if(!pcb)flipped=false;
      const clipped=area&&!(bare&&unclipped);
      if(clipped){ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.beginPath();ctx.rect(area[0],area[1],area[2]-area[0],area[3]-area[1]);ctx.clip();}
      const F=!rotation&&!area&&(pcb||doc.kind==="schematic")&&("reuseBase" in opts||opts.editorPane)&&globalThis.AtriumCanvasFast;
      if(F&&F.reuse(I,doc,defs,opts,frame)){paintTop(doc,defs,opts,area,pcb,substrate,undefined,null,frame);return true;}
      const t0=F?now():0;
      paintBackdrop(doc,defs,opts,pcb,substrate);
      const artwork=pcb&&!area&&!bare?{}:null;
      const count=paintArtwork(doc,defs,opts,area,pcb,substrate,F,artwork,frame);
      if(F)F.saved(I,doc,defs,opts,now()-t0,count,frame);
      if(bare){if(clipped)ctx.restore();return;}
      paintTop(doc,defs,opts,area,pcb,substrate,undefined,artwork,frame);
    }
    // Overlay effects extend past the damage rectangle by CSS pixels. Pad it
    // before inverting the camera, so the world bounds include rotated corners.
    function worldViewport(area,padding=0){
      const left=(area?area[0]:0)-padding, top=(area?area[1]:0)-padding;
      const right=(area?area[2]:width)+padding, bottom=(area?area[3]:height)+padding;
      if(rotation)return rotation.bounds([left,top,right,bottom],screenToWorld);
      const corner=screenToWorld([left,top]),far=screenToWorld([right,bottom]);
      return [Math.min(corner[0],far[0]),Math.min(corner[1],far[1]),Math.max(corner[0],far[0]),Math.max(corner[1],far[1])];
    }
    function artworkViewport(area){return expand(worldViewport(area),7/scale);}
    function boardArtwork(doc,defs,opts,viewport,candidates){
      // The interactive router hides the originals of copper it is shoving and draws them reshaped below.
      if(opts.routePreview?.hidden?.length){const gone=new Set(opts.routePreview.hidden);candidates=candidates.filter(i=>!gone.has(i.id));}
      const lod=lodFor(doc,candidates,opts,viewport);
      return {candidates,lod,options:flipped?{...opts,flipped:true}:opts};
    }
    function paintOrder(doc,defs,opts,candidates,viewport=artworkViewport(null),pours){
      const plan=boardArtwork(doc,defs,opts,viewport,candidates||query(doc,defs,viewport));
      return collectBoardLayers(plan.candidates,doc,defs,scale,plan.options,pours===undefined?pourFrame(doc,defs,opts).pours:pours,viewport,plan.lod,true);
    }
    function paintArtwork(doc,defs,opts,area,pcb,substrate,F,artwork,frame){
      const viewport=artworkViewport(area);
      let candidates=query(doc,defs,viewport);
      if(artwork){artwork.viewport=viewport;artwork.rawItems=candidates;artwork.rev=cache?.rev;}
      if(pcb){
        // Tiled live pours (polygon-pour.js): pours follow a dragged part, and changed tiles show at once.
        const plan=boardArtwork(doc,defs,opts,viewport,candidates);candidates=plan.candidates;
        if(!area)lodUsed=!!plan.lod;
        drawBoard(ctx,candidates,doc,defs,scale,plan.options,frame.pours,viewport,plan.lod);
        if(!area)orderUsed=boardOrder.last;
      }
      else{
        if(!area){lodUsed=false;orderUsed=null;}
        opts={...opts,imageViewport:viewport};
        if(!opts.notesDeferred && globalThis.AtriumLabs?.notebookEnabled()!==false && globalThis.AtriumMarkup && doc.kind==="schematic"){
          opts={...opts,leaderDrawn:true,noteIndexes:new Map(),drawnGestures:new Set(),notesPolicy:AtriumMarkup.policy(doc,opts),notesDark:AtriumMarkup.darkPaper(opts)};
          AtriumMarkup.drawLeaders(ctx,doc,defs,opts,viewport);
        }
        const levels=[[],[],[],[],[],[]];
        for(const i of candidates)if(visible(i,opts.hidden)&&!opts.hide?.has(i))levels[drawingOrder(i)].push(i);
        for(const level of levels)for(const i of level)drawItem(ctx,i,doc,defs,scale,opts,false);
      }
      // During a physical move, the copper graph is unsettled. Recompute once the
      // move commits; panning, zooming and highlighting reuse the same graph.
      // Board Planning mode (key 1): regions as tinted areas, bend lines dashed with labels.
      if(pcb&&globalThis.AtriumStackup?.isPlanning?.()&&globalThis.AtriumRigidFlex)AtriumRigidFlex.drawPlanning(ctx,doc,{scale,dpr,worldToScreen,selected:opts.planning?.region,line:opts.planning?.line},defs);
      if(doc.kind==="pcb" && opts.showUnrouted && !opts.transientGeometry && hasAirwireSource(sync(doc,defs))){F&&F.under(I,doc,opts,candidates.length);drawAirwires(doc,defs,viewport,opts.highlight,substrate,opts.netColors);}
      return candidates.length;
    }
    // Everything above the board layer: router preview, tools, overlays, marquee and measure.
    // Net names on the current layer's tracks and pours (pcb-net-labels.js), placed for this camera.
    let netLabels=[];
    function paintNetLabels(doc,defs,opts,artwork,frame){
      netLabels=[];
      const N=globalThis.AtriumPCBNetLabels;
      if(!N || opts.netNames===false || opts.print || opts.transientGeometry)return;
      const view=artworkViewport(null),pours=(frame||pourFrame(doc,defs,opts)).pours;
      const layer=opts.layer||"Top",maxWidth=N.trackWidthLimit(sync(doc,defs),layer,scale,view);
      if(!maxWidth && !pours?.some(r=>r?.layer===layer&&r.net))return;
      const reusable=artwork && cache?.doc===doc && artwork.rev===cache.rev &&
        view.every((edge,i)=>edge===artwork.viewport[i]);
      let items=reusable?artwork.rawItems:null, parts;
      const candidates=()=>items??=query(doc,defs,view);
      const partBoxes=items=>{
        const out=[];
        for(const i of items){
          if(i.kind!=="part")continue;
          const b=(cache?.doc===doc && cache.boxes.get(i)) || objectBox(i,doc,defs);
          if(!b)continue;
          const points=rotation?boxCorners(b):[[b[0],b[1]],[b[2],b[3]]];
          out.push(A.bounds(points.map(worldToScreen)));
        }
        return out;
      };
      netLabels=N.place({items:maxWidth?candidates():[],pours,scale,width,height,toScreen:worldToScreen,view,PCB,opts,maxWidth,
        trackInk:i=>chosen(i,opts)||opts.highlight&&i.net===opts.highlight?PCB.system.selection:netInk(i,opts)||PCB.ink(layer,i,opts,false),
        pourInk:r=>PCB.ink(r.layer,r,opts,!!opts.highlight&&opts.highlight===r.net),
        obstaclesFor:box=>{
          // Reuse the artwork query when present. For unrotated, retained frames, only a
          // part whose world box reaches this label can block it. A rotated screen bounding
          // box can overlap even outside its inverse transform, so keep the full view there.
          if(items || rotation || !globalThis.AtriumSpatial || cache?.preparation)return parts??=partBoxes(candidates());
          return partBoxes(query(doc,defs,worldViewport(box)));
        }});
      N.draw(ctx,netLabels,dpr,monoFont);
    }
    function paintTop(doc,defs,opts,area,pcb,substrate,damageRects=undefined,artwork=null,frame){
      if(pcb)paintNetLabels(doc,defs,opts,artwork,frame);
      if(pcb&&opts.routePreview)drawRoutePreview(opts.routePreview,opts.pointer);
      if(opts.lengthTuning&&globalThis.AtriumLength)AtriumLength.draw(ctx,opts.lengthTuning,{scale,dpr,worldToScreen,copper});
      // Via fencing preview (AtriumViaFence): fence paths, vias to place and skipped spots in red.
      if(pcb&&opts.viaFence&&globalThis.AtriumViaFence)AtriumViaFence.draw(ctx,opts.viaFence,{scale,dpr,worldToScreen,copper});
      if(opts.guides&&globalThis.AtriumGuides)AtriumGuides.draw(ctx,opts.guides,{scale,dpr,worldToScreen});
      // A part's text field under the pointer, selected or moving, and its owner (sch-fields.js).
      if(opts.fieldFocus&&!pcb&&globalThis.AtriumSchFields)AtriumSchFields.drawFocus(ctx,doc,defs,opts.fieldFocus,{scale,select:SCH?.select||color.select});
      // Caller overlays in world coordinates (DRC markers from drc-view.js).
      if(opts.overlay)for(const f of opts.overlay){try{f(ctx,{canvas,scale,dpr,worldToScreen,worldViewport,selectable,options:opts,copper,width,height,area,damageRects});}catch(e){globalThis.console?.error?.(e);}}
      if(pcb&&globalThis.AtriumRouteFeel)AtriumRouteFeel.paint(ctx,opts,{scale,dpr,worldToScreen,copper,system:PCB.system});
      if(opts.route?.length){
        ctx.save();
        drawPath(ctx,opts.route);
        ctx.strokeStyle=doc.kind==="pcb" ? copper(opts.layer || "Top") : SCH?.wire||color.wire;
        ctx.lineWidth=Math.max(1.4/scale,doc.kind==="pcb" ? opts.width || .25 : .22);
        if(doc.kind==="pcb")ctx.globalAlpha=.85;else ctx.setLineDash([5/scale,3/scale]);
        ctx.stroke();ctx.restore();
      }
      if(opts.block?.points){
        ctx.save();drawPath(ctx,opts.block.points,true);ctx.fillStyle="rgba(111,172,150,.15)";ctx.fill();
        ctx.strokeStyle=substrate?color.lightSelect:color.select;ctx.lineWidth=1.4/scale;ctx.setLineDash([5/scale,3/scale]);ctx.stroke();ctx.restore();
      }
      if(opts.ghost){
        ctx.save();ctx.globalAlpha=.65;
        if(pcb)drawBoard(ctx,[opts.ghost],doc,defs,scale,opts);else drawItem(ctx,opts.ghost,doc,defs,scale,opts,substrate);
        ctx.restore();
      }
      if(opts.snapAt) {
        circle(ctx,opts.snapAt[0],opts.snapAt[1],5/scale);ctx.strokeStyle=pcb?PCB.system.selection:substrate?color.lightSelect:color.select;
        ctx.lineWidth=1.3/scale;ctx.stroke();
      }
      if(opts.paste && opts.pasteAt){
        const paste=opts.paste;
        ctx.save();ctx.translate(opts.pasteAt[0],opts.pasteAt[1]);ctx.globalAlpha=.68;
        if(paste.items.length<=120){
          if(pcb)drawBoard(ctx,paste.items,doc,paste.defs,scale,opts);
          else for(const i of paste.items)drawItem(ctx,i,doc,paste.defs,scale,opts,substrate);
        }
        else if(pcb)boardSelectionBox(ctx,paste.bounds,scale);
        else selectionBox(ctx,paste.bounds,scale,!!substrate);
        ctx.restore();
      }
      if(opts.marquee){
        marquee(ctx,opts.marquee,pcb?PCB.system.marquee:SCH.marquee,dpr);
      }
      if(opts.measure){
        const {a,b,text}=opts.measure,start=worldToScreen(a),finish=worldToScreen(b),dark=doc.kind==="pcb";
        ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.lineWidth=1.4;ctx.strokeStyle=dark?"#b3fff0":"#405e72";
        ctx.setLineDash([5,3]);drawPath(ctx,[start,finish]);ctx.stroke();ctx.setLineDash([]);
        for(const [x,y] of [start,finish]){ctx.beginPath();ctx.moveTo(x-4,y);ctx.lineTo(x+4,y);ctx.moveTo(x,y-4);ctx.lineTo(x,y+4);ctx.stroke();}
        ctx.font="500 11px "+monoFont;ctx.textAlign="left";ctx.textBaseline="middle";
        const labelWidth=Math.min(width-8,ctx.measureText(text).width+12);
        const x=bounded((start[0]+finish[0]-labelWidth)/2,4,Math.max(4,width-labelWidth-4)),y=bounded((start[1]+finish[1])/2-20,3,height-22);
        ctx.fillStyle=dark?"#22292d":"#fffcf4";ctx.fillRect(x,y,labelWidth,19);
        ctx.fillStyle=dark?"#d7fff7":"#344b5d";ctx.fillText(text,x+6,y+10,labelWidth-10);ctx.restore();
      }
      // Altium shows no scale bar; callers may still ask for one.
      if(doc.kind==="pcb" && opts.scaleBar)scaleBar();
      if(area)ctx.restore();
    }
    function hit(doc,defs,p,opts={}){return rankHits(doc,defs,p,opts,0);}
    function hits(doc,defs,p,opts={},limit=8){return limit>0?rankHits(doc,defs,p,opts,limit):[];}
    // One spatial query. Limit one keeps the scalar best; a longer stack ranks that same walk.
    function rankHits(doc,defs,p,opts,limit){
      if(doc.kind==="panel" && globalThis.AtriumPanel)[doc,defs]=projectedPanel(doc,defs);
      finishOpeningOverview(doc);
      const tol=5/scale,kinds=opts.kinds?new Set(opts.kinds):null,scalar=limit===0; // kinds: only these item kinds (track tools)
      const area=expand([p[0],p[1],p[0],p[1]],tol);
      // hopPath can paint up to 0.7 mm above the indexed horizontal wire.
      if(doc.kind==="schematic" && doc.hopOvers)area[3]+=.7;
      const nearby=query(doc,defs,area);
      // Single and dim modes are about the active layer: its objects win over a footprint pad there.
      const partPriority=opts.layerMode==="single"||opts.layerMode==="dim"?1.5:2;
      let best=null,bestPriority=-1,bestDistance=Infinity;const ranked=scalar?null:[];
      for(let n=nearby.length-1;n>=0;n--){
        const i=nearby[n];
        if(kinds&&!kinds.has(i.kind)||opts.skip?.has(i.id))continue; // skip: ids already offered (touch cycling)
        if(opts.contactOnly&&!canContact(i,null,opts))continue;
        let distance=Infinity,priority=-1;
        if(doc.kind==="pcb"){
          if(boardVisible(i,opts)){
            bodyHit=false;
            distance=hitDistance(i,p,defs,doc,tol,scale,opts);
            if(distance<=tol)priority=i.kind==="part"?bodyHit?-.5:partPriority:layerRank(boardLayer(i),opts,flipped)/101;
          }
          if(!opts.contactOnly)for(const opening of PCB.traceOpenings(i,boardLayer(i))){
            if(!boardVisible(opening,opts))continue;
            const d=hitDistance(opening,p,defs,doc,tol,scale,opts),rank=layerRank(opening.layer,opts,flipped)/101;
            if(d<=tol && (rank>priority || rank===priority && d<distance)){distance=d;priority=rank;}
          }
        }else{
          if(!visible(i,opts.hidden))continue;
          distance=hitDistance(i,p,defs,doc,tol,scale,opts);
          const entry=i.kind==="sheetsymbol"&&globalThis.AtriumSchObjects?.entryAt(i,p,tol);
          priority=entry?5:drawingOrder(i);
        }
        if(distance>tol)continue;
        if(scalar){
          if(priority>bestPriority||priority===bestPriority&&distance<bestDistance){best=i;bestPriority=priority;bestDistance=distance;}
        }else{
          let place=ranked.length;
          for(let k=0;k<place;k++){
            const other=ranked[k];
            if(priority>other.priority||priority===other.priority&&distance<other.distance){place=k;break;}
          }
          if(place<limit){ranked.splice(place,0,{item:i,priority,distance});if(ranked.length>limit)ranked.pop();}
        }
      }
      return scalar?best:ranked.map(row=>row.item);
    }
    function snapPoint(doc,defs,p,opts={}) {
      finishOpeningOverview(doc);
      let best=null,distance=9/scale;
      function consider(q) {
        const d=gap(p,q);
        if(d<distance){best=q;distance=d;}
      }
      const nearby=query(doc,defs,expand([p[0],p[1],p[0],p[1]],distance));
      for(const i of nearby){
        if((doc.kind==="pcb"?!boardVisible(i,opts):!visible(i,opts.hidden)) || i.id===opts.exclude)continue;
        if(i.kind==="part"){
          const def=getDef(defs,i,doc),b=partBox(i,A.geometries(def,doc.kind));
          if(p[0]<b[0]-distance || p[0]>b[2]+distance || p[1]<b[1]-distance || p[1]>b[3]+distance)continue;
          for(const pin of A.pins(i,def,doc.kind)) {
            if(!pin.hidden && (doc.kind!=="pcb" || canContact(pin,i,opts)))consider(pin.at);
          }
        }else if(doc.kind==="pcb" && !canContact(i,null,opts))continue;
        else if(i.kind==="wire" || i.kind==="track")i.points.forEach(consider);
        else if(["pad","via","junction","netlabel"].includes(i.kind))consider([i.x,i.y]);
        else if(globalThis.AtriumSchObjects?.KINDS.has(i.kind))AtriumSchObjects.hotspots(i).forEach(consider);
      }
      if(best)return best.slice();
      const q=opts.grid===false ? p.slice() : p.map(v=>A.snap(v,doc.grid));
      // A junction dropped onto an existing segment must land on that segment.
      for(const i of nearby){
        if(!["wire","track"].includes(i.kind) || !visible(i,opts.hidden) || i.id===opts.exclude || (doc.kind==="pcb" && !canContact(i,null,opts)))continue;
        for(let n=1;n<i.points.length;n++){
          const a=i.points[n-1],b=i.points[n],dx=b[0]-a[0],dy=b[1]-a[1],d2=dx*dx+dy*dy;
          if(!d2 || A.nearSegment(p,a,b)>5/scale)continue;
          const t=bounded(((q[0]-a[0])*dx+(q[1]-a[1])*dy)/d2,0,1);
          consider([a[0]+dx*t,a[1]+dy*t]);
        }
      }
      return best || q;
    }
    function selectable(item,doc,opts,defs){
      const kind=doc.kind==="schematic" && globalThis.AtriumLabs?.notebookEnabled()!==false && globalThis.AtriumMarkup?.kind(item);
      if(kind && !AtriumMarkup.policy(doc,opts).hit({kind,id:item.id}))return false;
      if(doc.kind!=="pcb")return visible(item,opts.hidden);
      if(item.kind!=="part")return boardVisible(item,opts) || PCB.traceOpenings(item,boardLayer(item)).some(o=>boardVisible(o,opts));
      if(!defs || (!opts.hidden?.size && opts.layerMode!=="single"))return true;
      const def=getDef(defs,item,doc);
      if(PCB.footprintLayers(item,def?.footprint).some(g=>PCB.visible(g.layer,null,opts) &&
          (g.shapes.length || g.pads.some(p=>PCB.visible(g.layer,p,opts)))))return true;
      for(const row of PCB.partText(doc,item,def))if(PCB.visible(row.text.layer,item,opts))return true;
      return false;
    }
    function enclosed(doc,defs,b,opts){
      finishOpeningOverview(doc);
      return query(doc,defs,b).filter(i=>{
        if(!selectable(i,doc,opts,defs))return false;
        const box=A.bounds(A.itemPoints(i,getDef(defs,i,doc),doc.kind));
        return box && box[0]>=b[0] && box[1]>=b[1] && box[2]<=b[2] && box[3]<=b[3];
      });
    }
    const camera=()=>({cx,cy,scale,referenceScale,flipped,...(rotation?{rotation:rotation.rad}:{})});
    function restoreCamera(saved){({cx,cy,scale,referenceScale}=saved);flipped=!!saved.flipped;setAngle(saved.rotation||0);}
    function onRepaint(fn){
      repaint=typeof fn==="function"?fn:null;
      if(!repaint){cancelOpeningOverview();cancelPreparation();cancelAirwires();waitForSave=false;heldPourDoc=null;}
    }
    function pausePaint(){
      if(idle){clearTimeout(idle);idle=0;}
      gesture=false;
      cancelOpeningOverview();cancelPreparation();cancelAirwires();
      globalThis.AtriumCanvasGPU?.pause?.(I);
    }
    function dispose(){
      onRepaint(null);finishGesture();
      last=shown=cache=connectivity=pourCache=null;
      globalThis.AtriumCanvasFast?.release(I);
      globalThis.AtriumCanvasGPU?.release(I);
      resizeBacking(canvas,1,1);
    }
    return {camera,restoreCamera,rotate,selectable,enclosed,pourState,saveWritePending,render,fit,drawingBounds,internals:()=>I,onRepaint,pausePaint,dispose,
      resized(rect){const r=rect||canvas.getBoundingClientRect();width=r.width;height=r.height;if(I.size)I.size={w:width,h:height};}, // a dock resized the canvas: map with the new size now, keeping the centre
      moving(wheelEnd=false){gesture=wheelEnd?"wheel-end":true;},settle(){gesture=false;},screenToWorld,worldToScreen,worldViewport,zoom,zoomScale,hit,hits,snapPoint,query,invalidate,connectedWires,boardConnectivity,
      pan(dx,dy){if(rotation)[dx,dy]=rotation.vector(dx,dy,true);cx-=(flipped?-dx:dx)/scale;cy-=dy/scale;},scale:()=>scale,fitScale:()=>referenceScale,
      setFlipped(v){flipped=!!v;},flipped:()=>flipped};
  }
  function preview(canvas,def,kind="schematic") {
    syncPaintGeometry();
    const g=A.geometries(def,kind);
    if(!g)return;
    const rect=canvas.getBoundingClientRect(),dpr=bounded(globalThis.devicePixelRatio || 1,1,4);
    const w=rect.width,h=rect.height;
    if(!w || !h)return;
    canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
    const b=localBox(g),scale=bounded(Math.min(w*.77/Math.max(.2,b[2]-b[0]),h*.72/Math.max(.2,b[3]-b[1])),.001,40);
    const ctx=canvas.getContext("2d");
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);
    ctx.setTransform(scale*dpr,0,0,scale*dpr,(w/2-(b[0]+b[2])/2*scale)*dpr,(h/2-(b[1]+b[3])/2*scale)*dpr);
    ctx.lineCap="round";ctx.lineJoin="round";
    drawPart(ctx,{id:"preview",x:0,y:0,angle:0,ref:""},def,kind,scale,{},false,true);
  }
  // Cropped schematic previews share the editor's exact artwork and culling bounds.
  const schematicArtwork = {box:objectBox, order:drawingOrder, draw:drawItem, prepare:syncPaintGeometry};
  return {create,preview,resizeBacking,referencePositions,partBox,partTextDistance,boardText,schematicArtwork,artBounds,needsBoardBatches,canContact,routingLayers,tint,eachGridLine,edited(libraryPossible=true){
    editEpoch++;
    if(libraryPossible && globalThis.AtriumUndoStore?.unrecorded?.())pendingGeometry++;
  }};
})();
