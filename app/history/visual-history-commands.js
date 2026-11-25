"use strict";

// Shared command adapters. Desktop calls use the attached editor. The headless worker
// owns a separate scratch project and clipboard for the life of that MCP connection.
(() => {
  const G = globalThis;
  const H = () => G.AtriumHistorySession;
  const C = () => G.AtriumClipHistory;
  let editor, scratch;

  function active(context) {
    if (context.source === "mcp") {
      if (!scratch) throw Error("Open an MCP history session on the bound design first.");
      return scratch;
    }
    const host = G.AtriumNavHost;
    if (!host?.project?.() || !host.undoSteps) throw Error("Open a design in Waffle first.");
    if (editor?.host !== host) editor = {host, session:H().bind(host)};
    return editor;
  }
  function record(args, {host}) {
    const p = host.project(), proposal = {format:"atrium-ai", version:2, project:p.name,
      ops:args.ops, document_ids:p.documents.map(d => d.id)};
    return {applied:G.AtriumProposal.applyChecked(p,proposal,{validate:G.Atrium.validate,
      edit:(fn,_,hint,scope) => host.edit(fn,args.label,hint,scope)})};
  }
  function getDocument(host, id) {
    const d = id == null ? host.doc?.() : host.docById(id);
    if (!d || !["pcb","schematic"].includes(d.kind)) throw Error("Choose a schematic or PCB document.");
    return d;
  }
  function clipboardCopy(args, context) {
    const {host} = active(context), doc = getDocument(host,args.documentId), ids = args.itemIds || host.selection?.() || [];
    const clip = G.AtriumEditSelection.capture(doc,host.defs(),new Set(ids),false,host.project().blobs,host.project());
    if (!clip) throw Error("The selected document contains none of those clipboard objects.");
    const entry = C().recordSelection({clip,packet:G.AtriumSelectionClipboard.encode(clip,G.Atrium.id()),owner:doc},doc.name,
      context.source === "mcp" ? null : host.folderProject?.());
    if (!entry) throw Error("The clipboard entry exceeds the size limit.");
    return entry;
  }
  function clipboardRead(args) {
    const clip = C().read(args.entry);
    if (!clip) throw Error("The clipboard entry expired.");
    return clip;
  }
  function clipboardPaste(args, context) {
    const {host} = active(context), doc = getDocument(host,args.documentId), clip = clipboardRead(args), owner = host.project();
    if (clip.kind !== doc.kind) throw Error("The clipboard entry belongs to a different document kind.");
    const session = host.folderProject?.();
    const isCurrent = () => context.isCurrent?.() !== false && host.project() === owner &&
      host.docById(doc.id) === doc && host.folderProject?.() === session;
    const apply = () => {
      let plan, ids=[];
      try {
        if (!isCurrent()) throw Error("The document changed while preparing the clipboard entry.");
        plan=G.AtriumEditSelection.prepare(owner,doc,clip,host.defs());
        const applied=host.edit(()=>{ids=plan.commit([args.x,args.y]);}, "Paste from clipboard",
          ()=>[{doc,items:ids},{library:true}], {documents:[doc.id],items:[]});
        return {ids:applied===false?[]:ids};
      } finally {
        if (plan) plan.cancel?.();
        else G.AtriumClipboardMedia?.cancelClip(clip);
      }
    };
    // MCP keeps asset references in its bound scratch design without transferring original bytes.
    if (context.source === "mcp") return apply();
    if (session?.canEdit?.(doc.id) === false || G.AtriumCollabLock?.guard(doc.id)) return {ids:[]};
    return Promise.resolve(G.AtriumEditSelection.demand(clip))
      .then(()=>C().prepareAssets(args.entry,clip,{target:host,document:doc,isCurrent})).then(apply);
  }
  function compareModels(before, after, args) {
    const ops = G.AtriumProposal.diff(before || {name:after.name, documents:[], library:[]},after);
    const result = H().page(ops,args);
    return {...result, beforeExists:!!before, items:result.items.map(op => ({op:op.op, target:op.target,
      documentId:op.document ?? null, id:op.id ?? op.value?.id ?? null, path:op.path ?? null}))};
  }
  function git(id, args, context) {
    // Native MCP queries are resolved in the bound-host adapter, never by caller paths.
    if (context.source === "mcp") {
      if (id === "git-list" || id === "git-branch") return context.services.native;
      const before = JSON.parse(context.services.native);
      if (id === "git-compare") return compareModels(before, context.project, args);
      return gitDocument(before,args);
    }
    return editorGit(id,args,context);
  }
  async function editorGit(id,args,context) {
    const {host} = active(context);
    const L = G.AtriumLazy;
    await L.need(["AtriumGitPicker", "AtriumProjectHistoryData"]);
    const source = G.AtriumProjectHistoryData.source(G.AtriumGit);
    try {
      if (id === "git-list") return await source.query("projectLog",
        {limit:args.limit ?? 50, skip:args.offset ?? 0, ...(args.snapshot?{snapshot:args.snapshot}:{})});
      if (id === "git-branch") {
        if (G.AtriumHost?.historyPath) throw Error("Imported source history is read-only.");
        return await source.query("createBranch",{revision:args.revision,name:args.name,confirm:args.confirm});
      }
      const {project:before} = await source.project(args.revision);
      if (!source.current()) throw Error("The history source changed.");
      return id === "git-preview" ? gitDocument(before,args) : compareModels(before,host.project(),args);
    } finally { source.close(); }
  }
  function gitDocument(model, args) {
    const docs = model?.documents || [];
    const doc = docs.find(d => d.id === args.documentId);
    return {revision:args.revision, exists:!!model, documents:docs.map(d=>({id:d.id,kind:d.kind,name:d.name,count:d.items.length})),
      ...(args.documentId ? {document:doc ? {id:doc.id,...H().page(doc.items,args)} : null} : {})};
  }

  const write = run => (args,context) => context.mode === "write" ? run(args,context) : {requiresWrite:true};
  G.AtriumButter.register("visualHistory", {
    "session-open":write((_,context) => {
      if (context.source !== "mcp") throw Error("The editor already has an active Undo session.");
      if (scratch) throw Error("Close the existing MCP history session before opening another.");
      C().clear(true);
      scratch = H().open(context.project);
      return {state:"open", mode:"scratch", current:scratch.session.list({limit:1}).current};
    }),
    "session-close":write((_,context) => {
      if (context.source !== "mcp") throw Error("Only an MCP scratch history session can close here.");
      active(context);
      scratch = undefined;
      C().clear(true);
      G.AtriumUndoStore.reset();
      return {state:"closed"};
    }),
    "record-edit":write((args,context) => record(args,active(context))),
    "undo":write((args,context) => ({revision:active(context).host.historyGo(-(args.steps ?? 1))})),
    "redo":write((args,context) => ({revision:active(context).host.historyGo(args.steps ?? 1)})),
    "session-list":(args,context) => active(context).session.list(args),
    "session-preview":(args,context) => active(context).session.preview(args),
    "session-compare":(args,context) => active(context).session.compare(args),
    "session-thumbnail":(args,context) => active(context).session.thumbnail(args),
    "session-restore":write((args,context) => active(context).session.restore(args)),
    "session-fork":write((args,context) => active(context).session.restore(args,true)),
    "clipboard-list":(args,context) => { active(context); return H().page(C().list(args.query,args.pinned),args); },
    "clipboard-copy":write(clipboardCopy),
    "clipboard-text":write((args,context) => {
      active(context);
      const result = C().recordText(args.text,{kind:args.kind, math:args.math, source:"Clipboard"});
      if (!result) throw Error("Choose nonempty text that fits on the clipboard.");
      return result;
    }),
    "clipboard-preview":(args,context) => {
      active(context);
      const clip = clipboardRead(args);
      return {kind:clip.kind, ...H().page(clip.items,args)};
    },
    "clipboard-pin":write((args,context) => { active(context); const result=C().pin(args.entry,args.on); if(!result) throw Error("The clipboard entry expired."); return result; }),
    "clipboard-rename":write((args,context) => { active(context); const result=C().rename(args.entry,args.name); if(!result) throw Error("The clipboard entry expired."); return result; }),
    "clipboard-remove":write((args,context) => { active(context); return {removed:C().remove(args.entry)}; }),
    "clipboard-clear":write((args,context) => { active(context); C().clear(false); return {state:"cleared"}; }),
    "clipboard-paste":write(clipboardPaste),
    "git-list":(args,context) => git("git-list",args,context),
    "git-preview":(args,context) => git("git-preview",args,context),
    "git-compare":(args,context) => git("git-compare",args,context),
    "git-branch":write((args,context) => git("git-branch",args,context)),
  });
})();
