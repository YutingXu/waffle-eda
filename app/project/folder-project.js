"use strict";
if (!globalThis.AtriumBase64 && typeof require === "function") require("../core/base64.js");
// The live editor owns visited document projections. The worker owns canonical saved cursors.
// Native hosts own permissions, coherent read leases and durable multi-file transactions.
globalThis.AtriumFolderProject = (() => {
  const docs = new Set(["schematic", "pcb", "drawing", "panel"]);
  const sheetPurposes = new Set(["compile", "erc", "bom", "annotate", "schematic-connections", "schematic-export", "sch-convert-frame"]);
  const stopped = () => Object.assign(Error("The folder operation was cancelled."), {name: "AbortError"});
  const check = signal => { if (signal?.aborted) throw stopped(); };
  const unexpectedModelProof = "A saved body read returned an unexpected model proof.";
  const sha = /^[0-9a-f]{64}$/;
  const stamp = () => globalThis.performance?.now?.() ?? Date.now();
  const paused = () => globalThis.document?.visibilityState === "hidden" || globalThis.AtriumPower?.visible?.() === false ||
    !!globalThis.AtriumPower?.efficient?.();
  function workerIO(copperSource = "") {
    const source = !globalThis.AtriumHost && globalThis.AtriumFolderProjectWorkerSource;
    const workerBlob = source ? URL.createObjectURL(new Blob([copperSource,source],{type:"text/javascript"})) : null;
    const worker = workerBlob ? new Worker(workerBlob) : globalThis.AtriumWorkerPool.script("workers/folder-project-worker.js");
    const requests = new Map();
    let seq = 0, failed;
    function stop(error) {
      failed = error; worker.terminate();
      if (workerBlob) URL.revokeObjectURL(workerBlob);
      for (const job of requests.values()) job.reject(error);
      requests.clear();
    }
    worker.onerror = e => stop(Error(e.message || "The project worker could not start."));
    worker.onmessageerror = () => stop(Error("The project worker returned an unreadable result."));
    worker.onmessage = ({data: m}) => {
      const job = requests.get(m.requestId);
      if (!job) return;
      if (m.readId !== undefined) {
        Promise.resolve().then(() => m.paths ? job.readBatch(m.paths,m.refs) : job.read(m.path,m.ref)).then(record =>
          worker.postMessage({requestId:m.requestId,readId:m.readId,record}), error =>
          worker.postMessage({requestId:m.requestId,readId:m.readId,error:error.message})).catch(() => {});
        return;
      }
      if (m.chunk) { job.items.push(...m.chunk); return; }
      requests.delete(m.requestId);
      if (m.ok) {
        if (job.items.length) m.result.owner.items = job.items;
        job.resolve(m.result);
      } else job.reject(Error(m.error));
    };
    return {
      run(op, value = {}, read, readBatch) {
        if (failed) return Promise.reject(failed);
        return new Promise((resolve, reject) => {
          const id = ++seq;
          requests.set(id,{resolve,reject,read,readBatch,items:[]});
          try { worker.postMessage({...value,op,requestId:id,batch:!!readBatch}); }
          catch (error) { requests.delete(id); reject(error); }
        });
      },
      close() { stop(stopped()); }
    };
  }
  async function conversionWorker(project) {
    if (globalThis.AtriumHost || globalThis.location?.protocol !== "file:") return workerIO();
    const needsCopper = project.documents.some(doc => doc.pcbDrawing?.sourceFill === true || doc.pcbDrawing?.pourSignatures);
    const [,copperSource] = await Promise.all([globalThis.AtriumLazy.need("AtriumFolderProjectWorkerSource"),
      needsCopper ? globalThis.AtriumLazy.need("AtriumFolderCopperWorkerSource") : ""]);
    return workerIO(copperSource);
  }
  async function open(folder, o = {}) {
    const host = o.host || globalThis.AtriumHost, worker = (o.workerFactory || workerIO)();
    if (!host?.folderRead || !folder?.grant || !folder.manifest) { worker.close(); throw Error("Open a Waffle project folder."); }
    const {grant} = folder, listeners = new Set(), saved = new Map(), assets = new Map(), owners = new Map();
    const loads = new Map(), assetLoads = new Map(), staged = new Map(), dirty = new Map(), conflicts = new Map();
    const positions = new Map(), nativeCopies = new Map();
    let nextPosition = 0;
    const readTrace = [], readers = new Set(), hydrationSlices = [];
    let initialDiagnostic, formatDiagnostic;
    let manifestPath = folder.manifest, project, membership, local = {}, firstPresented = false, closed = false;
    let generation = 0, presentedGeneration = -1, editSeq = 0, readOnly = !!folder.readOnly, writeQueue = Promise.resolve(), pendingSave = 0, lastSave = null;
    let idle, background, foreground, activeDoc, sharedEdit, offPower = null, lastEvent = -1, latestRead = Promise.resolve(), closureRequests = 0;
    let manifestHash, newer = false, refreshQueued = false, overflow = false, sidecarsDirty = 0, idleCallbacks = 0;
    let viewWrite, viewVersion = 0, drafts;
    const savedSequences = new Map(), acknowledgedHashes = new Map();
    const changedPaths = new Set();
    const notify = (kind, detail) => {
      if (kind === "diagnostic" && !listeners.size) initialDiagnostic ||= detail.message;
      if (kind === "dirty" || kind === "saved") drafts?.changed(kind === "saved");
      for (const fn of listeners) try { fn(kind, detail); } catch (e) { globalThis.console?.error?.(e); }
    };
    function indexMembership(refs) {
      const index = new Map();
      positions.clear(); nextPosition = 0;
      for (const ref of refs) {
        // The UI annotates its copies with disk availability. A same-realm worker fallback
        // can return the original frozen descriptor instead of a structured clone.
        index.set(ref.id,Object.isFrozen(ref) ? {...ref} : ref);
        positions.set(ref.id,nextPosition++);
      }
      return index;
    }
    const byPath = path => typeof path === "string" && [...membership.values()].find(row => row.path === path);
    const member = id => membership.get(id);
    const document = id => owners.get(id) || project.documents.find(d => d.id === id) || member(id);
    function documentWindow(limit = Infinity, include = activeDoc) {
      const rows = [];
      const add = d => { if (rows.length < limit && !dirty.get(d.id)?.deleted) rows.push(d); };
      for (const ref of membership.values()) {
        if (docs.has(ref.kind)) add(owners.get(ref.id) || ref);
        if (rows.length >= limit) break;
      }
      for (const d of project.documents) {
        if (rows.length >= limit) break;
        if (!membership.has(d.id)) add(d);
      }
      if (include && !rows.some(d => d.id === include) && document(include)) rows.push(document(include));
      return rows;
    }
    function nextDocument() {
      for (const r of membership.values())
        if (docs.has(r.kind) && !owners.has(r.id) && !r.missing && !loads.has(r.id) && !dirty.get(r.id)?.deleted) return r;
    }
    const ownerReady = ref => owners.has(ref.id) && !ref.missing &&
      (saved.get(ref.id)?.deps.definitions || []).every(id => owners.has(id) && !member(id)?.missing);
    const closureRoots = purpose => [...membership.values()].filter(r => !dirty.get(r.id)?.deleted &&
      (sheetPurposes.has(purpose) ? r.kind === "schematic" :
        purpose === "library-import" ? r.kind === "library" : docs.has(r.kind) || r.kind === "library" || r.kind === "block"));
    const readAbort = new AbortController();
    async function readLease({signal, purpose = "read", duringWrite = false} = {}) {
      check(signal); check(readAbort.signal);
      if (!duringWrite) {
        let writing;
        do { writing = writeQueue; await writing; } while (writing !== writeQueue);
      }
      check(signal); check(readAbort.signal);
      let end, lease, verifyModels;
      const finished = new Promise(resolve => { end = resolve; });
      readers.add(finished);
      const finish = () => { readers.delete(finished); end(); };
      try { ({lease,verifyModels} = await host.folderReadLease({grant})); }
      catch (error) { finish(); throw error; }
      let released = false, manifestPinned = false;
      const release = async () => {
        if (released) return;
        released = true;
        try { await host.folderRelease({grant, lease}); }
        finally { finish(); }
      };
      if (signal?.aborted || closed) { await release(); throw stopped(); }
      async function read(paths, options = {}) {
        if (released) throw Error("The folder read lease is closed.");
        check(options.signal || signal);
        try {
          const manifestAt = newer && !manifestPinned ? paths.indexOf(manifestPath) : 0;
          const pin = manifestAt < 0;
          const requested = manifestAt === 0 ? paths : [manifestPath,...paths.filter(path => path !== manifestPath)];
          const {files} = await host.folderRead({grant,lease,paths:requested});
          check(options.signal || signal); check(readAbort.signal);
          if (files.some(file => Object.hasOwn(file,"model"))) throw Error(unexpectedModelProof);
          const found = new Map(files.map(file => [file.path, file]));
          if (pin && found.get(manifestPath)?.sha256 !== manifestHash) {
            throw Error("The project manifest changed. Reload the folder before opening this document.");
          }
          if (found.has(manifestPath)) manifestPinned = true;
          for (const path of requested) {
            if (!found.has(path)) {
              if (!options.optional) throw Error(path + " is missing from the project folder.");
              continue;
            }
            const f = found.get(path);
            if (readTrace.length < (o.traceLimit || 2048)) readTrace.push({path, purpose: options.purpose || purpose, bytes: f.length, at: stamp(), beforePresentation: !firstPresented});
          }
          return paths.map(p => found.get(p));
        } catch (error) {
          check(options.signal || signal);
          if (options.optional && /missing project member|project member is missing|does not exist|not found/i.test(error.message)) return paths.map(() => null);
          throw error;
        }
      }
      async function readBatch(paths, options = {}) {
        if (paths.length < 2) return read(paths,options);
        try { return await read(paths,options); }
        catch (error) {
          check(options.signal || signal); check(readAbort.signal);
          if (error.message === unexpectedModelProof) throw error;
          // Resolve an aggregate refused by the host's byte limit under the same lease.
          const files = [];
          for (const path of paths) files.push((await read([path],options))[0]);
          return files;
        }
      }
      const bridge = Object.getOwnPropertyDescriptor(globalThis,"AtriumHost");
      const canVerify = bridge?.value === host && !bridge.writable && !bridge.configurable &&
        verifyModels === "gzip-v1" && typeof host.folderReadVerified === "function" && typeof host.isVerifiedFolderRead === "function";
      async function readModelProofs(refs, options) {
        check(options.signal || signal); check(readAbort.signal);
        if (released || !manifestPinned || refs.length < 1 || refs.length > 8)
          throw Error("The saved model verification lease is unavailable.");
        const models = refs.map(({path,sha256,byteLength})=>({path,sha256,byteLength}));
        const paths = models.map(ref=>ref.path);
        const result = await host.folderReadVerified({grant,lease,paths,models});
        check(options.signal || signal); check(readAbort.signal);
        if (!host.isVerifiedFolderRead(result) || result.lease !== lease || result.files.length !== paths.length ||
            paths.some((path,index)=>result.files[index]?.path !== path))
          throw Error("The native model verification did not match its requested files.");
        for (const f of result.files) if (readTrace.length < (o.traceLimit || 2048))
          readTrace.push({path:f.path,purpose:options.purpose||purpose,bytes:f.length,at:stamp(),beforePresentation:!firstPresented});
        return result.files;
      }
      return {grant,lease,read,readBatch,release,readModelProofs:canVerify ? readModelProofs : undefined};
    }
    async function withLease(options, fn) {
      const reader = await readLease(options);
      try { return await fn(reader); } finally { await reader.release(); }
    }
    // The active sheet and its dependencies may arrive before earlier manifest members.
    // Insert only the incoming owner, leaving all already loaded and edited owners in place.
    function insertion(list, id) {
      const position = positions.get(id) ?? Infinity;
      let low = 0, high = list.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if ((positions.get(list[mid].id) ?? Infinity) <= position) low = mid + 1;
        else high = mid;
      }
      return low;
    }
    function install(result, isExternal = false, batch = false) {
      const began = stamp();
      const old = owners.get(result.id);
      const list = result.kind === "library" ? project.library : result.kind === "block" ? (project.layoutBlocks ||= []) : project.documents;
      const at = old ? -1 : insertion(list, result.id);
      const owner = o.install?.({result,old,list,at,project,external:isExternal,batch}) || result.owner;
      if (!o.install) {
        const previous = old ? list.indexOf(old) : -1;
        if (previous >= 0) list[previous] = owner; else list.splice(old ? list.length : at,0,owner);
      }
      owners.set(result.id, owner); saved.set(result.id, result);
      if (result.formatDiagnostic) notify("diagnostic",{id:result.id,path:result.path,message:result.formatDiagnostic});
      if (hydrationSlices.length < 2048) hydrationSlices.push(stamp()-began);
      return owner;
    }
    function sameAsset(a,b) {return a?.sha256 === b?.sha256 && a?.byteLength === b?.byteLength && a?.mediaType === b?.mediaType;}
    async function readAssetWith(reader, ownerId, asset, signal, purpose, assetToken, known = true) {
      if (!asset || !sha.test(asset.sha256) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0) throw Error("Invalid attachment reference.");
      const key = ownerId + "/" + asset.sha256 + "/" + (assetToken || "");
      const pending = assetLoads.get(key);
      if (known && !assetToken && assets.has(asset.sha256)) {
        const cached = assets.get(asset.sha256);
        if (sameAsset(cached.assetRef,asset)) return cached;
      }
      if (pending) return pending;
      const job = (async () => {
        const path = "assets/" + asset.sha256;
        let record;
        if (host.folderReadAsset) {
          if (asset.byteLength > 256 * 1024 * 1024) throw Error("This attachment exceeds the folder reader's size limit.");
          const bytes = new Uint8Array(asset.byteLength), maxRange = 1024 * 1024;
          let offset = 0;
          do {
            check(signal); check(readAbort.signal);
            const length = Math.max(1,Math.min(maxRange,bytes.length-offset));
            const chunk = await host.folderReadAsset({grant,lease:reader.lease,ownerId,assetRef:asset,purpose,offset,length,assetToken});
            const binary = globalThis.AtriumBase64.decode(chunk.data);
            if (chunk.offset !== offset || binary.length !== Math.min(length,bytes.length-offset) || chunk.eof !== (offset+binary.length === bytes.length))
              throw Error("The attachment reader returned an invalid range.");
            bytes.set(binary,offset); offset += binary.length;
          } while (offset < bytes.length);
          record = {path,bytes};
          if (readTrace.length < (o.traceLimit || 2048)) readTrace.push({path,purpose,bytes:bytes.length,at:stamp(),beforePresentation:!firstPresented});
        } else {
          [record] = await reader.read([path], {signal,purpose});
        }
        const value = await worker.run("asset", {record, asset, persisted:!assetToken});
        check(signal); check(readAbort.signal);
        if (!assetToken && value.bytes.byteLength <= 16 * 1024 * 1024) {
          let total = value.bytes.byteLength;
          for (const entry of assets.values()) total += entry.bytes.byteLength;
          while (total > 32 * 1024 * 1024 && assets.size) {
            const oldest = assets.keys().next().value;
            total -= assets.get(oldest).bytes.byteLength; assets.delete(oldest);
          }
          assets.set(asset.sha256, value);
        }
        return value;
      })();
      assetLoads.set(key, job);
      try { return await job; } finally { if (assetLoads.get(key) === job) assetLoads.delete(key); }
    }
    async function loadDefinitions(reader, ids, purpose, signal) {
      const refs = [...new Set(ids)].filter(id => !owners.has(id)).map(id => {
        const ref = member(id);
        if (ref?.kind !== "library") throw Error("The project has no library member with ID " + id + ".");
        return ref;
      });
      for (let offset = 0; offset < refs.length; offset += 16) {
        const group = refs.slice(offset,offset+16), records = await reader.read(group.map(r => r.path),{purpose,signal});
        const results = await worker.run("owners",{records,refs:group});
        check(signal); check(readAbort.signal);
        const apply = () => {for (const result of results) if (!owners.has(result.id)) install(result,false,true);};
        if (o.installDefinitions) o.installDefinitions(project,apply); else apply();
      }
      // An old derived footprint can have an unplaced original. Open only
      // that saved dependency, before first paint, so the reader can verify
      // the derivation. The saved mirror remains usable without its source.
      const sourceId=globalThis.AtriumPCBAppearance?.retainedMirrorSource;
      if(purpose==="mirror-source" || !sourceId)return;
      const needed=new Set(ids.map(id=>sourceId(owners.get(id))).filter(id=>id && !owners.has(id) && member(id)?.kind==="library"));
      for(const id of needed){
        try { await loadDefinitions(reader,[id],"mirror-source",signal); }
        catch { check(signal); check(readAbort.signal); }
      }
    }
    async function hydrateWithin(reader, id, purpose, signal, seen = new Set()) {
      check(signal); check(readAbort.signal);
      if (owners.has(id)) {
        if (!["visible","navigation","idle","view"].includes(purpose)) {
          const loaded = saved.get(id);
          if (member(id)?.missing) throw Error(member(id).path + " is missing from the project folder.");
          await loadDefinitions(reader,loaded?.deps.definitions || [],"definition",signal);
        }
        return owners.get(id);
      }
      if (seen.has(id)) return null;
      const ref = member(id);
      if (!ref) throw Error("The project has no member with ID " + id + ".");
      seen.add(id);
      const [record] = await reader.read([ref.path], {signal, purpose});
      const value = await worker.run("owner", {record, ref});
      check(signal); check(readAbort.signal);
      try { await loadDefinitions(reader, value.deps.definitions, "definition", signal); }
      catch (error) {
        check(signal);
        if (!["visible","navigation","idle","view"].includes(purpose)) throw error;
        notify("diagnostic",{id,path:ref.path,message:error.message});
      }
      if (ref.kind === "drawing" || ref.kind === "panel")
        for (const dependency of value.deps.documents) await hydrateWithin(reader, dependency, "view", signal, seen);
      for (const asset of value.deps.assets) if (/^font\//.test(asset.mediaType)) {
        try { await readAssetWith(reader,id,asset,signal,"font"); }
        catch (e) { check(signal); notify("diagnostic", {id, path: "assets/" + asset.sha256, message: e.message}); }
      }
      await o.prepareOwner?.(value.owner);
      check(signal); check(readAbort.signal);
      const owner = install(value);
      delete ref.missing;
      const at = stamp();
      if (!closureRequests || ["navigation","view","visible"].includes(purpose)) notify("loaded",{id,kind:ref.kind,purpose});
      if (hydrationSlices.length < 2048) hydrationSlices.push(stamp()-at);
      return owner;
    }
    function ensureDocument(id, {purpose = "navigation", signal} = {}) {
      if (owners.has(id)) return Promise.resolve(owners.get(id));
      const existing = loads.get(id);
      if (existing && !existing.signal?.aborted) return existing.promise;
      const entry = {signal};
      entry.promise = withLease({signal, purpose}, reader => hydrateWithin(reader, id, purpose, signal)).finally(() => {
        if (loads.get(id) === entry) loads.delete(id);
      });
      loads.set(id, entry);
      return entry.promise;
    }
    async function workspaceDocuments(id) {
      const loaded = new Map();
      async function visit(id) {
        if (loaded.has(id) || dirty.get(id)?.deleted) return;
        const doc = project.documents.find(row => row.id === id) ?? await ensureDocument(id,{purpose:"view"});
        if (!docs.has(doc?.kind)) return;
        loaded.set(id, doc);
        if (doc.kind !== "drawing" && doc.kind !== "panel") return;
        const deps = dirty.has(id) ? await worker.run("workspaceReferences", {owner:doc,
          documents:project.documents.map(({id,kind}) => ({id,kind}))}) : saved.get(id)?.deps.documents;
        for (const dependency of deps || []) await visit(dependency);
      }
      await visit(id);
      return [...loaded.values()];
    }
    async function requireClosure({purpose = "project",signal,saved:fromDisk = false,lease,assets:withAssets = true,only} = {}) {
      if (fromDisk) {
        if (lease && lease.grant !== grant) throw Error("This project snapshot belongs to another folder.");
        return savedClosure({purpose,signal,lease,full:withAssets});
      }
      const failures = [], roots = only ? [...new Set(only)].map(id => {
        const ref = member(id);
        if (!ref) throw Error("The project has no member with ID " + id + ".");
        return ref;
      }) : closureRoots(purpose);
      cancelBackground(); closureRequests++;
      try {
        await withLease({signal,purpose},async reader => {
          const libraries = [];
          for (const ref of roots) {
            if (ref.kind === "library") {libraries.push(ref.id);continue;}
            check(signal);
            try {await hydrateWithin(reader,ref.id,purpose,signal);}
            catch (error) {check(signal);failures.push(ref.path + ": " + error.message);}
          }
          try {await loadDefinitions(reader,libraries,"definition",signal);}
          catch (error) {check(signal);failures.push(error.message);}
        });
        if (failures.length) throw Error("The project is incomplete. " + failures.join("; "));
        notify("loaded",{kind:"project",purpose:"closure"});
        return project;
      } finally {closureRequests--;schedule();}
    }
    async function savedClosure({purpose,signal,lease,full = true,verifyOnly = false,localSources = false} = {}) {
      const gather = async reader => {
        check(signal); check(readAbort.signal);
        const job = (o.workerFactory || workerIO)();
        let running = true;
        const stop = () => { if (running) { running = false; job.close(); } };
        signal?.addEventListener("abort",stop);
        readAbort.signal.addEventListener("abort",stop);
        try {
          const [record] = await reader.read([manifestPath], {signal, purpose});
          const logical = verifyOnly ? null : new Map([[manifestPath,record]]);
          const proveModels = !!(verifyOnly && reader.readModelProofs);
          async function read(path,ref) {
            check(signal);
            let data = logical?.get(path);
            if (!data) {
              if (localSources && ref.kind === "source") {
                [data] = await reader.read([path],{signal,purpose,optional:!!ref.git});
                if (!data) throw Error("A retained original has no local copy: " + path + ". Use File › Save as Zip and open the extracted project to include the original from Git history.");
              } else if (ref.kind === "source" && host.folderReadImportSource) {
                data = await host.folderReadImportSource({grant,lease:reader.lease,bindingPath:ref.bindingPath,inputId:ref.inputId});
                data = {...data,path};
              } else [data] = await reader.read([path],{signal,purpose});
              logical?.set(path,data);
            }
            return data;
          }
          async function readBatch(paths,refs) {
            const models = proveModels && refs?.filter(ref=>ref.kind === "model");
            if (models?.length) {
              const bodies = refs.filter(ref=>ref.kind !== "model").map(ref=>ref.path);
              const files = bodies.length ? await reader.readBatch(bodies,{signal,purpose}) : [];
              // Seven maximum-size gzip bodies fit under the host's 256 MiB read cap.
              for (let start = 0; start < models.length; start += 7)
                files.push(...await reader.readModelProofs(models.slice(start,start+7),{signal,purpose}));
              const byPath = new Map(files.map(f=>[f.path,f]));
              return paths.map(path=>byPath.get(path));
            }
            const files = await reader.readBatch(paths,{signal,purpose});
            if (logical) for (const [index,path] of paths.entries()) logical.set(path,files[index]);
            return files;
          }
          const result = await job.run("closure",{record,full,verifyOnly,proveModels},read,readBatch);
          check(signal); check(readAbort.signal);
          if (verifyOnly) return result.sha256;
          return {project:result.project,version:result.sha256,manifestPath,members:[...logical.values()]};
        } finally {
          signal?.removeEventListener("abort",stop);
          readAbort.signal.removeEventListener("abort",stop);
          stop();
        }
      };
      return lease ? gather(lease) : withLease({signal, purpose}, gather);
    }
    const verifySavedVersion = ({purpose = "project verification",signal,localSources} = {}) => savedClosure({purpose,signal,localSources,verifyOnly:true});
    function cancelBackground() {
      if (idle !== undefined) {
        if (globalThis.AtriumIdle) AtriumIdle.cancel(idle); else clearTimeout(idle);
        idle = undefined;
      }
      background?.abort(); background = null;
    }
    function schedule() {
      if (closed || paused() || !firstPresented || idle !== undefined || background || closureRequests) return;
      const next = nextDocument();
      if (!next) return;
      const run = () => {
        idle = undefined;
        idleCallbacks++;
        if (closed || paused()) return;
        const op = background = new AbortController();
        ensureDocument(next.id, {purpose: "idle", signal: op.signal}).catch(e => {
          if (e.name !== "AbortError") { next.missing = true; notify("diagnostic", {id: next.id, path: next.path, message: e.message}); }
        }).finally(() => { if (background === op) background = null; schedule(); });
      };
      idle = globalThis.AtriumIdle?.idle ? AtriumIdle.idle(run) : setTimeout(run, 32);
    }
    function focus(id) {
      if (id !== activeDoc) { activeDoc = id; generation++; foreground?.abort(); cancelBackground(); }
    }
    async function activate(id, options = {}) {
      const was = activeDoc;
      focus(id);
      const at = generation;
      const running = foreground = new AbortController();
      const abort = () => running.abort();
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort",abort,{once:true});
      try {
        const owner = await ensureDocument(id,{...options,signal:running.signal});
        if (at !== generation || closed) throw stopped();
        return owner;
      } catch (e) {
        if (at === generation && !closed) focus(was);
        throw e;
      } finally {
        options.signal?.removeEventListener("abort",abort);
        if (foreground === running) foreground = null;
      }
    }
    function presented(id) {
      if (id !== activeDoc || closed) return;
      firstPresented = true; presentedGeneration = generation;
      schedule();
    }
    function setView(state, {strict = false} = {}) {
      local = {...local, ...state, activeDocument: state?.activeDocument ?? activeDoc};
      viewVersion++;
      if (!host.folderLocalState) return strict ? Promise.reject(Error("The host cannot save this workspace.")) : Promise.resolve();
      const job = viewWrite ||= (async () => {
        let version;
        do {
          await writeQueue;
          await Promise.all(readers);
          if (closed) return;
          version = viewVersion;
          await host.folderLocalState({grant,localState:local});
        } while (version !== viewVersion);
      })().finally(() => {viewWrite = null;});
      return strict ? job.then(()=>{if (closed) throw stopped();}) : job.catch(error => {if (!readOnly) notify("diagnostic",{message:error.message});});
    }
    function record(changes, {atomic = false, restored = false} = {}) {
      if (closed || readOnly) return;
      const copyStructure = change => nativeCopies.has(change.id) && (change.deleted || change.owner && dirty.get(change.id)?.deleted);
      const blocked = changes.find(change => (saved.get(change.id)?.readOnly || nativeCopies.has(change.id) && member(change.id)) && !copyStructure(change));
      if (blocked) {
        const owner = saved.get(blocked.id);
        notify("diagnostic",{id:blocked.id,path:owner.path,
          message:owner.formatDiagnostic || "This document requires a newer Waffle version and is read-only."});
        return;
      }
      const group = atomic && changes.length > 1 ? ++editSeq : null;
      if (group) {
        const joined = new Set(changes.map(change =>
          change.kind === "project" ? sharedEdit?.group : dirty.get(change.id)?.group).filter(Boolean));
        for (const [id,row] of dirty) if (joined.has(row.group)) dirty.set(id,{...row,group});
        if (joined.has(sharedEdit?.group)) sharedEdit = {...sharedEdit,group};
      }
      for (const change of changes) {
        if (change.kind === "project") {
          sharedEdit = {value:change.settings,seq:++editSeq,group:group ?? sharedEdit?.group};
          continue;
        }
        const prior = dirty.get(change.id), put = new Map(prior?.put), remove = new Set(prior?.remove);
        const tableCells=new Map(prior?.tableCells), proofs=new Map(change.tableCells?.map(edit=>[edit.index,edit]));
        const baseline=saved.get(change.id), sha256=baseline?.sha256;
        if(change.owner || change.deleted)tableCells.clear();
        for (const id of change.remove || []) { put.delete(id); remove.add(id); tableCells.delete(id); }
        for (const [index,item] of (change.put || []).entries()) {
          const proof=proofs.get(index), id=proof?.id ?? (typeof item === "string" ? JSON.parse(item).id : item.id);
          if(proof && sha256 && !prior?.owner && !change.owner && !change.deleted && !remove.has(id)){
            const previous=tableCells.get(id),equal=globalThis.AtriumTableData?.equal;
            const chained=!pendingSave && previous?.sha256===sha256 &&
              (previous.edit.after||previous.edit.before)?.id===(proof.after||proof.before)?.id &&
              equal?.(previous.edit.after,proof.before);
            if(chained && equal(previous.edit.before,proof.after)){put.delete(id);tableCells.delete(id);continue;}
            if(chained || !put.has(id)){
              tableCells.set(id,{edit:{id,before:chained?previous.edit.before:proof.before,after:proof.after},sha256});
            }else tableCells.delete(id);
          } else tableCells.delete(id);
          remove.delete(id); put.set(id, item);
        }
        const version = ++editSeq, next = {...prior,...change,put,remove,tableCells,seq:version,group:group ?? prior?.group};
        if (!member(change.id) && change.deleted || member(change.id) && nativeCopies.has(change.id) && prior?.deleted && !change.deleted ||
            !put.size && !remove.size && !next.owner && !next.settings && !next.name && !next.deleted)
          dirty.delete(change.id);
        else dirty.set(change.id, next);
        if (restored && !pendingSave && baseline && docs.has(change.kind) && dirty.get(change.id)===next) {
          worker.run("matchesSaved",{change:captureChange(next,true)}).catch(error=>{
            if(error.message!==globalThis.AtriumFormat2Model?.tableEditStale)throw error;
            return worker.run("matchesSaved",{change:captureChange(next)});
          }).then(equal => {
            if (!equal || closed || pendingSave || dirty.get(change.id) !== next || saved.get(change.id) !== baseline) return;
            dirty.delete(change.id); notify("dirty");
          }, () => {});
        }
      }
      notify("dirty");
    }
    async function prepareNativeCopy(owner,kind,bytes,proof,reader) {
      if (closed || readOnly || folder.standalone) throw Error("Open an editable Waffle project folder to add this file.");
      const validate = async lease => worker.run("validateNativeCopy",{id:owner.id,kind,bytes,name:owner.name},
        async (path,optional) => (await lease.read([path],{purpose:"add read-only document",optional:optional === true}))[0]);
      const result = await (reader ? validate(reader) : withLease({purpose:"add read-only document"},validate));
      const ids = new Set(result.ids);
      const owned = [...project.documents,...project.library,...(project.layoutBlocks || [])];
      const duplicate = owned.some(doc => ids.has(doc.id) || doc.items?.some(item => ids.has(item.id)));
      const pathKey = name => name.normalize("NFC").toUpperCase().toLowerCase();
      if (closed || duplicate || nativeCopies.has(owner.id) ||
          owned.some(doc => doc.kind === kind && pathKey(doc.name) === pathKey(owner.name)) ||
          [...nativeCopies.values()].some(row => row.ids.some(id => ids.has(id)) || pathKey(row.path) === pathKey(result.path)))
        throw Error("This read-only file collides with a document already in the project.");
      const raw = {...result,bytes,proof};
      return () => {
        nativeCopies.set(owner.id,raw);
        return () => { if (nativeCopies.get(owner.id) === raw) nativeCopies.delete(owner.id); };
      };
    }
    function stageAttachment({ownerId, assetRef, assetToken}) {
      if (readOnly || closed || !ownerId || !assetRef || !sha.test(assetRef.sha256) || !assetToken) throw Error("The attachment could not be added to this owner.");
      const key = ownerId + "/" + assetRef.sha256;
      const prior = staged.get(key);
      if (prior && sameAsset(prior.assetRef,assetRef)) {
        if (prior.assetToken !== assetToken) host.folderDropAsset?.({grant,assetToken})?.catch?.(() => {});
      } else staged.set(key, {ownerId, assetRef, assetToken});
      if (dirty.has(ownerId) || ownerId === project.id && sharedEdit) drafts?.changed();
      return {...assetRef};
    }
    async function readAsset({ownerId, assetRef, assetToken, purpose = "render", signal}) {
      return withLease({signal,purpose},reader => {
        const known = saved.get(ownerId)?.deps.assets.some(a => sameAsset(a,assetRef));
        const pending = staged.get(ownerId + "/" + assetRef?.sha256);
        const token = assetToken || (!known && pending && sameAsset(pending.assetRef,assetRef) ? pending.assetToken : undefined);
        if (!token && !known && !host.folderReadAsset) throw Error("This owner has no verified reference to the attachment.");
        if (token && !host.folderReadAsset) throw Error("This host cannot read a staged attachment.");
        return readAssetWith(reader,ownerId,assetRef,signal,purpose,token,known);
      });
    }
    async function readModel({ownerId, modelRef, signal}) {
      const purpose = "3D model";
      return withLease({signal,purpose},async reader => {
        const ref = saved.get(ownerId)?.deps.assets.find(asset => sameAsset(asset,modelRef));
        if (!ref) throw Error("This owner has no verified reference to the STEP model.");
        const {bytes} = await worker.run("readModel",{modelRef:ref},async path => (await reader.read([path],{signal,purpose}))[0]);
        check(signal); check(readAbort.signal);
        return bytes;
      });
    }
    function releaseAsset({assetToken}) {
      if ([...staged.values()].some(asset => asset.assetToken === assetToken)) return;
      return host.folderDropAsset?.({grant,assetToken});
    }
    async function discardDocument(id,apply) {
      await writeQueue;
      const edits = dirty.get(id);
      if (!edits) return true;
      const changed = conflicts.get(id);
      if (changed?.disk) return resolveConflict(id,"disk");
      const result = await worker.run("savedOwner",{id});
      if (dirty.get(id) !== edits) throw Error("This document changed during review.");
      if (!result || !apply(result.owner)) return false;
      dirty.delete(id);
      notify("dirty");
      return true;
    }
    let indexedMembership, retainedIndexes = [];
    function retainedImportIndexes() {
      if (indexedMembership !== membership) {
        retainedIndexes = [...membership.values()].filter(r => r.kind === "import-index");
        indexedMembership = membership;
      }
      return retainedIndexes;
    }
    const importIndexes = () => retainedImportIndexes().slice();
    function markSidecarsDirty() {
      if (readOnly) return;
      const first = !sidecarsDirty;
      sidecarsDirty = ++editSeq; notify("dirty");
      if (first && drafts) notify("diagnostic",{message:"Private drafts keep edited documents and settings. Save to keep pending import reports with them."});
    }
    function takeSidecars(signal) {
      return withLease({signal,purpose:"import reports",duringWrite:true}, reader => {
        const read = async path => (await reader.read([path],{signal,optional:true}))[0];
        return o.prepareSidecars({grant,prior:importIndexes(),read,signal});
      });
    }
    function captureChange(row, compact=false) {
      const copy = nativeCopies.get(row.id), {tableCells,...change}=row;
      const put=[],edits=[],tableBase=saved.get(row.id)?.sha256;
      const eligible=compact && tableBase && !row.owner && !row.deleted && !copy;
      for(const [id,item] of row.put){
        const certified=eligible && tableCells?.get(id);
        if(certified && certified.sha256===tableBase)edits.push(certified.edit);
        else put.push(item?.tableJSON?item.tableJSON():item);
      }
      return {...change,put,remove:[...row.remove],...(edits.length?{tableCells:edits,tableBase}:{}),
        ...(copy && {nativeCopy:copy.bytes,copyProof:copy.proof})};
    };
    async function copyStandalone() {
      const target = folder.standalone;
      if (!target) throw Error("Select a standalone Waffle document first.");
      return withLease({purpose:"save a document copy"},async reader => {
        const [base] = await reader.read([target.path]);
        const changes = dirty.get(target.id);
        if (!changes) return base.bytes;
        if (conflicts.has(target.id)) throw Error("Resolve the changed file before saving a copy.");
        const plan = await worker.run("plan",{changes:[captureChange(changes)],attachments:[]});
        try {
          if (!plan.plan.length) return base.bytes;
          const [edit] = plan.plan;
          if (plan.plan.length !== 1 || edit.path !== target.path || edit.remove)
            throw Error("This change needs a Waffle project folder.");
          return AtriumBrowserProject.payload(edit,{...base,length:base.bytes.byteLength});
        } finally { await worker.run("aborted",{token:plan.token}); }
      });
    }
    const savedCopper = new WeakMap();
    function captureSavedCopper(changes) {
      const captured = new Map(), engine = globalThis.AtriumPolygonPour;
      if (!engine) return captured;
      let defs;
      for (const row of changes) {
        const doc = owners.get(row.id), drawing = doc?.pcbDrawing;
        if (doc?.kind !== "pcb" || row.deleted || row.owner || drawing?.sourceFill) continue;
        const unverified = globalThis.AtriumPourMarker.read(drawing);
        const stamp = [drawing?.pours,drawing?.pourSignatures,unverified,doc.sourcePourSignature];
        if (!row.settings && savedCopper.get(doc)?.every((value,i)=>value===stamp[i])) continue;
        const ids = Object.keys(drawing?.pourSignatures || {});
        if (!ids.length && !unverified?.length) continue;
        if (ids.length) defs ??= new Map(project.library.map(def => [def.id,def]));
        const report = ids.length ? engine.inspectCopper(doc,defs,{project}) : null;
        const stale = new Set(report?.stale), verified = new Set(report?.verified);
        const current = ids.filter(id => verified.has(id));
        if (!current.length && !unverified?.length) continue;
        const {items, ...settings} = doc; void items;
        // Tie the accepted fill to this authored save before another edit can land.
        const snapshot = JSON.parse(JSON.stringify(settings));
        const pending = new Set([...(unverified || []),...ids.filter(id=>stale.has(id))]);
        if (pending.size) globalThis.AtriumPourMarker.write(snapshot.pcbDrawing,[...pending]);
        const copperBases = current.length ? [...engine.copperBases(doc,drawing.pourSignatures,current)] : [];
        captured.set(doc.id,{doc,stamp,change:{settings:snapshot,copperBases}});
      }
      return captured;
    }
    async function copyTo(manifest,signal) {
      const changes = [...dirty.values()].map(row=>captureChange(row)), attachments = [...staged.values()];
      const settings = sharedEdit?.value, copySidecars = !!sidecarsDirty;
      return withLease({signal,purpose:"save as"},async reader => {
        const original = await savedClosure({signal,purpose:"save as",lease:reader,localSources:true});
        const read = async path => (await reader.read([path],{signal,optional:true}))[0];
        const ignore = await read(".waffle/.gitignore");
        const sidecars = copySidecars ? await o.prepareSidecars({grant,prior:importIndexes(),read,signal}) : null;
        const stagedPlan = await worker.run("plan",{changes,attachments,manifest:settings,importIndexes:sidecars?.refs});
        try {
          const plan = [];
          const copiedHashes = new Map(original.members.map(file => [file.path,file.sha256]));
          const reusable = new Set(stagedPlan.payloads.filter(row => copiedHashes.get(row.path) === row.sha256).map(row => row.path));
          for (const next of [...(sidecars?.plan || []),...stagedPlan.plan]) {
            if (reusable.has(next.path)) continue;
            if (!next.assetToken) { plan.push(next); continue; }
            const attached = attachments.find(a => a.assetToken === next.assetToken);
            const {bytes} = await readAssetWith(reader,attached.ownerId,attached.assetRef,signal,"save as",attached.assetToken);
            plan.push({path:next.path,expected:next.expected,bytes});
          }
          const files = [...original.members,...(ignore ? [ignore] : [])];
          const visited = new Set(files.map(file => file.path));
          for (const asset of stagedPlan.existingAssets) {
            const path = "assets/"+asset.sha256;
            if (visited.has(path)) continue;
            const [record] = await reader.read([path],{signal});
            await worker.run("asset",{record,asset});
            files.push(record);
          }
          if (!ignore && !plan.some(r => r.path === ".waffle/.gitignore"))
            plan.unshift({path:".waffle/.gitignore",expected:null,text:await o.ignoredStores?.() || ""});
          check(signal);
          const writes = await worker.run("copy",{files,plan,original:manifestPath,manifest});
          return {projectId:original.project.id,plan:writes};
        } finally { await worker.run("aborted",{token:stagedPlan.token}); }
      });
    }
    const originalKey = (id,asset) => JSON.stringify([id,asset.sha256]);
    function draftCursor() {
      const hashOf = id => saved.get(id)?.sha256 || acknowledgedHashes.get(id) || null;
      const rows = [...dirty.values()].map(row => ({...row,baseHash:hashOf(row.id)}));
      const settings = sharedEdit && {seq:sharedEdit.seq,value:sharedEdit.value,baseHash:manifestHash};
      const attachments = [...staged.values()], base = manifestHash;
      return {rows,settings,attachments,covered:(id,seq) => savedSequences.get(id) >= seq,
        current:() => !closed && base === manifestHash && rows.every(r => hashOf(r.id) === r.baseHash)};
    }
    async function draftSnapshot(changes,capture,existing) {
      await writeQueue;
      const snapshot = await worker.run("draftOwners",{changes:changes.map(row=>captureChange(row)),attachments:capture.attachments,
        manifest:capture.settings?.value});
      const originals = [], previous = new Set(existing);
      const pending = new Map(capture.attachments.map(a => [originalKey(a.ownerId,a.assetRef),a]));
      for (const row of snapshot.rows) {
        row.originals = [];
        for (const raw of row.assetRefs || []) {
          const assetRef = {sha256:raw.sha256,byteLength:raw.byteLength,mediaType:raw.mediaType};
          const key = originalKey(row.id,assetRef), live = pending.get(key);
          const inline = snapshot.originals.find(a => a.sha256 === raw.sha256);
          if (!live && !inline && !previous.has(key)) {
            if (snapshot.verify?.includes(assetRef.sha256)) {
              // A new typed reference with no pending token must point to an existing verified
              // content-addressed member, as required by Save. Missing originals cannot be
              // represented by a successful private draft.
              await withLease({purpose:"draft original"},async reader => {
                const [record] = await reader.read(["assets/"+assetRef.sha256],{optional:true});
                if (!record) throw Error("The newly referenced original is unavailable. Add the attachment again.");
                await worker.run("draftBinary",{record,asset:assetRef});
              });
            }
            continue;
          }
          row.originals.push(key);
          if (previous.has(key)) continue;
          if (live) {
            if (!host.folderDraftAssetProof || !host.folderRestoreDraftAsset || !host.folderReadAsset)
              throw Error("This host cannot keep the newly attached original in a private draft.");
            const {bytes} = await readAsset({...live,purpose:"private draft"});
            const {proof} = await host.folderDraftAssetProof({grant,...live});
            if (typeof proof !== "string" || !sha.test(proof)) throw Error("The private original could not be authenticated.");
            originals.push({key,ownerId:row.id,assetRef,bytes,proof});
          } else {
            originals.push({key,ownerId:row.id,assetRef,data:inline.data});
          }
        }
        delete row.assetRefs;
      }
      return {rows:snapshot.rows,assets:originals};
    }
    async function checkDraft(reader,head,unresolved) {
      const [root] = await reader.read([manifestPath]);
      const disk = await worker.run("manifest",{record:root,install:false});
      if (disk.project.id !== project.id) throw Error("The saved project identity changed. Reopen its folder.");
      const refs = new Map(disk.members.map(r => [r.id,r]));
      let matches = true, same = true;
      for (const row of head.rows) {
        const member = refs.get(row.id), [f] = member ? await reader.read([member.path],{optional:true}) : [];
        const digest = f?.sha256 || null;
        const alreadySaved = digest === row.desiredHash && (row.deleted ? !member : member?.path === row.path);
        if (!alreadySaved) {
          unresolved?.add(row.id);
          same = false;
          if (dirty.has(row.id) || conflicts.has(row.id) || digest !== row.baseHash) matches = false;
        }
      }
      if (head.settings) {
        const {documents,library,blobs,...current} = disk.project;
        const equivalent = await worker.run("sameSettings",{left:current,right:head.settings.value});
        if (!equivalent) {
          unresolved?.add(project.id);
          same = false;
          if (head.settings.baseHash !== root.sha256 || sharedEdit) matches = false;
        }
      }
      return same ? "saved" : matches ? "matches" : "changed";
    }
    const classifyDraft = head => withLease({purpose:"draft review"},reader => checkDraft(reader,head));
    async function separateDraft(bundle) {
      // A recovery copy needs its drafted owners and their actual sheet/library dependencies.
      // Resolve that graph by ID under one lease. An unrelated sheet may be missing or very large.
      return withLease({purpose:"draft copy"},async reader => {
        const [root] = await reader.read([manifestPath]);
        const index = await worker.run("manifest",{record:root,install:false});
        if (index.project.id !== project.id || index.readOnly || index.newer || bundle.rows.some(r => r.newer || r.nativeCopy))
          throw Error("A newer Waffle version is needed to open a separate recovery copy without losing records. The private draft is still available.");
        const copyProject = index.project, binary = new Map();
        for (const a of bundle.originals) binary.set("assets/"+a.assetRef.sha256,a.data || globalThis.AtriumFolderDrafts.base64(a.bytes));
        const refs = new Map(index.members.map(r => [r.id,r])), seen = new Set(bundle.rows.map(r => r.id));
        const extra = [], pending = bundle.rows.filter(r => !r.deleted);
        const originals = new Map(bundle.originals.map(a => [originalKey(a.ownerId,a.assetRef),a]));
        if (!pending.some(r => docs.has(r.kind))) {
          const entry = index.members.find(r => docs.has(r.kind) && !seen.has(r.id));
          if (entry) extra.push(entry.id);
        }
        async function assetOf(row,ref) {
          if (binary.has(ref.path)) return;
          const a = originals.get(originalKey(row.id,ref));
          let record;
          if (a) record = a.data ? {data:a.data} : {bytes:a.bytes};
          else if (ref.kind === "asset" && host.folderReadAsset) {
            const value = await readAssetWith(reader,row.id,{sha256:ref.sha256,mediaType:ref.mediaType,byteLength:ref.byteLength},undefined,"draft copy",undefined,false);
            record = {bytes:value.bytes};
          } else [record] = await reader.read([ref.path]);
          binary.set(ref.path,await worker.run("draftBinary",{record,asset:ref}));
        }
        async function include(row) {
          for (const id of [...(row.deps?.definitions || []),...(row.deps?.documents || [])]) if (!seen.has(id)) extra.push(id);
          for (const ref of row.binaries || []) await assetOf(row,ref);
        }
        for (const row of pending) await include(row);
        for (let i=0; i<extra.length; i++) {
          const id = extra[i]; if (seen.has(id)) continue;
          seen.add(id);
          const ref = refs.get(id);
          if (!ref) throw Error("A referenced project member is unavailable: " + id + ". The private draft is still available.");
          const [record] = await reader.read([ref.path]);
          const row = await worker.run("draftDependency",{record,ref});
          if (row.readOnly || row.newer) throw Error("A newer Waffle version is needed for a referenced recovery document.");
          const list = row.kind === "library" ? copyProject.library : row.kind === "block" ? (copyProject.layoutBlocks ||= []) : copyProject.documents;
          list.push(row.owner);
          await include(row);
        }
        return {project:copyProject,binary};
      });
    }
    async function verifyDraftOriginal(a) {
      if (!a.proof) {
        await worker.run("draftBinary",{record:{data:a.data},asset:a.assetRef});
        return null;
      }
      if (!host.folderRestoreDraftAsset) throw Error("This host cannot restore the private attachment.");
      const data = globalThis.AtriumFolderDrafts.base64(a.bytes);
      const receipt = await host.folderRestoreDraftAsset({grant,ownerId:a.ownerId,assetRef:a.assetRef,proof:a.proof,data});
      if (!receipt?.assetToken || !sameAsset(a.assetRef,receipt.assetRef) || receipt.ownerId && receipt.ownerId !== a.ownerId)
        throw Error("The attachment recovery receipt did not match its document.");
      return {...receipt,ownerId:a.ownerId};
    }
    async function restoreDraft(bundle,separate) {
      if (closed || !o.restoreDraft) throw Error("Open this folder in an editable Waffle window to recover the draft.");
      if (separate) {
        for (const original of bundle.originals) {
          const verified = await verifyDraftOriginal(original);
          if (verified) await host.folderDropAsset({grant,assetToken:verified.assetToken});
        }
        const copy = await separateDraft(bundle);
        if (closed) throw Error("The original folder was closed.");
        return o.restoreDraft({bundle,separate,session:api,copy});
      }
      for (const row of bundle.rows) {
        const ref = member(row.id);
        if (ref && !saved.has(row.id)) {
          if (docs.has(ref.kind)) await ensureDocument(row.id,{purpose:"draft recovery"});
          else if (ref.kind === "library") await withLease({purpose:"draft recovery"},r => loadDefinitions(r,[row.id],"draft recovery"));
        }
      }
      const issued = [], copies = [];
      try {
        for (const a of bundle.originals) {
          const receipt = await verifyDraftOriginal(a);
          if (receipt) issued.push(receipt);
        }
        // No writes can interleave with this read lease. Recheck disk and the live editor immediately before the one Undo edit.
        await withLease({purpose:"draft recovery"},async reader => {
          const unresolved = new Set();
          if (await checkDraft(reader,bundle.header,unresolved) !== "matches" || closed) throw Error("The folder changed during review. Open this draft separately.");
          bundle.rows = bundle.rows.filter(r => unresolved.has(r.id));
          for (const row of bundle.rows) if (row.nativeCopy && row.owner && !member(row.id)) {
            if (globalThis.AtriumHost && host === globalThis.AtriumHost)
              throw Error("Re-add the original read-only file to verify a fresh copy. The private draft is still available.");
            copies.push((await prepareNativeCopy(row.owner,row.kind,row.nativeCopy,null,reader))());
          }
          if (!unresolved.has(project.id)) bundle.header = {...bundle.header,settings:null};
          for (const a of issued) {
            if (unresolved.has(a.ownerId)) stageAttachment(a);
            else await host.folderDropAsset?.({grant,assetToken:a.assetToken});
          }
          if (!await o.restoreDraft({bundle,separate:false,session:api})) throw Error("The document changed during recovery.");
        });
        const recovered = bundle.rows.map(r => [r.id,dirty.get(r.id)?.seq]);
        if (bundle.header.settings) recovered.push([project.id,sharedEdit?.seq]);
        return () => recovered.length > 0 && recovered.every(([id,seq]) => seq && (savedSequences.get(id) || 0) >= seq);
      } catch (error) {
        for (const discard of copies) discard();
        for (const a of issued) {
          const k = a.ownerId + "/" + a.assetRef.sha256;
          if (staged.get(k)?.assetToken === a.assetToken) staged.delete(k);
          await host.folderDropAsset?.({grant,assetToken:a.assetToken}).catch(() => {});
        }
        throw error;
      }
    }
    function save({documentId = activeDoc, all = false, only, editorMs = 0, started = stamp()} = {}) {
      const selecting = stamp();
      const diagnostics = globalThis.AtriumDiagnostics?.performance;
      if (readOnly) {
        diagnostics?.begin("save","save")?.end("failed");
        return Promise.reject(Error(formatDiagnostic || "This project is read-only. Save a copy to edit it."));
      }
      const activeOnly = !all && (!only || only.length === 1 && only[0] === documentId) && documentId === activeDoc;
      const activeUpgrade = activeOnly && saved.get(documentId)?.upgradePending ? documentId : undefined;
      const use = all ? [...dirty.values()] : only ? only.map(id => dirty.get(id)).filter(Boolean) : [dirty.get(documentId)].filter(Boolean);
      const selected = new Set(use.map(row => row.id));
      if (activeUpgrade) selected.add(activeUpgrade);
      if ([...selected].some(id => conflicts.has(id))) {
        diagnostics?.begin("save","save")?.end("failed");
        return Promise.reject(Error("Resolve the changed file before saving."));
      }
      if (all && conflicts.has(project.id)) {
        diagnostics?.begin("save","save")?.end("failed");
        return Promise.reject(Error("Resolve the project settings conflict before saving."));
      }
      function unsavedDefinition(value){
        const item=typeof value==="string"?JSON.parse(value):value;
        return item.def && dirty.has(item.def) && !membership.has(item.def) && !selected.has(item.def);
      }
      const mustSaveAll = use.some(row => row.group && (sharedEdit?.group === row.group ||
        [...dirty.values()].some(other => other.group === row.group && !selected.has(other.id))) ||
        [...row.put].some(([id,value])=>!row.tableCells?.has(id)&&!value?.tableJSON&&unsavedDefinition(value)) ||
        row.owner?.items?.some(unsavedDefinition));
      if (!all && mustSaveAll) {
        diagnostics?.begin("save","save")?.end("cancelled");
        return Promise.resolve({saved: false, needsSaveAll: true});
      }
      const projectEdit = all ? sharedEdit : null;
      const sidecarEdit = all ? sidecarsDirty : 0;
      const attachments = [...staged.values()].filter(a => selected.has(a.ownerId) || projectEdit && a.ownerId === project.id);
      if (!use.length && !projectEdit && !sidecarEdit && !activeUpgrade) return Promise.resolve({saved:true,clean:true});
      let timing = diagnostics?.queue("save","save");
      const copper = captureSavedCopper(use);
      const capture = compact => use.map(row => ({...captureChange(row,compact),...copper.get(row.id)?.change}));
      cancelBackground();
      pendingSave++; notify("saving");
      editorMs += stamp() - selecting;
      let deliver, reject, acknowledgedToEditor = false;
      const receipt = new Promise((resolve,fail) => { deliver = resolve; reject = fail; });
      function settle(error,reply) {
        pendingSave--; notify("saving");
        if (error) reject(error); else { acknowledgedToEditor = true; deliver(reply); }
      }
      const write = writeQueue.then(async () => {
        await Promise.all(readers);
        check(readAbort.signal);
        timing?.start();
        const locks = globalThis.AtriumCollabLock;
        // The worker can prepare a plan while the host refreshes ownership. The plan is
        // still private, and a refusal must discard its token before the next queued write.
        const ownership = locks?.active() ? locks.beforeSave(api,selected).catch(error => ({error})) : null;
        const sidecars = sidecarEdit ? await takeSidecars(readAbort.signal) : null;
        let slice = stamp();
        const changes = capture(true), message={changes,attachments,upgradeOwnerId:activeUpgrade,
          manifest:projectEdit?.value,importIndexes:sidecars?.refs};
        const preparing = worker.run("plan",message);
        editorMs += stamp() - slice;
        let pending;
        try { pending=await preparing; }
        catch(error){
          if(error.message!==globalThis.AtriumFormat2Model?.tableEditStale || !changes.some(change=>change.tableCells?.length))throw error;
          slice=stamp();
          const fallback=worker.run("plan",{...message,changes:capture(false)});
          editorMs+=stamp()-slice;
          pending=await fallback;
        }
        let plan = [...(sidecars?.plan || []),...pending.plan];
        try {
          if (ownership) {
            const denied = await ownership;
            if (denied) throw denied.error;
          }
          check(readAbort.signal);
          const planReady = stamp();
          if (pending.existingAssets.length || pending.payloads.length) await withLease({signal:readAbort.signal,purpose:"attachment verification",duringWrite:true},async reader => {
            const reusable = new Set();
            for (const payload of pending.payloads) {
              const [record] = await reader.read([payload.path],{optional:true});
              if (!record) continue;
              if (record.sha256 !== payload.sha256) throw Error(payload.path + " has changed on disk.");
              reusable.add(payload.path);
            }
            if (reusable.size) plan = plan.filter(row => !reusable.has(row.path));
            for (const asset of pending.existingAssets) {
              const [record] = await reader.read(["assets/"+asset.sha256]);
              await worker.run("asset",{record,asset});
            }
          });
          slice = stamp();
          if (plan.length) notify("write-start");
          const posted = stamp();
          // Ready separates preparation from the host commit round trip.
          timing?.ready();
          const writing = plan.length ? host.folderCommit({grant,projectId:project.id,manifest:manifestPath,plan}) : {saved:true,hashes:{}};
          editorMs += stamp() - slice;
          const reply = await writing, acknowledged = stamp();
          if (!reply.saved) throw Error(reply.error || "The folder could not be saved.");
          timing?.end(plan.length && reply.saved === true && !folder.temporary &&
            (!folder.standalone || folder.standalone.nativeGrant) ? "durable" : "completed");
          timing = null;
          for (const {doc,stamp} of copper.values()) savedCopper.set(doc,stamp);
          manifestHash = reply.hashes?.[manifestPath] || manifestHash;
          const upgradedOwner = saved.get(pending.upgraded);
          if (upgradedOwner && reply.hashes?.[upgradedOwner.path]) upgradedOwner.upgradePending = false;
          for (const row of pending.membership) {
            if (!positions.has(row.id)) positions.set(row.id,nextPosition++);
            membership.set(row.id, {...row, kind: row.docKind || row.kind});
          }
          for (const id of pending.dropped) { membership.delete(id); positions.delete(id); owners.delete(id); saved.delete(id); }
          for (const row of use) {
            savedSequences.set(row.id,row.seq);
            const newer = dirty.get(row.id);
            if (!newer || newer.seq === row.seq) dirty.delete(row.id);
            else {
              const put = new Map(newer.put), remove = new Set(newer.remove), tableCells=new Map(newer.tableCells);
              for (const [id, item] of row.put) if (put.get(id) === item) {put.delete(id);tableCells.delete(id);}
              for (const id of row.remove) remove.delete(id);
              const settings = newer.settings === row.settings ? undefined : newer.settings;
              const owner = newer.owner === row.owner ? undefined : newer.owner;
              const name = newer.name === row.name ? undefined : newer.name;
              if (!put.size && !remove.size && !settings && !owner && !name && newer.deleted === row.deleted) dirty.delete(row.id);
              else dirty.set(row.id, {...newer, put, remove, tableCells, settings, owner, name});
            }
          }
          if (projectEdit) savedSequences.set(project.id,projectEdit.seq);
          if (projectEdit && sharedEdit?.seq === projectEdit.seq) sharedEdit = null;
          if (sidecars) {
            for (const ref of importIndexes()) membership.delete(ref.id);
            for (const ref of sidecars.refs) membership.set(ref.id,{...ref,kind:"import-index"});
            indexedMembership = null;
            if (sidecarsDirty === sidecarEdit) sidecarsDirty = 0;
          }
          for (const added of attachments)
            if (pending.plan.some(p => p.assetToken === added.assetToken)) staged.delete(added.ownerId + "/" + added.assetRef.sha256);
          for (const id of selected) {
            const next = membership.get(id), record = saved.get(id);
            if (!next) acknowledgedHashes.delete(id);
            else if (reply.hashes?.[next.path]) {
              acknowledgedHashes.set(id,reply.hashes[next.path]);
              if (record) saved.set(id, {...record,path:next.path,sha256:reply.hashes[next.path]});
            }
          }
          lastSave = {started,planReady,posted,acknowledged,...pending.metrics,transaction:reply.transaction,paths:plan.map(p => p.path),
            ownerIds: [...selected], splices: pending.plan.reduce((n, p) => n + (p.splice?.edits.length || 0), 0)};
          const timings = lastSave;
          const accepting = worker.run("accepted", {token: pending.token, hashes: reply.hashes || {}});
          notify("saved", lastSave);
          notify("write-stop");
          lastSave.editorMs = editorMs + stamp() - acknowledged;
          settle(null,reply);
          await accepting;
          timings.cursorSettled = stamp();
        } catch (error) {
          notify("write-stop");
          await worker.run("aborted", {token: pending.token}).catch(() => {});
          throw error;
        }
      }).catch(error => {
        timing?.end(error?.name === "AbortError" ? "cancelled" : "failed");
        if (!acknowledgedToEditor) settle(error);
        else {
          readOnly = true;
          notify("diagnostic",{message:"The save is durable. Reopen the folder to continue editing."});
        }
      }).finally(schedule);
      writeQueue = write;
      return receipt;
    }
    function metrics() {
      return {reads:readTrace.slice(),active:activeDoc,loaded:[...owners.keys()],firstPresented,pendingSave:pendingSave>0,lastSave,
        idleCallbacks,hydrationSlices:hydrationSlices.slice()};
    }
    function power() {
      if (globalThis.document?.visibilityState === "hidden") drafts?.flush().catch(() => {});
      if (paused()) cancelBackground(); else schedule();
    }
    function conflictAt(ref, note, disk, record) {
      const detail = {id:ref.id, path:ref.path, message:note, disk, record, base:saved.get(ref.id)};
      conflicts.set(ref.id, detail);
      notify("conflict", detail);
    }
    async function reload(paths, uncertain) {
      if (closed) return;
      const wanted = new Set(paths), manifestChanged = uncertain || wanted.has(manifestPath);
      await withLease({purpose:"disk"}, async reader => {
        if (manifestChanged) {
          const [record] = await reader.read([manifestPath]);
          if (record.sha256 !== manifestHash) {
            if (sharedEdit) {
              notify("diagnostic",{path:manifestPath,message:"Project settings changed on disk while you have unsaved settings. Review or save a copy."});
              return;
            }
            const next = await worker.run("manifest",{record});
            const refs = indexMembership(next.members);
            for (const prior of membership.values()) {
              const ref = refs.get(prior.id);
              if (!ref) {
                if (owners.has(prior.id) || dirty.has(prior.id)) {
                  refs.set(prior.id,{...prior, missing:true});
                  notify("diagnostic",{id:prior.id,path:prior.path,message:prior.name+" is no longer listed in the manifest."});
                }
              } else if (ref.path !== prior.path || ref.name !== prior.name) wanted.add(ref.path);
            }
            membership = refs; manifestHash = record.sha256; newer = next.newer; readOnly ||= next.readOnly;
            formatDiagnostic = next.formatDiagnostic;
            if (formatDiagnostic) notify("diagnostic",{path:manifestPath,message:formatDiagnostic});
            const {documents,library,...settings} = next.project; void documents; void library;
            if (o.installManifest) o.installManifest({project,settings});
            else {
              // Empty optional native collections have no manifest rows.
              for (const key of Object.keys(project)) {
                if (!Object.hasOwn(settings, key) && (key === "releaseDescriptors" || globalThis.AtriumFormat2Model.optionalProjectField(key)))
                  delete project[key];
              }
              Object.assign(project,settings);
            }
            notify("loaded",{kind:"project",purpose:"disk"});
          }
        }
        for (const ref of membership.values()) {
          if ((!uncertain && !wanted.has(ref.path)) || (!docs.has(ref.kind) && ref.kind !== "library")) continue;
          if (!owners.has(ref.id)) { delete ref.missing; continue; }
          const base = saved.get(ref.id);
          let record;
          try { [record] = await reader.read([ref.path]); }
          catch (error) {
            ref.missing = true;
            conflictAt(ref, ref.name + " is missing on disk. Keep this copy open or save it to a new folder.");
            continue;
          }
          if (!record || record.sha256 === base?.sha256 && ref.path === base.path) continue;
          const disk = await worker.run("owner", {record, ref, install:false});
          if (dirty.has(ref.id)) conflictAt(ref, ref.name+" changed on disk while you have unsaved changes.", disk, record);
          else {
            await o.prepareOwner?.(disk.owner);
            install(disk, true);
            await worker.run("acceptExternal",{id:ref.id});
            delete ref.missing;
            notify("loaded",{id:ref.id,kind:ref.kind,purpose:"disk"});
          }
        }
      });
    }
    function synchronize(paths, uncertain = false) {
      const timing = globalThis.AtriumDiagnostics?.performance?.queue("project","sync");
      const work = latestRead.then(() => writeQueue).then(() => {
        if (!timing) return reload(paths, uncertain);
        timing.start();
        return reload(paths, uncertain).then(result => {
          timing.ready();
          timing.end("completed");
          return result;
        }, error => {
          timing.end(error?.name === "AbortError" ? "cancelled" : "failed");
          throw error;
        });
      }, error => {
        timing?.end(error?.name === "AbortError" ? "cancelled" : "failed");
        throw error;
      });
      latestRead = work.catch(e => { if (e.name !== "AbortError") notify("diagnostic",{message:e.message}); });
      return work;
    }
    function watched(event) {
      const m = event.detail;
      if (m?.grant !== grant || closed || m.seq <= lastEvent) return;
      lastEvent = m.seq ?? lastEvent;
      for (const path of m.paths || []) {
        changedPaths.add(path);
        if (path.startsWith("assets/") && sha.test(path.slice(7))) {
          assets.delete(path.slice(7));
          worker.run("invalidateAsset",{sha256:path.slice(7)}).catch(() => {});
        }
      }
      overflow ||= !!m.overflow;
      if (m.status === "conflict" || m.status?.state === "conflict") {
        notify("diagnostic",{message:"Saved, external conflict. The durable changes were retained for recovery."});
        notify("journal-conflict",m.status);
        return;
      }
      if (m.status === "applying" || m.status?.state === "applying" || refreshQueued) return;
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        const paths = [...changedPaths], all = overflow;
        changedPaths.clear(); overflow = false;
        if (paths.length || all) synchronize(paths,all).catch(() => {});
      });
    }
    async function resolveConflict(id, choice) {
      await latestRead; await writeQueue;
      const conflict = conflicts.get(id);
      if (!conflict?.disk) throw Error("Locate the missing document or save a copy before changing it.");
      const row = dirty.get(id), change = row ? captureChange(row) : null;
      const result = await worker.run("resolveExternal",{id,choice,change});
      if (result.conflicts) throw Error("Both versions changed the same records. Choose which version to keep after reviewing "+result.conflicts.join(", ")+".");
      await o.prepareOwner?.(result.owner);
      if (dirty.get(id) !== row || conflicts.get(id) !== conflict) throw Error("This document changed during review. Open the comparison again.");
      if (choice === "disk") dirty.delete(id);
      install(result,true); conflicts.delete(id); delete member(id)?.missing;
      await worker.run("acceptExternal",{id});
      notify("loaded",{id,kind:member(id)?.kind,purpose:"disk"}); notify("dirty");
      return true;
    }
    async function restoreMissing(id,bytes) {
      if (readOnly) throw Error("This Waffle folder is read-only.");
      const conflict = conflicts.get(id), ref = member(id);
      if (!conflict || conflict.disk || !ref?.missing) throw Error("The document must still be missing.");
      const restoring = writeQueue.then(async () => {
        await Promise.all(readers);
        if (closed || conflicts.get(id) !== conflict) throw Error("The folder changed. Review it again.");
        const entry = await worker.run("restoreMember",{id,bytes});
        notify("write-start");
        try {
          const reply = await host.folderCommit({grant,projectId:project.id,manifest:manifestPath,plan:[entry]});
          if (!reply?.saved) throw Error("The document could not be restored.");
          conflicts.delete(id); delete ref.missing;
        } finally {notify("write-stop");}
      });
      writeQueue = restoring.catch(() => {});
      await restoring;
      await synchronize([ref.path]);
      return true;
    }
    async function resolveGitOwner(id, path, prepare, verify) {
      const apply = writeQueue.then(async () => {
        await Promise.all(readers);
        if (closed || readOnly || sharedEdit || dirty.has(id))
          throw Error("Save the project settings and any edits to this document before resolving its Git conflict.");
        const plan = await withLease({purpose:"Git merge review",duringWrite:true}, async reader => {
          const [manifest] = await reader.read([manifestPath]);
          const [current] = await reader.read([path], {optional:true});
          return prepare(manifest,current);
        });
        await verify();
        if (closed || readOnly || sharedEdit || dirty.has(id))
          throw Error("The project changed. Reopen merge review.");
        if (!plan.length) return;
        notify("write-start");
        try {
          const result = await host.folderCommit({grant,projectId:project.id,manifest:manifestPath,plan});
          if (!result?.saved) throw Error("The Git resolution could not be saved.");
        } finally {notify("write-stop");}
      });
      writeQueue = apply.catch(() => {});
      await apply;
      await synchronize([manifestPath,path]);
    }
    async function close() {
      if (closed) return;
      await writeQueue;
      await drafts?.close().catch(() => {});
      await viewWrite;
      closed = true; generation++; readAbort.abort(); foreground?.abort(); cancelBackground(); worker.close();
      globalThis.document?.removeEventListener?.("visibilitychange", power);
      globalThis.removeEventListener?.("folderChanged", watched);
      offPower?.(); listeners.clear();
      await host.folderClose?.({grant});
    }
    const api = {ensureDocument,activate,focus,presented,record,save,copyTo,copyStandalone,readLease,stageAttachment,readAsset,readModel,releaseAsset,requireClosure,verifySavedVersion,metrics,close,setView,
      importIndexes,hasImportIndexes:() => retainedImportIndexes().length > 0,markSidecarsDirty,discardDocument,restoreMissing,resolveGitOwner,prepareNativeCopy,
      listDrafts:() => drafts?.list() || Promise.resolve([]),
      workspaceDocuments,
      flushDrafts:({required = false} = {}) => required ? drafts?.checkpoint() ??
        Promise.reject(Error("Private recovery is unavailable for this project.")) : drafts?.flush() || Promise.resolve(),
      configureDrafts:() => drafts?.configure(),
      resolveDraft:(offer,choice) => drafts?.decide(offer,choice),
      draftMetrics:() => drafts?.metrics(),
      noteSaveStatus() {
        const timings = lastSave;
        if (!timings) return;
        timings.statusAt = stamp();
        globalThis.requestAnimationFrame?.(() => { timings.statusFrame = stamp(); });
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      get project() { return project; }, get readOnly() { return readOnly; }, get dirty() { return !!dirty.size || !!sharedEdit || !!sidecarsDirty; },
      get initialDiagnostic() { return initialDiagnostic; },
      get pendingSave() { return pendingSave > 0; }, get pendingWrites() { return pendingSave; }, get localState() { return local; }, get activeId() { return activeDoc; },
      get grant() { return grant; }, get manifestPath() { return manifestPath; }, get conflicts() { return new Map(conflicts); }, synchronize, resolveConflict,
      get temporary() { return folder.temporary === true; },
      get standalone() { return folder.standalone; },
      get openedMember() { return byPath(folder.memberPath); }, memberAtPath:byPath,
      getDocumentRef: member, document,
      loadedDocument:id => docs.has(member(id)?.kind) && !dirty.get(id)?.deleted ? owners.get(id) : undefined,
      documents: () => documentWindow(), documentWindow,
      modified: id => dirty.has(id),
      canEdit: id => !readOnly && !saved.get(id)?.readOnly && !nativeCopies.has(id) && (!folder.standalone || id === folder.standalone.id),
      ownerReady: id => !member(id) || dirty.get(id)?.deleted || ownerReady(member(id)),
      completeFor: purpose => closureRoots(purpose).every(ownerReady),
      hasPresented: id => presentedGeneration === generation && activeDoc === id};
    try {
      const {signal} = o;
      const restore = Promise.resolve(host.folderLocalState?.({grant})).catch(() => null);
      await withLease({signal,purpose:"open"},async reader => {
        const [record] = await reader.read([manifestPath]);
        const [info,state] = await Promise.all([worker.run("manifest",{record}),restore]);
        local = state?.state || state || folder.localState || {};
        project = info.project; manifestPath = info.manifestPath; manifestHash = info.sha256;
        newer = info.newer; readOnly ||= info.readOnly;
        formatDiagnostic = info.formatDiagnostic;
        if (formatDiagnostic) notify("diagnostic",{path:manifestPath,message:formatDiagnostic});
        membership = indexMembership(info.members);
        const selected = api.openedMember;
        if (folder.memberPath && !selected) throw Error("The project no longer lists the selected Waffle file.");
        activeDoc = [selected?.id,local.activeDocument,info.entry].find(id => id && docs.has(member(id)?.kind)) || nextDocument()?.id;
        if (!activeDoc) throw Error("The project manifest has no design document.");
        if (!local.openTabs?.includes(activeDoc)) local = {...local,openTabs:[...(local.openTabs || []),activeDoc]};
        await hydrateWithin(reader,activeDoc,"visible",signal);
      });
      check(signal);
      globalThis.document?.addEventListener?.("visibilitychange", power);
      globalThis.addEventListener?.("folderChanged", watched);
      offPower = globalThis.AtriumPower?.onChange?.(power);
      const service = globalThis.AtriumFolderDrafts;
      if (!readOnly && service && folder.draftScope) {
        drafts = service.bind({scope:folder.draftScope,projectId:project.id,cursor:draftCursor,snapshot:draftSnapshot,
          classify:classifyDraft,restore:restoreDraft,store:o.draftStore,diagnose:message => notify("diagnostic",{message})});
      } else if (!readOnly && service && !folder.draftScope) {
        let warned = false;
        api.on(event => { if (event === "dirty" && api.dirty && !warned) { warned=true; notify("diagnostic",{message:"This host cannot keep private drafts of this folder. Save to preserve your changes."}); } });
      }
      return api;
    } catch (e) { await close(); throw e; }
  }
  return Object.freeze({open, workerIO, conversionWorker});
})();
