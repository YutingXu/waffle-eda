"use strict";
// The lazy read bridge used by the editor, palette and frozen output consumers.
// Authored calculations and edits are owned by AtriumCalculationSheet.
globalThis.AtriumCalculations = (() => {
  const G = globalThis;
  const graph = () => G.AtriumCalculationGraph;
  const design = () => G.AtriumCalculationDesign;
  const sessions = new WeakMap(), attached = new WeakSet(), extensions = new WeakSet(), answers = new Map();
  const emptyProject = {documents: [], library: []};
  const noStats = {visited: 0, evaluated: 0, cyclic: 0};
  let pool, serial = 0, generation = 0;
  const abort = () => Object.assign(Error("Calculation cancelled."), {name: "AbortError"});
  const isAbort = e => e?.name === "AbortError" || e?.cancelled;
  const issue = (code, message, span) => ({code, message, span});
  const denied = span => issue("denied","The requested design data is unavailable.",span);
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const id = () => G.Atrium?.id?.() || "calculation-" + ++serial;
  const acceptsPaletteText = (text, context) => !!G.AtriumCalculationIntent?.acceptsPaletteText(text, context);
  const hasBlocks = project => (project?.documents || []).some(d => d.kind === "schematic" &&
    d.items?.some(i => i?.kind === "calculation" || i?.kind === "textframe" && i.calculation != null));
  const hostOf = (project, host) => host || (G.AtriumNavHost?.project?.() === project ? G.AtriumNavHost : null);
  const normalizedRegistry = definitions => definitions instanceof Map ? Object.fromEntries(definitions) :
    Array.isArray(definitions) ? Object.fromEntries(definitions.map(d => [d.id, d])) : definitions || {};
  const revisionOf = (host, revision) => revision ?? host?.revision?.() ?? "snapshot-" + ++serial;

  function source() {
    if (G.AtriumCalculationWorkerSource) return G.AtriumCalculationWorkerSource;
    const base = G.document?.baseURI || G.location?.href;
    return "globalThis.AtriumCalculationWorkerBase = " + JSON.stringify(base) + ";\n" +
      "importScripts(" + JSON.stringify(new URL("workers/calculation-worker.js", base).href) + ");";
  }

  function request(task, signal) {
    if (signal?.aborted) return Promise.reject(abort());
    // File documents have opaque origins in some browser hosts. The same
    // worker modules are bundled for those hosts, without changing CSP.
    if (G.location?.protocol === "file:" && !G.AtriumCalculationWorkerSource) {
      return G.AtriumLazy.need("AtriumCalculationWorkerSource").then(() => request(task, signal));
    }
    if (!G.AtriumWorkerPool) return Promise.resolve().then(() => {
      if (signal?.aborted) throw abort();
      return graph().task(task);
    });
    pool ||= G.AtriumWorkerPool.get("calculations", source, {size: 1, watchdogMs: 5000, crash: "fail"});
    const work = pool.run(task);
    const cancel = () => work.cancel?.();
    signal?.addEventListener?.("abort", cancel, {once: true});
    return work.catch(e => { if (isAbort(e)) throw abort(); throw e; })
      .finally(() => signal?.removeEventListener?.("abort", cancel));
  }

  function current(project, host, revision, signal) {
    if (signal?.aborted || host && (host.project?.() !== project || host.revision?.() !== revision)) throw abort();
  }
  function allowedPlan(model,project,o,task) {
    if (!o.authority) return true;
    return design().readable(project,o.authority,o.documentId) && task.nodes.every(n=>
      design().readable(project,o.authority,n.documentId) && n.references.every(r=>r.diagnostic?.code!=="denied" && (!r.target || model.allowed(r.target))));
  }
  const hiddenSnapshot=revision=>({revision,records:[],stats:noStats,diagnostic:denied([0,0])});

  // Keep query plans, grants and design objects out of the arithmetic worker.
  // Equal queries in the same occurrence and revision share one authorized read.
  function countReads(task, project, o) {
    const reads = new Map();
    for (const node of task.nodes) for (const query of graph().countQueries(node.source)) {
      const key = JSON.stringify([node.documentId,node.instanceId,query.source]);
      let read = reads.get(key);
      if (!read) {
        const context = {project, documentId:node.documentId, instanceId:node.instanceId, revision:o.revision, signal:o.signal};
        if (o.authority !== undefined) context.authority = o.authority;
        if (o.host) context.isCurrent = revision => o.host.project()===project && o.host.revision()===revision;
        read = {source:query.source, context, targets:[]}; reads.set(key,read);
      }
      read.targets.push([node,query.span[0]]);
    }
    return reads;
  }
  function acceptCount(read, receipt) {
    const failure = receipt?.diagnostic || receipt?.diagnostics?.[0] || (receipt?.code ? receipt : null);
    const count = receipt?.count;
    let value;
    if (failure?.code === "denied" || receipt?.status === "denied") value = {diagnostic:issue("denied","The requested design query is unavailable.")};
    else if (receipt?.revision != null && receipt.revision !== read.context.revision)
      value = {diagnostic:issue("stale","The design revision changed before counting finished.")};
    else if (!failure && (!receipt?.status || receipt.status==="complete") && receipt?.complete === true && Number.isSafeInteger(count) && count >= 0) value = count;
    else value = {diagnostic:issue(failure?.code || receipt?.status || "query-incomplete",failure?.message || "A complete design query count is required.",failure?.span)};
    for (const [node,start] of read.targets) (node.counts ||= {})[start] = value;
  }
  async function runGraph(task, project, o) {
    const reads = countReads(task,project,o);
    if (reads.size) {
      let query = G.AtriumDesignQuery;
      if (!o.countQuery && !query && G.AtriumLazy?.modules?.().includes("AtriumDesignQuery")) query = await G.AtriumLazy.need("AtriumDesignQuery");
      const count = o.countQuery || query?.count;
      for (const read of reads.values()) {
        current(project,o.host,o.revision,o.signal);
        try {
          const context = o.onCountPlan ? {...read.context,onPlan:o.onCountPlan} : read.context;
          acceptCount(read,await count?.(read.source,context));
        }
        catch (e) {
          if (isAbort(e) || o.signal?.aborted) throw abort();
          acceptCount(read,{diagnostic:e?.diagnostic});
        }
      }
      current(project,o.host,o.revision,o.signal);
    }
    return request(task,o.signal);
  }
  function frozenGraph(task, project, o) {
    const count = o.countSnapshot || G.AtriumDesignQuery?.countSnapshot;
    for (const read of countReads(task,project,o).values()) {
      current(project,null,o.revision,o.signal);
      try { acceptCount(read,count?.(read.source,read.context)); }
      catch (e) { if (isAbort(e)) throw e; acceptCount(read,{diagnostic:e?.diagnostic}); }
    }
    current(project,null,o.revision,o.signal);
    return graph().task(task);
  }

  function registryOf(o) {
    if (o.functions) return normalizedRegistry(o.functions);
    const ext = G.AtriumExtensionPalette;
    if (ext && !extensions.has(ext)) {
      extensions.add(ext);
      ext.onMathFunctionsChanged?.(() => {
        const host = G.AtriumNavHost, project = host?.project?.(), s = project && sessions.get(project);
        if (!s) return;
        supersede(s);
        notify(s, project, host);
      });
    }
    return normalizedRegistry(ext?.mathFunctions?.());
  }

  function settle(job, error, result) {
    for (const waiter of job.waiters) {
      waiter.signal?.removeEventListener("abort", waiter.cancel);
      if (error) waiter.reject(error);
      else waiter.resolve(result);
    }
    job.waiters.clear();
  }

  function cancelBatch(batch) {
    if (!batch) return;
    batch.controller.abort();
    for (const j of batch.jobs.values()) settle(j, abort());
  }

  function supersede(s) {
    cancelBatch(s.running);
    cancelBatch(s.waiting);
    s.running = s.waiting = null;
    s.ready.clear();
    s.revision = undefined;
  }

  function attach(host) {
    if (!host || attached.has(host)) return;
    attached.add(host);
    let old = host.project?.();
    function edit() {
      const next = host.project?.();
      const revision = host.revision?.();
      const s = sessions.get(old);
      if (s && (old !== next || s.revision !== revision)) supersede(s);
      for (const [key, answer] of answers) {
        if (answer.host === host && (answer.project !== next || answer.value.projectRevision !== revision)) answers.delete(key);
      }
      old = next;
    }
    host.on?.("change", edit);
    host.on?.("replace", edit);
  }

  function session(project, host) {
    let s = sessions.get(project);
    if (!s) {
      s = {model: design().create(project, host ? G.AtriumUndoStore : null), listeners: new Set(), ready: new Map()};
      sessions.set(project, s);
    }
    if (host) attach(host);
    return s;
  }

  function prepare(project, host, revision, functions) {
    const s = session(project, host);
    const key = design().registryKey(functions);
    if (s.revision !== revision || s.functions !== key) {
      supersede(s);
      s.revision = revision;
      s.functions = key;
      s.model.sync(revision, functions);
    }
    return s;
  }

  function ready(s, snapshot) {
    let changed = false;
    for (const r of snapshot.records) {
      const key = graph().keyOf(r.documentId, r.blockId, r.instanceId), old = s.ready.get(key);
      if (!old || old.result !== r.result || old.assertions.some((a, i) => a.result !== r.assertions[i]?.result)) changed = true;
      s.ready.set(key, r);
    }
    return changed;
  }

  function notify(s, project, host) {
    s.generation = ++generation;
    if (host?.project?.() === project) G.AtriumChecks?.scheduler?.plan?.("erc", {now:true});
    for (const fn of s.listeners) {
      try { fn(s.revision); } catch (e) { G.console?.error?.(e); }
    }
  }

  async function flush(s, project, host) {
    if (s.running || !s.waiting) return;
    const batch = s.running = s.waiting;
    s.waiting = null;
    const {revision, controller} = batch;
    try {
      current(project, host, revision, controller.signal);
      const plans = [], roots = new Set(), nodes = new Map(), known = new Map();
      let functions;
      for (const job of batch.jobs.values()) {
        if (!job.waiters.size) continue;
        const {request: r, selection} = s.model.plan(job.options);
        for (const root of r.roots) roots.add(root);
        for (const node of r.nodes) nodes.set(node.key, node);
        for (const [key, v] of r.known) known.set(key, v);
        functions = r.functions;
        plans.push({job, selection});
      }
      const response = nodes.size ? await runGraph({operation: "graph", roots: [...roots], nodes: [...nodes.values()], known: [...known], functions}, project,
        {...plans[0].job.options,host,revision,signal:controller.signal})
        : {changed: [], stats: noStats};
      current(project, host, revision, controller.signal);
      if (s.running !== batch) throw abort();
      s.model.accept(response);
      let changed = false;
      for (const {job, selection} of plans) {
        const snapshot = s.model.snapshot(selection, response.stats, revision);
        changed = ready(s, snapshot) || changed;
        settle(job, null, snapshot);
      }
      if (changed) notify(s, project, host);
    } catch (error) {
      for (const job of batch.jobs.values()) settle(job, error);
    } finally {
      if (s.running === batch) s.running = null;
      queueMicrotask(() => flush(s, project, host));
    }
  }

  function evaluate(project, o = {}) {
    const host = hostOf(project, o.host), revision = revisionOf(host, o.revision);
    try { current(project, host, revision, o.signal); }
    catch (e) { return Promise.reject(e); }
    if (!project) return Promise.resolve({revision, records: [], stats: noStats});
    if (o.authority !== undefined || o.countQuery) {
      // Independently authorized requests never share the editor’s warm graph or result cache.
      const model = frozenModel(project,{...o,revision}), plan = model.plan(o);
      if (!allowedPlan(model,project,o,plan.request)) return Promise.resolve(hiddenSnapshot(revision));
      return runGraph(plan.request,project,{...o,host,revision}).then(response => {
        current(project,host,revision,o.signal);
        if (!allowedPlan(model,project,o,plan.request)) return hiddenSnapshot(revision);
        model.accept(response);
        return model.snapshot(plan.selection,response.stats,revision);
      });
    }
    const s = prepare(project, host, revision, registryOf(o));
    const key = JSON.stringify([o.documentId, o.blockId, o.instanceId]);
    let batch = s.running?.jobs.has(key) && !s.running.controller.signal.aborted ? s.running : s.waiting;
    if (batch?.controller.signal.aborted) batch = null;
    if (!batch) {
      batch = s.waiting = {revision, controller: new AbortController(), jobs: new Map()};
      queueMicrotask(() => flush(s, project, host));
    }
    let job = batch.jobs.get(key);
    if (!job) { job = {options: o, waiters: new Set()}; batch.jobs.set(key, job); }
    return new Promise((resolve, reject) => {
      const signal = o.signal;
      const cancel = () => {
        job.waiters.delete(waiter);
        reject(abort());
        if (![...batch.jobs.values()].some(j => j.waiters.size)) batch.controller.abort();
      };
      const waiter = {signal, cancel, resolve, reject};
      job.waiters.add(waiter);
      signal?.addEventListener("abort", cancel, {once: true});
    });
  }

  function accepted(project, revision) {
    const s = project && sessions.get(project), host = hostOf(project);
    return s?.revision != null && s.revision === (revision ?? host?.revision?.()) ? s : null;
  }

  function knownSnapshot(project, revision) {
    const s = accepted(project, revision);
    if (!s) return null;
    return {revision: s.revision, generation: s.generation ?? 0, records: [...s.ready.values()]};
  }

  function generationOf(project, revision) {
    const s = project && sessions.get(project);
    return s?.revision != null && s.revision === revision ? s.generation || 0 : 0;
  }

  function peek(project, o = {}) {
    const s = accepted(project, o.revision);
    if (!s) return null;
    const {documentId, blockId} = o, instanceId = o.instanceId === documentId ? null : o.instanceId;
    const direct = s.ready.get(graph().keyOf(documentId, blockId, instanceId));
    if (direct || instanceId != null) return direct ?? null;
    let unique = null;
    for (const r of s.ready.values()) {
      if (r.documentId !== documentId || r.blockId !== blockId) continue;
      if (unique) return null;
      unique = r;
    }
    return unique;
  }

  function listen(project, fn) {
    if (!project) return () => {};
    const s = session(project, hostOf(project));
    s.listeners.add(fn);
    return () => s.listeners.delete(fn);
  }

  function frozenModel(project, o) {
    const model = design().create(project || emptyProject,null,o.authority);
    model.sync(o.revision ?? null, registryOf(o));
    return model;
  }

  function evaluateSnapshot(project, o = {}) {
    current(project,null,o.revision,o.signal);
    const model = frozenModel(project, o), {request: r, selection} = model.plan(o);
    if (!allowedPlan(model,project,o,r)) return hiddenSnapshot(o.revision ?? null);
    const response = frozenGraph(r,project,o);
    model.accept(response);
    return model.snapshot(selection, response.stats, o.revision ?? null);
  }

  // Retain surviving occurrences before resolving new names. Exact untouched
  // prefixes/suffixes win. Identically spelled repeated tokens retain their order.
  function matchedBindings(before, after, bindings, tokens) {
    const previous = new Map(), slots = new Map(), used = new Set();
    for (const b of bindings) previous.set(graph().refKey(b), b);
    let prefix = 0, suffix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    while (suffix < before.length - prefix && suffix < after.length - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    for (const r of tokens) {
      let offset;
      if (r.span[1] <= prefix) offset = 0;
      else if (r.span[0] >= after.length - suffix) offset = before.length - after.length;
      if (offset == null) continue;
      const old = previous.get(graph().refKey({...r, span: r.span.map(p => p + offset)}));
      if (old) { slots.set(graph().refKey(r), old); used.add(old); }
    }
    for (const name of new Set(tokens.map(t => t.name))) {
      const remaining = tokens.filter(r => r.name === name && !slots.has(graph().refKey(r)));
      const old = bindings.filter(b => b.name === name && !used.has(b)).sort((a, b) => a.span[0] - b.span[0]);
      if (!remaining.length || !old.length) continue;
      const oneTarget = old.every(b => JSON.stringify(b.target) === JSON.stringify(old[0].target));
      for (const [i, r] of remaining.entries()) {
        if (old.length === remaining.length || oneTarget && old[i]) slots.set(graph().refKey(r), old[i]);
        else if (!oneTarget) slots.set(graph().refKey(r), null);
      }
    }
    return slots;
  }

  function bindParsed(model, o, parsed) {
    if (!parsed.ok) return {bindings: copy(o.bindings || []), references: [], diagnostic: parsed.diagnostic};
    const previous = matchedBindings(o.previousSource || "", o.source, o.bindings || [], parsed.references);
    const choiceKey = span => span.join(":");
    const choices = new Map((o.choices || []).map(c => [choiceKey(c.span), c.target]));
    const references = parsed.references.map(r => {
      const key = graph().refKey(r), saved = previous.get(key);
      const chosen = choices.get(choiceKey(r.span));
      const resolved = chosen ? {binding: chosen} : saved ? {binding: saved.target} : previous.has(key)
        ? {diagnostic: issue("ambiguous", "Choose which source to retain for " + r.name + ".", r.span)}
        : model.resolveName(o, r.name);
      if (resolved.binding && model?.allowed && !model.allowed(resolved.binding)) return {...r,id:saved?.id || id(),target:null,
        diagnostic:issue("denied","The requested design data is unavailable.",r.span)};
      return {...r, id: saved?.id || id(), target: resolved.binding || null, candidates: resolved.candidates,
        diagnostic: resolved.diagnostic && {...resolved.diagnostic, span: r.span}};
    });
    const bindings = references.filter(r => r.target).map(({id, name, span, target}) => ({id, name, span, target: copy(target)}));
    const failure = references.find(r => r.diagnostic);
    const functions = pinsOf(parsed, o.registry, o.pinnedFunctions);
    return {name: parsed.name, bindings, references, functions, diagnostic: failure?.diagnostic};
  }

  function pinsOf(parsed, registry, existing = {}) {
    const wanted = new Set(parsed.calls || []), pins = new Map();
    for (const id of wanted) {
      const declaration = registry?.[id], version = Object.hasOwn(existing, id) ? existing[id] : declaration?.version;
      if (!version) continue;
      pins.set(id, version);
      if (declaration?.version === version) for (const d of declaration.dependencies || []) wanted.add(d.id);
    }
    // If a pinned installation is unavailable, retain all authored pins needed
    // to make that snapshot reproducible when the package returns.
    if ([...pins].some(([id, version]) => registry?.[id]?.version !== version)) {
      for (const [id, version] of Object.entries(existing)) if (!pins.has(id)) pins.set(id, version);
    }
    return pins.size ? Object.fromEntries(pins) : undefined;
  }

  async function bindSource(project, o) {
    const host = hostOf(project, o.host), revision = revisionOf(host, o.revision);
    current(project, host, revision, o.signal);
    const parsed = await request({operation: "parse", source: o.source}, o.signal);
    current(project, host, revision, o.signal);
    const registry = registryOf(o), model = project && !o.authority ? prepare(project, host, revision, registry).model : frozenModel(project, o);
    return bindParsed(model, {...o, registry}, parsed);
  }

  // Numeric controls use the same worker, bindings and revision guard as notebook blocks.
  // Constants and local geometry variables do not require a design projection.
  async function fieldExpression(project, o) {
    const host = hostOf(project, o.host), revision = revisionOf(host, o.revision);
    const check = () => current(project, host, revision, o.signal);
    check();
    const parsed = await request({operation: "parse", source: o.source}, o.signal);
    check();
    if (!parsed.ok) return {result: parsed};
    const registry = registryOf(o), locals = o.locals || {}, globalRefs = [], localRefs = [];
    for (const ref of parsed.references) {
      const local = Object.hasOwn(locals, ref.name) && locals[ref.name];
      if (!local) { globalRefs.push(ref); continue; }
      localRefs.push({...ref, id: local.id || id(), target: local.target, field: {raw: local.value,
        unit: local.unit || "", fieldUnit:local.unit || "", sourceId: JSON.stringify(local.target || ref.name), tolerance: {absolute: 0}}});
    }
    const readsDesign=globalRefs[0] || parsed.queries?.[0] || localRefs.find(r=>r.target);
    if(readsDesign && o.allowDesign===false)return {result:{ok:false,diagnostic:issue("permission","This form cannot read design fields.",readsDesign.span)}};
    const refused=(span=readsDesign?.span)=>({result:{ok:false,diagnostic:denied(span || [0,o.source.length])}});
    if(readsDesign && o.authority && !design().readable(project,o.authority,o.documentId))return refused();
    const s = globalRefs.length && !o.authority ? prepare(project || emptyProject, host, revision, registry) : null;
    const model = s?.model || (globalRefs.length ? frozenModel(project,{...o,revision,functions:registry}) : null);
    const bound = bindParsed(model, {...o, registry}, {...parsed, references: globalRefs});
    const key = id();
    const query = model ? model.query(key, o.source, o, bound.references, bound.functions) :
      {key, source: o.source, documentId: o.documentId, references: [], functions: bound.functions};
    query.references.push(...localRefs);query.fieldUnit=o.fieldUnit;
    const plan = model ? model.plan({}, query).request : {operation:"graph", roots:[key], nodes:[query], functions:registry};
    const access={allowed(target){
      if(target.scope!=="numeric-field")return model?.allowed(target)===true;
      const address=target.address,field=address?.path?.at(-1);
      return !!address && design().readable(project,o.authority,address.documentId) && typeof field==="string" &&
        (!o.authority?.canReadField || !!o.authority.canReadField(field.toLowerCase()));
    }};
    const allowed=()=>!readsDesign || allowedPlan(access,project,o,plan);
    const unavailable=()=>refused(query.references.find(r=>r.diagnostic?.code==="denied" || r.target && !access.allowed(r.target))?.span);
    if(!allowed())return unavailable();
    const queryWatches = new Map();
    const onCountPlan = (plan,docId) => {
      const fields=plan.dependencies.filter(d=>!d.startsWith("reference:") && !d.startsWith("kind:"));
      const designators=plan.indexTerms.filter(t=>t.type==="exact" && ["designator","ref","component.designator"].includes(t.key.toLowerCase())).map(t=>t.value);
      const target={scope:"query",docId,kind:plan.kind,fields,designators};
      queryWatches.set(JSON.stringify(target),target);
      for(const {target} of plan.references)if(target?.itemId && target.field)queryWatches.set(JSON.stringify(target),target);
    };
    const evaluated = await runGraph(plan,project,{...o,host,revision,onCountPlan});
    check();
    if(!allowed())return unavailable();
    if (s && s.revision !== revision) throw abort();
    s?.model.accept(evaluated, key);
    const row = new Map(evaluated.changed).get(key);
    const bindings = [...bound.bindings, ...localRefs.filter(r => r.target).map(({id, name, span, target}) => ({id, name, span, target}))];
    const watches=model?.watchTargets(query) || bindings.map(b=>b.target);
    if(parsed.queries?.length && !watches.some(w=>w?.scope==="query" && w.docId===o.documentId))watches.push({scope:"query",docId:o.documentId});
    return {result:row.result,bindings,functions:bound.functions,
      watches:queryWatches.size ? [...watches.filter(t=>t.scope!=="query"),...queryWatches.values()] : watches,quantityLiteral:parsed.quantityLiteral};
  }

  function fieldIds(references) {
    return [...new Set(references.filter(r => r.target).map(r => design().fieldKey(r.target)))];
  }

  function evaluateExpressionSnapshot(project, o) {
    current(project,null,o.revision,o.signal);
    const model = frozenModel(project, o);
    const parsed = graph().task({operation: "parse", source: o.source}), bound = bindParsed(model, {...o, registry: registryOf(o)}, parsed);
    if (!parsed.ok) return {revision: o.revision ?? null, result: parsed, bindings: bound.bindings, references: [], boundFieldIds: []};
    const key = "query", query = model.query(key, o.source, o, bound.references, bound.functions);
    const task=model.plan({},query).request;
    if ((parsed.queries?.length || parsed.references.length) && !allowedPlan(model,project,o,task))
      return {revision:o.revision ?? null,result:{ok:false,diagnostic:denied([0,o.source.length])},bindings:[],references:[],boundFieldIds:[]};
    const response = frozenGraph(task,project,o), row = new Map(response.changed).get(key);
    return {revision: o.revision ?? null, ...row, bindings: bound.bindings, references: bound.references,
      functions: bound.functions, boundFieldIds: fieldIds(bound.references)};
  }

  function responseError(req, diagnostic) {
    return {...req, state: "diagnostic", message: diagnostic.message, span: diagnostic.span, diagnostic};
  }

  function activeAnswerContext(host, req) {
    if (!host || !req.documentId) return true;
    if (host.currentId && host.currentId() !== req.documentId) return false;
    const location = host === G.AtriumNavHost ? G.AtriumConnectionPreview?.location?.()?.occurrence : null;
    const active = host.instanceId?.() ?? (location?.docId === req.documentId ? location.instanceId : null);
    const normalized = v => v === req.documentId ? null : v ?? null;
    return normalized(active) === normalized(req.instanceId);
  }

  function followAnswer(host, project, req, external) {
    if (!host) return {signal: external, close() {}};
    const controller = new AbortController(), cancel = () => controller.abort();
    const stopIfChanged = () => {
      if (host.project() !== project || host.revision() !== req.projectRevision || !activeAnswerContext(host, req)) cancel();
    };
    if (external?.aborted) cancel();
    else external?.addEventListener("abort", cancel, {once:true});
    const unsubscribers = ["change", "document", "replace"].map(event => host.on?.(event, stopIfChanged));
    return {signal:controller.signal, close() {
      external?.removeEventListener("abort", cancel);
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    }};
  }

  async function answer(args, o = {}) {
    const project = o.project || (o.host || G.AtriumNavHost)?.project?.() || emptyProject, host = hostOf(project, o.host);
    const {queryId, text, documentId, instanceId, selection = []} = args;
    const projectRevision = revisionOf(host, args.projectRevision);
    const req = {queryId, projectRevision, documentId, instanceId};
    if (!Array.isArray(args.bindings) && !acceptsPaletteText(text, args)) return null;
    const work = followAnswer(host, project, req, o.signal), signal = work.signal;
    try {
      current(project, host, projectRevision, signal);
      if (!activeAnswerContext(host, req)) throw abort();
      const parsed = await request({operation: "parse", source: text}, signal);
      current(project, host, projectRevision, signal);
      if (!activeAnswerContext(host, req)) throw abort();
      if (!parsed.ok) return responseError(req, parsed.diagnostic);
      const functions = registryOf(o), scoped = o.authority !== undefined || !!o.countQuery;
      const s = scoped ? null : prepare(project, host, projectRevision, functions);
      const model = s?.model || frozenModel(project,{...o,revision:projectRevision,functions});
      const bound = bindParsed(model, {...req, source: text, previousSource: text, bindings: args.bindings, registry: functions,
        pinnedFunctions: args.pinnedFunctions}, parsed);
      const resultKey = id(), query = model.query(resultKey, text, req, bound.references, bound.functions);
      const plan = model.plan({}, query);
      const usesDesign=!!(parsed.references.length || parsed.queries?.length);
      const allowed=()=>!usesDesign || allowedPlan(model,project,{...o,documentId},plan.request);
      if (!allowed()) return responseError(req,denied([0,text.length]));
      const evaluated = await runGraph(plan.request,project,{...o,host,revision:projectRevision,signal});
      current(project, host, projectRevision, signal);
      if (!activeAnswerContext(host, req)) throw abort();
      if (!allowed()) return responseError(req,denied([0,text.length]));
      if (s && (s.revision !== projectRevision || s.functions !== design().registryKey(functions))) throw abort();
      if (s) model.accept(evaluated, resultKey);
      const {result} = new Map(evaluated.changed).get(resultKey);
      if (!result.ok) return responseError(req, result.diagnostic);
      const summary = {...req, state: "ready", resultKey, source: text, display: result.display, formatted: result.display,
        copyText: result.copyText, dimensions: result.dimensions, unit: result.unit, bindings: bound.bindings,
        functions: bound.functions, selection: copy(selection), boundFieldIds: fieldIds(bound.references), result};
      const ready = {...summary, actions:(!scoped && G.AtriumCalculationActions?.eligibleActions?.(summary, args, host)) || ["copy"]};
      if (!scoped) {
        if (answers.size >= 64) answers.delete(answers.keys().next().value);
        answers.set(resultKey, {project, host, functions: design().registryKey(functions), externalRegistry: !!o.functions, value: copy(ready)});
      }
      return ready;
    } catch (e) {
      if (isAbort(e)) throw e;
      return responseError(req, issue("unavailable", String(e?.message || e), [0, text.length]));
    } finally { work.close(); }
  }

  function resolvePaletteAnswer(candidate) {
    const stored = answers.get(candidate?.resultKey);
    if (!stored) return null;
    const ready = stored.value;
    if (candidate.queryId !== ready.queryId || candidate.projectRevision !== ready.projectRevision || candidate.documentId !== ready.documentId) return null;
    if (!activeAnswerContext(stored.host, ready)) return null;
    if (!stored.externalRegistry && stored.functions !== design().registryKey(registryOf({}))) return null;
    try { current(stored.project, stored.host, ready.projectRevision); } catch { return null; }
    return copy(ready);
  }

  async function applyPaletteAnswer(candidate, action, context) {
    const trusted = resolvePaletteAnswer(candidate);
    if (!trusted || !trusted.actions.includes(action)) throw Error("The calculation answer changed. Run it again before editing the design.");
    const sheet = G.AtriumCalculationSheet || await G.AtriumLazy?.need("AtriumCalculationSheet");
    const currentAnswer = resolvePaletteAnswer(candidate);
    if (!currentAnswer) throw Error("The calculation answer changed. Run it again before editing the design.");
    return sheet?.applyPaletteAnswer(currentAnswer, action, context, answers.get(candidate.resultKey).host);
  }

  const evaluateExtensionFunction = (declaration, args, o = {}) =>
    request({operation: "extension", declaration: copy(declaration), args: copy(args), functions: copy(normalizedRegistry(o.functions))}, o.signal);
  const validateExtensionFunctions = (declarations, o = {}) =>
    request({operation: "validate-functions", declarations: copy(declarations), functions: copy(normalizedRegistry(o.functions))}, o.signal);
  const syncRules = project => G.AtriumCalculationChecks?.syncRules(project);
  const stats = () => pool?.stats() || {started: 0, jobs: 0, local: 0, workerMs: 0};

  return Object.freeze({acceptsPaletteText, hasBlocks, bindSource, fieldExpression, evaluate, evaluateSnapshot, evaluateExpressionSnapshot,
    knownSnapshot, generationOf, peek, listen, answer, resolvePaletteAnswer, applyPaletteAnswer, evaluateExtensionFunction,
    validateExtensionFunctions, syncRules, stats});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumCalculations;
