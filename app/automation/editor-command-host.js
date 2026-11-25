"use strict";
// Loaded by Preferences only when the profile opts into a Butter feature.
(() => {
  const G = globalThis, B = G.AtriumButter, L = G.AtriumLazy, prefs = G.AtriumPrefs;
  const commands = new Map(), modules = new Map();
  const key = feature => "butter." + feature;
  const enabled = feature => B.state(feature).enabled;
  const metadata = feature => G.AtriumButterCatalog[feature];
  const unsupported = message => {throw Object.assign(Error(message), {code:"unsupported_command"});};
  const writeGrant = Symbol("first-party editor command");

  // The Ask AI, Query, Macros and Links surfaces (butter-intel-ui.js) load only with their flags.
  const intel = new Set(["ai", "query", "macros", "links"]);
  function intelSurfaces(feature) {
    if (!intel.has(feature) || !enabled(feature) && !G.AtriumIntelUI) return;
    L.register("AtriumIntelUI", {scripts:["editor/workspace-tools.js"], css:["editor/workspace-tools.css"]});
    L.need("AtriumIntelUI").then(ui => G.AtriumNavCommon?.ready(() => ui.install(feature)), error => G.AtriumNavHost?.info(error.message));
  }
  function sync(feature) {
    intelSurfaces(feature);
    for (const handle of commands.get(feature) ?? []) handle.dispose();
    commands.delete(feature);
    if (!enabled(feature) || !Object.hasOwn(G.AtriumButterCatalog, feature)) return;
    if (feature === "windows" && G.AtriumHost?.workspaceWindow)
      L.need("AtriumProjectWindowClient").then(client => G.AtriumNavCommon?.ready(() => client.install()),
        error => G.AtriumNavHost?.info(error.message));
    const descriptor = metadata(feature), handles = [];
    for (const spec of descriptor.commands) {
      if (!B.eligible(spec, "editor")) continue;
      const id = key(feature) + "." + spec.id;
      handles.push(G.AtriumKeymap.registerCommand({id, action:id, title:spec.title, category:descriptor.title, run() {
        if (!enabled(feature)) return;
        const host = G.AtriumNavHost;
        if (B.argumentSchema(spec).required?.length) {host?.info("This command requires arguments."); return;}
        const options = spec.kind === "state" && spec.editorMode === "write" ? {mode:"write", grant:writeGrant}
          : {mode:spec.kind === "read" ? "read" : "plan"};
        B.run(id, {}, options).then(
          r => host?.info(B.failure(r.result)?.message ??
            spec.title + (r.changes != null ? " · " + r.changes + " changes" : " · Ready")),
          error => host?.info(error.message));
      }}));
    }
    surfaces(descriptor, handles);
    commands.set(feature, handles);
  }

  // Interfaces of the documents family: lazy, and registered only
  // while their feature is on. Each opens from the palette and Window › Panels once used.
  const editorActionHandlers = {
    "butter.savedViews.panel": m => m.toggle("views"),
    "butter.savedViews.capture-current": m => m.open("views").then(() => m.captureView()),
    "butter.slides.panel": m => m.toggle("slides"),
    "butter.slides.present": m => m.open("slides").then(() => m.presentSlides()),
    "butter.datasheets.reader": m => m.toggle(),
    "butter.datasheets.open-pdf": m => m.choose()
  };
  function surfaces({feature, title, editorActions}, handles) {
    if (!editorActions?.length) return;
    L.register("AtriumDocsFamily", {scripts:["project/docs-family.js"], css:["project/docs-family.css"], deps:["AtriumHistoryArtwork"]});
    L.register("AtriumViewsPanel", {scripts:["project/views-panel.js"], deps:["AtriumDocsFamily"]});
    L.register("AtriumDatasheetReader", {scripts:["notebook/datasheet-reader.js"], deps:["AtriumDocsFamily","AtriumDatasheets"]});
    for (const action of editorActions) {
      const id = key(feature) + "." + action.id, handle = editorActionHandlers[id];
      if (!handle) unsupported("No editor handler for " + id + ".");
      handles.push(G.AtriumKeymap.registerCommand({id, action:id, title:action.title, category:title, run() {
        if (enabled(feature)) L.need(action.module).then(handle).catch(error => G.AtriumNavHost?.info(error.message));
      }}));
    }
  }

  async function load(descriptor, spec) {
    const feature=descriptor.feature;
    if (!modules.has(feature)) {
      const name = "AtriumButterFeature_" + feature;
      L.register(name, {scripts:[descriptor.editorHandler]});
      modules.set(feature, name);
    }
    await L.need([...(descriptor.modules?.editor ?? []), ...(spec.modules?.editor ?? [])]);
    await L.need(modules.get(feature));
  }

  async function dispatch(descriptor, spec, args, options) {
    const host = G.AtriumNavHost, source = options.source ?? "editor", feature = descriptor.feature;
    if (!host || !["editor","macro","extension"].includes(source)) unsupported("Butter editor commands are unavailable.");
    const project = host.project(), revision = host.revision(), documentId = host.currentId(), selection = host.selection();
    const workspace = host.fileSession?.() ?? project;
    const allowWrite = options.grant === writeGrant && source === "editor";
    const mode = B.check(spec, args, source, options.mode, allowWrite);
    await load(descriptor, spec);
    if (!enabled(feature)) throw Object.assign(Error("This Butter feature is disabled."), {code:"butter_disabled"});
    const sameWorkspace = () => enabled(feature) && workspace === (host.fileSession?.() ?? host.project());
    const current = () => {
      if (!sameWorkspace()) return false;
      if (spec.workspaceRead === true) return true;
      if (project !== host.project() || revision !== host.revision() || documentId !== host.currentId()) return false;
      const now = host.selection();
      return now.length === selection.length && now.every((id, index) => id === selection[index]);
    };
    const proposalAPI = spec.kind === "edit" ? await L.need("AtriumProposal") : null;
    if (!current()) throw Object.assign(Error("The project or selection changed while opening this command."), {code:"stale_source"});
    const signal = {get aborted() {return !current();}};
    async function planCommand(id, args, input = {}) {
      const {descriptor:target, spec:command} = B.resolve(id, "macro");
      B.check(command,args,"macro","plan",false);
      await load(target,command);
      if (!current() || !enabled(target.feature)) unsupported("The macro command is no longer current.");
      return B.invoke(target.feature,command,args,{source:"macro",mode:"plan",scope:workspace,
        project:input.project ?? project,documentId:input.documentId ?? documentId,selection:input.selection ?? selection,
        revision,signal,isCurrent:() => current() && enabled(target.feature)}, B.requireSuccess);
    }
    return B.invoke(feature, spec, args, {source, project, revision, mode, allowWrite, scope:workspace, isCurrent:current,
      signal, plan:planCommand,
      documentId, selection}, async (receipt, {ops, file, commit}) => {
      const stateWrite = spec.kind === "state" && mode === "write", transitioned = stateWrite && spec.editorTransition === true;
      if (!transitioned && !(stateWrite ? sameWorkspace() : current()))
        throw Object.assign(Error("The project changed during this Butter command."), {code:"stale_source"});
      if (ops?.length) {
        const proposal = proposalAPI.guarded(project, receipt.command, ops);
        const prepared = proposalAPI.prepare(project, proposal, G.Atrium.validate);
        if (mode === "write") {
          if (allowWrite && options.beforeCommit) {
            options.beforeCommit();
            if (!current()) throw Object.assign(Error("The project changed before applying this Butter command."), {code:"stale_source"});
          }
          const accepted = prepared.apply((change, touched, scope) => host.edit(change, spec.title, touched, scope));
          if (!accepted) throw Object.assign(Error("This Butter edit cannot change the current project."), {code:"read_only"});
        } else if (mode === "proposal") receipt.proposal = proposal;
      }
      if (ops) receipt.changes = ops.length;
      if (file) {
        const payload = B.filePayload(file);
        receipt.saved = await host.exportFile(file.name, payload);
      }
      if (feature === "ai" && spec.id === "ask" && receipt.result.proposal) {
        const binding = G.AtriumAIProvidersDesktop.requestBinding(current);
        G.AtriumAI.bindEditorProposal(receipt.result.proposal,{host,project,revision,documentId,...binding});
      }
      commit();
      if (source === "editor") B.report(workspace,spec,args,receipt);
      return receipt;
    });
  }

  B.bind(dispatch);
  // Available only to first-party workbench handlers after a real user approval.
  globalThis.AtriumButterEditor = Object.freeze({apply: (id, args, {beforeCommit}={}) =>
    B.run(id, args, {mode:"write", grant:writeGrant,beforeCommit})});
  prefs.on("butter.", ({key:changed}) => sync(changed.slice(7)));
  for (const feature of Object.keys(G.AtriumButterCatalog)) if (enabled(feature)) sync(feature);
})();
