"use strict";
// The notebook, calculator and export readers share the same authored value and persistent
// address. Resolving a saved address never consults its former designator or display label.
globalThis.AtriumNoteFields = (() => {
  const lower = s => String(s ?? "").trim().toLowerCase();
  const scalar = v => typeof v === "string" || typeof v === "number" && Number.isFinite(v);
  const own = (o,k) => !!o && Object.hasOwn(o,k);
  const nameOf = i => String(i.ref || i.name || i.text || i.id);
  const docsOf = p => p.documents || [];
  const fieldName = k => ({value:"Value",description:"Description",revision:"Revision",title:"Title",currentdate:"CurrentDate",name:"Name",designator:"Designator"})[lower(k)] || k;
  const prefix = b => b?.scope || (b?.itemId ? "item" : b?.signalId ? "signal" : b?.docId ? "sheet" : "project");
  const key = b => b ? JSON.stringify([prefix(b),b.docId || "",b.itemId || b.signalId || "",b.instanceId || "",b.parameterId ? "@"+b.parameterId : lower(b.field)]) : "";
  function parameters(source) {
    if (Array.isArray(source)) return source.filter(v=>typeof v?.name==="string").map(v=>[v.name,v.value,v.unit,v.id]);
    return Object.entries(source || {}).map(([k,v])=>[k,v?.value ?? v,v?.unit,v?.id]);
  }
  function property(source, field, provenance) {
    const p = parameters(source).find(v => lower(v[0]) === field);
    if (p && scalar(p[1])) return {raw:p[1],unit:p[2] || "",name:p[0],parameterId:p[3],provenance};
    return null;
  }
  function direct(obj,key,provenance,name) {
    return own(obj,key) && scalar(obj[key]) ? {raw:obj[key],name,provenance} : null;
  }

  const sheets = new WeakMap(), libraries = new WeakMap(), trees = new WeakMap();
  function add(index,item) {
    const old = index.byId.get(item.id);
    if (old) remove(index,item.id);
    const n=lower(nameOf(item)), row={item,name:n};
    index.byId.set(item.id,row);
    if (!index.byName.has(n)) index.byName.set(n,new Set());
    index.byName.get(n).add(item);
  }
  function remove(index,id) {
    const old=index.byId.get(id);
    if (!old) return;
    const set=index.byName.get(old.name);
    set.delete(old.item); if (!set.size) index.byName.delete(old.name);
    index.byId.delete(id);
  }
  function sheetIndex(project,doc) {
    const store=globalThis.AtriumUndoStore, v=store?.documentVersions?.(doc,project);
    let ix=v && sheets.get(doc);
    if (ix?.rev===v?.items && ix) return ix;
    if (ix) {
      const delta=store.recordedChanges(doc,ix.seq);
      if (delta.ids) {
        for (const id of delta.ids) remove(ix,id);
        for (const item of delta.items.values()) add(ix,item);
      } else ix=null;
    }
    if (!ix) {
      ix={byId:new Map(),byName:new Map()};
      for (const item of doc.items || []) add(ix,item);
    }
    if (v) {ix.rev=v.items;ix.seq=v.seq;sheets.set(doc,ix);}
    return ix;
  }
  function definition(project,doc,id) {
    if (!id) return null;
    const v=globalThis.AtriumUndoStore?.documentVersions?.(doc,project);
    if (!v) return project.library?.find(d=>d.id===id);
    let entry=libraries.get(project);
    if (!entry || entry.version!==v.library) {
      entry={version:v.library,defs:new Map((project.library || []).map(d=>[d.id,d]))}; libraries.set(project,entry);
    }
    return entry.defs.get(id);
  }
  function occurrences(project,doc,opts) {
    const H=/** @type {any} */ (globalThis.AtriumHierarchy);
    const prepared=opts.instances || H?.peek?.(project)?.instances;
    if (prepared) return prepared.filter(i=>i.doc.id===doc.id);
    if (!H) return [];
    const v=globalThis.AtriumUndoStore?.hierarchyVersion?.(project);
    let cached=v!=null && trees.get(project);
    if (!cached || cached.version!==v) {
      const hierarchical=docsOf(project).some(d=>d.kind==="schematic" && d.items?.some(i=>i.kind==="sheetsymbol"));
      cached={version:v,instances:hierarchical ? H.instances(project).instances : []};
      if (v!=null) trees.set(project,cached);
    }
    return cached.instances.filter(i=>i.doc.id===doc.id);
  }
  function boundParameter(tables,id) {
    for (const [source,provenance] of tables) {
      const row=parameters(source).find(p=>p[3]===id);
      if (row && scalar(row[1])) return {raw:row[1],name:row[0],unit:row[2] || "",parameterId:id,provenance};
    }
    return null;
  }
  function partType(item,def) {
    const family=lower(item.generic?.family || def?.generic?.family || def?.genericPart?.family);
    const symbol=lower(def?.prefix || String(item.ref || "").replace(/[\d?].*$/,""));
    if (["resistor","capacitor","inductor"].includes(family)) return family;
    return ({r:"resistor",c:"capacitor",l:"inductor"})[symbol] || "parameter";
  }
  function itemValue(item,def,field) {
    const placed=property(item.parameters,field,"placement"), lib=property(def?.parameters,field,"library");
    if (field==="value" && item.kind==="part") return direct(item,"value","placement","Value") || placed || direct(def,"value","library","Value") || lib;
    if (field==="description") return placed || direct(item,"description","placement","Description") || direct(def,"description","library","Description") || lib;
    if (field==="designator" || field==="ref") return direct(item,"ref","placement","Designator");
    if (field==="name") return direct(item,"name","placement","Name") || direct(item,"text","placement","Name");
    return placed || lib || property(item.schPaint?.parameters && Object.fromEntries(Object.entries(item.schPaint.parameters).map(([k,v])=>[k,v?.text])),field,"placement");
  }
  function sheetValue(project,doc,field,opts) {
    const authored=property(doc?.sheet?.params,field,"sheet") || property(doc?.parameters,field,"sheet");
    if (authored) return authored;
    if (field==="title" || field==="name") return direct(doc,"name","sheet",fieldName(field));
    if (field==="currentdate") {
      const now=opts.now ?? new Date(), date=typeof now==="string" ? now.slice(0,10) : new Date(now).toISOString().slice(0,10);
      return {raw:date,name:"CurrentDate",provenance:"date"};
    }
    return null;
  }
  function projectValue(project,field) {
    if (field==="name") return direct(project,"name","project","Name");
    if (field==="revision") {
      const current=direct(project.revision,"letter","project","Revision") || direct(project,"revision","project","Revision");
      if (current) return current;
    }
    return property(project.parameters,field,"project");
  }
  function signalValue(project,sig,field) {
    const authored=property(sig.params,field,"signal");
    if (authored) return authored;
    if (field==="voltage" && sig.intent?.confirmed && scalar(sig.intent.voltage))
      return {raw:sig.intent.voltage,unit:"V",name:"voltage",provenance:"confirmed signal"};
    if (field==="name") return direct(sig,"name","signal","Name");
    const confirmed=(project.signals?.tags || []).filter(t=>sig.tags?.includes(t.name)).map(t=>property(t.params,field,"signal tag")).filter(Boolean);
    return confirmed.length && confirmed.every(v=>v.raw===confirmed[0].raw && v.unit===confirmed[0].unit) ? confirmed[0] : null;
  }
  const units={resistor:"Ω",capacitor:"F",inductor:"H",voltage:"V"};
  function read(project,doc,binding,label,opts) {
    const b=binding, field=lower(b.field), s=prefix(b);
    const result={binding:b,sourceId:key(b),label,field,kind:"parameter",defaultUnit:"",authoredUnit:"",raw:null,text:"⟦"+label+"⟧",
      broken:true,code:"missing",tolerance:null,toleranceSource:null,provenance:null};
    for(const k of ["docId","itemId","signalId","instanceId"]) if (b[k]) result[k]=b[k];
    if (b.detached || !field) return result;
    let val, owner, normalized=field, kind="parameter",tables=[], fieldContext;
    if (s==="item" || s==="sheet") {
      const scope=docsOf(project).find(d=>d.id===b.docId);
      if (!scope) return result;
      if (b.instanceId && !occurrences(project,scope,opts).some(i=>i.id===b.instanceId)) return result;
      if (s==="sheet") {val=sheetValue(project,scope,field,opts);owner="sheet";tables=[[scope.sheet?.params,"sheet"],[scope.parameters,"sheet"]];}
      else {
        const item=sheetIndex(project,scope).byId.get(b.itemId)?.item;
        if (!item) return result;
        const def=definition(project,scope,item.def); owner=nameOf(item); val=itemValue(item,def,field);tables=[[item.parameters,"placement"],[def?.parameters,"library"]];
        if (opts.describeField) fieldContext={kind:item.kind,item,definition:def,documentId:scope.id};
        if (field==="value" && item.kind==="part") {
          kind=partType(item,def);const tol=itemValue(item,def,"tolerance");
          result.tolerance=tol?.raw ?? null;result.toleranceSource=tol?.provenance || null;
        }
      }
    } else if (s==="signal") {
      const sig=project.signals?.signals?.find(r=>r.id===b.signalId);
      if (!sig) return result;
      owner=formatSignal(sig.name);val=signalValue(project,sig,field);tables=[[sig.params,"signal"]];
      if (field==="voltage") kind="voltage";
    } else if (s==="project") {owner="project";val=projectValue(project,field);tables=[[project.parameters,"project"]];}
    if(b.parameterId) val=boundParameter(tables,b.parameterId);
    if (!val) return result;
    if(val.parameterId && !b.parameterId) {result.binding={...b,parameterId:val.parameterId};result.sourceId=key(result.binding);}
    normalized=val.name || fieldName(field);
    if (["description","title","name","ref","designator","currentdate"].includes(field)) kind="text";
    const declaration=fieldContext && opts.describeField(project,{...fieldContext,field:normalized,parameterId:b.parameterId});
    return {...result,raw:val.raw,kind,authoredUnit:val.unit || "",defaultUnit:val.unit || (kind==="voltage" ? "" : units[kind]) || "",text:String(val.raw),label:owner+"."+normalized,
      broken:false,code:null,provenance:val.provenance,...(declaration ? {declaration} : {})};
  }
  function formatSignal(name) {
    const s=String(name);
    return "net "+(/^[\p{L}\p{N}_]+$/u.test(s)?s:'"'+s.replace(/[\\"]/g,c=>"\\"+c)+'"');
  }
  function parse(expression) {
    const text=String(expression ?? "").trim().replace(/^\{([\s\S]*)\}$/,"$1").trim();
    const quoted=/^net\s+(["'])((?:\\.|(?!\1)[\s\S])*)\1\s*\.\s*([^\.]+)$/i.exec(text);
    if(quoted) {
      const delimiter=quoted[1],n=quoted[2].replace(/\\(.)/gs,(all,c)=>c===delimiter || c==="\\"?c:all);
      return {text,head:"net "+n,signal:n,sheet:"",field:lower(quoted[3])};
    }
    const i=text.lastIndexOf("."), head=i<0 ? text : text.slice(0,i);
    const q=head.lastIndexOf("::");
    return {text,head:(q<0?head:head.slice(q+2)).trim(),sheet:q<0?"":head.slice(0,q).trim(),field:lower(i<0?"Value":text.slice(i+1))};
  }
  function matches(project,doc,query,opts) {
    const h=lower(query.head), field=query.field, id=opts.instanceId;
    if (h==="project") return [{scope:"project",field}];
    if (h==="sheet") {
      const documents=query.sheet?docsOf(project).filter(d=>d.id===query.sheet||lower(d.name)===lower(query.sheet)):[doc];
      return documents.filter(Boolean).map(d=>({scope:"sheet",docId:d.id,field}));
    }
    if (h.startsWith("net ")) {
      const n=lower(query.signal ?? query.head.slice(4));
      return (project.signals?.signals || []).filter(s=>s.id===query.head.slice(4) || lower(s.name)===n || s.legs?.some(l=>l.nets?.some(v=>lower(v)===n)))
        .map(s=>({scope:"signal",signalId:s.id,field}));
    }
    const found=[];
    for (const d of docsOf(project)) {
      if (query.sheet && d.id!==query.sheet && lower(d.name)!==lower(query.sheet)) continue;
      const ix=sheetIndex(project,d), candidates=ix.byId.has(query.head) ? [ix.byId.get(query.head).item] : ix.byName.get(h) || [];
      for(const item of candidates) {
        if (item.kind!=="part" && !itemValue(item,null,field)) continue;
        const insts=d.kind==="schematic"?occurrences(project,d,opts):[], scoped=id&&insts.some(i=>i.id===id)?insts.filter(i=>i.id===id):insts;
        const base={scope:"item",docId:d.id,itemId:item.id,field};
        if (scoped.length>1 || id && scoped.some(i=>i.id===id)) for (const i of scoped) found.push({...base,instanceId:i.id});
        else found.push(base);
      }
    }
    const sch=found.filter(b=>docsOf(project).some(d=>d.id===b.docId&&d.kind==="schematic"));
    return sch.length ? sch : found;
  }
  function resolve(project,doc,expression,prior,opts={}) {
    const q=parse(expression);
    if (prior) return read(project,doc,prior,q.text,opts);
    const candidates=matches(project,doc,q,opts);
    if(candidates.length===1) return read(project,doc,candidates[0],q.text,opts);
    return {text:"⟦"+q.text+"⟧",broken:true,code:candidates.length?"ambiguous":"missing",binding:null,sourceId:"",label:q.text,
      raw:null,kind:"parameter",authoredUnit:"",defaultUnit:"",tolerance:null,toleranceSource:null,provenance:null,field:q.field,
      candidates:candidates.map(b=>({...read(project,doc,b,q.text,opts),sheet:docsOf(project).find(d=>d.id===b.docId)?.name || ""}))};
  }
  function complete(project,doc,prefixText="",limit=24,opts={}) {
    const p=lower(String(prefixText).replace(/^\{/,"")), rows=[],seen=new Set();
    function row(expression,binding) {
      if (rows.length>=limit || !lower(expression).includes(p) || seen.has(key(binding))) return;
      const r=read(project,doc,binding,expression,opts);
      if (!r.broken) {rows.push({expression,label:expression,detail:r.text,binding:r.binding});seen.add(key(binding));}
    }
    function list(owner,fields,base) {
      for (const f of fields) row(owner+"."+f,{...base,field:lower(f)});
    }
    list("sheet",["Title","CurrentDate",...parameters(doc?.sheet?.params).map(v=>v[0]),...parameters(doc?.parameters).map(v=>v[0])],{scope:"sheet",docId:doc?.id});
    list("project",["Name","Revision",...parameters(project.parameters).map(v=>v[0])],{scope:"project"});
    for(const s of project.signals?.signals || []) list(formatSignal(s.name),["voltage",...parameters(s.params).map(v=>v[0])],{scope:"signal",signalId:s.id});
    for(const d of [doc,...docsOf(project).filter(v=>v!==doc)]) {
      if (!d || d.kind!=="schematic") continue;
      for(const item of d.items || []) {
        if (rows.length>=limit) return rows;
        if (item.kind!=="part" && !item.parameters) continue;
        const name=nameOf(item),def=definition(project,d,item.def),base={scope:"item",docId:d.id,itemId:item.id};
        const fields=[...(item.kind==="part"?["Value","Description","Designator"]:[]),...parameters(item.parameters).map(v=>v[0]),...parameters(def?.parameters).map(v=>v[0])];
        if (!fields.some(f=>lower(name+"."+f).includes(p))) continue;
        const insts=occurrences(project,d,opts), choices=opts.instanceId && insts.some(i=>i.id===opts.instanceId)?insts.filter(i=>i.id===opts.instanceId):insts;
        if(choices.length>1 || opts.instanceId && choices.length) for (const i of choices) list(name,fields,{...base,instanceId:i.id});
        else list(name,fields,base);
      }
    }
    return rows;
  }
  function follow(host,result) {
    if (!host || result?.broken) return false;
    if (result.signalId) {host.act?.("signals-panel");const sig=host.project()?.signals?.signals?.find(s=>s.id===result.signalId);
      if (sig) host.setHighlight?.(sig.legs?.[0]?.nets?.[0] || sig.name);return !!sig;}
    const doc=host.project()?.documents?.find(d=>d.id===result.docId);
    if (!doc) return false;
    const move=()=>{
      if(host.currentId?.()!==doc.id) host.selectDocument?.(doc.id);
      if(result.instanceId) globalThis.AtriumConnectionPreview?.activateInstance?.(doc.id,result.instanceId);
      if(result.itemId) {host.select?.([result.itemId]); const item=doc.items.find(i=>i.id===result.itemId),nav=globalThis.AtriumNavCommon;
        const box=nav?.itemBox(doc,host.defs?.(),item),view=host.view?.(),canvas=host.canvas?.();
        if(box && view && canvas) view.restoreCamera(nav.cameraFor(box,canvas.clientWidth,canvas.clientHeight,view.camera(),{maxFactor:4}));
        host.redraw?.();}
    };
    const camera=/** @type {any} */ (globalThis.AtriumCamera);
    if(camera?.jump) camera.jump(doc.id,move);else move();
    return true;
  }
  function remap(binding,maps={},crossProject=false) {
    if (!binding) return null;
    const b={...binding};
    function change(k,m) {if (!b[k]) return false;let v=m instanceof Map ? m.get(b[k]) : m?.[b[k]];if (v==null) return false;b[k]=v;return true;}
    const d=change("docId",maps.docIds), i=change("itemId",maps.itemIds), s=change("signalId",maps.signalIds);
    change("instanceId",maps.instanceIds);change("parameterId",maps.parameterIds);
    if(crossProject && !(prefix(b)==="item"?i:prefix(b)==="sheet"?d:prefix(b)==="signal"?s:false)) b.detached=true;
    return b;
  }
  // Resolve the occurrence against its old document before moving either field.
  function rebaseTarget(target,from,to,moved,instances,{fallback=false,richText=false,docKey="docId",itemKey="itemId"}={}) {
    if (!target || (target.detached && !richText)) return null;
    const docId=target[docKey],itemId=target[itemKey],id=target.instanceId;
    const local=docId===from && (!richText || itemId) && moved.has(itemId);
    let next;
    if (id) {
      if (fallback) next=instances?.forTarget?.(id,docId,itemId) ?? instances?.get?.(id);
      else next=instances.forTarget?instances.forTarget(id,docId,itemId):instances.get(id);
    }
    const shifted=(fallback?!!next:next!==undefined) && next!==id;
    if (!local && !shifted) return null;
    return {...(local?{[docKey]:to}:{}),...(shifted?{instanceId:next}:{})};
  }
  function altium(text) {
    if (typeof text!=="string") return null;
    const m=/^\s*=(Title|CurrentDate|Revision|ProjectName)\s*$/i.exec(text);
    return m ? ({title:"sheet.Title",currentdate:"sheet.CurrentDate",revision:"project.Revision",projectname:"project.Name"})[lower(m[1])] : null;
  }
  return Object.freeze({resolve,complete,follow,remap,rebaseTarget,key,altium,formatSignal,partType});
})();
