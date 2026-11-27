"use strict";
// AtriumCollabPresence: what collaboration looks like (docs/collaboration.md). Lazy; collab-lock.js
// loads it once the editor is idle.
//
//   * Presence on the document tabs and the Projects tree: a small avatar initial for who
//     edits (holds the lock) or views each document.
//   * One non-blocking bar above the canvas: read-only ("Bob is editing…", Ask to Edit, Take
//     Over when stale), hand-over requests, a lock someone took, the file changing on disk
//     (Reload / Compare with Theirs) and a save stopped by a conflict.
//   * Project › Collaboration… (people, locks, Git LFS locks) and Preferences › Collaboration.
//   * AtriumCollabLive: the real-time co-editing prototype (off by default): live cursors with
//     names, colour-coded selections, follow mode, "Bob is routing GND", per-object soft locks
//     while someone drags, and per-user undo. AtriumCollabCRDT merges, AtriumCollabTransport
//     carries end-to-end encrypted messages: WebRTC data channels between editors, introduced by
//     the relay server set in Preferences (which also carries them when nothing else works).
//
// Trust. Every remote peer id is verified by the transport (a signature over its relay
// connection). A live edit must be its sender's own (AtriumCollabCRDT receive {author}). Only the
// host named in the invitation may send other people's edits (catch-up), a merge snapshot, or a
// shared-restore boundary; anyone else's copies of those are filtered to their own edits or ignored.
//
// Energy. No polling while nobody moves: presence heartbeats every 20 s on the transport's keepalive
// beat, its one steady timer (a peer is gone after 60 s or at once when the relay says it left), a
// 4 s lock heartbeat only while dragging, cursor waypoints only on movement. An unchanged cursor
// record and a heartbeat that changes nobody's presence repaint nothing.
//
// Bad networks. A guest's bounded CRDT log never drops its own edits before the host confirms them
// (the host's hello and heartbeat carry its version vector), so a guest that edits offline catches
// the host up when it returns; past UNSENT of them it says so plainly and offers Save As. A host
// whose window is the relay (on this network, or pairing codes) ends the session for its guests
// when it leaves.
globalThis.AtriumCollabPresence = (() => {
  const G = globalThis, L = () => G.AtriumCollabLock;
  function savedFolder() {
    const folder = host?.folderProject?.();
    return folder?.grant && !folder.temporary && folder.grant === G.AtriumHost?.folderGitGrant ? folder : null;
  }
  const PREF_NAME = "collab.displayName", PREF_ON = "collab.locking", PREF_LIVE = "collab.realtime", PREF_RELAY = "collab.relay", PREF_PATH = "collab.path";
  // A private relay's host invitation holds a token: a secret, so it stays out of Preferences (which
  // export and import) under its own key (security review N5).
  const HOST_TOKEN = "atrium.collab.hostToken";
  // Shared on this network (lanStart: {port, addresses, primary?}): the address an invitation names.
  // The host's primary address (its default-route Wi-Fi or Ethernet) when it gives one, else the most
  // likely home or office network: IPv4 before IPv6, 192.168/16, 10/8, then 172.16/12 with 172.17/16
  // (Docker's default bridge) last; the host's own order within each. IPv6 goes in brackets.
  function lanRank(a) {
    if (a.includes(":")) return 9;
    const [x, y] = a.split(".").map(Number);
    return x === 192 && y === 168 ? 0 : x === 10 ? 1 : x === 172 && y === 17 ? 3 : x === 172 ? 2 : 4;
  }
  function lanAddresses(lan) {
    const list = (Array.isArray(lan?.addresses) ? lan.addresses : []).filter(a => typeof a === "string" && a);
    const best = list.map((a, i) => [a, i]).sort((p, q) => lanRank(p[0]) - lanRank(q[0]) || p[1] - q[1]).map(p => p[0]);
    return typeof lan?.primary === "string" && best.includes(lan.primary) ? [lan.primary, ...best.filter(a => a !== lan.primary)] : best;
  }
  const lanHostPort = (a, port) => (a.includes(":") ? "[" + a + "]" : a) + ":" + port;
  const hostInvite = () => { try { const h = JSON.parse(G.localStorage?.getItem(HOST_TOKEN) || "null"); return h && typeof h.token === "string" && typeof h.relay === "string" ? h : null; } catch { return null; } };
  const setHostInvite = h => { try { if (h) G.localStorage.setItem(HOST_TOKEN, JSON.stringify(h)); else G.localStorage.removeItem(HOST_TOKEN); } catch { /* storage */ } };
  const pathPref = () => ["relay", "turn"].includes(pref(PREF_PATH, "auto")) ? pref(PREF_PATH, "auto") : "auto";
  // This build's versions: the app (a label beside a face when it differs), the file format and the
  // transport protocol (a different major format or protocol cannot share a session).
  const appVersion = () => G.document?.querySelector?.('meta[name="application-version"]')?.getAttribute("content") || "";
  const FORMAT = () => G.AtriumFormat2?.FORMAT || "2.0";
  const major = v => Number(String(v || "").split(".")[0]) || 0;
  const minor = v => /^\d+\.(\d+)$/.test(v) ? Number(v.split(".")[1]) : 0;
  const HEARTBEAT = 20000, PRESENT = 60000, LOCK_BEAT = 4000, HOST_WAIT = 15000;
  // A guest keeps its own edits until the host confirms them, up to this many (or this size); past
  // that, this window's copy can no longer catch the session up, and it says so.
  const UNSENT = 40000, UNSENT_BYTES = 32 * 1024 * 1024;
  const COLOURS = ["--accent", "--info", "--success", "--warning", "--danger"];
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const btn = (text, fn, cls = "collab-button", title) => {
    const b = el("button", text, cls); b.type = "button"; b.onclick = fn; if (title) b.title = title;
    // Peers and nearby sessions are library chips; the rest are library buttons.
    if (b.classList.contains("collab-chip")) b.classList.add("ui-chip");
    else if (b.classList.contains("collab-button")) {
      b.classList.add("ui-button");
      b.dataset.variant = b.classList.contains("is-primary") ? "primary" : b.classList.contains("is-quiet") ? "quiet" : "secondary";
    }
    return b;
  };
  const pref = (k, d) => { try { return G.AtriumPref?.get?.(k, d) ?? d; } catch { return d; } };
  const setPref = (k, v) => { try { G.AtriumPref?.set?.(k, v); } catch { /* storage */ } };
  const relayAddress = u => /^wss?:\/\/[^\s/@?#]+(?:\/[^\s?#]*)?$/i.test(u);
  const initial = n => (String(n || "?").trim().match(/[\p{L}\p{N}]/u) || ["?"])[0].toUpperCase();
  const colourIndex = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % COLOURS.length; };
  const clock = t => { try { return new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); } catch { return ""; } };
  const say = (t, kind) => { G.AtriumNavCommon?.toast?.(t, {kind, ms: 4200}); host?.info?.(t); };
  let host = null;
  // The live-session renderers load with the first session (lazy.js registers this module only).
  for (const [name, file] of [["AtriumCollabCursors", "project/collab-cursors.js"], ["AtriumCollabObjectMotion", "project/collab-object-motion.js"], ["AtriumCollabPair", "project/collab-pair.js"]])
    if (G.AtriumLazy?.register && !G.AtriumLazy.modules?.().includes(name)) G.AtriumLazy.register(name, {scripts: [file]});

  // ------------------------------------------------------------------ badges
  const glyphs = new Map();
  let glyphMeasure;
  function setBadgeText(node, letters) {
    if (node.dataset.badgeText === letters) return;
    node.dataset.badgeText = letters;
    const small = node.classList.contains("collab-badge"), wide = node.id === "collab-more" && letters.length > 2;
    if (node.id === "collab-more") node.classList.toggle("is-wide", wide);
    const key = (small ? "s" : wide ? "w" : "l") + letters;
    let icon = glyphs.get(key);
    if (!icon) {
      // Centre the visible ink. A centred line box includes the font's unused descender space.
      glyphMeasure ||= document.createElement("canvas").getContext("2d");
      glyphMeasure.font = "600 100px system-ui, sans-serif";
      glyphMeasure.textAlign = "center"; glyphMeasure.direction = "ltr";
      const m = glyphMeasure.measureText(letters);
      const inkWidth = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / 100 || 1;
      const halfWidth = wide ? 70 : 50, size = Math.min(small ? 70 : 55, (2 * halfWidth - 21) / inkWidth);
      const ns = "http://www.w3.org/2000/svg";
      icon = document.createElementNS(ns, "svg");
      icon.setAttribute("viewBox", [-halfWidth, -50, 2 * halfWidth, 100].join(" ")); icon.setAttribute("class", "collab-initials");
      icon.setAttribute("aria-hidden", "true"); icon.setAttribute("focusable", "false");
      const text = document.createElementNS(ns, "text");
      text.setAttribute("text-anchor", "middle"); text.setAttribute("font-size", String(size));
      text.setAttribute("x", String((m.actualBoundingBoxLeft - m.actualBoundingBoxRight) * size / 200));
      text.setAttribute("y", String((m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) * size / 200));
      text.textContent = letters;
      icon.append(text);
      if (glyphs.size >= 256) glyphs.clear();
      glyphs.set(key, icon);
    }
    node.replaceChildren(icon.cloneNode(true));
  }
  // A library avatar (ui/components.css): 14 px, an identity hue, editing (active), viewing (away) or a stale lock.
  function avatar(name, state, title, key) {
    const a = el("span", null, "ui-avatar collab-badge");
    a.dataset.size = "sm"; a.dataset.hue = String(colourIndex(key || name)); a.dataset.state = state;
    setBadgeText(a, initial(name));
    a.setAttribute("aria-label", title);
    return a;
  }
  function badgesFor(id) {
    const out = [], M = L()?.manager();
    if (M) {
      const s = M.docState(id);
      if (s.owner) out.push(avatar(s.owner.name, s.stale ? "stale" : "active", (s.stale ? "Stale lock: " : "Locked by ") + s.owner.name + (s.owner.started ? " — editing since " + clock(s.owner.started) : ""), s.owner.session));
      for (const v of s.viewers.slice(0, 2)) if (v.session !== s.owner?.session) out.push(avatar(v.name, "away", v.name + " has this open", v.session));
      if (s.held && (s.viewers.length || s.askers.length)) { const me = el("span", null, "collab-held"); me.setAttribute("aria-label", "You hold the edit lock"); out.push(me); }
    }
    for (const p of Live.peers()) if (p.doc === id) out.push(avatar(p.name, "is-live", p.name + (p.act ? " — " + p.act : " is here (live)"), p.id));
    return out;
  }
  // Share and the project-wide row of people stay in view when everyone is on different documents.
  function projectPeople(session) {
    const names = ids => ids.map(id => host.docById(id)?.name).filter(Boolean).join(", ");
    let people;
    if (session) {
      people = session.connection === "open" ? Live.peers().map(p => ({
        id: p.id, name: p.name, open: names([p.doc]), locks: "", app: p.app
      })) : [];
    } else {
      people = (L()?.manager()?.people() || []).map(p => ({
        id: p.session, name: p.name, open: names(p.viewing), locks: names(p.editing)
      }));
    }
    return people.map(p => ({
      id: p.id, name: p.name,
      detail: (p.open ? "Viewing " + p.open : p.locks ? "Holds an edit lock on " + p.locks : "No open document reported yet") +
        (p.app && p.app !== appVersion() ? " · Waffle " + p.app : "")
    })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  function initials(name) {
    const words = name.trim().split(/\s+/u);
    return initial(words[0]) + (words.length > 1 ? initial(words[words.length - 1]) : "");
  }
  let peopleBar, roster, lastPeople, nextTip = 0;
  function fillRoster(list, people) {
    if (!people.length) { list.replaceChildren(el("li", "No one else is here.", "collab-note")); return; }
    list.replaceChildren(...people.map(p => {
      const item = el("li"), face = el("span", null, "collab-face collab-c" + colourIndex(p.id)), info = el("span");
      setBadgeText(face, initials(p.name));
      face.setAttribute("aria-hidden", "true");
      info.append(el("strong", p.name), el("span", p.detail));
      item.append(face, info);
      return item;
    }));
  }
  function openRoster() {
    const d = dialog("People here", panel => {
      roster = el("ul", null, "collab-roster");
      fillRoster(roster, projectPeople(Live.session()));
      panel.append(roster);
    });
    d.addEventListener("close", () => { roster = null; }, {once: true});
  }
  function personFace(id) {
    const wrap = el("span", null, "collab-person"), face = btn("", openRoster, "collab-face collab-c" + colourIndex(id));
    const tip = el("span", null, "collab-person-tip");
    wrap.dataset.person = id;
    tip.id = "collab-person-tip-" + ++nextTip;
    tip.setAttribute("role", "tooltip");
    tip.append(el("strong"), el("span"));
    face.setAttribute("aria-describedby", tip.id);
    face.setAttribute("aria-haspopup", "dialog");
    wrap.append(face, tip);
    // No hover pop-ups: the name and document show for keyboard focus; a click opens People here.
    wrap.addEventListener("focusin", () => wrap.classList.remove("is-dismissed"));
    return wrap;
  }
  function paintPeople() {
    if (!peopleBar) return;
    const session = Live.session(), state = session?.connection;
    const label = state === "open" ? (session.mode === "start" ? "Sharing" : session.r ? "Live" : "Waiting…")
      : ({connecting: "Connecting…", offline: "Offline", ended: "Session ended", error: "Disconnected"})[state] || "Share";
    const {share, faces, more} = peopleBar;
    // Live: a success dot, not a repainted face (WCAG AA).
    const live = state === "open" && !!session.r, dot = share.querySelector(".ui-dot");
    share.classList.toggle("is-sharing", live); if (dot) dot.hidden = !live;
    const hint = session ? session.status + ". Open session controls" : "Share project or join a live session";
    if (share.dataset.tooltip !== hint) {
      share.dataset.tooltip = hint;
      share.setAttribute("aria-label", session ? label + ". " + hint : hint);
    }

    const people = projectPeople(session), signature = JSON.stringify(people);
    if (signature === lastPeople) return;
    lastPeople = signature;
    const visible = people.slice(0, 3), old = new Map();
    for (const n of [...faces.children]) {
      if (visible.some(p => p.id === n.dataset.person)) old.set(n.dataset.person, n);
      else { if (n.contains(document.activeElement)) share.focus(); n.remove(); }
    }
    visible.forEach((p, i) => {
      const wrap = old.get(p.id) || personFace(p.id);
      const face = wrap.firstElementChild, tip = wrap.lastElementChild;
      setBadgeText(face, initials(p.name));
      face.setAttribute("aria-label", p.name);
      tip.firstElementChild.textContent = p.name;
      tip.lastElementChild.textContent = p.detail;
      if (faces.children[i] !== wrap) faces.insertBefore(wrap, faces.children[i] || null);
    });
    if (people.length <= 3 && document.activeElement === more) share.focus();
    more.hidden = people.length <= 3;
    if (!more.hidden) {
      setBadgeText(more, "+" + (people.length - 3));
      more.setAttribute("aria-label", "Show all " + people.length + " other people here");
    }
    if (roster) fillRoster(roster, people);
  }
  function attachPeople() {
    const bar = document.getElementById("collab-people");
    if (!bar) return;
    const share = document.getElementById("collab-share"), more = bar.querySelector("#collab-more");
    if (!share || !more) return;
    more.onclick = openRoster;
    peopleBar = {share, more, faces: bar.querySelector("#collab-faces")};
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") for (const n of bar.querySelectorAll(".collab-person")) n.classList.add("is-dismissed");
    });
    paintPeople();
  }
  let painting = false;
  function paintBadges() {
    if (painting || !document.body) return;
    painting = true;
    try {
      for (const node of document.querySelectorAll("#document-tabs [data-tab], #documents [data-doc]")) {
        const id = node.dataset.tab || node.dataset.doc;
        let box = node.querySelector(":scope > .collab-badges");
        const list = badgesFor(id);
        if (!list.length) { box?.remove(); continue; }
        if (!box) { box = el("span", null, "collab-badges"); node.append(box); }
        const sig = list.map(n => n.className + n.getAttribute("aria-label")).join("|");
        if (box.dataset.sig !== sig) { box.replaceChildren(...list); box.dataset.sig = sig; }
      }
      paintPeople();
    } finally { painting = false; }
  }
  let badgeTimer = 0;
  const soon = () => { if (!badgeTimer) badgeTimer = setTimeout(() => { badgeTimer = 0; paintBadges(); paintBar(); keepTime(); }, 30); };
  // Stale locks and expired asks change with time alone: repaint every 3 s, but only while someone
  // else shares the folder and the window is on screen. A live session repaints
  // on its own events and its 20 s heartbeat.
  let timeTick = 0;
  function keepTime() {
    let on = false;
    try { on = !!L()?.manager?.()?.people?.().length && G.AtriumPower?.visible?.() !== false; } catch { on = false; }
    if (on && !timeTick) timeTick = setInterval(soon, 3000);
    else if (!on && timeTick) { clearInterval(timeTick); timeTick = 0; }
  }

  // ------------------------------------------------------------------ the bar
  let bar = null, dismissed = new Set(), sessionNotice = null;
  function barNode() {
    if (bar?.isConnected) return bar;
    const area = document.getElementById("editor-area"), panes = document.getElementById("editor-panes");
    if (!area || !panes) return null;
    bar = el("div", null, "collab-bar"); bar.setAttribute("role", "status"); bar.setAttribute("aria-live", "polite"); bar.hidden = true;
    panes.before(bar);
    return bar;
  }
  function show(kind, message, actions, key) {
    const b = barNode(); if (!b) return;
    if (key && dismissed.has(key)) { b.hidden = true; return; }
    b.dataset.kind = kind; b.replaceChildren(el("span", null, "collab-bar-icon"), el("span", message, "collab-bar-text"));
    const acts = el("span", null, "collab-bar-actions");
    for (const [label, fn, primary, title] of actions) acts.append(btn(label, fn, "collab-button" + (primary ? " is-primary" : ""), title));
    if (key) acts.append(btn("Dismiss", () => { dismissed.add(key); paintBar(); }, "collab-button is-quiet", "Hide this message"));
    b.append(acts); b.hidden = false;
  }
  function paintBar() {
    const b = barNode(); if (!b) return;
    const M = L()?.manager(), id = host?.currentId?.(), name = host?.docById?.(id)?.name || "This document";
    if (M && id) {
      const s = M.docState(id);
      if (s.lost) return show("warning", (s.owner?.name || "Someone") + " took over " + name + ". Your later changes to it are read-only until they release it.", [
        ["Ask to Edit", () => lockAction(M, () => M.ask(id)), true]], "lost:" + id);
      if (s.owner && !s.held) {
        const who = s.owner.name;
        if (s.stale) return show("warning", who + "'s lock on " + name + " looks stale (no heartbeat for over " + Math.round(L().constants.STALE / 1000) + " s). Waffle may have quit on their computer.", [
          ["Take Over", () => takeOver(id, who, M), true, "Take the lock. If " + who + " is still editing, their unsaved changes to this document will conflict."],
          ["Open Read-Only", () => { dismissed.add("ro:" + id); paintBar(); }, false]], "stale:" + id);
        return show("info", who + " is editing " + name + (s.owner.started ? " (since " + clock(s.owner.started) + ")" : "") + ". You're viewing it read-only; it reloads when " + who + " saves.", [
          [s.asked ? "Asked…" : "Ask to Edit", () => lockAction(M, () => M.ask(id), () => { say("Asked " + who + " for " + name); paintBar(); }), !s.asked, "Ask " + who + " to hand the document over"]], "ro:" + id);
      }
      if (s.held && s.askers.length) {
        const a = s.askers[0];
        return show("info", a.name + " asks to edit " + name + ".", [
          ["Hand Over", () => handOver(id, a, M), true, "Save if needed, then release the lock to " + a.name],
          ["Keep Editing", () => { dismissed.add("ask:" + id + ":" + a.session + ":" + (a.asks.find(x => x.doc === id)?.at || 0)); paintBar(); }, false]],
          "ask:" + id + ":" + a.session + ":" + (a.asks.find(x => x.doc === id)?.at || 0));
      }
    }
    // A live session's copy that only this window holds (the host ended the session, or offline
    // edits the session can no longer take): Save As keeps it.
    if (sessionNotice) return show("warning", sessionNotice.text, [["Save As…", () => host?.act?.("save-as"), true, "Save this copy of the project as a file"], ...(sessionNotice.actions || [])], sessionNotice.key);
    b.hidden = true;
  }
  function setSessionNotice(notice) { sessionNotice = notice; soon(); }
  async function lockAction(manager, action, done) {
    if (!manager || manager !== L()?.manager()) return;
    try {
      const result = await action();
      if (manager === L().manager()) done?.(result);
    } catch (e) { if (manager === L().manager() && e.name !== "AbortError") say(e.message, "error"); }
  }
  async function takeOver(id, who, manager = L()?.manager()) {
    if (!manager || manager !== L()?.manager() ||
        G.confirm?.("Take the lock from " + who + "? If they are still editing, their unsaved changes to this document will conflict with yours when either of you saves.") !== true) return;
    const result = await L().takeOver(id, manager);
    if (manager === L().manager()) say(result?.state === "held" ? "You now hold the lock" : "Could not take the lock");
    soon();
  }
  async function handOver(id, asker, manager) {
    if (!manager || manager !== L()?.manager()) return;
    try {
      if (host.isDirty?.() && !await host.saveAll?.()) { say("Save first, then hand over."); return; }
      if (manager !== L().manager()) return;
      if (await manager.handOver(id, asker.session) && manager === L().manager())
        say("Handed " + (host.docById?.(id)?.name || "the document") + " to " + asker.name);
    } catch (e) { if (manager === L().manager()) say("Could not hand over. " + e.message, "error"); }
    soon();
  }
  function onLock(e) {
    if (e.type === "disabled") dismissed.clear();
    else if (e.type === "granted") {
      const manager = L().manager();
      L().take(e.doc, undefined, manager).then(async result => {
        if (manager !== L().manager() || result?.state !== "held") return;
        await L().synchronize(e.doc, manager);
        if (manager === L().manager()) say("You can edit " + (host?.docById?.(e.doc)?.name || "the document") + " now.");
      }).catch(error => { if (manager === L().manager()) say(error.message, "error"); });
    } else if (e.type === "lost") {
      const name = host?.docById?.(e.doc)?.name || "A document";
      say(e.by ? e.by.name + " took over " + name : name + "'s lock was removed", "warning");
    }
    soon();
  }

  // ------------------------------------------------------------------ dialogs
  function dialog(title, build, closeLabel = "Close") {
    const d = el("dialog", null, "collab-dialog"), heading = el("h2", title);
    const actions = el("div", null, "collab-dialog-actions ui-sticky-actions"), close = btn(closeLabel, () => d.close());
    d.append(heading);
    build(d, actions);
    const body = Array.from(d.children).slice(1);
    actions.prepend(close); d.append(actions);
    globalThis.AtriumShell?.adoptDialog(d, {title:heading, body, actions, sheet:true,
      initialFocus:() => [...d.querySelectorAll(AtriumUI.FIELD + ",textarea")].find(AtriumUI.available) || close});
    document.body.append(d);
    d.onclose = () => d.remove();
    d.showModal();
    return d;
  }
  function nameField(parent, render) {
    const label = "Your display name", help = "Shown to people sharing this folder or session and on your review comments. Waffle never uses your account or computer name.";
    const input = el("input", null, "ui-field");
    input.type = "text"; input.maxLength = 64; input.value = pref(PREF_NAME, "") || ""; input.placeholder = "How others see you";
    input.onchange = () => setPref(PREF_NAME, input.value.trim().slice(0, 64));
    if (render) parent.append(render(PREF_NAME, label, input, "Shown to collaborators and on your review comments."));
    else {
      const row = el("label", null, "collab-field");
      row.append(el("span", label), input, el("small", help));
      parent.append(row);
    }
    return input;
  }
  function statusDialog() {
    dialog("Collaboration", d => {
      const M = L()?.manager();
      nameField(d);
      if (!G.AtriumHost?.collabLocks) d.append(el("p", "Document locks need the desktop app and a project saved in a folder (a shared drive, Dropbox, OneDrive, iCloud or a Git working copy).", "collab-note"));
      else if (!savedFolder()) d.append(el("p", "Open or save a Waffle project folder to lock its documents for other editors.", "collab-note"));
      else if (savedFolder().readOnly) d.append(el("p", "This Waffle folder is read-only.", "collab-note"));
      else if (!M) d.append(el("p", "Document locking is off (Preferences › Collaboration).", "collab-note"));
      else {
        const table = el("table", null, "collab-table"), head = el("tr");
        for (const h of ["Document", "Edited by", "Also open for"]) head.append(el("th", h));
        table.append(head);
        for (const doc of host.documentRefs()) {
          const s = M.docState(doc.id), tr = el("tr");
          tr.append(el("td", doc.name), el("td", s.held ? "You" : s.owner ? s.owner.name + (s.stale ? " (stale)" : "") : "—"), el("td", s.viewers.map(v => v.name).join(", ") || "—"));
          const td = el("td");
          if (s.held) td.append(btn("Release", () => lockAction(M, () => M.release(doc.id), () => { say("Released " + doc.name); d.close(); })));
          else if (s.owner && !s.stale) td.append(btn("Ask to Edit", () => lockAction(M, () => M.ask(doc.id), () => { say("Asked " + s.owner.name); d.close(); })));
          else if (s.owner) td.append(btn("Take Over…", () => { d.close(); takeOver(doc.id, s.owner.name, M); }));
          else td.append(btn("Lock", () => L().take(doc.id, undefined, M).then(() => d.close())));
          tr.append(td); table.append(tr);
        }
        d.append(table);
        const suffix = ".waffle-lock";
        d.append(el("p", `Locks live beside the project as small “${suffix}” files. Add “*${suffix}” to .gitignore in Git working copies.`, "collab-note"));
      }
      lfsSection(d);
    });
  }
  // Git LFS locks: local status only until the user presses a button (the lock server is a network call).
  function lfsSection(d) {
    const H = G.AtriumHost, folder = savedFolder(), generation = H?.projectGeneration;
    if (!H?.gitQuery || !folder) return;
    const current = () => H === G.AtriumHost && savedFolder() === folder && generation === H.projectGeneration;
    const box = el("section", null, "collab-lfs"), out = el("p", "Checking Git LFS (local only)…", "collab-note");
    box.append(el("h3", "Git LFS locks"), out); d.append(box);
    const run = async (op, confirmText) => {
      if (!current() || confirmText && (!d.open || G.confirm?.(confirmText) !== true || !current())) return null;
      try {
        const result = await H.gitQuery(op, op === "lfsStatus" ? {} : {confirm:true});
        return d.open && current() ? result : null;
      } catch (e) {
        if (d.open && current()) out.textContent = e.message;
        return null;
      }
    };
    run("lfsStatus").then(s => {
      if (!s) return;
      if (!s.git) { out.textContent = "This project is not in a Git working copy."; return; }
      if (!s.lfs) { out.textContent = "Git LFS is not installed, so its locks are unavailable."; return; }
      if (!s.lockable) { out.textContent = "This repository has no Git LFS lock for the project manifest. Mark it lockable in .gitattributes to enable locks."; return; }
      out.textContent = "This repository uses Git LFS locks for the project manifest." + (s.cached ? " Last known: " + s.cached : " The server is contacted when you ask.");
      const row = el("div", null, "collab-dialog-actions");
      const server = "This contacts your Git LFS server (" + (s.remote || "the repository's remote") + ").";
      row.append(btn("Check Locks", async () => { const r = await run("lfsLocks", server + " Continue?"); if (r) out.textContent = r.locked ? "Locked by " + (r.owner || "someone") + (r.mine ? " (you)" : "") + "." : "Not locked on the server."; }));
      if (!folder.readOnly) row.append(
        btn("Lock on Server", async () => { if (folder.readOnly) return; const r = await run("lfsLock", server + " Lock " + s.path + " for you?"); if (r) out.textContent = r.locked ? "Locked for you on the LFS server." : (r.message || "Not locked."); }),
        btn("Unlock on Server", async () => { if (folder.readOnly) return; const r = await run("lfsUnlock", server + " Release your LFS lock on " + s.path + "?"); if (r) out.textContent = r.unlocked ? "Unlocked." : (r.message || "Not unlocked."); }));
      box.append(row);
    });
  }
  function prefsPage(P) {
    P.on?.(PREF_ON, e => e.value === false ? L()?.disable() : L()?.enable());
    P.on?.(PREF_LIVE, e => { if (e.key === PREF_LIVE && e.value !== true) Live.leave(); });
    P.registerPage?.({id: "collaboration", title: "Collaboration", order: 7.5, resetKeys: [PREF_NAME, PREF_ON, PREF_LIVE, PREF_RELAY, PREF_PATH], keywords: "collaboration lock locking shared folder dropbox onedrive icloud git lfs presence live real-time co-editing relay name",
      render(c, api) {
        const g = api.group ? api.group(c, "Shared folders") : c;
        const prefId = key => "prf-" + key.replace(/\W/g, "-");
        function field(key, text, input, help, keywords = "") {
          const row = el("div", null, "prf-row"), label = el("label", text, "prf-label");
          const control = el("span", null, "prf-control"), detail = el("small", help, "prf-help");
          row.dataset.search = (text + " " + help + " " + keywords).toLowerCase();
          input.id = prefId(key); label.htmlFor = input.id;
          detail.id = input.id + "-help"; input.setAttribute("aria-describedby", detail.id);
          control.append(input); row.append(label, control, detail); return row;
        }
        nameField(g, field);
        const check = (key, label, help, def) => {
          const row = el("div", null, "prf-row prf-check"), box = el("input", null, "ui-checkbox"), l = el("label", null, "ui-checkbox-row");
          const detail = el("small", help, "prf-help");
          row.dataset.search = (label + " " + help).toLowerCase();
          box.type = "checkbox"; box.id = prefId(key); box.checked = pref(key, def) !== false && pref(key, def) !== "false" && (def || pref(key, def) === true);
          detail.id = box.id + "-help"; box.setAttribute("aria-describedby", detail.id);
          box.onchange = () => setPref(key, box.checked);
          l.htmlFor = box.id; l.append(box, el("span", label)); row.append(l, detail); return row;
        };
        g.append(check(PREF_ON, "Lock the documents I open", "Other people get a read-only view of these files.", true));
        const live = api.group ? api.group(c, "Real-time co-editing (prototype)") : c;
        live.append(check(PREF_LIVE, "Enable live sessions", "Edit together with people you invite.", false));
        const input = el("input", null, "ui-field"), tested = el("small", "", "prf-help");
        input.type = "url"; input.placeholder = "wss://collab.example.org"; input.value = pref(PREF_RELAY, "") || "";
        input.spellcheck = false; input.autocomplete = "off";
        input.onchange = () => {
          const u = input.value.trim();
          const message = !u || relayAddress(u) ? "" : "Enter a wss:// address (ws:// only on a trusted local network).";
          tested.textContent = message;
          if (message) input.setAttribute("aria-invalid", "true");
          else { input.removeAttribute("aria-invalid"); setPref(PREF_RELAY, u); }
        };
        const row = field(PREF_RELAY, "Relay server", input, "Leave blank to use pairing codes.", "address wss turn webrtc invitation");
        const actions = el("div", null, "prf-row prf-link"), test = btn("Test Connection", async () => {
          const u = input.value.trim();
          if (!relayAddress(u)) { tested.textContent = "Enter the relay server's address first."; return; }
          test.disabled = true; tested.textContent = "Connecting to " + u + "…";
          try { tested.textContent = await Live.testRelay(u); } finally { test.disabled = false; }
        });
        test.classList.add("prf-button");
        actions.dataset.search = "relay server address wss turn webrtc invitation test connection";
        tested.setAttribute("aria-live", "polite");
        actions.append(test, tested);
        // A private relay's host invitation (waffle-collab add-host), set by opening its link.
        const invited = hostInvite();
        if (invited) {
          const invitation = el("div", null, "prf-row prf-link");
          invitation.dataset.search = "host invitation private relay server";
          const remove = btn("Remove", () => { setHostInvite(null); invitation.remove(); });
          remove.classList.add("prf-button");
          invitation.append(el("span", "Host invitation"), el("small", (invited.name ? invited.name + " — " : "") + "you can start sessions on " + invited.relay + ".", "prf-help"), remove);
          live.append(row, actions, invitation);
        } else live.append(row, actions);
        const path = el("select", null, "ui-field");
        for (const [value, text] of [["auto", "Direct, relay as fallback"], ["turn", "TURN only"], ["relay", "Relay server only"]]) {
          const opt = el("option", text); opt.value = value; path.append(opt);
        }
        path.value = pathPref();
        path.onchange = () => setPref(PREF_PATH, path.value);
        live.append(field(PREF_PATH, "Connection", path, "Direct uses WebRTC. TURN keeps your IP address from the others. Every path encrypts edits end to end.", "direct webrtc relay turn path"));
      }});
  }

  // ------------------------------------------------------------------ live sessions (prototype)
  const Live = (() => {
    let S = null;   // {t, r, me, host, roomKey, url, peers: Map, followed, applying, timers}
    let nextError = 0, joinRounds = 0;
    const ownSeqs = new Map();   // peer id -> edits it made in earlier sessions in this window (N3)
    const ownSeq = id => ownSeqs.get(id) || 0;
    // The CRDT for a received snapshot: the host owns the format stamp (N4); a snapshot from the
    // verified host may show this replica's own earlier edits (N3), anyone else's only those we made.
    const replicaFrom = (snap, from) => G.AtriumCollabCRDT.create({replica: S.me, snapshot: snap, owner: S.host || undefined, ownSeq: ownSeq(S.me), resume: isHost(from)});
    const presentPeers = () => S ? [...S.peers.values()].filter(p => Date.now() - p.seen < PRESENT) : [];
    // The invitation names the host by its peer id; the transport verified every sender's id.
    const isHost = id => !!S?.host && id === S.host;
    const peers = () => S?.r ? presentPeers() : [];
    const active = () => !!S;
    function reviewWarning(project) {
      if (!S?.r || host?.project() !== project || presentPeers().every(p => p.reviewRecords)) return "";
      const message = "Everyone in this session needs an updated editor to change Review comments. Save a copy or rejoin after the update.";
      say(message,"warning"); return message;
    }
    const clean = (v, n = 64) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").slice(0, n) : "";
    const finite = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e8;
    const point = p => Array.isArray(p) && p.length === 2 && p.every(finite) ? [p[0], p[1]] : null;
    function status(text) {
      S.status = text;
      S.refreshDialog?.();
      soon(); renderStrip();
    }
    // How the other editors are connected: "Direct", "via TURN", "via relay server" or a mix.
    function pathSummary(session = S) {
      if (!session?.t || session.url === "local") return "";
      const paths = [...(session.t.paths?.() || new Map()).entries()].filter(([id]) => session.peers.has(id)).map(([, v]) => v);
      const names = {direct: "direct", turn: "via TURN", relay: session.hub || session.pairing ? "through the host" : "via relay server"};
      const kinds = [...new Set(paths)].map(v => names[v] || v);
      const note = session.rtc === false ? " (this window has no WebRTC)" : "";
      return kinds.length ? kinds.join(" and ") + note : session.rtc === false ? "relay server only" + note : "";
    }
    function connectedStatus() {
      if (!S.r) return "Waiting for the shared project";
      if (S.url === "local") return "Live (this computer)";
      const path = pathSummary();
      // The relay connection dropped while data channels still reach the others.
      const relay = S.t?.joined?.() === false ? " · reconnecting to the relay server" : "";
      return (S.mode === "start" ? "Hosting" : "Live") + (path ? " · " + path : "") + relay;
    }
    // A new session. mode "start" hosts this project; "join" uses {url, roomKey, host, salt} from an
    // invitation. A host makes a fresh session salt; on a private relay it presents its host invitation.
    // url "pair": a session without a server, joined with pairing codes (collab-pair.js); a host's own
    // window is then the relay, and a paired guest passes o.socket (its connection to the host).
    async function begin(mode, url, roomKey, o = {}) {
      if (typeof o === "string" || o === null) o = {host: o};
      const hostId = o.host || null;
      if (S) leave();
      const session = S = {me: null, host: hostId, url, mode, started: Date.now(), peers: new Map(), claims: new Set(), followed: null, applying: false, status: "Connecting…", connection: "connecting", r: null, t: null, timers: [], offs: [], acked: 0};
      if (mode === "join") session.joinRevision = host.revision();
      session.heartbeat = () => heartbeat(session);
      setSessionNotice(null);
      try {
        // A peer can introduce a full table even while this project has no widgets.
        const widgets = G.AtriumLabs?.notebookEnabled() !== false ? ["AtriumWidgetCatalogue", "AtriumTableData", "AtriumNotebook"] : [];
        await G.AtriumLazy?.need?.(["AtriumCollabCRDT", "AtriumCollabTransport", "AtriumCollabCursors", "AtriumCollabObjectMotion", "AtriumUndoStore", ...widgets, ...(url === "pair" ? ["AtriumCollabPair"] : [])]);
        if (S !== session) return;
        session.cursors = G.AtriumCollabCursors.create(host, peers, COLOURS);
        session.objectMotion = G.AtriumCollabObjectMotion.create(host);
        session.waypoints = G.AtriumCollabCursors.waypoints((client, end, turn) => sendCursor(client, end, true, turn));
        const T = G.AtriumCollabTransport;
        let salt = o.salt || null;
        // A host always makes a fresh session salt (it travels with the invitation), also for a key
        // given to start(); only a key typed by hand on both sides (o.manual) uses the fixed one.
        if (mode === "start" && !roomKey) roomKey = T.newRoomKey();
        if (mode === "start" && !salt && !o.manual) salt = T.newSalt();
        session.salt = salt;
        const invited = hostInvite(), hostToken = mode === "start" && invited?.relay === url ? invited.token : undefined;
        // The room's owner token lets the host back into its own room when it is full.
        const owner = mode === "start" ? [...G.crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, "0")).join("") : undefined;
        session.roomKey = roomKey;   // for pairing codes; in memory only
        session.lan = o.lan || null;   // shared on this network: {port, addresses, name, code}
        let WebSocket, address = url, path = pathPref();
        if (url === "pair" && mode === "start") {
          const k = await T.keys(roomKey, salt);
          session.hub = G.AtriumCollabPair.hub(k.room, k.auth);
          WebSocket = session.hub.hostSocket; address = "ws://pair.invalid"; path = "relay";
        } else if (url === "pair") {
          if (!o.socket) throw Error("Paste the host's pairing code into Join.");
          WebSocket = o.socket; address = "ws://pair.invalid"; path = o.path || "relay";
          session.pairing = o.pairing;
          o.pairing?.onEnd?.(() => { if (S === session) { leave(true); say("The pairing with the host ended. Ask them for a new pairing code to join again.", "warning"); } });
        } else if (G.AtriumHost?.lanSocket && /^ws:\/\//i.test(url)) WebSocket = await G.AtriumHost.lanSocket();   // ws:// on this network through the host (Windows)
        if (S !== session) return;
        const t = await T.connect({url: address, WebSocket, roomKey, salt, hostToken, persist: true, host: hostId, owner, path, cancelled: () => S !== session,
          heartbeat: HEARTBEAT, onBeat() { if (S === session) heartbeat(session); },
          onMessage(...args) { if (S === session) onMessage(...args); },
          onState(state, d) { if (S === session) onState(state, d); }});
        if (S !== session) { t.close(); return; }
        if (session.lan && mode === "start") G.AtriumHost?.lanHost?.(t.peer)?.catch?.(() => {});
        session.t = t; session.me = t.peer; session.rtc = t.rtc || url === "local" ? undefined : false;
        if (mode === "start") {
          session.host = t.peer;
          session.editProject = host.project();
          session.r = G.AtriumCollabCRDT.create({replica: t.peer, project: session.editProject, owner: t.peer, ownSeq: ownSeq(t.peer)});
          rememberCursor(session);
          // Materialise and validate the shared project once, when idle: later edits, undo and
          // incoming patches then bring it up to date for what they touch (a guest's join does this).
          const replica = session.r, I = G.AtriumIdle;
          (I ? f => I.idle(f, {timeout: 2000}) : f => setTimeout(f, 50))(() => { if (S === session && session.r === replica) replica.hiddenCount(); });
          session.base = "host";
          if (!session.hub) session.invite = T.invitation({relay: o.lan ? "ws://" + lanHostPort(lanAddresses(o.lan)[0] || "127.0.0.1", o.lan.port) : url, roomKey, host: t.peer, salt});
        }
      } catch (e) { if (S === session) leave(); throw e; }
      session.lastCamera = host.view().camera();
      S.offs.push(host.on("change", onLocal), host.on("selection", sendCursor), host.on("move-end", finishDrag), host.on("replace", () => {
        // Another project in this window (Open, New, a restored copy) ends its part in the session.
        if (S === session && !session.adopting) { leave(); say("Left the live session: this window opened another project."); }
      }), host.on("frame", () => {
        session.cursors.refresh();
        keyboardPointer(session);
        const cam = host.view().camera(), old = session.lastCamera;
        session.lastCamera = cam;
        if (session.followed || session.cameraTimer ||
            (cam.cx === old.cx && cam.cy === old.cy && cam.scale === old.scale && cam.flipped === old.flipped)) return;
        session.cameraTimer = setTimeout(() => { session.cameraTimer = 0; sendCursor(); }, 240);
      }), host.on("document", () => {
        session.pointer = null; session.waypoints.reset(); sendCursor();
      }));
      // Saved: compare the whole project once (audit). A folder project reports each save, also of
      // one document while others stay unsaved; any save that leaves the editor clean counts too. A
      // derived change marks a clean project unsaved and clean again in one task: not a save.
      let blip = false;
      S.offs.push(host.on("dirty", dirty => {
        if (dirty) { blip = true; queueMicrotask(() => { blip = false; }); } else if (!blip && S === session) auditSoon();
      }));
      const folderSession = host.folderProject?.();
      if (folderSession?.on) S.offs.push(folderSession.on(kind => { if (kind === "saved" && S === session) auditSoon(); }));
      const move = e => {
        const canvas = e.target, client = [e.clientX, e.clientY];
        // Closing a keyboard dialog can trigger pointerout from the disappearing
        // element without any mouse movement. Keep the editor's keyboard crosshair.
        if (e.type === "pointerout" && session.pointer?.world && canvas !== session.pointer.canvas) return;
        session.mouseMoved = true;
        if (e.type === "pointermove" && canvas === host.canvas()) {
          clearTimeout(session.edgeTimer);
          session.pointer = {canvas, doc: host.currentId(), client};
          session.waypoints.move(client);
          return;
        }
        if (!session.pointer && canvas !== host.canvas() &&
            !(e.type === "pointerdown" && host.panes().some(p => p.canvas === canvas))) return;
        const hide = e.type === "pointerout" || e.type === "pointercancel";
        // A press can activate a split pane or finish a drag in the editor's own handler.
        clearTimeout(session.edgeTimer);
        session.edgeTimer = setTimeout(() => {
          if (canvas === host.canvas() && !hide) session.pointer = {canvas, doc: host.currentId(), client};
          else if (session.pointer) session.pointer = null;
          else return;
          session.waypoints.reset(session.pointer?.client);
          sendCursor(undefined, true);
        }, 0);
      };
      for (const event of ["pointermove", "pointerout", "pointerdown", "pointerup", "pointercancel"]) {
        document.addEventListener(event, move, {passive: true, capture: true});
        S.offs.push(() => document.removeEventListener(event, move, true));
      }
      // The presence heartbeat runs on the transport's keepalive beat (onBeat above): no timer of its own.
      if (S.connection === "open") hello();
      G.AtriumHistoryPanel?.sessionChanged();
      renderStrip(); soon();
      return {room: session.t.room, peer: session.me, host: session.host, salt: session.salt || null, ...(session.invite || {})};
    }
    // The keyboard crosshair (arrow keys, Jump to): the editor's pointer moved in a frame without mouse input.
    function keyboardPointer(session) {
      const world = host.pointer?.(), moved = world && world !== session.lastWorld && !session.mouseMoved;
      session.lastWorld = world; session.mouseMoved = false;
      if (!moved || !session.lastWorldSeen) { session.lastWorldSeen = true; return; }
      clearTimeout(session.edgeTimer);
      const canvas = host.canvas(), rect = canvas.getBoundingClientRect();
      const [x, y] = host.view().worldToScreen(world), client = [x + rect.left, y + rect.top];
      session.pointer = {canvas, doc: host.currentId(), client, world};
      session.waypoints.move(client);
    }
    // Patch the editor's project; a shared edit can remove the document on screen.
    function rememberCursor(session) {
      if (session.editProject === host.project()) session.editCursor = G.AtriumUndoStore?.itemEdits?.(session.editProject, null, true)?.cursor;
    }
    function patchHost(session, touched, observers, project = session.editProject, fromPeer = false) {
      const plan = session.r.preparePatch(project, touched, observers);
      if (plan.scopes?.length === 0) return false;
      // File > Open can dispatch replace after switching the active project.
      // Finish a pending edit in the old session without touching the new editor.
      if (project !== host.project()) { plan.apply(); return plan; }
      const timing = fromPeer ? globalThis.AtriumDiagnostics?.performance?.begin("collaboration", "sync") : null;
      let outcome = "failed";
      session.applying = true;
      try {
        const apply = () => host.derive(() => {
          plan.apply();
          const docs = host.project().documents;
          if (!host.docById(host.currentId()) && docs.length) host.selectDocument(docs[0].id);
        }, {touched: plan.scopes});
        if (fromPeer && G.AtriumLabs?.butterEnabled("visualHistory") && G.AtriumUndoStore?.peerPatch) G.AtriumUndoStore.peerPatch(project, apply); else apply();
        rememberCursor(session);
        outcome = "completed";
      } finally {
        session.applying = false;
        timing?.end(outcome);
      }
      return plan;
    }
    // Undo and Redo buttons follow personal history during a session (editor.js syncTools asks too).
    function syncHistoryButtons() {
      const steps = host?.undoSteps?.(), available = historyAvailability() || {undo: !!steps?.history.length, redo: !!steps?.future.length};
      for (const button of document.querySelectorAll('[data-action="undo"], [data-action="redo"]')) button.disabled = !available[button.dataset.action];
    }
    // Every HEARTBEAT, on the transport's beat: presence to the others (the host's carries what it
    // holds of everyone's edits), a join that waits, the bounded log. It repaints only when someone's
    // presence changed (a peer gone quiet past PRESENT).
    function heartbeat(session) {
      if (S !== session) return;
      sendCursor(undefined, false, false, false, true);
      refreshJoin();
      keepLog(session);
      // (Arrivals and departures repaint when they happen; the first heartbeat only takes note.)
      const here = presentPeers().map(p => p.id).join(), seen = session.here;
      session.here = here;
      if (seen !== undefined && here !== seen) { session.cursors?.request(); soon(); renderStrip(); }
    }
    // What the host holds of this window's edits (its hello and heartbeat): the log keeps the rest.
    function noteAck(session, n) {
      if (!session.r || !Number.isSafeInteger(n) || n <= session.acked) return;
      session.acked = Math.min(n, session.r.ownSeq());
    }
    // The bounded log never drops this window's own edits before the host has them. An older host
    // never confirms (its hello has no `acks`): while it is here, the log is trimmed as before.
    // Away from the host, past UNSENT edits, this copy can no longer catch the session up.
    function keepLog(session) {
      const r = session.r;
      if (!r) return;
      if (isHost(session.me) || !session.host || session.diverged) { r.trim(); return; }
      const reachable = session.connection === "open" && presentPeers().some(p => p.id === session.host);
      if (reachable && !session.hostAcks) { r.trim(); return; }
      if (!reachable) {
        const unsent = r.unsent(session.acked);
        if (unsent.ops > UNSENT || unsent.bytes > UNSENT_BYTES) { diverge(session, unsent.ops); r.trim(); return; }
      }
      r.trim(session.acked);
    }
    // Too many edits away from the host to catch it up: say so, keep them in this window only (it
    // still receives everyone else's), and offer Save As. Taking the host's copy is the person's
    // choice: the hello then says base "other" and the host replaces this copy (resetFrom).
    function diverge(session, n) {
      session.diverged = true;
      const take = () => { if (S !== session || session.base === "other") return; session.base = "other"; hello(); setSessionNotice({...sessionNotice, actions: []}); };
      setSessionNotice({key: "diverged:" + session.started, actions: [["Use the Host's Copy", take, false, "Replace this window's copy with the session's when the host is reachable; your changes that did not reach it are discarded"]],
        text: "You made more changes away from the session than this window can keep for it (" + n.toLocaleString() + "). They stay in this copy only and no longer reach the others. Save As keeps them."});
      say("Your offline changes no longer fit the session. Save As keeps them.", "warning");
    }
    function leave(immediate = false) {
      if (!S) return;
      const session = S;
      if (!immediate && S.editProject === host.project() && (commitTimer || S.dragMessages) && host.drag?.()?.before) host.setTool("select");
      if (S !== session) return;
      if (!immediate) audit();
      // A copy that no longer fits the session (diverge) continues from what the host holds of it.
      if (session.r && session.me) ownSeqs.set(session.me, Math.max(ownSeq(session.me), (session.diverged ? session.acked : session.r.ownSeq?.()) || 0));
      session.restoreCheck?.reject(Error("The session ended before restoring."));
      releaseRestoreHold(session);
      S = null;
      session.groupChannel?.ended();
      G.AtriumHistoryPanel?.sessionChanged();
      session.refreshDialog?.();
      clearTimeout(commitTimer); commitTimer = 0; clearTimeout(session.edgeTimer); clearTimeout(session.cameraTimer);
      session.waypoints?.reset();
      for (const f of session.offs) try { f(); } catch { /* gone */ }
      session.cursors?.stop();
      session.objectMotion?.stop();
      for (const t of session.timers) clearInterval(t);
      clearInterval(session.lockBeat);
      // Connections this window carries (pairing codes, its hub, the listener on this network) end
      // only after its last edits (the audit above) and its bye are on their way.
      let carried = true;
      const unhost = () => {
        if (!carried) return;
        carried = false;
        for (const p of session.pairings || []) p.close();
        session.pairing?.close(); session.hub?.close();
        if (session.lan) G.AtriumHost?.lanStop?.()?.catch?.(() => {});   // nothing listens once the session ends
      };
      const t = session.t;
      if (!immediate && t?.state === "open") {
        const stop = setTimeout(() => { t.close(); unhost(); }, 250);
        // A host whose window is the relay (on this network, or pairing codes) takes the session with it.
        t.send("bye", session.host === session.me && (session.lan || session.hub) ? {ended: true} : {}).finally(() => { clearTimeout(stop); t.close(); unhost(); });
      }
      else { t?.close(); unhost(); }
      renderStrip(); soon(); host?.redraw?.();
    }
    function onState(state, d) {
      if (!S) return;
      // Join rounds keep growing across sessions in this window (a rejoin keeps its peer id).
      if (state === "open" && !S.r) S.waitFrom = Date.now();
      if (state === "open") { S.joinRound = Math.max((S.joinRound || 0) + 1, (joinRounds = Math.max(joinRounds + 1, Math.floor(Date.now() / 1000) % 1e9))); S.snapshotFrom = null; }
      if (["connecting", "open", "offline", "ended", "error"].includes(state)) S.connection = state;
      if (state === "offline" || state === "ended" || state === "error") {
        S.restoreCheck?.reject(Error("The connection changed. Reconnect and review the version again.")); releaseRestoreHold(S);
        S.incomingVersions?.clear(); S.groupChannel?.offline();
        S.peers.clear(); S.claims.clear(); S.followed = null; S.cursors?.request();
      }
      if (state === "open" || state === "resync") S.groupChannel?.opened();
      if (state === "open") { if (d?.rtc === false) S.rtc = false; status(connectedStatus()); hello(); }
      else if (state === "path" || state === "peers") status(S.connection === "open" ? connectedStatus() : S.status);
      else if (state === "rtc") { S.rtc = d; status(connectedStatus()); }
      else if (state === "left") { const p = S.peers.get(d?.peer); if (p) dropPeer(p, d.peer); }
      else if (state === "resync") hello();
      else if (state === "incompatible") versionNotice(null, d?.protocol > d?.ours);
      else if (state === "ended") status(S.r ? "The host ended the session. You can save your copy." : "The host ended the session before the shared project arrived.");
      // When the host's own window is the relay, "the relay" is the host's computer.
      else if (state === "offline") status(!S.r ? "Connection lost while waiting for the shared project. Reconnecting…"
        : S.hostRelays ? "Can't reach the host's computer — your edits are kept here and sync if the session comes back. Save As keeps a copy."
        : "Offline — edits are kept and sync when the relay is back");
      else if (state === "connecting") status("Connecting…");
      else if (state === "error") status("Relay: " + (d || "Connection error"));
      else if (state === "flood") { const p = S.peers.get(d?.peer); if (p) p.muted = Date.now() + 30000; }
    }
    // Someone uses a transport protocol or major file format this build cannot share a session with.
    // Only the verified host's own hello (signed, decrypted) ends a join (security review N1): a
    // protocol number read before decryption, or another participant's claim, is a notice only.
    function versionNotice(p, theyAreNewer) {
      if (!S) return;
      if (p && isHost(p.id) && theyAreNewer && S.mode === "join") {
        const joining = !S.r; leave(); say("Update to join: this session's host uses a newer Waffle." + (joining ? " Your project is unchanged." : ""), "warning"); return;
      }
      if (S.incompatibleShown) return;
      S.incompatibleShown = true;
      const who = p ? p.name : "Someone";
      say(theyAreNewer ? who + " uses a newer Waffle that this one cannot work with. Update Waffle to edit with them." : who + " uses an older Waffle that cannot join; they need to update.", "warning");
    }
    // sharedRestore: "host" for the host; "guest" only for a guest that knows (and so can verify) its host.
    // acks: this build's host confirms everyone's edits (vv here, ack on its heartbeat); hub: the
    // host's own window is the relay, so the session ends when the host leaves.
    const hello = () => S?.t?.send("hello", {name: (pref(PREF_NAME, "") || "Someone").slice(0, 64), has: !!S.r, vv: S.r?.vv() || {}, waypoints: true, personalUndo: 2, reviewRecords:1,
      sharedRestore: isHost(S.me) ? "host" : S.host ? "guest" : null, joinRound: S.joinRound, base: S.r ? S.base || null : null,
      ...(isHost(S.me) && {acks: 1, ...((S.lan || S.hub) && {hub: 1})}),
      app: appVersion(), format: FORMAT(), protocol: G.AtriumCollabTransport?.constants.PROTOCOL});
    const roundOf = body => Number.isSafeInteger(body.joinRound) && body.joinRound > 0 ? body.joinRound : 0;
    function sendSnapshot(to, joinRound, reset=false) {
      const snap=S.r.snapshot();
      if (snap.reviewRecords && !S.peers.get(to)?.reviewRecords) {
        S.t.send("snapshot",{to,joinRound,error:"Update Waffle to join this project with shared Review records. Your current project is unchanged."}); return;
      }
      sendVersion("snapshot", {to, joinRound, ...(reset && {reset:true}), ...(isHost(S.me) && S.restoreBoundary), snap}, !!S.peers.get(to)?.sharedRestore);
    }
    function answerJoin(p, round) {
      if (!S.r) return;
      if (round && round <= (p.answeredRound || 0)) return;
      // Legacy editors send both hello and want. Retry a still-unacknowledged request
      // after the relay's rate window, e.g. if their connection broke during the snapshot.
      if (!round) {
        const otherResponder = presentPeers().some(other => other !== p && other.hasProject && (!other.joinRound || other.id < S.me));
        if (otherResponder || p.legacyRetryAfter > Date.now()) { p.legacyRetry = true; return; }
      }
      sendSnapshot(p.id, round);
      if (round) p.answeredRound = round;
      else { p.legacyRetryAfter = Date.now() + 10000; p.legacyRetry = false; }
    }
    function refreshJoin() {
      if (S.connection !== "open") return;
      let expired = false;
      for (const [from, version] of S.incomingVersions || []) if (Date.now() - version.last > 30000) {
        S.incomingVersions.delete(from); expired = true;
      }
      if (expired) { if (!S.r) { S.snapshotFrom = null; S.joinRound++; } hello(); }
      const present = presentPeers();
      if (S.r) {
        for (const p of present) if (p.legacyRetry && !(p.legacyRetryAfter > Date.now())) answerJoin(p, 0);
        return;
      }
      if (present.some(p => p.id === S.snapshotFrom && p.hasProject !== false)) return;
      // The starting project comes from the host named in the invitation. Without that host for
      // HOST_WAIT, another participant's copy is used, with a warning; the host checks it on arrival.
      let source = present.find(p => p.hasProject && isHost(p.id));
      if (!source && (!S.host || Date.now() - (S.waitFrom || Date.now()) > HOST_WAIT)) {
        source = present.find(p => p.hasProject);
        if (source && S.host && !S.warnedSource) { S.warnedSource = true; say("The host isn't here. Joining with " + source.name + "'s copy; the host checks it when they return.", "warning"); }
      }
      S.snapshotFrom = source?.id;
      if (source) S.t.send("want", {to: source.id, joinRound: S.joinRound});
    }
    function peer(id) { let p = S.peers.get(id); if (!p) { p = {id, name: "Someone", seen: Date.now(), colour: colourIndex(id)}; S.peers.set(id, p); } p.seen = Date.now(); return p; }
    // The editor flushes before picking a move or resize target. The following gesture
    // mutates the project until Drop or Escape settles its Undo mark.
    // Apply signed design messages in arrival order after that mark, including when the
    // user cancels. Presence, acknowledgements and restore readiness remain live.
    function waitForDrag(kind, body, sender) {
      if (!S.r || (kind !== "ops" && kind !== "snapshot") || !host.drag?.()?.before) return false;
      const waiting = S.dragMessages ||= {messages: [], size: 0};
      const size = JSON.stringify(body).length;
      if (waiting.messages.length >= 128 || waiting.size + size > G.AtriumCollabTransport.constants.MAX_BODY) {
        const session = S;
        host.setTool("select"); // Cancels the preview and drains the existing queue via move-end.
        if (S !== session) return true;
        say("The current drag was cancelled to apply the incoming shared changes.", "warning");
        return false;
      }
      waiting.messages.push([kind, body, sender]); waiting.size += size;
      return true;
    }
    function finishDrag() {
      if (!S?.dragMessages) return;
      const session = S, waiting = session.dragMessages;
      session.dragMessages = null;
      if (commitTimer) commitNow(); // The completed local gesture precedes the incoming patches.
      for (const message of waiting.messages) {
        if (S !== session) break;
        handleMessage(...message);
      }
    }
    function onMessage(kind, body, from) {
      if (!S || !body || typeof body !== "object") return;
      if (body.to && body.to !== S.me) return;
      if (kind === "group-library") {
        if (!S.groupChannel) return;  // Group libraries are opt-in on both sides.
        S.groupChannel.receive(body, from);
        return;
      }
      if ((kind === "snapshot" || kind === "ops") && body.page !== undefined) {
        body = receiveVersion(kind, body, from);
        if (!body) return;
      }
      const p = peer(from);
      if (!waitForDrag(kind, body, p)) handleMessage(kind, body, p);
    }
    function handleMessage(kind, body, p) {
      const from = p.id;
      if (kind === "hello") {
        p.name = clean(body.name) || "Someone";
        p.waypoints = body.waypoints === true;
        p.personalUndo = body.personalUndo === 2;
        p.reviewRecords = body.reviewRecords === 1;
        p.sharedRestore = ["host", "guest"].includes(body.sharedRestore) ? body.sharedRestore : null;
        p.app = clean(body.app, 32); p.format = clean(body.format, 8);
        if (p.format && major(p.format) !== major(FORMAT())) { versionNotice(p, major(p.format) > major(FORMAT())); if (!S) return; }
        else if (minor(p.format) > minor(FORMAT()) && !p.newerNoted) {
          p.newerNoted = true;
          say((clean(body.name) || "Someone") + " uses a newer Waffle. Objects only it understands are kept unchanged here (this window doesn't show them).");
        }
        const round = roundOf(body), reconnected = p.joinRound !== undefined && p.joinRound !== round;
        p.joinRound = round; p.hasProject = body.has === true;
        if (p.hasProject) { p.legacyRetry = false; p.legacyRetryAfter = 0; }
        // Only the verified host's word counts for what it holds and for its window being the relay.
        if (isHost(from) && !isHost(S.me)) {
          S.hostRelays = body.hub === 1;
          if (body.acks === 1) S.hostAcks = true;
          if (body.vv && typeof body.vv === "object") noteAck(S, Number(body.vv[S.me]));
        }
        // A copy that did not come from the host, or claims more edits by the host than it made,
        // may be forged: replace it with the host's (once per join round).
        if (isHost(S.me) && S.r && p.hasProject && (body.base === "other" || body.vv && Number(body.vv[S.me]) > (S.r.vv()[S.me] || 0))) {
          if (p.resetRound !== round || !round) { p.resetRound = round; sendSnapshot(p.id,round,true); }
        } else if (S.r && p.hasProject && body.vv && typeof body.vv === "object") {
          // Others send only their own edits, which a copy someone else made may hide behind a
          // floor the receiver lacks: ask for those alone. A copy that no longer fits the session
          // (diverge) sends nothing; the host replaces it.
          const ops = isHost(S.me) ? S.r.since(body.vv) : S.diverged ? [] : S.r.since({[S.me]: Number(body.vv[S.me]) || 0}, S.me);
          if (!p.personalUndo && (ops === null || ops.some(op => op.t === "undo"))) {
            if (!p.rejoinNotice && S.mode === "start") {
              p.rejoinNotice = true;
              say(p.name + " needs to leave and rejoin to sync their older editor. They can save a copy first.", "warning");
            }
          } else if (ops === null) { if (isHost(S.me)) sendSnapshot(p.id, round); }
          else {
            // The host relays everyone's missing edits. Others send only their own: a receiver
            // accepts other people's edits only from the host it verified.
            const mine = isHost(S.me) ? ops : ops.filter(op => op.ts.r === S.me);
            if (mine.length) {
              const parts = operationBatches({from: S.me, ops: mine});
              if (isHost(S.me) && p.sharedRestore && S.restoreBoundary) sendVersion("ops", {to: p.id, joinRound: round, batches: parts, ...S.restoreBoundary});
              else for (const part of parts) S.t.send("ops", {...part, to: p.id, catchUp: true});
            }
          }
        } else if (S.r && !p.hasProject && !round) answerJoin(p, 0);
        if (!S.r && p.hasProject) {
          if (reconnected && S.snapshotFrom === p.id) S.snapshotFrom = null;
          refreshJoin();
        }
        if (!p.greeted || reconnected) {
          if (S.r || !p.hasProject) hello();
          sendCursor();
          if (!p.greeted) say(p.name + " joined the live session");
          p.greeted = true;
          S.refreshDialog?.();
        }
        soon(); renderStrip(); S.cursors.request();
      } else if (kind === "want") {
        if (!body.to || body.to === S.me) answerJoin(p, roundOf(body));
      } else if (kind === "snapshot") {
        const round = roundOf(body);
        if (body.error && body.to === S.me && (!round || round === S.joinRound)) {
          if (!S.r) leave();
          say(clean(body.error, 160), "warning"); return;
        }
        if (!S.r && (!body.to || body.to === S.me) && (!round || round === S.joinRound) && (from === S.snapshotFrom || isHost(from))) {
          S.snapshotFrom = from;
          adopt(body.snap, p, body);
        } else if (S.r && body.reset === true && body.to === S.me && isHost(from)) {
          resetFrom(body.snap, p);
        } else if (S.r && body.to === S.me && (!round || round === S.joinRound) && isHost(from)) {
          if (commitTimer) commitNow();
          const session = S;
          try {
            const merged = session.r.merge(body.snap);
            rememberRestore(body, from);
            if (merged.applied) {
              patchHost(session, merged.touched, undefined, session.editProject, true);
              if (session.mode === "start" || savedFolder()) host.markUnsaved();
            }
          } catch (err) { G.console?.warn?.("Could not merge a collaboration snapshot", err.message); }
        }
      } else if (kind === "ops") {
        if (S.r && (!roundOf(body) || roundOf(body) === S.joinRound)) applyRemote(body, from);
      }
      else if (kind === "restore") onRestoreMessage(body, p);
      else if (kind === "cursor") {
        const doc = clean(body.doc, 128);
        if (body.posOnly === true) {
          if (p.doc === doc) S.cursors.sample(p, doc, point(body.at), body.end === true, body.turn === true);
          p.record = null;
          return;
        }
        // The host's heartbeat says how many of this window's edits it holds.
        if (isHost(from) && !isHost(S.me) && body.ack && typeof body.ack === "object") { S.hostAcks = true; noteAck(S, Number(body.ack[S.me])); }
        // A heartbeat that repeats the last record only refreshes the soft locks: nothing to draw.
        const record = JSON.stringify([doc, body.at, body.sel, body.lock, body.act, body.cam]);
        if (record === p.record && body.end !== true && body.turn !== true) { p.lockAt = Date.now(); return; }
        p.record = record;
        const act = clean(body.act, 80), changed = p.doc !== doc || p.act !== act;
        S.cursors.sample(p, doc, point(body.at), body.end === true, body.turn === true);
        p.act = act;
        p.sel = Array.isArray(body.sel) ? body.sel.slice(0, 64).map(x => clean(x, 128)).filter(Boolean) : [];
        p.lock = Array.isArray(body.lock) ? body.lock.slice(0, 256).map(x => clean(x, 128)).filter(Boolean) : [];
        p.lockAt = Date.now();
        const c = body.cam; p.cam = c && finite(c.cx) && finite(c.cy) && finite(c.scale) && c.scale > 0 ? {cx: c.cx, cy: c.cy, scale: c.scale} : null;
        if (p.cam && typeof c.flipped === "boolean") p.cam.flipped = c.flipped;
        if (S.followed === from) follow(p);
        if (changed) { soon(); renderStrip(); }
      } else if (kind === "bye") {
        // The host's window was the relay: the session has ended for everyone. Final, and said so.
        if (isHost(from) && body.ended === true && S.mode === "join") { hostEnded(p); return; }
        dropPeer(p, from);
      }
    }
    function hostEnded(p) {
      const kept = !!S.r;
      leave(true);
      if (kept) setSessionNotice({key: "ended:" + Date.now(), text: p.name + " ended the session. This window keeps your copy, unsaved: Save As keeps it."});
      say(p.name + " ended the session." + (kept ? " Your copy stays open; Save As keeps it." : " Your project is unchanged."), "warning");
    }
    function dropPeer(p, from) {
      if (!S.peers.has(from)) return;
      S.restoreCheck?.reject(Error(p.name + " left the session. Review the version again."));
      if (S.restoreHold?.from === from) releaseRestoreHold(S);
      S.incomingVersions?.delete(from); S.groupChannel?.left(from);
      S.peers.delete(from); if (S.followed === from) S.followed = null; if (!S.r) refreshJoin();
      say(p.name + " left the live session"); soon(); renderStrip(); S.cursors.request(); S.refreshDialog?.();
    }
    // The host found this replica's history inconsistent with its own (a forged starting copy):
    // take the host's state whole. Unsent local edits since then are lost; say so.
    function resetFrom(snap, p) {
      if (commitTimer) commitNow();
      try {
        const forged = S.base !== "other";
        S.r = replicaFrom(snap, p.id); S.base = "host";
        S.acked = S.r.vv()[S.me] || 0;
        if (S.diverged) { S.diverged = false; setSessionNotice(null); }
        patchHost(S, null, undefined, S.editProject, true);
        hello();
        say(forged ? p.name + " (the host) replaced this window's copy of the shared project: it did not match the host's."
          : "Now using " + p.name + "'s copy (the host's). Your edits that reached the host are in it.", forged ? "warning" : undefined);
      } catch (e) { G.console?.warn?.("Could not take the host's project", e.message); }
    }
    async function adopt(snap, p, message) {
      const session = S;
      if (session.receiving) return;
      session.receiving = true;
      try {
        const C = G.AtriumCollabCRDT, r = replicaFrom(snap, p.id);
        // A session at its author limit could not accept this window's edits: say so instead.
        if (Object.keys(r.vv()).length >= C.LIMITS.authors) {
          leave(); say("This session has reached its limit of " + C.LIMITS.authors + " editors. Ask the host to start a new session.", "warning"); return;
        }
        const project = r.project();
        if (G.AtriumLazy?.validatorsFor) await G.AtriumLazy.need(G.AtriumLazy.validatorsFor(project));
        if (S !== session || session.r || session.connection !== "open") return;
        G.Atrium.validate(JSON.parse(JSON.stringify(project)));
        // Initial join consent predates the network wait. The current window may now contain a draft or a drag.
        const field = document.activeElement;
        const editingField = (field?.isContentEditable || field?.matches("input, textarea, select")) && !field.closest(".collab-dialog");
        if (host.isDirty() || host.revision() !== session.joinRevision || ["move", "resize"].includes(host.drag()?.kind) || !["select", "pan", "measure"].includes(host.tool()) ||
            editingField || document.querySelector("dialog[open]:not(.collab-dialog)")) {
          leave();
          say("Kept your current project. Finish and save your work, then join the session again.", "warning");
          return;
        }
        session.applying = true;
        try {
          session.adopting = true;
          if (!await host.replaceProject(project, {force: true, copy: true, dirty: false, current: () => S === session})) return;
        } finally { session.applying = session.adopting = false; }
        if (S !== session) return;
        S.r = r; S.editProject = host.project(); rememberCursor(S); S.base = isHost(p.id) ? "host" : "other";
        if (isHost(p.id)) S.acked = r.vv()[S.me] || 0;
        rememberRestore(message, p.id);
        G.AtriumHistoryPanel?.sessionChanged();
        if (S.connection === "open") status(connectedStatus());
        hello();
        say("Joined " + p.name + "'s live session");
        setAsideNotice(session);
      } catch (e) { if (S === session) say("Couldn't join: " + e.message, "error"); }
      finally { session.receiving = false; }
    }
    // A live edit must be its sender's own. Edits by others (a catch-up, a shared version) are
    // accepted only from the verified host; from anyone else they are cut down to the sender's own.
    function applyRemote(b, from) {
      // A remote edit can arrive during the debounce on a completed local edit.
      // Record the local edit first so patching the incoming state cannot erase it.
      if (commitTimer) commitNow();
      let res;
      try {
        if (b.batches) {
          if (!Array.isArray(b.batches) || !b.batches.length || b.batches.length > 64) throw Error("Invalid shared version.");
          // A disconnected transfer never advances the vector. Validate every batch, then
          // apply them without yielding and patch the working project once.
          for (const batch of b.batches) {
            if (!Array.isArray(batch?.ops) || !batch.ops.length || batch.ops.length > G.AtriumCollabCRDT.LIMITS.ops ||
                operationBatches(batch, true).length !== 1) throw Error("Invalid shared version.");
          }
          const touched = new Set(), trusted = isHost(from);
          for (const batch of b.batches) {
            const own = trusted ? batch : {from, ops: batch.ops.filter(op => op?.ts?.r === from)};
            if (own.ops.length) for (const id of S.r.receive(own, trusted ? {} : {author: from}).touched) touched.add(id);
          }
          res = {touched, applied: touched.size};
          rememberRestore(b, from);
        } else if (b.catchUp && isHost(from)) res = S.r.receive(b);
        else {
          const own = b.catchUp ? {from, ops: Array.isArray(b.ops) ? b.ops.filter(op => op?.ts?.r === from) : []} : b;
          if (b.catchUp && !own.ops.length) return;
          res = S.r.receive(own, {author: from});
        }
      } catch (e) { if (/older editor.*Review/.test(e.message)) say(e.message,"warning"); else G.console?.warn?.(e.message); return; }
      if (!res.applied) return;
      const session = S, observers = new Map(), motion = session.objectMotion;
      const limits = G.AtriumCollabObjectMotion.limits;
      if (res.touched.size > limits.items) motion.clear();
      else if (!document.hidden && !G.AtriumPower?.idle?.() && G.AtriumMotion?.level?.() !== "off") {
        const defs = host.defs();
        let oldDefs = defs;
        for (const pane of host.panes()) {
          const id = pane.docId, kind = host.docById(id)?.kind;
          if (observers.has(id) || !["schematic", "pcb"].includes(kind) || G.Atrium3D?.isOpen?.(pane.canvas.parentElement)) continue;
          observers.set(id, (before, after) => {
            // Large polygons are already redrawn by the model update. Keep their geometry out of the animation budget.
            if (before?.points?.length > limits.points || after?.points?.length > limits.points) {
              motion.cancel(id, (after || before).id);
              return;
            }
            try {
              // The library is patched after the documents. Detach an old symbol only
              // if this edit changes both the instance and its definition.
              if (before?.def && res.touched.has(before.def) && defs.has(before.def)) {
                if (oldDefs === defs) oldDefs = new Map(defs);
                if (oldDefs.get(before.def) === defs.get(before.def)) oldDefs.set(before.def, G.Atrium.clone(defs.get(before.def)));
              }
              motion.change(id, before && G.Atrium.clone(before), after && G.Atrium.clone(after), oldDefs);
            }
            catch (e) { G.console?.warn?.("Could not animate a shared object", e.message); }
          });
        }
      }
      const changed = patchHost(session, res.touched, observers, session.editProject, true);
      // A host or someone saving a named copy needs Save to write incoming edits as well.
      if (changed && (session.mode === "start" || savedFolder())) host.markUnsaved();
    }
    // An established drag keeps its objects. If two new claims cross in flight, every editor
    // uses the same peer-id order. Expire a lost claim after a missed five-second heartbeat.
    function softLocked() {
      const out = new Map();
      for (const p of peers()) if (p.lock?.length && Date.now() - p.lockAt < 8000) {
        for (const id of p.lock) {
          if (S.claims.has(id) && S.me < p.id) continue;
          if (!out.has(id) || p.id < out.get(id).id) out.set(id, p);
        }
      }
      return out;
    }
    // Selected proposal/script targets can be checked before their transaction.
    // null means an unknown footprint; the actual operations are checked again at flush.
    function guardObjects(ids) {
      if (!S?.r) return false;
      const locked = softLocked();
      if (!locked.size) return false;
      for (const id of ids ?? locked.keys()) {
        const who = locked.get(id);
        if (!who) continue;
        say(who.name + " is " + (who.act || "editing") + " — wait for them to finish before applying this change", "warning");
        return true;
      }
      return false;
    }
    let commitTimer = 0;
    function onLocal() {
      if (!S?.r || S.applying) return;
      const session = S, project = host.project();
      if (session.editProject !== project) {
        // Add Existing swaps the working object inside this session. File > Open,
        // in contrast, has already emitted replace and detached this listener.
        session.editProject = project; session.editCursor = null;
      } else if (session.editCursor && G.AtriumUndoStore?.itemEdits?.(project)?.cursor === session.editCursor) return;
      S.objectMotion?.localChange();
      clearTimeout(commitTimer);
      commitTimer = setTimeout(() => { if (S === session) commitNow(); }, 16);
    }
    function commitNow() {
      // A pending publication can be flushed explicitly or by the timer. Neither may
      // diff or record the provisional pose. move-end drains it after Drop or Escape.
      if (S?.editProject === host.project() && host.drag?.()?.before) {
        S.dragMessages ||= {messages: [], size: 0};
        return;
      }
      clearTimeout(commitTimer); commitTimer = 0;
      if (!S?.r || S.applying) return;
      const locked = softLocked();
      const session = S, project = session.editProject;
      const range = project === host.project() ? G.AtriumUndoStore?.itemEdits?.(project, session.editCursor, true) : null;
      const reconcile = ops => {
        const hit = [...session.r.touches({ops})].filter(id => locked.has(id));
        if (hit.length) {
          const who = locked.get(hit[0]);
          const patch = patchHost(S, hit, undefined, S.editProject, true);
          say(who.name + " is " + (who.act || "editing") + " — your change to that object was undone", "warning");
          return !patch || patch.scopes ? new Set(hit) : true;
        }
        return false;
      };
      const b = session.r.commit(project, {updates: range?.updates, structure: range?.structure, reconcile: locked.size ? reconcile : undefined});
      // A lock rollback may already have advanced the journal inside reconcile.
      rememberCursor(session);
      if (!b) return;
      if (b.related?.length) {
        patchHost(S, b.related);
      }
      sendEdits(b); syncHistoryButtons();
    }
    // The whole-project comparison at save and before leaving (AtriumCollabCRDT audit): what the
    // journal missed is published and counted in r.stats().repairs. Nothing runs while idle.
    let auditTimer = 0;
    function auditSoon() { if (!auditTimer) auditTimer = setTimeout(() => { auditTimer = 0; audit(); }, 0); }
    function audit() {
      const session = S;
      if (!session?.r || session.applying || session.editProject !== host.project() || host.drag?.()?.before) { if (commitTimer) commitNow(); return; }
      if (commitTimer) commitNow();
      const b = session.r.audit(session.editProject);
      rememberCursor(session);
      if (!b) return;
      if (b.related?.length) patchHost(session, b.related);
      sendEdits(b); syncHistoryButtons();
    }
    function historyAvailability() {
      if (!S?.r) return null;
      const available = presentPeers().every(p => p.personalUndo);
      return {undo: available && (!!commitTimer || S.r.canUndo()), redo: available && S.r.canRedo()};
    }
    // Per-user undo (editor.js asks before its own undo): only this person's operations.
    function undo(redo) {
      if (!S?.r) return false;
      if (presentPeers().some(p => !p.personalUndo)) {
        say("Personal undo and redo need everyone in this session to use the updated editor.", "warning");
        return true;
      }
      commitNow();
      if(G.AtriumLabs?.notebookEnabled()===false && S.r.historyTouches(redo,(item,key,after,before)=>{
        if(!item){
          if(key!=="rules")return false;
          const clauses=book=>JSON.stringify(book?.list?.filter(r=>r.origin?.kind==="calculation") || []);
          return clauses(after)!==clauses(before);
        }
        if(item.kind==="schematic")return key==="notesLayer" || (key==null && item.notesLayer!=null);
        const kind=G.Atrium.notebookItemKind;
        return !!(kind(item) || key && (kind({...item,[key]:before}) || kind({...item,[key]:after})));
      })){
        host.info?.("Notebook items are read-only while notebook features are off.");return true;
      }
      const b = redo ? S.r.redo() : S.r.undo();
      if (!b) { say(redo ? "Nothing of yours to redo" : "Nothing of yours to undo"); return true; }
      patchHost(S, S.r.touches(b));
      host.markUnsaved();
      sendEdits(b);
      host.info?.(redo ? "Redone (your changes only)" : "Undone (your changes only)");
      return true;
    }
    function sendEdits(batch) {
      if (S.diverged) return;   // this copy no longer fits the session (diverge): its edits stay here
      try { for (const part of operationBatches(batch)) S.t.send("ops", part); }
      catch (e) { say("This edit is only in your copy. " + e.message, "warning"); }
    }
    function operationBatches(batch, validate = false) {
      // Allow a large project to change in one action, within each recipient's message limits.
      const C = G.AtriumCollabCRDT, limit = G.AtriumCollabTransport.constants.MAX_BODY - 256, parts = [];
      let ops = [], size = 0;
      for (const op of batch.ops) {
        if (validate) C.checkOp(op);
        const n = JSON.stringify(op).length + 1;
        if (n > limit || (op.v !== undefined && JSON.stringify(op.v).length > C.LIMITS.value)) throw Error("One change is too large to share.");
        if (ops.length === C.LIMITS.ops || size + n > limit) { parts.push({from: batch.from, ops}); ops = []; size = 0; }
        ops.push(op); size += n;
      }
      if (ops.length) parts.push({from: batch.from, ops});
      return parts;
    }
    // The transport already encrypts, chunks and paces each message. Larger logical versions
    // arrive in addressed pages. Keep one incomplete version per sender and one bounded budget.
    const VERSION_PAGE = 1024 * 1024, VERSION_LIMIT = 64 * VERSION_PAGE;
    function sendVersion(kind, body, upgraded = true) {
      const json = JSON.stringify(body);
      if (json.length <= G.AtriumCollabTransport.constants.MAX_BODY) { S.t.send(kind, body); return; }
      if (!upgraded || json.length > VERSION_LIMIT) {
        const message = upgraded ? "This project is too large to send as a shared version." : "Open this large shared project with the updated editor.";
        if (kind === "snapshot") { S.t.send(kind, {to: body.to, joinRound: body.joinRound, error: message}); return; }
        throw Error(message);
      }
      const id = S.me + "." + (++restoreNumber), count = Math.ceil(json.length / VERSION_PAGE);
      for (let page = 0; page < count; page++) {
        S.t.send(kind, {to: body.to, joinRound: body.joinRound, id, page, count, data: json.slice(page * VERSION_PAGE, (page + 1) * VERSION_PAGE)});
      }
    }
    function receiveVersion(kind, msg, from) {
      if ((msg.joinRound && msg.joinRound !== S.joinRound) || typeof msg.id !== "string" || msg.id.length > 80 ||
          !Number.isInteger(msg.count) || msg.count < 2 || msg.count > VERSION_LIMIT / VERSION_PAGE ||
          !Number.isInteger(msg.page) || msg.page < 0 || msg.page >= msg.count || typeof msg.data !== "string" || msg.data.length > VERSION_PAGE) return null;
      const pending = S.incomingVersions ||= new Map(), now = Date.now();
      for (const [peer, transfer] of pending) if (now - transfer.last > 30000) pending.delete(peer);
      if (msg.page === 0) pending.set(from, {kind, id: msg.id, count: msg.count, chunks: [], size: 0, last: now});
      const part = pending.get(from);
      if (!part || part.kind !== kind || part.id !== msg.id || part.count !== msg.count || part.chunks.length !== msg.page) return null;
      let allocated = msg.data.length;
      for (const transfer of pending.values()) allocated += transfer.size;
      if (allocated > VERSION_LIMIT) { pending.delete(from); return null; }
      part.chunks.push(msg.data); part.size += msg.data.length; part.last = now;
      if (S.restoreHold?.from === from) extendRestoreHold(S);
      if (part.chunks.length < part.count) return null;
      pending.delete(from);
      const result = JSON.parse(part.chunks.join(""));
      return result && result.to === msg.to && result.joinRound === msg.joinRound ? result : null;
    }
    // A shared-restore boundary retires older personal history, so only the verified host may set
    // one (its own restore, sent by itself). Anyone else's is ignored.
    function rememberRestore({restore, through, restoredAt}, from) {
      // Only a fully installed version can retire older personal history. A hello, an
      // interrupted transfer or a version ahead of this replica cannot move this boundary.
      if (!isHost(from) || typeof restore !== "string" || !/^[a-zA-Z0-9_-]{1,64}\.\d+$/.test(restore) || !through || !restoredAt || !S.r) return;
      const covers = (have, need) => Object.entries(need).every(([actor, n]) => Number.isSafeInteger(n) && n >= 0 && n <= (Object.hasOwn(have, actor) ? have[actor] : 0));
      const author = restore.slice(0, restore.lastIndexOf("."));
      if (author !== from || !(restoredAt[author] > (through[author] || 0)) || !covers(S.r.vv(), restoredAt) || !covers(restoredAt, through)) return;
      if (S.restoreBoundary && !covers(restoredAt, S.restoreBoundary.restoredAt)) return;
      S.restoreBoundary = {restore, through, restoredAt};
      if (through[S.me]) S.r.forgetHistoryThrough(through[S.me]);
    }
    const hosting = () => S?.mode === "start" && !!S.r && S.connection === "open";
    function unfinishedEdit() {
      const field = document.activeElement;
      return S.claims.size || ["move", "resize"].includes(host.drag()?.kind) || !["select", "pan", "measure"].includes(host.tool()) ||
        ((field?.isContentEditable || field?.matches("input,textarea,select")) && !field.closest(".collab-dialog,.panel-history,.dv"));
    }
    function releaseRestoreHold(session) {
      const hold = session.restoreHold;
      if (!hold) return;
      clearTimeout(hold.timer); session.restoreHold = null; hold.dialog.close();
    }
    function extendRestoreHold(session) {
      clearTimeout(session.restoreHold.timer);
      session.restoreHold.timer = setTimeout(() => releaseRestoreHold(session), 15000);
    }
    function onRestoreMessage(body, peer) {
      if (!S.r || (body.to && body.to !== S.me) || typeof body.id !== "string" || body.id.length > 80) return;
      if (body.phase === "check" && S.mode === "join" && isHost(peer.id)) {
        const busy = unfinishedEdit() || S.restoreHold || document.querySelector("dialog[open]:not(.collab-dialog)");
        // In-order transport sends a completed local edit before its acknowledgement.
        if (!busy && commitTimer) commitNow();
        if (!busy) {
          const session = S, d = el("dialog", null, "collab-dialog"), note = el("p", "The host is restoring a shared version…");
          d.setAttribute("aria-label", "Restoring shared version"); d.setAttribute("aria-busy", "true");
          d.append(note); d.oncancel = event => event.preventDefault();
          globalThis.AtriumShell?.adoptDialog(d, {body:note, sheet:true});
          d.onclose = () => d.remove(); document.body.append(d); d.showModal();
          session.restoreHold = {id: body.id, from: peer.id, dialog: d};
          extendRestoreHold(session);
        }
        S.t.send("restore", {to: peer.id, id: body.id, phase: busy ? "busy" : "ready", vv: S.r.vv()});
      } else if (["ready", "busy"].includes(body.phase)) {
        const check = S.restoreCheck;
        if (!check || check.id !== body.id || !check.waiting.has(peer.id)) return;
        if (body.phase === "busy") { check.reject(Error(peer.name + " is editing. Try again when they finish.")); return; }
        if (G.AtriumCollabCRDT.canon(body.vv) !== check.vector) { check.reject(Error("Edits are still syncing. Review the version again.")); return; }
        check.waiting.delete(peer.id); if (!check.waiting.size) check.resolve();
      } else if (S.restoreHold?.id === body.id && S.restoreHold.from === peer.id && isHost(peer.id) && ["finish", "cancel"].includes(body.phase)) {
        releaseRestoreHold(S);
        if (body.phase === "finish") {
          if (S.restoreBoundary?.restore === body.id) say(peer.name + " restored the shared project.");
          else { say("Syncing the restored version…"); hello(); }
        }
      }
    }
    async function prepareRestore(entry) {
      if (!hosting()) throw Error("Only the connected host can restore a version for everyone.");
      if (unfinishedEdit()) throw Error("Finish the current edit before reviewing a restore.");
      if (commitTimer) commitNow();
      const session = S, project = host.project(), revision = host.revision(), folder = savedFolder(), generation = G.AtriumHost?.projectGeneration;
      const bound = () => folder === savedFolder() && generation === G.AtriumHost?.projectGeneration;
      const replicaClock = S.r.stats().clock, A = G.AtriumAutosave, C = G.AtriumCollabCRDT;
      const Hp = G.AtriumHistoryPanel || await G.AtriumLazy.need("AtriumHistoryPanel");
      const current = () => S === session && hosting() && project === host.project() && revision === host.revision() &&
        replicaClock === session.r.stats().clock && bound();
      const ensure = () => { if (!current()) throw Error("The shared project changed. Review the version again."); };
      if (entry.git) throw Error("Choose a private Timeline version to restore the shared project.");
      const saved = await A.read(entry.id);
      if (!Hp.ownSnapshot(saved.meta) || saved.meta.ts !== entry.snapshot?.ts || saved.meta.revision !== entry.snapshot?.revision)
        throw Error("That version changed or belongs to another project. Reopen Timeline.");
      ensure();
      const after = JSON.parse(saved.text);
      if (G.AtriumLazy?.validatorsFor) await G.AtriumLazy.need(G.AtriumLazy.validatorsFor(after));
      G.Atrium.validate(after); ensure();
      const before = G.Atrium.clone(project);
      return {before, after, current, async apply() {
        ensure();
        if (session.restoring || unfinishedEdit()) throw Error("Finish the current edit before restoring.");
        const people = presentPeers();
        if (people.some(p => !p.hasProject || !p.sharedRestore)) throw Error("Everyone needs to finish joining with an editor that supports shared restore.");
        const roster = () => { const now = presentPeers(); return now.length === people.length && people.every(p => now.includes(p)); };
        // Dry-run the forward change against the exact reviewed CRDT state before saving or publishing it.
        const trial = C.create({replica: session.me, snapshot: session.r.snapshot(), resume: true});
        const preview = trial.commit(after, {recordUndo: false});
        if (!preview) throw Error("This version already matches the shared project.");
        if (trial.diff(after).length) throw Error("This version cannot be represented by the current collaboration session.");
        const parts = operationBatches(preview, true);
        const id = session.me + "." + (++restoreNumber);
        const version = {batches: parts, through: session.r.vv(), restoredAt: trial.vv(), restore: id};
        if (parts.length > 64 || JSON.stringify(version).length > VERSION_LIMIT) throw Error("This version is too large to restore for everyone.");
        session.restoring = true;
        let finished = false, timer;
        try {
          await Hp.checkpoint("before-restore", current); ensure();
          if (!roster() || unfinishedEdit()) throw Error("Someone joined, left or started editing. Review the version again.");
          if (people.length) await new Promise((resolve, reject) => {
            session.restoreCheck = {id, waiting: new Set(people.map(p => p.id)), vector: C.canon(session.r.vv()), resolve, reject};
            timer = setTimeout(() => reject(Error("An editor did not finish syncing. Try again when everyone is connected.")), 6000);
            session.t.send("restore", {id, phase: "check"});
          });
          ensure();
          if (!roster() || unfinishedEdit()) throw Error("The session changed. Review the version again.");
          const batch = session.r.commit(after, {recordUndo: false});
          patchHost(session, session.r.touches(batch), undefined, project); host.markUnsaved();
          let offset = 0;
          for (const part of parts) {
            part.ops = batch.ops.slice(offset, offset + part.ops.length);
            offset += part.ops.length;
          }
          rememberRestore(version, session.me);
          sendVersion("ops", version);
          finished = true;
          const restoredRevision = host.revision();
          const restoredCurrent = () => S === session && project === host.project() && bound() && restoredRevision === host.revision();
          // This entry describes the committed version. Newer edits still get ordinary autosaves.
          Hp.checkpoint("restored", restoredCurrent).then(() => G.AtriumHistoryPanel?.sessionChanged(),
            err => { if (restoredCurrent()) say("The shared version was restored. Timeline could not record the new version. " + err.message, "warning"); });
        } finally {
          clearTimeout(timer); session.restoreCheck = null; session.restoring = false;
          if (people.length && S === session && hosting()) session.t.send("restore", {id, phase: finished ? "finish" : "cancel"});
        }
      }};
    }
    let restoreNumber = 0;
    function activity() {
      const r = host.liveRoute?.();
      if (r) return "routing " + (r.net || "a track");
      const d = host.drag?.(), sel = host.selection?.() || [];
      if (d && (d.kind === "move" || d.kind === "drag")) return "moving " + labels(sel);
      const tool = host.tool?.();
      if (tool === "move-object") return "moving " + labels(sel);
      if (tool === "place") return "placing a part";
      if (tool === "route") return "drawing a wire";
      return "";
    }
    function labels(ids) {
      const d = host.doc?.(), names = [];
      for (const id of ids.slice(0, 3)) { const it = d?.items.find(i => i.id === id); if (it) names.push(it.ref || it.text || it.net || it.kind); }
      return names.join(", ") + (ids.length > 3 ? " +" + (ids.length - 3) : "") || "objects";
    }
    function sendCursor(client, end = false, movement = false, turn = false, beat = false) {
      if (!S?.r || !S.t || S.connection !== "open") return;
      const view = host.view(), cam = view.camera(), sel = (host.selection?.() || []).slice(0, 64), act = activity();
      const route = host.liveRoute?.(), moving = host.drag?.()?.kind === "move" || host.tool?.() === "move-object";
      const targets = route ? (route.preview?.pushed || []).map(item => item.id) : moving ? sel : [];
      const blocked = softLocked(), lock = targets.filter(id => !blocked.has(id)).slice(0, 256);
      if (commitTimer && S.claims.size && [...S.claims].some(id => !lock.includes(id))) commitNow();
      S.claims = new Set(lock);
      // Soft locks expire after 8 s at the others: refresh them every 4 s, only while dragging.
      if (lock.length && !S.lockBeat) { const session = S; S.lockBeat = setInterval(() => { if (S === session) sendCursor(); }, LOCK_BEAT); }
      else if (!lock.length && S.lockBeat) { clearInterval(S.lockBeat); S.lockBeat = 0; }
      const doc = host.currentId(), pointer = S.pointer;
      let at = null;
      if (pointer?.canvas === host.canvas() && pointer.doc === doc) {
        if (pointer.world && (!client || client === pointer.client)) at = pointer.world;
        else {
          const rect = pointer.canvas.getBoundingClientRect(), [x, y] = client || pointer.client;
          at = view.screenToWorld([x - rect.left, y - rect.top]);
        }
      }
      const state = {doc, sel, act, lock, cam: {cx: cam.cx, cy: cam.cy, scale: cam.scale, flipped: cam.flipped}};
      const signature = JSON.stringify(state);
      // Older editors expect complete cursor records. A mixed room uses the same sparse cadence.
      const compact = movement && signature === S.cursorState && [...S.peers.values()].every(p => p.waypoints);
      S.cursorState = signature;
      const body = compact ? {doc, posOnly: true, at} : {...state, at};
      if (end) body.end = true;
      if (turn) body.turn = true;
      // The host's heartbeat confirms what it holds of everyone's edits (guests trim their logs by it).
      if (beat && !compact && isHost(S.me)) body.ack = S.r.vv();
      S.t.send("cursor", body);
    }
    function follow(p) {
      if (!p) return;
      if (p.doc && p.doc !== host.currentId?.() && host.docById?.(p.doc)) host.selectDocument(p.doc);
      if (p.cam) {
        const v = host.view(), cam = v.camera();
        if (cam.cx !== p.cam.cx || cam.cy !== p.cam.cy || cam.scale !== p.cam.scale || (p.cam.flipped !== undefined && cam.flipped !== p.cam.flipped)) { v.restoreCamera({...cam, ...p.cam}); host.redraw?.(); }
      }
    }
    function setFollow(id) { if (!S) return; S.followed = S.followed === id ? null : id; const p = S.peers.get(id); if (S.followed && p) { follow(p); say("Following " + p.name + " (move the view to stop)"); } renderStrip(); }
    // The strip in the status bar: who is here, what they do, follow buttons.
    let strip = null, stripSignature = "";
    function renderStrip() {
      if (host) syncHistoryButtons();
      const status = document.getElementById("status");
      if (!S) { strip?.remove(); strip = null; stripSignature = ""; return; }
      if (!strip?.isConnected) { strip = el("span", null, "collab-strip"); (status?.parentElement || document.body).insertBefore(strip, status || null); }
      const here = peers(), signature = JSON.stringify([S.status, S.followed, ...here.map(p => [p.id, p.name, p.act])]);
      if (signature === stripSignature) return;
      stripSignature = signature;
      strip.replaceChildren(el("span", S.status || "Live", "collab-strip-state"));
      for (const p of here) {
        const b = btn("", () => setFollow(p.id), "collab-strip-peer" + (S.followed === p.id ? " is-following" : ""));
        b.setAttribute("aria-label", (S.followed === p.id ? "Stop following " : "Follow ") + p.name + (p.act ? " — " + p.act : ""));
        b.append(avatar(p.name, "is-live", p.name, p.id), el("span", p.act ? p.name + " is " + p.act : p.name));
        strip.append(b);
      }
      const waiting = S.mode === "join" && !S.r;
      strip.append(btn(waiting ? "Cancel Join" : "Leave", () => leave(), "collab-strip-leave"));
    }
    function copyButton(label, value) {
      const b = btn(label, async () => {
        try { await G.navigator.clipboard.writeText(value()); b.textContent = "Copied"; setTimeout(() => { b.textContent = label; }, 2000); }
        catch { say("Copy it from the field instead.", "warning"); }
      });
      return b;
    }
    function setAsideNotice(session) {
      const n = session.r?.hiddenCount?.() || 0;
      if (n && S === session) say(n + (n === 1 ? " object" : " objects") + " from a newer Waffle " + (n === 1 ? "is" : "are") + " kept unchanged and not shown here. Share lists " + (n === 1 ? "it" : "them") + ".");
    }
    function discardSetAside(session) {
      if (S !== session || !session.r || !isHost(session.me)) return;
      if (commitTimer) commitNow();
      const b = session.r.discardHidden?.();
      if (b) { sendEdits(b); say("Discarded the objects this Waffle cannot show, for everyone in the session."); }
      session.refreshDialog?.();
    }
    // The invitation link as a QR code (dark modules on white for any scanner, in both themes).
    function qrCode(text) {
      let q;
      try { q = G.AtriumPCBTextRich?.qr?.(text, "M"); } catch { return null; }
      if (!q) return null;
      const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), n = q.size + 8;
      svg.setAttribute("viewBox", "0 0 " + n + " " + n); svg.setAttribute("class", "collab-qr");
      svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "QR code of the invitation link");
      const bg = document.createElementNS(NS, "rect"), path = document.createElementNS(NS, "path");
      bg.setAttribute("width", String(n)); bg.setAttribute("height", String(n)); bg.setAttribute("fill", "white");
      let dPath = "";
      for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x]) dPath += "M" + (x + 4) + " " + (y + 4) + "h1v1h-1z";
      path.setAttribute("d", dPath); path.setAttribute("fill", "black");
      svg.append(bg, path);
      return svg;
    }
    // People in the session: one button each, with how they are connected; choosing one explains it.
    const PATH_LABEL = {direct: "Direct", turn: "via TURN", relay: "via relay server", host: "through the host", local: "this computer", connecting: "Connecting"};
    function pathOf(session, id) {
      const v = session.t?.paths?.()?.get(id);
      if (!v) return "connecting";
      return v === "relay" && (session.hub || session.pairing) ? "host" : v;
    }
    function explainPath(name, path) {
      return ({
        direct: name + " and you are connected directly (WebRTC). Each of you can see the other's IP address.",
        turn: name + "'s connection goes through the TURN server beside the relay server, so neither of you learns the other's IP address.",
        relay: name + "'s edits go through the relay server: a direct connection did not work, or Preferences › Collaboration › Connection asks for the relay.",
        host: name + "'s edits go through the host's window (a pairing code connected them).",
        local: name + " is in another window on this computer.",
        connecting: "Connecting to " + name + "…"
      }[path] || "") + (path === "connecting" ? "" : " Everything is end-to-end encrypted with the session key.");
    }
    async function createPairing(session) {
      const P = G.AtriumCollabPair || await G.AtriumLazy.need("AtriumCollabPair");
      if (S !== session) throw Error("The session ended.");
      const carry = session.hub ? sock => session.hub.attach(sock) : sock => P.forward(sock, session.url);
      const pairing = await P.offer({roomKey: session.roomKey, salt: session.salt, host: session.me, name: (pref(PREF_NAME, "") || "").slice(0, 64), relayed: !session.hub}, carry);
      if (S !== session) { pairing.close(); throw Error("The session ended."); }
      (session.pairings ||= []).push(pairing);
      return pairing;
    }
    // Other ways to connect (the host): a pairing code per guest.
    function otherWays(session) {
      const box = el("details", null, "collab-ways");
      box.open = !!session.hub;
      box.append(el("summary", "Other ways to connect"));
      const card = el("section", null, "collab-card");
      card.append(el("h3", "Pairing code"), el("p", session.hub
        ? "No server: each guest gets a code from you and sends a reply back. Their computer connects to this one directly (the same network, or one of you reachable), and their edits go through this window."
        : "For someone who cannot reach the relay server: their computer connects to this one directly, and this window carries their connection to the relay.", "collab-note"));
      const create = btn("Create Pairing Code", null, "collab-button" + (session.hub ? " is-primary" : ""));
      const codeRow = el("label", null, "collab-field"), code = el("textarea"), copy = copyButton("Copy Code", () => code.value);
      code.readOnly = true; code.rows = 3; code.spellcheck = false;
      codeRow.append(el("span", "Pairing code"), code, el("small", "Send it privately, like the link: it holds the session key. It works once, for one guest."));
      const replyRow = el("label", null, "collab-field"), reply = el("textarea"), connect = btn("Connect", null, "collab-button is-primary");
      reply.rows = 3; reply.spellcheck = false; reply.autocomplete = "off"; reply.placeholder = "atrium-reply.…";
      replyRow.append(el("span", "Their reply"), reply, el("small", "Paste the reply code the guest sends back, then Connect."));
      const state = el("p", "", "collab-note");
      state.setAttribute("role", "status");
      const actions = el("div", null, "collab-dialog-actions");
      actions.append(copy, connect);
      for (const n of [codeRow, replyRow, actions]) n.hidden = true;
      let current = null;
      create.onclick = async () => {
        create.disabled = true; state.textContent = "Preparing a code…";
        try {
          current = await createPairing(session);
          code.value = current.code; reply.value = "";
          for (const n of [codeRow, replyRow, actions]) n.hidden = false;
          state.textContent = "Send the code, then paste the reply here.";
          create.textContent = "Create Another Code";
          code.focus(); code.select();
        } catch (e) { state.textContent = e.message; }
        finally { create.disabled = false; }
      };
      connect.onclick = async () => {
        if (!current) return;
        connect.disabled = true; state.textContent = "Connecting…";
        try {
          await current.accept(reply.value);
          current = null; code.value = reply.value = "";
          for (const n of [codeRow, replyRow, actions]) n.hidden = true;
          state.textContent = "Connected. They join in a moment; create another code for the next person.";
          create.focus();
        } catch (e) { state.textContent = e.message; }
        finally { connect.disabled = false; }
      };
      reply.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); connect.onclick(); } });
      card.append(create, codeRow, replyRow, actions, state);
      box.append(card);
      return box;
    }
    function connectedDialog(d, session) {
      const message = el("p", "", "collab-note");
      message.setAttribute("role", "status");
      d.append(message);
      // The host's invitation: a link (the room key stays in the fragment), the same as text, a QR code.
      const invite = el("div", null, "collab-invite");
      if (session.invite) {
        const row = el("label", null, "collab-field"), link = el("input");
        link.readOnly = true; link.value = session.invite.link || session.invite.text.split("\n").slice(0, 3).join(" · ");
        row.append(el("span", "Invitation"), link, el("small", session.invite.link
          ? "Anyone with this link can join and edit while you host. The room key is after the #, which browsers never send to a server." + (pathPref() === "auto" ? " A direct connection shows each of you the other's IP address (Preferences › Collaboration › Connection can avoid that)." : "")
          : "This session stays on this computer. Set a relay server in Preferences › Collaboration to invite others."));
        const actions = el("div", null, "collab-dialog-actions");
        if (session.invite.link) actions.append(copyButton("Copy Link", () => session.invite.link));
        actions.append(copyButton("Copy as Text", () => session.invite.text));
        invite.append(row);
        const qr = session.invite.link && qrCode(session.invite.link);
        if (qr) {
          const show = el("details", null, "collab-qr-box");
          show.append(el("summary", "QR code"), qr);
          invite.append(show);
        }
        invite.append(actions);
      }
      const ways = isHost(session.me) && session.url !== "local" ? otherWays(session) : null;
      if (session.lan && isHost(session.me)) {
        const box = el("section", null, "collab-section"), code = el("p", session.lan.code, "collab-code");
        code.setAttribute("aria-label", "Session code " + session.lan.code.split("").join(" "));
        const where = lanAddresses(session.lan).map(a => lanHostPort(a, session.lan.port)).join(", ");
        box.append(el("h3", "On this network"), el("p", "Visible as “" + session.lan.name + "”. People nearby choose it under Share › Join" + (where ? " (or type " + where + ")" : "") + ", then enter this code:", "collab-note"), code,
          el("p", "Read it out or send it; with the code they can join and edit while you host. Waffle stops listening when the session ends.", "collab-note"));
        d.append(box);
      }
      const people = el("div", null, "collab-people"), explain = el("p", "", "collab-note"), chips = new Map();
      people.setAttribute("role", "group"); people.setAttribute("aria-label", "People in this session");
      explain.setAttribute("role", "status");
      let explained = null;
      const leaveButton = btn("", () => leave(), "collab-button is-primary");
      const history = btn("Version history", async () => {
        try {
          const panel = G.AtriumHistoryPanel || await G.AtriumLazy.need("AtriumHistoryPanel");
          if (S !== session || !session.r || !d.open) return;
          d.close(); panel.openTimeline();
        } catch (err) { say(err.message, "error"); }
      });
      const aside = el("div", null, "collab-field"), asideText = el("small");
      const discard = btn("Discard Them", () => {
        // A second press confirms: the objects go for everyone.
        if (discard.dataset.confirm !== "1") { discard.dataset.confirm = "1"; discard.textContent = "Discard for Everyone"; return; }
        discard.dataset.confirm = ""; discard.textContent = "Discard Them"; discardSetAside(session);
      });
      aside.append(asideText, discard);
      session.refreshDialog = () => {
        if (S !== session) { d.close(); return; }
        message.textContent = session.status;
        leaveButton.textContent = session.mode === "join" && !session.r ? "Cancel Join" : "Leave Session";
        history.hidden = !session.r;
        // Chips are kept (and keep focus) across refreshes; only their text changes.
        const here = peers(), ids = new Set(here.map(p => p.id));
        for (const [id, chip] of chips) if (!ids.has(id)) { chip.remove(); chips.delete(id); }
        for (const p of here) {
          const path = session.url === "local" ? "local" : pathOf(session, p.id);
          let chip = chips.get(p.id);
          if (!chip) {
            chip = btn("", () => { explained = p.id; explain.textContent = explainPath(chip.dataset.name, chip.dataset.path); }, "collab-chip");
            chips.set(p.id, chip); people.append(chip);
          }
          chip.dataset.path = path; chip.dataset.name = p.name;
          // The dot says whether the peer is reached directly (success) or still connecting (muted).
          const dot = el("span", null, "ui-dot");
          if (path === "direct" || path === "local") dot.dataset.tone = "success";
          chip.replaceChildren(dot, p.name + " · " + PATH_LABEL[path]);
          if (explained === p.id) explain.textContent = explainPath(p.name, path);
        }
        if (explained && !ids.has(explained)) { explained = null; explain.textContent = ""; }
        people.hidden = !here.length; explain.hidden = !here.length;
        const n = session.r?.hiddenCount?.() || 0;
        aside.hidden = !n; discard.hidden = !isHost(session.me);
        asideText.textContent = n + (n === 1 ? " object" : " objects") + " from a newer Waffle " + (n === 1 ? "is" : "are") + " kept unchanged and not shown here." +
          (isHost(session.me) ? " Discarding removes them for everyone." : " The host can discard them.");
      };
      session.refreshDialog();
      const refresh = session.refreshDialog;
      d.addEventListener("close", () => { if (session.refreshDialog === refresh) session.refreshDialog = null; }, {once: true});
      d.append(invite, ...(ways ? [ways] : []), people, explain, aside, history, leaveButton);
    }
    function saveBeforeJoining() {
      return new Promise(resolve => {
        const name = host.project()?.name || "Untitled";
        const d = dialog("Save changes to “" + name + "” before joining?", (panel, actions) => {
          const message = el("p", "The shared project opens in this window. Save your project first to keep your changes.", "collab-note");
          message.setAttribute("role", "status");
          const save = btn("Save and Join", async () => {
            save.disabled = true;
            const ok = await host.saveProject();
            if (!d.open) return;
            if (ok && !host.isDirty()) d.close("saved");
            else {
              message.textContent = "Your project is still open, with its changes unsaved. Save again, or Cancel to keep editing.";
              save.disabled = false;
            }
          }, "collab-button");
          save.dataset.variant = "primary";
          panel.append(message); actions.append(save);
        }, "Cancel");
        d.addEventListener("close", () => resolve(d.returnValue === "saved"), {once: true});
      });
    }
    // Preferences › Test Connection: join a throwaway room (the relay's real path), and read /healthz.
    async function testRelay(url) {
      const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
      const authBytes = G.crypto.getRandomValues(new Uint8Array(32)), auth = hex(authBytes), room = hex(await G.crypto.subtle.digest("SHA-256", authBytes));
      const invited = hostInvite(), t0 = Date.now();
      const joined = await new Promise(resolve => {
        let ws;
        const done = r => { clearTimeout(timer); try { ws?.close(); } catch { /* closed */ } resolve(r); };
        const timer = setTimeout(() => done({error: "no answer in 8 s"}), 8000);
        try { ws = new G.WebSocket(url); } catch (e) { done({error: e.message}); return; }
        ws.onopen = () => ws.send(JSON.stringify({t: "join", room, auth, v: 2, host: invited?.relay === url ? invited.token : undefined}));
        ws.onmessage = e => { let m = null; try { m = JSON.parse(e.data); } catch { /* not ours */ } if (m?.t === "joined") done({ms: Date.now() - t0, v: m.v}); else if (m?.t === "error") done({refused: String(m.e || "").slice(0, 200), ms: Date.now() - t0}); };
        ws.onclose = () => done({error: "the connection closed"});
      });
      let health = null;
      try {
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 6000);
        const r = await G.fetch(new URL(url.replace(/^ws/i, "http")).origin + "/healthz", {cache: "no-store", signal: ctl.signal, credentials: "omit"});
        clearTimeout(timer);
        if (r.ok) health = await r.json();
      } catch { /* an older relay or a proxy without it */ }
      const turn = health ? (health.turn ? " TURN is on (for guests the host vouches for)." : " TURN is off: guests connect directly or through the relay.") : "";
      if (joined.refused) return /private/i.test(joined.refused) ? "The server answered in " + joined.ms + " ms. It is private: open a host invitation from its owner to host sessions there." + turn : "The server answered but refused: " + joined.refused;
      if (joined.error) return "Couldn't connect (" + joined.error + "). Check the address, and that port 443 is open on the server.";
      return "Connected in " + joined.ms + " ms (relay protocol " + (joined.v || "?") + ")." + turn + (health?.mode === "private" ? " Private: only invited hosts start sessions." : "");
    }
    // ---- same network (native/macos/LanRelay.swift, native/linux/lan_relay.py) ----
    const lanAvailable = () => G.AtriumHost?.lanAvailable === true && typeof G.AtriumHost.lanStart === "function";
    const lanNote = () => G.AtriumHost ? "Sharing on this network isn't available in the Windows app yet; use a link or a pairing code." : "Sharing on this network needs the Waffle app; use a link or a pairing code.";
    const LAN_PORT = 48765;
    // A typed session code: letters and digits in groups of four, as the host's window shows it.
    const sessionCode = text => (String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "").match(/.{1,4}/g) || []).join("-");
    function addressUrl(text) {
      const t = String(text || "").trim().replace(/\/+$/, "");
      const m = /^(?:wss?:\/\/)?(\[[0-9a-f:.]+\]|[^\s:/\[\]]+)(?::(\d{1,5}))?$/i.exec(t);
      if (!m) return null;
      const port = m[2] ? +m[2] : LAN_PORT;
      return port > 0 && port < 65536 ? "ws://" + m[1] + ":" + port : null;
    }
    // macOS asks for Local Network access the first time: say why first (once).
    function explainLocalNetwork() {
      if (!/Mac/i.test(G.navigator?.platform || "") || pref("collab.lanExplained", false) === true) return Promise.resolve(true);
      return new Promise(resolve => {
        let ok = false;
        const d = dialog("Local network access", (panel, actions) => {
          panel.append(el("p", "To share a session with people on this network, or to find theirs, Waffle needs macOS's permission to use your local network. macOS asks next.", "collab-note"),
            el("p", "Waffle listens only while you share a session as Visible on this network, and announces only the session's name. Joining still needs its code.", "collab-note"));
          const next = btn("Continue", () => { ok = true; setPref("collab.lanExplained", true); d.close(); });
          next.dataset.variant = "primary";
          actions.append(next);
        }, "Not Now");
        d.addEventListener("close", () => resolve(ok), {once: true});
      });
    }
    // The public facts of a session shared on the network (salt, name, host id), before joining.
    async function lanInfo(url) {
      const Socket = G.AtriumHost?.lanSocket ? await G.AtriumHost.lanSocket() : G.WebSocket;
      return new Promise((resolve, reject) => {
        let ws;
        const fail = () => reject(Error("No Waffle session answered at " + url.replace(/^ws:\/\//, "") + ". Check the address, and that the host chose Visible on this network."));
        const timer = setTimeout(() => { try { ws?.close(); } catch { /* closed */ } fail(); }, 6000);
        try { ws = new Socket(url); } catch { clearTimeout(timer); fail(); return; }
        ws.onopen = () => ws.send(JSON.stringify({t: "info"}));
        ws.onmessage = e => {
          let m = null; try { m = JSON.parse(e.data); } catch { /* not ours */ }
          if (m?.t !== "info" || typeof m.salt !== "string") return;
          clearTimeout(timer); ws.onclose = null; ws.close();
          resolve({salt: m.salt, name: typeof m.name === "string" ? m.name.slice(0, 64) : "", host: typeof m.host === "string" ? m.host : null});
        };
        ws.onclose = () => { clearTimeout(timer); fail(); };
      });
    }
    // What the Join field holds, before anything connects.
    function recognise(text) {
      const t = String(text || "").trim();
      if (!t) return {kind: null, label: ""};
      if (/#?atrium-host=1&/.test(t)) return {kind: "host", label: "A host invitation: it lets you start sessions on that server."};
      if (/^atrium-offer\./.test(t.replace(/\s+/g, ""))) return {kind: "offer", label: "A pairing code: you'll get a reply to send back to the host."};
      if (/^atrium-reply\./.test(t.replace(/\s+/g, ""))) return {kind: "reply", label: "This is a pairing reply. The host pastes it in their window (Share › Other ways to connect)."};
      if (/#?atrium=1&/.test(t) || /^Room key:/im.test(t)) {
        const parsed = G.AtriumCollabTransport?.parseInvitation?.(t);
        return {kind: "invite", label: parsed ? (parsed.relay === "local" ? "An invitation to a session on this computer." : "An invitation to a session on " + parsed.relay.replace(/^wss?:\/\//, "") + ".") : "An invitation."};
      }
      if (/^(wss?:\/\/)?(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\]|[a-z0-9-]+(\.[a-z0-9-]+)*\.local)(:\d{1,5})?\/?$/i.test(t))
        return {kind: "address", label: "An address: enter the session's code from the host below."};
      return {kind: null, label: ""};
    }
    // A pairing code: make the reply, show it until the host pastes it, then join through that connection.
    async function joinWithCode(d, code, prepare, opened) {
      if (!await prepare("join")) return;
      const P = G.AtriumCollabPair || await G.AtriumLazy.need("AtriumCollabPair");
      const a = await P.answer(code);
      if (!d.open) { a.close(); return; }
      const who = a.invite.name || "the host";
      const box = el("section", null, "collab-section"), row = el("label", null, "collab-field"), reply = el("textarea");
      reply.readOnly = true; reply.rows = 4; reply.spellcheck = false; reply.value = a.code;
      row.append(el("span", "Your reply"), reply, el("small", "Send it back to " + who + ". It holds no key and works only with their code."));
      const wait = el("p", "Waiting for " + who + " to paste your reply…", "collab-note");
      wait.setAttribute("role", "status");
      const actions = el("div", null, "collab-dialog-actions");
      actions.append(copyButton("Copy Reply", () => a.code), btn("Cancel", () => d.close()));
      box.append(el("h3", "Pairing with " + who), row, actions, wait);
      const heading = d.firstElementChild;
      d.replaceChildren(heading, box);
      globalThis.AtriumShell?.adoptDialog(d, {title:heading, body:box, actions});
      reply.focus(); reply.select();
      d.addEventListener("close", () => { if (S?.pairing !== a) a.close(); }, {once: true});
      await a.ready;
      if (!d.open) return;
      wait.textContent = "Connected to " + who + ". Joining…";
      setPref(PREF_LIVE, true);
      if (await begin("join", "pair", a.invite.roomKey, {host: a.invite.host, salt: a.invite.salt, socket: a.socket, pairing: a, path: a.invite.relayed ? pathPref() : "relay"})) opened("join");
    }
    // Share: host this project (through the relay server in Preferences) or join from an invitation.
    function dialogLive(o = {}) {
      // An invitation the user opened is consent to see the join form; joining turns live sessions on.
      if (!S && !o.invite && pref(PREF_LIVE, false) !== true) {
        return dialog("Live Session", d => {
          d.append(el("p", "Turn on live sessions to edit a project together. Nothing is contacted until you start or join a session.", "collab-note"));
          d.append(btn("Turn On Live Sessions", () => { setPref(PREF_LIVE, true); d.close(); dialogLive(o); }, "collab-button is-primary"));
        });
      }
      return dialog("Live Session", d => {
        if (S) { connectedDialog(d, S); return; }
        nameField(d);
        const relay = String(pref(PREF_RELAY, "") || "").trim();
        const error = el("p", "", "collab-field-error");
        error.id = "collab-session-error-" + ++nextError;
        error.setAttribute("role", "alert");
        let invalidField = null;
        const clearError = () => { invalidField?.removeAttribute("aria-invalid"); invalidField?.removeAttribute("aria-describedby"); invalidField = null; error.textContent = ""; };
        function showError(message, field) {
          clearError();
          if (field) { field.closest(".collab-field").after(error); field.setAttribute("aria-invalid", "true"); field.setAttribute("aria-describedby", error.id); invalidField = field; field.focus(); }
          else d.append(error);
          error.textContent = message;
        }
        let starting = false;
        const run = fn => async () => {
          if (starting) return;
          starting = true; clearError();
          try { await fn(); } catch (e) { if (d.open) showError(e.message); else say(e.message, "error"); } finally { starting = false; }
        };
        const prepare = async mode => {
          await G.AtriumLazy?.need?.("AtriumCollabTransport");
          if (mode === "join" && host.isDirty() && !await saveBeforeJoining()) { if (d.open) d.close(); return false; }
          return d.open;
        };
        const opened = mode => { const was = d.open; d.close(); if (was) dialogLive(); else if (mode === "join") say("Joining…"); };
        // Host. Without a relay server: pairing codes where this window has WebRTC, else this computer only.
        const hostBox = el("section", null, "collab-section"), canPair = typeof G.RTCPeerConnection === "function";
        hostBox.append(el("h3", "Host this project"), el("p", relay
          ? "Guests join with a link, through " + relay + " (directly when their networks allow). Keep this window open while hosting."
          : canPair ? "No relay server is set: guests join with a pairing code, computer to computer, with no server. Set one in Preferences › Collaboration to invite with a link."
          : "No relay server is set, so the session stays between windows on this computer. Set one in Preferences › Collaboration to invite others.", "collab-note"));
        // Visible on this network (the Waffle app): a listener and an announcement only while hosting.
        const visible = el("input"), visibleRow = el("label", null, "collab-check"), nameRow = el("label", null, "collab-field"), lanName = el("input");
        visible.type = "checkbox"; visible.id = "collab-visible";
        visibleRow.append(visible, el("span", "Visible on this network"));
        lanName.type = "text"; lanName.maxLength = 63; lanName.value = (host.project()?.name || "").slice(0, 63); lanName.placeholder = "Waffle session";
        nameRow.append(el("span", "Session name"), lanName, el("small", "Shown to Waffle on this network instead of your name or your computer's. Guests also need the code you'll see."));
        nameRow.hidden = true;
        visible.onchange = () => { nameRow.hidden = !visible.checked; };
        if (lanAvailable()) hostBox.append(visibleRow, nameRow);
        else hostBox.append(el("p", lanNote(), "collab-note"));
        hostBox.append(btn("Start Session", run(async () => {
          if (!await prepare("start")) return;
          if (visible.checked && lanAvailable()) {
            if (!await explainLocalNetwork() || !d.open) return;
            const T = G.AtriumCollabTransport, code = sessionCode(T.newRoomKey().replace(/-/g, "").slice(0, 16)), salt = T.newSalt(), k = await T.keys(code, salt);
            const lan = await G.AtriumHost.lanStart(k.room, salt, lanName.value.trim() || "Waffle session");
            let ok = false;
            try { ok = !!await begin("start", "ws://127.0.0.1:" + lan.port, code, {salt, lan: {...lan, code}}); }
            finally { if (!ok) G.AtriumHost.lanStop().catch(() => {}); }
            if (ok) opened("start");
            return;
          }
          if (await begin("start", relay || (canPair ? "pair" : "local"))) opened("start");
        }), "collab-button is-primary"));
        // Join: one field for whatever the host sent (link, text, host invitation, pairing code).
        const joinBox = el("section", null, "collab-section"), inviteRow = el("label", null, "collab-field"), invite = el("textarea"), seen = el("small", "", "collab-detected");
        invite.rows = 3; invite.maxLength = 64 * 1024; invite.spellcheck = false; invite.autocomplete = "off"; invite.value = o.invite || "";
        invite.placeholder = "https://collab.example.org/join#…";
        seen.setAttribute("aria-live", "polite");
        inviteRow.append(el("span", "Invitation"), invite, el("small", "Paste the link, the text or the pairing code the host sent you."), seen);
        const codeRow = el("label", null, "collab-field"), codeInput = el("input");
        codeInput.type = "text"; codeInput.autocomplete = "off"; codeInput.spellcheck = false; codeInput.placeholder = "ABCD-EFGH-JKMN-PQRS"; codeInput.maxLength = 24;
        codeRow.append(el("span", "Session code"), codeInput, el("small", "The code the host reads out or sends (16 letters and digits)."));
        codeRow.hidden = true;
        const detect = () => { const what = recognise(invite.value); seen.textContent = what.label; codeRow.hidden = what.kind !== "address"; return what; };
        invite.addEventListener("input", () => { if (invalidField === invite) clearError(); detect(); });
        const joinNow = run(async () => {
          const what = detect();
          if (!what.kind) { showError(invite.value.trim() ? "Not recognised. Paste the whole link, text or pairing code from the host." : "Paste the link, text or pairing code from the host.", invite); return; }
          if (what.kind === "reply") { showError(what.label, invite); return; }
          if (what.kind === "address") {
            const url = addressUrl(invite.value), code = sessionCode(codeInput.value);
            if (!url) { showError("That address isn't complete: host:port, for example 192.168.1.20:" + LAN_PORT + ".", invite); return; }
            if (code.replace(/-/g, "").length < 16) { showError("Enter the 16-character session code from the host.", codeInput); return; }
            const info = await lanInfo(url);
            if (!await prepare("join")) return;
            setPref(PREF_LIVE, true);
            if (await begin("join", url, code, {salt: info.salt, host: info.host})) opened("join");
            return;
          }
          await G.AtriumLazy?.need?.("AtriumCollabTransport");
          if (what.kind === "host") { if (acceptHostInvite(invite.value)) d.close(); else showError("That host invitation is incomplete. Copy it again.", invite); return; }
          if (what.kind === "offer") { await joinWithCode(d, invite.value, prepare, opened); return; }
          const parsed = G.AtriumCollabTransport.parseInvitation(invite.value);
          if (!parsed) { showError("Paste the complete invitation link or text from the host.", invite); return; }
          if (!await prepare("join")) return;
          setPref(PREF_LIVE, true);
          if (await begin("join", parsed.relay, parsed.roomKey, parsed)) opened("join");
        });
        invite.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!codeRow.hidden && !codeInput.value) codeInput.focus(); else joinNow(); } });
        codeInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); joinNow(); } });
        codeInput.addEventListener("input", () => { if (invalidField === codeInput) clearError(); });
        // Sessions announced on this network: choosing one fills in its address; the code is asked for.
        const nearby = el("div", null, "collab-nearby"), nearbyState = el("p", "", "collab-note");
        nearbyState.setAttribute("aria-live", "polite");
        const find = btn("Find Sessions on This Network", async () => {
          if (!await explainLocalNetwork() || !d.open) return;
          find.disabled = true; nearbyState.textContent = "Looking…"; nearby.replaceChildren();
          try {
            const found = (await G.AtriumHost.lanBrowse())?.sessions || [];
            nearbyState.textContent = found.length ? "Choose one, then enter its code:" : "No shared sessions found on this network. You can type the host's address instead.";
            nearby.replaceChildren(...found.slice(0, 20).map(f => btn(f.name + " — " + f.address + ":" + f.port, () => {
              invite.value = (f.address.includes(":") ? "[" + f.address + "]" : f.address) + ":" + f.port; detect(); codeInput.focus();
            }, "collab-chip")));
            nearby.querySelector("button")?.focus();
          } catch (e) { nearbyState.textContent = e.message; }
          finally { find.disabled = false; }
        });
        joinBox.append(el("h3", "Join a session"), inviteRow, codeRow, btn("Join Session", joinNow, o.invite ? "collab-button is-primary" : "collab-button"));
        if (lanAvailable()) joinBox.append(find, nearbyState, nearby);
        detect();
        // Without an invitation: a relay and room key typed by hand (tests, local networks).
        const manual = el("details"), urlRow = el("label", null, "collab-field"), url = el("input"), keyRow = el("label", null, "collab-field"), key = el("input");
        url.type = "url"; url.placeholder = "wss://collab.example.org (empty: this computer)"; url.value = relay;
        urlRow.append(el("span", "Relay server"), url);
        key.type = "text"; key.autocomplete = "off"; key.spellcheck = false; key.placeholder = "Room key";
        keyRow.append(el("span", "Room key"), key, el("small", "Share it privately. Anyone with it can join and edit. It is never saved."));
        const gen = btn("Generate", async () => { await G.AtriumLazy?.need?.("AtriumCollabTransport"); key.value = G.AtriumCollabTransport.newRoomKey(); key.select(); });
        const go = mode => run(async () => {
          const u = url.value.trim() || "local";
          if (u !== "local" && !relayAddress(u)) { showError("Enter a ws:// or wss:// relay address, or leave it empty to use this computer.", url); return; }
          if (!await prepare(mode)) return;
          if (await begin(mode, u, key.value, {manual: true})) opened(mode);
        });
        const row = el("div", null, "collab-dialog-actions");
        row.append(btn("Start with This Key", go("start")), btn("Join with This Key", go("join")));
        manual.append(el("summary", "Use a room key instead"), urlRow, keyRow, gen, row);
        d.append(o.invite ? joinBox : hostBox, o.invite ? hostBox : joinBox, manual, error);
        setTimeout(() => (o.invite ? invite : hostBox.querySelector("button"))?.focus(), 0);
      });
    }
    // An invitation link opened in a browser (#atrium=1&… to join, #atrium-host=1&… to become a host on
    // a private relay): act on it, and drop the secret from the address bar and history at once.
    function joinFromLink(hash) {
      const text = String(hash || "");
      if (!/^#?atrium(-host)?=1&/.test(text)) return false;
      try { G.history?.replaceState?.(null, "", G.location.pathname + G.location.search); } catch { /* not a page */ }
      const link = G.location ? G.location.origin + G.location.pathname + "#" + text.replace(/^#/, "") : text;
      if (/^#?atrium-host=1&/.test(text)) G.AtriumLazy?.need?.("AtriumCollabTransport")?.then?.(() => acceptHostInvite(link));
      else dialogLive({invite: link});
      return true;
    }
    // A host invitation sets the relay server and this person's host token (one person, revocable).
    function acceptHostInvite(text) {
      const h = G.AtriumCollabTransport?.parseHostInvitation(text);
      if (!h) return false;
      setPref(PREF_RELAY, h.relay); setHostInvite(h); setPref(PREF_LIVE, true);
      say("You can now host live sessions on " + h.relay + (h.name ? " as " + h.name : "") + ". Share › Start Session.");
      return true;
    }

    function bindGroupLibrary(handlers) {
      const session = S;
      if (!session?.t) throw Error("Start or join a live session first.");
      session.groupChannel?.ended();
      session.groupChannel = handlers;
      return {
        send(body) { if (S === session && session.groupChannel === handlers && session.connection === "open") return session.t.send("group-library", body); },
        close() { if (session.groupChannel === handlers) delete session.groupChannel; }
      };
    }

    return {bindGroupLibrary, active, begin, leave, undo, guardObjects, historyAvailability, peers, reviewWarning, prepareRestore, follow: setFollow, dialog: dialogLive, joinFromLink, testRelay, recognise, session: () => S, flush() { if (commitTimer) commitNow(); }};
  })();

  // ------------------------------------------------------------------ wiring
  const ACTIONS = [
    ["collab-status", "Collaboration…", () => statusDialog()],
    ["collab-live", "Live Session…", () => Live.dialog()],
    ["collab-ask", "Ask to Edit Document", () => { const id = host.currentId(); const M = L()?.manager(); if (!M?.owner(id)) { say("No one else is editing this document."); return; } L().ask(id).then(() => say("Asked " + M.owner(id).name)); }],
    ["collab-release", "Release Document Lock", () => { const id = host.currentId(); L()?.release(id)?.then(r => say(r ? "Released the lock" : "You don't hold this document's lock")) ?? say("Document locking is off."); }]
  ];
  function attach(h) {
    if (host) return;
    host = h;
    attachPeople();
    const N = G.AtriumNavCommon, K = G.AtriumKeymap;
    for (const [id, label, fn] of ACTIONS) {
      h.registerAction?.(id, fn);
      N?.menuItem?.("project", id, label, {after: id === "collab-status" ? "review-changes" : null, separator: id === "collab-status"});
      try { if (!K?.command?.(id)) K?.registerCommand?.({id, title: label.replace(/…$/, ""), category: "Collaboration", action: id, defaultKeys: []}); } catch { /* keymap built in */ }
    }
    // Keep collaboration items together after Review Changes.
    const list = document.querySelector('.work-menu[data-menu="project"] .menu-items');
    if (list) { let at = list.querySelector('[data-action="collab-status"]'); for (const id of ["collab-live", "collab-ask", "collab-release"]) { const b = list.querySelector('[data-action="' + id + '"]'); if (b && at) { at.after(b); at = b; } } }
    L()?.on(onLock);
    h.on?.("change", soon); h.on?.("document", soon);
    const watch = new MutationObserver(() => { if (!painting) soon(); });
    for (const id of ["document-tabs", "documents"]) { const n = document.getElementById(id); if (n) watch.observe(n, {childList: true}); }
    G.AtriumPower?.onChange?.(soon);
    if (G.AtriumPrefs?.registerPage) prefsPage(G.AtriumPrefs); else G.AtriumLazy?.need?.("AtriumPrefs").then(prefsPage, () => {});
    G.addEventListener?.("pagehide", () => Live.leave(true));
    if (/^#atrium(-host)?=1&/.test(G.location?.hash || "")) Live.joinFromLink(G.location.hash);
    soon();
  }
  if (G.document) G.AtriumNavCommon?.ready?.(attach);
  // start(relay, roomKey?, {salt}?) -> {room, peer, host, salt, link, text}: the invitation to share.
  // join(relay, roomKey, {host, salt}) or join(invitation link or text).
  async function joinArgs(a, b, c) {
    if (b === undefined) {
      await G.AtriumLazy?.need?.("AtriumCollabTransport");
      const parsed = G.AtriumCollabTransport.parseInvitation(a);
      if (!parsed) throw Error("That is not a Waffle invitation.");
      return [parsed.relay, parsed.roomKey, parsed];
    }
    return [a, b, c];
  }
  G.AtriumCollabLive = Object.freeze({bindGroupLibrary: Live.bindGroupLibrary, active: () => Live.active(), undo: redo => Live.undo(redo), guardObjects: Live.guardObjects, historyAvailability: Live.historyAvailability, reviewWarning:Live.reviewWarning, prepareRestore: Live.prepareRestore, flush: Live.flush,
    start: (url, key, o) => Live.begin("start", url, key, o), join: async (a, b, c) => Live.begin("join", ...await joinArgs(a, b, c)),
    leave: () => Live.leave(), peers: () => Live.peers(), follow: id => Live.follow(id), session: () => Live.session(), dialog: o => Live.dialog(o), joinFromLink: h => Live.joinFromLink(h),
    recognise: t => Live.recognise(t), testConnection: url => Live.testRelay(url)});
  return Object.freeze({paintBadges, paintBar, statusDialog, live: G.AtriumCollabLive});
})();
