"use strict";

// Only the typed MCP workspace adapter can supply these completed tool reads.
globalThis.AtriumAIProvidersMCP = (() => {
  const stub = Object.freeze({id:"waffle.stub", label:"Deterministic local test provider", network:false});
  const providers = native => native?.stub === true ? [stub] : [];

  function transport(native, context, policy) {
    if (native?.stub !== true || native.revision !== context.sourceRevision) return null;
    const decision = {
      providers:[stub.id], documents:[context.documentId], objects:context.selection,
      tools:policy.tools,
      fields:globalThis.AtriumAIProviders.resultFields
    };
    return {
      decision,
      provider:(_, request) => {
        const read = request.reads[0];
        if (native.read && !read) return {type:"tools", calls:[native.read]};
        const count = read?.rows.length ?? 0;
        const summary = read?.truncated ? "Verified " + count + " of " + read.total :
          read?.partial ? "Verified at least " + count : "Verified " + count;
        return {type:"answer", text:read ? summary + " tool rows." : "No design reads requested.",
          citations:read?.rows.map(row => row.citation) ?? []};
      },
      async tool(name, args, scope) {
        if (native.failed) throw Error("The approved read could not be completed.");
        if (name !== native.read?.tool || scope.documentId !== native.documentId ||
            JSON.stringify(args) !== JSON.stringify(native.read.args)) return [];
        const authority = {readProject:true,projectId:scope.projectId,documentIds:[scope.documentId]};
        if (name === "query") {
          const result = await globalThis.AtriumQueryService.search(args.scope,{
            project:context.project,documentId:scope.documentId,revision:scope.revision,isCurrent:context.isCurrent,
            enabled:() => context.services.enabled("query"), limit:scope.limit, yieldTask:() => Promise.resolve(),
            authority:{...authority,fields:globalThis.AtriumAIProviders.queryFields}, fields:["id","kind"]
          });
          if (result.status !== "complete" && result.status !== "partial")
            throw Object.assign(Error("The authorized query did not complete."),{code:"permission_denied"});
          return {rows:result.rows,total:result.count,partial:!result.complete};
        }
        if (name === "evaluate_calculation") {
          const result = globalThis.AtriumCalculations.evaluateSnapshot(context.project,{
            documentId:scope.documentId,blockId:args.calculation_id,authority,revision:scope.revision
          });
          return result.records.slice(0,scope.limit).map(row => ({document_id:row.documentId,id:row.blockId,
            status:row.result?.ok === true ? "computed" : "unavailable",value:row.result?.value,unit:row.result?.unit}));
        }
        return native.rows;
      }
    };
  }
  return Object.freeze({providers,transport});
})();
