"use strict";
// Design review comments (Panels › Comments, Project › Add Comment): threads pinned to a part,
// net, track, area or point of a schematic or board, with replies, resolve/reopen, plain-text
// @mentions and a status filter. Offline and local-first: an answer to cloud commenting that
// travels with the design through Git.
//
// Storage: in the project file, as `project.review = {version:1, records:{<id>: record}}`.
//   - Records are keyed by a random ID and the editor saves with sorted keys, so each record is
//     one self-contained block at a pseudo-random position: comments added on two branches land
//     in different places and merge without conflicts. Replies are their own records (they point
//     at the thread), so a reply never edits the thread's lines; resolving edits only the thread.
//   - Keeping them in the project (not a sidecar) means every host can save them (browser,
//     macOS, Linux) with no new file permission in the native hosts, undo/autosave/recovery cover
//     them, and Git revisions, Compare Revisions and MCP proposals carry them with the design.
//   thread: {id, type:"thread", doc, anchor:{kind, id?, net?, pin?, ids?, label?, at:[x,y], box?}, text, author,
//            created, status:"open"|"resolved", resolved?:{by, at}, diff?:{status, name, key}}
//   reply:  {id, type:"reply", thread, text, author, created}
//   Anchor kinds: part, net, track, item, area, point; Annotate mode (review-annotate.js) adds pin
//   (id = the part, pin = its number), group (ids = up to 200 objects) and room (id = the room).
//
// Security: comment text, authors and labels are untrusted data. The panel renders them only with
// textContent (never innerHTML), no element carries data-action derived from them, mentions are
// plain spans, and nothing in a comment is ever run, followed or dispatched. Text is capped and
// control and bidirectional-override characters are removed on the way in and on display.
// The model half has no DOM access: the MCP engine (mcp/review.py) loads this file headless.
globalThis.AtriumReviewComments = (() => {
  const VERSION = 1, MAX_TEXT = 4000, MAX_AUTHOR = 80, MAX_LABEL = 120, MAX_RECORDS = 20000;
  const KINDS = new Set(["part", "net", "track", "item", "area", "point", "pin", "group", "room"]), MAX_GROUP = 200;
  const STATUS = new Set(["open", "resolved"]);
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const num = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e8;
  const point = p => Array.isArray(p) && p.length === 2 && p.every(num);
  const box = b => Array.isArray(b) && b.length === 4 && b.every(num) && b[0] <= b[2] && b[1] <= b[3];
  const fail = m => { throw Error(m); };
  const writable = p => { const warning=globalThis.AtriumCollabLive?.reviewWarning?.(p); if(warning) fail(warning); };
  const A = () => globalThis.Atrium;
  const newId = () => A().id();
  // Record keys must never name an Object prototype member.
  const safeId = s => typeof s === "string" && /^[\w-]{1,80}$/.test(s) && !["__proto__", "constructor", "prototype"].includes(s);
  // References to documents and threads: any short string without control characters (imported IDs vary).
  const safeRef = s => typeof s === "string" && s.length > 0 && s.length <= 200 && !/[\u0000-\u001f]/.test(s);

  // ------------------------------------------------------------------ text
  // Control characters (except tab and newline), bidirectional overrides and isolates, and other
  // invisible format characters that could disguise text. CRLF becomes LF.
  const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿￹-￻]/g;
  function clean(text, max = MAX_TEXT) {
    if (typeof text !== "string") return "";
    const s = text.replace(/\r\n?/g, "\n").replace(UNSAFE, "");
    return s.length > max ? s.slice(0, max) : s;
  }
  function line(text, max) { return clean(text, max).replace(/\s+/g, " ").trim(); }
  const MENTION = /(^|[^\w@])@([\p{L}\p{N}][\p{L}\p{N}._-]{0,39})/gu;
  // @mentions as plain names (no links, no lookups).
  function mentions(text) {
    const out = new Set();
    for (const m of clean(text).matchAll(MENTION)) out.add(m[2].replace(/[._-]+$/, ""));
    return [...out];
  }
  // Text split into plain runs and mention runs, for display with textContent.
  function segments(text) {
    const s = clean(text), out = [];
    let last = 0;
    for (const m of s.matchAll(MENTION)) {
      const name = m[2].replace(/[._-]+$/, ""), at = m.index + m[1].length;
      if (at > last) out.push({text: s.slice(last, at)});
      out.push({text: "@" + name, mention: name});
      last = at + 1 + name.length;
    }
    if (last < s.length) out.push({text: s.slice(last)});
    return out;
  }

  // ------------------------------------------------------------------ store
  function store(p, create = false) {
    if (!plain(p)) fail("Open a project first.");
    if (!plain(p.review) || !plain(p.review.records)) {
      if (!create) return null;
      p.review = {version: VERSION, records: {}};
    }
    return p.review;
  }
  // A record as saved, or null when it is malformed (it is then ignored, never repaired in place).
  function check(r, id) {
    if (!plain(r) || r.id !== id || !safeId(id) || typeof r.text !== "string" || typeof r.created !== "string") return null;
    if (r.type === "reply") return safeRef(r.thread) ? r : null;
    if (r.type !== "thread" || !safeRef(r.doc) || !STATUS.has(r.status) || !plain(r.anchor) || !KINDS.has(r.anchor.kind) || !point(r.anchor.at)) return null;
    if (r.anchor.box != null && !box(r.anchor.box)) return null;
    return r;
  }
  function records(p) {
    const s = store(p);
    if (!s) return [];
    const out = [];
    for (const id of Object.keys(s.records)) { const r = check(s.records[id], id); if (r) out.push(r); }
    return out;
  }
  const order = (a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Threads, oldest first, each with its replies (oldest first) and a stable number per document.
  function orderedThreads(p) {
    const all = records(p), byThread = new Map();
    for (const r of all) if (r.type === "reply") { if (!byThread.has(r.thread)) byThread.set(r.thread, []); byThread.get(r.thread).push(r); }
    const counters = new Map();
    return all.filter(r => r.type === "thread").sort(order).map(t => {
      const n = (counters.get(t.doc) || 0) + 1; counters.set(t.doc, n);
      return {...t, number: n, replies: (byThread.get(t.id) || []).sort(order)};
    });
  }
  function matchesThread(t, doc, status, query) {
    if ((doc && t.doc !== doc) || (status !== "all" && t.status !== status)) return false;
    if (!query) return true;
    const matches = value => String(value).toLowerCase().includes(query);
    return matches(t.text) || matches(t.author) || matches(t.anchor.label || "") ||
      t.replies.some(r => matches(r.text) || matches(r.author));
  }
  function threads(p, {doc = null, status = "open", query = ""} = {}) {
    const q = line(query, 200).toLowerCase();
    return orderedThreads(p).filter(t => matchesThread(t, doc, status, q));
  }
  function thread(p, id) { return threads(p, {status: "all"}).find(t => t.id === id) || null; }
  function room(s) { if (Object.keys(s.records).length >= MAX_RECORDS) fail("This project has the maximum number of review comments."); }
  function stamp(now) { const d = now ? new Date(now) : new Date(); return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString(); }
  function anchorOf(a) {
    if (!plain(a) || !KINDS.has(a.kind)) fail("Choose a part, net, track, area or point for the comment.");
    if (!point(a.at)) fail("A comment needs a location (x, y in mm).");
    const r4 = v => Math.round(+v * 1e4) / 1e4;
    const out = {kind: a.kind, at: [r4(a.at[0]), r4(a.at[1])]};
    if (a.id != null) { if (!safeRef(String(a.id))) fail("Unknown object ID."); out.id = String(a.id); }
    if (a.net != null) out.net = line(String(a.net), MAX_LABEL);
    if (a.label != null) out.label = line(String(a.label), MAX_LABEL);
    if (a.box != null) { if (!box(a.box)) fail("An area is [x0, y0, x1, y1] in mm."); out.box = a.box.map(r4); }
    if (a.pin != null) out.pin = line(String(a.pin), 40);
    if (a.ids != null) {
      if (!Array.isArray(a.ids) || !a.ids.length || a.ids.length > MAX_GROUP || !a.ids.every(x => safeRef(String(x)))) fail("A group comment names 1 to " + MAX_GROUP + " objects.");
      out.ids = [...new Set(a.ids.map(String))];
    }
    return out;
  }
  // Adds a thread. Returns the stored record.
  function add(p, {doc, anchor, text, author, now, id, diff} = {}) {
    writable(p);
    const body = clean(text).trim();
    if (!body) fail("Write a comment first.");
    const d = p.documents?.find(x => x.id === doc);
    if (!d) fail("The project has no document " + String(doc).slice(0, 80) + ".");
    if (!safeRef(d.id)) fail("This document's ID cannot hold comments.");
    const s = store(p, true); room(s);
    const key = id && safeId(id) && !own(s.records, id) ? id : newId();
    const r = {id: key, type: "thread", doc: d.id, anchor: anchorOf(anchor), text: body, author: line(author || "Reviewer", MAX_AUTHOR) || "Reviewer",
      created: stamp(now), status: "open"};
    if (plain(diff)) r.diff = {status: line(String(diff.status || ""), 20), name: line(String(diff.name || ""), MAX_LABEL), ...(diff.key ? {key: String(diff.key).slice(0, 400)} : {})};
    s.records[key] = r;
    return r;
  }
  function reply(p, threadId, {text, author, now, id} = {}) {
    writable(p);
    const t = thread(p, threadId) || fail("There is no comment thread " + String(threadId).slice(0, 80) + ".");
    const body = clean(text).trim();
    if (!body) fail("Write a reply first.");
    const s = store(p, true); room(s);
    const key = id && safeId(id) && !own(s.records, id) ? id : newId();
    const r = {id: key, type: "reply", thread: t.id, text: body, author: line(author || "Reviewer", MAX_AUTHOR) || "Reviewer", created: stamp(now)};
    s.records[key] = r;
    return r;
  }
  function setStatus(p, threadId, status, {author, now} = {}) {
    writable(p);
    if (!STATUS.has(status)) fail("A comment is open or resolved.");
    const s = store(p), r = s && check(s.records[threadId], threadId);
    if (!r || r.type !== "thread") fail("There is no comment thread " + String(threadId).slice(0, 80) + ".");
    r.status = status;
    if (status === "resolved") r.resolved = {by: line(author || "Reviewer", MAX_AUTHOR) || "Reviewer", at: stamp(now)};
    else delete r.resolved;
    return r;
  }
  // Removes a thread with its replies, or one reply. Returns the number of records removed.
  function remove(p, id) {
    writable(p);
    const s = store(p);
    if (!s || !own(s.records, id)) return 0;
    let n = 0;
    for (const k of Object.keys(s.records)) if (k === id || s.records[k]?.type === "reply" && s.records[k].thread === id) { delete s.records[k]; n++; }
    if (!Object.keys(s.records).length) delete p.review;
    return n;
  }

  // ------------------------------------------------------------------ anchors
  const itemBox = (doc, defs, item) => { try { return A().bounds(A().itemPoints(item, defs?.get?.(item.def), doc.kind)); } catch { return null; } };
  function labelFor(item) {
    if (!item) return "";
    if (item.kind === "part") return item.ref || "Component";
    if (item.kind === "track") return (item.net ? item.net + " track" : "Track") + (item.layer ? " · " + item.layer : "");
    if (item.kind === "via") return item.net ? item.net + " via" : "Via";
    if (item.kind === "pad") return "Pad " + (item.number || "") + (item.net ? " · " + item.net : "");
    if (item.kind === "wire") return item.net ? item.net + " wire" : "Wire";
    if (item.kind === "netlabel") return "Net label " + (item.text || "");
    if (item.kind === "polygon") return (item.net ? item.net + " " : "") + "pour";
    return item.kind[0].toUpperCase() + item.kind.slice(1);
  }
  // The attachments a click offers: the object, its net, and the bare point.
  function candidates(doc, defs, item, at, netOf) {
    const out = [];
    if (item) {
      const b = itemBox(doc, defs, item), label = labelFor(item);
      const kind = item.kind === "part" ? "part" : item.kind === "track" || item.kind === "wire" ? "track" : "item";
      out.push({kind, id: item.id, label, at: b ? [(b[0] + b[2]) / 2, b[1]] : at, ...(b ? {box: b} : {})});
      const net = item.net || netOf?.(item);
      if (net) out.push({kind: "net", id: item.id, net, label: "Net " + net, at});
    }
    out.push({kind: "point", label: "Point (" + at.map(v => +v.toFixed(2)).join(", ") + ")", at});
    return out;
  }
  // Where a thread is now: an anchored object that moved takes its pin with it.
  const find = (doc, index, id) => index ? index.get(id) : doc.items.find(i => i.id === id);
  const top = b => ({at: [(b[0] + b[2]) / 2, b[1]], box: b, live: true});
  // The box of one pin or pad of a part (world mm), or null.
  function pinBox(doc, defs, part, number) {
    let pins; try { pins = A().pins(part, defs?.get?.(part.def), doc.kind); } catch { return null; }
    const pin = pins.find(p => String(p.number) === String(number));
    if (!pin) return null;
    const r = doc.kind === "pcb" ? Math.max(pin.w || 0, pin.h || 0, pin.diameter || 0, .3) / 2 : .6;
    return [pin.at[0] - r, pin.at[1] - r, pin.at[0] + r, pin.at[1] + r];
  }
  function roomBox(doc, id) {
    const r = Array.isArray(doc.rooms) ? doc.rooms.find(x => x.id === id) : null;
    if (!r || !Array.isArray(r.points)) return null;
    let b = null;
    for (const [x, y] of r.points) b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
    return b;
  }
  function locate(doc, defs, t, index) {
    const a = t.anchor;
    if (a.id && (a.kind === "part" || a.kind === "track" || a.kind === "item")) {
      const item = find(doc, index, a.id);
      const b = item && itemBox(doc, defs, item);
      if (b) return top(b);
    }
    if (a.kind === "pin" && a.id && a.pin != null) {
      const part = find(doc, index, a.id), b = part && pinBox(doc, defs, part, a.pin);
      if (b) return top(b);
    }
    if (a.kind === "room" && a.id) { const b = roomBox(doc, a.id); if (b) return top(b); }
    if (a.kind === "group" && a.ids) {
      let b = null;
      for (const id of a.ids) { const item = find(doc, index, id), q = item && itemBox(doc, defs, item); if (q) b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q; }
      if (b) return top(b);
      return {at: a.at, box: a.box || null, live: false};
    }
    return {at: a.at, box: a.box || null, live: !a.id};
  }

  // ------------------------------------------------------------------ drawing (world units)
  // Pins keep a constant on-screen size at every zoom: sizes are CSS px times px (= 1/scale).
  // Theme colours resolved for the canvas. Status tokens are tuned for text on panels; over a dark
  // canvas a dark token (the Light theme's) is lifted towards white so it stays readable.
  let probeNode = null;
  function rgb(value) {
    if (typeof document === "undefined" || !document.body || !globalThis.getComputedStyle) return null;
    if (!probeNode) { probeNode = document.createElement("span"); probeNode.hidden = true; probeNode.setAttribute("aria-hidden", "true"); document.body.append(probeNode); }
    probeNode.style.color = ""; probeNode.style.color = value;
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(getComputedStyle(probeNode).color || "");
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  const luma = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  function canvasColour(token, fallback, background = "var(--canvas-bg)") {
    try {
      const c = rgb("var(" + token + ")"), bg = rgb(background);
      if (!c) return fallback;
      if (bg && luma(bg) < .35 && luma(c) < .5) { const k = .45; return "rgb(" + c.map(v => Math.round(v + (255 - v) * k)).join(",") + ")"; }
      if (bg && luma(bg) > .65 && luma(c) > .6) { const k = .45; return "rgb(" + c.map(v => Math.round(v * (1 - k))).join(",") + ")"; }
      return "rgb(" + c.join(",") + ")";
    } catch { return fallback; }
  }
  // The surface the pins sit on: the schematic sheet's paper or the board workspace, else --canvas-bg.
  function surface(kind) {
    try {
      const v = kind === "pcb" ? globalThis.AtriumPCBAppearance?.system?.workspace : kind ? globalThis.AtriumSchAppearance?.paper : "";
      return typeof v === "string" && v ? v : undefined;
    } catch { return undefined; }
  }
  function palette(kind) {
    const bg = surface(kind), accent = canvasColour("--accent", "#3794ff", bg), m = /(\d+),(\d+),(\d+)/.exec(accent);
    const on = m && luma([+m[1], +m[2], +m[3]]) > .6 ? "#1e1e1e" : "#ffffff";
    // A pin is a filled shape inside a white ring, so it needs no lift: the plain accent, one blue everywhere.
    const raw = rgb("var(--accent)"), pin = raw ? "rgb(" + raw.join(",") + ")" : accent, pinOn = raw && luma(raw) > .6 ? "#1e1e1e" : raw ? "#ffffff" : on;
    return {accent, on, pin, pinOn, muted: canvasColour("--muted", "#8a8a8a", bg), ring: "#ffffff", shadow: "rgba(0,0,0,.55)",
      success: canvasColour("--success", "#4ec27a", bg)};
  }
  let colours = null, coloursAt = 0, coloursKind = "";
  function themed(kind = "") {
    const t = Date.now();
    if (!colours || kind !== coloursKind || t - coloursAt > 700) { colours = palette(kind); coloursAt = t; coloursKind = kind; }
    return colours;
  }
  // A rounded box in world units with a constant on-screen radius (Annotate mode's hover box, a
  // hovered pin's target). Builds the path only: no allocation, the caller strokes and fills.
  function roundBox(ctx, x0, y0, x1, y1, r) {
    const w = x1 - x0, h = y1 - y0;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0); ctx.lineTo(x1 - r, y0); ctx.arcTo(x1, y0, x1, y0 + r, r);
    ctx.lineTo(x1, y1 - r); ctx.arcTo(x1, y1, x1 - r, y1, r);
    ctx.lineTo(x0 + r, y1); ctx.arcTo(x0, y1, x0, y1 - r, r);
    ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r);
    ctx.closePath();
  }
  // The target highlight: an accent outline over a soft accent tint, padded by `pad` screen px.
  function drawTarget(ctx, b0, b1, b2, b3, px, accent, alpha = 1, {pad = 3, width = 1.5, fill = .12, radius = 4, halo = null} = {}) {
    if (alpha <= .004) return;
    const p = pad * px;
    roundBox(ctx, b0 - p, b1 - p, b2 + p, b3 + p, radius * px);
    ctx.globalAlpha = alpha * fill; ctx.fillStyle = accent; ctx.fill();
    if (halo) { ctx.globalAlpha = alpha * .5; ctx.strokeStyle = halo; ctx.lineWidth = (width + 2) * px; ctx.stroke(); }
    ctx.globalAlpha = alpha; ctx.strokeStyle = accent; ctx.lineWidth = width * px; ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Pin geometry, shared by drawing and hit-testing: the head radius as a share of the pin size, and
  // the head centre's distance above the tip in head radii (2.2 gives the tangent sides about 63° apart).
  const PIN_HEAD = .85, PIN_REACH = 2.2;
  function pinPath(ctx, x, y, r, cy) {
    const a = Math.acos(1 / PIN_REACH);   // between the tip direction and each tangent point
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + r * Math.cos(Math.PI / 2 + a), cy + r * Math.sin(Math.PI / 2 + a));
    ctx.arc(x, cy, r, Math.PI / 2 + a, Math.PI / 2 - a + Math.PI * 2, false);
    ctx.closePath();
  }
  const easeOutBack = k => { const c = 1.6; return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2; };
  // pins: [{at, box, number, status, hot}]. o.drop: Map(pin id -> 0..1), a pin dropping into place.
  function drawPins(ctx, pins, {scale, worldToScreen}, o = {}) {
    if (!pins.length) return;
    const px = 1 / scale, c = o.colours || themed();
    const flipped = worldToScreen ? worldToScreen([1, 0])[0] < worldToScreen([0, 0])[0] : false;
    ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const p of pins) if (p.box && p.area) {
      const b = p.box;
      ctx.globalAlpha = p.status === "resolved" ? .45 : .9;
      ctx.strokeStyle = c.accent; ctx.lineWidth = (p.hot ? 2.2 : 1.4) * px; ctx.setLineDash([6 * px, 4 * px]);
      ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); ctx.setLineDash([]);
    }
    for (const p of pins) {
      const s = (p.hot ? 1.15 : 1) * (o.size || 11) * px, x = p.at[0];
      let y = p.at[1], fade = 1;
      const k = o.drop ? o.drop.get(p.id) : undefined;
      if (k !== undefined) {
        // Drops from 16 px above with a small overshoot; a ring spreads from the tip as it lands.
        y -= (1 - easeOutBack(k)) * 16 * px; fade = Math.min(1, k * 3);
        if (k > .45) { const q = (k - .45) / .55; ctx.globalAlpha = (1 - q) * .55; ctx.strokeStyle = c.accent; ctx.lineWidth = 1.2 * px; ctx.beginPath(); ctx.arc(x, p.at[1], (2 + q * 10) * px, 0, Math.PI * 2); ctx.stroke(); }
      }
      // A map-pin teardrop: the tip on the anchor, two straight sides tangent to the round head, the
      // number centred in the head. Sizes are screen px (px = 1 / scale), so it is crisp at any zoom.
      const r = s * PIN_HEAD, cy = y - r * PIN_REACH;
      pinPath(ctx, x, y, r, cy);
      const resolved = p.status === "resolved", fill = resolved ? c.muted : c.pin || c.accent, ink = resolved ? c.on : c.pinOn || c.on;
      if (p.hot) { ctx.globalAlpha = .3 * fade; ctx.lineWidth = 6 * px; ctx.strokeStyle = c.accent; ctx.stroke(); }
      ctx.globalAlpha = (resolved ? .7 : 1) * fade;
      ctx.lineWidth = 3.5 * px; ctx.strokeStyle = c.shadow; ctx.globalAlpha *= .6; ctx.stroke(); ctx.globalAlpha = (resolved ? .7 : 1) * fade;
      ctx.lineWidth = 2 * px; ctx.strokeStyle = c.ring; ctx.stroke();
      ctx.fillStyle = fill; ctx.fill();
      if (p.number != null) {
        ctx.save(); ctx.translate(x, cy); ctx.scale(px, px); if (flipped) ctx.scale(-1, 1);
        ctx.fillStyle = ink; ctx.font = "600 " + (resolved ? 11 : p.number > 99 ? 8 : 10) * (o.size || 11) / 11 + "px system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(resolved ? "✓" : String(p.number), 0, .5);
        ctx.restore();
      }
      if (o.labels && p.text) {
        ctx.save(); ctx.translate(x + r * 1.3, cy); ctx.scale(px, px); if (flipped) ctx.scale(-1, 1);
        ctx.font = "500 9px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.fillStyle = o.labelInk || c.accent;
        ctx.fillText(p.text, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  }
  // Pins for one document, in drawing order (resolved first, so open ones sit on top).
  function pinsFor(p, doc, defs, {status = "open", selected = null, index = null} = {}) {
    const list = threads(p, {doc: doc.id, status});
    const out = [];
    for (const t of list) {
      const at = locate(doc, defs, t, index);
      out.push({id: t.id, at: at.at, box: at.box, area: t.anchor.kind === "area", number: t.number, status: t.status, hot: t.id === selected, thread: t});
    }
    return out.sort((a, b) => (a.status === b.status ? (a.hot ? 1 : 0) - (b.hot ? 1 : 0) : a.status === "resolved" ? -1 : 1));
  }
  // Print and PDF ("Include comments"): pins with their number and the first words of the text.
  function printOverlay(p, doc, defs) {
    const pins = pinsFor(p, doc, defs, {status: "open"}).map(x => ({...x, text: "#" + x.number + " " + line(x.thread.text, 400).slice(0, 60)}));
    if (!pins.length) return null;
    return (ctx, info) => drawPins(ctx, pins, info, {labels: true, size: 9, colours: {accent: "#1f6fd1", on: "#ffffff", muted: "#777777", ring: "#ffffff", shadow: "rgba(0,0,0,.35)"}, labelInk: "#1f4f9a"});
  }

  // ------------------------------------------------------------------ headless (MCP: list_comments, add_comment, resolve_comment)
  function headless(a, env) {
    const {project, mutable, touched, page} = env;
    const docOf = (p, id) => {
      if (id == null) return null;
      return p.documents.find(d => d.id === id) || p.documents.find(d => d.name === id) || fail("The project has no document " + String(id).slice(0, 80) + ".");
    };
    const round = v => Math.round(v * 1e4) / 1e4;
    const defsOf = p => new Map(p.library.map(d => [d.id, d]));
    if (a.op === "list") {
      const p = project(), d = docOf(p, a.document_id), defs = defsOf(p);
      const docs = new Map(p.documents.map(x => [x.id, x]));
      const list = threads(p, {doc: d?.id || null, status: a.status || "open", query: a.query || ""});
      const items = list.map(t => {
        const doc = docs.get(t.doc), at = doc ? locate(doc, defs, t) : {at: t.anchor.at, box: t.anchor.box || null};
        return {id: t.id, document_id: t.doc, number: t.number, status: t.status, created: t.created, ...(t.resolved ? {resolved_at: t.resolved.at} : {}),
          anchor: {kind: t.anchor.kind, ...(t.anchor.id ? {object_id: t.anchor.id} : {}), at: at.at.map(round), ...(at.box ? {box: at.box.map(round)} : {}), current: !!at.live || !t.anchor.id},
          ...(t.diff ? {change_status: t.diff.status} : {}), reply_count: t.replies.length,
          replies: t.replies.map(r => ({id: r.id, created: r.created}))};
      });
      const pg = page(items, a), shown = new Set(pg.items.map(x => x.id));
      // Design-derived text, kept apart from the trusted fields (see UNTRUSTED_NOTE in mcp/automation.py).
      const text = list.filter(t => shown.has(t.id)).map(t => ({id: t.id, text: t.text, author: t.author, mentions: mentions(t.text),
        ...(t.anchor.label ? {anchor_label: t.anchor.label} : {}), ...(t.anchor.net ? {net: t.anchor.net} : {}), ...(t.diff?.name ? {change: t.diff.name} : {}),
        ...(t.resolved ? {resolved_by: t.resolved.by} : {}), document_name: docs.get(t.doc)?.name || "",
        replies: t.replies.map(r => ({id: r.id, text: r.text, author: r.author}))}));
      return {...pg, open: threads(p, {doc: d?.id || null, status: "open"}).length, untrusted_design_text: {comments: text}};
    }
    const p = mutable();
    if (a.op === "add") {
      if (a.reply_to) { const r = reply(p, a.reply_to, {text: a.text, author: a.author || "AI assistant (MCP)", now: a.now}); touched(); return {comment_id: r.id, thread_id: r.thread, type: "reply"}; }
      const d = docOf(p, a.document_id) || p.documents.find(x => x.kind === "pcb") || p.documents[0], defs = defsOf(p);
      let anchor;
      if (a.component) {
        const part = d.items.find(i => i.kind === "part" && (i.ref === a.component || i.id === a.component)) || fail("The document has no component " + String(a.component).slice(0, 64) + ".");
        anchor = candidates(d, defs, part, [part.x, part.y])[0];
      } else if (a.object_id) {
        const item = d.items.find(i => i.id === a.object_id) || fail("The document has no object " + String(a.object_id).slice(0, 80) + ".");
        const b = itemBox(d, defs, item), at = b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [item.x || 0, item.y || 0];
        anchor = candidates(d, defs, item, at)[0];
      } else if (a.net) {
        const item = d.items.find(i => i.net === a.net) || fail("The document has no copper or wire on net " + String(a.net).slice(0, 64) + ".");
        const b = itemBox(d, defs, item);
        anchor = {kind: "net", id: item.id, net: a.net, label: "Net " + a.net, at: a.at || (b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0])};
      } else if (a.box) anchor = {kind: "area", label: "Area", at: [(a.box[0] + a.box[2]) / 2, a.box[1]], box: [Math.min(a.box[0], a.box[2]), Math.min(a.box[1], a.box[3]), Math.max(a.box[0], a.box[2]), Math.max(a.box[1], a.box[3])]};
      else if (a.at) anchor = {kind: "point", label: "Point", at: a.at};
      else fail("Give component, object_id, net, box or at.");
      const t = add(p, {doc: d.id, anchor, text: a.text, author: a.author || "AI assistant (MCP)", now: a.now});
      touched();
      return {comment_id: t.id, thread_id: t.id, type: "thread", document_id: d.id, anchor: {kind: t.anchor.kind, at: t.anchor.at.map(round)}};
    }
    if (a.op === "resolve") {
      const r = setStatus(p, a.comment_id, a.reopen ? "open" : "resolved", {author: a.author || "AI assistant (MCP)", now: a.now});
      touched();
      return {comment_id: r.id, status: r.status};
    }
    fail("Unknown review operation.");
  }

  // Motion: Preferences › Appearance › Motion (data-motion on the root: "full", "reduce") wins over the
  // operating system's reduced-motion setting, as in style.css.
  let reduceQuery = null;
  function motionOK() {
    try { const M = globalThis.AtriumMotion; if (M?.level) return M.level() === "full"; } catch {}
    const m = globalThis.document?.documentElement?.getAttribute?.("data-motion");
    if (m === "full") return true;
    if (m === "reduce" || m === "off") return false;
    try { reduceQuery ||= globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") || null; return !reduceQuery?.matches; } catch { return true; }
  }
  // A theme token as a canvas colour string ("rgb(…)" / "rgba(…)"), unadjusted; for UI drawn on the canvas.
  function cssColour(token, fallback) {
    try {
      if (typeof document === "undefined" || !document.body || !globalThis.getComputedStyle) return fallback;
      rgb("var(" + token + ")");
      return getComputedStyle(probeNode).color || fallback;
    } catch { return fallback; }
  }

  const api = {VERSION, MAX_TEXT, MAX_GROUP, canvasColour, cssColour, motionOK, clean, mentions, segments, store, records, threads, thread, add, reply, setStatus, remove,
    candidates, locate, labelFor, pinBox, roomBox, roundBox, drawTarget, pinsFor, drawPins, pinPath, PIN_HEAD, PIN_REACH, printOverlay, headless};
  if (typeof document === "undefined" || !document.createElement) return Object.freeze(api);

  // ------------------------------------------------------------------ panel
  const PREF_AUTHOR = "review.author", PREF_NAME = "collab.displayName", FILTER_KEY = "atrium.comments.v1";
  let host = null, panel = null, ui = null, selected = null, visible = true, filter = {status: "open", scope: "doc", query: ""};
  let changeTimer = 0, filterFrame = 0;
  try { Object.assign(filter, JSON.parse(localStorage.getItem(FILTER_KEY) || "{}")); } catch {}
  if (!["open", "resolved", "all"].includes(filter.status)) filter.status = "open";
  if (!["doc", "all"].includes(filter.scope)) filter.scope = "doc";
  filter.query = "";
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const btn = (text, fn, cls, label) => {
    const b = el("button", text, cls); b.type = "button";
    b.classList.add("ui-button");
    if (cls === "is-primary") b.dataset.variant = "primary";
    b.onclick = fn;
    if (label) b.setAttribute("aria-label", label);
    return b;
  };
  // The author is the user's one identity: Preferences › Collaboration › display name. A name typed
  // per comment in earlier versions (review.author) still counts until a display name is set.
  function author() {
    let v = "";
    try {
      const P = globalThis.AtriumPref;
      v = line(P?.get?.(PREF_NAME, "") || "", MAX_AUTHOR) || P?.get?.(PREF_AUTHOR, "") || localStorage.getItem("atrium." + PREF_AUTHOR) || "";
    } catch {}
    return line(v, MAX_AUTHOR) || "Reviewer";
  }
  function setAuthor(v) {
    const s = line(v, MAX_AUTHOR);
    try { if (globalThis.AtriumPref?.set) AtriumPref.set(PREF_AUTHOR, s); else localStorage.setItem("atrium." + PREF_AUTHOR, s); } catch {}
  }
  // Comment text into a node: plain text runs and mention spans, textContent only.
  function textNode(text, cls) {
    const p = el("p", null, cls);
    for (const s of segments(text)) p.append(s.mention ? el("span", s.text, "rc-mention") : document.createTextNode(s.text));
    return p;
  }
  function when(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return d.toISOString().slice(0, 10);
  }
  function saveFilter() { try { localStorage.setItem(FILTER_KEY, JSON.stringify({status: filter.status, scope: filter.scope})); } catch {} }
  function build() {
    const nav = document.getElementById("navigator");
    if (!nav) return false;
    panel = el("section", null, "panel ui-dock-panel"); panel.dataset.dock = "comments"; panel.setAttribute("aria-labelledby", "rc-heading"); panel.hidden = true;
    const head = el("header", null, "pane-heading"), h2 = el("h2", "Comments"); h2.id = "rc-heading";
    const count = el("span", null, "ui-dock-count");
    const close = el("button", "×", "ui-close ui-dock-close"); close.type = "button"; close.onclick = () => toggle(false);
    close.title = "Close Comments"; close.setAttribute("aria-label", "Close Comments");
    head.append(h2, count, close);
    const tools = el("div", null, "rc-tools");
    const addPoint = btn("Add comment", () => startAdd(false), "rc-add");
    const addArea = btn("Area", () => startAdd(true), "rc-add-area", "Add a comment on an area");
    addArea.title = "Drag out an area to comment on";
    const status = el("select", null, "ui-field"); status.setAttribute("aria-label", "Show comments");
    for (const [v, t] of [["open", "Open"], ["resolved", "Resolved"], ["all", "All"]]) status.add(new Option(t, v));
    status.value = filter.status; status.onchange = () => { filter.status = status.value; saveFilter(); paint(); host?.invalidate?.(); };
    const scope = el("select", null, "ui-field"); scope.setAttribute("aria-label", "Documents");
    for (const [v, t] of [["doc", "This document"], ["all", "All documents"]]) scope.add(new Option(t, v));
    scope.value = filter.scope; scope.onchange = () => { filter.scope = scope.value; saveFilter(); paint(); };
    const search = el("input", null, "ui-field"); search.type = "search"; search.placeholder = "Search comments"; search.setAttribute("aria-label", "Search comments");
    search.oninput = e => { if (!e.isComposing) filterSoon(search.value); };
    search.addEventListener("compositionend", () => filterSoon(search.value));
    search.onkeydown = e => e.stopPropagation();
    const row = el("div", null, "rc-row");
    row.append(status, scope);
    const show = el("label", null, "rc-show"), box = el("input", null, "ui-checkbox"); box.type = "checkbox"; box.checked = visible;
    box.onchange = () => setVisible(box.checked); show.append(box, el("span", "Show pins on the canvas"));
    const actions = el("div", null, "rc-actions");
    actions.append(addPoint, addArea);
    tools.append(actions, row, AtriumUI.searchField(search), show);
    const list = el("div", null, "ui-dock-list pane-scroll"); list.setAttribute("role", "list"); list.setAttribute("aria-label", "Comment threads");
    const empty = el("p", null, "empty-state ui-dock-empty"); empty.hidden = true;
    panel.append(head, tools, list, empty);
    nav.append(panel);
    ui = {count, list, empty, status, scope, search, show: box};
    return true;
  }
  function docName(id) { return host?.docById?.(id)?.name || host?.project?.().documents.find(d => d.id === id)?.name || "Document"; }
  function filterSoon(query) {
    filter.query = query;
    if (!filterFrame) filterFrame = requestAnimationFrame(() => { filterFrame = 0; paint(); });
  }
  function paint() {
    if (filterFrame) { cancelAnimationFrame(filterFrame); filterFrame = 0; }
    if (changeTimer) { clearTimeout(changeTimer); changeTimer = 0; }
    if (!panel || panel.hidden || !host) return;
    const doc = filter.scope === "doc" ? host.currentId?.() : null, query = line(filter.query, 200).toLowerCase();
    const groups = new Map();
    let openCount = 0;
    for (const t of orderedThreads(host.project())) {
      if (t.status === "open") openCount++;
      if (!matchesThread(t, doc, filter.status, query)) continue;
      let group = groups.get(t.doc);
      if (!group) {
        group = el("div", null, "rc-group"); group.setAttribute("role", "group");
        const heading = el("h3", docName(t.doc)); group.setAttribute("aria-label", heading.textContent); group.append(heading);
        groups.set(t.doc, group);
      }
      group.append(card(t));
    }
    ui.count.textContent = openCount ? openCount + " open" : "";
    ui.list.replaceChildren(...groups.values());
    ui.empty.hidden = !!groups.size;
    ui.empty.textContent = filter.query ? "No comments match." : filter.status === "resolved" ? "No resolved comments." :
      "No comments yet. Choose Add comment, then click a part, net, track or point on the canvas.";
  }
  function card(t) {
    const c = el("article", null, "rc-thread"); c.setAttribute("role", "listitem"); c.dataset.status = t.status;
    if (t.id === selected) c.classList.add("is-selected");
    const top = el("button", null, "rc-head"); top.type = "button";
    top.setAttribute("aria-label", "Comment " + t.number + " on " + (t.anchor.label || t.anchor.kind) + " by " + t.author + (t.status === "resolved" ? ", resolved" : ""));
    top.append(el("span", t.status === "resolved" ? "✓" : String(t.number), "rc-pin"), el("span", t.anchor.label || t.anchor.kind, "rc-anchor"));
    // Library badges: the change type in info, Resolved in success.
    const badge = (text, tone) => { const b = el("span", text, "ui-badge rc-badge"); b.dataset.tone = tone; top.append(b); };
    if (t.diff?.status) badge(t.diff.status, "info");
    if (t.status === "resolved") badge("Resolved", "success");
    top.onclick = () => focus(t.id, true);
    const meta = el("div", null, "rc-meta"); meta.append(el("strong", t.author), el("span", when(t.created)));
    c.append(top, meta, textNode(t.text, "rc-text"));
    if (t.id !== selected) {
      if (t.replies.length) c.append(el("p", t.replies.length + (t.replies.length === 1 ? " reply" : " replies"), "rc-replies-count"));
      return c;
    }
    for (const r of t.replies) {
      const rr = el("div", null, "rc-reply"), m = el("div", null, "rc-meta");
      m.append(el("strong", r.author), el("span", when(r.created)));
      rr.append(m, textNode(r.text, "rc-text"));
      c.append(rr);
    }
    if (t.status === "resolved" && t.resolved) c.append(el("p", "Resolved by " + t.resolved.by + " · " + when(t.resolved.at), "rc-note"));
    const box = el("textarea", null, "rc-input ui-field"); box.rows = 2; box.placeholder = "Reply… (@name to mention)"; box.setAttribute("aria-label", "Reply");
    box.maxLength = MAX_TEXT;
    const actions = el("div", null, "rc-buttons");
    const send = btn("Reply", () => {
      const text = box.value; if (!clean(text).trim()) { box.focus(); return; }
      host.edit(() => reply(host.project(), t.id, {text, author: author()})); host.info("Reply added"); paint();
    }, "is-primary");
    box.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send.click(); } };
    const status = btn(t.status === "resolved" ? "Reopen" : "Resolve", () => {
      host.edit(() => setStatus(host.project(), t.id, t.status === "resolved" ? "open" : "resolved", {author: author()}));
      host.info(t.status === "resolved" ? "Comment reopened" : "Comment resolved"); paint(); host.invalidate?.();
    });
    const del = btn("Delete", () => {
      // Undo restores it (comments are design edits), so no confirmation.
      host.edit(() => remove(host.project(), t.id)); selected = null; host.info("Comment deleted. Undo restores it."); paint(); host.invalidate?.();
    }, "rc-delete");
    actions.append(del, status, send);
    c.append(box, actions);
    return c;
  }
  // Select a thread: show its document, zoom to its pin and expand it in the panel.
  function focus(id, zoom) {
    const p = host.project(), t = thread(p, id);
    if (!t) return;
    selected = selected === id && !zoom ? null : id;
    if (!panel || panel.hidden) toggle(true, false);
    if (t.doc !== host.currentId?.()) host.selectDocument?.(t.doc);
    const doc = host.doc(), at = locate(doc, host.defs(), t);
    if (zoom) {
      const b = at.box || [at.at[0] - 2, at.at[1] - 2, at.at[0] + 2, at.at[1] + 2];
      host.zoomTo?.([b[0] - 1, b[1] - 4, b[2] + 1, b[3] + 1]);
    }
    if (filter.status !== "all" && t.status !== filter.status) { filter.status = "all"; ui.status.value = "all"; }
    paint(); host.invalidate?.();
    panel.querySelector(".rc-thread.is-selected")?.scrollIntoView?.({block: "nearest"});
  }
  function toggle(show, focusList = true) {
    if (!panel && !build()) return;
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    if (on) document.body.classList.remove("hide-left");
    globalThis.AtriumNavCommon?.setChecked("comments-panel", on);
    if (on) { paint(); if (focusList) ui.list.focus?.({preventScroll: true}); }
    else host?.canvas?.()?.focus?.();
    host?.invalidate?.();
  }
  function setVisible(on) {
    visible = !!on;
    if (ui) ui.show.checked = visible;
    globalThis.AtriumNavCommon?.setChecked("comments-show", visible);
    host?.invalidate?.();
    host?.info?.(visible ? "Comment pins shown" : "Comment pins hidden");
  }

  // ------------------------------------------------------------------ add
  let composing = false;
  async function startAdd(area) {
    if (!host || composing) return;
    const doc = host.doc();
    if (doc.kind !== "pcb" && doc.kind !== "schematic") { host.info("Open a schematic sheet or board layout to comment on it."); return; }
    composing = true;
    try {
      const sel = host.selection?.() || [];
      if (!area && sel.length === 1) {
        const item = doc.items.find(i => i.id === sel[0]);
        if (item) { compose(doc, candidates(doc, host.defs(), item, centre(doc, item))); return; }
      }
      if (area) {
        const a = await host.pickPoint("Click the first corner of the area to comment on. Esc cancels.");
        if (!a) return;
        const b = await host.pickPoint("Click the opposite corner.", {from: a});
        if (!b) return;
        const bx = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        compose(doc, [{kind: "area", label: "Area " + (+(bx[2] - bx[0]).toFixed(2)) + " × " + (+(bx[3] - bx[1]).toFixed(2)) + " mm", at: [(bx[0] + bx[2]) / 2, bx[1]], box: bx}]);
        return;
      }
      const at = await host.pickPoint("Click a part, net, track or point to comment on. Esc cancels.");
      if (!at) return;
      const item = host.hitAt?.(at) || null;
      compose(host.doc(), candidates(host.doc(), host.defs(), item, at));
    } finally { composing = false; }
  }
  function centre(doc, item) {
    const b = itemBox(doc, host.defs(), item);
    return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [item.x || 0, item.y || 0];
  }
  // The composer: where the comment attaches and the text. The author comes from author().
  function compose(doc, options, extra = {}) {
    const d = el("dialog", null, "work-dialog ui-dialog rc-dialog"); d.setAttribute("aria-label", "Add Comment");
    const title = el("h2", "Add Comment", "ui-dialog-title");
    const form = el("div", null, "rc-form ui-dialog-body");
    const where = el("select", null, "ui-field"); where.setAttribute("aria-label", "Attach to");
    options.forEach((o, n) => where.add(new Option(o.label, String(n))));
    const text = el("textarea", null, "rc-input ui-field"); text.rows = 4; text.maxLength = MAX_TEXT; text.placeholder = "Comment (@name to mention)"; text.setAttribute("aria-label", "Comment");
    const lab = (t, c) => { const l = el("label", null, "work-row"); l.append(el("span", t), c); return l; };
    form.append(lab("Attach to", where), lab("Comment", text));
    const status = el("p", null, "rc-status"); status.setAttribute("role", "status");
    const foot = el("div", null, "work-actions ui-dialog-actions");
    const ok = btn("Add Comment", () => {
      if (!clean(text.value).trim()) { status.textContent = "Write a comment first."; text.focus(); return; }
      let made = null;
      try { host.edit(() => { made = add(host.project(), {doc: doc.id, anchor: options[+where.value], text: text.value, author: author(), diff: extra.diff}); }); }
      catch (e) { status.textContent = e.message; return; }
      d.close(); host.info("Comment added");
      if (made) focus(made.id, false);
    }, "is-primary");
    const cancel = btn("Cancel", () => d.close(), "ui-button");
    ok.dataset.uiDefault = "false";
    foot.append(cancel, ok);
    d.append(title, form, status, foot);
    const adoptDialog = globalThis.AtriumShell?.adoptDialog;
    adoptDialog?.(d, {title, body: form, actions: foot, initialFocus: text});
    for (const f of [text]) f.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ok.click(); } };
    d.onclose = () => { d.remove(); host.canvas?.()?.focus?.(); };
    document.body.append(d); d.showModal();
    if (!adoptDialog) text.focus();
    return d;
  }

  // ------------------------------------------------------------------ canvas
  // Pin overlay. The renderer returns one cached {overlay} object per pin set, and the overlay reads
  // the hover and drop-in state live, so an animation frame allocates nothing of its own. Frames are
  // asked for only while a pin is dropping in or a hovered pin's target is fading in.
  // Motion tokens (AtriumMotion): pins drop in --motion-slow, the hover target highlights in --motion-fast.
  const ms = n => Math.max(1, globalThis.AtriumMotion?.duration?.(n) ?? {fast: 140, slow: 320}[n]);
  let indexCache = null, pinCache = null, hotPin = null, hotAt = 0, raf = 0;
  const drops = new Map(), dropK = new Map(), DROP_OPTS = {drop: dropK}, NO_OPTS = {};
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  function frame() { raf = 0; if (host?.redrawOverlay) host.redrawOverlay(); else host?.redraw?.(); }
  function again() { if (!raf && typeof requestAnimationFrame === "function") { raf = 1; queueMicrotask(frame); } }
  function indexFor(doc) {
    const rev = host.revision?.();
    if (!indexCache || indexCache.doc !== doc || indexCache.rev !== rev) indexCache = {doc, rev, map: new Map(doc.items.map(i => [i.id, i]))};
    return indexCache.map;
  }
  // Pins are rebuilt only when the design, the document, the filter or the selection changes.
  function cachedPins(doc) {
    const p = host.project();
    if (!p?.review) return null;
    const key = host.revision?.() + "|" + doc.id + "|" + filter.status + "|" + selected;
    if (!pinCache || pinCache.key !== key || pinCache.project !== p) {
      const pins = pinsFor(p, doc, host.defs(), {status: filter.status === "resolved" ? "all" : filter.status, selected, index: indexFor(doc)});
      const c = {key, project: p, pins, out: null};
      c.out = {overlay: (ctx, info) => overlay(ctx, info, c.pins, doc.kind)};
      pinCache = c;
    }
    return pinCache.pins;
  }
  function stepDrops() {
    if (!drops.size) return false;
    const t = clock();
    let live = false;
    for (const [id, t0] of drops) {
      const k = (t - t0) / ms("slow");
      if (k >= 1) { drops.delete(id); dropK.delete(id); } else { dropK.set(id, Math.max(0, k)); live = true; }
    }
    return live;
  }
  function overlay(ctx, info, pins, kind) {
    let anim = stepDrops();
    if (hotPin) {
      // Hovering a pin highlights what it is attached to: its object, area or place.
      for (const p of pins) if (p.id === hotPin) {
        const k = motionOK() ? Math.min(1, (clock() - hotAt) / ms("fast")) : 1, px = 1 / info.scale, c = themed(kind), b = p.box;
        if (k < 1) anim = true;
        ctx.save();
        if (b) drawTarget(ctx, b[0], b[1], b[2], b[3], px, c.accent, k * (p.status === "resolved" ? .6 : 1), {pad: 3 + (1 - k) * 4});
        else drawTarget(ctx, p.at[0], p.at[1], p.at[0], p.at[1], px, c.accent, k, {pad: 6 + (1 - k) * 4, radius: 8});
        ctx.restore();
        break;
      }
    }
    const opts = dropK.size ? DROP_OPTS : NO_OPTS;
    opts.colours = themed(kind);
    drawPins(ctx, pins, info, opts);
    if (anim) again();
  }
  function render(doc) {
    if (!visible || !doc || !host) return null;
    const pins = cachedPins(doc);
    return pins?.length ? pinCache.out : null;
  }
  // A new thread's pin drops into place (Annotate mode, the composer).
  function dropIn(id) {
    if (!id || !motionOK()) return;
    drops.set(id, clock()); dropK.set(id, 0); again();
  }
  // A pin under a pointer, within its drawn head (screen px).
  function pinAt(pane, clientX, clientY) {
    if (!visible || !host) return null;
    const doc = pane.docId ? host.docById?.(pane.docId) : host.doc();
    if (!doc || !host.project()?.review) return null;
    const pins = pane.active === false ? pinsFor(host.project(), doc, host.defs(), {status: filter.status === "resolved" ? "all" : filter.status, index: indexFor(doc)}) : cachedPins(doc);
    if (!pins?.length) return null;
    const b = pane.canvas.getBoundingClientRect(), x = clientX - b.left, y = clientY - b.top;
    const r = 11 * PIN_HEAD, lift = r * PIN_REACH;
    let best = null, bd = r + 3;
    for (const pin of pins) {
      const s = pane.view.worldToScreen(pin.at), d = Math.hypot(s[0] - x, s[1] - lift - y);
      if (d <= bd) { bd = d; best = pin; }
    }
    return best;
  }
  function setHot(id) {
    if (id === hotPin) return;
    hotPin = id; hotAt = clock();
    if (host?.redrawOverlay) host.redrawOverlay(); else host?.redraw?.();
  }
  // Hovering a pin (any tool, pointer up) highlights its target. Cheap when there are no comments.
  function onHover(e) {
    if (!host) return;
    const t = e.target;
    if (!visible || e.buttons || t?.tagName !== "CANVAS" || !host.project()?.review) { if (hotPin) setHot(null); return; }
    const pane = host.panes?.().find(q => q.canvas === t);
    const pin = pane?.active ? pinAt(pane, e.clientX, e.clientY) : null;
    setHot(pin ? pin.id : null);
  }
  function onPointer(e) {
    if (e.button !== 0 || !host || host.tool?.() !== "select") return;
    const pane = host.panes?.().find(q => q.canvas === e.target);
    if (!pane) return;
    const pin = pinAt(pane, e.clientX, e.clientY);
    if (!pin) return;
    e.preventDefault(); e.stopImmediatePropagation();
    focus(pin.id, false);
  }
  function attach(h) {
    host = h;
    host.registerAction("comments-panel", () => toggle());
    host.registerAction("comment-add", () => startAdd(false));
    host.registerAction("comment-add-area", () => startAdd(true));
    host.registerAction("comments-show", () => setVisible(!visible));
    host.addRenderer(d => render(d));
    host.on("change", () => { if (panel && !panel.hidden) { clearTimeout(changeTimer); changeTimer = setTimeout(paint, 120); } });
    host.on("document", () => { if (panel && !panel.hidden) paint(); });
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("pointermove", onHover, {capture: true, passive: true});
    globalThis.AtriumNavCommon?.setChecked("comments-show", visible);
  }
  globalThis.AtriumNavCommon?.ready(attach);
  return Object.freeze({...api, toggle, focus, compose, setVisible, isOpen: () => !!panel && !panel.hidden, visible: () => visible, attach,
    author, setAuthor, dropIn, pinAt, hotPin: () => hotPin, filterStatus: () => filter.status});
})();
