"use strict";
// AtriumMinimap: an overview of the active document with the visible area as a rectangle (View ›
// Minimap; lazy). Click or drag on it to move the view there.
//
// Cheap by construction: the overview is a simplified drawing (board outline, tracks and wires as
// lines, pads, vias and parts as dots in their layer colours). Retain its bitmap and patch only
// confirmed model damage at idle. Camera moves only redraw the rectangle over that bitmap.
globalThis.AtriumMinimap = (() => {
  const W = 220, H = 150, PAD = 6;
  const EMPTY_LAYERS = new Set();
  const host = () => globalThis.AtriumNavHost;
  let box = null, base = null, over = null, scratch = null, cache = null, baseJob = null, frame = 0, lastRect = "", dragging = false, appearance = 0;

  const token = name => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null; } catch { return null; } };
  // The theme colours a sheet's bitmap reads. A board's come from AtriumPCBAppearance, which has its own event.
  const sheetTokens = () => token("--canvas-bg") + "|" + token("--muted");

  const union = (a,b) => !a ? b : !b ? a : [Math.min(a[0],b[0]), Math.min(a[1],b[1]), Math.max(a[2],b[2]), Math.max(a[3],b[3])];
  const sameBounds = (a,b) => a===b || !!a && !!b && a.every((v,n) => v===b[n]);
  const rawBounds = i => i.points?.length ? Atrium.bounds(i.points) : Number.isFinite(i.x) && Number.isFinite(i.y) ? [i.x,i.y,i.x,i.y] : null;
  const itemsBounds = d => d.items.reduce((b,i) => union(b,rawBounds(i)), null);
  function fixedBounds(d) {
    if (d.kind === "pcb" && d.outline?.length >= 3) return Atrium.bounds(d.outline);
    if (d.kind === "schematic") {
      const S=globalThis.AtriumSchAppearance, h=host(), defs=h?.defs?.();
      if(S?.isInfinite?.(d) && h?.doc?.()===d && h.view?.()?.drawingBounds)return h.view().drawingBounds(d,defs);
      return S?.pageBounds?.(d,defs) || null;
    }
    return null;
  }
  function paddedBounds(b) {
    b = b || [0, 0, 100, 80];
    const w = Math.max(1, b[2] - b[0]), h = Math.max(1, b[3] - b[1]), m = .04 * Math.max(w, h);
    return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
  }
  const bounds = d => paddedBounds(fixedBounds(d) || itemsBounds(d));
  function transform(b) {
    const k = Math.min((W - 2 * PAD) / (b[2] - b[0]), (H - 2 * PAD) / (b[3] - b[1]));
    const ox = (W - (b[2] - b[0]) * k) / 2 - b[0] * k, oy = (H - (b[3] - b[1]) * k) / 2 - b[1] * k;
    return {k, ox, oy, to: p => [ox + p[0] * k, oy + p[1] * k], from: q => [(q[0] - ox) / k, (q[1] - oy) / k]};
  }
  const mapping = d => transform(bounds(d));
  const ratio = () => Math.min(2, globalThis.devicePixelRatio || 1);
  const visible = () => box?.isConnected && !box.hidden && !document.hidden && globalThis.AtriumPower?.visible?.() !== false;
  function sameLayers(a,b) {
    if (a.size!==b.size) return false;
    for (const layer of a) if (!b.has(layer)) return false;
    return true;
  }
  const shownItem = (i,pcb,hidden) => !(pcb && i.layer && hidden.has(i.layer));
  const lineItem = i => i.points?.length > 1 && (i.kind === "track" || i.kind === "wire" || i.kind === "graphic");
  const lineWidth = (i,m) => Math.max(.6, (i.width || .2) * m.k);
  const dotSize = i => i.kind === "part" ? 2.2 : 1.4;
  function background(ctx, d, m, dpr, pcb) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = pcb ? pcb.system.workspace : token("--canvas-bg") || "#202020"; ctx.fillRect(0, 0, W, H);
    if (pcb && d.outline?.length >= 3) {
      ctx.beginPath(); d.outline.forEach((p, n) => { const q = m.to(p); n ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath();
      ctx.fillStyle = pcb.system.board; ctx.fill(); ctx.strokeStyle = pcb.system.edge; ctx.lineWidth = 1; ctx.stroke();
    }
  }
  function paintItems(ctx, items, m, pcb, hidden) {
    const muted = pcb ? null : token("--muted") || "#9a9a9a";
    const ink = pcb ? l => pcb.color(l || "Top") : () => muted;
    const alpha = pcb ? l => pcb.layerAlpha?.(l) ?? 1 : () => 1;
    ctx.lineCap = "round";
    for (const i of items) {
      if (!shownItem(i,pcb,hidden)) continue;
      if (globalThis.AtriumSchObjects?.isFrame(i)) {
        const q=m.to([i.x,i.y]);ctx.globalAlpha=1;ctx.strokeStyle=muted;ctx.lineWidth=1;
        ctx.strokeRect(q[0],q[1],i.w*m.k,i.h*m.k);
      } else if (lineItem(i)) {
        ctx.globalAlpha = .9 * alpha(i.layer); ctx.strokeStyle = ink(i.layer); ctx.lineWidth = lineWidth(i,m);
        ctx.beginPath(); i.points.forEach((p, n) => { const q = m.to(p); n ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke();
      } else if (Number.isFinite(i.x) && Number.isFinite(i.y)) {
        const q = m.to([i.x, i.y]), s = dotSize(i);
        ctx.globalAlpha = .85 * alpha(i.layer); ctx.fillStyle = ink(i.kind === "via" ? "Multi" : i.layer);
        ctx.fillRect(q[0] - s / 2, q[1] - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
  }
  function entry(i, m, pcb, hidden, fixed, order) {
    const line = lineItem(i), raw = !fixed || line ? rawBounds(i) : null;
    const e = {item:i, order, raw, paint:null, stamp:null};
    if (!shownItem(i,pcb,hidden)) return e;
    let paint, pad;
    if (globalThis.AtriumSchObjects?.isFrame(i)) {
      paint=AtriumSchObjects.frameBounds(i);e.stamp=["frame",...paint];pad=1.5;
    } else if (line && raw) {
      const width = lineWidth(i,m);
      e.stamp = [pcb ? i.layer : null, width];
      for (const [x,y] of i.points) e.stamp.push(x,y);
      paint = raw;
      // The default miter limit allows a corner up to five stroke widths from its vertex.
      pad = 5 * width + 1;
    } else if (Number.isFinite(i.x) && Number.isFinite(i.y)) {
      const size = dotSize(i);
      e.stamp = [pcb ? i.layer : null, !!pcb && i.kind === "via", i.x, i.y, size];
      paint = [i.x,i.y,i.x,i.y];
      pad = size / 2 + 1;
    }
    if (paint) e.paint = [m.ox + paint[0]*m.k-pad,m.oy + paint[1]*m.k-pad,m.ox + paint[2]*m.k+pad,m.oy + paint[3]*m.k+pad];
    return e;
  }
  function fullPaint(d, pcb, hidden, dpr, fixed, outline, journal) {
    const raw = fixed || itemsBounds(d), m = transform(paddedBounds(raw)), entries = new Map();
    base.width = W*dpr; base.height = H*dpr;
    const ctx = base.getContext("2d");
    background(ctx,d,m,dpr,pcb); paintItems(ctx,d.items,m,pcb,hidden);
    if (journal && globalThis.AtriumSpatial) d.items.forEach((i,n) => entries.set(i.id,entry(i,m,pcb,hidden,fixed,n)));
    const canPatch=!!journal && entries.size===d.items.length && !entries.has(undefined) && !!globalThis.AtriumSpatial;
    cache = {doc:d, kind:d.kind, pcb, length:d.items.length, appearance, fixed, raw, outline, m, entries, canPatch, index:null, dpr, hidden:new Set(hidden), journal, tokens:pcb ? null : sheetTokens()};
    lastRect = "";
  }
  function mappingChanged(c, old, next) {
    if (sameBounds(old,next)) return false;
    if (!c.raw) return !!next;
    return !!next && (next[0]<c.raw[0] || next[1]<c.raw[1] || next[2]>c.raw[2] || next[3]>c.raw[3]) ||
      !!old && old.some((v,n) => v===c.raw[n] && next?.[n]!==v);
  }
  const sameStamp = (a,b) => a===b || !!a && !!b && a.length===b.length && a.every((v,n) => v===b[n]);
  function patchItems(c, d, pcb, hidden, changes) {
    if (!c.canPatch || !changes?.ids) return false;
    let damage = null, reorder = c.length!==d.items.length, checkMapping = false, count = c.entries.size;
    const updates = new Map();
    for (const id of changes.ids) {
      const old = c.entries.get(id), i = changes.items.get(id), next = i && entry(i,c.m,pcb,hidden,c.fixed,old?.order);
      if (!old && !next) continue;
      count += Number(!!next) - Number(!!old);
      const moved = !old || !next || d.items[old.order]!==i;
      if (moved || !old?.paint && next?.paint) reorder = true;
      const changed = !sameStamp(old?.stamp,next?.stamp);
      if (moved || changed) damage = union(damage,union(old?.paint,next?.paint));
      if (!c.fixed && mappingChanged(c,old?.raw,next?.raw)) checkMapping = true;
      updates.set(id,{old,next,changed});
    }
    if (count!==d.items.length || checkMapping && !sameBounds(itemsBounds(d),c.raw)) return false;
    if (reorder) {
      let last = -1;
      for (const i of d.items) {
        const e = updates.has(i.id) ? updates.get(i.id).next : c.entries.get(i.id);
        if (!e || e.item!==i || !updates.has(i.id) && e.order<=last) return false;
        if (!updates.has(i.id)) last = e.order;
      }
    }
    for (const [id,{old,next,changed}] of updates) {
      if (old && (!next?.paint || old.item!==next.item)) c.index?.remove(old.item);
      if (next) {
        c.entries.set(id,next);
        if (old?.paint && next.paint && old.item===next.item && changed) c.index?.update(next.item);
      } else c.entries.delete(id);
    }
    if (reorder) {
      d.items.forEach((i,n) => { c.entries.get(i.id).order = n; });
      c.index?.reorder(d.items);
    }
    c.length=d.items.length;
    if (!damage) return true;
    return paintDamage(c,d,pcb,hidden,damage);
  }
  function paintDamage(c,d,pcb,hidden,damage) {
    const {dpr,m} = c, [x,y,r,b] = [Math.max(0,Math.floor(damage[0]*dpr)),Math.max(0,Math.floor(damage[1]*dpr)),
      Math.min(base.width,Math.ceil(damage[2]*dpr)),Math.min(base.height,Math.ceil(damage[3]*dpr))];
    if (r<=x || b<=y) return true;
    if ((r-x)*(b-y)>base.width*base.height*.5) return false;
    // Camera-only use never builds the spatial index. The first actual visible edit needs it.
    c.index ||= AtriumSpatial.create(d.items,i => c.entries.get(i.id)?.paint,8);
    const items = c.index.query([x/dpr,y/dpr,r/dpr,b/dpr]);
    scratch ||= AtriumNavCommon.el("canvas");
    if (scratch.width!==base.width) scratch.width=base.width;
    if (scratch.height!==base.height) scratch.height=base.height;
    const ctx = scratch.getContext("2d"), target = base.getContext("2d");
    // Rasterize with the same canvas extent as a full draw. Clipping a crossing stroke at
    // the dirty edge changes antialiasing on some engines, even where the canvas is opaque.
    background(ctx,d,m,dpr,pcb); paintItems(ctx,items,m,pcb,hidden);
    target.setTransform(1,0,0,1,0,0); target.clearRect(x,y,r-x,b-y);
    target.drawImage(scratch,x,y,r-x,b-y,x,y,r-x,b-y);
    return true;
  }
  const covered = (old, journal) => !!old && !!journal && old.seq>=journal.floor && old.seq<=journal.seq;
  const sameDisplay = (c, hidden, dpr) => c.appearance===appearance && c.dpr===dpr && sameLayers(c.hidden,hidden);
  function paintBase() {
    const Hs = host(), d = Hs?.doc?.(); if (!visible() || !d) return;
    const dpr = ratio(), pcb = d.kind === "pcb" && globalThis.AtriumPCBAppearance, hidden = Hs.hiddenLayers?.() || EMPTY_LAYERS;
    const store = globalThis.AtriumUndoStore, journal = store?.documentVersions?.(d,Hs.project?.());
    const c = cache, sameDoc = c?.doc===d && c.kind===d.kind && c.pcb===pcb;
    const known = sameDoc && covered(c.journal,journal);
    const sameOuter = known && c.journal.outer===journal.outer;
    const infinite=globalThis.AtriumSchAppearance?.isInfinite?.(d);
    const fixed = sameOuter && !infinite ? c.fixed : fixedBounds(d);
    const outline = sameOuter ? c.outline : pcb && d.outline?.length>=3 ? JSON.stringify(d.outline) : null;
    const sameBase = known && sameDisplay(c,hidden,dpr) && c.outline===outline && sameBounds(c.fixed,fixed);
    const sameItems = sameBase && c.journal.items===journal.items && c.length===d.items.length;
    if (sameItems || sameBase && patchItems(c,d,pcb,hidden,store.recordedChanges(d,c.journal.seq))) {
      c.journal = journal;
    } else {
      fullPaint(d,pcb,hidden,dpr,fixed,outline,journal);
    }
    requestOverlay();
  }
  function cancelBase() { baseJob?.cancel?.(); baseJob=null; }
  function cancelPaint() {
    cancelBase();
    if (frame) { globalThis.cancelAnimationFrame?.(frame); frame=0; }
  }
  function schedule() {
    if (!visible() || baseJob) return;
    /** @type {{ cancel?: () => void }} */
    const job = {};
    baseJob = job;
    const run = () => { if (baseJob===job) { baseJob=null; paintBase(); } };
    const idle = globalThis.AtriumIdle;
    if (idle) {
      const id=idle.idle(run,{timeout:1500}); job.cancel=() => idle.cancel(id);
    } else if (typeof requestIdleCallback === "function") {
      const id=requestIdleCallback(run,{timeout:1500}); job.cancel=() => globalThis.cancelIdleCallback?.(id);
    } else {
      const id=setTimeout(run,300); job.cancel=() => clearTimeout(id);
    }
  }
  // Certify small edits against the projections already on screen. Larger edits
  // and previews still prepare their base layers at idle.
  function reuseBaseAfterEdit() {
    const Hs=host(),d=Hs?.doc?.(),c=cache;
    if (!d || c?.doc!==d || c.kind!==d.kind || c.length!==d.items.length || dragging || Hs.drag?.() ||
        globalThis.AtriumSchAppearance?.isInfinite?.(d)) return false;
    const pcb=d.kind==="pcb" && globalThis.AtriumPCBAppearance, hidden=Hs.hiddenLayers?.() || EMPTY_LAYERS;
    if (c.pcb!==pcb || !sameDisplay(c,hidden,ratio())) return false;
    const store=globalThis.AtriumUndoStore, journal=store?.documentVersions?.(d,Hs.project?.());
    if (!covered(c.journal,journal) || c.journal.outer!==journal.outer) return false;
    if (c.journal.items!==journal.items) {
      // Bound synchronous work on the edit path, including interleaved records
      // from other documents. Additions, deletions and reorderings go to idle.
      const limit=8;
      if (!c.canPatch || journal.seq-c.journal.seq>limit) return false;
      const changes=store.recordedChanges(d,c.journal.seq,limit);
      if (!changes?.ids?.size || changes.seq!==journal.seq) return false;
      for (const id of changes.ids) {
        const old=c.entries.get(id),i=changes.items.get(id);
        if (!old || !i || old.item!==i || d.items[old.order]!==i || i.points?.length>32) return false;
        const next=entry(i,c.m,pcb,hidden,c.fixed,old.order);
        if (!sameStamp(old.stamp,next.stamp) || !sameBounds(old.raw,next.raw)) return false;
      }
    }
    c.journal=journal;
    return true;
  }
  function changed() {
    if (!visible() || baseJob) return;
    if (reuseBaseAfterEdit()) requestOverlay();
    else schedule();
  }
  // The visible area of the active view, drawn over the bitmap.
  function overlay() {
    frame = 0;
    if (!visible()) return;
    const Hs = host(), v = Hs?.view?.(), c = Hs?.canvas?.(), d = Hs?.doc?.();
    if (!over || !v || !c || !cache || cache.doc !== d) return;
    const a = v.screenToWorld([0, 0]), b = v.screenToWorld([c.clientWidth, c.clientHeight]), m = cache.m;
    const p = m.to([Math.min(a[0], b[0]), Math.min(a[1], b[1])]), q = m.to([Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
    const dpr = ratio(), key = [dpr, appearance, p, q].flat().map(x => x.toFixed(1)).join(",");
    if (key === lastRect) return; lastRect = key;
    const ctx = over.getContext("2d");
    if (over.width !== Math.floor(W*dpr) || over.height !== Math.floor(H*dpr)) { over.width = W*dpr; over.height = H*dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const x = Math.max(-1, Math.min(W + 1, p[0])), y = Math.max(-1, Math.min(H + 1, p[1])), x2 = Math.max(-1, Math.min(W + 1, q[0])), y2 = Math.max(-1, Math.min(H + 1, q[1]));
    ctx.fillStyle = token("--tint-accent") || "rgba(80,140,255,.15)"; ctx.fillRect(x, y, x2 - x, y2 - y);
    ctx.strokeStyle = token("--accent") || "#4c8dff"; ctx.lineWidth = 1.5; ctx.strokeRect(x + .5, y + .5, Math.max(2, x2 - x - 1), Math.max(2, y2 - y - 1));
  }
  function requestOverlay() { if (!frame && visible()) frame = requestAnimationFrame(overlay); }
  // Move the main view so the clicked point is at its centre.
  function jump(e) {
    const Hs = host(), v = Hs?.view?.(); if (!v || !cache || cache.doc!==Hs?.doc?.()) return;
    const r = over.getBoundingClientRect(), w = cache.m.from([e.clientX - r.left, e.clientY - r.top]);
    globalThis.AtriumCamera?.stopFly?.();
    v.restoreCamera({...v.camera(), cx: w[0], cy: w[1]}); Hs.redraw(); v.moving?.(); requestOverlay();
  }
  function build() {
    box = AtriumNavCommon.el("aside", null, "cam-minimap"); box.setAttribute("aria-label", "Minimap"); box.title = "Minimap: click or drag to move the view";
    base = AtriumNavCommon.el("canvas", null, "cam-minimap-base"); over = AtriumNavCommon.el("canvas", null, "cam-minimap-view");
    for (const c of [base, over]) { c.style.width = W + "px"; c.style.height = H + "px"; }
    const close = AtriumNavCommon.el("button", "×", "cam-close ui-close vc-close cam-minimap-close"); close.dataset.fill = "overlay"; close.type = "button"; close.title = "Hide the minimap"; close.setAttribute("aria-label", "Hide the minimap");
    close.onclick = () => show(false);
    box.append(base, over, close);
    over.addEventListener("pointerdown", e => { if (e.button !== 0) return; e.preventDefault(); dragging = true; over.setPointerCapture?.(e.pointerId); jump(e); });
    over.addEventListener("pointermove", e => { if (dragging) jump(e); });
    over.addEventListener("pointerup", () => { dragging = false; globalThis.AtriumCamera?.settle?.(); });
    over.addEventListener("pointercancel", () => { dragging = false; });
    over.addEventListener("wheel", e => { e.preventDefault(); const Hs = host(), v = Hs?.view?.(); if (!v) return; v.zoom(Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * .008)); Hs.redraw(); v.moving?.(); }, {passive: false});
  }
  function place() {
    const stage = host()?.canvas?.()?.parentElement;
    if (stage && box.parentElement !== stage) stage.append(box);
  }
  function show(on = !box || box.hidden) {
    if (on && !box) build();
    if (!box) return;
    box.hidden = !on;
    if (on) { place(); schedule(); requestOverlay(); }
    else { cancelPaint(); cache=null; dragging=false; }
    globalThis.AtriumNavCommon?.setChecked?.("minimap", !!on);
    try { globalThis.AtriumCamera?.setPref?.("camera.minimap", !!on); } catch {}
  }
  function attach(Hs) {
    Hs.registerAction("minimap", () => show(!box || box.hidden));
    Hs.addRenderer((d, info) => {
      if (info?.active && visible()) {
        if (cache?.doc!==d || cache.dpr!==ratio() || d.kind==="pcb" && !sameLayers(cache.hidden,Hs.hiddenLayers?.() || EMPTY_LAYERS)) schedule();
        requestOverlay();
      }
      return null;
    });
    Hs.on("change", changed);
    Hs.on("document", () => { if (box && !box.hidden) { place(); schedule(); requestOverlay(); } });
    const appearanceChanged = () => { appearance++; schedule(); requestOverlay(); };
    globalThis.addEventListener?.("atrium-pcb-appearance", appearanceChanged);
    // Any theme setting (motion, density, font size) fires this. Only colours the bitmap read rebuild
    // it; the rectangle is redrawn (its accent) without touching the geometry.
    globalThis.addEventListener?.("atrium-theme", () => {
      if (!cache || !cache.pcb && cache.tokens !== sheetTokens()) { appearanceChanged(); return; }
      lastRect = ""; requestOverlay();
    });
    const powerChanged = () => { if (visible()) { place(); schedule(); requestOverlay(); } else cancelPaint(); };
    globalThis.AtriumPower?.onChange?.(powerChanged);
    document.addEventListener("visibilitychange", powerChanged);
  }
  if (globalThis.AtriumNavCommon?.ready && globalThis.document) globalThis.AtriumNavCommon.ready(attach);
  return {show, isOpen: () => !!box && !box.hidden, bounds, mapping, repaint() { cancelBase(); paintBase(); }};
})();
