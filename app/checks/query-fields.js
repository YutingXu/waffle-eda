"use strict";
// Field declarations are independent of query syntax. The notebook owns unit parsing,
// conversion, uncertainty and scalar semantics. Only a bound/compared field can supply units.
globalThis.AtriumQueryFields=(()=>{
  const G=globalThis, core=()=>G.AtriumCalculationCore;
  const own=(o,k)=>o!=null && Object.hasOwn(o,k);
  const lower=s=>String(s ?? "").trim().toLowerCase();
  const unsafe=new Set(["__proto__","prototype","constructor"]);
  const valid=s=>typeof s==="string" && s.length>0 && s.length<=128 && !unsafe.has(lower(s)) && !/[\u0000-\u001f]/.test(s);
  const valueUnits={resistor:"Ω",capacitor:"F",inductor:"H"};
  const catalogue=new Map(), aliases=new Map();
  function add(id,type,unit,label,keys=[id],kinds) {
    const row={id,field:id,type,label,keys,kinds,source:"builtin",...(type==="quantity"?{unit}: {})};
    catalogue.set(lower(id),row); for(const alias of keys)if(!aliases.has(lower(alias)))aliases.set(lower(alias),lower(id));
  }
  add("value","polymorphic",null,"Value",["value"],["part","resistor","capacitor","inductor"]);
  add("power","quantity","W","Power",["power","power rating","rated power"],["part","resistor","capacitor","inductor"]);
  add("voltage","quantity","V","Voltage",["voltage","rated voltage","voltage rating"],["part","resistor","capacitor","inductor","signal","net"]);
  add("tolerance","quantity","%","Tolerance",["tolerance"],["part","resistor","capacitor","inductor"]);
  add("tcr","quantity","ppm/K","Temperature coefficient",["tcr","temperature coefficient","tempco"],["part","resistor","capacitor","inductor"]);
  const geometry=["track","arc","via","pad","hole","fill","region","text","part","component","wire","net","room","polygon","object"];
  for(const id of ["width","length","x","y","diameter","height","clearance"])add(id,"quantity","mm",id[0].toUpperCase()+id.slice(1),[id],geometry);
  add("holeDiameter","quantity","mm","Hole diameter",["holeDiameter","hole","drill","holeSize"],geometry);
  add("rotation","quantity","deg","Rotation",["rotation","angle"],geometry);
  add("qty","quantity","ea","Quantity",["qty","quantity"],["bom","bomRow","row","table"]);
  add("pinCount","quantity","ea","Pin count",["pinCount"],["part","component"]);
  for(const id of ["locked","plated","fitted","dnp","teardrop","paired","hasNet","signalLayer","innerLayer","outerLayer","multilayer","smd","throughHole","inPolygon"])add(id,"boolean",null,id);
  for(const id of ["sheet","layer","signal","net","component","pin"])add(id,"reference",null,id);
  for(const id of ["kind","name","text","comment","description","designator","footprint","side","polarity","pin.number","signal.name","net.name","layer.name","sheet.name","component.designator","packageClass"])
    add(id,"text",null,id,id==="designator"?["designator","ref"]:[id]);
  const unitInfo=u=>core()?.units(u==="m"?"metre":u);
  const family=(item,def)=>G.AtriumNoteFields?.partType?.(item || {},def) || lower(item?.partType);
  const issue=(code,message,span=[0,0],owner)=>({code,message,span,...(owner?{owner}: {})});
  const failed=(code,message,span,owner)=>({ok:false,diagnostic:issue(code,message,span,owner)});
  function parameters(source) {
    return Array.isArray(source)?source.filter(v=>valid(v?.name)).map(v=>({name:v.name,row:v,id:v.id,unit:v.unit,value:v.value})) :
      Object.entries(source || {}).filter(([name])=>valid(name)).map(([name,row])=>({name,row,id:row?.id,unit:row?.unit,value:row && typeof row==="object"?row.value:row}));
  }
  function parameter(source,key,id) {
    return parameters(source).find(v=>id ? v.id===id : lower(v.name)===lower(key));
  }
  function authorized(c,id) {
    const fields=c.allowedFields;
    return !fields || (typeof fields.has==="function"?fields.has(id):Array.isArray(fields) && fields.includes(id));
  }
  function typed(row,unit,source,owner) {
    const info=unitInfo(unit);
    return info?{...row,type:"quantity",unit,dimension:info.dimensions,dimensions:info.dimensions,tag:info.tag || "",source,owner} :
      {...row,type:"invalid",source,owner,diagnostic:issue("unit","Unknown declared unit "+unit+".",[0,0],owner)};
  }
  function describe(project,c={}) {
    const raw=c.field ?? c.key, name=lower(raw);
    if(!valid(raw) || !authorized(c,String(raw)))return {type:"unavailable",id:raw,field:raw};
    const kind=lower(c.kind),item=c.item,def=c.definition || (c.definitionId ? project?.library?.find(d=>d.id===c.definitionId):null);
    const known=catalogue.get(name) || catalogue.get(aliases.get(name));
    if(known) {
      const base={...known,path:known.id.split(".")};
      if(known.id==="value") {
        const part=lower(c.partType || (own(valueUnits,kind)?kind:family(item,def)));
        return own(valueUnits,part)?typed(base,valueUnits[part],"builtin"): {...base,polymorphic:true};
      }
      return known.type==="quantity"?typed(base,known.unit,"builtin"):known.type==="reference"?{...base,family:known.id}:base;
    }
    const row={id:raw,field:raw,label:raw,path:["parameters",raw]}, declarations=[];
    function take(source,scope,context) {
      const p=parameter(source,raw,c.parameterId);
      if(!p)return;
      const owner={scope,...context,name:p.name,...(p.id?{parameterId:p.id}:{})};
      declarations.push({p,owner});
    }
    if(item)take(item.parameters,"placement",{documentId:c.documentId,itemId:item.id});
    if(def)take(def.parameters,"library",{definitionId:def.id});
    // Callers can supply their already authorized library slice for mixed catalogs.
    if(!def && Array.isArray(c.definitions))for(const d of c.definitions)take(d.parameters,"library",{definitionId:d.id});
    take(project?.parameters,"project",{});
    if(c.parameterId && !declarations.length)return {...row,type:"invalid",diagnostic:issue("missing","The declared parameter is unavailable.",[0,0],{parameterId:c.parameterId})};
    const match=declarations.find(x=>typeof x.p.unit==="string" && x.p.unit.trim());
    if(match) {
      const result=typed({...row,sourceField:match.p.name,...(match.p.id?{parameterId:match.p.id}:{})},match.p.unit,match.owner.scope,match.owner);
      if(result.type==="invalid")return result;
      for(const {p,owner} of declarations) {
        if(!p.unit)continue;
        const u=unitInfo(p.unit);
        if(!u || result.tag!==(u.tag || "") || result.dimension.some((v,i)=>v!==u.dimensions[i]))
          return {...row,type:"invalid",owner,diagnostic:issue("declaration-conflict","The unit declared for "+p.name+" conflicts with "+match.p.unit+".",[0,0],owner)};
      }
      return result;
    }
    const owner=declarations.find(r=>r.owner.scope==="library" || r.owner.scope==="project")?.owner || {scope:def?"library":"project",...(def?{definitionId:def.id}:{}),name:raw};
    return {...row,type:"undeclared",owner,source:owner.scope};
  }
  function complete(project,c={}) {
    const kind=lower(c.kind),p=lower(c.prefix), ids=new Set();
    for(const f of catalogue.values())if(!kind || kind==="object" || !f.kinds || f.kinds.some(k=>lower(k)===kind))ids.add(f.id);
    for(const source of [c.item?.parameters,c.definition?.parameters,project?.parameters,...(c.definitions || []).map(d=>d.parameters)])
      for(const r of parameters(source))ids.add(r.name);
    return [...ids].filter(id=>authorized(c,id) && (!p || lower(id).startsWith(p))).map(field=>describe(project,{...c,field}));
  }
  function at(object,key) {
    if(own(object,key))return object[key];
    return key.split(".").reduce((v,k)=>own(v,k)?v[k]:undefined,object);
  }
  function read(subject,field) {
    const item=subject.item || subject, def=subject.definition;
    if(field.parameterId) {
      const bag=field.owner.scope==="placement"?item.parameters:field.owner.scope==="library"?def?.parameters:subject.project?.parameters;
      const source=parameter(bag,field.sourceField,field.parameterId);
      if(!source)return;
      const placed=parameter(item.parameters,source.name);
      return placed?.value ?? source.value;
    }
    for(const key of field.keys || [field.id]) {
      const initial=at(subject,key) ?? at(item,key);
      if(initial!=null && (typeof initial!=="object" || field.type==="reference" || initial.kind==="quantity"))return initial;
    }
    if(field.id==="component.designator")return item.ref ?? subject.component;
    if(field.id==="net.name" || field.id==="sheet.name" || field.id==="layer.name" || field.id==="signal.name") {
      const parent=subject[field.id.split(".")[0]];if(typeof parent==="string")return parent;
    }
    if(field.id==="pin.number")return item.number ?? item.pin;
    if(field.id==="comment")return item.value;
    if(field.id==="pinCount")return Array.isArray(def?.symbol?.pins)?def.symbol.pins.length:undefined;
    for(const source of [item.parameters,def?.parameters,subject.project?.parameters]) {
      for(const k of field.keys || [field.id]) {const p=parameter(source,k);if(p?.value!=null)return p.value;}
    }
  }
  function fieldValue(subject,key,declaration) {
    let field=declaration || describe(subject.project,{...subject,field:key});
    if(field.type==="unavailable" || field.type==="invalid")return {ok:false,field,diagnostic:field.diagnostic};
    if(field.type==="polymorphic" || field.type==="undeclared") {
      field=describe(subject.project,{...subject,item:subject.item || subject,field:key});
    }
    const raw=read(subject,field);
    if(raw==null)return {ok:false,field,missing:true};
    if(["text","boolean","reference"].includes(field.type))return {ok:true,value:raw,field};
    if(raw.kind==="quantity")return {ok:true,quantity:raw,field};
    // Raw component markings (including 4k7) are data, never executable expressions.
    if(Number.isFinite(raw) && field.unit) {
      const quantity=core().quantity(raw,field.unit);
      return {ok:true,field,quantity,value:quantity.value};
    }
    const quantity=core().parseBoundValue(raw,{unit:field.unit || "",...(field.unit?{fieldUnit:field.unit}:{})});
    if(!quantity.ok)return {ok:false,field,diagnostic:quantity.diagnostic};
    if(!field.unit && !quantity.inputUnit && !quantity.tag && quantity.dimensions.every(n=>n===0))return {ok:false,field,missing:true};
    if(field.unit)try{core().as(quantity,field.unit);}catch(e){return {ok:false,field,diagnostic:e.diagnostic};}
    return {ok:true,field,quantity,value:quantity.value};
  }
  function adapt(source,field,options={}) {
    if(field.diagnostic)return {ok:false,diagnostic:{...field.diagnostic,span:options.span || field.diagnostic.span}};
    const result=core().evaluateField(source,field.type==="quantity"?{unit:field.unit}:null,options);
    if(!result.ok) {
      const offset=options.span?.[0] || 0, local=result.diagnostic.span || [0,String(source).length];
      return {ok:false,diagnostic:{...result.diagnostic,span:local.map(v=>v+offset),...(field.owner?{owner:field.owner}:{})}};
    }
    if(["undeclared","polymorphic"].includes(field.type) && !result.inputUnit && !result.tag && result.dimensions.every(n=>n===0))
      return failed("unit-required","Specify a unit for "+field.label+".",options.span || [0,String(source).length],field.owner);
    return {ok:true,quantity:result,field,unit:result.unit};
  }
  function declare(project,field,unit) {
    const owner=field.owner,info=unitInfo(unit);
    if(!project || !valid(owner?.name) || !info || !unit || field.source==="builtin")throw Error("Select a custom parameter and a recognized unit.");
    const entity=owner.scope==="project"?project:owner.scope==="library"?project.library?.find(d=>d.id===owner.definitionId):
      project.documents?.find(d=>d.id===owner.documentId)?.items?.find(i=>i.id===owner.itemId);
    if(!entity)throw Error("The parameter owner is unavailable.");
    const previous=parameter(entity.parameters,owner.name,owner.parameterId);
    if(owner.parameterId && !previous)throw Error("The declared parameter is unavailable.");
    const id=previous?.id || G.Atrium.id(),name=previous?.name || owner.name;
    const meta=previous?.row && typeof previous.row==="object"?previous.row:{value:previous?.value};
    if(Array.isArray(entity.parameters)) {
      const next={...meta,name,id,unit};entity.parameters=previous?entity.parameters.map(r=>r===previous.row?next:r):[...entity.parameters,next];
    }
    else entity.parameters={...entity.parameters,[name]:{...meta,id,unit}};
    return {...owner,name,parameterId:id};
  }
  return Object.freeze({describe,complete,fieldValue,adapt,declare,parameters});
})();
