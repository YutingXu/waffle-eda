"use strict";

globalThis.AtriumImport = (() => {
  const pageURL = globalThis.document?.baseURI || globalThis.location?.href;
  let scriptURL = globalThis.document?.currentScript?.src;
  if (!scriptURL && pageURL) {
    try { scriptURL = new URL("workers/import-worker-client.js", pageURL).href; }
    catch { scriptURL = pageURL; } // Blob workers have opaque URLs and no relative base.
  }
  let connection = null, opening = null, unavailable = false, nextID = 0, jobsInFlight = 0, cancelEpoch = 0;
  let nextExportSession = 0;
  class WorkerUnavailable extends Error {}

  function start(url) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(url), jobs = new Map();
      let ready = false, stopped = false;
      const startup = setTimeout(() => stop("Import worker did not start."), 5000);

      function stop(message) {
        if (stopped) return;
        stopped = true;
        clearTimeout(startup);
        worker.terminate();
        const error = new WorkerUnavailable(message);
        if (!ready) reject(error);
        if (connection === session) connection = null;
        for (const task of jobs.values()) task.reject(error);
        jobs.clear();
      }
      const session = {
        cancel() { stop("The import was cancelled."); },
        notify(payload) {
          if (!stopped) try {worker.postMessage(payload);} catch { /* already closed */ }
        },
        send(payload, transfers, options) {
          if (stopped) return Promise.reject(new WorkerUnavailable("Import worker stopped."));
          return new Promise((resolveJob, rejectJob) => {
            const id = ++nextID, timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120000;
            const timer = setTimeout(() => stop("Translation took longer than " + Math.round(timeout / 1000) + " s and was stopped."), timeout);
            jobs.set(id, {resolve(value) {clearTimeout(timer); resolveJob(value);}, reject(error) {clearTimeout(timer); rejectJob(error);},
              progress: typeof options.onProgress === "function" ? options.onProgress : null});
            try { worker.postMessage({id, ...payload}, transfers); }
            catch (error) { stop(error?.message || "Could not send the translation to the worker."); }
          });
        }
      };
      worker.onmessage = ({data}) => {
        if (stopped) return;
        if (data?.type === "ready" && !ready) { ready = true; clearTimeout(startup); resolve(session); return; }
        if (data?.type === "unavailable") { stop(data.message || "Import worker unavailable."); return; }
        const task = jobs.get(data?.id);
        if (!task) return;
        if (data.type === "progress") { try { task.progress?.(data); } catch { /* display only */ } return; }
        if (data.type === "result") { jobs.delete(data.id); task.resolve(data.value); }
        else if (data.type === "parse-error") { jobs.delete(data.id); task.reject(Object.assign(Error(data.message),{code:data.code})); }
        else stop("Unexpected import worker response.");
      };
      worker.onerror = event => { event.preventDefault?.(); stop(event.message || "Import worker could not run."); };
      worker.onmessageerror = () => stop("Could not receive the translated files.");
    });
  }

  async function findWorker() {
    if (typeof Worker !== "function") return null;
    const baseURL = scriptURL || globalThis.location?.href;
    async function external() {
      if (baseURL) try { return await start(new URL("import-worker.js", baseURL).href); } catch { /* try the other packaged entry */ }
      return null;
    }
    const served = /^https?:/i.test(baseURL || "");
    if (served) {
      const worker = await external();
      if (worker) return worker;
    }
    // The embedded worker also works on opaque desktop file origins. Load its source only
    // when a translator actually runs; listing formats and opening the picker stay cheap.
    if (typeof globalThis.AtriumImportWorkerSource !== "string" && globalThis.AtriumLazy) {
      try { await AtriumLazy.need("AtriumImportWorkerSource"); } catch { /* static worker below */ }
    }
    if (typeof globalThis.AtriumImportWorkerSource === "string" && typeof globalThis.URL?.createObjectURL === "function") {
      let url;
      try {
        url = URL.createObjectURL(new Blob([globalThis.AtriumImportWorkerSource], {type: "text/javascript"}));
        return await start(url);
      } catch { /* an origin may permit only a static worker */ }
      finally { if (url) URL.revokeObjectURL(url); }
    }
    return served ? null : external();
  }
  async function acquire() {
    if (connection) return connection;
    if (!opening) opening = findWorker().then(result => {
      connection = result;
      unavailable = !result;
      return result;
    }).finally(() => { opening = null; });
    const worker = await opening;
    if (!worker) throw new WorkerUnavailable("An isolated translation worker could not start. Reopen the editor to retry.");
    return worker;
  }
  function byteView(input) {
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    throw Error("A translator input file must contain bytes.");
  }
  function payloadBuffer(input, owned = false) {
    const view = byteView(input);
    if (owned && view.buffer instanceof ArrayBuffer && !view.byteOffset && view.byteLength === view.buffer.byteLength) return view.buffer;
    return new Uint8Array(view).buffer;
  }
  function workerOptions(options) {
    const {onProgress, timeoutMs, signal, transferInput, preparedAssets, resolveAsset, ...data} = options;
    return data;
  }
  async function run(makePayload, options = {}) {
    const epoch = cancelEpoch;
    if (options.signal?.aborted) throw Error("The import was cancelled.");
    const worker = await acquire();
    if (cancelEpoch !== epoch || options.signal?.aborted) throw Error("The import was cancelled.");
    jobsInFlight++;
    const abort = () => worker.cancel();
    options.signal?.addEventListener("abort", abort, {once: true});
    try {
      const [payload, transfers] = makePayload(worker);
      return await worker.send(payload, transfers, options);
    } finally { jobsInFlight--; options.signal?.removeEventListener("abort", abort); }
  }
  function translatedRequest(component, makePayload, options) {
    const timing = globalThis.AtriumDiagnostics?.performance?.begin(component, "request");
    if (!timing) return run(makePayload, options);
    const epoch = cancelEpoch;
    return run(makePayload, options).then(result => {
      timing.end("completed");
      return result;
    }, error => {
      timing.end(epoch !== cancelEpoch || options.signal?.aborted || error?.name === "AbortError" ? "cancelled" : "failed");
      throw error;
    });
  }
  function filePayload(files, options) {
    const limits = globalThis.AtriumTranslatorRegistry?.limits || {files: 500, fileBytes: 256 * 1048576, totalBytes: 1024 * 1048576};
    if (!Array.isArray(files) || !files.length || files.length > limits.files) throw Error("Choose between one and " + limits.files + " files to translate.");
    let total = 0;
    for (const file of files) {
      const size = byteView(file.bytes).byteLength;
      total += size;
      if (size > limits.fileBytes || total > limits.totalBytes) throw Error("The selected files exceed the translator size limit.");
    }
    const members = files.map(file => ({name: file.name, ...(file.path ? {path: file.path} : {}), buffer: payloadBuffer(file.bytes, !!options.transferInput)}));
    return {members, buffers: [...new Set(members.map(file => file.buffer))]};
  }

  // Specialized choosers sometimes need the translator ID before requesting import options.
  // Copy only the same bounded header inspected by the real worker detector.
  function detect(name, input, options = {}) {
    return run(() => {
      const bytes = byteView(input), sample = new Uint8Array(bytes.subarray(0,globalThis.AtriumObsoleteProject.limit));
      return [{operation: "detect", name, buffer: sample.buffer}, [sample.buffer]];
    }, options);
  }
  function translateImport(files, options = {}) {
    return translatedRequest("import", () => {
      const {members, buffers} = filePayload(files, options);
      return [{operation: "translate-import", files: members, options: workerOptions(options)}, buffers];
    }, options);
  }
  const manufacturing = new Set(["gerber","excellon","fabrication","ipc2581","odb"]);
  const exportSource = source => Array.isArray(source) && !source.length ? undefined : source;
  // Release keeps each authored snapshot and its retained source stable for the
  // life of a job. Both ends use that lifetime to avoid re-cloning the board.
  function exportSession() {
    const scope = {id:++nextExportSession, nextSnapshot:0, snapshots:new WeakMap(),
      retained:new WeakMap(), reduced:new Map(), worker:null, closed:false};
    return {
      export:(id,model,options)=>translateExport(id,model,options,scope),
      close() {
        if (scope.closed) return;
        scope.closed = true;
        scope.worker?.notify({operation:"close-export-session",session:scope.id});
        scope.worker = null;
        scope.snapshots = new WeakMap();
        scope.retained = new WeakMap();
        scope.reduced.clear();
      }
    };
  }
  function exportPayload(worker, scope, id, model, options) {
    const payload = {operation:"translate-export",translator:id,options:workerOptions(options)};
    if (!scope) return {...payload,model};
    if (scope.closed) throw Error("The output job has closed.");
    if (scope.worker !== worker) {
      scope.worker = worker;
      scope.snapshots = new WeakMap();
    }
    const provenance = exportSource(options.provenance);
    delete payload.options.provenance;
    let bySource = scope.snapshots.get(model);
    if (!bySource) scope.snapshots.set(model,bySource = new Map());
    let snapshot = bySource.get(provenance);
    const first = snapshot === undefined;
    if (first) bySource.set(provenance,snapshot = ++scope.nextSnapshot);
    return {...payload,session:scope.id,snapshot,...(first && {model,provenance})};
  }
  async function translateExport(id, model, options = {}, session) {
    const job = session && manufacturing.has(id) ? session : null;
    // A panel can depend on retained records from several boards. Re-read source data
    // for each request and share the snapshot only when the writer received none.
    const sourceJob = options.panelId ? null : job;
    if (session?.closed) throw Error("The output job has closed.");
    if (id === "odb") {
      if (globalThis.AtriumPrefs?.get("butter.odb") !== true)
        throw Object.assign(Error("Enable ODB++ output in Experimental features to export this product model."), {code:"butter_disabled"});
      options = {...options, odbEnabled:true};
    }
    const host = globalThis.AtriumNavHost;
    const folder = host?.project?.() === model ? host.folderProject?.() : null;
    const scope = options.scope || (options.documentId ? "document" : "project");
    const documentIds = scope === "document" && options.documentId ? [options.documentId] : options.documentIds;
    if ((id==="kicad" || id==="altium") && !options.notebookProjection &&
        model.documents?.some(d=>(!documentIds || documentIds.includes(d.id)) && d.items?.some(i=>
          i.asset && i.kind==="image" || i.ink || i.kind==="imageMarkup" || i.kind==="inkStroke"))) {
      const notes=globalThis.AtriumNotebookForeign || await globalThis.AtriumLazy?.need("AtriumNotebookForeign");
      if(notes){
        const resolveAsset=options.resolveAsset || (request=>folder?.readAsset(request));
        const notebookProjection=await notes.prepare(model,{...options,documentIds,resolveAsset});
        options={...options,notebookProjection};
      }
    }
    const film = id === "gerber" || id === "fabrication" || id === "odb";
    if (film || ["altium","altium-source-copy","kicad","eagle","easyeda"].includes(id)) {
      if(folder && host.project()===model){
        let retained = sourceJob?.retained.get(folder);
        if (!retained) {
          await folder.ensureImportReports?.();
          options.signal?.throwIfAborted();
          if(folder!==host.folderProject())throw Error("The project changed during export.");
          retained = globalThis.AtriumImportReports?.provenance() || [];
          sourceJob?.retained.set(folder,retained);
        }
        options={...options,provenance:retained};
      }
      const source = exportSource(options.provenance);
      if (film && source) {
        const sidecars = globalThis.AtriumImportSidecars || await globalThis.AtriumLazy.need("AtriumImportSidecars");
        const documentId = options.panelId ? null : options.documentId;
        let byBoard = sourceJob?.reduced.get(source);
        if (sourceJob && !byBoard) sourceJob.reduced.set(source,byBoard = new Map());
        let reduced = byBoard?.get(documentId);
        if (!reduced) {
          reduced = sidecars.manufacturingProvenance(source,documentId);
          byBoard?.set(documentId,reduced);
        }
        options = {...options,provenance:reduced};
      } else if(!film && Array.isArray(options.provenance) && globalThis.AtriumImportReports?.withOriginals){
        options={...options,provenance:await AtriumImportReports.withOriginals(options.provenance,options.signal,options.scope==="project"?null:options.documentId)};
      }
    }
    const snapshot = options.panelId && exportSource(options.provenance) ? null : job;
    return translatedRequest("export", worker => [exportPayload(worker,snapshot,id,model,options),[]],options);
  }

  // Source verification and the Altium folder chooser need individual records before a
  // project can be assembled. These compatibility projections also stay inside the worker.
  function read(name, bytes) {
    return run(() => {
      const [member] = filePayload([{name, bytes}], {}).members;
      return [{name, buffer: member.buffer}, [member.buffer]];
    });
  }
  function readSet(files, options = {}) {
    return run(() => {
      const {members, buffers} = filePayload(files, options);
      return [{operation: "foreign-set", files: members}, buffers];
    }, options);
  }
  function prepareSource(doc, library, bytes) {
    return run(() => {
      const ids = new Set(doc.items.filter(item => item.kind === "part").map(item => item.def));
      const [member] = filePayload([{name: doc.sourceName, bytes}], {}).members;
      return [{operation: "source-copy", name: doc.sourceName, doc, library: library.filter(def => ids.has(def.id)), buffer: member.buffer}, [member.buffer]];
    });
  }
  function cancel() { cancelEpoch++; if (jobsInFlight) connection?.cancel(); }
  const folderPaths = new WeakMap();
  const pathOf = file => file.altiumPath || folderPaths.get(file) || file.webkitRelativePath?.split("/").slice(1).join("/") || file.name;
  const stepFile = f => /\.(?:step|stp)$/i.test(f?.name || "");
  async function attachBodyModels(all, designs, files, work) {
    const companions = files.filter(stepFile);
    if (!companions.length) return;
    if (!globalThis.AtriumSourceFile) await globalThis.AtriumLazy.need("AtriumSourceFile");
    const loaded = new Map(), changed = new Map();
    let total = 0;
    for (const {f, asset, parsed} of AtriumIO.modelLinks(all, designs, companions, pathOf)) {
      if (!loaded.has(f)) {
        work.check();
        let text = null;
        if (f.size == null || f.size <= 32 * 1048576 && f.size <= 64 * 1048576 - total) {
          const bytes = new Uint8Array(await f.arrayBuffer());
          work.check();
          if (bytes.byteLength <= 64 * 1048576 - total) {
            try { text = (await read(f.name, bytes)).modelFile.stepText; total += bytes.byteLength; } catch { /* keep unresolved */ }
          }
        }
        loaded.set(f, text);
      }
      if (loaded.get(f)) { asset.stepText = loaded.get(f); changed.set(parsed, (changed.get(parsed) || 0) + 1); }
    }
    for (const [parsed, count] of changed) AtriumIO.modelNotes(parsed, count);
  }
  const pathKey = path => {
    const parts = [];
    for (const part of path.replace(/\\/g, "/").normalize("NFC").toLowerCase().split("/")) {
      if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  };
  function referencedFiles(paths, files) {
    const exact = new Map(), flat = new Map(), counts = new Map(), found = [], missing = [];
    for (const path of paths) {
      const name = pathKey(path).split("/").pop();
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    for (const file of files) {
      const relative = file.altiumPath || folderPaths.get(file);
      if (relative) {
        const key = pathKey(relative);
        exact.set(key, exact.has(key) ? null : file);
      }
      else {
        const key = pathKey(file.name);
        flat.set(key, flat.has(key) ? null : file);
      }
    }
    for (const path of paths) {
      const key = pathKey(path), name = key.split("/").pop();
      const file = exact.has(key) ? exact.get(key) : counts.get(name) === 1 && flat.get(name);
      if (file) found.push(file); else missing.push(path);
    }
    return {found, missing};
  }

  // A browser File carries no right to read its siblings. Request the folder from an explicit
  // click, then import only the entries in this particular manifest, even in a tree of projects.
  function pickProjectFolder(name) {
    return new Promise((resolve, reject) => {
      const d = document.createElement("dialog"), title = document.createElement("h2"), note = document.createElement("p");
      const input = document.createElement("input"), choose = document.createElement("button"), cancel = document.createElement("button");
      const actions = document.createElement("div");
      title.textContent = "Open Altium project";
      const native = globalThis.AtriumHost?.open, directory = Reflect.has(input, "webkitdirectory");
      note.textContent = native ? "Choose " + name + " in the system file picker to open its referenced documents." :
        directory ? "Choose the folder containing " + name + " so the browser can read the documents listed in the project." :
        "Choose the schematic, board and library files listed in " + name + ".";
      input.type = "file"; input.multiple = true; input.hidden = true;
      if (directory) input.webkitdirectory = true; else input.accept = [...AtriumTranslatorRegistry.get("altium").extensions, ...AtriumTranslatorRegistry.get("step").extensions].join(",");
      choose.textContent = native ? "Choose project…" : directory ? "Choose folder…" : "Choose documents…";
      choose.type = cancel.type = "button"; choose.dataset.variant = "primary";
      cancel.textContent = "Cancel"; cancel.onclick = () => d.close();
      let picked = null;
      input.onchange = () => { picked = Array.from(input.files); d.close(); };
      input.oncancel = () => d.close();
      choose.onclick = () => {
        if (native) native().then(files => { picked = files; d.close(); }, error => { reject(error); d.close(); });
        else input.click();
      };
      d.onclose = () => { d.remove(); resolve(picked); };
      actions.append(cancel, choose); d.append(title, note, input, actions);
      AtriumShell.adoptDialog(d, {title, body:note, actions, initialFocus:choose});
      document.body.append(d); d.showModal();
    });
  }

  async function inspectMember(file, operation) {
    const max = globalThis.AtriumTranslatorRegistry?.limits.fileBytes || 256 * 1048576;
    if (file.size > max) throw Error("The project manifest exceeds the translator size limit.");
    const bytes = byteView(await file.arrayBuffer());
    if (bytes.byteLength > max) throw Error("The project manifest exceeds the translator size limit.");
    return run(() => {
      const buffer = payloadBuffer(bytes, true);
      return [{operation, name: file.name, buffer}, [buffer]];
    });
  }

  async function projectFiles(selection, pick = pickProjectFolder) {
    const manifests = selection.filter(f => /\.prjpcb$/i.test(f.name));
    if (manifests.length > 1) throw Error("Choose one Altium project at a time.");
    const project = manifests[0];
    if (!project || selection.length > 1 || project.altiumPath) return selection;
    const chosen = await pick(project.name);
    if (!chosen?.length) return [];
    const original = await inspectMember(project, "inspect-manifest");
    const refs = [...original.manifest.paths, ...(original.manifest.modelPaths || [])];
    if (chosen.some(f => f.webkitRelativePath || f.altiumPath)) {
      const manifest = chosen.find(f => pathKey(f.name) === pathKey(project.name) &&
        (f.altiumPath || f.webkitRelativePath?.split("/").length === 2));
      const candidate = manifest && (manifest.size == null || manifest.size === original.size) && await inspectMember(manifest, "source-digest");
      if (!candidate || candidate.sha256 !== original.sha256)
        throw Error("Choose the project folder containing the selected " + project.name + ".");
      for (const file of chosen) if (file.webkitRelativePath) folderPaths.set(file, file.webkitRelativePath.split("/").slice(1).join("/"));
    }
    return [project, ...new Set(referencedFiles(refs, chosen).found)];
  }
  // Builds the project for File › Open / Import of foreign files (editor importFiles; `all` holds
  // the read results in `files` order). Schematic or board documents open as their own project,
  // as Altium and KiCad open a project and as File › Open does with a .waffle file (the editor
  // asks first when the open project has unsaved edits); libraries alone join the open project.
  // into (Projects panel › Add Existing to Project…): the documents join a copy of the open project.
  // -> {after, newDoc, openLib, libraryTarget}
  function assemble(all, files, project, current, into = false) {
    const A = Atrium, L = AtriumImportLink;
    if (globalThis.AtriumAltiumIds) all = AtriumAltiumIds.distinct(all); // two files of one name: distinct stable ids
    const manifestIndex = all.findIndex(x => x.manifest);
    const manifest = manifestIndex < 0 ? null : L.manifestScope(all[manifestIndex], files[manifestIndex]?.bytes).manifest;
    const docs = all.flatMap(x => x.documents), libs = all.flatMap(x => x.library);
    if (manifest && !docs.length && !libs.length) throw Error("Could not read the project's referenced documents. Check the files in the project folder: " + manifest.paths.join(", "));
    if (manifest) {
      const {missing} = referencedFiles(manifest.paths, files);
      if (missing.length) all.find(x => x.manifest).notes.push("Referenced files that could not be opened: " + missing.join(", ") + ".");
    }
    if (into && manifest) throw Error("Add schematic, board or library documents one at a time. Open an Altium project with File › Open.");
    // The same file twice: an imported document keeps its source file name (sourceName).
    const key = d => d.kind + ":" + (d.sourceName || d.id).toLowerCase();
    const have = into ? new Set(project.documents.map(key)) : null, again = have && docs.find(d => have.has(key(d)));
    if (again) throw Error((again.name || "This document") + " is already in the project.");
    const own = docs.length && !into, after = own ? A.project(manifest?.name || files[0].name.replace(/\.[^.]+$/, ""), AtriumParts.catalogue) : A.clone(project);
    if (own) after.documents = [];
    after.documents.push(...docs); after.library.push(...libs);
    if (manifest) for (const d of docs) d.sourceProject = manifest.name;
    if (manifest?.drillPlots?.length) after.sourceDrillPlots = manifest.drillPlots;
    if (manifest?.parameters && !Array.isArray(after.parameters)) after.parameters = {...manifest.parameters, ...(after.parameters || {})}; /* PrjPcb parameters (gerber-parity-2) */
    const links = L.reconcile(after, docs, manifest?.netScope);
    if (own && !after.documents.some(d => d.kind === "pcb")) after.documents.push(L.placeholder("pcb", "Board layout"));
    if (own && !after.documents.some(d => d.kind === "schematic")) after.documents.push(L.placeholder("schematic", "Schematic"));
    after.importNotes = [...new Set([...(after.importNotes || []), ...links.notes, ...all.flatMap((v, i) => v.notes.map(n => files[i].name + " — " + n))])];
    if (own) globalThis.AtriumPCB?.addProfileJobs?.(after, manifest);
    return {after, newDoc: docs[0]?.id || current, openLib: !docs.length, libraryTarget: libs.some(l => l.symbol) ? "schematic" : "pcb"};
  }
  return Object.freeze({detect, import: translateImport, export: translateExport, exportSession, read, readSet, cancel, prepareSource, projectFiles, pathOf, attachBodyModels, assemble,
    get mode() {return connection ? "worker" : unavailable ? "unavailable" : "idle";}});
})();

globalThis.AtriumTranslatorClient = globalThis.AtriumImport;
