"use strict";
// Validate and index declarations without loading widget rendering or starting an extension.
globalThis.AtriumExtensionWidgetDeclarations = (() => {
  const G=globalThis, owners=new Map(), definitions=new Map();
  if (!G.AtriumWidgetFallback && typeof require === "function") require("../notebook/widget-fallback.js");
  const {withinBytes,fallbackOK}=G.AtriumWidgetFallback;
  const limits=Object.freeze({types:16,properties:24,inputs:16,rows:48,cells:8,points:256,bytes:32768,interval:250,timeout:160});
  const key=s=>typeof s==="string" && /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/.test(s) && !["constructor","prototype","__proto__"].includes(s);
  const str=(s,n=256)=>typeof s==="string" && s.length<=n;
  const obj=s=>s!=null && typeof s==="object" && !Array.isArray(s);
  const safeCopy=x=>JSON.parse(JSON.stringify(x));
  function plain(x,depth=0,budget={n:0}) {
    if (++budget.n>2400 || depth>8) return false;
    if (x===null || typeof x==="boolean" || Number.isFinite(x)) return true;
    if (typeof x==="string") return str(x,4096);
    if (Array.isArray(x)) return x.length<=256 && x.every(v=>plain(v,depth+1,budget));
    return obj(x) && Object.entries(x).every(([k,v])=>key(k) && plain(v,depth+1,budget));
  }
  function bounded(x) {return plain(x) && withinBytes(JSON.stringify(x),limits.bytes);}
  function schemaOK(s,nested=false) {
    if (!obj(s) || Object.keys(s).length>limits.properties) return false;
    return Object.entries(s).every(([k,v])=>key(k) && obj(v) && (
      v.type==="string" && Number.isInteger(v.maxLength) && v.maxLength>0 && v.maxLength<=2048 && str(v.default,v.maxLength) ||
      v.type==="number" && [v.min,v.max,v.default].every(Number.isFinite) && v.min<=v.default && v.default<=v.max ||
      v.type==="boolean" && typeof v.default==="boolean" ||
      !nested && v.type==="list" && Number.isInteger(v.maxItems) && v.maxItems>0 && v.maxItems<=128 && schemaOK(v.fields,true) && !Object.hasOwn(v.fields,"id")));
  }
  // Saved records can come from a newer package. Only the declared fields enter the worker.
  function projectRecord(saved,schema,fromStorage) {
    if (!fromStorage && Object.keys(saved).some(k=>!Object.hasOwn(schema,k))) return null;
    const state={};
    for (const [k,v] of Object.entries(schema)) {
      if (!Object.hasOwn(saved,k)) {
        if (fromStorage) state[k]=v.type==="list"?[]:v.default;
        continue;
      }
      const a=saved[k];
      if (v.type==="list") {
        if (!Array.isArray(a) || a.length>v.maxItems || new Set(a.map(r=>r?.id)).size!==a.length) return null;
        const rows=[];
        for (const r of a) {
          if (!obj(r) || !str(r.id,128) || !/^[\x21-\x7e]+$/.test(r.id)) return null;
          const {id,...fields}=r, row=projectRecord(fields,v.fields,fromStorage);
          if (!row) return null;
          rows.push({id,...row});
        }
        state[k]=rows;
      } else {
        const valid=v.type==="string"?str(a,v.maxLength):v.type==="number"?Number.isFinite(a) && a>=v.min && a<=v.max:typeof a==="boolean";
        if (!valid) return null;
        state[k]=a;
      }
    }
    return state;
  }
  function projectState(state,schema,fromStorage=true) {
    if (!obj(state) || !bounded(state)) return null;
    const projected=projectRecord(state,schema,fromStorage);
    return projected && bounded(projected)?projected:null;
  }
  const stateOK=(state,schema)=>projectState(state,schema)!==null;
  // An event updates the fields it returns. For a returned list, row IDs carry opaque fields
  // across reordering. An echoed virtual default does not change the stored record.
  function mergeRecord(saved,changes,schema) {
    const state={...saved};
    for (const [k,value] of Object.entries(changes)) {
      const spec=schema[k], had=Object.hasOwn(saved,k);
      if (spec.type==="list") {
        if (!had && !value.length) continue;
        const prior=new Map((saved[k] || []).map(row=>[row.id,row]));
        state[k]=value.map(({id,...row})=>mergeRecord(prior.get(id) || {id},row,spec.fields));
      } else if (had || value!==spec.default) state[k]=value;
    }
    return state;
  }
  function mergeState(saved,next,schema) {
    const changes=projectState(next,schema,false);
    if (!changes) return null;
    const state=mergeRecord(saved,changes,schema);
    return bounded(state)?state:null;
  }
  function validate(manifest) {
    const list=manifest.contributes?.widgets;
    if (list===undefined) return [];
    const check=(condition,why)=>{if (!condition) throw Error("Invalid widget contribution: "+why+".");};
    check(Array.isArray(list) && list.length<=limits.types,"too many widget types");
    const own=new Set((manifest.contributes.commands || []).map(c=>c.command)),ids=new Set();
    for (const w of list) {
      check(obj(w) && key(w.id) && !ids.has(w.id) && str(w.name,80) && w.name.trim(),"unique ID and visible name required");
      ids.add(w.id);
      check(manifest.permissions?.includes("ui:widgets"),"declare ui:widgets");
      check(own.has(w.render) && (!w.event || own.has(w.event)),"commands must be declared by this package");
      check(schemaOK(w.state),"state schema must contain bounded primitive properties or lists");
      const inp=w.inputs;
      check(Array.isArray(inp) && inp.length<=limits.inputs && new Set(inp.map(i=>i?.key)).size===inp.length,"invalid input declarations");
      check(inp.every(i=>obj(i) && key(i.key) && ["field","calculation"].includes(i.kind) &&
        (i.kind==="field"?str(i.expression,512):str(i.documentId,128) && str(i.blockId,128))),"invalid input");
      check(!inp.length || manifest.permissions.includes("read:project"),"design inputs require read:project");
      check(fallbackOK(w.fallback),"a bounded text or asset fallback is required");
      const size=w.size;
      check(obj(size) && ["min","preferred","max"].every(k=>Array.isArray(size[k]) && size[k].length===2 && size[k].every(n=>Number.isFinite(n) && n>=4 && n<=400)) &&
        [0,1].every(i=>size.min[i]<=size.preferred[i] && size.preferred[i]<=size.max[i]),"invalid size range");
    }
    return list;
  }
  function remove(owner) {
    const rec=owners.get(owner);
    if (!rec) return;
    owners.delete(owner);
    for (const k of rec.ids) definitions.delete(k);
    G.AtriumPalette?.invalidateProvider?.("sheet-widgets");
    G.AtriumSheetWidgetRuntime?.invalidate?.();
  }
  function install(record,bridge) {
    remove(record.id);
    const rec={record,bridge,ids:[]};
    for (const spec of validate(record.manifest)) {
      const type="ext."+record.id+"."+spec.id;
      if (definitions.has(type)) throw Error("Widget ID is already in use.");
      rec.ids.push(type);definitions.set(type,{type,spec,rec});
    }
    owners.set(record.id,rec);
    G.AtriumPalette?.invalidateProvider?.("sheet-widgets");
    G.AtriumSheetWidgetRuntime?.invalidate?.();
  }
  const available=d=>d && d.rec.bridge.current(d.rec.record,"ui:widgets") && (!d.spec.inputs.length || d.rec.bridge.current(d.rec.record,"read:project"));
  const entries=()=>Array.from(definitions.values()).filter(available).map(({type,spec})=>({type,title:spec.name,size:safeCopy(spec.size),fallback:safeCopy(spec.fallback)}));
  const current=type=>{const d=definitions.get(type);return available(d)?d:null;};
  return Object.freeze({validate,install,remove,entries,current,limits,bounded,stateOK,projectState,mergeState,key,str,obj,safeCopy,allowed:type=>!!current(type),
    size:type=>definitions.get(type)?.spec.size,inputs:type=>safeCopy(current(type)?.spec.inputs || [])});
})();
