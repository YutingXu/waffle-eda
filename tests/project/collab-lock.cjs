"use strict";
// Document locking and presence (app/project/collab-lock.js) against an in-memory lock folder with the
// host's rules (exclusive create, owner-only replace and remove, explicit take-over), plus the
// three-way region merge a save uses when someone else saved first. Runs under Node and JSC.
const assert = require("node:assert/strict");
require("../../app/project/collab-lock.js");
const L = globalThis.AtriumCollabLock, {STALE, HEARTBEAT, ASK_TTL, IDLE_RELEASE} = L.constants;

// ---- a shared folder and one host per window -------------------------------------------------
let clock = 1000000;
const folder = new Map();   // key -> {text, mtime}
function host(machine, session, pid, sidecars = folder) {
  const wrap = data => JSON.stringify({"atrium-lock": 1, machine, session, pid, written: clock, data});
  const ownerOf = key => { try { return JSON.parse(sidecars.get(key).text).session; } catch { return null; } };
  return {
    async list() { return {session, machine, now: clock, project: {size: 10, modified: 1}, locks: [...sidecars].map(([key, f]) => ({key, text: f.text, modified: f.mtime}))}; },
    async write(key, data, mode) {
      assert.ok(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key), "a key the host accepts: " + key);
      const text = wrap(data);
      if (mode === "create") { if (sidecars.has(key)) return {written: false, exists: true}; sidecars.set(key, {text, mtime: clock}); return {written: true}; }
      if (mode === "replace") { if (!sidecars.has(key)) return {written: false, missing: true}; if (ownerOf(key) !== session) return {written: false, owner: false}; sidecars.set(key, {text, mtime: clock}); return {written: true}; }
      if (mode === "takeover") { sidecars.set(key, {text, mtime: clock}); return {written: true}; }
      throw Error("mode");
    },
    async remove(key, force) { if (!sidecars.has(key)) return {removed: false}; if (!force && ownerOf(key) !== session) return {removed: false, owner: false}; sidecars.delete(key); return {removed: true}; }
  };
}
function win(nameText, session, open = []) {
  const state = {open, changed: new Set()};
  const events = [];
  const m = L.create({host: host("machine-" + session, session, 4242), now: () => clock, name: () => nameText, open: () => state.open,
    docName: id => "Doc " + id, changed: id => state.changed.has(id), schedule: false});
  m.on(e => events.push(e));
  return {m, state, events};
}

