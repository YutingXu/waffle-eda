"use strict";
// Pure projections used by rule subjects, the Filter and the native query index.
globalThis.AtriumDesignQueryContext = (() => {
  const G = globalThis;
  const own = (o,k) => o != null && Object.prototype.hasOwnProperty.call(o,k);
  const folded = value => String(value ?? "").toLowerCase();
  const texts = new Set(("kind name text designator component.designator net.name footprint layer side pin.number signal polarity " +
    "package comment description component net").split(" "));
  const booleans = new Set(["locked","plated","throughhole","smd","teardrop","keepout","hasnet","inpolygon"]);
  const signalFields = new Set(["signal.name","polarity","paired"]);
  const kindAliases = {__proto__:null,component:"part",powerport:"power",label:"netlabel",poly:"polygon"};
  const signalField = key => signalFields.has(folded(key));
  function instance(project, doc, instanceId) {
    const hierarchy = G.AtriumHierarchy;
    const tree = hierarchy?.instancesCached?.(project) ?? hierarchy?.instances(project);
    return tree?.instances.find(i => i.id === instanceId && i.doc.id === doc?.id);
  }
  const call = (fn, args, fallback) => {
    const result = fn?.(...args);
    return result === undefined ? fallback() : result;
  };
  function kind(row) {
    const v = folded(row.kind || row.item?.kind);
    if (row.sub && !v) return row.docKind === "schematic" ? "pin" : "pad";
    return kindAliases[v] || v;
  }
  function placedKind(doc, item) {
    if (doc.kind === "pcb") {
      if (item.keepout || /keep-?out/i.test(item.layer || "")) return "keepout";
      if (item.kind === "graphic") {
        if (item.fill && item.fillRect) return "fill";
        if (item.fill) return "region";
        return item.arc ? "arc" : "line";
      }
      if (item.kind === "track" && item.arc) return "arc";
    }
    return kind(item);
  }
  const terminalId = (owner,pin,number,occurrence) => G.Atrium.terminalId(owner,pin,number,occurrence);
  function subject(doc, item, context, kind = placedKind(doc, item)) {
    const row = {docId:doc.id, docKind:doc.kind, instanceId:context.instanceId,
      item, definition:context.defs.get(item.def), id:item.id, kind};
    const component = kind === "part" ? context.occurrence?.designator?.(item) : undefined;
    if (component) row.component = component;
    return row;
  }
  function terminalSubjects(part) {
    const {item, definition, docKind} = part;
    if (!definition || !G.Atrium?.pins) return [];
    const board = docKind === "pcb", rows = [], counts = new Map();
    const pins = G.Atrium.pins(item, definition, docKind);
    for (let slot = 0; slot < pins.length; slot++) {
      const pin = pins[slot];
      if (pin.hidden && !board) continue;
      const number = String(pin.number ?? ""), occurrence = counts.get(number) || 0;
      counts.set(number, occurrence + 1);
      // A flipped part already references a mirrored definition. Its explicit pad
      // layers are physical board layers, including lands opposite the mounted side.
      const layer = board ? pin.layer || (pin.drill > 0 ? "Multi" : item.layer || "Top") : undefined;
      rows.push({...pin, ...part, item:pin, part:item, sub:true, kind:board ? "pad" : "pin",
        ...(board ? {padIndex:slot, padId:pin.id} : {}),
        id:terminalId(item.id,pin,number,occurrence), ownerId:item.id, pin:number,
        component:part.component ?? item.ref, net:item.pinNets?.[number] ?? pin.net, layer});
    }
    return rows;
  }
  function netNames(doc,item,ctx) {
    if (doc.kind === "pcb" && !item.net && !item.pinNets) return [];
    const names = new Set([ctx.netName({item,kind:item.kind}),...Object.values(item.pinNets || {})]);
    if (item.kind === "part") for (const terminal of terminalSubjects(subject(doc,item,ctx,"part")))
      names.add(ctx.netName(terminal));
    return [...names].filter(name=>typeof name === "string" && name);
  }
  function netSubject(doc,name,instanceId) {
    return {kind:"net",id:"net/"+name,name,net:name,docId:doc.id,instanceId};
  }
  // One placed owner, shared by the Filter scan and the query index.
  // Net names stay exactly as netNames returns them, so case remains distinct.
  function* projectOwner(doc, item, ctx, accept) {
    if (accept.nets) {
      yield* netNames(doc, item, ctx);
      return;
    }
    const row = subject(doc, item, ctx);
    if (accept.parent) yield row;
    if (accept.terminals && row.kind === "part") yield* terminalSubjects(row);
  }
  function family(row,defs) {
    if (["resistor","capacitor","inductor","led"].includes(kind(row))) return kind(row);
    const part = row.item || row, definition = row.definition || defs?.get(part.def);
    const type = folded(part.generic?.family || definition?.generic?.family || definition?.genericPart?.family);
    return type || ({r:"resistor",c:"capacitor",l:"inductor"})[folded(definition?.prefix || String(part.ref || row.component || "").replace(/[\d?].*$/,""))] || null;
  }
  const copper = l => l === "Top" ? 0 : l === "Bottom" ? 127 : /^Inner ([1-9]\d?)$|^Inner (1[01]\d|12[0-6])$/.test(l || "") ? Number(l.slice(6)) : null;
  function layerRange(row) {
    if (row.span) return row.span;
    const item=row.item || row;
    if(kind(row)==="via") {
      const a=copper(item.fromLayer),b=copper(item.toLayer);
      return a==null || b==null ? [0,127] : [Math.min(a,b),Math.max(a,b)];
    }
    return (row.layer || item.layer)==="Multi" || kind(row)==="pad" && (row.drill || item.drill)>0 ? [0,127] : null;
  }
  function raw(row,key,doc,defs) {
    const item = row.item || row, part = row.part || item, def = row.definition || defs?.get(part.def);
    switch (folded(key)) {
      case "kind": return kind(row);
      case "layer": return row.layer ?? item.layer ?? (["track","part"].includes(kind(row)) ? "Top" : kind(row)==="via" ? "Multi" : undefined);
      case "net": case "net.name": return kind(row) === "net" ? row.name : typeof row.net === "object" ? row.net?.name : row.net ?? item.net;
      case "component": case "component.designator": case "designator": return typeof row.component === "object" ? row.component.ref : row.component ?? part.ref ?? row.designator;
      case "sheet": return row.docId ?? row.sheet ?? doc?.id;
      case "pin.number": return row.pin ?? row.number ?? item.number;
      case "hole": case "holesize": case "holediameter": return row.drill ?? item.drill ?? (["pad","via"].includes(kind(row)) ? 0 : undefined);
      case "throughhole": return row.drill != null ? row.drill > 0 : item.drill != null ? item.drill > 0 : null;
      case "smd": return kind(row) === "pad" ? !(row.drill > 0 || item.drill > 0) : null;
      case "hasnet": return !!raw(row,"net.name",doc,defs);
      case "inpolygon": return kind(row)==="polygon" || !!(row.polygonId || row.polygon || item.polygonId || item.polygon);
      case "teardrop": return row.teardrop ?? (item.teardrop===true || String(item.groupId || "").startsWith("teardrop:"));
      case "signallayer": case "innerlayer": case "outerlayer": case "multilayer": {
        const layer=raw(row,"layer",doc,defs),index=copper(layer),interval=layerRange(row) || (index==null ? null : [index,index]);
        if(!interval)return false;
        if(folded(key)==="signallayer")return true;
        const [a,b]=interval;
        return folded(key)==="multilayer" ? a!==b : a===b && (folded(key)==="innerlayer" ? a>0 && a<127 : a===0 || a===127);
      }
      case "footprint": return row.footprint ?? def?.footprint?.name;
      case "x": return row.at?.[0] ?? row.x ?? item.x;
      case "y": return row.at?.[1] ?? row.y ?? item.y;
      case "rotation": return row.rotation ?? row.angle ?? item.angle;
      case "comment": return row.comment ?? item.comment ?? item.value;
      case "name": return row.name ?? item.name ?? item.text ?? row.pin;
      case "pincount": return kind(row) === "part" ?
        (doc?.kind === "pcb" ? def?.footprint?.pads : def?.symbol?.pins || def?.pins)?.length : undefined;
      case "plated": return kind(row) === "pad" ? item.plated !== false : item.plated;
    }
    if (own(row,key)) return row[key];
    if (own(item,key)) return item[key];
    return own(item.parameters,key) ? item.parameters[key] : own(def?.parameters,key) ? def.parameters[key] : undefined;
  }
  function context(project, doc, opts = {}) {
    const authority=opts.authority;
    const member=(collection,key)=>!collection || (collection.has?.(key) ?? collection.includes(key));
    const projectAllowed=()=>!authority || !(authority.revoked || authority.readProject===false || authority.projectId && authority.projectId!==project?.id);
    const canReadDoc=id=>projectAllowed() && (!id || member(authority?.documentIds,id) && (authority?.canReadDocument?.(id) ?? true));
    const canReadItem=(id,owner)=>!id || (authority?.canReadItem?.(id,owner) ?? true);
    const canReadField=key=>projectAllowed() && member(authority?.fields || authority?.allowedFields,key) && (authority?.canReadField?.(key) ?? true);
    const defs = opts.defs || new Map((projectAllowed() ? project?.library || [] : []).map(d => [d.id,d]));
    const docs = project?.documents || (doc ? [doc] : []);
    const board = doc?.kind === "pcb" && canReadDoc(doc.id) ? doc : docs.find(d => canReadDoc(d.id) && d.kind === "pcb");
    const occurrence = opts.occurrence ?? (project && opts.instanceId ? instance(project,doc,opts.instanceId) : undefined);
    let signals, netClasses, componentClasses, paths, schematicNets, geometry=opts.geometry;
    const derivedNets = doc?.kind === "schematic" && !(authority?.documentIds || authority?.canReadDocument || authority?.canReadItem);
    function netName(row) {
      const fallback = raw(row,"net.name",doc,defs);
      if (!derivedNets || row.kind === "net") return fallback;
      const item = row.item || row;
      if (["netlabel","power","port","offsheet"].includes(item.kind)) return item.text ?? item.name ?? fallback;
      if (row.kind !== "pin" && item.kind !== "wire") return fallback;
      if (schematicNets === undefined) {
        schematicNets = occurrence ? G.AtriumHierarchy?.compileCached?.(project,{defs,publish:false})?.byInstance.get(occurrence.id) : null;
        schematicNets ??= G.Atrium?.sheetNets?.(project,doc,defs) ?? null;
      }
      return (row.kind === "pin" ? schematicNets?.byPin.get(row.ownerId+"/"+row.pin) : schematicNets?.byWire.get(item.id)) ?? fallback;
    }
    function classMembers(name) {
      const members = signalEnv()?.classes?.get(name);
      if (members != null || !board) return members;
      netClasses ??= G.AtriumRules?.netClasses?.(board,{project}) ?? board.rules?.netClasses ?? {};
      return own(netClasses,name) ? netClasses[name] : undefined;
    }
    function geometryFor() {
      if (geometry===undefined && canReadDoc(doc?.id) && doc?.kind==="pcb") {
        const api=G.AtriumDesignQueryGeometry;
        const scoped = authority?.canReadItem ? {...opts,allows:ref => canReadItem(ref.id ?? ref.itemId,ref.docId ?? doc.id) &&
          (opts.allows?.(ref) ?? true)} : opts;
        geometry=project && api?.context ? api.context(project,doc,scoped) : api?.create?.({doc,defs,
          revision:typeof opts.revision==="function" ? opts.revision : ()=>opts.revision,
          occurrence:opts.instanceId,allows:opts.allows,journal:opts.store || G.AtriumUndoStore});
      }
      return geometry;
    }
    const signalEnv = () => signals === undefined ? (signals = G.AtriumSignals?.scopeEnv?.(board, project) || null) : signals;
    function pathGroups() {
      if (paths) return paths;
      const store = G.AtriumSignals?.xsView?.(board,project) || board?.lengthTuning || {};
      const components = new Map((board?.items || []).filter(i => i.kind === "part").map(i => [i.ref,i]));
      const nets = new Map(), classes = new Map(Object.entries(store.xSignalClasses || {}).map(([k,v])=>[k,new Set(v)]));
      for (const x of store.xSignals || []) {
        const members = x.nets?.length ? x.nets : [x.from,x.to].map(p=>components.get(p?.ref)?.pinNets?.[p?.pin]);
        nets.set(x.name,new Set(members.filter(Boolean)));
        if (x.class) { if (!classes.has(x.class)) classes.set(x.class,new Set()); classes.get(x.class).add(x.name); }
      }
      return paths = {nets,classes};
    }
    function resolveRef(input) {
      const denied={diagnostic:{code:"denied",message:"The requested reference is unavailable.",span:input.span}};
      if (!canReadDoc(doc?.id) || !canReadDoc(input.binding?.target?.docId) ||
          !canReadItem(input.binding?.target?.itemId,input.binding?.target?.docId ?? doc?.id)) return denied;
      return call(opts.resolveRef,[input],() => {
        const {name,binding,family:role} = input;
        const t = binding?.target;
        const result = (record, label, extra = {}) => ({target:{...t,...extra,name:label || name,...(record ? {object:record,id:record.id} : {})}});
        const issue = (code,message) => ({diagnostic:{code,message,span:input.span}});
        if (opts.authority?.revoked || opts.authority?.readProject === false ||
            doc && opts.authority?.canReadDocument && !opts.authority.canReadDocument(doc.id))
          return issue("denied","The requested reference is unavailable.");
        if (binding && (!t || t.detached || t.needsRebind)) return issue("broken-reference","Rebind “" + name + "” to its intended object.");
        if (t?.projectId && project?.id && t.projectId !== project.id) return issue("broken-reference","The reference belongs to another project.");
        if (role === "anchor" && geometryFor()?.resolveRef) {
          const located = geometryFor().resolveRef(input);
          if (located !== undefined) return located;
        }
        if (t) {
          const owner = t.docId ? docs.find(d => d.id === t.docId) : doc;
          if (t.docId && !owner) return issue("broken-reference","The bound document is unavailable.");
          if (t.scope === "sheet") return result(owner,owner?.name,{docId:owner?.id});
          if (t.scope === "item" || t.scope === "terminal") {
            const object = owner?.items?.find(i => i.id === t.itemId);
            return object ? result(object, object.ref || object.name || object.text,{docId:owner.id}) : issue("broken-reference","The bound object was deleted.");
          }
          const records = [...(project?.signals?.signals || []), ...(project?.signals?.tags || []), ...(project?.rules?.list || [])];
          const object = records.find(r => r.id === (t.signalId || t.entityId));
          if (t.scope === "project") return result(project,project?.name);
          return object ? result(object,object.name) : issue("broken-reference","The bound design identity is unavailable.");
        }
        if (role === "anchor" || role === "sheet") {
          const matches = [];
          if (role === "sheet") {
            for (const d of docs) if (canReadDoc(d.id) && (d.id === name || d.name === name)) matches.push([d,d]);
          } else {
            for (const d of doc ? [doc] : docs) if(canReadDoc(d.id)) for (const item of d.items || []) {
              if (!canReadItem(item.id,d.id)) continue;
              const ref = item.kind === "part" ? occurrence?.designator?.(item) ?? item.ref : item.ref;
              if (item.id === name || ref === name || item.name === name) matches.push([item,d]);
            }
          }
          if (matches.length !== 1) return issue(matches.length ? "ambiguous-reference" : "broken-reference",
            matches.length ? "Choose the document and instance for “" + name + "”." : "Could not find “" + name + "”.");
          const [object, owner] = matches[0];
          const ref = role === "anchor" && object.kind === "part" ? occurrence?.designator?.(object) : null;
          return result(object,ref || object.ref || object.name || name,{docId:owner.id,...(ref ? {instanceId:occurrence.id} : {})});
        }
        if(role==="signal" || role==="tag") {
          const candidates=(role==="signal" ? project?.signals?.signals : project?.signals?.tags) || [];
          const found=candidates.filter(r=>r.name===name || r.id===name);
          if(found.length>1)return issue("ambiguous-reference","Choose one matching design identity.");
          if(found.length) return result(found[0],found[0].name,role==="signal" ? {signalId:found[0].id} : {entityId:found[0].id});
        }
        return {target:{name}};
      });
    }
    function relation(row,role,target) {
      return call(opts.relation,[row,role,target],() => {
        const name = target.name, net = netName(row), ref = raw(row,"component.designator",doc,defs);
        if (role === "sheet") return raw(row,"sheet",doc,defs) === (target.docId || target.id || name);
        if (role === "net") return net === name;
        if (role === "component") return ref === name;
        if (role === "layer") {
          const idx = copper(name), span = layerRange(row), l = row.layer ?? row.item?.layer ?? (["track","part"].includes(kind(row)) ? "Top" : null);
          return idx != null && span ? span[0] <= idx && idx <= span[1] : idx != null && l === "Multi" || l === name;
        }
        if (role === "pad") return (row.pin ?? row.number) === name;
        if (role === "polygon") return kind(row) === "polygon" && (row.name ?? row.polygon) === name;
        if (role === "room") {
          if (row.room === name || row.rooms?.includes(name)) return true;
          const room = (doc?.rooms || []).find(r => r.name === name || r.id === target.id);
          if (!room || !G.AtriumRooms?.inside) return false;
          const b = row.box, points = b ? [[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]] : [row.at || [row.x,row.y]];
          return points.every(p => p.every(Number.isFinite) && G.AtriumRooms.inside(room,p));
        }
        const s = board && signalEnv();
        if (role === "componentclass") {
          componentClasses ||= G.AtriumComponentClasses?.map?.(board,project) || new Map();
          return componentClasses.get(name)?.has(ref) ?? (name === "All Components" && !!ref);
        }
        if (role === "netclass") {
          const c = classMembers(name);
          return c ? (c.has?.(net) ?? c.includes(net)) : name === "All Nets" && !!net;
        }
        const pair = row.pair || s?.pairOfNet?.get(net)?.name ||
          board?.rules?.diffPairs?.find(p=>p.positive===net || p.negative===net)?.name;
        if (role === "diffpair") return pair === name || s?.signalOf?.(net)?.kind === "diff" && s.signalOf(net).name === name;
        if (role === "diffpairclass") return s?.pairClasses?.get(name)?.has(pair) ?? !!board?.rules?.diffPairClasses?.[name]?.includes(pair);
        if (role === "signal") return s ? !!s.netsOfSignal?.(name)?.has(net) : pair === name || !!pathGroups().nets.get(name)?.has(net);
        if (role === "tag" && s) return !!s.hasTag?.(net,name);
        if (role === "xsignal") return row.xSignal != null ? row.xSignal === name : !!pathGroups().nets.get(name)?.has(net);
        if (role === "xsignalclass" || role === "tag") {
          if (role === "tag" && (board?.rules?.netClasses?.[name]?.includes(net) || board?.rules?.diffPairClasses?.[name]?.includes(pair))) return true;
          const xs = pathGroups(), members = xs.classes.get(name);
          if (!members) return false;
          if (row.xSignal != null) return members.has(row.xSignal);
          for (const member of members) if (xs.nets.get(member)?.has(net)) return true;
          return false;
        }
        return null;
      });
    }
    function describeField(k, key) {
      if (!canReadDoc(doc?.id) || !canReadField(key)) return {type:"unavailable",diagnostic:{code:"denied",message:"The requested field is unavailable."}};
      return call(opts.describeField,[k,key],() => {
        const name = folded(key), shared = G.AtriumQueryFields?.describe?.(project,{kind:k,field:key,partType:k,doc,
          definitionId:opts.definitionId,definitions:opts.definitions || (opts.authority ? undefined : project?.library)});
        if (shared && !["undeclared","unknown"].includes(shared.type)) return shared;
        if (name === "sheet") return {type:"reference",key, family:"sheet"};
        if (texts.has(name)) return {type:"text",key};
        if (booleans.has(name)) return {type:"boolean",key};
        return shared || null;
      });
    }
    function fieldValue(row, key, declaration) {
      if (!canReadDoc(row.docId || doc?.id) || !canReadField(key)) return null;
      const read=opts.fieldValue, projected=read?.(row,key,declaration);
      if(projected!==undefined)return projected;
      if (derivedNets) {
        const name = folded(key);
        if (name === "net" || name === "net.name") return netName(row);
        if (name === "hasnet") return !!netName(row);
      }
      if(signalField(key)) {
        if(own(row,key))return row[key];
        const net=netName(row),s=board && signalEnv(),signal=net && s?.signalOf?.(net);
        const pair=net && (s?.pairOfNet?.get(net) || board?.rules?.diffPairs?.find(p=>p.positive===net || p.negative===net));
        if(folded(key)==="paired")return !!(row.pair || pair || signal?.kind==="diff");
        if(folded(key)==="signal.name")return signal?.name ?? pair?.name ?? row.pair ?? null;
        const sign=signal?.polarity ?? (pair && pair.positive===net ? 1 : pair && pair.negative===net ? -1 : null);
        return sign===1 ? "+" : sign===-1 ? "-" : signal ? "" : null;
      }
      if(declaration?.source==="builtin" && declaration.type==="quantity") {
        const n=raw(row,key,doc,defs);
        if(typeof n==="number" && Number.isFinite(n))return n;
      }
      if (declaration?.id==="length" && kind(row)==="net" && row.length==null) {
        if (!board || !G.AtriumLength?.netLength) return null;
        const measurement=G.AtriumLength.netLength(board,defs,row.net || row.name,{project,revision:opts.revision});
        return measurement && !measurement.unrouted && Number.isFinite(measurement.length) ? {value:measurement.length,unit:"mm"} : null;
      }
      const numeric = ["quantity","polymorphic","undeclared","number"].includes(declaration?.type);
      if (numeric && G.AtriumQueryFields?.fieldValue) {
        const part = row.part || row.item || row, definition = row.definition || defs.get(part.def);
        const out = G.AtriumQueryFields.fieldValue({...row,item:part,definition,partType:family(row,defs),project,doc},key,declaration);
        if (out !== undefined) return out;
      }
      return raw(row,key,doc,defs);
    }
    function scalarField(name,span,binding) {
      const target=binding?.target, key=target?.field || name.slice(name.lastIndexOf(".")+1);
      if (!canReadDoc(doc?.id) || !canReadDoc(target?.docId) || !canReadField(key) ||
          authority?.canReadItem && (!target?.itemId || !canReadItem(target.itemId,target.docId ?? doc?.id)))
        return {diagnostic:{code:"denied",message:"The requested input is unavailable.",span}};
      if (binding && (!target || target.detached || target.needsRebind || target.projectId && target.projectId!==project?.id))
        return {diagnostic:{code:"broken-reference",message:"Rebind the deleted scalar input.",span}};
      const scoped=authority && project ? {...project,documents:docs.filter(d=>canReadDoc(d.id))} : project;
      const r=scoped && G.AtriumNoteFields?.resolve(scoped,doc,name,target,{instanceId:opts.instanceId,describeField:G.AtriumQueryFields?.describe});
      if(!r || r.broken || r.raw==null) return {diagnostic:{code:r?.code==="ambiguous" ? "ambiguous-reference" : "broken-reference",message:"The referenced design field is unavailable.",span}};
      const unit=r.declaration?.unit || r.authoredUnit || r.defaultUnit;
      const quantity=G.AtriumCalculationCore.parseBoundValue(r.raw,{unit:unit || "",fieldUnit:unit || undefined,sourceId:r.sourceId});
      return quantity.ok ? {quantity,target:r.binding,id:r.sourceId} : {diagnostic:{...quantity.diagnostic,span}};
    }
    function posting(term) {
      if (opts.relation || opts.fieldValue) return null;
      const name=term.target.name;
      if(term.family==="net")return derivedNets ? null : {key:"net.name",values:[name]};
      if(term.family==="component")return {key:"component.designator",values:[name]};
      if(term.family==="netclass") {
        const members=classMembers(name);
        if(members && !derivedNets)return {key:"net.name",values:members};
      }
      return null;
    }
    return {...opts,project,doc,defs,occurrence,get geometry(){return geometryFor();},domain:opts.domain || doc?.kind || "project",
      resolveRef,relation,describeField,fieldValue,posting,scalarField,canReadDoc,canReadItem,canReadField,projectAllowed,netName,derivedNets,__nativeContext:true,
      customProviders:!!(opts.resolveRef || opts.relation || opts.fieldValue || opts.describeField || opts.ruleValue || opts.geometry),
      customFieldProjection:!!(opts.fieldValue || opts.describeField),customRelationProjection:!!opts.relation,hasGeometryProvider:!!opts.geometry,
      kindOf:kind,partType:row => family(row,defs)};
  }
  return Object.freeze({context,kind,placedKind,subject,terminalSubjects,terminalId,netNames,netSubject,projectOwner,raw,copper,layerRange,partType:family,instance,signalField});
})();
