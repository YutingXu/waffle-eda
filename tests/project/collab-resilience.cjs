"use strict";
// Live sessions on bad networks, end to end in plain Node: two (or three) real session modules
// (app/project/collab-presence.js with the real CRDT), each in its own V8 context with a minimal DOM,
// joined by a scripted network that can drop an editor, lose what is in flight, and bring it back.
// The transport's own resilience (stalled sockets, retries, data channels outliving the relay) is in
// tests/project/collab-transport.cjs; this suite checks what the session does with it:
//   * no edit is lost: a guest that edits while disconnected (also when its edits vanished in flight)
//     and whose bounded log is trimmed meanwhile catches the host up when it returns
//     (scripts/perf-collab.cjs trim: offlineKnown, inFlight);
//   * the host's heartbeat confirms what it holds, and only then may a guest drop its own edits;
//     with an older host that never confirms, a connected guest trims as before;
//   * past UNSENT edits away from the host, the guest says so plainly, offers Save As and keeps its
//     edits to itself (memory stays bounded); Use the Host's Copy then takes the host's copy;
//   * a host whose window is the relay ends the session for its guests when it leaves: final, said
//     so, Save As offered; while unreachable the status says it is the host's computer;
//   * hostile peers: only the verified host can confirm edits, end the session or say it relays;
//   * energy: the heartbeat rides the transport's beat; an unchanged heartbeat draws nothing;
//   * with the Undo journal (app/history/undo-store.js) in the editors: a guest's offline pastes,
//     deletes and personal undo publish from the journal (itemEdits {structure}) and still reach the
//     host past the bounded log; a copy that no longer fits the session publishes nothing through the
//     whole-project audit at save; Use the Host's Copy starts a replica whose kept view takes scoped
//     patches from then on.
const assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "../..");
const FILES = ["app/core/uuid-v7.js", "app/core/model.js", "app/formats/format-2-codec.js", "app/project/collab-crdt.js", "app/editor/nav-common.js"];
const code = Object.fromEntries([...FILES, "app/history/undo-store.js", "app/project/collab-presence.js"].map(f => [f, fs.readFileSync(path.join(root, f), "utf8")]));
const tick = () => new Promise(r => setImmediate(r));
const paint = () => new Promise(r => setTimeout(r, 60));   // the bar repaints 30 ms after a change
async function until(test, what, n = 400) { for (let i = 0; i < n; i++) { if (test()) return; await tick(); await new Promise(r => setTimeout(r, 2)); } throw Error("timed out: " + what); }

// ---- a minimal DOM: enough for the session's status strip, bar and dialogs to be built ----------
function dom() {
  const byId = new Map();
  class Node {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.textContent = ""; this.className = ""; this.isConnected = false;
      const self = this; this.classList = {add(...c) { self.className = [...new Set((self.className + " " + c.join(" ")).trim().split(/\s+/))].join(" "); }, remove(...c) { self.className = self.className.split(/\s+/).filter(x => !c.includes(x)).join(" "); }, contains: c => self.className.split(/\s+/).includes(c), toggle() {}}; }
    set id(v) { this.attrs.id = v; byId.set(v, this); } get id() { return this.attrs.id; }
    adopt(nodes) { for (const n of nodes) if (n && typeof n === "object") { n.isConnected = this.isConnected; n.parentElement = this; } return nodes; }
    append(...n) { this.children.push(...this.adopt(n)); } prepend(...n) { this.children.unshift(...this.adopt(n)); } appendChild(n) { this.append(n); return n; }
    replaceChildren(...n) { this.children = this.adopt(n); } insertBefore(n) { this.append(n); return n; }
    before(...n) { this.parentElement?.append(...n); for (const x of n) if (x && typeof x === "object") x.isConnected = true; } after(...n) { this.before(...n); }
    remove() { this.isConnected = false; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") byId.set(String(v), this); } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return k in this.attrs; } toggleAttribute(k, on) { if (on ?? !(k in this.attrs)) this.attrs[k] = ""; else delete this.attrs[k]; }
    addEventListener() {} removeEventListener() {} dispatchEvent() { return true; } focus() {} blur() {} select() {}
    querySelector() { return null; } querySelectorAll() { return []; } closest() { return null; } matches() { return false; } contains() { return false; }
    getBoundingClientRect() { return {left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0}; }
    showModal() { this.open = true; } close() { this.open = false; }
    cloneNode() { const n = new Node(this.tagName); n.textContent = this.textContent; n.className = this.className; return n; }
    getContext() { return {measureText: () => ({width: 8, actualBoundingBoxLeft: 4, actualBoundingBoxRight: 4, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 0})}; }
    text() { return [this.textContent, ...this.children.map(c => typeof c === "string" ? c : c.text())].join(" ").trim(); }
    find(test) { if (test(this)) return this; for (const c of this.children) { const f = typeof c === "object" && c.find(test); if (f) return f; } return null; }
  }
  const body = new Node("body"); body.isConnected = true;
  const area = new Node("div"), panes = new Node("div");
  area.isConnected = panes.isConnected = true; area.id = "editor-area"; panes.id = "editor-panes"; body.append(area); area.append(panes);
  const document = {body, documentElement: new Node("html"), activeElement: null, visibilityState: "visible", hidden: false,
    createElement: t => new Node(t), createElementNS: (_, t) => new Node(t), getElementById: id => byId.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}};
  return {document, area};
}

