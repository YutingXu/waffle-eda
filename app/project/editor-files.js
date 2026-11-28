"use strict";

globalThis.AtriumEditorFiles = (() => {
  const t = AtriumI18n.define({
    "import_save.editor.changed_during_open": "The open project changed during import.",
    "import_save.editor.changed_session": "The project changed.",
    "import_save.editor.invalid_draft": "The imported design draft could not be verified.",
    "import_save.editor.draft_cleanup": "Saved. The private draft could not be cleared. {error}",
    "import_save.editor.choose_original": "Select the original EDA files to export to another format.",
    "import_save.editor.downloaded": "Downloaded {name}. The working design still needs a save.",
    "import_save.editor.exported_snapshot": "Exported a saved snapshot. Newer changes remain open.",
    "import_save.editor.exported": "Exported {name}.",
    "import_save.editor.preference_failed": "Exported {name}. Waffle couldn’t remember the destination. {error}",
    "import_save.editor.opening": "Opening {name}…",
    "import_save.editor.opening_count": "Opening {name}… {done} of {total}"
  });
  const nativeMemberSuffixes = Object.freeze([".wpcb",".wsch",".wlib",".wdraw",".wpanel"]);
  const nativeMemberName = name => nativeMemberSuffixes.includes(/\.[^.]+$/.exec(name ?? "")?.[0].toLowerCase());
  function nativeFiles(rows) {
    if (!Array.isArray(rows) || rows.length !== 1) throw Error("Add one Waffle document or component file at a time.");
    return rows.map(({name,data,nativeCopy}) => {
      if (!nativeMemberName(name) || /[\\/]/.test(name) || typeof data !== "string")
        throw Error("Choose a regular Waffle document or component file.");
      const bytes = Uint8Array.fromBase64?.(data) ?? Uint8Array.from(atob(data),ch => ch.charCodeAt(0));
      const file = new File([bytes],name);
      if (nativeCopy) Object.defineProperty(file,"nativeCopy",{value:nativeCopy});
      return file;
    });
  }
  function element(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }
  function button(text, run) {
    const b = element("button", text);
    b.type = "button"; b.className = "ui-button"; b.onclick = run;
    return b;
  }
  function dialog({title, body, actions, form, initialFocus}) {
    const d = element("dialog");
    if (!form) actions.classList.add("ui-sticky-actions");
    (form || d).append(title, ...body, actions);
    if (form) d.append(form);
    AtriumShell.adoptDialog(d, {title, body, actions, sheet:true, initialFocus});
    document.body.append(d);
    return d;
  }
  function report(messages, heading = "Import details", sections = []) {
    const title = element("h2",heading), list = element("ul"), actions = element("div");
    for (const message of messages) list.append(element("li",message));
    const done = button("Done",() => d.close());
    done.dataset.variant = "primary";
    actions.append(done);
    const d = dialog({title, body:[list,...sections], actions, initialFocus:done});
    d.addEventListener("close",() => d.remove(),{once:true}); d.showModal();
  }
  function promptValue(label, initial, submit, confirm = "Apply", numeric) {
    const title = element("h2",label), form = element("form"), input = element("input"), actions = element("div"), apply = button(confirm);
    form.method = "dialog"; input.className = "ui-field"; input.value = initial; input.setAttribute("aria-label",label); apply.type = "submit"; apply.dataset.variant = "primary";
    if(numeric){input.inputMode="decimal";globalThis.AtriumLazy?.numericField?.(input,numeric);}
    const value = element("div"); value.className = "ui-field-row"; value.append(input);
    actions.append(button("Cancel",() => d.close()),apply);
    const d = dialog({title, body:[value], actions, form, initialFocus:input});
    d.onclose = () => d.remove();
    form.onsubmit = event => {
      event.preventDefault();
      if (input.value.trim()) {d.close();submit(input.value.trim());}
    };
    d.showModal(); input.focus(); input.select();
  }
  function confirmReplace({name, dirty, save, isDirty}) {
    return new Promise(resolve => {
      let choice;
      const pick = value => () => {choice = value; d.close();};
      const title = element("h2", dirty ? "Save changes to “" + name + "” before closing?" : "Replace current project?");
      const detail = element("p", dirty ? "Your changes to “" + name + "” are lost if you close it without saving."
        : "Opening this file here will close " + name + ". Use File › Open to keep both projects open.");
      const actions = element("div"), cancel = button("Cancel",pick(null));
      const accept = button(dirty ? "Save" : "Replace project",pick(dirty ? "save" : "replace"));
      accept.dataset.variant = "primary";
      actions.append(cancel);
      if (dirty) {
        const discard = button("Don’t Save",pick("discard"));
        discard.dataset.variant = "danger";
        actions.append(discard);
      }
      actions.append(accept);
      const d = dialog({title, body:[detail], actions, initialFocus:cancel});
      d.onclose = async () => {d.remove(); resolve(choice === "save" ? await save() !== false && !isDirty() : !!choice);};
      d.showModal();
    });
  }
  async function newProject({before,units,fab,show,info}) {
    promptValue("New project","Untitled",async name => {
      if (!await before()) return;
      const project = globalThis.Atrium.project(name,globalThis.AtriumParts.catalogue);
      if (units() === "mil") project.units = "mil";
      for (const doc of project.documents) globalThis.AtriumPrefs?.sheetDefaults?.(doc);
      const rules = await fab(project);
      show(project,project.documents[0].id);
      info(rules ? "Project created with " + rules + " rules" : "Project created");
    });
  }
  function validName(host,name,kind,id) {
    const folder = host.folderProject();
    if (!folder) return true;
    if (!folder.canEdit(id)) {host.info("This Waffle document is read-only.");return false;}
    if (name !== name.normalize("NFC") || /[\\/:*?"<>|\u0000-\u001f\u007f]|[. ]$/.test(name) ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
      host.info("Choose a valid Waffle document name."); return false;
    }
    const parent = ref => ref?.path?.split("/").slice(0,-1).join("/") || "";
    const folderName = parent(folder.getDocumentRef(id)), key = name.toUpperCase().toLowerCase();
    if (folder.documents().some(d => d.id !== id && d.kind === kind && d.name.toUpperCase().toLowerCase() === key &&
        parent(folder.getDocumentRef(d.id)) === folderName)) {
      host.info("A document with that name already exists in this folder."); return false;
    }
    return true;
  }
  function addDocument(kind,host,accept) {
    const board = kind === "pcb", base = board ? "PCB layout" : "Schematic", owner = host.project();
    const names = new Set(host.documentRefs().map(d => d.name.trim().toLowerCase()));
    let next = 1;
    while (names.has((base + " " + next).toLowerCase())) next++;
    promptValue(board ? "Add PCB layout" : "Add schematic sheet",base + " " + next,async name => {
      if (host.project() !== owner) return;
      if (board && !globalThis.AtriumConnectivity) {
        try { await globalThis.AtriumLazy.need("AtriumConnectivity"); }
        catch (error) { if (host.project() === owner) host.info(error.message); return; }
      }
      if (host.project() !== owner || !validName(host,name,kind)) return;
      const offered = globalThis.Atrium.sheet(kind,name);
      globalThis.AtriumPrefs?.sheetDefaults?.(offered);
      accept(offered);
    },"Add");
  }
  function renameDocument(host) {
    const doc = host.doc();
    if (host.folderProject()?.standalone) { host.info("Rename this document in the file manager after closing it."); return; }
    promptValue("Rename document",doc.name,name => {
      if (host.docById(doc.id) === doc && doc.name !== name && validName(host,name,doc.kind,doc.id))
        host.edit(() => {doc.name = name;},"Rename document",[],{documents:[doc.id]});
      host.canvas().focus();
    },"Rename");
  }
  const pending = host => host.fileSession().imported;
  const native = () => globalThis.AtriumHost;
  const retains = file => !!file && native()?.canConvertSibling?.(file) === true;
  function importStatus(state,host) {
    if (!state) return null;
    return {kind:"foreign",id:state.id,sourceKey:state.sourceKey,translator:state.translator,
      formatLabel:state.formatLabel,sourceLabel:state.sourceLabel,name:host.project().name,
      state:state.operation ? "saving" : state.state,canSaveBeside:retains(state.sourceFile),canExport:state.canExport};
  }
  function syncImportHint(host) {
    const status = pending(host);
    if (!status || status.state === "exported" || status.state === "export-preferred") {
      globalThis.AtriumImportSaveView?.clearHint();
      return;
    }
    AtriumLazy.need("AtriumImportSaveView").then(view => {
      if (pending(host) === status && !status.exported)
        view.hint({formatLabel:status.formatLabel,onSave:anchor => host.saveProject({anchor})});
    },error => host.info(error.message));
  }
  function importState(anchor,host,values) {
    return anchor.imported = {...values,state:"unsaved",
      current:() => host.fileSession() === anchor,revision:() => host.revision()};
  }
  async function draftService() {
    const L = globalThis.AtriumLazy;
    return globalThis.AtriumForeignDrafts ||
      (L?.modules?.().includes("AtriumForeignDrafts") ? await L.need("AtriumForeignDrafts") : null);
  }
  async function prepareImported({read,reports,plan,format,names,signal},host) {
    const previous = host.fileSession(), revision = host.revision(), anchor = {};
    const sourceFiles = [...read.files], owned = sourceFiles.filter(retains), candidates = owned.length ? owned : sourceFiles;
    const extension = f => /\.[^./\\]+$/.exec(f.name.toLowerCase())?.[0];
    const sourceFile = candidates.find(file => format.projectExtensions?.includes(extension(file))) || candidates[0];
    const entry = reports.remember(anchor,read,plan.ids,names);
    const index = await AtriumLazy.need("AtriumImportSidecars");
    const inputs = (entry.provenance?.files || []).map(({name,path,sha256,byteLength,bytes}) =>
      ({name,path,sha256,byteLength:byteLength ?? bytes?.byteLength}));
    const nativeKey = native()?.importSaveKey?.(sourceFile) || null;
    const sourceKey = nativeKey || format.id+":"+await index.sha(new TextEncoder().encode(JSON.stringify(inputs)));
    const state = importState(anchor,host,{id:entry.scopeId,sourceKey,nativeKey,sourceFile,sourceFiles,inputs,
      name:plan.after.name,translator:format.id,formatLabel:format.label,canExport:format.export === true,
      sourceLabel:sourceFile?.name || names[0],entry});
    function current() {
      signal?.throwIfAborted();
      if (host.fileSession() !== previous || host.revision() !== revision) throw Error(t("import_save.editor.changed_during_open"));
    }
    current();
    const drafts = await draftService();
    await drafts?.begin({pending:state,model:plan.after,entries:[entry],signal});
    try {current();}
    catch (error) {await drafts?.retire(state);throw error;}
    return anchor;
  }
  function bindSource(state) {
    const H = native();
    if (!retains(state.sourceFile) || !H?.bindImportSave) return;
    const key = H.bindImportSave({file:state.sourceFile,files:state.sourceFiles});
    if (!key || state.nativeKey && state.nativeKey !== key) state.sourceFile = null;
    else state.nativeKey = key;
  }
  function activateImported(anchor,host) {
    const state = anchor.imported;
    bindSource(state);
    host.importSessionChanged();
  }
  async function restoreImported({pending:stored,model,entries},host) {
    const [reports,registry] = await AtriumLazy.need(["AtriumImportReports","AtriumTranslatorRegistry"]);
    const format = registry.get(stored?.translator), entry = entries?.find(entry => entry.scopeId === stored.id);
    if (format?.group !== "design" || !entry || typeof stored.sourceKey !== "string") throw Error(t("import_save.editor.invalid_draft"));
    const anchor = {};
    reports.installRetained(anchor,entries);
    const sourceFiles = !native() ? (stored.inputs || []).map(({name,path}) => ({name,path})) : [];
    const sourceFile = sourceFiles.find(file => file.name === stored.sourceLabel) || sourceFiles[0] || null;
    const state = importState(anchor,host,{id:stored.id,sourceKey:stored.sourceKey,nativeKey:stored.nativeKey,inputs:stored.inputs,
      name:model.name,translator:format.id,formatLabel:format.label,canExport:format.export === true,
      sourceLabel:stored.sourceLabel,sourceFile,sourceFiles,entry,restored:true});
    const opened = await host.replaceProject(model,{dirty:true,importFileSession:anchor});
    if (opened && state.current()) native()?.bindRestoredImportSave?.({id:state.id,sourceKey:state.sourceKey,format:state.translator});
    return opened;
  }
  async function reselectSource(state,signal) {
    const H = native();
    if (!state.restored || !state.nativeKey || !H?.reselectImportSave || retains(state.sourceFile)) return;
    const files = await H.reselectImportSave({sourceKey:state.nativeKey,format:state.translator,signal});
    if (state.current() && files?.length && retains(files[0])) {
      state.sourceFile = files[0];
      state.sourceFiles = files;
      bindSource(state);
    }
  }
  async function retireDraft(state,host,revision) {
    try {await (await draftService())?.retire(state, revision);}
    catch (error) {host.info(t("import_save.editor.draft_cleanup",{error:error.message}));}
  }
  function saveImported(state, options, ctx) {
    if (state.operation) return state.operation.promise;
    const {host,folderUI,folderContext,clean} = ctx;
    const controller = new AbortController(), signal = controller.signal;
    function check() {
      signal.throwIfAborted();
      if (!state.current()) throw new DOMException(t("import_save.editor.changed_session"),"AbortError");
    }
    const operation = state.operation = {controller,promise:null};
    operation.promise = (async () => {
      const view = await AtriumLazy.need("AtriumImportSaveView");
      let exporter, choice;
      if (state.canExport && !options.nativeOnly) {
        exporter = await AtriumLazy.need("AtriumImportExport");
        if (!options.as && await exporter.recall(state)) choice = "remembered";
      }
      check();
      if (!choice) choice = options.nativeOnly ? "waffle" : await view.firstSave({name:host.project().name,
        id:state.id,sourceKey:state.sourceKey,format:state.translator,formatLabel:state.formatLabel,
        canExport:state.canExport,file:state.sourceFile,anchor:options.anchor,signal});
      check();
      if (choice === "cancel" || !choice) return false;
      if (choice === "export" || choice === "remembered") {
        if (choice === "export" && state.restored && !state.sourceFile) await reselectSource(state,signal);
        check();
        if (!state.sourceFile) {
          host.info(t("import_save.editor.choose_original"));
          return false;
        }
        const revision = host.revision();
        state.name = host.project().name;
        const result = await exporter.exportImported({session:state,project:host.project(),choice,signal,anchor:options.anchor,isCurrent:state.current});
        check();
        if (result.status !== "exported") {
          if (result.status === "downloaded") host.info(t("import_save.editor.downloaded",{name:result.name}));
          else if (result.reason) host.info(result.reason);
          return false;
        }
        if (host.revision() !== (result.revision ?? revision)) {
          host.info(t("import_save.editor.exported_snapshot"));
          return false;
        }
        state.state = result.remembered ? "export-preferred" : "exported";
        state.exported = true;
        clean();
        host.info(result.preferenceError ? t("import_save.editor.preference_failed",{name:result.name,error:result.preferenceError}) :
          t("import_save.editor.exported",{name:result.name}));
        await retireDraft(state,host,result.revision ?? revision);
        return true;
      }
      if (choice !== "waffle") return false;
      if (!options.as) await reselectSource(state,signal);
      check();
      const source = !options.as && retains(state.sourceFile) ? state.sourceFile : undefined;
      if (!native()?.chooseProjectFolder && !source && options.download !== false &&
          !await view.confirmPortable({name:host.project().name,anchor:options.anchor,signal})) return false;
      check();
      const entries = globalThis.AtriumImportReports.retained();
      const entry = entries.find(current => current.scopeId === state.entry.scopeId);
      const ui = await folderUI();
      check();
      const at = state.revision();
      try {
        const saved = await ui.create(folderContext(),{source,entry,entries,signal,download:options.download,firstSave:true});
        if (saved && host.folderProject() && !host.isDirty()) await retireDraft(state,host,at);
        return saved;
      } finally {
        if (state.current() && retains(state.sourceFile)) bindSource(state);
      }
    })().catch(error => {
      if (state.current() && error.name !== "AbortError") host.info(error.message);
      return false;
    }).finally(() => {
      if (state.operation === operation) state.operation = null;
      if (state.current()) host.importSessionChanged();
    });
    host.importSessionChanged();
    return operation.promise;
  }
  // Opening progress in the status bar: a thin accent bar before the status text, which
  // carries the label. Determinate once the reader reports file counts. Display only.
  function openProgress(selection, info) {
    const status = globalThis.document?.getElementById?.("status");
    const named = selection.find(f => /\.(prjpcb|kicad_pro|waffle)$/i.test(f?.name || "")) || selection[0];
    const name = String(named?.folderProject?.name || named?.name || "").replace(/\.[^./]+$/,"") || "files";
    let node = null;
    if (status?.parentNode) {
      node = element("span");
      node.className = "ui-progress status-progress";
      node.setAttribute("role","progressbar");
      status.before(node);
    }
    // The bar shows the whole open, not only file reading: reading fills the first part, and the
    // reader's later stages (preparing, pouring each board, activating) call stage() for the rest.
    // It never moves backwards. Without file counts or a stage it stays indeterminate.
    let from = 0, span = .55, shown = -1;
    const show = (fraction, label) => {
      if (!node) return;
      const known = fraction != null;
      node.setAttribute("aria-label",label);
      node.toggleAttribute("data-indeterminate",!known);
      if (known) {
        shown = Math.max(shown, Math.min(1, fraction));
        node.setAttribute("aria-valuemin","0"); node.setAttribute("aria-valuemax","100");
        node.setAttribute("aria-valuenow",String(Math.round(shown * 100)));
        const w = node.clientWidth;
        node.style.setProperty("--ui-progress", String(w ? Math.round(w * shown) / w : shown));
      } else {
        for (const a of ["aria-valuemin","aria-valuemax","aria-valuenow"]) node.removeAttribute(a);
        node.style.removeProperty("--ui-progress");
      }
      info(label);
    };
    const bar = {
      update({done = 0, total = 0} = {}) {
        const known = total > 1;
        show(known ? from + span * Math.min(done,total) / total : shown >= 0 ? shown : null,
          known ? t("import_save.editor.opening_count",{name,done:Math.min(done + 1,total),total}) : t("import_save.editor.opening",{name}));
      },
      // A later stage of the open: the bar runs from `start` towards `end` as `part` goes 0 → 1.
      stage(start, end, part = 0, label) {
        from = start; span = end - start;
        show(start + span * Math.max(0, Math.min(1, part)), label || t("import_save.editor.opening",{name}));
      },
      end() { node?.remove(); node = null; }
    };
    bar.update();
    return bar;
  }
  async function open(selection, options, ctx) {
    const {host,info,folderUI,folderContext} = ctx;
    const openFolder = async folder => {
      const ui = await folderUI();
      options.current?.();
      return ui.open(folder,folderContext(),{expectedProjectId:options.expectedProjectId,signal:options.signal,
        current:options.current && (()=>{options.current();return true;})});
    };
    const first = selection[0], native = globalThis.AtriumHost;
    let progress;
    try {
      options.current?.();
      if (options.directories?.some(nativeMemberName)) throw Error("A Waffle document must be a regular file, not a folder.");
      if (!first) return false;
      progress = openProgress(selection,info);
      if (first.folderProject || selection.length === 1 && /\.zip$/i.test(first.name) && !options.into) {
        if (options.into || selection.length !== 1) throw Error("Open one Waffle project folder with File › Open.");
        const opened = first.folderProject ? await openFolder(first.memberPath ? {...first.folderProject,memberPath:first.memberPath} : first.folderProject) :
          await (await AtriumLazy.need("AtriumProjectArchiveUI")).open(first,{host,openFolder,signal:options.signal});
        const session = first.memberPath && host.folderProject?.();
        if (opened && session?.openedMember?.kind === "library") {
          const UI = await AtriumLazy.need("AtriumNativeMemberUI");
          const component = await session.ensureDocument(session.openedMember.id);
          if (host.folderProject?.() === session) await UI.showLibrary(component,host);
        }
        native?.finishedOpening?.(opened);
        return opened;
      }
      const manifests = selection.filter(file => /\.waffle$/i.test(file.name));
      if (manifests.length) {
        if (options.into || manifests.length !== 1) throw Error("Open one Waffle project folder with File › Open.");
        const opened = await (await AtriumLazy.need("AtriumProjectArchiveUI")).openManifest(manifests[0],selection,{openFolder,signal:options.signal});
        native?.finishedOpening?.(opened);
        return opened;
      }
      if (selection.some(file => nativeMemberName(file.name))) {
        if (selection.length !== 1) throw Error("Open or add one Waffle document or component file at a time.");
        const into = options.into || options.drop && !host.isStarter();
        const UI = await AtriumLazy.need("AtriumNativeMemberUI");
        const opened = await UI.open(first,{host,openFolder,into,current:options.current,beforeCommit:options.beforeCommit});
        native?.finishedOpening?.(opened);
        return opened;
      }
      const reader = await AtriumLazy.need("AtriumDesignReader");
      return await reader.open(selection,options,host,{
        context:ctx.context,leave:ctx.leave,adopt:ctx.adopt,report,fitOpened:ctx.fitOpened,progress,
        prepareImported:input => prepareImported(input,host),activateImported
      });
    } catch (error) {
      native?.finishedOpening?.(false);
      if (error.name==="AbortError" || ["cancelled","stale_target"].includes(error.code)) return false;
      info(error.message); report([error.message],"Couldn’t open this file");
      return false;
    } finally {
      progress?.end();
    }
  }
  return Object.freeze({report,promptValue,confirmReplace,open,newProject,addDocument,renameDocument,nativeMemberSuffixes,nativeFiles,
    importStatus,syncImportHint,bindSource,saveImported,restoreImported});
})();
