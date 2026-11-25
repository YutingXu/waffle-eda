"use strict";

// Opening a design is explicit. Its parser, project-file resolver and progress control
// load on that request, before the editor checkpoints or adopts the result.
globalThis.AtriumDesignReader = (() => {
  function progress(options = {}, bar) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let cancelled = false;
    const button = globalThis.document?.createElement?.("button");
    const abort = () => {cancelled=true;controller?.abort();};
    options.signal?.addEventListener("abort",abort,{once:true});
    if (options.signal?.aborted) abort();
    if (button) {
      button.type = "button";
      button.textContent = "Cancel import";
      button.className = "import-cancel";
      globalThis.AtriumUI?.button(button, "secondary");
      button.onclick = () => {abort();globalThis.AtriumImport?.cancel?.();};
      document.body.append(button);
    }
    return {
      bar,
      signal: controller?.signal,
      get cancelled() {return cancelled;},
      check() {
        options.current?.();
        if (!cancelled) return;
        const error = new Error("Import cancelled.");
        error.name = "AbortError";
        throw error;
      },
      close() {options.signal?.removeEventListener("abort",abort);button?.remove();}
    };
  }

  const registry = () => globalThis.AtriumTranslatorRegistry;
  function opensDesign(files) {
    return files.some(f => {
      const row = registry().forName(f.name);
      return row?.group === "design" && !registry().isLibrary(f.name);
    });
  }

  async function verifySelection(files, work, inspected) {
    const R = registry(), limits = R.limits;
    if (files.length > limits.files || files.some(f => f.size > limits.fileBytes) || files.reduce((sum, f) => sum + (f.size || 0), 0) > limits.totalBytes)
      throw Error("The selected files exceed the translator size or file count limit.");
    const altiumSheet = files.some(file => /\.schdoc$/i.test(file.name));
    for (const file of files) {
      work.check();
      if (!file.slice || inspected.has(file)) continue;
      const bytes = new Uint8Array(await file.slice(0,AtriumObsoleteProject.limit).arrayBuffer());
      work.check();
      if (!R.detect(file.name,bytes) && !(altiumSheet && /^notebook-[0-9a-f]{64}\.png$/.test(file.name))) {
        const named = R.forName(file.name,null);
        if (named && !named.import) throw Error(named.label + " has no import translator.");
        throw Error("Choose a Waffle project or a supported design, library, netlist or mechanical file. Unrecognised input: " + file.name);
      }
      inspected.add(file);
    }
  }

  async function read(files, work, info, options = {}, inspected) {
    const client = globalThis.AtriumTranslatorClient || await AtriumLazy.need("AtriumTranslatorClient");
    if (!inspected) {
      inspected = new Set();
      await verifySelection(files,work,inspected);
    }
    if (files.some(f => registry().get("altium").projectExtensions?.includes("." + f.name.split(".").pop().toLowerCase()))) {
      const selected = await client.projectFiles(files);
      if (!selected.length) return null;
      if (selected !== files) await verifySelection(selected,work,inspected);
      files = selected;
    }
    const limits = registry().limits;
    const input = [];
    let totalBytes = 0;
    for (const file of files) {
      work.check();
      const bytes = new Uint8Array(await file.arrayBuffer());
      work.check();
      totalBytes += bytes.byteLength;
      if (bytes.byteLength > limits.fileBytes || totalBytes > limits.totalBytes) throw Error("The selected files exceed the translator size limit.");
      const path = client.pathOf(file);
      input.push({name: file.name, ...(path !== file.name || file.altiumPath ? {path} : {}), bytes});
    }
    const first = input[0], hint = registry().forName(first.name);
    // Netlists and portable components open their own review workflows. Only those or
    // ambiguous/renamed files need a separate worker look at their header before import.
    const alternate = !hint || hint.id.startsWith("netlist-") || hint.id === "waffle-library" || /\.(json|xml)$/i.test(first.name);
    const primary = alternate ? (await client.detect(first.name, first.bytes, {signal:work.signal}))?.id : hint.id;
    if (primary === "waffle-library" || primary?.startsWith("netlist-")) return {files, input, specialized: primary};
    const result = await client.import(input, {...options, transferInput: true, signal: work.signal, onProgress(p) {
      if (work.cancelled) return;
      if (work.bar) work.bar.update(p);
      else info(p.total > 1 ? "Opening files… " + Math.min(p.done + 1, p.total) + " of " + p.total : "Opening " + (p.name || "files") + "…");
    }});
    work.check();
    return {files, ...result};
  }

  async function readLibrary(file,{signal,check}) {
    if (/\.wlib$/i.test(file.name)) {
      const native = await AtriumLazy.need("AtriumNativeMemberUI");
      check();
      return native.readComponent(file);
    }
    const translator = registry().forName(file.name);
    if (!translator?.import || !registry().isLibrary(file.name)) throw Error("Choose a supported library file.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    check();
    if (bytes.byteLength !== file.size) throw Error("The library changed while opening. Select it again.");
    if (translator.id === "waffle-library") {
      const library = await AtriumLazy.need("AtriumLibrary");
      check();
      return (await library.readPortable({name:file.name,bytes},{signal})).read;
    }
    const result = await globalThis.AtriumTranslatorClient.import([{name:file.name,bytes}],
      {translator:translator.id,transferInput:true,signal});
    return {id:"import-"+result.provenance.files[0].sha256, name:file.name,defs:result.model.library};
  }

  // Placeholders are editor conveniences, never counted as translated documents. Libraries
  // join the open project. Add Existing adopts the translated document as a single edit.
  async function assemble(read, project, current, {into, identityBindings} = {}) {
    const {model, report, files} = read;
    const docs = model.documents, ids = docs.map(d => d.id), openLib = !ids.length;
    const newDoc = ids[0] || current;
    const libraryTarget = model.library.some(l => l.symbol) ? "schematic" : "pcb";
    if (into && files.some(f => registry().isProject(f.name))) throw Error("Use File › Open for a complete project.");
    const link = globalThis.AtriumImportLink || await AtriumLazy.need("AtriumImportLink");
    let after = model;
    if (into || openLib) {
      const existingIds = new Set(project.documents.map(d => d.id)), names = new Set();
      for (const d of project.documents) {
        const source = globalThis.AtriumImportReports?.sourceDocument(d) || d;
        if (source.sourceName) names.add(d.kind + "/" + source.sourceName.toLowerCase());
      }
      const selected = new Map((read.provenance?.fields || []).filter(f => f.type === "document").map(f => [f.id, f.values.sourceName]));
      const duplicate = docs.find(d => existingIds.has(d.id) || names.has(d.kind + "/" + selected.get(d.id)?.toLowerCase()));
      if (duplicate) throw Error(duplicate.name + " is already in the project.");
      after = Atrium.clone(project);
      const existing = new Map(after.library.map(d => [d.id, d]));
      for (const def of model.library) {
        const old = existing.get(def.id);
        if (old && JSON.stringify(Atrium.definitionGeometry(old)) !== JSON.stringify(Atrium.definitionGeometry(def))) throw Error("The project already has a different library component with ID " + def.id + ".");
        if (!old) after.library.push(def);
      }
      after.documents.push(...docs);
      if (model.rules) for (const d of docs) if (d.kind === "pcb") d.rules = AtriumProjectRules.forBoard(model, d);
      const links = link.reconcile(after, docs);
      if (links.notes.length) report.notes.push(...links.notes);
    } else {
      const occupied = new Set([after.id, ...docs.map(d => d.id), ...docs.flatMap(d => d.items.map(i => i.id)),
        ...model.library.map(d => d.id), ...read.provenance.identityBindings.map(([, id]) => id)]);
      const retained = new Map(identityBindings || []);
      for (const template of AtriumParts.catalogue) {
        const key = JSON.stringify(["catalogue", template.id]), prior = retained.get(key);
        const id = AtriumUUID.isV7(prior) && !occupied.has(prior) ? prior : AtriumUUID.next();
        occupied.add(id);
        after.library.push({...Atrium.clone(template), catalogueId:template.id, id});
        read.provenance.identityBindings.push([key, id]);
      }
      for (const [kind, name] of [["pcb", "Board layout"], ["schematic", "Schematic"]]) {
        if (!docs.some(d => d.kind === kind)) after.documents.push(link.placeholder(kind, name));
      }
    }
    return {after, newDoc, ids, openLib, libraryTarget};
  }

  async function planOpen(files, options, work, host, context) {
    const current = host.project(), revision = host.revision(), designOpen = opensDesign(files);
    const unchanged = () => current === host.project() && revision === host.revision();
    const inspected = new Set();
    await verifySelection(files,work,inspected);
    if (!host.isStarter() && designOpen && !globalThis.AtriumHost && !options.into) {
      const windows = await AtriumLazy.need("AtriumProjectWindows");
      const choice = await windows.choose(files, current.name, host.isDirty());
      if (choice !== "here") {host.info(choice === "opened" ? "Opening project in a separate window." : "Open cancelled."); return null;}
    }
    const input = await read(files, work, host.info,{identityBindings:options.identityBindings},inspected);
    if (!input) {host.info("Open cancelled."); return null;}
    if (input.specialized) {
      const portable = input.specialized === "waffle-library";
      const service = await AtriumLazy.need(portable ? "AtriumLibrary" : "AtriumNetlist");
      work.check();
      if (!unchanged()) throw Error("The project changed. Open the file again.");
      return {handled: !!(await (portable ? service.openPortableFiles(input.input) : service.importFiles(input.input)))};
    }
    const id = input.report.translator;
    if (input.provenance.mechanical || id === "dxf") {
      if (id === "dxf") {
        await AtriumLazy.need(["AtriumBoardShapeUI","AtriumDXF","AtriumMessages"]);
        if (!unchanged()) throw Error("The project changed. Open the outline again.");
        const board = Atrium.preferredDocument(current, "pcb", host.currentId());
        if (!board) throw Error("Open a PCB document to import the board outline.");
        if (host.currentId() !== board.id) host.selectDocument(board.id);
        return {handled: !!AtriumBoardShapeUI.open(context(), {tab:"import", dxfTranslation:input})};
      }
      const mcad = await AtriumLazy.need("AtriumMCADPanel");
      if (!unchanged()) throw Error("The project changed. Open the mechanical file again.");
      return {handled: !!(await mcad.adoptTranslation(input, input.files))};
    }
    const folder = host.folderProject?.();
    if (folder && (options.into || !input.model.documents.length)) {
      await host.requireProjectClosure({purpose:options.into ? "import" : "library-import",signal:work.signal});
      if (options.into && input.model.documents.length) await folder.ensureImportReports?.();
      work.check();
      if (!unchanged()) throw Error("The project changed. Open the files again.");
    }
    const plan = await assemble(input, current, host.currentId(), options);
    await prepare(plan.after, input.files, work, host.info);
    const reports = await AtriumLazy.need("AtriumImportReports");
    work.check();
    if ((options.into || plan.openLib) && !unchanged()) throw Error("The project changed. Open the files again.");
    return {read:input, reports, designOpen, unchanged, ...plan};
  }

  async function open(files, options, host, {context, mayReplace, adopt, report, fitOpened, prepareImported, activateImported, progress: bar}) {
    const work = progress(options, bar);
    let opened = false;
    try {
      const plan = await planOpen(files, options, work, host, context);
      if (!plan) return false;
      if ("handled" in plan) return opened = plan.handled;
      const {read, ids, openLib, reports} = plan, H = globalThis.AtriumHost;
      const replacing = !openLib && !options.into;
      if (replacing && !await mayReplace(!host.isStarter() && !!H && plan.designOpen)) return false;
      work.check();
      const destination = host.project(), revision = host.revision();
      const current = replacing ? () => destination === host.project() && revision === host.revision() : plan.unchanged;
      bar?.stage?.(.92, .97, 0, "Preparing the project…");
      const names = read.files.map(f => f.name), format = registry().get(read.report.translator);
      await host.prepareWorkbench?.(plan.after,{starterView:false});
      work.check();
      if (!current()) throw Error("The project changed. Open the files again.");
      const imported = replacing && format?.group === "design"
        ? await prepareImported({read,reports,plan,format,names,signal:work.signal}) : null;
      work.check();
      options.beforeCommit?.();
      bar?.stage?.(.97, 1, 0, "Opening the project…");
      if (replacing) H?.clearProjectPath?.();
      adopt(plan,imported);
      let entry;
      try {
        if (replacing) H?.acceptHistorySource?.(read.files);
        if (imported) activateImported(imported,host);
        entry = imported?.imported.entry || reports.remember(host.fileSession(), read, ids.length ? ids : [host.currentId()], names);
        if (!replacing) host.folderProject?.()?.markSidecarsDirty();
        reports.show(entry);
      } finally { if (replacing) fitOpened(); bar?.end(); }
      host.info((replacing ? "Imported " : "Added ") + names.join(", "));
      const boards = read.model.documents.filter(d => d.kind === "pcb" && reports.sourceDocument(d).sourceRules?.length);
      if (boards.length) try {
        const rules = await AtriumLazy.need("AtriumImportRules");
        if (reports.recent(boards[0].id) === entry) await rules.offer(host, boards.map(d => d.id));
      } catch (error) { host.info("Imported design. Source rules could not be opened. " + error.message); }
      return opened = true;
    } catch (error) {
      if (work.cancelled || error.name === "AbortError" || ["cancelled","stale_target"].includes(error.code)) host.info("Import cancelled.");
      else {host.info(error.message); report([error.message], "Couldn’t open this file");}
      return false;
    } finally {work.close(); globalThis.AtriumHost?.finishedOpening?.(opened);}
  }

  async function prepare(project, files, work, info) {
    const L = globalThis.AtriumLazy, modules = L?.validatorsFor(project);
    work.bar?.stage?.(.55, .65, 0, "Preparing the design…");
    if (L) await L.need(modules);
    work.check();
    (globalThis.AtriumSymbols || (L && await L.need("AtriumSymbols")))?.applyPreferences(project);
    try {globalThis.Atrium.validate(project);}
    catch (error) {
      const reason = globalThis.AtriumImportFormats?.explain?.(project);
      throw new Error(reason ? files.map(f => f.name).join(", ") + " — " + reason : error.message);
    }
    if (modules?.includes("AtriumMath")) await globalThis.AtriumMath?.prepareSheet(project.documents[0], work.check);
    if (!globalThis.AtriumPolygonPour?.adoptAsync) return;
    const P = globalThis.AtriumPolygonPour;
    const boards = project.documents.filter(d => d.kind === "pcb" && (d.pcbDrawing?.sourceFill || P.pendingPlanes?.(d)?.length));
    if (!boards.length) return;
    info("Pouring polygons…");
    const defs = new Map(project.library.map(d => [d.id, d]));
    for (const [i, board] of boards.entries()) {
      work.check();
      work.bar?.stage?.(.65, .92, i / boards.length, boards.length > 1 ? "Pouring polygons… " + (i + 1) + " of " + boards.length : "Pouring polygons…");
      if(board.pcbDrawing?.sourceFill===true&&!P.pendingPlanes(board).length){
        await P.queryReady(board,{project});
        work.check();
        P.adopt(board,defs,{project},false);
      }else await P.adoptAsync(board, defs, {project, signal: work.signal});
    }
    work.bar?.stage?.(.92, .92);
  }
  return {open, read, readLibrary, assemble, prepare, progress};
})();
