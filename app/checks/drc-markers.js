"use strict";
if (!globalThis.AtriumLandContours && typeof require === "function") require("../pcb/land-contours.js");
// DRC violation markers on the board (loaded by drc-view.js).
//
// Quiet, click-driven feedback (Altium's hover pop-up over the board is what users found
// counter-intuitive, so it is off by default):
//   - Each violation draws a marker in its severity colour with a shape cue, so colour is not
//     the only signal: a ring for errors, a triangle for warnings, a dashed ring for waived
//     violations. Markers grow with zoom within an on-screen range (problem-marks.js), staying
//     smaller than a via close up, in thin strokes (problem-marks.js STROKE). Inside it an X marks a conflict between two objects (clearance, short, hole
//     to hole …), a dot a single-object rule (width, hole size, annular ring …).
//   - The objects involved get a subtle outline in the same colour at half strength; a dashed detail
//     line joins the two closest points.
//   - Footprint findings (Missing Courtyard) are listed, not drawn, until one is chosen (LISTED).
//   - Hovering a marker emphasises it and its objects a little, and writes one quiet line
//     in the status bar ("Clearance 0.186 < 0.2 mm · A2.2 ↔ Track A1 · click for details").
//     After a rest, the small problem card (problem-hover.js) says what it is beside the marker,
//     clear of the marker and its objects, and goes as soon as the pointer or the camera moves.
//   - Clicking a marker (or F8 / Shift+F8) opens the pinned Violation inspector in the
//     Properties pane (drc-inspector.js, lazy): rule, actual and required values, the objects,
//     Fix with a preview and Waive…. Escape or a click on empty board closes it.
//
// Markers follow layer visibility (a violation whose objects are all on hidden layers is
// not drawn) and the selection filter (filtered-out objects draw dimmed and ignore the
// pointer). View → DRC Markers hides them all. Choosing a violation in Messages zooms to it.
//
// Online DRC (drc-view.js) uses pick(): a spatial index over item boxes, updated per edit,
// so only the changed region is collected for re-checking.
globalThis.AtriumDRCMarkers = (() => {
  const C = () => globalThis.AtriumNavCommon, A = () => globalThis.Atrium, R = () => globalThis.AtriumRules;
  // Canvas palette (problem-marks.js BOARD: the board canvas is dark in every theme). Severity first;
  // ring is the focus ring of the pinned violation, halo the dark edge that keeps glyphs readable on copper.
  const P = globalThis.AtriumProblemMarks, B = P.BOARD, S = P.STROKE, planFor = P.register();
  const COLORS = Object.freeze({error: B.error, warning: B.warning, waived: B.waived, halo: B.halo, ring: B.ring, dim: B.dim,
    overlay: B.error, marker: B.error, detail: B.error});
  // error | warning | waived. Waived rows come from drc-view.js with a `waived` waiver attached.
  const severity = v => v?.waived ? "waived" : v?.warning || v?.type === "unrouted" ? "warning" : "error";
  const RANK = {error: 3, warning: 2, waived: 1};
  const PAIRED = new Set(["clearance", "short", "holeToHole", "silkToSilk", "silkToMask", "boardOutlineClearance", "dfaSpacing", "returnPathVia", "diffPairsRouting"]);
  // Findings about a footprint in the library rather than about its place on the board (Missing
  // Courtyard): every placement of the footprint would carry the same marker, so they stay in Messages
  // and draw on the board only while one is chosen there (focused).
  const LISTED = new Set(["courtyard"]);
  let visible = true;
  try { const s = JSON.parse(globalThis.localStorage?.getItem("atrium-drc-markers") || "null"); if (s) visible = s.visible !== false; } catch { /* storage unavailable */ }
  const save = () => { try { globalThis.localStorage?.setItem("atrium-drc-markers", JSON.stringify({visible})); } catch { /* storage unavailable */ } };

  // ------------------------------------------------------------------ geometry
  const glyph = v => v.otherId && v.otherId !== v.id || PAIRED.has(v.type) ? "x" : "o";
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function boxOf(s) {
    if (s.kind === "line") { let b = null; for (const p of s.points) b = C().union(b, [p[0], p[1], p[0], p[1]]); return C().grow(b, (s.width || 0) / 2); }
    if (s.kind === "circle") return [s.at[0] - s.r, s.at[1] - s.r, s.at[0] + s.r, s.at[1] + s.r];
    if (s.kind === "pad") { const r = Math.hypot(s.w, s.h) / 2; return [s.at[0] - r, s.at[1] - r, s.at[0] + r, s.at[1] + r]; }
    return s.box;
  }
  // The primitive of `item` a violation points at: tracks and vias themselves, the pad of a
  // part nearest the violation point, else the part's box.
  function shapeOf(doc, defs, item, at, partPins) {
    if (!item) return null;
    if (item.kind === "track" || Array.isArray(item.points) && item.points.length > 1 && !item.fill)
      return {kind: "line", points: item.points, width: item.width || 0, layer: item.layer || "Top", item, closed: !!item.closed};
    if (item.kind === "via") return {kind: "circle", at: [item.x, item.y], r: (item.diameter || .6) / 2, layer: "Multi", item};
    if (item.kind === "part") {
      const def = defs?.get?.(item.def);
      if (at && def) {
        let best = null, bd = Infinity;
        try {
          let pins = partPins?.get(item);
          if (!pins) {
            pins = A().pins(item, def, "pcb");
            partPins?.set(item, pins);
          }
          for (const p of pins) {
            const d = near(p.at, at);
            if (d < bd) { bd = d; best = p; }
          }
        } catch { best = null; }
        const reach = best ? Math.hypot(best.w || 0, best.h || 0) / 2 + 0.5 : 0;
        if (best && bd <= reach) return {kind: "pad", at: best.at.slice(), w: best.w || best.diameter || .5, h: best.h || best.diameter || .5, angle: (best.angle || 0) + (item.angle || 0),
          shape: String(best.shape || "round").toLowerCase(), layer: best.drill > 0 ? "Multi" : best.layer || item.layer || "Top", item};
      }
      const b = C().itemBox(doc, defs, item);
      return b ? {kind: "box", box: b, layer: item.layer || "Top", item} : null;
    }
    if (Array.isArray(item.points) && item.points.length > 2) return {kind: "line", points: item.points, width: item.width || 0, layer: item.layer || "Top", item, closed: true};
    if (Number.isFinite(item.x)) { const r = Math.max(item.w || 0, item.h || 0, item.diameter || 0) / 2 || .3; return {kind: "circle", at: [item.x, item.y], r, layer: item.layer || "Top", item}; }
    return null;
  }
  function itemIndex(doc) {
    const ids = new Map();
    for (const i of doc.items) ids.set(i.id, i);
    return ids;
  }
  function shapes(doc, defs, v, ids = itemIndex(doc), partPins) {
    const out = [];
    const a = v.id && ids.get(v.id), b = v.otherId && v.otherId !== v.id && ids.get(v.otherId);
    const s1 = shapeOf(doc, defs, a, v.at || v.otherAt, partPins), s2 = shapeOf(doc, defs, b, v.otherAt || v.at, partPins);
    if (s1) out.push(s1); if (s2) out.push(s2);
    return out;
  }
  // World box of a violation: its objects and points.
  function boundsOf(all, v) {
    let b = null;
    for (const s of all) b = C().union(b, boxOf(s));
    for (const p of [v.at, v.otherAt]) if (p) b = C().union(b, [p[0], p[1], p[0], p[1]]);
    return b;
  }
  function box(doc, defs, v, ids) { return boundsOf(shapes(doc, defs, v, ids), v); }

  // ------------------------------------------------------------------ visibility and filter
  const shown = (s, hidden) => !hidden || !hidden.size || s.layer === "Multi" || !hidden.has(s.layer);
  const reaches = (box, view) => !view || box && box[0] <= view[2] && box[1] <= view[3] && box[2] >= view[0] && box[3] >= view[1];
  // {v, shapes, live} for each violation to draw; live is false for filtered-out objects.
  // `rev` (the editor's revision) keeps each violation's shapes and box between frames; `view` (a world
  // box) leaves out the rows that cannot reach it.
  function visibleList(doc, defs, list, {hidden = null, selectable = null, rev = null, view = null, preview = null, publication = null, focused = null} = {}, eligibility = null) {
    return rowViews(rowsOf(doc, defs, list, rev, preview, publication), {hidden, selectable, view, publication, focused}, eligibility);
  }
  function rowViews(entry, {hidden, selectable, view, publication, focused = null}, eligibility, members = null) {
    const out = [];
    if (!entry) return out;
    let cached = eligibility?.get(entry);
    if (eligibility && !cached) eligibility.set(entry, cached = []);
    for (let i = 0; i < entry.rows.length; i++) {
      const r = entry.rows[i];
      if (!r || LISTED.has(r.v.type) && r.v !== focused || !(members ? members(r, i) : reaches(r.box, view))) continue;
      let row = cached?.[i];
      if (row === undefined) {
        row = rowView(r, hidden, selectable, !!publication);
        if (cached) cached[i] = row;
      }
      if (row) out.push(row);
    }
    return out;
  }
  function rowView(r, hidden, selectable, published = false) {
    const sh = r.all, vis = published && !hidden?.size ? sh : sh.filter(s => shown(s, hidden));
    if (sh.length && !vis.length) return null;
    const live = !selectable || !sh.length || sh.some(s => { try { return selectable(s.item) !== false; } catch { return true; } });
    const v = r.v, sev = severity(v), score = (live ? 8 : 0) + (v.waived ? 0 : 4) + RANK[sev];
    return {v, shapes: vis, live, row: r, sev, score, cross: glyph(v) === "x"};
  }
  // The journal proves which object geometry changed between two paints. A full rebuild also
  // replaces the per-list caches, including those belonging to inactive panes and waived rows.
  const boards = new WeakMap();
  function geometry(doc, defs, rev) {
    const undo = rev != null && globalThis.AtriumUndoStore;
    const version = undo?.documentVersions?.(doc);
    const store = (version || !undo?.documentVersions && undo?.root?.()?.documents?.includes(doc)) ? undo : null;
    const prior = rev != null && boards.get(doc), outer = version?.outer ?? store?.outer?.(), library = version?.library;
    const same = store && outer != null && prior && prior.items === doc.items && prior.length === doc.items.length &&
      prior.defs === defs && prior.store === store && prior.outer === outer && prior.library === library;
    if (same && version && prior.seq === version.seq && prior.seq >= version.floor) return prior;
    const ch = store?.recordedChanges?.(doc, prior?.seq);
    if (same && ch?.ids) {
      // A rename, replacement or ambiguous ID can change the last object an ID resolves to.
      let valid = !ch.ids.size || prior.ids.size === doc.items.length;
      for (const id of ch.ids) if (prior.ids.get(id) !== ch.items.get(id)) { valid = false; break; }
      if (valid) { prior.seq = ch.seq; return prior; }
    }
    const next = {items: doc.items, length: doc.items.length, ids: itemIndex(doc), lists: new WeakMap(), published: new WeakMap(), defs, store, outer, library, seq: ch?.seq};
    if (rev != null) boards.set(doc, next);
    return next;
  }
  function makeRow(doc, defs, ids, v, partPins) {
    const all = shapes(doc, defs, v, ids, partPins);
    return {v, all, box: boundsOf(all, v), id: v.id, other: v.otherId, x: v.at?.[0], y: v.at?.[1], ox: v.otherAt?.[0], oy: v.otherAt?.[1],
      type: v.type, warning: v.warning, waived: v.waived, value: v.delay?.actual ?? v.actual};
  }
  // Only live DRC publications carry a snapshot identity. Ad-hoc lists may change entries in place.
  function rowsOf(doc, defs, list, rev, preview, publication = null) {
    if (!list?.length) return null;
    // Some hosts expose a live drag without identifying the objects it moves.
    if (preview === true) { boards.delete(doc); rev = null; preview = null; }
    const g = geometry(doc, defs, rev), lists = publication ? g.published : g.lists, c = lists.get(list);
    if (publication && c?.publication === publication && c.seq === g.seq && !preview && !c.preview) return c;
    const advanced = c && c.seq !== g.seq, changed = advanced ? g.store?.recordedChanges(doc, c.seq) : null;
    const rows = c && (!advanced || changed?.ids) ? c.rows : [];
    const dirty = preview || c?.preview ? new Set([...(changed?.ids || []), ...(c?.preview || []), ...(preview || [])]) : changed?.ids;
    // Each violation still selects its own nearest pad. The transformed footprint
    // is shared only inside this pass, including when a live drag bypasses Undo.
    let partPins;
    for (let k = 0; k < list.length; k++) {
      const v = list[k], r = rows[k];
      if (!v || v.type === "unrouted") { rows[k] = null; continue; }
      // DRC results can be reordered, replaced, or have their points edited in place independently
      // of the board. Reuse only the actual row at this position with the same shape inputs.
      if (!r || r.v !== v || r.id !== v.id || r.other !== v.otherId || r.x !== v.at?.[0] || r.y !== v.at?.[1] ||
          r.ox !== v.otherAt?.[0] || r.oy !== v.otherAt?.[1] || r.type !== v.type || r.warning !== v.warning ||
          r.waived !== v.waived || r.value !== (v.delay?.actual ?? v.actual) || dirty?.has(v.id) || dirty?.has(v.otherId)) {
        rows[k] = makeRow(doc, defs, g.ids, v, partPins ??= new Map());
      }
    }
    rows.length = list.length;
    const entry = {rows, seq: g.seq, preview, publication};
    lists.set(list, entry);
    return entry;
  }
  function context(host, doc, defs, frame) {
    const opts = frame.options, edit = globalThis.AtriumPCBEdit, filter = edit?.filters?.pcb;
    const drag = (!opts || opts.transientGeometry) && host?.drag?.();
    const affected = drag?.translation?.affected || (drag?.item ? [drag.item] : null);
    const preview = drag?.before ? (affected ? new Set(affected.map(i => i.id)) : true) : null;
    if (opts && frame.selectable) return {hidden: opts.hidden, preview,
      selectable: i => frame.selectable(i, doc, opts, defs) && (!filter || edit.allows(i, filter, "pcb")),
      visual: [opts.layer, opts.layerMode, JSON.stringify(filter)]};
    let hidden = null;
    try { hidden = host?.hiddenLayers?.() || null; } catch { /* no visibility provider */ }
    const layers = host?.captureViewState?.()?.layers;
    return {hidden, selectable: host?.selectable && (i => host.selectable(i)), preview,
      visual: layers ? [layers.active, layers.mode, JSON.stringify(filter)] : null};
  }

  // ------------------------------------------------------------------ drawing
  function padPath(ctx,s,grow){
    const L=AtriumResolvedLand,land=L.geometry(s),g=land&&AtriumLandContours.expand(land,grow);
    ctx.beginPath();
    if(!g)return;
    ctx.save();ctx.translate(s.at[0],s.at[1]);ctx.rotate(Atrium.rad(g.angle));
    if(g.shape==="circle")ctx.arc(0,0,g.w/2,0,Math.PI*2);
    else if(g.shape==="ellipse"&&ctx.ellipse)ctx.ellipse(0,0,g.w/2,g.h/2,0,0,Math.PI*2);
    else if(g.shape==="rect")ctx.rect(-g.w/2,-g.h/2,g.w,g.h);
    else if(g.r>0&&ctx.roundRect)ctx.roundRect(-g.w/2,-g.h/2,g.w,g.h,g.r);
    else{
      const pts=AtriumLandContours.outline(g);
      ctx.moveTo(...pts[0]);for(let i=1;i<pts.length;i++)ctx.lineTo(...pts[i]);ctx.closePath();
    }
    ctx.restore();
  }
  // A subtle outline around an offending primitive: a soft band along tracks, a thin ring
  // around pads and vias, a dashed box around a part. Hovered or pinned: a little stronger.
  // Half strength at rest: the marker already says where; the ring only says which object.
  const OUTLINE_ALPHA = .5;
  function outline(ctx, s, px, color, hot) {
    ctx.strokeStyle = color; ctx.setLineDash([]);
    if (s.kind === "line") {
      ctx.globalAlpha *= hot ? .5 : .3;
      ctx.lineWidth = (s.width || 0) + (hot ? 6 : 4) * px; ctx.beginPath(); ctx.moveTo(s.points[0][0], s.points[0][1]);
      for (let k = 1; k < s.points.length; k++) ctx.lineTo(s.points[k][0], s.points[k][1]);
      if (s.closed) ctx.closePath();
      ctx.stroke();
      return;
    }
    ctx.globalAlpha *= hot ? 1 : OUTLINE_ALPHA; ctx.lineWidth = (hot ? 2 : 1) * px;
    if (s.kind === "circle") { ctx.beginPath(); ctx.arc(s.at[0], s.at[1], Math.max(s.r, 3 * px) + 1.5 * px, 0, Math.PI * 2); ctx.stroke(); }
    else if (s.kind === "pad") { padPath(ctx, s, 1.5 * px); ctx.stroke(); }
    else if (s.kind === "box") { ctx.setLineDash([5 * px, 3 * px]); ctx.strokeRect(s.box[0], s.box[1], s.box[2] - s.box[0], s.box[3] - s.box[1]); ctx.setLineDash([]); }
  }
  // One severity outline and one interior. Sparse markers and retained batches both append them.
  function appendMarkerBorder(path, at, r, sev) {
    if (sev === "warning") {
      const h = r * 1.2;
      path.moveTo(at[0], at[1] - h); path.lineTo(at[0] + h * .95, at[1] + h * .62); path.lineTo(at[0] - h * .95, at[1] + h * .62); path.closePath();
    } else { path.moveTo(at[0] + r, at[1]); path.arc(at[0], at[1], r, 0, Math.PI * 2); }
  }
  function appendMarkerInterior(path, at, r, sev, px, cross) {
    const inner = sev === "warning" ? r * .45 : r * .5, cy = sev === "warning" ? at[1] + r * .12 : at[1];
    if (cross) { const k = inner * .9; path.moveTo(at[0] - k, cy - k); path.lineTo(at[0] + k, cy + k); path.moveTo(at[0] + k, cy - k); path.lineTo(at[0] - k, cy + k); }
    else { const d = Math.max(r * .22, 1.2 * px); path.moveTo(at[0] + d, cy); path.arc(at[0], cy, d, 0, Math.PI * 2); }
  }
  // The marker outline for a severity: ring (error), triangle (warning), ring drawn dashed (waived).
  // z: P.size() for the frame's scale (the marker's radius and stroke factor).
  function drawMarker(ctx, v, at, z, {hot = false, pinned = false, live = true} = {}) {
    const px = z.px, w = z.w, sev = severity(v), r = z.r * (hot || pinned ? 1.2 : 1), color = live ? COLORS[sev] : COLORS.dim;
    if (pinned) { ctx.lineWidth = 1.5 * px * w; ctx.strokeStyle = COLORS.ring; ctx.beginPath(); ctx.arc(at[0], at[1], r + 4 * px * w, 0, Math.PI * 2); ctx.stroke(); }
    ctx.setLineDash(sev === "waived" ? [2.5 * px * w, 2 * px * w] : []);
    ctx.beginPath(); appendMarkerBorder(ctx, at, r, sev);
    ctx.lineWidth = S.halo * px * w; ctx.strokeStyle = COLORS.halo; ctx.stroke();
    ctx.lineWidth = (hot || pinned ? S.hot : S.line) * px * w; ctx.strokeStyle = color; ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.strokeStyle = color;
    const cross = glyph(v) === "x" && sev !== "waived";
    ctx.beginPath(); appendMarkerInterior(ctx, at, r, sev, px, cross); if (cross) ctx.stroke(); else ctx.fill();
  }
  function valueText(v, unit) {
    if (v.delay) return (v.delay.actual).toFixed(v.what === "Phase skew" ? 2 : 1) + " ps";
    if (v.actual == null) return "";
    try { return R().units.format(v.actual, unit, true); } catch { return v.actual.toFixed(3) + " mm"; }
  }
  const LOD_ROWS = 250, PADDING = P.MAX * 4 + 12;
  // Camera moves keep layer and selection eligibility. Cache it against the publication, journal and
  // pane filters. Within that snapshot, resolve newly exposed rows only when their world bounds reach
  // the current viewport. The exact scale and viewport still decide every cell winner and draw order.
  const paneEligibility = new WeakMap();
  function eligibilityFor(canvas, stamp) {
    if (!canvas || !stamp) return null;
    const old = paneEligibility.get(canvas);
    if (old?.stamp.length === stamp.length && stamp.every((v, i) => v === old.stamp[i])) return old;
    const state = {stamp, rows: new WeakMap(), allowed: new Map()};
    paneEligibility.set(canvas, state);
    return state;
  }
  function markerPlan(doc, defs, list, o, frame) {
    if (o.host) o = {...o, ...context(o.host, doc, defs, frame)};
    const v = globalThis.AtriumUndoStore?.documentVersions?.(doc);
    const input = o.publication && v && !o.preview && (o.visual || !o.selectable) && !o.view ?
      [doc, o.publication, list, o.waived, defs, v.seq, v.floor, v.outer, v.library, v.pours,
        ...(o.visual || []), ...(o.hidden || [])] : null;
    const stamp = input && [...input, o.focused, o.hover];
    return planFor(doc, frame, stamp, () => {
      const eligibility = eligibilityFor(frame.canvas, input);
      const q = {...o, view: o.view || frame.worldViewport?.(null, PADDING)};
      if (o.selectable && (eligibility || o.publication && (list?.length || 0) + (o.waived?.length || 0) > LOD_ROWS)) {
        const allowed = eligibility?.allowed || new Map();
        q.selectable = item => {
          if (!allowed.has(item)) allowed.set(item, o.selectable(item));
          return allowed.get(item);
        };
      }
      const cell = P.pcbCell(frame);
      const z = P.size(frame.scale, "pcb");
      if (cell) return coarsePlan(doc, defs, list, q, frame, z, cell, eligibility);
      if (eligibility) eligibility.index = null;
      const rows = visibleList(doc, defs, list, q, eligibility?.rows);
      const waived = visibleList(doc, defs, o.waived, q, eligibility?.rows);
      const overview = rows.length + waived.length > LOD_ROWS && !!frame.worldToScreen;
      const detail = overview ? null : detailMarks(rows, waived, o, z, frame.scale);
      return {rows, waived, overview, ...(overview ? overviewMarks(rows, waived, o, z, frame.scale) : {marks: detail})};
    });
  }
  function overlay(doc, defs, list, o = {}) {
    const paint = (ctx, a) => {
      const plan = markerPlan(doc, defs, list, o, a);
      const {rows, waived} = plan;
      if (!(plan.hasRows ?? (rows.length || waived.length))) return;
      const clip = a.area && a.worldViewport?.(a.area, PADDING);
      if (plan.overview) {
        // A damage strip uses the whole view's cell winners and outline style order.
        const strips = clip && (a.damageRects?.length > 1 ? a.damageRects.map(rect => a.worldViewport(rect, PADDING)) : [clip]);
        const retain = !plan.cell || plan.clustered.length;
        if (!retain || !retainedOverview(ctx, a, plan, o)) drawOverview(ctx, a, rows, o, plan, strips);
        return;
      }
      if (!clip) drawRows(ctx, a, rows, o, plan.marks);
      else drawRows(ctx, a, rows.filter(r => reaches(r.row.box, clip)), o,
        plan.marks.filter(({at: [x, y]}) => x >= clip[0] && x <= clip[2] && y >= clip[1] && y <= clip[3]));
    };
    paint.panDamage = (frame, dx, dy) => {
      if (!P.pcbCell(frame) || (list?.length || 0) + (o.waived?.length || 0) < 2) return [];
      const radius = P.hit(P.size(frame.scale, "pcb").screen * 1.2) + 2;
      return P.groupPanDamage(markerPlan(doc, defs, list, o, frame).clustered, frame, atOf, scoreOf, radius, dx, dy);
    };
    return paint;
  }
  // A whole-frame overview is drawn into a transparent layer kept per canvas, then composited.
  // Every whole frame takes this path, so a frame that reuses the layer (same rows, camera,
  // hover and focus) equals one that redraws it: ~1,000 markers cost one image copy instead of
  // their strokes. When an edit rebuilds a few rows, only the pixel rows of their old and new
  // areas are redrawn, from the markers that reach them: a stroke path's antialiasing can depend
  // on its other contours along a scanline (up to a pixel's whole coverage), much less above or
  // below it: Chrome's patched rows stay within two levels of a whole layer (canvas-damage.js). The
  // layer is redrawn whole once frames have stopped for 250 ms. Gesture strips (`area`) draw directly; the exact
  // frame after the gesture uses the layer.
  let layers = new WeakMap();
  const PREFIX = 13, PATCH_ROWS = 16, layerStats = {whole: 0, patched: 0, reused: 0}, held = new Set();
  // Hidden markers keep no surfaces (they count against the browser's canvas memory).
  function releaseLayers() { for (const c of held) c.width = c.height = 1; held.clear(); layers = new WeakMap(); }
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  function retainedOverview(ctx, a, plan, o) {
    const target = ctx.canvas, m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
    if (a.area || !m || !target?.width || !target.height || typeof OffscreenCanvas !== "function" || globalThis.AtriumCanvasGPU?.overlays?.()) return false;
    const {rows, waived} = plan.rowLists?.() || plan;
    const key = [target.width, target.height, m.a, m.b, m.c, m.d, m.e, m.f, a.scale, ctx.globalAlpha, o.focused, o.hover, waived.length];
    const items = [...waived, ...rows];
    // A paired finding can switch from one visible primitive to the other at the same shape count.
    for (const r of items) key.push(r.row, r.live, r.shapes.length === r.row.all.length ? null : r.shapes[0]);
    let L = layers.get(target);
    const changed = L && !L.stale ? changedRows(L, key) : null;
    if (!changed || changed.length) {
      let c = L?.canvas;
      try { c ||= new OffscreenCanvas(target.width, target.height); } catch { return false; }
      held.add(c);
      if (c.width !== target.width) c.width = target.width;
      if (c.height !== target.height) c.height = target.height;
      const g = c.getContext("2d");
      if (!g) return false;
      // A new group can retire an unchanged singleton's entire outline, including remote track geometry.
      const patched = !plan.cell && !!changed && patchLayer(g, a, m, ctx.globalAlpha, L.items, items, changed, waived.length, o, plan);
      layerStats[patched ? "patched" : "whole"]++;
      if (!patched) {
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
        g.setTransform(m); g.globalAlpha = ctx.globalAlpha;
        drawOverview(g, a, rows, o, plan);
        g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
      }
      if (L?.timer) clearTimeout(L.timer);
      layers.set(target, L = {canvas: c, key, items, inexact: patched || !!(changed && L.inexact), stale: false, used: 0, timer: 0});
    } else layerStats.reused++;
    L.used = clock();
    if (L.inexact) settleLayer(L);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(L.canvas, 0, 0);
    ctx.restore();
    return true;
  }
  // The rows (indices into the layer's items) whose entries changed: [] for none, null when the
  // camera, focus or list length changed or more than PATCH_ROWS rows did (the layer is redrawn).
  function changedRows(L, key) {
    if (L.key.length !== key.length) return null;
    for (let n = 0; n < PREFIX; n++) if (L.key[n] !== key[n]) return null;
    const out = [];
    for (let n = PREFIX; n < key.length; n++) {
      if (L.key[n] === key[n]) continue;
      const j = (n - PREFIX) / 3 | 0;
      if (out.at(-1) !== j) out.push(j);
      if (out.length > PATCH_ROWS) return null;
    }
    return out;
  }
  // Redraws the old and new areas of the changed rows into the layer; false when it cannot.
  function patchLayer(g, a, m, alpha, before, after, changed, waivedCount, o, plan) {
    const z = P.size(a.scale, "pcb");
    const grow = Math.max(40, z.screen + Math.SQRT2 * overviewCell(z) + 6) / a.scale, boxes = [];
    for (const j of changed) for (const r of [before[j], after[j]]) {
      const b = r?.row?.box;
      if (!b) return false;
      boxes.push([b[0] - grow, b[1] - grow, b[2] + grow, b[3] + grow]);
    }
    const W = g.canvas.width, H = g.canvas.height;
    // Whole rows of pixels: a stroke path's antialiasing can change along the scanlines of an edit.
    const bands = boxes.map(b => {
      const ys = [];
      for (const x of [b[0], b[2]]) for (const y of [b[1], b[3]]) ys.push(m.b * x + m.d * y + m.f);
      return [Math.max(0, Math.floor(Math.min(...ys))), Math.min(H, Math.ceil(Math.max(...ys)))];
    }).filter(([y, b]) => b > y).sort((p, q) => p[0] - q[0]), rects = [];
    for (const [y, b] of bands) { const last = rects.at(-1); if (last && y <= last[3]) last[3] = Math.max(last[3], b); else rects.push([0, y, W, b]); }
    if (rects.reduce((n, r) => n + r[3] - r[1], 0) > H * .35) return false;
    let scratch;
    try { scratch = new OffscreenCanvas(W, H); } catch { return false; }
    const s = scratch.getContext("2d");
    if (!s) return false;
    // Project the padded box on both axes, since the view may be rotated.
    const span = q => { const ys = []; for (const x of [q[0] - grow, q[2] + grow]) for (const y of [q[1] - grow, q[3] + grow]) ys.push(m.b * x + m.d * y + m.f); return [Math.min(...ys), Math.max(...ys)]; };
    const spans = after.map(r => r.row.box ? span(r.row.box) : null);
    for (const [x, y, r, b] of rects) {
      const pick = (from, to) => { const out = []; for (let k = from; k < to; k++) { const q = spans[k]; if (q && q[0] <= b && q[1] >= y) out.push(after[k]); } return out; };
      s.setTransform(1, 0, 0, 1, 0, 0); s.clearRect(0, 0, W, H);
      s.setTransform(m); s.globalAlpha = alpha;
      const rows = pick(waivedCount, after.length), waived = pick(0, waivedCount), included = new Set([...rows, ...waived]);
      drawOverview(s, a, rows, o, plan, null, r => included.has(r));
      s.setTransform(1, 0, 0, 1, 0, 0); s.globalAlpha = 1;
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.clearRect(x, y, r - x, b - y);
      g.drawImage(scratch, x, y, r - x, b - y, x, y, r - x, b - y);
    }
    scratch.width = scratch.height = 1;
    return true;
  }
  // Once frames have stopped for 250 ms the layer is redrawn whole on the next frame.
  function settleLayer(L) {
    if (L.timer || typeof setTimeout !== "function") return;
    const check = () => {
      const quiet = clock() - L.used;
      if (quiet < 250) { L.timer = setTimeout(check, 260 - quiet); return; }
      L.timer = 0; L.stale = true;
      globalThis.AtriumNavHost?.redraw?.();
    };
    L.timer = setTimeout(check, 260);
  }
  // Close markers merged (problem-marks.js cluster): errors outrank warnings, warnings waived ones.
  const RANK_OF = {error: 0, warning: 1, waived: 2}, atOf = r => r.v.at || r.v.otherAt;
  const scoreOf = r => r.score;
  function coarseKey(v, cell) {
    const at = v.at || v.otherAt;
    return at && Math.floor(at[0] / cell) + "," + Math.floor(at[1] / cell);
  }
  function addIndexedMember(group, row, i) {
    if (!row) return group;
    if (!group) return {first: i, rep: row, members: [row], at: atOf(row), score: row.score};
    group.members.push(row);
    if (row.score > group.score) { group.rep = row; group.at = atOf(row); group.score = row.score; }
    return group;
  }
  function indexedCells(owner, entry, exceptions, cell) {
    const prior = owner.index;
    if (prior?.entry === entry && prior.exceptions === exceptions && prior.cell === cell) return prior;
    const count = entry?.rows.length || 0, total = count + (exceptions?.rows.length || 0);
    const next = new Int32Array(total).fill(-1), ids = new Int32Array(total).fill(-1);
    const columns = new Map(), cells = [], anchorless = [];
    const active = owner.rows.get(entry), waived = owner.rows.get(exceptions);
    const raw = i => i < count ? entry.rows[i] : exceptions.rows[i - count];
    for (let i = 0; i < total; i++) {
      const row = raw(i);
      if (!row) continue;
      const at = row.v.at || row.v.otherAt;
      if (!at) { anchorless.push(i); continue; }
      const x = Math.floor(at[0] / cell), y = Math.floor(at[1] / cell);
      let column = columns.get(x);
      if (!column) columns.set(x, column = new Map());
      let bin = column.get(y);
      if (!bin) {
        bin = {id: cells.length, first: i, last: i, witness: -1, bounds: null, complete: true, group: null};
        column.set(y, bin); cells.push(bin);
      } else { next[bin.last] = i; bin.last = i; }
      ids[i] = bin.id;
      // On a later band, the pane may already have filtered all members.
      // Build those groups in the same pass, without consulting a new object.
      if (bin.complete) {
        const row = i < count ? active?.[i] : waived?.[i - count];
        if (row === undefined) { bin.complete = false; bin.group = undefined; }
        else bin.group = addIndexedMember(bin.group, row, i);
      }
      // Union is only a rejection bound. Long objects and gaps between objects
      // still use their own boxes before a whole cell is admitted.
      const b = row.box;
      if (b && b[0] <= b[2] && b[1] <= b[3]) {
        const a = bin.bounds;
        if (!a) bin.bounds = b.slice();
        else {
          a[0] = Math.min(a[0], b[0]); a[1] = Math.min(a[1], b[1]);
          a[2] = Math.max(a[2], b[2]); a[3] = Math.max(a[3], b[3]);
        }
      } else if (b) bin.bounds = [-Infinity, -Infinity, Infinity, Infinity];
    }
    return owner.index = {entry, exceptions, cell, cells, count, raw, next, ids, anchorless};
  }
  function indexedRows(index, o, eligibility) {
    const {entry, exceptions, count, cells, raw, next, ids, anchorless} = index, view = o.view;
    const resolved = e => {
      let rows = eligibility.rows.get(e);
      if (!rows && e) eligibility.rows.set(e, rows = []);
      return rows;
    };
    const active = resolved(entry), waived = resolved(exceptions);
    const resolve = i => {
      const list = i < count ? active : waived, k = i < count ? i : i - count;
      let row = list[k];
      if (row === undefined) list[k] = row = rowView(raw(i), o.hidden, o.selectable, true);
      return row;
    };
    const groups = [], outlines = [], admitted = new Uint8Array(cells.length);
    for (const bin of cells) {
      if (!reaches(bin.bounds, view)) continue;
      if (bin.witness < 0 || !reaches(raw(bin.witness).box, view)) {
        bin.witness = bin.first;
        while (bin.witness >= 0 && !reaches(raw(bin.witness).box, view)) bin.witness = next[bin.witness];
        if (bin.witness < 0) continue;
      }
      let group = bin.group;
      if (group === undefined) {
        group = null;
        for (let i = bin.first; i >= 0; i = next[i])
          group = addIndexedMember(group, resolve(i), i);
        bin.group = group;
      }
      if (group) { admitted[bin.id] = 1; groups.push(group); }
    }
    // A hidden early member must not reorder a cell ahead of an earlier
    // eligible member in another cell. Ties follow active rows then waivers.
    groups.sort((a, b) => a.first - b.first);
    let hasRows = groups.length > 0;
    for (const i of anchorless) {
      if (!reaches(raw(i).box, view)) continue;
      const row = resolve(i);
      if (!row) continue;
      hasRows = true;
      if (i < count) outlines.push(row);
    }
    // The full 2D raster cache still compares ordered rows. The direct GPU,
    // strip, and pointer routes only consume the smaller cell/outline plan.
    const include = (row, i) => ids[i] >= 0 ? admitted[ids[i]] : reaches(row.box, view);
    const rowLists = () => ({rows: rowViews(entry, o, eligibility.rows, include),
      waived: rowViews(exceptions, o, eligibility.rows, (row, i) => include(row, i + count))});
    return {groups, outlines, rowLists, hasRows};
  }
  function coarsePlan(doc, defs, list, o, frame, z, cell, eligibility) {
    const entry = rowsOf(doc, defs, list, o.rev, o.preview, o.publication);
    const exceptions = rowsOf(doc, defs, o.waived, o.rev, o.preview, o.publication);
    let groups, outlines, rowLists, hasRows, rows, waived;
    if (eligibility && o.view && (entry?.rows.length || 0) + (exceptions?.rows.length || 0) > LOD_ROWS) {
      ({groups, outlines, rowLists, hasRows} = indexedRows(indexedCells(eligibility, entry, exceptions, cell), o, eligibility));
    } else {
      const relevant = new Set(), view = o.view;
      if (view) for (const e of [entry, exceptions]) for (const r of e?.rows || []) {
        if (!r || !reaches(r.box, view)) continue;
        const key = coarseKey(r.v, cell);
        if (key) relevant.add(key);
      }
      const members = view && (r => reaches(r.box, view) || relevant.has(coarseKey(r.v, cell)));
      rows = rowViews(entry, o, eligibility?.rows, members);
      waived = rowViews(exceptions, o, eligibility?.rows, members);
      groups = P.cells([...rows, ...waived], atOf, 1, cell, scoreOf);
      outlines = rows.filter(r => !atOf(r));
    }
    const ordinary = [], single = [], inspected = [];
    const inspect = [], clustered = [], reach = P.hit(z.screen * 1.2);
    const mark = (row, members) => ({row, score: row.score, v: row.v, at: atOf(row), live: row.live,
      members, reach, n: 1, hot: row.v === o.hover, pinned: row.v === o.focused});
    for (const group of groups) {
      if (group.members.length === 1) {
        const row = group.rep, m = mark(row, group.members);
        if (m.hot || m.pinned) { inspect.push(row); inspected.push(m); }
        else { single.push(m); if (!row.v.waived) outlines.push(row); }
        continue;
      }
      clustered.push(group);
      const row = P.visibleWinner(group, frame, atOf, scoreOf);
      if (row.v !== o.hover && row.v !== o.focused) ordinary.push(mark(row, group.members));
      if (o.hover || o.focused) for (const member of group.members) {
        if (member.v !== o.hover && member.v !== o.focused) continue;
        inspect.push(member); inspected.push(mark(member, group.members));
      }
    }
    // Painting singles first and sorting group styles by severity keeps overlap ties deterministic,
    // even when a proxy changes at a distant edge. The picker uses this same order.
    ordinary.sort((a, b) => markerStyle(a) - markerStyle(b));
    inspected.sort((a, b) => Number(a.pinned) - Number(b.pinned));
    return {rows, waived, rowLists, hasRows, overview: true, cell, clustered, ordinary, single, outlines, inspected, inspect,
      marks: [...single, ...ordinary, ...inspected]};
  }
  const mergeAt = (rows, scale) => P.cluster(rows, atOf, scale, "pcb", r => RANK_OF[severity(r.v)]);
  function detailMarks(rows, waived, o, z, scale) {
    const asMark = c => {
      const f = c.members.find(r => r.v === o.focused), row = f || c.rep, v = row.v;
      const hot = c.members.some(m => m.v === o.hover), pinned = !!f;
      return {row, v, members: c.members, at: f ? atOf(f) : c.at,
        live: row.live, n: c.members.length, hot, pinned, reach: P.hit(z.screen * 1.2)};
    };
    const live = mergeAt([...rows.filter(r => r.live), ...waived.filter(r => r.live)], scale).map(asMark);
    const dim = mergeAt([...waived.filter(r => !r.live), ...rows.filter(r => !r.live)], scale).map(asMark);
    const marks = [...live.filter(m => m.v.waived), ...dim, ...live.filter(m => !m.v.waived)];
    return [...marks.filter(m => !m.hot && !m.pinned), ...marks.filter(m => m.hot || m.pinned)];
  }
  function drawRows(ctx, a, rows, o, marks) {
    const {scale} = a;
    const px = 1 / scale, z = P.size(scale, "pcb");
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    // Offending primitives: a subtle outline; hovered or pinned ones a little stronger (drawn last).
    const drawn = new Set(), hotRows = rows.filter(r => r.v === o.focused || r.v === o.hover);
    for (const pass of [rows.filter(r => !hotRows.includes(r)), hotRows]) for (const {v, shapes: sh, live} of pass) {
      const hot = v === o.focused || v === o.hover;
      for (const s of sh) {
        const k = (s.item?.id || "") + (s.kind === "pad" ? "@" + s.at[0] + "," + s.at[1] : "") + (hot ? "!" : "");
        if (drawn.has(k)) continue; drawn.add(k);
        ctx.save(); ctx.globalAlpha = live ? 1 : .5; outline(ctx, s, px, live ? COLORS[severity(v)] : COLORS.dim, hot); ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    // Detail lines between the two closest points, one per violation.
    for (const {v, live} of [...rows.filter(r => !hotRows.includes(r)), ...hotRows]) {
      if (!(v.otherAt && v.at && near(v.at, v.otherAt) > 1e-6)) continue;
      const hot = v === o.hover || v === o.focused;
      ctx.globalAlpha = live ? (hot ? 1 : .6) : .35;
      ctx.strokeStyle = COLORS[severity(v)]; ctx.lineWidth = (hot ? 1.5 : 1) * px; ctx.setLineDash([4 * px, 3 * px]);
      ctx.beginPath(); ctx.moveTo(v.at[0], v.at[1]); ctx.lineTo(v.otherAt[0], v.otherAt[1]); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const m of marks) {
      const {v, at, live, hot, pinned} = m;
      ctx.globalAlpha = v.waived ? .75 : live ? 1 : .45;
      drawMarker(ctx, v, at, z, {hot, pinned, live});
      P.count(ctx, a, at[0], at[1], z, m.n, {ink: live ? COLORS[severity(v)] : COLORS.dim, halo: COLORS.halo});
      // The pinned (inspected) violation carries its measured value; the others stay quiet.
      if (pinned && live) {
        const text = valueText(v, o.unit || "mm"), r = z.r * 1.2;
        if (text) {
          ctx.save(); ctx.translate(at[0] + r * 1.6, at[1] - r * 1.3); ctx.scale(px, px);
          if (P.mirrored(ctx, a)) ctx.scale(-1, 1);
          ctx.font = "600 " + Math.round(Math.max(11, z.screen * 1.1)) + "px system-ui, sans-serif"; ctx.textBaseline = "bottom";
          ctx.lineWidth = 3; ctx.strokeStyle = COLORS.halo; ctx.strokeText(text, 0, 0); ctx.fillStyle = COLORS.ring; ctx.fillText(text, 0, 0);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  // The overview of many violations: one marker per cell of 12 px or more (it widens as markers grow
  // with zoom; the most severe, live first) and every
  // stroke style batched into one path, so a frame costs a few dozen canvas calls instead of
  // thousands. Pads outline as rings. The hovered and pinned violations draw in full on top.
  const overviewCell = z => Math.max(12, z.screen * 1.7);
  function markerBorders(path, st, r) {
    for (const at of st.list) appendMarkerBorder(path, at, r, st.sev);
  }
  function markerGlyphs(path, st, r, px) {
    for (const at of st.list) appendMarkerInterior(path, at, r, st.sev, px, st.x);
  }
  // A track outline may move while every marker stays in place until DRC publishes again.
  // Retain one pair of world-space paths per style. The ordered, filtered cell winners decide
  // reuse on every paint, including a pan strip, zoom, waiver, hover or selection filter change.
  const markerPaths = new WeakMap();
  function pathsFor(ctx, key, st, r, px) {
    if (!ctx.canvas || typeof Path2D !== "function") return null;
    let styles = markerPaths.get(ctx);
    if (!styles) markerPaths.set(ctx, styles = new Map());
    const prev = styles.get(key);
    if (prev?.r === r && prev.xy.length === 2 * st.list.length &&
        st.list.every((at, i) => prev.xy[2 * i] === at[0] && prev.xy[2 * i + 1] === at[1])) return prev;
    const border = new Path2D(), glyph = new Path2D(), xy = [];
    markerBorders(border, st, r); markerGlyphs(glyph, st, r, px);
    for (const at of st.list) xy.push(at[0], at[1]);
    const next = {border, glyph, xy, r};
    styles.set(key, next);
    return next;
  }
  const severityAt = [null, "waived", "warning", "error"];
  const markerStyle = ({score, row}) => (score << 1) + Number(row.cross);
  const padKeys = new WeakMap();
  function outlineKey(shape, published) {
    const id = String(shape.item?.id || "");
    if (shape.kind !== "pad") return id;
    if (!published) return id + "@" + shape.at[0] + "," + shape.at[1];
    let key = padKeys.get(shape);
    if (key === undefined) padKeys.set(shape, key = id + "@" + shape.at[0] + "," + shape.at[1]);
    return key;
  }
  function overviewMarks(rows, waived, o, z, scale) {
    const priority = r => r.score + (r.v === o.focused ? 32 : r.v === o.hover ? 16 : 0);
    const cells = P.cells([...waived, ...rows], atOf, scale, overviewCell(z), priority);
    const ordinary = [], hot = [], reach = P.hit(z.screen * 1.2);
    for (const c of cells) {
      const row = c.rep, v = row.v, pinned = v === o.focused, hovered = v === o.hover;
      c.row = row; c.v = v; c.live = row.live; c.reach = reach;
      c.score &= 15; c.n = c.members.length; c.pinned = pinned; c.hot = hovered;
      (pinned || hovered ? hot : ordinary).push(c);
    }
    return {marks: [...ordinary, ...hot], ordinary, hot, onTop: new Set(hot.map(m => m.row))};
  }
  function drawOverview(ctx, a, rows, o, plan, strips = null, included = null) {
    const px = 1 / a.scale, hot = [], drawn = new Set();
    const lineStyles = new Map(), fixedStyles = [], groups = [], z = P.size(a.scale, "pcb");
    const inDamage = row => (!included || included(row)) && (!strips || strips.some(box => reaches(row.row.box, box)));
    if (plan.cell) {
      if (plan.outlines.length || plan.single.length)
        drawRows(ctx, a, plan.outlines.filter(inDamage), o, plan.single.filter(m => inDamage(m.row)));
      drawOverviewGlyphs(ctx, z, px, plan.ordinary, inDamage);
      if (plan.inspected.length) drawRows(ctx, a, plan.inspect.filter(inDamage), o, plan.inspected.filter(m => inDamage(m.row)));
      return;
    }
    // Even a clipped outline fixes its style's place in the stroke order.
    const push = (slots, slot, kind, color, alpha, width, shape, draw) => {
      let group = slots[slot];
      if (!group) { group = slots[slot] = {kind, color, alpha, width, list: []}; groups.push(group); }
      if (draw) group.list.push(shape);
    };
    for (const r of rows) {
      const {v, live, sev} = r;
      if (plan.hot.length && plan.onTop.has(r)) { if (inDamage(r)) hot.push(r); continue; }
      const tag = live ? r.score & 3 : 0, color = live ? COLORS[sev] : COLORS.dim;
      const draw = inDamage(r);
      for (const shape of r.shapes) {
        const key = outlineKey(shape, o.publication);
        if (drawn.has(key)) continue; drawn.add(key);
        if (shape.kind === "line") {
          const width = (shape.width || 0) + 4 * px;
          let slots = lineStyles.get(width);
          if (!slots) lineStyles.set(width, slots = []);
          push(slots, tag, "line", color, r.live ? .3 : .15, width, shape, draw);
        } else {
          const box = shape.kind === "box";
          push(fixedStyles, tag + (box ? 4 : 0), box ? "box" : "ring", color, r.live ? OUTLINE_ALPHA : OUTLINE_ALPHA / 2, px, shape, draw);
        }
      }
      if (v.otherAt && v.at && near(v.at, v.otherAt) > 1e-6) push(fixedStyles, tag + 8, "detail", color, live ? .6 : .35, px, v, draw);
    }
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.setLineDash([]);
    for (const g of groups) {
      if (!g.list.length) continue;
      ctx.globalAlpha = g.alpha; ctx.strokeStyle = g.color; ctx.lineWidth = g.width; ctx.beginPath();
      if (g.kind === "line") for (const s of g.list) { ctx.moveTo(s.points[0][0], s.points[0][1]); for (let k = 1; k < s.points.length; k++) ctx.lineTo(s.points[k][0], s.points[k][1]); if (s.closed) ctx.closePath(); }
      else if (g.kind === "ring") for (const s of g.list) {
        const r = (s.kind === "pad" ? Math.hypot(s.w, s.h) / 2 : Math.max(s.r, 3 * px)) + 1.5 * px;
        ctx.moveTo(s.at[0] + r, s.at[1]); ctx.arc(s.at[0], s.at[1], r, 0, Math.PI * 2);
      }
      else if (g.kind === "box") { ctx.setLineDash([5 * px, 3 * px]); for (const s of g.list) ctx.rect(s.box[0], s.box[1], s.box[2] - s.box[0], s.box[3] - s.box[1]); }
      else { ctx.setLineDash([4 * px, 3 * px]); for (const v of g.list) { ctx.moveTo(v.at[0], v.at[1]); ctx.lineTo(v.otherAt[0], v.otherAt[1]); } }
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
    drawOverviewGlyphs(ctx, z, px, plan.ordinary, inDamage);
    if (plan.hot.length) drawRows(ctx, a, hot, o, plan.hot.filter(m => inDamage(m.row)));
  }
  // Markers by style: halo, outline and glyph, each one path.
  function drawOverviewGlyphs(ctx, z, px, ordinary, inDamage) {
    if (!ordinary.length) return;
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    const styles = new Map();
    for (const mark of ordinary) {
      const {row, score, at} = mark;
      const rank = score & 3, sev = severityAt[rank];
      const live = row.live, waived = !(score & 4), x = row.cross, key = markerStyle(mark);
      let st = styles.get(key);
      if (!st) styles.set(key, st = {sev, x: x && sev !== "waived", live, waived, list: []});
      if (inDamage(row)) st.list.push(at);
    }
    const {r, w} = z;
    for (const [key, st] of styles) {
      if (!st.list.length) continue;
      const paths = pathsFor(ctx, key, st, r, px), color = st.live ? COLORS[st.sev] : COLORS.dim;
      ctx.globalAlpha = st.waived ? .75 : st.live ? 1 : .45;
      ctx.setLineDash(st.sev === "waived" ? [2.5 * px * w, 2 * px * w] : []);
      if (!paths) { ctx.beginPath(); markerBorders(ctx, st, r); }
      ctx.lineWidth = S.halo * px * w; ctx.strokeStyle = COLORS.halo;
      if (paths) ctx.stroke(paths.border); else ctx.stroke();
      ctx.lineWidth = S.line * px * w; ctx.strokeStyle = color;
      if (paths) ctx.stroke(paths.border); else ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = color;
      if (paths) { if (st.x) ctx.stroke(paths.glyph); else ctx.fill(paths.glyph); }
      else { ctx.beginPath(); markerGlyphs(ctx, st, r, px); if (st.x) ctx.stroke(); else ctx.fill(); }
    }
    ctx.restore();
  }
  const revOf = host => { try { return host?.revision?.() ?? null; } catch { return null; } };
  // drc-view.js renderer: null when markers are off.
  function renderFor(host, doc, list, {focused = null, hover = null, waived = null, publication = null} = {}) {
    if (!visible || !list?.length && !waived?.length) return null;
    return {overlay: overlay(doc, host.defs(), list || [], {host, focused, hover, waived, publication, unit: host.units?.() || "mm", rev: revOf(host)})};
  }

  // ------------------------------------------------------------------ pointer
  // The live marker under a screen point of a pane, within the drawn marker's reach (P.hit). Markers
  // merged on screen answer as one: the group's worst (and first) violation; F8 still steps through each.
  function markerAt(host, pane, list, clientX, clientY, waived, publication) { return groupAt(host, pane, list, clientX, clientY, waived, publication)?.v || null; }
  // The same marker as a group, with lazily projected world boxes for the hover card.
  function groupAt(host, pane, list, clientX, clientY, waived, publication = null, focused = null, hover = null) {
    if (!visible || !list?.length && !waived?.length) return null;
    const doc = host.docById?.(pane.docId) || host.doc();
    if (doc?.kind !== "pcb") return null;
    const b = pane.canvas.getBoundingClientRect();
    const frame = P.paneFrame(pane, b);
    const plan = markerPlan(doc, host.defs(), list || [], {host, rev: revOf(host), waived, publication, focused, hover}, frame);
    const mark = P.pick(plan, clientX - b.left, clientY - b.top);
    if (!mark) return null;
    const rows = mark.members.filter(r => r.live), members = rows.map(r => r.v), K = globalThis.AtriumChecks;
    return {v: mark.v, members, at: mark.at, reach: mark.reach,
      get boxes() { return rows.map(r => r.row.box).filter(Boolean); },
      get findings() { return K ? members.map(v => K.fromDRC(v, doc.id)) : []; }};
  }
  // Tooltip text: {title, measured, objects[], where}.
  function describe(v, unit = "mm") {
    const T = R()?.types?.[v.type], rule = T?.title || v.typeTitle || v.type;
    const f = x => { try { return R().units.format(x, unit, true); } catch { return x.toFixed(3) + " mm"; } };
    let measured = "";
    if (v.delay) measured = "Measured " + v.delay.actual.toFixed(2) + " ps · required " + (v.delay.limit === "max" ? "≤ " : "≥ ") + v.delay.required.toFixed(2) + " ps" + (v.delay.target != null ? " (target " + v.delay.target.toFixed(1) + " ps)" : "");
    else if (v.actual != null && v.required != null) measured = "Measured " + (v.what ? v.what.toLowerCase() + " " : "") + f(v.actual) + " · required " + (v.limit === "max" ? "≤ " : "≥ ") + f(v.required) + (v.target != null ? " (target " + f(v.target) + ")" : "");
    else if (v.detail) measured = v.detail + (v.actual != null ? " " + f(v.actual) : "");
    else if (v.actual != null) measured = "Measured " + f(v.actual);
    const objects = String(v.title || "").split(/\s+↔\s+/).filter(Boolean);
    const at = v.at || v.otherAt;
    return {title: (v.ruleName || rule) + " · " + rule, measured, detail: v.detail && v.detail !== measured ? v.detail : "", objects,
      where: at ? "at " + f(at[0]) + ", " + f(at[1]) : ""};
  }
  // ------------------------------------------------------------------ status line and clicks
  // "Pad A2-2 (Multi-Layer) A2" → "A2.2"; "Track (Top Layer) GND" → "Track GND".
  function shortObject(text) {
    const m = /^(.*?) \(([^)]*)\)(?: (.+))?$/.exec(String(text || "").trim());
    if (!m) return String(text || "").trim();
    const what = m[1], net = m[3] || "", pad = /^Pad (.+)-([^-]+)$/.exec(what);
    return pad ? pad[1] + "." + pad[2] : what + (net ? " " + net : "");
  }
  // One quiet status-bar line: "Clearance 0.186 < 0.2 mm · A2.2 ↔ Track A1 · click for details".
  function statusText(v, unit = "mm", {hint = true} = {}) {
    if (!v) return "";
    const rule = R()?.types?.[v.type]?.title || v.typeTitle || v.ruleName || v.type;
    const n = x => { try { return String(R().units.value(x, unit)); } catch { return String(+x.toFixed(4)); } };
    let value = "";
    if (v.delay) value = v.delay.actual.toFixed(1) + (v.delay.limit === "max" ? " > " : " < ") + v.delay.required.toFixed(1) + " ps";
    else if (v.actual != null && v.required != null) value = n(v.actual) + (v.limit === "max" ? " > " : " < ") + n(v.required) + " " + (unit === "mil" ? "mil" : "mm");
    else if (v.detail) value = String(v.detail);
    const objects = String(v.title || "").split(/\s+↔\s+/).filter(Boolean).map(shortObject).join(" ↔ ");
    return [(v.waived ? "Waived · " : "") + rule + (value ? " " + value : ""), objects, hint ? "click for details" : ""].filter(Boolean).join(" · ");
  }
  const setLine = text => P.hoverStatus("drc", text);
  // While routing, dragging or placing, feedback stays inline (the router's conflict halo):
  // no text over the board and no status line in place of the tool's own prompt.
  const busy = host => { try { return host?.tool?.() !== "select" || !!host?.liveRoute?.() || !!host?.drag?.(); } catch { return false; } };
  // Pointer over the board (drc-view.js): v is the marker under the pointer or null.
  function hovered(host, v) {
    setLine(!v || busy(host) ? null : statusText(v, host?.units?.() || "mm"));
  }
  // Left click on a marker in the Select tool (drc-view.js has pinned it). Returns true when the
  // click was taken (the editor then does not select the copper under the marker).
  let click = 0;
  function clicked(host, v) {
    const serial = ++click, doc = host.doc?.(), canvas = host.canvas?.();
    inspector(host).then(I => {
      if (serial === click && host.doc?.() === doc && host.canvas?.() === canvas) I?.open(host, v);
    }, err => host.info?.(err.message));
    return true;
  }
  // A click on the board away from any marker closes the inspector.
  function clickedEmpty() { click++; globalThis.AtriumDRCInspector?.close?.({reason: "canvas"}); }
  function inspector(host) {
    if (globalThis.AtriumDRCInspector) return Promise.resolve(AtriumDRCInspector);
    const L = globalThis.AtriumLazy;
    return L?.modules?.().includes("AtriumDRCInspector") ? L.need("AtriumDRCInspector").then(() => globalThis.AtriumDRCInspector) : Promise.resolve(null);
  }
  // Zoom the active view to a violation (Messages row chosen).
  function zoom(host, v) {
    const doc = host?.doc?.();
    if (!doc || doc.kind !== "pcb" || !v) return false;
    const defs = host.defs(), b = box(doc, defs, v, geometry(doc, defs, revOf(host)).ids);
    if (!b) return false;
    host.zoomTo?.(C().grow(b, Math.max(.5, .25 * Math.max(b[2] - b[0], b[3] - b[1]))));
    return true;
  }

  // Fly the camera to a violation (next / previous violation): at least `min` mm in view so the
  // neighbourhood stays readable. Uses AtriumCamera (view history, animated fly-to) when loaded.
  function fly(host, v, {min = 4} = {}) {
    const doc = host?.doc?.();
    if (!doc || doc.kind !== "pcb" || !v) return false;
    const defs = host.defs();
    let b = box(doc, defs, v, geometry(doc, defs, revOf(host)).ids);
    if (!b) return false;
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, hw = Math.max((b[2] - b[0]) / 2 * 1.3, min / 2), hh = Math.max((b[3] - b[1]) / 2 * 1.3, min / 2);
    b = [cx - hw, cy - hh, cx + hw, cy + hh];
    // AtriumCamera.flyTo takes a camera ({cx, cy, scale}); the view's own canvas gives the framing.
    const Cam = globalThis.AtriumCamera, view = host.view?.(), canvas = host.canvas?.();
    if (typeof Cam?.flyTo === "function" && view?.camera && C()?.cameraFor) {
      try {
        const to = C().cameraFor(b, canvas?.clientWidth || 800, canvas?.clientHeight || 600, view.camera());
        if (to && Number.isFinite(to.cx) && Number.isFinite(to.cy) && Number.isFinite(to.scale)) { Cam.settle?.(); Cam.flyTo(to, {view}); return true; }
      } catch { /* fall back to a jump */ }
    }
    host.zoomTo?.(b);
    return true;
  }

  // ------------------------------------------------------------------ online DRC: spatial pick
  // Items whose boxes overlap any region. A grid follows the current map of item boxes. A full
  // check replaces it after dependency changes; ordinary journal edits update only dirty ids.
  const picks = new WeakMap();
  function pick(doc, boxes, regions, dirty) {
    const Sp = globalThis.AtriumSpatial;
    if (!Sp) return doc.items.filter(i => { const b = boxes.get(i.id); return b && regions.some(q => C().overlaps(b, q)); });
    let st = picks.get(boxes);
    const build = () => { st = {ids: new Set(boxes.keys()), extra: new Set()}; st.index = Sp.create([...st.ids], id => boxes.get(id) || null, 2); picks.set(boxes, st); };
    if (!st || !dirty) build();
    else {
      // The grid inserts only on creation: new ids are tested one by one until there are many.
      for (const id of dirty) if (st.ids.has(id)) { st.index.update(id); if (!boxes.has(id)) st.ids.delete(id); } else if (boxes.has(id)) st.extra.add(id); else st.extra.delete(id);
      if (st.extra.size > 256) build();
    }
    const want = new Set();
    for (const q of regions) for (const id of st.index.query(q)) want.add(id);
    for (const id of st.extra) { const b = boxes.get(id); if (b && b.every(Number.isFinite) && regions.some(q => Sp.overlaps(b, q))) want.add(id); }
    return doc.items.filter(i => want.has(i.id));
  }

  // ------------------------------------------------------------------ host
  function setVisible(on, host) {
    visible = !!on; save(); C()?.setChecked("drc-markers", visible); host?.invalidate?.();
    if (!visible) { setLine(null); releaseLayers(); }
    host?.info?.(visible ? "DRC markers shown." : "DRC markers hidden. Messages still lists the violations.");
  }
  function attach(host) {
    host.registerAction("drc-markers", () => setVisible(!visible, host));
    C()?.setChecked("drc-markers", visible);
  }
  globalThis.AtriumNavCommon?.ready?.(attach);

  return Object.freeze({overviewStats: () => ({...layerStats}), COLORS, glyph, severity, shapes, box, visibleList, overlay, renderFor, markerAt, groupAt, describe, statusText, shortObject, zoom, fly, pick,
    hovered, clicked, clickedEmpty, setLine, visible: () => visible, setVisible, attach});
})();
