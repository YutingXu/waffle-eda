"use strict";
// AtriumAutosave: autosave and crash recovery (v2). Its design notes and API are at the top of
// recover.js (lazy), which keeps them out of the eager startup bytes.
globalThis.AtriumAutosave = (() => {
  const DBNAME = "waffle-editor-drafts", INDEX = "waffle-editor-drafts-v1", LSDATA = INDEX + ":";
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const KEEP = 5, MAX_PER_SLOT = 20, MAX_SLOTS = 30, HEAD_MS = MIN, DEBOUNCE = 1500, MAX_WAIT = 20000, LS_MAX = 1500000, BEAT = 15000;
  const CHUNK = 2000, SLICE_MS = 5, PART = 524288;
  const TIERS = [[2 * HOUR, 10 * MIN], [2 * DAY, 2 * HOUR], [14 * DAY, DAY]];

  // Snapshots to keep for one slot: newest first, KEEP recent ones, then one per tier bucket.
  function retain(list, now) {
    const sorted = [...list].sort((a, b) => b.ts - a.ts), keep = [], used = new Set();
    for (const m of sorted) {
      const age = now - m.ts, tier = TIERS.findIndex(([limit]) => age < limit), bucket = tier < 0 ? null : tier + ":" + Math.floor(m.ts / TIERS[tier][1]);
      if (keep.length < KEEP) { keep.push(m); if (bucket) used.add(bucket); continue; }
      if (!bucket || used.has(bucket) || keep.length >= MAX_PER_SLOT) continue;
      used.add(bucket); keep.push(m);
    }
    for (const m of sorted) if (m.keep > now && !keep.includes(m)) keep.push(m); // pinned until m.keep
    return keep;
  }
  // Serialisation in small steps: the concatenated results of plan(p)'s tasks equal
  // JSON.stringify(p). The project, its documents and each document's fields are split by key;
  // arrays longer than CHUNK (a board's items, the library) by CHUNK elements.
  function plan(root) {
    const tasks = [], put = t => tasks.push(t), skip = x => x === undefined || typeof x === "function" || typeof x === "symbol";
    function value(v, depth) {
      if (Array.isArray(v)) {
        if (v.length > CHUNK) {
          put(() => "[");
          for (let a = 0; a < v.length; a += CHUNK) { const b = a + CHUNK, first = a === 0; put(() => (first ? "" : ",") + JSON.stringify(v.slice(a, b)).slice(1, -1)); }
          put(() => "]"); return;
        }
        if (depth <= 1 && v.some(x => x && typeof x === "object")) {
          put(() => "[");
          v.forEach((x, i) => { if (i) put(() => ","); if (skip(x)) put(() => "null"); else value(x, depth + 1); });
          put(() => "]"); return;
        }
      } else if (v && typeof v === "object" && typeof v.toJSON !== "function" && depth <= 2) {
        const keys = Object.keys(v).filter(k => !skip(v[k]));
        put(() => "{");
        keys.forEach((k, i) => { put(() => (i ? "," : "") + JSON.stringify(k) + ":"); value(v[k], depth + 1); });
        put(() => "}"); return;
      }
      put(() => JSON.stringify(v));
    }
    value(root, 0);
    return tasks;
  }
  // What to do at startup: {action:"prompt"|"reopen"|"none", slot, unclean, snapshots}.
  // `held` lists sessions still running in other windows (Web Locks); without it a session whose
  // heartbeat is under 2 × BEAT old counts as running.
  function decide(index, metas, now, self, held = null) {
    const sessions = Object.entries(index.sessions || {}).filter(([id]) => id !== self).map(([id, s]) => ({id, ...s}));
    const running = s => !s.clean && (held ? held.has(s.id) : now - (s.beat || 0) < 2 * BEAT);
    const live = sessions.filter(running);
    const crashed = sessions.filter(s => !s.clean && !running(s) && s.slot).sort((a, b) => (b.beat || 0) - (a.beat || 0))[0];
    const unclean = !!crashed, slot = crashed?.slot || index.last?.slot;
    const none = {action: "none", slot: null, unclean, snapshots: []};
    if (!slot || live.some(s => s.slot === slot)) return none;
    const snapshots = metas.filter(m => m.slot === slot).sort((a, b) => b.ts - a.ts);
    if (!snapshots.length || wasDismissed(index, snapshots[0].id)) return none;
    return {action: unclean || snapshots[0].dirty ? "prompt" : "reopen", slot, unclean, snapshots};
  }
  const dismissals = index => Array.isArray(index.dismissedSnapshots) ? index.dismissedSnapshots : index.dismissed ? [index.dismissed] : [];
  const wasDismissed = (index, id) => dismissals(index).includes(id);
  function decideRestart(index, metas, session) {
    const activeSlot = session && index.sessions?.[session]?.slot;
    const own = session ? metas.filter(m => m.session === session).sort((a,b) => b.ts - a.ts) : [];
    const slot = activeSlot || own[0]?.slot || null;
    const snapshots = own.filter(m => m.slot === slot);
    const dismissed = !!snapshots.length && wasDismissed(index, snapshots[0].id), prompt = !!snapshots.length && !dismissed;
    return {action: prompt ? "prompt" : "none", slot, unclean: true, restarted: true, dismissed, snapshots: prompt ? snapshots : []};
  }
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";
  function fmtTime(ts, now = Date.now()) {
    const d = new Date(ts), age = now - ts, clock = d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
    if (age < MIN) return "just now · " + clock;
    if (age < HOUR) return Math.round(age / MIN) + " min ago · " + clock;
    return d.toLocaleDateString([], {month: "short", day: "numeric", year: new Date(now).getFullYear() === d.getFullYear() ? undefined : "numeric"}) + " " + clock;
  }
  const REASONS = {auto: "autosave", exit: "on close", saved: "after save", open: "on open", hidden: "autosave"};

  function create(env = {}) {
    const G = globalThis, now = env.now || (() => Date.now()), perf = () => G.performance?.now?.() ?? Date.now();
    const pref = (k, d) => (env.prefs || G.AtriumPref)?.get?.(k, d) ?? d; // Preferences: general.autosave, general.autosaveMinutes
    const idle = env.schedule || (cb => (G.AtriumIdle ? G.AtriumIdle.idle(cb, {timeout: 2000}) : G.requestIdleCallback ? G.requestIdleCallback(cb, {timeout: 2000}) : setTimeout(cb, 1)));
    const ls = "localStorage" in env ? env.localStorage : (() => { try { return G.localStorage || null; } catch { return null; } })();
    const idbFactory = "indexedDB" in env ? env.indexedDB : (() => { try { return G.indexedDB || null; } catch { return null; } })();
    const SESSION = now().toString(36) + Math.random().toString(36).slice(2, 7);
    const openingFileAtLaunch = !!G.__atriumOpeningProject;
    const restart = G.__atriumRendererRestart || null;
    let writing = null, writingKeys = new Set(), chunked = null, urgentFollowup = null, host = null, timer = 0, firstChange = 0, slot = null, anchor = null, head = null, saving = null, again = false, warned = "";
    let detachedCount = 0, saves = 0;
    let recentCache = [], backend = idbFactory ? "indexeddb" : ls ? "localStorage" : "none";
    const stats = {saves: 0, serializeMs: 0, writeMs: 0, mainThreadMs: 0, maxMainThreadMs: 0, bytes: 0, written: 0, at: 0, error: ""};
    // The incremental serialiser (save-cache.js), or null: the JSON.stringify path below.
    async function serializer() {
      if ("serializer" in env) return env.serializer;
      if (G.AtriumSaveCache) return G.AtriumSaveCache;
      try { return G.AtriumIO?.serializer ? await G.AtriumIO.serializer() : null; } catch { return null; }
    }

    // ---- session index (small, synchronous) -------------------------------------------------
    const readIndex = () => { try { const v = JSON.parse(ls?.getItem(INDEX) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
    const writeIndex = v => { try { ls?.setItem(INDEX, JSON.stringify(v)); } catch { /* reported by saves */ } };
    const previous = readIndex();
    function touch(fields) { const v = readIndex(); v.sessions ||= {}; v.sessions[SESSION] = {...(v.sessions[SESSION] || {started: now()}), beat: now(), ...fields}; writeIndex(v); return v; }

    // ---- storage --------------------------------------------------------------------------
    let dbp = null;
    function db() {
      if (!idbFactory) return Promise.reject(Error("IndexedDB is unavailable."));
      return dbp ||= new Promise((resolve, reject) => {
        let r;
        try { r = idbFactory.open(DBNAME, 1); } catch (e) { reject(e); return; }
        r.onupgradeneeded = () => { const d = r.result; for (const [n, k] of [["meta", "id"], ["data", "id"], ["slots", "slot"]]) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, {keyPath: k}); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error || Error("IndexedDB did not open."));
        r.onblocked = () => reject(Error("IndexedDB is blocked by another window."));
      }).catch(e => { dbp = null; backend = ls ? "localStorage" : "none"; throw e; });
    }
    const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    function tx(stores, mode, body) {
      return db().then(d => new Promise((resolve, reject) => {
        const t = d.transaction(stores, mode); let out;
        t.oncomplete = () => resolve(out);
        t.onerror = t.onabort = () => reject(t.error || Error("Recovery storage failed."));
        try { out = body(t); } catch (e) { try { t.abort(); } catch { /* already finished */ } reject(e); }
      }));
    }
    // Fallback metadata lives in the index; data in one key per slot (latest snapshot only).
    const lsMetas = () => Object.values(readIndex().ls || {});
    async function allMetas() {
      if (backend !== "indexeddb") return lsMetas();
      try { return (await tx(["meta"], "readonly", t => req(t.objectStore("meta").getAll()))) || []; } catch { return lsMetas(); }
    }
    async function readData(id) {
      let meta = null, parts = [];
      if (backend === "indexeddb") {
        try {
          await tx(["meta", "data"], "readonly", t => {
            const row = t.objectStore("meta").get(id), data = t.objectStore("data");
            row.onsuccess = () => {
              meta = row.result;
              if (!meta) return;
              parts = partKeys(meta).map(key => data.get(key));
            };
          });
        } catch (e) { if (backend === "indexeddb") throw e; }
      }
      if (meta) {
        if (parts.length !== meta.parts || parts.some(part => typeof part.result?.text !== "string")) throw Error("That snapshot is incomplete.");
        return {meta, json: parts.map(part => part.result.text).join("")};
      }
      meta = lsMetas().find(m => m.id === id);
      if (meta) {
        const json = ls?.getItem(LSDATA + meta.slot);
        if (json != null) return {meta, json};
      }
      throw Error("That snapshot is no longer stored.");
    }
    // Data records of a snapshot: shared chunks (m.keys) or its own numbered parts.
    const partKeys = m => Array.isArray(m.keys) ? m.keys : Array.from({length: m.parts || 0}, (_, i) => m.data + "#" + i);
    async function removeIds(ids) {
      if (!ids.length) return;
      if (chunked && ids.includes(chunked.id)) chunked = null; // its chunks may be swept
      const lsIds = new Set(lsMetas().filter(m => ids.includes(m.id)).map(m => m.id));
      if (lsIds.size) { const v = readIndex(); for (const id of lsIds) { const m = v.ls[id]; try { ls.removeItem(LSDATA + m.slot); } catch { /* gone */ } delete v.ls[id]; } writeIndex(v); }
      if (backend !== "indexeddb") return;
      const want = new Set(ids), metas = (await allMetas()).filter(m => want.has(m.id));
      await tx(["meta", "data"], "readwrite", t => { for (const m of metas) { t.objectStore("meta").delete(m.id); if (!m.keys) for (const k of partKeys(m)) t.objectStore("data").delete(k); } });
      if (metas.some(m => m.keys)) await sweep();
    }
    // Parts no snapshot refers to (an interrupted write, a rewritten newest snapshot).
    async function sweep() {
      if (backend !== "indexeddb") return 0;
      let removed = 0;
      // Holding both stores in one transaction keeps a second window's newly committed chunks live.
      await tx(["meta", "data"], "readwrite", t => {
        const rows = t.objectStore("meta").getAll(), data = t.objectStore("data");
        rows.onsuccess = () => {
          const live = new Set();
          for (const m of rows.result) for (const k of partKeys(m)) live.add(k);
          const keys = data.getAllKeys();
          keys.onsuccess = () => {
            for (const key of keys.result) if (!live.has(key) && !writingKeys.has(key) && !(writing && String(key).startsWith(writing + "#"))) {
              data.delete(key); removed++;
            }
          };
        };
      });
      return removed;
    }
    async function prune(all) {
      const t = now(), bySlot = new Map();
      for (const m of all) { if (!bySlot.has(m.slot)) bySlot.set(m.slot, []); bySlot.get(m.slot).push(m); }
      const slots = [...bySlot.entries()].sort((a, b) => Math.max(...b[1].map(m => m.ts)) - Math.max(...a[1].map(m => m.ts)));
      const drop = [];
      slots.forEach(([s, list], i) => {
        if (i >= MAX_SLOTS && s !== slot) { drop.push(...list.map(m => m.id)); return; }
        const keep = new Set(retain(list, t).map(m => m.id));
        for (const m of list) if (!keep.has(m.id)) drop.push(m.id);
      });
      await removeIds(drop);
      await sweep();
      if (backend === "indexeddb" && slots.length > MAX_SLOTS) await tx(["slots"], "readwrite", st => { for (const [s] of slots.slice(MAX_SLOTS)) if (s !== slot) st.objectStore("slots").delete(s); });
      return drop.length;
    }
    // Free space after a quota error: other projects keep only their newest snapshot, this one two.
    async function emergencyPrune() {
      const all = await allMetas(), bySlot = new Map();
      for (const m of all) { if (!bySlot.has(m.slot)) bySlot.set(m.slot, []); bySlot.get(m.slot).push(m); }
      const drop = [];
      for (const [s, list] of bySlot) drop.push(...list.sort((a, b) => b.ts - a.ts).slice(s === slot ? 2 : 1).map(m => m.id));
      await removeIds(drop);
      await sweep();
      return drop.length;
    }
    async function refreshRecent() {
      try {
        if (backend === "indexeddb") recentCache = (await tx(["slots"], "readonly", t => req(t.objectStore("slots").getAll()))) || [];
        else { const by = new Map(); for (const m of lsMetas()) by.set(m.slot, {slot: m.slot, name: m.name, path: m.path, updated: m.ts, size: m.size, dirty: m.dirty, latest: m.id, kind:m.kind}); recentCache = [...by.values()]; }
        recentCache.sort((a, b) => b.updated - a.updated);
      } catch { recentCache = []; }
      return recentCache;
    }

    // ---- saving -------------------------------------------------------------------------------
    function slotFor(p) {
      if (slot && p.documents.some(d => d.id === anchor)) return slot;
      const first = p.documents[0]?.id || null;
      if (slot && !anchor && first) { anchor = first; return slot; }
      anchor = first; head = null;
      return slot = "doc:" + (anchor || p.name || "project");
    }
    const quota = e => /quota/i.test(String(e?.name) + " " + String(e?.message)) || e?.code === 22;
    function warn(kind, text) {
      stats.error = text;
      if (warned === kind) return;
      warned = kind;
      G.AtriumDiagnostics?.autosaveFailure(kind);
      host?.info?.(text);
      G.document && showWarning(text);
    }
    const pause = urgent => urgent ? null : new Promise(r => idle(r));
    // Serialise in slices of about SLICE_MS between idle periods. Returns null when the project
    // changed meanwhile (the snapshot would mix two states); urgent runs in one go.
    async function produce(p, urgent, cost) {
      const rev = host.revision?.(), tasks = plan(p), parts = [];
      let i = 0;
      while (i < tasks.length) {
        if (!urgent) { await pause(); if (host.revision?.() !== rev) return null; }
        const t0 = perf();
        while (i < tasks.length && (urgent || perf() - t0 < SLICE_MS)) parts.push(tasks[i++]());
        const d = perf() - t0; cost.serialize += d; cost.slice = Math.max(cost.slice, d);
      }
      // Storage records of about PART characters.
      const out = [];
      let cur = "";
      for (const x of parts) { cur += x; if (cur.length >= PART) { out.push(cur); cur = ""; } }
      if (cur || !out.length) out.push(cur);
      return out;
    }
    // The same in slices with the incremental serialiser: {state, chunks, fresh, text()} where
    // fresh lists the chunks no stored snapshot has yet (only those are written).
    async function produceChunks(S, p, urgent, cost, s, documentVersions) {
      const rev = host.revision?.();
      let t0 = perf();
      const j = S.job(p, {journal:true, documentVersions});
      for (;;) {
        const done = j.step(urgent ? Infinity : SLICE_MS), d = perf() - t0;
        cost.serialize += d; cost.slice = Math.max(cost.slice, d);
        if (done) break;
        await pause();
        if (host.revision?.() !== rev) return null;
        t0 = perf();
      }
      t0 = perf();
      const st = j.result(), list = S.chunks(st, chunked && chunked.slot === s ? chunked.value : null), fresh = [];
      for (const c of list.list) if (!c.key) { c.key = "c~" + now().toString(36) + Math.random().toString(36).slice(2, 10); fresh.push({id: c.key, text: S.chunkText(st, c)}); }
      cost.serialize += perf() - t0;
      return {state: st, chunks: list, fresh, keys: list.list.map(c => c.key), size: st.total, text: () => S.text(st)};
    }
    async function write(meta, parts, slotRec, urgent, cost) {
      const keyed = !Array.isArray(parts);
      if (backend === "indexeddb") {
        try {
          if (keyed) { meta.keys = parts.keys; meta.parts = parts.keys.length; meta.data = "chunks"; for (const x of parts.fresh) writingKeys.add(x.id); }
          else { meta.data = meta.id + "~" + meta.ts.toString(36) + Math.random().toString(36).slice(2, 6); meta.parts = parts.length; writing = meta.data; }
          const timed = (t, fn) => { const t0 = perf(); fn(); const d = perf() - t0; cost.write += d; cost.slice = Math.max(cost.slice, d); };
          // One transaction: the parts, the metadata that commits them and the removal of the parts
          // of the version they replace. Its synchronous cost is one structured clone of the text.
          const old = (await allMetas()).find(m => m.id === meta.id);
          await tx(["meta", "data", "slots"], "readwrite", t => timed(t, () => {
            if (keyed) for (const x of parts.fresh) t.objectStore("data").put(x);
            else parts.forEach((text, i) => t.objectStore("data").put({id: meta.data + "#" + i, text}));
            t.objectStore("meta").put(meta);
            t.objectStore("slots").put(slotRec);
            // Chunks are shared between snapshots: the sweep removes the ones nothing refers to.
            if (old && !old.keys && old.data !== meta.data) for (const k of partKeys(old)) t.objectStore("data").delete(k);
          }));
          cost.written = keyed ? parts.fresh.reduce((n, x) => n + x.text.length, 0) : parts.reduce((n, x) => n + x.length, 0);
          return;
        } catch (e) { if (!dbp && ls) return write(meta, parts, slotRec, urgent, cost); throw e; }
        finally { writing = null; if (keyed) for (const x of parts.fresh) writingKeys.delete(x.id); }
      }
      if (backend === "localStorage") {
        const json = keyed ? parts.text() : parts.join("");
        if (json.length > LS_MAX) { const e = Error("too large"); e.name = "QuotaExceededError"; e.large = true; throw e; }
        const t0 = perf();
        const m = {...meta, store: "localStorage", data: LSDATA + meta.slot, parts: 1}, v = readIndex();
        delete m.keys;
        v.ls ||= {};
        for (const [id, x] of Object.entries(v.ls)) if (x.slot === meta.slot) delete v.ls[id];
        v.ls[m.id] = m;
        ls.setItem(LSDATA + meta.slot, json);
        ls.setItem(INDEX, JSON.stringify(v));
        cost.write += perf() - t0; cost.written = json.length;
        return;
      }
      throw Error("This browser keeps no recovery storage.");
    }
    // urgent: serialise and write in one go (closing, saving or opening a file).
    async function save(reason = "auto", urgent = reason !== "auto", extra) { // extra: metadata such as {keep, label}
      if (!host || !host.project?.()?.documents) return null;
      const automatic = reason === "auto" || reason === "hidden";
      if (automatic && !pref("general.autosave", true)) return null;
      const folder = host.folderProject?.();
      if (folder) return folder.flushDrafts();
      if (host.importSession?.()) return G.AtriumForeignDrafts?.flush(host);
      if (host.isStarter?.()) return null;
      if (saving) {
        if (!urgent) { again = true; return saving; }
        // Close, Save As and other urgent callers need the checkpoint for the newly requested
        // state. A previously accepted write can still belong to the preceding file.
        if (!urgentFollowup) {
          const flush = () => { urgentFollowup = null; return save(reason, true, extra); };
          urgentFollowup = saving.then(flush, flush);
        }
        return urgentFollowup;
      }
      clearTimeout(timer); timer = 0; firstChange = 0;
      let timing = G.AtriumDiagnostics?.performance?.begin("autosave","save"), outcome = "failed";
      const run = (async () => {
        const cost = {serialize: 0, write: 0, slice: 0, written: 0};
        let parts = null, p = null, s = null, generation, revision, dirty, name, imported;
        const S = await serializer();
        for (let attempt = 0; !parts; attempt++) {
          // Loading the serializer or preparing an import can outlive File > Open or Save As.
          // A native folder projection contains only its visited owners.
          if (automatic && !pref("general.autosave", true)) { outcome = "cancelled"; return null; }
          const adopted = host.folderProject?.();
          if (adopted || host.importSession?.()) {
            timing?.end("cancelled"); timing = null;
            return adopted ? adopted.flushDrafts() : G.AtriumForeignDrafts?.flush(host);
          }
          p = host.project(); s = slotFor(p);
          generation = G.AtriumHost?.projectGeneration;
          revision = host.revision?.() ?? null; dirty = !!host.isDirty?.(); name = String(p.name || "Untitled");
          try {
            imported = G.AtriumImportReports?.needsProjection();
            const data = imported ? await G.AtriumImportReports.snapshot(p) : p;
            if (imported && (host.project() !== p || (host.revision?.() ?? null) !== revision)) continue;
            parts = S ? await produceChunks(S, data, urgent || attempt >= 2, cost, s, imported && G.AtriumImportReports.storageVersion) : await produce(data, urgent || attempt >= 2, cost);
          }
          catch (e) { warn("serialize", "Autosave couldn't serialise the project: " + e.message); return null; }
        }
        const keyed = !Array.isArray(parts), size = keyed ? parts.size : parts.reduce((n, x) => n + x.length, 0), ts = now();
        const reuse = head && head.slot === s && head.reason === "auto" && reason === "auto" && ts - head.created < HEAD_MS;
        const active = () => !host.folderProject?.() && host.project() === p && G.AtriumHost?.projectGeneration === generation;
        const kind = p.documents.length === 1 ? p.documents[0].kind : "project";
        const meta = {id: reuse ? head.id : s + "@" + ts + "-" + SESSION + "-" + ++saves, slot: s, ts, name, size, dirty,
          reason, revision, session: SESSION, kind, docs: p.documents.length, items: p.documents.reduce((n, d) => n + (d.items?.length || 0), 0), ...extra};
        const slotRec = {slot: s, name: meta.name, updated: ts, size, dirty: meta.dirty, latest: meta.id,kind};
        // The session names its project before the write, so a crash during it still finds the slot.
        const stillActive = active(), latest = host.project();
        const currentSlot = stillActive ? s : !host.folderProject?.() && latest?.documents ? slotFor(latest) : null;
        const v = touch({slot: currentSlot}); v.last = {slot: currentSlot, ts, dirty: stillActive ? meta.dirty : !!host.isDirty?.()};
        if (wasDismissed(v, meta.id)) { v.dismissedSnapshots = dismissals(v).filter(id => id !== meta.id); delete v.dismissed; }
        writeIndex(v);
        timing?.ready();
        try { await write(meta, parts, slotRec, urgent, cost); if (keyed) chunked = active() ? {slot: s, id: meta.id, value: parts.chunks} : null; }
        catch (e) {
          chunked = null;
          if (e?.large) { warn("large", "This project (" + fmtSize(size) + ") is too large for browser recovery storage. Save it to a file."); return null; }
          if (!quota(e) || extra?.keep) { warn("error", "Autosave failed: " + (e?.message || e) + ". Save the project to a file."); return null; }
          try { await emergencyPrune(); await write(meta, parts, slotRec, true, cost); }
          catch { warn("quota", "Recovery storage is full, so autosave is paused. Save the project to a file, or delete old snapshots in File › Recover…"); return null; }
        }
        timing?.end("completed"); timing = null;
        if (active()) head = reuse ? {...head, ts} : {id: meta.id, slot: s, reason, created: ts, ts};
        Object.assign(stats, {saves: stats.saves + 1, serializeMs: cost.serialize, writeMs: cost.write, mainThreadMs: cost.serialize + cost.write, longestSliceMs: cost.slice,
          parts: keyed ? parts.keys.length : parts.length, urgent, bytes: size, written: cost.written, fresh: keyed ? parts.fresh.length : parts.length, at: ts, error: ""});
        stats.maxMainThreadMs = Math.max(stats.maxMainThreadMs, stats.mainThreadMs);
        if (warned) { warned = ""; hideWarning(); }
        try { await prune(await allMetas()); } catch { /* pruning retries next save */ }
        await refreshRecent();
        return meta;
      })();
      saving = run;
      try { return await run; }
      catch (error) { if (error?.name === "AbortError") outcome = "cancelled"; throw error; }
      finally { timing?.end(outcome); saving = null; if (again) { again = false; schedule(); } }
    }
    function schedule() {
      if (host?.importSession?.()) { G.AtriumForeignDrafts?.schedule(host); return; }
      const p = host?.project?.(), before = slot;
      if (p?.documents && slotFor(p) !== before) touch({slot});
      if (pref("general.autosave", true) === false) return;
      const t = now();
      firstChange ||= t;
      clearTimeout(timer);
      // Efficiency mode (power.js) doubles the debounce: fewer snapshots in a burst of edits, MAX_WAIT unchanged.
      const quiet = G.AtriumPower?.delay?.(DEBOUNCE) ?? DEBOUNCE;
      timer = setTimeout(() => { timer = 0; idle(() => save("auto")); }, Math.max(0, Math.min(quiet, firstChange + MAX_WAIT - t)));
    }
    const flush = (reason = host?.isDirty?.() ? "exit" : "saved") => save(reason, true);
    function closed() { clearTimeout(timer); timer = 0; const v = touch({slot: null}); delete v.last; writeIndex(v); } // Close Project

    // ---- restoring ------------------------------------------------------------------------------
    async function projectFrom(json) {
      const invalid = () => Object.assign(Error("This snapshot could not be read as a Waffle project. Choose another snapshot if available."), {invalidSnapshot: true});
      let p;
      try { p = JSON.parse(json); } catch { throw invalid(); }
      if (!Array.isArray(p?.documents) || !p.documents.length || p.documents.some(d => !d || typeof d !== "object")) throw invalid();
      const L = G.AtriumLazy;
      if (L) await L.need(L.validatorsFor(p));
      try { return G.Atrium?.validate ? G.Atrium.validate(p) : p; } catch { throw invalid(); }
    }
    function detach(p) { slot = "copy:" + SESSION + "-" + (++detachedCount); anchor = p.documents[0]?.id || null; head = null; }
    async function restore(id, {copy = false, force = false, atLaunch = false, current} = {}) {
      const timing = G.AtriumDiagnostics?.performance?.begin("project","load");
      let outcome = "failed";
      try {
        const {meta, json} = await readData(id), p = await projectFrom(json);
        if (copy) p.name = String(p.name || "Untitled") + " (recovered)";
        if (!host?.replaceProject) throw Error("This editor build can't restore projects.");
        if (atLaunch && (G.__atriumOpeningProject || host.isStarter?.() === false) ||
            !await host.replaceProject(p, {copy, force, dirty: copy || meta.dirty, current})) {
          outcome = "cancelled";
          return false;
        }
        timing?.ready();
        if (copy) detach(p);
        else { slot = meta.slot; anchor = p.documents.some(d => "doc:" + d.id === meta.slot) ? meta.slot.slice(4) : p.documents[0]?.id || null; }
        const v = touch({slot}); v.last = {slot, ts: now(), dirty: copy || meta.dirty}; writeIndex(v);
        host.info?.((copy ? "Opened a copy of " : "Restored ") + meta.name + " from " + fmtTime(meta.ts, now()) + " (" + fmtSize(meta.size) + ")");
        outcome = "completed";
        return true;
      } catch (error) {
        if (error?.name === "AbortError") outcome = "cancelled";
        throw error;
      } finally { timing?.end(outcome); }
    }
    async function openRecent(s) {
      const rec = recentCache.find(r => r.slot === s) || (await refreshRecent()).find(r => r.slot === s);
      const list = (await allMetas()).filter(m => m.slot === s).sort((a, b) => b.ts - a.ts);
      const id = list[0]?.id || rec?.latest;
      if (!id) throw Error("That project is no longer in recovery storage.");
      return restore(id);
    }
    // Each editor window holds a Web Lock named after its session until it closes or crashes.
    const LOCK = "waffle-editor-draft-session:", locks = "locks" in env ? env.locks : G.navigator?.locks;
    async function heldSessions() {
      if (!locks?.query) return null;
      try { const q = await locks.query(); return new Set((q.held || []).map(l => l.name).filter(n => n?.startsWith(LOCK)).map(n => n.slice(LOCK.length))); } catch { return null; }
    }
    // Preferences waits for the same startup recovery that attach() schedules. An
    // explicit document opened during that work takes precedence over the last session.
    let startup;
    function boot() { return startup ||= recoverAtLaunch(); }
    function launchHome(open) {
      const current = () => G.document?.body && !G.__atriumOpeningProject && pref("general.startPage", "auto") !== "never" &&
        (pref("general.startPage", "auto") !== "auto" || host?.isStarter?.() !== false);
      if (!current()) return;
      const show = plan => {
        if (plan?.openingFile || !current()) return;
        const prompt = G.document.querySelector("dialog[open]");
        if (prompt) prompt.addEventListener("close", () => show(plan), {once:true});
        else open();
      };
      boot().then(show, () => show());
    }
    async function recoverAtLaunch() {
      const explicitOpen = () => openingFileAtLaunch || G.__atriumOpeningProject;
      const loadingFile = {action: "none", slot: null, unclean: false, snapshots: [], openingFile: true};
      if (explicitOpen()) return loadingFile;
      if (G.document && host?.isStarter?.() !== false) {
        const heads=await foreignHeads();
        if (heads.length && !G.__atriumOpeningProject && host?.isStarter?.()!==false) {
          G.AtriumForeignDraftUI.prompt(heads,host);
          return {action:"foreign-drafts",snapshots:[],slot:null};
        }
      }
      if (explicitOpen()) return loadingFile;
      // Save prunes stored snapshots. Startup only reads those with a possible recovery
      // target; the recent-project and recovery browsers read their own records on demand.
      const sessions = Object.values(previous.sessions || {});
      const [all, held] = await Promise.all([
        restart || previous.last?.slot || sessions.some(session => session.slot) ? allMetas() : [],
        !restart && sessions.some(session => !session.clean) ? heldSessions() : null
      ]);
      if (explicitOpen()) return loadingFile;
      if (restart) {
        const plan = decideRestart(previous, all, restart.session);
        const v = readIndex();
        if (restart.session && v.sessions?.[restart.session]) { delete v.sessions[restart.session]; writeIndex(v); }
        if (host?.isStarter?.() !== false && !G.__atriumOpeningProject) {
          if (plan.action === "prompt") await openRecovery(plan);
          else if (!plan.dismissed) await openBrowser();
        }
        return plan;
      }
      const plan = decide(previous, all, now(), SESSION, held);
      const v = readIndex();
      // Sessions that ended (cleanly or not) are settled now; live ones in other windows stay.
      for (const [id, s] of Object.entries(v.sessions || {})) if (id !== SESSION && (s.clean || (held ? !held.has(id) : now() - (s.beat || 0) >= 2 * BEAT))) delete v.sessions[id];
      writeIndex(v);
      if (host?.isStarter?.() === false) return plan;
      if (plan.action === "prompt") await openRecovery(plan);
      else if (plan.action === "reopen") {
        try {
          if (await restore(plan.snapshots[0].id, {force: true, atLaunch: true})) {
            host.info?.("Reopened " + plan.snapshots[0].name + " (saved, " + fmtTime(plan.snapshots[0].ts, now()) + ")");
            G.dispatchEvent?.(new Event("atrium-recovery-restored"));
          }
        }
        catch (e) { host.info?.("Couldn't reopen the last project: " + e.message); }
      }
      return plan;
    }

    // ---- user interface (recover.js, loaded on first use) -------------------------------------
    const ui = options => G.AtriumRecover ? Promise.resolve(G.AtriumRecover) : G.AtriumLazy ? G.AtriumLazy.need("AtriumRecover",options) : Promise.reject(Error("The recovery dialogs are not loaded."));
    const shown = p => p.catch(e => { host?.info?.(e.message); return null; });
    const openRecovery = plan => G.document ? shown(ui().then(U => plan ? U.prompt(self, host, plan) : U.browser(self, host))) : Promise.resolve(null);
    function foreignHint() {
      try { for (let i=0;i<ls?.length;i++) if (ls.key(i)?.startsWith("waffle-foreign-draft:")) return true; return !ls; }
      catch { return true; }
    }
    async function foreignHeads() {
      if (!idbFactory || !G.AtriumLazy) return [];
      // Local storage can be cleared without removing IndexedDB. Inspect only its small
      // header index. Cold profiles never load the foreign converter or open source bodies.
      if (!foreignHint() && typeof idbFactory.databases==="function") {
        try { if (!(await idbFactory.databases()).some(db=>db.name==="waffle-folder-drafts")) return []; }
        catch { /* Some profiles can open their own databases but cannot enumerate them. */ }
      }
      const store=G.AtriumFolderDrafts || await G.AtriumLazy.need("AtriumFolderDrafts");
      const rows=await store.storage.list(store.foreignScope);
      if (!rows.length) return [];
      const manager=G.AtriumForeignDrafts || await G.AtriumLazy.need("AtriumForeignDrafts");
      return manager.available(host,rows);
    }
    const openBrowser = () => G.document ? shown(ui().then(U => U.browser(self, host))) : Promise.resolve(null);
    const openDiagnostics = () => G.document ? shown(ui({measure:false}).then(U => U.diagnostics(self, host))) : Promise.resolve(null);
    const showWarning = text => { if (G.document?.body) ui().then(U => U.warning(self, host, text), () => {}); };
    const hideWarning = () => G.AtriumRecover?.hideWarning();
    function dismiss(id) {
      const v = readIndex();
      v.dismissedSnapshots = [...dismissals(v).filter(other => other !== id), id].slice(-32);
      delete v.dismissed;
      writeIndex(v);
    }
    // ---- editor wiring --------------------------------------------------------------------------
    function attach(h) {
      if (host) return;
      host = h;
      touch({clean: false});
      G.AtriumHost?.startRecoverySession?.(SESSION);
      try { locks?.request?.(LOCK + SESSION, () => new Promise(() => {})).catch?.(() => {}); } catch { /* no Web Locks */ }
      // The heartbeat tells other windows this session runs. With Web Locks (the held session lock,
      // decide()) it is not needed for that: the beat is refreshed when the window is hidden
      // instead of a localStorage write every BEAT ms for the life of the window (energy.md).
      const lockLive = typeof locks?.request === "function" && typeof locks?.query === "function";
      if (!lockLive && typeof G.setInterval === "function") G.setInterval(() => touch({}), BEAT)?.unref?.();
      G.addEventListener?.("pagehide", () => { const v = touch({clean: true}); if (slot) v.last = {slot, ts: now(), dirty: !!host.isDirty?.()}; writeIndex(v); });
      G.addEventListener?.("pageshow", e => { if (e.persisted) touch({clean: false}); });
      G.document?.addEventListener?.("visibilitychange", () => { if (G.document.visibilityState !== "hidden") return; if (lockLive) touch({}); if (timer || host.importSession?.()) save("hidden", true).catch(e=>host.info?.(e.message)); });
      h.registerAction?.("recover", () => { openBrowser(); });
      h.registerAction?.("crash-diagnostics", () => { openDiagnostics(); });
      G.AtriumNavCommon?.menuItem?.("file", "save-as", "Save As…", {after: "save"});
      G.AtriumNavCommon?.menuItem?.("file", "recover", "Recover…", {after: "save-as"});
      // After first paint; the deadline keeps busy pages from postponing the prompt.
      const later = env.schedule || (cb => (G.AtriumIdle ? G.AtriumIdle.idle(cb, {timeout: 400}) : G.requestIdleCallback ? G.requestIdleCallback(cb, {timeout: 400}) : setTimeout(cb, 1)));
      later(() => boot().catch(e => host.info?.("Recovery storage: " + e.message)));
    }
    const self = {
      retain, decide, decideRestart, plan, fmtSize, fmtTime, schedule, flush, closed, save, detach, attach, boot, launchHome, restore, openRecent, openRecovery, openBrowser, dismiss,
      // Stable API: one snapshot's metadata and project text, whatever the storage layout (chunks
      // shared between snapshots, numbered parts, or localStorage). Rejects when it is gone.
      read: id => readData(id).then(({meta, json}) => ({meta, text: json})),
      foreignHeads, list: allMetas, remove: removeIds, recent: () => recentCache.filter(r => r.slot !== slot), refreshRecent, stats: () => ({...stats, backend, pending: !!timer}),
      slot: () => slot, session: SESSION, backend: () => backend, describe: m => [fmtTime(m.ts, now()), fmtSize(m.size), (m.items || 0).toLocaleString() + " objects",
        REASONS[m.reason] || m.label || m.reason, m.dirty ? "unsaved changes" : "saved"].join(" · "), fmtTimeNow: ts => fmtTime(ts, now())};
    return self;
  }

  // History panel and History tab share one slot filter and one reason title. list() is allMetas.
  async function recoverySnapshots(A) {
    const slot = A?.slot?.(), titles = {saved: "Saved", open: "Opened", exit: "On close", checkpoint: "Checkpoint", "before-restore": "Before shared restore", restored: "Shared restore"};
    const rows = [];
    for (const m of (await A?.list?.()) || []) if (!slot || m.slot === slot) rows.push({key: "snap:" + m.id, type: "snapshot", id: m.id, slot: m.slot, ts: m.ts, snapshot: m, reason: m.reason, title: titles[m.reason] || "Autosave", meta: A.describe ? A.describe(m) : "", saved: m.reason === "saved"});
    return rows;
  }

  const api = create();
  if (globalThis.document) globalThis.AtriumNavCommon?.ready?.(h => api.attach(h));
  return Object.freeze({...api, create, recoverySnapshots, constants: {KEEP, MAX_PER_SLOT, MAX_SLOTS, DEBOUNCE, MAX_WAIT, LS_MAX, HEAD_MS, TIERS, CHUNK, SLICE_MS, PART}});
})();
