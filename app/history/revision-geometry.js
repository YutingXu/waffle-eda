"use strict";
if (!globalThis.AtriumLandContours && typeof require === "function") require("../pcb/land-contours.js");
if (!globalThis.AtriumBoardShape && typeof require === "function") require("../pcb/board-shape-core.js");

// Project only the selected object into design coordinates, using the workbench's
// placement transform. Both revisions share a viewBox so distances remain comparable.
globalThis.AtriumRevisionGeometry = (() => {
  const A = Atrium;
  const origin = {x:0, y:0, angle:0};
  const svgNS = "http://www.w3.org/2000/svg";
  const colors = {Before:"#986620", After:"#17674f"};
  const round = n => Number(n.toFixed(9));
  const point = p => p.map(round);
  const positive = (n, fallback) => Number.isFinite(n) && n > 0 ? n : fallback;
  const corners = (w,h) => [[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]];

  function project(entry, libraryKind) {
    if (!entry) return [];
    const item = entry.data, pcb = entry.area === "PCB" || libraryKind === "pcb";
    const shapes = [];
    function path(points, closed, width, filled=false, holes=[]) {
      if (!points.length) return;
      shapes.push({kind:"path", points:points.map(point), holes:holes.map(ring=>ring.map(point)), closed:!!closed, width:round(width), filled:!!filled});
    }
    function artwork(shape, parent) {
      const curves=AtriumGeometryCurves, frame=parent && curves.artworkFrame(parent);
      const appearance=AtriumPCBAppearance;
      const width=shape.kind==="track" ? appearance.boardStrokeWidth(shape) : appearance.shapeStrokeWidth(shape);
      if (shape.kind==="track" && width===null) return;
      const vertices=edges=>curves.flatten(frame ? edges.map(edge=>curves.placeEdge(edge,frame)) : edges,.005);
      curves.artworkInk(shape,width,ink=>{
        if (ink.kind==="stroke") path(vertices(ink.centerline),false,ink.width ?? 0);
        else for (const island of ink.islands) path(vertices(island.outer),true,0,true,island.holes.map(vertices));
      });
    }
    function ellipse(center,w,h,angle=0,role="body") {
      shapes.push({kind:"ellipse", center:point(center), w:round(w), h:round(h), angle:w===h?0:(angle%180+180)%180, role});
    }
    function pad(p,parent){
      const L=AtriumResolvedLand,g=L.geometry(p,p.layer==="Bottom"||parent.layer==="Bottom"?"Bottom":"Top");
      if(g&&!g.holeOnly){
        const {at,angle,mirror}=L.place(g,parent),frame={x:at[0],y:at[1],angle,mirror};
        if(g.shape==="circle"||g.shape==="ellipse")ellipse(at,g.w,g.h,angle,"pad");
        else if(g.shape==="rect"||g.shape==="roundrect"||g.shape==="obround")
          shapes.push({kind:"rect",center:point(at),w:round(g.w),h:round(g.h),angle:(angle%180+180)%180,radius:round(g.r)});
        else path(AtriumLandContours.outline(g).map(v=>A.world(v,frame)),true,0,true);
      }
      if(positive(p.drill,0))ellipse(A.world([p.x,p.y],parent),p.drill,p.drill,0,"drill");
    }
    function component(g,parent) {
      if (!g) return;
      for (const s of g.shapes) {
        if (pcb) artwork(s,parent);
        else if (s.kind==="path") path(s.points.map(p=>A.world(p,parent)),s.closed,s.width || .24,s.fill);
        else if (s.kind==="circle") ellipse(A.world([s.x,s.y],parent),2*s.r,2*s.r);
      }
      for (const p of g.pads || []) pad(p,parent);
      for (const pin of g.pins || []) ellipse(A.world([pin.x,pin.y],parent),.34,.34,0,"pin");
    }
    if (libraryKind) component(A.geometries(item,libraryKind),origin);
    else if (item.kind==="part") component(entry.geometry,item);
    else if (item.kind==="pad" || item.kind==="via") pad(item,origin);
    else if (pcb && (item.kind==="track" || item.kind==="graphic")) artwork(item,null);
    else if (item.points && ["wire","graphic"].includes(item.kind)) path(item.points,item.closed,positive(item.width,item.kind==="wire" ? .22 : .2),item.fill);
    else if (item.kind==="junction") ellipse([item.x,item.y],.8,.8);
    else if (item.kind==="pcb" && item.outline?.length) path(item.outline,true,0);
    return shapes;
  }

  function bounds(shapes) {
    const extents=[];
    for (const s of shapes) {
      if (s.kind==="path") {
        const b=A.bounds(s.points), r=s.width/2;
        extents.push([b[0]-r,b[1]-r],[b[2]+r,b[3]+r]);
      } else {
        const [x,y]=s.center;
        // The rectangle around a rotated ellipse also encloses the ellipse.
        const placement={x,y,angle:s.angle};
        for (const p of corners(s.w,s.h)) extents.push(A.world(p,placement));
      }
    }
    return A.bounds(extents);
  }
  function svg(tag, attrs) {
    const el=document.createElementNS(svgNS,tag);
    for (const [key,value] of Object.entries(attrs)) el.setAttribute(key,String(value));
    return el;
  }
  function draw(shape, group, side, dashSize) {
    let el;
    if (shape.kind==="path") {
      if (shape.holes.length) {
        const d=[shape.points,...shape.holes].map(ring=>"M"+ring.join("L")+"Z").join("");
        el=svg("path",{d,"fill-rule":"evenodd"});
      } else el=svg(shape.closed?"polygon":"polyline",{points:shape.points.join(" ")});
      if (shape.width) {
        el.setAttribute("stroke-width",shape.width);
        el.setAttribute("stroke-opacity",".78");
        if (side==="Before") {
          // The continuous faint band retains the round trace ends. Flat dash
          // caps keep gaps legible even when the original copper was much wider.
          const band=el.cloneNode();
          band.setAttribute("stroke-opacity",".16");group.append(band);
          el.setAttribute("stroke-linecap","butt");
          el.setAttribute("stroke-dasharray",dashSize*1.8+" "+dashSize);
        }
      }
    } else {
      const [x,y]=shape.center, w=shape.w, h=shape.h;
      el=shape.kind==="rect"
        ? svg("rect",{x:x-w/2,y:y-h/2,width:w,height:h,rx:shape.radius})
        : svg("ellipse",{cx:x,cy:y,rx:w/2,ry:h/2});
      if (shape.angle) el.setAttribute("transform","rotate("+shape.angle+" "+x+" "+y+")");
    }
    if (!shape.width) {
      el.setAttribute("vector-effect","non-scaling-stroke");
      el.setAttribute("stroke-width",1.45);
      if (side==="Before") el.setAttribute("stroke-dasharray","4 3");
    }
    if (shape.role==="pad" || shape.filled || shape.kind==="rect") {
      el.setAttribute("fill",colors[side]);el.setAttribute("fill-opacity",".11");
    }
    if (shape.role==="drill") {
      el.setAttribute("fill","#fbfcfa");el.setAttribute("fill-opacity",".65");
    }
    group.append(el);
  }
  function sameProjection(before,after) {
    if (before.length!==after.length) return false;
    const equal=(p,q)=>p[0]===q[0] && p[1]===q[1];
    const samePath=(a,b)=>a.length===b.length && (a.every((p,i)=>equal(p,b[i])) || a.every((p,i)=>equal(p,b[b.length-1-i])));
    return before.every((a,i)=>{
      const b=after[i];
      if (a.kind!==b.kind) return false;
      if (a.kind!=="path") return a.center[0]===b.center[0] && a.center[1]===b.center[1] &&
        a.w===b.w && a.h===b.h && a.angle===b.angle && a.role===b.role && a.radius===b.radius;
      return a.width===b.width && a.closed===b.closed && a.filled===b.filled && samePath(a.points,b.points) &&
        a.holes.length===b.holes.length && a.holes.every((ring,j)=>samePath(ring,b.holes[j]));
    });
  }
  function diagram(before,after,name,description) {
    if (sameProjection(before,after)) return null;
    const b=bounds(before.concat(after));if(!b)return null;
    const span=Math.max(b[2]-b[0],b[3]-b[1],.01), pad=span*.14;
    const box=[b[0]-pad,b[1]-pad,b[2]-b[0]+2*pad,b[3]-b[1]+2*pad];
    const graphic=svg("svg",{viewBox:box.join(" "),role:"img","aria-label":name+" · "+description+" · "+(before.length&&after.length?"Before and after":before.length?"Before removal":"After addition"),width:"100%",height:"140"});
    for (const [side,shapes] of [["After",after],["Before",before]]) {
      if (!shapes.length) continue;
      const g=svg("g",{"data-revision":side,fill:"none",stroke:colors[side],"stroke-linecap":"round","stroke-linejoin":"round"});
      for (const s of shapes) draw(s,g,side,span/65);
      graphic.append(g);
    }
    return graphic;
  }
  function preview(report,row) {
    const figure=document.createElement("figure");figure.className="revision-geometry";
    const library=row.area==="Library" && (row.previous?.data.footprint || row.previous?.data.symbol || row.next?.data.footprint || row.next?.data.symbol);
    const component=library || row.previous?.data.kind==="part" || row.next?.data.kind==="part";
    let hasBefore=false,hasAfter=false;
    for (const kind of library?["pcb","schematic"]:[null]) {
      const before=project(row.previous,kind),after=project(row.next,kind);
      const type=kind==="pcb"?"Footprint outline":kind==="schematic"?"Symbol outline":component?"Component outline":"Geometry";
      const image=diagram(before,after,row.name,type);
      if(image){figure.append(image);hasBefore ||= before.length>0;hasAfter ||= after.length>0;}
    }
    if (!figure.firstChild) return null;
    const caption=document.createElement("figcaption");
    for (const [side,shown] of [["Before",hasBefore],["After",hasAfter]]) {
      if (!shown) continue;
      const key=document.createElement("span"),swatch=svg("svg",{width:22,height:8,"aria-hidden":"true"});
      const line=svg("line",{x1:1,y1:4,x2:21,y2:4,stroke:colors[side],"stroke-width":2});
      if(side==="Before")line.setAttribute("stroke-dasharray","4 3");
      swatch.append(line);key.append(swatch,document.createTextNode(" "+side));caption.append(key);
    }
    if(component){const note=document.createElement("span");note.textContent="Component outlines";caption.append(note);}
    figure.append(caption);
    return figure;
  }
  return {preview};
})();
