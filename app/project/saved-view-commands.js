"use strict";

(() => {
  const G = globalThis, V = G.AtriumSavedViews;
  const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
  function publishView(id, context) {
    const {project,mode} = context, writing = mode === "write", view = V.find(project,id);
    const resolve = (doc, revision, signal) =>
      V.resolve(project,id,{doc,refs:V.refs(context),query:V.queryResolver({...context,signal}),revision});
    const plan = V.editor(context) && writing && view ?
      V.navigate(context,view.documentId,resolve,{feature:"savedViews",code:"stale_view"}) :
      resolve(undefined,context.revision,context.signal);
    const finish = value => {
      if (writing && value.camera) context.services.state.set("currentView", value.id);
      return value;
    };
    return plan?.then ? plan.then(finish) : finish(plan);
  }

  function present(args, context, moving = false) {
    const {project, services, mode} = context, old = services.state.get("sequence");
    const ids = V.sequence(project, args.ids ?? (moving ? old?.ids : undefined));
    const target = args.index ?? (moving ? (old?.index ?? 0) + (args.direction ?? 1) : 0);
    const position = V.step(project, ids, target, V.refs(context));
    if (!position.current) return position;
    if (position.status !== "ready" && position.status !== "loading-document") {
      if (mode === "write") services.state.set("sequence", {ids, index:position.index});
      return position;
    }
    const plan = publishView(position.current.id, context);
    const finish = view => {
      if (mode === "write") services.state.set("sequence", {ids, index:position.index});
      return {...V.step(project, ids, position.index, V.refs(context)), status:view.status, view};
    };
    return plan?.then ? plan.then(finish) : finish(plan);
  }

  async function describePdf(args, context) {
    const project = context.project, ids = V.sequence(project, args.ids);
    if (!ids.length) fail("missing_view", "Choose at least one saved view to export.");
    const positions = ids.map(id => V.find(project, id));
    if (positions.some(view => !view)) fail("missing_view", "Some saved views are no longer available.");
    const refs = V.refs(context);
    if (positions.some(view => V.documentStatus(V.document(project,view.documentId,refs)) === "missing-document"))
      fail("missing_document", "Some saved views' documents are no longer available.");
    const stem = String(project.name || "Waffle").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^[. ]+/, "").slice(0, 160);
    const name = (stem || "Waffle") + "-Saved views.pdf";
    if (context.mode !== "write") return {result:{name, pageCount:ids.length, viewIds:ids}};
    const notes = [];
    const presentation = await V.resolvePages(context, positions, {purpose:"Saved views PDF",
      stale:{code:"stale_view", message:"The project changed during PDF preparation."}}, async (record, options) => {
      const view = await V.resolve(project, record.id, options);
      if (!view.camera) fail("missing_document", "A saved view's document is unavailable.");
      if (view.filter && view.filter.status !== "complete") notes.push(view.name + ": the saved filter could not finish.");
      if (view.missingSelection.length) notes.push(view.name + ": some highlighted objects are missing.");
      return {...view, title:view.name, camera:V.restore(view.camera), uri:V.pageSourceLink(project, view.id)};
    });
    return V.publishPDF(context, {feature:"savedViews", presentation, color:args.color, title:project.name + " — Saved views",
      notes, result:{name}});
  }

  G.AtriumButter.register("savedViews", {
    list:(args, context) => V.describeMany(context.project, args, V.refs(context)),
    capture(args, context) {
      const {project} = context, input = args.view ?? V.captureLive(context);
      const view = V.capture(project, {...input, name:args.name.trim()}, V.refs(context));
      return V.edit(project, [...(project.savedViews ?? []), view], {view});
    },
    rename:({id, name}, {project}) => V.rename(project, id, name.trim()),
    remove:({id}, {project}) => V.remove(project, id),
    apply:({id}, context) => publishView(id, context),
    present:(args, context) => present(args, context),
    step:(args, context) => present(args, context, true),
    "export-pdf":describePdf
  });
})();
