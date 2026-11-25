"use strict";
// Pure, display-only projections. Canvas, Compare, Smart PDF and MCP interpret each
// field from the project revision being displayed. The projection is never saved.
globalThis.AtriumNotebook = (() => {
  const tokens=new WeakMap();
  function projectToken(project){if(!project)return null;if(!tokens.has(project))tokens.set(project,globalThis.Atrium.id());return tokens.get(project);}
  const providers=new Map(), plain=o=>!!o && typeof o==="object" && !Array.isArray(o);
  const styles=["paragraph","h1","h2","h3","bullet","number","check"], fonts=["sans","serif","mono","hand"];
  const safeURL=value=>{
    if(typeof value!=="string" || value.length>4096) return "";
    if (value.startsWith("waffle:")) return globalThis.AtriumLinkRecord?.parse(value) ? value : "";
    try {const u=new URL(value);return ["https:","http:","mailto:"].includes(u.protocol)?value:"";} catch {return "";}
  };
  const color=value=>typeof value==="string" && /^#[0-9a-f]{6}$/i.test(value);
  function validate(body) {
    if (!plain(body) || !Array.isArray(body.blocks) || !body.blocks.length || body.blocks.length>4096) return false;
    if (body.font!=null && !fonts.includes(body.font) && !(plain(body.font) && ((body.font.source==="system" && typeof body.font.family==="string" && /^[\p{L}\p{N} ._-]{1,80}$/u.test(body.font.family)) ||
      (body.font.source==="asset" && /^[a-f0-9]{64}$/.test(body.font.assetRef?.sha256) && body.font.assetRef?.mediaType==="font/ttf" && Number.isSafeInteger(body.font.assetRef?.byteLength) && body.font.assetRef.byteLength>0 && body.font.assetRef.byteLength<=8e6 && body.font.license==="OFL-1.1")))) return false;
    let runs=0, chars=0;
    for (const b of body.blocks) {
      if(!plain(b) || !styles.includes(b.style) || b.align!=null && !["left","center","right"].includes(b.align) || b.checked!=null && typeof b.checked!=="boolean" || !Array.isArray(b.runs)) return false;
      for(const r of b.runs) {
        if(++runs>32768 || !plain(r)) return false;
        const s=r.type==="text"?r.text:r.type==="field"?r.expression:r.type==="math"?r.tex:null;
        if(typeof s!=="string" || (chars+=s.length)>524288 || r.type==="field" && s.length>512 || r.type==="math" && s.length>16384) return false;
        for(const k of ["bold","italic","underline","strike","code"]) if(r[k]!=null && typeof r[k]!=="boolean") return false;
        if(r.color && !color(r.color) || r.highlight && !color(r.highlight) || r.href && !safeURL(r.href)) return false;
        if(r.binding!=null && (!plain(r.binding) || typeof r.binding.field!=="string" || !r.binding.field.length || r.binding.field.length>512)) return false;
      }
    }
    return true;
  }
  function textBody(text,style="paragraph") {
    return {font:"sans",blocks:String(text ?? "").split(/\r?\n/).map((t,i)=>({style:i?"paragraph":style,runs:t?[{type:"text",text:t}]:[]}))};
  }
  function parseInline(text,project,doc,marks={},ctx={}) {
    const runs=[],parts=/(\{[^{}\r\n]{1,512}\}|\$[^$\r\n]+\$|\*\*[^*\r\n]+\*\*|~~[^~\r\n]+~~|\x60[^\x60\r\n]+\x60|(?<!\*)\*[^*\r\n]+\*(?!\*))/g;
    let last=0;
    function add(t) {if(t) runs.push({type:"text",text:t,...marks});}
    for(const m of text.matchAll(parts)) {
      const s=m[0];add(text.slice(last,m.index));last=m.index+s.length;
      if(s[0]==="{") {const expression=s.slice(1,-1),v=globalThis.AtriumNoteFields.resolve(project,doc,expression,null,ctx);
        runs.push({type:"field",expression,...(v.binding?{binding:v.binding}:{}),...marks});}
      else if(s[0]==="$") runs.push({type:"math",tex:s.slice(1,-1),...marks});
      else {const kind=s.startsWith("**")?"bold":s.startsWith("~~")?"strike":s[0]==="\x60"?"code":"italic",n=["bold","strike"].includes(kind)?2:1;
        runs.push({type:"text",text:s.slice(n,-n),...marks,[kind]:true});}
    }
    add(text.slice(last));return runs;
  }
  function bodyText(body,project,doc,ctx={},source=false) {
    const fields=[], blocks=[];let number=0;
    for (const b of body?.blocks || []) {
      const pieces=[];
      for (const r of b.runs || []) {
        if(r.type==="field") {
          if(source) {pieces.push("{"+r.expression+"}");continue;}
          const f=globalThis.AtriumNoteFields.resolve(project,doc,r.expression,r.binding,ctx);
          pieces.push(f.text);fields.push({expression:r.expression,text:f.text,broken:f.broken,binding:f.binding});
        } else pieces.push(r.type==="math"?(source?"$"+r.tex+"$":globalThis.AtriumMath?.layout(r.tex,{display:false})?.plain || r.tex):r.text || "");
      }
      number=b.style==="number"?number+1:0;
      const marker=b.style==="check"?(b.checked?"☑ ":"☐ "):b.style==="bullet"?"• ":number?number+". ":"";
      blocks.push(marker+pieces.join(""));
    }
    return {text:blocks.join("\n"),fields};
  }
  function register(type,p) {
    if(typeof type!=="string" || typeof p?.matches!=="function" || typeof p.describe!=="function") throw TypeError("A note descriptor needs matches and describe.");
    providers.set(type,p);return ()=>{if(providers.get(type)===p)providers.delete(type);};
  }
  const hinted=i=>i && (i.kind==="textframe" && i.role!=="frame" || i.richText || i.widget || i.calculation || i.math || i.sticky || i.callout || i.ink || i.sketch || i.reviewChecklist || i.notebook);
  function provider(item) {for(const [type,p] of providers) if(p.matches(item)) return [type,p];return [];}
  function isNote(i) {return !!i && (!!hinted(i) || !!provider(i)[0]);}
  const modules=[
    {name:"AtriumCalculations",has:i=>i.kind==="calculation" || i.kind==="textframe" && !!i.calculation,
      files:["notebook/preferred-values","notebook/calculation-intent","notebook/calculation-helpers","notebook/calculation-core","notebook/calculation-records","notebook/calculation-design","notebook/calculation-graph","notebook/calculation-checks","notebook/calculation-actions","notebook/calculations"]},
    {name:"AtriumTableVisual",has:i=>i.widget?.type==="table" && i.widget.state?.tableVersion===1,files:["project/source-file","notebook/table-data","notebook/calculation-intent","notebook/calculation-core","notebook/calculation-graph","notebook/calculation-design","notebook/widget-fallback","notebook/widget-catalogue","notebook/sheet-widgets","notebook/table-exchange","notebook/table-formulas","notebook/table-visual"]},
    {name:"AtriumSheetWidgets",has:i=>i.kind==="textframe" && !!i.widget,files:["notebook/preferred-values","analysis/calculators","notebook/widget-fallback","notebook/widget-catalogue","notebook/sheet-widgets","extension-host/extension-widget-declarations","extension-host/extension-widgets"]},
    {name:"AtriumMarkup",has:i=>i.kind==="textframe" && (i.sticky || i.callout || i.ink),
      files:["history/review-comments","notebook/sch-note-ink","notebook/sch-note-leader","notebook/sch-note-layer","history/review-notes-model"]}
  ];
  function used(project,m,{docId=null,itemId=null}={}) {
    return project?.documents?.some(d=>(!docId || docId===d.id) && d.items?.some(i=>(!itemId || itemId===i.id) && m.has(i)));
  }
  function required(projects,scope={}) {
    return modules.filter(m=>projects.some(p=>used(p,m,scope))).map(({name,files})=>({name,files:[...files]}));
  }
  async function demand(projects) {
    const lazy=globalThis.AtriumLazy,available=lazy?.modules?.();
    if(!available)return;
    const names=required(projects).filter(m=>!globalThis[m.name] && available.includes(m.name)).map(m=>m.name);
    if(names.length) await lazy.need(names);
  }
  function prepare(project,context={}) {
    for(const m of required([project],context)) if(!globalThis[m.name]) {
      if(typeof importScripts==="function") {
        try {importScripts(...m.files.map(n=>"../"+n+".js"));} catch(error) {
          if(error.name!=="NetworkError")throw error;
        }
      }
      // @ts-ignore CommonJS is available to the Node headless reader.
      else if(typeof require==="function") {
        // Older builds can still show a newer note's saved plain-text projection.
        // @ts-ignore Node's module resolver checks for the optional reader without loading it.
        try {require.resolve("../"+m.files.at(-1)+".js");} catch(error) {if(error.code==="MODULE_NOT_FOUND")continue;throw error;}
        // @ts-ignore The current record's reader is present.
        for(const name of m.files) require("../"+name+".js");
      }
    }
    const perType=new Map();
    for(const [type,p] of providers) if(p.prepare && (project.documents || []).some(d=>d.items?.some(i=>p.matches(i)))) perType.set(type,p.prepare(project,context) || {});
    return {...context,perType};
  }
  function describe(project,doc,item,context={}) {
    if(!item) return null;
    const [type,p]=provider(item);
    if(p) return {type,...p.describe(project,doc,item,{...context,...context.perType?.get(type)})};
    if(item.richText) return {type:"richtext",label:"Rich text",...bodyText(item.richText,project,doc,context)};
    if(hinted(item)) return {type:"note",label:"Note",text:item.text || "",fields:[]};
    return null;
  }
  function compare(before,after,ea,eb,ca,cb) {
    const a=ea?.item,b=eb?.item,da=describe(before,ea?.doc,a,ca),db=describe(after,eb?.doc,b,cb),p=provider(b || a)[1];
    if(!a||!b) return [{kind:a?"removed":"added",before:da,after:db,text:(a?"Removed ":"Added ")+(db || da).label,fields:[]}];
    const table=globalThis.AtriumTableData;
    const cells=table?.isItem(a) && table.isItem(b);
    const rows=cells ? table.compareTables(a,b) : p?.compare ? p.compare(a,da,b,db) : [];
    if (!cells && !p?.compare) {
      const authChanged=JSON.stringify(a.richText ?? a.widget ?? a.text)!==JSON.stringify(b.richText ?? b.widget ?? b.text);
      const fieldsChanged=JSON.stringify(da?.fields)!==JSON.stringify(db?.fields);
      if(authChanged || fieldsChanged || da?.text!==db?.text) {
        const field=authChanged?"content":"fields";rows.push({kind:field,before:da,after:db,text:(db?.label || "Note")+(authChanged?" edited":" fields changed"),fields:[field]});
      }
    }
    const geometry=["x","y","w","h","layer","fill","size","border","angle"].filter(k=>a[k]!==b[k]);
    if(geometry.length) rows.push({kind:"geometry",before:Object.fromEntries(geometry.map(k=>[k,a[k] ?? null])),after:Object.fromEntries(geometry.map(k=>[k,b[k] ?? null])),
      text:(db?.label || "Note")+" position or appearance changed",fields:geometry});
    return rows;
  }
  function clipboardSource(doc,items,owner) {
    const project=owner || globalThis.AtriumNavHost?.project?.();
    return items.some(i=>i.richText) && project?.documents.includes(doc)?{noteProject:projectToken(project),noteDoc:doc.id}:null;
  }
  function copyBindings(i,project,doc,clip,ids) {
      for(const b of i.richText.blocks) for(const run of b.runs) if(run.binding) {
        const b=run.binding, mapped=ids.has(b.itemId), origin=clip.noteDoc || clip.doc;
        const internal=b.scope==="sheet"?b.docId===origin:mapped;
        const docIds=internal && b.docId?new Map([[b.docId,doc.id]]):new Map();
        const external=clip.noteProject?clip.noteProject!==projectToken(project):!clip.doc || !project.documents.some(d=>d.id===clip.doc);
        run.binding=AtriumNoteFields.remap(b,{docIds,itemIds:ids},external && !internal);
      }
  }
  function moveBindings(project,fromDocId,toDocId,movedIds,instanceIds) {
    const moved=movedIds instanceof Set?movedIds:new Set(movedIds),changed=new Set();
    for(const d of project.documents || []) for(const i of d.items || []) for(const block of i.richText?.blocks || []) {
      for(const run of block.runs || []) {
        const next=AtriumNoteFields.rebaseTarget(run.binding,fromDocId,toDocId,moved,instanceIds,{fallback:true,richText:true});
        if(next){run.binding={...run.binding,...next};changed.add(i);}
      }
    }
    for(const p of providers.values()) if(p.moveBindings) for(const i of p.moveBindings(project,fromDocId,toDocId,moved,instanceIds) || []) changed.add(i);
    const calc=globalThis.AtriumCalculationRecords;
    if(calc?.moveBindings && !providers.get("calculation")?.moveBindings) for(const i of calc.moveBindings(project,fromDocId,toDocId,moved,instanceIds) || []) changed.add(i);
    return changed;
  }
  function read(project,{docId=null,itemId=null,offset=0,limit=100,...context}={}) {
    const rows=[],ctx=prepare(project,{...context,docId,itemId});let total=0;
    for(const doc of project.documents || []) if(!docId || docId===doc.id) for(const item of doc.items || []) if((!itemId || item.id===itemId) && isNote(item)) {
      if(total>=offset && rows.length<limit) rows.push({docId:doc.id,itemId:item.id,...describe(project,doc,item,ctx)});total++;
    }
    return {total,rows};
  }
  const api=Object.freeze({projectToken,clipboardSource,copyBindings,register,isNote,describe,compare,required,prepare,demand,moveBindings,read,bodyText,textBody,parseInline,validate,styles,fonts,safeURL,color});
  function imageChanges(keys,a,da,b,db) {
    const fields=keys.filter(k=>a[k]!==b[k] && (typeof a[k]!=="object" || !a[k] || JSON.stringify(a[k])!==JSON.stringify(b[k])));
    if(JSON.stringify(da.fields)!==JSON.stringify(db.fields))fields.push("fields");
    return fields.length?[{kind:"content",before:da,after:db,text:db.label+" edited",fields}]:[];
  }
  register("image",{matches:i=>i?.kind==="image",describe:(_p,_d,i)=>({
    label:i.clip?"Datasheet clip":"Image",text:i.caption || i.alt || i.name || "Image",fields:[],name:i.name || "",
    caption:i.caption || "",alt:i.alt || "",asset:i.asset || null,clip:i.clip || null,crop:i.crop || null,extent:i.extent || null
  }),compare:(a,da,b,db)=>imageChanges(["name","caption","alt","asset","src","clip","crop","extent"],a,da,b,db)});
  register("image-markup",{matches:i=>i?.kind==="imageMarkup",describe:(p,d,i,c)=>({
    label:"Image annotation",...(typeof i.richText==="string" ? {text:i.richText,fields:[]} : bodyText(i.richText,p,d,c)),
    imageId:i.imageId,shape:i.shape,at:i.at,to:i.to,colour:i.colour,
    width:i.width,pointCount:i.points?.length || 0
  }),compare:(a,da,b,db)=>imageChanges(["imageId","shape","at","to","width","colour","points","richText"],a,da,b,db)});
  register("math",{matches:i=>i?.kind==="textframe" && i.math===true,
    describe:(_p,_d,i)=>({label:"Equation",text:globalThis.AtriumMath?.layout(i.text,{display:true})?.plain || i.text,fields:[]}),
    compare:(a,da,b,db)=>a.text===b.text?[]:[{kind:"formula",before:{source:a.text,text:da.text},after:{source:b.text,text:db.text},text:"Equation source changed",fields:["text"]}]});
  if(globalThis.AtriumCalculationRecords?.descriptor) register("calculation",globalThis.AtriumCalculationRecords.descriptor);
  for(const p of ["AtriumSheetWidgets","AtriumCalculationRecords","AtriumMath","AtriumMarkup"]) globalThis[p]?.registerNotebook?.(api);
  return api;
})();
