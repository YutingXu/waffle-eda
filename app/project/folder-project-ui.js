"use strict";
// The editor adapts the existing undo journal to owner updates. This is loaded only by a folder
// open, a folder conversion, or first save. Ordinary design and drawing code stays in the editor.
globalThis.AtriumFolderProjectUI = (() => {
  const t = AtriumI18n.define({
    "import_save.folder.changed_before_open": "The design changed before opening the saved folder.",
    "import_save.folder.prepare": "Preparing the new project folder…",
    "import_save.folder.changed_before_save": "The design changed during preparation. Save again to include those edits.",
    "import_save.folder.saved_snapshot": "Saved a project snapshot. Newer changes remain open.",
    "import_save.folder.saved": "Saved Waffle project {name}"
  });
  const DONE = ["compare", "connectivity", "compile", "erc", "bom", "annotate", "mcp", "eco", "eco-reverse", "fab", "fab-outputs", "output-jobs"];
  const clone = value => JSON.parse(JSON.stringify(value));
  const label = error => error?.message || String(error);
  const explorers = new WeakMap();
  const conflicts = new Map();
  const recoveryFiles = new WeakMap();
  const atomicWork = new WeakSet();
  function atomicEdit(session,apply) {
    if (atomicWork.has(session)) return apply();
    atomicWork.add(session);
    try {return apply();}
    finally {atomicWork.delete(session);}
  }
  function ownerChanges(records, dir, project) {
    const out = new Map();
    const get = (id, kind) => {
      if (!out.has(id)) out.set(id, {id, kind, put: new Map(), remove: new Set(), tableCells: new Map()});
      return out.get(id);
    };
    const add = (change, id, next, tableEdit) => {
      if (tableEdit?.id===id && !change.put.has(id) && !change.remove.has(id)) change.tableCells.set(id,tableEdit);
      else change.tableCells.delete(id);
      if (next == null) { change.put.delete(id); change.remove.add(id); }
      else { change.remove.delete(id); change.put.set(id, next); }
    };
    function settings(change, doc) {
      // Owner settings do not carry its placed objects. The worker retains their saved rows.
      const {items, ...rest} = doc; void items;
      change.settings = clone(rest);
      change.name = doc.name;
    }
    function step(r) {
      const n = r.node, doc = n?.doc?.ref;
      if (!n || r.t === "r") return;
      if (n.t === "l" && r.t === "s") {
        const [removed, inserted] = dir > 0 ? [r.removed, r.inserted] : [r.inserted, r.removed];
        for (const [, d] of removed) if (d?.id) get(d.id, d.kind).deleted = true;
        for (const [, d] of inserted) if (d?.id) Object.assign(get(d.id, d.kind), {deleted: false, owner: clone(d), name: d.name});
        return;
      }
      if (doc) {
        const change = get(doc.id, doc.kind);
        if (n.path === "items" && r.t === "e") {
          const store=globalThis.AtriumUndoStore,proof=store?.tableCellEdit?.(r,dir);
          const next=store?.tableItemSnapshot?.(r,dir)??(dir>0?r.after:r.before);
          add(change,r.ref.id,next,proof);
        } else if (n.path === "items" && r.t === "s") {
          const [removed, inserted] = dir > 0 ? [r.removed, r.inserted] : [r.inserted, r.removed];
          for (const [, item] of removed) if (item?.id) add(change, item.id, null);
          for(const [,item,saved] of inserted)if(item?.id){
            const next=globalThis.AtriumUndoStore?.tableItemSnapshot?.(saved)??saved;
            add(change,item.id,next);
          }
        } else if (n.path === "" && r.t === "k" && r.key === "items") {
          // An operation that replaced its entire Items owner is explicitly a bulk rewrite.
          const before = dir > 0 ? r.before : r.after, after = dir > 0 ? r.after : r.before;
          for (const item of before?.refs || []) if (item?.id) add(change, item.id, null);
          for (const item of after?.refs || []) if (item?.id) add(change, item.id, clone(item));
        } else settings(change, doc);
        return;
      }
      if (n.path === "library") {
        if (r.t === "e" && r.ref?.id) Object.assign(get(r.ref.id, "library"), {owner: JSON.parse(dir > 0 ? r.after : r.before), deleted: false});
        if (r.t === "s") {
          const [removed, inserted] = dir > 0 ? [r.removed, r.inserted] : [r.inserted, r.removed];
          for (const [, def] of removed) if (def?.id) get(def.id, "library").deleted = true;
          for (const [, def, text] of inserted) if (def?.id) Object.assign(get(def.id, "library"), {owner: JSON.parse(text), deleted: false});
        }
      } else if (!(n.path === "" && r.t === "k" && ["blobs", "documents", "library"].includes(r.key))) {
        const {documents, library, blobs, ...rest} = project; void documents; void library; void blobs;
        get(project.id, "project").settings = clone(rest);
      }
    }
    if (dir > 0) for (const row of records) step(row);
    else for (let i = records.length - 1; i >= 0; i--) step(records[i]);
    return [...out.values()].map(({put,remove,tableCells,...r}) => {
      const edits=[],items=[];
      for(const [id,item] of put){
        if(tableCells.has(id))edits.push({...tableCells.get(id),index:items.length});
        items.push(item);
      }
      return {...r,put:items,remove:[...remove],...(edits.length?{tableCells:edits}:{})};
    });
  }
  function bindingChangesOwner(records, changes) {
    if (changes.length < 2 || !changes.some(change => change.kind === "project")) return false;
    const owners = new Set(changes.map(change => change.id));
    const targetsOwner = text => {
      const target = JSON.parse(text)?.target;
      return (target?.scope === "document" || target?.scope === "item") && owners.has(target.documentId);
    };
    // The journal stores both sides of an edit, including a binding removed by
    // a cell replacement or restored by Undo. Use those snapshots for either direction.
    return records.some(r => {
      const n = r.node;
      if (!n || n.doc) return false;
      if (n.path === "" && r.t === "k" && r.key === "numericExpressions")
        return r.before?.vals?.some(targetsOwner) || r.after?.vals?.some(targetsOwner);
      if (n.path !== "numericExpressions") return false;
      if (r.t === "e") return targetsOwner(r.before) || targetsOwner(r.after);
      const touches = entries => entries.some(([, , text]) => targetsOwner(text));
      return r.t === "s" && (touches(r.removed) || touches(r.inserted));
    });
  }
  function updateInPlace(old, replacement) {
    // Preserve object identities used by Undo and the renderer when the file is reloaded.
    if (old.items && replacement.items) {
      const prior = new Map(old.items.map(item => [item.id, item]));
      replacement.items = replacement.items.map(item => {
        const prev = prior.get(item.id);
        if (!prev) return item;
        for (const key of Object.keys(prev)) if (!(key in item)) delete prev[key];
        Object.assign(prev, item);
        return prev;
      });
    }
    for (const key of Object.keys(old)) if (!(key in replacement)) delete old[key];
    Object.assign(old, replacement);
    return old;
  }
  function mergeImported(session,next,host) {
    const project = session.project;
    return atomicEdit(session,() => host.edit(() => {
      for (const [key,value] of Object.entries(next)) {
        if (key === "documents" || key === "library") {
          const previous = project[key], byId = new Map(previous.map(row => [row.id,row]));
          project[key] = value.map(row => {
            const prior = byId.get(row.id);
            if (!prior) return row;
            return JSON.stringify(prior) === JSON.stringify(row) ? prior : updateInPlace(prior,row);
          });
        } else if (JSON.stringify(project[key]) !== JSON.stringify(value)) project[key] = value;
      }
    },"Add imported design"));
  }
  function installDraft(project,bundle,separate) {
    if (bundle.header.settings) {
      const structural = new Set(["documents","library","blobs","layoutBlocks"]);
      const next = bundle.header.settings.value;
      for (const k of Object.keys(project)) if (!structural.has(k) && !(k in next)) delete project[k];
      for (const [k,v] of Object.entries(next)) if (!structural.has(k)) project[k] = v;
      // A draft can contain a full layout block list in settings. Explicit owner rows then apply over it.
      if (Array.isArray(next.layoutBlocks)) project.layoutBlocks = clone(next.layoutBlocks);
    }
    for (const row of bundle.rows) {
      const list = row.kind === "library" ? project.library : row.kind === "block" ? (project.layoutBlocks ||= []) : project.documents;
      const i = list.findIndex(d => d.id === row.id);
      if (row.deleted) { if (i >= 0) list.splice(i,1); continue; }
      const next = row.owner;
      for (const item of next.items || []) if (item.kind === "image" && item.asset) {
        const a = bundle.originals.find(a => a.ownerId === row.id && a.assetRef.sha256 === item.asset.sha256);
        if (!a || a.proof && !separate) continue;
        item.src = "data:"+a.assetRef.mediaType+";base64,"+(a.data || globalThis.AtriumFolderDrafts.base64(a.bytes));
        if (!a.proof) delete item.asset;
      }
      if (i < 0) list.push(next); else updateInPlace(list[i],next);
    }
    if (separate) project.name += " (Recovered copy)";
  }
  async function restoreDraft(ctx,{bundle,separate,session,copy}) {
    if (ctx.session() !== session) return false;
    const host = ctx.host();
    if (!separate) {
      atomicEdit(session,() => host.edit(() => installDraft(session.project,bundle,false),"Restore private draft"));
      return true;
    }
    // The folder remains the source of the saved version. This copy has no file target until its
    // owner selects one. Preserve verified originals for its ordinary Save As path.
    const {project,binary} = copy;
    installDraft(project,bundle,true);
    for (const doc of project.documents) for (const item of doc.items || []) if (item.kind === "image" && item.asset) {
      const data = binary.get("assets/"+item.asset.sha256);
      if (data) item.src = "data:"+item.asset.mediaType+";base64,"+data;
    }
    recoveryFiles.set(project,binary);
    if (!await host.replaceProject(project,{copy:true,current:() => ctx.session() === session})) return false;
    host.markUnsaved();
    return null;
  }
  async function offerDrafts(session,ctx) {
    const offers = await session.listDrafts();
    for (let i=0; i<offers.length; i++) {
      if (ctx.session() !== session) return;
      const offer = i ? (await session.listDrafts()).find(o => o.head.writer === offers[i].head.writer) : offers[0];
      if (!offer) continue;
      const changed = offer.state === "changed", unsupported = offer.state === "unsupported";
      const names = offer.head.rows?.map(r => r.name || r.id).join(", ") || "Project settings";
      const options = unsupported ? [] : [{label:changed ? "Open as Separate Copy" : "Restore Draft",value:changed ? "separate" : "restore",primary:true}];
      if (!changed && !unsupported && offers.length > 1) options.push({label:"Open as Separate Copy",value:"separate"});
      options.push({label:"Keep for Later",value:"keep"},{label:"Discard Draft",value:"discard"});
      const message = unsupported ? "A newer Waffle version created this private draft." :
        names + (changed ? " changed after this private draft began. Open the recovered documents and their linked sheets and libraries in a separate copy." :
        " has unsaved changes from another window. Restore them to continue editing.");
      const written = offer.head.written && new Date(offer.head.written).toLocaleString();
      const answer = await confirm(written ? message + " Draft recorded " + written + "." : message,"Recover private draft",options);
      if (answer && ctx.session() === session) await session.resolveDraft(offer,answer);
    }
  }
  async function open(folder, ctx, {confirmed = false, signal, current, fromSave = false, expectedProjectId} = {}) {
    const H = folder.host || globalThis.AtriumHost;
    if (!confirmed && !await ctx.mayReplace()) {
      globalThis.AtriumDiagnostics?.performance?.begin("project","load")?.end("cancelled");
      await H.folderClose?.({grant:folder.grant});
      return false;
    }
    const timing = globalThis.AtriumDiagnostics?.performance?.begin("project","load");
    const U = globalThis.AtriumUndoStore;
    let session, off, subscribed, outcome = "failed";
    function install({result,old,list,at,project,batch}) {
      const owner = old || result.owner, mutate = () => {
        if (old) updateInPlace(old, result.owner); else list.splice(at,0,owner);
      };
      if (!batch && ctx.project() === project) U.reconcile(project, mutate, {doc: old && result.kind !== "library" ? old : null,
        library: result.kind === "library", structureChanged: !old && result.kind !== "library"});
      else mutate();
      return owner;
    }
    function prepareOwner(owner) {
      if (folder.standalone && owner.kind === "drawing" && !owner.drawing)
        return AtriumLazy.need("AtriumDrawing").then(drawing => { owner.drawing = drawing.normalize({}); });
      if (owner.kind !== "pcb") return;
      const modules = globalThis.AtriumLazy?.boardRenderers({documents:[owner]});
      if (modules?.length) return AtriumLazy.need(modules);
    }
    try {
      if (folder.status?.state === "conflict" && !await reviewJournal(folder,ctx)) {
        outcome = "cancelled";
        await H.folderClose?.({grant:folder.grant});
        return false;
      }
      session = await globalThis.AtriumFolderProject.open(folder,{host:H,install,prepareOwner,signal,
        restoreDraft:options => restoreDraft(ctx,options),
        installDefinitions(project,apply) {
          if (ctx.project() === project) U.reconcile(project,apply,{library:true}); else apply();
        },
        ignoredStores:async () => (await AtriumLazy.need("AtriumImportSidecars")).ignoreText,
        prepareSidecars:async options => (await AtriumLazy.need("AtriumProjectArchiveUI")).sidecarPlan({host:ctx.host(),...options})});
      if (expectedProjectId && session.project.id !== expectedProjectId) throw Error("The selected project does not match this link.");
      if (session.project.rules?.list?.length && !globalThis.AtriumDesignQueryRecord) await AtriumLazy.need("AtriumDesignQueryRecord");
      await globalThis.AtriumLazy?.need?.(globalThis.AtriumLazy.validatorsFor(session.project));
      const editor = ctx.host(), previous = editor.project(), edited = editor.authoredRevision?.();
      await editor.prepareWorkbench?.(session.project,{starterView:false});
      if (editor.project() !== previous || editor.authoredRevision?.() !== edited || current && !current()) {
        outcome = "cancelled";
        throw Error(t("import_save.folder.changed_before_open"));
      }
      // Edits made in an editor tab while the folder loaded ask now; a save reopening its own project keeps them.
      if (!fromSave && globalThis.AtriumDocViews?.mayDiscard?.() === false) {
        outcome = "cancelled";
        await session.close();
        return false;
      }
      if (await H.folderAdopt({grant:folder.grant,fromSave}) === false) throw Error("The folder could not be opened.");
      if (current && !current()) {
        outcome = "cancelled";
        throw Error(t("import_save.folder.changed_before_open"));
      }
      off = U.onAuthored((records, dir, project, action, restored) => {
        if (ctx.session() !== session || project !== session.project || ctx.derived()) return;
        const changes = ownerChanges(records, dir, project);
        const sheetStructure = changes.some(change => change.kind === "schematic" && (change.owner || change.deleted));
        const atomic = sheetStructure || atomicWork.has(session) || /^(eco|update-from-schematic)/.test(action || "") ||
          bindingChangesOwner(records, changes);
        if (changes.length) session.record(changes,{atomic,restored});
      });
      subscribed = session.on((event, detail) => {
        if (ctx.session() !== session) return;
        if (event === "dirty" || event === "saved") ctx.dirty(session.dirty);
        if (event === "saving") ctx.saving?.(session.pendingWrites > 0);
        if (event === "write-start" || event === "write-stop") ctx.pending(event === "write-start");
        if (event === "loaded" && detail.purpose !== "idle") ctx.updated(detail);
        if (event === "diagnostic") ctx.info(detail.message);
        if (event === "conflict") conflict(session, detail, ctx);
        if (event === "journal-conflict") reviewJournal(session,ctx).then(resolved => {
          if (resolved && ctx.session() === session) session.synchronize(detail.paths || [],true);
        }).catch(error => ctx.info(label(error)));
      });
      let restoredSplit = false, recoveryChecked = false, explorerQueued = false;
      const checkRecovery = () => {
        if (recoveryChecked || ctx.session() !== session) return;
        recoveryChecked = true;
        offerDrafts(session,ctx).catch(error => { if (ctx.session() === session) ctx.info(label(error)); }).finally(() => {
          if (ctx.session() !== session) return;
          session.workspaceRecoveryReady = true;
          if (globalThis.AtriumPrefs?.get("butter.windows") === true)
            globalThis.dispatchEvent?.(new Event("atrium-window-workspace-ready"));
        });
      };
      session.onPaint = () => {
        if (explorers.has(session)) ctx.explorer();
        else if (!explorerQueued) {
          explorerQueued = true;
          // The first active canvas frame has been drawn. Leave its next presentation
          // update clear of the initial batch of Explorer rows.
          requestAnimationFrame(() => {
            if (ctx.session() !== session) return;
            explorers.set(session,{limit:48});
            ctx.explorer();
          });
        }
        if (!restoredSplit) { restoredSplit = true; restoreSplit(session,ctx.host()); }
        checkRecovery();
      };
      ctx.adopt(session, () => { off(); subscribed(); session.close().catch(() => {}); }, {fromSave});
      timing?.ready();
      // A folder opened by Finder can be occluded from its first frame. WebKit suppresses rAF
      // there. Its explicit Open still needs a single recovery check before the user edits it.
      if (globalThis.document?.visibilityState === "hidden") queueMicrotask(checkRecovery);
      else requestAnimationFrame(() => requestAnimationFrame(checkRecovery));
      let reports;
      session.ensureImportReports = () => {
        // Undo can restore an edit made before the first lazy import-report read.
        if (ctx.session()!==session || !session.hasImportIndexes() || globalThis.AtriumImportReports?.capture()?.loadedRetained) return Promise.resolve();
        return reports ||= (async () => {
          const refs = session.importIndexes();
          const host = ctx.host(), fileSession = host.fileSession();
          const archive = await AtriumLazy.need("AtriumProjectArchiveUI");
          const lease = await session.readLease({purpose:"import reports"});
          try { await archive.restoreSidecars({host,session:fileSession,refs,lease}); }
          finally { await lease.release(); }
        })().finally(() => { reports = null; });
      };
      ctx.info(session.initialDiagnostic || (session.readOnly ? "This Waffle folder is read-only." : "Opened " + session.project.name));
      outcome = "completed";
      return true;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError" || error?.code === "cancelled" || error?.code === "stale_target") outcome = "cancelled";
      globalThis.AtriumDocViews?.keep?.();
      off?.(); subscribed?.();
      await session?.close();
      throw error;
    } finally { timing?.end(outcome); }
  }
  function present(session, id) {
    if (!session || session.activeId !== id || session.hasPresented(id)) return;
    if (!session.paintQueued) {
      session.paintQueued = true;
      requestAnimationFrame(() => { session.paintQueued = false;
        if (session.activeId === id) { session.presented(id); session.onPaint?.(id); } });
    }
  }
  function explorerDocuments(session) {
    const layout = explorers.get(session);
    if (!layout || !session.hasPresented(session.activeId)) return tabs(session,session.activeId);
    const documents = session.documentWindow(layout.limit + 1,null);
    const hasMore = documents.length > layout.limit;
    if (hasMore) {
      documents.pop();
      if (!layout.more) {
        const more = layout.more = document.createElement("button");
        more.type = "button"; more.className = "nav-row ui-project-more"; more.textContent = "Show more documents";
        more.setAttribute("role","treeitem");
        more.onclick = () => { layout.limit += 48; session.onPaint?.(); };
      }
    }
    if (!documents.some(d => d.id === session.activeId)) documents.push(session.document(session.activeId));
    return {documents,more:hasMore ? layout.more : undefined};
  }
  function tabs(session, id) {
    return [...new Set([...(session.localState.openTabs || []),id])].map(doc => session.document(doc)).filter(Boolean);
  }
  function rememberView(session, activeDocument, views) {
    const openTabs = [...new Set([...(session.localState.openTabs || []), activeDocument])];
    const cameras = Object.fromEntries([...views].map(([id, x]) => [id,{...x,hidden:[...x.hidden]}]));
    session.setView({activeDocument, openTabs, cameras});
  }
  function restoreSplit(session,host) {
    const split = session.localState.split;
    if (!split || split.doc === session.activeId || !session.getDocumentRef(split.doc)) return;
    requestAnimationFrame(() => {
      if (host.folderProject() !== session || session.localState.split !== split || host.panes().length > 1) return;
      host.openSplit(split.orientation,split.doc,{ratio:split.ratio});
    });
  }
  function revertOwner(session,id,host) {
    return session.discardDocument(id,previous => host.edit(() => updateInPlace(host.docById(id),previous),"Don’t Save",null,{documents:[id]}));
  }
  function restoreView(session, views) {
    for (const [id, v] of Object.entries(session.localState.cameras || {})) {
      if (v?.view && session.getDocumentRef(id)) views.set(id, {...v, hidden:new Set(v.hidden || [])});
    }
  }
  async function confirm(message, name, options) {
    const Shell = globalThis.AtriumShell;
    if (!Shell?.dialog) return globalThis.confirm?.(message) ? options[0]?.value : null;
    let value = null;
    const d = Shell.dialog({title:name, body:[message],
      actions:[{label:"Cancel", run:() => {}}, ...options.map(o => ({label:o.label, primary:o.primary, run:() => { value = o.value; }}))]});
    await d.done;
    return value;
  }
  function conflict(session, detail, ctx) {
    if (!session.resolveConflict) return ctx.info(detail.message);
    if (!detail.disk) {
      const choices = [{label:"Locate Document…",value:"locate",primary:true}];
      if (detail.base) choices.unshift({label:"Restore Saved Copy",value:"restore"});
      confirm(detail.message,"Document missing",choices).then(async choice => {
        if (!choice) return;
        let bytes;
        if (choice === "locate") {
          const file = await globalThis.AtriumHost?.pickFile?.([detail.path.match(/\.[^.]+$/)?.[0]]);
          if (!file) return;
          bytes = new Uint8Array(await file.arrayBuffer());
        }
        await session.restoreMissing(detail.id,bytes);
        if (session === ctx.session()) ctx.info("Document restored.");
      }).catch(error => ctx.info(label(error)));
      return;
    }
    confirm(detail.message, "Document changed on disk", [
      {label:"Keep My Changes", value:"keep"}, {label:"Use Disk Version", value:"disk"}, {label:"Merge", value:"merge", primary:true}
    ]).then(choice => choice && session.resolveConflict(detail.id, choice)).then(() => ctx.dirty(session.dirty), e => ctx.info(label(e)));
  }
  function reviewJournal(folder,ctx) {
    const {grant} = folder;
    if (conflicts.has(grant)) return conflicts.get(grant);
    const inspect = async () => {
      const H = globalThis.AtriumHost, info = await H.folderConflict({grant});
      const paths = new Set(info.paths), rows = [];
      const message = document.createElement("p");
      message.textContent = "Compare the saved transaction with the files on disk and choose a version for each path.";
      const feedback = document.createElement("p");
      feedback.setAttribute("role","status");
      async function download(member,side) {
        const parts = [];
        let offset = 0, eof = false;
        while (!eof) {
          const reply = await H.folderConflictRead({grant,transaction:info.transaction,path:member.path,side,offset,length:1024*1024});
          if (reply.sha256 !== (side === "staged" ? member.desired?.sha256 : member.current) ||
              reply.offset !== offset || !reply.eof && !reply.length) throw Error("The conflict changed. Review it again.");
          parts.push(Uint8Array.from(atob(reply.data),c => c.charCodeAt(0)));
          offset += reply.length; eof = reply.eof;
        }
        const bytes = new Uint8Array(offset);
        let at = 0; for (const part of parts) {bytes.set(part,at);at += part.length;}
        await ctx.host().exportFile(member.path.split("/").pop(),bytes);
      }
      for (const member of info.plan.filter(row => paths.has(row.path))) {
        const row = document.createElement("div"), name = document.createElement("label"), caption = document.createElement("span"), choose = document.createElement("select");
        name.className = "work-row";
        caption.textContent = member.path;
        choose.className = "ui-field";
        const action = (value,text) => {
          const option = document.createElement("option"); option.value = value; option.textContent = text; choose.append(option);
        };
        action("","Choose a version");
        action("external","Keep disk version"); action("staged","Use saved transaction");
        if (/\.(waffle|wsch|wpcb|wdraw|wpanel|wlib|wblock)$/.test(member.path)) action("merged","Enter merged records");
        const merged = document.createElement("textarea");
        merged.setAttribute("aria-label","Merged records for " + member.path); merged.hidden = true; merged.spellcheck = false;
        choose.onchange = () => { merged.hidden = choose.value !== "merged"; };
        name.append(caption,choose);row.append(name,merged);
        for (const [side,text,exists] of [["external","Export disk file",member.current],["staged","Export saved file",member.desired]]) if (exists) {
          const button = document.createElement("button"); button.type = "button"; button.textContent = text;
          button.onclick = () => download(member,side).catch(error => {feedback.textContent = label(error);});
          row.append(button);
        }
        rows.push({row,member,choose,merged});
      }
      if (!rows.length) throw Error("The folder is awaiting recovery. Open it again when recovery completes.");
      let resolved = false;
      const dialog = globalThis.AtriumShell.dialog({title:"Saved, external conflict",body:[message,...rows.map(r => r.row),feedback],
        actions:[{label:"Cancel"},{label:"Apply Choices",primary:true,async run() {
          if (rows.some(r => !r.choose.value || r.choose.value === "merged" && !r.merged.value.trim())) {
            feedback.textContent = "Choose one version for each path."; return false;
          }
          const choices = rows.map(({member,choose,merged}) => ({path:member.path,current:member.current,use:choose.value,
            ...(choose.value === "merged" ? {text:merged.value} : {})}));
          try {
            const merges = choices.filter(choice => choice.use === "merged");
            if (merges.length) {
              const worker = globalThis.AtriumFolderProject.workerIO();
              try {for (const {path,text} of merges) await worker.run("validateMerged",{path,text});}
              finally {worker.close();}
            }
            resolved = !!(await H.folderResolve({grant,transaction:info.transaction,choices}))?.saved;
          }
          catch (error) { feedback.textContent = label(error); }
          return resolved;
        }}]});
      await dialog.done;
      return resolved;
    };
    const job = inspect().finally(() => conflicts.delete(grant));
    conflicts.set(grant,job);
    return job;
  }
  async function downloadSaved(session,ctx) {
    const archive=await AtriumLazy.need("AtriumProjectArchiveUI");
    if(ctx.session()!==session)return false;
    return archive.save({host:ctx.host(),current:true});
  }
  async function save(session, ctx, {all = false, only, download = true} = {}) {
    if (session.standalone) {
      if (session.standalone.readOnly) { ctx.info(session.standalone.notice); return false; }
      only = [session.standalone.id]; all = false;
      if (session.dirty) {
        try { await session.standalone.beforeSave?.(); }
        catch (error) { ctx.info(label(error)); return false; }
        if (ctx.session() !== session) return false;
      }
    }
    const started = performance.now();
    ctx.flush();
    ctx.info("Saving…");
    const editorMs = performance.now() - started;
    try {
      let result = await session.save({documentId:ctx.current(), all, only, started, editorMs});
      if (result.needsSaveAll) {
        const go = await confirm("This change depends on edits in other project files.", "Save dependent changes",
          [{label:"Save All", value:true, primary:true}]);
        if (!go) { ctx.info("Save cancelled."); return false; }
        result = await session.save({all:true});
      }
      ctx.info(result.clean ? "No unsaved changes in this document" : session.dirty ? "Saved · other changes remain" : "Saved");
      if (!result.clean) session.noteSaveStatus();
      if (result.saved && session.temporary && download) return await downloadSaved(session,ctx);
      return result.saved;
    } catch (error) { ctx.info(label(error)); return false; }
  }
  function workflow(session, action, run, report) {
    if (action==="rules" && session?.hasImportIndexes() && !globalThis.AtriumImportReports?.capture()?.loadedRetained) {
      session.ensureImportReports().then(run,error=>report(label(error)));
      return true;
    }
    const library = ["library-place","library-panel","library-catalogue"].includes(action);
    const purpose = library ? "library-import" : action;
    if (!session || !library && !DONE.includes(action) || session.completeFor(purpose)) return false;
    session.requireClosure({purpose}).then(run, error => report(label(error)));
    return true;
  }
  async function create(ctx, {name, source, entry, entries, entryDocument = ctx.current(), signal, download = true, firstSave = false} = {}) {
    const native = globalThis.AtriumHost;
    ctx.flush?.();
    const host = ctx.host(), prior = ctx.session(), current = ctx.project(), session = host.fileSession();
    const revision = () => (firstSave ? host.authoredRevision?.() : null) ?? host.revision();
    const started = revision();
    const same = () => host.fileSession() === session && ctx.project() === current && revision() === started;
    let superseded = false;
    const checkAuthored = () => {
      signal?.throwIfAborted();
      if (firstSave && !same()) {
        superseded = true;
        throw Error(t("import_save.folder.changed_before_save"));
      }
    };
    let stem = String(name || current.name || "Project").normalize("NFC").replace(/[\\/:*?"<>|\x00-\x1f]/g,"-").trim().replace(/\.+$/g,"");
    if (!stem || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem)) stem = "Project";
    const hostName = stem + ".waffle";
    if (prior?.hasImportIndexes() && !source) await prior.verifySavedVersion({purpose:"save as",signal,localSources:true});
    const target = source ? {manifest:hostName} : native?.chooseProjectFolder ? await native.chooseProjectFolder({mode:"create",name:hostName}) :
      (await AtriumLazy.need("AtriumBrowserProject")).create(hostName);
    if (!target) {
      globalThis.AtriumDiagnostics?.performance?.begin("save","save")?.end("cancelled");
      return false;
    }
    let timing = globalThis.AtriumDiagnostics?.performance?.begin("save","save"), outcome = "cancelled";
    const H = target.host || native;
    let worker;
    const stop = () => worker?.close();
    signal?.addEventListener("abort",stop,{once:true});
    try {
      signal?.throwIfAborted();
      ctx.info(t("import_save.folder.prepare"));
      let prepared;
      if (prior && !source) prepared = await prior.copyTo(target.manifest,signal);
      else {
        const project = current;
        worker = await globalThis.AtriumFolderProject.conversionWorker(project);
        const archive = await globalThis.AtriumLazy.need("AtriumProjectArchiveUI");
        for (;;) {
          checkAuthored();
          const projection = host.revision();
          const converted = await worker.run("convert",{project,manifest:target.manifest,entryDocument,provenance:entry?.provenance});
          checkAuthored();
          if (firstSave && host.revision() !== projection) continue;
          const retained = entries?.map(row => row.scopeId === entry?.scopeId ? {...row,
            report:{...row.report,notes:[...(row.report.notes || []),...(converted.modelDiagnostics || []).map(item => item.message || String(item))]}} : row);
          const extras = await archive.sidecarPlan({host,entries:retained,read:() => null,signal});
          prepared = await worker.run("conversionPlan",{importIndexes:extras.refs,extraMembers:extras.members,extras:extras.plan});
          // Keep the latest completed derived copper without treating a background fill as an edit.
          if (!firstSave || host.revision() === projection) break;
        }
        const binary = recoveryFiles.get(project);
        if (binary) {
          const paths = new Set(prepared.plan.map(row => row.path));
          for (const [path,data] of binary) if (!paths.has(path)) prepared.plan.unshift({path,expected:null,data});
        }
      }
      const {plan} = prepared;
      checkAuthored();
      signal?.removeEventListener("abort",stop);
      if (source) {
        const files = plan.map(({path,data}) => ({path,data}));
        // The host asks where to put the project, suggesting this name (suffixed when taken) outside
        // the source project folder. A cancelled choice returns false and writes nothing.
        timing?.ready();
        const installed = await H.folderConvertSibling({file:source,manifest:target.manifest,files,version:prepared.version,
          folderName:stem,signal});
        if (!installed) return false;
        const folder = installed.folderProject || installed;
        timing?.end(typeof folder.grant === "string" ? "durable" : "completed");
        timing = null;
        if (!same()) {
          await H.folderClose?.({grant:folder.grant});
          ctx.info(t("import_save.folder.saved_snapshot"));
          return !firstSave;
        }
        if (!await open(folder,ctx,{confirmed:true,current:firstSave ? same : undefined,fromSave:true})) return false;
        ctx.info(t("import_save.folder.saved",{name:ctx.project().name}));
        return true;
      }
      timing?.ready();
      const committed = await H.folderCommit({grant:target.grant,projectId:prepared.projectId,manifest:target.manifest,plan});
      if (!committed?.saved) throw Error("The new folder could not be saved.");
      timing?.end(plan.length && committed.saved === true && !target.temporary ? "durable" : "completed");
      timing = null;
      if (!same()) {
        await H.folderClose?.({grant:target.grant});
        ctx.info(t("import_save.folder.saved_snapshot"));
        return !firstSave;
      }
      const opened=await open(target,ctx,{confirmed:true,current:firstSave ? same : undefined,fromSave:true});
      return opened && target.temporary && download ? downloadSaved(ctx.session(),ctx) : opened;
    } catch (error) {
      if (!superseded && !signal?.aborted && error?.name !== "AbortError") outcome = "failed";
      if (target.grant) await H.folderClose?.({grant:target.grant});
      throw error;
    } finally { timing?.end(outcome); signal?.removeEventListener("abort",stop); stop(); }
  }
  function retainRecoveryFiles(project,files) {
    recoveryFiles.set(project,new Map([...files].map(([path,bytes])=>[path,globalThis.AtriumFolderDrafts.base64(bytes)])));
  }
  return Object.freeze({open,save,create,retainRecoveryFiles,workflow,atomicEdit,mergeImported,present,ownerChanges,tabs,explorerDocuments,rememberView,restoreView,restoreSplit,revertOwner});
})();
