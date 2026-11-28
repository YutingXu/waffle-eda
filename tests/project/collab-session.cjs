"use strict";
// Live-session trust rules in app/project/collab-presence.js, driven through its real message handling with
// LinkeDOM, the real CRDT and a scripted transport (the transport's own identity checks are in
// tests/project/collab-transport.cjs). A guest that joined from an invitation naming its host:
//   * applies a live edit only when every operation is the verified sender's own;
//   * takes other people's edits (a catch-up, a shared version) only from the host; from anyone
//     else they are cut down to that sender's own edits;
//   * accepts a merge snapshot and a shared-restore boundary only from the host, so nobody else can
//     retire its personal undo history or move the restore boundary;
//   * answers a restore check only from the host;
//   * keeps no timer faster than the 20 s heartbeat while nobody drags (energy).
// Node with LinkeDOM (scripts/test-jsc.sh skips it).
const assert = require("node:assert/strict");
const {parseHTML} = require("linkedom");
const {window, document} = parseHTML("<!doctype html><html><body><div id=editor-area><div id=editor-panes></div></div></body></html>");
Object.assign(globalThis, {window, document, HTMLElement: window.HTMLElement, MutationObserver: class { observe() {} }});
const proto = window.HTMLElement.prototype;
proto.showModal = function () { this.setAttribute("open", ""); this.open = true; };
proto.close = function () { this.removeAttribute("open"); this.open = false; this.dispatchEvent(new window.Event("close")); this.onclose?.(); };
window.HTMLCanvasElement.prototype.getContext = () => ({measureText: () => ({actualBoundingBoxLeft: 30, actualBoundingBoxRight: 30, actualBoundingBoxAscent: 40, actualBoundingBoxDescent: 0})});
const intervals = [];
const realInterval = setInterval;
globalThis.setInterval = (fn, ms) => { intervals.push(ms); return realInterval(fn, ms); };
require("../../app/core/model.js");
require("../../app/formats/format-2-codec.js");
require("../../app/project/collab-crdt.js");
const A = globalThis.Atrium, C = globalThis.AtriumCollabCRDT;

// ---- a minimal editor host -------------------------------------------------------------------------
const def = {id: "def-r", name: "Resistor", prefix: "R", symbol: {shapes: [], pins: [{x: -3, y: 0, number: "1"}, {x: 3, y: 0, number: "2"}]},
  footprint: {shapes: [], pads: [{x: -1, y: 0, w: .8, h: .9, number: "1"}, {x: 1, y: 0, w: .8, h: .9, number: "2"}]}};
const base = A.project("Shared", [def]);
base.documents[1].id = "doc-pcb";
base.documents[1].items.push({id: "v1", kind: "via", x: 3, y: 3, diameter: .6});
A.validate(base);
let project = A.project("Mine", [def]);
const notes = [];
const listeners = new Map();
const host = {
  project: () => project, revision: () => 1, isDirty: () => false, drag: () => null, tool: () => "select", selection: () => [], defs: () => new Map(),
  docById: id => project.documents.find(d => d.id === id), currentId: () => project.documents[0].id, selectDocument() {}, panes: () => [],
  view: () => ({camera: () => ({cx: 0, cy: 0, scale: 1, flipped: false}), worldToScreen: p => p, screenToWorld: p => p}), canvas: () => null, pointer: () => null,
  derive(fn) { fn(); }, markUnsaved() {}, info(text) { notes.push(String(text)); }, undoSteps: () => ({history: [], future: []}), redraw() {},
  async replaceProject(p, o) { if (o.current && !o.current()) return false; project = p; return true; },
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
  registerAction() {}, addRenderer: () => () => {}
};
require("../../app/editor/nav-common.js");
Object.assign(globalThis.AtriumNavCommon, {ready: fn => fn(host), toast() {}});
const prefs = new Map([["collab.realtime", true]]), stored = new Map();
globalThis.localStorage = {getItem: k => stored.has(k) ? stored.get(k) : null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k)};
globalThis.AtriumPref = {get: (k, d) => prefs.has(k) ? prefs.get(k) : d, set: (k, v) => prefs.set(k, v)};
globalThis.AtriumCollabCursors = {create: () => ({refresh() {}, request() {}, sample() {}, stop() {}}), waypoints: () => ({move() {}, reset() {}})};
globalThis.AtriumCollabObjectMotion = {create: () => ({change() {}, cancel() {}, localChange() {}, clear() {}, stop() {}}), limits: {items: 32, points: 2048}};

