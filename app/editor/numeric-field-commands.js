"use strict";
// First-party commands for the same field evaluator used by editor controls.
(() => {
  const G = globalThis, N = () => G.AtriumNumericFields;
  const own = (o, field) => Object.hasOwn(o, field);
  const copy = value => JSON.parse(JSON.stringify(value));
  const issue = (code, message, text = "") => ({ok:false, diagnostic:{code, message, span:[0,text.length]}});
  const lengths = new Set(["x", "y", "w", "h", "width", "height", "size", "diameter", "drill", "strokeWidth"]);
  const angles = new Set(["angle", "rotation"]);
  const mm = {unit:"mm", storageUnit:"mm", nanometres:true, max:1e7};
  const ruleLimits = {
    length: f => ({...mm, min:f.signed ? -100 : 0, max:f.signed ? 100 : f.upper ?? mm.max}),
    ps: () => ({unit:"ps", min:0, max:1e6}),
    volts: () => ({unit:"V"}),
    amps: () => ({unit:"A", min:0, max:1000}),
    integer: f => ({unit:"", integer:true, min:f.min, max:f.max})
  };

  function describe(project, target, at) {
    const {owner, field} = at, path = target.path;
    if (at.spec) return at.spec;
    if(owner.kind==="pad" && path.length===1) {
      const spec=G.Atrium.padNumericSpec(field);
      if(spec)return spec;
    }
    if (at.read) return typeof at.unit === "string" ? {unit:at.unit, optional:true} : null;
    if (target.scope === "rule") {
      const type = G.AtriumRules?.types[owner.type];
      const descriptor = type?.fields?.find(f => f.key === (path.length === 1 ? field : path[0]));
      if (path.length === 3 && descriptor && ["lengths","layers","connectTable"].includes(descriptor.kind))
        return {...mm, min:0, optional:true};
      const limits = ruleLimits[descriptor?.kind]?.(descriptor);
      return limits && {...limits, optional:!!descriptor.optional || path.length > 1};
    }
    if (target.scope === "document")
      return path.length === 1 && field === "grid" ? {...mm, ...G.Atrium.units.gridLimits(owner.kind)} : null;
    if (path.length === 1 && field === "value" && owner.kind === "part") {
      const kind = G.AtriumQueryFields?.describe(project,{kind:"part",item:owner,definitionId:owner.def,field});
      return kind?.type === "quantity" ? {unit:kind.unit, textValue:true, allowText:true, optional:true} : null;
    }
    if (path[0] === "parameters" && owner.kind === "part") {
      const name = path.at(-1) === "value" ? at.object.name ?? path.at(-2) : field;
      const kind = G.AtriumQueryFields?.describe(project,{kind:"part",item:owner,definitionId:owner.def,field:name});
      return kind?.type === "quantity" ? {unit:kind.unit, textValue:true, optional:true} : null;
    }
    if (path.length === 3 && path[0] === "widget" && path[1] === "state" && owner.widget?.type === "calculator") {
      const calculator = G.AtriumCalc?.list().find(c => c.id === owner.widget.state.calculator);
      const spec = calculator?.inputs.find(f => f.key === field && field !== "l");
      if (spec) return {unit:spec.unit || "", min:spec.min, max:spec.max};
    }
    if (path.length === 1 && field === "height" && owner.kind === "part" && at.doc.kind === "pcb")
      return {...mm,min:.000001,max:1000,optional:true,omitEmpty:true};
    if (owner.kind === "label" && at.doc.kind === "pcb") {
      if (path.length === 1 && field === "angle") return {unit:"deg",period:360,positiveWrap:true,omitZero:true};
      if (path.length === 1 && field === "size") return {...mm,min:.05,max:1000};
      if (path.length === 1 && field === "width") return {...mm,min:.01,max:1000};
      if (path.length === 1 && field === "lineSpacing" && String(owner.text).includes("\n"))
        return {unit:"",min:.5,max:10};
      if (path.length === 2 && path[0] === "barcode" && owner.font === "barcode") {
        if (field === "quiet") return {unit:"",min:0,max:40,integer:true};
        if (field === "ratio" && owner.barcode.type === "code39") return {unit:"",min:2,max:3};
        if (field === "module" && owner.barcode.type !== "qr") return {...mm,min:.05,max:1000};
      }
    }
    if (path.length === 1 && field === "angle" && owner.kind === "part")
      return {unit:"deg", min:-1e7, max:1e7, period:360};
    if (!Number.isFinite(at.object[field])) return null;
    if (path.length === 1 && lengths.has(field))
      return {...mm, min:["x","y"].includes(field) ? -mm.max : .000001};
    if (path.length === 1 && angles.has(field)) return {unit:"deg", min:-1e7, max:1e7};
    return null;
  }

  async function getTarget(project, target) {
    if (!target || !project) return null;
    await N().prepareTarget(target);
    const at = N().locate(project,target);
    const spec = at && describe(project,target,at);
    return spec ? {at,spec} : null;
  }

  function evalOptions(context, target) {
    return {project:context.project, documentId:target?.documentId || context.documentId,
      signal:context.signal, revision:context.revision};
  }

  async function evaluate(args, context) {
    const {source, target, unit, storageUnit, min, max, integer, optional} = args;
    const known = target && await getTarget(context.project,target);
    if (target && !known) return issue("missing","This numeric field is unavailable.",source);
    const spec = known ? {...known.spec, target, unit:unit ?? known.spec.unit, storageUnit:known.spec.storageUnit ?? known.spec.unit,
      locals:()=>N().geometryLocals(known.at.owner,known.at.doc.id)} :
      {unit, storageUnit, min, max, integer, optional};
    return N().evaluate(source,spec,evalOptions(context,target));
  }

  async function inspect({target}, {project}) {
    const found = await getTarget(project,target);
    if (!found) return issue("missing","This numeric field is unavailable.");
    return {ok:true, target, spec:found.spec, value:N().readValue(found.at) ?? null,
      binding:N().stored(project,target) ?? null, diagnostic:N().issue(project,target) ?? null,
      writable:N().writeAllowed(project,found.at.owner,found.at.doc)};
  }

  function setField(scope, path, object, field, next) {
    const before = own(object,field) ? {before:object[field]} : {};
    const after = next === undefined ? {} : {after:next};
    const changed = Object.keys(before).length !== Object.keys(after).length ||
      JSON.stringify(before.before) !== JSON.stringify(after.after);
    return changed ? [{op:"set", target:scope, path, ...before, ...after}] : [];
  }

  function bind(project, target, entry) {
    const old = project.numericExpressions;
    if (old != null && !Array.isArray(old))
      throw Object.assign(Error("The saved numeric bindings are not readable."),{code:"invalid_binding"});
    const next = (old || []).filter(e => N().key(e?.target) !== N().key(target));
    if (entry) next.push(entry);
    return setField("project",["numericExpressions"],project,"numericExpressions",next.length ? next : undefined);
  }

  function itemOperations(at, target, after, project) {
    const {doc, owner, object, field} = at;
    const identity = {document:doc.id, id:owner.id};
    const move=N().planGeometryMove(project,at,after);
    if (move) {
      if (move.some(({original})=>!N().writeAllowed(project,original,doc)))
        throw Object.assign(Error("The movement would change a locked object."),{code:"read_only"});
      return move.flatMap(({original,next,fields})=>fields.flatMap(key=>
        setField("item",[key],original,key,next[key]).map(op=>({...op,document:doc.id,id:original.id}))));
    }
    if (target.path[0] === "parameters" && Array.isArray(owner.parameters) && target.path[1]?.id) {
      const parameters = owner.parameters.map(p=>p.id === target.path[1].id ? {...p,[field]:after} : p);
      return setField("item",["parameters"],owner,"parameters",parameters).map(op=>({...op,...identity}));
    }
    if (target.path.some(part=>typeof part !== "string"))
      throw Object.assign(Error("This field requires its collection editor."),{code:"unsupported_target"});
    return setField("item",target.path,object,field,after).map(op=>({...op,...identity}));
  }

  function ruleOperation(project, target, at, after) {
    const raw = project.rules.list;
    const replacement = copy(at.owner);
    const next = raw.map(r=>r.id === replacement.id ? replacement : r);
    const address = N().locate({documents:[at.doc], rules:{list:next}},target);
    address.object[address.field] = after;
    G.AtriumProjectRules.validate({...project.rules,list:next});
    return setField("project",["rules","list"],project.rules,"list",next);
  }

  async function set({target, source}, context) {
    const {project} = context, found = await getTarget(project,target);
    const refuse = (code,message) => ({result:issue(code,message,source),ops:[]});
    if (!found) return refuse("missing","This numeric field is unavailable.");
    const {at,spec} = found, before = N().readValue(at), binding = N().stored(project,target);
    if (!N().writeAllowed(project,at.owner,at.doc)) return refuse("read_only","This numeric field is read-only.");
    const result = await N().evaluate(source,{...spec,target,locals:()=>N().geometryLocals(at.owner,at.doc.id)},evalOptions(context,target));
    if (!result.ok) return {result,ops:[]};
    const now = N().locate(project,target);
    if (context.isCurrent?.() === false || !now || now.owner !== at.owner || !Object.is(N().readValue(now),before) ||
        binding !== N().stored(project,target)) return refuse("stale","This numeric field changed during evaluation.");
    if (!N().writeAllowed(project,now.owner,now.doc)) return refuse("read_only","This numeric field is read-only.");
    let diagnostic;
    const candidate = {entry:{target},at,value:result.value};
    N().validateChanges(project,[candidate],null,(_,message)=>{diagnostic=message;});
    if (diagnostic) return refuse("constraint",diagnostic);
    const next = spec.omitZero && result.value === 0 || spec.omitEmpty && result.value === null
      ? undefined : result.marking ?? (spec.textValue && result.value !== null ? String(result.value) : result.value);
    let ops;
    try {
      if (at.plan) ops = at.plan(next);
      else if (at.write) return refuse("unsupported_target","This field requires its collection editor.");
      else if (target.scope === "rule") ops = ruleOperation(project,target,at,next);
      else if (target.scope === "document") ops = setField("document",target.path,at.object,at.field,next).map(op=>({...op,id:at.doc.id}));
      else ops = itemOperations(at,target,next,project);
    } catch (e) {return refuse(e.code || "constraint",e.message);}
    return {result, ops:ops.concat(bind(project,target,result.entry))};
  }

  async function clear({target}, context) {
    const {project} = context, found = await getTarget(project,target);
    if (!found) return {result:issue("missing","This numeric field is unavailable."),ops:[]};
    const {at} = found;
    if (!N().writeAllowed(project,at.owner,at.doc))
      return {result:issue("read_only","This numeric field is read-only."),ops:[]};
    return {result:{ok:true, value:N().readValue(at) ?? null},ops:bind(project,target,null)};
  }

  G.AtriumButter.register("numericFields",{evaluate,inspect,set,clear});
})();
