"use strict";
// Autosave and crash recovery v2 (app/project/autosave.js): snapshot retention, the startup decision,
// IndexedDB and localStorage storage, rewriting the newest snapshot while editing, quota
// handling, isolated native folders, restore / open as copy and recent projects.
// Runs under Node and under JavaScriptCore (scripts/test-jsc.sh autosave). No DOM is needed.
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/project/autosave.js");
const AS = globalThis.AtriumAutosave, {KEEP, MAX_PER_SLOT} = AS.constants;
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ---- retention -----------------------------------------------------------------------------
{
  const now = 100 * DAY, list = [];
  for (let t = now; t > now - 20 * DAY; t -= 7 * MIN) list.push({id: "s@" + t, slot: "s", ts: t});
  const keep = AS.retain(list, now);
  assert.equal(keep.length, MAX_PER_SLOT, "capped per project");
  assert.deepEqual(keep.slice(0, KEEP).map(m => m.ts), list.slice(0, KEEP).map(m => m.ts), "the newest snapshots are always kept");
  assert.ok(keep.every(m => now - m.ts < 14 * DAY), "nothing older than two weeks");
  const spaced = keep.slice(KEEP);
  for (let i = 1; i < spaced.length; i++) assert.ok(spaced[i - 1].ts - spaced[i].ts >= 7 * MIN, "time-spaced");
  const few = AS.retain(list.slice(0, 3), now);
  assert.equal(few.length, 3);
  // Sparse history: one per day for two weeks survives.
  const daily = []; for (let d = 0; d < 20; d++) daily.push({id: "d" + d, slot: "s", ts: now - d * DAY - HOUR});
  const kept = AS.retain(daily, now);
  assert.ok(kept.length >= 13 && kept.length <= 15, "daily snapshots for two weeks: " + kept.length);
}

// ---- startup decision ------------------------------------------------------------------------
{
  const now = 50 * DAY, metas = [{id: "a@2", slot: "a", ts: now - 5000, dirty: true}, {id: "a@1", slot: "a", ts: now - 9000, dirty: true},
    {id: "b@1", slot: "b", ts: now - HOUR, dirty: false}];
  const crashed = {sessions: {x: {beat: now - 10 * MIN, clean: false, slot: "a"}}, last: {slot: "b"}};
  let plan = AS.decide(crashed, metas, now, "me");
  assert.equal(plan.action, "prompt"); assert.equal(plan.unclean, true); assert.equal(plan.slot, "a");
  assert.deepEqual(plan.snapshots.map(m => m.id), ["a@2", "a@1"], "newest first");
  // Another window that is still running is not a crash.
  plan = AS.decide({sessions: {x: {beat: now - 1000, clean: false, slot: "a"}}, last: {slot: "a"}}, metas, now, "me");
  assert.equal(plan.action, "none");
  // Clean exit with unsaved changes: prompt; clean and saved: reopen; dismissed: nothing.
  assert.equal(AS.decide({sessions: {x: {beat: now - HOUR, clean: true}}, last: {slot: "a"}}, metas, now, "me").action, "prompt");
  assert.equal(AS.decide({sessions: {}, last: {slot: "b"}}, metas, now, "me").action, "reopen");
  assert.equal(AS.decide({last: {slot: "a"}, dismissed: "a@2"}, metas, now, "me").action, "none");
  assert.equal(AS.decide({}, metas, now, "me").action, "none", "first start");
  assert.equal(AS.decide({last: {slot: "gone"}}, metas, now, "me").action, "none");
  const sessions = {sessions: {x: {slot: "a"}}, last: {slot: "b"}};
  const windowMetas = metas.map((m, i) => ({...m, session: i === 1 ? "x" : "another-window"}));
  plan = AS.decideRestart(sessions, windowMetas, "x");
  assert.deepEqual(plan.snapshots.map(m => m.id), ["a@1"], "a renderer restart ignores snapshots from other windows");
  assert.equal(AS.decideRestart({...sessions, dismissed: "a@1"}, windowMetas, "x").action, "none", "a dismissal survives restart");
  assert.equal(AS.decideRestart({sessions: {x: {slot: "new-unsnapshotted-draft"}}}, windowMetas, "x").action, "none");
  assert.equal(AS.decideRestart(sessions, windowMetas, null).action, "none", "a crash without a session never guesses a project");
}
assert.equal(AS.fmtSize(3210000), "3.1 MB");
// ---- sliced serialisation equals JSON.stringify ---------------------------------------------------
{
  const {CHUNK} = AS.constants, big = {name: "Big \"q\"", units: undefined, fn() {}, library: Array.from({length: CHUNK * 2 + 7}, (_, i) => ({id: "L" + i, pins: [i, null]})),
    documents: [{id: "a", kind: "pcb", items: Array.from({length: CHUNK * 3 + 1}, (_, i) => ({id: "i" + i, x: i / 3, skip: undefined, arr: [undefined, 1]})), rules: {list: [{a: 1}]}, outline: []},
      {id: "b", kind: "schematic", items: [], notes: ["x", {y: new Date(0)}]}], empty: [], nested: {deep: {deeper: [1, {z: 2}]}}, nums: [NaN, Infinity, -0], tags: [undefined, () => 1]};
  const joined = AS.plan(big).map(t => t()).join("");
  assert.equal(joined, JSON.stringify(big), "plan() tasks concatenate to JSON.stringify");
  assert.ok(AS.plan(big).length > 10, "split into many small steps");
  for (const v of [{}, [], {a: []}, {documents: []}, {documents: [{items: [1, 2]}]}]) assert.equal(AS.plan(v).map(t => t()).join(""), JSON.stringify(v));
} assert.equal(AS.fmtSize(2048), "2 KB");

