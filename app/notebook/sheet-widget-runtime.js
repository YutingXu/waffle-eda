"use strict";
// Paint only a prepared view. Solver, field and extension work starts outside the canvas frame.
globalThis.AtriumSheetWidgetRuntime = (() => {
  const G=globalThis,W=G.AtriumSheetWidgets;
  const tableInputs=new WeakMap(), interactions=new WeakMap();
  let projects=new WeakMap(), colours=null;
  const optional=name=>G[name]?Promise.resolve(G[name]):G.AtriumLazy?.modules().includes(name)?G.AtriumLazy.need(name):Promise.resolve(null);
  function storage(project) {
    let state=projects.get(project);
    if (!state) {state={views:new Map(),sweeps:new Map()};projects.set(project,state);}
    return state;
  }
  function theme() {
    if (colours) return colours;
    if (typeof document==="undefined") return {};
    const style=getComputedStyle(document.documentElement),get=k=>style.getPropertyValue("--"+k).trim();
    colours={paper:get("field"),ink:get("ink"),line:get("line-strong"),muted:get("muted"),accent:get("accent"),warning:get("warning"),broken:get("danger")};
    return Object.fromEntries(Object.entries(colours).filter(([,v])=>v));
  }
  function invalidate() {projects=new WeakMap();colours=null;G.AtriumNavHost?.invalidate?.();}
  const current=(h,p,rev)=>!h || h.project()===p && h.revision()===rev;
  function calculationInputs(item) {
    const s=item.widget.state;
    if (item.widget.type.startsWith("ext.")) return G.AtriumExtensionWidgetDeclarations?.inputs(item.widget.type) || [];
    if (item.widget.type==="power-budget") return s.sources.map(r=>r.input);
    if (item.widget.type==="table" && s.tableVersion===1) {
      let inputs=tableInputs.get(s.cells);
      if(!inputs){
        inputs=[];
        for(const {content} of s.cells)if(content?.kind==="field" || content?.kind==="calculation")inputs.push(content);
        tableInputs.set(s.cells,inputs);
      }
      return inputs;
    }
    if (item.widget.type==="table") return s.rows.flatMap(r=>s.columns.map(c=>r[W.keyFor(c.id)]));
    return [];
  }
  async function sweep(project,item,ctx) {
    const b=item.widget.state,rev=ctx.revision;
    if (!b.probe || !ctx.host || !current(ctx.host,project,rev)) return null;
    const bench=b.bench ? project.simulation?.benches?.find(x=>x.id===b.bench) : null;
    if (b.bench && !bench) throw Error("SPICE bench unavailable.");
    const analysis=bench?.analyses?.find(a=>(a.type || a.kind)==="ac") || {type:"ac",sweep:"dec",points:20,fstart:10,fstop:1e6};
    const opts={...(bench?{bench:bench.id}:{}),engine:"builtin",analysis,probes:[b.probe]};
    const key=JSON.stringify([ctx.revision,opts]), cache=storage(project).sweeps;
    if (!cache.has(key)) {
      const promise=optional("AtriumExtensions").then(api=>{
        if (!current(ctx.host,project,rev)) return null;
        if (!api?.list().some(e=>e.id==="waffle.spice" && e.origin==="builtin" && e.enabled)) throw Error("SPICE extension unavailable.");
        return api.execute("spice.simulate",opts);
      });
      cache.set(key,promise);if (cache.size>32) cache.delete(cache.keys().next().value);
    }
    const response=await cache.get(key);
    return response && W.bodeResult(response,b.probe,b.channel || "both");
  }
  async function prepare(project,doc,item,context={}) {
    if(G.AtriumLabs?.notebookEnabled()===false)return W.storedFallback(item);
    const ctx={...context},type=item.widget.type;
    const external=type.startsWith("ext.");
    if (type==="table" && item.widget.state.tableVersion===1) {
      if (G.AtriumPrefs && G.AtriumPrefs.get("butter.tables") !== true) return W.storedFallback(item);
      await optional("AtriumTableVisual");
      if(item.widget.state.query) {
        const api=await optional("AtriumTableQuery"),prior=item.widget.state,host=ctx.host,revision=ctx.revision;
        const here=()=>!host || host.project()===project && host.revision()===revision && doc.items.includes(item) && item.widget.state===prior;
        const live=host && ctx.purpose==="screen" && !ctx.authority;
        const result=api && await (live ? api.projected(prior,{project,host,revision}) :
          api.refresh(prior,{project,revision,defs:ctx.defs,authority:ctx.authority,signal:ctx.signal,isCurrent:here}));
        if(!here())return null;
        if(!result?.complete){
          const message=result?.diagnostic?.message || "Query unavailable";
          if(ctx.authority)return {title:"Query table",width:item.w,height:item.h,rows:[{cells:[{text:message,token:"broken"}]}],
            fallback:{type:"text",text:message}};
          ctx.queryDiagnostic=message;
        } else if(prior!==result.state) {
          item={...item,widget:{...item.widget,state:result.state}};
        }
      }
      const kinds=G.AtriumTableData.contentKinds(item.widget.state);
      if(kinds.has("math"))await optional("AtriumMath");
      if(kinds.has("rich"))await optional("AtriumRichText");
      if(kinds.has("image"))await optional("AtriumNotebookImages");
    }
    if (external && !G.AtriumExtensionWidgetDeclarations) await optional("AtriumExtensions");
    if (type==="calculator") await optional("AtriumCalc");
    if (type==="todo" && item.widget.state.rows.some(r=>r.threadId)) await optional("AtriumReviewComments");
    const fullTable=type==="table" && item.widget.state.tableVersion===1;
    const kinds=fullTable ? G.AtriumTableData.contentKinds(item.widget.state) : null;
    const inputs=fullTable && !kinds.has("field") && !kinds.has("calculation") ? [] : calculationInputs(item).filter(Boolean);
    if (inputs.some(r=>r.kind==="field") && !ctx.fields) await optional("AtriumNoteFields");
    if (inputs.some(r=>r.kind==="calculation") && !ctx.calculation && !ctx.calculationRecords && !ctx.evaluations && ctx.revision!=null) {
      const calc=await optional("AtriumCalculations"),seen=new Map();
      for (const r of inputs.filter(x=>x.kind==="calculation")) {
        const opt={documentId:r.documentId,blockId:r.blockId,...(r.instanceId?{instanceId:r.instanceId}:{}),revision:ctx.revision},key=JSON.stringify(opt);
        if (!seen.has(key)) seen.set(key,calc?.evaluate(project,{...opt,...(ctx.host?{host:ctx.host}:{}),signal:ctx.signal}));
      }
      await Promise.all([...seen.values()]);
    }
    if (type==="bode" && !ctx.bode) {
      try {const plot=await sweep(project,item,ctx);ctx.bode=()=>plot;if (!plot) ctx.bodeStatus="No AC trace for this probe";}
      catch(e) {ctx.bodeStatus=e.message;}
    }
    if (external && !ctx.extension && G.AtriumExtensionWidgetDeclarations?.allowed(type)) {
      const ext=await optional("AtriumExtensionWidgets");
      if (ext?.allowed(type)) {
        const result=await ext.request(project,doc,item,ctx);
        if (!result) return null;
        ctx.extension=()=>result.view;
      }
    }
    return W.view(project,doc,item,ctx);
  }
  function preparedView(project,doc,item,revision) {
    if (item.widget.type.startsWith("ext.") && !G.AtriumExtensionWidgetDeclarations?.allowed(item.widget.type)) return null;
    const entry=storage(project).views.get(doc.id+"/"+item.id);
    return entry?.item===item && entry.revision===revision ? entry.view : null;
  }
  async function interact(host,doc,item,event) {
    if(G.AtriumLabs?.notebookEnabled()===false)return false;
    const project=host.project(),revision=host.revision();
    if (host.doc()!==doc || !doc.items.includes(item)) return false;
    let queue=interactions.get(item);
    if(!queue || queue.host!==host || queue.doc!==doc || queue.project!==project || queue.revision!==revision){
      queue={host,doc,project,revision,pending:0,tail:Promise.resolve()};
      interactions.set(item,queue);
    }
    // One active interaction and up to twelve waiting, as at the extension host.
    if(queue.pending>=13)throw Error("Widget interaction queue full.");
    queue.pending++;
    const run=queue.tail.then(async()=>{
      const revision=queue.revision;
      const active=()=>G.AtriumLabs?.notebookEnabled()!==false && current(host,project,revision) &&
        host.doc()===doc && doc.items.includes(item);
      if(!active())return false;
      const ext=await optional("AtriumExtensionWidgets");
      if(!active())return false;
      const ctx={host,revision,dark:document.documentElement.dataset.theme==="dark"};
      const result=await ext?.request(project,doc,item,ctx,event);
      if (!result?.state || !active()) return false;
      if (JSON.stringify(result.state)===JSON.stringify(item.widget.state)) return false;
      const accepted=host.edit(()=>{item.widget.state=result.state;},"Update "+(item.text || "widget").split("\n")[0],[item]);
      if(accepted===false)return false;
      queue.revision=host.revision();
      return true;
    });
    const finished=()=>{
      if(--queue.pending===0 && interactions.get(item)===queue)interactions.delete(item);
    };
    queue.tail=run.then(finished,finished);
    return run;
  }
  const later=fn=>setTimeout(fn,0);
  function paint(ctx,item,opts) {
    const h=G.AtriumNavHost,doc=opts.doc,project=opts.project || h?.project?.();
    if (!doc || !project) return false;
    const revision=h?.project?.()===project?h.revision():null,cache=storage(project).views,key=doc.id+"/"+item.id;
    let entry=cache.get(key);
    if (entry?.revision!==revision || entry?.item!==item) {
      const state=item.widget.state;
      const previousView=item.widget.type==="table" && entry?.item===item && entry.state===state ?
        entry.view ?? entry.previousView : null;
      entry={item,state,revision,view:null,previousView};cache.set(key,entry);
      if (cache.size>1024) cache.delete(cache.keys().next().value);
      const rec=entry, update=async()=>{
        if (cache.get(key)!==rec || !current(h,project,revision)) return;
        if (G.AtriumPower?.visible()===false) {cache.delete(key);return;}
        try {
          const v=await prepare(project,doc,item,{revision,host:h,defs:opts.defs,purpose:"screen",dark:document.documentElement.dataset.theme==="dark"});
          if (v===null) {setTimeout(update,260);return;}
          rec.view=v;
        } catch(e) {rec.view={title:item.text,width:item.w,height:item.h,rows:[{cells:[{text:e.message,token:"broken"}]}],fallback:item.widget.fallback};}
        // The retained schematic layer may still show the fallback painted before this view arrived.
        if (cache.get(key)===rec && current(h,project,revision)) h?.invalidateDocument?.(doc.id,true);
      };
      if(item.widget.type==="table" && item.widget.state.query && h?.stageEdit)h.stageEdit("idle",key,()=>update());
      else later(update);
    }
    if (item.widget.type?.startsWith("ext.") && !G.AtriumExtensionWidgetDeclarations?.allowed(item.widget.type)) {
      W.draw(ctx,W.storedFallback(item),{x:item.x,y:item.y,w:item.w,h:item.h,theme:theme(),assets:opts.assets,scale:opts.scale,viewport:opts.viewport});return true;
    }
    const view=entry.view ?? entry.previousView;
    if (!view) return false;
    W.draw(ctx,view,{x:item.x,y:item.y,w:item.w,h:item.h,theme:theme(),assets:opts.assets,scale:opts.scale,viewport:opts.viewport});return true;
  }
  function partIn(ctx) {
    const i=ctx.host.doc().items.find(i=>i.kind==="part" && ctx.selection.includes(i.id));
    return i?{docId:ctx.docId,itemId:i.id}:null;
  }
  function entries(ctx) {
    if (!ctx || ctx.surface || ctx.kind!=="schematic") return [];
    const available=[...Object.entries(W.types).map(([type,title])=>({type,title})),...(G.AtriumExtensionWidgetDeclarations?.entries() || [])];
    return available.map(({type,title})=>({key:"widget:"+type,kind:"insert",label:title,detail:"Sheet widget",group:"Widgets",keywords:"notebook widget "+type,
      ...(type==="todo"?{inline:G.AtriumWidgetCatalogue.todoAliases}:{}),preview:async r=>{
        const w=type.startsWith("ext.")?(await optional("AtriumExtensionWidgets")).make(type,[0,0]):W.make(type,[0,0],{argument:r.argument || "",part:partIn(ctx)});
        return {kind:"widget",title,scene:W.view(ctx.host.project(),ctx.host.doc(),w,{defs:ctx.host.defs(),revision:ctx.host.revision()})};
      },run:async r=>{
        const c=r.context,h=c.host,d=h.doc(),project=h.project();
        const ext=type.startsWith("ext.") ? await optional("AtriumExtensionWidgets") : null;
        if (h.project()!==project || h.doc()!==d || d.id!==c.docId || d.kind!=="schematic" || c.surface || r.signal?.aborted)
          throw Error("The sheet changed. Open the palette again.");
        const at=h.snapAt?.(c.point) || c.point,i=ext?ext.make(type,at):W.make(type,at,{argument:r.argument || "",part:partIn(c)});
        h.edit(()=>d.items.push(i),"Place "+title,[i]);h.setTool("select");h.select([i.id]);h.canvas()?.focus();return i;
      }}));
  }
  function activateRow(h,doc,item,point,pointerType) {
    if (G.AtriumLabs?.notebookEnabled()===false || h?.tool?.()!=="select" || !W.isWidget(item) || !doc || !point) return false;
    const markup=G.AtriumMarkup, kind=markup?.kind(item);
    if (kind && !markup.policy(doc).hit({kind,id:item.id})) return false;
    const x=point[0]-item.x,y=point[1]-item.y;
    if (x<0 || x>item.w || y<5.2 || y>=item.h) return false;
    const index=Math.floor((y-5.2)/3.05),project=h.project();
    if (item.widget.type==="todo" && x<=3.6) {
      const r=item.widget.state.rows[index],done=r && W.checked(project,r);
      if (!r || done===null) return false;
      h.edit(()=>W.setDone(project,item,r.id,!done),"Check to-do",r.threadId?undefined:[item]);return true;
    }
    if (item.widget.type==="link" && index===0 && W.safeURL(item.widget.state.url)) {
      try {Promise.resolve(W.openURL(item.widget.state.url)).catch(error=>h.info?.(error.message));}
      catch(error) {h.info?.(error.message);}
      return true;
    }
    if (item.widget.type.startsWith("ext.")) {
      const row=preparedView(project,doc,item,h.revision())?.rows[index];
      if (row?.action) {
        interact(h,doc,item,{type:["touch","pen"].includes(pointerType)?"touch":"activate",action:row.action}).catch(error=>h.info?.(error.message));return true;
      }
    }
    return false;
  }
  if (typeof window!=="undefined") {
    window.addEventListener("atrium-theme",invalidate);
    let start=null;
    document.addEventListener("pointerdown",e=>{start=e.button===0 && e.target.tagName==="CANVAS"?[e.clientX,e.clientY,e.target,e.pointerType]:null;},true);
    document.addEventListener("pointercancel",()=>{start=null;},true);
    document.addEventListener("waffle-canvas-tap",e=>{
      const d=e.detail,h=G.AtriumNavHost;
      if (!e.defaultPrevented && d?.docId===h?.currentId?.() && activateRow(h,h.doc(),d.item,d.point,d.pointerType)) {
        start=null;e.preventDefault();
      }
    },true);
    document.addEventListener("click",e=>{
      const at=start;start=null;
      if (!at || at[2]!==e.target || Math.hypot(e.clientX-at[0],e.clientY-at[1])>5 || e.detail>1 ||
        e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      const h=G.AtriumNavHost,hit=h?.hit?.(e.target,e.clientX,e.clientY);
      activateRow(h,hit?.doc,hit?.item,hit?.point,at[3]);
    },true);
    document.addEventListener("keydown",e=>{
      if (G.AtriumLabs?.notebookEnabled()===false || e.key!=="Enter" || e.target.tagName!=="CANVAS" || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const h=G.AtriumNavHost,ids=h?.selection?.(),item=ids?.length===1 && h.doc().items.find(i=>i.id===ids[0]);
      if(W.isWidget(item)) {e.preventDefault();optional("AtriumSheetWidgetEditor").then(ui=>ui?.open(item.id));}
    },true);
  }
  return Object.freeze({prepare,preparedView,interact,sweep,paint,theme,invalidate,entries});
})();
