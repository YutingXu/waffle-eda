"use strict";
// Design Insights in the editor (the engine and checks: insights.js, insights-pcb.js, insights-sch.js).
//
// Quiet by design, and clearly not a violation: a violet diamond at the place (hollow for a tip, filled
// for advice; the hint size of problem-marks.js, so it grows with zoom), never red or amber, never counted by DRC, ERC or Release.
//   - Click a marker and it opens a compact card beside it, pinned: what, why, Fix (one undo step)
//     when there is one, Dismiss, Dismiss all of this kind, Learn more. Escape closes it. Click-only
//     is the default in both editors, as DRC markers are (a rest on a marker shows only the small
//     read-only problem card, problem-hover.js). Preferences › Design
//     Insights › Expand: On hover opens the card after a short delay instead; it closes when the
//     pointer leaves both marker and card.
//   - Tools › Next / Previous Insight (Alt+F8 / Shift+Alt+F8) fly to each insight and open its card
//     with the keyboard focus on its first button. View › Design Insights shows or hides the markers.
//   - Tools › List Design Insights lists them in the Messages panel, in their own group; choosing a row
//     goes to it.
//   - Dismissals are design edits (undo restores them) kept with the project (project.insights), so
//     collaborators share them.
// Runs only after an edit, debounced and on idle, in slices of a few milliseconds, and abandons a
// run when a newer edit arrives; nothing runs while the document is unchanged. The one check
// scheduler (checks.js) runs it, after the layout rules of the same edit (client "insights"). In
// Efficiency mode (AtriumPower) the debounce is longer and the heavy checks (pour necks, return
// paths, crosstalk) wait until the editor has been quiet for a while. Motion follows Preferences ›
// Appearance › Animations (CSS motion tokens; data-motion off shows the card at once).
globalThis.AtriumInsightsUI = (() => {
  const G = globalThis, doc = G.document, E = () => G.AtriumInsights, C = () => G.AtriumNavCommon;
  const canvasHover = G.AtriumCanvasHover;
  const AtriumI18n = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s), scope() {}};
  AtriumI18n.scope?.(".insight-card", ["insights"]);
  AtriumI18n.scope?.('.prf-page[data-shown="insights"]', ["insights", "prefs"]);
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = AtriumI18n.define({
    "insights.ui.tip": "Tip",
    "insights.ui.advice": "Advice",
    "insights.ui.fix_done": "{label}. Undo reverts it in one step.",
    "insights.ui.dismiss": "Dismiss",
    "insights.ui.dismiss_all": "Dismiss all of this kind",
    "insights.ui.learn": "Learn more",
    "insights.ui.learn_less": "Less",
    "insights.ui.close": "Close",
    "insights.ui.dismissed": "Insight dismissed for this project. Undo brings it back.",
    "insights.ui.muted": "“{title}” hidden for this project. Preferences › Design Insights shows them again.",
    "insights.ui.none": "No design insights on this document.",
    "insights.ui.off": "Design Insights are off (Preferences › Design Insights).",
    "insights.ui.count": "Insight {index} of {count}: {message}",
    "insights.ui.messages_title": "Design Insights · {name}",
    "insights.ui.refresh": "Check again",
    "insights.ui.refresh_title": "Run every insight check on this document again",
    "insights.ui.prefs": "Preferences…",
    "insights.ui.prefs_title": "Design Insights preferences",
    "insights.ui.restored": "{count} dismissed insights shown again.",
    "insights.ui.shown": "Design Insights markers shown.",
    "insights.ui.hidden": "Design Insights markers hidden. Tools › List Design Insights still lists them.",
    "insights.ui.not_advice": "Advice only: insights never fail DRC, ERC or Release.",
    "insights.pref.title": "Design Insights",
    "insights.pref.general": "General",
    "insights.pref.enabled": "Show design insights (advice, never violations)",
    "insights.pref.expand": "Expand a marker",
    "insights.pref.expand_hover": "On hover",
    "insights.pref.expand_click": "On click only",
    "insights.pref.expand_help": "Hover opens the card after a pause.",
    "insights.pref.sensitivity": "Sensitivity",
    "insights.pref.low": "Low (fewer, surer hints)",
    "insights.pref.normal": "Normal",
    "insights.pref.high": "High (more hints)",
    "insights.pref.all_signals": "Check the return path of every signal net, not only high-speed ones",
    "insights.pref.pcb": "Board checks",
    "insights.pref.schematic": "Schematic checks",
    "insights.pref.default": "default {value}",
    "insights.pref.restore": "Show dismissed insights again ({count})",
    "insights.pref.restore_help": "Dismissals are saved with the open project, so collaborators share them. Undo reverts this."
  });
  // Board canvas palette (the board is dark in every theme); schematic markers read --insight.
  const BOARD = Object.freeze({mark: "#b7a2ff", halo: "rgba(0,0,0,.72)", ring: "#ffffff", line: "#cbbcff"});
  const PM = () => G.AtriumProblemMarks, HOVER_MS = 350, LEAVE_MS = 280, LOD = 300;
  let planFor;
  const pref = (k, d) => { try { return G.AtriumPref?.get?.(k, d) ?? d; } catch { return d; } };
  let host = null, engine = null, nowNext = false;
  let enabled = pref("insights.enabled", true) !== false, markers = pref("insights.markers", true) !== false;
  const seqs = new Map(), shown = new Map(); // docId → journal seq of the last finished pass; docId → {list, sig}
  let hover = null, pinned = null, card = null, cardFor = null, cardCanvas = null, cursor = new Map(), lastPass = null;
  let schematicInk = null;

  // ---------------------------------------------------------------- running
  const efficient = () => { try { return !!G.AtriumPower?.efficient?.(); } catch { return false; } };
  const S = () => G.AtriumChecks?.scheduler;
  // o.now: no debounce; o.force: a pass even without an edit; o.heavy: the heavy checks too in Efficiency mode.
  function schedule(o = {}) { if (host && enabled) S()?.plan?.("insights", o); }
  // A document's journal stamp includes the sheets when an enabled check reads schematic evidence.
  function stampOf(d) {
    const U = G.AtriumUndoStore, p = host.project(), out = [], docs = [d];
    if (d.kind === "schematic" || E().enabledChecks(d.kind).some(c => c.schematicInputs)) {
      for (const sheet of p?.documents || []) if (sheet !== d && sheet.kind === "schematic") docs.push(sheet);
    }
    for (const x of docs) { const v = U?.documentVersions?.(x, p); if (!v) return null; out.push(x.id + ":" + v.floor + "/" + v.items + "/" + v.outer + "/" + v.pours); }
    const v0 = U?.documentVersions?.(d, p);
    return out.join(",") + "|" + v0.project + "|" + v0.library;
  }
  const stamps = new Map();
  function client(h) {
    G.AtriumChecks?.attach?.(h);
    S()?.client?.({id: "insights", key: d => "insights:" + d.id, phase: () => "idle", unrecorded: "sync", heavy: true, efficiency: true,
      delay: o => { if (nowNext || o?.now) { nowNext = false; return 0; } return efficient() ? 1500 : 400; },
      enabled: () => enabled,
      docs: () => { const d = host.doc(); return d && ["pcb", "schematic"].includes(d.kind) ? [d] : []; },
      due: (d, o) => !!(o?.force || o?.heavy || !engine.state(d.id) || stamps.get(d.id) == null || stamps.get(d.id) !== stampOf(d)),
      onDocument: () => { closeCard(); hover = null; nowNext = true; },
      start: (d, slice, o) => start(d, o || {})});
  }
  function needed(d) {
    const L = G.AtriumLazy, mods = new Set();
    for (const c of E().enabledChecks(d.kind)) for (const m of c.needs || []) if (!G[m]) mods.add(m);
    // The signal-integrity engine only matters where there is reference copper to check.
    if (!d.items.some(i => i.kind === "polygon") && !(d.pcbDrawing?.pours || []).length) { mods.delete("AtriumSI"); mods.delete("AtriumReturnPath"); }
    const want = [...mods].filter(m => L?.modules?.().includes(m) && !L.pending?.(m));
    return want;
  }
  function start(d, o) {
    if (!enabled || !d || !["pcb", "schematic"].includes(d.kind)) return null;
    const want = needed(d);
    if (want.length) { G.AtriumLazy.need(want).then(() => schedule({now: true}), () => {}); }
    const U = G.AtriumUndoStore, since = seqs.has(d.id) ? seqs.get(d.id) : undefined, ch = U?.changed?.(d, since);
    const hint = ch && since != null ? {from: since, to: ch.seq, ids: ch.ids, items: ch.items} : ch ? {from: null, to: ch.seq, ids: null, items: null} : null;
    const opts = {outer: U?.outer?.(), skipHeavy: efficient() && !o.heavy, allSignals: pref("insights.allSignals", false) === true, force: !!o.force,
      sheetChanged: s => { if (!U?.changed) return true; const c = U.changed(s, since); return since == null || c.ids == null || c.ids.size > 0; }};
    const project = host.project(), defs = host.defs(), initialStamp = stampOf(d), it = engine.update(project, d, defs, hint, opts);
    return (function* () {
      for (;;) {
        const r = it.next();
        if (r.done) { stamps.set(d.id, initialStamp); finish(d, r.value, ch?.seq); return r.value; }
        yield;
      }
    })();
  }
  function finish(d, r, seq) {
    if (seq != null) seqs.set(d.id, seq);
    lastPass = {docId: d.id, ms: r.ms, mode: r.mode, why: r.why, ran: r.ran};
    shown.delete(d.id);
    host.invalidate?.({overlay:true});
    publishTo(d);
    refreshMessages(d);
    // A pass makes new insight objects. The hovered and the open insight follow their key, so the
    // overlay keeps their highlight and a pending hover still opens; an open card whose insight is gone closes.
    const fresh = new Map(current(d).map(x => [x.key, x]));
    if (hover?.doc === d.id) hover = fresh.get(hover.key) || null;
    if (cardFor && !fresh.has(cardFor.key)) closeCard();
    else if (cardFor?.doc === d.id) cardFor = fresh.get(cardFor.key);
  }
  // The insights to show for a document: the engine's, without dismissed ones (re-read when the store changes).
  function current(d) {
    if (!d || !engine) return [];
    const p = host.project(), s = p?.insights, K = G.AtriumChecks, sig = (s && typeof s === "object" ? Object.keys(s.dismissed || {}).join() + "|" + Object.keys(s.muted || {}).join() : "") + "|" + (K?.revision?.() ?? "");
    const c = shown.get(d.id);
    if (c && c.sig === sig && c.project === p) return c.list;
    // A hint the rule or the fab already reports for the same object is left out (one check per question).
    const list = E().visible(p, engine.list(d.id)).filter(x => !K?.shadowed?.(K.fromInsight(x)));
    shown.set(d.id, {sig, list, project: p});
    return list;
  }

  // The check store (checks.js): the insights shown for this document (dismissed ones left out).
  function publishTo(d) { const K = G.AtriumChecks; if (K && d) K.publish(d.id, "insights", current(d), K.fromInsight); }

  // ---------------------------------------------------------------- drawing
  function inkFor(d) {
    if (d.kind === "pcb") return BOARD.mark;
    if (!schematicInk && doc) schematicInk = getComputedStyle(doc.documentElement).getPropertyValue("--insight").trim() || "#7a5cff";
    return schematicInk || "#7a5cff";
  }
  // Where an insight's diamond goes: at its place, or for one about a via or hole (land: its radius) up and
  // right of the land, as problem badges sit, so it never covers the drill it is about.
  function markAt(x, r) { if (!(x.land > 0)) return x.at; const d = (x.land + r) * Math.SQRT1_2; return [x.at[0] + d, x.at[1] - d]; }
  function diamond(ctx, at, r) { ctx.moveTo(at[0], at[1] - r); ctx.lineTo(at[0] + r, at[1]); ctx.lineTo(at[0], at[1] + r); ctx.lineTo(at[0] - r, at[1]); ctx.closePath(); }
  const markerRank = x => x === cardFor ? 2 : x.severity === "advice" ? 1 : 0;
  const boardGroups = new WeakMap();
  function overviewGroups(list, cell, M) {
    let groups = boardGroups.get(list);
    if (!groups || groups.cell !== cell || groups.card !== cardFor) {
      groups = {cell, card:cardFor, all:M.cells(list, x => x.at, 1, cell, markerRank)};
      boardGroups.set(list,groups);
    }
    return groups.all;
  }
  function markerPlan(d, list, frame) {
    planFor ??= PM().register();
    return planFor(d, frame, [list, cardFor], () => {
      const M = PM(), {r, screen, w} = M.size(frame.scale, d.kind, "hint"), reach = M.hit(screen * 1.2);
      const view = frame.worldViewport?.(null, screen * 2.1 + 8);
      const atOf = x => markAt(x, r);
      const inView = x => {
        const [mx, my] = atOf(x);
        return mx >= view[0] && mx <= view[2] && my >= view[1] && my <= view[3];
      };
      const cell = d.kind === "pcb" && M.pcbCell(frame);
      if (cell && list.length > 1) {
        // Group at the findings' fixed world anchors, then choose where a visible diamond goes.
        const groups = [], marks = [];
        for (const group of overviewGroups(list, cell, M)) {
          if (view && !group.members.some(inView)) continue;
          const rep = M.visibleWinner(group, frame, atOf, markerRank);
          groups.push(group);
          marks.push({rep, at:atOf(rep), members:group.members, live:true, reach, coarse:true});
        }
        return {marks, groups, atOf, damageRadius:screen * 1.8 + w + 2};
      }
      const near = view ? list.filter(inView) : list;
      const groups = near.length > LOD && frame.worldToScreen ?
        M.cells(near, atOf, frame.scale, Math.max(14, screen * 2), markerRank) :
        near.map(x => ({rep: x, at: atOf(x), members: [x]}));
      return {marks: groups.map(g => ({...g, live: true, reach}))};
    });
  }
  function overlay(d) {
    const paint = (ctx, a) => {
      const list = drawn(d, a.options, a.canvas);
      const {r, px, w, screen} = PM().size(a.scale, d.kind, "hint");
      const clip = a.area && a.worldViewport?.(a.area, screen * 2.1 + 8);
      const marks = markerPlan(d, list, a).marks;
      const rows = clip ? marks.filter(({at: [x, y]}) => x >= clip[0] && x <= clip[2] && y >= clip[1] && y <= clip[3]) : marks;
      const hot = [hover, cardFor].filter(x => x?.doc === d.id);
      if (!rows.length && !hot.length) return;
      const ink = inkFor(d);
      ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
      // The place itself for the hovered / open insight: its measuring line, dashed.
      for (const x of hot) if (x.line) {
        ctx.globalAlpha = .9; ctx.strokeStyle = BOARD.halo; ctx.lineWidth = 3 * px; ctx.beginPath(); ctx.moveTo(x.line[0][0], x.line[0][1]); ctx.lineTo(x.line[1][0], x.line[1][1]); ctx.stroke();
        ctx.strokeStyle = d.kind === "pcb" ? BOARD.line : ink; ctx.lineWidth = 1.4 * px; ctx.setLineDash([3 * px, 2 * px]); ctx.stroke(); ctx.setLineDash([]);
      }
      const fixPreview = cardFor?.doc === d.id && card?.dataset.preview === "1" ? cardFor.fix?.preview : null;
      if (fixPreview?.kind === "via") { ctx.globalAlpha = .7; ctx.strokeStyle = ink; ctx.lineWidth = 1.5 * px; ctx.setLineDash([2 * px, 2 * px]); ctx.beginPath(); ctx.arc(fixPreview.at[0], fixPreview.at[1], (fixPreview.diameter || .6) / 2, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
      // Markers: halo, then the diamond (filled for advice, hollow with a dot for a tip).
      if (rows.length) {
        const outlines = new Path2D(), advice = new Path2D(), tips = new Path2D();
        const dot = Math.max(1.1 * px, r * .2);
        for (const {rep, at} of rows) {
          const radius = hot.includes(rep) ? r * 1.2 : r;
          diamond(outlines, at, radius);
          if (rep.severity === "advice") diamond(advice, at, radius);
          else { tips.moveTo(at[0] + dot, at[1]); tips.arc(at[0], at[1], dot, 0, Math.PI * 2); }
        }
        // Thinner than a problem marker and a little see-through: a note, not a fault.
        const S = PM().STROKE;
        ctx.globalAlpha = .8; ctx.lineWidth = S.halo * px * w; ctx.strokeStyle = BOARD.halo; ctx.stroke(outlines);
        ctx.fillStyle = ink; ctx.globalAlpha = .55; ctx.fill(advice);
        ctx.globalAlpha = .9; ctx.lineWidth = S.line * px * w; ctx.strokeStyle = ink; ctx.stroke(outlines);
        ctx.fill(tips);
      }
      for (const {rep, at} of rows) if (hot.includes(rep)) { ctx.lineWidth = 1.2 * px * w; ctx.strokeStyle = BOARD.ring; ctx.globalAlpha = .9; ctx.beginPath(); ctx.arc(at[0], at[1], r * 1.8, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
    };
    if (d.kind === "pcb") paint.panDamage = (frame, dx, dy) => {
      const M = PM();
      if (!M.pcbCell(frame)) return [];
      const plan = markerPlan(d, drawn(d, frame.options, frame.canvas), frame);
      return plan.groups ? M.groupPanDamage(plan.groups, frame, plan.atOf, markerRank, plan.damageRadius, dx, dy) : [];
    };
    return paint;
  }
  const filtered = new WeakMap();
  function drawn(d, options, canvas = d) {
    let hidden = options?.hidden;
    if (d.kind === "pcb" && !options && d === host.doc()) hidden = host.hiddenLayers?.();
    const list = current(d);
    if (!hidden?.size && options?.layerMode !== "single") return list;
    const key = JSON.stringify([options?.layer, options?.layerMode, ...(hidden || [])]), old = filtered.get(canvas);
    if (old?.list === list && old.key === key) return old.rows;
    const rows = list.filter(x => !x.layer || (options?.layerMode === "single" && G.AtriumPCBAppearance ?
      G.AtriumPCBAppearance.visible(x.layer, null, options) : !hidden?.has(x.layer)));
    filtered.set(canvas, {list, key, rows});
    return rows;
  }
  function render(d) {
    if (!enabled || !markers || !d || (d.kind !== "pcb" && d.kind !== "schematic")) return null;
    // Insights on hidden layers stay hidden with them (pours, tracks); board-wide ones always show.
    return current(d).length ? {overlay: overlay(d)} : null;
  }

  // ---------------------------------------------------------------- pointer
  const paneOf = c => host?.panes?.().find(p => p.canvas === c) || null;
  function groupAt(pane, x, y) {
    const d = host.docById?.(pane.docId) || host.doc();
    if (!d || !markers || !enabled) return null;
    const b = pane.canvas.getBoundingClientRect(), M = PM();
    const group = M.pick(markerPlan(d, drawn(d, pane.options, pane.canvas), M.paneFrame(pane, b)), x - b.left, y - b.top);
    return group && {...group, get findings() { return group.members.map(G.AtriumChecks.fromInsight); }};
  }
  const markerAt = (pane, x, y) => groupAt(pane, x, y)?.rep || null;
  const busy = () => { try { return host.tool() !== "select" || !!host.liveRoute?.() || !!host.drag?.(); } catch { return false; } };
  const expandOnHover = () => pref("insights.expand", "click") === "hover";
  function hoverAt(canvas, x, y) {
    const p = enabled && !pinned && expandOnHover() && !busy() && paneOf(canvas);
    return p ? markerAt(p, x, y) : null;
  }
  function setHover(ins) {
    if (ins !== hover) { hover = ins; host.invalidate?.(); }
  }
  function leaveHover(restart = false) {
    if (!pinned && cardFor && !card.contains(doc.activeElement)) {
      canvasHover.leave("insight", LEAVE_MS, () => {
        if (!pinned && !hover && !card.contains(doc.activeElement)) closeCard();
      }, restart);
    }
  }
  function onMove(e) {
    if (!host || !enabled) return;
    if (card && !card.hidden && card.contains(e.target)) { canvasHover.stay("insight"); return; }
    if (e.pointerType === "touch") return;
    const p = e.target?.tagName === "CANVAS" && !e.buttons ? paneOf(e.target) : null, ins = p && !busy() ? markerAt(p, e.clientX, e.clientY) : null;
    setHover(ins);
    canvasHover.cancel("insight");
    if (ins && !pinned && expandOnHover() && (!cardFor || cardFor.key !== ins.key || cardCanvas !== p.canvas)) {
      const {clientX: x, clientY: y} = e;
      canvasHover.queue("insight", p.canvas, HOVER_MS, ins, () => {
        // By key: a pass that finishes during the pause replaces the objects; the card shows the current one.
        const now = hoverAt(p.canvas, x, y);
        if (!now || hover?.key !== ins.key || now.key !== ins.key || !canvasHover.preferred("insight", p.canvas, x, y)) return;
        canvasHover.show("insight", p.canvas, () => openCard(now, p));
      });
    } else if (!ins) leaveHover(true);
  }
  function onDown(e) {
    if (!host || !enabled || e.defaultPrevented) return;
    if (card && !card.hidden && card.contains(e.target)) return;
    if (e.target?.tagName !== "CANVAS" || e.button !== 0 || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) { return; }
    const p = paneOf(e.target), ins = p && host.tool() === "select" ? markerAt(p, e.clientX, e.clientY) : null;
    if (!ins) { if (cardFor) closeCard(); return; }
    e.preventDefault(); e.stopPropagation();
    openCard(ins, p, {pinned: true});
  }

  // ---------------------------------------------------------------- the card
  const el = (tag, cls, text) => AtriumNavCommon.classedElement(doc, tag, cls, text);
  function button(text, fn, cls = "insight-btn", variant = "secondary") {
    const b = el("button", "ui-button " + cls, text); b.type = "button"; b.dataset.variant = variant; b.dataset.size = "sm";
    b.addEventListener("click", ev => { ev.stopPropagation(); fn(ev); }); return b;
  }
  function ensureCard() {
    if (card) return card;
    card = el("div", "insight-card ui-popover"); card.hidden = true; card.setAttribute("role", "dialog");
    card.addEventListener("pointerenter", () => canvasHover.stay("insight"));
    card.addEventListener("pointerleave", () => leaveHover(true));
    card.addEventListener("focusout", e => { if (!card.contains(e.relatedTarget) && !card.matches(":hover")) leaveHover(true); });
    card.addEventListener("keydown", e => { if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeCard({focus: true}); } });
    doc.body.append(card);
    return card;
  }
  function openCard(ins, pane, {pinned: pin = false, focus = false} = {}) {
    if (!ins) return;
    if (pin) canvasHover.dismiss();
    ensureCard();
    canvasHover.stay("insight"); canvasHover.cancel("insight");
    cardFor = ins; pinned = pin; cardCanvas = pane?.canvas || host.canvas?.();
    const head = el("div", "insight-head"), mark = el("span", "insight-mark"); mark.dataset.severity = ins.severity; mark.setAttribute("aria-hidden", "true");
    const title = el("strong", "insight-title", ins.title); title.id = "insight-card-title";
    const sev = el("span", "insight-sev", t(ins.severity === "advice" ? "insights.ui.advice" : "insights.ui.tip"));
    const close = el("button", "ui-close insight-close", "×"); close.type = "button"; close.addEventListener("click", ev => { ev.stopPropagation(); closeCard({focus: true}); });
    close.setAttribute("aria-label", t("insights.ui.close")); close.title = t("insights.ui.close");
    head.append(mark, title, sev, close);
    const msg = el("p", "insight-msg", ins.message), why = el("p", "insight-why", ins.why);
    const learn = el("p", "insight-learn", ins.learnMore); learn.hidden = true; learn.id = "insight-card-learn";
    const actions = el("div", "insight-actions");
    if (ins.fix) {
      const fix = button(ins.fix.label, () => applyFix(ins), "insight-btn insight-fix", "primary");
      const show = on => { card.dataset.preview = on ? "1" : ""; host.invalidate?.(); };
      fix.addEventListener("pointerenter", () => show(true)); fix.addEventListener("pointerleave", () => show(false));
      fix.addEventListener("focus", () => show(true)); fix.addEventListener("blur", () => show(false));
      actions.append(fix);
    }
    actions.append(button(t("insights.ui.dismiss"), () => dismiss(ins)), button(t("insights.ui.dismiss_all"), () => mute(ins)));
    if (ins.learnMore) {
      const more = button(t("insights.ui.learn"), () => { learn.hidden = !learn.hidden; more.textContent = t(learn.hidden ? "insights.ui.learn" : "insights.ui.learn_less"); more.setAttribute("aria-expanded", String(!learn.hidden)); place(ins, pane); }, "insight-btn insight-link", "quiet");
      more.setAttribute("aria-expanded", "false"); more.setAttribute("aria-controls", learn.id);
      actions.append(more);
    }
    card.replaceChildren(head, msg, why, learn, actions);
    card.setAttribute("aria-labelledby", title.id);
    card.dataset.severity = ins.severity; card.dataset.preview = "";
    card.hidden = false;
    place(ins, pane);
    globalThis.AtriumSurfaceMotion?.popover(card, true);
    if (focus) (card.querySelector(".insight-actions button") || close).focus({preventScroll: true});
    host.invalidate?.();
  }
  function place(ins, pane) {
    if (!card || card.hidden) return;
    const p = pane || host.panes?.().find(q => q.active) || null, c = p?.canvas || host.canvas?.();
    if (!c) return;
    const b = c.getBoundingClientRect(), view = p?.view || host.view?.(), s = view ? view.worldToScreen(ins.at) : [b.width / 2, b.height / 2];
    const x = b.left + s[0], y = b.top + s[1], r = card.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    let left = x + 14, top = y + 12;
    if (left + r.width > W - 8) left = Math.max(8, x - 14 - r.width);
    if (top + r.height > H - 8) top = Math.max(8 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0), y - 12 - r.height); // below the title bar
    card.style.left = Math.round(left) + "px"; card.style.top = Math.round(top) + "px";
  }
  function closeCard(o = {}) {
    canvasHover.cancel("insight"); canvasHover.release("insight");
    const had = !!cardFor;
    const canvas = cardCanvas?.isConnected ? cardCanvas : host?.canvas?.();
    cardFor = null; pinned = false; cardCanvas = null;
    if (card) {
      const surface = globalThis.AtriumSurfaceMotion;
      if (surface) surface.popover(card, false, {instant: !!o.instant});
      else card.hidden = true;
      card.dataset.preview = "";
    }
    if (had) host?.invalidate?.();
    if (o.focus) canvas?.focus?.({preventScroll: true});
  }
  function applyFix(ins) {
    const label = ins.fix.label;
    // A fix that opens a dialog (Resolve… on a placeholder) makes its own undo step, if any.
    if (typeof ins.fix.open === "function" && typeof ins.fix.apply !== "function") { closeCard({focus: false}); try { ins.fix.open(host); } catch (e) { host.info?.(e.message); } return; }
    try { host.edit(() => ins.fix.apply(host.doc(), host.project(), host.defs()), label); }
    catch (e) { host.info?.(e.message); return; }
    closeCard({focus: true});
    host.info?.(t("insights.ui.fix_done", {label}));
    schedule({now: true});
  }
  function dismiss(ins) {
    try { host.edit(() => E().dismiss(host.project(), ins), t("insights.ui.dismiss")); } catch (e) { host.info?.(e.message); return; }
    closeCard({focus: true}); shown.clear(); host.invalidate?.(); publishTo(host.doc()); refreshMessages(host.doc());
    host.info?.(t("insights.ui.dismissed"));
  }
  function mute(ins) {
    try { host.edit(() => E().mute(host.project(), ins.check), t("insights.ui.dismiss_all")); } catch (e) { host.info?.(e.message); return; }
    closeCard({focus: true}); shown.clear(); host.invalidate?.(); publishTo(host.doc()); refreshMessages(host.doc());
    host.info?.(t("insights.ui.muted", {title: ins.title}));
  }

  // ---------------------------------------------------------------- next / previous, Messages
  function go(dir) {
    if (!enabled) { host.info?.(t("insights.ui.off")); return; }
    const d = host.doc(), list = current(d);
    if (!list.length) { host.info?.(t("insights.ui.none")); if (!engine.state(d.id)) schedule({now: true}); return; }
    const k = cursor.get(d.id), at = cardFor ? list.findIndex(x => x.key === cardFor.key) : list.findIndex(x => x.key === k);
    const i = at < 0 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length;
    focusInsight(list[i], {focus: true});
    host.info?.(t("insights.ui.count", {index: i + 1, count: list.length, message: list[i].message}));
  }
  function focusInsight(ins, o = {}) {
    if (!ins) return;
    if (host.currentId?.() !== ins.doc && host.selectDocument) host.selectDocument(ins.doc);
    cursor.set(ins.doc, ins.key);
    const m = Math.max(2, ins.line ? Math.hypot(ins.line[0][0] - ins.line[1][0], ins.line[0][1] - ins.line[1][1]) : 0) * 1.5 + 3;
    host.zoomTo?.([ins.at[0] - m, ins.at[1] - m, ins.at[0] + m, ins.at[1] + m]);
    const motionOff = () => { try { return (G.AtriumMotion?.level?.() || "full") === "off"; } catch { return false; } };
    setTimeout(() => openCard(ins, null, {pinned: true, focus: !!o.focus}), motionOff() ? 0 : 360);
  }
  let messagesOpen = false;
  function rows(d) {
    const s = engine.state(d.id);
    return E().messages(current(d), d, {ms: lastPass?.docId === d.id ? lastPass.ms : 0, dismissed: E().dismissedCount(host.project())});
  }
  function showMessages() {
    const L = G.AtriumLazy, M = G.AtriumMessages;
    if (!M && L?.need) { L.need("AtriumMessages").then(showMessages, e => host.info?.(e.message)); return; }
    const d = host.doc();
    if (!enabled) { host.info?.(t("insights.ui.off")); return; }
    if (!engine.state(d.id)) schedule({now: true});
    messagesOpen = true;
    M.show({...host.messageContext(), info: host.info}, {title: t("insights.ui.messages_title", {name: d.name}), group: "Insights", messages: rows(d),
      rerun: () => { engine.reset(d.id); seqs.delete(d.id); shown.delete(d.id); stamps.delete(d.id); schedule({now: true, force: true, heavy: true}); }, rerunLabel: t("insights.ui.refresh"), rerunTitle: t("insights.ui.refresh_title"),
      options: () => G.AtriumLazy?.need?.("AtriumPrefs").then(P => P.open("insights")), optionsLabel: t("insights.ui.prefs"), optionsTitle: t("insights.ui.prefs_title"),
      onChoose: m => { if (m?.insight) focusInsight(m.insight); }});
  }
  function refreshMessages(d) {
    const M = G.AtriumMessages;
    if (!messagesOpen || !M?.update || !d || !M.isOpen?.() || !M.messages().some(m => m.group === "Insights")) return;
    M.update("Insights", rows(d));
  }

  // ---------------------------------------------------------------- preferences
  function prefsPage(P) {
    P.registerPage({id: "insights", title: t("insights.pref.title"), order: 2.7,
      keywords: "insights hints advice tips neck pour plane return path split stitching via decoupling capacitor acid trap stub crosstalk typo pull-up dismiss hover sensitivity",
      render(c, api) {
        const g = api.group(c, t("insights.pref.general"));
        const describe = (row, control, help) => {
          if (!help) return;
          const detail = api.el("small", "prf-help", help);
          detail.id = control.id + "-help"; control.setAttribute("aria-describedby", detail.id); row.append(detail);
        };
        const check = (key, label, def, help) => {
          const r = api.el("div", "prf-row prf-check"); r.dataset.search = (label + " " + key).toLowerCase();
          const box = api.el("input", "ui-checkbox"); box.type = "checkbox"; box.id = "prf-" + key.replace(/\W/g, "-"); box.checked = pref(key, def) !== false;
          box.onchange = () => P.set(key, box.checked);
          const l = api.el("label", "ui-checkbox-row"); l.htmlFor = box.id; l.append(box, api.el("span", null, label)); r.append(l);
          describe(r, box, help);
          return r;
        };
        const select = (key, label, def, options, help) => {
          const r = api.el("div", "prf-row"); r.dataset.search = (label + " " + key).toLowerCase();
          const l = api.el("label", "prf-label", label), s = api.el("select", "ui-field"); s.id = "prf-" + key.replace(/\W/g, "-"); l.htmlFor = s.id;
          for (const [v, text] of options) { const o = api.el("option", null, text); o.value = v; s.append(o); }
          s.value = String(pref(key, def)); s.onchange = () => P.set(key, s.value);
          const ctl = api.el("span", "prf-control"); ctl.append(s); r.append(l, ctl);
          describe(r, s, help);
          return r;
        };
        g.append(check("insights.enabled", t("insights.pref.enabled"), true, t("insights.ui.not_advice")),
          select("insights.expand", t("insights.pref.expand"), "click", [["click", t("insights.pref.expand_click")], ["hover", t("insights.pref.expand_hover")]], t("insights.pref.expand_help")),
          select("insights.sensitivity", t("insights.pref.sensitivity"), "normal", [["low", t("insights.pref.low")], ["normal", t("insights.pref.normal")], ["high", t("insights.pref.high")]]),
          check("insights.allSignals", t("insights.pref.all_signals"), false));
        for (const [kind, title] of [["pcb", t("insights.pref.pcb")], ["schematic", t("insights.pref.schematic")]]) {
          const f = api.group(c, title);
          for (const ck of E().checks(kind)) {
            f.append(check("insights.check." + ck.id, ck.title, ck.on !== false, ck.prefHelp ? ck.prefHelp() : ck.why?.split(/(?<=\.)\s/)[0]));
            const base = E().settingsFor(ck, {prefs: false});
            for (const s of ck.settings || []) {
              const key = "insights." + ck.id + "." + s.key, r = api.el("div", "prf-row prf-sub"); r.dataset.search = (ck.title + " " + s.label).toLowerCase();
              const l = api.el("label", "prf-label", s.label), input = api.el("input", "ui-field"); input.type = "number"; input.id = "prf-" + key.replace(/\W/g, "-"); l.htmlFor = input.id;
              input.step = String(s.step || "any"); if (s.min != null) input.min = String(s.min); if (s.max != null) input.max = String(s.max);
              const v = pref(key, null); input.value = v == null ? "" : String(v); input.placeholder = t("insights.pref.default", {value: base[s.key]});
              if (Number.isFinite(base[s.key])) input.dataset.defaultValue = String(base[s.key]);
              input.onchange = () => { const n = input.value === "" ? null : Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, +input.value)); if (n == null || !Number.isFinite(n)) P.reset?.([key]) ?? P.set(key, null); else { P.set(key, n); input.value = String(n); } };
              const ctl = api.el("span", "prf-control"); ctl.append(input); if (s.unit) ctl.append(api.el("span", "prf-unit", s.unit));
              r.append(l, ctl); f.append(r);
            }
          }
        }
        const n = host ? E().dismissedCount(host.project()) : 0, b = api.el("div", "prf-row prf-link"); b.dataset.search = "dismissed restore show again insights";
        const restore = api.button(t("insights.pref.restore", {count: n}), () => {
          if (!host) return;
          let count = 0;
          try { host.edit(() => { count = E().restore(host.project()); }, t("insights.pref.restore", {count: n})); } catch (e) { host.info?.(e.message); return; }
          shown.clear(); host.invalidate?.(); restore.disabled = true; restore.textContent = t("insights.pref.restore", {count: 0});
          host.info?.(t("insights.ui.restored", {count}));
        }, "prf-button");
        restore.disabled = !n;
        b.append(restore, api.el("small", "prf-help", t("insights.pref.restore_help"))); g.append(b);
      }});
    P.on?.("insights.", ({key, value}) => {
      if (key === "insights.enabled") setEnabled(value !== false, {quiet: true});
      else if (key === "insights.markers") { markers = value !== false; host?.invalidate?.(); }
      else { shown.clear(); schedule({now: true}); }
    });
  }
  function registerPrefs() { const P = G.AtriumPrefs; if (!P?.registerPage) return false; prefsPage(P); return true; }

  // ---------------------------------------------------------------- toggles and install
  function setEnabled(on, o = {}) {
    enabled = !!on;
    if (!o.quiet) try { G.AtriumPref?.set?.("insights.enabled", enabled); } catch { /* storage */ }
    if (!enabled) { closeCard(); S()?.cancel?.("insights"); engine?.reset(); seqs.clear(); shown.clear(); stamps.clear(); G.AtriumChecks?.clear?.(null, "insights"); } else schedule({now: true});
    host?.invalidate?.();
  }
  function setMarkers(on) {
    markers = !!on;
    try { G.AtriumPref?.set?.("insights.markers", markers); } catch { /* storage */ }
    C()?.setChecked?.("insights-markers", markers);
    if (!markers) closeCard();
    host?.invalidate?.();
    host?.info?.(t(markers ? "insights.ui.shown" : "insights.ui.hidden"));
  }
  function attach(h) {
    host = h; engine = E().engine();
    canvasHover.register("insight", {
      hide(reason) {
        if (!pinned) closeCard({instant: true, focus: reason === "escape" && card?.contains(doc.activeElement)});
      },
      contains: target => card?.contains(target),
      over: hoverAt,
      reset() { setHover(null); },
      leaveCanvas() { setHover(null); leaveHover(true); }
    });
    h.registerAction("insights-next", () => go(1));
    h.registerAction("insights-prev", () => go(-1));
    h.registerAction("insights-panel", () => showMessages());
    h.registerAction("insights-markers", () => setMarkers(!markers));
    h.addRenderer(d => render(d));
    // The scheduler plans the passes (change, document, panes, visibility, Efficiency mode); here only the card.
    h.on("change", () => { if (!pinned) closeCard(); });
    h.on("replace", () => {
      S()?.cancel?.("insights"); engine.reset(); seqs.clear(); shown.clear(); stamps.clear(); closeCard();
    });
    client(h);
    if (doc) {
      C()?.menuItem?.("tools", "insights-panel", "List Design Insights", {after: "drc-prev"});
      C()?.menuItem?.("tools", "insights-next", "Next Insight", {after: "insights-panel"});
      C()?.menuItem?.("tools", "insights-prev", "Previous Insight", {after: "insights-next"});
      C()?.menuItem?.("view", "insights-markers", "Design Insights", {after: "minimap", checkable: true});
      C()?.setChecked?.("insights-markers", markers);
      doc.addEventListener("pointermove", onMove, {passive: true});
      doc.addEventListener("pointerdown", onDown, true);
      doc.addEventListener("wheel", () => { if (cardFor && pinned) setTimeout(() => cardFor && place(cardFor), 0); }, {passive: true, capture: true});
      doc.addEventListener("keydown", e => {
        if (e.key === "Escape" && cardFor && !e.defaultPrevented && !e.isComposing && !e.target.closest?.("dialog[open], [role=dialog]")) closeCard();
      });
      G.addEventListener?.("atrium-theme", () => { schematicInk = null; host?.invalidate?.(); });
    }
    schedule({now: true});
  }
  if (!registerPrefs() && doc) G.AtriumLazy?.need?.("AtriumPrefs").then(registerPrefs, () => {});
  C()?.ready?.(attach);
  return Object.freeze({schedule, current: () => host ? current(host.doc()) : [], open: (ins, o) => openCard(ins, null, {pinned: true, ...o}), close: closeCard, next: () => go(1), prev: () => go(-1),
    showMessages, setEnabled, setMarkers, enabled: () => enabled, expandOnHover, markerAt, groupAt, cardFor: () => cardFor, _render: d => render(d), _markAt: markAt, lastPass: () => lastPass, engine: () => engine, running: () => !!S()?.running?.("insights"), _card: () => card});
})();
