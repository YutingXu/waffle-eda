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
    const {bytes,bounds,packed}=regionBytes(rings,native);
    return {layer,net:packed?net:net||"",bounds,count:rings.length,data:encode(bytes),...extra};
  }
  // region()'s answer, or the region of `prior` (removed from it) with exactly that content: the same
  // layer, net, rings (byte for byte) and other fields. A repour that leaves an island as it was then
  // keeps its object, so nothing is encoded again and every cache of it holds. A new region holds its
  // rings as runs (withCopper): the runs it shares with the pour's earlier regions are the same objects.
  function regionLike(prior,rings,layer,net,extra){
    const {bytes,bounds,packed}=regionBytes(rings,false),n=packed?net:net||"";
    let fresh=null;
    try{fresh=tableFrom({count:rings.length,data:null},bytes);}catch{fresh=null;}
    for(let i=0;fresh&&i<(prior?.length||0);i++){
      const p=prior[i];
      if(p.layer!==layer||(p.net||"")!==(n||"")||p.count!==rings.length)continue;
      let t;try{t=table(p);}catch{continue;}
      if(t.bytes!==bytes.length||t.runs.length!==fresh.runs.length)continue;
      let same=true;for(let k=0;k<t.n&&same;k++)same=t.h1[k]===fresh.h1[k]&&t.h2[k]===fresh.h2[k];
      if(!same)continue;
      const c=copperOf(p);
      if(c)for(let j=0;j<c.runs.length&&same;j++)same=sameBytes(c.runs[j].bytes,bytes,fresh.runs[j].b0);
      else{const old=decode(p.data);for(let k=0;k<old.length&&same;k++)same=old[k]===bytes[k];}
      if(!same||!sameFields(p,extra))continue;
      prior.splice(i,1);
      return p;
    }
    const base={layer,net:n,bounds,count:rings.length,data:"",...extra};
    if(!fresh){base.data=encode(bytes);return base;}   // walk() reports what is wrong when it is read
    // True arcs ([ring, i0, i1, cx, cy, ...] in ring order) go with the runs of their rings.
    const arcs=arcsByRun(extra?.arcs,fresh);
    return withCopper(base,new Copper(fresh.runs.map((run,j)=>intern(runOf(bytes,fresh,run,arcs?.[j]))),rings.length,!!arcs));
  }
  const sameBytes=(a,b,at)=>{for(let i=0;i<a.length;i++)if(a[i]!==b[at+i])return false;return true;};
  const BASE_FIELDS=new Set(["layer","net","bounds","count","data"]);
  const sameValue=(a,b)=>a===b||Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&(a.every(x=>typeof x==="number")&&b.every(x=>typeof x==="number")?a.every((x,i)=>x===b[i]):JSON.stringify(a)===JSON.stringify(b))||
    !Array.isArray(a)&&!Array.isArray(b)&&JSON.stringify(a)===JSON.stringify(b);
  function sameFields(p,extra){
    const keys=Object.keys(p).filter(k=>!BASE_FIELDS.has(k)&&p[k]!==undefined),more=Object.keys(extra||{}).filter(k=>extra[k]!==undefined);
    if(keys.length!==more.length)return false;
    for(const k of keys)if(!(k in extra)||!sameValue(p[k],extra[k]))return false;
    return true;
  }
  // A region's arcs split by the runs of table t (each relative to its run's first ring), or null when
  // they cannot be (not ring-ordered numbers): they then stay an ordinary field.
  function arcsByRun(arcs,t){
    if(!Array.isArray(arcs)||!arcs.length||arcs.length%5)return null;
    const out=t.runs.map(()=>[]);let j=0,last=-1;
    for(let i=0;i<arcs.length;i+=5){
      const ring=arcs[i];
      if(!Number.isInteger(ring)||ring<last||ring>=t.n)return null;
      for(let k=1;k<5;k++)if(typeof arcs[i+k]!=="number")return null;
      last=ring;
      while(ring>=t.runs[j].k1)j++;
      out[j].push(ring-t.runs[j].k0,arcs[i+1],arcs[i+2],arcs[i+3],arcs[i+4]);
    }
    return out.map(a=>a.length?Float64Array.from(a):null);
  }
  function regionBytes(rings,native){
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
    return {bytes,bounds,packed};
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
  // ---- runs
  // A region's stored bytes are its rings in canonical order (the outer ring, then the holes sorted by
  // their lowest vertex), each [u32 n][n x (f64 u, f64 w)]. A run is a stretch of whole rings that ends
  // after a ring whose content hash has its low RUN_BITS bits clear, or before a ring that would take it
  // past RUN_MAX bytes. A boundary depends only on the ring before it, so adding, removing or changing
  // a ring moves no boundary but its own. A run is known by a key made from its rings' content (two
  // 32-bit hashes, its ring count and byte length), so every version of a region that shares a run
  // shares what is cached for it: decoded rings and their boxes, canvas paths, display LOD. A small
  // edit inside a large island then costs the runs it changed, not the island.
  //   table(region)  -> {n, h1, h2, at, runs: [{key, k0, k1, b0, b1}]} (cached per region and data)
  //   runsOf(region) -> the run list; contours(region) -> the decoded rings, assembled from runs.
  // Display caches keyed by region (Undo keeps old regions alive) are bounded: past their budget, the
  // entries no paint used recently are dropped (oldest first); a dropped entry is rebuilt if needed.
  const RUN_BITS=5,RUN_MASK=(1<<RUN_BITS)-1,RUN_MAX=262144;
  const tables=new WeakMap(),runCache=new Map(),RUN_BUDGET=1200000;
  const paths=new Map(),decoded=new Map(),PATH_BUDGET=400000,RUN_PATH_BUDGET=600000,DECODED_MAX=256;
  let pathVertices=0,runVertices=0,runPathVertices=0;
  // Caches remember the data they were made from by dataKey (no text is joined to check them).
  const sameGeometry=(entry,region)=>entry.data===dataKey(region)&&entry.ringCount===region.count;
  // Ring hashes straight from the stored words: h1 is copperChange's FNV-1a (seeded by the ring's role,
  // 0 outer, 1 hole), h2 an independent multiply-xorshift hash.
  function ringHash1(w,from,to,role){let h=2166136261^role;for(let i=from;i<to;i++)h=Math.imul(h^w[i],16777619);return h>>>0;}
  function ringHash2(w,from,to,role){
    let h=0x9747b28c^role^(to-from);
    for(let i=from;i<to;i++){h=Math.imul(h^w[i],0x5bd1e995);h^=h>>>15;}
    h=Math.imul(h^(h>>>13),0x85ebca6b);return (h^(h>>>16))>>>0;
  }
  const mixKey=(a,x)=>{a=Math.imul(a^x,0x27d4eb2d);return (a^(a>>>15))>>>0;};
  // The table of region r from its stored bytes (validated as walk() validates them). Throws on bad data.
  function tableFrom(r,bytes){
    if(!Number.isInteger(r.count)||r.count<1||r.count>bytes.length/52)throw Error("Invalid pour hole count.");
    if(bytes.byteOffset%4||bytes.byteLength%4)bytes=bytes.slice();
    const n=r.count,w=new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength>>2),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const h1=new Uint32Array(n),h2=new Uint32Array(n),at=new Uint32Array(n+1),runs=[];
    let cursor=0,k0=0,b0=0,a=0x811c9dc5,b=0x165667b1;
    const close=k=>{if(k>k0){runs.push({key:(a>>>0).toString(36)+"."+(b>>>0).toString(36)+"."+(k-k0)+"."+(at[k]-b0),k0,k1:k,b0,b1:at[k]});}k0=k;b0=at[k];a=0x811c9dc5;b=0x165667b1;};
    for(let k=0;k<n;k++){
      if(cursor+4>bytes.length)throw Error("Truncated pour contour.");
      const vertices=view.getUint32(cursor,true);
      if(vertices<3||vertices>(bytes.length-cursor-4)/16)throw Error("Invalid pour vertex count.");
      const size=4+16*vertices;
      if(k>k0&&cursor+size-b0>RUN_MAX){at[k]=cursor;close(k);}
      at[k]=cursor;
      const from=(cursor>>2)+1,to=from+4*vertices,role=k?1:0;
      h1[k]=ringHash1(w,from,to,role);h2[k]=ringHash2(w,from,to,role);
      a=mixKey(a,h1[k]);b=mixKey(b,h2[k]);
      cursor+=size;at[k+1]=cursor;
      if((h2[k]&RUN_MASK)===0)close(k+1);
    }
    if(cursor!==bytes.length)throw Error("Unrecognized Regions6 contour trailer.");
    close(n);
    return {data:r.data,ringCount:r.count,n,h1,h2,at,runs,bytes:bytes.length};
  }
  function table(region,bytes){
    const t=tables.get(region);
    if(t&&sameGeometry(t,region))return t;
    const c=copperOf(region),made=c?copperTable(c):tableFrom(region,bytes||decode(region.data));
    tables.set(region,made);
    return made;
  }

  // ---- copper held as runs
  // A region the pour engine makes (regionLike, or from the live worker's runs) holds its rings as runs:
  // Run {key, bytes, n, h1, h2, at} (at: ring offsets within the run), interned by key, so every
  // version of a region, and every region that has the same rings in a row, shares one object for
  // them. Its `data` is an accessor: reading it joins the runs into the stored base64 text (kept for a
  // while, bounded), so saving, exporting and every other reader of the text get the bytes they always
  // did, and writing it makes an ordinary region again. Code on the edit path reads the runs instead,
  // through this module only: dataKey(r) and sameData(a, b) (what a cache keys on), dataLength(r),
  // contours and tables, copperOf(r) / withCopper(o, c) (the undo store's shared fields), copperRuns(c)
  // and copperText(records) (recovery drafts), fieldsOf / fromRuns / runLookup (the live worker).
  const copperOfRegion=new WeakMap(),runStore=new Map(),TEXT_BUDGET=1<<25;
  const runGone=typeof FinalizationRegistry==="function"?new FinalizationRegistry(key=>{const w=runStore.get(key);if(w&&!w.deref())runStore.delete(key);}):null;
  // arcs: the region's true arcs are held by its runs (Run.arcs) and its `arcs` field reads them too.
  class Copper{
    constructor(runs,count,arcs=false){
      this.runs=runs;this.count=count;this.arcs=arcs;let b=0,s=0;for(const r of runs){b+=r.bytes.length;s+=r.size;}
      this.bytes=b;this.size=s;this.chars=4*Math.ceil(b/3);
    }
    // The text of the data (Array.join and String() of a copper give it).
    toString(){return textOf(this);}
    // Content, not text, for hashes over values that hold a copper (the undo store's checks).
    toJSON(){return "copper:"+this.count+":"+this.runs.map(r=>r.id).join(",");}
  }
  const isCopper=x=>x instanceof Copper;
  // One run of a region's bytes (a copy), with its rings' hashes and offsets, and its true arcs. A run is
  // found by id (key: its rings; id: its rings and arcs). Geometry caches key on key.
  function runOf(bytes,t,run,arcs=null){
    const at=new Uint32Array(run.k1-run.k0+1);for(let k=run.k0;k<=run.k1;k++)at[k-run.k0]=t.at[k]-run.b0;
    return made({key:run.key,bytes:bytes.slice(run.b0,run.b1),n:run.k1-run.k0,h1:t.h1.slice(run.k0,run.k1),h2:t.h2.slice(run.k0,run.k1),at,arcs});
  }
  function made(run){
    let id=run.key;
    if(run.arcs){const w=new Uint32Array(run.arcs.buffer,run.arcs.byteOffset,run.arcs.length*2);id+=":"+ringHash1(w,0,w.length,2).toString(36)+"."+ringHash2(w,0,w.length,2).toString(36);}
    run.id=id;run.size=run.bytes.length+(run.arcs?run.arcs.byteLength:0);
    return run;
  }
  const sameArcs=(a,b)=>a===b||!!a&&!!b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
  // The run already held under its id when it has the same bytes and arcs (a different run with the
  // same id, which the 64-bit hashes make all but impossible, gets an id of its own).
  function intern(run){
    let other=false;
    for(let k=0;;k++){
      const id=k?run.id+"~"+k:run.id,held=runStore.get(id)?.deref();
      if(!held){
        run.id=id;if(other)run.key+="~"+k;   // other rings under the same key: a key of its own too
        runStore.set(id,typeof WeakRef==="function"?new WeakRef(run):{deref:()=>run});runGone?.register(run,id);return run;
      }
      const sameRings=held.bytes.length===run.bytes.length&&sameBytes(held.bytes,run.bytes,0);
      if(sameRings&&sameArcs(held.arcs,run.arcs))return held;
      other||=!sameRings;
    }
  }
  function copperTable(c){
    let n=0;for(const r of c.runs)n+=r.n;
    const h1=new Uint32Array(n),h2=new Uint32Array(n),at=new Uint32Array(n+1),runs=[];
    let k=0,b=0;
    for(const r of c.runs){
      h1.set(r.h1,k);h2.set(r.h2,k);for(let i=0;i<r.n;i++)at[k+i]=b+r.at[i];
      runs.push({key:r.key,k0:k,k1:k+r.n,b0:b,b1:b+r.bytes.length,run:r});k+=r.n;b+=r.bytes.length;
    }
    at[n]=b;
    return {data:c,ringCount:c.count,n,h1,h2,at,runs,bytes:b};
  }
  // o (an ordinary region object, its other fields in place) now holds c; its data reads as c's text,
  // and its arcs (when c holds them) as c's arcs. Writing either makes it an ordinary field again.
  function withCopper(o,c){
    const field=(k,read)=>{
      if(!(k in o))o[k]=null;
      Object.defineProperty(o,k,{enumerable:true,configurable:true,get(){return copperOfRegion.get(this)===c?read(c):undefined;},
        set(v){if(k==="data")copperOfRegion.delete(this);Object.defineProperty(this,k,{value:v,writable:true,enumerable:true,configurable:true});}});
    };
    field("data",textOf);
    if(c.arcs&&"arcs" in o)field("arcs",arcsOf);   // (an object rebuilt field by field gets its arcs when it reaches them)
    copperOfRegion.set(o,c);
    return o;
  }
  // A copper's arcs as the region's field reads: [ring, i0, i1, cx, cy, ...] (kept, as texts are).
  const arcLists=new Map();let arcNumbers=0;
  function arcsOf(c){
    let a=arcLists.get(c);
    if(a){arcLists.delete(c);arcLists.set(c,a);return a;}
    a=[];let k=0;
    for(const r of c.runs){if(r.arcs)for(let i=0;i<r.arcs.length;i+=5)a.push(r.arcs[i]+k,r.arcs[i+1],r.arcs[i+2],r.arcs[i+3],r.arcs[i+4]);k+=r.n;}
    arcLists.set(c,a);arcNumbers+=a.length;
    for(const [x,v] of arcLists){if(arcNumbers<=TEXT_BUDGET>>4||x===c)break;arcLists.delete(x);arcNumbers-=v.length;}
    return a;
  }
  const copperArcs=c=>c?.arcs?arcsOf(c):null;
  // The copper behind field k of a region, when its copper holds that field (its data; its arcs too).
  const heldField=(region,k)=>{const c=(k==="data"||k==="arcs")&&copperOf(region);return c&&(k==="data"||c.arcs)?c:null;};
  function copperOf(region){
    const c=region&&typeof region==="object"?copperOfRegion.get(region):null;
    return c&&Object.getOwnPropertyDescriptor(region,"data")?.get?c:null;
  }
  // What a cache of a region's data keys on: its copper, or its data text.
  const dataKey=region=>copperOf(region)||region?.data;
  // Whether two regions hold the same data (the same runs, or the same text), joining no text.
  function sameData(a,b){
    const ca=copperOf(a),cb=copperOf(b);
    if(!ca&&!cb)return a.data===b.data;
    if(ca&&cb)return ca===cb||ca.count===cb.count&&ca.runs.length===cb.runs.length&&ca.runs.every((r,i)=>r===cb.runs[i]);
    let ta,tb;try{ta=table(a);tb=table(b);}catch{return false;}
    return ta.bytes===tb.bytes&&ta.n===tb.n&&ta.runs.length===tb.runs.length&&ta.runs.every((r,i)=>r.key.split("~")[0]===tb.runs[i].key.split("~")[0])&&a.data===b.data;
  }
  // The length of the data text, and whether there is any.
  const dataLength=region=>{const c=copperOf(region);return c?c.chars:typeof region?.data==="string"?region.data.length:0;};
  const hasData=region=>!!copperOf(region)||typeof region?.data==="string";
  // A copper's text: the runs' bytes joined and base64-encoded, kept while within TEXT_BUDGET characters.
  const texts=new Map();let textChars=0;
  function textOf(c){
    let s=texts.get(c);
    if(s!==undefined){texts.delete(c);texts.set(c,s);return s;}
    const all=new Uint8Array(c.bytes);let o=0;for(const r of c.runs){all.set(r.bytes,o);o+=r.bytes.length;}
    s=encode(all);texts.set(c,s);textChars+=s.length;
    for(const [k,v] of texts){if(textChars<=TEXT_BUDGET||k===c)break;texts.delete(k);textChars-=v.length;}
    return s;
  }
  // A region's own fields with the ones its copper holds left empty in place (no text joined), for a
  // message to or from the worker: {fields, runs: ids} and fromRuns rebuild it.
  function fieldsOf(region){
    const c=copperOf(region),o={};
    for(const k of Object.keys(region))o[k]=k==="data"||c?.arcs&&k==="arcs"?null:region[k];
    return o;
  }
  // Runs by id from regions an editor already holds (their copper, or slices of their text), for
  // fromRuns: the live worker sends only the runs the editor does not have.
  // The runs of a region held as text, by id ({t, run, arcs}): its arcs split by run as regionLike
  // splits them. Empty when its arcs cannot be (they are then sent whole).
  function textRuns(r){
    let t;try{t=table(r);}catch{return [];}
    const arcs=Array.isArray(r.arcs)&&r.arcs.length?arcsByRun(r.arcs,t):null;
    if(Array.isArray(r.arcs)&&r.arcs.length&&!arcs)return [];
    return t.runs.map((run,j)=>{
      const a=arcs?.[j]||null,x={key:run.key,arcs:a,bytes:new Uint8Array(0)};made(x);
      return {id:x.id,t,run,arcs:a};
    });
  }
  function runLookup(regions){
    const at=new Map();
    for(const r of regions||[]){
      const c=copperOf(r);
      if(c){for(const run of c.runs)at.set(run.id,run);continue;}
      for(const x of textRuns(r))if(!at.has(x.id))at.set(x.id,{region:r,...x});
    }
    return id=>{
      const x=at.get(id);
      if(!x||x.bytes)return x||null;
      const g0=Math.floor(x.run.b0/3),g1=Math.ceil(x.run.b1/3),bytes=decode(x.region.data.slice(4*g0,4*g1));
      const run=intern(runOf(bytes,{...x.t,at:x.t.at.map(v=>v-3*g0)},{...x.run,b0:x.run.b0-3*g0,b1:x.run.b1-3*g0},x.arcs));
      at.set(id,run);return run;
    };
  }
  // The ids the worker may name without sending the run: the runs of regions the editor holds.
  function runIds(regions){
    const ids=new Set();
    for(const r of regions||[]){
      const c=copperOf(r);
      if(c){for(const run of c.runs)ids.add(run.id);continue;}
      for(const x of textRuns(r))ids.add(x.id);
    }
    return ids;
  }
  // A region from its fields (fieldsOf) and run ids: the runs from `runs` (id -> run as sent) or from
  // lookup. Null when a run is missing.
  function fromRuns(fields,ids,runs,lookup){
    const list=[];let arcs=false;
    for(const id of ids){
      const sent=runs?.get(id),run=sent?intern(made({key:sent.key,bytes:sent.bytes,n:sent.n,h1:sent.h1,h2:sent.h2,at:sent.at,arcs:sent.arcs||null})):lookup?.(id);
      if(!run)return null;
      arcs||=!!run.arcs;
      list.push(run);
    }
    const o={};for(const k of Object.keys(fields))o[k]=fields[k];
    return withCopper(o,new Copper(list,fields.count,arcs||fields.arcs===null));
  }
  // A run as a message or a recovery record carries it (structured clone).
  const runRecord=run=>({id:run.id,key:run.key,bytes:run.bytes,n:run.n,h1:run.h1,h2:run.h2,at:run.at,arcs:run.arcs});
  const copperRuns=c=>c.runs;
  const copperBytes=c=>c?c.size:0;
  // The bytes of a's runs that b does not hold (what an Undo record keeps alive when b replaces a).
  function copperDelta(a,b){
    if(!a)return 0;if(!b)return a.size;
    const have=new Set(b.runs);let n=0;for(const r of a.runs)if(!have.has(r))n+=r.size;return n;
  }
  // The arcs field of runs read back from records ({n, arcs}), in order (a recovery draft).
  function arcsText(records){
    const a=[];let k=0;
    for(const r of records){if(r.arcs)for(let i=0;i<r.arcs.length;i+=5)a.push(r.arcs[i]+k,r.arcs[i+1],r.arcs[i+2],r.arcs[i+3],r.arcs[i+4]);k+=r.n;}
    return a;
  }
  // The data text of runs read back from records ({bytes}), in order (a recovery draft).
  function copperText(records){
    let n=0;for(const r of records)n+=r.bytes.length;
    const all=new Uint8Array(n);let o=0;for(const r of records){all.set(r.bytes,o);o+=r.bytes.length;}
    return encode(all);
  }
  const runsOf=region=>table(region).runs;
  // A run's decoded rings (model mm, walk()'s arithmetic) and ring boxes, from bytes that start at
  // byte `base` of the region's bytes.
  function decodeRun(bytes,t,run,base=0){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),rings=[],boxes=new Float64Array(4*(run.k1-run.k0));
    let vertices=0;
    for(let k=run.k0;k<run.k1;k++){
      let cursor=t.at[k]-base;const n=view.getUint32(cursor,true),xy=new Float64Array(2*n);cursor+=4;
      if(n<3||cursor+16*n>bytes.length)throw Error("Invalid pour vertex count.");
      let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      for(let i=0;i<n;i++){
        const x=view.getFloat64(cursor,true)*unit,y=-view.getFloat64(cursor+8,true)*unit;cursor+=16;
        if(!Number.isFinite(x+y)||Math.max(Math.abs(x),Math.abs(y))>1e8)throw Error("Invalid pour vertex.");
        xy[2*i]=x;xy[2*i+1]=y;
        if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;
      }
      const j=4*(k-run.k0);boxes[j]=x0;boxes[j+1]=y0;boxes[j+2]=x1;boxes[j+3]=y1;
      rings.push(xy);vertices+=n;
    }
    return {rings,boxes,vertices,path:null,lod:[]};
  }
  function runEntry(key){const e=runCache.get(key);if(e){runCache.delete(key);runCache.set(key,e);}return e||null;}
  function keepRun(key,e){
    runCache.set(key,e);runVertices+=e.vertices;
    for(const [k,x] of runCache){
      if(runVertices<=RUN_BUDGET)break;
      if(x===e)continue;
      dropRun(k,x);
    }
  }
  function dropRun(key,e){
    runCache.delete(key);runVertices-=e.vertices;
    if(e.path){runPathVertices-=e.vertices;e.path=null;}
    for(const l of e.lod)if(l)lodVertices-=l.count;
  }
  // Every run of a region, decoded: the cached ones as they are, the others from the region's data
  // (only their stretch of it when they are a small part of the region).
  function runEntries(region){
    const known=tables.get(region),t=known&&sameGeometry(known,region)?known:null;
    let bytes=null;
    if(!t&&!copperOf(region)){bytes=decode(region.data);return runEntriesOf(region,table(region,bytes),bytes);}
    return runEntriesOf(region,t||table(region),null);
  }
  function runEntriesOf(region,t,bytes){
    const out=new Array(t.runs.length),missing=[];let size=0;
    for(let j=0;j<t.runs.length;j++){const e=runEntry(t.runs[j].key);out[j]=e;if(!e){missing.push(j);size+=t.runs[j].b1-t.runs[j].b0;}}
    if(!missing.length)return out;
    if(!bytes&&!t.runs[0]?.run&&size*2>t.bytes)bytes=decode(region.data);
    for(const j of missing){
      const run=t.runs[j];let e;
      if(run.run)e=decodeRun(run.run.bytes,t,run,run.b0);   // a run-held region: its own bytes
      else if(bytes)e=decodeRun(bytes,t,run);
      else{
        // Base64 keeps 3 bytes in 4 characters: the run's characters, from the group it starts in.
        const g0=Math.floor(run.b0/3),g1=Math.ceil(run.b1/3);
        e=decodeRun(decode(region.data.slice(4*g0,4*g1)),t,run,3*g0);
      }
      keepRun(run.key,e);out[j]=e;
    }
    return out;
  }
  // The rings a region's runs have cached now (no decoding): their share of its vertices, 0 to 1.
  function cachedShare(region){
    const t=tables.get(region);
    if(!t||!sameGeometry(t,region))return 0;
    let have=0;for(const run of t.runs)if(runCache.has(run.key))have+=run.b1-run.b0;
    return t.bytes?have/t.bytes:1;
  }
  function contours(region){
    const cached=decoded.get(region);
    if(cached&&sameGeometry(cached,region)){decoded.delete(region);decoded.set(region,cached);return cached.rings;}
    const rings=[],boxes=[];
    for(const e of runEntries(region)){for(const xy of e.rings)rings.push(xy);boxes.push(e.boxes);}
    decoded.set(region,{rings,boxes,data:dataKey(region),ringCount:region.count});
    while(decoded.size>DECODED_MAX)decoded.delete(decoded.keys().next().value);
    return rings;
  }
  // Each ring's box [x0, y0, x1, y1, ...] (one for one with contours(region)).
  function ringBoxes(region){
    contours(region);
    const e=decoded.get(region);
    if(!e.allBoxes){
      let n=0;for(const b of e.boxes)n+=b.length;
      const all=new Float64Array(n);let o=0;for(const b of e.boxes){all.set(b,o);o+=b.length;}
      e.allBoxes=all;
    }
    return e.allBoxes;
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
  function dropContours(region){decoded.delete(region);}
  // No closePath: the path is only filled, which closes each ring, and Chrome's
  // Path2D.closePath costs time proportional to the whole path (quadratic over many holes).
  function ringsPath(rings){
    const p=new Path2D();
    for(const xy of rings){p.moveTo(xy[0],xy[1]);for(let i=2;i<xy.length;i+=2)p.lineTo(xy[i],xy[i+1]);}
    return p;
  }
  // A run's path, kept with the run while the run paths are within their budget.
  function runPath(e){
    if(e.path)return e.path;
    const p=ringsPath(e.rings);
    e.path=p;runPathVertices+=e.vertices;
    if(runPathVertices>RUN_PATH_BUDGET)for(const x of runCache.values()){if(runPathVertices<=RUN_PATH_BUDGET)break;if(x.path&&x!==e){x.path=null;runPathVertices-=x.vertices;}}
    return p;
  }
  // A region's path: its runs' paths joined (Path2D.addPath copies a path's verbs and points natively;
  // the even-odd fill of the joined path is the fill of the same rings drawn one by one).
  function joinPaths(list){
    if(list.length===1)return list[0];
    const p=new Path2D();for(const q of list)p.addPath(q);return p;
  }
  function pathOf(region){
    let e=paths.get(region);
    if(e&&!sameGeometry(e,region)){paths.delete(region);pathVertices-=e.count;e=null;}
    if(!e){
      try{
        const runs=runEntries(region);let count=0;
        for(const r of runs)count+=r.vertices;
        e={path:typeof Path2D.prototype.addPath==="function"?joinPaths(runs.map(runPath)):ringsPath(contours(region)),count};
      }catch{e={path:null,count:0};}
      e.data=dataKey(region);e.ringCount=region.count;
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
  function warm(region){if(typeof Path2D==="function"&&region&&hasData(region))pathOf(region);}
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
  const LOD={enabled:true,tolerance:.5,version:0,stats:()=>({regions:lodCache.size,vertices:lodVertices,queued:lodQueue.length,built:LOD.built,buildMs:+LOD.buildMs.toFixed(1),saved:LOD.saved}),built:0,buildMs:0,saved:0};
  // Vertex count from the encoded size: per ring a 4-byte count, per vertex 16 bytes.
  const verticesOf=r=>{const c=copperOf(r);return c?Math.max(0,(c.bytes-4*(r.count||0))>>4):typeof r?.data==="string"?Math.max(0,((r.data.length*3>>2)-4*(r.count||0))>>4):0;};
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
  function lodPath(ctx,region){
    const best=lodAt(lodLevel(ctx),region);
    if(best&&!best.path)best.path=typeof Path2D.prototype.addPath==="function"?joinPaths(best.parts.map(lodRunPath)):ringsPath(best.rings);
    return best;
  }
  // A run's simplified rings at one level, from its decoded rings. simplify() works ring by ring, so a
  // region's level is its runs' levels side by side, whichever version of the region built them.
  function lodRun(e,L){
    let l=e.lod[L];
    if(!l){
      const tol=LOD_BASE*2**L,rings=new Array(e.rings.length);let count=0;
      for(let i=0;i<rings.length;i++){rings[i]=simplify(e.rings[i],tol);count+=rings[i].length>>1;}
      l=e.lod[L]={rings,count,path:null};lodVertices+=count;LOD.built++;
    }
    return l;
  }
  const lodRunPath=l=>l.path??=ringsPath(l.rings);
  function lodAssemble(region,e,L,runs){
    const rings=[],parts=[];let count=0;
    for(const r of runs){const l=r.lod[L];for(const xy of l.rings)rings.push(xy);parts.push(l);count+=l.count;}
    LOD.saved+=verticesOf(region)-count;
    return e.lv[L]={rings,parts,count,path:null,level:L};
  }
  // The coarsest built level within L (L queued for building when it is not), or null. A region some
  // of whose runs already have level L (a new version of a region on screen) builds the runs it lacks
  // at once: the frame then fills the level the frame before it filled, so an edit repaints only where
  // the copper changed. A region that shares no run with one on screen waits for idle time as before.
  function lodAt(L,region){
    if(L<0||!(region?.count>0)||verticesOf(region)<LOD_REGION_MIN)return null;
    let e=lodCache.get(region);
    if(e&&!sameGeometry(e,region)){dropLod(region);e=null;}
    if(!e){e={lv:[],want:new Set(),used:0,data:dataKey(region),ringCount:region.count};lodCache.set(region,e);}
    else{lodCache.delete(region);lodCache.set(region,e);}
    e.used=Date.now();
    if(!e.lv[L]){
      let runs=null;try{runs=runEntries(region);}catch{runs=null;}
      if(runs?.some(r=>r.lod[L])){for(const r of runs)lodRun(r,L);lodAssemble(region,e,L,runs);e.want.delete(L);lodTrim();}
    }
    let best=null;for(let l=L;l>=LOD_MIN&&!best;l--)best=e.lv[l]||null;
    if(!e.lv[L]&&!e.want.has(L)){e.want.add(L);lodQueue.push({region,e,L,runs:null,j:0,i:0,out:null,n:0});}
    if(lodQueue.length)lodSchedule();
    return best;
  }
  // The GPU renderer (canvas-gpu.js) fills the same rings as the 2D path at k device pixels per mm:
  // {rings, level}, or null for the stored rings.
  function lodRingsAt(region,k){const e=lodAt(levelOf(k),region);return e?{rings:e.rings,level:e.level}:null;}
  function lodRings(ctx,region){return lodAt(lodLevel(ctx),region)?.rings||null;}
  function lodSchedule(){
    if(lodScheduled)return;lodScheduled=true;
    const I=globalThis.AtriumIdle,run=d=>{lodScheduled=false;lodWork(d);};
    if(I?.idle)I.idle(run,{timeout:1000});
    else if(typeof requestIdleCallback==="function")requestIdleCallback(run,{timeout:1000});
    else setTimeout(run,50);
  }
  // Build queued levels for the idle period, 3 to 6 ms; a big run resumes ring by ring.
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
      if(!j.runs){try{j.runs=runEntries(j.region);}catch{lodQueue.shift();continue;}}
      const tol=LOD_BASE*2**j.L;
      while(j.j<j.runs.length&&left()>.5){
        const r=j.runs[j.j];
        if(!r.lod[j.L]){
          j.out??=new Array(r.rings.length);
          while(j.i<r.rings.length&&left()>.5){const x=simplify(r.rings[j.i],tol);j.out[j.i++]=x;j.n+=x.length>>1;}
          if(j.i<r.rings.length)break;
          r.lod[j.L]={rings:j.out,count:j.n,path:null};lodVertices+=j.n;LOD.built++;
        }
        j.j++;j.i=0;j.out=null;j.n=0;
      }
      if(j.j<j.runs.length)break;
      lodQueue.shift();
      if(j.runs.every(r=>r.lod[j.L]))lodAssemble(j.region,j.e,j.L,j.runs);
      j.e.want.delete(j.L);finished++;
    }
    LOD.buildMs+=clock()-p0;
    lodTrim();
    if(finished&&!lodQueue.length){LOD.version++;try{globalThis.AtriumNavHost?.redraw?.();}catch{/* no editor */}}
    if(lodQueue.length)lodSchedule();
  }
  // Past LOD_BUDGET vertices: the levels of regions no frame used for 2 s, then the levels of the runs
  // used longest ago.
  function lodTrim(){
    if(lodVertices<=LOD_BUDGET)return;
    const old=Date.now()-2000;
    for(const [r,e] of lodCache)if(e.used<old)lodCache.delete(r);
    for(const x of runCache.values()){
      if(lodVertices<=LOD_BUDGET)break;
      for(let L=0;L<x.lod.length;L++)if(x.lod[L]){lodVertices-=x.lod[L].count;x.lod[L]=null;}
    }
  }
  function dropLod(region){lodCache.delete(region);}
  // Undo retains the stored region and can rebuild these display caches if that state is shown. The
  // runs it shares with the regions kept stay cached.
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
  // Where poured copper changed between two region lists (a refill, an undo, a collaborator's copper):
  // {changes:[{polygon, layer, net, boxes}], same} with one box per connected set of changed edges,
  // or null when a region cannot be read. Regions are compared by polygon, layer and net (the stored
  // polyline, contours(); true-arc metadata is not compared). A region kept (the same object or the
  // same data) costs nothing; a changed one is compared ring by ring (rings are canonical: one that
  // did not change has the same vertices in the same order), then the rings left over edge by
  // directed edge. Every point where the copper of a polygon differs lies inside the box of a set of
  // changed edges that encloses it (the boundary of the difference consists of those edges and is
  // connected through their shared vertices), so a check of the copper outside every box is unchanged.
  // The answer for the last few pairs of lists is kept (the canvas and the copper checks ask about the
  // same commit, each with its own copy of the list): it holds while both lists hold the same regions,
  // in the same order, with the same data.
  const changeMemo=[];
  const listCopy=list=>(list||[]).map(r=>({r,d:dataKey(r),c:r.count}));
  const sameAs=(copy,list)=>{list=list||[];if(copy.length!==list.length)return false;for(let i=0;i<list.length;i++){const x=copy[i],r=list[i];if(x.r!==r||x.d!==dataKey(r)||x.c!==r.count)return false;}return true;};
  function copperChange(before,after){
    for(const m of changeMemo)if(sameAs(m.b,before)&&sameAs(m.a,after))return m.result;
    const result=copperChangeOf(before,after);
    changeMemo.unshift({b:listCopy(before),a:listCopy(after),result});
    if(changeMemo.length>4)changeMemo.pop();
    return result;
  }
  function copperChangeOf(before,after){
    const key=r=>(r.polygon??"")+"\u0000"+r.layer+"\u0000"+(r.net||""),groups=new Map();
    const kept=new Set(before||[]),group=k=>{let g=groups.get(k);if(!g)groups.set(k,g={old:[],now:[]});return g;};
    const fresh=[];
    for(const r of after||[])if(kept.has(r))kept.delete(r);else fresh.push(r);
    for(const r of kept)group(key(r)).old.push(r);
    for(const r of fresh){
      const g=group(key(r)),i=g.old.findIndex(o=>o.count===r.count&&sameData(o,r));
      if(i>=0)g.old.splice(i,1);else g.now.push(r);
    }
    // Whole runs cancel by key, the rings of the runs left by content (their hashes, then their
    // coordinates); only the rings left over are walked edge by edge.
    const changes=[];
    const sameRing=(a,b)=>{if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;};
    for(const g of groups.values()){
      if(!g.old.length&&!g.now.length)continue;
      const rings=new Map();
      try{
        const runs=new Map();
        for(const [list,side] of [[g.old,0],[g.now,1]])for(const r of list){
          const t=table(r),entries=runEntries(r);
          t.runs.forEach((run,j)=>{
            let l=runs.get(run.key);if(!l)runs.set(run.key,l=[]);
            const twin=l.findIndex(x=>x.side!==side);
            if(twin>=0)l.splice(twin,1);else l.push({side,t,run,e:entries[j]});
          });
        }
        for(const l of runs.values())for(const {side,t,run,e} of l)for(let k=run.k0;k<run.k1;k++){
          const h=t.h1[k]+":"+t.h2[k],role=k?1:0,ring=e.rings[k-run.k0];
          let b=rings.get(h);if(!b)rings.set(h,b=[]);
          const twin=b.findIndex(x=>x.side!==side&&x.role===role&&sameRing(x.ring,ring));
          if(twin>=0)b.splice(twin,1);else b.push({side,role,ring,n:ring.length>>1});
        }
      }catch{return null;}
      // The rings left: directed edges, cancelled pairwise; what remains is the changed boundary.
      const edges=new Map();
      for(const l of rings.values())for(const x of l){
        const {role,side,ring}=x,n=x.n;
        for(let i=0;i<n;i++){
          const j=(i+1)%n,e=[ring[2*i],ring[2*i+1],ring[2*j],ring[2*j+1]],id=role+":"+e.join(","),x=edges.get(id);
          if(x&&x.side!==side&&x.n){x.n--;if(!x.n)edges.delete(id);}
          else if(x&&x.side===side)x.n++;
          else edges.set(id,{e,side,n:1});
        }
      }
      if(!edges.size)continue;
      const sample=g.now[0]||g.old[0],out={polygon:sample.polygon??null,layer:sample.layer,net:sample.net||"",boxes:[]};
      changes.push(out);
      // Many changed edges (a new island, a large outline): one box around them all.
      if(edges.size>20000){
        const b=[Infinity,Infinity,-Infinity,-Infinity];
        for(const {e} of edges.values()){b[0]=Math.min(b[0],e[0],e[2]);b[1]=Math.min(b[1],e[1],e[3]);b[2]=Math.max(b[2],e[0],e[2]);b[3]=Math.max(b[3],e[1],e[3]);}
        out.boxes.push(b);continue;
      }
      // Connected sets of changed edges (shared vertices), one box each.
      const parent=new Map(),find=v=>{let r=v;while(parent.get(r)!==r)r=parent.get(r);while(parent.get(v)!==r){const n=parent.get(v);parent.set(v,r);v=n;}return r;};
      const vertex=(x,y)=>{const id=x+","+y;if(!parent.has(id))parent.set(id,id);return id;};
      const list=[...edges.values()].map(({e})=>{const a=vertex(e[0],e[1]),b=vertex(e[2],e[3]),ra=find(a),rb=find(b);if(ra!==rb)parent.set(ra,rb);return {e,a};});
      const boxes=new Map();
      for(const {e,a} of list){
        const r=find(a),b=boxes.get(r)||[Infinity,Infinity,-Infinity,-Infinity];
        b[0]=Math.min(b[0],e[0],e[2]);b[1]=Math.min(b[1],e[1],e[3]);b[2]=Math.max(b[2],e[0],e[2]);b[3]=Math.max(b[3],e[1],e[3]);boxes.set(r,b);
      }
      out.boxes.push(...boxes.values());
    }
    return {changes,same:!changes.length};
  }
  // ---- what a frame shows
  // A canvas that keeps a board layer it painted repaints only where the copper it shows changed.
  // view(stored) -> a token for the copper a frame shows now: the stored regions and, through
  // displayHook (polygon-pour.js), the live pour tile patches drawn over them. viewDamage(a, b) -> the
  // boxes (model mm) outside which two frames' copper is the same ([]: nowhere differs), or null when
  // that is unknown (repaint everything). Changed stored copper is copperChange's boxes, a patch its
  // clip rectangles; both enclose every pixel that changes, edges and their antialiasing included.
  function view(stored){return {list:listCopy(stored),none:!stored,hook:api.displayHook?.version?.()??null};}
  // The boxes carry the copper layers they are on (boxes.layers).
  function viewDamage(a,b){
    if(!a||!b||a.none!==b.none)return null;
    const boxes=[];boxes.layers=new Set();
    if(a.hook!==b.hook){
      const d=api.displayHook?.damage?.(a.hook,b.hook);if(!d)return null;
      boxes.push(...d);for(const l of d.layers||[])boxes.layers.add(l);
    }
    const same=a.list.length===b.list.length&&a.list.every((x,i)=>x.r===b.list[i].r&&x.d===b.list[i].d&&x.c===b.list[i].c);
    if(!same){
      const c=copperChange(a.list.map(x=>x.r),b.list.map(x=>x.r));
      if(!c)return null;
      for(const ch of c.changes){boxes.push(...ch.boxes);boxes.layers.add(ch.layer);}
    }
    return boxes;
  }
  // The rings of a region and their boxes are cached (no decoding needed to read them).
  const cached=region=>{const e=decoded.get(region);return !!e&&sameGeometry(e,region)||cachedShare(region)===1;};
  const api={read,signalScope,signature,signatureSteps,matchesSignature,storeSignature,contours,edgeBands,contourEdges,contourSegments,nativeContours,paint,paintWith,warm,release,region,regionLike,paintHook:null,displayHook:null,lod:LOD,lodRings,lodRingsAt,simplify,copperChange,
    table,runsOf,ringBoxes,cached,view,viewDamage,
    copperOf,withCopper,isCopper,heldField,dataKey,sameData,dataLength,hasData,fieldsOf,runLookup,runIds,fromRuns,runRecord,copperRuns,copperArcs,copperBytes,copperDelta,copperText,arcsText,runStats:()=>({runs:runCache.size,vertices:runVertices,pathVertices:runPathVertices,lodVertices,regionPaths:paths.size})};
  return api;
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumPCBPours;
