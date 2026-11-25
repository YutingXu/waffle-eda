"use strict";

globalThis.AtriumTableQuery = (() => {
  const G=globalThis,T=G.AtriumTableData;
  const liveTables=new WeakMap();
  const rowId=row=>"q"+G.AtriumSourceFile.sha256(new TextEncoder().encode(JSON.stringify([
    row.documentId??row.docId,row.kind,row.ownerId??null,row.id,row.instanceId??null,row.pin??null])));
  function definition(scope,documentId,fields,s) {
    if(!(T.savedQueryScope(scope) || G.AtriumDesignQueryRecord.valid(scope))||typeof documentId!=="string"||!documentId ||
      !Array.isArray(fields)||!fields.length||fields.length>32 || new Set(fields.map(f=>f.columnId)).size!==fields.length ||
      fields.some(f=>!T.index(s).columns.has(f.columnId)||typeof f.field!=="string"||!f.field||f.field.length>128))
      throw Error("Choose a document, a valid query and distinct table columns.");
    return {scope,documentId,fields:fields.map(({field,columnId})=>({field,columnId}))};
  }
  function failure(code,message) { return {complete:false,diagnostic:{code,message}}; }
  async function queryService(options) {
    const enabled = options.queryEnabled ?? (() => G.AtriumPrefs?.get("butter.query") === true);
    if (!(typeof enabled === "function" ? enabled() : enabled === true))
      return failure("disabled","Enable Butter design queries to use a saved query.");
    const service = G.AtriumQueryService ?? (G.AtriumLazy?.modules().includes("AtriumQueryService") ?
      await G.AtriumLazy.need("AtriumQueryService") : null);
    return service ? {service,enabled} : failure("missing-queries","The saved query service is unavailable.");
  }
  function savedQuery(ready,id,documentId,options) {
    const found = ready.service.get(id,{...options,enabled:ready.enabled});
    if (!found.complete) return found;
    return found.record.scope.documentId && found.record.scope.documentId !== documentId ?
      failure("query-scope","The saved query belongs to a different document.") : found;
  }
  async function author(s,{project,documentId,source,savedQueryId,fields,...options}) {
    const doc=project.documents.find(d=>d.id===documentId);
    if(!doc)return {ok:false,diagnostics:[{code:"missing-document",message:"The query document is unavailable."}]};
    if (savedQueryId) {
      const ready = await queryService(options);
      if (!ready.service) return {ok:false,diagnostics:[ready.diagnostic]};
      const result = savedQuery(ready,savedQueryId,documentId,{...options,project});
      if (!result.complete) return {ok:false,diagnostics:[result.diagnostic]};
      return {ok:true,query:definition({savedQueryId},documentId,fields,s)};
    }
    const record=s.query?.documentId===documentId && s.query.scope.source===source ? s.query.scope : {languageVersion:1,source};
    const api=G.AtriumDesignQuery,ctx=api.context(project,doc,{...options,project,doc});
    const prepared=await api.prepare(record,ctx);if(!prepared.ok)return prepared;
    const bound=api.bind(record,ctx);if(!bound.ok)return bound;
    return {ok:true,query:definition(bound.record,documentId,fields,s)};
  }
  function value(v) {if(v==null)return "";if(typeof v!=="object")return String(v);
    const magnitude=v.magnitude??v.value;
    if(Number.isFinite(magnitude))return [magnitude,v.unit||""].join(" ").trim();return "";}
  async function authoredMatches(q,doc,fields,options) {
    const api=G.AtriumDesignQuery;
    const ctx=api.context(options.project,doc,options),checked=await api.prepare(q.scope,ctx);
    if(!checked.ok)return {complete:false,diagnostic:checked.diagnostics[0]};
    if(fields.some(key=>!ctx.describeField(checked.plan.kind,key)))return {complete:false,diagnostic:{code:"field",message:"A selected query column is unavailable."}};
    const index=await G.AtriumDesignQueryIndex.documentIndex(options.project,doc,ctx,checked.plan,options);
    if(index.diagnostic)return index;
    options.onProjection?.({doc,plan:checked.plan,context:ctx});
    return checked.plan.run(index,{...options,fields,limit:1000});
  }
  async function savedMatches(q,doc,fields,options) {
    const ready = await queryService(options);
    if (!ready.service) return ready;
    if (typeof ready.service.materialize !== "function")
      return failure("missing-queries","This reader cannot materialize a saved query table.");
    const found = savedQuery(ready,q.scope.savedQueryId,doc.id,options);
    if (!found.complete) return found;
    return ready.service.materialize(q.scope,{...options,documentId:doc.id,fields,limit:1000,enabled:ready.enabled});
  }
  async function refresh(s,{project,authority,revision,signal,isCurrent,defs,...opts}) {
    const q=s.query,doc=project.documents.find(d=>d.id===q?.documentId);
    if(!doc)return failure("missing-document","The query document is unavailable.");
    definition(q.scope,doc.id,q.fields,s);
    const options={...opts,project,doc,defs,authority,revision,signal,isCurrent};
    const fields=[...new Set(q.fields.map(f=>f.field))];
    const hits=await (T.savedQueryScope(q.scope) ? savedMatches(q,doc,fields,options) : authoredMatches(q,doc,fields,options));
    if(!hits.complete || hits.unknown || hits.rows.length!==hits.count)return {complete:false,diagnostic:hits.diagnostic ||
      {code:hits.unknown?"measurement":"limit",message:hits.unknown?"Some query measurements are unavailable.":"Refine this query to at most 1,000 rows."}};
    const old=new Map(s.rows.filter(r=>r.object).map(r=>[r.id,r])),rows=[],changes=[],fresh=new Set();
    if(authority?.canReadItem && [...old.values()].some(r=>!authority.canReadItem(r.object.ownerId??r.object.itemId,r.object.documentId)))
      return {complete:false,diagnostic:{code:"denied",message:"The saved query rows are unavailable in this scope."}};
    for(const hit of hits.rows){
      const id=rowId(hit),prior=old.get(id),row={...prior,id,object:{documentId:hit.documentId??hit.docId,itemId:hit.id,kind:hit.kind,
        ...(hit.ownerId?{ownerId:hit.ownerId}:{}),...(hit.instanceId?{instanceId:hit.instanceId}:{}),...(hit.pin!=null?{pin:hit.pin}:{})}};
      delete row.removed;rows.push(T.equal(prior,row)?prior:row);fresh.add(id);
      for(const {columnId,field} of q.fields){
        const text=value(hit.fields?.[field]),before=T.get(s,id,columnId)?.content;
        if(before?.kind==="literal" ? before.text!==text : before || text)
          changes.push({rowId:id,columnId,content:{kind:"literal",text}});
      }
    }
    for(const row of old.values())if(!fresh.has(row.id))rows.push(row.removed?row:{...row,removed:true});
    const ordinary=s.rows.filter(r=>!r.object && !r.queryEmpty);
    if(old.size || s.rows.some(r=>r.queryEmpty))rows.push(...ordinary);
    else if(ordinary.length){
      const authoredRows=new Set(s.cells.map(cell=>cell.rowId));
      rows.push(...ordinary.filter(r=>authoredRows.has(r.id)));
    }
    if(!rows.length)rows.push(s.rows.find(r=>r.queryEmpty) || {id:s.rows[0].id,queryEmpty:true});
    let state=s;
    if(rows.length!==s.rows.length || rows.some((row,i)=>row!==s.rows[i])){
      const indices=new Map(rows.map((r,i)=>[r.id,i]));
      const removed=s.rows.some(r=>!indices.has(r.id));
      // A query can insert or reorder an object inside a previously rectangular
      // selection. Keep all cell data and retain only merges that still fit.
      const merges=s.merges.filter(m=>{
        const first=indices.get(m.rows[0]);
        return first!==undefined && m.rows.every((id,i)=>indices.get(id)===first+i);
      });
      state={...s,rows,headerRows:Math.min(s.headerRows,rows.length),
        cells:removed?s.cells.filter(c=>indices.has(c.rowId)):s.cells,merges};
    }
    if(changes.length)state=T.batch(state,changes);
    if(state!==s)T.validate(state);
    return {complete:true,count:hits.count,removed:rows.filter(r=>r.removed).length,state};
  }
  function projected(s,{project,host,revision}) {
    let entries=liveTables.get(project);
    if(!entries)liveTables.set(project,entries=new WeakMap());
    const enabled=G.AtriumPrefs?.get("butter.query")===true, prior=entries.get(s);
    if(prior?.host===host && prior.enabled===enabled && (prior.revision===revision || prior.current?.()))return prior.result;
    const getRevision=()=>host.revision();
    const isCurrent=()=>host.project()===project && getRevision()===revision && G.AtriumPower?.visible()!==false;
    const checks=[],fields=s.query.fields.map(f=>f.field);
    const onProjection=({doc,plan,context})=>checks.push(
      G.AtriumDesignQueryIndex.localProjectionCurrent?.(project,doc,plan,fields,context) || null);
    const result=refresh(s,{project,revision,defs:host.defs?.(),getRevision,isCurrent,onProjection});
    const entry={host,revision,enabled,result};
    entries.set(s,entry);
    const discard=()=>{if(entries.get(s)===entry)entries.delete(s);};
    result.then(outcome=>{
      if(!isCurrent() || ["stale","cancelled"].includes(outcome.diagnostic?.code))discard();
      else if(outcome.complete && checks.length && checks.every(Boolean))entry.current=()=>checks.every(check=>check());
    },discard);
    return result;
  }
  function clearRemoved(s) {
    const removed=new Set(s.rows.filter(r=>r.removed).map(r=>r.id));
    if(!removed.size)return s;
    const rows=s.rows.filter(r=>!removed.has(r.id));
    if(!rows.length)rows.push({id:G.Atrium.id(),queryEmpty:true});
    return T.validate({...s,rows,headerRows:Math.min(s.headerRows,rows.length),cells:s.cells.filter(c=>!removed.has(c.rowId)),merges:s.merges.filter(m=>!m.rows.some(r=>removed.has(r)))});
  }
  return Object.freeze({author,definition,refresh,projected,clearRemoved,rowId});
})();
if(typeof module!=="undefined")module.exports=globalThis.AtriumTableQuery;