// ---- a scripted transport ----------------------------------------------------------------------------
const HOST = "p" + "H".repeat(22), MAL = "p" + "M".repeat(22), ME = "p" + "G".repeat(22);
let wire = null;
const sent = [];
globalThis.AtriumCollabTransport = {
  constants: {MAX_BODY: 8 * 1024 * 1024, CHUNK: 256 * 1024, PROTOCOL: 3},
  newRoomKey: () => "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", newSalt: () => "S".repeat(22),
  invitation: () => ({link: "", text: ""}),
  parseHostInvitation: t => /#atrium-host=1&/.test(t) ? {relay: "wss://collab.example.org", token: "T".repeat(24), name: "Alice"} : null,
  async connect(o) {
    wire = o;
    return {peer: ME, room: "r", state: "open", rtc: true, send(kind, body) { sent.push({kind, body}); return Promise.resolve(); }, paths: () => new Map(), close() {}};
  }
};
require("../../app/project/collab-presence.js");
const Live = globalThis.AtriumCollabLive;
const tick = () => new Promise(r => setTimeout(r, 0));
const say = (kind, body, from) => wire.onMessage(kind, body, from, {host: from === HOST});
const item = id => project.documents.flatMap(d => d.items).find(i => i.id === id);
const clone = v => JSON.parse(JSON.stringify(v));
const until = async test => { for (let i = 0; i < 100 && !test(); i++) await tick(); return test(); };
const edit = fn => { fn(project); for (const f of listeners.get("change") || []) f(); Live.flush(); };

