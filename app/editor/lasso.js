"use strict";
// Lasso selection (Altium: Edit › Select › Lasso Select, S then L).
//
// Drag a freeform outline around objects; on release every object fully inside it is
// selected. Clicks without a drag add polygon vertices instead; Enter, a double click or a
// click on the first vertex closes the outline. Shift adds to the selection, Ctrl/Cmd removes
// from it, otherwise the lasso replaces it. Escape or right-click cancels. The selection
// filter (pcb-edit.js) and layer visibility apply through the host's selectable().
// Works on schematics and boards. The live outline is drawn by a canvas overlay: dashed
// while open, with the objects that would be selected highlighted.
//
// Pure helpers (tests): AtriumLasso.contains(poly, p), AtriumLasso.inside(poly, points),
// AtriumLasso.pick(doc, defs, poly, {selectable, query}) → ids, AtriumLasso.combine(current, ids, mode).
globalThis.AtriumLasso = (() => {
  const A = () => globalThis.Atrium;
  const G = () => globalThis.AtriumGeometry;
  // Even-odd point in polygon.
  function contains(poly, p) { return G().inRing(p, poly); }
  // Every point inside, and (for polylines) no segment leaves through an edge of a concave outline.
  function inside(poly, points, segments = true) {
    if (poly.length < 3 || !points.length) return false;
    for (const p of points) if (!contains(poly, p)) return false;
    if (segments && points.length > 1) for (let k = 1; k < points.length; k++)
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (G().strictCrossing(points[k - 1], points[k], poly[i], poly[j])) return false;
    return true;
  }
  function bbox(poly) {
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of poly) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    return b;
  }
  // Points that stand for an item: its outline points; tracks and wires keep their order so
  // their segments are checked too. Parts use their drawn geometry (pads, body, pins).
  function pointsOf(item, doc, defs) {
    try { return A().itemPoints(item, defs?.get?.(item.def), doc.kind) || []; } catch { return item.points || (Number.isFinite(item.x) ? [[item.x, item.y]] : []); }
  }
  function pick(doc, defs, poly, {selectable = null, query = null} = {}) {
    if (!doc || poly.length < 3) return [];
    const b = bbox(poly), cand = query ? query(b) : doc.items;
    const out = [];
    for (const i of cand) {
      if (selectable && !selectable(i)) continue;
      const pts = pointsOf(i, doc, defs);
      if (!pts.length) continue;
      if (pts.some(p => p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3])) continue;
      if (inside(poly, pts, !!i.points)) out.push(i.id);
    }
    return out;
  }
  function combine(current, ids, mode) {
    if (mode === "add") return [...new Set([...current, ...ids])];
    if (mode === "remove") { const drop = new Set(ids); return current.filter(id => !drop.has(id)); }
    return ids.slice();
  }

  // ------------------------------------------------------------------ interactive tool
  let host = null, session = null;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function modeOf(e) { return e.ctrlKey || e.metaKey ? "remove" : e.shiftKey ? "add" : "replace"; }
  function activePane() { return host.panes().find(p => p.active) || null; }
  function worldAt(pane, e) { const r = pane.canvas.getBoundingClientRect(); return pane.view.screenToWorld([e.clientX - r.left, e.clientY - r.top]); }
  function preview() {
    if (!session) return [];
    const poly = session.cursor && !session.dragging ? [...session.points, session.cursor] : session.points;
    if (poly.length < 3) return [];
    const d = host.doc(), defs = host.defs(), v = host.view();
    return pick(d, defs, poly, {selectable: i => host.selectable(i), query: b => v.query ? v.query(d, defs, b) : d.items});
  }
  function hint() {
    const m = session?.mode === "add" ? " (adding)" : session?.mode === "remove" ? " (removing)" : "";
    host.info(session?.points.length ? "Lasso" + m + ": " + session.hits.length + " object" + (session.hits.length === 1 ? "" : "s") + " inside · release, Enter or double-click to select · Escape cancels"
      : "Lasso select: drag around objects, or click to place outline points. Shift adds, Ctrl/⌘ removes. Escape cancels.");
  }
  function refresh() { if (session) session.hits = preview(); hint(); host.redraw(); }
  function start() {
    if (session) stop(false);
    session = {points: [], cursor: null, dragging: false, down: null, mode: "replace", hits: [], doc: host.currentId()};
    const pane = activePane();
    if (pane) pane.canvas.style.cursor = "crosshair";
    hint();
  }
  function stop(apply) {
    const s = session; if (!s) return;
    s.cursor = null;
    const ids = apply && s.doc === host.currentId() && s.points.length >= 3 ? preview() : [];
    session = null;
    for (const p of host.panes()) p.canvas.style.cursor = "";
    if (apply && s.doc === host.currentId()) {
      const next = combine(host.selection(), ids, s.mode);
      host.select(next, next[0] || null);
      host.info(ids.length ? (s.mode === "remove" ? ids.length + " removed by lasso" : ids.length + " selected by lasso") + " · " + next.length + " in selection" : "The lasso enclosed nothing selectable.");
    } else if (!apply) host.info("Lasso cancelled.");
    host.redraw();
  }
  function close() {
    if (!session) return;
    if (session.points.length < 3) { stop(false); return; }
    stop(true);
  }
  function onDown(e) {
    if (!session) return;
    const pane = activePane();
    if (!pane || e.target !== pane.canvas) return;
    if (e.button === 2) { e.preventDefault(); e.stopPropagation(); stop(false); return; }
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();
    const p = worldAt(pane, e), px = 1 / (pane.view.scale?.() || 1);
    session.mode = modeOf(e);
    if (session.points.length >= 3 && dist(p, session.points[0]) < 8 * px) { close(); return; }
    session.down = {p, x: e.clientX, y: e.clientY};
    if (!session.points.length) session.points.push(p);
    try { pane.canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic events */ }
    refresh();
  }
  function onMove(e) {
    if (!session) return;
    const pane = activePane();
    if (!pane || (e.target !== pane.canvas && !session.down)) return;
    const p = worldAt(pane, e), px = 1 / (pane.view.scale?.() || 1);
    if (session.down && (e.buttons & 1)) {
      e.stopPropagation();
      if (!session.dragging && Math.hypot(e.clientX - session.down.x, e.clientY - session.down.y) > 4) session.dragging = true;
      if (session.dragging && dist(p, session.points.at(-1)) > 3 * px) session.points.push(p);
    }
    session.cursor = p;
    refresh();
  }
  function onUp(e) {
    if (!session || !session.down) return;
    e.stopPropagation();
    const was = session.dragging; session.down = null;
    if (was) { session.dragging = false; close(); return; }
    // A click: add a vertex (the first one was placed on press).
    const pane = activePane(); if (!pane) return;
    const p = worldAt(pane, e);
    if (session.points.length && dist(p, session.points.at(-1)) > 1e-9) session.points.push(p);
    refresh();
  }
  function onKey(e) {
    if (!session) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stop(false); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Backspace" && session.points.length > 1) { e.preventDefault(); e.stopPropagation(); session.points.pop(); refresh(); }
  }
  function overlay(ctx, {scale}) {
    const s = session; if (!s || !s.points.length) return;
    const px = 1 / scale, d = host.doc(), defs = host.defs();
    const pts = s.cursor && !s.dragging ? [...s.points, s.cursor] : s.points;
    const color = s.mode === "remove" ? "#ff6b6b" : s.mode === "add" ? "#7ee787" : "#58a6ff";
    ctx.save();
    // Objects that would change: outlined in the lasso colour.
    if (s.hits.length) {
      const ids = new Set(s.hits);
      ctx.strokeStyle = color; ctx.lineWidth = 2 * px; ctx.globalAlpha = .9;
      for (const i of d.items) if (ids.has(i.id)) {
        const q = pointsOf(i, d, defs); if (!q.length) continue;
        const b = bbox(q), g = 3 * px;
        ctx.strokeRect(b[0] - g, b[1] - g, b[2] - b[0] + 2 * g, b[3] - b[1] + 2 * g);
      }
    }
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    if (pts.length > 2) { ctx.closePath(); ctx.fillStyle = color + "1f"; ctx.fill(); }
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * px; ctx.setLineDash([6 * px, 4 * px]); ctx.stroke(); ctx.setLineDash([]);
    if (!s.dragging) for (const p of s.points) { ctx.beginPath(); ctx.arc(p[0], p[1], 3 * px, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
    ctx.restore();
  }
  function attach(h) {
    host = h;
    host.registerAction("lasso-select", start);
    host.addRenderer(d => session && d.id === session.doc ? {overlay} : null);
    host.on?.("document", () => { if (session) stop(false); });
    if (typeof window === "undefined") return;
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("dblclick", e => { if (session && e.target === activePane()?.canvas) { e.preventDefault(); e.stopPropagation(); close(); } }, true);
    window.addEventListener("contextmenu", e => { if (session) { e.preventDefault(); e.stopPropagation(); stop(false); } }, true);
    window.addEventListener("keydown", onKey, true);
  }
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({contains, inside, pick, combine, start: () => host && start(), cancel: () => stop(false), active: () => !!session, attach});
})();
