"use strict";
// Pull causal pages from explicitly shared libraries over the existing authenticated live
// session. There is no timer. A join, reconnect or new local record announces availability.
// Persist a complete page before asking for the next one. Replaying any page is harmless.
globalThis.AtriumGroupSync = (() => {
  const LIMIT = 128, PAGE = 512 * 1024;
  function create({current, accept, send, offered, error}) {
    const reading = new Map(), offers = new Map(), outgoing = new Map(), sizes = new WeakMap();
    const traffic = new Map();
    // Request the next page after the transport's receive-rate window when necessary.
    // Local BroadcastChannel and direct WebRTC do not have the relay's outgoing pacer.
    async function pace(from, bytes, more) {
      const now = Date.now();
      let window = traffic.get(from);
      if (!window || now - window.start >= 10250) { window = {start: now, bytes: 0, messages: 0}; traffic.set(from, window); }
      window.bytes += bytes; window.messages += 4 + Math.ceil(bytes / (256 * 1024));
      if (more && (window.bytes >= 6 * 1024 * 1024 || window.messages >= 220)) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, Math.max(0, window.start + 10250 - Date.now()));
          window.wake = () => { clearTimeout(timer); resolve(); };
        });
        traffic.delete(from);
      }
    }
    const resetTraffic = () => { for (const window of traffic.values()) window.wake?.(); traffic.clear(); };
    const sizeOf = e => { if (!sizes.has(e)) sizes.set(e, JSON.stringify(e).length); return sizes.get(e); };
    let selected = null, closed = false, serial = Promise.resolve();
    const group = () => selected && current(selected);
    const post = (op, payload, to) => { if (!closed) send({op, ...payload, ...(to ? {to} : {})}); };
    const offer = to => { if (group()) post("offer", {library: group().info}, to); };
    const refresh = () => { reading.clear(); offers.clear(); outgoing.clear(); resetTraffic(); if (!closed) { post("find", {}); offer(); } };
    function select(id) { selected = id; refresh(); }
    const list = (from, at) => { reading.set(from, {at, again: reading.get(from)?.again}); post("list", {group: selected, at}, from); };
    function finish(from, msg) {
      const job = reading.get(from);
      if (!job) return;
      if (msg.next !== null) list(from, msg.next);
      else if (job.again) { reading.delete(from); list(from, 0); }
      else reading.delete(from);
    }
    async function receive(msg, from) {
      if (closed || !msg || !from) return;
      if (msg.op === "find") { offer(from); return; }
      if (msg.op === "offer") {
        const info = globalThis.AtriumGroupLibrary.groupInfo(msg.library);
        if (!offers.has(from) || offers.get(from).id !== info.id) { offers.set(from, info); offered?.(info, from); }
        if (info.id === selected) {
          if (reading.has(from)) reading.get(from).again = true;
          else list(from, 0);
        }
        return;
      }
      const g = group();
      if (!g || msg.group !== g.info.id || !Number.isSafeInteger(msg.at) || msg.at < 0 || msg.at > globalThis.AtriumGroupLibrary.MAX_EVENTS) return;
      const head = {group: selected, at: msg.at};
      if (msg.op === "list") {
        const ids = []; let size = 0;
        if (msg.at > g.shareable.size) return;
        for (const k of g.inventoryPage(msg.at, LIMIT)) {
          const n = sizeOf(g.events.get(k));
          if (ids.length && size + n > PAGE) break;
          ids.push(k); size += n;
        }
        post("inventory", {...head, ids, next: msg.at + ids.length < g.shareable.size ? msg.at + ids.length : null}, from);
        return;
      }
      if (msg.op === "want") {
        if (!Array.isArray(msg.ids) || !msg.ids.length || msg.ids.length > LIMIT) return;
        const items = []; let size = 0;
        for (const k of new Set(msg.ids)) {
          if (!g.shareable.has(k)) return;
          const e = g.events.get(k);
          size += sizeOf(e);
          if (items.length && size > PAGE) return;
          items.push(e);
        }
        if (size <= PAGE) post("records", {...head, items}, from);
        else {
          const e = items[0], offset = msg.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size || offset % PAGE) return;
          let part = outgoing.get(from);
          if (part?.key !== e.key) {
            part = {key: e.key, json: JSON.stringify(e)}; outgoing.set(from, part);
          }
          const data = part.json.slice(offset, offset + PAGE);
          post("piece", {...head, key: e.key, offset, data, total: size}, from);
          if (offset + data.length === size) outgoing.delete(from);
        }
        return;
      }
      const job = reading.get(from);
      if (!job || job.at !== msg.at) return;
      if (msg.op === "inventory") {
        if (job.want || !Array.isArray(msg.ids) || msg.ids.length > LIMIT || !msg.ids.every(k => typeof k === "string" && /^[0-9a-f]{64}$/.test(k)) ||
          !(msg.next === null || (msg.ids.length && msg.next === msg.at + msg.ids.length))) return;
        job.next = msg.next; job.want = [...new Set(msg.ids.filter(k => !g.events.has(k)))];
        if (job.want.length) post("want", {...head, ids: job.want}, from); else finish(from, job);
      } else if (msg.op === "piece" && job.want?.length === 1 && job.want[0] === msg.key) {
        if (!Number.isSafeInteger(msg.total) || msg.total <= PAGE || msg.total > globalThis.AtriumGroupLibrary.MAX_EVENT ||
          (job.total && msg.total !== job.total) || msg.offset !== (job.offset || 0) || typeof msg.data !== "string" ||
          msg.data.length !== Math.min(PAGE, msg.total - msg.offset)) return;
        job.total = msg.total; job.offset = msg.offset + msg.data.length;
        const held = [...reading.values()].reduce((n, j) => n + (j.offset || 0), 0);
        if (held > 64 * 1024 * 1024) throw Error("Too many large library revisions are arriving. Sync again.");
        (job.pieces ||= []).push(msg.data);
        if (job.offset < job.total) {
          await pace(from, msg.data.length * 3, true);
          if (reading.get(from) === job) post("want", {...head, ids: job.want, offset: job.offset}, from);
        }
        else {
          const e = JSON.parse(job.pieces.join(""));
          if (e.key !== msg.key) throw Error("The group revision identifier differs from its transfer.");
          await accept(g.info, [e], from);
          await pace(from, msg.data.length * 3, job.next !== null);
          if (!closed && reading.get(from) === job) finish(from, job);
        }
      } else if (msg.op === "records" && job.want && Array.isArray(msg.items) && msg.items.length === job.want.length &&
        msg.items.every((e, i) => e?.key === job.want[i])) {
        await accept(g.info, msg.items, from);
        await pace(from, msg.items.reduce((n, e) => n + sizeOf(e) * 3, 0), job.next !== null);
        if (!closed && group()?.info.id === msg.group && reading.get(from) === job) finish(from, job);
      }
    }
    return {select, refresh, announce(from) {
      // The source already has this page. Forward availability to other connected members.
      if (from) { for (const [peer, info] of offers) if (peer !== from && info.id === selected) offer(peer); }
      else offer();
    }, offers, selected: () => selected,
      receive(msg, from) {
        const task = serial.then(() => receive(msg, from));
        serial = task.catch(e => { reading.delete(from); error?.(e.message); }); return serial;
      },
      disconnect() { reading.clear(); offers.clear(); outgoing.clear(); resetTraffic(); },
      left(from) { reading.delete(from); offers.delete(from); outgoing.delete(from); traffic.get(from)?.wake?.(); traffic.delete(from); },
      close() { closed = true; selected = null; reading.clear(); offers.clear(); outgoing.clear(); resetTraffic(); }};
  }
  // A library-only room uses the same WebRTC, relay, crypto and peer verification as a live
  // project. Its invitation cannot be pasted into Share to request a project snapshot.
  function invitation(info, relay, key, salt, host) {
    return ["Waffle group library", "Group: " + info.name, "Library: " + info.id,
      ...(relay !== "local" ? ["Relay: " + relay] : []), "Library key: " + key, "Session: " + salt, "Host: " + host].join("\n");
  }
  function parseInvitation(value) {
    const raw = String(value || "").trim();
    if (raw.length > 4096 || !raw.startsWith("Waffle group library\n")) throw Error("Paste a group library invitation.");
    const fields = Object.fromEntries(raw.split(/\r?\n/).slice(1).map(line => {
      const i = line.indexOf(": "); return [line.slice(0, i), line.slice(i + 2)];
    }));
    const info = globalThis.AtriumGroupLibrary.groupInfo({id: fields.Library, name: fields.Group});
    const T = globalThis.AtriumCollabTransport, keys = T.parseInvitation(raw.replace(/^Library key:/m, "Room key:"));
    if (!keys?.host || !keys.salt) throw Error("This library invitation is incomplete.");
    return {info, ...keys};
  }
  async function room(info, invite, handlers) {
    const G = globalThis, T = G.AtriumCollabTransport, host = !invite;
    const relay = invite?.relay || G.AtriumPref?.get?.("collab.relay", "") || "local";
    const salt = invite?.salt || T.newSalt(), key = invite?.roomKey || T.newRoomKey();
    let token;
    if (host) try {
      const h = JSON.parse(G.localStorage?.getItem("atrium.collab.hostToken") || "null");
      if (h?.relay === relay && typeof h.token === "string") token = h.token;
    } catch { /* no host invitation */ }
    let t, closed = false;
    t = await T.connect({url: relay, roomKey: key, salt, host: invite?.host, hostToken: token, path: G.AtriumPref?.get?.("collab.path", "auto"),
      owner: host ? Array.from(G.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("") : undefined,
      onMessage(kind, body, from) {
        if (!closed && kind === "group-library" && body && (!body.to || body.to === t?.peer)) handlers.receive(body, from);
      }, onState(state, detail) {
        if (closed) return;
        if (state === "open" || state === "resync") handlers.opened();
        else if (state === "left") handlers.left(detail.peer);
        else if (state === "offline" || state === "error" || state === "ended") handlers.offline();
        handlers.state?.(state, detail);
      }});
    return {invitation: host ? invitation(info, relay, key, salt, t.peer) : null,
      send(body) { if (!closed && t.state === "open") return t.send("group-library", body); },
      close() { closed = true; t.close(); }};
  }
  return Object.freeze({create, room, parseInvitation});
})();