(async () => {
  // Join through an invitation naming HOST, and adopt its snapshot.
  const hostReplica = C.create({replica: HOST, project: JSON.parse(JSON.stringify(base))});
  const malReplica = C.create({replica: MAL, project: JSON.parse(JSON.stringify(base))});
  await Live.join("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", HOST);
  wire.onState("open", {peers: 2});
  say("hello", {name: "Host", has: true, vv: hostReplica.vv(), waypoints: true, personalUndo: 2, sharedRestore: "host", joinRound: 1}, HOST);
  say("hello", {name: "Mallory", has: true, vv: malReplica.vv(), waypoints: true, personalUndo: 2, sharedRestore: "host", joinRound: 1}, MAL);
  const want = sent.find(m => m.kind === "want");
  assert.equal(want?.body.to, HOST, "a joining guest asks the host for the project");
  say("snapshot", {to: ME, joinRound: Live.session().joinRound, snap: JSON.parse(JSON.stringify(malReplica.snapshot()))}, MAL);
  await tick();
  assert.equal(project.name, "Mine", "an unsolicited snapshot from someone else is ignored");
  say("snapshot", {to: ME, joinRound: Live.session().joinRound, snap: JSON.parse(JSON.stringify(hostReplica.snapshot()))}, HOST);
  for (let i = 0; i < 50 && !Live.session()?.r; i++) await tick();
  assert.equal(project.name, "Shared", "joined the host's project");
  const S = Live.session();
  assert.equal(S.host, HOST);

  // Forged authors: a live edit carrying the host's replica id, sent by Mallory, is refused.
  const hostEdit = (() => { const p = hostReplica.project(); p.documents[1].items.find(i => i.id === "v1").x = 40; return hostReplica.commit(p); })();
  say("ops", JSON.parse(JSON.stringify(hostEdit)), MAL);
  assert.equal(item("v1").x, 3, "a live edit in someone else's name is refused");
  say("ops", JSON.parse(JSON.stringify(hostEdit)), HOST);
  assert.equal(item("v1").x, 40, "the author's own edit applies");

  // Mallory's own edit applies; her "catch-up" carrying the host's edits is cut down to her own.
  const malEdit = (() => { const p = malReplica.project(); p.name = "Mallory was here"; return malReplica.commit(p); })();
  const hostEdit2 = (() => { const p = hostReplica.project(); p.documents[1].items.find(i => i.id === "v1").diameter = 2; return hostReplica.commit(p); })();
  const forgedOther = JSON.parse(JSON.stringify(hostEdit2));
  say("ops", {from: MAL, catchUp: true, to: ME, ops: [...forgedOther.ops, ...JSON.parse(JSON.stringify(malEdit)).ops]}, MAL);
  assert.equal(project.name, "Mallory was here", "her own edits in a catch-up apply");
  assert.equal(item("v1").diameter, .6, "someone else's edits in her catch-up do not");
  say("ops", {from: HOST, catchUp: true, to: ME, ops: forgedOther.ops}, HOST);
  assert.equal(item("v1").diameter, 2, "the host's catch-up carries others' edits");

  // A shared-restore boundary from anyone but the host is ignored (it would retire personal undo).
  edit(() => { item("v1").y = 9; });
  assert.ok(S.r.canUndo(), "a personal edit to undo");
  const vv = S.r.vv(), malNext = (() => { const p = malReplica.project(); p.name = "Restored by Mallory"; return malReplica.commit(p); })();
  const fake = {to: ME, joinRound: Live.session().joinRound, batches: [JSON.parse(JSON.stringify(malNext))], restore: MAL + ".1", through: {...vv}, restoredAt: {...vv, [MAL]: (vv[MAL] || 0) + 1}};
  say("ops", fake, MAL);
  assert.equal(S.restoreBoundary, undefined, "a non-host cannot set the restore boundary");
  assert.ok(S.r.canUndo(), "personal history survives a forged restore");
  const spoof = {...fake, restore: HOST + ".1", restoredAt: {...vv, [HOST]: (vv[HOST] || 0) + 1}};
  say("ops", spoof, MAL);
  assert.equal(S.restoreBoundary, undefined, "nor by naming the host as the restore's author");
  // The host's own shared version does set it.
  const hv = S.r.vv(), hostRestore = (() => { const p = hostReplica.project(); p.name = "Restored by host"; return hostReplica.commit(p, {recordUndo: false}); })();
  say("ops", {to: ME, joinRound: Live.session().joinRound, batches: [JSON.parse(JSON.stringify(hostRestore))], restore: HOST + ".1", through: {...hv}, restoredAt: {...hv, [HOST]: (hv[HOST] || 0) + 1}}, HOST);
  assert.equal(S.restoreBoundary?.restore, HOST + ".1", "the host's shared restore sets the boundary");
  assert.equal(project.name, "Restored by host");

  // Group messages are explicitly enabled and stay outside the project CRDT and its version vector.
  const groupMessages = [], libraryBefore = JSON.stringify(project);
  const connection = Live.bindGroupLibrary({receive: (body, from) => groupMessages.push([body, from]), opened() {}, left() {}, offline() {}, ended() {}});
  say("group-library", {to: MAL, op: "find"}, HOST);
  say("group-library", {to: ME, op: "find"}, HOST);
  assert.deepEqual(groupMessages, [[{to: ME, op: "find"}, HOST]]);
  sent.length = 0; connection.send({op: "find"}); assert.equal(sent.at(-1).kind, "group-library");
  connection.close(); say("group-library", {to: ME, op: "find"}, HOST);
  assert.equal(groupMessages.length, 1); assert.equal(JSON.stringify(project), libraryBefore);

  // Snapshot merges (catch-up after the log was trimmed) come from the host only.
  const before = JSON.stringify(S.r.vv());
  const rogue = C.create({replica: MAL + "x", project: JSON.parse(JSON.stringify(base))});
  const p2 = rogue.project(); p2.name = "Merged from Mallory"; rogue.commit(p2);
  say("snapshot", {to: ME, joinRound: Live.session().joinRound, snap: JSON.parse(JSON.stringify(rogue.snapshot()))}, MAL);
  assert.equal(JSON.stringify(S.r.vv()), before, "a merge snapshot from a guest is ignored");
  assert.notEqual(project.name, "Merged from Mallory");

  // A restore check from anyone but the host gets no answer and holds nothing.
  sent.length = 0;
  say("restore", {id: "x.1", phase: "check"}, MAL);
  assert.ok(!sent.some(m => m.kind === "restore"), "no answer to a non-host restore check");
  assert.equal(S.restoreHold, undefined);

  // History › Open privately asks before it leaves the session; Cancel keeps everything.
  const jumps = [];
  host.historyGo = (n, tip) => jumps.push([n, tip]);
  require("../../app/history/history-panel.js");
  const dialogFor = () => [...document.querySelectorAll("dialog[open]")].find(d => d.textContent.includes("Leave the live session?"));
  globalThis.AtriumHistoryPanel.openPrivately("tip-1", "Branch A");
  const cancel = [...dialogFor().querySelectorAll("button")].find(b => b.textContent === "Cancel");
  cancel.onclick({stopPropagation() {}});
  assert.ok(Live.active() && !jumps.length, "Cancel stays in the session");
  globalThis.AtriumHistoryPanel.openPrivately("tip-1", "Branch A");
  const confirm = [...dialogFor().querySelectorAll("button")].find(b => b.textContent === "Leave and Open");
  confirm.onclick({stopPropagation() {}});
  assert.ok(!Live.active(), "confirming leaves the session first");
  assert.deepEqual(jumps, [[0, "tip-1"]], "then opens the branch privately");

  // Energy: one 20 s heartbeat, on the transport's keepalive beat (no interval of the session's
  // own); nothing faster while nobody drags.
  const energy = [...intervals];
  assert.deepEqual(intervals.filter(ms => ms < 15000), [], "no fast timers: " + intervals.join(", "));
  void notes;
  assert.equal(wire.heartbeat, 20000);
  assert.equal(typeof wire.onBeat, "function");
  Live.leave(true);
  assert.deepEqual(energy.filter(ms => ms < 15000), []);

  // A starting project comes from the invitation's host; another participant's copy only after a
  // wait, with a warning (security review #4). The wait counts from the connection (N2a).
  project = A.project("Mine", [def]); sent.length = 0;
  await Live.join("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", HOST);
  Live.session().started -= 60000;   // a long wait before the relay answered does not count
  wire.onState("open", {peers: 1});
  say("hello", {name: "Mallory", has: true, vv: malReplica.vv(), personalUndo: 2, joinRound: 1}, MAL);
  assert.ok(!sent.some(m => m.kind === "want"), "no starting project from someone other than the host");
  Live.session().waitFrom -= 20000;
  say("hello", {name: "Mallory", has: true, vv: malReplica.vv(), personalUndo: 2, joinRound: 1}, MAL);
  assert.equal(sent.find(m => m.kind === "want")?.body.to, MAL, "after the wait, another copy, with a warning");
  assert.ok(notes.some(n => /host isn't here/.test(n)));

  // N2b-d: Mallory's copy is forged (any counters she likes). The guest edits it; when the verified
  // host arrives, the guest says its copy is not the host's, its own edits go to the host first,
  // and it takes the host's copy whole, which already holds those edits.
  const forged = C.create({replica: MAL, project: clone(base)});
  { const q = forged.project(); q.name = "Forged"; forged.commit(q); }
  say("snapshot", {to: ME, joinRound: Live.session().joinRound, snap: clone(forged.snapshot())}, MAL);
  assert.ok(await until(() => Live.session()?.r), "joined Mallory's copy");
  assert.equal(project.name, "Forged");
  assert.equal(Live.session().base, "other");
  edit(p => { p.documents[1].items.find(i => i.id === "v1").x = 77; });
  sent.length = 0;
  say("hello", {name: "Host", has: true, vv: hostReplica.vv(), personalUndo: 2, sharedRestore: "host", joinRound: 1}, HOST);
  const catchUp = sent.filter(m => m.kind === "ops" && m.body.to === HOST);
  assert.ok(catchUp.length, "the guest's own edits go to the host");
  const firstHello = sent.findIndex(m => m.kind === "hello"), lastOps = sent.map(m => m.kind).lastIndexOf("ops");
  assert.ok(firstHello > lastOps && sent[firstHello].body.base === "other", "then it says its copy did not come from the host");
  for (const m of catchUp) hostReplica.receive(clone({from: ME, ops: m.body.ops.filter(op => op.ts.r === ME)}), {author: ME});
  assert.equal(hostReplica.project().documents[1].items.find(i => i.id === "v1").x, 77);
  say("snapshot", {to: ME, joinRound: 1, reset: true, snap: clone(hostReplica.snapshot())}, HOST);
  assert.equal(Live.session().base, "host", "the host's copy replaced Mallory's (no 'edits by this replica' error)");
  assert.equal(project.name, hostReplica.project().name);
  assert.equal(item("v1").x, 77, "the guest's edit survived");
  // N4: the format stamp is the host's; Mallory's change of it is ignored.
  const stamp = project.formatVersion;
  const malStamp = (() => { const q = malReplica.project(); q.formatVersion = "9.0"; q.name = "Stamped"; return malReplica.commit(q); })();
  say("ops", clone(malStamp), MAL);
  assert.equal(project.name, "Stamped");
  assert.equal(project.formatVersion, stamp, "only the host sets the format stamp");
  // N3: Leave, then Join again in this window (same peer id): the host's copy holds this
  // replica's earlier edits, also when it arrives through someone else after the wait.
  Live.leave(true);
  project = A.project("Mine", [def]); sent.length = 0;
  const OTHER = "p" + "O".repeat(22), relayed = C.create({replica: OTHER, snapshot: clone(hostReplica.snapshot())});
  await Live.join("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", HOST);
  wire.onState("open", {peers: 1});
  Live.session().waitFrom -= 20000;
  say("hello", {name: "Olga", has: true, vv: relayed.vv(), personalUndo: 2, joinRound: 1}, OTHER);
  say("snapshot", {to: ME, joinRound: Live.session().joinRound, snap: clone(relayed.snapshot())}, OTHER);
  assert.ok(await until(() => Live.session()?.r), "rejoined: " + notes.slice(-2).join(" | "));
  assert.equal(item("v1").x, 77);
  edit(p => { p.name = "After rejoin"; });
  const next = sent.filter(m => m.kind === "ops" && !m.body.to).pop()?.body;
  assert.ok(next && next.ops.every(op => op.n > Math.max(...catchUp.flatMap(m => m.body.ops.map(o => o.n)))), "the edit sequence continues past the earlier session's");
  Live.leave(true);

  // The host replaces a guest's copy that did not come from it, or claims more host edits than it made.
  project = JSON.parse(JSON.stringify(base)); sent.length = 0;
  assert.equal((await Live.start("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456")).salt, "S".repeat(22), "a given room key still gets a fresh session salt");
  wire.onState("open", {peers: 1});
  const hs = Live.session();
  assert.equal(hs.host, ME);
  say("hello", {name: "Guest", has: true, vv: {[ME]: 500}, personalUndo: 2, sharedRestore: "guest", joinRound: 1}, MAL);
  const reset = sent.find(m => m.kind === "snapshot" && m.body.reset);
  assert.ok(reset && reset.body.to === MAL, "a fresh snapshot replaces the inflated copy");
  sent.length = 0;
  say("hello", {name: "Guest", has: true, vv: {}, personalUndo: 2, sharedRestore: "guest", joinRound: 2, base: "other"}, MAL);
  assert.ok(sent.some(m => m.kind === "snapshot" && m.body.reset && m.body.to === MAL), "and a copy that came from someone else");
  // Versions: an older app version is a label; a newer minor format a single notice; a newer major
  // format a notice for the host, who stays.
  const [major,minor]=AtriumFormat2.FORMAT.split(".").map(Number);
  const nextMinor=major+"."+(minor+1), nextMajor=(major+1)+".0";
  say("hello", {name: "Newer", has: true, vv: {}, personalUndo: 2, joinRound: 1, app: "9.9.9", format: nextMinor, protocol: 3}, HOST.replace("H", "N"));
  assert.ok(notes.some(n => /Newer uses a newer Waffle\. Objects only it understands are kept/.test(n)), notes.join(" | "));
  assert.equal(Live.peers().find(p => p.name === "Newer")?.app, "9.9.9");
  assert.ok(Live.active(), "a newer minor format shares the session");
  say("hello", {name: "Future", has: true, vv: {}, personalUndo: 2, joinRound: 1, format: nextMajor, protocol: 3}, HOST.replace("H", "F"));
  assert.ok(Live.active() && notes.some(n => /Future uses a newer Waffle that this one cannot work with/.test(n)), "the host stays");
  Live.leave(true);
  // N1: a guest acts only on its verified host's version. A protocol number (read before
  // decryption) or anyone else's format is a notice; the host's newer major format ends the join.
  project = A.project("Mine", [def]);
  await Live.join("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", HOST);
  wire.onState("open", {peers: 1});
  wire.onState("incompatible", {protocol: 4, ours: 3});
  assert.ok(Live.active(), "an unverified protocol number never ends the join");
  say("hello", {name: "Mallory", has: true, vv: {}, personalUndo: 2, joinRound: 1, format: "9.0", protocol: 3}, MAL);
  assert.ok(Live.active(), "nor another participant's format");
  say("hello", {name: "Host", has: true, vv: {}, personalUndo: 2, sharedRestore: "host", joinRound: 1, format: nextMajor, protocol: 3}, HOST);
  assert.ok(!Live.active() && notes.some(n => /Update to join: this session's host uses a newer Waffle/.test(n)), "the verified host's does");
  assert.equal(project.name, "Mine", "the guest's own project is unchanged");

  // N4: objects only a newer Waffle understands: the host sees how many and can discard them.
  project = JSON.parse(JSON.stringify(base)); sent.length = 0;
  await Live.start("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456");
  wire.onState("open", {peers: 1});
  const NEW = "p" + "N".repeat(22), newer = C.create({replica: NEW, snapshot: clone(Live.session().r.snapshot()), validate: null});
  const odd = (() => { const q = clone(newer.project()); q.documents[1].items.push({id: "odd", kind: "hologram"}); return newer.commit(q); })();
  say("ops", clone(odd), NEW);
  assert.equal(Live.session().r.hiddenCount(), 1);
  assert.ok(!item("odd"), "not shown here");
  Live.dialog();
  const discard = [...document.querySelectorAll("dialog[open] button")].find(b => b.textContent === "Discard Them");
  assert.ok(discard && !discard.hidden && /1 object from a newer Waffle/.test(discard.parentElement.textContent));
  sent.length = 0;
  discard.onclick(); assert.ok(!sent.length, "the first press asks again");
  discard.onclick();
  const gone = sent.find(m => m.kind === "ops");
  assert.ok(gone && gone.body.ops.some(op => op.t === "rem" && op.o === "odd"), "discarding is an edit for everyone");
  assert.equal(Live.session().r.hiddenCount(), 0);
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  Live.leave(true);
  // A private relay's host invitation, pasted into Share › Join: it sets up hosting, starts nothing.
  Live.leave(true);
  globalThis.AtriumCollabLive.dialog({invite: "https://collab.example.org/host#atrium-host=1&r=x&t=y"});
  const joinButton = [...document.querySelectorAll("dialog[open] button")].find(b => b.textContent === "Join Session");
  await joinButton.onclick({stopPropagation() {}});
  assert.equal(prefs.get("collab.relay"), "wss://collab.example.org");
  assert.equal(JSON.parse(stored.get("atrium.collab.hostToken")).name, "Alice");
  assert.ok(![...prefs.keys()].some(k => /host/i.test(k)), "the host token is not a preference (N5)");
  assert.ok(!Live.active() && notes.some(n => /You can now host live sessions/.test(n)));
  // Share › Join recognises what was pasted before anything connects (docs/collaboration.md).
  const R = Live.recognise;
  assert.equal(R("").kind, null);
  assert.equal(R("https://collab.example.org/join#atrium=1&r=wss%3A%2F%2Fcollab.example.org&k=ABCD").kind, "invite");
  assert.equal(R("Relay: wss://collab.example.org\nRoom key: ABCD-EFGH").kind, "invite");
  assert.equal(R("https://collab.example.org/host#atrium-host=1&r=x&t=y").kind, "host");
  assert.equal(R("  atrium-offer.z.AAAA\nBBBB ").kind, "offer");
  assert.equal(R("atrium-reply.z.AAAA").kind, "reply");
  for (const a of ["192.168.1.20:48765", "ws://10.0.0.5:8765", "alice-mac.local", "[fe80::1]:48765"]) assert.equal(R(a).kind, "address", a);
  assert.equal(R("hello there").kind, null);
  globalThis.AtriumCollabLive.dialog();
  const joinField = [...document.querySelectorAll("dialog[open] textarea")][0];
  joinField.value = "atrium-reply.z.AAAA"; joinField.dispatchEvent(new window.Event("input"));
  assert.match(document.querySelector("dialog[open] .collab-detected").textContent, /pairing reply/);
  await [...document.querySelectorAll("dialog[open] button")].find(b => b.textContent === "Join Session").onclick({stopPropagation() {}});
  assert.ok(!Live.active() && /pairing reply/.test(document.querySelector("dialog[open] .collab-field-error").textContent), "a reply pasted into Join is explained, nothing connects");
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  // Shared on this network: the invitation names the host's best address, not whichever came first
  // (172.17.0.1 is Docker's bridge on Linux): the primary (default-route) address when the host gives
  // one, else 192.168/16, 10/8, 172.16/12 (172.17/16 last), IPv4 before IPv6 (in brackets).
  const invites = [], invitation = globalThis.AtriumCollabTransport.invitation;
  globalThis.AtriumCollabTransport.invitation = o => { invites.push(o); return invitation(o); };
  const lanInvite = async lan => {
    await Live.start("ws://127.0.0.1:48765", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", {salt: "S".repeat(22), lan: {port: 48765, name: "Board", code: "ABCD", ...lan}});
    const relay = invites.at(-1)?.relay;
    Live.leave(true);
    return relay;
  };
  assert.equal(await lanInvite({addresses: ["172.17.0.1", "fd12::7", "172.20.0.4", "10.1.2.3", "192.168.1.20"]}), "ws://192.168.1.20:48765");
  assert.equal(await lanInvite({addresses: ["172.17.0.1", "172.20.0.4", "10.1.2.3"]}), "ws://10.1.2.3:48765");
  assert.equal(await lanInvite({addresses: ["172.17.0.1", "172.20.0.4"]}), "ws://172.20.0.4:48765");
  assert.equal(await lanInvite({addresses: ["192.168.1.20", "10.1.2.3"], primary: "10.1.2.3"}), "ws://10.1.2.3:48765", "the host's default-route address");
  assert.equal(await lanInvite({addresses: ["192.168.1.20"], primary: "172.17.0.1"}), "ws://192.168.1.20:48765", "a primary not among the addresses is ignored");
  assert.equal(await lanInvite({addresses: ["fd12::7"]}), "ws://[fd12::7]:48765");
  assert.equal(await lanInvite({addresses: []}), "ws://127.0.0.1:48765");
  globalThis.AtriumCollabTransport.invitation = invitation;
  // Exercise the real Undo journal, publication timer and soft-lock reconciliation together.
  require("../../app/history/undo-store.js");
  const store = globalThis.AtriumUndoStore, originalDerive = host.derive, derives = [];
  host.derive = (fn, {touched} = {}) => { fn(); derives.push(touched); store.record(project, touched); };
  project = clone(base); project.documents[0].items.push({id: "joint", kind: "junction", x: 1, y: 2});
  await Live.start("local", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456");
  wire.onState("open", {peers: 1});
  const remote = C.create({replica: HOST, snapshot: clone(Live.session().r.snapshot())});
  say("hello", {name: "Editor", has: true, vv: {}, personalUndo: 2, joinRound: 1}, HOST);
  const [sheet, board] = project.documents, sheetItems = sheet.items, joint = sheet.items[0], via = item("v1");
  say("cursor", {doc: sheet.id, act: "moving a junction", lock: [joint.id]}, HOST);
  assert.equal(Live.guardObjects([via.id]), false); assert.equal(Live.guardObjects([]), false);
  assert.equal(Live.guardObjects([via.id, joint.id]), true); assert.equal(Live.guardObjects(null), true);
  assert.match(notes.at(-1), /Editor.*moving a junction/);
  const signal = () => { for (const f of listeners.get("change") || []) f(); };
  let dragging = null;
  host.drag = () => dragging;
  function beginViaMove() { dragging = {kind: "move", before: store.mark(project)}; }
  function finishViaMove(cancel) {
    const touched = {doc: board, items: [via]};
    if (cancel) store.rollback(dragging.before, touched);
    else { store.record(project, touched); signal(); }
    dragging = null;
    for (const f of listeners.get("move-end") || []) f();
  }
  host.setTool = () => { if (dragging) finishViaMove(true); };
  let planned = 0, guards = 0;
  const r = Live.session().r, orig = r.commit;
  r.commit = (p, opts) => {
    planned++;
    assert.ok(Array.isArray(opts.updates), "the session consumed the settled journal");
    const reconcile = opts.reconcile;
    return orig(p, {...opts, reconcile: ops => { guards++; return reconcile(ops); }});
  };
  sent.length = 0; via.x++; store.record(project, {doc: board, items: [via]}); signal(); Live.flush();
  assert.equal(planned, 1); assert.equal(guards, 1);
  const valid = sent.filter(m => m.kind === "ops"); assert.equal(valid.length, 1);
  remote.receive(clone(valid[0].body)); assert.deepEqual(remote.raw(), r.raw());
  const previousVector = r.vv();
  store.record(project, {doc: board, items: [via]}); signal(); Live.flush();
  assert.equal(planned, 1, "a no-op never installs a pending publication timer"); assert.deepEqual(r.vv(), previousVector);
  // A hit restores just the blocked geometry and still publishes a genuine independent edit.
  joint.x += 9; via.y++;
  store.record(project, [{doc: sheet, items: [joint]}, {doc: board, items: [via]}]); signal();
  const originalX = via.x;
  beginViaMove(); via.x += 12; // Begin a real Undo mark, but do not commit this pose.
  sent.length = 0; Live.flush();
  assert.equal(sent.filter(m => m.kind === "ops").length, 0, "a flush during the next gesture does not publish its pose");
  assert.equal(via.x, originalX + 12, "the tentative drag remains visible");
  finishViaMove(true); // Escape restores the mark, then publishes the preceding completed edit.
  assert.equal(via.x, originalX);
  assert.equal(joint.x, 1); assert.equal(sheet.items, sheetItems);
  assert.deepEqual(derives.at(-1).map(x => x.items.map(i => i.id)), [["joint"]]);
  const unlocked = sent.find(m => m.kind === "ops");
  assert.deepEqual(unlocked.body.ops.map(op => [op.o, op.k]), [["v1", "y"]], "rollback never publishes the next drag preview");
  remote.receive(clone(unlocked.body)); assert.deepEqual(remote.raw(), r.raw());
  r.commit = orig;
  // A normal peer edit arrives during both Escape and Drop. It is received in order,
  // outside the drag's checkpoint; cancelling must never undo the peer's change.
  for (const cancel of [true, false]) {
    const x = via.x, y = joint.y;
    beginViaMove(); via.x += 2; sent.length = 0;
    for (let n = 1; n <= 2; n++) {
      const design = remote.project(); design.documents[0].items.find(i => i.id === joint.id).y = y + n;
      say("ops", clone(remote.commit(design)), HOST);
    }
    assert.equal(joint.y, y); assert.equal(via.x, x + 2);
    Live.flush(); assert.equal(sent.filter(m => m.kind === "ops").length, 0);
    finishViaMove(cancel);
    assert.equal(joint.y, y + 2); assert.equal(via.x, x + (cancel ? 0 : 2));
    const batches = sent.filter(m => m.kind === "ops");
    assert.equal(batches.length, cancel ? 0 : 1);
    if (!cancel) {
      assert.deepEqual(batches[0].body.ops.map(op => [op.o, op.k, op.v]), [[via.id, "x", via.x]]);
      remote.receive(clone(batches[0].body));
    }
    assert.deepEqual(remote.raw(), r.raw());
  }
  // A long move has a bounded incoming queue. Lower its byte budget to the size of one
  // normal edit so the next edit exercises cancellation and ordered catch-up.
  const limits = globalThis.AtriumCollabTransport.constants, limit = limits.MAX_BODY;
  const y = joint.y, x = via.x, incoming = [1, 2].map(n => {
    const design = remote.project(); design.documents[0].items.find(i => i.id === joint.id).y = y + n;
    return clone(remote.commit(design));
  });
  try {
    limits.MAX_BODY = Math.max(...incoming.map(b => JSON.stringify(b).length));
    beginViaMove(); via.x += 3; sent.length = 0;
    say("ops", incoming[0], HOST); assert.equal(joint.y, y);
    say("ops", incoming[1], HOST);
    assert.equal(dragging, null); assert.equal(via.x, x); assert.equal(joint.y, y + 2);
    assert.equal(sent.filter(m => m.kind === "ops").length, 0);
    assert.deepEqual(remote.raw(), r.raw());
  } finally { limits.MAX_BODY = limit; }
  const beforeReplay = derives.length, version = clone(remote.vv());
  const same = {from: HOST, ops: [
    {t: "set", o: "joint", k: "x", v: 1}, {t: "set", o: sheet.id, k: "name", v: sheet.name},
    {t: "set", o: def.id, k: "name", v: def.name}, {t: "meta", k: "name", v: project.name}
  ].map((op, i) => ({...op, ts: {c: r.stats().clock + i + 1, r: HOST}, n: (version[HOST] || 0) + i + 1}))};
  say("ops", same, HOST); say("ops", same, HOST);
  assert.equal(derives.length, beforeReplay, "a received same-value operation and its replay never refresh the editor");
  assert.equal(r.vv()[HOST], same.ops.at(-1).n, "the no-op still advances the causal clock");
  // Opening a new project between the edit and its debounced flush can publish only the old edit.
  via.x++; store.record(project, {doc: board, items: [via]}); signal(); sent.length = 0;
  project = A.project("Other");
  for (const f of listeners.get("replace") || []) f();
  assert.equal(Live.active(), false);
  assert.deepEqual(sent.filter(m => m.kind === "ops").flatMap(m => m.body.ops.map(op => op.o)), ["v1"]);
  Live.flush(); store.reset();

  // Start on a table-free project. A peer introduces a table and the actual
  // publisher uses the Undo journal for its title, cell and locked cell edits.
  const validators = {AtriumWidgetCatalogue: "widget-catalogue", AtriumTableData: "table-data", AtriumNotebook: "notebook"};
  globalThis.AtriumLazy = {async need(names) {
    for (const name of names) if (validators[name]) require(require("../support/app-source-paths.cjs").appFile(validators[name] + ".js"));
  }};
  require("../../app/project/source-file.js");
  require("../../app/notebook/widget-fallback.js");
  project = clone(base);
  await Live.start("local", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456");
  wire.onState("open", {peers: 1});
  const tables = globalThis.AtriumTableData, hostTable = Live.session().r;
  const peerTable = C.create({replica: HOST, snapshot: clone(hostTable.snapshot())});
  say("hello", {name: "Editor", has: true, vv: {}, personalUndo: 2, joinRound: 1}, HOST);
  const tableSheet = project.documents[0], ids = ["table-row", "table-column"], tableState = tables.create(1,1,()=>ids.shift());
  const added = peerTable.project();
  added.documents[0].items.push({id: "full-table", kind: "textframe", x: 0, y: 0, w: 40, h: 25, text: "Input",
    widget: {type: "table", state: tableState, fallback: {type: "text", text: "Input"}}});
  say("ops", clone(peerTable.commit(added)), HOST);
  sent.length = 0;
  const tableItem = item("full-table"), history = [], future = [];
  assert.ok(tableItem, "the initially table-free editor validates the peer's new table");
  const tableChange = fn => {
    const before = store.mark(project);
    fn(tableItem);
    store.checkpoint(history, future, before, "Edit table");
    store.record(project, {doc: tableSheet, items: [tableItem]});
    signal(); Live.flush();
  };
  const sendToPeer = () => {
    const batches = sent.filter(message => message.kind === "ops");
    for (const batch of batches) peerTable.receive(clone(batch.body));
    assert.deepEqual(hostTable.raw(), peerTable.raw());
    sent.length = 0;
  };
  tableChange(i => { i.text = "Measurement"; });
  sendToPeer();
  const editCell = text => tableChange(i => {
    i.widget.state = tables.change(i.widget.state, "table-row", "table-column", {content: {kind: "literal", text}});
  });
  const readCell = () => tables.get(tableItem.widget.state, "table-row", "table-column")?.content.text;
  editCell("Measured");
  sendToPeer();
  assert.equal(readCell(), "Measured");
  Live.undo(false); sendToPeer(); assert.equal(readCell(), undefined);
  Live.undo(true); sendToPeer(); assert.equal(readCell(), "Measured");
  say("cursor", {doc: tableSheet.id, act: "editing the table", lock: [tableItem.id]}, HOST);
  editCell("Blocked");
  assert.equal(readCell(), "Measured");
  assert.ok(!sent.some(message => message.kind === "ops"));
  Live.leave(true); store.reset(); host.derive = originalDerive;
  console.log("collab-session: ok (verified authors, host-only catch-up, merge and restore boundary, restore checks, timers, host-only start, forged-start reset, rejoin, format owner, set-aside, versions, Join recognition, journaled tables, Undo and table locks)");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
