"use strict";
// The live-session transport (app/project/collab-transport.js) with real Web Crypto, an in-process relay
// that speaks the relay's protocol (collab/relay/waffle_relay.py) and an in-process WebRTC stand-in:
//   * the relay queue's wire budget (pacing across the relay's rate window);
//   * identity: a peer id is bound to its connection only by a signature, so nobody can speak as
//     another peer or replay someone's proof; the host named in an invitation is that peer;
//   * paths: messages move from the relay to a data channel in order (the "path" marker), fall back
//     to the relay when the channel breaks, and a stalled channel never holds back another peer;
//   * forced relay mode, invitations (link and text) and their parser.
// Standalone JavaScriptCore has no Web Crypto. The Node inventory runs this with node:crypto.
const assert = require("node:assert/strict");
const {webcrypto} = require("node:crypto");
if (!webcrypto?.subtle) throw Error("This suite measures wire sizes using Web Crypto.");
Object.defineProperty(globalThis, "crypto", {value: webcrypto, configurable: true});
require("../../app/project/collab-transport.js");
const T = globalThis.AtriumCollabTransport;
const realTimeout = setTimeout, realClear = clearTimeout;
const tick = (ms = 0) => new Promise(r => realTimeout(r, ms));
async function until(test, what, ms = 4000) {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw Error("timed out: " + what); await tick(5); }
}

// ---- an in-process relay (protocol v2) --------------------------------------------------------
function fakeRelay({ice = []} = {}) {
  const sockets = new Map(), relay = {sockets, log: [], drop: null};
  let n = 0;
  const post = (ws, obj) => setImmediate(() => { if (ws.readyState === 1) ws.onmessage?.({data: JSON.stringify(obj)}); });
  relay.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.id = "c" + String(++n).padStart(16, "0"); setImmediate(() => { this.readyState = 1; this.onopen?.(); }); }
    send(text) {
      const m = JSON.parse(text);
      relay.log.push({from: this.id, m});
      if (m.t === "join") {
        const others = [...sockets.values()].filter(s => s.room === m.room);
        this.room = m.room; sockets.set(this.id, this);
        this.owner = !others.length;
        post(this, {t: "joined", v: 2, id: this.id, peers: others.map(s => s.id), ice, ttl: 600, owner: this.owner});
        for (const s of others) post(s, {t: "peer", id: this.id, joined: true});
      } else if (m.t === "m") {
        for (const s of sockets.values()) if (s !== this && s.room === this.room && (!m.to || m.to.includes(s.id)) && !relay.drop?.(this, s, m))
          post(s, {t: "m", d: m.d, from: this.id});
      } else if (m.t === "sig") { const s = sockets.get(m.to); if (s) post(s, {t: "sig", from: this.id, d: m.d}); }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3; sockets.delete(this.id);
      for (const s of sockets.values()) if (s.room === this.room) post(s, {t: "peer", id: this.id, joined: false});
      setImmediate(() => this.onclose?.());
    }
  };
  return relay;
}

