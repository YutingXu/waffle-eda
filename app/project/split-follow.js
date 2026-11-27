"use strict";
// Schematic | Board split with Follow (lazy: editor.js loads it when a split opens; the
// split-counterpart and split-follow actions load it too).
//
//   Window › Split with Board / Split with Schematic (Ctrl/⌘+Alt+\, split-counterpart): opens the paired
//   document in the other pane and turns Follow on. With the split already open it swaps the other
//   pane to the counterpart. The pair: a schematic's board (the board with the most of its parts), a
//   board's sheet that holds the selected part or net, else the first schematic.
//
//   Follow (split-follow; the eye on the inactive pane's tab strip): on whenever the other pane shows a
//   document of the other kind. Per session (sessionStorage), on by default. A click or a selection
//   change on a part, pin, wire, track or net in the active pane eases the other pane's camera to the
//   matching objects and pulses them briefly. The active pane keeps focus. Debounced; never during a
//   drag or a box select; no camera move when the target is already comfortably in view; the zoom
//   stops at a sensible minimum view size. Ctrl/⌘+click net highlight (shared by both panes) follows too.
//   Motion: AtriumMotion tokens and levels (Reduced: the camera jumps and the pulse only fades; Off: no pulse).
//
// Headless API (pure):
//   AtriumSplitFollow.counterpartFor(project, defs, docId, ids)       -> docId | null
//   AtriumSplitFollow.followTarget(project, defs, fromId, ids, opts)  -> {docId, ids, box, label} | null
//        opts: {toId, point, highlight}; point picks the pin under a click
//   AtriumSplitFollow.inView(box, cam, w, h, kind)                    -> true when no camera move is needed
//   AtriumSplitFollow.cameraFor(box, w, h, cam, kind)                 -> camera with margin and minimum view span
//   AtriumSplitFollow.glide(pane, box, {kind, level, force})          -> "moved" | "jumped" | "in-view" | null
globalThis.AtriumSplitFollow = (() => {
  const G = globalThis;
  const X = () => G.AtriumCrossProbe, N = () => G.AtriumNavCommon, M = () => G.AtriumMotion;
  const KEY = "atrium-split-follow-v1", HINT = "atrium-split-follow-hint-v1";
  const DEBOUNCE = 140;
  // Smallest world span (mm) a Follow camera shows on the canvas's shorter side: one 0402 never fills the pane.
  const MIN_SPAN = {pcb: 12, schematic: 60};
  const MARGIN = .3;           // fraction of the pane left around a fitted target
  const COMFORT = .08;         // a target inside this inset counts as in view
  const MIN_PX = 14;           // ... unless it is drawn smaller than this
  const base = l => String(l || "").split("@")[0];
  const upper = s => String(s || "").trim().toUpperCase();
  const otherKind = k => k === "pcb" ? "schematic" : "pcb";
  const paired = (a, b) => !!a && !!b && a !== b && (a === "pcb" || a === "schematic") && (b === "pcb" || b === "schematic");

  // ---------------------------------------------------------------- counterpart (pure)
  function partKeys(doc, ids) {
    const want = ids ? new Set(ids) : null, links = new Set(), refs = new Set();
    for (const i of doc.items) {
      if (i.kind !== "part" || (want && !want.has(i.id))) continue;
      if (i.link) links.add(base(i.link));
      if (i.ref && !/[?*]/.test(i.ref)) refs.add(upper(i.ref));
    }
    return {links, refs};
  }
  function score(doc, keys) {
    let n = 0;
    for (const i of doc.items) if (i.kind === "part" && (i.link && keys.links.has(base(i.link)) || i.ref && keys.refs.has(upper(i.ref)))) n++;
    return n;
  }
  function counterpartFor(project, defs, docId, ids = []) {
    const from = project?.documents?.find(d => d.id === docId);
    if (!from) return null;
    const kind = otherKind(from.kind), docs = project.documents.filter(d => d.kind === kind);
    if (!docs.length) return null;
    if (docs.length === 1) return docs[0].id;
    // 1. The document holding the selected parts (most matches wins).
    const sel = ids?.length ? partKeys(from, ids) : null;
    if (sel && (sel.links.size || sel.refs.size)) {
      let best = null, bestN = 0;
      for (const d of docs) {const n = score(d, sel); if (n > bestN) {best = d; bestN = n;}}
      if (best) return best.id;
    }
    // 2. A selected wire, track or net: the first document carrying that net.
    const XP = X();
    if (XP && ids?.length) {
      const set = new Set(ids);
      for (const i of from.items) {
        if (!set.has(i.id) || i.kind === "part") continue;
        const net = XP.netOf(from, defs, i);
        if (net) for (const d of docs) if (XP.netObjects(d, defs, net).box) return d.id;
      }
    }
    // 3. A schematic's board: the one with most of the sheet's parts; a board's sheet: the first schematic.
    if (kind === "pcb") {
      const all = partKeys(from, null);
      let best = null, bestN = 0;
      for (const d of docs) {const n = score(d, all); if (n > bestN) {best = d; bestN = n;}}
      if (best) return best.id;
      return (G.Atrium?.preferredDocument?.(project, "pcb", null) || docs[0]).id;
    }
    return docs[0].id;
  }

  // ---------------------------------------------------------------- follow target (pure)
  // What the other document shows for a selection in `fromId`: matching parts (link, then designator),
  // a clicked pin's pad, or the copper / wires of the selected nets; else the highlighted net.
  function followTarget(project, defs, fromId, ids, {toId = null, point = null, highlight = ""} = {}) {
    const XP = X(), C = N();
    const from = project?.documents?.find(d => d.id === fromId);
    if (!from || !XP || !C) return null;
    const kind = otherKind(from.kind);
    let docs = project.documents.filter(d => d.kind === kind);
    const pref = docs.find(d => d.id === toId);
    if (pref) docs = [pref, ...docs.filter(d => d !== pref)];
    if (!docs.length) return null;
    const items = ids?.length ? from.items.filter(i => ids.includes(i.id)) : [];
    // A single part clicked on a pin: that pin in the other document.
    if (items.length === 1 && items[0].kind === "part" && point) {
      const t = XP.targetAt(from, defs, items[0], point);
      if (t?.kind === "pin") {
        const res = XP.resolve(project, defs, fromId, t);
        if (res) {
          const inPref = pref && docOf(pref, res.ids);
          const r = inPref ? {...res, docId: pref.id} : res;
          return {docId: r.docId, ids: r.ids, box: r.box, label: r.label, kind: "pin", net: r.net || ""};
        }
      }
    }
    if (items.length) {
      for (const d of docs) {
        const got = XP.mirror(project, defs, fromId, ids, d.id);
        if (!got.length) continue;
        const want = new Set(got);
        let box = null, n = 0;
        for (const i of d.items) if (want.has(i.id)) {box = C.union(box, objectBox(d, defs, i)); n++;}
        if (!box) continue;
        const parts = items.filter(i => i.kind === "part");
        const label = parts.length === 1 && items.length === 1 ? parts[0].ref || "component"
          : parts.length ? parts.length + " part" + (parts.length === 1 ? "" : "s") : items.length + " object" + (items.length === 1 ? "" : "s");
        return {docId: d.id, ids: got, box, label, kind: parts.length ? "part" : "net"};
      }
    }
    if (highlight) {
      for (const d of docs) {
        const found = XP.netObjects(d, defs, highlight);
        if (found.box) return {docId: d.id, ids: found.ids, box: found.box, label: "net " + highlight, kind: "net", net: highlight};
      }
    }
    return null;
  }
  // A part's box with its pins and pads (itemBox alone is the body outline).
  function objectBox(d, defs, i) {
    let box = N().itemBox(d, defs, i);
    if (i.kind !== "part") return box;
    try {
      for (const p of G.Atrium.pins(i, defs.get(i.def), d.kind)) {
        if (!p?.at) continue;
        const r = d.kind === "pcb" ? Math.max(p.w || 0, p.h || 0, p.diameter || 0, .4) / 2 : .5;
        box = N().union(box, [p.at[0] - r, p.at[1] - r, p.at[0] + r, p.at[1] + r]);
      }
    } catch {}
    return box;
  }
  const docOf = (d, ids) => ids.every(id => d.items.some(i => i.id === id));

  // ---------------------------------------------------------------- camera (pure)
  function span(cam, w, h) {return [w / cam.scale, h / cam.scale];}
  function inView(box, cam, w, h, kind = "pcb") {
    if (!box || !cam || !(cam.scale > 0)) return false;
    const [sw, sh] = span(cam, w, h), ix = sw * COMFORT, iy = sh * COMFORT;
    const l = cam.cx - sw / 2 + ix, r = cam.cx + sw / 2 - ix, t = cam.cy - sh / 2 + iy, b = cam.cy + sh / 2 - iy;
    if (box[0] < l || box[2] > r || box[1] < t || box[3] > b) return false;
    // In view but drawn tiny (zoomed far out on a big board): worth a zoom, unless that is as close as Follow goes.
    const px = Math.max(box[2] - box[0], box[3] - box[1]) * cam.scale;
    if (px >= MIN_PX) return true;
    const want = cameraFor(box, w, h, cam, kind);
    return want.scale <= cam.scale * 1.05;
  }
  function cameraFor(box, w, h, cam, kind = "pcb") {
    const C = N(), minSpan = MIN_SPAN[kind] ?? MIN_SPAN.pcb;
    const base = C ? C.cameraFor(box, w, h, cam, {margin: MARGIN}) : {cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, scale: cam?.scale || 8};
    const maxScale = Math.min(w, h) / minSpan;
    const scale = Math.max(1e-6, Math.min(base.scale, maxScale));
    // Keep everything the camera carries (referenceScale, a flipped board).
    return {...(cam || {}), cx: base.cx, cy: base.cy, scale};
  }

  // ---------------------------------------------------------------- glide (animated camera)
  const flights = new Map();   // pane view -> running flight
  const samePane = (a, b) => a.view === b.view && a.docId === b.docId && a.active === b.active;
  const ownsPane = pane => host?.ownsPane?.(pane) ?? panes().some(p => samePane(p, pane));
  function level(o) {return o?.level || M()?.level?.() || "full";}
  // Ease the pane's camera onto box. The pane is {view, canvas}; repaint(view) asks for a frame.
  function glide(pane, box, {kind = "pcb", force = false, repaint = null, done = null, level: lv = null} = {}) {
    const view = pane?.view;
    if (!view || !box) return null;
    const current = () => !host || pane.docId == null || ownsPane(pane);
    if (!current()) return null;
    const w = pane.canvas?.clientWidth || 800, h = pane.canvas?.clientHeight || 600;
    const from = view.camera();
    cancelGlide(view);
    if (!force && inView(box, from, w, h, kind)) {done?.("in-view"); return "in-view";}
    const to = cameraFor(box, w, h, from, kind), L = level({level: lv});
    const paint = () => {try {if (repaint) repaint(view); else host?.repaintPane?.(pane);} catch (e) {G.console?.error?.(e);}};
    const Mo = M(), camera = G.AtriumCamera;
    camera?.takeCamera?.(view);
    if (L !== "full" || !Mo?.animate || typeof G.requestAnimationFrame !== "function" || lv == null && camera?.animate() === false) {
      view.restoreCamera(to); paint(); done?.("jumped"); return "jumped";
    }
    const lf = Math.log(from.scale), lt = Math.log(to.scale);
    const ms = camera?.flightMs(from,to,pane.canvas) ?? Mo.duration("base");
    const flight = {pane, handle:null};
    flight.handle = Mo.animate({ms, ease: "standard", camera:true, step(e) {
      if (!current()) {cancelGlide(view); return;}
      const cam = {...to, cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e, scale: Math.exp(lf + (lt - lf) * e)};
      view.restoreCamera(cam);
      if (e < 1) view.moving?.(); else view.settle?.();
      paint();
    }, done() {if (flights.get(view) === flight) flights.delete(view); if (current()) done?.("moved");}});
    if (flight.handle?.running) flights.set(view,flight);
    return "moved";
  }
  function cancelGlide(view) {const f = flights.get(view); if (f) {f.handle.cancel(); flights.delete(view); view.settle?.();}}

  // ---------------------------------------------------------------- state
  let host = null, follow = true, timer = 0, pending = null, lastClick = null, down = false, deferred = false, lastKey = "";
  try {const v = G.sessionStorage?.getItem(KEY); if (v === "0") follow = false;} catch {}
  function setFollow(on, quiet = false) {
    follow = !!on;
    try {G.sessionStorage?.setItem(KEY, follow ? "1" : "0");} catch {}
    sync();
    if (follow) {lastKey = ""; schedule(0);}
    else cancelFollow();
    if (!quiet) host?.info(follow ? "Follow on: a click on a part, pin or net shows it in the other pane." : "Follow off: the other pane keeps its view.");
  }
  function panes() {return host?.panes?.() || [];}
  function pair() {
    const ps = panes(); if (ps.length < 2) return null;
    const active = ps.find(p => p.active), other = ps.find(p => !p.active);
    const a = host.docById(active?.docId), b = host.docById(other?.docId);
    return a && b && paired(a.kind, b.kind) ? {active, other, a, b} : null;
  }
  const enabled = () => follow && !!pair();

  // ---------------------------------------------------------------- the follow itself
  const keyboardInput = () => G.document?.documentElement?.dataset?.motionInput === "keyboard";
  function intent() {
    const P = pair();
    return P && {active:P.active, other:P.other, keyboard:keyboardInput()};
  }
  function cancelFollow() {
    clearTimeout(timer);
    timer = 0; pending = null; deferred = false;
  }
  function schedule(ms = DEBOUNCE, request = intent()) {
    cancelFollow();
    if (!request) return;
    pending = request;
    timer = setTimeout(run, ms);
  }
  function run() {
    const request = pending || intent();
    cancelFollow();
    const P = request && follow && pair();
    if (!P || !samePane(P.active, request.active) || !samePane(P.other, request.other)) return;
    if (down || host.drag?.()) {pending = request; deferred = true; return;}   // finish after the drag / box select
    const ids = host.selection(), {keyboard} = request;
    // A fresh click on the active canvas picks the pin under the pointer.
    let point = null;
    if (!keyboard && lastClick && lastClick.canvas === P.active.canvas && Date.now() - lastClick.at < 1500) {
      const hit = host.hit(lastClick.canvas, lastClick.x, lastClick.y);
      if (hit?.item && ids.includes(hit.item.id)) point = hit.point;
    }
    const fresh = !keyboard && !!lastClick && Date.now() - lastClick.at < 1500;
    lastClick = null;
    const hl = ids.length ? "" : host.highlight?.() || "";
    if (!ids.length && !hl) {lastKey = ""; return;}
    const t = followTarget(host.project(), host.defs(), P.a.id, ids, {toId: P.b.id, point, highlight: hl});
    if (!t) {lastKey = ""; return;}
    const key = t.docId + "|" + t.ids.join(",") + "|" + (point ? t.label : "");
    if (key === lastKey && !fresh) return;
    lastKey = key;
    go(t, keyboard);
  }
  function go(t, keyboard) {
    if (!host.showInOther(t.docId)) return false;
    const other = panes().find(p => !p.active);
    if (!other) return false;
    const kind = host.docById(t.docId)?.kind || "pcb";
    glide(other, t.box, {kind, level:keyboard ? "off" : null, done: how => {if (!keyboard) pulse(other, t.box, how);}});
    return true;
  }

  // ---------------------------------------------------------------- pulse (DOM ring over the pane; no canvas redraw)
  let ring = null;
  function clearPulse() {
    ring?.timer?.cancel(); ring?.node.remove(); ring = null;
  }
  function pulse(pane, box, how) {
    const D = G.document, motion = M(), L = level();
    if (!D?.createElement || !motion?.afterVisible || L === "off" || !pane?.canvas?.parentElement) return;
    const stage = pane.canvas.parentElement, view = pane.view;
    const a = view.worldToScreen([box[0], box[1]]), b = view.worldToScreen([box[2], box[3]]);
    const cr = pane.canvas.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const pad = 6, x = Math.min(a[0], b[0]) - pad, y = Math.min(a[1], b[1]) - pad;
    const w = Math.abs(b[0] - a[0]) + 2 * pad, h = Math.abs(b[1] - a[1]) + 2 * pad;
    if (!(w > 0 && h > 0)) return;
    clearPulse();
    const node = D.createElement("div"); node.className = "split-follow-pulse"; node.setAttribute("aria-hidden", "true");
    if (L !== "full") node.classList.add("is-still");
    node.dataset.how = how || "";
    node.style.left = (cr.left - sr.left + x) + "px"; node.style.top = (cr.top - sr.top + y) + "px";
    node.style.width = w + "px"; node.style.height = h + "px";
    stage.append(node);
    const timer = motion.afterVisible(motion.duration("slow") * 3 + 100, clearPulse);
    ring = {pane, node, timer};
  }

  // ---------------------------------------------------------------- split-counterpart
  function counterpart() {
    const d = host.doc(), id = counterpartFor(host.project(), host.defs(), d.id, host.selection());
    if (!id) {host.info("This project has no " + (d.kind === "pcb" ? "schematic" : "board layout") + " to split with."); return false;}
    const ps = panes();
    if (ps.length < 2) {
      if (!host.openSplit) {host.act?.("split-right"); return false;}
      host.openSplit("right", id, {focus: false});
    } else host.showInOther(id);
    const firstTime = !seenHint();
    setFollow(true, true);
    const target = host.docById(id);
    host.info("Split with " + (target?.name || "the counterpart") + " · Follow on");
    if (firstTime) hint(target?.kind);
    sync();
    return true;
  }
  function seenHint() {try {return G.localStorage?.getItem(HINT) === "1";} catch {return true;}}
  function hint(kind) {
    try {G.localStorage?.setItem(HINT, "1");} catch {}
    const where = kind === "pcb" ? "on the board" : "in the schematic";
    N()?.toast?.("Click a part to find it " + where + ". Follow: on (toggle on the pane strip)", {ms: 7000});
  }

  // ---------------------------------------------------------------- UI: the eye on the inactive pane's strip
  const SVG = "http://www.w3.org/2000/svg";
  function eye() {
    const D = G.document, svg = D.createElementNS(SVG, "svg");
    svg.setAttribute("class", "icon"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    const p = D.createElementNS(SVG, "path"); p.setAttribute("d", "M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z");
    const c = D.createElementNS(SVG, "circle"); c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "2.6");
    const s = D.createElementNS(SVG, "path"); s.setAttribute("d", "M4 20 20 4"); s.setAttribute("class", "slash");
    svg.append(p, c, s);
    return svg;
  }
  // split-tabs.js calls this for every strip it renders (k: pane index).
  function decorate(strip, pane) {
    if (!strip || !G.document) return;
    let b = strip.querySelector(".pane-follow");
    const P = pair(), show = !!P && pane && !pane.active;
    if (!show) {if (b) b.hidden = true; return;}
    if (!b) {
      b = G.document.createElement("button"); b.type = "button"; b.className = "pane-follow ui-chrome-action ui-chrome-action-compact"; b.dataset.hover = "bright"; b.dataset.action = "split-follow";
      b.append(eye());
      b.addEventListener("click", e => {e.stopPropagation(); setFollow(!follow); P0()?.canvas?.focus?.();});
      b.addEventListener("pointerdown", e => e.preventDefault());   // the active pane keeps focus
    }
    const close = strip.querySelector(".pane-arrange, .pane-close");
    if (close && b.nextSibling !== close) close.before(b); else if (!close && b.parentElement !== strip) strip.append(b);
    b.hidden = false;
    b.setAttribute("aria-pressed", String(follow));
    const what = P.b.kind === "pcb" ? "board" : "schematic";
    const t = follow ? "Follow on: this " + what + " follows your clicks in the other pane. Click to turn off" : "Follow off: click to make this " + what + " follow your clicks in the other pane";
    b.title = t; b.setAttribute("aria-label", "Follow selection in this pane");
  }
  const P0 = () => panes().find(p => p.active);
  function sync() {
    const D = G.document;
    N()?.setChecked?.("split-follow", follow);
    if (!D?.querySelectorAll) return;
    const ps = panes();
    for (const s of D.querySelectorAll(".pane-tabs")) decorate(s, ps[+s.dataset.pane]);
  }

  function attach(h) {
    if (host) return;
    host = h;
    host.registerAction("split-counterpart", counterpart);
    host.registerAction("split-follow", () => {
      if (!pair()) {
        const key = globalThis.AtriumKeymap?.hintFor?.("split-counterpart", host.doc().kind);
        host.info(follow ? "Follow works in a schematic and board split. " + (key ? key + " opens it." : "Use Window › Split with Schematic or Board.") : "Follow will show clicks in the other pane once a schematic | board split is open.");
        setFollow(!follow, true); return;
      }
      setFollow(!follow);
    });
    host.on("selection", () => {if (enabled()) schedule();});
    host.on("highlight", () => {if (enabled() && host.highlight?.() && !host.selection().length) {lastKey = ""; schedule();}});
    function updatePanes() {
      for (const [view, flight] of flights) if (!ownsPane(flight.pane)) cancelGlide(view);
      if (pending && (!ownsPane(pending.active) || !ownsPane(pending.other))) cancelFollow();
      if (ring && !ownsPane(ring.pane)) clearPulse();
      lastKey = ""; sync();
    }
    host.on("document", updatePanes);
    host.on("panes", updatePanes);
    host.on("replace", () => {
      for (const view of flights.keys()) cancelGlide(view);
      cancelFollow(); clearPulse(); lastClick = null; down = false; lastKey = "";
    });
    sync();
    const D = G.document;
    if (!D?.addEventListener) return;
    const onActive = e => {const p = P0(); return !!p && e.target === p.canvas;};
    D.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !onActive(e)) return;
      down = true; lastClick = {canvas: e.target, x: e.clientX, y: e.clientY, at: Date.now(), moved: false};
    }, true);
    D.addEventListener("pointerup", () => {
      if (!down) return; down = false;
      if (deferred) schedule(DEBOUNCE, pending);
    }, true);
    D.addEventListener("pointercancel", () => {down = false;}, true);
    // Wheel or a drag in the other pane: the user takes the camera; stop any glide in flight.
    D.addEventListener("wheel", e => {const o = panes().find(p => !p.active); if (o && e.target === o.canvas) cancelGlide(o.view);}, {capture: true, passive: true});
    // Ctrl/⌘+double-click is the explicit probe (crossprobe.js): it wins over a pending Follow.
    D.addEventListener("dblclick", e => {if (e.ctrlKey || e.metaKey) cancelFollow();}, true);
    G.AtriumKeymap?.onChange?.(sync);
  }
  N()?.ready?.(attach);

  return Object.freeze({counterpartFor, followTarget, inView, cameraFor, glide, cancelGlide, decorate, sync, attach,
    setFollow, follow: () => follow, enabled, counterpart, MIN_SPAN,
    _run: run, _state: () => ({timer, lastKey, deferred, down})});
})();
