"use strict";

// Saved views store authored intent. Resolving a view plans the live camera,
// visible layers, selection and filter against the current document revision.
globalThis.AtriumSavedViews = (() => {
  const G = globalThis, M = G.AtriumFormat2Model;
  const copy = value => JSON.parse(JSON.stringify(value));

  function camera({cx, cy, scale, referenceScale, flipped = false, rotation = 0}) {
    return {center:[cx, cy], scale, referenceScale, flipped, rotationRadians:rotation};
  }
  function restore(saved, scaleFactor = 1) {
    return {cx:saved.center[0], cy:saved.center[1], scale:saved.scale * scaleFactor,
      referenceScale:saved.referenceScale * scaleFactor, flipped:saved.flipped, rotation:saved.rotationRadians};
  }
  const list = project => project?.savedViews ?? [];
  const find = (project, id) => list(project).find(view => view.id === id);
  const document = (project, id, refs = []) => project?.documents?.find(doc => doc.id === id) ?? refs.find(doc => doc.id === id);
  const documentStatus = doc => !doc || doc.missing ? "missing-document" : Array.isArray(doc.items) ? "ready" : "loading-document";
  function unavailable(code, message) { throw Object.assign(Error(message), {code}); }

  function capture(project, {name, documentId, camera, viewport, layers, selection = [], filter, netHighlight}, refs) {
    if (list(project).length >= M.savedViewLimit) unavailable("saved_view_limit", "This project already has the maximum number of saved views.");
    const doc = document(project, documentId, refs);
    if (!doc) unavailable("missing_document", "Choose a document in this project.");
    const record = {id:G.AtriumUUID.next(), name, documentId, camera, viewport, selection,
      ...(layers !== undefined ? {layers} : {}), ...(filter !== undefined ? {filter} : {}), ...(netHighlight ? {netHighlight} : {})};
    return copy(M.checkSavedView(record));
  }

  function describe(view, docs) {
    const doc = docs.get(view.documentId);
    return {id:view.id, name:view.name, documentId:view.documentId, documentName:doc?.name ?? null,
      status:documentStatus(doc), hasFilter:!!view.filter, selectionCount:view.selection.length};
  }
  function documentMap(project, refs) {
    return new Map([...refs, ...project.documents].map(doc => [doc.id, doc]));
  }
  function describeMany(project, {offset = 0, limit = 50} = {}, refs = []) {
    const views = list(project), docs = documentMap(project, refs);
    return {views:views.slice(offset, offset + limit).map(view => describe(view, docs)), total:views.length, offset};
  }

  function retainedSelection(doc, selection, itemIndex) {
    if (!selection.length) return {selection:[], missingSelection:[]};
    if (itemIndex) {
      const present = itemIndex(), kept = [], missing = [];
      for (const id of selection) (present.has(id) ? kept : missing).push(id);
      return {selection:kept, missingSelection:missing};
    }
    const missing = new Set(selection);
    if (doc.kind === "drawing") return G.AtriumDrawing.retainSelection(doc, selection);
    if (missing.size) for (const item of doc.items) {
      missing.delete(item.id);
      if (!missing.size) break;
    }
    return {selection:selection.filter(id => !missing.has(id)), missingSelection:[...missing]};
  }

  function resolve(project, id, {doc, refs, query, revision, itemIndex} = {}) {
    const record = find(project, id);
    if (!record) return {id, status:"missing-view"};
    M.checkSavedView(record, id, {reading:true});
    doc = doc?.id === record.documentId ? doc : document(project, record.documentId, refs);
    const status = documentStatus(doc);
    if (status !== "ready") return {id, documentId:record.documentId, name:record.name, status};
    if (doc.kind === "drawing" && record.selection.length && !G.AtriumDrawing && G.AtriumLazy)
      return G.AtriumLazy.need("AtriumDrawing").then(() => resolve(project,id,{doc,refs,query,revision,itemIndex}));
    const selected = retainedSelection(doc, record.selection, itemIndex);
    const filter = record.filter && (query ? query(record.filter.scope, {project, documentId:doc.id, revision}) : {status:"unavailable"});
    const finish = matches => ({id, documentId:doc.id, name:record.name,
      status:selected.missingSelection.length || matches && matches.status !== "complete" ? "partial" : "ready",
      camera:copy(record.camera), viewport:copy(record.viewport),
      ...(record.layers ? {layers:copy(record.layers)} : {}), ...selected,
      ...(record.netHighlight ? {netHighlight:record.netHighlight} : {}),
      ...(matches ? {filter:{...matches, authoredScope:record.filter.scope, mask:record.filter.mask, highlight:record.filter.highlight}} : {})});
    return filter?.then ? filter.then(finish) : finish(filter);
  }

  function sequence(project, ids) {
    const source = ids ?? list(project).map(view => view.id);
    if (source.length > M.savedViewLimit || new Set(source).size !== source.length) unavailable("invalid_views", "Choose distinct saved views in presentation order.");
    return [...source];
  }
  function step(project, ids, index, refs = []) {
    if (!ids.length) return {status:"empty", index:null, total:0, current:null, previous:null, next:null};
    const n = Math.max(0, Math.min(ids.length - 1, index)), docs = documentMap(project, refs);
    const entry = i => {
      const id = ids[i];
      if (!id) return null;
      const record = find(project, id);
      return record ? describe(record, docs) : {id, status:"missing-view"};
    };
    const current = entry(n);
    return {status:current.status, index:n, total:ids.length, current, previous:entry(n - 1), next:entry(n + 1)};
  }

  function edit(project, views, result) {
    return {result, ops:[{op:"set", target:"project", path:["savedViews"],
      ...(Object.hasOwn(project, "savedViews") ? {before:list(project)} : {}), after:views}]};
  }
  function rename(project, id, name) {
    const views = list(project), old = find(project, id);
    if (!old) unavailable("missing_view", "This saved view no longer exists.");
    if (old.name === name) return {result:{view:copy(old)}, ops:[]};
    const view = M.checkSavedView({...old, name}, id, {reading:true});
    return edit(project, views.map(record => record === old ? view : record), {view});
  }
  function remove(project, id) {
    if (!find(project, id)) unavailable("missing_view", "This saved view no longer exists.");
    return edit(project, list(project).filter(view => view.id !== id), {id});
  }

  const editor = context => context.source === "editor" || context.source === "macro" ? G.AtriumNavHost : undefined;
  const refs = context => editor(context)?.documentRefs() ?? [];

  async function loadDocument(context, id, purpose) {
    const host = editor(context), folder = host?.folderProject();
    const doc = document(context.project, id, refs(context));
    if (!doc || doc.missing || Array.isArray(doc.items) || !folder) return doc;
    try { return await folder.ensureDocument(id, {purpose, signal:context.signal}); }
    catch (error) {
      if (folder.getDocumentRef(id)?.missing && !context.signal?.aborted) return undefined;
      throw error;
    }
  }

  // Only index the requested selections and frames, and stop once all are found.
  // Drawing objects live in the drawing's authored lists instead of doc.items.
  function presentationItems(doc, requests) {
    const wanted = new Set();
    for (const ids of requests) for (const id of ids) wanted.add(id);
    if (doc.kind === "drawing") {
      const found = G.AtriumDrawing.retainSelection(doc, [...wanted]).selection;
      return new Map(found.map(id => [id, null]));
    }
    const found = new Map();
    for (const item of doc.items) {
      const id = item.id;
      if (wanted.delete(id)) found.set(id, item);
      if (!wanted.size) break;
    }
    return found;
  }

  async function resolvePages(context, entries, {purpose, stale}, resolveEntry) {
    const batches = new Map();
    for (const {documentId, frameId, selection} of entries) {
      if (!documentId) continue;
      if (!batches.has(documentId)) batches.set(documentId, {requests:[]});
      if (frameId || selection?.length) batches.get(documentId).requests.push(frameId ? [frameId] : selection);
    }
    const query = context.mode === "write" ? queryResolver(context) : undefined, pages = [];
    const guard = () => {
      if (context.signal?.aborted || context.isCurrent?.() === false) unavailable(stale.code, stale.message);
    };
    for (const entry of entries) {
      guard();
      const batch = batches.get(entry.documentId);
      if (batch) batch.loaded ??= loadDocument(context, entry.documentId, purpose);
      const doc = await batch?.loaded;
      guard();
      const itemIndex = batch?.requests.length > 1 && documentStatus(doc) === "ready" ?
        () => batch.items ??= presentationItems(doc, batch.requests) : undefined;
      pages.push(await resolveEntry(entry, {doc, refs:doc ? undefined : refs(context), query, revision:context.revision, itemIndex}));
    }
    guard();
    return pages;
  }

  function pageSourceLink(project, id) {
    const L = G.AtriumLinkRecord;
    return L?.id(project.id) && L.id(id) ? L.format({projectId:project.id, objectId:id}) : undefined;
  }

  function publishPDF(context, {feature, presentation, color, title, links, notes, result}) {
    return preparePDF(context, {feature, presentation, color, title, ...(links === undefined ? {} : {links}),
      attachments:false, properties:false, viewerLayers:false, searchable:false}, built => {
      const pages = built.pages.map(page => ({id:page.viewId,title:page.title,documentId:page.doc,width:page.w,height:page.h}));
      return {result:{...result, pageCount:result.pageCount ?? pages.length, pages, links:built.links, notes:[...notes,...built.notes]},
        file:{name:result.name,data:built.bytes(),binary:true}};
    });
  }

  async function preparePDF(context, options, consume) {
    const host = editor(context);
    if (!host) return G.AtriumPrint.prepareDocument(context.project, {...options,signal:context.signal},
      {decodeAsset:context.services.native?.prepareImage,loadNotebookModules:context.services.native?.loadNotebookModules}, consume);
    const controller = new AbortController(), stop = () => {
      if (context.signal?.aborted) controller.abort();
    };
    const dispose = ["change","document","replace","selection"].map(event => host.on(event, stop));
    const feature = options.feature;
    if (feature) dispose.push(G.AtriumPrefs.on("butter." + feature, stop));
    try {
      stop();
      return await G.AtriumPrint.prepareDocument(host.project(),{...options, signal:controller.signal}, {}, consume);
    } finally { for (const off of dispose) off?.(); }
  }

  let transition = 0;
  async function navigate(context, documentId, resolve, {feature, code, current = () => true, preflight}) {
    const host = editor(context), project = host.project(), ticket = ++transition;
    const viable = () => ticket === transition && host.project() === project && current() && G.AtriumButter.state(feature).enabled;
    const guard = () => {
      if (!viable()) unavailable(code, "The active project changed while opening the view.");
    };
    if (host.editInProgress()) unavailable("busy_canvas", "Finish the current edit first.");
    const doc = await loadDocument(context, documentId, "view");
    guard();
    if (context.signal?.aborted) unavailable(code, "The origin changed while opening the view.");
    // Resolve an unavailable source without moving the live editor.
    if (documentStatus(doc) !== "ready") return resolve(doc, host.revision(), context.signal);
    const error = preflight?.(doc);
    if (error) return error;
    await host.selectDocument(documentId);
    const revision = host.revision();
    const unchanged = () => {
      guard();
      if (host.currentId() !== documentId || host.revision() !== revision)
        unavailable(code, "The design changed while opening the view.");
    };
    unchanged();
    const signal = {get aborted() {
      return !viable() || host.currentId() !== documentId || host.revision() !== revision;
    }};
    const plan = await resolve(host.doc(), revision, signal);
    await applyPlan(host, plan, unchanged);
    return plan;
  }

  function captureLive(context, {transient = false} = {}) {
    const host = editor(context), live = host?.captureViewState();
    if (!live || host.project().id !== context.project.id)
      unavailable("missing_viewport", "Use an open design canvas or supply the view state explicitly.");
    const applied = G.AtriumQuery?.applied();
    let scope;
    if (applied?.docId === live.documentId && (applied.scope || applied.text)) {
      const source = applied.scope ?? applied.text;
      const converted = typeof source === "string" ? G.AtriumQueryExchange.fromClassic(source,{layer:G.AtriumQuery.layerKey}) : {ok:true, scope:source};
      if (converted.ok) scope = converted.scope;
      else if (!transient) unavailable("invalid_filter", "The current filter cannot be saved as a native query. " + converted.diagnostics[0]?.message);
    }
    const selection = host.doc().kind === "drawing" ? G.AtriumDrawing.selection() : context.selection;
    const savedFilter = scope && {scope, mask:!!applied.modes.mask, highlight:!!applied.modes.highlight};
    return {...live, camera:camera(live.camera), selection, netHighlight:host.highlight(),
      ...(savedFilter ? {filter:savedFilter} : transient && applied?.docId === live.documentId ?
        {liveMask:G.AtriumQuery.snapshotMask()} : {})};
  }

  async function resolveReturn(prior, doc, revision, context) {
    if (documentStatus(doc) !== "ready") return {status:"missing-document"};
    const {filter, liveMask, ...state} = prior, selected = retainedSelection(doc, state.selection);
    if (liveMask) {
      const ids = retainedSelection(doc, liveMask.ids);
      const unbound = [], rows = [];
      for (const sub of liveMask.subs) {
        if (sub.ownerId && sub.pin != null) rows.push({...sub,at:undefined});
        else unbound.push(sub);
      }
      const {subitems} = highlightRecords({rows},doc,editor(context).defs());
      const subs = [...unbound,...subitems];
      return {...state, ...selected, liveMask:{...liveMask, ids:ids.selection, subs},
        status:selected.missingSelection.length || ids.missingSelection.length || subs.length !== liveMask.subs.length ? "partial" : "ready"};
    }
    const result = filter && await queryResolver(context)(filter.scope, {project:context.project, documentId:doc.id, revision});
    return {...state, ...selected, status:selected.missingSelection.length || result && result.status !== "complete" ? "partial" : "ready",
      ...(result && {filter:{...result, authoredScope:filter.scope, mask:filter.mask, highlight:filter.highlight}})};
  }

  function queryResolver(context) {
    return (scope, inputs) => {
      const host = context.source === "editor" ? editor(context) : undefined;
      const live = host?.project(), project = live?.id === inputs.project.id ? live : inputs.project;
      const enabled = context.services.enabled?.("query") ?? G.AtriumButter.state("query").enabled;
      if (!enabled) {
        if (scope.savedQueryId) return {status:"disabled", diagnostic:{message:"Enable Design Queries to use this named filter."}};
        if (!G.AtriumDesignQueryRecord.valid(scope, {allowUnknown:true})) return {status:"unavailable", diagnostic:{message:"This saved filter needs a newer reader."}};
        if (scope.bindings?.length) return {status:"disabled", diagnostic:{message:"Enable Design Queries to apply this filter's bound references."}};
        const classic = Q => {
          const doc = project.documents.find(d => d.id === inputs.documentId);
          try {
            const {ids, subs, count, complete, diagnostics} = Q.run(project, doc, scope.source, {timeLimit:2000,revision:inputs.revision});
            const rows = [...ids.map(id => ({id})), ...subs.map(s => ({id:s.id,ownerId:s.part.id,pin:s.pin,padIndex:s.padIndex,at:s.at,w:s.w,h:s.h}))];
            return {scope, count, rows:rows.slice(0,50000), status:complete && rows.length <= 50000 ? "complete" : "partial", diagnostics};
          } catch (error) { return {status:"error",diagnostic:{message:error.message}}; }
        };
        return G.AtriumQuery ? classic(G.AtriumQuery) : G.AtriumLazy.need("AtriumQuery").then(classic);
      }
      const search = async Q => {
        const options = {...inputs, project, enabled:true, signal:context.signal,
          ...(context.source === "mcp" ? {yieldTask:() => Promise.resolve()} : {})};
        const result = Q.selection ? await Q.selection(scope,options) : await Q.search(scope,{...options,limit:200});
        if (result.status !== "complete") return result;
        const native = scope.savedQueryId ? Q.get(scope.savedQueryId,options).record?.query : scope;
        return {...result,scope:native,status:result.count > result.rows.length ? "partial" : "complete"};
      };
      if (G.AtriumQueryService) return search(G.AtriumQueryService);
      if (editor(context) && G.AtriumLazy.modules().includes("AtriumQueryService")) return G.AtriumLazy.need("AtriumQueryService").then(search);
      return {status:"unavailable"};
    };
  }

  function highlightRecords(filter, doc, defs) {
    const ids = [], subitems = [];
    let parts;
    const pins = new Map();
    for (const row of filter.rows ?? []) {
      if (!row.ownerId || row.pin == null) {ids.push(row.ownerId ?? row.id); continue;}
      if (row.at) {subitems.push(row); continue;}
      parts ??= new Map(doc.items.map(item => [item.id,item]));
      const part = parts.get(row.ownerId);
      if (!part) continue;
      if (!pins.has(part.id)) pins.set(part.id, G.Atrium.pins(part,defs.get(part.def),doc.kind));
      const group = pins.get(part.id), id = row.id?.startsWith(part.id + "/") ? row.id.slice(part.id.length + 1) : row.id;
      const pin = group[row.padIndex] ?? (id ? group.find(p => p.id === id || p.nativeId === id) : undefined) ??
        group.find(p => String(p.number) === String(row.pin));
      if (pin) subitems.push(pin);
    }
    return {ids, subitems};
  }

  async function applyPlan(host, plan, guard = () => {}) {
    guard();
    if (!plan.camera) return false;
    const pane = host.captureViewState();
    if (!pane) unavailable("missing_viewport", "Open the two-dimensional design canvas first.");
    const ratio = Math.min(pane.viewport.pixelWidth / plan.viewport.pixelWidth, pane.viewport.pixelHeight / plan.viewport.pixelHeight);
    const savedCamera = restore(plan.camera, ratio);
    if (savedCamera.rotation && !G.AtriumCanvasInput) await G.AtriumLazy.need("AtriumCanvasInput");
    if ((plan.filter || plan.liveMask) && !G.AtriumQuery) await G.AtriumLazy.need("AtriumQuery");
    guard();
    if (!host.applyViewState({...plan, camera:savedCamera})) unavailable("busy_canvas", "The design canvas is unavailable.");
    if (host.doc().kind === "drawing") G.AtriumDrawing.selectIds(host.doc(), plan.selection);
    G.AtriumQuery?.clear(true);
    if (plan.liveMask) {
      const {ids, subs, modes} = plan.liveMask;
      G.AtriumQuery.applyIds(plan.documentId, ids, subs, modes);
    }
    if (plan.filter?.status === "complete") {
      const {ids, subitems} = highlightRecords(plan.filter, host.doc(), host.defs());
      const scope = plan.filter.authoredScope;
      G.AtriumQuery.applyIds(plan.documentId, ids, subitems, {mask:plan.filter.mask, highlight:plan.filter.highlight},
        {scope,text:scope?.bindings?.length ? "" : scope?.source});
    }
    return true;
  }

  return Object.freeze({camera, restore, editor, refs, document, documentStatus, loadDocument, navigate, preparePDF, resolvePages, pageSourceLink, publishPDF,
    captureLive, queryResolver, highlightRecords, resolveReturn, applyPlan, capture, find, describeMany, resolve, sequence, step, edit, rename, remove});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumSavedViews;