// ---- a scripted network between the editors' transports ---------------------------------------
// online(name, false): the editor's connection drops (it hears "offline", the others "left").
// lossy(name): what it sends vanishes, as into a stalled socket, while it still looks connected.
// mute(name, kinds): fields the network strips from that editor's messages (an older build).
function network() {
  const editors = new Map(), net = {editors, log: []};
  net.transport = name => ({
    constants: {MAX_BODY: 8 * 1024 * 1024, CHUNK: 256 * 1024, PROTOCOL: 4},
    newRoomKey: () => "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", newSalt: () => "S".repeat(22),
    invitation: () => ({link: "", text: ""}), parseHostInvitation: () => null,
    async connect(o) {
      const e = editors.get(name);
      e.o = o; e.closed = false;
      const t = {peer: e.id, room: "r", state: "open", rtc: true, stats: {}, send(kind, body) { net.post(e, kind, JSON.stringify(body ?? null)); return Promise.resolve(); },
        paths: () => new Map([...editors.values()].filter(x => x !== e && x.o && !x.closed && x.up && e.up).map(x => [x.id, "relay"])),
        joined: () => e.up, wake() {}, close() { e.closed = true; }};
      setImmediate(() => { if (!e.closed && e.up) o.onState("open", {peers: editors.size - 1}); });
      return t;
    }
  });
  net.post = (from, kind, json) => {
    if (!from.up || from.lossy || from.closed) return;
    let body = JSON.parse(json);
    for (const k of from.mute || []) if (body && typeof body === "object") delete body[k];
    net.log.push({from: from.name, kind, body});
    for (const to of editors.values()) if (to !== from && to.o) setImmediate(() => {
      if (!from.up || !to.up || to.closed) return;   // a message already sent still arrives after its sender closes
      to.o.onMessage(kind, to.parse(JSON.stringify(body)), from.id, {host: to.o.host === from.id});
    });
  };
  net.online = (name, up) => {
    const e = editors.get(name);
    if (e.up === up) return;
    e.up = up;
    if (!e.o || e.closed) return;
    e.o.onState(up ? "open" : "offline", {peers: editors.size - 1});
    for (const x of editors.values()) if (x !== e && x.o && !x.closed && x.up && !up) x.o.onState("left", {peer: e.id});
  };
  return net;
}

