"use strict";

(() => {
  const G = globalThis, S = G.AtriumSlides, V = G.AtriumSavedViews;
  const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
  const editor = context => context.source === "editor" ? G.AtriumNavHost : undefined;
  const writing = context => context.mode === "write";
  const deckOf = context => context.services.state.get("deck");
  const setDeck = (context, deck) => context.services.state.set("deck", deck);
  const query = context => ({query:V.queryResolver(context), revision:context.revision});
  const snapshotOf = (context, deck) => S.presenter(context.project, deck, undefined, V.refs(context));
  let latest = 0, presenterWindow;

  async function closePresenter(project) {
    const active = presenterWindow;
    if (!active || project && active.project !== project) return;
    presenterWindow = undefined;
    await active.handle.close();
  }

  async function publishPresenter(context, snapshot, requested) {
    if (!writing(context)) return requested ? {status:"planned"} : undefined;
    const host = editor(context), project = host?.project();
    if (!host) return requested ? {status:"unavailable"} : undefined;
    if (!requested && presenterWindow?.project !== project) return;
    if (G.AtriumPrefs.get("butter.windows") !== true || !host.folderProject()) return {status:"unavailable"};
    const ticket = latest;
    let active = presenterWindow;
    try {
      if (active && active.project !== project) {
        await closePresenter();
        active = undefined;
      }
      if (!active) {
        const client = await G.AtriumLazy.need("AtriumProjectWindowClient");
        if (latest !== ticket || host.project() !== project || !G.AtriumButter.state("slides").enabled) return {status:"cancelled"};
        const handle = await client.openAuxiliary({kind:"presenter",documentId:snapshot.current.documentId,deckId:project.id});
        if (latest !== ticket || host.project() !== project || !G.AtriumButter.state("slides").enabled) {
          await handle.close();
          return {status:"cancelled"};
        }
        presenterWindow = active = {project,handle};
      }
      const sent = await active.handle.update({...snapshot, measuredAtUnixMs:Date.now()});
      if (sent === false) {
        if (presenterWindow === active) await closePresenter(project);
        return {status:"closed"};
      }
      return {status:"open",windowId:active.handle.windowId};
    } catch (error) {
      if (presenterWindow === active && active) await closePresenter(project).catch(() => {});
      return {status:"unavailable",message:error.message};
    }
  }

  function live(context, documentId, resolve, preflight) {
    const ticket = ++latest;
    return V.navigate(context, documentId, resolve, {feature:"slides",code:"stale_slide",current:() => ticket === latest,preflight});
  }

  function apply(id, context) {
    const {project, documentId:liveDocument} = context, slide = S.find(project, id), host = editor(context);
    const documentId = slide?.source.documentId ?? V.find(project, slide?.source.savedViewId)?.documentId;
    const refs = V.refs(context), revisions = query(context);
    if (host && writing(context) && documentId) {
      const checkFrame = slide.source.kind === "frame" ? doc => {
        const plan = S.resolve(project,id,{doc});
        return plan.camera ? undefined : plan;
      } : undefined;
      return live(context, documentId, (doc, revision, signal) =>
        S.resolve(project, id, {...query({...context,signal}), doc, refs:V.refs(context), revision}), checkFrame);
    }
    return S.resolve(project, id, {
      ...revisions, refs, doc:documentId === liveDocument ? host?.doc() : undefined
    });
  }

  async function visit(deck, context, showPresenter) {
    const work = apply(deck.ids[deck.index], context), ticket = latest;
    const plan = await work;
    const presented = {...deck, viewStatus:plan.status};
    const snapshot = snapshotOf(context, presented);
    const window = await publishPresenter(context, snapshot, plan.camera && showPresenter);
    if (writing(context)) {
      if (editor(context) && ticket !== latest) fail("stale_slide", "A newer slide action replaced this one.");
      setDeck(context, presented);
    }
    return {...snapshot, status:plan.status, view:S.summary(plan), ...(window && {presenterWindow:window})};
  }

  function start(args, context) {
    const old = deckOf(context), host = editor(context);
    // Capture a return point only for an actual presentation start on a live design.
    const deck = S.start(context.project, args, old, null);
    if (!deck) return {...snapshotOf(context, null), status:"empty"};
    if (!old && host && writing(context)) deck.prior = V.captureLive(context, {transient:true});
    return visit(deck, context, args.presenter === true);
  }

  function navigate(args, context, stepping) {
    const deck = deckOf(context);
    if (!deck) return snapshotOf(context, null);
    if (args.index !== undefined && args.direction !== undefined)
      fail("invalid_arguments", "Choose a slide index or a direction.");
    return visit(stepping ? S.advance(deck, args) : deck, context);
  }

  async function stop(_, context) {
    const deck = deckOf(context);
    if (!deck) return snapshotOf(context, null);
    const host = editor(context), prior = deck.prior, documentId = prior?.documentId ?? null;
    const restoring = !!(host && prior && V.document(context.project, documentId, V.refs(context)));
    let partial = !!documentId && !restoring;
    let restored = false;
    if (writing(context)) {
      if (restoring) {
        const plan = await live(context, documentId, (doc, revision, signal) =>
          V.resolveReturn(prior, doc, revision, {...context,signal}));
        restored = !!plan.camera;
        partial = plan.status !== "ready";
      }
      if (host) await closePresenter(host.project()).catch(() => { partial = true; });
      setDeck(context, null);
    }
    return {status:partial ? "partial" : "stopped", restoredDocumentId:restored ? documentId : null};
  }

  async function exportPdf({ids, color}, context) {
    const {project} = context, requested = S.sequence(project, ids);
    if (!requested.length) fail("empty_slides", "Choose at least one slide to export.");
    const slides = requested.map(id => S.find(project, id));
    if (slides.some(slide => !slide)) fail("missing_slide", "Some selected slides are no longer available.");
    const stem = String(project.name || "Waffle").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim().replace(/^\.+/, "").slice(0,160).trim();
    const name = (stem || "Waffle") + "-Slides.pdf";
    const base = {name, pageCount:requested.length, slideIds:requested};
    const notes = [], entries = slides.map(({id, name, source}) => {
      if (source.kind === "frame") return {id, name, documentId:source.documentId, frameId:source.frameId};
      const view = V.find(project, source.savedViewId);
      return {id, name, documentId:view?.documentId, selection:view?.selection};
    });
    const presentation = await V.resolvePages(context, entries, {purpose:"Slides PDF",
      stale:{code:"stale_slide",message:"The project changed during slide export."}}, async ({id,name}, options) => {
      const view = await S.resolve(project, id, options);
      if (!view.camera) fail(view.status.replaceAll("-", "_"), "The source of slide “" + name + "” is unavailable.");
      if (view.missingSelection.length) notes.push(name + ": some highlighted objects are missing.");
      if (view.filter && view.filter.status !== "complete") notes.push(name + ": the saved filter could not finish.");
      return {...view, title:name, camera:V.restore(view.camera), paper:S.paper(view.aspect), margin:24,
        uri:V.pageSourceLink(project, id)};
    });
    if (!writing(context)) return {result:base};
    return V.publishPDF(context, {feature:"slides", presentation, color, title:project.name + " — Slides", links:true, notes, result:base});
  }

  G.AtriumButter.register("slides", {
    list:(args, context) => S.describeMany(context.project, args, V.refs(context)),
    add:(args, context) => S.add(context.project, args, V.refs(context)),
    update:(args, context) => S.update(context.project, args, V.refs(context)),
    remove:({id}, {project}) => S.remove(project, id),
    reorder:({ids}, {project}) => S.reorder(project, ids),
    apply:async ({id}, context) => S.summary(await apply(id, context)),
    start,
    step:(args, context) => navigate(args, context, true),
    resume:(args, context) => navigate(args, context, false),
    stop,
    presenter:(_, context) => snapshotOf(context, deckOf(context)),
    "export-pdf":exportPdf
  });
  G.AtriumPrefs?.on("butter.slides", ({value}) => { if (value !== true) void closePresenter().catch(() => {}); });
})();
