"use strict";
// Compact, non-electrical sheet records. Canvas, print and accessibility consume the same bounded view.
// Values and checked states are derived at the supplied project revision. No computed value is saved.
globalThis.AtriumSheetWidgets = (() => {
  const G = globalThis;
  const {types,limits,isWidget,valid,validCell,stateOK,withinBytes,fallbackOK,keyFor}=G.AtriumWidgetCatalogue;
  const rowId = () => G.Atrium.id();
  function frozen(x) {
    if (x && typeof x === "object" && !Object.isFrozen(x)) {Object.values(x).forEach(frozen); Object.freeze(x);}
    return x;
  }
  function size(type,w,h) {const range=G.AtriumExtensionWidgetDeclarations?.size?.(type);
    return [w,h].map((n,i)=>Math.max(range?.min[i] || 4,Math.min(range?.max[i] || limits.size,n)));}
  function copyFallback(f) {return {...f,...(f.assetRef?{assetRef:{...f.assetRef}}:{})};}
  function storedFallback(item) {
    const f=item.widget?.fallback || {type:"text",text:item.text || ""};
    return frozen({title:types[item.widget?.type] || "Widget",width:item.w,height:item.h,rows:[row(f.type==="image"?f.alt:f.text || "")],
      useFallback:true,fallback:copyFallback(f)});
  }
  function make(type, at, opts={}) {
    const fallback = {type:"text",text:types[type] || opts.title || type};
    const id = opts.makeId || rowId, cell = () => "c" + id().replace(/[^a-zA-Z0-9]/g,"").slice(0,32);
    let state;
    switch (type) {
      case "todo": state={rows:opts.argument?[{id:id(),text:opts.argument,done:false}]:[]}; break;
      case "table": {const cols = ["Item","Value"].map(title=>({id:cell(),title})); state={columns:cols,rows:[{id:id()}]}; break;}
      case "pin-map": state={part:opts.part || null}; break;
      case "power-budget": state={sources:[]}; break;
      case "bode": state={bench:"",probe:"",channel:"both"}; break;
      case "calculator": state={calculator:opts.calculator || "voltage_divider"}; break;
      case "link": state={url:"",caption:"Datasheet"}; break;
      default: state=opts.state || {};
    }
    const item={id:id(),kind:"textframe",x:at[0],y:at[1],w:Math.min(limits.size,opts.w || 48),h:Math.min(limits.size,opts.h || 28),
      text:fallback.text,widget:{type,state,fallback:opts.fallback || fallback}};
    if (opts.fallback) item.text=opts.fallback.type==="image"?opts.fallback.alt:opts.fallback.text;
    if (type==="todo" && opts.argument) item.text+="\n☐ "+opts.argument;
    if (!valid(item)) throw Error("Invalid sheet widget.");
    return item;
  }
  const textCell = (s,token) => ({text:String(s ?? "").slice(0,2048),...(token?{token}:{})});
  const row = (...cells) => ({cells:cells.map(v=>typeof v === "object" ? v : textCell(v))});
  const stem = t => t.replace(/[ _-]/g,"").toLowerCase();
  function resolveCell(project,doc,cell,ctx) {
    if (!cell || cell.kind === "literal") return textCell(cell?.text || "");
    if (cell.kind === "field") {
      const result = (ctx.fields || G.AtriumNoteFields)?.resolve(project,doc,cell.expression,cell.binding,ctx);
      return textCell(result?.text || cell.expression,result?.broken || !result ? "broken" : undefined);
    }
    const q={documentId:cell.documentId,blockId:cell.blockId,...(cell.instanceId?{instanceId:cell.instanceId}:{}),revision:ctx.revision};
    const frozen=(ctx.calculationRecords || ctx.evaluations || ctx.perType?.get("calculation")?.evaluations)?.get?.(cell.blockId);
    const selected=cell.instanceId && frozen?.instances ? frozen.instances.find(r=>r.documentId===cell.documentId && r.instanceId===cell.instanceId) : frozen;
    const record=ctx.calculation ? ctx.calculation(q) : (selected && (!selected.documentId || selected.documentId===cell.documentId)?selected:null) ??
      (ctx.revision!=null ? G.AtriumCalculations?.peek?.(project,q) : null);
    const result = record?.result;
    return result?.ok ? {...textCell(result.display),quantity:result} : textCell(result?.diagnostic?.message || result?.error?.message || "Calculation unavailable","broken");
  }
  function checked(project,r,ctx={}) {
    if (!r.threadId) return r.done;
    const api=ctx.reviews || G.AtriumReviewComments;
    const t=api?api.thread(project,r.threadId):project.review?.records?.[r.threadId];
    return t ? t.status === "resolved" : null;
  }
  function todoRows(project,s,ctx) {
    return s.rows.map(r=>{
      const done=checked(project,r,ctx), out=row(r.text,r.assignee || "",r.due || "");
      return {...out,id:r.id,checked:done,action:"toggle",...(done===null?{error:"Review thread unavailable"}:{}),...(r.link?{link:{...r.link}}:{})};
    });
  }
  function setDone(project,item,id,done,ctx={}) {
    const r=item.widget.state.rows.find(x=>x.id===id);
    if (!r) throw Error("Checklist row was removed.");
    if (r.threadId) {
      const api=ctx.reviews || G.AtriumReviewComments;
      if (!api?.thread(project,r.threadId)) throw Error("Review thread unavailable.");
      api.setStatus(project,r.threadId,done?"resolved":"open",{author:ctx.author || G.AtriumReviewComments?.author?.() || G.AtriumPref?.get?.("review.author","") || "Reviewer"});
    } else r.done=!!done;
  }
  function tableRows(project,doc,s,ctx) {
    return [{...row(...s.columns.map(c=>c.title)),header:true},...s.rows.map(r=>({...row(...s.columns.map(c=>resolveCell(project,doc,r[keyFor(c.id)],ctx))),id:r.id}))];
  }
  const pinTypes=["Input","I/O","Output","Open collector","Passive","High impedance","Open emitter","Power"];
  function pinRows(project,s,ctx) {
    const d=project.documents.find(d=>d.id===s.part?.docId);
    const part=d?.items.find(i=>i.id===s.part?.itemId && i.kind==="part");
    if (!part) return [row(textCell(s.part?"Part unavailable":"Choose a part","broken"))];
    const def=(ctx.defs || new Map(project.library.map(x=>[x.id,x]))).get(part.def);
    return [{...row(part.ref,"Pin","Electrical type"),header:true},...G.Atrium.pins(part,def,"schematic").slice(0,limits.rows-1).map(p=>row(p.number,p.name || "",pinTypes[p.electrical] || p.type || ""))];
  }
  const factor = {"":1,m:1e-3,"µ":1e-6,"μ":1e-6,u:1e-6,n:1e-9,p:1e-12,k:1e3};
  function amps(c) {
    if (c.token === "broken") return null;
    if (c.quantity) return c.quantity.dimensions?.join(",")==="0,0,0,1,0,0,0" && Number.isFinite(c.quantity.value) && c.quantity.value>=0 ? c.quantity.value : null;
    const m=c.text.trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([pmµμunk]?)A$/i);
    const n=m && Number(m[1])*factor[m[2]];
    return m && Number.isFinite(n) && n>=0 ? n : null;
  }
  const ampText=n => n < 1 ? +(n*1000).toPrecision(5)+" mA" : +n.toPrecision(5)+" A";
  function budget(project,doc,s,ctx) {
    const rails=new Map();
    function add(rail,use,c) {
      if (!rails.has(rail)) rails.set(rail,{load:0,ratings:[],missing:0});
      const a=rails.get(rail), n=amps(c);
      if (n==null) a.missing++;
      else if (use==="load") a.load+=n;
      else a.ratings.push(n);
    }
    for (const r of s.sources) add(r.rail || "Unassigned rail",r.use,resolveCell(project,doc,r.input,ctx));
    for (const it of doc.items) {
      if (it.kind!=="part") continue;
      const def=ctx.defs?.get(it.def) || project.library.find(d=>d.id===it.def);
      const params=Object.fromEntries(Object.entries({...def?.parameters,...it.parameters}).map(([k,v])=>[stem(k),v?.value ?? v]));
      const rail=params.powerrail || params.supplyrail;
      if (!rail) continue;
      if (params.supplycurrent != null) add(String(rail),"load",textCell(params.supplycurrent));
      if (params.outputcurrentrating != null) add(String(rail),"rating",textCell(params.outputcurrentrating));
    }
    return [{...row("Rail","Load","Regulator rating","Status"),header:true},...Array.from(rails,([rail,b])=>{
      const rated=b.ratings.length===1 ? b.ratings[0] : null, over=rated!=null && b.load>rated;
      const status=[over?"Over rating":"",b.missing?b.missing+" unavailable":"",b.ratings.length>1?"Several regulator ratings":""].filter(Boolean).join(" · ") || (rated==null?"Unrated":"Within rating");
      return row(rail,ampText(b.load),rated==null?"—":ampText(rated),textCell(status,over?"warning":b.missing?"broken":undefined));
    })];
  }
  function calcRows(s,ctx) {
    const calc=ctx.calculators || G.AtriumCalc;
    if (!calc) return [row(textCell("Calculator unavailable","broken"))];
    const inputs={...s}; delete inputs.calculator;
    if (s.calculator==="rclc") inputs.l=0;
    try {return calc.calculate(s.calculator,inputs).rows.map(r=>row(r.label,r.text));}
    catch (e) {return [row(textCell(e.message,"broken"))];}
  }
  function safeURL(raw) {
    try {const u=new URL(raw); return ["https:","http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null;} catch {return null;}
  }
  function openURL(url) {
    const href=safeURL(url);
    if (!href) throw Error("Enter an HTTP or HTTPS URL without credentials.");
    if (G.AtriumHost?.openURL) return G.AtriumHost.openURL(href);
    if (!G.AtriumHost && G.open) return G.open(href,"_blank","noopener,noreferrer");
    throw Error("Opening external links is unavailable in this host.");
  }
  function bodeResult(response,probe,channel="db") {
    if (channel==="both") {
      const magnitude=bodeResult(response,probe,"db"),phase=bodeResult(response,probe,"phase");
      return magnitude && phase ? {...magnitude,phase} : magnitude || phase;
    }
    const series=response?.signals?.[probe]?.[channel], x=response?.x;
    if (!Array.isArray(x) || !Array.isArray(series) || x.length!==series.length || x.length<2) return null;
    const points=[], xs=x.length-1, count=Math.min(x.length,limits.points);
    for (let i=0;i<count;i++) {
      const k=Math.round(i*xs/(count-1)), f=x[k], value=series[k];
      if (Number.isFinite(f) && f>0 && Number.isFinite(value)) points.push([f,value]);
    }
    return points.length>1 ? {points,xUnit:"Hz",yUnit:channel==="phase"?"°":"dB",xScale:"log"} : null;
  }
  function view(project,doc,item,ctx={}) {
    const w=item.widget,s=w?.state, type=w?.type;
    if (!valid(item,{cacheTable:true})) return frozen({title:"Widget unavailable",width:item.w,height:item.h,rows:[row(textCell(item.text || "Invalid widget","broken"))],fallback:{type:"text",text:item.text || "Invalid widget"}});
    if(type==="table" && s.tableVersion===1) return G.AtriumTableVisual?.view(project,doc,item,ctx) || storedFallback(item);
    let rows=[],plot=null;
    if (type==="todo") rows=todoRows(project,s,ctx);
    else if (type==="table") rows=tableRows(project,doc,s,ctx);
    else if (type==="pin-map") rows=pinRows(project,s,ctx);
    else if (type==="power-budget") rows=budget(project,doc,s,ctx);
    else if (type==="calculator") rows=calcRows(s,ctx);
    else if (type==="link") rows=[{...row(textCell(s.caption || s.url,safeURL(s.url)?"link":"broken"),s.url),...(safeURL(s.url)?{action:"open"}:{})}];
    else if (type==="bode") {
      plot=ctx.bode?.(item,s.channel || "both") || null;
      rows=[row(s.probe || "Choose a probe",plot ? plot.yUnit+(plot.phase?" / °":"") : ctx.bodeStatus || "Awaiting AC sweep")];
    } else {
      const external=ctx.extension?.(item);
      if (external) return external;
      return storedFallback(item);
    }
    const bounded=rows.slice(0,limits.rows);
    for (const r of bounded) for (const c of r.cells) delete c.quantity;
    const text=[types[type] || w.fallback.text || item.text,...bounded.map(r=>(r.checked===true?"☑ ":r.checked===false?"☐ ":"")+r.cells.map(c=>c.text).filter(Boolean).join(" · "))].join("\n").slice(0,limits.chars);
    return frozen({title:types[type] || item.text,width:item.w,height:item.h,rows:bounded,...(plot?{plot}:{}),fallback:
      w.fallback.type==="image"?copyFallback(w.fallback):{type:"text",text}});
  }
  function views(project, doc, ctx) {
    return new Map(doc.items.filter(isWidget).map(item => [item.id, view(project,doc,item,ctx)]));
  }
  function draw(ctx,v,{x=0,y=0,w=v.width,h=v.height,theme={},assets,scale,viewport}={}) {
    if(v.table && G.AtriumTableVisual)return G.AtriumTableVisual.draw(ctx,v,{x,y,w,h,theme,assets,scale,viewport});
    const t={paper:"#fff",ink:"#253044",muted:"#616b7b",line:"#b6c0cc",accent:"#1b5fae",warning:"#a24a05",broken:"#aa2b3c",...theme};
    const font=1.65, line=3.05, pad=1.35;
    ctx.save(); ctx.translate(x,y); ctx.beginPath(); ctx.rect(0,0,w,h); ctx.clip(); ctx.fillStyle=t.paper;ctx.fillRect(0,0,w,h);
    ctx.strokeStyle=t.line;ctx.lineWidth=.2;ctx.strokeRect(.1,.1,w-.2,h-.2);ctx.textBaseline="top";ctx.textAlign="left";
    ctx.fillStyle=t.ink;ctx.font="600 2px system-ui";ctx.fillText(v.title,pad,pad,Math.max(1,w-2*pad));
    const fallback=v.fallback;
    if (v.useFallback && fallback?.type==="image") {
      const image=assets?.get?.(fallback.assetRef?.sha256 || fallback.assetId);
      if (image?.surface && image.width>0 && image.height>0) {
        const roomW=w-2*pad,roomH=h-5.2-pad,ratio=Math.min(roomW/image.width,roomH/image.height);
        if (ratio>0) {const iw=image.width*ratio,ih=image.height*ratio;ctx.drawImage(image.surface,pad+(roomW-iw)/2,5.2+(roomH-ih)/2,iw,ih);ctx.restore();return;}
      }
    }
    let top=5.2;
    for (const r of v.rows) {
      if (top + font > h) break;
      const mark=r.checked==null?"":r.checked?"☑ ":"☐ ", count=Math.max(1,r.cells.length);
      const col=(w-2*pad)/count;
      for (let j=0;j<count;j++) {
        const c=r.cells[j]; if (!c) continue;
        ctx.save();ctx.beginPath();ctx.rect(pad+j*col,top,col-.15,line);ctx.clip();
        ctx.font=(r.header?"600 ":"")+font+"px system-ui";ctx.fillStyle=t[c.token==="link"?"accent":c.token] || (r.header?t.muted:t.ink);
        ctx.fillText((j===0?mark:"")+c.text,pad+j*col,top);
        ctx.restore();
      }
      top+=line;
    }
    if (v.plot && top+3 < h) {
      const traces=v.plot.phase?[v.plot,v.plot.phase]:[v.plot],bottom=h-3,region=(bottom-top)/traces.length;
      function label(n) {return Number(n.toPrecision(3)).toString();}
      traces.forEach((trace,idx)=>{
        const a=trace.points, lo=Math.log10(a[0][0]), hi=Math.log10(a.at(-1)[0]), values=a.map(p=>p[1]);
        const low=Math.min(...values), high=Math.max(...values),span=high-low || 1,left=7.8,right=w-pad;
        const y=top+idx*region,ph=Math.max(1,region-1.7);
        ctx.font="1.3px system-ui";ctx.fillStyle=t.muted;ctx.fillText(label(high)+trace.yUnit,pad,y,6);ctx.fillText(label(low)+trace.yUnit,pad,y+ph-1.2,6);
        ctx.strokeStyle=t.line;ctx.lineWidth=.12;ctx.strokeRect(left,y,right-left,ph);
        ctx.beginPath();ctx.strokeStyle=t.accent;ctx.lineWidth=.28;
        a.forEach(([f,val],k)=>{const px=left+(Math.log10(f)-lo)/(hi-lo || 1)*(right-left),py=y+(high-val)/span*ph;
          if(k===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);});ctx.stroke();
        if (idx===traces.length-1) {ctx.fillStyle=t.muted;ctx.fillText(label(a[0][0])+" Hz",left,bottom);ctx.textAlign="right";ctx.fillText(label(a.at(-1)[0])+" Hz",right,bottom);ctx.textAlign="left";}
      });
    }
    ctx.restore();
  }
  // A source sheet instance survives a partial frame move. Update occurrences only for their actual target.
  function moveBindings(project,from,to,moved,instances) {
    const changed=new Set();
    for (const doc of project.documents) for (const item of doc.items) {
      if (!isWidget(item)) continue;
      function target(t,docKey="docId",itemKey="itemId") {
        const next=G.AtriumNoteFields.rebaseTarget(t,from,to,moved,instances,{fallback:true,docKey,itemKey});
        if(next){Object.assign(t,next);changed.add(item);}
      }
      const s=item.widget.state;
      if (item.widget.type==="todo") for(const r of s.rows) target(r.link);
      if (item.widget.type==="pin-map") target(s.part);
      if (item.widget.type==="table" || item.widget.type==="power-budget") {
        const cells=item.widget.type==="table"?(s.tableVersion===1?s.cells.map(c=>c.content):s.rows.flatMap(r=>s.columns.map(c=>r[keyFor(c.id)]))):s.sources.map(r=>r.input);
        for(const c of cells) {if(c?.kind==="field")target(c.binding);if(c?.kind==="calculation")target(c,"documentId","blockId");}
      }
    }
    return changed;
  }
  const installed=new WeakSet();
  function registerNotebook(notebook) {
    if (!notebook?.register || installed.has(notebook)) return;
    installed.add(notebook);
    notebook.register("widget",{matches:isWidget,moveBindings,describe(project,doc,item,context={}) {
      const v=view(project,doc,item,context),cells=item.widget.type==="table"?(item.widget.state.tableVersion===1?item.widget.state.cells.map(c=>c.content):item.widget.state.rows.flatMap(r=>item.widget.state.columns.map(c=>r[keyFor(c.id)]))):[],fields=[];
      for(const c of cells.filter(c=>c?.kind==="field")) {const value=resolveCell(project,doc,c,context);fields.push({expression:c.expression,text:value.text,broken:value.token==="broken",...(c.binding?{binding:c.binding}:{})});}
      return {label:v.title,text:v.fallback.type==="text"?v.fallback.text:v.fallback.alt,fields};
    }});
  }
  registerNotebook(G.AtriumNotebook);
  function paint(ctx, item, options) {
    const {x,y,w,h}=item;
    draw(ctx,options.widgetViews?.get(item.id) || storedFallback(item),{x,y,w,h,assets:options.assets,viewport:options.viewport,scale:options.scale});
    return true;
  }
  return Object.freeze({types,limits,size,storedFallback,paint,moveBindings,registerNotebook,isWidget,valid,validCell,stateOK,withinBytes,fallbackOK,make,keyFor,view,views,draw,resolveCell,checked,setDone,safeURL,openURL,bodeResult});
})();
