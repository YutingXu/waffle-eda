"use strict";
// Native read-only query compiler. Headless modules are resolved on the first real query.
// @ts-ignore CommonJS entry point. Browser and worker loaders declare these files.
if (typeof module !== "undefined" && typeof require === "function") {
  for (const name of ["checks/design-query-record","notebook/calculation-intent","notebook/calculation-core","notebook/note-fields","checks/query-fields",
    "checks/design-query-parser","checks/design-query-geometry","checks/design-query-context","checks/design-query-index"]) require("../" + name + ".js");
}
globalThis.AtriumDesignQuery = (() => {
  const G = globalThis, R = G.AtriumDesignQueryRecord, parser = G.AtriumDesignQueryParser;
  const t = G.AtriumI18n?.define?.({"common.query_unavailable":"The query is unavailable."});
  const unavailable = () => t ? t("common.query_unavailable") : "The query is unavailable.";
  const core = () => G.AtriumCalculationCore;
  const fail = (code,message,span) => parser.fail(code,message,span);
  const info = (e,offset,span) => ({...e,span:e.span ? [e.span[0]+offset,e.span[1]+offset] : span});
  const fold = text => Array.from(String(text),c => c === "\u0131" ? c : c.toUpperCase().toLowerCase()).join("");
  const operations = {"=":s=>s===0,"!=":s=>s!==0,"<":s=>s<0,"<=":s=>s<=0,">":s=>s>0,">=":s=>s>=0};
  function glob(pattern,caseSensitive) {
    const p = Array.from(caseSensitive ? pattern : fold(pattern));
    return value => {
      const chars = Array.from(caseSensitive ? String(value) : fold(value));
      let i = 0, j = 0, star = -1, after = 0;
      while (i < chars.length) {
        if (p[j] === "?" || p[j] === chars[i]) { i++; j++; }
        else if (p[j] === "*") { star = j++; after = i; }
        else if (star >= 0) { i = ++after; j = star + 1; }
        else return false;
      }
      while (p[j] === "*") j++;
      return j === p.length;
    };
  }
  // A required measurement can carry its source diagnostic through Kleene logic.
  // A decisive false AND or true OR suppresses the unavailable branch.
  const unknown = (a,b) => typeof a==="object" && a || typeof b==="object" && b || null;
  const truthAnd = (a,b) => a===false || b===false ? false : a===true && b===true ? true : unknown(a,b);
  const truthOr = (a,b) => a===true || b===true ? true : a===false && b===false ? false : unknown(a,b);
  const asTruth = value => typeof value==="boolean" ? value : null;
  const missing = (name,span) => ({code:"measurement",message:"The required "+name+" is unavailable.",span});
  function valueOf(v) {
    if (v == null || v.ok === false) return null;
    if (v.quantity) return v.quantity;
    if (v.dimensions) return v;
    if (typeof v === "object" && "value" in v && !v.unit) return v.value;
    return v;
  }
  function scopeContext(input) {
    return G.AtriumDesignQueryContext.context(input.project,input.doc,input);
  }
  const syntaxCache = new Map(), plansByContext=new WeakMap();
  function freezeSyntax(node) {
    if(!node || typeof node!=="object" || Object.isFrozen(node))return node;
    for(const child of Object.values(node))freezeSyntax(child);
    return Object.freeze(node);
  }
  function parse(source) {
    let p = syntaxCache.get(source);
    if (!p) {
      p = parser.parse(source);
      if (p.ok) {
        if (syntaxCache.size >= 256) syntaxCache.delete(syntaxCache.keys().next().value);
        syntaxCache.set(source,freezeSyntax(p));
      }
    }
    return p;
  }
  function compile(input, supplied = {}) {
    const record = typeof input === "string" ? {languageVersion:1,source:input} : input;
    const hints = [], deps = new Set(), terms = [], comparisons = [], measurements=[], ranges=new Map();
    if (!R.valid(record,{allowUnknown:!!supplied.allowUnknown})) {
      return {ok:false,hints,diagnostics:[{code:record?.languageVersion === 1 ? "record" : "language-version",
        message:"Invalid or unsupported native query scope.",span:[0,typeof record?.source === "string" ? record.source.length : 0]}]};
    }
    const parsed = parse(record.source);
    if (!parsed.ok) return {...parsed,hints};
    const ctx = supplied.__nativeContext ? supplied : scopeContext(supplied);
    const kind = parsed.kind, references = [];
    const seq=ctx.store?.documentVersions?.(ctx.doc,ctx.project)?.seq;
    const revision=typeof ctx.getRevision==="function" ? ctx.getRevision() : ctx.revision;
    const reusable=!ctx.customProviders && (revision!=null || seq!=null) && (!ctx.authority || ctx.authority.version!=null);
    let plans,cacheKey;
    if(reusable) {
      plans=plansByContext.get(ctx);
      if(!plans)plansByContext.set(ctx,plans=new Map());
      cacheKey=JSON.stringify([record,revision,seq,ctx.schemaRevision,ctx.authority?.version]);
      const hit=plans.get(cacheKey);if(hit?.plan.authorized())return hit;
    }
    const boundOccurrences=new Map();
    const safeTarget=target=>{
      const ref={};
      for(const key of ["scope","id","kind","name","projectId","docId","itemId","signalId","entityId","pinId","definitionId","instanceId","parameterId","field"])
        if(typeof target[key]==="string")ref[key]=target[key];
      return Object.freeze(ref);
    };
    function bind(family,name,span) {
      const at=family+"@"+span[0];
      if(boundOccurrences.has(at))return boundOccurrences.get(at);
      const binding = record.bindings?.find(b => b.span[0] === span[0] && b.span[1] === span[1]);
      const result = ctx.resolveRef({family,name,span,binding});
      if (!result?.target || result.diagnostic) fail(result?.diagnostic?.code || "broken-reference",result?.diagnostic?.message || "The reference is unavailable.",span);
      if(!ctx.canReadDoc(result.target.docId) || result.target.field && !ctx.canReadField(result.target.field))
        fail("denied","The requested reference is unavailable.",span);
      references.push({family,name,span,target:safeTarget(result.target)});
      deps.add("reference:" + (result.target.id || result.target.entityId || result.target.itemId || result.target.name));
      boundOccurrences.set(at,result.target);
      return result.target;
    }
    function field(key,span) {
      const d = ctx.describeField(kind,key);
      if (!d || d.type === "unavailable" || d.type === "invalid") fail(d?.diagnostic?.code || "field",d?.diagnostic?.message || "Unknown or unavailable field “" + key + "”.",span);
      if(d.id && !ctx.canReadField(d.id))fail("denied","The requested field is unavailable.",span);
      if (d.kinds && kind !== "object" && !d.kinds.some(k => k.toLowerCase() === kind) &&
          !(["resistor","capacitor","inductor","led"].includes(kind) && d.kinds.includes("part"))) fail("field","This field does not apply to " + kind + ".",span);
      deps.add("field:" + (d.id || key));
      if (G.AtriumDesignQueryContext.signalField(d.id || key)) deps.add("derived:signals");
      return d;
    }
    function get(row,key,d) { return valueOf(ctx.fieldValue(row,key,d)); }
    function declaredSample(d) {
      return d.type === "quantity" && d.unit != null ? core().quantity(1,d.unit) : null;
    }
    function typed(value,d) {
      value = valueOf(value);
      if (value == null) return null;
      if (value.dimensions) return value;
      if (typeof value === "number") return core().quantity(value,d.unit || "");
      if (value.unit && Number.isFinite(value.value)) return core().quantity(value.value,value.unit);
      const r = core().parseBoundValue(value,{unit:d.unit || "",fieldUnit:d.unit});
      return r.ok ? r : null;
    }
    function scalar(op, paired) {
      const calc = core(), p = calc.parse(op.source,{predicate:true});
      if (!p.ok) throw {diagnostic:info(p.diagnostic,op.span[0],op.span)};
      const n = p.ast;
      function input(ref) {
        const span=[op.span[0]+ref.span[0],op.span[0]+ref.span[1]];
        const occurrence=record.bindings?.find(b=>b.span[0]===span[0] && b.span[1]===span[1]);
        const declaration=ctx.describeField(kind,ref.name);
        if(occurrence || ref.name.includes(".") && declaration?.type==="undeclared") {
          const r=ctx.scalarField(ref.name,span,occurrence);
          if(r.diagnostic)throw {diagnostic:r.diagnostic};
          references.push({family:"scalar",name:ref.name,span,target:safeTarget(r.target)});
          deps.add("reference:"+r.id);
          return {sample:r.quantity,constant:r.quantity,read:()=>r.quantity};
        }
        const d=field(ref.name,span);
        return {sample:declaredSample(d),declaration:d,read:row=>typed(get(row,ref.name,d),d)};
      }
      if (n.type === "call" && n.id.toLowerCase() === "rule") {
        if (n.args.length !== 1 || !["string","ref"].includes(n.args[0].type)) fail("rule","Choose one typed rule constraint.",op.span);
        const key = n.args[0].name ?? n.args[0].value;
        if (key !== "MinWidth") fail("rule","Unknown effective constraint “" + key + "”.",op.span);
        if (ctx.ruleType === "width" || ctx.resolvingRules?.includes(key)) fail("cycle","The width rule depends on its own winning minimum.",op.span);
        deps.add("rule:" + key);
        let resolve, resolving = false;
        return {sample:calc.quantity(1,"mm"),required:missing("effective rule "+key,op.span),read:row => {
          if (resolving) return null;
          resolving = true;
          try {
            let v = ctx.ruleValue?.(row,key);
            if (v === undefined && ctx.doc?.kind === "pcb" && G.AtriumRules?.resolver) {
              const rules = G.AtriumRules, item = row.item;
              resolve ||= rules.resolver(ctx.doc,{project:ctx.project,defs:ctx.defs});
              if (item?.kind === "track") {
                const [a,b] = item.points ?? [];
                const at = row.at ?? (a && b ? [(a[0]+b[0])/2,(a[1]+b[1])/2] : a);
                v = resolve("width",rules.kit.copperSubject(item,row.part,undefined,at))?.min;
              } else v = resolve("width",row)?.min;
            }
            return typed(v,{unit:"mm"});
          } finally { resolving = false; }
        }};
      }
      if (n.type === "ref" && p.references?.length) {
        return input(p.references[0]);
      }
      if (!p.references?.length) {
        const unit = paired?.type === "quantity" ? paired.unit : undefined;
        const bare = node => node.type === "number" && !node.unit || node.type === "unary" && bare(node.arg) || node.type === "group" && bare(node.child);
        const prepared=calc.compileScalar(p,unit ? {unit} : null);
        if (!prepared.ok) throw {diagnostic:info(prepared.diagnostic,op.span[0],op.span)};
        const inferred = !!unit && prepared.bareLiteral;
        const q=prepared.read();
        if (!q.ok) throw {diagnostic:info(q.diagnostic,op.span[0],op.span)};
        if (inferred) hints.push({code:"inferred-unit",field:paired.id || paired.field,unit,span:op.span});
        if (["polymorphic","undeclared"].includes(paired?.type) && !q.tag && q.dimensions?.every(x => x === 0) && bare(n)) {
          hints.push({code:"declare-unit",field:paired.id || paired.field,span:op.span,owner:paired.owner});
          fail("unit-required","Give this value a unit or declare a unit for the field.",op.span);
        }
        return {sample:q,constant:q,read:() => q};
      }
      // Bind arithmetic inputs once. The calculation core owns operations and dimensional checking.
      const rows = new Map();
      for (const ref of p.references) rows.set(ref.span[0],input(ref));
      const prepared = calc.compileScalar?.(p,null);
      if (!prepared?.ok) fail(prepared?.diagnostic?.code || "scalar-plan",
        prepared?.diagnostic?.message || "A compiled scalar operation is unavailable.",op.span);
      const sample = prepared.read({resolve:ref => rows.get(ref.span[0])?.sample,functions:ctx.functions});
      if (sample?.ok === false && ["dimension","unit"].includes(sample.diagnostic?.code)) fail(sample.diagnostic.code,sample.diagnostic.message,op.span);
      if ([...rows.values()].every(r=>r.constant) && sample.ok) return {sample,constant:sample,read:()=>sample};
      return {sample:sample?.ok === false ? null : sample,read:row => valueOf(prepared.read({functions:ctx.functions,
        resolve:ref => rows.get(ref.span[0])?.read(row)}))};
    }
    function conjunctLayers(node,set) {
      if(node.type==="and")for(const part of node.args)conjunctLayers(part,set);
      else if(node.type==="relation" && node.family==="layer")set.add(node);
    }
    function compileNode(n,positive,inherited=new Set()) {
      if (!n) return () => true;
      if (n.type === "and" || n.type === "or") {
        const and=n.type==="and",layers=new Set(inherited);
        if(and)conjunctLayers(n,layers);
        const fs=n.args.map(a=>compileNode(a,positive && and,layers));
        return row => {
          let v = and;
          for (const f of fs) { v = and ? truthAnd(v,f(row)) : truthOr(v,f(row)); if (v === !and) break; }
          return v;
        };
      }
      if (n.type === "not") {
        const f = compileNode(n.arg,false,inherited);
        return row => { const v = f(row); return typeof v==="boolean" ? !v : v; };
      }
      if (n.type === "relation") {
        const target = bind(n.family,n.name,n.nameSpan);
        deps.add("relation:" + n.family);
        if (positive) terms.push({type:"relation",family:n.family,target:safeTarget(target)});
        return row => ctx.relation(row,n.family,target) ?? null;
      }
      if (n.type === "near") {
        const anchor = bind("anchor",n.name,n.nameSpan), radius = scalar(n.radius);
        if (!radius.constant) fail("geometry","The search radius must be independent of the candidate.",n.radius.span);
        let mm;
        try { mm = core().as(radius.constant,"mm"); } catch { fail("dimension","The radius needs a length.",n.radius.span); }
        if (mm < 0) fail("geometry","The search radius must be nonnegative.",n.radius.span);
        const near = ctx.geometry?.prepareNear?.({anchor,mode:n.mode,radius:mm,kind});
        if (!near?.ok) fail(near?.diagnostic?.code || "geometry",near?.diagnostic?.message || "The required geometry is unavailable.",n.nameSpan);
        deps.add("geometry:" + n.mode);
        for (const key of near.dependencies || []) deps.add(key);
        if (positive && near.bounds) terms.push({type:"spatial",bounds:near.bounds});
        const absent=missing("physical geometry",n.span);
        const layers=[...new Set([...inherited].map(node=>bind("layer",node.name,node.nameSpan).name))];
        measurements.push(Object.freeze({mode:n.mode,basis:near.basis || null,span:n.span,radiusMm:mm,layers:Object.freeze(layers),
          anchor:Object.freeze({id:anchor.id || anchor.itemId,docId:anchor.docId || ctx.doc?.id,instanceId:anchor.instanceId || ctx.instanceId})}));
        if(!layers.length)return row=>near.matches(row) ?? absent;
        return row=>{
          const subjectKind=ctx.kindOf(row);
          if(subjectKind!=="pad" && subjectKind!=="via")return near.matches(row) ?? absent;
          let unmeasured=false;
          for(const layer of layers) {
            const v=near.matches({...row,layer});
            if(v===true)return true;
            if(v==null)unmeasured=true;
          }
          return unmeasured ? absent : false;
        };
      }
      if (n.type === "boolean") {
        if (n.field.toLowerCase() === "true" || n.field.toLowerCase() === "false") return () => n.field.toLowerCase() === "true";
        const d = field(n.field,n.span);
        if (d.type !== "boolean") fail("type","Compare the field with a value.",n.span);
        return row => { const v = get(row,n.field,d); return typeof v === "boolean" ? v : null; };
      }
      const external=n.field?.includes(".") && ctx.describeField(kind,n.field)?.type==="undeclared";
      const d = n.field && !external ? field(n.field,n.left.span) : null;
      if (d && ["text","reference","boolean"].includes(d.type)) {
        const like = n.op.startsWith("like");
        if (d.type === "reference" && !like && n.right.type !== "text") {
          if (!["=","!="].includes(n.op)) fail("type","References support equality comparisons.",n.right.span);
          const family = d.family || d.id || n.field, target = bind(family,n.right.value,n.right.span);
          return row => { const v = ctx.relation(row,family,target); return v == null ? null : n.op === "=" ? v : !v; };
        }
        let value = n.right.value;
        if (d.type === "boolean") {
          if (!/^(true|false)$/i.test(value) || !["=","!="].includes(n.op)) fail("type","Compare a boolean with true or false.",n.right.span);
          value = value.toLowerCase() === "true";
        } else if (n.right.type !== "text") fail("text","Quote the text value.",n.right.span);
        if (positive && n.op === "=") terms.push({type:"exact",key:n.field,value});
        comparisons.push({span:n.span,key:d.id || n.field,sourceKey:n.field,op:n.op,fieldType:d.type,value,rightSpan:n.right.span});
        const apply=operations[n.op];
        const test = like ? glob(value,n.op === "like case") : v => apply(v===value ? 0 : v<value ? -1 : 1);
        return row => { const v = get(row,n.field,d); return typeof v===typeof value ? test(v) : null; };
      }
      if (n.op.startsWith("like")) fail("type","A glob requires a text field.",n.left.span);
      const a = d ? {sample:declaredSample(d),read:row => typed(get(row,n.field,d),d)} : scalar(n.left);
      if (d && (kind==="net" && d.id==="length" || d.requiredMeasurement)) {
        a.required=missing(d.label || n.field,n.left.span);
        deps.add("measurement:"+d.id);
      }
      const b = scalar(n.right,d);
      if (a.sample && b.sample) try { core().compareNominal(a.sample,b.sample); }
        catch(e) { fail(e.diagnostic?.code || "dimension","These quantities have incompatible units.",n.right.span); }
      if (d) comparisons.push({span:n.span,key:d.id || n.field,sourceKey:n.field,op:n.op,fieldType:d.type,unit:d.unit,...(b.constant ? {quantity:b.constant} : {})});
      const apply=operations[n.op],compare=core().compareNominal;
      const widths=kind==="track" && d?.id==="width" && d.source==="builtin" && b.constant ? new Map() : null;
      const compareDeclared = raw => {
        if(widths?.has(raw))return widths.get(raw);
        const result=apply(compare(core().quantity(raw,d.unit),b.constant));
        // Track widths often share a few authored values. The quantity core
        // still owns conversion and nominal comparison at the exact boundary.
        if(widths && widths.size<32)widths.set(raw,result);
        return result;
      };
      if(positive && d && b.constant) {
        const term={type:"range",key:n.field,op:n.op,value:b.constant.value,unit:d.unit};
        terms.push(term);
        ranges.set(term,compareDeclared);
      }
      return row => {
        const raw = widths ? get(row,n.field,d) : null;
        if(widths && Number.isFinite(raw))return compareDeclared(raw);
        const x = widths ? typed(raw,d) : a.read(row), y = b.read(row);
        if (!x || !y) return !x && a.required || !y && b.required || null;
        try { return apply(compare(x,y)); } catch(e) { if(!e.diagnostic)throw e; return null; }
      };
    }
    try {
      if(!ctx.canReadDoc(ctx.doc?.id)) fail("denied","The requested design scope is unavailable.",[0,record.source.length]);
      const test = compileNode(parsed.ast,true);
      if (kind !== "object") { terms.unshift({type:"kind",kind}); deps.add("kind:" + kind); }
      const partKind = ["resistor","capacitor","inductor","led"].includes(kind);
      function acceptsKind(row) {
        if(kind==="object" || row.kind===kind)return true;
        const k = ctx.kindOf(row);
        return k === kind || kind === "part" && ["resistor","capacitor","inductor","led"].includes(k) ||
          partKind && k === "part" && ctx.partType(row) === kind;
      }
      const rowAllowed=row=>ctx.canReadDoc(row.docId || ctx.doc?.id) && (ctx.authority?.canReadItem?.(row.ownerId || row.id,row.docId || ctx.doc?.id) ?? true);
      const evaluate = row => ctx.authority && !rowAllowed(row) ? null : acceptsKind(row) ? test(row) : false;
      const plan = {source:record.source,kind,ast:parsed.ast,references,comparisons,measurements,dependencies:[...deps].sort(),indexTerms:terms,
        signature:JSON.stringify([record,ctx.domain,ctx.schemaRevision || "",ctx.instanceId || ""]),
        acceptsKind,customProviders:!!ctx.customProviders,customFields:!!ctx.customFieldProjection,
        customRelations:!!ctx.customRelationProjection,posting:ctx.posting,rangeAccepts:(term,value)=>ranges.get(term)(value),
        spatial:bounds=>ctx.geometry?.spatial?.(bounds),
        prepareSpatial:options=>ctx.geometry?.prepareSpatial?.(options),evaluate,
        caseValue:(row,key)=>get(row,key,ctx.describeField(kind,key)),fieldAllowed:ctx.canReadField,
        rowAllowed,
        test:row=>asTruth(evaluate(row)),matches:row=>evaluate(row)===true,
        requiredMissing:row=>{const v=evaluate(row);return typeof v==="object" ? v : null;}};
      plan.authorized=()=>ctx.canReadDoc(ctx.doc?.id) && [...deps].every(k=>!k.startsWith("field:") || ctx.canReadField(k.slice(6))) &&
        references.every(r=>ctx.canReadDoc(r.target?.docId) &&
          ctx.canReadItem(r.target?.itemId,r.target?.docId ?? ctx.doc?.id) && (!r.target?.field || ctx.canReadField(r.target.field)));
      const alternatives=new Map();
      plan.caseMatches=(comparison,value,row)=>{
        const [a,b]=comparison.rightSpan,key=JSON.stringify([a,b,value]);
        if(!alternatives.has(key)) {
          if(alternatives.size>=32)return false;
          const quoted=JSON.stringify(value), delta=quoted.length-(b-a);
          const bindings=(record.bindings || []).map(binding=>binding.span[0]>=b ?
            {...binding,span:binding.span.map(offset=>offset+delta)} : binding);
          const source=record.source.slice(0,a)+quoted+record.source.slice(b);
          alternatives.set(key,compile(R.create(source,bindings),ctx).plan);
        }
        return alternatives.get(key)?.matches(row)===true;
      };
      plan.projectRow=(row,fields)=> {
        const out={id:row.id,docId:row.docId || ctx.doc?.id,kind:ctx.kindOf(row)};
        for(const key of ["instanceId","ownerId","pin","padIndex","padId"])if(row[key]!=null)out[key]=row[key];
        if(fields?.length) {
          const values=Object.create(null);
          for(const key of fields)if(ctx.canReadField(key)) {
            const d=ctx.describeField(kind,key),projected=ctx.fieldValue(row,key,d),raw=valueOf(projected);
            const v=d?.type === "quantity" || d?.type === "polymorphic" ? typed(raw,d) : raw;
            if(v?.dimensions) {
              const value={value:v.value,dimensions:v.dimensions.slice(),tag:v.tag || ""};
              const unit=d?.unit ?? projected?.field?.unit ?? v.inputUnit ?? v.unit ?? v.preferred ?? raw?.unit;
              if(unit != null || !v.tag && v.dimensions.every(n=>n===0)) {
                try { Object.assign(value,{unit:unit ?? "",magnitude:core().as(v,unit ?? "")}); }
                catch { /* An incompatible provider unit cannot label the coherent value. */ }
              }
              values[key]=value;
            }
            else if(v==null || ["string","number","boolean"].includes(typeof v))values[key]=v ?? null;
          }
          out.fields=values;
        }
        return out;
      };
      plan.run = (index,options={}) => G.AtriumDesignQueryIndex.run(plan,index,{project:ctx.project,doc:ctx.doc,
        revision:ctx.revision,authority:ctx.authority,signal:ctx.signal,...options});
      for(const a of [references,comparisons,measurements,terms,plan.dependencies,hints])Object.freeze(a);
      const result=Object.freeze({ok:true,diagnostics:Object.freeze([]),hints,plan:Object.freeze(plan)});
      if(plans) {
        if(plans.size>=128)plans.delete(plans.keys().next().value);
        plans.set(cacheKey,result);
      }
      return result;
    } catch (e) {
      if (!e.diagnostic) throw e;
      return {ok:false,diagnostics:[e.diagnostic],hints};
    }
  }
  function context(project,doc,options = {}) { return G.AtriumDesignQueryContext.context(project,doc,options); }
  async function prepare(scope,context={}) {
    const ctx=context.__nativeContext ? context : scopeContext(context);
    const source=typeof scope==="string" ? scope : scope?.source;
    if(typeof scope!=="string" && !R.valid(scope,{allowUnknown:!!ctx.allowUnknown}))return compile(scope,ctx);
    if(!ctx.canReadDoc(ctx.doc?.id) || ctx.signal?.aborted)return {ok:false,hints:[],diagnostics:[{code:ctx.signal?.aborted?"cancelled":"denied",message:"The requested query is unavailable.",span:[0,source?.length || 0]}]};
    const parsed=parse(source);
    if(!parsed.ok)return parsed;
    const modules=new Map();
    function inspect(node) {
      if(!node)return;
      if(node.type==="near" && !ctx.hasGeometryProvider && !G.AtriumDFA) modules.set("AtriumDFA",["checks/rules","checks/dfa"]);
      if(parsed.kind==="net" && node.type==="compare" && node.field?.toLowerCase()==="length" && ctx.canReadField("length") && !G.AtriumLength)
        modules.set("AtriumLength",["pcb/length-tuning"]);
      if(node.arg)inspect(node.arg);
      for(const child of node.args || [])inspect(child);
    }
    inspect(parsed.ast);
    try {
      for(const [name,files] of modules) {
        if(ctx.signal?.aborted)break;
        if(G.AtriumLazy?.need)await G.AtriumLazy.need(name);
        // @ts-ignore CommonJS uses the same geometry and measurement implementations.
        else if(typeof require==="function")for(const file of files)require("../"+file+".js");
      }
    } catch(e) { return {ok:false,hints:[],diagnostics:[{code:"provider",message:"A requested design measurement could not load.",span:[0,source.length]}]}; }
    if(ctx.signal?.aborted)return {ok:false,hints:[],diagnostics:[{code:"cancelled",message:"The query was cancelled.",span:[0,source.length]}]};
    return compile(scope,ctx);
  }
  function count(source,options) { return G.AtriumDesignQueryIndex.count(source,options); }
  // Explicit authoring freezes identities. Normal reads and ephemeral filters never author bindings.
  function bind(input,ctx={},options={}) {
    const compiled=compile(input,ctx);
    if(!compiled.ok)return compiled;
    const initial=typeof input==="string" ? R.create(input) : R.copy(input);
    const bindings=initial.bindings || [],ids=new Set(bindings.map(b=>b.id));
    for(const ref of compiled.plan.references) {
      if(bindings.some(b=>b.span[0]===ref.span[0] && b.span[1]===ref.span[1]))continue;
      const r=ref.target;
      let target;
      if(r?.scope) {
        target={scope:r.scope};
        for(const key of ["projectId","docId","itemId","signalId","entityId","pinId","definitionId","instanceId","parameterId","field"])
          if(typeof r[key]==="string" && r[key])target[key]=r[key];
      } else if(ref.family==="anchor" && r?.id && (r.docId || ctx.doc?.id)) {
        target={scope:"item",docId:r.docId || ctx.doc.id,itemId:r.id};
      } else if(ref.family==="sheet" && (r?.docId || r?.id)) {
        target={scope:"sheet",docId:r.docId || r.id};
      } else if(ref.family==="signal" && r?.signalId)target={scope:"signal",signalId:r.signalId};
      else if(r?.entityId)target={scope:"entity",entityId:r.entityId};
      if(!target)continue;
      if(!target.instanceId && (r.instanceId || ctx.instanceId) && ["sheet","item","terminal"].includes(target.scope))
        target.instanceId=r.instanceId || ctx.instanceId;
      let id=options.newId?.() || "q"+ref.span[0];
      while(ids.has(id))id+="_";
      ids.add(id);bindings.push({id,name:ref.name,span:ref.span.slice(),target});
    }
    const record=R.create(initial.source,bindings);
    return {...compiled,record};
  }
  function caseSuggestions(plan,rows) {
    const choices=plan.comparisons.filter(c=>c.fieldType==="text" && c.op==="=" && plan.indexTerms.some(t=>t.type==="exact" && t.key===c.sourceKey));
    if(!choices.length || !plan.authorized())return [];
    const sought=choices.map(c=>fold(c.value)), found=new Map();
    for(const row of rows) {
      if(!plan.acceptsKind(row) || !plan.rowAllowed(row))continue;
      for(const [i,c] of choices.entries()) {
        const value=plan.caseValue(row,c.sourceKey);
        if(typeof value==="string" && value!==c.value && fold(value)===sought[i] && plan.caseMatches(c,value,row))
          found.set(c.key+"\0"+value,{code:"case-match",field:c.key,value,span:c.rightSpan});
      }
      if(found.size>=4)break;
    }
    return plan.authorized() ? [...found.values()].slice(0,4) : [];
  }
  return Object.freeze({parse,compile,prepare,bind,context,count,countSnapshot:(source,o)=>G.AtriumDesignQueryIndex.countSnapshot(source,o),
    glob,fold,caseSuggestions,unavailable,scope:R.create,validScope:R.valid});
})();
