"use strict";

if (globalThis.AtriumButter) {
  const G = globalThis, service = G.AtriumQueryService;
  function options(args, context) {
    const host = context.source === "editor" ? G.AtriumNavHost : null;
    const live = host?.project()?.id === context.project.id ? host.project() : null;
    return {
      project:live ?? context.project, revision:context.sourceRevision ?? context.revision, isCurrent:context.isCurrent, signal:context.signal,
      enabled:() => context.services.enabled("query"),
      ...(live ? {store:G.AtriumUndoStore,getRevision:host.revision} : {}),
      ...(context.source === "mcp" || !G.document ? {yieldTask:() => Promise.resolve()} : {}),
      documentId:args.documentId, instanceId:args.instanceId, fields:args.fields, cursor:args.cursor, limit:args.limit,
      suggestions:args.suggestions,
    };
  }
  const query = a => (a.source == null) === (a.savedQueryId == null) ? null :
    a.source ?? {savedQueryId:a.savedQueryId};
  const run = method => (args,c) => service[method](query(args),options(args,c));
  G.AtriumButter.register("query",{
    async plan(args,c) {
      const result = await service.plan(query(args),options(args,c));
      if (!result.complete) return result;
      return {...result,plans:result.plans.map(({documentId,plan,hints}) => ({documentId,kind:plan.kind,hints,
        dependencies:plan.dependencies,comparisons:plan.comparisons,measurements:plan.measurements,references:plan.references,
      }))};
    },
    search:run("search"),
    count:run("count"),
    "list-saved":(a,c) => service.list(options(a,c)),
    "get-saved":(a,c) => service.get(a.id,options(a,c)),
    "save-query":(a,c) => service.save({id:a.id,name:a.name,query:a.source,scope:a.scope,columns:a.columns},options(a,c)),
    "delete-saved":(a,c) => service.remove(a.id,options(a,c)),
    "rule-applicability":(a,c) => service.applicability(a.id,options({...a,documentId:a.documentId ?? c.documentId},c)),
  });
}
