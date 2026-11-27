"use strict";

// Regions6 stores the already tessellated result of the last Altium pour.
// Its holes and disconnected islands are actual artwork; polygon boundaries
// alone cannot reconstruct those clearances.
globalThis.AtriumPCBPours=(()=>{
  const unit=.00000254,none=0xffff,decoder=new TextDecoder("windows-1252");
  const yes=s=>/^(true|1)$/i.test(s||"");
  function encode(bytes){
    if(typeof bytes.toBase64==="function")return bytes.toBase64();
    let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(binary);
  }
  function decode(text){
    if(typeof Uint8Array.fromBase64==="function")return Uint8Array.fromBase64(text);
    const raw=atob(text),bytes=new Uint8Array(raw.length);
    for(let i=0;i<bytes.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;
  }
  function walk(bytes,count,visit){
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(!Number.isInteger(count)||count<1||count>bytes.length/52)throw Error("Invalid pour hole count.");
    let cursor=0;
    for(let ring=0;ring<count;ring++){
      if(cursor+4>bytes.length)throw Error("Truncated pour contour.");
      const vertices=v.getUint32(cursor,true);cursor+=4;
      if(vertices<3||vertices>(bytes.length-cursor)/16)throw Error("Invalid pour vertex count.");
      for(let i=0;i<vertices;i++){
        const u=v.getFloat64(cursor,true),w=v.getFloat64(cursor+8,true),x=u*unit,y=-w*unit;cursor+=16;
        if(!Number.isFinite(x+y)||Math.max(Math.abs(x),Math.abs(y))>1e8)throw Error("Invalid pour vertex.");
        visit(ring,i,vertices,x,y,u,w);
      }
    }
    if(cursor!==bytes.length)throw Error("Unrecognized Regions6 contour trailer.");
  }
  // ids[i]: the Waffle polygon item made from Polygons6 record i, if any. Its
  // stored islands are tagged with it (region.polygon), so they become that
  // pour's current copper until it is repoured.
  function read(bytes,zones,nets,toLayer,properties,ids,extended=false){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),regions=[];
    let pos=0,total=0;
    while(pos<bytes.length){
      if(pos+5>bytes.length||bytes[pos]!==11)throw Error("Unsupported Regions6 frame.");
      const length=view.getUint32(pos+1,true)&0xffffff,base=pos+5,end=base+length;
      if(end>bytes.length||length<22)throw Error("Truncated Regions6 record.");
      const poly=view.getUint16(base+5,true),owner=view.getUint16(base+7,true),zone=zones[poly],layer=toLayer(bytes[base]);
      pos=end;total++;
      if(!zone || poly===none || owner!==none || (bytes[base+2]&2) || yes(zone.SHELVED) || yes(zone.KEEPOUT) ||
          zone.HATCHSTYLE?.toLowerCase()!=="solid" || zone.POLYGONTYPE?.toLowerCase()!=="polygon" ||
          toLayer(zone.LAYER)!==layer || !/^(?:Top|Bottom|Inner [1-9]\d?)$/.test(layer))continue;
      const propertyLength=view.getUint32(base+18,true),start=base+22+propertyLength;
      if(start+4>end)throw Error("Truncated Regions6 properties.");
      const p=properties(decoder.decode(bytes.subarray(base+22,start)));
      if(p.KIND!=="0" || !/^\d+$/.test(p.SUBPOLYINDEX||"") || yes(p.ISBOARDCUTOUT) || yes(p.ISSHAPEBASED) || toLayer(p.V7_LAYER)!==layer)continue;
      const count=1+view.getUint16(base+14,true),contours=bytes.subarray(start,end);
      const bounds=[Infinity,Infinity,-Infinity,-Infinity];
      const net=zone.NET===undefined?view.getUint16(base+3,true):Number(zone.NET);
      let island;
      if(extended){
        const {rings}=AtriumPCB.regionGeometry(bytes,start,end,count-1,true);
        island=region(rings,layer,nets.get(net));
      }else{
        walk(contours,count,(ring,i,n,x,y)=>{
          if(ring===0){bounds[0]=Math.min(bounds[0],x);bounds[1]=Math.min(bounds[1],y);bounds[2]=Math.max(bounds[2],x);bounds[3]=Math.max(bounds[3],y);}
        });
        island={layer,net:nets.get(net)||"",bounds,count,data:encode(contours)};
      }
      // links:[] until AtriumPolygonPour.adopt() finds the copper the island touches.
      if(ids?.[poly]){island.polygon=ids[poly];island.links=[];island.subPolygonIndex=Number(p.SUBPOLYINDEX);}
      regions.push(island);
    }
    return {regions,total};
  }
  // Encode imported point pairs or the solver's packed XY rings.
  function region(rings,layer,net,extra,native=false){
    const packed=typeof rings[0]?.[0]==="number",count=r=>packed?r.length>>1:r.length;
    let size=0;for(const r of rings)size+=4+count(r)*16;
    const bytes=new Uint8Array(size),v=new DataView(bytes.buffer),bounds=[Infinity,Infinity,-Infinity,-Infinity];let cursor=0;
    rings.forEach((r,k)=>{
      const n=count(r);v.setUint32(cursor,n,true);cursor+=4;
      for(let i=0;i<n;i++){
        const x=packed?r[2*i]:r[i][0],y=packed?r[2*i+1]:r[i][1];
        v.setFloat64(cursor,native?x:x/unit,true);v.setFloat64(cursor+8,native?y:-y/unit,true);cursor+=16;
        if(!k){
          const a=native?x*unit:x,b=native?-y*unit:y;
          if(packed){if(a<bounds[0])bounds[0]=a;if(b<bounds[1])bounds[1]=b;if(a>bounds[2])bounds[2]=a;if(b>bounds[3])bounds[3]=b;}
          else{bounds[0]=Math.min(bounds[0],a);bounds[1]=Math.min(bounds[1],b);bounds[2]=Math.max(bounds[2],a);bounds[3]=Math.max(bounds[3],b);}
        }
      }
    });
    return {layer,net:packed?net:net||"",bounds,count:rings.length,data:encode(bytes),...extra};
  }
  // ASCII Region records use the same unrounded, Y-up, 1/10000 mil coordinates as Regions6.
  function nativeContours(region){
    const rings=[];
    walk(decode(region.data),region.count,(r,i,n,x,y,u,v)=>{if(!i)rings.push([]);rings[r].push([u,v]);});
    return rings;
  }
  // Fingerprint the content affecting stored artwork. Component identity enters
  // only when rules or smart connections read it. Sorted object keys keep a
  // saved/reopened Git-friendly project identical to its in-memory version.
  const geometryFields=["kind","x","y","angle","points","w","h","width","diameter","drill","shape","layer","fromLayer","toLayer","plated","net","pinNets","closed","fill","size","text","keepoutRestrictions","stackMode","padStack","backdrill","tent","ipc4761","slotLength","slotAngle","holeOnly","roundrectRadiusRatio"];
  const zoneFields=["outline","priority","pourIndex","clearance","pourOverSameNet","removeDeadCopper","connectStyle","viaConnectStyle","connectOverrides","reliefConductorWidth","reliefEntries","reliefAngle","reliefAirGap","minPrimLength","arcApproximation","islandAreaThreshold","boardClearance","cutout","shelved","fillMode","hatchPitch","hatchWidth","hatchAngle","powerPlane"];
  // signatureSteps yields every `chunk` items (live pours hash in idle slices); signature drains it.
  // Signals by name, whether stored natively or derived from imported classes.
  function signalScope(doc,p){
    const S=globalThis.AtriumSignals;
    try{if(S?.toLegacy&&S.canonicalLegacy)return S.canonicalLegacy(S.toLegacy(p||null,doc));}catch{/* raw store below */}
    return p?.signals??null;
  }
  function signature(doc,defs,project,verify=false,ruleBook){const g=signatureSteps(doc,defs,Infinity,project,verify,ruleBook);let r=g.next();while(!r.done)r=g.next();return r.value;}
  function* signatureSteps(doc,defs,chunk=Infinity,project,verify=false,ruleBook){
    let hash1=2166136261,hash2=5381,n=0;
    function text(s){for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);hash1=Math.imul(hash1^c,16777619);hash2=Math.imul(hash2,33)^c;}}
    function value(v){
      if(Array.isArray(v)){text("[");for(const x of v)value(x);text("]");}
      else if(v!==null&&typeof v==="object"){
        text("{");for(const k of Object.keys(v).sort())if(k!=="sourceDrillTool"){value(k);value(v[k]);}text("}");
      }else if(typeof v==="number")text(String(globalThis.Atrium?.projectNumber?Atrium.projectNumber(v):v)+",");
      else if(typeof v==="string"){text("s"+v.length+":");text(v);}
      else text(String(v)+",");
    }
    const simpleScope=s=>["all","net","layer"].includes(globalThis.AtriumDesignQueryRecord?.toSelector(s)?.kind);
    const used=new Map();
    const G=globalThis,p=doc.rules&&!ruleBook?null:project??[G.AtriumSignals?.projectOf?.(doc),G.AtriumNavHost?.project?.()].find(x=>x?.documents?.includes(doc)),b=p?.rules,rules=ruleBook??doc.rules??(b&&{...b,list:b.list.filter(r=>!/^erc[A-Z]/.test(r.type)&&(!r.boards||r.boards.includes(doc.id)))})??null;
    value(doc.outline);value(rules);if(rules?.list?.some(r=>[r.scope,r.scope2].some(s=>s&&!simpleScope(s))))value(signalScope(doc,p));
    const variable=((doc.items||[]).some(i=>i.kind==="polygon"&&(i.connectStyle==="auto"||i.viaConnectStyle==="auto"))||
      rules?.list?.some(r=>r.type==="polygonConnect"&&r.enabled!==false&&(r.style&&r.style!=="polygon"||Object.values(r.kinds||{}).some(k=>k.style&&k.style!=="polygon"))));
    if(doc.boardShape?.cutouts?.length){text("cutouts");value(doc.boardShape.cutouts);}
    if(variable){text("stackup");value(doc.stackup||null);}
    const scoped=rules?.list?.some(r=>r.type==="clearance"&&[r.scope,r.scope2].some(s=>s&&!simpleScope(s)));
    if(scoped){text("copper scopes");value(doc.componentClasses);value(doc.rooms);value(signalScope(doc,p));}
    if(doc.pcbDrawing?.sourceFill===true){
      const engine=G.AtriumPolygonPour;
      const custom=engine?.needsScopeTrace?engine.needsScopeTrace(rules):rules?.list?.some(r=>r.enabled!==false&&
        (r.type==="clearance"||r.type==="polygonConnect")&&[r.scope,r.scope2].some(s=>s?.languageVersion===1&&!G.AtriumDesignQueryRecord?.toSelector(s)));
      if(custom){
        if(verify&&!G.AtriumDesignQuery)return null;
        // Only the source's authored inputs can establish the first contour basis.
        // The input-only pass excludes all stored regions, including the artwork being verified.
        text("scoped source copper");
        if(engine?.polygonSignatureSteps&&G.AtriumRules?.kit){
          value(yield* engine.polygonSignatureSteps(doc,defs,{rules,project:project||p||undefined,sourceInputs:true},chunk));
        }else if(verify)return null;
        else text("unverified");
      }
    }
    for(const i of doc.items){
      if(++n>=chunk){n=0;yield;}
      if(i.kind==="netlabel" || i.kind==="label" && !/^(?:Top|Bottom|Multi|Inner \d+)$/.test(i.layer))continue;
      for(const field of geometryFields)if(i[field]!==undefined){text(field);value(i[field]);}
      if(i.kind==="polygon")for(const f of zoneFields)if(i[f]!==undefined){text(f);value(i[f]);}
      if(i.keepout){text("keepout");value(i.keepout);}
      for(const k of ["arc","fillRect","sourcePour","planeVoid"])if(i[k]!=null){text(k);value(i[k]);}
      if(scoped)value([i.name,i.ref,i.number]);
      if(i.kind==="part"){
        const def=defs.get(i.def),g=def?.footprint;
        if(variable)value([i.ref,i.value,def?.name,def?.value,def?.footprintName,g?.name]);
        if(!used.has(g)){used.set(g,used.size);value(g?.pads||[]);value(g?.shapes||[]);}
        text("def"+used.get(g));
      }
      text(";");
    }
    return (hash1>>>0).toString(16).padStart(8,"0")+(hash2>>>0).toString(16).padStart(8,"0");
  }
  // The board's stored copper was poured on exactly this board (its signature still holds).
  function matchesSignature(doc,defs,project,rules){
    const saved=doc.sourcePourSignature??doc.pcbDrawing?.sourceHatchSignature;
    return !!saved&&saved===api.signature(doc,defs,project,true,rules);
  }
  function storeSignature(doc,defs,project){
    const drawing=doc.pcbDrawing,stamp=api.signature(doc,defs,project);
    // Earlier editors require a contour table when a board has sourcePourSignature.
    if(drawing.pours?.length){
      doc.sourcePourSignature=stamp;
      delete drawing.sourceHatchSignature;
    }else{
      drawing.sourceHatchSignature=stamp;
      delete doc.sourcePourSignature;
    }
  }
  // Canvas paths by region, bounded: undo history keeps old regions alive, so a WeakMap kept every
  // generation's path. Past PATH_BUDGET vertices, entries no paint used for 1 s are dropped (oldest
  // first), and past 3x it any but the one in hand; a dropped path is rebuilt if painted again.
  const paths=new Map(),decoded=new Map(),PATH_BUDGET=400000,CONTOUR_BUDGET=700000;
  let pathVertices=0,contourVertices=0;
  const sameGeometry=(entry,region)=>entry.data===region.data&&entry.ringCount===region.count;
  function contours(region){
    const cached=decoded.get(region);
    if(cached&&sameGeometry(cached,region)){decoded.delete(region);decoded.set(region,cached);return cached.rings;}
    if(cached)dropContours(region);
    const rings=[];let count=0;
    walk(decode(region.data),region.count,(r,i,n,x,y)=>{
      if(i===0){rings.push(new Float64Array(n*2));count+=n;}
      rings[r][i*2]=x;rings[r][i*2+1]=y;
    });
    if(count<=CONTOUR_BUDGET){
      decoded.set(region,{rings,count,data:region.data,ringCount:region.count});contourVertices+=count;
      while(contourVertices>CONTOUR_BUDGET)dropContours(decoded.keys().next().value);
    }
    return rings;
  }
  // Horizontal bands index the same stored edges for even-odd containment
  // and for the importer's bounded copper contact search. The DRC ray can
  // stop at edges that end left of it; contact searches also need flat edges.
  function edgeBands(rings,height,bounds){
    const count=rings.reduce((n,ring)=>n+(ring.length>>1),0);
    const contact=!!bounds, countY=Math.max(1,Math.min(4096,Math.ceil(Math.sqrt(count))));
    const y0=contact?bounds[1]:0, h=contact?Math.max(1e-6,(bounds[3]-y0)/countY):height;
    const band=contact?y=>Math.min(countY-1,Math.max(0,Math.floor((y-y0)/h))):y=>Math.floor(y/h);
    const edges=new Float64Array(5*count),lists=new Map();
    let edge=0;
    for(const ring of rings)for(let i=0,j=ring.length-2;i<ring.length;j=i,i+=2,edge+=5){
      const a=contact?j:i,b=contact?i:j,ax=ring[a],ay=ring[a+1],bx=ring[b],by=ring[b+1];
      if(!contact&&ay===by)continue;
      edges[edge]=ax;edges[edge+1]=ay;edges[edge+2]=bx;edges[edge+3]=by;
      edges[edge+4]=Math.max(ax,bx)+1e-9*(1+Math.abs(ax)+Math.abs(bx));
      for(let k=band(Math.min(ay,by)),last=band(Math.max(ay,by));k<=last;k++){
        let row=lists.get(k);
        if(!row)lists.set(k,row=[]);
        row.push(edge);
      }
    }
    if(!contact)for(const [id,row] of lists)lists.set(id,Int32Array.from(row).sort((a,b)=>edges[b+4]-edges[a+4]));
    function inside(x,y){
      if(contact&&(x<bounds[0]||x>bounds[2]||y<bounds[1]||y>bounds[3]))return false;
      let odd=false;
      for(const edge of lists.get(band(y))||[]){
        if(!contact&&edges[edge+4]<x)break;
        const ax=edges[edge],ay=edges[edge+1],bx=edges[edge+2],by=edges[edge+3];
        if((ay>y)!==(by>y)&&x<ax+(y-ay)*(bx-ax)/(by-ay))odd=!odd;
      }
      return odd;
    }
    return {inside,band,edges,lists};
  }
  // The solver's accepted arc runs belong to stored copper, independently of its
  // rendering LOD. Read them in model millimetres before any fabrication quantization.
  function contourEdges(region, rings = contours(region)) {
    const arcs = region.arcs, runs = new Map();
    for (let j = 0; arcs && j + 4 < arcs.length; j += 5) {
      const [ring, first, last, x, y] = arcs.slice(j, j + 5);
      if (!Number.isInteger(ring) || !Number.isInteger(first) || !Number.isInteger(last) ||
          first < 0 || last - first < 2 || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!runs.has(ring)) runs.set(ring, new Map());
      runs.get(ring).set(first, {last, x, y});
    }
    return rings.map((ring, ri) => {
      const length = ring.length / 2, edges = [], at = index => [ring[2 * (index % length)], ring[2 * (index % length) + 1]];
      const marks = runs.get(ri);
      for (let i = 0; i < length;) {
        const a = at(i), mark = marks?.get(i);
        if (mark && mark.last <= length) {
          const b = at(mark.last), dx = b[0] - a[0], dy = b[1] - a[1], width = Math.hypot(dx, dy);
          if (width > 0) {
            // The stored centre is rounded to a nanometre. Its projection onto
            // the bisector preserves the authored endpoints without loose joins.
            const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, nx = -dy / width, ny = dx / width;
            const offset = (mark.x - mx) * nx + (mark.y - my) * ny;
            const center = [mx + offset * nx, my + offset * ny];
            const param = p => Math.atan2(center[1] - p[1], p[0] - center[0]) * 180 / Math.PI;
            const radius = Math.hypot(a[0] - center[0], a[1] - center[1]);
            const start = param(a), end = param(b), mid = param(at(Math.floor((i + mark.last) / 2)));
            const rise = v => (v - start + 360) % 360;
            const forward = rise(end), sweep = rise(mid) <= forward ? forward : forward - 360;
            if (sweep && Math.abs(sweep) < 360) {
              edges.push({kind: "arc", center, radius, start, sweep});
              i = mark.last;
              continue;
            }
          }
        }
        edges.push({kind: "line", a, b: at(i + 1)});
        i++;
      }
      return edges;
    });
  }
  function contourSegments(region, rings) {
    return contourEdges(region, rings).map(edges => edges.map(g => g.kind === "line" ? g : {
      kind: "arc", c: g.center, r: g.radius, start: g.start, end: g.start + g.sweep, ccw: g.sweep > 0
    }));
  }
  function dropContours(region){const e=decoded.get(region);if(e){contourVertices-=e.count;decoded.delete(region);}}
  function pathOf(region){
    let e=paths.get(region);
    if(e&&!sameGeometry(e,region)){paths.delete(region);pathVertices-=e.count;e=null;}
    if(!e){
      const path=new Path2D();let count=0;
      try{
        walk(decode(region.data),region.count,(ring,i,n,x,y)=>{count++;
          // No closePath: the path is only filled, which closes each ring, and Chrome's
          // Path2D.closePath costs time proportional to the whole path (quadratic over many holes).
          if(i===0)path.moveTo(x,y);else path.lineTo(x,y);
        });
        e={path,count};
      }catch{e={path:null,count:0};}
      e.data=region.data;e.ringCount=region.count;
      paths.set(region,e);pathVertices+=e.count;
      if(pathVertices>PATH_BUDGET){
        const old=Date.now()-1000;
        for(const [r,x] of paths){if(pathVertices<=PATH_BUDGET)break;if(r!==region&&(x.used<old||pathVertices>3*PATH_BUDGET)){paths.delete(r);pathVertices-=x.count;}}
      }
    }else{paths.delete(region);paths.set(region,e);}
    e.used=Date.now();
    return e.path;
  }
  // Build a region's canvas path ahead of its first paint (live pours do it in an idle slice).
  function warm(region){if(typeof Path2D==="function"&&region&&typeof region.data==="string")pathOf(region);}
  // paintHook: live pour tile patches (polygon-pour.js).
  function paint(ctx,region){paintWith(ctx,region,()=>fill(ctx,region));}
  // How a region paints, given its fill (canvas-fast.js passes the rings in view): a Repour All reveal
  // (pour-anim.js: an alpha and a sweep clip, while a run shows), then the live pour tile patches.
  function paintWith(ctx,region,fillIt){
    const a=globalThis.AtriumPourAnim?.of?.(region);
    if(!a){if(!api.paintHook?.(ctx,region,fillIt))fillIt();return;}
    if(!(a.alpha>0))return;
    ctx.save();ctx.globalAlpha*=a.alpha;
    if(a.clip){ctx.beginPath();ctx.rect(a.clip[0],-1e7,a.clip[1]-a.clip[0],2e7);ctx.clip();}
    if(!api.paintHook?.(ctx,region,fillIt))fillIt();
    ctx.restore();
  }
  function fill(ctx,region){
    if(typeof Path2D==="function"){
      const e=lodPath(ctx,region);
      if(e){ctx.fill(e.path,"evenodd");return;}
      const path=pathOf(region);if(path)ctx.fill(path,"evenodd");
    }else{
      let rings;try{rings=contours(region);}catch{return;}
      ctx.beginPath();for(const xy of rings){
        ctx.moveTo(xy[0],xy[1]);for(let i=2;i<xy.length;i+=2)ctx.lineTo(xy[i],xy[i+1]);ctx.closePath();
      }
      ctx.fill("evenodd");
    }
  }
  // ---- display LOD
  // A big region whose vertices crowd within a device pixel fills rings simplified to LOD.tolerance px
  // (radial, then Douglas-Peucker; every ring kept, 3+ vertices). Level L is within LOD_BASE*2^L mm of
  // the stored rings; a frame uses the coarsest built level within tolerance, the stored rings below
  // LOD_MIN. Built in idle slices from the stored rings. Display only: hit tests, DRC, Gerber and data
  // never see them; print/PDF fill the stored rings, a raster export its own resolution's level.
  const LOD_BASE=.002,LOD_MIN=4,LOD_MAX=10,LOD_REGION_MIN=1500,LOD_BUDGET=1000000;
  const lodCache=new Map(),lodQueue=[];
  let lodVertices=0,lodScheduled=false;
  const LOD={enabled:true,tolerance:.5,version:0,keyAt,stats:()=>({regions:lodCache.size,vertices:lodVertices,queued:lodQueue.length,built:LOD.built,buildMs:+LOD.buildMs.toFixed(1),saved:LOD.saved}),built:0,buildMs:0,saved:0};
  // Vertex count from the encoded size: per ring a 4-byte count, per vertex 16 bytes.
  const verticesOf=r=>typeof r?.data==="string"?Math.max(0,((r.data.length*3>>2)-4*(r.count||0))>>4):0;
  function lodLevel(ctx){
    if(!LOD.enabled||typeof ctx?.getTransform!=="function"||typeof ctx.fill!=="function")return -1;
    const C=globalThis.CanvasRenderingContext2D,O=globalThis.OffscreenCanvasRenderingContext2D;
    if(!(C&&ctx instanceof C)&&!(O&&ctx instanceof O))return -1;
    const m=ctx.getTransform();
    return levelOf(Math.sqrt(Math.abs(m.a*m.d-m.b*m.c)));
  }
  // The level for k device pixels per mm (-1: the stored rings).
  function levelOf(k){
    if(!LOD.enabled||!(k>0))return -1;
    const L=Math.floor(Math.log2(LOD.tolerance/k/LOD_BASE));
    return L<LOD_MIN?-1:Math.min(L,LOD_MAX);
  }
  function keyAt(k){
    const level=levelOf(k);
    return level<0?"stored":level+":"+LOD.version;
  }
  function lodPath(ctx,region){
    const best=lodAt(lodLevel(ctx),region);
    if(best&&!best.path)best.path=ringsPath(best.rings);
    return best;
  }
  // The coarsest built level within L (L queued for building when it is not), or null.
  function lodAt(L,region){
    if(L<0||!(region?.count>0)||verticesOf(region)<LOD_REGION_MIN)return null;
    let e=lodCache.get(region);
    if(e&&!sameGeometry(e,region)){dropLod(region);e=null;}
    if(!e){e={lv:[],want:new Set(),used:0,data:region.data,ringCount:region.count};lodCache.set(region,e);}
    else{lodCache.delete(region);lodCache.set(region,e);}
    e.used=Date.now();
    let best=null;for(let l=L;l>=LOD_MIN&&!best;l--)best=e.lv[l]||null;
    if(!e.lv[L]&&!e.want.has(L)){e.want.add(L);lodQueue.push({region,e,L,src:null,out:null,i:0,n:0});}
    if(lodQueue.length)lodSchedule();
    return best;
  }
  // The GPU renderer (canvas-gpu.js) fills the same rings as the 2D path at k device pixels per mm:
  // {rings, level}, or null for the stored rings.
  function lodRingsAt(region,k){const e=lodAt(levelOf(k),region);return e?{rings:e.rings,level:e.level}:null;}
  function lodRings(ctx,region){return lodAt(lodLevel(ctx),region)?.rings||null;}
  function ringsPath(rings){
    const p=new Path2D();
    for(const xy of rings){p.moveTo(xy[0],xy[1]);for(let i=2;i<xy.length;i+=2)p.lineTo(xy[i],xy[i+1]);}
    return p;
  }
  function lodSchedule(){
    if(lodScheduled)return;lodScheduled=true;
    const I=globalThis.AtriumIdle,run=d=>{lodScheduled=false;lodWork(d);};
    if(I?.idle)I.idle(run,{timeout:1000});
    else if(typeof requestIdleCallback==="function")requestIdleCallback(run,{timeout:1000});
    else setTimeout(run,50);
  }
  // Build queued levels for the idle period, 3 to 6 ms; a big region resumes ring by ring.
  function lodWork(deadline){
    if(globalThis.AtriumPower?.visible?.()===false)return;
    const clock=()=>globalThis.performance?.now?.()??Date.now(),p0=clock();
    const idleMs=deadline&&typeof deadline.timeRemaining==="function"&&!deadline.didTimeout?deadline.timeRemaining():6;
    const budget=Math.max(3,Math.min(6,idleMs)),left=()=>budget-(clock()-p0);
    let finished=0;
    while(lodQueue.length&&left()>1){
      const j=lodQueue[0];
      if(lodCache.get(j.region)!==j.e){lodQueue.shift();continue;}
      if(!sameGeometry(j.e,j.region)){dropLod(j.region);lodQueue.shift();continue;}
      if(!j.src){
        try{j.src=contours(j.region);}catch{lodQueue.shift();continue;}
        j.out=new Array(j.src.length);
      }
      const tol=LOD_BASE*2**j.L;
      while(j.i<j.src.length&&left()>.5){const r=simplify(j.src[j.i],tol);j.out[j.i++]=r;j.n+=r.length>>1;}
      if(j.i<j.src.length)break;
      lodQueue.shift();
      j.e.lv[j.L]={rings:j.out,count:j.n,path:null,level:j.L};j.e.want.delete(j.L);
      lodVertices+=j.n;LOD.built++;LOD.saved+=verticesOf(j.region)-j.n;finished++;
    }
    LOD.buildMs+=clock()-p0;
    if(lodVertices>LOD_BUDGET){
      const old=Date.now()-2000;
      for(const [r,e] of lodCache){if(lodVertices<=LOD_BUDGET)break;if(e.used<old||lodVertices>2*LOD_BUDGET)dropLod(r);}
    }
    if(finished&&!lodQueue.length){
      LOD.version++;
      const host=globalThis.AtriumNavHost;
      try{if(host?.redrawPourLOD)host.redrawPourLOD();else host?.redraw?.();}catch{/* no editor */}
    }
    if(lodQueue.length)lodSchedule();
  }
  function dropLod(region){
    const e=lodCache.get(region);if(!e)return;
    for(const l of e.lv)if(l)lodVertices-=l.count;
    lodCache.delete(region);
  }
  // Undo retains the stored region and can rebuild these display caches if that state is shown.
  function release(previous,current){
    if(!previous?.length)return;
    const keep=new Set(current),drop=new Set(previous.filter(region=>!keep.has(region)));
    for(const region of drop){
      const e=paths.get(region);if(e){pathVertices-=e.count;paths.delete(region);}
      dropContours(region);dropLod(region);
    }
    for(let i=lodQueue.length-1;i>=0;i--)if(drop.has(lodQueue[i].region))lodQueue.splice(i,1);
  }
  // One closed ring (flat x,y) within tol: drop vertices closer than tol to the last kept one, then
  // Douglas-Peucker on the two halves split at the vertex farthest from the first. At least 3 vertices.
  const lodStack=[];
  function simplify(xy,tol){
    const n=xy.length>>1;
    if(n<=4)return xy;
    const t2=tol*tol,keep=new Uint8Array(n);
    // Radial pass: candidate indices.
    const cand=[0];let lx=xy[0],ly=xy[1];
    for(let i=1;i<n;i++){const dx=xy[2*i]-lx,dy=xy[2*i+1]-ly;if(dx*dx+dy*dy>t2){cand.push(i);lx=xy[2*i];ly=xy[2*i+1];}}
    const m=cand.length;
    if(m<3)return tiny(xy,n);
    let far=1,fd=-1;for(let k=1;k<m;k++){const i=cand[k],dx=xy[2*i]-xy[0],dy=xy[2*i+1]-xy[1],d=dx*dx+dy*dy;if(d>fd){fd=d;far=k;}}
    keep[cand[0]]=1;keep[cand[far]]=1;
    const dp=(a,b)=>{
      lodStack.length=0;lodStack.push(a,b);
      while(lodStack.length){
        const z=lodStack.pop(),s=lodStack.pop();if(z-s<2)continue;
        const i0=cand[s],i1=cand[z%m],ax=xy[2*i0],ay=xy[2*i0+1],bx=xy[2*i1],by=xy[2*i1+1],dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
        let best=-1,bd=t2;
        for(let k=s+1;k<z;k++){
          const i=cand[k],px=xy[2*i]-ax,py=xy[2*i+1]-ay;
          let d;
          if(l2>0){const c=px*dy-py*dx;d=c*c/l2;}else d=px*px+py*py;
          if(d>bd){bd=d;best=k;}
        }
        if(best>=0){keep[cand[best]]=1;lodStack.push(s,best,best,z);}
      }
    };
    dp(0,far);dp(far,m);
    let c=0;for(let i=0;i<n;i++)c+=keep[i];
    if(c<3)return tiny(xy,n);
    if(c>=n*.9)return xy;
    const out=new Float64Array(c*2);let o=0;
    for(let i=0;i<n;i++)if(keep[i]){out[o++]=xy[2*i];out[o++]=xy[2*i+1];}
    return out;
  }
  // A ring within the tolerance of a point: first vertex, the farthest from it, the farthest from that chord.
  function tiny(xy,n){
    let a=0,ad=-1;for(let i=1;i<n;i++){const dx=xy[2*i]-xy[0],dy=xy[2*i+1]-xy[1],d=dx*dx+dy*dy;if(d>ad){ad=d;a=i;}}
    const ax=xy[0],ay=xy[1],dx=xy[2*a]-ax,dy=xy[2*a+1]-ay;
    let b=a===1?2:1,bd=-1;for(let i=1;i<n;i++){if(i===a)continue;const c=Math.abs((xy[2*i]-ax)*dy-(xy[2*i+1]-ay)*dx);if(c>bd){bd=c;b=i;}}
    const idx=[0,a,b].sort((p,q)=>p-q),out=new Float64Array(6);
    idx.forEach((i,k)=>{out[2*k]=xy[2*i];out[2*k+1]=xy[2*i+1];});
    return out;
  }
  const api={read,signalScope,signature,signatureSteps,matchesSignature,storeSignature,contours,edgeBands,contourEdges,contourSegments,nativeContours,paint,paintWith,warm,release,region,paintHook:null,lod:LOD,lodRings,lodRingsAt,simplify};
  return api;
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumPCBPours;
