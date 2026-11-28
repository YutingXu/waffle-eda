"use strict";
// Unsaved foreign projects have no destination grant. Their private 2.0 members, including
// the original files, use the same atomic, version-checked profile store as native-folder drafts.
globalThis.AtriumForeignDrafts = (() => {
  const G = globalThis, scope = G.AtriumFolderDrafts.foreignScope, hint = "waffle-foreign-draft:";
  const manifest = "Project.waffle", records = new Map(), reviews = new Map();
  const scopes = () => G.AtriumFolderDrafts.storage;
  const pendingOf = host => host?.fileSession?.()?.imported || host?.importSession?.();
  const needsReview = host => {
    const p=pendingOf(host);
    return !!p && (!p.exported && p.state!=="exported" && p.state!=="export-preferred" || host.isDirty());
  };
  const requireValue = (v, message) => { if (!v) throw Error(message); };
  const idOf = p => {
    requireValue(typeof p?.id === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(p.id), "Invalid import recovery identity.");
    return p.id;
  };
  function metadata(p) {
    const out = {id:idOf(p),kind:"foreign",state:p.state === "export-preferred" ? "export-preferred" : "unsaved"};
    for (const field of ["sourceKey","nativeKey","translator","formatLabel","name","sourceLabel"]) {
      if (typeof p[field] === "string") out[field] = p[field].slice(0,512);
    }
    if (out.sourceLabel) out.sourceLabel = out.sourceLabel.split(/[\\/]/).pop();
    requireValue(out.translator && out.formatLabel, "Missing foreign import identity.");
    return out;
  }
  function discover(id, active) {
    try {
      if (active) G.localStorage?.setItem(hint+id,"1");
      else G.localStorage?.removeItem(hint+id);
    } catch { /* IndexedDB is authoritative. */ }
  }
  function serialized(record, fn) {
    const work = record.queue.then(fn,fn);
    record.queue = work.catch(() => {});
    return work;
  }
  async function worker() {
    if (G.location?.protocol === "file:" && !G.AtriumHost && !G.AtriumFolderProjectWorkerSource)
      await G.AtriumLazy.need("AtriumFolderProjectWorkerSource");
    return G.AtriumFolderProject.workerIO();
  }
  async function encode(model, entries, record, originalScope, signal) {
    const job = await G.AtriumFolderProject.conversionWorker(model), codec = G.AtriumFormat2, side = G.AtriumImportSidecars;
    const withoutBytes=file=>{ const {bytes,...identity}=file; return identity; };
    const cancel = () => job.close();
    signal?.addEventListener("abort", cancel, {once:true});
    try {
      signal?.throwIfAborted();
      requireValue(entries?.some(e => e.adopted !== false && e.provenance?.files?.length),
        "The original files are missing from this import.");
      const origin=entries[0].provenance;
      const converted = await job.run("convert",{project:model,manifest,entryDocument:model.documents[0]?.id,
        deferModelEncoding:true,provenance:{...origin,files:origin.files.map(withoutBytes)}});
      const imports = entries.map(e => {
        const existing=record.bindings?.get(e.scopeId);
        const files=e.provenance.files.map((file,j)=>{
          const pinned=existing?.inputs[j];
          return pinned && pinned.sha256===file.sha256 && pinned.byteLength===(file.byteLength ?? file.bytes?.byteLength)
            ? withoutBytes(file) : file;
        });
        return {...e,index:existing,provenance:{...e.provenance,files},...(e.scopeId === originalScope ? {residuals:converted.residuals} : {})};
      });
      // Compress and serialize the native members on the worker while the editor prepares
      // the binding. Source buffers stay on the editor side; native buffers transfer back.
      const [prepared,retained] = await Promise.all([job.run("draftConversionMembers"),side.prepare(imports,{signal})]);
      const files = new Map(prepared.members.map(({path,bytes}) => [path,bytes]));
      const root = G.AtriumFormat2Model.parse(files.get(manifest),{kind:"project"});
      files.set(manifest, codec.serialize(codec.edit(root,{put:retained.refs})));
      for (const [path,data] of record.originals || []) files.set(path,data);
      for (const [path,data] of retained.files) files.set(path,data);
      for (const [path,data] of retained.originals) files.set(path,data);
      for (const [path,data] of record.binary || []) if (!files.has(path)) files.set(path,data);
      const checked = await G.AtriumProjectArchive.verifyClosure({manifestPath:manifest,read:path=>files.get(path),signal});
      requireValue(checked.indexes.length && checked.indexes.every(b => b.inputs.length), "Could not verify the retained import originals.");
      const indexes = new Map(checked.indexes.map(binding => [binding.ref.id,binding]));
      const originals = new Map(checked.members.filter(row => row.kind === "source").map(row => [row.path,files.get(row.path)]));
      const hashes = new Map(checked.members.map(row => [row.path,row.physicalSha256]));
      const rows = [...checked.files].map(([id,bytes]) => ({id,bytes,hash:hashes.get(id) ?? codec.sha256(bytes)}));
      return {rows,version:checked.version,indexes,originals};
    } finally {
      signal?.removeEventListener("abort",cancel);
      job.close();
    }
  }
  async function checkpoint(record,pending,model,entries,revision,stillCurrent,originalScope,signal) {
    const timing = G.AtriumDiagnostics?.performance?.begin("autosave","save");
    let outcome = "failed";
    try {
      const next = await encode(model,entries,record,originalScope,signal);
      signal?.throwIfAborted();
      if (!stillCurrent()) { outcome = "cancelled"; return false; }
      const meta = metadata(pending), old = new Map(record.head?.rows.map(r => [r.id,r.hash]));
      const header = {version:G.AtriumFolderDrafts.version,scope,writer:meta.id,stamp:crypto.randomUUID(),written:Date.now(),
        session:G.AtriumAutosave?.session,pending:meta,projectVersion:next.version,assets:[],rows:next.rows.map(({id,hash})=>({id,hash}))};
      discover(meta.id,true);
      timing?.ready();
      await scopes().write(scope,meta.id,record.head?.stamp,header,next.rows.filter(r => old.get(r.id) !== r.hash));
      record.head = header; record.revision = revision; record.model = model;
      record.bindings=next.indexes; record.originals=next.originals;
      outcome = "completed";
      return true;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") outcome = "cancelled";
      throw error;
    } finally { timing?.end(outcome); }
  }
  async function begin({pending,model,entries,signal}) {
    const id = idOf(pending);
    requireValue(!records.has(id), "This import already has an active private draft.");
    const record = {queue:Promise.resolve()}; records.set(id,record);
    try {
      const source = entries.find(e=>e.scopeId===id && e.report?.translator===pending.translator);
      requireValue(source,"The import scope does not match its verified source.");
      await serialized(record,()=>checkpoint(record,pending,model,entries,undefined,()=>true,id,signal));
      // Capture the original projection before installing the editable project. Later
      // captures and first Save retain this proof even if a track or its copper changes.
      source.residuals = record.bindings.get(id).metadata.residuals || [];
      return record.head.stamp;
    } catch (e) { records.delete(id); if (!record.head) discover(id,false); throw e; }
  }
  async function bindSource(pending) {
    const record = records.get(idOf(pending));
    if (!record) return false;
    return serialized(record,async () => {
      const next = metadata(pending);
      if (!record.head || JSON.stringify(record.head.pending) === JSON.stringify(next)) return true;
      const head = {...record.head,pending:next,stamp:crypto.randomUUID()};
      await scopes().write(scope,pending.id,record.head.stamp,head); record.head=head;
      return true;
    });
  }
  function sessionRecord(pending) {
    let record=records.get(pending.id);
    if (!record) {
      // Undo can return to a previous file session after its in-memory cache was released.
      record={queue:Promise.resolve()};records.set(pending.id,record);
      record.queue=scopes().list(scope).then(heads=>{record.head=heads.find(h=>h.writer===pending.id);});
    }
    return record;
  }
  function schedule(host=G.AtriumNavHost) {
    const p=pendingOf(host);
    if (!p || !needsReview(host)) return;
    const record=sessionRecord(p);
    record.edited=true;
    if (G.AtriumPref?.get("general.autosave",true)===false) return;
    const constants=G.AtriumAutosave?.constants || {}, now=Date.now();
    record.firstChange??=now;
    const quiet=G.AtriumPower?.delay?.(constants.DEBOUNCE || 1500) ?? (constants.DEBOUNCE || 1500);
    const minutes=Number(G.AtriumPref?.get("general.autosaveMinutes",5)) || 5;
    const after=record.lastEditWrite ? record.lastEditWrite+Math.min(120,Math.max(1,minutes))*60000 : 0;
    const due=Math.max(after,Math.min(now+quiet,record.firstChange+(constants.MAX_WAIT || 20000)));
    clearTimeout(record.timer);
    record.timer=setTimeout(()=>{
      record.timer=null;
      if (G.AtriumPref?.get("general.autosave",true)!==false)
        flush(host).catch(e=>host.info?.(e.message));
    },Math.max(0,due-now));
  }
  function configure(host=G.AtriumNavHost) {
    const p=pendingOf(host), record=p && records.get(p.id);
    if (!record?.edited) return;
    clearTimeout(record.timer); record.timer=null;
    if (G.AtriumPref?.get("general.autosave",true)!==false) schedule(host);
  }
  async function flush(host=G.AtriumNavHost) {
    const pending = pendingOf(host);
    if (!pending || !needsReview(host)) return false;
    const record=sessionRecord(pending);
    clearTimeout(record.timer); record.timer=null; record.firstChange=null;
    return serialized(record,async () => {
      for (;;) {
        if (pendingOf(host)?.id !== pending.id || !record.head && record.discardedAt===host.revision()) return false;
        const model=host.project(), revision=host.revision(), entries=G.AtriumImportReports.retained();
        if (record.model===model && record.revision===revision) {record.edited=false;return true;}
        const same=()=>pendingOf(host)?.id===pending.id && host.project()===model && host.revision()===revision;
        const written=await checkpoint(record,pending,model,entries,revision,same);
        if (written && same()) {record.edited=false;record.lastEditWrite=Date.now();return true;}
      }
    });
  }
  async function retire(pending,revision) {
    const id=idOf(pending), record=records.get(id);
    if (!record) return;
    clearTimeout(record.timer);
    await serialized(record,async () => {
      const matches=()=>revision===undefined || !pending.current?.() || pending.revision()===revision;
      if (!matches()) return;
      if (record.head) await scopes().write(scope,id,record.head.stamp,null);
      if (!matches()) {
        record.head=null;record.revision=undefined;schedule(G.AtriumNavHost);return;
      }
      record.head=null; record.binary=null; record.model=null;
      records.delete(id); discover(id,false);
    });
  }
  function release(pending) {
    const record=records.get(idOf(pending));
    if (!record) return;
    clearTimeout(record.timer); records.delete(pending.id); record.model=null; record.binary=null;
    // Keep becomes recoverable in another live window only once this project actually leaves.
    return serialized(record,async()=>{
      const h=record.head;
      if (h?.kept && h.session===G.AtriumAutosave?.session) {
        const next={...h,stamp:crypto.randomUUID(),session:null};
        await scopes().write(scope,h.writer,h.stamp,next);
        if (record.head===h) record.head=next;
      }
    }).catch(()=>{});
  }
  async function available(host=G.AtriumNavHost,rows) {
    rows ??= await scopes().list(scope);
    const current=pendingOf(host)?.id;
    let live=null;
    try {
      if (G.navigator?.locks?.query) live=new Set((await G.navigator.locks.query()).held.map(l=>l.name));
    } catch { /* Storage compare-and-set still protects reviewed versions. */ }
    return rows.filter(r=>r.pending && r.writer!==current && (!live || !r.session ||
      r.session===G.AtriumAutosave?.session || !live.has("waffle-editor-draft-session:"+r.session))).sort((a,b)=>b.written-a.written);
  }
  async function restore(head,host=G.AtriumNavHost) {
    const timing = G.AtriumDiagnostics?.performance?.begin("project","load");
    let outcome = "failed";
    try {
      const adopted = await restoreVerified(head,host);
      if (adopted) timing?.ready();
      outcome = adopted ? "completed" : "cancelled";
      return adopted;
    } catch (error) {
      if (error?.name === "AbortError") outcome = "cancelled";
      throw error;
    } finally { timing?.end(outcome); }
  }
  async function restoreVerified(head,host) {
    requireValue(head.scope===scope && head.writer===idOf(head.pending) && !records.has(head.writer),"This imported project is already open.");
    const bundle=await scopes().read(head), files=new Map(bundle.rows.map(r=>[r.id,r.bytes]));
    // The displayed offer is only a stamp. All restored identity and provenance come from its stored header.
    head=bundle.header;
    requireValue(head.scope===scope && head.writer===idOf(head.pending),"The stored import identity does not match its private scope.");
    for (const {id,hash} of head.rows) requireValue(files.has(id) && G.AtriumFormat2.sha256(files.get(id))===hash,"Damaged private import member.");
    const read=path=>files.get(path);
    const checked=await G.AtriumProjectArchive.verifyClosure({manifestPath:manifest,read});
    requireValue(checked.version===head.projectVersion && checked.indexes.length,"The recovered import does not match its verified version.");
    const job=await worker();
    try {
      const member=path=>({path,bytes:read(path),sha256:G.AtriumFormat2.sha256(read(path))});
      const {project:model}=await job.run("closure",{record:member(manifest),full:false},member);
      const entries=[];
      for (const binding of checked.indexes) {
        const entry=G.AtriumImportSidecars.restore(binding);
        const originals=await G.AtriumImportSidecars.originalFiles(binding,r=>read(r.sourcePath));
        // These are privately verified bytes, not a grant on the original filesystem.
        delete entry.index;
        for (const [i,file] of originals.entries()) G.AtriumImportSidecars.retainCopy(entry.provenance.files[i],file.bytes);
        entries.push(entry);
      }
      const binary=new Map([...files].filter(([p])=>/^(assets|models)\//.test(p)));
      G.AtriumFolderProjectUI.retainRecoveryFiles(model,binary);
      const primary=entries.find(entry=>entry.scopeId===head.pending.id);
      requireValue(primary && primary.report.translator===head.pending.translator,"The recovered import is missing its original source scope.");
      const inputs=primary.provenance.files.map(({name,path,sha256,byteLength})=>({name,path,sha256,byteLength}));
      const pending={...head.pending,inputs,canCreateBesideSource:false};
      const claimed={...head,stamp:crypto.randomUUID(),session:G.AtriumAutosave?.session,kept:false};
      await scopes().write(scope,head.writer,head.stamp,claimed);
      const bindings=new Map(checked.indexes.map(b=>[b.ref.id,b]));
      const originals=new Map([...files].filter(([path])=>path.startsWith(".waffle/imports/") && path.endsWith("/source")));
      const record={head:claimed,queue:Promise.resolve(),binary,model,bindings,originals}; records.set(head.writer,record);
      let adopted=false;
      try {
        adopted=await host.restoreImportSession({pending,model,entries});
        if (adopted) record.revision=host.revision();
        return adopted;
      } finally {
        if (!adopted) {
          records.delete(head.writer);
          await scopes().write(scope,head.writer,claimed.stamp,{...head,stamp:crypto.randomUUID()});
        }
      }
    } finally { job.close(); }
  }
  async function finishReview(host,pendingId,commit=true) {
    const record=records.get(pendingId);
    if (!record || record.discardRevision===undefined) return true;
    const expected=record.discardRevision; delete record.discardRevision;
    if (!commit) return true;
    const same=()=>pendingOf(host)?.id===pendingId && host.revision()===expected;
    return serialized(record,async () => {
      if (!same() || !record.head) return false;
      clearTimeout(record.timer); record.timer=null;
      await scopes().write(scope,pendingId,record.head.stamp,null);
      record.head=null; record.revision=undefined; record.discardedAt=expected;
      discover(pendingId,false);
      if (!same() && pendingOf(host)?.id===pendingId) schedule(host);
      return same();
    });
  }
  async function resolveClose(host,pending,choice,deferDiscard=false) {
    const same=()=>pendingOf(host)?.id===pending.id;
    if (!same() || !["save","keep","discard"].includes(choice)) return false;
    if (choice==="save") return await host.saveProject()!==false && !host.isDirty() && (!pendingOf(host) || same());
    const record=sessionRecord(pending);
    if (choice==="discard") { record.discardRevision=host.revision(); return deferDiscard || finishReview(host,pending.id); }
    if (!await flush(host)) return false;
    return serialized(record,async () => {
      if (!same() || record.revision!==host.revision()) return false;
      const head={...record.head,kept:true,stamp:crypto.randomUUID()};
      await scopes().write(scope,pending.id,record.head.stamp,head);
      record.head=head;
      return same() && record.revision===host.revision();
    });
  }
  function review(host=G.AtriumNavHost,deferDiscard=false) {
    const pending=pendingOf(host);
    if (!pending) return Promise.resolve(false);
    if (reviews.has(pending.id)) return reviews.get(pending.id);
    const work=G.AtriumForeignDraftUI.closeChoice(pending).then(c=>resolveClose(host,pending,c,deferDiscard))
      .catch(e=>{host.info?.(e.message);return false;}).finally(()=>reviews.delete(pending.id));
    reviews.set(pending.id,work); return work;
  }
  // Leaving the project (project/leave-project.js): the review only records its answer. Save saves now and Keep keeps
  // the recovery copy for later; Discard deletes the copy at the commit, so a later Cancel (or an open that fails)
  // keeps it. An answer holds for the revision it was given about: an edit made since asks again.
  const LP=G.AtriumLeaveProject, ANSWER="foreign-drafts";
  LP?.register(ANSWER,{order:LP.order.foreign,
    ask(t) {
      const host=t.host,pending=pendingOf(host);
      if (t.sameProject || t.settled || !pending || !needsReview(host)) return true;
      const held=t.answers.get(ANSWER);
      if (held?.id===pending.id && held.revision===host.revision()) return true;
      if (held?.discard) delete held.record.discardRevision;
      return review(host,true).then(ok=>{
        if (!ok) return false;
        const record=sessionRecord(pending);
        t.answers.set(ANSWER,{id:pending.id,pending,record,revision:host.revision(),discard:record.discardRevision!==undefined});
        return true;
      });
    },
    keep(t) { const held=t.answers.get(ANSWER); if (held?.discard) delete held.record.discardRevision; },
    commit(t) {
      const held=t.answers.get(ANSWER);
      if (!held) return;
      const {record,id}=held;
      if (held.discard) {
        delete record.discardRevision;
        serialized(record,async()=>{
          clearTimeout(record.timer); record.timer=null;
          if (!record.head) return;
          await scopes().write(scope,id,record.head.stamp,null);
          record.head=null; record.revision=undefined; discover(id,false);
        }).catch(e=>t.host.info?.(e.message));
      }
      release(held.pending);
    }});
  function beforeUnload(event) { if (needsReview(G.AtriumNavHost)) {event.preventDefault();event.returnValue="";} }
  let lastSession;
  G.AtriumNavCommon?.ready(host=>host.on?.("import-session",()=>{
    const p=pendingOf(host), previous=lastSession;
    lastSession=p;
    if (previous && previous.id!==p?.id) {
      // Conversion adopts the target before its acknowledged Save retires the old record.
      // Release large model/source references after that operation or an ordinary replacement.
      const releasePrevious=()=>{if (pendingOf(host)?.id!==previous.id) release(previous);};
      const saving=previous.operation?.promise;
      if (saving) saving.then(releasePrevious,releasePrevious); else releasePrevious();
    }
    if (G.AtriumHost) G.AtriumHost.setDirty?.(host.isDirty(),host.isStarter?.() ? null : host.project()?.name);
    else if (p && needsReview(host)) G.addEventListener?.("beforeunload",beforeUnload);
    else G.removeEventListener?.("beforeunload",beforeUnload);
  }));
  return Object.freeze({begin,bindSource,needsReview,schedule,configure,flush,retire,release,available,restore,review,resolveClose,finishReview,
    discard:async head=>{requireValue(head.scope===scope,"Invalid imported draft.");await scopes().write(scope,head.writer,head.stamp,null);discover(head.writer,false);}});
})();
