"use strict";
// @ts-check
// Pairing codes: a live session between computers with no server (docs/collaboration.md, Other ways
// to connect). The host makes one code per guest: a WebRTC offer (all candidates gathered, no STUN or
// TURN) and the session's invitation, compressed. The guest answers with a reply code. The data
// channel between them then carries the guest's ordinary relay protocol (collab-transport.js): the
// host passes it to the session's relay server, or, in a session without one, to a small relay in
// the host's own window (hub). Everything on it stays end-to-end encrypted with the session key.
globalThis.AtriumCollabPair = (() => {
  const G = globalThis;
  const OFFER = "atrium-offer.", REPLY = "atrium-reply.", PIECE = 16 * 1024, GATHER = 3000;
  const MAX_CODE = 48 * 1024, MAX_JSON = 96 * 1024, MAX_MESSAGE = 2 * 1024 * 1024, STALL = 16 * 1024 * 1024, PEERS = 16;
  const hex = n => [...G.crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
  const b64u = bytes => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return G.btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64u = text => Uint8Array.from(G.atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

  async function through(stream, bytes, limit) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream)).body?.getReader();
    if (!out) throw Error("no stream");
    const parts = []; let size = 0;
    for (;;) {
      const {done, value} = await out.read();
      if (done) break;
      size += value.length;
      if (size > limit) { out.cancel(); throw Error("too large"); }
      parts.push(value);
    }
    const all = new Uint8Array(size); let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    return all;
  }
  // "atrium-offer.z.<base64url deflate-raw JSON>" ("j." where CompressionStream is missing).
  async function pack(prefix, obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof G.CompressionStream === "function") return prefix + "z." + b64u(await through(new G.CompressionStream("deflate-raw"), raw, MAX_JSON));
    return prefix + "j." + b64u(raw);
  }
  // Whitespace and line breaks a chat or e-mail adds are ignored.
  async function unpack(prefix, text) {
    const t = String(text || "").replace(/\s+/g, "");
    if (!t.startsWith(prefix) || t.length > MAX_CODE) throw Error(prefix === OFFER ? "That is not a pairing code." : "That is not a pairing reply.");
    const m = /^(z|j)\.([A-Za-z0-9_-]+)$/.exec(t.slice(prefix.length));
    if (!m) throw Error("The code is incomplete. Copy it again, whole.");
    try {
      let bytes = unb64u(m[2]);
      if (m[1] === "z") {
        if (typeof G.DecompressionStream !== "function") throw Error("This Waffle cannot read compressed codes.");
        bytes = await through(new G.DecompressionStream("deflate-raw"), bytes, MAX_JSON);
      }
      const o = JSON.parse(new TextDecoder().decode(bytes));
      if (!o || typeof o !== "object" || o.v !== 1 || typeof o.sdp !== "string" || o.sdp.length > MAX_JSON || !/^[0-9a-f]{8}$/.test(o.i)) throw Error("bad");
      return o;
    } catch (e) { throw Error(/cannot read/.test(e.message) ? e.message : "The code is damaged. Copy it again, whole."); }
  }
  // What a pasted text is: "offer" (a pairing code), "reply", or null.
  const kind = text => { const t = String(text || "").replace(/\s+/g, ""); return t.startsWith(OFFER) ? "offer" : t.startsWith(REPLY) ? "reply" : null; };

  function gathered(pc) {
    return new Promise(resolve => {
      if (pc.iceGatheringState === "complete") { resolve(); return; }
      const timer = setTimeout(resolve, GATHER);
      pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); } });
    });
  }
  function opened(dc, ms) {
    return new Promise((resolve, reject) => {
      if (dc.readyState === "open") { resolve(); return; }
      const timer = setTimeout(() => reject(Error("The other computer did not connect. Are both on the same network, or is one of them reachable?")), ms);
      dc.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      dc.addEventListener("close", () => { clearTimeout(timer); reject(Error("The pairing was closed.")); });
    });
  }
  // One message socket over a data channel: text of any size, in pieces ("+" more follows, "." last).
  function channelSocket(dc) {
    const s = {onmessage: null, onclose: null, get bufferedAmount() { return dc.bufferedAmount; },
      send(text) {
        if (dc.readyState !== "open") return;
        if (!text.length) { dc.send("."); return; }
        for (let i = 0; i < text.length; i += PIECE) dc.send((i + PIECE < text.length ? "+" : ".") + text.slice(i, i + PIECE));
      },
      close() { try { dc.close(); } catch { /* closed */ } }};
    let parts = [], size = 0;
    dc.onmessage = e => {
      const d = typeof e.data === "string" ? e.data : "";
      size += d.length;
      if (!d || size > MAX_MESSAGE) { s.close(); return; }
      parts.push(d.slice(1));
      if (d[0] === "+") return;
      const text = parts.join(""); parts = []; size = 0;
      s.onmessage?.(text);
    };
    dc.addEventListener("close", () => s.onclose?.());
    return s;
  }
  // Two connected sockets in this window (the host's own transport and the hub).
  function loop() {
    const a = {onmessage: null, onclose: null, bufferedAmount: 0, open: true, peer: null, send(t) { if (a.open) Promise.resolve().then(() => a.peer.open && a.peer.onmessage?.(t)); }, close() { if (!a.open) return; a.open = a.peer.open = false; Promise.resolve().then(() => { a.onclose?.(); a.peer.onclose?.(); }); }};
    const b = {...a, peer: a}; a.peer = b;
    b.send = t => { if (b.open) Promise.resolve().then(() => a.open && a.onmessage?.(t)); };
    b.close = () => a.close();
    return [a, b];
  }
  // A WebSocket look-alike for the transport (o.WebSocket): open(url): a socket, null when gone, or a
  // promise of either (the Windows host's socket, native/bridge.js lanSocket).
  function socketClass(open) {
    return class {
      constructor(url) {
        this.readyState = 0; this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
        const ready = s => {
          if (this.readyState === 3) { if (s && s !== opening) s.close(); return; }
          if (!s) { this.readyState = 3; this.onclose?.({}); return; }
          this.s = s; this.readyState = 1;
          s.onmessage = text => { if (this.readyState === 1) this.onmessage?.({data: text}); };
          s.onclose = () => { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({}); };
          this.onopen?.();
        };
        const opening = open(url);
        if (typeof opening?.then === "function") opening.then(ready, () => ready(null));
        else setTimeout(() => ready(opening), 0);
      }
      get bufferedAmount() { return this.s?.bufferedAmount || 0; }
      send(text) { if (this.readyState === 1) this.s.send(text); }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.s?.close(); setTimeout(() => this.onclose?.({}), 0); }
    };
  }
  // The relay of a session without a server: protocol 2 of collab/relay/waffle_relay.py, for at most
  // PEERS connections. It sees only ciphertext, like any relay.
  function hub(room, auth) {
    const members = new Map();
    let closed = false;
    function deliver(c, text) {
      const m = members.get(c);
      if (!m) return;
      if (m.sock.bufferedAmount > STALL) { m.sock.close(); return; }   // a guest that stopped reading
      m.sock.send(text);
    }
    const send = (c, obj) => deliver(c, JSON.stringify(obj));
    function attach(sock, owner = false) {
      if (closed) { sock.close(); return; }
      let id = null;
      sock.onmessage = text => {
        if (text.length > MAX_MESSAGE) { sock.close(); return; }
        let m; try { m = JSON.parse(text); } catch { return; }
        if (!m || typeof m !== "object") return;
        if (!id) {
          // The reason goes first; the channel closes once it is on its way.
          const refuse = e => { sock.send(JSON.stringify({t: "error", e})); sock.onmessage = null; setTimeout(() => sock.close(), 500); };
          if (m.t !== "join" || m.room !== room || m.auth !== auth) { refuse("The room key does not match this room."); return; }
          if (members.size >= PEERS && !owner) { refuse("This room is full."); return; }
          id = "c" + hex(8);
          const others = [...members.keys()];
          members.set(id, {sock, owner});
          sock.send(JSON.stringify({t: "joined", v: 2, id, peers: others, ice: [], ttl: 3600, owner}));
          for (const c of others) { send(c, {t: "peer", id, joined: true}); send(c, {t: "peers", n: members.size - 1}); }
          return;
        }
        if (m.t === "m" && typeof m.d === "string") {
          const out = JSON.stringify({t: "m", d: m.d, from: id});
          const to = Array.isArray(m.to) ? m.to.slice(0, 64).filter(c => c !== id && members.has(c)) : [...members.keys()].filter(c => c !== id);
          for (const c of to) deliver(c, out);
        } else if (m.t === "sig" && typeof m.d === "string" && m.d.length <= 64 * 1024 && typeof m.to === "string" && m.to !== id) send(m.to, {t: "sig", from: id, d: m.d});
        else if (m.t === "p") send(id, {t: "p"});   // the keepalive's answer, as the relay gives it
      };
      sock.onclose = () => {
        if (!id || !members.has(id)) return;
        members.delete(id);
        for (const c of members.keys()) { send(c, {t: "peer", id, joined: false}); send(c, {t: "peers", n: members.size - 1}); }
      };
    }
    return {
      attach, size: () => members.size,
      // The host's own transport: connect({WebSocket: hub.hostSocket}).
      hostSocket: socketClass(() => { if (closed) return null; const [mine, theirs] = loop(); attach(theirs, true); return mine; }),
      close() { closed = true; for (const m of members.values()) m.sock.close(); members.clear(); }
    };
  }
  // In a session with a relay server, a paired guest's protocol goes on to the relay unchanged.
  function forward(sock, url, WS = G.WebSocket) {
    const ws = new WS(url), early = [];
    let gone = false;
    const end = () => { if (gone) return; gone = true; try { ws.close(); } catch { /* closed */ } sock.close(); };
    ws.onopen = () => { for (const t of early.splice(0)) ws.send(t); };
    ws.onmessage = e => { if (typeof e.data === "string") { if (sock.bufferedAmount > STALL) end(); else sock.send(e.data); } };
    ws.onclose = end; ws.onerror = end;
    sock.onmessage = text => { if (ws.readyState === 1) ws.send(text); else if (early.length < 64) early.push(text); else end(); };
    sock.onclose = end;
  }

  const newPc = RTC => {
    if (typeof RTC !== "function") throw Error("Pairing needs WebRTC, which this window does not have.");
    const pc = new RTC({iceServers: []});
    return {pc, dc: pc.createDataChannel("atrium-pair", {negotiated: true, id: 1, ordered: true})};
  };
  // Host: one code for one guest. carry(sock): what to do with the guest's connection (hub.attach, or
  // forward to the relay). accept(reply) finishes the pairing.
  async function offer(invite, carry, RTC = G.RTCPeerConnection) {
    const {pc, dc} = newPc(RTC), id = hex(4);
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const code = await pack(OFFER, {v: 1, i: id, sdp: pc.localDescription.sdp, k: invite.roomKey, s: invite.salt || undefined, h: invite.host || undefined, n: invite.name || undefined, r: invite.relayed ? 1 : undefined});
    let done = false;
    return {code, id, pc,
      async accept(text) {
        if (done) throw Error("This pairing code was already used. Create a new one for each guest.");
        const r = await unpack(REPLY, text);
        if (r.i !== id) throw Error("This reply belongs to another pairing code.");
        done = true;
        await pc.setRemoteDescription({type: "answer", sdp: r.sdp});
        await opened(dc, 20000);
        carry(channelSocket(dc));
      },
      close() { try { pc.close(); } catch { /* closed */ } }};
  }
  // Guest: the reply code to send back, the invitation inside the code, and (once the host accepted)
  // a socket class for the transport.
  async function answer(text, RTC = G.RTCPeerConnection) {
    const o = await unpack(OFFER, text);
    if (typeof o.k !== "string" || o.k.length > 128 || (o.s !== undefined && !/^[A-Za-z0-9_-]{16,64}$/.test(o.s)) ||
        (o.h !== undefined && !/^p[A-Za-z0-9_-]{8,64}$/.test(o.h))) throw Error("The code is damaged. Copy it again, whole.");
    const {pc, dc} = newPc(RTC);
    await pc.setRemoteDescription({type: "offer", sdp: o.sdp});
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    const code = await pack(REPLY, {v: 1, i: o.i, sdp: pc.localDescription.sdp});
    let used = false;
    return {code, pc, dc, invite: {roomKey: o.k, salt: o.s || null, host: o.h || null, name: typeof o.n === "string" ? o.n.slice(0, 64) : "", relayed: o.r === 1},
      ready: opened(dc, 30 * 60 * 1000),
      // The transport connects once; when the channel closes the pairing is over.
      socket: socketClass(() => { if (used || dc.readyState !== "open") return null; used = true; return channelSocket(dc); }),
      onEnd(fn) { dc.addEventListener("close", fn); pc.addEventListener("connectionstatechange", () => { if (["failed", "closed"].includes(pc.connectionState)) fn(); }); },
      close() { try { pc.close(); } catch { /* closed */ } }};
  }
  return Object.freeze({kind, offer, answer, hub, forward, pack, unpack, channelSocket, socketClass, constants: Object.freeze({PIECE, GATHER, PEERS})});
})();