// ---- one editor: the session module in its own context, with a stand-in editor host ------------
// o.journal: the real Undo journal, driven as editor.js drives it (mark before an edit, record after
// it and after a derived patch, a new root for a replaced project).
function editor(net, name, project, o = {}) {
  const id = "p" + name[0].toUpperCase().repeat(22), {document, area} = dom(), listeners = new Map(), notes = [], acts = [];
  let current = project, U = null;
  const host = {
    project: () => current, revision: () => 1, isDirty: () => false, drag: () => null, tool: () => "select", selection: () => [], defs: () => new Map(),
    docById: id => current.documents.find(d => d.id === id), currentId: () => current.documents[0].id, selectDocument() {}, panes: () => [],
    view: () => ({camera: () => ({cx: 0, cy: 0, scale: 1, flipped: false}), worldToScreen: p => p, screenToWorld: p => p}), canvas: () => null, pointer: () => null,
    derive(fn) { fn(); U?.record(current); }, markUnsaved() {}, info(text) { notes.push(String(text)); }, undoSteps: () => ({history: [], future: []}), redraw() {},
    async replaceProject(p, o) { if (o.current && !o.current()) return false; current = p; if (U) { U.reset(); U.mark(p); } return true; },
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    registerAction() {}, addRenderer: () => () => {}, act(a) { acts.push(a); }
  };
  const counts = {sample: 0, request: 0};
  const ctx = vm.createContext({console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone, performance, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, document, window: null, MutationObserver: class { observe() {} }, requestAnimationFrame: f => setTimeout(f, 0), cancelAnimationFrame: clearTimeout});
  ctx.window = ctx;
  for (const f of FILES) vm.runInContext(code[f], ctx, {filename: f});
  if (o.journal) { vm.runInContext(code["app/history/undo-store.js"], ctx, {filename: "app/history/undo-store.js"}); U = ctx.AtriumUndoStore; U.mark(current); }
  const prefs = new Map([["collab.realtime", true], ["collab.displayName", name]]), stored = new Map();
  Object.assign(ctx.AtriumNavCommon, {ready: fn => fn(host), toast() {}});
  Object.assign(ctx, {
    localStorage: {getItem: k => stored.has(k) ? stored.get(k) : null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k)},
    AtriumPref: {get: (k, d) => prefs.has(k) ? prefs.get(k) : d, set: (k, v) => prefs.set(k, v)},
    AtriumCollabCursors: {create: () => ({refresh() {}, request() { counts.request++; }, sample() { counts.sample++; }, stop() {}}), waypoints: () => ({move() {}, reset() {}})},
    AtriumCollabObjectMotion: {create: () => ({change() {}, cancel() {}, localChange() {}, clear() {}, stop() {}}), limits: {items: 32, points: 2048}},
    AtriumCollabTransport: net.transport(name)
  });
  vm.runInContext(code["app/project/collab-presence.js"], ctx, {filename: "app/project/collab-presence.js"});
  const e = {name, id, ctx, up: true, notes, acts, counts, area, Live: ctx.AtriumCollabLive, parse: vm.runInContext("JSON.parse", ctx),
    get project() { return current; }, set project(p) { current = p; },
    session: () => ctx.AtriumCollabLive.session(),
    edit(fn) { U?.mark(current); fn(current); U?.record(current); for (const f of listeners.get("change") || []) f(); ctx.AtriumCollabLive.flush(); },
    fire(type, ...args) { for (const f of listeners.get(type) || []) f(...args); },
    beat() { e.o?.onBeat?.(); },
    bar() { const b = area.find(n => n.className === "collab-bar" && !n.hidden); return b ? b.text() : ""; },
    barButton(label) { return area.find(n => n.tagName === "BUTTON" && n.textContent === label); }};
  net.editors.set(name, e);
  return e;
}

