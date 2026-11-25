"use strict";

globalThis.AtriumAIProvidersDesktop = (() => {
  const G = globalThis;
  const need = name => G.AtriumLazy.need(name);
  const key = (id, name) => "atrium.ai.project." + id + "." + name;
  const volatile = new Map(), generations = new Map(), requests = new WeakMap();
  const policyListeners = new Set();
  let labGeneration = 0;
  const bump = key => {
    generations.set(key, (generations.get(key) ?? 0) + 1);
    for (const check of policyListeners) check();
  };
  G.addEventListener?.("storage", ({key:changed}) => {
    if (changed?.startsWith("atrium.ai.project.")) {
      volatile.delete(changed);
      if (changed.endsWith(".policy")) bump(changed);
    } else if (changed === null) {
      volatile.clear();
      labGeneration++;
      for (const check of policyListeners) check();
    }
  });
  G.AtriumPrefs?.on?.("butter.ai", () => {
    labGeneration++;
    for (const check of policyListeners) check();
  });

  function local(id, name, value) {
    const at = key(id, name);
    if (value !== undefined) {
      const encoded = JSON.stringify(value);
      try { G.localStorage.setItem(at, encoded); volatile.delete(at); }
      catch { volatile.set(at, encoded); }
      if (name === "policy") bump(at);
      return value;
    }
    try { return JSON.parse(volatile.get(at) ?? G.localStorage.getItem(at) ?? "null") ?? undefined; }
    catch { return undefined; }
  }
  const providers = () => G.AtriumExtensions?.providersAI() ?? [];
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key,value[key]]));

  function transport(context, policy, providerId) {
    const host = G.AtriumNavHost, project = host?.project(), documentId = context.documentId;
    if (!project || project.id !== context.project.id) return null;
    const doc = project.documents.find(doc => doc.id === documentId);
    if (!doc) return null;
    const policyKey = key(project.id, "policy"), generation = generations.get(policyKey);
    const lab = labGeneration, permission = G.AtriumExtensions?.permissionAI(providerId);
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && context.isCurrent() && host.project() === project &&
      generations.get(policyKey) === generation && labGeneration === lab && permission?.current() === true;
    function check() { if (!isCurrent()) controller.abort(); }
    const folder = host.folderProject?.();
    const mayPropose = policy.proposeEdits && permission?.proposals === true;
    const binding = {folder, current:() => isCurrent() && host.folderProject?.() === folder, savedDigest:null};
    requests.set(context.isCurrent, binding);
    policyListeners.add(check);
    const unsubscribe = ["selection","document","change","replace","folder-owner"].map(event => host.on?.(event, check));
    unsubscribe.push(permission?.onChange(check));
    function close() { policyListeners.delete(check); for (const off of unsubscribe) off?.(); }
    const selection = (context.selection ?? []).slice(0,8).filter(id => doc.items.some(item => item.id === id));
    const sources = ["erc","drc"].filter(source => policy.tools.includes("run_" + source));
    const findingCounts = sources.length ? G.AtriumChecks?.summary({docs:[documentId],sources}) : null;
    return {
      close,
      async prepare() {
        if (mayPropose && folder && !folder.temporary)
          binding.savedDigest = await folder.verifySavedVersion({purpose:"proposal",signal:controller.signal}).catch(() => {
            throw Object.assign(Error("The saved folder could not be verified. Start a fresh request."),{code:"stale_source"});
          });
      },
      decision:{providers:permission ? [providerId] : [],documents:[documentId],objects:selection,tools:policy.tools,
        fields:G.AtriumAIProviders.resultFields,current:isCurrent,
        findingCounts,mayPropose:() => mayPropose},
      provider:(id, data) => G.AtriumExtensions.askAI(id, data, isCurrent, controller.signal),
      async tool(name, args, scope) {
        if (!isCurrent() || scope.documentId !== documentId || !policy.tools.includes(name)) throw Error("The read grant changed.");
        switch (name) {
          case "query": {
            const service = await need("AtriumQueryService");
            const result = await service.search(args.scope,{project,documentId,revision:scope.revision,
              enabled:() => G.AtriumPrefs?.get("butter.query") === true, limit:scope.limit, isCurrent,
              authority:{readProject:true,projectId:project.id,documentIds:[documentId],fields:G.AtriumAIProviders.queryFields},
              fields:["id","kind"]});
            if (result.status !== "complete" && result.status !== "partial") throw Error("The authorized query did not complete.");
            return {rows:result.rows,total:result.count,partial:!result.complete};
          }
          case "inspect_component": {
            const part = doc.items.find(row => row.id === args.component_id && row.kind === "part");
            return part ? [{document_id:documentId,...pick(part,["id","kind","ref","value","x","y","angle"])}] : [];
          }
          case "run_erc": {
            const engine = await need("AtriumERC");
            const analysis = engine.run(await host.requireProjectClosure({purpose:"erc", signal:controller.signal, assets:false}));
            if (analysis.complete === false) throw Error("The electrical rule check was incomplete.");
            const findings = analysis.messages.filter(row => row.documentId === documentId && row.check !== "summary");
            return {total:findings.length, rows:findings.slice(0,scope.limit).map(row => ({
              document_id:documentId,object_id:row.objectId,class:row.class,rule:row.check
            }))};
          }
          case "run_drc": {
            if (doc.kind !== "pcb") return [];
            const engine = await need("AtriumDRC"), rules = G.AtriumRules.stored(doc, project) || G.AtriumRules.defaults();
            return engine.run(doc,host.defs(),rules,{limit:scope.limit,project}).violations.slice(0,scope.limit)
              .map(row => ({document_id:documentId,id:row.id,rule:row.ruleName,actual:row.actual,required:row.required}));
          }
          case "evaluate_calculation": {
            const engine = await need("AtriumCalculations");
            const data = engine.evaluateSnapshot(project, {documentId, blockId:args.calculation_id, revision:scope.revision,
              authority:{readProject:true,projectId:project.id,documentIds:[documentId]}});
            return data.records.filter(row => row.documentId === documentId && row.blockId === args.calculation_id)
              .slice(0,scope.limit).map(row => ({document_id:documentId,id:row.blockId,
                status:row.result?.ok === true ? "computed" : "unavailable",value:row.result?.value,unit:row.result?.unit}));
          }
          case "compare_revisions": {
            await need(["AtriumRevisions","AtriumDiff"]);
            const comparison = G.AtriumRevisions.headless("compare_revisions",project,args);
            return [{kind:"revision-comparison", identical:comparison.identical}];
          }
          case "list_library": {
            const rows = [], query = args.query.toLowerCase();
            for (const item of project.library) {
              if (!item.name.toLowerCase().includes(query)) continue;
              rows.push({id:item.id,name:item.name,footprint:item.footprint?.name});
              if (rows.length === scope.limit) break;
            }
            return rows;
          }
          case "project_history": {
            await need("AtriumGitPicker");
            const data = await G.AtriumGit.q("projectLog",{limit:scope.limit,skip:0});
            return (data.commits ?? []).slice(0,scope.limit).map(row => ({kind:"revision",id:row.revision}));
          }
          default: throw Error("This AI tool is unavailable.");
        }
      }
    };
  }

  async function credential(provider, operation) {
    const account = G.AtriumExtensions?.credentialAI(provider,operation), host = G.AtriumHost;
    if (!account || !host?.aiCredential) return {available:false};
    try {
      const result = await host.aiCredential(operation, account);
      const limit = Number.isSafeInteger(result?.maxBytes) && {maxBytes:result.maxBytes};
      if (result?.available === false) return {available:false,...limit};
      if (result?.cancelled) return {available:true,cancelled:true};
      if (operation === "forget" || operation === "configure" && result?.configured === true)
        G.AtriumExtensions.rememberCredentialAI(provider,account,operation);
      return {available:true,configured:result?.configured === true,...limit};
    } catch { return {available:false}; }
  }
  return Object.freeze({local,providers,transport,credential,requestBinding:current => requests.get(current)});
})();
