"use strict";

// A detached native WebView is a project view. Only the adopted folder's
// authoritative editor has the capability that can write project members.
globalThis.AtriumProjectWindowClient = (() => {
  const G = globalThis, localKey = "projectWindows", W = G.AtriumWindowWorkspace;
  let identity, ownerSession, record, viewedTab, viewedRevision, applying = false, snapshotQueue = Promise.resolve(), isWatching = false;
  let writerEpoch, viewedEpoch, refreshing = false, refreshRequests = 0, installed = false;
  const auxiliaries = new Map();
  const pendingEdits = new Set();
  let auxiliarySnapshot;
  let operations = Promise.resolve();
  // What the Windows list shows (butter-windows-ui.js): the writer, recovery, the local store and
  // detached views that have not yet received their first snapshot.
  const status = {writer:"ready", recovery:null, store:null, loading:new Set()};
  function setStatus(change) {
    Object.assign(status, change);
    G.dispatchEvent?.(new G.CustomEvent("atrium-window-workspace-status"));
  }
  G.AtriumLazy?.register?.("AtriumWindowsUI", {scripts:["native-bridge/window-commands-ui.js"]});
  const host = () => G.AtriumNavHost;
  const enabled = () => G.AtriumPrefs?.get("butter.windows") === true;
  const native = payload => G.AtriumHost?.workspaceWindow?.(payload) ?? Promise.reject(Error("Project windows need a native editor host."));
  const isMirror = () => identity?.writer === false;
  const diagnostic = error => host()?.info(error?.message || String(error));
  const copy = data => JSON.parse(JSON.stringify(data));

  function serial(action) {
    const result = operations.then(action);
    operations = result.catch(() => {});
    return result;
  }

  function submitEdit(action) {
    const result = serial(action);
    pendingEdits.add(result);
    const settled = () => pendingEdits.delete(result);
    result.then(settled, settled);
    return result;
  }

  async function describe() {
    if (identity && isMirror()) return identity;
    const editor = host(), session = editor?.folderProject();
    if (!enabled() || !session || session.temporary || session.standalone || session.readOnly)
      throw Error("Open an editable native Waffle project to manage its windows.");
    if (session === ownerSession && identity) return identity;
    const delegate = await native({operation:"describe", grant:session.grant, project:editor.project().id});
    if (session !== editor.folderProject()) throw Error("The project has changed.");
    identity = delegate;
    ownerSession = session;
    writerEpoch = G.crypto.randomUUID();
    record = session.localState?.[localKey] ?? null;
    if (record?.owner && record.owner !== identity.window) {
      const rebind = layout => {
        const rename = id => id === record.owner ? identity.window : id;
        return {...layout, focused:rename(layout.focused), windows:layout.windows.map(row => ({...row, id:rename(row.id)}))};
      };
      record = {...record, owner:identity.window, current:rebind(record.current),
        saved:record.saved.map(entry => ({...entry, layout:rebind(entry.layout)}))};
    }
    if (!isWatching) {
      isWatching = true;
      for (const type of ["change", "selection", "highlight"]) editor.on(type, () => publish(type));
    }
    return identity;
  }

  function publish(type) {
    const editor = host();
    if (!identity || applying || !enabled()) return;
    const presence = type !== "change" ? {document:editor.currentId(), selection:editor.selection(), net:editor.highlight()} : null;
    if (isMirror()) {
      if (presence) forward("selection", presence).catch(diagnostic);
      return;
    }
    if (editor.folderProject() !== ownerSession || !record?.current?.windows.some(row => row.id !== identity.window)) return;
    native({operation:"broadcast", value:{type:presence ? "selection" : type, revision:editor.authoredRevision(), presence}}).catch(diagnostic);
  }

  function applyNative(layout, focused = layout.focused) {
    const additional = [...auxiliaries].map(([id,row])=>({id, active:row.documentId, tabs:[row.documentId]}));
    return native({operation:"apply-layout", windows:[...layout.windows,...additional], focused});
  }

  async function apply(next, restoreSplit = false) {
    const session = ownerSession;
    checkWriter(session);
    const layout = next.current;
    const editor = host(), authority = layout.windows.find(row => row.id === identity.window);
    if (!authority) throw Error("The project’s main window must retain a tab.");
    const before = new Set(record?.current?.windows.map(row => row.id) ?? [identity.window]);
    await applyNative(layout);
    checkWriter(session);
    record = {...next, owner:identity.window};
    for (const row of layout.windows) if (!before.has(row.id)) status.loading.add(row.id);
    for (const id of status.loading) if (!layout.windows.some(row => row.id === id)) status.loading.delete(id);
    try { await session.setView({[localKey]:record}, {strict:true}); }
    catch (error) { setStatus({store:{message:error?.message || String(error)}}); throw error; }
    setStatus({store:null});
    checkWriter(session);
    const split = editor.captureWorkspaceSplit();
    if (restoreSplit || split && !authority.tabs.includes(split.secondary))
      await editor.applyWorkspaceSplit(authority.active, restoreSplit ? authority.split : null);
    else if (editor.currentId() !== authority.active) await editor.selectDocument(authority.active);
    else editor.moduleLoaded();
    return layout;
  }

  async function layoutCommand(command, args, mode, from) {
    await describe();
    if (isMirror()) return forward("layout", {command, args, mode});
    const editor = host(), model = G.AtriumWorkspaceCommands;
    if (!model) throw Error("The window command catalogue is unavailable.");
    const preferred = command === "merge-all-windows" ? identity.window : from || identity.window;
    let current = record && {...record, current:{...record.current, focused:preferred,
      windows:record.current.windows.map(row => row.id === identity.window && row.tabs.includes(editor.currentId()) ?
        {...row, active:editor.currentId()} : row)}};
    if (command === "save-workspace-layout") {
      const members = editor.documentRefs().map(row=>row.id);
      let {layout} = W.restore(current?.current, identity.project, members, identity.window, editor.currentId(), {preserveWriter:true});
      const description = await native({operation:"describe"});
      const frames = new Map((description.frames || []).map(({id,bounds})=>[id,bounds]));
      for (const row of layout.windows) layout = W.plan(layout, "window-view", {window:row.id, tab:row.active,
        bounds:frames.get(row.id), split:row.id === identity.window ? editor.captureWorkspaceSplit() : undefined});
      current = {...current, version:W.version, project:identity.project, current:layout, saved:current?.saved || []};
    }
    const result = model.run(command, args, {project:identity.project, members:editor.documentRefs().map(row => row.id),
      active:editor.currentId(), initialWindow:identity.window, newWindow:G.crypto.randomUUID(), record:current, preserveWriter:true});
    if (result.next && mode === "write") {
      await apply(result.next, command === "restore-workspace-layout");
    }
    const {next, ...readable} = result;
    return readable;
  }

  function show(tab) {
    if (tab !== viewedTab) viewedEpoch = viewedRevision = undefined;
    viewedTab = tab;
    const result = snapshotQueue.catch(() => {}).then(async () => {
      if (viewedTab !== tab) return false;
      const packet = await native({operation:"snapshot", value:{document:tab}});
      if (viewedTab !== tab || packet.project.id !== identity?.project || packet.document !== tab) return false;
      const editor = host(), view = editor.currentId() === tab ? editor.captureViewState?.() : null;
      const presence = view && {selection:editor.selection(), netHighlight:editor.highlight()};
      applying = true;
      try {
        await editor.replaceProject(packet.project, {force:true, dirty:false, workspaceMirror:true, document:tab});
        if (view) editor.applyViewState?.({...view, ...presence});
        viewedRevision = packet.revision;
        viewedEpoch = packet.epoch;
        if (packet.auxiliary) auxiliarySnapshot = packet.auxiliary;
        G.AtriumStartPage?.close?.();
        return true;
      } finally { applying = false; }
    });
    snapshotQueue = result;
    return result;
  }

  async function refreshView() {
    refreshRequests++;
    if (refreshing) return;
    refreshing = true;
    try {
      let requested;
      do {
        requested = refreshRequests;
        try { await show(viewedTab); }
        catch (error) { if (requested === refreshRequests) throw error; }
      } while (requested !== refreshRequests);
    } finally { refreshing = false; }
  }

  async function shareSelection(value, rebroadcast = true) {
    if (!value || typeof value.document !== "string" || !Array.isArray(value.selection)) return false;
    if (host().currentId() === value.document) {
      applying = true;
      try { host().select(value.selection); host().setHighlight(value.net || ""); }
      finally { applying = false; }
    }
    if (rebroadcast) await native({operation:"broadcast", value:{type:"selection", presence:value}});
    return true;
  }

  async function receive(event) {
    try {
      if (event.type === "rpc") {
        try {
          const value = await serve(event.packet);
          await native({operation:"deliver", token:event.token, value});
        } catch (error) {
          await native({operation:"deliver", token:event.token, error:error.message});
        }
      } else if (event.type === "arrival") {
        const delegate = await native({operation:"describe"});
        if (delegate.writer) return;
        identity = delegate;
        if (status.recovery) setStatus({writer:"ready", recovery:{state:"reattached"}});
        if (!isWatching) {
          isWatching = true;
          for (const type of ["selection", "highlight"]) host().on(type, () => publish(type));
        }
        await show(event.tab ?? delegate.tab);
      } else if (event.type === "view") {
        if (isMirror()) await show(event.tab);
        if (isMirror() && status.recovery?.state === "reattaching") setStatus({writer:"ready", recovery:{state:"reattached"}});
      } else if (event.type === "change") {
        if (isMirror() && viewedTab) await refreshView();
      } else if (event.type === "selection" && isMirror()) await shareSelection(event.presence, false);
      else if (event.type === "auxiliary" && isMirror() && event.window === identity.window) auxiliarySnapshot = event.value;
      else if (event.type === "probe" && isMirror() && viewedTab === event.value?.docId) {
        applying = true;
        try { (await G.AtriumLazy.need("AtriumCrossProbe")).go(event.value, event.keyboard); }
        finally { applying = false; }
      }
      else if (event.type === "closed" && identity?.writer && auxiliaries.has(event.window)) auxiliaries.delete(event.window);
      else if (event.type === "closed" && identity?.writer && record?.current?.windows.some(row => row.id === event.window)) {
        await serial(() => apply({...record, current:W.plan(record.current, "close-window", {window:event.window})}));
      } else if (event.type === "writer-unavailable") {
        viewedEpoch = viewedRevision = undefined;
        setStatus({writer:"unavailable", recovery:{state:"reattaching"}});
        host()?.info("Reopen the project to recover its shared writer.");
      }
    } catch (error) { diagnostic(error); }
  }

  function send(kind, data) {
    return native({operation:"command", value:{kind, data}});
  }

  function forward(kind, data = {}) {
    if (kind === "edit") {
      const request = {...data, epoch:data.epoch ?? viewedEpoch};
      return submitEdit(() => send(kind, request));
    }
    if (kind === "save" || kind === "undo" || kind === "redo") {
      const request = {...data, document:viewedTab};
      const edits = kind === "save" ? [...pendingEdits] : [];
      return serial(async () => { await Promise.all(edits); return send(kind, request); });
    }
    return send(kind, data);
  }

  function openAuxiliary({kind, documentId, deckId}) {
    return serial(async () => {
      await describe();
      const editor = host(), members = editor.documentRefs().map(row=>row.id);
      if (!identity.writer || kind !== "presenter" || !members.includes(documentId) || typeof deckId !== "string" || !deckId)
        throw Error("The presenter needs a deck from the active project.");
      if (!record) record = {version:W.version, project:identity.project, owner:identity.window,
        current:W.initial(identity.project,members,identity.window,editor.currentId()), saved:[]};
      const windowId = G.crypto.randomUUID(), row = {kind, documentId, deckId, snapshot:null};
      auxiliaries.set(windowId,row);
      try { await applyNative(record.current,windowId); }
      catch (error) { auxiliaries.delete(windowId); throw error; }
      return Object.freeze({windowId,
        update(snapshot) {
          return serial(async ()=>{
            if (!auxiliaries.has(windowId)) return false;
            const value = copy(snapshot);
            if (JSON.stringify(value).length > (1<<16)) throw Error("The presenter update is too large.");
            row.snapshot = value;
            return native({operation:"broadcast", value:{type:"auxiliary", window:windowId, value}});
          });
        },
        close() { return serial(()=>auxiliaries.delete(windowId) ? applyNative(record.current) : false); }
      });
    });
  }

  function submit(before, after, label) {
    const revision = viewedRevision, document = viewedTab, epoch = viewedEpoch, original = copy(before);
    return submitEdit(async () => {
      const P = await G.AtriumLazy.need("AtriumProposal"), ops = P.diff(original, after);
      if (!ops.length) return false;
      return send("edit", {document, revision, epoch, id:G.crypto.randomUUID(), label, ops});
    });
  }

  function probeHere(target, keyboard) {
    if (!isMirror()) return false;
    forward("probe", {target, keyboard, document:viewedTab}).catch(diagnostic);
    return true;
  }

  function routeProbe(value, keyboard) {
    if (!identity?.writer || applying || !record?.current?.windows.some(row => row.id !== identity.window && row.active === value.docId)) return false;
    native({operation:"broadcast", value:{type:"probe", value, keyboard}}).catch(diagnostic);
    return true;
  }

  function inverse(ops) {
    return ops.filter(op => op.op === "set").map(({before, after, ...op}) => ({...op,
      ...(after !== undefined ? {before:after} : {}), ...(before !== undefined ? {after:before} : {})}));
  }

  function recoveredStructure(P, project, ops) {
    return ops.filter(op=>op.op !== "set").every(op=>{
      const records = op.target === "item" ? project.documents.find(doc=>doc.id === op.document)?.items : project.library;
      if (!records) return false;
      if (op.op === "remove") return !records.some(row=>row.id === op.id);
      return op.op === "add" && records.some(row=>row.id === op.value.id && P.equal(row,op.value));
    });
  }

  function checkWriter(session) {
    if (session !== host().folderProject()) throw Error("The project writer is unavailable.");
  }

  async function applyGuarded(session, data, replay) {
    const editor = host(), P = await G.AtriumLazy.need("AtriumProposal");
    await session.requireClosure({purpose:"project"});
    await editor.afterWorkspaceGesture(() => {
      checkWriter(session);
      if (!replay && editor.authoredRevision() !== data.revision)
        throw Object.assign(Error("The project changed before the detached edit was applied."), {unchanged:true});
      const project = editor.project();
      if (!Array.isArray(data.ops) || data.ops.length === 0 || data.ops.some(op =>
        !((op.target === "item" && op.document === data.document) || (op.target === "document" && op.id === data.document && op.op === "set") || op.target === "library")))
        throw Error("A detached tab can only change its own document and project library.");
      const proposal = {format:"atrium-ai", version:2, tool:"workspace-edit", project:project.name,
        document_ids:project.documents.map(row => row.id).sort(), source_sha256:null, ops:data.ops};
      // The tab's own editor already applied these edits, so the designator rules for automation
      // proposals do not apply; every guard and the validator still do.
      const replayed = {designators:false};
      try { P.inspect(proposal, project, undefined, 0, replayed); }
      catch (error) {
        if (!replay) throw error;
        const original = inverse(data.ops);
        if (!recoveredStructure(P,project,data.ops)) throw error;
        if (original.length) P.inspect({...proposal, ops:original}, project, undefined, 0, replayed);
        return;
      }
      const accepted = P.applyChecked(project, proposal, {...replayed, validate:p => G.Atrium.validate(p, {normalize:false}),
        edit:(change, _, touched, scope) => editor.edit(change, typeof data.label === "string" ? data.label.slice(0,120) : "Edit in another window", touched, scope)});
      if (!accepted) throw Error("The project writer declined this edit.");
    });
  }

  async function finishEdit(session, data, replay = false) {
    await applyGuarded(session, data, replay);
    await session.flushDrafts({required:true});
    checkWriter(session);
    const editor = host(), receipt = {id:data.id, revision:editor.authoredRevision(), dirty:editor.isDirty()};
    await session.setView({workspacePending:null, workspaceEditReceipt:receipt}, {strict:true});
    return receipt;
  }

  const assigned = from => record?.current?.windows.find(row => row.id === from)?.tabs;

  async function guardedEdit(session, data, from) {
    if (!data || typeof data.id !== "string" || !/^[a-f0-9-]{36}$/i.test(data.id))
      throw Error("The detached edit has no valid request identity.");
    const editor = host(), local = session.localState;
    if (data.epoch !== writerEpoch || !assigned(from)?.includes(data.document))
      throw Error("The project changed. Review the current tab before editing again.");
    if (local.workspaceEditReceipt?.id === data.id) return local.workspaceEditReceipt;
    if (local.workspacePending) {
      if (local.workspacePending.id === data.id && local.workspacePending.document === data.document)
        return finishEdit(session, local.workspacePending, true);
      throw Error("The project writer needs to finish recovering its previous edit.");
    }
    if (data.revision !== editor.authoredRevision())
      throw Error("The project changed. Review the current tab before editing again.");
    await session.setView({workspacePending:data}, {strict:true});
    try { return await finishEdit(session, data); }
    catch (error) {
      if (error.unchanged || editor.authoredRevision() === data.revision)
        await session.setView({workspacePending:null}, {strict:true});
      throw error;
    }
  }

  async function snapshot(session, id, from) {
    const editor = host(), auxiliary = auxiliaries.get(from);
    if (typeof id !== "string" || !assigned(from)?.includes(id) && auxiliary?.documentId !== id)
      throw Error("The selected project tab is unavailable.");
    for (;;) {
      const revision = editor.authoredRevision();
      const documents = await session.workspaceDocuments(id);
      const packet = await editor.afterWorkspaceGesture(() => {
        checkWriter(session);
        if (revision !== editor.authoredRevision()) return null;
        if (documents[0]?.id !== id) throw Error("The selected project tab is unavailable.");
        return {document:id, revision, epoch:writerEpoch, project:copy({...editor.project(), documents}),
          auxiliary:auxiliary?.snapshot ?? null};
      });
      if (packet) {
        if (status.loading.delete(from)) setStatus({});
        return packet;
      }
    }
  }

  function serve(packet) {
    if (!identity?.writer || !enabled() || ownerSession !== host().folderProject()) throw Error("The project writer is unavailable.");
    const session = ownerSession, editor = host();
    return serial(async () => {
      checkWriter(session);
      if (packet.operation === "snapshot") return snapshot(session, packet.value?.document, packet.from);
      const {kind, data} = packet.value;
      if (kind === "layout" && data.command === "return-tabs" && record?.current?.windows.some(row => row.id === packet.from))
        return returnNow(data.args ?? {}).then(layout => ({layout}));
      if (kind === "layout" && record?.current?.windows.some(row => row.id === packet.from)) {
        return layoutCommand(data.command, data.args, data.mode, packet.from);
      }
      if (kind === "selection") return shareSelection(data);
      if (kind === "edit") return guardedEdit(session, data, packet.from);
      if (kind === "probe") {
        const C = await G.AtriumLazy.need("AtriumCrossProbe");
        await session.requireClosure({purpose:"project"});
        const result = C.resolve(editor.project(), editor.defs(), data.document, data.target);
        return !!result && C.go(result, !!data.keyboard);
      }
      if (kind === "save" && assigned(packet.from)?.includes(data.document))
        return editor.saveProject(data.all === true ? {all:true} : {only:[data.document]});
      if ((kind === "undo" || kind === "redo") && assigned(packet.from)?.includes(data.document)) {
        const changed = await editor.afterWorkspaceGesture(() => {
          checkWriter(session);
          const revision = editor.authoredRevision();
          editor.historyGo(kind === "undo" ? -1 : 1);
          return revision !== editor.authoredRevision();
        });
        if (changed) await session.flushDrafts({required:true});
        return true;
      }
      throw Error("This operation is unavailable in a detached project window.");
    });
  }

  function visibleTabs(tabs) {
    if (isMirror()) return tabs.filter(row => row.id === viewedTab);
    if (!enabled() || identity?.writer !== true || host().folderProject() !== ownerSession) return tabs;
    const detached = new Set(record?.current?.windows.filter(row => row.id !== identity.window).flatMap(row => row.tabs));
    return tabs.filter(row => !detached.has(row.id));
  }

  async function restore() {
    const owner = host()?.folderProject();
    if (!enabled() || !owner?.workspaceRecoveryReady || !owner.localState?.[localKey]) return;
    await G.AtriumLazy.need("AtriumButterEditor");
    await describe();
    const pending = ownerSession.localState.workspacePending;
    if (pending) {
      setStatus({recovery:{state:"replaying", label:pending.label}});
      try { await finishEdit(ownerSession, pending, true); }
      catch (error) { setStatus({recovery:{state:"conflict", label:pending.label, message:error.message}}); throw error; }
      setStatus({recovery:{state:"reattached", label:pending.label}});
    }
    const current = W.restore(record.current, identity.project, host().documentRefs().map(row=>row.id), identity.window, host().currentId(), {preserveWriter:true}).layout;
    await apply({...record, current}, true);
  }

  // Saved layouts with what the list shows: window count, displays and documents that have gone.
  function layouts() {
    const members = new Set(host()?.documentRefs?.().map(row => row.id) ?? []);
    const key = layout => JSON.stringify(layout.windows.map(row => row.tabs));
    const now = record?.current && key(record.current);
    return (record?.saved ?? []).map(({name, layout}) => ({name, windows:layout.windows.length,
      displays:[...new Set(layout.windows.map(row => row.bounds?.display).filter(Boolean))],
      missing:layout.windows.flatMap(row => row.tabs).filter(tab => !members.has(tab)), active:key(layout) === now}));
  }

  // Dropping a detached tab back on the main window's strip, or Return in the Windows list.
  function returnTabs(args) {
    return serial(async () => {
      await describe();
      return isMirror() ? forward("layout", {command:"return-tabs", args, mode:"write"}) : returnNow(args);
    });
  }
  function returnNow({tab, window:windowId}) {
    {
      const current = record?.current;
      const source = current?.windows.find(row => row.id !== identity.window && (tab ? row.tabs.includes(tab) : row.id === windowId));
      if (!source) throw Error("This tab is already in the main window.");
      const moving = tab ? [tab] : source.tabs;
      const windows = current.windows.map(row => row.id === identity.window ? {...row, tabs:[...row.tabs, ...moving], active:moving[0]}
        : row === source ? {...row, tabs:row.tabs.filter(id => !moving.includes(id))} : row).filter(row => row.tabs.length);
      for (const row of windows) if (!row.tabs.includes(row.active)) row.active = row.tabs[0];
      return apply({...record, current:{...current, windows, focused:identity.window}});
    }
  }

  // Pending edit review (Windows list): the writer keeps a conflicting edit until someone discards it.
  function discardPending() {
    return serial(async () => {
      await describe();
      if (isMirror()) throw Error("Review the pending edit in the main window.");
      await ownerSession.setView({workspacePending:null}, {strict:true});
      setStatus({recovery:null});
    });
  }

  function install() {
    if (installed || !G.AtriumHost?.workspaceWindow) return;
    installed = true;
    const actions = [["list-windows","List Windows"], ["move-tab-to-new-window","Move Tab to New Window"], ["merge-all-windows","Merge All Windows"]];
    const buttons = [];
    for (const [command,label] of actions) {
      const action = "butter.windows." + command;
      const button = G.AtriumNavCommon.menuItem("window",action,label);
      if (button) buttons.push(button);
      host().registerAction(action, async () => {
        if (!enabled()) return;
        try {
          const B = await G.AtriumLazy.need("AtriumButterEditor");
          if (command === "list-windows") (await G.AtriumLazy.need("AtriumWindowsUI")).open();
          else await B.apply(action, {});
        } catch (error) { diagnostic(error); }
      });
    }
    G.AtriumPrefs.on("butter.windows", () => {
      for (const button of buttons) button.hidden = !enabled();
    });
    G.addEventListener("atrium-window-workspace-ready", () => serial(restore).catch(diagnostic));
    serial(restore).catch(diagnostic);
    G.AtriumLazy.need("AtriumWindowsUI").then(ui => ui.installTabs(), diagnostic);
  }

  return Object.freeze({receive, serve, isMirror, visibleTabs, forward, submit, copyProject:copy, probeHere, routeProbe, install,
    openAuxiliary, presenter:()=>auxiliarySnapshot && copy(auxiliarySnapshot), layouts, returnTabs, discardPending,
    status:() => ({...status, loading:[...status.loading], window:identity?.window ?? null, writerWindow:identity?.writer === true}),
    run:(command, args, context) => serial(() => layoutCommand(command, args, context.mode))});
})();