function fixture(vias = 0) {
  const A = globalThis.Atrium;
  const def = {id: "def-r", name: "Resistor", prefix: "R", symbol: {shapes: [], pins: [{x: -3, y: 0, number: "1"}, {x: 3, y: 0, number: "2"}]},
    footprint: {shapes: [], pads: [{x: -1, y: 0, w: .8, h: .9, number: "1"}, {x: 1, y: 0, w: .8, h: .9, number: "2"}]}};
  const p = A.project("Shared", [def]);
  p.documents[1].id = "doc-pcb";
  p.documents[1].items.push({id: "v1", kind: "via", x: 3, y: 3, diameter: .6});
  for (let i = 0; i < vias; i++) p.documents[1].items.push({id: "kv" + i, kind: "via", x: i % 100, y: 10 + Math.floor(i / 100), diameter: .5});
  return A.validate(p);
}
require("../../app/core/uuid-v7.js"); require("../../app/core/model.js");
const clone = v => JSON.parse(JSON.stringify(v));
const kvCount = e => e.project.documents.find(d => d.id === "doc-pcb").items.filter(i => /^kv/.test(i.id)).length;
const deleteKv = (e, n) => e.edit(p => { const d = p.documents.find(x => x.id === "doc-pcb"); let k = 0; d.items = d.items.filter(i => !(/^kv/.test(i.id) && k++ < n)); });

async function pair(vias, o = {}) {
  const net = network(), H = editor(net, "Host", fixture(vias), o), G = editor(net, "Guest", globalThis.Atrium.project("Mine", []), o);
  for (const [e, f] of [[H, o.hostMute], [G, o.guestMute]]) if (f) e.mute = f;
  await H.Live.start("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", o.start);
  await G.Live.join("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", {host: H.id, salt: "S".repeat(22)});
  await until(() => G.session()?.r && G.project.name === "Shared", "the guest joined");
  await until(() => G.session().peers.has(H.id) && H.session().peers.has(G.id), "both see each other");
  return {net, H, G};
}

// The guest edits while disconnected, past the bounded log, and its heartbeat trims; it returns.
// variant "inFlight": the edit is sent into a connection that looks open, then the drop is found.
async function lossScenario(variant) {
  const {net, H, G} = await pair(4300);
  const vv0 = G.session().r.vv()[G.id] || 0;
  if (variant === "inFlight") { G.lossy = true; deleteKv(G, 4300); await tick(); net.online("Guest", false); G.lossy = false; }
  else { net.online("Guest", false); deleteKv(G, 4300); }
  assert.equal(kvCount(G), 0);
  assert.equal(kvCount(H), 4300, "nothing reached the host");
  G.beat(); G.beat();
  const r = G.session().r;
  assert.ok(r.stats().log >= 4300, variant + ": the guest's unconfirmed edits stay in its log through the heartbeat's trim (" + r.stats().log + ")");
  assert.ok(r.ownSeq() - vv0 >= 4300);
  net.online("Guest", true);
  await until(() => kvCount(H) === 0, variant + ": the host received every deletion", 2000);
  await until(() => JSON.stringify(H.session().r.vv()) === JSON.stringify(G.session().r.vv()), "the vectors agree");
  // The host's heartbeat confirms; the guest's log is bounded again.
  H.beat(); await tick(); await tick();
  assert.equal(G.session().acked, G.session().r.ownSeq(), "the host confirmed all of them");
  G.beat();
  assert.ok(G.session().r.stats().log <= G.ctx.AtriumCollabCRDT.LIMITS.log >> 1, "trimmed once confirmed");
  await paint();
  assert.equal(G.bar(), "", "no notice");
  H.Live.leave(); G.Live.leave();
}

