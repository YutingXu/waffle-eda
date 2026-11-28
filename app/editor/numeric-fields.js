"use strict";
// Numeric control values use the notebook evaluator. Authored live expressions are keyed by
// object identity and field path. The materialised number stays in the field's native units.
globalThis.AtriumNumericFields = (() => {
  const G = globalThis, own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  const unsafe = new Set(["__proto__", "prototype", "constructor"]);
  const hosts = new WeakMap(), diagnostics = new WeakMap(), observers=new WeakMap(), evaluatedEntries=new WeakSet();
  const editing=new WeakMap();
  let committing, eventId = 0;
  const presentationEnabled = () => G.AtriumLabs?.butterEnabled?.("numericFields") ??
    G.AtriumPrefs?.get?.("butter.numericFields") === true;
  const error = (message, span, code = "field") => ({ok:false, diagnostic:{code, message, span}});
  const key = t => JSON.stringify([t?.scope || "item", t?.documentId || "", t?.itemId || t?.ruleId || "", t?.path || []]);
  const targetResolvers = new Map();
  const changedColumnUnit="The table column unit changed. Reopen this field to use its new unit.";
  function tableTarget(t) {
    const path=t?.path;
    return t?.scope==="item" && Array.isArray(path) && path.length===4 && path[0]==="cells" && path[3]==="value" &&
      [path[1],path[2]].every(id=>typeof id==="string" && id.length>0 && id.length<=128);
  }
  function registerTargetResolver(name, resolver) {
    if(typeof name!=="string" || !name || typeof resolver?.matches!=="function" || typeof resolver.resolve!=="function")
      throw TypeError("A named field resolver must provide matches and resolve.");
    targetResolvers.set(name,resolver);
    return ()=>{ if(targetResolvers.get(name)===resolver)targetResolvers.delete(name); };
  }
  // The table owner registers on the first addressed cell. Opening an unrelated
  // field or indexing a saved binding never requests the table model.
  function targetResolver(t) {
    if(tableTarget(t) && !targetResolvers.has("table-cell")) G.AtriumTableData?.registerNumericFields?.(G.AtriumNumericFields);
    for(const resolver of targetResolvers.values())if(resolver.matches(t))return resolver;
  }
  function prepareTarget(t) {
    if(tableTarget(t) && !targetResolvers.has("table-cell") && !G.AtriumTableData)
      return G.AtriumLazy?.need?.("AtriumTableData").catch(()=>{});
  }
  function validTarget(t) {
    const id = value => typeof value === "string" && value.length > 0 && value.length <= 128;
    return t && ["item","document","rule"].includes(t.scope) && id(t.documentId) &&
      (t.scope === "document" || id(t.scope === "item" ? t.itemId : t.ruleId)) && Array.isArray(t.path) &&
      (tableTarget(t) || t.path.length > 0 && t.path.length <= 12 && t.path.every(k => typeof k === "string"
        ? k.length > 0 && k.length <= 120 && !unsafe.has(k) : id(k?.id)));
  }
  function locate(project, t) {
    if (!validTarget(t)) return null;
    const documents=project?.documents;
    if(!documents)return null;
    const resolver=targetResolver(t);
    if(resolver)return resolver.resolve(project,t);
    if(tableTarget(t))return null;
    const doc = documents.find(d => d.id === t.documentId);
    if (!doc) return null;
    let object = t.scope === "item" ? doc.items?.find(i => i.id === t.itemId) :
      t.scope === "rule" ? project.rules?.list?.find(r => r.id === t.ruleId) : doc;
    const owner = object;
    for (const segment of t.path.slice(0,-1)) {
      if (!object) return null;
      object = typeof segment === "string" ? own(object,segment) && object[segment] : (Array.isArray(object) ? object : Object.values(object)).find(v => v?.id === segment.id);
    }
    const field = t.path.at(-1);
    return object && owner && typeof field === "string" ? {doc, owner, object, field} : null;
  }
  const readValue = at => at?.read ? at.read() : at?.object[at.field];
  function hasValue(current,value,spec) {
    const blank=current==null || typeof current==="string" && !current.trim();
    if (value==null) return blank;
    if (blank) return spec?.omitZero===true && value===0;
    return Number(current)===value;
  }
  function stored(project, target) {
    const list=project?.numericExpressions;
    if (!target || !Array.isArray(list)) return;
    const id=key(target);
    return list.find(r=>r?.version===1 && key(r.target)===id);
  }
  function remember(project, target, entry) {
    if (!validTarget(target) || !entry && !stored(project,target)) return;
    if (project.numericExpressions != null && !Array.isArray(project.numericExpressions))
      throw Error("The saved numeric bindings are not readable.");
    const list = (project.numericExpressions || []).filter(r => key(r?.target) !== key(target));
    if (entry) list.push(entry);
    if (list.length) project.numericExpressions = list; else delete project.numericExpressions;
  }
  function writeAllowed(project, owner, doc, host) {
    return !project.readOnly && !project.atriumCompat?.readOnly && !G.AtriumRevisions?.locked?.(project) &&
      !["released","obsolete"].includes(project.revision?.status) && !doc.readOnly && !doc.locked && !owner.readOnly && !owner.locked &&
      host?.folderProject?.()?.canEdit?.(doc.id) !== false && host?.canEdit?.(doc.id) !== false &&
      !G.AtriumCollabLock?.manager?.()?.blocked?.(doc.id) && !G.AtriumCollabLive?.objectsBlocked?.([owner.id]);
  }
  function localInputs(project, options, prior) {
    const clean = Object.create(null), local = typeof options.locals === "function" ? options.locals() : options.locals;
    for (const [name, field] of Object.entries(local || {})) clean[name] = field;
    for (const b of prior?.bindings || []) {
      if (b.target?.scope !== "numeric-field") continue;
      const t = b.target.address, at = locate(project,t);
      clean[b.name] = {id:b.id, target:b.target, value:readValue(at), unit:b.target.unit};
    }
    return clean;
  }
  function geometryLocals(item, documentId) {
    if (!item) return {};
    const locals = {};
    for (const [alias, field] of [["w","width"],["h","height"],["x","x"],["y","y"]]) {
      const actual=Number.isFinite(item[field])?field:alias;
      if (!Number.isFinite(item[actual])) continue;
      const address = {scope:"item", documentId, itemId:item.id, path:[actual]};
      locals[alias] = {value:item[actual], unit:"mm", target:{scope:"numeric-field", address, unit:"mm"}};
    }
    return locals;
  }
  const lower=value=>String(value ?? "").toLowerCase();
  const padFields=new Set(["w","h","drill"]);
  function namedField(at,target) {
    if(target.path[0]==="parameters")return at.field==="value" ? at.object.name ?? target.path.at(-2) : at.field;
    return at.field;
  }
  function readsField(project,watch,target) {
    if(!watch || target.scope!=="item")return false;
    if(watch.scope==="item") {
      if(watch.docId!==target.documentId || watch.itemId!==target.itemId)return false;
    } else if(watch.scope!=="query" || !Array.isArray(watch.fields) || watch.docId!=null && watch.docId!==target.documentId)return false;
    const at=locate(project,target);
    if(!at)return false;
    const field=lower(namedField(at,target)), fields=new Set([field]);
    if(field==="value")fields.add("comment");
    if(field==="angle")fields.add("rotation");
    if(field==="w")fields.add("width");
    if(field==="h")fields.add("height");
    if(at.owner.kind==="pad" && padFields.has(field))for(const k of ["holediameter","throughhole","smd","layer","multilayer","signallayer","innerlayer","outerlayer"])fields.add(k);
    if(watch.scope==="item")return fields.has(lower(watch.field));
    const {owner}=at;
    const geometry=watch.fields.some(k=>k.startsWith("geometry:") || k.startsWith("measurement:"));
    if(geometry && ["x","y","width","height","rotation","diameter","holediameter"].some(k=>fields.has(k)))return true;
    const def=owner.kind==="part" ? project.library?.find(d=>d.id===owner.def) : null;
    const kind=owner.kind==="part" ? G.AtriumNoteFields?.partType(owner,def) : owner.kind==="label" ? "text" : owner.kind;
    if(watch.kind!=="object" && watch.kind!==owner.kind && watch.kind!==kind)return false;
    if(watch.designators?.length && owner.ref && watch.designators.some(v=>lower(v)!==lower(owner.ref)))return false;
    return watch.fields.some(k=>k.startsWith("field:") && fields.has(lower(k.slice(6))) || k==="relation:layer" && fields.has("layer"));
  }
  function bindingKey(t) {
    if (t?.scope === "numeric-field") return key(t.address);
    if (t?.scope === "item") return key({scope:"item", documentId:t.docId, itemId:t.itemId, path:[t.field]});
    return null;
  }
  const dependenciesOf=entry=>Array.isArray(entry.watches) ? entry.watches : entry.bindings.map(binding=>binding.target);
  function cycle(project, entry, host) {
    const target = key(entry.target), state=hosts.get(host);
    const byId=state && state.project===project && state.list===project?.numericExpressions ? state.records :
      new Map((project?.numericExpressions || []).map(e => [key(e.target),e]));
    const seen = new Set(), todo = [...dependenciesOf(entry)];
    while (todo.length) {
      const watch=todo.pop(), next=bindingKey(watch);
      if (next === target || readsField(project,watch,entry.target)) return true;
      const dependencies=watch?.scope==="query" || watch?.scope==="item" && byId.has(next)===false
        ? [...byId].filter(([,record])=>readsField(project,watch,record.target)).map(([id])=>id) : [next];
      for(const id of dependencies) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const b = byId.get(id);
        if (b) todo.push(...dependenciesOf(b));
      }
    }
    return false;
  }
  function convert(result, spec, span) {
    if (!result.ok) return result;
    if (result.kind !== "quantity") return error("This field requires a numeric result.",span);
    const core = G.AtriumCalculationCore, unit = spec.unit || "", storage = spec.storageUnit ?? unit;
    let value,display;
    try {value=core.as(result,storage);display=core.format(result,unit || undefined);}
    catch (_) { return error("This field requires " + (unit || "a dimensionless number") + ". The expression gives " + (result.unit || "a different dimension") + ".",span,"dimension"); }
    if (spec.nanometres) value = Math.round(value * 1e6) / 1e6;
    if (!Number.isFinite(value)) return error("The number is outside the field range.",span,"range");
    if (spec.integer && !Number.isInteger(value)) return error("Enter a whole number.",span,"range");
    if (value < (spec.min ?? -Infinity) || value > (spec.max ?? Infinity))
      return error("The value is outside this field’s allowed range.",span,"range");
    if (spec.period) {
      value %= spec.period;
      if (spec.positiveWrap && value < 0) value += spec.period;
      value ||= 0;
      display = core.format(core.quantity(value,storage),unit || undefined);
    }
    return {ok:true, value, display, warnings:result.warnings || []};
  }
  async function evaluate(text, spec = {}, options = {}) {
    const original = String(text), live = /^\s*=/.test(original), start = live ? original.indexOf("=") + 1 : 0;
    const source = original.slice(start), span = [start, original.length];
    if (spec.allowText && !live && (/^\p{L}[\p{L}\p{M}\p{N} _-]*$/u.test(source.trim()) || /^\d+[RrKkMm]\d+$/.test(source.trim())))
      return {ok:true,value:source.trim(),display:source.trim(),literal:true,entry:null};
    if (!source.trim()) return spec.optional && !live ? {ok:true,value:null,display:"",entry:null} : error("Enter a number or expression.",span);
    const editor = G.AtriumNavHost, project = options.project ?? options.host?.project?.() ?? editor?.project?.();
    const host = options.host ?? (project === editor?.project?.() ? editor : null);
    const api = G.AtriumCalculations || await G.AtriumLazy.need("AtriumCalculations");
    if(spec.declaration) {
      const field=G.AtriumQueryFields.describe(project,spec.declaration);
      if(field.diagnostic)return {ok:false,diagnostic:{...field.diagnostic,span}};
      if(field.type==="quantity")spec={...spec,unit:spec.unit ?? field.unit,storageUnit:spec.storageUnit ?? field.unit};
    }
    const prior = options.prior || stored(project,spec.target);
    const boundCell=prior?.bindings?.find(b=>tableTarget(b.target?.address));
    const pending=prepareTarget(spec.target) || prepareTarget(boundCell?.target.address);
    if(pending)await pending;
    const columnUnit=tableTarget(spec.target) ? locate(project,spec.target)?.unit : undefined;
    if(typeof columnUnit==="string") {
      if(spec.tableUnit!==undefined && spec.tableUnit!==columnUnit)
        return error(changedColumnUnit,span,"table-unit");
      if(columnUnit) {
        const display=spec.unit || columnUnit,core=G.AtriumCalculationCore;
        try {core.as(core.quantity(1,display),columnUnit);}
        catch {return error("This table column requires "+columnUnit+".",span,"dimension");}
        spec={...spec,unit:display,storageUnit:columnUnit};
      }
    }
    const locals = localInputs(project,spec,prior);
    const authority=options.authority ?? spec.authority?.() ?? (spec.readDesign ? {get readProject(){return spec.readDesign()===true;}} : undefined);
    if(spec.allowText && !live && /±|^\s*[+-]?\d*[RrKkMmGnpµμu]\d/u.test(source)) {
      const marking=G.AtriumCalculationCore.parseBoundValue(source,{unit:spec.unit,fieldUnit:spec.unit});
      if(marking.ok)return {ok:true,value:source.trim(),display:source.trim(),literal:true,entry:null};
    }
    const out = await api.fieldExpression(project, {host, revision:options.revision ?? host?.revision?.(), signal:options.signal,
      documentId:options.documentId || spec.target?.documentId || host?.currentId?.(), instanceId:options.instanceId,
      source,fieldUnit:spec.unit ?? "",allowDesign:spec.readDesign?.()!==false,authority,countQuery:options.countQuery,previousSource:prior?.source, bindings:prior?.bindings, pinnedFunctions:prior?.functions, locals});
    if(spec.readDesign?.()===false && (out.bindings?.length || out.watches?.length))return error("This form cannot read design fields.",span,"permission");
    let raw = out.result;
    // Older editor length fields also accept Altium's thou, th, mils and inch quote.
    if (!raw.ok && spec.nanometres && /^[-+.\deE]+\s*(thou|th|mils|inch(?:es)?|")$/i.test(source.trim())) {
      const mm = G.Atrium?.units?.parse(source,spec.unit);
      if (Number.isFinite(mm)) raw = {...G.AtriumCalculationCore.quantity(mm,"mm"),ok:true};
    }
    if (!raw.ok) {
      const issue = raw.diagnostic, pos = issue.span || [0,source.length];
      return {ok:false,diagnostic:{...issue,span:[pos[0]+start,pos[1]+start]}};
    }
    const result = convert(raw,spec,span);
    if (!result.ok) return result;
    const destination=spec.target?.path?.length===1 && spec.target.path[0]==="drill" && locate(project,spec.target);
    if(destination?.owner?.kind==="pad") {
      result.value=G.Atrium.padDimensions(destination.owner,"drill",result.value).drill ?? 0;
      result.display=G.AtriumCalculationCore.format(G.AtriumCalculationCore.quantity(result.value,"mm"),spec.unit);
    }
    // A literal part marking is authored text on schematics, BOMs and native exports.
    if(spec.textValue && !live && out.quantityLiteral)result.marking=source.trim();
    let entry = null;
    if (live) {
      entry = {version:1, target:spec.target, source, bindings:out.bindings || [], unit:spec.unit || "", storageUnit:spec.storageUnit ?? spec.unit ?? ""};
      for (const k of ["nanometres","integer","min","max","textValue","period","positiveWrap","omitZero"]) if (spec[k] != null && spec[k] !== false && (typeof spec[k] !== "number" || Number.isFinite(spec[k]))) entry[k]=spec[k];
      if (typeof columnUnit==="string")entry.tableUnit=columnUnit;
      if (out.functions) entry.functions=out.functions;
      entry.watches=out.watches || entry.bindings.map(b=>b.target);
      if (spec.target && cycle(project,entry,host)) return error("This live field would depend on itself.",span,"cycle");
      evaluatedEntries.add(entry);
    }
    if(typeof columnUnit==="string") {result.tableUnit=columnUnit;result.storageUnit=spec.storageUnit ?? spec.unit ?? "";}
    return {...result, entry, watches:out.watches || [], live};
  }

  function observe(project,target,input) {
    if(!project || !target || typeof WeakRef!=="function")return;
    let byId=observers.get(project);if(!byId)observers.set(project,byId=new Map());
    const id=key(target),items=(byId.get(id) || []).filter(r=>r.deref()?.isConnected);
    items.push(new WeakRef(input));byId.set(id,items);
  }
  function notify(project,id) {
    const byId=observers.get(project),items=byId?.get(id);
    if(!items)return;
    const remaining=[];
    for(const ref of items) {
      const input=ref.deref();if(!input?.isConnected)continue;
      controls.get(input)?.syncChip();remaining.push(ref);
    }
    if(remaining.length)byId.set(id,remaining);else byId.delete(id);
  }
  const design=()=>G.AtriumCalculationDesign;
  const objectWatch = (doc,id) => design().watchKey("item",doc,id);
  const docWatch = id => design().watchKey("doc",id);
  const queryWatch = id => design().watchKey("query",id);
  function watchKeys(t) {return t ? design().fieldWatches(t) : [];}
  function entryWatches(entry,watches) {
    const targets=watches || dependenciesOf(entry);
    return entry.target.path.length===1 && entry.target.path[0]==="drill" ? [...targets,{scope:"numeric-field",address:entry.target}] : targets;
  }
  function journalWatches(rows) {
    const keys=new Set();
    for(const r of rows) {
      const doc=r.node?.doc?.ref?.id,path=(r.node?.path || "").split(".").filter(Boolean);
      if(doc) {
        keys.add(queryWatch(doc));keys.add(queryWatch(null));
        if(r.node.path==="items" && r.t!=="k") {
          const items=r.ref ? [r.ref] : [...(r.inserted || []),...(r.removed || [])].map(e=>e[1]);
          for(const item of items)if(item?.id)keys.add(objectWatch(doc,item.id));
          if(!items.length)keys.add(docWatch(doc));
        } else {keys.add(docWatch(doc));keys.add(design().watchKey("sheet",doc));}
      } else {
        if(path[0]==="documents") {
          const docs=r.ref ? [r.ref] : [...(r.inserted || []),...(r.removed || [])].map(e=>e[1]);
          for(const document of docs)if(document?.id){keys.add(docWatch(document.id));keys.add(queryWatch(document.id));}
          keys.add(queryWatch(null));
        }
        for(const key of design().environmentWatches(r.key ? [...path,r.key] : path))keys.add(key);
      }
    }
    return keys;
  }
  function operationWatches(ops) {
    const keys=new Set();
    for(const op of ops) {
      const doc=op.document || (op.target==="document" ? op.id || op.value?.id : null);
      if(doc) {
        keys.add(queryWatch(doc));keys.add(queryWatch(null));
        if(op.target==="item")keys.add(objectWatch(doc,op.id || op.value?.id));
        else {keys.add(docWatch(doc));keys.add(design().watchKey("sheet",doc));}
      } else for(const key of design().environmentWatches(op.target==="library" ? ["library"] : op.path || []))keys.add(key);
    }
    return keys;
  }
  function ruleValues(book, rows) {
    for(const {entry,at,value} of rows){
      const dest=locate({documents:[at.doc],rules:book},entry.target);
      if(dest)dest.object[dest.field]=value;
    }
  }
  // A live update has the same cross-field limits as a direct edit. Check coupled
  // values together before notifying the editor or touching an imported rule record.
  function validateChanges(project, changes, host, reject) {
    const rules=new Map(), vias=new Map(), accepted=[];
    for(const row of changes){
      const {entry,at}=row;
      const group=entry.target.scope==="rule" ? rules : at.owner.kind==="via" && at.object===at.owner && ["diameter","drill"].includes(at.field) ? vias : null;
      if(!group){accepted.push(row);continue;}
      let values=group.get(at.owner);if(!values)group.set(at.owner,values=[]);values.push(row);
    }
    for(const [via,rows] of vias){
      const next={...via};
      for(const {at,value} of rows)next[at.field]=value;
      const stack=G.AtriumViaStack;
      const diameter=next.stackMode==="full" || next.stackMode==="tmb" ? stack?.minDiameter(next,stack.keysOf(rows[0].at.doc,next,host?.defs?.())) : next.diameter;
      if(!Number.isFinite(diameter) || next.drill>=diameter)reject(rows,"Drill size must be smaller than the via land diameter.");
      else accepted.push(...rows);
    }
    for(const [rule,rows] of rules){
      try{
        const api=G.AtriumProjectRules, book=api.book(project);
        const candidate={...book,list:book.list.map(r=>r.id===rule.id ? JSON.parse(JSON.stringify(r)) : r)};
        ruleValues(candidate,rows);api.validate(candidate);accepted.push(...rows);
      }catch(e){reject(rows,e.message);}
    }
    return accepted;
  }
  function planGeometryMove(project, at, value) {
    const {owner,object,doc,field}=at, A=G.Atrium;
    if (owner!==object || !A) return null;
    if(owner.kind==="pad" && padFields.has(field))
      return [{original:owner,next:A.padDimensions(owner,field,value),fields:[...new Set([field,"drill","layer"])]}];
    if (!["x","y","angle"].includes(field)) return null;
    if (owner.kind==="part") {
      if (doc.kind!=="schematic") return [{original:owner,next:{...owner,[field]:value},fields:[field]}];
      const defs=new Map(project.library?.map(d=>[d.id,d])), definition=defs.get(owner.def);
      const terminals=new Set(A.pins(owner,definition,doc.kind).map(pin=>A.pointKey(pin.at)));
      const originals=new Map(), junctionCopies=new Map(), wires=[];
      for (const i of doc.items) {
        if(i.kind==="wire"){
          const points=i.points;
          if(!points.length || !(terminals.has(A.pointKey(points[0])) || terminals.has(A.pointKey(points.at(-1))) ||
            points.some((p,n)=>n>0&&A.same(p,points[n-1]))))continue;
          wires.push({...i}); originals.set(i.id,i);
        } else if(i.kind==="junction" && terminals.has(A.pointKey([i.x,i.y]))){
          junctionCopies.set(i.id,{...i}); originals.set(i.id,i);
        }
      }
      // A turn carries a power port or label sitting alone on a pin (Atrium.pinTags).
      if(field==="angle")for(const tag of A.pinTags(doc,defs,owner)){wires.push({...tag});originals.set(tag.id,tag);}
      const [part,...changed]=A.transformPart(doc,{...owner},definition,{[field]:value},wires,{defs,junctionCopies});
      return [{original:owner,next:part,fields:[field]},...changed.flatMap(next=>{
        const original=originals.get(next.id);
        if(next.kind==="wire")return [{original,next,fields:["points"]}];
        return next.x!==original.x || next.y!==original.y ? [{original,next,fields:["x","y"]}] : [];
      })];
    }
    if (!G.AtriumSchObjects?.isFrame(owner) || field==="angle") return null;
    const tool=G.AtriumEditSelection;
    if (!tool) throw Error("The frame movement engine is unavailable.");
    const originals=new Map(doc.items.map(i=>[i.id,i]));
    const source={...doc, items:doc.items.map(i=>({...i}))};
    const item=source.items.find(i=>i.id===owner.id), defs=new Map(project.library.map(d=>[d.id,d]));
    // Expression plans update fields on an existing set of objects.
    const move=tool.translation(source,defs,[item],{existingOnly:true});
    const delta=value-owner[field];
    move.apply(field==="x"?delta:0,field==="y"?delta:0);
    return move.affected.map(next=>({original:originals.get(next.id),next,
      fields:next.points ? next.arc ? ["points","arc"] : ["points"] : ["x","y"]}));
  }
  function applyNumber(project, entry, at, value, host) {
    if(at.write)return at.write(value) ? [at.owner] : null;
    const {object,field,doc,owner} = at;
    const move=planGeometryMove(project,at,value);
    if (move) {
      if (move.some(({original})=>!writeAllowed(project,original,doc,host))) return null;
      for (const {original,next,fields} of move) for (const key of fields) {if(own(next,key))original[key]=next[key];else delete original[key];}
      return move.map(r=>r.original);
    }
    if (entry.omitZero && value===0) delete object[field];
    else object[field]=entry.textValue ? String(value) : value;
    return [owner];
  }
  function attachHost(host,{headless=false}={}) {
    if (!host || hosts.has(host)) return hosts.get(host);
    const state = {project:null,list:null,records:new Map(),index:new Map(),slots:new Map(),pending:new Set(),batch:null,
      changed:new Set(),transient:new Map(),inspected:new Set(),queryValues:new Map(),idle:[],queued:false,derived:false,evaluations:0};
    hosts.set(host,state);
    function index(id,targets) {
      for (const k of state.slots.get(id) || []) {
        const set=state.index.get(k); set?.delete(id); if (!set?.size) state.index.delete(k);
      }
      const keys=new Set(targets.flatMap(watchKeys)); state.slots.set(id,keys);
      for (const k of keys) { if (!state.index.has(k)) state.index.set(k,new Set()); state.index.get(k).add(id); }
    }
    state.watchControl=(control,targets)=>{
      if(typeof WeakRef!=="function")return;
      const id=control.transientId ||= Symbol();
      index(id,targets);
      if(targets.length)state.transient.set(id,new WeakRef(control));
      else {state.transient.delete(id);state.slots.delete(id);state.pending.delete(id);}
    };
    function dirty(k) {for(const id of state.index.get(k) || [])state.pending.add(id);}
    function sync(replayed=false) {
      const project=host.project(), list=project?.numericExpressions;
      if (project !== state.project) {
        state.batch?.abort(); state.pending.clear(); state.index.clear(); state.slots.clear(); state.records.clear();state.transient.clear();state.inspected.clear();
        state.project=project; state.list=null;
      }
      if (list === state.list && !replayed) return;
      const next=new Map((Array.isArray(list) ? list : []).filter(r=>r?.version===1 && validTarget(r.target) && typeof r.source==="string" && Array.isArray(r.bindings)).map(r=>[key(r.target),r]));
      for (const id of state.records.keys()) if (!next.has(id)) { index(id,[]); state.slots.delete(id); state.pending.delete(id); state.inspected.delete(id); }
      for (const [id,r] of next) if (replayed || state.records.get(id)!==r) {
        const recorded=Array.isArray(r.watches);
        index(id,entryWatches(r));
        if(evaluatedEntries.has(r))state.inspected.add(id);else state.inspected.delete(id);
        // Old files lack the transitive index. Rebuild only those entries.
        if(!recorded)state.pending.add(id);
      }
      state.records=next; state.list=list;
    }
    function schedule() {
      if (!headless && !state.queued && state.pending.size) { state.queued=true; queueMicrotask(flush); }
    }
    state.inspect=target=>{
      const id=key(target);
      if(state.records.has(id) && !state.inspected.has(id)){
        state.inspected.add(id);state.pending.add(id);schedule();
      }
    };
    async function flush() {
      state.queued=false;
      if (state.batch) return;
      if(!state.pending.size){for(const done of state.idle.splice(0))done();return;}
      const controller=state.batch=headless ? {signal:host.signal,abort(){}} : new AbortController(), project=state.project, revision=host.revision?.();
      const ids=[];
      for(const id of state.pending){ids.push(id);state.pending.delete(id);if(ids.length===8)break;}
      try {
        const results=await Promise.all(ids.map(async id=>{
          if(state.transient.has(id)) {
            const control=state.transient.get(id).deref();
            if(!control?.input.isConnected) {index(id,[]);state.slots.delete(id);state.transient.delete(id);return null;}
            await control.refreshSession(controller.signal);return null;
          }
          const entry=state.records.get(id);
          if(!entry || state.queryValues.get(id)?.failed)return null;
          const pending=prepareTarget(entry.target);if(pending)await pending;
          if(controller.signal?.aborted)return null;
          const at=locate(project,entry.target);
          if(!at && tableTarget(entry.target))return {id,entry,result:error("This table cell is unavailable for a numeric edit.",[0,entry.source.length],"target")};
          if (!at || !writeAllowed(project,at.owner,at.doc,host)) return null;
          if(at.owner.kind==="via" && ["full","tmb"].includes(at.owner.stackMode) && !G.AtriumViaStack)await G.AtriumLazy?.need("AtriumViaStack");
          // project-rules.js is a file of the AtriumRules module.
          if(entry.target.scope==="rule" && !G.AtriumProjectRules)await G.AtriumLazy?.need("AtriumRules");
          state.evaluations++;
          const result=await evaluate("="+entry.source,entry,{project,host,revision,prior:entry,signal:controller.signal});
          return {id,entry,result};
        }));
        if (controller.signal?.aborted || host.project()!==project || host.revision?.()!==revision) return;
        const proposed=[], indexes=new Map();
        let issues=diagnostics.get(project); if (!issues) diagnostics.set(project,issues=new Map());
        for (const row of results.filter(Boolean)) {
          const {id,entry,result}=row;
          if (state.records.get(id)!==entry) continue;
          state.inspected.add(id);
          if (!result.ok) {issues.set(id,result.diagnostic);notify(project,id);continue;}
          if(issues.delete(id))notify(project,id);
          index(id,entryWatches(entry,result.watches));
          if(!Array.isArray(entry.watches) || JSON.stringify(entry.watches)!==JSON.stringify(result.watches)){
            const updated={...entry,watches:result.watches};evaluatedEntries.add(updated);indexes.set(entry,updated);
          }
          const at=locate(project,entry.target), current=readValue(at);
          if(!at || !writeAllowed(project,at.owner,at.doc,host) || hasValue(current,result.value,entry))continue;
          let value=result.value;
          if(result.watches.some(target=>target.scope==="query")) {
            let history=state.queryValues.get(id);
            if(!history)state.queryValues.set(id,history={initial:current,seen:new Set(),failed:false});
            // Quantity-producing functions and geometry queries can add implicit
            // dependencies. Bound the number of updates between authored edits.
            if(history.seen.has(value) || history.seen.size>=16) {
              history.failed=true;
              issues.set(id,{code:"cycle",message:"This live query did not reach a stable value.",span:[1,entry.source.length+1]});notify(project,id);
              value=history.initial ?? (entry.omitZero ? 0 : null);
            }
            history.seen.add(value);
          }
          proposed.push({id,entry,at,value});
        }
        const changes=validateChanges(project,proposed,host,(rows,message)=>{
          for(const {id,entry} of rows){
            // A sibling change can make this result legal even when its source did not move.
            index(id,[...dependenciesOf(indexes.get(entry) || entry),{scope:"numeric-field",address:entry.target}]);
            issues.set(id,{code:"range",message,span:[1,entry.source.length+1]});notify(project,id);
          }
        });
        if (changes.length || indexes.size) {
          const rules=changes.filter(r=>r.entry.target.scope==="rule"),applied=[...rules];
          const touched=changes.map(({at})=>({doc:at.doc,items:[at.owner]}));
          state.derived=true;
          try { host.derive(()=>{
            if(rules.length)G.AtriumProjectRules.edit(project, book=>ruleValues(book,rules));
            for (const [position,row] of changes.entries()) {
              const {id,entry,at,value}=row;
              if(entry.target.scope==="rule")continue;
              let message="The addressed field could not accept the number.";
              try {
                const items=applyNumber(project,entry,at,value,host);
                if(items) {touched[position].items=items;applied.push({...row,items});continue;}
              } catch(e) {
                if(!at.write)throw e;
                message=e.message;
              }
              issues.set(id,{code:"target",message,span:[0,entry.source.length]});notify(project,id);
            }
            if(indexes.size)project.numericExpressions=project.numericExpressions.map(e=>indexes.get(e) || e);
          },
            {source:"numeric-field",touched}); }
          finally { state.derived=false; }
          if(indexes.size)sync();
          for (const {id,entry,at,items} of applied) {
            if (entry.target.scope==="item") for (const item of items || [at.owner]) dirty(objectWatch(at.doc.id,item.id));
            else dirty(docWatch(at.doc.id));
            dirty(queryWatch(at.doc.id));dirty(queryWatch(null));
            if(at.write)notify(project,id);
          }
        }
      } catch (e) {
        if (e.name!=="AbortError") {
          if(headless)throw e;
          G.console?.warn?.("Numeric field update:",e.message);
        }
      } finally {
        if (!headless && controller.signal.aborted && project===state.project) for (const id of ids) if (state.records.has(id) || state.transient.has(id)) state.pending.add(id);
        state.batch=null;
        if(!state.pending.size) {
          state.queryValues.clear();
          for(const done of state.idle.splice(0))done();
        }
        schedule();
      }
    }
    function changed(event) {
      if (state.derived) return;
      state.batch?.abort();state.queryValues.clear();
      // Undo may replay bindings in place on the existing manifest array.
      sync(event?.source==="undo");
      for (const k of state.changed) dirty(k);
      if(!state.store){
        for(const {doc,items} of event?.touched || []){
          if(!doc?.id)continue;
          dirty(queryWatch(doc.id));dirty(queryWatch(null));
          if(items?.length)for(const item of items)dirty(objectWatch(doc.id,item.id));
          else dirty(docWatch(doc.id));
        }
      }
      state.changed.clear(); schedule();
    }
    function journal(store) {
      if (!store || state.store===store) return;
      state.store=store;
      store.onAuthored((rows,dir,project)=>{
        if (project!==host.project() || state.derived) return;
        for(const key of journalWatches(rows))state.changed.add(key);
        if (state.changed.size) queueMicrotask(()=>{ if (state.changed.size) changed(); });
      });
    }
    if(!headless) {
      host.on?.("change",changed);host.on?.("replace",changed);
      journal(G.AtriumUndoStore);
      if(!state.store)G.AtriumLazy?.need?.("AtriumUndoStore").then(journal,()=>{});
    }
    state.invalidate=keys=>{for(const key of keys)dirty(key);};
    state.drain=async()=>{while(state.pending.size && !host.signal?.aborted)await flush();};
    sync(); schedule(); return state;
  }
  async function settle(project,operations,signal) {
    if(!project.numericExpressions?.length || !operations.length)return false;
    let changed=false,revision=0;
    const host={project:()=>project,revision:()=>revision,signal,
      derive(fn){fn();changed=true;revision++;}};
    const state=attachHost(host,{headless:true});
    state.invalidate(operationWatches(operations));
    await state.drain();
    return changed;
  }
  // Existing controls perform their established domain checks and their existing edit
  // transaction. Persist the formula only after that edit accepts the actual materialised value.
  function capture(project) {
    if (!committing || committing.project!==project || committing.manual) return;
    const {target, result, spec}=committing, at=locate(project,target);
    if(!at)return;
    const authored=result.marking ?? (result.literal ? result.value : undefined), actual=readValue(at);
    const accepted=authored!==undefined ? actual===authored : hasValue(actual,result.value,spec);
    if (accepted) {
      remember(project,target,result.entry); committing.captured=true;
    }
  }

  const controls=new WeakMap(),pointerDocuments=new WeakSet();
  function watchPointer(doc){
    if(pointerDocuments.has(doc))return;
    pointerDocuments.add(doc);
    doc.addEventListener("pointerdown",e=>controls.get(doc.activeElement)?.holdPreview(e),true);
  }
  const draftText=input=>input.value;
  function attach(input, provided=input.waffleNumeric || {}) {
    if (controls.has(input)) return controls.get(input);
    const originalType=input.waffleNumericType || input.type;
    const geometry=input.dataset.unit && input.inputMode==="decimal";
    const local=input.closest(".prf-dialog,.prf-stepper");
    const legacyPreference=!!input.closest(".prf-stepper");
    const plainPreference=()=>legacyPreference && !!input.value.trim() && Number.isFinite(Number(input.value));
    const spec={unit:input.dataset.numericUnit || input.dataset.unit || "",...(geometry ? {storageUnit:"mm",nanometres:true}:{}),
      ...(local ? {readDesign:()=>false} : {}), ...provided};
    if (!provided.storageUnit && !spec.storageUnit) spec.storageUnit=spec.unit;
    if(spec.nanometres==null && spec.storageUnit==="mm")spec.nanometres=true;
    if (!legacyPreference)
      for (const prop of ["min","max"]) if (spec[prop] == null && input.hasAttribute(prop)) spec[prop]=Number(input.getAttribute(prop));
    if (spec.integer==null && input.getAttribute("step")==="1") spec.integer=true;
    const host=spec.host || G.AtriumNavHost;
    const project=()=>(typeof spec.project==="function" ? spec.project() : spec.project) || host?.project?.();
    if(tableTarget(spec.target) && G.AtriumTableData)spec.tableUnit ??= locate(project(),spec.target)?.unit;
    const prior=()=>spec.prior ? spec.prior() : stored(project(),spec.target) || state.sessionEntry;
    const state={spec, input, dirty:false, serial:0, saved:input.waffleNumericBefore ?? input.value, originalType,
      sessionEntry:null, echo:false, host, project};
    controls.set(input,state);
    let status, chip, timer, controller, promise, source, cache, evaluatedRevision, shownIssue;
    const doc=input.ownerDocument;
    function holdPreview(event){
      if(event.button!==0 || event.target===input || !state.dirty || !status || status.hidden || state.pointerHeld)return;
      state.pointerHeld=true;
      // The pressed action must stay under the pointer until its click is delivered.
      function release(end){
        if(end.type!=="blur" && end.pointerId!==event.pointerId)return;
        doc.removeEventListener("pointerup",release,true);doc.removeEventListener("pointercancel",release,true);
        doc.defaultView?.removeEventListener("blur",release);
        setTimeout(()=>{state.pointerHeld=false;if(state.clearAfterClick)message("");},0);
      }
      doc.addEventListener("pointerup",release,true);doc.addEventListener("pointercancel",release,true);
      doc.defaultView?.addEventListener("blur",release);
    }
    function message(line, bad=false, committed=false) {
      if (!presentationEnabled()) {
        if (bad) input.setAttribute("aria-invalid","true"); else input.removeAttribute("aria-invalid");
        if (bad && committed) host?.info?.(line);
        return;
      }
      G.AtriumLazy?.numericPresentation?.().catch(() => {});
      state.clearAfterClick=!line && state.pointerHeld;
      if(state.clearAfterClick){input.removeAttribute("aria-invalid");return;}
      if (!status && line) {
        status=doc.createElement("span"); status.className="numeric-field-preview"; status.id="numeric-preview-"+(++eventId);
        // In a property row the unit shares the field's box (ui-library.md › Property rows): the preview goes under the box.
        status.setAttribute("role","status"); status.setAttribute("aria-live","polite"); (input.closest(".ui-prop-row > .ui-field-measure") || input).after(status);
        const before=input.getAttribute("aria-describedby"); input.setAttribute("aria-describedby",[before,status.id].filter(Boolean).join(" "));
      }
      if (status) {status.textContent=line || "";status.hidden=!line;status.classList.toggle("is-error",bad);}
      if (bad) input.setAttribute("aria-invalid","true"); else input.removeAttribute("aria-invalid");
    }
    function syncChip() {
      const entry=prior();
      if (!entry) {chip?.remove();chip=null;return;}
      if(spec.target && !spec.stage) {
        attachHost(host)?.inspect(spec.target);
        if(!state.dirty && !state.echo && tableTarget(spec.target)) {
          const at=locate(project(),spec.target),raw=at?.read?.();
          if(raw!=null && raw!=="" && Number.isFinite(Number(raw))) {
            const previous=state.saved;state.saved=materialise({value:Number(raw)});
            if(doc.activeElement!==input || input.value===previous)input.value=state.saved;
          }
        }
      }
      if (!presentationEnabled()) {chip?.remove();chip=null;return;}
      G.AtriumLazy?.numericPresentation?.().catch(() => {});
      if (!chip) {
        chip=doc.createElement("button");chip.type="button";chip.className="ui-button numeric-field-chip";chip.dataset.size="sm";
        chip.textContent="ƒx";chip.setAttribute("aria-label","Edit live expression");input.after(chip);
        chip.addEventListener("click",e=>{e.preventDefault();input.focus();enter();input.select();});
      }
      const issue=spec.target && diagnostics.get(project())?.get(key(spec.target));
      chip.setAttribute("aria-label","Edit live expression "+entry.source+(issue ? ". "+issue.message : ""));
      if(!state.dirty && issue)message(issue.message,true);
      else if(!state.dirty && shownIssue)message("");
      shownIssue=issue;
    }
    function enter() {
      if (input.disabled || input.readOnly) return;
      if (originalType==="number" && input.type!=="text") G.AtriumLazy.numericText(input);
      if (!state.dirty && prior()) input.value="="+prior().source;
    }
    function stop() { clearTimeout(timer); controller?.abort(); controller=null; promise=cache=source=null; state.serial++; }
    function run() {
      const text=draftText(input);
      const rev=host?.revision?.();
      if (source===text && promise && evaluatedRevision===rev) return promise;
      evaluatedRevision=rev;
      controller?.abort(); controller=new AbortController();
      const n=++state.serial; source=text;
      promise=evaluate(text,spec,{host,project:project(),signal:controller.signal,prior:prior()}).then(r=>{
        if (state.serial!==n || input.value!==text) return null;
        cache=r;
        if(r.ok && typeof r.tableUnit==="string") {
          spec.tableUnit ??= r.tableUnit;
          spec.storageUnit=r.storageUnit;
          if(!spec.unit)spec.unit=r.tableUnit;
        }
        if (!r.ok) {
          const [a,b]=r.diagnostic.span;input.dataset.errorStart=String(a);input.dataset.errorEnd=String(b);
          message(r.diagnostic.message+" ("+(a+1)+(b>a+1?"–"+b:"")+")",true);
        } else {
          delete input.dataset.errorStart;delete input.dataset.errorEnd;
          message([r.display,...(r.warnings || [])].filter(Boolean).join(" · "));
        }
        return r;
      }).catch(e=>{
        if (e.name!=="AbortError" && state.serial===n) message(e.message,true);
        if (state.serial===n) promise=null;
        return null;
      });
      return promise;
    }
    const replay=new WeakSet();
    function dispatch(type) {
      const E=doc.defaultView?.Event || G.Event;
      const event=new E(type,{bubbles:true,cancelable:true});replay.add(event);input.dispatchEvent(event);
    }
    function materialise(result) {
      const value=result.value;
      if (value==null) return "";
      if (result.marking!==undefined)return result.marking;
      if (result.literal || spec.textValue) return String(value);
      const core=G.AtriumCalculationCore;
      if ((spec.storageUnit || "")!==(spec.unit || "") && core) return String(core.as(core.quantity(value,spec.storageUnit),spec.unit));
      return String(value);
    }
    async function refreshSession(signal) {
      if(state.dirty || !state.sessionEntry || !spec.authority && state.sessionRevision===host?.revision?.())return true;
      const entry=state.sessionEntry,owner=project(),rev=host?.revision?.();
      const next=await evaluate("="+entry.source,spec,{host,project:owner,prior:entry,signal,revision:rev});
      if(state.dirty || state.sessionEntry!==entry || owner!==project() || rev!==host?.revision?.() || !input.isConnected)return false;
      if(!next.ok){message(next.diagnostic.message,true);return false;}
      state.sessionRevision=rev;state.saved=materialise(next);
      if(doc.activeElement===input){input.value="="+entry.source;message(next.display);}
      else {input.value=state.saved;message("");}
      return true;
    }
    state.refreshSession=refreshSession;
    async function commit() {
      if (!state.dirty) return true;
      if (state.applying) return state.applying;
      const text=input.value, owner=project(), rev=host?.revision?.();
      clearTimeout(timer);
      state.applying=(async()=>{
        if(spec.authority && cache?.watches?.length)stop();
        const r=cache && source===text && evaluatedRevision===rev ? cache : await run();
        const ready=r?.ok && prepareTarget(spec.target);if(ready)await ready;
        // A commit starts when focus leaves the field or the field is removed while focused (the browser sends
        // change then), as a plain field's change handler runs. A surface that replaces the field while the value
        // evaluates (Properties or a rule list choosing another object) does not cancel it: it lands on the field's
        // own target. An edit, Undo or another project in the meantime does.
        if (input.value!==text || owner!==project() || host && rev!==host.revision?.()) return false;
        if (!r?.ok) {
          if (r?.diagnostic) message(r.diagnostic.message,true,true);
          return false;
        }
        if (spec.readDesign?.()===false && r.watches?.length){message("This form cannot read design fields.",true,true);return false;}
        let destination;
        if (spec.target && !spec.stage) {
          destination=locate(owner,spec.target);
          if(!destination && !tableTarget(spec.target) && !targetResolver(spec.target))destination=locate(owner,{...spec.target,path:["id"]});
          if (!destination || !writeAllowed(owner,destination.owner,destination.doc,host)) {message("This field is read-only or its object is unavailable.",true,true);return false;}
          if(typeof destination.unit==="string" && spec.tableUnit!==undefined && spec.tableUnit!==destination.unit) {
            message(changedColumnUnit,true,true);return false;
          }
        }
        const saved=committing;
        const transaction=committing={project:owner,target:spec.target,result:r,spec,captured:false};
        state.echo=true;
        try {
          if (originalType==="number") input.type="number";
          input.value=materialise(r);
          if (spec.commit) {
            if (spec.commit(r,input)===false) {input.value=text;return false;}
          } else if(destination?.write) {
            transaction.manual=true;
            try {
              host?.edit?.(()=>{
                if(!destination.write(r.value))return;
                remember(owner,spec.target,r.entry);transaction.captured=true;
              },"Edit numeric field",[{doc:destination.doc,items:[destination.owner]}],{documents:[destination.doc.id],items:[destination.owner.id]});
            } catch(e) {
              message(e.message,true,true);
            }
            if(!transaction.captured) {
              if(originalType==="number")input.type="text";
              input.value=text;if(!input.hasAttribute("aria-invalid"))message("The edited field did not accept this value.",true,true);return false;
            }
          } else { dispatch("input"); dispatch("change"); }
          if (input.getAttribute("aria-invalid")==="true") { if(originalType==="number")input.type="text";input.value=text;return false; }
          if(r.entry && spec.target && !spec.stage && !transaction.captured) {
            const at=locate(owner,spec.target);
            if(at && hasValue(readValue(at),r.value,spec) && host?.revision?.()===rev && host?.edit) {
              host.edit(()=>remember(owner,spec.target,r.entry),"Set live expression");
            } else {
              if(originalType==="number")input.type="text";input.value=text;
              message("The edited field did not accept this value.",true,true);return false;
            }
          }
          if (spec.stage) spec.stage(r.entry,spec.target);
          if(!spec.target && !spec.stage) {
            state.sessionEntry=r.entry;state.sessionRevision=rev;
            if(r.entry && r.watches?.length || state.transientId)attachHost(host)?.watchControl(state,r.entry?r.watches:[]);
          }
          state.usedDesign=!!r.watches?.length;state.saved=input.value; state.dirty=false; stop(); message(""); syncChip();
          if (r.entry?.target && !spec.stage) attachHost(host);
          return true;
        } finally { state.echo=false; committing=saved; }
      })();
      let active;
      if(host) {
        active=editing.get(host);
        if(!active)editing.set(host,active=new Set());
        active.add(state.applying);
      }
      try { return await state.applying; } finally {active?.delete(state.applying);state.applying=null;}
    }
    function inputEvent(e) {
      if (replay.has(e)) return;
      if(state.echo){e.stopImmediatePropagation();return;}
      if(!spec.nativeInput?.(input.value))e.stopImmediatePropagation();
      stop(); state.dirty=true;
      // Superseded work is cancelled. A numeric field never starts an idle loop.
      timer=setTimeout(run,60);
    }
    function change(e) {
      if(replay.has(e))return;
      if(state.echo){e.stopImmediatePropagation();return;}
      if (plainPreference()) {
        stop();state.dirty=false;state.sessionEntry=null;
        queueMicrotask(()=>{state.saved=input.value;message("");});
        return;
      }
      const entry=prior();
      // Browsers can deliver change on blur after Enter has already committed a
      // live value. Only a later user edit may replace its source.
      if (!state.dirty && (input.value===state.saved || entry && input.value==="="+entry.source)) {
        if(entry)e.stopImmediatePropagation();
        return;
      }
      const text=!input.waffleNumeric && !entry ? input.waffleNativeNumber?.() : null;
      if(typeof text==="string"){
        stop();state.saved=text;state.dirty=false;input.type="number";input.value=text;
        dispatch("input");message("");return;
      }
      e.stopImmediatePropagation();state.dirty=true;commit();
    }
    input.addEventListener("input",inputEvent,true);
    input.addEventListener("change",change,true);
    input.addEventListener("focus",enter);
    input.addEventListener("keydown",e=>{
      if (state.echo || e.isComposing) return;
      if (e.key==="Escape" && (state.dirty || input.value!==state.saved)) {
        e.preventDefault();e.stopImmediatePropagation();stop();state.dirty=false;
        input.value=state.saved;message("");syncChip();return;
      }
      if (e.key==="Enter" && state.dirty && !plainPreference()) {
        e.preventDefault();e.stopImmediatePropagation();
        commit().then(ok=>{if(ok && input.form && input.isConnected) input.form.requestSubmit?.();});
      }
    },true);
    input.addEventListener("blur",()=>{if (!state.dirty && originalType==="number") {input.type="number";input.value=state.saved;}});
    state.commit=commit;state.enter=enter;state.changed=()=>{state.dirty=true;run();};state.message=message;
    state.holdPreview=holdPreview;watchPointer(doc);
    state.syncChip=syncChip;observe(project(),spec.target,input);syncChip(); if(doc.activeElement===input) enter();
    return state;
  }
  async function flush(container) {
    const inputs=[...(container?.querySelectorAll?.("input") || [])];
    for (const i of inputs) {
      const controller=controls.get(i);
      if (controller?.dirty && !await controller.commit()) {i.focus?.();return false;}
      if(controller?.sessionEntry && !await controller.refreshSession()) {i.focus?.();return false;}
      if (controller?.usedDesign && controller.spec.readDesign?.()===false) {
        controller.message("This form cannot read design fields.",true);i.focus?.();return false;
      }
    }
    return true;
  }
  function pending(container) {
    return [...(container?.querySelectorAll?.("input") || [])].some(input=>{
      const state=controls.get(input);
      return state?.dirty || !!state?.sessionEntry || state?.usedDesign && state.spec.readDesign?.()===false;
    });
  }
  function draft(input) {return controls.get(input)?.dirty === true;}
  async function commitField(input) {return (await controls.get(input)?.commit()) !== false;}
  function finishEdits(host=G.AtriumNavHost) {
    const active=editing.get(host), busy=()=>{
      const state=hosts.get(host);
      return state && (state.queued || state.batch || state.pending.size) ? state : null;
    };
    if(!active?.size && !busy())return;
    return (async()=>{
      if(active?.size && !(await Promise.all([...active])).every(Boolean))return false;
      const state=busy();if(state)await new Promise(resolve=>state.idle.push(resolve));
      return true;
    })();
  }
  return Object.freeze({evaluate,convert,attach,attachHost,flush,pending,draft,commitField,finishEdits,capture,remember,stored,key,locate,prepareTarget,readValue,writeAllowed,validateChanges,planGeometryMove,settle,registerTargetResolver,geometryLocals,presentationEnabled,
    editingBinding:()=>!!committing?.target && (!!committing.result.entry || !!stored(committing.project,committing.target)),
    copyIssues:(from,to)=>{if(diagnostics.has(from))diagnostics.set(to,diagnostics.get(from));},
    issue:(p,t)=>diagnostics.get(p)?.get(key(t)),stats:h=>({evaluations:hosts.get(h)?.evaluations || 0})});
})();
