"use strict";
// Palette indexing needs only titles and aliases. Load the editors and scene on preview or placement.
globalThis.AtriumWidgetCatalogue=(()=>{
  const G=globalThis,types=Object.freeze({todo:"To-do list",table:"Table","pin-map":"Pin-map table","power-budget":"Power budget",bode:"Bode plot",calculator:"Calculator",link:"Link card"});
  const todoAliases=Object.freeze(["todo-list","checklist-widget"]);
  if (!G.AtriumWidgetFallback && typeof require === "function") require("./widget-fallback.js");
  const {chars,withinBytes,fallbackOK}=G.AtriumWidgetFallback;
  const limits = Object.freeze({rows:256,columns:16,chars,size:400,points:512,state:65536});
  const object = x => !!x && typeof x === "object" && !Array.isArray(x);
  const safeKey = k => /^[a-zA-Z_][a-zA-Z0-9_-]{0,47}$/.test(k) && !["constructor","prototype","__proto__"].includes(k);
  const identifier = v => typeof v === "string" && /^[\x21-\x7e]{1,128}$/.test(v);
  const short = (x,n=512) => typeof x === "string" && x.length <= n;
  function stateOK(data) {
    let count = 0;
    function visit(x,d) {
      if (d > 10 || ++count > 8192) return false;
      if (x === null || typeof x === "boolean" || Number.isFinite(x)) return true;
      if (typeof x === "string") return short(x,4096);
      if (Array.isArray(x)) return x.length <= limits.rows && x.every(v => visit(v,d+1));
      return object(x) && Object.entries(x).every(([k,v]) => safeKey(k) && visit(v,d+1));
    }
    return object(data) && visit(data,0) && withinBytes(JSON.stringify(data),limits.state);
  }
  const ordered = a => Array.isArray(a) && a.length <= limits.rows && a.every(r=>object(r) && identifier(r.id)) && new Set(a.map(r=>r.id)).size === a.length;
  const reference = r => r == null || (object(r) && identifier(r.docId) && identifier(r.itemId));
  const exclusive=["role","math","richText","calculation","sticky","callout","ink","sketch","reviewChecklist","notebook"];
  const isWidget = i => i?.kind === "textframe" && object(i.widget);
  const calculatorPresets=Object.freeze([["voltage_divider","Voltage divider"],["led_resistor","LED resistor"],["rclc","RC filter"]].map(Object.freeze));
  function valid(i,{cacheTable=false}={}) {
    if (!isWidget(i) || exclusive.some(k=>i[k]!=null) || i.note === true ||
        !Number.isFinite(i.w) || !Number.isFinite(i.h) || i.w <= 0 || i.h <= 0 || i.w > limits.size || i.h > limits.size) return false;
    const {type,state:s,fallback} = i.widget;
    if (type==="table" && s?.tableVersion===1) {
      if (!fallbackOK(fallback)) return false;
      try { return !!G.AtriumTableData?.[cacheTable?"validateView":"validate"](s); } catch { return false; }
    }
    if (!identifier(type) || !stateOK(s) || !fallbackOK(fallback)) return false;
    if (!Object.hasOwn(types,type)) return /^ext\.[a-zA-Z0-9][a-zA-Z0-9._-]{0,122}$/.test(type);
    if (type === "todo") return ordered(s.rows) && s.rows.every(r => short(r.text,2048) && typeof r.done === "boolean" &&
      (r.assignee == null || short(r.assignee,128)) && (!r.due || /^\d{4}-\d{2}-\d{2}$/.test(r.due)) && reference(r.link) && (!r.threadId || identifier(r.threadId)));
    if (type === "table") return ordered(s.rows) && ordered(s.columns) && s.columns.length <= limits.columns && s.columns.every(c => /^[A-Za-z0-9]{1,40}$/.test(c.id) && short(c.title)) &&
      s.rows.every(r => Object.keys(r).every(k => k === "id" || (s.columns.some(c=>keyFor(c.id)===k) && validCell(r[k]))));
    if (type === "pin-map") return reference(s.part);
    if (type === "power-budget") return ordered(s.sources) && s.sources.every(r => short(r.rail,200) && ["load","rating"].includes(r.use) && validCell(r.input));
    if (type === "calculator") return calculatorPresets.some(([id]) => id === s.calculator);
    if (type === "bode") return short(s.probe,200) && short(s.bench,128) && (!s.channel || ["both","db","phase"].includes(s.channel));
    return short(s.url,2048) && short(s.caption,512);
  }
  function fieldBinding(v) {
    if (v==null) return true;
    if (!object(v) || !["project","sheet","item","signal","net"].includes(v.scope) && !reference(v)) return false;
    return ["docId","itemId","instanceId","signalId","parameterId"].every(k=>v[k]==null || identifier(v[k]));
  }
  function validCell(v) {
    return object(v) && (v.kind === "literal" && short(v.text,2048) || v.kind === "field" && short(v.expression,512) && fieldBinding(v.binding) ||
      v.kind === "calculation" && identifier(v.documentId) && identifier(v.blockId) && (!v.instanceId || identifier(v.instanceId)));
  }
  const keyFor = id => "c_" + id.replace(/-/g,"");
  function paint(ctx,item,options,request) {
    const print=options.purpose==="print" || options.widgetViews;
    const painter=print ? G.AtriumSheetWidgets : G.AtriumSheetWidgetRuntime;
    if (!print && (!options.purpose || options.purpose==="screen")) {
      if (!G.AtriumMarkup && item.widget.type==="todo" && item.widget.state?.rows?.some(row=>row.threadId)) {
        request("AtriumReviewNotes");
        return true;
      }
      if (!painter) request("AtriumSheetWidgetRuntime");
    }
    return painter?.paint(ctx,item,options) || false;
  }
  let installed=null;
  function attach() {
    if (!G.AtriumPalette || installed===G.AtriumPalette) return;
    installed=G.AtriumPalette;
    installed.registerProvider("sheet-widgets",ctx=>{
      if (ctx?.kind!=="schematic" || ctx.surface) return [];
      const list=[...Object.entries(types).map(([type,title])=>({type,title})),...(G.AtriumExtensionWidgetDeclarations?.entries() || [])];
      return list.map(({type,title})=>{
        const entry=async()=>{const mod=G.AtriumSheetWidgetRuntime || await G.AtriumLazy.need("AtriumSheetWidgetRuntime");
          const result=mod.entries(ctx).find(e=>e.key==="widget:"+type);
          if (!result) throw Error("Widget unavailable.");return result;};
        return {key:"widget:"+type,kind:"insert",label:title,detail:"Sheet widget",group:"Widgets",keywords:"notebook widget "+type,
          ...(type==="todo"?{inline:todoAliases}:{}),preview:async r=>(await entry()).preview(r),run:async r=>(await entry()).run(r)};
      });
    });
  }
  if (typeof window!=="undefined") window.addEventListener("waffle-palette-ready",attach);
  attach();return Object.freeze({types,limits,todoAliases,keyFor,isWidget,valid,validCell,stateOK,withinBytes,fallbackOK,paint,attach,calculatorPresets});
})();
