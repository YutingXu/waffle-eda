"use strict";

// Browser sessions use the same owner reads and save plans as desktop folders.
// The selected bytes and edits belong to this window until the user downloads a ZIP.
globalThis.AtriumBrowserProject = (() => {
  const F = globalThis.AtriumFormat2, A = globalThis.AtriumProjectArchive;
  const encode = new TextEncoder();
  const invalid = text => { throw Error(text); };
  function payload(change,previous) {
    if (!change.splice) {
      if (typeof change.text === "string") return encode.encode(change.text);
      if (typeof change.data !== "string") invalid("Invalid project member contents.");
      return Uint8Array.fromBase64?.(change.data) ?? Uint8Array.from(atob(change.data),ch=>ch.charCodeAt(0));
    }
    if (!previous || change.splice.base !== previous.sha256) invalid("The project member changed before Save.");
    const parts = [];
    let offset = 0, size = previous.length;
    for (const {offset:start,remove,insert} of change.splice.edits) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(remove) || start < offset || remove < 0 ||
          start + remove > previous.length || typeof insert !== "string") invalid("Invalid project member edit.");
      const bytes = encode.encode(insert);
      parts.push(previous.bytes.subarray(offset,start),bytes);
      offset = start + remove;
      size += bytes.length - remove;
    }
    parts.push(previous.bytes.subarray(offset));
    if (size > A.bounds.entryBytes) invalid("A project member exceeds the ZIP size limit.");
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) { bytes.set(part,at); at += part.length; }
    return bytes;
  }
  function create(manifest, originals = new Map(), {commit, close, temporary = true, draftScope = "browser-project"} = {}) {
    const grant = globalThis.crypto?.randomUUID?.() || Atrium.id(), leases = new Map();
    let files = new Map([...originals].map(([path,bytes]) => [path,receipt(path,bytes)]));
    let closed = false, sequence = 0;
    const check = token => {
      if (closed || token !== grant) invalid("The browser project has closed.");
    };
    function receipt(path,bytes) {
      A.portable(path);
      if (bytes.length > A.bounds.entryBytes) invalid("A project member exceeds the ZIP size limit.");
      return {path,bytes,length:bytes.length,sha256:F.sha256(bytes)};
    }
    const host = Object.freeze({
      folderAdopt({grant:token}) { check(token); return true; },
      folderClose({grant:token}) {
        if (token !== grant || closed) return;
        closed = true; leases.clear(); files.clear();
        return close?.();
      },
      folderReadLease({grant:token}) {
        check(token);
        const lease = String(++sequence);
        leases.set(lease,files);
        return {lease};
      },
      folderRelease({grant:token,lease}) { if (token === grant) leases.delete(lease); },
      folderRead({grant:token,lease,paths}) {
        check(token);
        const snapshot = leases.get(lease);
        if (!snapshot) invalid("The browser project read lease has expired.");
        return {files:paths.map(path=>snapshot.get(path)).filter(Boolean).map(row=>({...row,bytes:row.bytes.slice()}))};
      },
      folderCommit({grant:token,manifest:target,plan}) {
        check(token);
        if (target !== manifest) invalid("This save belongs to a different browser project.");
        const next = new Map(files), hashes = Object.create(null), seen = new Set();
        for (const row of plan) {
          const path = A.portable(row.path), old = files.get(path);
          if (seen.has(path) || row.expected !== (old?.sha256 ?? null)) invalid("The project member changed before Save: "+path);
          seen.add(path);
          if (row.remove) next.delete(path);
          else {
            const stored = receipt(path,payload(row,old));
            next.set(path,stored); hashes[path] = stored.sha256;
          }
        }
        if (!next.has(manifest) || next.size > A.bounds.entries ||
            [...next.values()].reduce((sum,row)=>sum+row.length,0) > A.bounds.totalBytes)
          invalid("The saved project exceeds the browser ZIP limits.");
        const accept = result => {
          files = next;
          return {saved:true,transaction:result?.transaction || String(++sequence),hashes};
        };
        return commit ? Promise.resolve(commit(files,next,plan)).then(accept) : accept();
      }
    });
    return {grant,manifest,host,temporary,draftScope};
  }
  return Object.freeze({create, payload});
})();
