"use strict";

// The native projection is an ordinary, movable schematic text frame. All live
// geometry, field values, local preferences and resolved Review state stay derived.
globalThis.AtriumMarkup = (() => {
  const G = globalThis;
  const colours = Object.freeze(["ink", "blue", "green", "amber", "red", "violet"]);
  const pigments = {
    ink:["#30383f","#ecf0f3","#eff1f1","#333b40"], blue:["#17558a","#a1cdff","#e4f0fb","#263e56"],
    green:["#226345","#95ddb0","#e3f1e8","#284536"], amber:["#785411","#f9d16e","#fcf1c9","#493e24"],
    red:["#913b3d","#ffadb0","#fae7e6","#503438"], violet:["#6a4686","#d9b9f4","#f2eafa","#44344e"]
  };
  const names = {sticky:"Sticky note",callout:"Callout",inkStroke:"Sketch",reviewChecklist:"Review checklist"};
  const kind = i => i?.kind !== "textframe" ? null : i.sticky ? "sticky" : i.callout ? "callout" :
    i.ink ? "inkStroke" : i.widget?.type === "todo" && i.widget.state?.rows?.some(r=>r.threadId) ? "reviewChecklist" : null;
  const finitePoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const rect = i => [i.x,i.y,i.x+i.w,i.y+i.h];
  const maxVertices = 16000;
  function valid(i) {
    const k=kind(i),pressure=v=>Number.isInteger(v)&&v>=0&&v<=255,token=v=>typeof v==="string"&&v.length>0&&v.length<=2048;
    if(!k || ![i.x,i.y,i.w,i.h].every(Number.isFinite) || i.w<=0 || i.h<=0)return false;
    if(k==="reviewChecklist")return G.AtriumSheetWidgets.valid(i);
    if(k==="inkStroke"){
      const a=i.ink;
      if(!["pen","highlighter"].includes(a.brush)||!colours.includes(a.colour)||!Number.isFinite(a.width)||a.width<=0||a.width>20||
          !pressure(a.p)||!finitePoint(a.at)||!Array.isArray(a.path)||a.path.length%3||a.path.length/3>=maxVertices||
          a.gesture!=null&&!token(a.gesture))return false;
      let x=i.x+a.at[0],y=i.y+a.at[1];
      for(let n=0;n<a.path.length;n+=3){x+=a.path[n];y+=a.path[n+1];
        if(!Number.isFinite(a.path[n])||!Number.isFinite(a.path[n+1])||!Number.isFinite(x)||!Number.isFinite(y)||!pressure(a.path[n+2]))return false;}
      return true;
    }
    if(!colours.includes(i[k].colour)||!G.AtriumNotebook.validate(i.richText))return false;
    const a=i.callout?.anchor;
    return k==="sticky"||a && finitePoint(a.at) && token(a.docId) && [a.itemId,a.instanceId,a.pin].every(v=>v==null||token(v));
  }
  function paint(colour, dark=false) {
    const values = pigments[colour] || pigments.ink;
    return {line:values[dark?1:0],paper:values[dark?3:2],ink:dark?"#faf8f3":"#22292e"};
  }
  function darkPaper(opts={}) {
    if(typeof opts.notesDark==="boolean")return opts.notesDark;
    if(opts.print || opts.notesPurpose && opts.notesPurpose!=="screen" || opts.purpose && opts.purpose!=="screen")return false;
    const paper=G.AtriumTheme?.canvasPalette?.("sch")?.paper || G.AtriumRichText?.colours?.().paper;
    const hex=/^#([0-9a-f]{6})$/i.exec(paper || "");
    if(hex){const rgb=[0,2,4].map(n=>parseInt(hex[1].slice(n,n+2),16));return .213*rgb[0]+.715*rgb[1]+.072*rgb[2]<120;}
    return G.document?.documentElement?.getAttribute("data-theme")==="dark";
  }
  function body(text,project,doc) {
    const result=G.AtriumNotebook.textBody(text);
    for (const b of result.blocks) b.runs=G.AtriumNotebook.parseInline(b.runs[0]?.text || "",project,doc);
    return result;
  }
  function card(type,at,text,colour,project,doc,anchor) {
    if (!["sticky","callout"].includes(type) || !colours.includes(colour)) throw Error("Choose a note type and colour.");
    const note=G.AtriumSchObjects.make("textframe",at,{w:34,h:17,text,note:true});
    note[type]={colour,...(type==="callout"?{anchor}: {})};
    note.richText=body(text,project,doc);return note;
  }
  function stroke(points,brush,colour,width) {
    if (!points.length || points.length>maxVertices || !["pen","highlighter"].includes(brush) ||
        !colours.includes(colour) || !(width>0 && width<=20)) throw Error("Invalid sketch stroke.");
    const box=G.AtriumSchNoteInk.bounds(points,{brush,width});
    const i=G.AtriumSchObjects.make("textframe",box,{w:box[2]-box[0],h:box[3]-box[1],text:brush==="pen"?"Pen stroke":"Highlight",note:true});
    const [x,y,p]=points[0], path=[];
    for (let n=1;n<points.length;n++) path.push(points[n][0]-points[n-1][0],points[n][1]-points[n-1][1],points[n][2]);
    i.ink={brush,colour,width,at:[x-i.x,y-i.y],p,path};return i;
  }
  function points(i) {
    const k=i.ink;
    if (!k || !finitePoint(k.at) || !Array.isArray(k.path) || k.path.length%3 || k.path.length>maxVertices*3) return [];
    let x=i.x+k.at[0],y=i.y+k.at[1];
    const pts=[[x,y,k.p]];
    for(let n=0;n<k.path.length;n+=3) {x+=k.path[n];y+=k.path[n+1];pts.push([x,y,k.path[n+2]]);}
    return pts;
  }
  const sheetIndexes=new WeakMap();
  function sheetIndex(project,doc,frame) {
    if(frame?.has(doc))return frame.get(doc);
    const v=G.AtriumUndoStore?.documentVersions?.(doc,project);
    let idx=v && sheetIndexes.get(doc);
    function put(i){
      idx.items.set(i.id,i);if(i.callout)idx.callouts.set(i.id,i);
      if(i.ink?.gesture){
        const g=i.ink.gesture;
        if(!idx.groups.has(g))idx.groups.set(g,new Map());
        idx.groups.get(g).set(i.id,i);idx.gestures.set(i.id,g);
      }
    }
    if(!idx || idx.revision!==v.items) {
      const delta=idx && G.AtriumUndoStore.recordedChanges(doc,idx.seq);
      if(delta?.ids) {
        for(const id of delta.ids){idx.items.delete(id);idx.callouts.delete(id);
          const g=idx.gestures.get(id);if(g){const group=idx.groups.get(g);group?.delete(id);if(!group?.size)idx.groups.delete(g);idx.gestures.delete(id);}
        }
        for(const item of delta.items.values())put(item);
      }else {
        idx={items:new Map(),callouts:new Map(),groups:new Map(),gestures:new Map()};
        for(const i of doc.items)put(i);
      }
      if(v){idx.revision=v.items;idx.seq=v.seq;sheetIndexes.set(doc,idx);}
    }
    frame?.set(doc,idx);return idx;
  }
  function locate(project,doc,a,defs,frame) {
    const gone={at:a?.at || [0,0],box:null,live:false};
    if(!a?.itemId || !project || !doc) return gone;
    let target=project.documents.find(d=>d.id===a.docId);
    if(!a.instanceId && (!target || !sheetIndex(project,target,frame).items.has(a.itemId))) {
      const matches=project.documents.filter(d=>d.kind==="schematic" && sheetIndex(project,d,frame).items.has(a.itemId));
      if(matches.length===1)target=matches[0];
    }
    if(!target) return gone;
    if(a.instanceId) {
      const instances=G.AtriumHierarchy?.peek?.(project)?.instances || G.AtriumHierarchy?.instances?.(project)?.instances;
      if(!instances?.some(i=>i.id===a.instanceId && i.doc?.id===a.docId)) return gone;
    }
    const dmap=defs || new Map((project.library || []).map(d=>[d.id,d]));
    const hit=G.AtriumReviewComments.locate(target,dmap,{anchor:{kind:a.pin!=null?"pin":"item",id:a.itemId,pin:a.pin,at:gone.at}},sheetIndex(project,target,frame).items);
    return {...hit,docId:target.id,...(doc.id!==target.id&&hit.live?{remote:target.name}:{})};
  }
  function reference(project,doc,item,pin,instanceId,defs) {
    const a={docId:doc.id,itemId:item.id,...(pin!=null && pin!==""?{pin:String(pin)}:{}),...(instanceId?{instanceId}:{}),at:[item.x||0,item.y||0]};
    const found=locate(project,doc,a,defs);
    if(!found.live) throw Error("The selected target is unavailable.");
    a.at=found.at.slice();return a;
  }
  const liveViews=new Map();
  function localView(doc) {
    if(liveViews.has(doc.id))return liveViews.get(doc.id);
    let saved;try{saved=JSON.parse(G.localStorage?.getItem("waffle.notes.sheet."+doc.id) || "{}");}catch{saved={};}
    const v={visible:saved.visible!==false,hiddenKinds:new Set(saved.hiddenKinds || []),minimized:new Set(saved.minimized || [])};
    liveViews.set(doc.id,v);return v;
  }
  function saveView(doc) {
    const v=localView(doc);
    try{G.localStorage?.setItem("waffle.notes.sheet."+doc.id,JSON.stringify({visible:v.visible,hiddenKinds:[...v.hiddenKinds],minimized:[...v.minimized]}));}catch{}
  }
  function policy(doc,options={}) {
    if(options.notesPolicy)return options.notesPolicy;
    const purpose=options.notesPurpose || options.purpose || "screen";
    const screen=purpose==="screen";
    const view=screen?{...localView(doc),routing:["route","sch-wire","bus"].includes(options.tool ?? G.AtriumNavHost?.tool?.())}:{};
    return G.AtriumSchNoteLayer.policy(screen?"screen":purpose==="foreign"?"foreign":"print",{layer:doc.notesLayer,view,includeNotes:options.includeNotes});
  }
  function projectFor(doc,opts) {
    if(opts.project) return opts.project;
    const live=G.AtriumNavHost?.project?.();
    return live?.documents?.includes(doc)?live:{documents:[doc],library:[]};
  }
  function read(project,doc,i,opts={}) {
    const k=kind(i),description={label:names[k],text:i.text || "",fields:[]};
    if(k==="inkStroke") return {...description,brush:i.ink.brush,vertices:i.ink.path.length/3+1};
    if(k==="reviewChecklist") {
      const view=G.AtriumSheetWidgets.view(project,doc,i,opts);
      return {...description,text:view.fallback.text};
    }
    Object.assign(description,G.AtriumNotebook.bodyText(i.richText,project,doc,opts));
    if(k==="callout") {
      const a=i.callout.anchor,hit=locate(project,doc,a,opts.defs,opts.noteIndexes);
      description.anchor={...a,docId:hit.docId||a?.docId,live:hit.live,at:hit.at,...(hit.remote?{sheet:hit.remote}:{})};
    }
    return description;
  }
  const installed=new WeakSet();
  function registerNotebook(n) {
    if(!n?.register || installed.has(n)) return;
    installed.add(n);
    for(const k of ["sticky","callout","inkStroke"]) n.register(k,{matches:i=>kind(i)===k,describe:read,
      compare(a,da,b,db) {
        const property=k==="inkStroke"?"ink":k;
        const changes=[];
        if(JSON.stringify(a[property])!==JSON.stringify(b[property]) || JSON.stringify(a.richText)!==JSON.stringify(b.richText))
          changes.push({kind:"content",before:da,after:db,text:names[k]+" edited",fields:[property]});
        if(da.text!==db.text || JSON.stringify(da.fields)!==JSON.stringify(db.fields)) changes.push({kind:"fields",before:da,after:db,text:names[k]+" text changed",fields:["text"]});
        if(k==="callout" && JSON.stringify(da.anchor)!==JSON.stringify(db.anchor)) changes.push({kind:"anchor",before:da,after:db,text:"Callout target changed",fields:["anchor"]});
        return changes;
      }});
  }
  function hit(i,doc,p,tol,opts={}) {
    const row={id:i.id,kind:kind(i)},v=policy(doc,opts);
    if(!v.hit(row))return Infinity;
    if(row.kind==="inkStroke") return G.AtriumSchNoteInk.hit(points(i),i.ink,p,p,tol)?0:Infinity;
    if(v.minimized(row)) return Math.hypot(p[0]-i.x-1.5,p[1]-i.y-1.5)-1.5;
    return G.AtriumSchObjects.hit(i,p,tol);
  }
  function drawLeader(ctx,i,loc,palette) {
    const r=G.AtriumSchNoteLeader.route(rect(i),loc);
    if(!r.points.length)return;
    ctx.strokeStyle=palette.line;ctx.lineWidth=.35;ctx.setLineDash(r.broken?[1.2,.8]:[]);
    ctx.beginPath();ctx.moveTo(...r.points[0]);for(const p of r.points.slice(1))ctx.lineTo(...p);ctx.stroke();ctx.setLineDash([]);
    const p=r.points.at(-1);ctx.beginPath();ctx.arc(p[0],p[1],.62,0,2*Math.PI);ctx.fillStyle=palette.line;ctx.fill();
  }
  function drawLeaders(ctx,doc,defs,opts,viewport) {
    const project=projectFor(doc,opts),index=sheetIndex(project,doc,opts.noteIndexes),v=policy(doc,opts);
    if(!v.visible({kind:"callout"}))return;
    const dark=darkPaper(opts);
    function leaders() {
      ctx.save();
      try{
        ctx.globalAlpha*=v.opacity;
        for(const i of index.callouts.values()){
          if(opts.hide?.has(i))continue;
          const hit=locate(project,doc,i.callout.anchor,defs,opts.noteIndexes);
          if(hit.remote)continue;
          const box=hit.box || [...hit.at,...hit.at];
          if(viewport && (Math.max(i.x+i.w,box[2])<viewport[0]||Math.min(i.x,box[0])>viewport[2]||
            Math.max(i.y+i.h,box[3])<viewport[1]||Math.min(i.y,box[1])>viewport[3]))continue;
          drawLeader(ctx,i,hit,paint(i.callout.colour,dark));
        }
      }finally{ctx.restore();}
    }
    if(ctx.withLayer && opts.notesLayerTag)ctx.withLayer(opts.notesLayerTag,leaders);else leaders();
  }
  function draw(ctx,i,doc,defs,opts={}) {
    const k=kind(i),row={kind:k,id:i.id},v=policy(doc,opts);
    if(!v.visible(row))return;
    const project=projectFor(doc,opts),screen=!opts.notesPurpose && !opts.purpose || [opts.notesPurpose,opts.purpose].includes("screen");
    const dark=darkPaper(opts);
    const palette=paint(i[k]?.colour || i.ink?.colour,dark);
    function render() {
      ctx.save();
      try {
        ctx.globalAlpha*=v.opacity;
        if(k==="inkStroke") {
          const gesture=i.ink.gesture;
          if(gesture && opts.drawnGestures){
            if(opts.drawnGestures.has(gesture))return;
            opts.drawnGestures.add(gesture);
            const group=sheetIndex(project,doc,opts.noteIndexes).groups.get(gesture);
            G.AtriumSchNoteInk.drawPaths(ctx,[...(group?.values() || [i])].map(points),i.ink,palette.line);
          }else G.AtriumSchNoteInk.draw(ctx,points(i),i.ink,palette.line);
          return;
        }
        if(k==="reviewChecklist") {
          const view=opts.widgetViews?.get(i.id) || G.AtriumSheetWidgets.view(project,doc,i,opts);
          G.AtriumSheetWidgets.draw(ctx,view,{...i,theme:palette});return;
        }
        const anchor=k==="callout" && locate(project,doc,i.callout.anchor,defs,opts.noteIndexes);
        if(anchor && !opts.leaderDrawn && !anchor.remote) drawLeader(ctx,i,anchor,palette);
        ctx.fillStyle=palette.paper;ctx.strokeStyle=palette.line;ctx.lineWidth=.32;
        if(v.minimized(row)) {ctx.beginPath();ctx.arc(i.x+1.5,i.y+1.5,1.35,0,2*Math.PI);ctx.fill();ctx.stroke();return;}
        ctx.fillRect(i.x,i.y,i.w,i.h);ctx.strokeRect(i.x,i.y,i.w,i.h);
        ctx.fillStyle=palette.line;ctx.fillRect(i.x,i.y,.8,i.h);
        if(G.AtriumRichText?.draw) {
          if(anchor && (!anchor.live || anchor.remote)) {
            ctx.font="600 1.7px system-ui";ctx.fillStyle=palette.line;ctx.textAlign="left";ctx.textBaseline="bottom";
            ctx.fillText(anchor.remote || "Target missing",i.x+.6,i.y-.45);
          }
          G.AtriumRichText.draw(ctx,i,{...opts,project,doc,print:!screen,scale:opts.scale || 1});return;
        }
        ctx.beginPath();ctx.rect(i.x+1,i.y+.3,i.w-1.3,i.h-.6);ctx.clip();
        ctx.textAlign="left";ctx.textBaseline="top";ctx.font="600 1.65px system-ui";ctx.fillStyle=palette.line;
        ctx.fillText(anchor&&!anchor.live?"Target missing":anchor?.remote?anchor.remote:names[k],i.x+2,i.y+1.25);
        ctx.font="2px system-ui";ctx.fillStyle=palette.ink;
        let y=i.y+4.3;
        for(const line of read(project,doc,i,opts).text.split("\n")) {
          let current="";
          for(const word of line.split(/\s+/)) {
            const next=current?current+" "+word:word;
            if(current && ctx.measureText(next).width>i.w-4){ctx.fillText(current,i.x+2,y);y+=2.65;current=word;}else current=next;
          }
          ctx.fillText(current,i.x+2,y);y+=2.65;if(y>i.y+i.h)break;
        }
      }finally{ctx.restore();}
    }
    if(ctx.withLayer && opts.notesLayerTag && !opts.inNotesLayer)ctx.withLayer(opts.notesLayerTag,render);else render();
  }
  // File exports already own a frozen revision and its prepared per-object fonts.
  // Callers preparing a scene directly can carry a copy into later tiled pages.
  async function notebookScene(source,{documentIds,signal,widgetViews,frozen=false}={}) {
    const project=frozen ? source : JSON.parse(JSON.stringify(source)),defs=new Map((project.library||[]).map(d=>[d.id,d]));
    const ids=documentIds && new Set(documentIds),sheets=new Map(),indexes=new Map();
    for(const doc of project.documents) {
      if(doc.kind!=="schematic" || ids && !ids.has(doc.id))continue;
      const rows=doc.items.filter(i=>kind(i));
      if(rows.length)sheets.set(doc.id,{doc,rows});
    }
    if(sheets.size && G.AtriumRichText?.ready)await G.AtriumRichText.ready();
    if(signal?.aborted)throw signal.reason || Error("Print cancelled.");
    return {
      sheetNotes({sheetId,clip,purpose="print",includeNotes}) {
        const sheet=sheets.get(sheetId);if(!sheet)return [];
        const {doc,rows}=sheet,opts={project,notesPurpose:purpose,includeNotes,noteIndexes:indexes,inNotesLayer:true,print:true,scale:1,
          widgetViews:widgetViews?.get(sheetId)};
        const v=policy(doc,opts),out=[];
        for(const item of rows) {
          if(!v.visible({kind:kind(item)}))continue;
          const b=rect(item);
          if(item.callout){const a=locate(project,doc,item.callout.anchor,defs,indexes);
            if(!a.remote){const box=a.box || [...a.at,...a.at];b[0]=Math.min(b[0],box[0]);b[1]=Math.min(b[1],box[1]);b[2]=Math.max(b[2],box[2]);b[3]=Math.max(b[3],box[3]);}}
          if(clip && (b[2]<Math.min(clip[0],clip[2])||b[0]>Math.max(clip[0],clip[2])||b[3]<Math.min(clip[1],clip[3])||b[1]>Math.max(clip[1],clip[3])))continue;
          out.push({item,doc,opts});
        }
        return out;
      },
      draw(ctx,projection){const drawnGestures=new Set();for(const r of projection)draw(ctx,r.item,r.doc,defs,{...r.opts,drawnGestures});}
    };
  }
  function foreignStroke(item,{raster,scale,signal}={}) {
    // Native folder rows store integer nanometres. The portable editor frame
    // starts at its padded box and stores the first centre as a local offset.
    let style=item.ink,vertices;
    if(style)vertices=points(item);
    else if(item.kind==="inkStroke" && finitePoint(item.at) && item.at.every(Number.isSafeInteger) && Number.isSafeInteger(item.width) &&
      Array.isArray(item.path) && item.path.length%3===0 && item.path.length/3<maxVertices && item.path.every(Number.isSafeInteger)){
      const mm=1e6;let x=item.at[0]/mm,y=item.at[1]/mm;
      vertices=[[x,y,item.p]];
      for(let n=0;n<item.path.length;n+=3){x+=item.path[n]/mm;y+=item.path[n+1]/mm;vertices.push([x,y,item.path[n+2]]);}
      style={brush:item.brush,colour:item.colour,width:item.width/mm};
    }
    if(signal?.aborted)throw signal.reason || Error("Export cancelled.");
    const valid=style && ["pen","highlighter"].includes(style.brush) && colours.includes(style.colour) && Number.isFinite(style.width) && style.width>0 &&
      vertices?.length>0 && vertices.length<=maxVertices && vertices.every(p=>Number.isFinite(p[0])&&Number.isFinite(p[1])&&Number.isInteger(p[2])&&p[2]>=0&&p[2]<=255);
    const box=valid?G.AtriumSchNoteInk.bounds(vertices,style):[item.x||0,item.y||0,(item.x||0)+(item.w||16),(item.y||0)+(item.h||4)];
    const alt=valid?(style.brush==="highlighter"?"Highlighter":"Pen")+" stroke, "+style.colour+", "+Number(style.width.toFixed(4))+" mm":item.text || "Sketch";
    if(!valid || typeof raster!=="function")return {type:"text",text:alt,box,reason:valid?"Static text describes the stroke because the image renderer is unavailable.":"Static text represents unavailable stroke geometry."};
    return raster({box,alt,scale},ctx=>G.AtriumSchNoteInk.draw(ctx,vertices,style,paint(style.colour).line));
  }
  const foreignRegistries=new WeakSet();
  function registerForeign(api) {
    if(!api?.register || foreignRegistries.has(api))return;
    api.register("inkStroke",foreignStroke);foreignRegistries.add(api);
  }
  registerNotebook(G.AtriumNotebook);
  registerForeign(G.AtriumNotebookForeign);
  return Object.freeze({kind,valid,colours,paint,darkPaper,body,card,stroke,points,maxVertices,rect,reference,locate,localView,saveView,policy,read,draw,drawLeaders,hit,registerNotebook,notebookScene,registerForeign});
})();