// lossScenario with the Undo journal: away from the host (or into a socket that is already dead),
// the guest pastes a block past the bounded log, deletes items and undoes that, and moves one; the
// pastes and deletes publish from the journal ({structure}) and its personal undo from the CRDT. Its
// heartbeat trims meanwhile. On return the host holds every one of these edits and both converge.
async function journalScenario(variant) {
  const {net, H, G} = await pair(200, {journal: true});
  const S = G.session(), r = S.r, vv0 = r.vv()[G.id] || 0, paths = [];
  const publish = r.commit;
  r.commit = (next, options = {}) => { paths.push(options.structure?.length ? "structure" : options.updates ? "updates" : "full"); return publish(next, options); };
  const pcb = e => e.project.documents.find(d => d.id === "doc-pcb");
  if (variant === "inFlight") G.lossy = true; else net.online("Guest", false);
  // A pasted block between existing items (4,300 vias: past LIMITS.log on its own).
  G.edit(p => { const d = p.documents.find(x => x.id === "doc-pcb"); d.items.splice(50, 0, ...Array.from({length: 4300}, (_, i) => ({id: "pasted" + i, kind: "via", x: i % 90, y: 60 + Math.floor(i / 90), diameter: .4}))); });
  if (variant === "inFlight") { await tick(); net.online("Guest", false); G.lossy = false; }
  deleteKv(G, 30);
  assert.ok(G.Live.undo(false), "personal undo while away");
  deleteKv(G, 5);
  G.edit(p => { p.documents.find(d => d.id === "doc-pcb").items.find(i => i.id === "v1").x = 4.5; });
  // (Personal undo first flushes the journal: an empty range, "updates".)
  assert.deepEqual(paths, ["structure", "structure", "updates", "structure", "updates"], variant + ": pastes and deletes published from the journal");
  assert.equal(kvCount(G), 195);
  G.beat(); G.beat();
  assert.ok(r.stats().log >= r.ownSeq() - vv0 && r.ownSeq() - vv0 >= 4300, variant + ": its unconfirmed edits stay in its log through the trim (" + r.stats().log + ")");
  assert.equal(pcb(H).items.length, 201, "nothing reached the host");
  net.online("Guest", true);
  await until(() => JSON.stringify(H.session().r.vv()) === JSON.stringify(G.session().r.vv()), variant + ": the vectors agree", 2000);
  assert.equal(H.session().r.vv()[G.id], G.session().r.ownSeq(), "the host holds every edit the guest made");
  const C = H.ctx.AtriumCollabCRDT;
  assert.equal(C.canon(H.project), C.canon(G.project), variant + ": the editors converge");
  assert.equal(C.canon(H.project), C.canon(H.session().r.project()), "the host's editor matches its replica");
  assert.equal(pcb(H).items.filter(i => /^pasted/.test(i.id)).length, 4300);
  assert.equal(kvCount(H), 195);
  assert.equal(pcb(H).items.find(i => i.id === "v1").x, 4.5);
  assert.equal(pcb(H).items.findIndex(i => i.id === "pasted0"), pcb(G).items.findIndex(i => i.id === "pasted0"), "the block sits where it was pasted");
  H.beat(); await tick(); await tick(); G.beat();
  assert.ok(G.session().r.stats().log <= G.ctx.AtriumCollabCRDT.LIMITS.log >> 1, "trimmed once confirmed");
  H.Live.leave(); G.Live.leave();
}

async function testOlderHost() {
  // An older host never confirms (no acks in its hello, no ack on its heartbeat): while it is here,
  // the guest trims as before and never claims its edits are stranded.
  const {net, H, G} = await pair(4300, {hostMute: ["acks", "ack"]});
  deleteKv(G, 4300);
  await until(() => kvCount(H) === 0, "live edits reach the host");
  G.beat();
  assert.ok(G.session().r.stats().log <= 4000, "trimmed as before");
  await paint();
  assert.ok(!G.session().diverged && G.bar() === "");
  assert.equal(G.session().hostAcks, undefined);
  void net;
  H.Live.leave(); G.Live.leave();
}