// ---- an in-process WebRTC stand-in: a negotiated, ordered data channel per pair ------------------
function fakeRTC({fail = false, relayed = false} = {}) {
  const offers = new Map(), all = [];
  class DataChannel {
    constructor(pc) { this.pc = pc; this.readyState = "connecting"; this.bufferedAmount = 0; this.bufferedAmountLowThreshold = 0; this.sent = 0; this.stall = false; }
    send(data) {
      if (this.readyState !== "open") throw Error("not open");
      this.sent++;
      if (this.stall) { this.bufferedAmount += data.length; return; }
      const other = this.pc.remote?.dc;
      setImmediate(() => { if (other?.readyState === "open") other.onmessage?.({data}); });
    }
    close() { if (this.readyState === "closed") return; this.readyState = "closed"; setImmediate(() => this.onclose?.()); const o = this.pc.remote?.dc; if (o && o.readyState === "open") o.close(); }
  }
  class PeerConnection {
    constructor(config) { this.config = config; this.id = Math.random().toString(36).slice(2); this.connectionState = "new"; all.push(this); }
    createDataChannel(label, o) { assert.equal(o.negotiated, true); assert.equal(o.ordered, true); this.dc = new DataChannel(this); return this.dc; }
    async createOffer() { return {type: "offer", sdp: "fake:" + this.id}; }
    async createAnswer() { return {type: "answer", sdp: "fake:" + this.id}; }
    async setLocalDescription(d) { this.localDescription = d; if (d.type === "offer") offers.set(this.id, this); this.connect(); }
    async setRemoteDescription(d) { this.remoteDescription = d; this.remote = offers.get(d.sdp.slice(5)) || all.find(p => p.id === d.sdp.slice(5)); this.connect(); }
    async addIceCandidate() {}
    connect() {
      const r = this.remote;
      if (!this.localDescription || !this.remoteDescription || !r) return;
      r.remote = this;
      if (fail) { setImmediate(() => { this.connectionState = "failed"; this.onconnectionstatechange?.(); }); return; }
      if (r.localDescription && r.remoteDescription) setImmediate(() => {
        for (const pc of [this, r]) { pc.connectionState = "connected"; if (pc.dc.readyState === "connecting") { pc.dc.readyState = "open"; pc.dc.onopen?.(); } }
      });
    }
    async getStats() {
      const m = new Map([["T", {type: "transport", selectedCandidatePairId: "P"}], ["P", {type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R"}],
        ["L", {type: "local-candidate", candidateType: relayed ? "relay" : "host"}], ["R", {type: "remote-candidate", candidateType: "srflx"}]]);
      return m;
    }
    close() { this.connectionState = "closed"; this.dc?.close(); }
  }
  return {RTCPeerConnection: PeerConnection, all};
}

function editor(name, relay, rtc, o = {}) {
  const got = [], states = [];
  return {name, got, states, connect: async roomKey => {
    const RTC = rtc && class extends rtc.RTCPeerConnection { constructor(c) { super(c); this.owner = name; } };
    const e = await T.connect({url: "wss://relay.test", roomKey, WebSocket: relay.WebSocket, RTCPeerConnection: RTC, ...o,
      onMessage(kind, body, from, info) { got.push({kind, body, from, host: info.host}); }, onState(s, d) { states.push([s, d]); }});
    return e;
  }};
}

async function testPacing() {
  const key = T.newRoomKey(), frames = [];
  let now = 0;
  Object.defineProperty(globalThis, "performance", {value: {now: () => now}, configurable: true});
  globalThis.setTimeout = (fn, ms) => {
    const timer = {cancelled: false};
    setImmediate(() => { if (!timer.cancelled) { now += ms || 0; fn(); } });
    return timer;
  };
  globalThis.clearTimeout = timer => { if (timer) timer.cancelled = true; };
  class WS {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; queueMicrotask(() => this.onopen()); }
    send(frame) {
      const m = JSON.parse(frame);
      if (m.t === "join") queueMicrotask(() => this.onmessage({data: JSON.stringify({t: "joined", v: 2, id: "c0000000000000001", peers: ["c0000000000000002"], ice: []})}));
      else if (m.t === "m") frames.push({at: now, size: frame.length, data: m.d});
    }
    close() { this.readyState = 3; this.onclose(); }
  }
  const t = await T.connect({roomKey: key, url: "ws://local.test", WebSocket: WS, path: "relay"});
  try {
    while (!frames.length) await new Promise(r => setImmediate(r));
    const keys = await T.keys(key);
    assert.equal((await T.open(keys, frames[0].data)).t, "id", "a connection proves who it is before anything else");
    frames.length = 0;
    const body = {snap: "界".repeat(T.constants.MAX_BODY - 128)};
    await Promise.all([t.send("snapshot", body), t.send("ops", {edit: 1})]);
    while (frames.length < 2 || JSON.parse(JSON.stringify(frames.at(-1))).size < 0) await new Promise(r => setImmediate(r));
    await until(() => frames.some(f => f.size < 2000 && f.at > 0), "the edit after the snapshot", 20000);
    assert.ok(frames.reduce((sum, f) => sum + f.size, 0) > 24 * 1024 * 1024, "encoded snapshot spans relay windows");
    assert.ok(frames.at(-1).at >= 10000, "the reliable edit waits behind the whole snapshot");
    const pieces = [];
    for (const [i, frame] of frames.entries()) {
      const m = await T.open(keys, frame.data);
      if (i === frames.length - 1) { assert.equal(m.t, "ops"); assert.equal(m.b.edit, 1); }
      else { assert.equal(m.t, "chunk"); assert.equal(m.b.i, i); pieces.push(m.b.d); }
    }
    assert.equal(JSON.parse(pieces.join("")).snap, body.snap);
    const before = frames.length, start = now;
    await Promise.all(Array.from({length: 401}, (_, i) => t.send("ops", {edit: i + 2})));
    await until(() => frames.length === before + 401, "401 edits", 20000);
    assert.ok(frames.at(-1).at - start >= 10000);
    for (const f of frames) {
      const window = frames.filter(prior => prior.at <= f.at && prior.at > f.at - 10000);
      assert.ok(window.reduce((sum, entry) => sum + entry.size, 0) <= 24 * 1024 * 1024);
      assert.ok(window.length <= 400);
    }
  } finally {
    t.close();
    globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear;
    delete globalThis.performance;
  }
}

async function testInvitations() {
  const key = T.newRoomKey(), host = "p" + "A".repeat(22), salt = T.newSalt();
  const inv = T.invitation({relay: "wss://collab.example.org", roomKey: key, host, salt});
  assert.ok(inv.link.startsWith("https://collab.example.org/join#atrium=1&"), inv.link);
  assert.ok(!inv.link.split("#")[0].includes(key), "the room key stays in the fragment");
  const want = {relay: "wss://collab.example.org", roomKey: key, host, salt};
  assert.deepEqual(T.parseInvitation(inv.link), want);
  assert.deepEqual(T.parseInvitation(inv.text), want);
  assert.deepEqual(T.parseInvitation("  " + inv.link + "\n"), want);
  assert.equal(T.parseInvitation(T.invitation({relay: "wss://collab.example.org", roomKey: key}).link).salt, null);
  const dev = T.invitation({relay: "ws://127.0.0.1:8765", roomKey: key, host});
  assert.ok(dev.link.startsWith("http://127.0.0.1:8765/join#"));
  assert.equal(T.parseInvitation(dev.link).relay, "ws://127.0.0.1:8765");
  for (const bad of ["", "hello", inv.link.replace(/k=[^&]+/, "k=SHORT"), inv.text.replace("wss://", "https://"), inv.text.replace(host, "evil host"),
    "Relay: wss://x.org\nRoom key: " + key + "\nHost: " + host + "x", inv.link.replace("s=" + salt, "s=!")])
    assert.equal(T.parseInvitation(bad), null, bad);
  assert.equal(T.parseInvitation("Room key: " + key).relay, "local");
  // A host invitation for a private relay (waffle-collab add-host) configures hosting, nothing else.
  const token = "Tk_" + "x".repeat(30), hostLink = "https://collab.example.org/host#atrium-host=1&r=" + encodeURIComponent("wss://collab.example.org") + "&t=" + token + "&n=Alice";
  assert.deepEqual(T.parseHostInvitation(hostLink), {relay: "wss://collab.example.org", token, name: "Alice"});
  assert.equal(T.parseInvitation(hostLink), null, "a host invitation is not a session invitation");
  assert.equal(T.parseHostInvitation(inv.link), null);
}

// Keys (security review #13): a per-session salt separates sessions that reuse a room key; each
// sender has its own AES key and the frame names the sender; manual keys need 24 characters;
// another protocol is reported, not parsed; a host token goes to the relay only when given.
async function testKeys() {
  const key = T.newRoomKey(), a = await T.keys(key, T.newSalt()), b = await T.keys(key, T.newSalt()), manual = await T.keys(key);
  assert.notEqual(a.room, b.room); assert.notEqual(a.room, manual.room);
  const P = "p" + "Q".repeat(22), R = "p" + "R".repeat(22);
  const sealed = await T.seal(a, {p: P, s: 1, t: "ops", b: {x: 1}});
  assert.ok(sealed.startsWith(T.constants.PROTOCOL + ":" + P + "."), "the frame names its sender");
  assert.deepEqual((await T.open(a, sealed)).b, {x: 1});
  await assert.rejects(T.open(b, sealed), "an earlier session's traffic does not open in a new one with the same room key");
  await assert.rejects(T.open(a, sealed.replace(P, R)), "a frame cannot be relabelled with another sender");
  await assert.rejects(T.seal(a, {p: P, s: 1}, "", R).then(text => T.open(a, text)), /sender/, "the inner sender must match the frame");
  const legacy = sealed.replace(/^\d+:/, "3:");
  await assert.rejects(T.open(a, legacy), e => e.protocol === 3,
    "peers with the earlier register writer limit must be rejected before an edit opens");
  const future = sealed.replace(/^\d+:/, (T.constants.PROTOCOL + 1) + ":");
  await assert.rejects(T.open(a, future), e => e.protocol === T.constants.PROTOCOL + 1);
  await assert.rejects(T.keys("ABCD-EFGH-JKMN-PQRS-TUVW"), /at least 24/, "short manual keys are refused");
  // Identity: a rejoin of the same session from this window keeps its peer id (one author).
  const relay = fakeRelay(), salt = T.newSalt();
  const first = await editor("A", relay, null, {salt, RTCPeerConnection: null, persist: true}).connect(key);
  const again = await editor("A", relay, null, {salt, RTCPeerConnection: null, persist: true, hostToken: "alice-token-0123456789abcdef"}).connect(key);
  assert.equal(first.peer, again.peer);
  await until(() => relay.log.some(l => l.m.t === "join" && l.m.host), "a join with a host token");
  assert.equal(relay.log.filter(l => l.m.t === "join" && l.m.host).length, 1, "only when given");
  // The room's owner vouches for each member that proved it holds the room key (TURN rationing).
  const other = await editor("B", relay, null, {salt, RTCPeerConnection: null}).connect(key);
  await until(() => relay.log.some(l => l.m.t === "attest"), "an attestation");
  const attest = relay.log.find(l => l.m.t === "attest");
  assert.equal(attest.from, first.connectionId() || attest.from);
  assert.ok(relay.log.every(l => l.m.t !== "attest" || relay.sockets.get(l.from)?.owner !== false), "only the owner vouches");
  first.close(); again.close(); other.close();
}

// Budgets (security review #5, #6): bytes waiting for decryption, for a proof and for reassembly are
// bounded per connection or sender; one sender's chunks never evict another's.
async function testBudgets() {
  const key = T.newRoomKey(), relay = fakeRelay(), A = editor("A", relay, null, {RTCPeerConnection: null});
  const a = await A.connect(key);
  await until(() => a.state === "open", "A open");
  const keys = await T.keys(key);
  const M = new relay.WebSocket("wss://relay.test");
  await tick(5); M.onmessage = () => {};
  M.send(JSON.stringify({t: "join", room: keys.room, auth: keys.auth, v: 2}));
  await tick(10);
  // A connection that never proves who it is: its early messages are capped, the rest dropped.
  const junk = await T.seal(keys, {p: "p" + "J".repeat(22), s: 1, t: "ops", b: {pad: "x".repeat(300000)}});
  for (let i = 0; i < 12; i++) M.send(JSON.stringify({t: "m", d: junk}));
  await tick(200);
  assert.ok(a.stats.dropped >= 4, "pending bytes are capped (" + a.stats.dropped + ")");
  // A flood beyond the pre-decryption rate is dropped before any decryption.
  const before = a.stats.bad + a.stats.dropped;
  for (let i = 0; i < 2 * T.constants.RATE.messages + 20; i++) M.send(JSON.stringify({t: "m", d: "1:" + "p" + "J".repeat(22) + ".AAAA"}));
  await tick(300);
  assert.ok(a.stats.dropped + a.stats.bad - before >= 2 * T.constants.RATE.messages, "flood handled");
  // Two honest senders' large messages reassemble independently.
  const B = editor("B", relay, null, {RTCPeerConnection: null}), C = editor("C", relay, null, {RTCPeerConnection: null});
  const b = await B.connect(key), c = await C.connect(key);
  await until(() => a.paths().size >= 2, "both bound");
  b.send("snapshot", {from: "b", pad: "b".repeat(600000)});
  c.send("snapshot", {from: "c", pad: "c".repeat(600000)});
  await until(() => A.got.filter(g => g.kind === "snapshot").length === 2, "both snapshots");
  a.close(); b.close(); c.close(); M.close();
}

async function testIdentityAndPaths() {
  const key = T.newRoomKey(), relay = fakeRelay(), rtc = fakeRTC();
  const A = editor("A", relay, rtc);
  const a = await A.connect(key);
  await until(() => a.state === "open", "A open");
  const B2 = editor("B", relay, rtc, {host: a.peer});
  const bb = await B2.connect(key);
  await until(() => a.paths().get(bb.peer) === "direct" && bb.paths().get(a.peer) === "direct", "a direct data channel");
  // In order across the switch, and nothing lost.
  for (let i = 0; i < 50; i++) a.send("ops", {i});
  await until(() => B2.got.filter(g => g.kind === "ops").length === 50, "50 edits");
  assert.deepEqual(B2.got.filter(g => g.kind === "ops").map(g => g.body.i), [...Array(50).keys()]);
  assert.ok(B2.got.every(g => g.from === a.peer && g.host), "the invitation's host, verified");
  assert.ok(bb.stats.direct >= 50 && rtc.all.some(pc => pc.dc.sent > 0), "edits used the data channel");
  assert.ok(B2.states.some(([s, d]) => s === "path" && d.via === "direct"));
  // Large bodies are split to fit the channel and reassembled.
  const big = {snap: "x".repeat(700000)};
  a.send("snapshot", big);
  await until(() => B2.got.some(g => g.kind === "snapshot"), "a large snapshot over the channel");
  assert.equal(B2.got.find(g => g.kind === "snapshot").body.snap.length, 700000);

  // A third editor cannot speak as the host: forged envelopes and replayed proofs are refused.
  const keys = await T.keys(key);
  const M = new relay.WebSocket("wss://relay.test");
  await tick(5);
  M.onmessage = () => {};
  M.send(JSON.stringify({t: "join", room: keys.room, auth: keys.auth, v: 2}));
  await tick(10);
  const forged = await T.seal(keys, {p: a.peer, s: 999999, t: "ops", b: {forged: true}});
  const proof = await T.seal(keys, {p: a.peer, s: 999998, t: "id", b: a.proof});
  M.send(JSON.stringify({t: "m", d: proof})); M.send(JSON.stringify({t: "m", d: forged}));
  await tick(50);
  assert.ok(!B2.got.some(g => g.body?.forged), "an envelope claiming the host's id from another connection is dropped");
  assert.ok(bb.stats.bad >= 1);
  const own = await T.seal(keys, {p: "p" + "Z".repeat(22), s: 1, t: "ops", b: {stranger: true}});
  M.send(JSON.stringify({t: "m", d: own}));
  await tick(50);
  assert.ok(!B2.got.some(g => g.body?.stranger), "a connection that never proved its id is not heard");

  // Messages sealed before the connection's proof (sent at once after connect) still arrive, in order.
  const X = editor("X", relay, null, {RTCPeerConnection: null, path: "relay"}), x = await X.connect(key);
  x.send("hello", {early: 1}); x.send("cursor", {early: 2});
  await until(() => A.got.filter(g => g.body?.early).length === 2, "early messages");
  assert.deepEqual(A.got.filter(g => g.body?.early).map(g => g.body.early), [1, 2]);
  x.close();

  // A broken channel falls back to the relay and asks for a resync; edits keep flowing.
  const pcA = rtc.all.find(pc => pc.dc && pc.dc.readyState === "open");
  pcA.dc.close();
  await until(() => a.paths().get(bb.peer) === "relay" || bb.paths().get(a.peer) === "relay", "fallback to the relay");
  assert.ok(A.states.some(([s]) => s === "resync") || B2.states.some(([s]) => s === "resync"));
  const count = B2.got.length;
  a.send("ops", {after: "fallback"});
  await until(() => B2.got.length > count, "an edit after the fallback");
  assert.equal(B2.got.at(-1).body.after, "fallback");
  // Leaving is reported at once.
  bb.close();
  await until(() => A.states.some(([s, d]) => s === "left" && d.peer === bb.peer), "left");
  a.close(); M.close();
}

async function testStalledPeerAndForcedRelay() {
  const key = T.newRoomKey(), relay = fakeRelay(), rtc = fakeRTC();
  const A = editor("A", relay, rtc, {linkStall: 2e6}), B = editor("B", relay, rtc), C = editor("C", relay, rtc);
  const a = await A.connect(key);
  await until(() => a.state === "open", "A open");
  const b = await B.connect(key), c = await C.connect(key);
  await until(() => [b, c].every(x => a.paths().get(x.peer) === "direct"), "two direct channels");
  // B's channel stops draining: C still gets every edit promptly; B's link gives up and resyncs via the relay.
  const stalled = rtc.all.find(pc => pc.owner === "A" && pc.remote?.owner === "B" && pc.dc.readyState === "open");   // A's end of the A–B channel
  stalled.dc.stall = true;
  const piece = "z".repeat(100000);
  const sentToC = () => C.got.filter(g => g.kind === "ops").length;
  for (let i = 0; i < 40; i++) a.send("ops", {i, piece});
  await until(() => sentToC() === 40, "C keeps up while B's channel is stalled", 15000);
  await until(() => A.states.some(([s, d]) => s === "flood" && d.stalled), "the stalled link gives up", 15000);
  assert.equal(a.paths().get(b.peer), "relay", "B continues through the relay");
  a.close(); b.close(); c.close();

  // Forced relay: no peer connection at all.
  const relay2 = fakeRelay(), rtc2 = fakeRTC();
  const D = editor("D", relay2, rtc2, {path: "relay"}), E = editor("E", relay2, rtc2, {path: "relay"});
  const d = await D.connect(key);
  await until(() => d.state === "open", "D open");
  const e = await E.connect(key);
  await until(() => d.paths().get(e.peer) === "relay", "bound over the relay");
  d.send("ops", {via: "relay"});
  await until(() => E.got.some(g => g.body?.via === "relay"), "relay delivery");
  assert.equal(rtc2.all.length, 0, "forced relay never opens a peer connection");
  d.close(); e.close();

  // TURN-only mode asks for relay candidates and reports the TURN path.
  const relay3 = fakeRelay({ice: [{urls: ["turn:turn.test:3478"], username: "1:x", credential: "y"}]}), rtc3 = fakeRTC({relayed: true});
  const F = editor("F", relay3, rtc3, {path: "turn"}), H = editor("H", relay3, rtc3, {path: "turn"});
  const f = await F.connect(key);
  await until(() => f.state === "open", "F open");
  const h = await H.connect(key);
  await until(() => f.paths().get(h.peer) === "turn", "a TURN-relayed channel");
  assert.equal(rtc3.all[0].config.iceTransportPolicy, "relay");
  assert.deepEqual(rtc3.all[0].config.iceServers[0].urls, ["turn:turn.test:3478"]);
  f.close(); h.close();

  // Without WebRTC (a WebKitGTK build without it): relay only, and the session is told.
  const relay4 = fakeRelay(), G1 = editor("G", relay4, null, {RTCPeerConnection: null});
  const saved = globalThis.RTCPeerConnection; delete globalThis.RTCPeerConnection;
  const g = await G1.connect(key);
  await until(() => g.state === "open", "G open");
  assert.ok(G1.states.some(([s, v]) => s === "rtc" && v === false), "relay-only status");
  g.close();
  if (saved) globalThis.RTCPeerConnection = saved;
}

async function testGroupLibrary() {
  for (const m of ["model", "library-store", "library-panel", "group-library", "group-library-sync"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const info = {id: "group-encrypted", name: "Test group"}, actor = {...await AtriumGroupLibrary.newSigningKey(), name: "Fixture"}, relay = fakeRelay(), roomKey = T.newRoomKey();
  const make = async () => {
    const group = AtriumGroupLibrary.create(info), errors = [];
    let t;
    const sync = AtriumGroupSync.create({current: () => group, accept: (_, items) => group.receive(items),
      send: body => t.send("group-library", body), error: m => errors.push(m)});
    t = await T.connect({url: "wss://relay.test", roomKey, path: "relay", WebSocket: relay.WebSocket,
      onMessage(kind, body, from) { if (kind === "group-library" && (!body.to || body.to === t.peer)) sync.receive(body, from); }});
    return {t, group, sync, errors};
  };
  const a = await make(), b = await make();
  try {
    await until(() => a.t.paths().has(b.t.peer) && b.t.paths().has(a.t.peer), "authenticated group peers");
    const def = {id: "fixture", name: "Encrypted library fixture", symbol: {pins: [], shapes: []}};
    const rev = await a.group.propose(def, {author: actor, note: "Private component proposal"});
    await a.group.decide(a.group.preview(rev.key), "approved", actor);
    a.sync.select(info.id); b.sync.select(info.id);
    await until(() => b.group.events.size === 2, "encrypted group revisions and approval");
    assert.equal(b.group.heads.size, 0);
    assert.equal(b.group.pending()[0].def.name, def.name);
    assert.deepEqual([...a.errors, ...b.errors], []);
    assert.ok(relay.log.some(msg => msg.m.t === "m"));
    assert.ok(!JSON.stringify(relay.log).includes(def.name));
  } finally { a.sync.close(); b.sync.close(); a.t.close(); b.t.close(); }

  // The separate library-only room uses the local, encrypted carrier. Ordinary project
  // invitations are incompatible. A component above the page limit arrives intact.
  const rooms = [], groups = [AtriumGroupLibrary.create(info), AtriumGroupLibrary.create(info)];
  const connects = [], received = [], problems = [];
  for (let i = 0; i < 2; i++) {
    const sync = AtriumGroupSync.create({current: () => groups[i], accept: (_, es) => groups[i].receive(es),
      send: body => rooms[i]?.send(body), error: m => problems.push(m)});
    connects.push(sync);
    received.push({receive(msg, from) { if (msg.op === "piece") pieces++; return sync.receive(msg, from); },
      opened: sync.refresh, offline: sync.disconnect, left: sync.left});
  }
  let pieces = 0;
  try {
    const rev = await groups[0].propose({id: "package", name: "Large synthetic package", symbol: {pins: [], shapes: []},
      model3d: {file: "fixture.step", stepText: "test model".repeat(70000)}}, {author: actor, note: "Model"});
    rooms[0] = await AtriumGroupSync.room(info, null, received[0]);
    const invite = AtriumGroupSync.parseInvitation(rooms[0].invitation);
    assert.deepEqual(invite.info, info);
    assert.equal(T.parseInvitation(rooms[0].invitation), null);
    assert.throws(() => AtriumGroupSync.parseInvitation(T.invitation({relay: "local", roomKey}).text));
    connects[0].select(info.id);
    rooms[1] = await AtriumGroupSync.room(info, invite, received[1]); connects[1].select(info.id);
    await until(() => groups[1].events.has(rev.key), "library-only room with paged 3D model");
    assert.equal(groups[1].pending()[0].def.model3d.stepText, rev.def.model3d.stepText); assert.ok(pieces >= 2);
    assert.deepEqual(problems, []); assert.equal(groups[1].heads.size, 0);
  } finally { rooms.forEach(r => r.close()); connects.forEach(s => s.close()); }
}

const watchdog = realTimeout(() => { console.error("Collaboration transport tests timed out"); process.exit(1); }, 90000);
globalThis.__testDone = (async () => {
  await testGroupLibrary();
  await testInvitations();
  await testKeys();
  await testBudgets();
  await testIdentityAndPaths();
  await testStalledPeerAndForcedRelay();
  await testPacing();
})().then(
  () => console.log("collab-transport: ok (pacing, invitations, host invitations, per-session salt, sender keys, protocol, host tokens, attestations, budgets, verified identity, ordered path switch, fallback, stalled peer, forced relay, TURN, no WebRTC)"),
  e => { console.error(e); process.exitCode = 1; }
).finally(() => realClear(watchdog));
