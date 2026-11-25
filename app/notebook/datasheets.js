"use strict";
// Authorized bytes, reader sessions and page data. Views only schedule visible work.
globalThis.AtriumDatasheets = (() => {
  const G = globalThis, PDF_LIMIT = 128*1024**2, CACHE_LIMIT = 512*1024**2, CACHE_FILES = 256;
  const HASH = /^[0-9a-f]{64}$/, MAX_WORKERS = 4, MAX_DOCUMENTS = 32, TIMEOUT = 20000;
  const asError = (message,code) => Object.assign(Error(message),{code});
  const abort = () => Object.assign(Error("The datasheet request was cancelled."),{name:"AbortError",code:"cancelled"});
  let privateCache, parseRequests=0, liveReaders=0, slots=0;
  const approved = new Map(), sessions = new Map();
  const enabled = () => G.AtriumPrefs?.get("butter.datasheets") === true;

  function check(signal,current) {if (signal?.aborted || current?.()===false) throw abort();}
  function safeURL(value) {
    const url = G.AtriumDatasheetRecord.safeURL(value);
    if (!url) throw asError("Use an HTTPS datasheet URL without credentials or a fragment.","invalid_arguments");
    return url;
  }
  function bytesOf(value, legacy=false) {
    const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
    if (!bytes?.length || bytes.length>PDF_LIMIT || !(G.AtriumDatasheetRecord.pdfHeader(bytes) || legacy && new TextDecoder().decode(bytes.subarray(0,1024)).includes("%PDF-")))
      throw asError("Choose a PDF up to 128 MiB.","invalid_pdf");
    return bytes;
  }
  async function hashOf(bytes) {
    if (G.crypto?.subtle) return Array.from(new Uint8Array(await G.crypto.subtle.digest("SHA-256",bytes)),
      byte=>byte.toString(16).padStart(2,"0")).join("");
    await G.AtriumLazy.need("AtriumSourceFile");
    return G.AtriumSourceFile.sha256(bytes);
  }
  function db() {
    if (!privateCache) privateCache = new Promise((resolve,reject)=>{
      if (!G.indexedDB) {reject(asError("The private datasheet cache is unavailable.","cache_unavailable"));return;}
      const request = G.indexedDB.open("waffle-datasheets-v1",1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("content");
        request.result.createObjectStore("metadata",{keyPath:"sha256"});
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {request.result.close();privateCache=null;};
        resolve(request.result);
      };
      request.onerror = () => reject(asError("The private datasheet cache could not open.","cache_unavailable"));
      request.onblocked = () => reject(asError("Another Waffle window is updating the datasheet cache.","cache_unavailable"));
    }).catch(error=>{privateCache=null;throw error;});
    return privateCache;
  }
  async function store(bytes,sha256,signal) {
    const database = await db();
    check(signal);
    return new Promise((resolve,reject)=>{
      const transaction = database.transaction(["content","metadata"],"readwrite");
      const metadata = transaction.objectStore("metadata"), content = transaction.objectStore("content");
      const find = metadata.getAll();
      const stop = () => {try{transaction.abort();}catch{}};
      signal?.addEventListener("abort",stop,{once:true});
      find.onsuccess = () => {
        const rows = find.result.filter(row=>row.sha256!==sha256).sort((a,b)=>a.lastUsed-b.lastUsed);
        let sum = rows.reduce((n,row)=>n+row.byteLength,bytes.byteLength), count=rows.length+1;
        for (const row of rows) {
          if (count<=CACHE_FILES && sum<=CACHE_LIMIT) break;
          metadata.delete(row.sha256); content.delete(row.sha256); count--; sum-=row.byteLength;
        }
        content.put(bytes,sha256);
        metadata.put({sha256,byteLength:bytes.byteLength,lastUsed:Date.now()});
      };
      transaction.oncomplete = () => {signal?.removeEventListener("abort",stop);resolve();};
      transaction.onabort = transaction.onerror = () => {
        signal?.removeEventListener("abort",stop);
        reject(signal?.aborted ? abort() : asError("The private datasheet cache could not save the file.","cache_unavailable"));
      };
    });
  }
  async function fromCache(ref,signal) {
    const database = await db();
    check(signal);
    return new Promise((resolve,reject)=>{
      const tx = database.transaction(["content","metadata"],"readwrite");
      const content = tx.objectStore("content").get(ref.sha256);
      const stop = () => {try{tx.abort();}catch{}};
      signal?.addEventListener("abort",stop,{once:true});
      content.onsuccess = () => {
        if (content.result?.byteLength===ref.byteLength)
          tx.objectStore("metadata").put({sha256:ref.sha256,byteLength:ref.byteLength,lastUsed:Date.now()});
      };
      tx.oncomplete = () => {signal?.removeEventListener("abort",stop);resolve(content.result);};
      tx.onabort = tx.onerror = () => {
        signal?.removeEventListener("abort",stop);
        reject(signal?.aborted ? abort() : asError("Could not read the private datasheet cache.","cache_unavailable"));
      };
    });
  }
  function titleOf(name) {
    return [...String(name||"Datasheet").replace(/[\u0000-\u001f\u007f]/g,"").replace(/\.pdf$/i,"").trim()].slice(0,255).join("") || "Datasheet";
  }
  async function describeBytes(bytes,{name,sourceURL,version,signal,current}) {
    check(signal,current);
    const reference = {sha256:await hashOf(bytes),byteLength:bytes.byteLength,title:titleOf(name)};
    if (sourceURL!==undefined) reference.sourceURL=safeURL(sourceURL);
    if (version!==undefined) {
      if (typeof version!=="string") throw asError("Invalid datasheet revision.","invalid_arguments");
      reference.version=version.trim();
    }
    if (!G.AtriumDatasheetRecord.validateReference(reference))
      throw asError("Invalid datasheet metadata.","invalid_arguments");
    check(signal,current);
    return Object.freeze(reference);
  }
  async function openBytes(options={}) {
    check(options.signal,options.current);
    const bytes = bytesOf(options.bytes).slice();
    const reference = await describeBytes(bytes,options);
    await store(bytes,reference.sha256,options.signal);
    check(options.signal,options.current);
    return reference;
  }
  async function checkedSource(ref,load,signal,current) {
    const data = load ? await load(ref,signal) : await fromCache(ref,signal);
    check(signal,current);
    if (!data) throw asError("The datasheet is not in this user's cache. Select the original PDF.","missing_datasheet");
    const bytes = bytesOf(data.bytes ?? data,true);
    if (bytes.byteLength!==ref.byteLength || await hashOf(bytes)!==ref.sha256)
      throw asError("The PDF no longer matches this datasheet reference.","source_changed");
    check(signal,current);
    return bytes;
  }

  async function download({url,authorizeURL,signal,current,expected}={}) {
    if (!enabled()) throw asError("Datasheets are disabled.","butter_disabled");
    const sourceURL = safeURL(url);
    check(signal,current);
    if (typeof authorizeURL!=="function" || await authorizeURL(sourceURL)!==true)
      throw asError("Approve this HTTPS supplier address before downloading.","consent_required");
    check(signal,current);
    const response = await fetch(sourceURL,{signal,credentials:"omit",referrerPolicy:"no-referrer",redirect:"error",cache:"no-store"});
    if (!response.ok || !response.body) throw asError("The supplied PDF could not be downloaded.","missing_datasheet");
    const length = Number(response.headers.get("content-length")), reader = response.body.getReader(), chunks = [];
    let size=0, done=false;
    try {
      if (length > PDF_LIMIT) throw asError("Choose a PDF up to 128 MiB.","invalid_pdf");
      for (;;) {
        check(signal,current);
        const row = await reader.read();
        if (row.done) {done=true;break;}
        size += row.value.byteLength;
        if (size>PDF_LIMIT) throw asError("Choose a PDF up to 128 MiB.","invalid_pdf");
        chunks.push(row.value);
      }
    } finally {
      if (!done) await reader.cancel().catch(()=>{});
      reader.releaseLock();
    }
    check(signal,current);
    const bytes = new Uint8Array(size);
    let step=0;
    for (const chunk of chunks) {bytes.set(chunk,step);step+=chunk.byteLength;}
    if (expected && (expected.byteLength!==size || expected.sha256!==await hashOf(bytes)))
      throw asError("The downloaded PDF differs from the recorded reference.","source_changed");
    const name = expected?.title || new URL(sourceURL).pathname.split("/").at(-1);
    return openBytes({bytes,name,sourceURL,version:expected?.version,signal,current});
  }
  const bound = (host,project) => enabled() && host.project()===project;
  function authorize(project,ref) {
    const now = Date.now();
    for (const [key,value] of approved) if (value.expires < now || approved.size >= 32) approved.delete(key);
    const grant = G.Atrium.id();
    approved.set(grant,{project:project.id,ref,expires:now+60000});
    return grant;
  }
  function input(grant,project) {
    const row = approved.get(grant);
    if (enabled() && row?.project===project && row.expires>=Date.now()) return row.ref;
  }
  async function referenceBytes({host=G.AtriumNavHost,bytes,name,signal,current,beforeCommit}={}) {
    if (!enabled()) throw asError("Datasheets are disabled.","butter_disabled");
    const project = host.project(), live = ()=>bound(host,project) && current?.()!==false;
    const ref = await openBytes({bytes,name,signal,current:live});
    const grant = authorize(project,ref);
    try {
      check(signal,live);
      return (await G.AtriumButterEditor.apply("butter.datasheets.reference",{grant},
        {beforeCommit:()=>{check(signal,live);beforeCommit?.();}})).result.reference;
    } finally {approved.delete(grant);}
  }
  async function chooseEmbedded({host=G.AtriumNavHost,expected,confirm,signal}={}) {
    if (!enabled()) throw asError("Datasheets are disabled.","butter_disabled");
    const project = host.project(), session = host.folderProject?.(), native = G.AtriumHost;
    const live = ()=>bound(host,project) && host.folderProject?.()===session && !session?.readOnly;
    if (!session?.grant || !native?.folderPickAsset || !native.folderStageAsset || !native.folderDropAsset ||
        typeof confirm!=="function") throw asError("Open an editable native folder to embed the PDF.","unsupported_surface");
    check(signal,live);
    if (await confirm()!==true) return null;
    check(signal,live);
    const options = {grant:session.grant,ownerId:project.id,mediaType:"application/pdf"};
    const picked = await native.folderPickAsset({...options,mediaTypes:["application/pdf"]});
    if (!picked) return null;
    let stage, staged=false, grant;
    try {
      check(signal,live);
      stage = await native.folderStageAsset({...options,sourceToken:picked.sourceToken});
      check(signal,live);
      if (!stage?.assetToken || stage.ownerId!==project.id || stage.assetRef?.mediaType!==options.mediaType)
        throw asError("The selected PDF could not be verified.","invalid_pdf");
      const read = await session.readAsset({...stage,purpose:"datasheet embed",signal});
      const ref = await describeBytes(bytesOf(read.bytes),{name:picked.name,signal,current:live});
      if (stage.assetRef.sha256!==ref.sha256 || stage.assetRef.byteLength!==ref.byteLength)
        throw asError("The selected PDF could not be verified.","source_changed");
      if (expected && (expected.sha256!==ref.sha256 || expected.byteLength!==ref.byteLength))
        throw asError("Choose the exact original PDF to embed this reference.","source_changed");
      const metadata = expected ? {...ref,title:expected.title,...(expected.sourceURL && {sourceURL:expected.sourceURL}),
        ...(expected.version && {version:expected.version}),...(expected.pageCount && {pageCount:expected.pageCount})} : ref;
      grant = authorize(project,{...metadata,asset:stage.assetRef});
      check(signal,live);
      const result = await G.AtriumButterEditor.apply("butter.datasheets.reference",{grant,embed:true,...(expected && {existingId:expected.id})},
        {beforeCommit:()=>check(signal,live)});
      if (result.changes) {
        session.stageAttachment(stage);
        staged=true;
      }
      return result.result.reference;
    } finally {
      if (grant) approved.delete(grant);
      if (stage?.assetToken && !staged) await session.releaseAsset({assetToken:stage.assetToken});
      if (!stage) await native.folderDropAsset({...options,sourceToken:picked.sourceToken}).catch(()=>{});
    }
  }
  function loadFor(projectId,host=G.AtriumNavHost) {
    return async (ref,signal) => {
      if (!enabled() || host?.project().id!==projectId) throw abort();
      if (ref.asset) {
        const session = host.folderProject?.();
        if (session) return session.readAsset({ownerId:projectId,assetRef:ref.asset,signal,purpose:"datasheet page"});
      }
      return fromCache(ref,signal);
    };
  }
  async function workerSource() {
    if (G.location?.protocol==="file:") {
      const bundle = await G.AtriumLazy.need("AtriumDatasheetWorkerSource");
      return bundle.create();
    }
    return {url:new URL("workers/datasheet-worker.mjs",document.baseURI),type:"module",close(){}};
  }
  // There is one worker per active digest. Idle documents can be evicted while
  // their readers stay open, and the queued loads do not retain PDF bytes.
  function pump() {
    for (const entry of sessions.values()) {
      if (entry.started || !entry.active) continue;
      if (slots >= MAX_WORKERS) {
        const idle = [...sessions.values()].find(candidate=>candidate.started && !candidate.active);
        if (!idle) break;
        idle.stop(abort());
      }
      entry.start();
    }
  }

  function sessionFor(ref,load) {
    const known = sessions.get(ref.sha256);
    if (known) {
      if (known.byteLength!==ref.byteLength) throw asError("The PDF length does not match this reference.","source_changed");
      return known;
    }
    if (sessions.size >= MAX_DOCUMENTS) throw asError("Too many datasheet requests are open.","pdf_busy");
    const controller = new AbortController(), pending = new Map(), readers = new Set();
    const entry = {byteLength:ref.byteLength,readers,started:false,ready:false,active:0,error:null,start,stop,call};
    let worker, workerURL, timer, next=0, resolveOpen, rejectOpen;
    entry.open = new Promise((resolve,reject)=>{resolveOpen=resolve;rejectOpen=reject;});
    sessions.set(ref.sha256,entry);

    function stop(error) {
      if (entry.error) return;
      entry.error=error;
      sessions.delete(ref.sha256);
      controller.abort();
      clearTimeout(timer);
      if (entry.started) slots--;
      if (worker) {worker.terminate();liveReaders--;}
      workerURL?.close();
      workerURL=undefined;
      rejectOpen(error);
      for (const finish of pending.values()) finish(false,error);
      readers.clear();
    }
    function fail(error) {stop(error);pump();}
    function call(op,args={},signal) {
      check(signal);
      if (entry.error) throw entry.error;
      const id=++next;
      return new Promise((resolve,reject)=>{
        const finish = (ok,value) => {
          if (!pending.delete(id)) return;
          clearTimeout(watchdog);
          signal?.removeEventListener("abort",cancel);
          if (ok) resolve(value); else reject(value);
        };
        const cancel = () => {
          try {worker.postMessage({op:"cancel",id});}
          finally {finish(false,abort());}
        };
        const watchdog = setTimeout(()=>fail(asError("The datasheet reader timed out.","pdf_timeout")),TIMEOUT);
        pending.set(id,finish);
        signal?.addEventListener("abort",cancel,{once:true});
        try {worker.postMessage({key:ref.sha256,op,id,...args},op==="open" ? [args.bytes.buffer] : []);}
        catch (error) {finish(false,error);}
      });
    }
    async function start() {
      entry.started=true;
      slots++;
      timer=setTimeout(()=>fail(asError("The datasheet reader timed out.","pdf_timeout")),TIMEOUT);
      try {
        const source = await checkedSource(ref,load,controller.signal);
        workerURL = await workerSource();
        check(controller.signal);
        try {worker = new Worker(workerURL.url,{type:workerURL.type,name:"Datasheet reader"});}
        catch {throw asError("The datasheet worker is unavailable on this host.","pdf_unavailable");}
        liveReaders++;
        worker.onmessage = ({data}) => {
          const finish = pending.get(data.id);
          finish?.(!data.error,data.error ? asError(data.error,"invalid_pdf") : data.result);
        };
        worker.onerror = () => fail(asError("The datasheet worker could not start.","pdf_unavailable"));
        parseRequests++;
        const info = await call("open",{bytes:source.slice()});
        entry.ready=true;
        resolveOpen(info);
      } catch (error) {fail(error);}
      finally {
        clearTimeout(timer);
        workerURL?.close();
        workerURL=undefined;
      }
    }
    return entry;
  }

  function waitFor(promise,signal) {
    return new Promise((resolve,reject)=>{
      const cancel = () => reject(abort());
      signal.addEventListener("abort",cancel,{once:true});
      if (signal.aborted) cancel();
      promise.then(resolve,reject).finally(()=>signal.removeEventListener("abort",cancel));
    });
  }

  function createReader(ref,{load,signal,current}={}) {
    if (!ref || !HASH.test(ref.sha256) || !Number.isInteger(ref.byteLength) || ref.byteLength<1 || ref.byteLength>PDF_LIMIT)
      throw asError("Invalid datasheet reference.","invalid_arguments");
    const lifetime = new AbortController(), reader = {};
    let view, session;
    function close() {
      lifetime.abort();
      signal?.removeEventListener("abort",close);
      if (session) {
        session.readers.delete(reader);
        if (!session.active && !session.readers.size) session.stop(abort());
      }
      pump();
    }
    async function read(op,options={}) {
      check(lifetime.signal,current);check(options.signal);
      const {signal:jobSignal,...args}=options, job = new AbortController();
      const cancel = () => job.abort();
      const entry = session = sessionFor(ref,load);
      entry.readers.add(reader);
      entry.active++;
      lifetime.signal.addEventListener("abort",cancel,{once:true});
      jobSignal?.addEventListener("abort",cancel,{once:true});
      try {
        const opening = waitFor(entry.open,job.signal);
        pump();
        const info = await opening;
        check(job.signal,current);
        const result = op==="info" ? info : await entry.call(op,args,job.signal);
        check(job.signal,current);
        return result;
      } finally {
        lifetime.signal.removeEventListener("abort",cancel);
        jobSignal?.removeEventListener("abort",cancel);
        if (--entry.active===0 && (!entry.ready || !entry.readers.size)) entry.stop(abort());
        pump();
      }
    }
    async function visible(pages,options={}) {
      view?.abort();view=new AbortController();
      if (Array.isArray(pages) && !pages.length) return {pages:[]};
      const scoped = view, cancel=()=>scoped.abort();
      options.signal?.addEventListener("abort",cancel,{once:true});
      if (options.signal?.aborted) cancel();
      try {return await read("visible",{pages,side:options.side,signal:scoped.signal});}
      finally {options.signal?.removeEventListener("abort",cancel);}
    }
    signal?.addEventListener("abort",close,{once:true});
    if (signal?.aborted) close();
    return Object.freeze({visible,close,info:options=>read("info",options),text:options=>read("text",options),
      table:options=>read("table",options),search:options=>read("search",options),snip:options=>read("snip",options)});
  }
  async function createReaderFromBytes(input,{signal}={}) {
    check(signal);
    const bytes = bytesOf(input), sha256=await hashOf(bytes);
    check(signal);
    return createReader({sha256,byteLength:bytes.byteLength},{load:()=>bytes,signal});
  }
  const metrics = () => ({parseRequests,liveReaders});
  return Object.freeze({openBytes,createReader,createReaderFromBytes,resolveFragment:G.AtriumDatasheetRecord.resolveFragment,safeURL,metrics,input,referenceBytes,chooseEmbedded,loadFor,download});
})();