async function testCap() {
  // Away from the host past UNSENT edits: said plainly, Save As offered, the edits stay in this
  // copy only (memory bounded), and Use the Host's Copy takes the host's copy when it is back.
  const {net, H, G} = await pair(40100);
  net.online("Guest", false);
  deleteKv(G, 40050);
  G.beat();
  const S = G.session();
  assert.ok(S.diverged, "the copy no longer fits the session");
  await paint();
  assert.match(G.bar(), /more changes away from the session than this window can keep for it \(40,05\d\)/);
  assert.ok(G.notes.some(n => /no longer fit the session/.test(n)));
  assert.ok(S.r.stats().log <= 4000, "the log is bounded again: " + S.r.stats().log);
  G.barButton("Save As…").onclick();
  assert.deepEqual(G.acts, ["save-as"]);
  // Back online: its edits do not reach the host, which keeps editing and is heard.
  net.online("Guest", true);
  await until(() => H.session().peers.has(G.id) && G.session().peers.has(H.id), "reconnected");
  G.edit(p => { p.name = "only mine"; });
  H.edit(p => { p.documents.find(d => d.id === "doc-pcb").items.find(i => i.id === "v1").x = 9; });
  await until(() => G.project.documents.find(d => d.id === "doc-pcb").items.find(i => i.id === "v1").x === 9, "the host's edit arrives");
  await tick(); await tick();
  assert.equal(kvCount(H), 40100, "none of the stranded edits reached the host");
  assert.equal(H.project.name, "Shared");
  // A change the journal missed is found by the whole-project audit at save, kept in this copy and
  // counted, and not published either.
  G.project.name = "found by the audit";
  G.fire("dirty", false);
  await paint();
  assert.equal(S.r.stats().repairs, 1, "the audit at save found the change");
  assert.equal(H.project.name, "Shared", "a copy that no longer fits the session publishes nothing through the audit");
  assert.ok(!net.log.some(m => m.from === "Guest" && m.kind === "ops" && JSON.stringify(m.body).includes("found by the audit")));
  const old = S.r, oldStats = JSON.stringify(old.stats());
  G.barButton("Use the Host's Copy").onclick();
  await until(() => !G.session().diverged && kvCount(G) === 40100, "the host's copy replaced this one");
  await paint();
  assert.equal(G.bar(), "");
  assert.equal(G.project.documents.find(d => d.id === "doc-pcb").items.find(i => i.id === "v1").x, 9);
  // A new replica with its own view: the host's next edits patch it scoped, the old one is done.
  const fresh = G.session().r, C = G.ctx.AtriumCollabCRDT;
  assert.notEqual(fresh, old, "Use the Host's Copy starts a new replica");
  assert.equal(C.canon(G.project), C.canon(fresh.project()), "the editor holds the new replica's view");
  const refreshed = fresh.stats().refreshed;
  H.edit(p => { const d = p.documents.find(x => x.id === "doc-pcb"); d.items.find(i => i.id === "v1").x = 11; d.items.push({id: "after-reset", kind: "via", x: 1, y: 1, diameter: .5}); });
  await until(() => G.project.documents.find(d => d.id === "doc-pcb").items.some(i => i.id === "after-reset"), "the host's edit after the reset arrives");
  assert.ok(fresh.stats().refreshed > refreshed, "received scoped on the new replica's view (" + JSON.stringify(fresh.stats()) + ")");
  assert.equal(C.canon(G.project), C.canon(fresh.project()), "and the editor still matches it");
  assert.equal(JSON.stringify(old.stats()), oldStats, "the replaced replica takes nothing more");
  // Edits from here on reach the host again (its sequence continues from what the host holds).
  G.edit(p => { p.name = "after the reset"; });
  await until(() => H.project.name === "after the reset", "a new edit reaches the host");
  H.Live.leave(); G.Live.leave();
}

async function testHostEnds() {
  // A host sharing on this network (its window is the relay) ends the session when it leaves.
  const {net, H, G} = await pair(0, {start: {lan: {port: 48765, addresses: ["192.168.1.20"], code: "ABCD-EFGH-JKMN-PQRS"}}});
  assert.equal(G.session().hostRelays, true, "the verified host says its window is the relay");
  net.online("Guest", false);
  assert.match(G.session().status, /Can't reach the host's computer/);
  net.online("Guest", true);
  await until(() => G.session().connection === "open" && H.session().peers.has(G.id), "back");
  H.Live.leave();
  await until(() => !G.Live.active(), "the session ended for the guest");
  await paint();
  assert.match(G.bar(), /Host ended the session\. This window keeps your copy, unsaved: Save As keeps it\./);
  assert.ok(G.notes.some(n => /Host ended the session\. Your copy stays open/.test(n)));
  assert.equal(G.project.name, "Shared", "the copy stays");
  G.barButton("Save As…").onclick();
  assert.deepEqual(G.acts, ["save-as"]);
  // With a relay server, a host that leaves does not end it (guests go on).
  const two = await pair(0);
  assert.notEqual(two.G.session().hostRelays, true);
  two.H.Live.leave();
  await until(() => !two.G.session().peers.has(two.H.id), "the host left");
  assert.ok(two.G.Live.active(), "the guests go on");
  two.G.Live.leave();
}