(async () => {
  // ---- exclusive edit locks --------------------------------------------------------------------
  const A = win("Alice", "sa", ["board"]), B = win("Bob", "sb", ["board"]);
  await A.m.tick(); await B.m.tick();
  assert.equal((await A.m.acquire("board")).state, "held", "the first window takes the lock");
  const rb = await B.m.acquire("board");
  assert.equal(rb.state, "locked"); assert.equal(rb.owner.name, "Alice");
  assert.ok(B.m.blocked("board"), "Bob is read-only on the board");
  assert.ok(!A.m.blocked("board"), "Alice edits");
  // Per-document granularity: Bob locks the schematic while Alice has the board.
  assert.equal((await B.m.acquire("sheet1")).state, "held");
  await A.m.tick();
  assert.ok(A.m.blocked("sheet1") && !B.m.blocked("sheet1"), "Alice is read-only on Bob's sheet");
  // Presence: each window's presence file names the documents it shows.
  clock += HEARTBEAT; await A.m.tick(); await B.m.tick(); await A.m.tick();
  const st = A.m.docState("board");
  assert.ok(st.held && st.viewers.some(v => v.name === "Bob"), "Alice sees Bob viewing the board");
  assert.ok(A.m.people().some(p => p.name === "Bob" && p.editing.includes("sheet1")));
  // Lock text is untrusted: a forged record with another key or junk is ignored.
  folder.set("d-board2", {text: JSON.stringify({"atrium-lock": 1, session: "x", written: clock, data: {doc: "board", name: "Mallory"}}), mtime: clock});
  folder.set("d-junk", {text: "{not json", mtime: clock});
  folder.set("s-evil", {text: JSON.stringify({"atrium-lock": 1, session: "evil", written: clock, data: {name: "E‮v\u0007il " + "x".repeat(500), viewing: ["board"]}}), mtime: clock});
  await A.m.tick();
  assert.ok(!A.m.records().some(r => r.key === "d-board2" || r.key === "d-junk"), "mismatched and malformed locks are ignored");
  const evil = A.m.records().find(r => r.key === "s-evil");
  assert.ok(evil.name.length <= 64 && !/[‮\u0007]/.test(evil.name), "display names are cleaned");
  folder.delete("d-board2"); folder.delete("d-junk"); folder.delete("s-evil");

  // ---- heartbeat, staleness and take-over ----------------------------------------------------
  for (let t = 0; t < 3; t++) { clock += HEARTBEAT; await A.m.tick(); await B.m.tick(); }
  assert.ok(!B.m.docState("board").stale, "a lock with a moving heartbeat is fresh");
  // Alice's window freezes (no more heartbeats); Bob's view of the lock goes stale.
  for (let t = 0; t < 6; t++) { clock += HEARTBEAT; await B.m.tick(); }
  assert.ok(B.m.docState("board").stale, "stale after " + STALE + " ms without a heartbeat");
  assert.ok(!B.m.blocked("board"), "a stale lock no longer blocks");
  assert.equal((await B.m.acquire("board")).state, "stale", "acquire reports the stale lock instead of taking it");
  assert.equal((await B.m.acquire("board", {takeover: true})).state, "held", "take over after the warning");
  // Alice's window wakes up: her next poll notices the lock is gone.
  await A.m.tick();
  assert.ok(A.events.some(e => e.type === "lost" && e.doc === "board" && e.by?.name === "Bob"), "Alice is told Bob took the board");
  assert.ok(A.m.blocked("board"));
  // A replace of a lock someone else owns is refused by the host: Alice cannot write over it.
  assert.deepEqual(await host("m", "sa", 1).write("d-board", {kind: "edit", doc: "board"}, "replace"), {written: false, owner: false});

  // ---- ask to edit and hand over --------------------------------------------------------------
  await A.m.ask("board");
  clock += 1000; await B.m.tick();
  const asking = B.m.docState("board").askers;
  assert.equal(asking.length, 1); assert.equal(asking[0].name, "Alice");
  await B.m.handOver("board", A.m.session());
  await A.m.tick();
  assert.ok(A.events.some(e => e.type === "granted" && e.doc === "board"), "Alice is told she can edit");
  assert.equal((await A.m.acquire("board")).state, "held");
  // An ask expires.
  await B.m.ask("board"); clock += ASK_TTL + 1000; await B.m.tick();
  assert.ok(!B.m.docState("board").asked);

  // ---- idle release ---------------------------------------------------------------------------
  const C = win("Carol", "sc", ["power"]);
  await C.m.tick(); await C.m.acquire("power");
  C.state.open = ["other"]; C.state.changed.add("power");
  clock += IDLE_RELEASE + HEARTBEAT; await C.m.tick();
  assert.ok(C.m.held().includes("power"), "a document with unsaved edits keeps its lock");
  C.state.changed.clear(); clock += HEARTBEAT; await C.m.tick();
  assert.ok(!C.m.held().includes("power"), "an idle, unchanged document's lock is released");

  // ---- closing removes this window's files only ------------------------------------------------
  await C.m.stop(); await B.m.stop();
  assert.ok(![...folder.keys()].some(k => k === "s-sc" || k === "s-sb" || k === "d-sheet1"));
  assert.ok(folder.has("d-board"), "Alice's lock stays");
  await A.m.stop();
  assert.equal(folder.size, 0);

  // ---- three-way region merge -------------------------------------------------------------------
  const doc = (id, n, items = []) => ({id, kind: "pcb", name: n, grid: .25, items, outline: [], notes: []});
  const base = {format: "atrium", version: 1, name: "P", library: [{id: "L1", name: "R"}], documents: [doc("sch", "Sheet"), doc("pcb", "Board")],
    review: {version: 1, records: {c1: {type: "thread", text: "hi"}}}};
  const clone = v => JSON.parse(JSON.stringify(v));
  // Alice edits the board; Bob edited and saved the sheet, added a comment and a library part.
  const mine = clone(base); mine.documents[1].items.push({id: "t", kind: "track"});
  const theirs = clone(base); theirs.documents[0].name = "Sheet (Bob)"; theirs.review.records.c2 = {type: "reply", thread: "c1"}; theirs.library.push({id: "L2", name: "C"});
  let r = L.merge(base, mine, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.project.documents[0].name, "Sheet (Bob)"); assert.equal(r.project.documents[1].items.length, 1);
  assert.ok(r.project.review.records.c2 && r.project.review.records.c1); assert.equal(r.project.library.length, 2);
  assert.ok(r.theirs.some(t => t.region === "document" && t.id === "sch"));
  // Both changed the same document: a conflict, and the save stops.
  const theirs2 = clone(base); theirs2.documents[1].name = "Board (Bob)";
  r = L.merge(base, mine, theirs2);
  assert.deepEqual(r.conflicts.map(c => c.id), ["pcb"]);
  // A document Alice added keeps its place; one Bob deleted (and Alice did not touch) goes.
  const mine3 = clone(base); mine3.documents.splice(1, 0, doc("new", "New sheet"));
  const theirs3 = clone(base); theirs3.documents.splice(0, 1);
  r = L.merge(base, mine3, theirs3);
  assert.deepEqual(r.project.documents.map(d => d.id), ["new", "pcb"]);
  // Project-level keys merge per key; identical changes are not conflicts.
  const m4 = clone(base), t4 = clone(base); m4.name = "Same"; t4.name = "Same"; m4.rules = {a: 1}; t4.units = "mil";
  r = L.merge(base, m4, t4);
  assert.equal(r.conflicts.length, 0); assert.equal(r.project.name, "Same"); assert.deepEqual(r.project.rules, {a: 1}); assert.equal(r.project.units, "mil");

  // ---- keys and parsing ---------------------------------------------------------------------------
  assert.equal(L.docKey("2b1f-aa_c"), "d-2b1f-aa_c");
  assert.ok(/^d-h[a-z0-9]+-/.test(L.docKey("we/ird id")), "unsafe ids are hashed");
  assert.ok(L.docKey("x".repeat(200)).length <= 64);
  assert.equal(L.parse("../x", "{}"), null); assert.equal(L.parse("d-a", "x".repeat(20000)), null);

  // ---- current native folder wiring, with two roots containing the same document ID ----
  const aSidecars = new Map(), bSidecars = new Map();
  const peer = host("peer", "alice", 42, aSidecars);
  const AHost = host("machine", "window-a", 7, aSidecars), BHost = host("machine", "window-b", 7, bSidecars);
  await peer.write("d-sheet", {kind:"edit", doc:"sheet", name:"Alice"}, "create");
  const calls = [], reads = [];
  const folderSession = (grant, readOnly = false) => {
    const documents = [{id:"sheet",name:"Visible",path:"Visible.wsch",kind:"schematic",items:[]},
      {id:"cold",name:"Cold",path:"Cold.wpcb",kind:"pcb",items:[]}];
    return {
      grant, readOnly, document:id => documents.find(doc => doc.id === id),
      project:{id:"same-project",documents:documents.slice(0,1)},
      getDocumentRef:id => documents.find(doc => doc.id === id),
      async synchronize(paths) { reads.push(...paths); },
      requireClosure() { throw Error("Opening or handing over a lock must keep the projected editor partial"); },
      modified: () => false, canEdit: () => !readOnly
    };
  };
  const first = folderSession("grant-a"), second = folderSession("grant-b");
  let current = null, slow = null;
  function bound(grant, action) {
    assert.equal(grant, H.folderGitGrant);
    calls.push([grant,action]);
    return grant === first.grant ? AHost : BHost;
  }
  const H = globalThis.AtriumHost = {
    folderGitGrant:null, projectGeneration:0, historyPath:"Detached.kicad_sch",
    async collabLocks(grant) { const result = bound(grant,"list"); if (slow) await slow; return result.list(); },
    collabLockWrite: (grant,key,data,mode) => bound(grant,"write").write(key,data,mode),
    collabLockRemove: (grant,key) => bound(grant,"remove").remove(key,false)
  };
  const listeners = new Map(), notice = [];
  const nav = {
    folderProject:() => current, currentId:() => "sheet", docById:id => current?.project.documents.find(d => d.id === id),
    panes:() => [], on(event,fn) { listeners.set(event,fn); }, info:message => notice.push(message),
    derive(fn) { fn(); }
  };
  const select = (session, grant = session?.grant || null) => {
    current = session; H.folderGitGrant = grant; H.projectGeneration++;
    return listeners.get("replace")();
  };
  L.attach(nav);
  await L.enable();
  assert.equal(L.manager(),null);
  assert.deepEqual(calls, [], "a detached foreign source gets no lock I/O");
  await select(first,"not-the-session-grant");
  await select(folderSession("readonly",true));
  assert.deepEqual(calls, [], "wrong or read-only native folder gets no lock I/O");

  await select(first);
  const locked = L.manager();
  assert.ok(locked);
  assert.equal(L.guard("sheet"),true,"the genuine current document is protected by Alice's lock");
  await assert.rejects(L.beforeSave(first,new Set(["sheet"])), /Alice holds the editing lock/);
  await L.beforeSave(first,new Set(["cold"]));
  await L.synchronize("sheet",locked);
  assert.deepEqual(reads,["Visible.wsch"],"hand-over refresh scopes the exact active owner");
  assert.equal(first.project.documents.length,1,"no cold owner was materialized");

  let finish;
  slow = new Promise(resolve => { finish = resolve; });
  const oldReply = locked.refresh();
  const reopen = select(second);
  slow = null; finish();
  await Promise.all([oldReply,reopen]);
  assert.notEqual(L.manager(),locked);
  assert.equal(L.guard("sheet"),false,"a late response from the former grant cannot lock this project");
  assert.equal(await L.take("sheet",{},locked),null,"a stale dialog cannot reuse its manager on another folder");
  await select(null);
  await L.disable();
  assert.equal(L.manager(),null);
  assert.ok(!notice.some(message => /Could not lock/.test(message)));

  console.log("collab-lock: ok");
})().catch(e => { console.log("SHIM-FAIL collab-lock.cjs: " + e.message); throw e; });
