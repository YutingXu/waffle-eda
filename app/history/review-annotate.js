"use strict";
// Annotate mode: point at a schematic or board object and comment on it, the way a web page
// inspector picks elements. Entered from the Active Bar's Comment tool, Project › Annotate Mode,
// the palette ("Annotate"), C M, or right-click › Add Comment (which opens the composer at once).
//
//   Hover      the object under the pointer gets an accent box (rounded, soft tint) that eases
//              between objects in 140 ms, with a label: "R12 · 10 kΩ", "Track · 0.25 mm · GND",
//              "Pin U1.3 VDD", "Net GND". Alt (or Alt+wheel) steps up the hierarchy
//              pad/pin → part → net → room; the label shows it as a breadcrumb.
//   Empty      a crosshair and "Drag to mark an area".
//   Click      locks the box with a pulse; a composer slides in beside it (never over it: it flips
//              side near the canvas edges). Ctrl/⌘+Enter posts, Esc cancels.
//   Drag       marching-ants rectangle with its live size, then the same composer.
//   Shift      Shift+click adds objects to one comment (a group box).
//   Keyboard   Tab / Shift+Tab or the arrow keys cycle the objects near the cursor, Enter locks
//              (Shift+Enter adds to the group), Alt steps up, Esc exits. The target label is
//              announced through an ARIA live region.
//
// Comments are review-comments.js threads (anchors part, pin, track, item, net, room, area, group);
// a posted comment's pin drops into place there. Motion follows Preferences › Appearance › Motion
// and prefers-reduced-motion (AtriumReviewComments.motionOK).
//
// Cost: nothing is registered while the mode is off (no listeners, no renderer). While it is on,
// the box is drawn by one cached overlay renderer; frames are requested (requestAnimationFrame,
// pointer-only frames that reuse the board layer) only while something is easing, pulsing or a
// rectangle is being dragged. The per-frame path reuses typed arrays and allocates nothing of its
// own except the one screen point the label is placed from.
//
// The target model (levels, labels, anchors) is DOM-free and tested in tests/review-annotate.cjs.
globalThis.AtriumReviewAnnotate = (() => {
  const A = () => globalThis.Atrium, RC = () => globalThis.AtriumReviewComments, XP = () => globalThis.AtriumCrossProbe;
  // Motion tokens (AtriumMotion): the box eases in --motion-fast, the pulse takes --motion-slow.
  const ms = n => Math.max(1, globalThis.AtriumMotion?.duration?.(n) ?? {fast: 140, slow: 320}[n]);
  const DRAG_PX = 4, NEAR_PX = 56, MAX_NEAR = 12;
  const KIND_NAMES = {pin: "Pin", part: "Component", track: "Track", item: "Object", net: "Net", room: "Room", area: "Area", point: "Point", group: "Group"};
  // i18n (docs/translating.md): plain text is extracted into "review" and translated where it is
  // rendered (the scope below); labels with values use T(), single words drawn on the canvas tx().
  // Headless tests run without i18n.js: the stand-in formats the English table itself.
  // "\u0029" is ")": scripts/i18n-extract.py reads the table up to the first "})".
  const AtriumI18n = globalThis.AtriumI18n || {define: o => (k, a) => o[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  const T = AtriumI18n.define({
    "review.annotate.pad": "Pad {number}",
    "review.annotate.pin": "Pin {pin}",
    "review.annotate.net": "Net {net}",
    "review.annotate.room": "Room {name}",
    "review.annotate.area": "Area {size}",
    "review.annotate.point": "Point ({at}\u0029",
    "review.annotate.group_anchor": "{count} objects: {names}",
    "review.annotate.group": "{count} objects · {names}",
    "review.annotate.commenting": "Commenting on {target}. Type, then press {key} to post, or Escape to cancel.",
    "review.annotate.nearby": "{label}. {index} of {count} nearby.",
    "review.annotate.alt_steps": "Alt steps up.",
    "review.annotate.enter": "Enter to comment.",
    "review.annotate.level": "{label}. {kind}, level {level} of {count}. Alt steps up.",
    "review.annotate.comment_on": "Comment on {target}",
    "review.annotate.added": "Comment added on {target}.",
    "review.annotate.added_n": "Comment {number} added on {target}."
  });
  const tx = s => globalThis.AtriumI18n?.text ? globalThis.AtriumI18n.text(s, "review") : s;
  globalThis.AtriumI18n?.scope?.(".ann-composer, .ann-chip, .ann-hint, .ann-live", ["review"]);

  // ------------------------------------------------------------------ labels (DOM-free)
  const PREFIX = {p: "p", n: "n", u: "µ", "µ": "µ", m: "m", k: "k", K: "k", M: "M", R: "", r: ""};
  // "10k" on R12 → "10 kΩ"; "4k7" → "4.7 kΩ"; "100n" on C3 → "100 nF". Anything else as written.
  function prettyValue(ref, value) {
    const v = String(value ?? "").trim();
    if (!v) return "";
    const r = String(ref || "");
    const unit = /^R(?![NV])/i.test(r) ? "Ω" : /^C/i.test(r) ? "F" : /^L/i.test(r) ? "H" : "";
    if (!unit) return v;
    const m = /^(\d+)(?:([.,]\d+)|([pnuµmkKMRr])(\d*))?\s*(?:Ω|ohms?|F|H)?$/.exec(v);
    if (!m) return v;
    const mant = m[1] + (m[2] ? "." + m[2].slice(1) : m[4] ? "." + m[4] : ""), pre = m[3] ? PREFIX[m[3]] : "";
    if (unit !== "Ω" && pre === "" && m[3]) return v;
    return mant + " " + pre + unit;
  }
  const trim = (v, d) => String(+(+v).toFixed(d));
  function lengthText(mm, unit, d = 3) {
    const u = String(unit || "mm").toLowerCase();
    if (u === "mil" || u === "mils") return trim(mm / .0254, Math.max(0, d - 2)) + " mil";
    if (u === "in" || u === "inch") return trim(mm / 25.4, d + 1) + " in";
    return trim(mm, d) + " mm";
  }
  const KIND_WORDS = {track: "Track", arc: "Arc", via: "Via", pad: "Pad", wire: "Wire", bus: "Bus", netlabel: "Net label", polygon: "Pour", power: "Power port",
    port: "Port", fill: "Fill", region: "Region", keepout: "Keepout", text: "Text", junction: "Junction", line: "Line"};
  function kindWord(item) { return tx(KIND_WORDS[item.kind]) || (item.kind ? item.kind[0].toUpperCase() + item.kind.slice(1) : tx("Object")); }
  // One line per object: what it is, its size, its net.
  function describe(item, net, unit) {
    const k = item.kind, parts = [kindWord(item)];
    if (k === "track" || k === "arc") { if (item.width > 0) parts.push(lengthText(item.width, unit)); }
    else if (k === "via") { if (item.diameter > 0) parts.push(lengthText(item.diameter, unit)); }
    else if (k === "pad") parts[0] = T("review.annotate.pad", {number: item.number ?? ""});
    else if (k === "netlabel" || k === "power" || k === "port") return parts[0] + " " + (item.text || item.name || net || "");
    else if (k === "part") return item.ref || tx("Component");
    if (net) parts.push(net);
    return parts.join(" · ");
  }
  function itemBox(doc, defs, item) { try { return A().bounds(A().itemPoints(item, defs?.get?.(item.def), doc.kind)); } catch { return null; } }
  function pinName(doc, defs, part, number) {
    try { const p = A().pins(part, defs?.get?.(part.def), doc.kind).find(x => String(x.number) === String(number)); return p?.name && p.name !== String(number) ? String(p.name) : ""; } catch { return ""; }
  }
  // Even-odd point in polygon (rooms.js has the same rule; it may not be loaded).
  function insidePoly(pts, p) {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  }
  // Rooms that hold the object (members, channel) or the point.
  function roomsFor(doc, item, point, box) {
    const rooms = Array.isArray(doc.rooms) ? doc.rooms : [];
    if (!rooms.length) return [];
    const c = box ? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] : point;
    return rooms.filter(r => Array.isArray(r.points) && r.points.length >= 3 &&
      (item?.kind === "part" && (r.members?.includes(item.id) || r.channel && item.channel === r.channel) || c && insidePoly(r.points, c)));
  }
  // The hierarchy under a point, innermost first: [pin|pad] → object → net → room(s).
  // Each level: {kind, id?, pin?, net?, crumb, label, box|null}. A net's box is filled in on demand.
  function levels(doc, defs, item, point, {unit = "mm"} = {}) {
    const out = [];
    if (item) {
      const box = itemBox(doc, defs, item);
      let net = "";
      if (item.kind === "part") {
        const t = point ? XP()?.targetAt?.(doc, defs, item, point) : null, ref = item.ref || "?";
        if (t?.kind === "pin") {
          const name = pinName(doc, defs, item, t.pin);
          out.push({kind: "pin", id: item.id, pin: String(t.pin), crumb: ref + "." + t.pin, label: T("review.annotate.pin", {pin: ref + "." + t.pin}) + (name ? " " + name : t.net ? " " + t.net : ""),
            box: RC()?.pinBox?.(doc, defs, item, t.pin) || null});
          net = t.net || "";
        }
        const value = prettyValue(item.ref, item.value);
        out.push({kind: "part", id: item.id, crumb: item.ref || tx("Part"), label: (item.ref || tx("Component")) + (value ? " · " + value : ""), box});
      } else {
        net = XP()?.netOf?.(doc, defs, item) || item.net || "";
        out.push({kind: item.kind === "track" || item.kind === "arc" || item.kind === "wire" ? "track" : "item", id: item.id,
          crumb: item.kind === "pad" ? T("review.annotate.pad", {number: item.number ?? ""}) : kindWord(item), label: describe(item, net, unit), box});
      }
      if (net) out.push({kind: "net", id: item.id, net, crumb: net, label: T("review.annotate.net", {net}), box: null});
      if (doc.kind === "pcb") for (const r of roomsFor(doc, item, point, box)) out.push({kind: "room", id: r.id, crumb: r.name || tx("Room"), label: T("review.annotate.room", {name: r.name || ""}), box: RC()?.roomBox?.(doc, r.id) || null});
    }
    return out;
  }
  function levelBox(doc, defs, level, at) {
    if (level.box) return level.box;
    if (level.kind === "net") {
      try { level.box = XP()?.netObjects?.(doc, defs, level.net)?.box || null; } catch { level.box = null; }
    }
    if (!level.box && at) level.box = [at[0], at[1], at[0], at[1]];
    return level.box;
  }
  const sameLevel = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id && a.pin === b.pin && a.net === b.net && (a.kind !== "area" || a.box === b.box);
  const union = (a, b) => !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  function areaLevel(a, b, unit) {
    const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    return {kind: "area", crumb: tx("Area"), label: T("review.annotate.area", {size: areaSize(box, unit)}), box};
  }
  // "3 mm × 4 mm": an area's size (the drag label, and the area target's label).
  function areaSize(box, unit) { return lengthText(box[2] - box[0], unit, 2) + " × " + lengthText(box[3] - box[1], unit, 2); }
  function pointLevel(at) { return {kind: "point", crumb: tx("Point"), label: T("review.annotate.point", {at: at.map(v => +(+v).toFixed(2)).join(", ")}), box: [at[0], at[1], at[0], at[1]]}; }
  // The comment anchor (review-comments.js) for a locked target: one level, or a group of them.
  function anchorFor(target, at) {
    const r4 = v => Math.round(v * 1e4) / 1e4;
    if (target.group) {
      const ids = [...new Set(target.group.map(g => g.id).filter(Boolean))].slice(0, RC()?.MAX_GROUP || 200);
      const box = target.group.reduce((b, g) => union(b, g.box), null);
      const names = target.group.map(g => g.crumb);
      const label = T("review.annotate.group_anchor", {count: target.group.length, names: names.slice(0, 4).join(", ") + (names.length > 4 ? "…" : "")});
      return {kind: "group", ids, label, at: box ? [r4((box[0] + box[2]) / 2), r4(box[1])] : at, ...(box ? {box} : {})};
    }
    const b = target.box, top = b ? [(b[0] + b[2]) / 2, b[1]] : at;
    if (target.kind === "point") return {kind: "point", label: target.label, at: b ? [b[0], b[1]] : at};
    const out = {kind: target.kind, label: target.label, at: target.kind === "net" && at ? at : top};
    if (target.id) out.id = target.id;
    if (target.pin != null) out.pin = target.pin;
    if (target.net) out.net = target.net;
    if (b && (b[2] > b[0] || b[3] > b[1])) out.box = b;
    return out;
  }
  // Objects near a world point for keyboard cycling: nearest first, then smallest.
  function nearby(doc, defs, items, at) {
    const scored = [];
    for (const i of items) {
      const b = itemBox(doc, defs, i);
      if (!b) continue;
      const dx = Math.max(b[0] - at[0], 0, at[0] - b[2]), dy = Math.max(b[1] - at[1], 0, at[1] - b[3]);
      scored.push({item: i, d: Math.hypot(dx, dy), area: (b[2] - b[0]) * (b[3] - b[1])});
    }
    scored.sort((a, b) => a.d - b.d || a.area - b.area);
    return scored.slice(0, MAX_NEAR).map(s => s.item);
  }

  const api = {prettyValue, describe, levels, levelBox, anchorFor, areaLevel, pointLevel, nearby, sameLevel, KIND_NAMES};
  if (typeof document === "undefined" || !document.createElement) return Object.freeze(api);

  // ------------------------------------------------------------------ mode state
  let host = null, on = false, offRenderer = null, observer = null;
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const ease = k => 1 - (1 - k) * (1 - k) * (1 - k);
  // Box easing state (world mm). Typed arrays: the frame path writes into them in place.
  const cur = new Float64Array(4), from = new Float64Array(4), to = new Float64Array(4);
  const S = {
    a: 0, aFrom: 0, aTo: 0, t0: 0, grow: 0, levels: [], level: 0, key: "", world: null, client: [0, 0], flipped: false,
    locked: null, cand: null, pulse: 0, drag: null, group: [], near: null, nearAt: -1, nearFrom: null, raf: 0, wheel: 0, crumbTotal: 0,
    label: "", crumbs: [], crumbW: [], labelW: 0, sepW: 0, textDirty: true, lp: [0, 0], screen: new Float64Array(4), placed: new Float64Array(4)
  };
  const P = {accent: "", halo: "", bg: "", ink: "", muted: "", line: "", accentUI: "", shadow: "", main: "", crumb: "", crumbOn: "", fs: 1};
  const DASH = [0, 0], NO_DASH = [];
  const RENDER = {overlay: draw};
  let motion = true;

  // The theme accent, kept vivid against the workspace actually painted (boards stay dark in the
  // Light theme; sheets are light in the Dark theme): lightness moves, hue and saturation stay.
  function adapt(colour, darkBg) {
    const m = /(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/.exec(colour || "");
    if (!m) return colour;
    const r = m[1] / 255, g = m[2] / 255, b = m[3] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    let h = 0, sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const L = darkBg ? Math.max(l, .6) : Math.min(l, .42);
    if (sat > .15) sat = Math.max(sat, .7);
    const c = (1 - Math.abs(2 * L - 1)) * sat, x = c * (1 - Math.abs(h % 2 - 1)), o = L - c / 2;
    const [R1, G1, B1] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return "rgb(" + Math.round((R1 + o) * 255) + "," + Math.round((G1 + o) * 255) + "," + Math.round((B1 + o) * 255) + ")";
  }
  function workspaceDark() {
    const pcb = host?.doc?.()?.kind === "pcb";
    try {
      const px = host.canvas().getContext("2d").getImageData(1, 1, 1, 1).data;
      if (px[3] > 0) return (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255 < .5;
    } catch {}
    return pcb;
  }
  function palette() {
    const R = RC(), dark = workspaceDark();
    P.accent = adapt(R.cssColour("--accent", "rgb(55,148,255)"), dark);
    P.halo = dark ? R.cssColour("--shadow-md", "rgba(0,0,0,.6)") : R.cssColour("--sheet", "rgb(255,255,255)");
    P.bg = R.cssColour("--overlay", "rgb(45,45,45)"); P.ink = R.cssColour("--ink", "rgb(226,226,226)"); P.muted = R.cssColour("--muted", "rgb(176,176,176)");
    P.line = R.cssColour("--line", "rgb(71,71,71)"); P.accentUI = R.cssColour("--accent", "rgb(55,148,255)"); P.shadow = R.cssColour("--shadow-md", "rgba(0,0,0,.6)");
    let fam = "system-ui, sans-serif", fs = 1;
    try { const cs = getComputedStyle(document.body); fam = cs.fontFamily || fam; fs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-scale")) || 1; } catch {}
    P.fs = fs; P.main = "600 " + (12 * fs).toFixed(1) + "px " + fam; P.crumb = "400 " + (11 * fs).toFixed(1) + "px " + fam; P.crumbOn = "600 " + (11 * fs).toFixed(1) + "px " + fam;
    motion = R.motionOK();
    S.textDirty = true;
  }
  function frame() { S.raf = 0; if (!host) return; if (host.redrawOverlay) host.redrawOverlay(); else host.redraw?.(); }
  function again() { if (!S.raf && typeof requestAnimationFrame === "function") { S.raf = -1; queueMicrotask(frame); } }
  // Ease the box from where it is drawn now to `b` (world box), or fade it out (b = null).
  function retarget(b, fresh) {
    const t = clock(), k = motion ? Math.min(1, (t - S.t0) / ms("fast")) : 1, e = ease(k);
    for (let i = 0; i < 4; i++) from[i] = cur[i] = from[i] + (to[i] - from[i]) * e;
    S.aFrom = S.a = S.aFrom + (S.aTo - S.aFrom) * e;
    if (b) {
      if (fresh || S.a < .05) { for (let i = 0; i < 4; i++) from[i] = cur[i] = b[i]; S.grow = 1; } else S.grow = 0;
      for (let i = 0; i < 4; i++) to[i] = b[i];
      S.aTo = 1;
    } else S.aTo = 0;
    S.t0 = t;
    again();
  }
  function setText(label, crumbs) {
    if (label === S.label && crumbs.length === S.crumbs.length && crumbs.every((c, i) => c === S.crumbs[i])) return;
    S.label = label; S.crumbs = crumbs; S.textDirty = true;
  }

  // ------------------------------------------------------------------ drawing
  function draw(ctx, info) {
    const R = RC(), t = clock(), px = 1 / info.scale;
    let anim = false;
    const k = motion ? Math.min(1, (t - S.t0) / ms("fast")) : 1, e = ease(k);
    if (k < 1) anim = true;
    for (let i = 0; i < 4; i++) cur[i] = from[i] + (to[i] - from[i]) * e;
    S.a = S.aFrom + (S.aTo - S.aFrom) * e;
    ctx.save();
    for (let i = 0; i < S.group.length; i++) {
      const b = S.group[i].box;
      if (b) R.drawTarget(ctx, b[0], b[1], b[2], b[3], px, P.accent, .85, {pad: 2, width: 1.2, fill: .1, halo: P.halo});
    }
    if (S.locked && S.cand) R.drawTarget(ctx, S.cand[0], S.cand[1], S.cand[2], S.cand[3], px, P.accent, .55, {pad: 3, width: 1, fill: .05});
    if (S.a > .004 && !(R.hotPin?.() && !S.locked)) {
      const area = S.locked && S.locked.kind === "area";
      const dot = cur[2] - cur[0] < 1e-9 && cur[3] - cur[1] < 1e-9;
      R.drawTarget(ctx, cur[0], cur[1], cur[2], cur[3], px, P.accent, S.a, {pad: area ? 0 : (dot ? 8 : 3) + S.grow * (1 - e) * 6, radius: area ? 2 : dot ? 10 : 4,
        width: S.locked ? 2 : 1.5, fill: S.locked ? .16 : .12, halo: P.halo});
    }
    if (S.pulse) {
      const q = (t - S.pulse) / ms("slow");
      if (q >= 1 || !motion) S.pulse = 0;
      else { anim = true; const g = ease(q); R.drawTarget(ctx, cur[0], cur[1], cur[2], cur[3], px, P.accent, (1 - g) * .8, {pad: 3 + g * 12, width: 2.2 * (1 - g) + .6, fill: 0}); }
    }
    const d = S.drag;
    if (d?.moved && S.world) {
      const x0 = Math.min(d.at[0], S.world[0]), y0 = Math.min(d.at[1], S.world[1]), x1 = Math.max(d.at[0], S.world[0]), y1 = Math.max(d.at[1], S.world[1]);
      ctx.globalAlpha = .1; ctx.fillStyle = P.accent; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = .6; ctx.strokeStyle = P.halo; ctx.lineWidth = 3 * px; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      DASH[0] = 5 * px; DASH[1] = 4 * px; ctx.setLineDash(DASH);
      ctx.lineDashOffset = motion ? -((t / 28) % 9) * px : 0;
      ctx.globalAlpha = 1; ctx.strokeStyle = P.accent; ctx.lineWidth = 1.5 * px; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash(NO_DASH); ctx.lineDashOffset = 0;
      if (motion) anim = true;
    }
    ctx.restore();
    if (S.a > .25 && S.label && !(R.hotPin?.() && !S.locked) || d?.moved) drawLabel(ctx, info);
    if (S.locked && composer && !composer.root.hidden) follow(info);
    if (anim) again();
  }
  function measure(ctx) {
    ctx.font = P.main; S.labelW = ctx.measureText(S.label).width;
    S.crumbW.length = S.crumbs.length;
    let total = 0;
    ctx.font = P.crumb; S.sepW = ctx.measureText("  ›  ").width;
    for (let i = 0; i < S.crumbs.length; i++) { ctx.font = i === S.level ? P.crumbOn : P.crumb; S.crumbW[i] = ctx.measureText(S.crumbs[i]).width; total += S.crumbW[i] + (i ? S.sepW : 0); }
    S.crumbTotal = total;
    S.textDirty = false;
  }
  // The label pill above the box (below it near the canvas top), in screen px.
  function drawLabel(ctx, info) {
    const d = S.drag?.moved ? S.drag : null;
    if (d) { setText(d.label, []); }
    ctx.save();
    ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0);
    if (S.textDirty) measure(ctx);
    let sx, sy, bh;
    if (d) {
      S.lp[0] = S.world[0]; S.lp[1] = S.world[1];
      const s = info.worldToScreen(S.lp); sx = s[0] + 14; sy = s[1] + 16; bh = 0;
    } else {
      S.lp[0] = S.flipped ? cur[2] : cur[0]; S.lp[1] = cur[1];
      const s = info.worldToScreen(S.lp); sx = s[0] - 3; sy = s[1] - 3; bh = (cur[3] - cur[1]) * info.scale + 6;
    }
    const crumbs = S.crumbs.length > 1, fs = P.fs, padX = 8 * fs, h1 = Math.round(22 * fs), h2 = crumbs ? Math.round(16 * fs) : 0, H = h1 + h2;
    const W = Math.ceil(Math.max(S.labelW, crumbs ? S.crumbTotal : 0) + padX * 2);
    let x = sx, y = d ? sy : sy - 6 - H;
    if (!d && y < 4) y = sy + bh + 6;
    if (y + H > info.height - 4) y = Math.max(4, info.height - 4 - H);
    x = Math.max(4, Math.min(x, info.width - W - 4));
    ctx.globalAlpha = d ? 1 : Math.min(1, S.a * 1.4);
    ctx.shadowColor = P.shadow; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
    RC().roundBox(ctx, x, y, x + W, y + H, 6);
    ctx.fillStyle = P.bg; ctx.fill();
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.lineWidth = 1; ctx.strokeStyle = P.line; ctx.stroke();
    // An accent rule along the left edge ties the label to the box.
    ctx.fillStyle = P.accentUI; ctx.fillRect(x + 1, y + 6, 2, H - 12);
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.font = P.main; ctx.fillStyle = P.ink; ctx.fillText(S.label, x + padX, y + h1 / 2 + .5);
    if (crumbs) {
      let cx = x + padX;
      const cy = y + h1 + h2 / 2 - 3;
      for (let i = 0; i < S.crumbs.length; i++) {
        if (i) { ctx.font = P.crumb; ctx.fillStyle = P.muted; ctx.fillText("  ›  ", cx, cy); cx += S.sepW; }
        ctx.font = i === S.level ? P.crumbOn : P.crumb; ctx.fillStyle = i === S.level ? P.accentUI : P.muted;
        ctx.fillText(S.crumbs[i], cx, cy); cx += S.crumbW[i];
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ hover
  function activePane(target) {
    if (!target || target.tagName !== "CANVAS") return null;
    const p = host.panes?.().find(q => q.canvas === target);
    return p?.active ? p : null;
  }
  function announce(text) {
    if (!live) return;
    live.textContent = "";
    // A fresh text node on the next frame, so the same label is announced again.
    const t = text;
    (globalThis.requestAnimationFrame || setTimeout)(() => { if (live) live.textContent = t; });
  }
  function showLevel(i, fresh, speak) {
    if (!S.levels.length) return;
    const n = S.levels.length;
    S.level = ((i % n) + n) % n;
    const L = S.levels[S.level], b = levelBox(host.doc(), host.defs(), L, S.world);
    setText(L.label, S.levels.map(l => l.crumb));
    S.textDirty = true;
    retarget(b, fresh);
    if (speak) announce((n > 1 ? T("review.annotate.level", {label: L.label, kind: tx(KIND_NAMES[L.kind]), level: S.level + 1, count: n}) : L.label) + " " + T("review.annotate.enter"));
  }
  // While a target is locked, the object under the pointer gets a lighter box: Shift+click adds it.
  function candidate() {
    const L = S.levels[S.level], locked = S.locked;
    const taken = !L || locked && (sameLevel(L, locked) || locked.group?.some(g => sameLevel(g, L)));
    S.cand = taken ? null : levelBox(host.doc(), host.defs(), L, S.world);
    again();
  }
  function clearHover() {
    if (!S.levels.length && S.aTo === 0) return;
    S.levels = []; S.key = ""; setText("", []);
    retarget(null);
  }
  function setCursor(c, v) { if (c && c.style.cursor !== v) c.style.cursor = v; }
  function hover(e, pane) {
    const hit = host.hit(pane.canvas, e.clientX, e.clientY);
    S.world = hit?.point || S.world; S.client[0] = e.clientX; S.client[1] = e.clientY;
    if (S.drag) return;
    let item = hit?.item || null;
    if (item && host.selectable && !host.selectable(item)) item = null;
    if (RC().hotPin?.()) { setCursor(pane.canvas, "pointer"); hint(false); return; }
    setCursor(pane.canvas, item ? "pointer" : "crosshair");
    if (!item) {
      if (S.locked) { if (S.levels.length || S.cand) { S.levels = []; S.key = ""; S.cand = null; again(); } hint(false); }
      else { clearHover(); hint(true, e); }
      return;
    }
    hint(false);
    let pin = "";
    if (item.kind === "part" && hit.point) { const t = XP()?.targetAt?.(hit.doc, host.defs(), item, hit.point); if (t?.kind === "pin") pin = t.pin; }
    const key = item.id + "/" + pin;
    if (key === S.key) return;
    S.key = key; S.near = null;
    const fresh = !S.levels.length;
    const prev = S.levels[S.level];
    S.levels = levels(hit.doc, host.defs(), item, hit.point, {unit: host.units?.()});
    // Keep the level kind the user stepped to (e.g. stay on nets while moving along a track).
    const keep = prev && S.level > 0 ? S.levels.findIndex(l => l.kind === prev.kind) : -1;
    if (S.locked) { S.level = keep > 0 ? keep : 0; candidate(); return; }
    showLevel(keep > 0 ? keep : 0, fresh, false);
    announceSoon(S.levels[S.level]?.label);
  }
  // Pointer hover announces only once the pointer settles (no chatter while sweeping).
  let speakTimer = 0;
  function announceSoon(text) { clearTimeout(speakTimer); if (text) speakTimer = setTimeout(() => announce(text), 450); }

  // ------------------------------------------------------------------ the "Drag to mark an area" hint
  let hintEl = null, live = null, chip = null;
  function hint(show, e) {
    if (!hintEl) return;
    if (show && e) {
      const st = hintEl.parentElement?.getBoundingClientRect?.();
      if (st) hintEl.style.transform = "translate(" + Math.round(e.clientX - st.left + 16) + "px," + Math.round(e.clientY - st.top + 18) + "px)";
    }
    hintEl.classList.toggle("is-shown", !!show);
  }

  // ------------------------------------------------------------------ click, drag, lock
  function lock(target, {pulse = true} = {}) {
    S.locked = target; S.cand = null;
    if (target.group) { S.levels = []; setText(target.label, []); }
    else setText(target.label, S.levels.some(l => sameLevel(l, target)) ? S.levels.map(l => l.crumb) : []);
    retarget(target.box, false);
    if (pulse && motion) S.pulse = clock();
    hint(false);
    openComposer(target);
    announce(T("review.annotate.commenting", {target: target.label, key: globalThis.AtriumKeymap?.display("Mod+Enter", true) || "Control+Enter"}));
  }
  function unlock() { S.locked = null; S.group = []; S.key = ""; S.cand = null; clearHover(); again(); }
  function groupTarget() {
    const box = S.group.reduce((b, g) => union(b, g.box), null);
    return {group: S.group.slice(), kind: "group", box, label: T("review.annotate.group", {count: S.group.length, names: S.group.map(g => g.crumb).slice(0, 4).join(", ") + (S.group.length > 4 ? "…" : "")})};
  }
  function clickTarget(shift) {
    const L = S.levels[S.level];
    if (!L) {
      if (S.locked && !composerText()) { closeComposer(); unlock(); }
      else if (!S.locked) announce("Drag to mark an area, or point at an object.");
      return;
    }
    levelBox(host.doc(), host.defs(), L, S.world);
    if (shift) {
      // Shift: add to (or remove from) one group comment.
      if (S.locked && !S.locked.group && !S.group.length) S.group.push(S.locked);
      const at = S.group.findIndex(g => sameLevel(g, L));
      if (at >= 0) S.group.splice(at, 1); else S.group.push({...L});
      if (!S.group.length) { closeComposer(); unlock(); return; }
      if (S.group.length === 1) { const only = S.group[0]; S.group = []; lock(only); return; }
      lock(groupTarget());
      return;
    }
    S.group = [];
    lock({...L});
  }
  function onDown(e) {
    if (!on || e.button !== 0) return;
    const pane = activePane(e.target);
    if (!pane) return;
    // A comment pin under the pointer opens its thread (review-comments.js handles the click).
    if (RC().pinAt?.(pane, e.clientX, e.clientY)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    pane.canvas.focus?.({preventScroll: true});
    try { pane.canvas.setPointerCapture?.(e.pointerId); } catch {}
    const hit = host.hit(pane.canvas, e.clientX, e.clientY);
    S.world = hit?.point || S.world;
    S.drag = {at: S.world ? S.world.slice() : [0, 0], x: e.clientX, y: e.clientY, moved: false, shift: e.shiftKey, label: ""};
  }
  function onMove(e) {
    if (!on) return;
    const pane = activePane(e.target);
    if (!pane) { if (!S.drag && !S.locked && e.target?.closest && !e.target.closest(".ann-composer")) { clearHover(); hint(false); } return; }
    if (host.tool?.() !== "select") { exit(); return; }
    hover(e, pane);
    const d = S.drag;
    if (d) {
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) >= DRAG_PX) { d.moved = true; hint(false); if (!S.locked) clearHover(); }
      if (d.moved && S.world) { d.label = areaSize(areaLevel(d.at, S.world, host.units?.()).box, host.units?.()); again(); }
    }
  }
  function onUp(e) {
    if (!on || e.button !== 0 || !S.drag) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const d = S.drag; S.drag = null;
    if (d.moved && S.world) {
      const area = areaLevel(d.at, S.world, host.units?.());
      if (area.box[2] - area.box[0] > 0 || area.box[3] - area.box[1] > 0) { S.group = []; S.levels = []; S.key = ""; lock(area); return; }
    }
    clickTarget(d.shift || e.shiftKey);
    again();
  }
  function onLeave(e) {
    if (!on || S.drag || S.locked) return;
    if (e.target?.tagName === "CANVAS") { clearHover(); hint(false); }
  }
  function onWheel(e) {
    if (!on || !e.altKey || S.levels.length < 2 || S.locked || !activePane(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    S.wheel += e.deltaY;
    if (Math.abs(S.wheel) < 40) return;
    const step = S.wheel > 0 ? 1 : -1; S.wheel = 0;
    showLevel(S.level + step, false, true);
  }

  // ------------------------------------------------------------------ keyboard
  function cycle(step) {
    const doc = host.doc(), defs = host.defs(), view = host.view?.();
    if (!S.near) {
      const at = S.world || host.pointer?.() || centre();
      const r = NEAR_PX / (view?.scale?.() || 1);
      const found = view?.query ? view.query(doc, defs, [at[0] - r, at[1] - r, at[0] + r, at[1] + r]) : doc.items;
      S.near = nearby(doc, defs, found.filter(i => !host.selectable || host.selectable(i)), at);
      S.nearAt = -1; S.nearFrom = at;
    }
    if (!S.near.length) { announce("Nothing near the cursor. Move closer to an object, or drag to mark an area."); return; }
    S.nearAt = ((S.nearAt + step) % S.near.length + S.near.length) % S.near.length;
    const item = S.near[S.nearAt], b = itemBox(doc, defs, item);
    const at = b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : S.nearFrom;
    const fresh = !S.levels.length;
    S.levels = levels(doc, defs, item, item.kind === "part" ? null : at, {unit: host.units?.()});
    S.key = item.id + "/";
    showLevel(0, fresh, false);
    announce(T("review.annotate.nearby", {label: S.levels[0].label, index: S.nearAt + 1, count: S.near.length}) + (S.levels.length > 1 ? " " + T("review.annotate.alt_steps") : "") + " " + T("review.annotate.enter"));
  }
  function centre() { const c = host.canvas?.(), v = host.view?.(); return c && v ? v.screenToWorld([c.clientWidth / 2, c.clientHeight / 2]) : [0, 0]; }
  function onKey(e) {
    if (!on) return;
    const t = e.target;
    if (composer && composer.root.contains(t)) return;   // the composer has its own keys
    const free = t === document.body || t?.tagName === "CANVAS" || t === document.documentElement;
    if (e.key === "Escape") {
      if (!free && t?.closest?.("dialog[open], [role=dialog], .nav-menu, .menu-items")) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (S.drag) { S.drag = null; if (S.locked) setText(S.locked.label, []); again(); return; }
      if (S.locked) { closeComposer(); unlock(); return; }
      exit();
      return;
    }
    if (!free) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === "Alt" && !e.repeat) { if (S.levels.length > 1 && !S.locked) { stop(); showLevel(S.level + (e.shiftKey ? -1 : 1), false, true); } return; }
    if (e.key === "Tab" || (/^Arrow/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      if (S.locked) return;
      stop(); cycle(e.key === "Tab" ? (e.shiftKey ? -1 : 1) : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1); return;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { if (S.levels.length) { stop(); clickTarget(e.shiftKey); } return; }
  }

  // ------------------------------------------------------------------ composer
  let composer = null;
  const NC = () => globalThis.AtriumNavCommon;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  function buildComposer() {
    const root = el("div", null, "ann-composer ui-popover"); root.hidden = true; root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Add comment");
    const form = el("form", null, "ann-c-form"); form.noValidate = true;
    // One quiet caption names the target (the canvas already marks it); an area needs none.
    const title = el("p", null, "ann-c-title");
    const text = el("textarea", null, "ann-c-text ui-field"); text.rows = 3; text.maxLength = RC().MAX_TEXT; text.placeholder = tx("Add a comment… (@name to mention)"); text.setAttribute("aria-label", "Comment");
    // The author is the user's identity (Preferences › Collaboration › display name), never asked per comment.
    const foot = el("div", null, "ann-c-foot");
    const cancel = el("button", "Cancel", "ann-c-cancel ui-button"); cancel.type = "button"; cancel.setAttribute("aria-keyshortcuts", "Escape");
    const post = el("button", null, "ann-c-post ui-button"); post.type = "submit"; post.dataset.variant = "primary";
    const keys = AtriumShortcut.render("Mod+Enter"); keys.setAttribute("aria-hidden", "true");
    post.append(el("span", "Comment"), keys);
    post.setAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");   // ⌘↩ on macOS, Ctrl+Enter elsewhere; i18n-ignore
    const status = el("p", null, "ann-c-status"); status.setAttribute("role", "status");
    foot.append(cancel, post);
    form.append(title, text, status, foot); root.append(form);
    cancel.onclick = () => { closeComposer(); unlock(); };
    form.onsubmit = ev => { ev.preventDefault(); submit(); };
    root.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.isComposing) return;
      if (ev.key === "Escape") { ev.preventDefault(); closeComposer(); unlock(); }
      else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submit(); }
    });
    text.oninput = () => { post.disabled = !RC().clean(text.value).trim(); status.textContent = ""; };
    composer = {root, title, text, post, status};
    return composer;
  }
  function composerText() { return composer && !composer.root.hidden ? RC().clean(composer.text.value).trim() : ""; }
  function openComposer(target) {
    const c = composer || buildComposer(), stage = host.canvas?.()?.parentElement;
    if (!stage) return;
    if (c.root.parentElement !== stage) stage.append(c.root);
    c.title.textContent = target.kind === "area" ? "" : target.label;
    c.root.setAttribute("aria-label", T("review.annotate.comment_on", {target: target.label}));
    c.post.disabled = !RC().clean(c.text.value).trim();
    c.status.textContent = "";
    c.root.hidden = false;
    S.placed.fill(NaN);
    place(true);
    globalThis.AtriumSurfaceMotion?.popover(c.root, true);
    c.text.focus({preventScroll: true});
  }
  function closeComposer() {
    if (!composer || composer.root.hidden) return;
    const surface = globalThis.AtriumSurfaceMotion;
    if (surface) surface.popover(composer.root, false);
    else composer.root.hidden = true;
    host.canvas?.()?.focus?.({preventScroll: true});
  }
  // Screen box of the locked target, relative to the canvas stage.
  function screenBox(out) {
    const v = host.view?.(), c = host.canvas?.();
    if (!v || !c) return false;
    const a = v.worldToScreen([cur[0], cur[1]]), b = v.worldToScreen([cur[2], cur[3]]);
    const pad = S.locked?.kind === "area" ? 0 : 3;
    out[0] = Math.min(a[0], b[0]) - pad + c.offsetLeft; out[1] = Math.min(a[1], b[1]) - pad + c.offsetTop;
    out[2] = Math.max(a[0], b[0]) + pad + c.offsetLeft; out[3] = Math.max(a[1], b[1]) + pad + c.offsetTop;
    return true;
  }
  // Beside the target, never over it: right, left, below, above, whichever fits first.
  function place(force) {
    const c = composer, stage = c?.root.parentElement;
    if (!c || c.root.hidden || !stage || !screenBox(S.screen)) return;
    const sb = S.screen;
    if (!force && Math.abs(sb[0] - S.placed[0]) < .5 && Math.abs(sb[1] - S.placed[1]) < .5 && Math.abs(sb[2] - S.placed[2]) < .5 && Math.abs(sb[3] - S.placed[3]) < .5) return;
    S.placed.set(sb);
    const W = stage.clientWidth, H = stage.clientHeight, w = c.root.offsetWidth || 320, h = c.root.offsetHeight || 150, g = 12, m = 8;
    const cy = Math.max(m, Math.min(sb[1], H - h - m)), cx = Math.max(m, Math.min(sb[0], W - w - m));
    const options = [["right", sb[2] + g, cy], ["left", sb[0] - g - w, cy], ["below", cx, sb[3] + g], ["above", cx, sb[1] - g - h]];
    const fits = o => o[1] >= m && o[1] + w <= W - m && o[2] >= m && o[2] + h <= H - m;
    const clear = o => o[1] >= sb[2] || o[1] + w <= sb[0] || o[2] >= sb[3] || o[2] + h <= sb[1];
    let pick = options.find(o => fits(o) && clear(o));
    if (!pick) {
      // The target fills the view: the corner farthest from its centre, clamped to the stage.
      const mx = (sb[0] + sb[2]) / 2, my = (sb[1] + sb[3]) / 2;
      pick = [mx > W / 2 ? "left" : "right", mx > W / 2 ? m : W - w - m, my > H / 2 ? m : H - h - m];
    }
    c.root.dataset.side = pick[0];
    c.root.style.left = Math.round(Math.max(m, Math.min(pick[1], W - w - m))) + "px";
    c.root.style.top = Math.round(Math.max(m, Math.min(pick[2], H - h - m))) + "px";
  }
  // Called from the frame: the composer follows a pan or zoom. Cheap when nothing moved.
  function follow() { if (!S.pulse && clock() - S.t0 > ms("fast")) place(false); else place(true); }
  function submit() {
    const c = composer, target = S.locked;
    if (!c || !target) return;
    const text = c.text.value;
    if (!RC().clean(text).trim()) { c.status.textContent = "Write a comment first."; c.text.focus(); return; }
    const doc = host.doc();
    let made = null;
    try {
      const anchor = anchorFor(target, S.world || [(cur[0] + cur[2]) / 2, (cur[1] + cur[3]) / 2]);
      host.edit(() => { made = RC().add(host.project(), {doc: doc.id, anchor, text, author: (RC().author?.() || "Reviewer")}); });
    } catch (err) { c.status.textContent = err.message; return; }
    c.text.value = "";
    closeComposer();
    const n = made ? RC().threads(host.project(), {doc: doc.id, status: "all"}).find(t => t.id === made.id)?.number : null;
    if (made) RC().dropIn?.(made.id);
    unlock();
    host.invalidate?.();
    const msg = n ? T("review.annotate.added_n", {number: n, target: target.label}) : T("review.annotate.added", {target: target.label});
    host.info(msg); announce(msg);
  }

  // ------------------------------------------------------------------ enter / exit
  function setPressed(v) {
    for (const b of document.querySelectorAll('[data-action="comment-mode"]')) if (!b.closest(".menu-items")) b.setAttribute("aria-pressed", String(v));
    NC()?.setChecked?.("comment-mode", v);
  }
  function render(d, info) { return on && info?.active && d === host.doc() ? RENDER : null; }
  function ensureUi() {
    const stage = host.canvas?.()?.parentElement;
    if (!hintEl) { hintEl = el("div", "Drag to mark an area", "ann-hint"); hintEl.setAttribute("aria-hidden", "true"); }
    if (stage && hintEl.parentElement !== stage) stage.append(hintEl);
    if (!live) { live = el("div", null, "ann-live visually-hidden"); live.setAttribute("aria-live", "polite"); live.setAttribute("role", "status"); document.body.append(live); }
    if (!chip) {
      chip = el("button", null, "ann-chip status-action"); chip.type = "button";
      const label = "Annotate mode: click an object or drag an area to comment. Click to exit.";
      if (globalThis.AtriumKeymap) NC()?.shortcutTitle?.(chip, label, "Escape");
      else chip.title = label;
      chip.append(el("span", null, "ann-chip-dot"), el("span", "Annotating", "ann-chip-text"), AtriumShortcut.render("Escape", {variant:"inline"}));
      chip.onclick = () => exit();
      const status = document.getElementById("status");
      if (status) status.before(chip); else document.querySelector(".statusbar")?.append(chip);
    }
    chip.hidden = false;
  }
  function enter() {
    if (on || !host) return;
    const d = host.doc();
    if (d.kind !== "pcb" && d.kind !== "schematic") { host.info("Open a schematic sheet or board layout to annotate it."); return; }
    if (host.tool?.() !== "select") host.setTool?.("select");
    on = true;
    palette(); ensureUi();
    S.flipped = !!host.view?.()?.flipped?.();
    offRenderer = host.addRenderer(render);
    addEventListener("pointerdown", onDown, true); addEventListener("pointerup", onUp, true); addEventListener("pointermove", onMove, true);
    addEventListener("pointerout", onLeave, true); addEventListener("wheel", onWheel, {capture: true, passive: false}); addEventListener("keydown", onKey, true);
    observer = typeof MutationObserver === "function" ? new MutationObserver(() => { palette(); again(); }) : null;
    observer?.observe(document.documentElement, {attributes: true, attributeFilter: ["style", "class", "data-theme", "data-motion", "data-ui-font"]});
    document.body.classList.add("is-annotating");
    setPressed(true);
    const c = host.canvas?.(); setCursor(c, "crosshair"); c?.focus?.({preventScroll: true});
    host.info("Annotate: click an object or drag an area to comment. Alt steps up, Shift+click groups, Tab cycles, Esc exits.");
    announce("Annotate mode on. Point at an object, or press Tab to cycle the objects near the cursor.");
  }
  function exit() {
    if (!on) return;
    on = false;
    offRenderer?.(); offRenderer = null;
    removeEventListener("pointerdown", onDown, true); removeEventListener("pointerup", onUp, true); removeEventListener("pointermove", onMove, true);
    removeEventListener("pointerout", onLeave, true); removeEventListener("wheel", onWheel, {capture: true}); removeEventListener("keydown", onKey, true);
    observer?.disconnect(); observer = null;
    clearTimeout(speakTimer);
    if (S.raf) { (globalThis.cancelAnimationFrame || clearTimeout)(S.raf); S.raf = 0; }
    closeComposer();
    S.locked = null; S.group = []; S.drag = null; S.levels = []; S.key = ""; S.a = S.aFrom = S.aTo = 0; S.pulse = 0; S.near = null; setText("", []);
    hint(false); if (chip) chip.hidden = true;
    document.body.classList.remove("is-annotating");
    setPressed(false);
    const c = host.canvas?.(); if (c) c.style.cursor = "default";
    host.redraw?.();
    host.info("Annotate mode off.");
    announce("Annotate mode off.");
  }
  function toggle(v) { if (v ?? !on) enter(); else exit(); }
  // Right-click › Add Comment: the composer opens on the object (or point) that was clicked.
  function commentOn(item, point) {
    if (!host) return;
    enter();
    if (!on) return;
    const doc = host.doc(), defs = host.defs(), at = point || (item ? null : centre());
    S.world = at || S.world;
    S.levels = item ? levels(doc, defs, item, point, {unit: host.units?.()}) : [];
    S.group = [];
    if (S.levels.length) { S.level = 0; levelBox(doc, defs, S.levels[0], at); retarget(S.levels[0].box, true); lock({...S.levels[0]}); }
    else { const p = pointLevel(at || [0, 0]); retarget(p.box, true); lock(p); }
  }
  function attach(h) {
    host = h;
    host.registerAction("comment-mode", () => toggle());
    host.on?.("document", () => { if (!on) return; closeComposer(); S.locked = null; S.group = []; S.drag = null; S.levels = []; S.key = ""; S.a = S.aFrom = S.aTo = 0; palette(); ensureUi(); S.flipped = !!host.view?.()?.flipped?.(); const d = host.doc(); if (d.kind !== "pcb" && d.kind !== "schematic") exit(); });
    host.on?.("change", () => { if (on && !S.locked) { S.key = ""; S.near = null; } });
  }
  NC()?.ready?.(attach);
  return Object.freeze({...api, attach, enter, exit, toggle, commentOn, isOn: () => on,
    // The overlay renderer while the mode is on (frame-budget probes render it directly).
    renderer: () => on ? RENDER : null,
    // Tests and the frame-sequence probe: the eased box, alpha and label as drawn.
    state: () => ({on, box: [...cur], to: [...to], alpha: S.a, label: S.label, crumbs: S.crumbs.slice(), level: S.level, locked: S.locked ? S.locked.label : null,
      group: S.group.length, composer: !!composer && !composer.root.hidden, side: composer?.root.dataset.side || null})});
})();