// ---- fakes -------------------------------------------------------------------------------------
function fakeStorage(limit = Infinity) {
  const m = new Map();
  const size = () => [...m.values()].reduce((n, v) => n + v.length, 0);
  return {map: m, getItem: k => m.has(k) ? m.get(k) : null, removeItem: k => { m.delete(k); },
    setItem(k, v) { v = String(v); if (size() - (m.get(k)?.length || 0) + v.length > limit) { const e = Error("quota"); e.name = "QuotaExceededError"; throw e; } m.set(k, v); }};
}
// A small IndexedDB: open/upgrade, transactions over keyPath stores with put/get/getAll/delete.
function fakeIDB() {
  const data = new Map(), f = {data, failPuts: 0, limit: Infinity};
  const later = fn => setTimeout(fn, 0);
  const db = {
    objectStoreNames: {contains: n => data.has(n)},
    createObjectStore(n, {keyPath}) { data.set(n, new Map()); data.get(n).keyPath = keyPath; },
    transaction(names, mode) {
      const t = {error: null, oncomplete: null, onerror: null, onabort: null}, ops = [];
      let failed = false;
      const finish = () => later(() => { if (failed) { t.onabort?.(); return; } for (const op of ops) op(); t.oncomplete?.(); });
      t.abort = () => { failed = true; t.error = t.error || Error("aborted"); };
      t.objectStore = n => {
        const st = data.get(n);
        const req = fn => { const r = {}; ops.push(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
        return {
          put(v) {
            if (n === "data" && f.failPuts > 0) { if (f.failPuts > 0) f.failPuts--; failed = true; t.error = {name: "QuotaExceededError", message: "quota"}; }
            return req(() => { st.set(v[st.keyPath], structuredCloneish(v)); });
          },
          get: k => req(() => st.get(k)), getAll: () => req(() => [...st.values()]), getAllKeys: () => req(() => [...st.keys()]), delete: k => req(() => { st.delete(k); })
        };
      };
      later(finish);
      return t;
    }
  };
  f.open = () => { const r = {}; later(() => { r.result = db; if (!data.size) r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; };
  return f;
}
const structuredCloneish = v => JSON.parse(JSON.stringify(v));
function project(name, docs = 2, items = 3) {
  const p = Atrium.project(name);
  p.documents = Array.from({length:docs}, (_, d) => ({
    ...Atrium.sheet(d ? "pcb" : "schematic", "Doc " + d), id:name + "-d" + d,
    items:Array.from({length:items}, (_, i) => ({id:"i" + d + "-" + i, kind:"label", text:"A", x:i, y:d}))
  }));
  return p;
}
function fakeHost(p) {
  const h = {p, dirty: true, revision: 1, infos: [], replaced: [], project: () => h.p, isDirty: () => h.dirty, revision: () => h.rev || 1,
    info: t => h.infos.push(t), registerAction() {}, async replaceProject(q, o) { h.replaced.push({q, o}); h.p = q; return true; }};
  return h;
}

async function nativeLaunchRecovery(now) {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const read = name => fs.readFileSync(path.join(__dirname, "../..", name), "utf8");
  const swift = read("native/macos/main.swift"), autosave = read("app/project/autosave.js");
  const launch = swift.match(/static let launchSettleScript = """([\s\S]*?)"""/)?.[1];
  assert.ok(launch, "the native launch script is available to the test");
  // WKWebView presentation itself is exercised by the native first-frame suite. Pin the
  // Swift handoff here as well, without depending on a running window server.
  assert.match(swift, /if action == "launchReady" \{ revealAfterPresentation\(\); return \}/);
  const reveal = swift.match(/private func revealAfterPresentation\(\) \{([\s\S]*?)\n    \}/)?.[1];
  assert.match(reveal, /NSSelectorFromString\("_doAfterNextPresentationUpdate:"\)/);
  assert.match(reveal, /let (\w+): @convention\(block\)[^\n]+self\?\.revealWindow\(\) \}\s+web\.perform\(selector, with: \1\)\s*$/);

  const storage = fakeStorage();
  function page(mode, host) {
    const listeners = new Map(), messages = [];
    let poll, mutation, dialog;
    const eventTarget = {
      addEventListener(type, callback, {once = false} = {}) { listeners.set(type, {callback, once}); },
      removeEventListener(type, callback) { if (listeners.get(type)?.callback === callback) listeners.delete(type); },
      dispatchEvent(event) {
        const listener = listeners.get(event.type);
        if (listener?.once) listeners.delete(event.type);
        listener?.callback(event);
      }
    };
    const document = {readyState: "interactive", body: {}, querySelector: () => dialog};
    const context = vm.createContext({
      ...eventTarget, document, Atrium, clearTimeout,
      Event: class { constructor(type) { this.type = type; } },
      AtriumPref: {get: () => mode}, AtriumNavHost: host,
      window: {...eventTarget, webkit: {messageHandlers: {atriumHost: {postMessage: text => messages.push(JSON.parse(text).action)}}}},
      MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() { mutation = null; } },
      setTimeout: callback => { poll = callback; }
    });
    vm.runInContext(autosave, context);
    const recovery = context.AtriumAutosave = context.AtriumAutosave.create({indexedDB: null, localStorage: storage, now, schedule() {}});
    recovery.attach(host);
    return {recovery, messages,
      watch() { vm.runInContext(launch, context); document.readyState = "complete"; },
      poll() { assert.ok(poll, "a fallback poll was scheduled"); poll(); },
      openWelcome() { dialog = {matches: selector => selector === ".sp-dialog"}; mutation?.(); },
      close() { eventTarget.dispatchEvent({type: "pagehide"}); }
    };
  }

  const saved = fakeHost(project("Saved board"));
  saved.dirty = false;
  const seed = page("auto", saved);
  await seed.recovery.boot();
  assert.ok(await seed.recovery.flush());
  seed.close();

  for (const mode of ["auto", "never", "always"]) {
    const host = fakeHost(project("Starter"));
    host.dirty = false;
    host.isStarter = () => !host.replaced.length;
    let preparations = 0, finish;
    host.prepareLaunch = () => {
      preparations++;
      return new Promise(resolve => { finish = resolve; });
    };
    const run = page(mode, host);
    run.watch();
    assert.equal((await run.recovery.boot()).action, "reopen");
    assert.equal(host.p.name, "Saved board");
    assert.deepEqual(run.messages, [], `${mode}: restore alone cannot reveal the window`);
    if (mode === "always") {
      assert.equal(preparations, 0, "Always waits for its dialog while the timer is delayed");
      run.openWelcome();
    }
    assert.equal(preparations, 1, `${mode}: the intended surface starts preparation before the fallback poll`);
    // A late timer cannot send launchReady while the asynchronous preparation is still pending.
    run.poll();
    assert.deepEqual(run.messages, []);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(run.messages, ["launchReady"], `${mode}: sends exactly one ready handoff`);
    run.poll();
    assert.deepEqual(run.messages, ["launchReady"], `${mode}: a later timer cannot send ready again`);
    run.close();
  }
}

async function main() {
  let clock = 80 * DAY;
  const now = () => clock;
  await nativeLaunchRecovery(now);
  const recovery = [{id:"saved",slot:"current",ts:100,reason:"saved"},{id:"other",slot:"another",ts:200,reason:"open"},
    {id:"draft",slot:"current",ts:300,reason:"timer"}];
  const visibleRecovery = await AS.recoverySnapshots({slot:() => "current", list:async () => recovery, describe:r => r.id});
  assert.deepEqual(visibleRecovery.map(row=>[row.key,row.title,row.meta,row.saved]),
    [["snap:saved","Saved","saved",true],["snap:draft","Autosave","draft",false]]);
  assert.equal(visibleRecovery[0].snapshot,recovery[0]);

  // ---- IndexedDB backend ----------------------------------------------------------------------
  {
    const idb = fakeIDB(), ls = fakeStorage();
    const A = AS.create({indexedDB: idb, localStorage: ls, now, schedule: cb => cb()});
    const host = fakeHost(project("Board"));
    A.attach(host);
    const plan = await A.boot();
    assert.equal(plan.action, "none", "fresh profile: no prompt");
    const m1 = await A.save();
    assert.equal(A.stats().backend, "indexeddb");
    assert.equal(m1.slot, "doc:Board-d0"); assert.equal(m1.items, 6); assert.equal(m1.dirty, true);
    assert.ok(A.stats().mainThreadMs >= 0 && A.stats().bytes === JSON.stringify(host.p).length);
    clock += 20000; host.p.documents[1].items.push({id: "x", kind: "label", text: "New label", x: 9, y: 9});
    const m2 = await A.save();
    assert.equal(m2.id, m1.id, "the newest snapshot is rewritten while editing continues");
    assert.equal((await A.list()).length, 1);
    clock += 2 * MIN; const m3 = await A.save();
    assert.notEqual(m3.id, m1.id, "after a minute the history grows");
    assert.equal((await A.list()).length, 2);
    // Many snapshots over a long session are pruned to the retention set.
    for (let i = 0; i < 40; i++) { clock += 11 * MIN; await A.save(); }
    const all = await A.list();
    assert.ok(all.length <= MAX_PER_SLOT && all.length >= KEEP, "pruned: " + all.length);
    assert.equal(idb.data.get("data").size, all.reduce((n, m) => n + m.parts, 0), "data parts follow metadata (old versions swept)");
    // Restore round trip.
    const newest = all.sort((a, b) => b.ts - a.ts)[0];
    assert.equal(await A.restore(newest.id), true);
    assert.equal(host.replaced.at(-1).q.documents[1].items.length, 4);
    assert.equal(host.replaced.at(-1).o.copy, false);
    // Open as copy: renamed, separate slot, dirty.
    await A.restore(newest.id, {copy: true});
    const copy = host.replaced.at(-1);
    assert.equal(copy.q.name, "Board (recovered)"); assert.equal(copy.o.copy, true); assert.equal(copy.o.dirty, true);
    assert.ok(A.slot().startsWith("copy:"));
    clock += 2 * MIN; const mc = await A.save();
    assert.ok(mc.slot.startsWith("copy:"), "the copy autosaves into its own slot");
    // Recent projects: other projects only, newest first.
    const recent = A.recent();
    assert.deepEqual(recent.map(r => r.slot), ["doc:Board-d0"]);
    assert.equal(recent[0].kind,"project","multi-document slots retain their type as existing metadata");
    host.p = project("Other"); clock += MIN; await A.save();
    assert.deepEqual(A.recent().map(r => r.name), ["Board (recovered)", "Board"]);
    // A different project gets its own slot.
    assert.equal(A.slot(), "doc:Other-d0");
    // Quota: a transient failure frees space and retries; a persistent one warns.
    idb.failPuts = 1; clock += 2 * MIN;
    assert.ok(await A.save(), "retried after freeing space");
    assert.equal(A.stats().error, "");
    idb.failPuts = 5; clock += 2 * MIN;
    assert.equal(await A.save(), null);
    assert.match(A.stats().error, /Recovery storage is full/);
    assert.match(host.infos.at(-1), /Recovery storage is full/, "the warning reaches the status bar");
    idb.failPuts = 0; clock += 2 * MIN;
    assert.ok(await A.save()); assert.equal(A.stats().error, "", "cleared once saving works again");
    // A large project is stored in several parts and read back intact.
    host.p = project("Large", 2, 12000); clock += 2 * MIN;
    const largeSnapshot = JSON.stringify(host.p);
    const ml = await A.save();
    assert.ok(ml.parts > 1, "several parts: " + ml.parts);
    assert.ok(A.stats().longestSliceMs >= 0 && A.stats().urgent === false);
    await A.restore(ml.id);
    assert.equal(JSON.stringify(host.replaced.at(-1).q), largeSnapshot);
    // Edits while slicing restart the snapshot; after two restarts it is taken in one go.
    let calls = 0; host.revision = () => ++calls; clock += 2 * MIN;
    const mr = await A.save();
    assert.ok(mr && A.stats().urgent === false && calls > 3, "restarted, then finished");
    host.revision = () => 1;
    // Debounce: schedule() only arms a timer.
    A.schedule(); assert.equal(A.stats().pending, true);
  }

  // Explicit checkpoints (history-panel.js, lazy) wait for an in-flight autosave, even within the
  // same millisecond, and "before shared restore" stays pinned past ordinary retention.
  require("../../app/history/history-panel.js");
  const HP = globalThis.AtriumHistoryPanel;
  {
    const idb = fakeIDB(), a = AS.create({indexedDB: idb, localStorage: fakeStorage(), now, schedule: cb => cb()});
    const h = fakeHost(project("Shared")); a.attach(h); await a.boot();
    const cp = (reason, current) => HP.checkpoint(reason, current, a, h);
    const auto = a.save(), saved = cp(), [ordinary, version] = await Promise.all([auto, saved]);
    assert.notEqual(ordinary.id, version.id); assert.equal(version.reason, "checkpoint"); assert.equal(version.label, "checkpoint");
    assert.ok(HP.ownSnapshot(version, a));
    h.p.documents[0].items[0].x = 95; h.rev = 2;
    const recovery = await cp("before-restore");
    assert.equal(recovery.revision, 2); assert.notEqual(recovery.id, version.id); assert.ok(recovery.keep > now() + 13 * DAY, "pinned for two weeks");
    assert.match(a.describe(recovery), /before shared restore/);
    h.p.documents[0].items[0].x = 0; h.rev = 3; await a.save();
    assert.equal(JSON.parse((await a.read(recovery.id)).text).documents[0].items[0].x, 95);
    assert.equal(JSON.parse((await a.read(version.id)).text).documents[0].items[0].x, 0);
    // Retention keeps the pinned snapshot among many newer ones.
    const many = [recovery, ...Array.from({length: 40}, (_, i) => ({id: "n" + i, slot: recovery.slot, ts: now() + (i + 1) * MIN}))];
    assert.ok(AS.retain(many, now() + 41 * MIN).includes(recovery));
    const pending = a.save(), stale = cp("before-restore");
    h.p = structuredCloneish(h.p); h.rev++;
    await pending;
    await assert.rejects(stale, /project changed/);
    assert.ok(!(await a.list()).some(m => m.reason === "before-restore" && m.revision === h.rev), "a stale checkpoint is not left behind");
    // A joined session's copy shares document IDs with the original but has its own slot.
    a.detach(h.p);
    assert.ok(!HP.ownSnapshot(version, a), "a private copy with identical document IDs has distinct provenance");
    const foreign = await cp(); assert.ok(HP.ownSnapshot(foreign, a)); assert.notEqual(foreign.slot, version.slot);
    idb.failPuts = 1;
    await assert.rejects(cp("before-restore"), /storage is full/);
    assert.equal((await a.read(version.id)).meta.reason, "checkpoint", "a failed rollback checkpoint never prunes the selected version");
    assert.equal((await a.read(recovery.id)).meta.reason, "before-restore");
  }
  {
    // Without IndexedDB the newest automatic snapshot replaces its predecessor: no checkpoints.
    const a = AS.create({indexedDB: null, localStorage: fakeStorage(), now, schedule: cb => cb()}), h = fakeHost(project("LS"));
    a.attach(h); await a.boot();
    await assert.rejects(HP.checkpoint("before-restore", () => true, a, h), /IndexedDB/);
  }

  // ---- crash, then recovery prompt on the next start --------------------------------------------
  {
    const idb = fakeIDB(), ls = fakeStorage();
    const A = AS.create({indexedDB: idb, localStorage: ls, now, schedule: cb => cb(), locks: null});
    const host = fakeHost(project("Crashy")); A.attach(host);
    await A.boot(); await A.save();
    // Simulated separate processes: the crashed one cannot hold a real Node Web Lock.
    clock += 5 * MIN;
    globalThis.__atriumOpeningProject = true;
    const external = AS.create({indexedDB: idb, localStorage: ls, now, schedule: cb => cb(), locks: null});
    delete globalThis.__atriumOpeningProject;
    const fileHost = fakeHost(project("Opened from Finder")); external.attach(fileHost);
    assert.equal((await external.boot()).openingFile, true, "the native launch intent survives binding the file");
    assert.equal(fileHost.replaced.length, 0, "an explicit file never adopts the other window's recovery");
    const B = AS.create({indexedDB: idb, localStorage: ls, now, schedule: cb => cb(), locks: null});
    const h2 = fakeHost(project("Starter"));
    B.attach(h2);
    const plan = await B.boot();
    assert.equal(plan.action, "prompt"); assert.equal(plan.unclean, true); assert.equal(plan.snapshots[0].name, "Crashy");
    assert.equal(h2.replaced.length, 0, "never restored silently");
    B.dismiss(plan.snapshots[0].id);
    const C = AS.create({indexedDB: idb, localStorage: ls, now, schedule: cb => cb(), locks: null});
    C.attach(fakeHost(project("Starter")));
    assert.equal((await C.boot()).action, "none", "discarded recovery is not offered again");
    assert.equal((await C.list()).length, 1, "discard keeps the snapshot for File › Recover…");
  }

  // ---- localStorage fallback (no IndexedDB) -----------------------------------------------------
  {
    const ls = fakeStorage();
    const A = AS.create({indexedDB: null, localStorage: ls, now, schedule: cb => cb()});
    const host = fakeHost(project("Small")); A.attach(host);
    await A.boot();
    const m = await A.save();
    assert.equal(A.stats().backend, "localStorage"); assert.equal(m.name, "Small");
    clock += 5 * MIN; await A.save();
    assert.equal((await A.list()).length, 1, "the fallback keeps only the latest snapshot");
    await A.restore((await A.list())[0].id);
    assert.equal(host.replaced.at(-1).q.name, "Small");
    // Too large for the fallback: a warning, not a silent failure.
    host.p = project("Huge", 2, 30000); clock += 5 * MIN;
    assert.equal(await A.save(), null);
    assert.match(A.stats().error, /too large for browser recovery storage/);
  }

  // An automatic write can already be queued when the user turns off Autosave.
  {
    let enabled = true, release;
    const loading = new Promise(resolve=>{release=resolve;});
    const A = AS.create({indexedDB:null,localStorage:fakeStorage(),now,serializer:loading,
      prefs:{get:(key,fallback)=>key === "general.autosave" ? enabled : fallback},schedule() {}});
    A.attach(fakeHost(project("Pending")));
    const pending = A.save();
    enabled = false;
    release(null);
    assert.equal(await pending,null);
    assert.equal(await A.save("hidden",true),null);
    assert.deepEqual(await A.list(),[]);
    assert.ok(await A.flush("saved"),"explicit persistence remains available");
  }
  await require("../support/folder-autosave.cjs")(AS, fakeHost, project("Board"), fakeStorage, now);

  // A renderer restart offers only that window's draft even when another one saved most recently.
  {
    const ls = fakeStorage(), idb = fakeIDB(), settings = {indexedDB: idb, localStorage: ls, now, schedule: cb => cb(), locks: null};
    try {
      const A = AS.create(settings), host = fakeHost(project("Board"));
      host.dirty = false;
      A.attach(host);
      await A.boot();
      const board = await A.save();
      const B = AS.create(settings);
      B.attach(fakeHost(project("Other window")));
      await B.boot();
      const other = await B.save();
      assert.notEqual(board.id, other.id);
      globalThis.__atriumRendererRestart = {session: A.session};
      const fresh = AS.create(settings), editor = fakeHost(project("Starter"));
      fresh.attach(editor);
      const choice = await fresh.boot();
      assert.equal(choice.action, "prompt");
      assert.deepEqual(choice.snapshots.map(m => m.id), [board.id]);
      assert.equal(editor.replaced.length, 0, "even a saved snapshot waits for the user's choice");
      assert.equal(await fresh.restore(board.id, {copy: true}), true);
      assert.equal(editor.p.name, "Board (recovered)");
      const copy = await fresh.flush();
      assert.ok(copy.slot.startsWith("copy:"));
      assert.equal(await fresh.restore(board.id), true);
      assert.equal(editor.p.name, "Board");
      assert.equal(fresh.slot(), board.slot);
      assert.equal(JSON.parse((await fresh.read(other.id)).text).name, "Other window");
    } finally { delete globalThis.__atriumRendererRestart; }
  }

  // A pre-release workspace cannot become the current unsaved draft, even when flagged dirty.
  for (const dirty of ["0", "1"]) {
    const ls = fakeStorage();
    const old = JSON.stringify(project("Pre-release"));
    ls.setItem("atrium-workspace-v1", old); ls.setItem("atrium-workspace-v1-dirty", dirty);
    const A = AS.create({indexedDB:fakeIDB(), localStorage:ls, now, schedule() {}});
    const host = fakeHost(project("Starter")); A.attach(host);
    const boot = A.boot();
    assert.equal(A.boot(), boot, "the editor and Home share the startup decision");
    assert.equal((await boot).action, "none");
    assert.deepEqual(await A.list(), []);
    assert.deepEqual(host.replaced, []);
    assert.equal(ls.getItem("atrium-workspace-v1"), old, "retired bytes are not consumed");
  }

  // An invalid current recovery payload never replaces the editor or a neighbouring snapshot.
  {
    const ls = fakeStorage(), h = fakeHost(project("Untitled"));
    const A = AS.create({indexedDB:null, localStorage:ls, now, serializer:null, schedule() {}});
    A.attach(h);
    const saved = await A.flush();
    h.p = project("Other");
    const other = await A.flush();
    const key = (await A.read(saved.id)).meta.data, good = ls.getItem(key);
    for (const bad of ['{"documents":[', JSON.stringify({...project("Broken"), library:false})]) {
      ls.setItem(key,bad);
      await assert.rejects(A.restore(saved.id), /This snapshot could not be read as a Waffle project/);
      assert.deepEqual(h.replaced, []);
      assert.equal(JSON.parse((await A.read(other.id)).text).name, "Other");
    }
    ls.setItem(key,good);
    assert.equal(await A.restore(saved.id),true);
    assert.equal(h.p.name,"Untitled");
  }
  {
    require("../../app/checks/diagnostics.js");
    const recording = AtriumDiagnostics.startPerformance();
    const counts = component => AtriumDiagnostics.performanceSnapshot().rows.find(row => row.component === component)?.counts;
    const A = AS.create({indexedDB:null,localStorage:fakeStorage(),now,serializer:null,schedule() {}});
    const host = fakeHost(project("Private snapshot witness"));
    A.attach(host);
    const draft = await A.flush();
    assert.ok(draft);
    assert.equal(counts("autosave").completed,1);
    assert.equal(counts("autosave").durable,0);
    const replace = host.replaceProject;
    host.replaceProject = async () => false;
    assert.equal(await A.restore(draft.id),false);
    assert.equal(counts("project").cancelled,1);
    host.replaceProject = replace;
    assert.equal(await A.restore(draft.id),true);
    assert.equal(counts("project").completed,1);
    recording.stop();
  }
  console.log("autosave: native folder isolation, in-flight adoption, window recovery, typed restore, retention and quota OK");
}
globalThis.__testDone = main();
globalThis.__testDone.catch(e => { console.error(e); if (typeof process !== "undefined") process.exitCode = 1; });
