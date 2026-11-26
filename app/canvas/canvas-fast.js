"use strict";
// AtriumCanvasFast: frame-time shortcuts for the board canvas (lazy; prefetched when the editor is
// first idle, so canvas.js stays small at startup). Every shortcut gives the pixels of a full repaint;
// until this loads, canvas.js simply repaints everything.
//
//   Big pours in part (pourRings). A poured region is one even-odd path of an outline and its
//     clearance holes (hundreds of thousands of vertices on a dense board). Filling it costs time in
//     proportion to the whole path whatever the clip; in WebKit the path also crosses to the GPU
//     process, 25-35 ms a fill. Once a region is indexed (in idle time), a view or a gesture strip that
//     sees a small part of it fills only the rings whose box reaches it: under the even-odd rule a ring
//     that misses a point adds nothing there, so the pixels in view are those of the whole path.
//   Board-layer cache (reuse, saved). The board layer (workspace, grid, copper, pours, airwires) of a
//     heavy board is copied after it is drawn, keyed by everything it reads. A later frame of the same
//     document with the same key copies it and draws only the layers above (tools, overlays), so a
//     pointer-only frame, a redraw with nothing changed, or a switch back to a board tab costs a copy.
//     The last two documents keep a copy each.
//   Airwire frames. The copy of the current document also keeps the pixels beneath its airwires (the
//     last thing the board layer draws). A new connectivity result then costs two copies and the
//     airwires in view, not the board: the frame that follows an edit's copper, before its live pour.
//   Edit and selection frames. A copy with unchanged camera and presentation can take authoritative
//     model damage. Paint the intersecting items in the normal order on scratch, then copy only the
//     dirty pixels. Keeping the full raster surface avoids differences at antialiased stroke edges.
//     A batched (LOD) copy repaints with its batches while the view's object count keeps the
//     whole-frame batching decision. A rebuilt batch can move antialiasing by a level elsewhere on
//     its scanlines, so that copy is inexact and the exact frame follows on idle, as after a gesture.
//   Parked caches (park). Switching documents keeps the last two documents' item index, batches,
//     connectivity and pour state, so switching back neither rebuilds them nor misses the copy.
//   Canvas size (observe). A ResizeObserver supplies the canvas size: getBoundingClientRect() in every
//     frame forced style and layout after any DOM write (about 20 ms after a theme switch).
//
// canvas.js hands each view's internals over as `I` (paint, sync, ctx, camera, caches; see create()).
globalThis.AtriumCanvasFast = (() => {
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const same = (x, v) => x === v || (x !== x && v !== v);

  // ------------------------------------------------------------------ big pours in part
  // pourAsk: when a paint last asked for a region that has no index yet. The queue keeps only regions
  // asked for within POUR_STALE of the latest paint: a region a repour replaced is not painted again,
  // and holding it (megabytes of copper) until the canvas rests would grow with every edit.
  const pourIdx = new WeakMap(), pourAsk = new WeakMap(), pourQueue = new Set();
  const POUR_MIN = 256, POUR_STALE = 1000;
  let pourJob = null, painted = 0;
  const pourStale = r => now() - (pourAsk.get(r) ?? -Infinity) > POUR_STALE;
  const canIndexPours = () => !globalThis.document?.hidden && !globalThis.AtriumPower?.idle?.();
  function cancelPourWork() {
    pourJob?.cancel(); pourJob = null; pourQueue.clear();
  }
  function releasePours(previous, current = []) {
    const keep = new Set(current);
    for (const r of previous || []) if (!keep.has(r)) { pourIdx.delete(r); pourAsk.delete(r); pourQueue.delete(r); }
    if (!pourQueue.size) cancelPourWork();
  }
  globalThis.AtriumPower?.onChange?.(({visible, efficient}) => { if (!visible || efficient) cancelPourWork(); });
  function pourIndexBuild(region) {
    let rings; try { rings = globalThis.AtriumPCBPours.contours(region); } catch { rings = null; }
    if (!rings?.length) { pourIdx.set(region, {data: region.data, count: region.count}); return; }
    const n = rings.length, box = new Float64Array(n * 4); let total = 0, X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (let r = 0; r < n; r++) {
      const xy = rings[r]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < xy.length; i += 2) { const x = xy[i], y = xy[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      box[r * 4] = x0; box[r * 4 + 1] = y0; box[r * 4 + 2] = x1; box[r * 4 + 3] = y1; total += xy.length >> 1;
      if (x0 < X0) X0 = x0; if (y0 < Y0) Y0 = y0; if (x1 > X1) X1 = x1; if (y1 > Y1) Y1 = y1;
    }
    // A 64 x 64 grid over the region; rings spanning more than 16 cells are kept in one list.
    const G = 64, cw = Math.max(1e-6, (X1 - X0) / G), ch = Math.max(1e-6, (Y1 - Y0) / G), cells = new Array(G * G), big = [];
    const col = x => Math.max(0, Math.min(G - 1, Math.floor((x - X0) / cw))), row = y => Math.max(0, Math.min(G - 1, Math.floor((y - Y0) / ch)));
    for (let r = 0; r < n; r++) {
      const a = col(box[r * 4]), b = row(box[r * 4 + 1]), c = col(box[r * 4 + 2]), d = row(box[r * 4 + 3]);
      if ((c - a + 1) * (d - b + 1) > 16) { big.push(r); continue; }
      for (let y = b; y <= d; y++) for (let x = a; x <= c; x++) (cells[y * G + x] ??= []).push(r);
    }
    pourIdx.set(region, {data: region.data, count: region.count, rings, box, total, G, col, row, cells, big, stamp: new Uint32Array(n), mark: 0});
  }
  function schedulePourIndex(delay = 0) {
    if (pourJob || !pourQueue.size || !canIndexPours()) return;
    const job = pourJob = {};
    const run = deadline => {
      if (pourJob !== job) return;
      pourJob = null;
      if (!canIndexPours()) { pourQueue.clear(); return; }
      for (const r of pourQueue) if (pourStale(r)) pourQueue.delete(r);
      // The region was requested by a paint, and a build can overrun a busy frame.
      const quiet = 250 - (now() - painted);
      if (quiet > 0) { schedulePourIndex(quiet); return; }
      for (const r of pourQueue) {
        pourQueue.delete(r);
        if (!pourIdx.has(r)) pourIndexBuild(r);
        if (!deadline?.timeRemaining || deadline.timeRemaining() < 8) break;
      }
      schedulePourIndex();
    };
    const idle = globalThis.AtriumIdle;
    if (!delay && idle) {
      const id = idle.idle(run, {timeout: POUR_STALE}); job.cancel = () => idle.cancel(id);
    } else if (!delay && typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(run, {timeout: POUR_STALE}); job.cancel = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(run, delay || 250); job.cancel = () => clearTimeout(id);
    }
  }
  function pourIndexLater(region) {
    if (pourIdx.has(region) || typeof setTimeout !== "function" || !canIndexPours()) return;
    pourAsk.set(region, painted);
    pourQueue.add(region);
    schedulePourIndex();
  }
  // The rings of a region that reach the view box v, or null to fill the whole path (not indexed
  // yet, a small region, or a view that sees most of it).
  // alt: the region's display LOD rings (pcb-pours.js lodRings; one for one with the stored rings), taken instead.
  function pourRings(region, v, alt) {
    const b = region.bounds; painted = now();
    if (!(region.count >= POUR_MIN) || !b || v[0] <= b[0] && v[1] <= b[1] && v[2] >= b[2] && v[3] >= b[3]) return null;
    const ix = pourIdx.get(region);
    if (!ix || ix.data !== region.data || ix.count !== region.count) {
      if (ix) pourIdx.delete(region);
      pourIndexLater(region); return null;
    }
    if (!ix.rings) return null;
    const a = ix.col(v[0]), c = ix.col(v[2]), r0 = ix.row(v[1]), r1 = ix.row(v[3]);
    if ((c - a + 1) * (r1 - r0 + 1) > ix.G * ix.G * .4) return null;
    const mark = ix.mark = (ix.mark + 1) >>> 0 || 1, out = [], box = ix.box; let count = 0;
    const take = r => {
      if (ix.stamp[r] === mark) return; ix.stamp[r] = mark;
      if (box[r * 4] > v[2] || box[r * 4 + 1] > v[3] || box[r * 4 + 2] < v[0] || box[r * 4 + 3] < v[1]) return;
      out.push((alt || ix.rings)[r]); count += ix.rings[r].length >> 1;
    };
    for (const r of ix.big) take(r);
    for (let y = r0; y <= r1; y++) for (let x = a; x <= c; x++) { const l = ix.cells[y * ix.G + x]; if (l) for (const r of l) take(r); }
    return count * 2 > ix.total ? null : out;
  }
  // Fill the part of a region in view; false when the caller should paint the whole region. Live
  // pours' paint hook (polygon-pour.js tile patches: it clips a stored region out of its patch) still
  // applies, with this fill.
  // A Repour All reveal (pour-anim.js) applies too: pcb-pours.js paintWith.
  function paintPour(ctx, region, viewport) {
    const P = globalThis.AtriumPCBPours, alt = P?.lodRings?.(ctx, region);
    const rings = pourRings(region, viewport, alt?.length === pourIdx.get(region)?.rings?.length ? alt : null);
    if (!rings) return false;
    const fill = () => {
      ctx.beginPath();
      for (const xy of rings) { ctx.moveTo(xy[0], xy[1]); for (let i = 2; i < xy.length; i += 2) ctx.lineTo(xy[i], xy[i + 1]); }
      ctx.fill("evenodd");
    };
    if (P?.paintWith) P.paintWith(ctx, region, fill);
    else if (!P?.paintHook?.(ctx, region, fill)) fill();
    return true;
  }

  // ------------------------------------------------------------------ board-layer key
  // Options drawn above the board layer (not in the key), and the selection (compared on its own).
  const TOP = new Set(["measure", "block", "marquee", "marqueeMode", "paste", "pasteAt", "route", "routePreview", "pointer", "lengthTuning", "viaFence", "guides",
    "ghost", "snapAt", "overlay", "scaleBar", "reuseBase", "noReuse"]);
  const SEL = new Set(["selected", "selectedIds"]);
  // Appearance edits change PCB.system, PCB.opacity and the layer colours in place: a version.
  let looks = 0, watching = false;
  function watchLooks() {
    if (watching) return;
    const P = globalThis.AtriumPCBAppearance;
    P?.onChange?.(() => { looks++; });
    // Animation settings (motion) do not change the picture; any other theme setting may.
    let settings;
    globalThis.addEventListener?.("atrium-theme", e => {
      const s = e?.detail?.settings, k = s && typeof s === "object" ? JSON.stringify({...s, motion: null}) : null;
      if (k == null || k !== settings) looks++;
      settings = k;
    });
    watching = true;
  }
  function flatInto(k, v) {
    if (v instanceof Set) { k.push("S", v.size); for (const x of v) k.push(x); }
    else if (v instanceof Map) { k.push("M", v.size); for (const [a, b] of v) k.push(a, b); }
    else if (Array.isArray(v)) { k.push("A", v.length); for (const x of v) k.push(x); }
    else if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) { const ks = Object.keys(v); k.push("O", ks.length); for (const n of ks) k.push(n, v[n]); }
    else k.push(v);
  }
  // Presentation reads independently of the cache's item revision. Changing one of these values
  // can change the whole canvas. The retained artwork's revision is tracked beside this key.
  function keyOf(I, doc, defs, opts, v = I.cam(), frame) {
    watchLooks();
    const P = globalThis.AtriumPCBAppearance, d = globalThis.document, pcb = doc.kind === "pcb";
    const pours = pcb && !opts.hidden?.has("Source pours") && doc.pcbDrawing?.pours?.length ? frame?.state ?? I.pourState(doc, defs) : null;
    const airwires = pcb && opts.showUnrouted && !opts.transientGeometry ? I.connectivity : null;
    const labels = pcb ? globalThis.AtriumNavHost?.units?.() : new Date().toDateString();
    const lod = pcb ? globalThis.AtriumPCBPours?.lod : null, scale = v[2] * v[6];
    // The camera-independent gesture key still needs the global epoch. For an unrotated
    // backing at a known camera, match the device-pixel scale of the pour painter's transform.
    const detail = lod && Number.isFinite(scale) && scale !== 0 ? lod.keyAt?.(Math.sqrt(scale * scale)) : undefined;
    const k = [doc, doc.items, defs, airwires, pours, labels, doc.pcbDrawing, doc.pcbDrawing?.pours, doc.outline, doc.outline?.length, doc.grid, doc.origin,
      ...v, I.canvas.width, I.canvas.height, P?.system, P?.opacity, looks, !!globalThis.AtriumStackup?.isPlanning?.(), globalThis.AtriumPolygonPour?.tiles?.version,
      globalThis.AtriumPourAnim?.version, detail ?? lod?.version, d?.scripts?.length, d?.fonts?.status];
    for (const n of Object.keys(opts).sort()) { if (TOP.has(n) || SEL.has(n)) continue; k.push(n); flatInto(k, opts[n]); }
    k.push("routeHidden"); flatInto(k, opts.routePreview?.hidden || null);
    return k;
  }
  function sameKey(a, b) {
    if (!a || a.length !== b.length) return false;
    for (let n = 0; n < a.length; n++) if (!same(a[n], b[n])) return false;
    return true;
  }
  const selOf = opts => { const s = new Set(opts.selectedIds || []); if (opts.selected != null) s.add(opts.selected); return s; };

  // ------------------------------------------------------------------ board-layer cache
  const STATE = ["fillStyle", "strokeStyle", "lineWidth", "globalAlpha", "globalCompositeOperation", "font", "textAlign", "textBaseline", "lineCap", "lineJoin", "miterLimit",
    "lineDashOffset", "shadowBlur", "shadowColor", "shadowOffsetX", "shadowOffsetY", "imageSmoothingEnabled", "filter", "direction", "letterSpacing"];
  const views = new WeakMap();
  // Per view: copies by document (the last two), parked caches.
  const stateOf = I => { let s = views.get(I); if (!s) views.set(I, s = {copies: new Map(), parked: new Map(), geometry: new WeakSet(), drag: 0, last: 0}); return s; };
  const scratch = (W, H) => { try { return typeof OffscreenCanvas === "function" ? new OffscreenCanvas(W, H) : globalThis.document?.createElement("canvas") || null; } catch { return null; } };
  const lost = c => { try { return !!c.getContext("2d")?.isContextLost?.(); } catch { return true; } };
  const free = e => { if (e?.canvas) e.canvas.width = e.canvas.height = 1; freeUnder(e); };
  const freeUnder = e => { if (e?.under) { e.under.width = e.under.height = 1; e.under = null; } };
  function drop(state, doc, entry) { free(entry); state.copies.delete(doc); }
  // Synchronous, including sync() calls made by hit-testing before the next frame. A newer revision
  // extends damage from the last painted revision, even if several edits precede one render.
  function damage(I, doc, delta) {
    const state = views.get(I), entry = state?.copies.get(doc);
    if (!entry) return;
    if (!delta.known || delta.from !== (entry.pending?.to ?? entry.rev)) { drop(state, doc, entry); return; }
    const pending = entry.pending ??= {to: entry.rev, boxes: [], ids: new Set()};
    pending.to = delta.to;
    for (const i of delta.changed) pending.ids.add(i.id);
    for (const i of delta.removed || []) pending.ids.add(typeof i === "string" ? i : i.id);
    if (delta.box) pending.boxes.push(delta.box);
    if (pending.ids.size > 250 || pending.boxes.length > 24) drop(state, doc, entry);
  }
  // Called by paint() before it draws a whole frame. True when the board layer came from the
  // copy (the caller then draws the layers above it).
  function reuse(I, doc, defs, opts, frame) {
    const s = stateOf(I), e = s.copies.get(doc);
    s.frame = now();
    if (!e || opts.noReuse || e.canvas.width !== I.canvas.width || e.canvas.height !== I.canvas.height) return false;
    // A copy whose surface the GPU process dropped holds no pixels: draw the board afresh.
    if (lost(e.canvas) || e.under && lost(e.under)) { drop(s, doc, e); return false; }
    const c = I.sync(doc, defs);
    if (s.copies.get(doc) !== e) return false;
    const edited = e.rev !== c.rev;
    // The idle frame after an inexact repaint draws everything.
    if (e.inexact && I.exactNext) return false;
    if (edited) {
      if (e.pending?.to !== c.rev || opts.transientGeometry || doc.hopOvers) return false;
      // Airwires are painted with their last completed result while the editor checks connectivity.
      // A new result may affect pixels away from the changed items and invalidates the whole copy.
      if (doc.kind === "pcb" && opts.showUnrouted) I.airwireConnectivity(doc, defs);
    }
    const key = keyOf(I, doc, defs, opts, undefined, frame);
    // A new airwire result alone redraws the airwires over the pixels kept beneath them.
    const wires = !sameKey(e.key, key);
    if (wires && !(e.under && onlyAirwires(e.key, key))) return false;
    const sel = selOf(opts);
    if ((edited || !sameSet(sel, e.sel)) && !patch(I, s, e, c, doc, defs, opts, sel, wires, frame)) return false;
    if (wires && !redrawAirwires(I, e, doc, defs, opts)) return false;
    e.key = key;
    const ctx = I.ctx;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "copy"; ctx.drawImage(e.canvas, 0, 0); ctx.restore();
    I.boardTransform();
    restoreState(ctx, e);
    e.hits++; e.at = now(); I.lodUsed = e.lod; I.orderUsed = e.order;
    if (e.inexact) I.armIdle?.();
    s.copies.delete(doc); s.copies.set(doc, e);
    return true;
  }
  const sameSet = (a, b) => { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; };
  function restoreState(ctx, entry) {
    for (const n in entry.state) ctx[n] = entry.state[n];
    ctx.setLineDash?.(entry.dash);
  }
  function screenDamage(I, boxes) {
    const [, , , , , , dpr] = I.cam(), {width, height} = I.canvas;
    const rects = [], margin = 8;
    for (const b of boxes) {
      const p = I.worldToScreen([b[0], b[1]]), q = I.worldToScreen([b[2], b[3]]);
      const r = [Math.max(0, Math.floor((Math.min(p[0], q[0]) - margin) * dpr)), Math.max(0, Math.floor((Math.min(p[1], q[1]) - margin) * dpr)),
        Math.min(width, Math.ceil((Math.max(p[0], q[0]) + margin) * dpr)), Math.min(height, Math.ceil((Math.max(p[1], q[1]) + margin) * dpr))];
      if (r[2] <= r[0] || r[3] <= r[1]) continue;
      // Merge intersections to avoid painting the same neighbours twice.
      for (let n = rects.length - 1; n >= 0; n--) {
        const q = rects[n];
        if (r[0] > q[2] || q[0] > r[2] || r[1] > q[3] || q[1] > r[3]) continue;
        r[0] = Math.min(r[0], q[0]); r[1] = Math.min(r[1], q[1]);
        r[2] = Math.max(r[2], q[2]); r[3] = Math.max(r[3], q[3]);
        rects.splice(n, 1); n = rects.length;
      }
      rects.push(r);
    }
    const area = rects.reduce((n, [x, y, r, b]) => n + (r - x) * (b - y), 0);
    return rects.length <= 24 && area <= width * height * .35 ? rects : null;
  }
  function patch(I, state, entry, cache, doc, defs, opts, selected, wires, frame) {
    const pending = entry.pending, ids = new Set(pending?.ids), boxes = pending ? [...pending.boxes] : [];
    for (const id of new Set([...selected, ...entry.sel])) {
      if (selected.has(id) === entry.sel.has(id)) continue;
      const box = cache.boxes.get(cache.byId.get(id));
      if (box) boxes.push(box);
      else if (!ids.has(id)) return false;
      ids.add(id);
      if (ids.size > 250) return false;
    }
    // Bounds on the number of objects in view, which decides batching (LOD) for the whole frame.
    const maxCount = Math.min(cache.all.length, entry.maxCount + (pending?.ids.size || 0)), minCount = Math.max(0, entry.minCount - (pending?.ids.size || 0));
    let order = entry.order;
    if (doc.kind === "pcb") {
      // A fresh paint of this view must make the copy's batching decision: batched pixels are
      // repainted with the copy's batches (lodForce), unbatched ones without.
      if (pending && (!I.canBatch || (entry.lod ? !I.canBatch(minCount, opts) : I.canBatch(maxCount, opts)))) return false;
      if (!order || !I.paintLayers || !I.layerRank) return false;
      const visible = layer => globalThis.AtriumPCBAppearance.visible(layer, null, opts);
      order = order.filter(visible);
      const layers = new Set(order);
      for (const id of ids) {
        const i = cache.byId.get(id);
        if (i) for (const layer of I.paintLayers(doc, defs, i, opts)) if (visible(layer)) layers.add(layer);
      }
      const ranks = new Map([...layers].map(layer => [layer, I.layerRank(layer, opts)]));
      if (new Set(ranks.values()).size === layers.size) order = [...layers].sort((a,b) => ranks.get(a)-ranks.get(b));
      else if (pending || entry.lod) {
        // A tied pair follows its first occurrence in the full viewport. Resolve the same
        // order as whole-frame painting, and fall back if unchanged layers would swap.
        if (!I.paintOrder) return false;
        const current = I.paintOrder(doc, defs, opts, undefined, undefined, frame?.pours)?.filter(visible);
        if (!current) return false;
        const common = new Set(current.filter(layer => order.includes(layer)));
        if (!sameKey(order.filter(layer => common.has(layer)), current.filter(layer => common.has(layer)))) return false;
        order = current;
      }
    }
    const rects = screenDamage(I, boxes);
    if (!rects || rects.length && !repaintRects(I, state, entry, doc, defs, opts, rects, order, wires, frame)) return false;
    if (pending && entry.lod && rects.length) entry.inexact = true;
    entry.rev = cache.rev; entry.pending = null; entry.sel = selected; entry.maxCount = maxCount; entry.minCount = minCount; entry.order = order;
    return true;
  }
  // wires: the airwires are redrawn over the whole copy next, so only the pixels beneath them are needed.
  function repaintRects(I, state, entry, doc, defs, opts, rects, order, wires, frame) {
    const real = I.ctx, {width, height} = I.canvas, [, , , , , , dpr] = I.cam();
    const tile = state.tile ??= scratch(width, height);
    if (!tile) return false;
    if (tile.width !== width) tile.width = width;
    if (tile.height !== height) tile.height = height;
    const ctx = tile.getContext("2d"), target = entry.canvas.getContext("2d"), under = entry.under?.getContext("2d");
    if (!ctx || !target) return false;
    if (entry.under && !under) { freeUnder(entry); if (wires) return false; }
    // Use the same viewport and pixel origin as a full paint. Limit the item query, not the
    // rasterizer's clip; some platforms vary stroke coverage when the clip intersects a path.
    const guard = Math.ceil(5 * dpr);
    I.ctx = ctx; I.lodForce = entry.lod; I.orderForce = order;
    try {
      restoreState(ctx, entry);
      for (const [x, y, r, b] of rects) {
        const area = [Math.max(0, x - guard), Math.max(0, y - guard), Math.min(width, r + guard), Math.min(height, b + guard)].map(v => v / dpr);
        I.paint(doc, defs, under ? {...opts, showUnrouted: false} : opts, area, true, true, frame);
        if (under) {
          under.clearRect(x, y, r - x, b - y);
          under.drawImage(tile, x, y, r - x, b - y, x, y, r - x, b - y);
          if (wires) continue;
          // The airwires are last: the context is as the full paint left it before them.
          airwires(I, doc, defs, opts, area);
        }
        target.clearRect(x, y, r - x, b - y);
        target.drawImage(tile, x, y, r - x, b - y, x, y, r - x, b - y);
      }
    } finally { I.ctx = real; I.lodForce = null; I.orderForce = null; }
    return true;
  }
  // ------------------------------------------------------------------ airwire frames
  const AIRWIRES = 3;   // keyOf(): the connectivity whose airwires are drawn
  // canvas.js paintArtwork's airwires for `area` (CSS pixels; null: the view), with its viewport.
  function airwires(I, doc, defs, opts, area) {
    if (doc.kind !== "pcb" || !opts.showUnrouted || opts.transientGeometry) return;
    const [cx, cy, scale, flipped, width, height] = I.cam(), at = ([x, y]) => [(flipped ? width / 2 - x : x - width / 2) / scale + cx, (y - height / 2) / scale + cy];
    const p = at(area ? [area[0], area[1]] : [0, 0]), q = at(area ? [area[2], area[3]] : [width, height]), e = 7 / scale;
    I.drawAirwires(doc, defs, [Math.min(p[0], q[0]) - e, Math.min(p[1], q[1]) - e, Math.max(p[0], q[0]) + e, Math.max(p[1], q[1]) + e], opts.highlight, 0, opts.netColors);
  }
  function onlyAirwires(a, b) {
    if (!a || a.length !== b.length || same(a[AIRWIRES], b[AIRWIRES])) return false;
    for (let n = 0; n < a.length; n++) if (n !== AIRWIRES && !same(a[n], b[n])) return false;
    return true;
  }
  // Called by paint() before the airwires of a whole board layer: keep the pixels beneath them for the
  // copy saved() is about to take. Only the current document keeps them (one more canvas-sized surface).
  function under(I, doc, opts, count) {
    const s = stateOf(I), old = s.copies.get(doc), pending = s.under;
    s.under = null;
    if (opts.noReuse || s.drag >= 2 || count < 300 && !old || typeof I.ctx.drawImage !== "function") { free(pending); return; }
    const W = I.canvas.width, H = I.canvas.height;
    const c = old?.under || pending?.under || scratch(W, H);
    if (old) old.under = null;
    if (!c) return;
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "copy"; g.drawImage(I.canvas, 0, 0); g.globalCompositeOperation = "source-over";
    s.under = {doc, under: c};
  }
  function redrawAirwires(I, e, doc, defs, opts) {
    const g = e.canvas.getContext("2d"), real = I.ctx;
    if (!g || e.under.width !== e.canvas.width || e.under.height !== e.canvas.height) return false;
    g.save();
    try {
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "copy"; g.drawImage(e.under, 0, 0); g.globalCompositeOperation = "source-over";
      I.ctx = g; I.boardTransform(); restoreState(g, e);
      airwires(I, doc, defs, opts, null);
    } finally { I.ctx = real; g.restore(); }
    return true;
  }
  // Called by paint() after it drew a whole base layer in `ms` ms (count objects in view).
  let boardMs = 0;   // the last whole board layer's main-thread time (polygon-pour.js: fade or snap)
  function saved(I, doc, defs, opts, ms, count, frame) {
    const s = stateOf(I), old = s.copies.get(doc), pending = s.under; boardMs = ms;
    s.frame = now();
    s.under = null;
    const moving = s.geometry.delete(doc) && opts.transientGeometry;
    // Pointer moves invalidate the copy before the next frame. A later static preview
    // or the first post-drop frame can still retain the artwork.
    if (moving) s.drag = 0;
    if (opts.noReuse || moving) { free(pending); if (old) drop(s, doc, old); return; }
    const c = I.sync(doc, defs);
    // Release copies nobody used for a minute.
    for (const [d, e] of s.copies) if (d !== doc && now() - e.at > 60000) { free(e); s.copies.delete(d); }
    // Lightly populated views cost less to paint again. Detailed dense views retain their artwork
    // even if a particular paint was fast enough to be under the whole-board time threshold.
    // In a stream of frames (under 100 ms apart, a drag that changes the board every frame) copying
    // stops after two copies in a row that were never used.
    const t = now(), stream = t - (s.last || 0) < 100; s.last = t;
    if (!stream) s.drag = 0; else if (old) s.drag = old.hits ? 0 : s.drag + 1;
    // While copies are off in a stream, a board layer that comes out the same twice in a row is
    // stable again (a drag whose preview is drawn above the board): copy it.
    let key = null;
    if (s.drag >= 2) {
      key = keyOf(I, doc, defs, opts, undefined, frame);
      if (c.rev === s.lastRev && sameKey(s.lastKey, key)) s.drag = 0;
      s.lastRev = c.rev; s.lastKey = key;
    }
    if ((count < 300 && ms < (opts.reuseBase ? 1 : 6)) || s.drag >= 2 || globalThis.AtriumStackup?.isPlanning?.() || typeof I.ctx.drawImage !== "function") {
      free(pending);
      if (old) { free(old); s.copies.delete(doc); }
      return;
    }
    const W = I.canvas.width, H = I.canvas.height, copy = old?.canvas || scratch(W, H);
    const under = pending?.doc === doc && pending.under.width === W && pending.under.height === H ? pending.under : (free(pending), null);
    const g = copy?.getContext("2d"), ctx = I.ctx;
    if (!g) { free({under}); return; }
    globalThis.AtriumCanvas.resizeBacking(copy,W,H);
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "copy"; g.drawImage(I.canvas, 0, 0); g.globalCompositeOperation = "source-over";
    const state = {}; for (const n of STATE) if (n in ctx) state[n] = ctx[n];
    s.copies.delete(doc);
    // Only this document keeps the pixels beneath its airwires.
    if (old && old.under !== under) freeUnder(old);
    for (const e of s.copies.values()) freeUnder(e);
    // The key is taken after drawing: drawing may have settled the airwires or the pour state.
    s.copies.set(doc, {canvas: copy, key: key || keyOf(I, doc, defs, opts, undefined, frame), rev: c.rev, pending: null, maxCount: count, minCount: count, sel: selOf(opts), state,
      dash: ctx.getLineDash?.() || [], hits: 0, at: now(), lod: I.lodUsed, order: I.orderUsed, under});
    while (s.copies.size > 2) { const k = s.copies.keys().next().value; free(s.copies.get(k)); s.copies.delete(k); }
  }

  // ------------------------------------------------------------------ parked caches
  // sync() asks before it rebuilds for another document: keep the current caches, restore doc's.
  function park(I, doc) {
    const p = stateOf(I).parked, cur = I.cache;
    if (!cur || cur.doc === doc) return;
    const mine = x => x?.doc === cur.doc ? x : null;
    p.delete(cur.doc); p.set(cur.doc, {cache: cur, connectivity: mine(I.connectivity), pourCache: mine(I.pourCache)});
    while (p.size > 3) p.delete(p.keys().next().value);
    const e = p.get(doc);
    if (e) { p.delete(doc); I.cache = e.cache; if (e.connectivity) I.connectivity = e.connectivity; if (e.pourCache) I.pourCache = e.pourCache; }
  }
  function releasePixels(I) {
    const s = views.get(I);
    if (!s) return;
    for (const [doc, entry] of s.copies) drop(s, doc, entry);
    free(s.under); s.under = null;
  }
  // An edit to a document drops what is kept for it.
  function invalidate(I, doc, geometryChanged = false) {
    const s = stateOf(I);
    if (!doc) { releasePixels(I); s.parked.clear(); s.geometry = new WeakSet(); s.lastKey = null; return; }
    if (geometryChanged && doc.kind === "pcb") s.geometry.add(doc);
    else s.geometry.delete(doc);
    s.parked.delete(doc);
    const e = s.copies.get(doc); if (e) drop(s, doc, e);
  }

  // ------------------------------------------------------------------ canvas size
  function observe(I) {
    const s = stateOf(I);
    // The GPU process restarted (memory pressure, a driver reset): every accelerated surface lost its pixels.
    // Retained copies (canvas.js's zoom layers, the board copies here) would paint an empty board under the
    // overlays, so they go (I.surfacesLost) and a restored canvas is drawn in full. Chrome reports the loss on
    // the view's canvas; WebKit only on WebGL contexts (canvas-gpu.js calls I.surfacesLost).
    if (!s.lostWatch && I.canvas?.addEventListener) {
      const lost = () => { I.surfacesLost?.(); invalidate(I); };
      const restored = () => { lost(); I.repaint(); };
      s.lostWatch = {lost, restored};
      I.canvas.addEventListener("contextlost", lost);
      I.canvas.addEventListener("contextrestored", restored);
    }
    if (s.ro || typeof ResizeObserver !== "function") return;
    try {
      s.ro = new ResizeObserver(() => { const r = I.canvas.getBoundingClientRect(); I.size = {w: r.width, h: r.height}; });
      // The first measure often runs inside another ResizeObserver's callback (a library or wizard
      // preview that fits its canvas when it gets a size): an element observed there is a new
      // observation the browser cannot deliver in that pass ("ResizeObserver loop completed with
      // undelivered notifications"). Observe after the pass; until then the canvas is measured.
      const ro = s.ro;
      s.observeTimer = setTimeout(() => {
        s.observeTimer = null;
        if (s.ro === ro) try { ro.observe(I.canvas); } catch { s.ro = null; }
      }, 0);
    } catch { s.ro = null; }
  }

  function cancelIndex(s) {
    const job = s.indexJob;
    if (!job) return;
    s.indexJob = null;
    job.owner.indexing = false;
    job.idle.cancel(job.id);
  }

  function release(I) {
    const s = views.get(I);
    if (!s) return;
    if (s.observeTimer != null) clearTimeout(s.observeTimer);
    s.ro?.disconnect(); s.ro = null;
    if (s.lostWatch) {
      I.canvas.removeEventListener?.("contextlost", s.lostWatch.lost);
      I.canvas.removeEventListener?.("contextrestored", s.lostWatch.restored);
    }
    cancelIndex(s);
    releasePixels(I);
    views.delete(I);
  }

  // Build the airwire index once this view's frames have stopped for 250 ms.
  // Until then the airwires are scanned.
  function later(I, owner, box) {
    const idle = globalThis.AtriumIdle, S = globalThis.AtriumSpatial;
    if (owner.indexing || !S) return;
    if (!idle?.idle) { owner.index = S.create(owner.result.airwires, box, 4); return; }
    const s = stateOf(I);
    cancelIndex(s);
    const job = s.indexJob = {owner, idle, id: null};
    owner.indexing = true;
    const run = d => {
      if (s.indexJob !== job) return;
      if (I.connectivity === owner && !d?.didTimeout && (now() - (s.frame || 0) < 250 || d?.timeRemaining && d.timeRemaining() < 10)) {
        job.id = idle.idle(run, {timeout: 2000}); return;
      }
      s.indexJob = null;
      owner.indexing = false;
      if (I.connectivity === owner) owner.index = S.create(owner.result.airwires, box, 4);
    };
    job.id = idle.idle(run, {timeout: 2000});
  }
  return Object.freeze({pourRings, paintPour, releasePours, keyOf, reuse, saved, under, later, park, damage, invalidate, observe, releasePixels, release, lastBoardMs: () => boardMs});
})();
