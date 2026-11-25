"use strict";
// Local group copies are independent of the active project. Store immutable records once.
// The head and its approval share a transaction. A second window that got there first causes
// the operation to be retried on its new head, including the stale-review check.
globalThis.AtriumGroupLocal = (() => {
  const Core = () => globalThis.AtriumGroupLibrary;
  const MARK = "atrium.group-library.v1", copies = new Map(), sources = new Map(), listeners = new Set();
  let database, ready, channel, signingKey, localKey, queue = Promise.resolve();
  const notify = (id, added, from, installed = true) => {
    for (const fn of listeners) try { fn(id, added, from, installed); } catch (e) { globalThis.console?.warn?.(e.message); }
  };
  const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  function openDB() {
    if (!database) database = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(Error("Local group libraries need browser storage.")); return; }
      const r = indexedDB.open("atrium-group-libraries", 2);
      r.onupgradeneeded = event => {
        if (event.oldVersion < 1) {
          r.result.createObjectStore("groups", {keyPath: "id"});
          r.result.createObjectStore("records", {keyPath: ["group", "key"]}).createIndex("group", "group");
        }
        r.result.createObjectStore("identity");
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); database = null; };
        resolve(db);
      };
      r.onblocked = () => reject(Error("Close older Waffle windows and reopen the group library to upgrade its storage."));
      r.onerror = () => reject(r.error);
    }).catch(error => { database = null; throw error; });
    return database;
  }
  const query = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  async function storedIdentity(slot, create) {
    // Generating a key is asynchronous. The read and conditional add then share one write
    // transaction so two windows pick the same winner, even on the first use of this profile.
    const db = await openDB(), existing = await query(db.transaction("identity").objectStore("identity").get(slot));
    if (existing) return existing;
    const candidate = await create();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("identity", "readwrite"), store = tx.objectStore("identity"), read = store.get(slot);
      let chosen, cause;
      read.onsuccess = () => {
        chosen = read.result || candidate;
        if (!read.result) try { store.add(candidate, slot); } catch (e) { cause = e; tx.abort(); }
      };
      tx.oncomplete = () => resolve(chosen);
      tx.onabort = () => reject(cause || tx.error || Error("The signing identity could not be saved."));
    });
  }
  async function member(name) {
    if (globalThis.crypto?.subtle) {
      signingKey ||= storedIdentity("member", Core().newSigningKey).catch(e => { signingKey = null; throw e; });
      try { return {...await signingKey, name}; }
      catch (e) { if (!["NotSupportedError", "DataCloneError"].includes(e.name)) throw e; }
    }
    // Local work can continue in a webview without persistent CryptoKeys. Neither these
    // records nor their descendants can enter a bundle, a Git checkout or live sync.
    localKey ||= storedIdentity("local", () => ({id: "local-" + globalThis.Atrium.id(), localOnly: true}))
      .catch(e => { localKey = null; throw e; });
    return {...await localKey, name};
  }
  function serial(fn) { const task = queue.then(fn); queue = task.catch(() => {}); return task; }
  function sameHeads(a, b) {
    return a.size === b.size && [...a].every(([id, key]) => b.get(id) === key);
  }
  function installed(id, name, heads) {
    const source = sources.get(id);
    if (!source || source.name !== name) return false;
    const current = new Map(source.revisionKeys);
    if (source.naming) current.set(null, source.naming.key);
    return sameHeads(current, heads);
  }
  async function load(id) {
    const db = await openDB(), tx = db.transaction(["groups", "records"]);
    const [meta, events] = await Promise.all([query(tx.objectStore("groups").get(id)), query(tx.objectStore("records").index("group").getAll(id))]);
    if (!meta) { copies.delete(id); sources.delete(id); return null; }
    // Locally committed records are already verified. Stored ordinal preserves causal order.
    events.sort((a, b) => a.ordinal - b.ordinal);
    const group = Core().create(meta, {...meta, events: events.map(row => [row.key, row.event])});
    copies.set(id, {group, generation: meta.generation});
    if (!installed(id, group.info.name, group.heads)) sources.set(id, group.library());
    return group;
  }
  async function loadSource(meta) {
    const db = await openDB(), tx = db.transaction("records"), st = tx.objectStore("records"), keys = new Map(meta.heads);
    if (installed(meta.id, meta.name, keys)) return;
    const rows = await Promise.all([...keys.values()].map(k => query(st.get([meta.id, k]))));
    sources.set(meta.id, Core().librarySource(meta, keys, rows.map(r => r.event)));
  }
  function restore() {
    if (!ready) ready = (async () => {
      const db = await openDB();
      if (typeof BroadcastChannel === "function") {
        channel = new BroadcastChannel("atrium-group-libraries-v1");
        channel.onmessage = e => {
          const id = e.data;
          if (typeof id === "string") restore().then(() => serial(async () => {
            const previous = sources.get(id);
            if (copies.has(id)) await load(id);
            else {
              const meta = await query(db.transaction("groups").objectStore("groups").get(id));
              if (meta) await loadSource(meta);
            }
            notify(id, true, null, previous !== sources.get(id));
          })).catch(() => {});
        };
      }
      const metas = await query(db.transaction("groups").objectStore("groups").getAll());
      await Promise.all(metas.map(loadSource));
      if (metas.length) notify(null, false);
    })().catch(e => { ready = null; throw e; });
    return ready;
  }
  async function persist(group, version, added) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["groups", "records"], "readwrite"), meta = tx.objectStore("groups"), records = tx.objectStore("records");
      const check = meta.get(group.info.id); let stale = false;
      check.onsuccess = () => {
        if ((check.result?.generation || 0) !== version) { stale = true; tx.abort(); return; }
        let ordinal = group.events.size - added.length;
        for (const event of added) records.add({group: group.info.id, key: event.key, ordinal: ordinal++, event});
        meta.put({...group.info, generation: version + 1, heads: [...group.heads], dismissed: [...group.dismissed], members: [...group.members]});
      };
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => stale ? resolve(false) : reject(tx.error || Error("The local library could not be saved."));
      tx.onerror = () => {}; // onabort carries the final transaction result
    });
  }
  function edit(info, action, from) {
    return serial(async () => {
      await restore();
      for (;;) {
        let prior = copies.get(info.id);
        if (!prior) { await load(info.id); prior = copies.get(info.id); }
        const group = Core().create(prior?.group.info || info, prior?.group);
        const result = await action(group), added = group.addedRecords();
        // A repeated import, replay or duplicate decision has no disk or UI cost.
        if (prior && !added.length && sameLocal(group, prior.group)) return result;
        const version = prior?.generation || 0;
        if (!await persist(group, version, added)) { await load(info.id); continue; }
        const changed = !installed(info.id, group.info.name, group.heads);
        copies.set(info.id, {group, generation: version + 1});
        if (changed) sources.set(info.id, group.library());
        try { localStorage.setItem(MARK, "1"); } catch { /* copies remain accessible in the dialog */ }
        notify(info.id, added.length > 0, from, changed); channel?.postMessage(info.id); return result;
      }
    });
  }
  const sameLocal = (a, b) => a.heads.size === b.heads.size && [...a.heads].every(([id, k]) => b.heads.get(id) === k) &&
    a.members.size === b.members.size && [...a.members].every(([k, n]) => b.members.get(k) === n) &&
    a.dismissed.size === b.dismissed.size && [...a.dismissed].every(k => b.dismissed.has(k));
  async function open(id) { await restore(); return copies.get(id)?.group || serial(() => load(id)); }
  return Object.freeze({restore, member, edit, open, current: id => copies.get(id)?.group, libraries: () => [...sources.values()], onChange});
})();
