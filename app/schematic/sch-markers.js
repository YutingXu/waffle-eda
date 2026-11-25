"use strict";
// Schematic problem markers (docs/design/unified-rules-and-checks.md §2.7): the layout's marker language,
// scaled for sheets, for every problem the check store (checks.js) holds on a sheet: live and compiled
// ERC, and waived ones dimmed. Design Insights keep their own violet diamonds (insights-ui.js).
//   - a severity glyph at the pin or label: a red ring with a cross (fatal, error), an amber triangle
//     (warning), a smaller violet diamond (a live finding Compile has not reported yet: the hint tier),
//     sized by problem-marks.js (grows with zoom, clamped on screen);
//   - markers that would overlap on screen draw as one: the worst of them, with their count;
//   - board problems on a net or part: the same glyph drawn hollow on a second outline behind it
//     (problem-marks.js badge), and the count beside it when there are several;
//   - the objects involved outlined while the marker is hovered or open;
//   - hover writes one status-bar line, and after a rest the small problem card (problem-hover.js)
//     says what the marker is, beside it; a click opens the Violation inspector in the
//     Properties pane (drc-inspector.js), as on a board. F8 / Shift+F8 step through them.
// Loaded with checks.js (lazy); nothing here runs until a sheet with problems is drawn.
globalThis.AtriumSchMarkers = (() => {
  const G = globalThis, K = () => G.AtriumChecks, P = () => G.AtriumProblemMarks;
  let planFor;
  let host = null, hover = null, hoverBadge = null, focused = null, ink = null;
  // The problems drawn on a sheet: ERC findings (not insight hints, which have their own markers).
  // Cached per sheet by the store's revision and the project's journal stamp (waivers are edits), so a
  // pointer move or a frame never re-matches waivers.
  const cache = new Map();
  function list(docId) {
    const C = K();
    if (!C) return [];
    const p = host?.project?.(), d = p?.documents?.find(x => x.id === docId), v = d && G.AtriumUndoStore?.documentVersions?.(d, p);
    const stamp = C.revision() + "|" + (v ? v.floor + "/" + v.project + "/" + v.items + "/" + v.outer + "/" + v.library : "?"), hit = cache.get(docId);
    if (hit && hit.stamp === stamp && hit.project === p && v) return hit.list;
    let out = C.violations({doc: docId}).filter(x => x.domain === "schematic" && x.source !== "insights" && x.at.some(a => a.doc === docId || a.doc == null));
    const W = G.AtriumWaivers;
    if (W && p && out.length) { const m = W.match(p, out, {doc: d}), hidden = new Set(m.waived.map(x => x.violation)); out = out.filter(x => !hidden.has(x)); }
    if (d && out.length) place(d, out);
    cache.set(docId, {stamp, project: p, list: out});
    return out;
  }
  // Where a marker sits: its location, except that a problem located at a component's own origin (a part
  // not yet on the board, footprint pins) sits at the component's top-right corner, so a press on the part
  // still selects and drags it. Worked out once per list (cached with it).
  const placed = new WeakMap();
  function atOf(v, docId) {
    const p = (v.at.find(a => a.doc === docId) || v.at[0])?.point;
    return p ? placed.get(v) || p : p;
  }
  function place(d, rows) {
    let byId = null;
    for (const v of rows) {
      placed.delete(v);
      const p = (v.at.find(a => a.doc === d.id) || v.at[0])?.point;
      if (!p || !v.objects.length) continue;
      byId ??= new Map(d.items.filter(i => i.kind === "part").map(i => [i.id, i]));
      for (const o of v.objects) {
        const it = (o.doc == null || o.doc === d.id) && byId.get(o.id);
        if (!it || Math.abs(it.x - p[0]) > 1e-6 || Math.abs(it.y - p[1]) > 1e-6) continue;
        const b = G.AtriumNavCommon?.itemBox?.(d, host.defs(), it);
        if (b) placed.set(v, [b[2], b[1]]);
        break;
      }
    }
  }
  function colours() {
    if (ink) return ink;
    const css = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null, get = (k, d) => css?.getPropertyValue(k).trim() || d;
    return ink = {error: get("--danger", "#c4281c"), warning: get("--warning", "#b07400"), hint: get("--insight", "#6a4fd8"), halo: "rgba(255,255,255,.85)"};
  }
  function overlay(d, rows) {
    return (ctx, a) => {
      const px = 1 / a.scale, c = colours(), M = P(), Z = {error: M.size(a.scale, "schematic"), hint: M.size(a.scale, "schematic", "hint")};
      ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
      // The hovered or open problem's objects, outlined.
      for (const v of [hover, focused]) if (v && rows.includes(v)) {
        for (const o of v.objects) {
          const item = d.items.find(i => i.id === o.id), b = item && G.AtriumNavCommon?.itemBox?.(d, host.defs(), item);
          if (!b) continue;
          ctx.strokeStyle = sev(v) === "hint" ? c.hint : sev(v) === "warning" ? c.warning : c.error; ctx.lineWidth = 1.5 * px; ctx.setLineDash([4 * px, 3 * px]);
          ctx.strokeRect(b[0] - 2 * px, b[1] - 2 * px, b[2] - b[0] + 4 * px, b[3] - b[1] + 4 * px); ctx.setLineDash([]);
        }
      }
      const plan = markerPlan(d, rows, a);
      const clip = a.area && a.worldViewport?.(a.area, 4 * Z.error.screen + 8);
      for (const {v, at: p, n, hot} of plan.marks) {
        if (clip && (p[0] < clip[0] || p[1] < clip[1] || p[0] > clip[2] || p[1] > clip[3])) continue;
        const k = hot ? 1.2 : 1, s = sev(v), col = s === "hint" ? c.hint : s === "warning" ? c.warning : c.error;
        const z = s === "hint" ? Z.hint : Z.error, r = z.r;
        ctx.lineWidth = 3 * px * z.w; ctx.strokeStyle = c.halo; ctx.fillStyle = col;
        ctx.beginPath();
        if (s === "warning") { ctx.moveTo(p[0], p[1] - r * k); ctx.lineTo(p[0] + r * k, p[1] + r * .8 * k); ctx.lineTo(p[0] - r * k, p[1] + r * .8 * k); ctx.closePath(); }
        else if (s === "hint") { const q = r * k; ctx.moveTo(p[0], p[1] - q); ctx.lineTo(p[0] + q, p[1]); ctx.lineTo(p[0], p[1] + q); ctx.lineTo(p[0] - q, p[1]); ctx.closePath(); }
        else ctx.arc(p[0], p[1], r * k, 0, Math.PI * 2);
        ctx.stroke(); ctx.globalAlpha = s === "hint" ? .55 : .92; ctx.fill(); ctx.globalAlpha = 1;
        // A hint: a thin rim on its pale fill (quieter than the solid error and warning glyphs).
        if (s === "hint") { ctx.strokeStyle = col; ctx.lineWidth = 1.2 * px * z.w; ctx.stroke(); M.count(ctx, a, p[0], p[1], Z.error, n, {ink: col, halo: c.halo}); continue; }
        ctx.strokeStyle = c.halo; ctx.lineWidth = 1.3 * px * z.w; ctx.beginPath();
        if (s === "warning") { ctx.moveTo(p[0], p[1] - r * .4 * k); ctx.lineTo(p[0], p[1] + r * .2 * k); ctx.moveTo(p[0], p[1] + r * .5 * k); ctx.lineTo(p[0], p[1] + r * .5 * k); }
        else { const q = r * .45 * k; ctx.moveTo(p[0] - q, p[1] - q); ctx.lineTo(p[0] + q, p[1] + q); ctx.moveTo(p[0] + q, p[1] - q); ctx.lineTo(p[0] - q, p[1] + q); }
        ctx.stroke();
        M.count(ctx, a, p[0], p[1], Z.error, n, {ink: col, halo: c.halo});
      }
      ctx.restore();
    };
  }
  const sev = v => v.severity === "fatal" ? "error" : v.severity, RANK = {error: 0, warning: 1, hint: 2};
  // Close markers merged (problem-marks.js cluster), errors first, then warnings, then hints.
  const merge = (d, rows, scale) => P().cluster(rows, v => atOf(v, d.id), scale, "schematic", v => RANK[sev(v)] ?? 3);
  function markerPlan(d, rows, frame) {
    planFor ??= P().register();
    return planFor(d, frame, [rows, hover, focused], () => {
      const M = P(), scale = frame.scale, z = M.size(scale, "schematic"), padding = 4 * z.screen + 8;
      const view = frame.worldViewport?.(null, padding);
      const near = view ? rows.filter(v => {
        const p = atOf(v, d.id);
        return p && p[0] >= view[0] && p[1] >= view[1] && p[0] <= view[2] && p[1] <= view[3];
      }) : rows;
      const marks = merge(d, near, scale).map(g => {
        const v = g.members.includes(focused) ? focused : g.rep;
        const n = g.members.length, hot = g.members.includes(hover) || v === focused;
        const size = sev(v) === "hint" && n === 1 ? M.size(scale, "schematic", "hint") : z;
        return {v, rep: v, at: v === g.rep ? g.at : atOf(v, d.id), members: g.members,
          n, hot, live: true, reach: M.hit(size.screen * (hot ? 1.2 : 1))};
      });
      return {marks: [...marks.filter(m => !m.hot), ...marks.filter(m => m.hot)]};
    });
  }
  // Board problems projected onto the sheet (checks-cross.js): one badge per net or component, the
  // severity glyph drawn hollow on a stacked outline (problem-marks.js).
  function badges(d) { try { return G.AtriumChecksCross?.projected?.(host, d) || []; } catch { return []; } }
  function drawBadges(ctx, a, list) {
    P().paintBadges(ctx, a, list, "schematic", colours());
  }
  function render(d) {
    if (d?.kind !== "schematic") return null;
    const rows = list(d.id), proj = badges(d);
    if (!rows.length && !proj.length) return null;
    const own = rows.length ? overlay(d, rows) : null;
    return {overlay: (ctx, a) => { own?.(ctx, a); if (proj.length) drawBadges(ctx, a, proj); }};
  }
  // The merged marker under a screen point: {rep, members, at} (problem-marks.js cluster), or null.
  function groupAt(pane, x, y) {
    const d = host.docById?.(pane.docId) || host.doc();
    if (d?.kind !== "schematic") return null;
    const b = pane.canvas.getBoundingClientRect(), M = P();
    return M.pick(markerPlan(d, list(d.id), M.paneFrame(pane, b)), x - b.left, y - b.top);
  }
  const markerAt = (pane, x, y) => groupAt(pane, x, y)?.rep || null;
  // One status-bar line while a marker is hovered (no pop-up).
  const setLine = text => P().hoverStatus("erc", text);
  const statusText = v => (v.severity === "hint" ? "Hint (" + (v.hint || "problem") + " after Compile)" : v.severity[0].toUpperCase() + v.severity.slice(1)) + " · " + K().title(v.check) + ": " + v.text;
  const busy = () => { try { return host.tool() !== "select" || !!host.drag?.(); } catch { return false; } };
  const paneOf = c => host?.panes?.().find(p => p.canvas === c) || null;
  function attach(h) {
    if (host === h) return;
    host = h;
    h.addRenderer?.(d => render(d));
    h.on?.("document", () => { hover = focused = null; setLine(null); });
    if (typeof document === "undefined") return;
    G.addEventListener?.("atrium-theme", () => { ink = null; host?.invalidate?.(); });
    document.addEventListener("pointermove", e => {
      const p = e.target?.tagName === "CANVAS" && !e.buttons ? paneOf(e.target) : null, v = p && !busy() ? markerAt(p, e.clientX, e.clientY) : null;
      let b = null;
      if (!v && p && !busy() && (host.docById?.(p.docId) || host.doc())?.kind === "schematic") {
        try { b = G.AtriumChecksCross?.badgeAt?.(host, p, e.clientX, e.clientY) || null; } catch { /* projected badge unavailable */ }
      }
      if (v !== hover || b !== hoverBadge) { hover = v; hoverBadge = b; host.invalidate?.(); setLine(v ? statusText(v) : b ? b.text : null); }
    }, {passive: true});
    document.addEventListener("pointerdown", e => {
      if (e.target?.tagName !== "CANVAS" || e.button !== 0 || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey || G.AtriumCanvasInput?.isGrip?.(e)) return;
      const p = paneOf(e.target), v = p && host.tool?.() === "select" ? markerAt(p, e.clientX, e.clientY) : null;
      if (!v) return;
      e.preventDefault(); e.stopPropagation();
      focused = v; host.invalidate?.();
      K()?.inspect?.(host, v);
    }, true);
  }
  return Object.freeze({attach, list, render, markerAt, groupAt, focus(v) { focused = v?.member || v || null; host?.invalidate?.(); }, focused: () => focused, statusText});
})();
globalThis.AtriumNavCommon?.ready?.(h => globalThis.AtriumSchMarkers.attach(h));
