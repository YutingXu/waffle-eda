"use strict";
// AtriumCollabLock: document locking and presence for shared folders (SMB/NFS, Dropbox,
// OneDrive, iCloud) and Git teams (docs/collaboration.md). Lazy; the
// editor prefetches it when idle. Nothing here talks to a network: the only shared medium is
// the folder the project lives in.
//
// Lock sidecars. Beside "<name>.waffle" the native host keeps small JSON files
// "<name>.waffle.<key>.waffle-lock" (the only extra files it may write; ProjectWrites.swift,
// waffle.py, CollabLocks.cs). The host fills in its own machine id (random, generated once per
// machine), session id, process id and the write time; the page adds the display name from
// Preferences (never the OS account), the document and what it is doing.
//
//   d-<document id>   an edit lock, created with an atomic exclusive create and rewritten by its
//                     owner on a heartbeat. Stale when its heartbeat has not changed for STALE ms
//                     (seen from this machine, so clock skew between machines does not matter).
//   s-<session>       presence: which documents this window shows and the edit requests it makes.
//
// The adopted folder authorizes cooperative locks for its document IDs. The folder session
// watches and saves each owner independently, including external changes and conflict review.
//
//   AtriumCollabLock.create(env)            -> manager (DOM-free; tests drive it with a fake host)
//   AtriumCollabLock.merge(base, mine, theirs) -> {project, conflicts, theirs: [regions taken]}
//   AtriumCollabLock.parse(key, text, now)  -> record | null (lock text is untrusted)
//   AtriumCollabLock.docKey(id), .attach()  -> the app wiring (save, reload, document switches)
globalThis.AtriumCollabLock = (() => {
  const G = globalThis;
  const HEARTBEAT = 10000, STALE = 45000, FAR = 10 * 60000, POLL = 3000, ASK_TTL = 90000, IDLE_RELEASE = 120000;
  const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const PREF_NAME = "collab.displayName", PREF_ON = "collab.locking";
  const canon = v => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  };
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  // A short stable hash for ids that are not key-safe.
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }
  const docKey = id => { const s = String(id); return /^[A-Za-z0-9_-]{1,60}$/.test(s) ? "d-" + s : "d-h" + hash(s) + "-" + s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40); };
  const sessionKey = s => "s-" + String(s).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  // Display text from another machine: plain, short, no control or bidi-override characters.
  const text = (v, n = 64) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim().slice(0, n) : "";
  const num = v => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const sameStamp = (a, b) => !!a && !!b && a.size === b.size && a.modified === b.modified && (a.inode || 0) === (b.inode || 0);

  // A host-wrapped lock file: {"atrium-lock":1, machine, session, pid, written, data:{…}}.
  function parse(key, raw) {
    if (typeof key !== "string" || !KEY.test(key) || typeof raw !== "string" || raw.length > 16384) return null;
    let o; try { o = JSON.parse(raw); } catch { return null; }
    if (!isObj(o) || o["atrium-lock"] !== 1 || !isObj(o.data)) return null;
    const d = o.data, kind = key.startsWith("d-") ? "edit" : key.startsWith("s-") ? "presence" : null;
    if (!kind) return null;
    const rec = {key, kind, machine: text(o.machine, 80), session: text(o.session, 80), pid: num(o.pid), written: num(o.written),
      name: text(d.name) || "Someone", doc: text(d.doc, 128), docName: text(d.docName, 120), started: num(d.started), activity: text(d.activity, 80),
      viewing: Array.isArray(d.viewing) ? d.viewing.slice(0, 64).map(v => text(v, 128)).filter(Boolean) : [],
      asks: Array.isArray(d.asks) ? d.asks.slice(0, 16).filter(isObj).map(a => ({doc: text(a.doc, 128), at: num(a.at)})).filter(a => a.doc) : [],
      grant: isObj(d.grant) ? {doc: text(d.grant.doc, 128), to: text(d.grant.to, 80), at: num(d.grant.at)} : null};
    if (kind === "edit" && (!rec.doc || docKey(rec.doc) !== key)) return null;
    return rec;
  }

  // ------------------------------------------------------------------ three-way region merge
  function pick(b, m, t) {
    const cm = canon(m), ct = canon(t);
    if (cm === ct) return {v: m};
    const cb = canon(b);
    if (cb === cm) return {v: t, theirs: true};
    if (cb === ct) return {v: m};
    return {conflict: true};
  }
  function keyed(base = [], mine = [], theirs = [], region, conflicts, taken, label, owners = null) {
    const B = new Map(base.map(o => [o.id, o])), M = new Map(mine.map(o => [o.id, o])), T = new Map(theirs.map(o => [o.id, o]));
    const result = new Map();
    for (const id of new Set([...B.keys(), ...M.keys(), ...T.keys()])) {
      // A document's lock decides it: the holder's version wins (derived data, such as live
      // pours recomputed in a read-only window, never makes a conflict).
      const own = owners?.(id);
      const r = own === "mine" ? {v: M.get(id)} : own === "theirs" ? {v: T.get(id), theirs: canon(T.get(id)) !== canon(M.get(id))} : pick(B.get(id), M.get(id), T.get(id));
      if (r.conflict) { conflicts.push({region, id, name: label(M.get(id) || T.get(id) || B.get(id))}); result.set(id, M.get(id)); continue; }
      if (r.theirs) taken.push({region, id, name: label(T.get(id) || B.get(id))});
      if (r.v !== undefined) result.set(id, r.v);
    }
    // Their order, then this side's new objects after their predecessor in this side's order.
    const out = theirs.filter(o => result.has(o.id)).map(o => result.get(o.id)), placed = new Set(out.map(o => o.id));
    mine.forEach((o, i) => {
      if (placed.has(o.id) || !result.has(o.id)) return;
      let at = 0;
      for (let k = i - 1; k >= 0; k--) { const j = out.findIndex(x => x.id === mine[k].id); if (j >= 0) { at = j + 1; break; } }
      out.splice(at, 0, result.get(o.id)); placed.add(o.id);
    });
    return out;
  }
  // o.owner(docId) -> "mine" (this window holds its lock), "theirs" (someone else does) or null.
  function merge(base, mine, theirs, o = {}) {
    const conflicts = [], taken = [], out = {};
    for (const k of new Set([...Object.keys(base || {}), ...Object.keys(mine), ...Object.keys(theirs)])) {
      if (k === "documents" || k === "library" || k === "review") continue;
      const r = pick(base?.[k], mine[k], theirs[k]);
      if (r.conflict) { conflicts.push({region: "project", id: k, name: k}); out[k] = mine[k]; }
      else { if (r.theirs) taken.push({region: "project", id: k, name: k}); if (r.v !== undefined) out[k] = r.v; }
    }
    out.library = keyed(base?.library, mine.library, theirs.library, "library", conflicts, taken, d => d?.name || "Library part");
    out.documents = keyed(base?.documents, mine.documents, theirs.documents, "document", conflicts, taken, d => d?.name || "Document", o.owner);
    // Review comments: records by id (review-comments.js keeps them as a keyed map).
    const rb = base?.review, rm = mine.review, rt = theirs.review;
    if (rm !== undefined || rt !== undefined) {
      const recs = o => isObj(o?.records) ? Object.entries(o.records).map(([id, v]) => ({id, v})) : [];
      if ((rm === undefined || isObj(rm?.records)) && (rt === undefined || isObj(rt?.records))) {
        const list = keyed(recs(rb), recs(rm), recs(rt), "comment", conflicts, taken, () => "Comment");
        const rest = pick({...rb, records: 0}, {...rm, records: 0}, {...rt, records: 0});
        out.review = {...(rest.conflict ? rm : rest.v), records: Object.fromEntries(list.map(x => [x.id, x.v]))};
        if (!list.length && rm === undefined && rt === undefined) delete out.review;
      } else {
        const r = pick(rb, rm, rt);
        if (r.conflict) conflicts.push({region: "project", id: "review", name: "Comments"}); else if (r.v !== undefined) out.review = r.v;
      }
    }
    return {project: out, conflicts, theirs: taken};
  }

  // ------------------------------------------------------------------ lock manager
  // env: {host: {list(), write(key, data, mode), remove(key, force)}, now(), name(), current(),
  //       open(): document ids shown, docName(id), changed(id): unsaved edits in that document}
  function create(env) {
    const now = env.now || (() => Date.now());
    const listeners = new Set();
    let session = null, machine = null, records = [], project = null, timer = 0, lastBeat = 0, stopped = false, busy = null;
    let lastSig = "", changedNow = true;   // the listing changed since the last poll was scheduled
    const seen = new Map();          // key -> {written, at}: heartbeat observations on this machine
    const held = new Map();          // doc id -> {started, lastShown}
    const asks = new Map();          // doc id -> time this window asked for it
    const lost = new Set();          // documents whose lock someone took over
    let grant = null;                // {doc, to, at}: a hand-over this window offered
    const emit = why => { for (const f of [...listeners]) try { f(why); } catch (e) { G.console?.error?.(e); } };

    function observe(rec) {
      const s = seen.get(rec.key);
      if (!s || s.written !== rec.written) seen.set(rec.key, {written: rec.written, at: now()});
    }
    // Stale: the heartbeat has not moved for STALE ms here, or it is very old by the host clock.
    function stale(rec) {
      if (!rec) return false;
      const s = seen.get(rec.key);
      return (s && now() - s.at > STALE) || (listingNow && rec.written && listingNow - rec.written > FAR);
    }
    let listingNow = 0;
    const others = () => records.filter(r => r.session !== session);
    const lockOf = id => records.find(r => r.kind === "edit" && r.key === docKey(id)) || null;
    function owner(id) { const r = lockOf(id); return r && r.session !== session ? r : null; }

    async function refresh() {
      if (stopped) return false;
      const r = await env.host.list();
      if (stopped || !r || !Array.isArray(r.locks)) return false;
      session = text(r.session, 80) || session; machine = text(r.machine, 80) || machine; listingNow = num(r.now);
      const prev = project;
      project = isObj(r.project) ? {size: num(r.project.size), modified: num(r.project.modified), inode: num(r.project.inode)} : null;
      records = r.locks.map(l => parse(l?.key, l?.text)).filter(Boolean);
      // Other sessions' records and the project file's stamp: this window's own heartbeats are not a change.
      const sig = JSON.stringify([others(), project]);
      if (sig !== lastSig) { lastSig = sig; changedNow = true; }
      records.forEach(observe);
      for (const k of [...seen.keys()]) if (!records.some(r => r.key === k)) seen.delete(k);
      // A lock this window held that now names another session was taken over.
      for (const [id, h] of [...held]) {
        if (h.pending) continue;
        const rec = lockOf(id);
        if (rec && rec.session !== session) { held.delete(id); lost.add(id); emit({type: "lost", doc: id, by: rec}); }
        else if (!rec && !stopped) { held.delete(id); emit({type: "lost", doc: id, by: null}); }
      }
      // An ask this window made: the owner released the lock, or handed it over.
      for (const [id, at] of [...asks]) {
        const o = owner(id);
        if (now() - at > ASK_TTL) asks.delete(id);
        else if (!o || (o.grant?.doc === id && o.grant.to === session)) { asks.delete(id); emit({type: "granted", doc: id, by: o}); }
      }
      if (prev && project && !sameStamp(prev, project)) emit({type: "disk", project, prev});
      emit({type: "state"});
      return true;
    }
    const data = (kind, extra = {}) => ({kind, name: env.name() || "Someone", ...extra});
    function presence() {
      const mine = [...asks].filter(([, at]) => now() - at <= ASK_TTL).map(([doc, at]) => ({doc, at}));
      return data("presence", {viewing: env.open().slice(0, 64), asks: mine, ...(grant && now() - grant.at < ASK_TTL ? {grant} : {})});
    }
    async function writePresence() {
      const key = sessionKey(session || "pending");
      if (!session || stopped) return;
      const r = await env.host.write(key, presence(), "replace");
      if (!stopped && r?.missing) await env.host.write(key, presence(), "create");
    }
    const editData = id => data("edit", {doc: id, docName: env.docName(id) || "", started: held.get(id)?.started || now(), ...(grant?.doc === id ? {grant} : {})});

    // Take the edit lock for a document: "held", "locked" (someone else, fresh) or "stale".
    async function acquire(id, {takeover = false} = {}) {
      if (stopped) return {state: "closed"};
      if (held.has(id)) return {state: held.get(id).pending ? "pending" : "held"};
      if (!session) await refresh();
      if (stopped || !session) return {state: "closed"};
      const o = owner(id);
      if (o && !takeover) return {state: stale(o) ? "stale" : "locked", owner: o};
      const started = now();
      held.set(id, {started, lastShown: started, pending: true});
      let r;
      try { r = await env.host.write(docKey(id), editData(id), o || takeover ? "takeover" : "create"); }
      catch (e) { held.delete(id); throw e; }
      if (stopped) return {state: "closed"};
      if (held.has(id)) held.get(id).pending = false;
      if (!r?.written) {
        held.delete(id);
        await refresh();
        const now2 = owner(id);
        return {state: now2 ? (stale(now2) ? "stale" : "locked") : "free", owner: now2};
      }
      lost.delete(id); asks.delete(id);
      await refresh();
      return {state: "held"};
    }
    async function release(id) {
      if (!held.has(id)) return false;
      held.delete(id);
      if (grant?.doc === id) grant = null;
      await env.host.remove(docKey(id), false);
      await refresh();
      return true;
    }
    async function ask(id) { asks.set(id, now()); await writePresence(); emit({type: "state"}); }
    // Hand a document to the session that asked: the grant is published, then the lock released.
    async function handOver(id, to) {
      if (stopped || !held.has(id)) return false;
      grant = {doc: id, to, at: now()};
      if (held.has(id)) await env.host.write(docKey(id), editData(id), "replace");
      await writePresence();
      return release(id);
    }
    // Heartbeat: rewrite held locks and presence; release idle, unchanged documents.
    async function beat() {
      if (stopped) return;
      lastBeat = now();
      const open = new Set(env.open());
      for (const [id, h] of [...held]) {
        if (stopped) return;
        if (open.has(id)) h.lastShown = now();
        else if (now() - h.lastShown > IDLE_RELEASE && !env.changed(id)) { await release(id); continue; }
        const r = await env.host.write(docKey(id), editData(id), "replace");
        if (r && !r.written) { held.delete(id); lost.add(id); emit({type: "lost", doc: id, by: owner(id)}); }
      }
      await writePresence();
    }
    // One poll: list the sidecars, and every HEARTBEAT write ours.
    function tick() {
      if (busy) return busy;
      busy = (async () => {
        try { if (await refresh() && now() - lastBeat >= HEARTBEAT) await beat(); }
        catch (e) { emit({type: "error", error: e}); }
        finally { busy = null; }
      })();
      return busy;
    }
    // Polling: every POLL ms while someone else is here or something just
    // changed; with nothing changing and nobody else, the wait doubles up to HEARTBEAT (each tick
    // also writes the heartbeat on time). The same longest wait while the window is hidden or
    // Efficiency mode is on. wake() (the window shown again, a host file event) polls at once.
    let wait = POLL;
    function next() {
      if (stopped || env.schedule === false || typeof G.setTimeout !== "function") return;
      if (timer) G.clearTimeout(timer);
      const quiet = !others().length && !asks.size && !changedNow;
      wait = !quiet ? POLL : Math.min(HEARTBEAT, wait * 2);
      let idle = false;
      try { idle = !!G.AtriumPower?.idle?.(); } catch { idle = false; }
      const due = Math.max(250, Math.min(idle ? HEARTBEAT : wait, lastBeat + HEARTBEAT - now()));
      changedNow = false;
      timer = G.setTimeout(() => { timer = 0; Promise.resolve(tick()).then(next, next); }, due);
    }
    function wake() { if (stopped || env.schedule === false) return; if (timer) G.clearTimeout(timer); timer = 0; Promise.resolve(tick()).then(next, next); }
    function start() { stopped = false; const t = tick(); if (!timer && env.schedule !== false) Promise.resolve(t).then(next, next); return t; }
    async function stop() {
      stopped = true; if (timer) G.clearTimeout(timer); timer = 0;
      for (const id of [...held.keys()]) { held.delete(id); try { await env.host.remove(docKey(id), false); } catch { /* best effort */ } }
      if (session) try { await env.host.remove(sessionKey(session), false); } catch { /* best effort */ }
    }
    // Who else is here, per document: the editor (lock owner) and the viewers (presence).
    function docState(id) {
      const o = owner(id);
      const viewers = others().filter(r => r.kind === "presence" && r.viewing.includes(id) && !stale(r));
      const askers = held.has(id) ? others().filter(r => r.kind === "presence" && !stale(r) && r.asks.some(a => a.doc === id && now() - a.at <= ASK_TTL)) : [];
      return {held: held.has(id) && !held.get(id).pending, owner: o, stale: !!o && stale(o), viewers, askers, asked: asks.has(id), lost: lost.has(id)};
    }
    // Edits to a document someone else holds a fresh lock on are refused.
    const blocked = id => { const o = owner(id); return !!o && !stale(o) && (!held.has(id) || held.get(id).pending); };
    const people = () => {
      const by = new Map();
      for (const r of others()) { if (stale(r)) continue; const p = by.get(r.session) || {session: r.session, name: r.name, machine: r.machine, editing: [], viewing: []}; if (r.kind === "edit") p.editing.push(r.doc); else { p.name = r.name; p.viewing = r.viewing; } by.set(r.session, p); }
      return [...by.values()];
    };
    return {refresh, tick, wake, start, stop, acquire, release, ask, handOver, beat, docState, blocked, owner, people, stale,
      on(f) { listeners.add(f); return () => listeners.delete(f); },
      held: () => [...held.keys()], session: () => session, machine: () => machine, project: () => project, records: () => records};
  }

  // ------------------------------------------------------------------ app wiring
  let nav = null, binding = null, stopping = Promise.resolve(), ro = null, reverting = false;
  const pref = (k, d) => { try { return G.AtriumPref?.get?.(k, d) ?? d; } catch { return d; } };
  const enabled = () => pref(PREF_ON, true) !== false;
  const host = () => G.AtriumHost;
  const name = () => text(pref(PREF_NAME, "")) || "Someone";
  function folder() {
    const session = nav?.folderProject?.();
    return session?.grant && !session.temporary && session.grant === host()?.folderGitGrant ? session : null;
  }
  function current(entry) {
    return !!entry && entry.host === host() && entry.folder === folder() && entry.generation === entry.host.projectGeneration;
  }
  const manager = () => current(binding) && !binding.folder.readOnly && enabled() ? binding.manager : null;
  const shown = () => [...new Set([nav?.currentId?.(), ...(nav?.panes?.() || []).map(p => p.docId)].filter(Boolean))];
  const say = (message, kind) => {
    try { G.AtriumNavCommon?.toast?.(message, {kind, ms: 4200}); } catch { /* no DOM */ }
    nav?.info?.(message);
  };
  const extra = new Set();
  const emit = event => { for (const f of [...extra]) try { f(event); } catch (e) { G.console?.error?.(e); } };

  // Refresh a locked owner's rollback snapshot only when the folder installs its saved bytes.
  function roSync() {
    const id = nav?.currentId?.(), doc = nav?.docById?.(id);
    ro = doc && manager()?.blocked(id) ? {id, text: JSON.stringify(doc)} : null;
  }
  function backstop() {
    if (reverting) return;
    const id = nav?.currentId?.(), doc = nav?.docById?.(id);
    if (!doc || !manager()?.blocked(id)) { ro = null; return; }
    if (!ro || ro.id !== id) { roSync(); return; }
    if (JSON.stringify(doc) === ro.text) return;
    reverting = true;
    try {
      const saved = JSON.parse(ro.text);
      for (const key of Object.keys(doc)) delete doc[key];
      Object.assign(doc, saved);
      nav.derive?.(() => {}, {source:"collaboration-lock"});
    } finally { reverting = false; }
    guard(id);
  }
  function guard(id) {
    const m = manager();
    if (!m?.blocked(id)) return false;
    say((m.owner(id)?.name || "Someone") + " is editing " + (nav.docById?.(id)?.name || "this document") +
      ". It is read-only here. Use Ask to Edit.", "warning");
    emit({type:"blocked", doc:id});
    return true;
  }
  async function take(id, options, m = manager()) {
    const session = folder();
    if (!m || m !== manager() || !id || session.canEdit?.(id) === false) return null;
    try {
      const result = await m.acquire(id, options);
      if (m !== manager()) return null;
      emit({type:"doc", doc:id, result});
      return result;
    } catch (error) {
      if (m === manager() && error.name !== "AbortError") say("Could not lock the document. " + error.message, "error");
      return null;
    }
  }
  function takeShown() {
    roSync();
    for (const id of shown()) take(id);
  }
  async function synchronize(id, m = manager()) {
    const session = folder(), ref = session?.getDocumentRef?.(id);
    if (ref?.path && m && m === manager()) await session.synchronize([ref.path]);
  }
  async function beforeSave(session, ids) {
    const m = manager();
    if (!m || session !== folder() || !ids.size) return;
    // An unavailable share can still use the folder transaction's own stale-write checks.
    try { await m.refresh(); } catch (error) { if (error.name === "AbortError") throw error; }
    if (m !== manager()) throw new DOMException("The editing lock changed. Try saving again.", "AbortError");
    for (const id of ids) if (m.blocked(id))
      throw Error((m.owner(id)?.name || "Someone") + " holds the editing lock for " + (nav.docById?.(id)?.name || "this document") + ".");
  }
  async function enable() {
    const H = host(), session = folder(), generation = H?.projectGeneration;
    if (!session || session.readOnly || !H.collabLocks || !H.collabLockWrite || !H.collabLockRemove || !enabled()) return;
    await stopping;
    if (binding || H !== host() || session !== folder() || generation !== H.projectGeneration || session.readOnly || !enabled()) return;
    const grant = session.grant;
    const m = create({host:{
      list: () => H.collabLocks(grant),
      write: (key, data, mode) => H.collabLockWrite(grant, key, data, mode),
      remove: key => H.collabLockRemove(grant, key)
    }, name, open: shown, docName: id => session.document?.(id)?.name || nav.docById?.(id)?.name || "",
      changed: id => session.modified?.(id) === true});
    const entry = binding = {folder:session, host:H, generation, manager:m};
    entry.off = session.on?.((event, detail) => {
      if (session.readOnly) reconcile();
      else if (event === "loaded" && detail?.id === nav.currentId?.()) roSync();
    });
    m.on(event => {
      if (m !== manager()) return;
      if (event.type === "state") {
        if (!m.blocked(nav.currentId?.())) ro = null;
        else if (!ro) roSync();
      }
      if (event.type !== "disk") emit(event);
    });
    await m.start();
    if (m !== manager()) return;
    takeShown();
    emit({type:"enabled"});
    G.AtriumLazy?.need?.("AtriumCollabPresence").catch(() => {});
  }
  function disable() {
    const old = binding;
    binding = null; ro = null;
    if (old) {
      old.off?.();
      stopping = old.manager.stop();
      emit({type:"disabled"});
    }
    return stopping;
  }
  function reconcile() {
    if (manager()) return;
    if (binding) disable();
    return enable();
  }
  function attach(h) {
    if (nav) return;
    nav = h;
    G.addEventListener?.("atrium-git-binding", reconcile);
    G.addEventListener?.("pagehide", disable);
    let visible = G.AtriumPower?.visible?.() !== false;
    G.AtriumPower?.onChange?.(state => { if (state.visible && !visible) manager()?.wake(); visible = state.visible; });
    G.addEventListener?.("waffle-project-folder", () => manager()?.wake());
    G.addEventListener?.("folderChanged", event => { if (event.detail?.grant === folder()?.grant) manager()?.wake(); });
    h.on?.("replace", reconcile);
    h.on?.("document", takeShown);
    h.on?.("panes", takeShown);
    h.on?.("change", backstop);
    reconcile();
  }
  // The UI (badges, bars, dialogs, live sessions) and the live-session engines load on demand.
  if (G.AtriumLazy?.register && !G.AtriumLazy.modules?.().includes("AtriumCollabPresence")) {
    G.AtriumLazy.register("AtriumCollabPresence", {scripts: ["project/collab-presence.js"], css: ["project/collab.css"], deps: ["AtriumCollabLock"]});
    G.AtriumLazy.register("AtriumCollabCRDT", {scripts: ["project/collab-crdt.js"]});
    G.AtriumLazy.register("AtriumCollabTransport", {scripts: ["project/collab-transport.js"]});
    G.AtriumLazy.register("AtriumCollabCursors", {scripts: ["project/collab-cursors.js"]});
    G.AtriumLazy.register("AtriumCollabObjectMotion", {scripts: ["project/collab-object-motion.js"]});
  }
  if (G.document) G.AtriumNavCommon?.ready?.(attach);

  return Object.freeze({create, merge, parse, docKey, sessionKey, canon, constants: Object.freeze({HEARTBEAT, STALE, POLL, ASK_TTL, IDLE_RELEASE, FAR}),
    attach, guard, enable, disable, take, synchronize, beforeSave, folder, manager, active: () => !!manager(), name,
    on(f) { extra.add(f); return () => extra.delete(f); },
    release: id => manager()?.release(id), ask: id => manager()?.ask(id),
    takeOver: (id, m) => take(id, {takeover:true}, m),
    handOver: (id, to) => manager()?.handOver(id, to)});
})();
