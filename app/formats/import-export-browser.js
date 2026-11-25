"use strict";
// A downloaded Blob has no commit receipt. File System Access handles do, and can be
// kept privately with the imported design's verified identity after explicit consent.
globalThis.AtriumBrowserImportExport = (() => {
  const G = globalThis, pending = new WeakMap(), active = new WeakMap();
  const t = (id,args) => G.AtriumImportExport.message(id,args);
  const supported = () => typeof G.showSaveFilePicker === "function" && !!G.crypto?.subtle;
  const key = name => String(name).normalize("NFC").toLowerCase();
  const stale = message => Object.assign(Error(message),{code:"stale_destination"});
  const sourceHandle = file => {
    const handle = file?.fileHandle || file?.handle || file;
    return typeof G.FileSystemFileHandle==="function" && handle instanceof G.FileSystemFileHandle ? handle : null;
  };
  const sameName = (name, files) => files.some(f => key(f.name) === key(name));
  const suffix = name => {
    const extension = /\.[^./]+$/.exec(name)?.[0] || "";
    return t("import_export.exportSuffix",{name:name.slice(0,name.length-extension.length),extension});
  };
  const receipt = record => ({name:record.handle.name,destination:record.destination});
  let database;
  async function stored(sourceKey, update) {
    database ||= new Promise((resolve,reject) => {
      const r = indexedDB.open("waffle-import-export",1);
      r.onupgradeneeded = () => r.result.createObjectStore("destinations");
      r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); database = null; }; resolve(db); };
      r.onerror = () => {database=null; reject(r.error);};
    });
    const db = await database;
    return new Promise((resolve,reject) => {
      const tx = db.transaction("destinations",update ? "readwrite" : "readonly"), table = tx.objectStore("destinations");
      const r = table.get(sourceKey);
      let result;
      r.onsuccess = () => {
        try {
          const v = r.result, rows = v?.rows || (v ? [v] : []);
          // The first implementation stored one destination directly under the digest.
          const version = v?.version || (v ? v.destination + "/" + v.hash : "");
          if (!update) { result = {rows,version}; return; }
          const next = update(version);
          result = next !== undefined;
          if (result) {
            if (next.length) table.put({version:G.crypto.randomUUID(),rows:next},sourceKey);
            else table.delete(sourceKey);
          }
        } catch (error) { reject(error); tx.abort(); }
      };
      tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error || r.error);
    });
  }
  async function match(rows, handles) {
    for (const row of rows) {
      if (row.sources?.length!==handles.length) continue;
      const same = await Promise.all(handles.map((h,i)=>h.isSameEntry(row.sources[i])));
      if (same.every(Boolean)) return row;
    }
    return null;
  }
  async function updateRecord(sourceKey, handles, next, expectedDestination) {
    // Comparing browser handles is async and would close an IndexedDB transaction.
    // Retry the small bucket if another tab publishes a preference in between.
    for (;;) {
      const view = await stored(sourceKey), row = await match(view.rows,handles);
      if (expectedDestination && expectedDestination!==row?.destination) return false;
      if (!row && !next) return true;
      const rows = view.rows.filter(r=>r!==row);
      if (next) rows.push(next);
      if (await stored(sourceKey,version=>version===view.version ? rows : undefined)) return true;
    }
  }
  async function digest(bytes) {
    const hash = new Uint8Array(await G.crypto.subtle.digest("SHA-256",bytes));
    return [...hash].map(x=>x.toString(16).padStart(2,"0")).join("");
  }
  async function fileDigest(handle) { return digest(await (await handle.getFile()).arrayBuffer()); }
  async function recalledImportExport({file,sources=[file],sourceKey}) {
    if (!supported()) return null;
    const handles = sources.map(sourceHandle);
    const old = G.indexedDB && handles.every(Boolean) ? await match((await stored(sourceKey)).rows,handles) : active.get(file);
    if (!old || old.sourceKey !== sourceKey) { active.delete(file); return null; }
    active.set(file,old);
    try {
      if (await old.handle.queryPermission({mode:"readwrite"}) === "granted") {
        await old.handle.getFile();
        return receipt(old);
      }
    } catch (error) { if (!["NotFoundError","NotAllowedError"].includes(error.name)) throw error; }
    await forgetImportExport({file,sources,sourceKey});
    return null;
  }
  async function rememberImportExport({file,sources=[file],sourceKey,destination}) {
    const row = pending.get(file);
    if (!row || row.sourceKey !== sourceKey || row.destination !== destination) return false;
    const handles = sources.map(sourceHandle);
    // Plain input[type=file] grants identify this open session only. A reopened
    // file with the same name and bytes can be a separate copy of the design.
    if (handles.every(Boolean) && G.indexedDB) { row.sources = handles; await updateRecord(sourceKey,handles,row); }
    active.set(file,row); pending.delete(file); return true;
  }
  async function forgetImportExport({file,sources=[file],sourceKey}) {
    const old = active.get(file), handles = old?.sources || sources.map(sourceHandle);
    active.delete(file); pending.delete(file);
    if (G.indexedDB && handles.every(Boolean)) await updateRecord(sourceKey,handles,null,old?.destination);
    return true;
  }
  async function newTarget(name, sources) {
    const suggestedName = sameName(name,sources) ? suffix(name) : name;
    const handle = await G.showSaveFilePicker({id:"waffle-import-export",suggestedName});
    if (handle.kind !== "file") throw Error(t("import_export.targetType"));
    for (const source of sources) {
      const original = sourceHandle(source);
      if (original && await original.isSameEntry(handle)) throw Error(t("import_export.sourcePicked"));
    }
    const target = await handle.getFile();
    if (!sources.every(f=>sourceHandle(f)) && (target.size || sameName(handle.name,sources)))
      throw Error(t("import_export.newFile"));
    return {handle,expected:await digest(await target.arrayBuffer())};
  }
  async function writeImportExport({file,sources=[file],sourceKey,name,bytes,files,destination},{current,signal}) {
    const outputName = files ? name + ".zip" : name;
    if (!supported()) {
      if (destination) throw stale(t("import_export.browserUnwritable"));
      const data = files ? G.AtriumZip.create(files.map(f=>({name:f.name,data:f.bytes}))) : bytes;
      if (!current()) throw stale(t("import_export.beforeDownload"));
      const downloadName = sameName(outputName,sources) ? suffix(outputName) : outputName;
      await G.AtriumIO.exportFile(downloadName,data);
      return {downloaded:true,name:downloadName};
    }
    const old = destination && active.get(file);
    if (destination && (!old || old.sourceKey !== sourceKey || old.destination !== destination)) throw stale(t("import_export.unauthorized"));
    // Ask while the report button still grants user activation. Build a multi-file
    // archive only after the user finishes choosing its destination.
    const chosen = old ? {handle:old.handle,expected:old.hash} : await newTarget(outputName,sources);
    if (!current()) throw stale(t("import_export.beforeExport"));
    const {handle,expected} = chosen;
    if (await handle.queryPermission({mode:"readwrite"}) !== "granted" || await fileDigest(handle) !== expected) {
      if (old) await forgetImportExport({file,sourceKey});
      throw stale(t("import_export.targetChanged"));
    }
    const data = files ? G.AtriumZip.create(files.map(f=>({name:f.name,data:f.bytes}))) : bytes;
    const hash = await digest(data), stream = await handle.createWritable({mode:"exclusive"});
    try {
      await stream.write(data);
      signal?.throwIfAborted();
      if (!current() || await fileDigest(handle) !== expected) throw stale(t("import_export.duringExport"));
      await stream.close();
    } catch (error) { await stream.abort().catch(()=>{}); throw error; }
    if (await fileDigest(handle) !== hash) throw stale(t("import_export.verifyFailed"));
    const row = {...old,sourceKey,handle,hash,destination:destination || G.crypto.randomUUID()};
    if (old) {
      if (old.sources) {
        try {
          if (!await updateRecord(sourceKey,old.sources,row,old.destination)) {
            active.delete(file);
            return {...receipt(row),preferenceError:t("import_export.rememberChanged")};
          }
        } catch (error) {
          active.delete(file);
          await updateRecord(sourceKey,old.sources,null,old.destination).catch(()=>{});
          return {...receipt(row),preferenceError:error.message};
        }
      }
      active.set(file,row);
    } else pending.set(file,row);
    return receipt(row);
  }
  const rememberScope = ({file,sources=[file]}) => sources.every(f=>sourceHandle(f)) && G.indexedDB ? "project" : "session";
  return Object.freeze({writeImportExport,rememberImportExport,recalledImportExport,forgetImportExport,canRemember:supported,rememberScope});
})();
