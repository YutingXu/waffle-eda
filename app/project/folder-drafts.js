"use strict";
if (!globalThis.AtriumBase64 && typeof require === "function") require("../core/base64.js");
// Private to this WebView profile. A native grant's stable directory identity scopes independent
// copies of a design. Each editor has its own key and can retire only the version it reviewed.
globalThis.AtriumFolderDrafts = (() => {
  const VERSION = 1, uuid = () => crypto.randomUUID();
  const message = error => error?.message || String(error);
  let dbPromise;
  function database() {
    if (!dbPromise) dbPromise = new Promise((resolve,reject) => {
      if (!globalThis.indexedDB) return reject(Error("Private draft storage is unavailable in this window."));
      const req = indexedDB.open("waffle-folder-drafts",VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("headers",{keyPath:["scope","writer"]}).createIndex("scope","scope");
        db.createObjectStore("owners",{keyPath:["scope","writer","id"]}).createIndex("writer",["scope","writer"]);
        db.createObjectStore("originals",{keyPath:["scope","writer","key"]}).createIndex("writer",["scope","writer"]);
      };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(Error("Close the older Waffle window to access private drafts."));
    }).catch(e => { dbPromise = null; throw e; });
    return dbPromise;
  }
  async function transaction(names,mode,work) {
    const db = await database();
    return new Promise((resolve,reject) => {
      let tx, value, failure;
      try { tx = db.transaction(names,mode,{durability:"strict"}); } catch { tx = db.transaction(names,mode); }
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(failure || tx.error || Error("The private draft could not be stored."));
      work(tx, v => { value = v; }, e => { failure = e; tx.abort(); });
    });
  }
  function removeOutside(store,key,wanted) {
    const cursor = store.index("writer").openKeyCursor(IDBKeyRange.only(key));
    cursor.onsuccess = () => { const c = cursor.result; if (c) { if (!wanted.has(c.primaryKey[2])) store.delete(c.primaryKey); c.continue(); } };
  }
  const storage = {
    list(scope) { return transaction(["headers"],"readonly",(tx,done) => {
      const r = tx.objectStore("headers").index("scope").getAll(scope); r.onsuccess = () => done(r.result);
    }); },
    read(head) { return transaction(["headers","owners","originals"],"readonly",(tx,done,fail) => {
      const key = [head.scope,head.writer], h = tx.objectStore("headers").get(key);
      h.onsuccess = () => {
        if (h.result?.stamp !== head.stamp || h.result.version !== VERSION) return fail(Error("This draft changed. Review its current version."));
        const rows = tx.objectStore("owners").index("writer").getAll(key), originals = tx.objectStore("originals").index("writer").getAll(key);
        const out = {header:h.result}; rows.onsuccess = () => { out.rows = rows.result.map(r => r.value); };
        originals.onsuccess = () => { out.originals = originals.result.map(r => r.value); };
        done(out);
      };
    }); },
    write(scope,writer,prior,head,rows=[],assets=[]) {
      return transaction(["headers","owners","originals"],"readwrite",(tx,done,fail) => {
        const key = [scope,writer], headers = tx.objectStore("headers"), owners = tx.objectStore("owners"), originals = tx.objectStore("originals");
        const h = headers.get(key);
        h.onsuccess = () => {
          if (h.result?.stamp !== prior) {
            const e = Error("Another window changed this draft. Review it again.");
            if (!h.result && prior) e.code = "draft-removed";
            return fail(e);
          }
          if (head) headers.put(head); else headers.delete(key);
          for (const row of rows) owners.put({scope,writer,id:row.id,value:row});
          for (const a of assets) originals.put({scope,writer,key:a.key,value:a});
          removeOutside(owners,key,new Set(head?.rows.map(r => r.id)));
          removeOutside(originals,key,new Set(head?.assets));
          done(true);
        };
      });
    }
  };
  function bind(options) {
    const {scope,projectId,snapshot,cursor,classify,restore,diagnose} = options;
    const store = options.store || storage, writer = uuid();
    const key = JSON.stringify([scope,projectId]), pins = new Map();
    let timer, first = null, queue = Promise.resolve(), own, requested = 0, completed = 0, disposed = false;
    let failure, writes = 0, enabled, interval, lastWrite;
    const stop = () => { clearTimeout(timer); timer = undefined; first = null; };
    function schedule(immediate = false) {
      if (!enabled || disposed) return;
      const now = Date.now(), constants = globalThis.AtriumAutosave?.constants || {};
      first ??= now; clearTimeout(timer);
      const debounce = constants.DEBOUNCE || 1500, quiet = globalThis.AtriumPower?.delay?.(debounce) ?? debounce;
      const firstDue = Math.min(now + quiet, first + (constants.MAX_WAIT || 20000));
      const nextDue = lastWrite === undefined ? firstDue : Math.max(lastWrite + interval, firstDue);
      timer = setTimeout(() => flush(false,!immediate).catch(() => {}), immediate ? 0 : Math.max(0,nextDue - now));
    }
    function configure() {
      const prior = enabled, prefs = globalThis.AtriumPref;
      enabled = prefs?.get("general.autosave",true) !== false;
      const minutes = Number(prefs?.get("general.autosaveMinutes",5));
      interval = 60000 * Math.min(120,Math.max(1,Number.isFinite(minutes) ? minutes : 5));
      if (!enabled) { stop(); return; }
      if (prior === false) lastWrite = undefined;
      if (requested > completed) schedule();
    }
    function changed(immediate = false) {
      if (disposed) return;
      requested++;
      // An explicit project Save can retire this window’s covered rows while
      // automatic capture is off. Other dirty owners keep their previous bytes.
      if (immediate && !enabled && (own || pins.size)) flush(true).catch(() => {});
      else schedule(immediate);
    }
    configure();
    async function saveVersion(capturing, required, timing) {
      const capture = cursor(), before = new Map(own?.rows.map(r => [r.id,r]));
      const active = new Set(capture.rows.map(r => r.id));
      const changed = capturing ? capture.rows.filter(row => {
        const prior = before.get(row.id);
        return prior?.seq !== row.seq || prior.baseHash !== row.baseHash;
      }) : [];
      const fresh = changed.length ? await snapshot(changed,capture,own?.assets || []) : {rows:[],assets:[]};
      if (capturing && !enabled && !required) return false;
      if (!capture.current()) { if (!required && !disposed && !timer) changedLater(); return false; }
      for (const row of fresh.rows) {
        const {owner,deps,binaries,nativeCopy,...meta} = row;
        before.set(row.id, meta);
      }
      const rows = [...before.values()].filter(r => active.has(r.id) && !capture.covered?.(r.id,r.seq));
      const assets = [...new Set(rows.flatMap(r => r.originals || []))];
      let settings = capturing ? capture.settings : own?.settings;
      if (!capture.settings || settings && capture.covered?.(projectId,settings.seq)) settings = undefined;
      const head = rows.length || settings ? {version:VERSION,scope:key,writer,stamp:uuid(),projectId,
        rows,settings,assets,written:capturing ? Date.now() : own.written} : null;
      if ((own || head) && (capturing || rows.length !== before.size || (settings ?? undefined) !== (own?.settings ?? undefined))) {
        timing?.ready();
        try { await store.write(key,writer,own?.stamp,head,fresh.rows,fresh.assets); }
        catch (e) {
          if (e.code !== "draft-removed") throw e;
          // A different window explicitly retired our reviewed version. Its next edit needs all
          // private rows and originals again; do not build a partial version from the old index.
          own = undefined;
          if (head) return saveVersion(capturing, required, timing);
        }
        own = head; writes++;
        if (!head) lastWrite = undefined;
        else if (capturing) lastWrite = Date.now();
      }
      // A recovered source stays available until a durable Save acknowledged its entire edit.
      for (const [source,accepted] of pins) if (accepted()) {
        await store.write(key,source.writer,source.stamp,null).catch(() => {});
        pins.delete(source);
      }
      return true;
    }
    const changedLater = () => changed(true);
    function flush(afterSave = false, periodic = false, required = false) {
      stop();
      const target = requested;
      queue = queue.catch(() => {}).then(async () => {
        const capturing = enabled || required;
        if ((!capturing && !afterSave) || target <= completed) return;
        // Another pending checkpoint may have finished while this timer waited for storage.
        if (periodic && lastWrite !== undefined && Date.now() < lastWrite + interval) {
          schedule();
          return;
        }
        const timing = globalThis.AtriumDiagnostics?.performance?.begin("autosave","save");
        let outcome = "failed";
        try {
          const stored = await saveVersion(capturing, required, timing) || required && await saveVersion(true, true, timing);
          if (required && !stored) throw Error("The saved project changed before the detached edit could be kept in recovery.");
          if (stored) {
            if (capturing) completed = target;
            failure = null;
          }
          outcome = stored ? "completed" : "cancelled";
        }
        catch (e) {
          if (e?.name === "AbortError") outcome = "cancelled";
          const detail = "Private draft could not be saved. Your changes are still open. " + message(e);
          if (failure !== detail) diagnose(detail);
          failure = detail; throw e;
        } finally { timing?.end(outcome); }
      });
      return queue;
    }
    async function list() {
      const heads = (await store.list(key)).filter(h => h.writer !== writer);
      const result = [];
      for (const h of heads) {
        if (h.version !== VERSION) { result.push({head:h,state:"unsupported"}); continue; }
        const state = await classify(h);
        if (state !== "saved") result.push({head:h,state});
      }
      return result;
    }
    async function decide(offer,choice) {
      if (disposed || offer?.head?.scope !== key || offer.head.writer === writer) throw Error("This draft belongs to another project.");
      if (choice === "keep") return;
      if (choice === "discard") return store.write(key,offer.head.writer,offer.head.stamp,null);
      if (offer.head.version !== VERSION) throw Error("This draft requires a newer Waffle version.");
      const timing = globalThis.AtriumDiagnostics?.performance?.begin("project","load");
      let outcome = "failed";
      try {
        const bundle = await store.read(offer.head), state = await classify(bundle.header);
        if (disposed || state === "saved" || choice !== "separate" && state !== "matches") {
          outcome = "cancelled";
          throw Error("The saved or working document changed. Review the draft separately.");
        }
        const acknowledged = await restore(bundle,choice === "separate");
        if (acknowledged) pins.set(bundle.header,acknowledged);
        timing?.ready();
        outcome = "completed";
      } catch (e) {
        if (e?.name === "AbortError") outcome = "cancelled";
        throw e;
      } finally { timing?.end(outcome); }
    }
    return {changed,configure,flush,checkpoint:() => flush(false,false,true),list,decide, async close() { stop(); try { await flush(); } finally { disposed=true; stop(); } },
      metrics:() => ({writes,pending:!!timer,error:failure})};
  }
  const base64 = globalThis.AtriumBase64.encode;
  return Object.freeze({bind,storage,base64,version:VERSION,foreignScope:"foreign-import-v1"});
})();
