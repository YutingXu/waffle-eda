"use strict";
if (!globalThis.AtriumBase64 && typeof require === "function") require("../core/base64.js");
// AtriumCollabTransport: end-to-end encrypted messaging for live sessions (docs/collaboration.md).
// Lazy; loaded only when the user starts or joins a live session.
//
// Paths. A self-hosted relay (collab/relay/waffle_relay.py, the address in Preferences ›
// Collaboration) introduces the people in a room and carries their messages when nothing better
// works. Each pair of editors then tries a WebRTC data channel: directly, or through the TURN server
// that runs beside the relay (deploy/collab-server). The relay over WebSocket stays as the last
// fallback, and is the only path where WebRTC is unavailable (onState("rtc", false)). "local" uses a
// BroadcastChannel between windows of this browser profile (and the tests). Nothing is contacted
// unless the user enters a relay address.
//
// Keys. The room key is a secret the participants share out of band, in an invitation link's
// fragment (after #, never sent to a server) or as text, together with a random per-session salt.
// PBKDF2-SHA-256 (310,000 rounds, that salt) stretches it; HKDF derives a relay join token, the room
// id = SHA-256(join token) and one AES-256-GCM key per sender (info names the sender's peer id), so
// a reused room key never meets an earlier session's traffic and no two senders share a key. The
// relay checks that a joining connection knows the token for the room id (a private relay also
// wants a personal host token to open a room; guests never need one). It sees ciphertext, sizes,
// room ids and connection addresses only. A host vouches to the relay for each member that proved
// it holds the room key ({t:"attest"}); only vouched members get TURN credentials. WebRTC offers, answers and
// candidates are sealed too, so only room members can negotiate a channel.
//
// Identity. Each editor makes an ECDSA P-256 key pair per session; its peer id is a hash of the
// public key. After joining, it signs (room, its relay connection id) and sends that proof first.
// Others bind the connection to the peer id only with a valid signature, and accept an envelope
// only from the connection bound to its sender. So a participant cannot speak, or edit, as
// someone else, and the host named in an invitation (its peer id) cannot be impersonated.
//
// Frame: "<protocol>:<sender peer id>.<base64 iv|ciphertext>", the envelope {p: sender, s: sequence,
// t: kind, b: body} inside. The additional data binds the room id and the sender. A different
// protocol number is reported (onState("incompatible")), never guessed at.
// Budgets: bytes waiting to be decrypted, held for a path marker or for a proof are bounded per
// connection, and a connection over its rate is dropped before decryption. A per-sender sequence drops replays and duplicates. Moving a link from the
// relay to a data channel waits for a "path" marker sent through the relay, so messages stay in
// order. Incoming traffic is rate limited per sender. Bodies over CHUNK bytes travel in numbered
// chunks; data-channel frames are split again to fit the channel's message size. Each link has its
// own queue: a stalled peer never holds back the others.
//
//   const t = await AtriumCollabTransport.connect({url, roomKey, onMessage(kind, body, from, info), onState(state, detail)})
//   t.send(kind, body)        // body.to (a peer id) addresses one peer; otherwise everyone
//   t.peer, t.room, t.state, t.paths(), t.joined(), t.wake(), t.close()
//
// Bad networks. The relay socket's keepalive is answered, so a stalled socket is found within two
// beats (BEAT) and replaced; reconnecting retries about once a second, and at once on wake().
// Messages for everyone wait in the relay queue while disconnected. Working data channels outlive the
// relay connection at both ends (state stays "open" while one works): an editor that reconnects with
// a new connection id proves who it is, and its channel moves to that id.
//   AtriumCollabTransport.newRoomKey(), invitation({relay, roomKey, host}), parseInvitation(text)
globalThis.AtriumCollabTransport = (() => {
  const G = globalThis;
  const ITERATIONS = 310000, SALT = "atrium-collab-v1";
  const MAX_BODY = 8 * 1024 * 1024, CHUNK = 256 * 1024, MAX_CHUNKS = 64;
  const RATE = {window: 10000, messages: 600, bytes: 32 * 1024 * 1024, penalty: 30000};
  const KINDS = new Set(["hello", "want", "snapshot", "ops", "cursor", "bye", "chunk", "restore", "group-library"]);
  // Earlier peers retain fewer CRDT register writers and can disagree after undo.
  const PROTOCOL = 4, MIN_MANUAL_KEY = 24, INBOX_BYTES = 24 * 1024 * 1024, PENDING_BYTES = 2 * 1024 * 1024, HELD_BYTES = 32 * 1024 * 1024;
  const CONTROL = new Set(["id", "path"]);
  // Liveness of the relay socket, on its keepalive: one timer per BEAT. A beat that finds the socket
  // quiet for half a beat sends {t:"p"}, which the relay answers; a socket that hears nothing for the
  // whole next beat and is not draining is dead and is replaced, so a stalled link is found within
  // two beats. A relay that never answers (an older one) gets the old keepalive every KEEPALIVE. Data
  // channels carry the session's own heartbeat (collab-presence.js, 20 s). wake() (a network change,
  // the window back on screen) probes at once, or redials at once when disconnected.
  const KEEPALIVE = 45000, BEAT = 4000, PROBE = 2000, BARRIER_WAIT = 10000, LINK_HIGH = 1024 * 1024, LINK_LOW = 256 * 1024, LINK_STALL = 64 * 1024 * 1024;
  // Reconnecting: about once a second for RETRY_FAST attempts, then doubling to RETRY_MAX; an attempt
  // that has not joined within DIAL_WAIT is abandoned. While disconnected, messages for everyone wait
  // in the relay queue up to OFFLINE_QUEUE bytes (the session's catch-up covers anything beyond).
  const RETRY_FAST = 20, RETRY_MAX = 30000, DIAL_WAIT = 8000, OFFLINE_QUEUE = 8 * 1024 * 1024;
  // A ping's answer may wait behind what was sent before it: a socket that sent a lot is given the
  // time those bytes need at this rate (256 kbit/s), so a slow uplink in a large transfer is not dead.
  const SLOW_LINK = 32 * 1024;
  const RETRY = [20000, 60000, 180000];
  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  const {encode: b64, decode: unb64} = G.AtriumBase64;
  const b64url = bytes => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const subtle = () => { const s = G.crypto?.subtle; if (!s) throw Error("This window has no Web Crypto (a secure context is needed for live sessions)."); return s; };
  const PEER_ID = /^p[A-Za-z0-9_-]{22}$/;

  function newRoomKey() {
    const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", bytes = new Uint8Array(26);
    G.crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < bytes.length; i++) { out += A[bytes[i] % A.length]; if (i % 4 === 3 && i < bytes.length - 1) out += "-"; }
    return out.slice(0, 34);
  }
  const normalise = k => String(k || "").trim().replace(/\s+/g, "").toUpperCase();
  const relayAddress = u => /^wss?:\/\/[^\s/@?#]+(?:\/[^\s?#]*)?$/i.test(String(u || ""));

  // ---- invitations ------------------------------------------------------------------------------
  // A link https://relay.host/join#atrium=1&r=<relay>&k=<room key>&h=<host peer id>. The fragment
  // never reaches a server. The text form carries the same three values for chat or email.
  function invitation({relay, roomKey, host, salt}) {
    const key = normalise(roomKey);
    const lines = "\nRoom key: " + key + (salt ? "\nSession: " + salt : "") + (host ? "\nHost: " + host : "");
    if (!relayAddress(relay)) return {link: "", text: "Waffle live session (this computer only)" + lines};
    const base = relay.replace(/\/+$/, "").replace(/^ws/i, "http");
    const fragment = "atrium=1&r=" + encodeURIComponent(relay) + "&k=" + encodeURIComponent(key) + (salt ? "&s=" + salt : "") + (host ? "&h=" + host : "");
    return {link: base + "/join#" + fragment, text: "Waffle live session\nRelay: " + relay + lines + "\nIn Waffle: Share › Join, then paste this invitation."};
  }
  function parseInvitation(text) {
    const s = String(text || "").trim();
    if (!s || s.length > 4096) return null;
    let relay = "", roomKey = "", host = "", salt = "";
    const hash = s.indexOf("#");
    if (hash >= 0 && /(^|&)k=/.test(s.slice(hash + 1)) && !/\n/.test(s)) {
      const params = new URLSearchParams(s.slice(hash + 1));
      relay = params.get("r") || "";
      roomKey = params.get("k") || ""; host = params.get("h") || ""; salt = params.get("s") || "";
      if (!relay && /^https?:\/\//i.test(s)) relay = s.slice(0, hash).replace(/\/join\/?$/i, "").replace(/^http/i, "ws");
    } else {
      for (const line of s.split(/\r?\n/)) {
        const m = /^\s*(relay|room key|key|host|session)\s*:\s*(\S.*?)\s*$/i.exec(line);
        if (!m) continue;
        const k = m[1].toLowerCase();
        if (k === "relay") relay = m[2]; else if (k === "host") host = m[2]; else if (k === "session") salt = m[2]; else roomKey = m[2];
      }
    }
    roomKey = normalise(roomKey);
    if (roomKey.length < 16 || !/^[A-Z0-9-]{16,64}$/.test(roomKey)) return null;
    if (relay && !relayAddress(relay)) return null;
    if (host && !PEER_ID.test(host)) return null;
    if (salt && !/^[A-Za-z0-9_-]{16,64}$/.test(salt)) return null;
    return {relay: relay || "local", roomKey, host: host || null, salt: salt || null};
  }
  // A host invitation for a private relay (waffle-collab add-host): https://server/host#atrium-host=1&r=<relay>&t=<token>&n=<name>.
  function parseHostInvitation(text) {
    const s = String(text || "").trim(), hash = s.indexOf("#");
    if (hash < 0 || s.length > 2048 || !/^atrium-host=1&/.test(s.slice(hash + 1))) return null;
    const q = new URLSearchParams(s.slice(hash + 1)), relay = q.get("r") || "", token = q.get("t") || "";
    if (!relayAddress(relay) || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
    return {relay, token, name: String(q.get("n") || "").slice(0, 64)};
  }

  // ---- keys ---------------------------------------------------------------------------------------
  // Room key (+ session salt) -> {room (hex id), auth (hex token), hk (HKDF base for sender keys)}.
  async function keys(roomKey, salt) {
    const k = normalise(roomKey);
    if (k.replace(/-/g, "").length < (salt ? 16 : MIN_MANUAL_KEY)) throw Error("Use a room key of at least " + MIN_MANUAL_KEY + " characters (Generate makes one).");
    const S = subtle();
    const base = await S.importKey("raw", enc.encode(k), "PBKDF2", false, ["deriveBits"]);
    const master = await S.deriveBits({name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt ? "atrium-collab-v3|" + salt : SALT), iterations: ITERATIONS}, base, 256);
    const hk = await S.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"]);
    const auth = await S.deriveBits(hkdf("waffle-collab/relay-auth"), hk, 256);
    const room = hex(await S.digest("SHA-256", auth));
    return {room, auth: hex(auth), hk, senders: new Map()};
  }
  const hkdf = s => ({name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(s)});
  const newSalt = () => b64url(G.crypto.getRandomValues(new Uint8Array(16)));
  // One AES-GCM key per sender: random IVs never collide across senders sharing a key.
  function senderKey(k, sender) {
    let key = k.senders.get(sender);
    if (!key) {
      if (k.senders.size > 1024) k.senders.clear();
      key = subtle().deriveKey(hkdf("waffle-collab/aes-gcm/" + sender), k.hk, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
      k.senders.set(sender, key);
    }
    return key;
  }
  async function seal(k, obj, context = "", sender = obj?.p) {
    if (!PEER_ID.test(sender || "")) throw Error("sender");
    const iv = G.crypto.getRandomValues(new Uint8Array(12));
    const data = await subtle().encrypt({name: "AES-GCM", iv, additionalData: enc.encode(context + k.room + "|" + sender)}, await senderKey(k, sender), enc.encode(JSON.stringify(obj)));
    const out = new Uint8Array(12 + data.byteLength); out.set(iv); out.set(new Uint8Array(data), 12);
    return PROTOCOL + ":" + sender + "." + b64(out);
  }
  const frameOf = text => /^(\d{1,4}):(p[A-Za-z0-9_-]{22})\./.exec(text);
  async function open(k, text, context = "") {
    if (typeof text !== "string" || text.length > MAX_BODY * 1.4) throw Error("too large");
    const f = frameOf(text);
    if (!f) throw Error("frame");
    if (+f[1] !== PROTOCOL) throw Object.assign(Error("protocol " + f[1]), {protocol: +f[1]});
    const u = unb64(text.slice(f[0].length));
    if (u.length < 29) throw Error("short");
    const plain = await subtle().decrypt({name: "AES-GCM", iv: u.subarray(0, 12), additionalData: enc.encode(context + k.room + "|" + f[2])}, await senderKey(k, f[2]), u.subarray(12));
    const m = JSON.parse(dec.decode(plain));
    if (m && typeof m === "object" && "p" in m && m.p !== f[2]) throw Error("sender");
    return m;
  }

  // This editor's identity for one session: an ECDSA key pair and the peer id derived from it. A
  // rejoin of the same session from this window keeps it (and its message sequence), so it stays one author.
  const identities = new Map();
  async function identity() {
    const S = subtle(), pair = await S.generateKey({name: "ECDSA", namedCurve: "P-256"}, false, ["sign", "verify"]);
    const raw = new Uint8Array(await S.exportKey("raw", pair.publicKey));
    return {pair, raw: b64(raw), peer: await peerOf(raw)};
  }
  async function peerOf(raw) { return "p" + b64url(new Uint8Array(await subtle().digest("SHA-256", raw)).subarray(0, 16)); }
  const proofText = (room, cid) => enc.encode("atrium-peer-v1|" + room + "|" + cid);
  async function verifyProof(room, cid, body) {
    if (!body || typeof body.key !== "string" || typeof body.sig !== "string" || body.key.length > 200 || body.sig.length > 200) return null;
    const raw = unb64(body.key), S = subtle();
    const key = await S.importKey("raw", raw, {name: "ECDSA", namedCurve: "P-256"}, false, ["verify"]);
    const ok = await S.verify({name: "ECDSA", hash: "SHA-256"}, key, unb64(body.sig), proofText(room, cid));
    return ok ? peerOf(raw) : null;
  }

  // ---- WebRTC availability -------------------------------------------------------------------------
  // WKWebView (macOS 11+) and WebView2 provide RTCPeerConnection; WebKitGTK only when built with
  // WebRTC and enabled (native/linux/waffle.py). Without it every link uses the relay.
  const rtcAvailable = (o = {}) => typeof (o.RTCPeerConnection || G.RTCPeerConnection) === "function";

  // ---- the session ---------------------------------------------------------------------------------
  async function connect(o) {
    const k = await keys(o.roomKey, o.salt);
    // o.persist: this window's session identity (collab-presence.js); tools and tests make fresh ones.
    if (o.persist && !identities.has(k.room)) identities.set(k.room, identity());
    const me = await (o.persist ? identities.get(k.room) : identity());

    const peer = me.peer, url = String(o.url || "local").trim(), local = url === "local";
    if (!local && !relayAddress(url)) throw Error("Enter a relay address such as wss://collab.example.org (Preferences › Collaboration).");
    const RTC = o.RTCPeerConnection || G.RTCPeerConnection, WS = o.WebSocket || G.WebSocket;
    const mode = o.path === "relay" || o.path === "turn" ? o.path : "auto";
    const useRTC = !local && mode !== "relay" && typeof RTC === "function";
    // Liveness and reconnect timing; o.beat (tests) scales all of it.
    const scale = (o.beat || BEAT) / BEAT, beatMs = BEAT * scale, probeMs = PROBE * scale, dialMs = DIAL_WAIT * scale, retryMs = 1000 * scale;
    const keepMs = KEEPALIVE * scale, offlineQueue = o.offlineQueue || OFFLINE_QUEUE;
    let closed = false, cid = null, ice = [], iceAt = 0, iceTtl = 3600e3;
    const last = new Map(), rate = new Map(), chunks = new Map();
    const peerOfCid = new Map(), cidOfPeer = new Map(), pending = new Map(), links = new Map();
    const stats = {sent: 0, received: 0, dropped: 0, bad: 0, relayed: 0, direct: 0, stalls: 0, kept: 0};
    const t = {peer, room: k.room, state: "connecting", stats, rtc: typeof RTC === "function", owner: false};
    const now = () => G.performance?.now?.() ?? Date.now();
    const onState = (s, d) => {
      if (!["peers", "path", "flood", "left", "resync", "rtc", "incompatible"].includes(s)) t.state = s;
      try { o.onState?.(s, d); } catch (e) { G.console?.error?.(e); }
    };

    // ---- receiving ----------------------------------------------------------------------------------
    function limited(from, size) {
      const at = Date.now();
      let r = rate.get(from);
      if (!r || at - r.start > RATE.window) { r = {start: at, n: 0, bytes: 0, until: r?.until || 0}; rate.set(from, r); }
      if (r.until > at) return true;
      r.n++; r.bytes += size;
      if (r.n > RATE.messages || r.bytes > RATE.bytes) { r.until = at + RATE.penalty; onState("flood", {peer: from}); return true; }
      return false;
    }
    // Messages from one connection are handled strictly in arrival order (Web Crypto settles out of order).
    const inbox = [], waiting = new Map(), gate = new Map();
    let reading = false;
    // Before any decryption: each connection has a byte budget in this queue and a rate (twice the
    // per-sender rate); a connection over either is dropped (a data channel is closed).
    function receive(text, from, via) {
      if (closed) return;
      const size = text.length, used = (waiting.get(from) || 0) + size;
      const r = gate.get(from) || {start: 0, n: 0, bytes: 0};
      const at = Date.now();
      if (at - r.start > RATE.window) Object.assign(r, {start: at, n: 0, bytes: 0});
      r.n++; r.bytes += size; gate.set(from, r);
      if (used > INBOX_BYTES || r.n > 2 * RATE.messages || r.bytes > 2 * RATE.bytes) {
        stats.dropped++;
        const L = links.get(from);
        if (L && via !== "relay") closeLink(L, true);
        return;
      }
      waiting.set(from, used);
      inbox.push([text, from, via]);
      if (!reading) drain();
    }
    async function drain() {
      reading = true;
      try {
        while (inbox.length && !closed) {
          const [text, from, via] = inbox.shift();
          waiting.set(from, Math.max(0, (waiting.get(from) || 0) - text.length));
          try { await up(text, from, via); } catch (e) { G.console?.warn?.("Could not read collaboration message", e.message); }
        }
      } finally { reading = false; }
    }
    async function up(text, from, via) {
      // A data channel's messages wait for the "path" marker its sender put on the relay.
      const link = links.get(from);
      if (via === "direct" && link && !link.barrier) {
        link.held.push(text); link.heldBytes = (link.heldBytes || 0) + text.length;
        if (link.held.length > 4096 || link.heldBytes > HELD_BYTES) { link.held.length = 0; link.heldBytes = 0; closeLink(link, true); return; }
        if (!link.heldTimer) link.heldTimer = setTimeout(() => { link.heldTimer = 0; link.barrier = true; release(link); }, BARRIER_WAIT);
        return;
      }
      let m;
      try { m = await open(k, text); }
      catch (e) {   // not our room key, tampered, or another protocol
        stats.bad++;
        if (e.protocol && !t.incompatible) { t.incompatible = e.protocol; onState("incompatible", {protocol: e.protocol, ours: PROTOCOL}); }
        return;
      }
      if (closed) return;
      if (!m || typeof m.p !== "string" || !PEER_ID.test(m.p) || m.p === peer || !Number.isSafeInteger(m.s) || !(KINDS.has(m.t) || CONTROL.has(m.t))) { stats.bad++; return; }
      if (m.t === "id") return bind(m, from);
      const bound = peerOfCid.get(from);
      if (bound !== m.p) {
        // A connection speaks only after proving who it is; keep a few of its early messages.
        if (!bound) {
          const queue = pending.get(from) || [];
          queue.bytes = (queue.bytes || 0) + text.length;
          if (queue.length < 256 && queue.bytes <= PENDING_BYTES) { queue.push([text, via]); pending.set(from, queue); }
          else stats.dropped++;
        } else stats.bad++;
        return;
      }
      if (m.s <= (last.get(m.p) || 0)) { stats.dropped++; return; }   // replay or duplicate
      last.set(m.p, m.s);
      if (m.t === "path") {
        if (link && via === "relay" && m.b?.via === "direct") { link.barrier = true; release(link); }
        return;
      }
      if (limited(m.p, text.length)) { stats.dropped++; return; }
      if (via === "relay") stats.relayed++; else stats.direct++;
      if (m.t === "chunk") return chunk(m);
      stats.received++;
      deliver(m.t, m.b, m.p);
    }
    function deliver(kind, body, from) {
      try { o.onMessage(kind, body, from, {host: !!o.host && from === o.host}); } catch (e) { G.console?.warn?.("Collaboration message rejected:", e.message); }
    }
    async function bind(m, from) {
      const who = await verifyProof(k.room, from, m.b).catch(() => null);
      if (closed) return;
      if (who !== m.p) { stats.bad++; return; }
      if (peerOfCid.get(from) && peerOfCid.get(from) !== who) { stats.bad++; return; }
      // The same editor on a new relay connection. A data channel to it that still works is kept and
      // answers to the new connection; anything else starts over.
      const old = cidOfPeer.get(who), K = old && old !== from ? links.get(old) : null;
      if (K?.ready) migrate(K, from);
      else if (old && old !== from) { peerOfCid.delete(old); closeLink(K); chunks.delete(who); }
      peerOfCid.set(from, who); cidOfPeer.set(who, from);
      // A channel offer waits for the proof while kept channels may already reach this editor.
      const L = links.get(from);
      if (L?.deferred) { L.deferred = false; if (!L.ready) negotiate(L); }
      // As the room's owner, vouch to the relay that this connection holds the room key (TURN).
      if (t.owner && joined && !local) raw({t: "attest", id: from});
      // The proof needs no sequence check (its signature names this connection); messages this
      // connection sealed before it may still be waiting, in order, below.
      const early = pending.get(from) || [];
      pending.delete(from);
      onState("peers", {peers: cidOfPeer.size});
      for (const [queued, via] of early) await up(queued, from, via);
    }
    function chunk(m) {
      const b = m.b;
      if (!b || typeof b.id !== "string" || b.id.length > 40 || !Number.isInteger(b.i) || !Number.isInteger(b.n) || b.n < 1 || b.n > MAX_CHUNKS || b.i < 0 || b.i >= b.n || typeof b.d !== "string" || !KINDS.has(b.t) || b.t === "chunk") return;
      // Reassembly is per sender (two transfers at most, MAX_BODY in all): nobody can evict another's.
      let mine = chunks.get(m.p);
      if (!mine) { mine = new Map(); chunks.set(m.p, mine); }
      let c = mine.get(b.id);
      if (!c) { if (mine.size >= 2) mine.delete(mine.keys().next().value); c = {parts: new Array(b.n), got: 0, size: 0, t: b.t}; mine.set(b.id, c); }
      if (c.parts.length !== b.n || c.parts[b.i] != null) return;
      c.parts[b.i] = b.d; c.got++; c.size += b.d.length;
      let total = 0; for (const x of mine.values()) total += x.size;
      if (c.size > MAX_BODY || total > MAX_BODY * 1.25) { mine.delete(b.id); return; }
      if (c.got === b.n) {
        mine.delete(b.id);
        let body; try { body = JSON.parse(c.parts.join("")); } catch { stats.bad++; return; }
        stats.received++;
        deliver(c.t, body, m.p);
      }
    }

    // ---- sending ------------------------------------------------------------------------------------
    // Sends are sealed in order; each sealed envelope goes to every link's own queue.
    let chain = Promise.resolve(), queuedPoint = null;
    function post(kind, body, to) {
      if (closed) return chain;
      const point = kind === "cursor" && body?.posOnly === true;
      // While encryption is busy keep just the latest consecutive waypoint. Full
      // presence, edits and stops retain their order and always reach the carrier.
      if (point && queuedPoint && queuedPoint.body.doc === body.doc && (!queuedPoint.body.turn || body.turn)) {
        queuedPoint.body = body;
        if (body.end) queuedPoint = null;
        return chain;
      }
      const frame = {body};
      queuedPoint = point && !body.end ? frame : null;
      chain = chain.then(async () => {
        if (queuedPoint === frame) queuedPoint = null;
        if (closed) return;
        const text = await seal(k, {p: peer, s: me.seq = (me.seq || 0) + 1, t: kind, b: frame.body}, "", peer);
        if (!closed) { stats.sent++; route(text, to, point && !frame.body.end); }
      }).catch(e => { if (!closed) onState("error", e.message); });
      return chain;
    }
    // to: a peer id (one recipient), a connection id list (control messages) or nothing (everyone).
    function route(text, to, transient) {
      if (local) { carrier?.send(text); return; }
      let targets = null;
      if (Array.isArray(to)) targets = to;
      else if (typeof to === "string" && cidOfPeer.has(to)) targets = [cidOfPeer.get(to)];
      const relay = [];
      if (targets) { for (const c of targets) { const L = links.get(c); if (L?.ready) linkSend(L, text, transient); else relay.push(c); } }
      else {
        let direct = 0;
        for (const L of links.values()) { if (L.ready) { linkSend(L, text, transient); direct++; } else relay.push(L.cid); }
        if (!direct) { relaySend(text, null, transient); return; }   // nobody direct: one broadcast also reaches newcomers
      }
      if (relay.length) relaySend(text, relay, transient);
    }
    t.send = (kind, body) => {
      if (!KINDS.has(kind)) throw Error("Unknown message kind.");
      const text = JSON.stringify(body ?? null), to = typeof body?.to === "string" ? body.to : undefined;
      if (text.length > MAX_BODY) throw Error("The message is too large to send.");
      if (text.length <= CHUNK) return post(kind, body, to);
      const id = hex(G.crypto.getRandomValues(new Uint8Array(6))), n = Math.ceil(text.length / CHUNK);
      if (n > MAX_CHUNKS) throw Error("The message is too large to send.");
      let p;
      for (let i = 0; i < n; i++) p = post("chunk", {id, i, n, t: kind, d: text.slice(i * CHUNK, (i + 1) * CHUNK)}, to);
      return p;
    };
    const control = (kind, body, to) => post(kind, body, to);

    // ---- the relay socket -------------------------------------------------------------------------
    // One paced queue. The relay admits 24 MiB and 400 messages per 10 s per connection (and slows a
    // faster sender); stay under that and let the socket's buffer drain. Entries: {f: the frame,
    // all: a message for everyone, which stays queued across a reconnect}.
    let ws = null, joined = false, attempts = 0, retryTimer = 0, keepTimer = 0, pumpTimer = 0, refused = "";
    let relayQueue = [], queued = 0, sentBytes = 0;
    // Liveness: lastIn (anything heard), pingAt (an unanswered ping), owed (bytes sent since we last
    // heard anything, when the ping went: its answer may wait behind them, at SLOW_LINK at least).
    let dialAt = 0, lastIn = 0, pingAt = 0, echo = null, silent = 0, outBytes = 0, outAtIn = 0, owed = 0;
    const sent = [], windowMs = 10250, maxBytes = 20 * 1024 * 1024, maxFrames = 320;
    const kept = () => { for (const L of links.values()) if (L.ready) return true; return false; };
    function enqueue(f, all, first = false) {
      if (first) relayQueue.unshift({f, all}); else relayQueue.push({f, all});
      queued += f.length;
      // Disconnected: the oldest messages give way (the session's catch-up sends their edits again).
      while (!joined && queued > offlineQueue && relayQueue.length > 1) queued -= relayQueue.shift().f.length;
      pump();
    }
    function relaySend(text, to, transient) {
      if (local) return;
      if (transient && (!joined || ws?.bufferedAmount >= CHUNK || relayQueue.length)) return;
      enqueue(JSON.stringify(to ? {t: "m", d: text, to} : {t: "m", d: text}), !to);
    }
    function raw(obj) { enqueue(JSON.stringify(obj), false); }
    function pump() {
      if (pumpTimer || closed) return;
      while (relayQueue.length && joined && ws?.readyState === 1) {
        const at = now();
        while (sent.length && at - sent[0].at >= windowMs) sentBytes -= sent.shift().bytes;
        const frame = relayQueue[0].f;
        let delay = 0;
        if (sent.length >= maxFrames || sentBytes + frame.length > maxBytes) delay = Math.ceil(sent[0].at + windowMs - at);
        if (ws.bufferedAmount >= 4 * CHUNK) delay = Math.max(delay, 25);
        if (delay > 0) { pumpTimer = setTimeout(() => { pumpTimer = 0; pump(); }, delay); return; }
        relayQueue.shift(); queued -= frame.length;
        ws.send(frame); sent.push({at, bytes: frame.length}); sentBytes += frame.length; outBytes += frame.length;
      }
    }
    // The session's one steady timer. The keepalive's beat (BEAT above) also runs the session's own
    // heartbeat (o.onBeat, every o.heartbeat ms), so nothing else wakes the window while nobody moves.
    // While dialing, it abandons an attempt that has not joined; without a relay socket the retry
    // timer and, in a local session, a plain heartbeat timer stand in.
    let beatAt = now(), pingedAt = 0;
    const heartbeatMs = o.onBeat ? Math.max(beatMs, +o.heartbeat || 20000) : Infinity;
    function heartbeat(at = now()) {
      if (at - beatAt < heartbeatMs - beatMs / 2 || closed) return;
      beatAt = at;
      try { o.onBeat(); } catch (e) { G.console?.error?.(e); }
    }
    function beat() {
      clearTimeout(keepTimer); keepTimer = 0;
      if (closed) return;
      const sock = ws, at = now();
      heartbeat(at);
      if (closed) return;   // the heartbeat may have ended the session
      if (local) { if (heartbeatMs < Infinity) keepTimer = setTimeout(beat, heartbeatMs); return; }
      if (!sock || ws !== sock) return;
      if (!joined) {
        if (at - dialAt >= dialMs) { detach(sock); ws = null; retry(); }
        else keepTimer = setTimeout(beat, dialMs - (at - dialAt));
        return;
      }
      if (pingAt && lastIn < pingAt) {   // nothing heard since the last ping
        // The answer may still wait behind what was sent before the ping (the bytes sent since we
        // last heard anything, at a slow uplink's rate): give it that long. (The socket's own buffer
        // is no guide: the system takes bytes into its buffers while the link is dead.)
        const busy = at - pingAt < owed / SLOW_LINK * 1000;
        if (echo === true && !busy) { stats.stalls++; detach(sock); lost(); return; }
        if (echo === true) { keepTimer = setTimeout(beat, beatMs); return; }
        if (echo === null && ++silent >= 3) echo = false;   // a relay that does not answer pings
      }
      pingAt = 0;
      // An older relay that never answers gets the old keepalive; the beat still keeps the heartbeat.
      const ping = echo === false ? at - pingedAt >= keepMs && !relayQueue.length : at - lastIn >= beatMs / 2;
      if (sock.readyState === 1 && ping) { sock.send('{"t":"p"}'); pingAt = pingedAt = at; owed = outBytes - outAtIn; }
      keepTimer = setTimeout(beat, echo === false ? Math.min(keepMs, heartbeatMs) : beatMs);
    }
    function detach(sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try { sock.close(); } catch { /* closing */ }
    }
    async function joinedRelay(m, sock) {
      cid = String(m.id); t.owner = m.owner === true;
      ice = Array.isArray(m.ice) ? m.ice : []; iceAt = Date.now(); iceTtl = (+m.ttl || 3600) * 1000;
      joined = true; attempts = 0; sent.length = 0; sentBytes = 0;
      // Ask at once whether this relay answers the keepalive, so a stall right after a reconnect
      // (when traffic leaves no quiet beat to ask in) is still found.
      try { sock.send('{"t":"p"}'); pingAt = pingedAt = now(); owed = 0; } catch { /* closing */ }
      clearTimeout(keepTimer); keepTimer = setTimeout(beat, beatMs);
      const sig =b64(await subtle().sign({name: "ECDSA", hash: "SHA-256"}, me.pair.privateKey, proofText(k.room, cid)));
      if (closed || ws !== sock) return;
      t.proof = {key: me.raw, sig};
      // The proof goes out first, ahead of messages queued while disconnected (receivers hold a
      // connection's messages until it proves who it is). It takes no place in the sequence.
      const proof = await seal(k, {p: peer, s: me.seq = (me.seq || 0) + 1, t: "id", b: t.proof}, "", peer);
      if (closed || ws !== sock) return;
      stats.sent++;
      enqueue(JSON.stringify({t: "m", d: proof}), false, true);
      onState("open", {peers: (m.peers || []).length, rtc: typeof RTC === "function"});
      if (typeof RTC !== "function" && !local) onState("rtc", false);
      // Data channels that outlived the relay connection keep working. While there are any, an offer
      // to a connection waits for its proof: it may be one of those editors, on a new connection.
      const waitForProof = kept();
      for (const other of m.peers || []) if (typeof other === "string") addLink(other, true, waitForProof);
      pump();
    }
    function dial() {
      clearTimeout(retryTimer); retryTimer = 0;
      heartbeat();
      if (closed || ws) return;
      if (t.state !== "offline" && !kept()) onState("connecting");
      let sock;
      try { sock = ws = new WS(url); } catch (e) { ws = null; onState("error", e.message); retry(); return; }
      dialAt = lastIn = now(); pingAt = 0; echo = null; silent = 0;
      clearTimeout(keepTimer); keepTimer = setTimeout(beat, dialMs);
      sock.onopen = () => { if (closed) { sock.close(); return; } sock.send(JSON.stringify({t: "join", room: k.room, auth: k.auth, v: 2, own: o.owner || undefined, host: o.hostToken || undefined})); };
      sock.onmessage = ev => {
        if (closed || ws !== sock) return;
        lastIn = now(); outAtIn = outBytes;
        let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
        if (!m || typeof m !== "object") return;
        if (m.t === "p") { echo = true; return; }   // the keepalive's answer
        if (m.t === "joined" && !joined) {
          if (typeof m.id !== "string" || !Array.isArray(m.peers)) { closed = true; onState("error", "This relay is too old for this Waffle. Update collab/relay/waffle_relay.py on the server."); sock.close(); return; }
          joinedRelay(m, sock).catch(e => onState("error", e.message));
        } else if (!joined) {
          // Refused before joining (wrong key, a private relay without a host invitation, full): retrying would repeat it.
          if (m.t === "error") { refused = String(m.e || "The relay refused the connection.").slice(0, 200); onState("error", refused); }
        } else if (m.t === "m" && typeof m.d === "string" && typeof m.from === "string") receive(m.d, m.from, "relay");
        else if (m.t === "sig" && typeof m.d === "string" && typeof m.from === "string") signal(m.from, m.d);
        else if (m.t === "peer" && typeof m.id === "string") {
          if (m.joined) {
            // A newcomer offers to everyone; tell it who we are first (it missed our proof).
            if (t.proof) control("id", t.proof, [m.id]);
            addLink(m.id, false);
          } else left(m.id);
        } else if (m.t === "ice" && Array.isArray(m.ice)) {
          const first = !ice.some(s => s?.username);
          ice = m.ice; iceAt = Date.now(); iceTtl = (+m.ttl || 3600) * 1000;
          // TURN arrives once the host vouched for us: retry channels that did not connect without it.
          if (first && useRTC) for (const L of links.values()) if (!L.ready && !L.deferred && (L.initiator || cid < L.cid)) { L.attempt = 0; L.initiator = true; negotiate(L, true); }
        }
        else if (m.t === "error") onState("error", String(m.e || "Relay error").slice(0, 200));
      };
      sock.onclose = () => { if (ws === sock) lost(); };
      sock.onerror = () => { /* onclose follows */ };
    }
    // The relay connection is gone: closed, refused, or found dead by the keepalive.
    function lost() {
      const was = joined;
      ws = null; joined = false; cid = null; clearTimeout(pumpTimer); pumpTimer = 0; clearTimeout(keepTimer); keepTimer = 0;
      if (closed) return;
      if (refused && !was) { closed = true; onState("error", refused); return; }
      if (!was) { retry(); return; }   // a failed attempt: the state stays "offline" or "connecting"
      // A new connection id follows. Working data channels stay (the editors at their other end may
      // still be here, or come back on new connections: bind); everything else starts over and the
      // session resyncs on "open". Messages for everyone stay queued; replies, path markers and
      // catch-ups for one connection are made again after the resync.
      for (const L of [...links.values()]) if (!L.ready) forget(L.cid, false, true);
      pending.clear();
      relayQueue = relayQueue.filter(e => e.all); queued = relayQueue.reduce((n, e) => n + e.f.length, 0);
      if (kept()) { stats.kept++; onState("peers", {peers: cidOfPeer.size, relay: false}); }
      else onState("offline");
      retry(retryMs / 4);
    }
    function retry(ms) {
      clearTimeout(retryTimer);
      if (closed) return;
      const n = attempts++;
      retryTimer = setTimeout(dial, ms ?? Math.min(RETRY_MAX * scale, retryMs * 2 ** Math.max(0, n - RETRY_FAST)) * (0.75 + Math.random() / 2));
    }
    // At once rather than on the backoff: the network changed, or the window came back on screen
    // (after sleep). Joined: probe the socket. Disconnected: dial now.
    function wake() {
      if (closed || local) return;
      const at = now();
      if (joined) {
        if (echo === true && ws?.readyState === 1 && !pingAt) {
          ws.send('{"t":"p"}'); pingAt = at; owed = outBytes - outAtIn;
          clearTimeout(keepTimer); keepTimer = setTimeout(beat, probeMs);
        }
        return;
      }
      if (ws && at - dialAt < retryMs) return;   // an attempt has just started
      if (ws) { detach(ws); ws = null; }
      attempts = 0; dial();
    }
    // The relay says connection c left. A working data channel to it stays: that editor may only
    // have lost the relay, and comes back on a new connection (bind).
    function left(c) {
      const L = links.get(c);
      if (L?.ready) { L.orphan = true; return; }
      forget(c, true);
    }
    function forget(c, tell, quiet = false) {
      const who = peerOfCid.get(c);
      closeLink(links.get(c)); links.delete(c); pending.delete(c);
      if (who && cidOfPeer.get(who) === c) { cidOfPeer.delete(who); chunks.delete(who); if (tell) onState("left", {peer: who}); }
      waiting.delete(c); gate.delete(c);
      peerOfCid.delete(c);
      if (quiet) return;
      onState("peers", {peers: cidOfPeer.size, relay: joined || local});
      // The last channel that outlived the relay connection has gone too.
      if (!joined && !local && !kept() && t.state === "open") onState("offline");
    }
    // A working channel to an editor that now answers to relay connection c (bind checked its proof).
    function migrate(K, c) {
      const old = K.cid, P = links.get(c);
      if (P && P !== K) { clearTimeout(P.retry); clearTimeout(P.heldTimer); closePc(P); }
      links.delete(old); peerOfCid.delete(old); waiting.delete(old); gate.delete(old);
      for (const e of inbox) if (e[1] === old) e[1] = c;
      K.cid = c; K.orphan = false; links.set(c, K);
    }

    // ---- WebRTC links --------------------------------------------------------------------------------
    function addLink(c, initiator, waitForProof = false) {
      if (links.has(c) || c === cid) return links.get(c);
      const L = {cid: c, initiator, pc: null, dc: null, ready: false, barrier: false, held: [], heldTimer: 0, queue: [], queued: 0, frames: [], path: "relay", attempt: 0, retry: 0, candidates: []};
      links.set(c, L);
      if (useRTC && initiator) { if (waitForProof && !peerOfCid.has(c)) L.deferred = true; else negotiate(L); }
      return L;
    }
    function rtcConfig() {
      return {iceServers: ice.filter(s => s && (typeof s.urls === "string" || Array.isArray(s.urls))), iceTransportPolicy: mode === "turn" ? "relay" : "all"};
    }
    function newPeerConnection(L) {
      const pc = new RTC(rtcConfig()), dc = pc.createDataChannel("atrium", {negotiated: true, id: 0, ordered: true});
      L.pc = pc; L.dc = dc; L.ready = false; L.barrier = false;
      pc.onicecandidate = e => { if (e.candidate && L.pc === pc) sendSignal(L.cid, {c: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate}); };
      pc.onconnectionstatechange = () => {
        if (L.pc !== pc) return;
        if (pc.connectionState === "failed" || pc.connectionState === "closed") fallBack(L, true);
      };
      dc.binaryType = "arraybuffer";
      dc.bufferedAmountLowThreshold = LINK_LOW;
      dc.onbufferedamountlow = () => flush(L);
      dc.onopen = () => {
        if (L.dc !== dc || closed) return;
        // Everything already queued for this peer goes through the relay first, then the marker.
        control("path", {via: "direct"}, [L.cid]).then(() => {
          if (L.dc !== dc || dc.readyState !== "open") return;
          L.ready = true; L.attempt = 0;
          describePath(L);
          flush(L);
        });
      };
      dc.onclose = () => { if (L.dc === dc) fallBack(L, true); };
      dc.onmessage = e => frameIn(L, e.data);
      return pc;
    }
    async function negotiate(L, restart = false) {
      if (closed || !useRTC) return;
      try {
        // Credentials last iceTtl (1 h): refresh past half of it; a new offer then uses fresh ones.
        if (Date.now() - iceAt > iceTtl / 2 && joined) raw({t: "ice"});
        if (!L.pc || restart) { closePc(L); newPeerConnection(L); }
        const offer = await L.pc.createOffer();
        await L.pc.setLocalDescription(offer);
        sendSignal(L.cid, {sdp: {type: L.pc.localDescription.type, sdp: L.pc.localDescription.sdp}});
      } catch (e) { G.console?.warn?.("WebRTC offer failed:", e.message); fallBack(L, true); }
    }
    async function sendSignal(c, body) {
      if (closed || !joined) return;
      const d = await seal(k, {from: peer, to: c, ...body}, "sig|", peer);
      if (joined && ws?.readyState === 1) ws.send(JSON.stringify({t: "sig", to: c, d}));
    }
    async function signal(from, d) {
      let m;
      try { m = await open(k, d, "sig|"); } catch { stats.bad++; return; }
      if (closed || !m || m.to !== cid || frameOf(d)?.[2] !== m.from || (peerOfCid.get(from) && peerOfCid.get(from) !== m.from)) { stats.bad++; return; }
      if (!useRTC) return;
      const L = links.get(from) || addLink(from, false);
      if (Date.now() - iceAt > iceTtl / 2 && joined) raw({t: "ice"});
      try {
        if (m.sdp && (m.sdp.type === "offer" || m.sdp.type === "answer") && typeof m.sdp.sdp === "string" && m.sdp.sdp.length < 100000) {
          if (m.sdp.type === "offer") { closePc(L); newPeerConnection(L); }
          if (!L.pc) return;
          await L.pc.setRemoteDescription(m.sdp);
          for (const c of L.candidates.splice(0)) await L.pc.addIceCandidate(c).catch(() => {});
          if (m.sdp.type === "offer") {
            const answer = await L.pc.createAnswer();
            await L.pc.setLocalDescription(answer);
            sendSignal(from, {sdp: {type: L.pc.localDescription.type, sdp: L.pc.localDescription.sdp}});
          }
        } else if (m.c && typeof m.c === "object") {
          if (L.pc?.remoteDescription) await L.pc.addIceCandidate(m.c).catch(() => {});
          else if (L.candidates.length < 64) L.candidates.push(m.c);
        }
      } catch (e) { G.console?.warn?.("WebRTC negotiation failed:", e.message); fallBack(L, true); }
    }
    async function describePath(L) {
      let path = "direct";
      try {
        const report = await L.pc.getStats();
        let pair = null;
        report.forEach(s => { if (s.type === "transport" && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId); });
        if (!pair) report.forEach(s => { if (s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated || s.selected)) pair = s; });
        const localC = pair && report.get(pair.localCandidateId), remoteC = pair && report.get(pair.remoteCandidateId);
        if (localC?.candidateType === "relay" || remoteC?.candidateType === "relay") path = "turn";
      } catch { /* stats unavailable: still a data channel */ }
      if (!L.ready) return;
      L.path = path;
      onState("path", {peer: peerOfCid.get(L.cid) || null, via: path});
    }
    function closePc(L) {
      if (!L?.pc) return;
      const {pc, dc} = L;
      L.pc = L.dc = null; L.ready = false;
      try { dc?.close(); } catch { /* closing */ }
      try { pc.close(); } catch { /* closing */ }
    }
    // A broken or stalled channel: back to the relay, resync, and retry the channel later.
    function fallBack(L, retryLater) {
      if (!L || closed) return;
      // A channel that outlived the relay connection (ours or theirs) has no relay to fall back to.
      if (L.orphan || !joined && !local) { forget(L.cid, joined); return; }
      const was = L.ready;
      closePc(L);
      L.queue.length = 0; L.queued = 0; L.frames.length = 0;
      L.barrier = false; release(L);
      if (L.path !== "relay" || was) { L.path = "relay"; onState("path", {peer: peerOfCid.get(L.cid) || null, via: "relay"}); }
      if (was) onState("resync", {peer: peerOfCid.get(L.cid) || null});
      if (retryLater && useRTC && links.get(L.cid) === L && L.attempt < RETRY.length && cid < L.cid) {   // one side retries: no glare
        clearTimeout(L.retry);
        L.retry = setTimeout(() => { if (links.get(L.cid) === L && !L.pc) { L.initiator = true; negotiate(L, true); } }, RETRY[L.attempt++]);
      }
    }
    function closeLink(L, stalled = false) {
      if (!L) return;
      clearTimeout(L.retry); clearTimeout(L.heldTimer);
      if (stalled) { fallBack(L, true); return; }
      closePc(L); L.held.length = 0;
    }
    function release(L) {
      clearTimeout(L.heldTimer); L.heldTimer = 0;
      const held = L.held.splice(0);
      for (const text of held) inbox.push([text, L.cid, "direct-released"]);
      if (held.length && !reading) drain();
    }
    // Data channel frames: "F" whole, "P" part (more follow), "E" last part. Ordered and reliable.
    function linkSend(L, text, transient) {
      if (transient && (L.queued || (L.dc?.bufferedAmount ?? 0) > CHUNK)) return;
      const size = Math.max(1024, Math.min(Number(L.pc?.sctp?.maxMessageSize) || 65536, 65536) - 16);
      if (text.length <= size) L.queue.push("F" + text);
      else for (let i = 0; i < text.length; i += size) L.queue.push((i + size >= text.length ? "E" : "P") + text.slice(i, i + size));
      L.queued += text.length;
      if (L.queued > (o.linkStall || LINK_STALL)) { onState("flood", {peer: peerOfCid.get(L.cid) || null, stalled: true}); fallBack(L, true); return; }
      flush(L);
    }
    function flush(L) {
      const dc = L.dc;
      if (!dc || dc.readyState !== "open") return;
      try {
        while (L.queue.length && dc.bufferedAmount < LINK_HIGH) {
          const frame = L.queue.shift();
          L.queued -= frame.length - 1;
          dc.send(frame);
        }
      } catch { fallBack(L, true); }
    }
    function frameIn(L, data) {
      if (typeof data !== "string" || !data) return;
      const tag = data[0], body = data.slice(1);
      if (tag === "F") { if (!L.frames.length) receive(body, L.cid, "direct"); return; }
      L.frames.push(body);
      let size = 0; for (const f of L.frames) size += f.length;
      if (size > MAX_BODY * 1.4 + 1024) { L.frames.length = 0; return; }
      if (tag === "E") { const text = L.frames.join(""); L.frames.length = 0; receive(text, L.cid, "direct"); }
    }

    // ---- local carrier (BroadcastChannel) ---------------------------------------------------------
    let carrier = null;
    function localCarrier() {
      if (typeof G.BroadcastChannel !== "function") throw Error("This window cannot open a local session.");
      const ch = new G.BroadcastChannel("waffle-collab-" + k.room), mine = "L" + hex(G.crypto.getRandomValues(new Uint8Array(6)));
      cid = mine;
      ch.onmessage = ev => {
        const m = ev.data;
        if (!m || typeof m !== "object" || typeof m.c !== "string" || m.c === mine) return;
        // A newcomer missed our proof of identity: send it again.
        if (m.hi) { if (t.proof) control("id", t.proof); return; }
        if (typeof m.d === "string") receive(m.d, m.c, "relay");
      };
      return {send(text) { ch.postMessage({c: mine, d: text}); }, hello() { ch.postMessage({c: mine, hi: true}); }, close() { ch.close(); }};
    }

    // Retry at once when the network comes back (online) or the window does: AtriumPower reports the
    // page becoming visible and, in the macOS app, the window no longer occluded, as after a wake.
    let onScreen = G.AtriumPower?.visible?.() !== false;
    const onOnline = () => wake();
    const offPower = local ? null : G.AtriumPower?.onChange?.(s => { const was = onScreen; onScreen = s.visible !== false; if (onScreen && !was) wake(); });
    if (!local) G.addEventListener?.("online", onOnline);
    t.wake = wake;
    // Whether the relay connection is up (the session may still reach editors over data channels).
    t.joined = () => local || joined;
    t.close = () => {
      if (closed) return;
      closed = true; inbox.length = 0; chunks.clear(); queuedPoint = null;
      clearTimeout(retryTimer); clearTimeout(keepTimer); clearTimeout(pumpTimer);
      try { offPower?.(); G.removeEventListener?.("online", onOnline); } catch { /* gone */ }
      for (const L of links.values()) closeLink(L);
      links.clear();
      try { ws?.close(); } catch { /* closed */ }
      try { carrier?.close(); } catch { /* closed */ }
      onState("closed");
    };
    // Each connected peer's path: "direct", "turn", "relay" or "local".
    t.paths = () => {
      const out = new Map();
      for (const [who, c] of cidOfPeer) out.set(who, local ? "local" : links.get(c)?.ready ? links.get(c).path : "relay");
      return out;
    };
    t.connectionId = () => cid;
    if (o.cancelled?.()) { closed = true; try { offPower?.(); G.removeEventListener?.("online", onOnline); } catch { /* gone */ } return t; }
    if (local) {
      carrier = localCarrier();
      const sig = b64(await subtle().sign({name: "ECDSA", hash: "SHA-256"}, me.pair.privateKey, proofText(k.room, cid)));
      t.proof = {key: me.raw, sig};
      control("id", t.proof);
      carrier.hello();
      setTimeout(() => onState("open", {peers: 0, rtc: false}), 0);
      if (heartbeatMs < Infinity) keepTimer = setTimeout(beat, heartbeatMs);
    } else dial();
    return t;
  }
  return Object.freeze({connect, keys, newRoomKey, newSalt, normalise, seal, open, invitation, parseInvitation, parseHostInvitation, relayAddress, rtcAvailable, verifyProof,
    constants: Object.freeze({ITERATIONS, MAX_BODY, CHUNK, RATE, KEEPALIVE, BEAT, PROBE, DIAL_WAIT, PROTOCOL, MIN_MANUAL_KEY})});
})();
