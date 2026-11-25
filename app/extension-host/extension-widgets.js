"use strict";
// Widget commands execute in the owning worker. The sheet receives bounded text, states and points.
globalThis.AtriumExtensionWidgets = (() => {
  const G=globalThis, busy=new Map();
  if (!G.AtriumExtensionWidgetDeclarations && typeof require === "function") require("./extension-widget-declarations.js");
  const D=G.AtriumExtensionWidgetDeclarations, {current,bounded,stateOK,projectState,mergeState,limits,key,str,obj,safeCopy}=D;
  const text=s=>({text:String(s)});
  function make(type,at) {
    const d=current(type);
    if (!d) throw Error("Widget permission unavailable.");
    const s=Object.fromEntries(Object.entries(d.spec.state).map(([k,v])=>[k,v.type==="list"?[]:v.default]));
    return G.AtriumSheetWidgets.make(type,at,{title:d.spec.name,w:d.spec.size.preferred[0],h:d.spec.size.preferred[1],state:s,fallback:safeCopy(d.spec.fallback)});
  }
  function cleanView(raw,item,def) {
    if (!bounded(raw) || !obj(raw) || !str(raw.title,80) || !Array.isArray(raw.rows) || raw.rows.length>limits.rows) throw Error("Widget returned an invalid view.");
    const rows=raw.rows.map(r=>{
      if (!obj(r) || !Array.isArray(r.cells) || r.cells.length>limits.cells || r.action!==undefined && !key(r.action)) throw Error("Invalid widget row.");
      const cells=r.cells.map(c=>{
        if (!obj(c) || !str(c.text,512) || c.token!=null && !["ink","muted","accent","link","warning","broken"].includes(c.token)) throw Error("Invalid widget cell.");
        return Object.freeze({...text(c.text),...(c.token?{token:c.token}:{})});
      });
      return Object.freeze({cells:Object.freeze(cells),...(r.action && def.event?{action:r.action}:{}),...(typeof r.checked==="boolean"?{checked:r.checked}:{})});
    });
    return Object.freeze({title:raw.title,width:item.w,height:item.h,rows:Object.freeze(rows),fallback:Object.freeze({...item.widget.fallback,...(item.widget.fallback.assetRef?{assetRef:Object.freeze({...item.widget.fallback.assetRef})}:{})})});
  }
  function request(project,doc,item,ctx,event={type:"render"}) {
    const d=current(item.widget.type),saved=item.widget.state;
    const state=d && projectState(saved,d.spec.state);
    if (!state) return Promise.reject(Error("Widget unavailable or state outside its schema."));
    const rendering=event.type==="render",cmd=rendering?d.spec.render:d.spec.event;
    if (!cmd || !["render","touch","key","focus","activate"].includes(event.type)) return Promise.reject(Error("Unsupported widget event."));
    const now=Date.now(), owner=d.rec.record.id, b=busy.get(owner) || {active:false,next:0,waiting:0};
    if (rendering && (b.active || b.waiting || b.next>now)) return Promise.resolve(null);
    if (b.active) {
      if (b.waiting>=12) return Promise.reject(Error("Widget interaction queue full."));
      b.waiting++;
      return b.finished.then(()=>{b.waiting--;return request(project,doc,item,ctx,event);});
    }
    busy.set(owner,b); b.active=true;b.next=now+limits.interval;
    let release;b.finished=new Promise(resolve=>{release=resolve;});
    const inputs=Object.fromEntries(d.spec.inputs.map(input=>{
      const c=G.AtriumSheetWidgets.resolveCell(project,doc,input,ctx);
      return [input.key,{text:c.text,broken:c.token==="broken",...(c.quantity?.ok?{value:c.quantity.value,dimensions:c.quantity.dimensions,unit:c.quantity.unit}:{})}];
    }));
    const size=[item.w,item.h].map((n,i)=>Math.min(d.spec.size.max[i],Math.max(d.spec.size.min[i],n)));
    const payload={event:{type:event.type,...(key(event.action)?{action:event.action}:{}),...(["Enter"," ","ArrowDown","ArrowUp","Escape"].includes(event.key)?{key:event.key}:{})},
      state,inputs,size,theme:ctx.dark?"dark":"light",tokens:["ink","muted","accent","link","warning","broken"]};
    let timer;
    const within=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Widget render budget exceeded.")),limits.timeout);});
    const invoke=Promise.resolve().then(()=>{
      if (d!==current(item.widget.type)) throw Error("Widget permission unavailable.");
      return d.rec.bridge.invoke(d.rec.record,cmd,payload,"widgetInvoke");
    });
    return Promise.race([invoke,within]).then(r=>{
      if (d!==current(item.widget.type)) throw Error("Widget permission changed.");
      if (!bounded(r)) throw Error("Widget returned excessive data.");
      if (rendering) return {view:cleanView(r,item,d.spec)};
      const changed=obj(r) && mergeState(saved,r.state,d.spec.state);
      if (!changed) throw Error("Widget event produced invalid state.");
      return {state:safeCopy(changed)};
    }).finally(()=>{clearTimeout(timer); b.active=false;release();});
  }
  return Object.freeze({validate:D.validate,install:D.install,remove:D.remove,allowed:D.allowed,entries:D.entries,make,request,
    stateOK,limits,size:D.size,inputs:D.inputs});
})();