async function testHostile() {
  // Only the verified host confirms edits, ends the session or says its window is the relay.
  const net = network(), H = editor(net, "Host", fixture(0)), G = editor(net, "Guest", globalThis.Atrium.project("Mine", [])), M = editor(net, "Mallory", globalThis.Atrium.project("Mine", []));
  await H.Live.start("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456");
  await G.Live.join("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", {host: H.id, salt: "S".repeat(22)});
  await until(() => G.session()?.r && G.session().peers.has(H.id), "the guest joined");
  await M.Live.join("wss://relay.test", "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456", {host: H.id, salt: "S".repeat(22)});
  await until(() => M.session()?.r && G.session().peers.has(M.id), "Mallory joined");
  net.online("Host", false);
  G.edit(p => { p.name = "offline edit"; });
  const acked = G.session().acked, mine = G.session().r.ownSeq();
  assert.ok(mine > acked);
  const say = (kind, body) => G.session() && G.ctx.AtriumCollabLive && net.post(M, kind, JSON.stringify(body));
  say("cursor", {doc: "doc-pcb", sel: [], act: "", lock: [], cam: {cx: 0, cy: 0, scale: 1}, ack: {[G.id]: mine + 1000}});
  say("hello", {name: "Mallory", has: true, vv: {[G.id]: mine + 1000}, personalUndo: 2, joinRound: 99, acks: 1, hub: 1});
  say("bye", {ended: true});
  await tick(); await tick();
  assert.ok(G.Live.active(), "a guest's bye ends nothing");
  assert.equal(G.session().acked, acked, "nobody but the host confirms this window's edits");
  assert.notEqual(G.session().hostRelays, true);
  G.beat();
  assert.equal(G.session().r.since({[G.id]: acked}, G.id).length, mine - acked, "so they all stay for the host");
  net.online("Host", true);
  await until(() => H.project.name === "offline edit", "and reach it when it returns");
  for (const e of [H, G, M]) e.Live.leave();
}

async function testEnergy() {
  // The heartbeat rides the transport's beat; one that repeats the last record draws nothing.
  const {H, G} = await pair(0);
  assert.equal(G.o.heartbeat, 20000); assert.equal(typeof G.o.onBeat, "function");
  H.beat(); G.beat(); await tick(); await tick();
  const before = {...G.counts};
  for (let i = 0; i < 3; i++) { H.beat(); G.beat(); await tick(); await tick(); }
  assert.deepEqual(G.counts, before, "unchanged heartbeats neither sample nor redraw cursors");
  H.edit(p => { p.name = "moved on"; });
  await until(() => G.project.name === "moved on", "edits still flow");
  H.Live.leave(); G.Live.leave();
}

(async () => {
  const watchdog = setTimeout(() => { console.error("collab-resilience timed out"); process.exit(1); }, 240000);
  await lossScenario("offlineKnown");
  await lossScenario("inFlight");
  await journalScenario("offlineKnown");
  await journalScenario("inFlight");
  await testOlderHost();
  await testHostEnds();
  await testHostile();
  await testEnergy();
  await testCap();
  clearTimeout(watchdog);
  console.log("collab-resilience: ok (offline and in-flight edits past the bounded log reach the host, host confirmation, older host, cap notice with Save As and the host's copy, host-relayed session ends, hostile confirmations and endings, quiet heartbeat; with the Undo journal: offline and in-flight pastes, deletes and undo past the bounded log reach the host; no audit publication from a copy past the cap; a scoped view after Use the Host's Copy)");
})().catch(e => { console.error(e); process.exit(1); });
