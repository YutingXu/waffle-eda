"use strict";

// Incoming edits have already won in the model. Only the display of a handful
// of edited items is delayed, on a transparent surface belonging to each pane.
globalThis.AtriumCollabObjectMotion = (() => {
  const MAX_ITEMS = 32, MAX_POINTS = 2048;
  const level = () => globalThis.AtriumPower?.idle?.() ? "off" : globalThis.AtriumMotion?.level?.() ??
    (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "reduced" : "full");
  const duration = (name, fallback) => globalThis.AtriumMotion?.duration?.(name) ?? fallback;
  const in2D = pane => !globalThis.Atrium3D?.isOpen?.(pane.canvas.parentElement);
  const finitePair = p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]);

  // A stretch or a reroute must show its new shape immediately. A translated
  // polyline has the same offset at every vertex, just like a moved component.
  function offset(from, to) {
    if (!from || !to || from.kind !== to.kind) return null;
    if (!from.points && !to.points) {
      const delta = [from.x - to.x, from.y - to.y];
      return finitePair(delta) ? delta : null;
    }
    const a = from.points, b = to.points;
    if (!a?.length || a.length !== b?.length || a.length > MAX_POINTS || !finitePair(a[0]) || !finitePair(b[0])) return null;
    const x = a[0][0] - b[0][0], y = a[0][1] - b[0][1];
    for (let i = 1; i < a.length; i++) {
      if (!finitePair(a[i]) || !finitePair(b[i]) || Math.abs(a[i][0] - b[i][0] - x) > 1e-7 || Math.abs(a[i][1] - b[i][1] - y) > 1e-7) return null;
    }
    return [x, y];
  }
  function pose(entry, now) {
    const t = entry.start === null ? 0 : Math.min(1, Math.max(0, (now - entry.start) / entry.duration));
    const remaining = (1 - t) ** 2, alpha = entry.after ? 1 - (1 - entry.alpha) * remaining : entry.alpha * remaining;
    return {x: entry.after ? entry.x * remaining : entry.x, y: entry.after ? entry.y * remaining : entry.y, alpha, done: t === 1};
  }

  // One detached appearance painted with the pane's current camera, layers and normal shape
  // painters (canvas.js internals). Its pixels have no hit targets.
  const hopCache = new WeakMap();
  function paintItem(view, g, doc, item, defs, dx, dy, opacity, wireHops) {
    const I = view.internals?.(), last = I?.frame();
    if (!I || last?.[0] !== doc || opacity <= 0) return;
    const opts = last[2], pcb = doc.kind === "pcb";
    if (opts.routePreview?.hidden?.includes(item.id) || (!pcb && item.kind !== "part" && opts.hidden?.has(item.layer || ""))) return;
    const [, , scale, flipped, , , dpr] = I.cam(), [x, y] = I.worldToScreen([dx, dy]);
    const ink = {...opts, flipped, hide: null};
    if (wireHops !== undefined) ink.wireHops = wireHops;
    else if (item.kind === "wire" && doc.hopOvers && globalThis.AtriumSchObjects) {
      // The board frame already settled the crossings. A moving wire reuses them
      // without hashing every other wire once per animation frame.
      if (!hopCache.has(last)) hopCache.set(last, globalThis.AtriumSchObjects.hops(doc));
      ink.wireHops = hopCache.get(last);
    }
    g.save();
    try {
      g.setTransform((flipped ? -scale : scale) * dpr, 0, 0, scale * dpr, x * dpr, y * dpr);
      g.lineJoin = "round"; g.lineCap = "round"; g.globalAlpha = opacity;
      if (pcb) I.drawBoard(g, [item], doc, defs, scale, ink, null, null, null);
      else I.drawItem(g, item, doc, defs, scale, ink, false);
    } finally { g.restore(); }
  }

  function create(host) {
    const selected = id => host.selection?.().includes(id);
    const documents = new Map(), layers = new Map();
    let frame = 0;
    function redraw(group) {
      if (!group.pending) { group.pending = true; host.invalidateDocument(group.id); }
    }
    function cancel(docId, id) {
      const group = documents.get(docId), entry = group?.items.get(id);
      if (entry) { entry.finished = true; redraw(group); }
    }
    function change(docId, before, after, oldDefs) {
      const item = after || before, id = item?.id, doc = host.docById(docId);
      if (!id || !doc || (doc.kind !== "pcb" && doc.kind !== "schematic")) return;
      let group = documents.get(docId);
      const prior = group?.items.get(id), mode = level();
      if (mode === "off" || before?.points?.length > MAX_POINTS || after?.points?.length > MAX_POINTS ||
          !host.panes().some(p => p.docId === docId && in2D(p))) return cancel(docId, id);
      if (docId === host.currentId() && selected(id)) return cancel(docId, id);
      const delta = before && after ? offset(before, after) : null;
      if (before && after && !delta) return cancel(docId, id);
      if (delta && !prior && (mode !== "full" || (!delta[0] && !delta[1]))) return;
      if (!group) { group = {id: docId, items: new Map(), pending: false}; documents.set(docId, group); }
      if (!prior && group.items.size >= MAX_ITEMS) return;
      const current = prior && pose(prior, performance.now());
      const shape = after || prior?.item || before;
      const relative = prior && after ? offset(prior.item, after) : delta;
      let x = (current?.x || 0) + (relative?.[0] || 0), y = (current?.y || 0) + (relative?.[1] || 0);
      if (mode !== "full") x = y = 0;
      const alpha = current ? current.alpha : before ? 1 : 0;
      if (after && !x && !y && alpha === 1) return cancel(docId, id);
      const oldHops = !after && shape.kind === "wire" && doc.hopOvers ? globalThis.AtriumSchObjects?.hops(doc) : undefined;
      group.items.set(id, {item: shape, after, oldHops, oldDefs: after ? null : prior?.oldDefs || oldDefs,
        x, y, alpha, start: null, duration: after && (x || y) ? duration("base", 200) : duration("fast", 140), finished: false});
      redraw(group);
    }
    // The editor calls this while preparing its ordinary canvas frame. Restore
    // finished objects in that frame; the frame listener then removes their ink.
    // opts.hide holds the live objects (both renderers leave them out); a frame whose
    // set changed is painted afresh, never reprojected from the previous pixels.
    function renderOptions(doc) {
      const group = documents.get(doc.id);
      if (!group) return null;
      group.pending = false;
      for (const [id, entry] of group.items) if (entry.finished) group.items.delete(id);
      const hide = new Set();
      if (group.items.size) for (const item of doc.items) if (group.items.has(item.id)) hide.add(item);
      const key = [...group.items.keys()].join("\n"), changed = key !== group.shown;
      group.shown = key;
      if (!group.items.size) documents.delete(doc.id);
      return hide.size || changed ? {hide: hide.size ? hide : null, noReuse: changed} : null;
    }
    function surface(canvas) {
      let layer = layers.get(canvas);
      if (!layer) {
        const el = document.createElement("canvas");
        el.className = "collab-object-motion"; el.setAttribute("aria-hidden", "true");
        canvas.after(el);
        layer = {el, ctx: el.getContext("2d")}; layers.set(canvas, layer);
      }
      if (layer.el.width !== canvas.width) layer.el.width = canvas.width;
      if (layer.el.height !== canvas.height) layer.el.height = canvas.height;
      layer.ctx.clearRect(0, 0, layer.el.width, layer.el.height);
      return layer.ctx;
    }
    function draw() {
      frame = 0;
      if (!documents.size && !layers.size) return;
      // Editor frames may finish long after their rAF timestamp. Use the same
      // monotonic clock for those paints, autonomous frames and retargeting.
      const now = performance.now();
      const panes = host.panes().filter(in2D), seen = new Set(), mode = level();
      let running = false;
      for (const [docId, group] of documents) {
        const views = panes.filter(p => p.docId === docId), doc = host.docById(docId);
        if (!views.length || !doc) { documents.delete(docId); continue; }
        for (const p of views) seen.add(p.canvas);
        if (group.pending) continue;
        const painted = [], defs = host.defs();
        for (const entry of group.items.values()) {
          entry.start ??= now;
          const pos = pose(entry, now);
          if (mode === "off" || mode !== "full" && entry.after && (entry.x || entry.y)) pos.done = true;
          if (pos.done) {
            entry.finished = true; redraw(group);
            if (entry.after) painted.push({entry, x: 0, y: 0, alpha: 1});
          } else {
            running = true;
            if (pos.alpha > 0) painted.push({entry, ...pos});
          }
        }
        for (const p of views) {
          const g = surface(p.canvas);
          for (const {entry, x, y, alpha} of painted) paintItem(p.view, g, doc, entry.item, entry.oldDefs || defs, x, y, alpha, entry.oldHops);
        }
      }
      for (const [canvas, layer] of layers) if (!seen.has(canvas)) { layer.el.remove(); layers.delete(canvas); }
      if (running) frame = requestAnimationFrame(draw);
    }
    function localChange() {
      for (const [docId, group] of documents) {
        const doc = host.docById(docId);
        if (!doc) continue;
        // The document changed locally. Check only the active appearances, once
        // per edit, so a local properties change or deletion is visible at once.
        const actual = new Map();
        for (const item of doc.items) if (group.items.has(item.id)) actual.set(item.id, item);
        const canon = globalThis.AtriumCollabCRDT?.canon || JSON.stringify;
        for (const [id, entry] of group.items) if (canon(actual.get(id) ?? null) !== canon(entry.after ?? null)) {
          entry.finished = true; redraw(group);
        }
      }
    }
    const detach = [
      host.addRenderer(renderOptions),
      host.on("frame", () => { if (frame) cancelAnimationFrame(frame); draw(); }),
      host.on("selection", () => {
        const group = documents.get(host.currentId());
        if (!group) return;
        for (const [id, entry] of group.items) if (selected(id)) {
          entry.finished = true; redraw(group);
        }
      })
    ];
    const offPower = globalThis.AtriumPower?.onChange?.(() => { if (globalThis.AtriumPower.idle()) clear(); });
    if (offPower) detach.push(offPower);
    function clear() {
      cancelAnimationFrame(frame); frame = 0;
      const ids = [...documents.keys()]; documents.clear();
      for (const layer of layers.values()) layer.el.remove();
      layers.clear();
      for (const id of ids) host.invalidateDocument(id);
    }
    function stop() { for (const off of detach) off(); clear(); }
    return {change, cancel, localChange, clear, stop};
  }
  return Object.freeze({create, limits: Object.freeze({items: MAX_ITEMS, points: MAX_POINTS})});
})();
