"use strict";
// Panelize UI (lazy: panel.js loads it on Tools › Panelize… or when a panel document is shown).
//
//   Dialog     presets (one click to a fab-ready panel), a live SVG preview (click a board to edit
//              its cell), sections for the array, separation, frame and fab profile, the panel
//              check (click a finding to zoom to it) and the outputs. Non-modal: the panel stays
//              visible on the canvas while you edit.
//   Canvas     direct manipulation on the panel document: drag a tab along its edge (double-click
//              resets that edge, Delete removes a picked tab), drag the gap handles to change the
//              X/Y spacing (Shift: both), drag a rail's inner edge to change its width, click a
//              board to pick its cell. Alt turns snapping off. Esc cancels a drag. Values show
//              only while dragging (no hover pop-ups); every drop is one undo step.
//   Inspector  the Properties panel for a panel document: summary, the picked cell (board,
//              rotation, skip) or tab, and the dialog.
// The panel document stores parameters only (panel.js); everything drawn here is derived from
// AtriumPanel.layout, so board edits flow into the panel and its handles.
globalThis.AtriumPanelUI = (() => {
  const PN = () => globalThis.AtriumPanel;
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const fmt = v => String(r4(v));
  const SVGNS = "http://www.w3.org/2000/svg";
  let H = null;                      // the navigation host (AtriumNavHost)
  const state = {hover: null, drag: null, sel: null, tab: null, draft: null, G: null, Gsig: "", settle: null, raf: 0, inspector: null};
  let dialog = null;

  // ------------------------------------------------------------------ small DOM helpers
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, fn, cls) { const b = el("button", text, cls); b.type = "button"; b.onclick = fn; return b; }
  function row(label, control, hint) { const l = el("label", null, "panel-row"); l.append(el("span", label), control); if (hint) l.append(el("small", hint)); return l; }
  function num(v, step, min, max, label, unit="mm") { const i = el("input");i.dataset.numericUnit=unit; i.type = "number"; i.step = String(step); i.min = String(min); i.max = String(max); i.value = String(v); if (label) i.setAttribute("aria-label", label); return i; }
  function checkbox(v, label) { const i = el("input"); i.type = "checkbox"; i.checked = !!v; if (label) i.setAttribute("aria-label", label); return i; }
  function sel(values, v) { const s = el("select"); for (const [k, t] of values) s.add(new Option(t, k)); s.value = String(v); return s; }
  function section(title, open = true) { const d = el("details", null, "panel-section"); d.open = open; d.append(el("summary", title)); return d; }
  const svg = (tag, attrs = {}) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
  const css = name => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null; } catch { return null; } };

  // ------------------------------------------------------------------ the live panel document
  const liveDoc = () => { const d = H?.doc?.(); return d?.kind === "panel" ? d : null; };
  const docById = id => H?.project?.()?.documents.find(x => x.id === id) || null;
  function commit(id, fn, message) {
    let ok = true;
    try {
      H.edit(() => { const t = docById(id); if (!t || t.kind !== "panel") return; const next = PN().normalize(t.panel); fn(next, t); t.panel = PN().normalize(next); });
    } catch (e) { ok = false; H.info?.(e.message); }
    if (ok && message) H.info?.(message);
    state.Gsig = "";
    return ok;
  }
  // Layout of the live (or draft) panel, cached on the panel parameters and the project revision.
  function layoutOf(doc, panel) {
    const p = H.project(), sig = (panel ? JSON.stringify(panel) : JSON.stringify(doc.panel)) + "|" + (H.revision?.() ?? "") + "|" + doc.id;
    if (!panel && state.G && state.Gsig === sig) return state.G;
    let G = null;
    try { G = PN().layout(p, panel ? {...doc, panel} : doc, new Map((p.library || []).map(d => [d.id, d]))); } catch { G = null; }
    if (!panel) { state.G = G; state.Gsig = sig; }
    return G;
  }

  // ------------------------------------------------------------------ canvas: handles and hit tests
  function handles(G) {
    const out = [], P = G.params;
    const used = new Set(G.instances.map(i => i.col)), usedR = new Set(G.instances.map(i => i.row));
    const midY = G.instances.length ? (Math.min(...G.instances.map(i => i.box[1])) + Math.max(...G.instances.map(i => i.box[3]))) / 2 : G.H / 2;
    const midX = G.instances.length ? (Math.min(...G.instances.map(i => i.box[0])) + Math.max(...G.instances.map(i => i.box[2]))) / 2 : G.W / 2;
    for (let c = 0; c < P.cols - 1; c++) if (used.has(c) && used.has(c + 1)) out.push({kind: "gapx", index: c, at: [G.colX[c] + G.colW[c] + G.spacingX / 2, midY]});
    for (let r = 0; r < P.rows - 1; r++) if (usedR.has(r) && usedR.has(r + 1)) out.push({kind: "gapy", index: r, at: [midX, G.rowY[r] + G.rowH[r] + G.spacingY / 2]});
    for (const rail of G.rails) {
      const [x0, y0, x1, y1] = rail.rect, w = P.rails.width;
      const at = rail.side === "top" ? [(x0 + x1) / 2 + G.W / 6, y0 + w] : rail.side === "bottom" ? [(x0 + x1) / 2 + G.W / 6, y1 - w] : rail.side === "left" ? [x0 + w, (y0 + y1) / 2 + G.H / 6] : [x1 - w, (y0 + y1) / 2 + G.H / 6];
      out.push({kind: "rail", side: rail.side, at});
    }
    return out;
  }
  function hitAt(G, p, tol) {
    for (const h of handles(G)) if (Math.hypot(p[0] - h.at[0], p[1] - h.at[1]) <= tol * 1.4) return h;
    for (const t of G.tabs) { const r = t.rect; if (p[0] >= r[0] - tol && p[0] <= r[2] + tol && p[1] >= r[1] - tol && p[1] <= r[3] + tol) return {kind: "tab", tab: t}; }
    for (const i of G.instances) { const b = i.box; if (p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]) return {kind: "cell", inst: i}; }
    return null;
  }
  const cursorFor = h => !h ? "" : h.kind === "gapx" ? "ew-resize" : h.kind === "gapy" ? "ns-resize" : h.kind === "rail" ? (h.side === "top" || h.side === "bottom" ? "ns-resize" : "ew-resize")
    : h.kind === "tab" ? (h.tab.side === "top" || h.tab.side === "bottom" ? "ew-resize" : "ns-resize") : "pointer";
  function world(e) {
    const c = H.canvas(), v = H.view(), r = c.getBoundingClientRect();
    return {p: v.screenToWorld([e.clientX - r.left, e.clientY - r.top]), tol: Math.max(.3, 6 / (v.scale() || 1))};
  }
  const sameHit = (a, b) => (!a && !b) || (a && b && a.kind === b.kind && a.index === b.index && a.side === b.side && a.tab?.key === b.tab?.key && a.tab?.t === b.tab?.t && a.inst?.index === b.inst?.index);
  const snap = (v, step, e) => e.altKey ? r4(v) : Math.round(v / step) * step;

  function pick(hit) {
    if(hit.kind==="cell"){state.sel=hit.inst.row+","+hit.inst.col;state.tab=null;}
    else if(hit.kind==="tab"){state.tab={key:hit.tab.key,t:hit.tab.t};state.sel=null;}
    refreshInspector(); syncDialog(); H.redraw();
  }
  function inputAt(point,scale) {
    const doc=liveDoc(),G=doc&&layoutOf(doc);
    if(!G)return null;
    let hit;
    if(point)hit=hitAt(G,point,Math.max(.3,6/scale));
    else if(state.sel){
      const inst=G.instances.find(i=>i.row+","+i.col===state.sel);
      if(inst)hit={kind:"cell",inst};
    }else if(state.tab){
      const tab=G.tabs.find(t=>t.key===state.tab.key&&t.t===state.tab.t);
      if(tab)hit={kind:"tab",tab};
    }
    if(!hit)return null;
    const key=hit.inst?.index??(hit.tab?hit.tab.key+"/"+hit.tab.t:hit.side??hit.index);
    const box=hit.inst?.box||hit.tab?.rect||[...hit.at,...hit.at];
    const label={cell:"Board cell",tab:"Board tab",gapx:"Column spacing",gapy:"Row spacing",rail:"Panel rail"}[hit.kind];
    // Spacing and rail handles are always-on grips: a finger drags them like a grip of a selection.
    return {item:{id:hit.kind+"/"+key,kind:hit.kind},box,label,grip:hit.kind!=="cell"&&hit.kind!=="tab",pick:()=>pick(hit)};
  }

  // Tab fractions along one edge: the dragged set, or the even spacing perEdge gives.
  function fractions(P, key) {
    if (P.tabs.manual?.[key]) return P.tabs.manual[key].slice();
    const n = P.tabs.perEdge; return Array.from({length: n}, (_, t) => (t + 1) / (n + 1));
  }

  function onDown(e) {
    if (!H || e.button !== 0 || !liveDoc() || e.target !== H.canvas?.() || e.ctrlKey || e.metaKey) return;
    const doc = liveDoc(), G = layoutOf(doc);
    if (!G) return;
    const {p, tol} = world(e), hit = hitAt(G, p, tol);
    if (!hit) { if (state.sel || state.tab) { state.sel = null; state.tab = null; refreshInspector(); syncDialog(); H.redraw(); } return; }
    e.preventDefault(); e.stopPropagation();
    state.drag = {hit, pointerId:e.pointerId, start: p, doc: doc.id, base: PN().normalize(doc.panel), G0: G, moved: false, shift: e.shiftKey};
    try { H.canvas().setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  }
  function dragTo(e) {
    const g = state.drag, doc = docById(g.doc);
    if (!doc) { cancel(); return; }
    const {p, tol} = world(e), dx = p[0] - g.start[0], dy = p[1] - g.start[1];
    if (!g.moved && Math.hypot(dx, dy) < tol * .6) return;
    if (g.hit.kind === "cell") return;          // a board is picked, not moved
    g.moved = true;
    const P = JSON.parse(JSON.stringify(g.base)), h = g.hit, G0 = g.G0;
    if (h.kind === "tab") {
      const t = h.tab, horiz = t.side === "top" || t.side === "bottom", inst = G0.instances.find(i => i.index === t.instance);
      const start = horiz ? inst.box[0] : inst.box[1], len = t.len, along = (horiz ? p[0] : p[1]) - start;
      const tw = P.tabs.width, mm = Math.min(len - tw / 2, Math.max(tw / 2, snap(along, .5, e)));
      const list = fractions(P, t.key);
      list[t.t] = r4(mm / len);
      P.tabs.manual = {...(P.tabs.manual || {}), [t.key]: list};
      g.readout = "Tab at " + fmt(mm) + " mm along the edge";
    } else if (h.kind === "gapx" || h.kind === "gapy") {
      const x = h.kind === "gapx", k = h.index + .5 + (x ? (G0.rails.some(r => r.side === "left") ? 1 : 0) : (G0.rails.some(r => r.side === "top") ? 1 : 0));
      const base = x ? G0.spacingX : G0.spacingY, v = Math.max(0, snap(base + (x ? dx : dy) / k, .1, e));
      if (g.shift) { P.spacing = r4(v); delete P.spacingY; g.readout = "Spacing " + fmt(v) + " mm (X and Y)"; }
      else if (x) { P.spacingY = G0.spacingY; P.spacing = r4(v); g.readout = "Column gap " + fmt(v) + " mm"; }
      else { P.spacingY = r4(v); g.readout = "Row gap " + fmt(v) + " mm"; }
    } else if (h.kind === "rail") {
      const d = h.side === "top" ? dy : h.side === "bottom" ? -dy : h.side === "left" ? dx : -dx;
      P.rails.width = r4(Math.max(1, Math.min(50, snap(g.base.rails.width + d, .5, e))));
      g.readout = "Rails " + fmt(P.rails.width) + " mm";
    }
    state.draft = PN().normalize(P);
    g.pointer = p;
    schedule();
  }
  function endDrag() {
    const g = state.drag;
    state.drag = null;
    if (!g) return;
    const doc = docById(g.doc);
    if (!g.moved) {
      state.draft=null;pick(g.hit);return;
    }
    const draft = state.draft;
    state.draft = null;
    if (doc && draft) commit(doc.id, next => { Object.keys(next).forEach(k => delete next[k]); Object.assign(next, draft); }, g.readout ? g.readout + "." : null);
    // The dropped handle settles with a short ring (motion system; nothing at Animations: Off).
    const M = globalThis.AtriumMotion, at = g.pointer;
    if (M?.enabled?.() && at) {
      state.settle = {at, t: 0};
      M.animate({duration: "base", ease: "spring", step: t => { if (state.settle) state.settle.t = t; H.redraw(); }, done: () => { state.settle = null; H.redraw(); }});
    }
    H.redraw();
    syncDialog();
  }
  function cancel() { if (!state.drag) return; state.drag = null; state.draft = null; H.redraw(); }
  function onMove(e) {
    if (!H || !liveDoc()) return;
    if (state.drag) { if(state.drag.pointerId===e.pointerId){e.stopPropagation();dragTo(e);} return; }
    if (e.buttons || e.target !== H.canvas?.()) return;
    const G = layoutOf(liveDoc());
    if (!G) return;
    const {p, tol} = world(e), hit = hitAt(G, p, tol);
    if (!sameHit(hit, state.hover)) { state.hover = hit; H.canvas().style.cursor = cursorFor(hit); H.redraw(); }
  }
  function onUp(e) { if (state.drag?.pointerId===e.pointerId) { e.stopPropagation(); endDrag(); } }
  function onDbl(e) {
    if (!H || !liveDoc() || e.target !== H.canvas?.()) return;
    const doc = liveDoc(), G = layoutOf(doc), {p, tol} = world(e), hit = G && hitAt(G, p, tol);
    if (hit?.kind !== "tab") return;
    e.preventDefault(); e.stopPropagation();
    const key = hit.tab.key;
    if (!PN().normalize(doc.panel).tabs.manual?.[key]) { H.info?.("This edge already uses automatic tabs."); return; }
    commit(doc.id, next => { delete next.tabs.manual[key]; if (!Object.keys(next.tabs.manual).length) delete next.tabs.manual; }, "Tabs on that edge are automatic again.");
    syncDialog();
  }
  function onKey(e) {
    if (!H || !liveDoc()) return;
    if (e.key === "Escape" && state.drag) { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing || !(e.key === "Delete" || e.key === "Backspace") || !state.tab) return;
    e.preventDefault(); e.stopPropagation();
    removeTab(liveDoc(), state.tab);
  }
  function removeTab(doc, tab) {
    const P = PN().normalize(doc.panel), list = fractions(P, tab.key);
    list.splice(tab.t, 1);
    commit(doc.id, next => { next.tabs.manual = {...(next.tabs.manual || {}), [tab.key]: list}; }, "Tab removed (double-click the edge's tabs, or Reset dragged tabs, to bring them back).");
    state.tab = null; refreshInspector(); syncDialog();
  }
  function schedule() {
    if (state.raf) return;
    const raf = globalThis.requestAnimationFrame || (f => setTimeout(f, 16));
    state.raf = raf(() => { state.raf = 0; H?.redraw(); });
  }

  // ------------------------------------------------------------------ canvas: overlay painting (world coordinates)
  function paint(c, doc, env) {
    const G = layoutOf(doc);
    if (!G) return;
    const s = env.scale || 1, px = v => v / s, accent = css("--accent") || "#f0a32e", ink = css("--ink") || "#e2e2e2", warn = css("--warning") || "#f0c46a";
    c.save();
    c.lineWidth = px(1.25);
    // The picked cell and tab.
    if (state.sel) {
      const i = G.instances.find(x => x.row + "," + x.col === state.sel);
      if (i) { c.strokeStyle = accent; c.lineWidth = px(2); c.setLineDash([px(6), px(4)]); c.strokeRect(i.box[0], i.box[1], i.box[2] - i.box[0], i.box[3] - i.box[1]); c.setLineDash([]); }
    }
    const tabSel = state.tab && G.tabs.find(t => t.key === state.tab.key && t.t === state.tab.t);
    // Tabs: a grip on every tab; hover and the picked tab in the accent colour; dragged ones marked.
    for (const t of G.tabs) {
      const r = t.rect, on = (state.hover?.kind === "tab" && state.hover.tab.key === t.key && state.hover.tab.t === t.t) || t === tabSel;
      c.globalAlpha = on ? .9 : .45; c.fillStyle = on ? accent : ink;
      const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, horiz = t.side === "top" || t.side === "bottom", gw = px(on ? 12 : 9), gh = px(3);
      c.fillRect(horiz ? cx - gw / 2 : cx - gh / 2, horiz ? cy - gh / 2 : cy - gw / 2, horiz ? gw : gh, horiz ? gh : gw);
      if (t.manual) { c.globalAlpha = .9; c.beginPath(); c.arc(cx, cy, px(2), 0, Math.PI * 2); c.fillStyle = accent; c.fill(); }
    }
    c.globalAlpha = 1;
    // Spacing and rail handles.
    for (const h of handles(G)) {
      const on = state.hover && state.hover.kind === h.kind && state.hover.index === h.index && state.hover.side === h.side;
      c.beginPath(); c.arc(h.at[0], h.at[1], px(on ? 6 : 4.5), 0, Math.PI * 2);
      c.fillStyle = on ? accent : css("--panel") || "#252526"; c.fill(); c.strokeStyle = accent; c.lineWidth = px(1.5); c.stroke();
      const horiz = h.kind === "gapx" || (h.kind === "rail" && (h.side === "left" || h.side === "right")), a = px(9);
      c.beginPath();
      if (horiz) { c.moveTo(h.at[0] - a, h.at[1]); c.lineTo(h.at[0] - a - px(4), h.at[1]); c.moveTo(h.at[0] + a, h.at[1]); c.lineTo(h.at[0] + a + px(4), h.at[1]); }
      else { c.moveTo(h.at[0], h.at[1] - a); c.lineTo(h.at[0], h.at[1] - a - px(4)); c.moveTo(h.at[0], h.at[1] + a); c.lineTo(h.at[0], h.at[1] + a + px(4)); }
      c.stroke();
    }
    // The drag's draft: the new outline, boards and tabs, and the value being set.
    const g = state.drag;
    if (g?.moved && state.draft) {
      const D = layoutOf(doc, state.draft);
      if (D) {
        c.strokeStyle = accent; c.lineWidth = px(1.5);
        for (const loop of [...D.profile.outer, ...D.profile.holes]) { c.beginPath(); loop.forEach((q, k) => k ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath(); c.stroke(); }
        c.globalAlpha = .35; c.fillStyle = accent;
        for (const t of D.tabs) c.fillRect(t.rect[0], t.rect[1], t.rect[2] - t.rect[0], t.rect[3] - t.rect[1]);
        c.globalAlpha = 1;
      }
      if (g.readout && g.pointer) {
        const fs = px(12), text = g.readout;
        c.font = fs + "px " + (css("--font-ui") || "system-ui, sans-serif");
        const w = c.measureText(text).width, x = g.pointer[0] + px(14), y = g.pointer[1] - px(14);
        c.fillStyle = css("--menu-bg") || "#2d2d30"; c.globalAlpha = .92; c.fillRect(x - px(6), y - fs - px(3), w + px(12), fs + px(10)); c.globalAlpha = 1;
        c.fillStyle = ink; c.fillText(text, x, y + px(2));
      }
    }
    if (state.settle) {
      const t = state.settle.t, at = state.settle.at;
      c.globalAlpha = 1 - t; c.strokeStyle = accent; c.lineWidth = px(2);
      c.beginPath(); c.arc(at[0], at[1], px(6 + 14 * (1 - t)), 0, Math.PI * 2); c.stroke(); c.globalAlpha = 1;
    }
    // V-score lines get a readable dashed overlay.
    if (G.vlines.length) {
      c.strokeStyle = warn; c.globalAlpha = .7; c.lineWidth = px(1); c.setLineDash([px(8), px(4)]);
      for (const l of G.vlines) { c.beginPath(); c.moveTo(l.a[0], l.a[1]); c.lineTo(l.b[0], l.b[1]); c.stroke(); }
      c.setLineDash([]); c.globalAlpha = 1;
    }
    c.restore();
  }

  // ------------------------------------------------------------------ live preview (SVG)
  function preview(G, onPick) {
    const pad = Math.max(G.W, G.H) * .03 + 1, s = svg("svg", {viewBox: [-pad, -pad, r4(G.W + 2 * pad), r4(G.H + 2 * pad)].join(" "), class: "panel-preview", role: "img",
      "aria-label": "Panel preview: " + fmt(G.W) + " by " + fmt(G.H) + " mm, " + G.instances.length + " boards"});
    const path = loops => loops.map(l => "M" + l.map(q => r4(q[0]) + " " + r4(q[1])).join("L") + "Z").join("");
    s.append(svg("path", {d: path([...G.profile.outer, ...G.profile.holes]), class: "pv-profile", "fill-rule": "evenodd"}));
    for (const r of G.rails) s.append(svg("rect", {x: r.rect[0], y: r.rect[1], width: r4(r.rect[2] - r.rect[0]), height: r4(r.rect[3] - r.rect[1]), class: "pv-rail"}));
    if (G.thieving.dots.length) { const g = svg("g", {class: "pv-thief"}); for (const d of G.thieving.dots.slice(0, 1500)) g.append(svg("circle", {cx: d[0], cy: d[1], r: r4(G.thieving.size / 2)})); s.append(g); }
    if (G.thieving.hatch.length) { const g = svg("g", {class: "pv-thief-hatch", "stroke-width": G.thieving.size}); for (const h of G.thieving.hatch.slice(0, 1500)) g.append(svg("line", {x1: h[0][0], y1: h[0][1], x2: h[1][0], y2: h[1][1]})); s.append(g); }
    for (const t of G.tabs) s.append(svg("rect", {x: t.rect[0], y: t.rect[1], width: r4(t.rect[2] - t.rect[0]), height: r4(t.rect[3] - t.rect[1]), class: "pv-tab" + (t.manual ? " is-manual" : "")}));
    const fs = Math.max(1.6, Math.min(G.W, G.H) * .05);
    for (const i of G.instances) {
      const g = svg("g", {class: "pv-board" + (state.sel === i.row + "," + i.col ? " is-selected" : ""), "data-cell": i.row + "," + i.col, tabindex: "0", role: "button",
        "aria-label": "Board " + i.index + ", " + i.board.name + ", row " + (i.row + 1) + " column " + (i.col + 1) + (i.rotation ? ", " + i.rotation + " degrees" : "")});
      g.append(svg("path", {d: path([i.poly])}));
      const t = svg("text", {x: r4((i.box[0] + i.box[2]) / 2), y: r4((i.box[1] + i.box[3]) / 2 + fs / 3), "font-size": r4(fs), "text-anchor": "middle"}); t.textContent = String(i.index);
      g.append(t);
      if (onPick) { g.addEventListener("click", () => onPick(i)); g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(i); } }); }
      s.append(g);
    }
    const bites = svg("g", {class: "pv-bite"}); for (const b of G.bites.slice(0, 3000)) bites.append(svg("circle", {cx: b.at[0], cy: b.at[1], r: r4(b.d / 2)})); s.append(bites);
    for (const t of G.tooling) s.append(svg("circle", {cx: t.at[0], cy: t.at[1], r: r4(t.d / 2), class: "pv-tool"}));
    for (const f of G.fiducials) s.append(svg("circle", {cx: f.at[0], cy: f.at[1], r: r4(f.opening / 2), class: "pv-fid"}));
    for (const l of G.vlines) s.append(svg("line", {x1: l.a[0], y1: l.a[1], x2: l.b[0], y2: l.b[1], class: "pv-vcut"}));
    return s;
  }

  // ------------------------------------------------------------------ dialog
  function open(host, options = {}) {
    H ||= host;
    const project = host.project();
    let doc = host.doc();
    if (doc.kind !== "panel" && !options.create) {
      const board = doc.kind === "pcb" ? doc : PN().panelBoards(project)[0];
      const existing = board && project.documents.find(x => x.kind === "panel" && x.panel?.board === board.id);
      if (existing) { host.selectDocument(existing.id); doc = host.doc(); }
    }
    if (doc.kind !== "panel" || options.create) {
      const boards = PN().panelBoards(project);
      const board = doc.kind === "pcb" ? doc : doc.kind === "panel" ? boards.find(b => b.id === doc.panel?.board) || boards[0] : boards[0];
      if (!board) { host.info("Add a board layout first, then panelize it."); return null; }
      const created = PN().create(project, {board: board.id, preset: "mousebite-5mm-rails"});
      created.panel = PN().applyPreset(created.panel, "mousebite-5mm-rails");
      host.edit(() => { project.documents.push(created); });
      host.selectDocument(created.id);
      doc = host.doc();
      host.info("Panel " + created.name + " created from the “Mouse-bite tabs, 5 mm rails” preset. Its boards stay linked: board edits show here.");
    }
    dialog?.close();
    const d = el("dialog", null, "work-dialog panel-dialog");
    d.setAttribute("aria-label", "Panelize");
    dialog = d;
    const pid = doc.id, cur = () => docById(pid) || host.doc(), P = () => PN().normalize(cur().panel);
    const set = (fn, message) => { if (cur().kind !== "panel") return; if (commit(pid, fn, message)) { fill(); refresh(); } };

    // Header, presets, preview.
    const summary = el("p", null, "panel-summary"), status = el("p", null, "panel-status");
    status.setAttribute("role", "status");
    const presets = el("div", null, "panel-presets");
    presets.setAttribute("role", "group"); presets.setAttribute("aria-label", "Presets");
    for (const pr of PN().PRESETS) {
      const b = button("", () => {
        set(next => { const q = PN().applyPreset(next, pr.id); Object.keys(next).forEach(k => delete next[k]); Object.assign(next, q); }, "Preset applied: " + pr.name + ".");
        pv.classList.remove("is-changing"); void pv.offsetWidth; pv.classList.add("is-changing");
      }, "panel-preset");
      b.dataset.preset = pr.id;
      b.append(el("strong", pr.name), el("small", pr.hint));
      presets.append(b);
    }
    const pv = el("div", null, "panel-preview-wrap"), pvCaption = el("p", null, "panel-hint");
    pvCaption.textContent = "On the canvas: drag tabs along their edges, the round handles to change gaps and rails; click a board to change its cell.";
    const cellBox = el("div", null, "panel-cell");

    // Array.
    const p0 = P(), boards = PN().panelBoards(project);
    const name = el("input"); name.value = cur().name; name.setAttribute("aria-label", "Panel name");
    name.onchange = () => { host.edit(() => { const t = docById(pid); if (t) t.name = name.value.trim() || "Panel"; }); };
    const board = sel(boards.map(b => [b.id, b.name]), p0.board); board.onchange = () => set(p => { p.board = board.value; });
    const rows = num(p0.rows, 1, 1, 30, "Rows","ea"), cols = num(p0.cols, 1, 1, 30, "Columns","ea");
    rows.onchange = () => set(p => { p.rows = +rows.value; }); cols.onchange = () => set(p => { p.cols = +cols.value; });
    const sx = num(p0.spacing, .1, 0, 50, "Column gap"), sy = num(p0.spacingY ?? p0.spacing, .1, 0, 50, "Row gap"), link = checkbox(p0.spacingY == null, "Same gap for rows and columns");
    sx.onchange = () => set(p => { p.spacing = +sx.value; if (link.checked) delete p.spacingY; });
    sy.onchange = () => set(p => { if (link.checked) { p.spacing = +sy.value; delete p.spacingY; } else p.spacingY = +sy.value; });
    link.onchange = () => set(p => { if (link.checked) delete p.spacingY; else p.spacingY = p.spacing; });
    const rot = sel([[0, "0°"], [90, "90°"], [180, "180°"], [270, "270°"]], p0.rotation); rot.onchange = () => set(p => { p.rotation = +rot.value; });
    const alt = sel([["none", "None"], ["rows", "Every other row 180°"], ["cols", "Every other column 180°"], ["both", "Checkerboard 180°"]], p0.alternate || "none");
    alt.onchange = () => set(p => { if (alt.value === "none") delete p.alternate; else p.alternate = alt.value; });
    const fitW = num(100, 1, 10, 600, "Fill width"), fitH = num(100, 1, 10, 600, "Fill height");
    const fit = button("Fill", () => {
      try {
        const f = PN().fitArray(host.project(), cur(), [+fitW.value, +fitH.value]);
        if (!f.count) { status.textContent = "Not even one board fits " + fitW.value + " × " + fitH.value + " mm with these rails and gaps."; return; }
        set(p => { p.rows = f.rows; p.cols = f.cols; p.rotation = f.rotation; }, f.rows + " × " + f.cols + " boards fit (" + f.size.join(" × ") + " mm).");
      } catch (e) { status.textContent = e.message; }
    });
    const fitRow = el("span", null, "panel-fit"); fitRow.append(fitW, el("span", "×"), fitH, el("span", "mm"), fit);
    const pair = (...n) => { const s = el("span", null, "panel-pair"); s.append(...n); return s; };
    const linkLabel = el("label", null, "panel-inline"); linkLabel.append(link, " same");
    const arr = section("Array");
    arr.append(row("Board", board), row("Rows × columns", pair(rows, cols)), row("Gap X / Y (mm)", pair(sx, sy), null), row("", linkLabel),
      row("Rotation", rot), row("Alternate", alt, "turns every other board so connectors face out"), row("Fill a panel size", fitRow, "most boards within the size (JLCPCB's price break is 100 × 100 mm)"));

    // Separation.
    const seg = el("div", null, "ui-segmented panel-segmented"); seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-label", "Separation");
    const sepBtn = (v, text) => { const b = button(text, () => set(p => { p.separation = v; if (v === "vscore") { p.spacing = 0; delete p.spacingY; } else if (!(p.spacing > 0)) p.spacing = 2; }), "ui-segment"); b.dataset.value = v; b.setAttribute("role", "radio"); return b; };
    seg.append(sepBtn("mousebite", "Mouse-bite tabs"), sepBtn("vscore", "V-score"));
    const tw = num(p0.tabs.width, .1, .3, 50, "Tab width"), tn = num(p0.tabs.perEdge, 1, 0, 12, "Tabs per edge","ea"), th = num(p0.tabs.hole, .05, 0, 3, "Mouse-bite hole"), tp = num(p0.tabs.pitch, .05, .1, 10, "Hole pitch"), to = num(p0.tabs.offset, .05, -2, 2, "Hole offset");
    tw.onchange = () => set(p => { p.tabs.width = +tw.value; }); tn.onchange = () => set(p => { p.tabs.perEdge = +tn.value; });
    th.onchange = () => set(p => { p.tabs.hole = +th.value; }); tp.onchange = () => set(p => { p.tabs.pitch = +tp.value; }); to.onchange = () => set(p => { p.tabs.offset = +to.value; });
    const mill = num(p0.mill?.radius || 0, .1, 0, 5, "Mill radius"); mill.onchange = () => set(p => { if (+mill.value > 0) p.mill = {radius: +mill.value}; else delete p.mill; });
    const resetTabs = AtriumNavCommon.actionButton("Reset dragged tabs", () => set(p => { delete p.tabs.manual; }, "Every tab is automatic again."));
    const tabRows = el("div", null, "panel-grid");
    tabRows.append(row("Tab width (mm)", tw), row("Tabs per edge", tn), row("Mouse bites (mm)", pair(th, tp), "hole / pitch; 0 hole for solid tabs"), row("Hole offset (mm)", to, "positive moves holes into the board"),
      row("Mill radius (mm)", mill, "routing-bit radius; inside corners are filleted (0: sharp)"), row("", resetTabs));
    const sepS = section("Separation");
    sepS.append(seg, tabRows);

    // Frame.
    const rails = el("span", null, "panel-sides"), railW = num(p0.rails.width, .5, 0, 50, "Rail width");
    for (const s of ["top", "bottom", "left", "right"]) { const c = checkbox(p0.rails[s], s + " rail"); c.onchange = () => set(p => { p.rails[s] = c.checked; }); const l = el("label"); l.append(c, " " + s); rails.append(l); }
    railW.onchange = () => set(p => { p.rails.width = +railW.value; });
    const fe = checkbox(p0.fiducials.enabled, "Fiducials"), fd = num(p0.fiducials.diameter, .1, .2, 5, "Fiducial diameter"), fo = num(p0.fiducials.opening, .1, .2, 10, "Fiducial mask opening");
    fe.onchange = () => set(p => { p.fiducials.enabled = fe.checked; }); fd.onchange = () => set(p => { p.fiducials.diameter = +fd.value; }); fo.onchange = () => set(p => { p.fiducials.opening = +fo.value; });
    const ge = checkbox(p0.tooling.enabled, "Tooling holes"), gd = num(p0.tooling.diameter, .1, .5, 6.5, "Tooling hole diameter");
    ge.onchange = () => set(p => { p.tooling.enabled = ge.checked; }); gd.onchange = () => set(p => { p.tooling.diameter = +gd.value; });
    const xe = checkbox(p0.text.enabled, "Rail text"), xr = el("input"), xd = checkbox(p0.text.date, "Date on rail"); xr.value = p0.text.revision; xr.placeholder = "A"; xr.setAttribute("aria-label", "Revision");
    xe.onchange = () => set(p => { p.text.enabled = xe.checked; }); xr.onchange = () => set(p => { p.text.revision = xr.value; }); xd.onchange = () => set(p => { p.text.date = xd.checked; });
    const T0 = p0.thieving || PN().THIEVING, ce = checkbox(T0.enabled, "Copper thieving"), cp = sel([["dots", "Dots"], ["hatch", "Hatch"]], T0.pattern);
    const cs = num(T0.size, .1, .2, 5, "Thieving size"), cg = num(T0.pitch, .1, .5, 20, "Thieving pitch");
    const thv = fn => set(p => { p.thieving = {...(p.thieving || PN().THIEVING)}; fn(p.thieving); });
    ce.onchange = () => thv(t => { t.enabled = ce.checked; }); cp.onchange = () => thv(t => { t.pattern = cp.value; }); cs.onchange = () => thv(t => { t.size = +cs.value; }); cg.onchange = () => thv(t => { t.pitch = +cg.value; });
    const withBox = (c, ...rest) => pair(c, ...rest);
    const frame = section("Frame and features");
    frame.append(row("Rails", rails), row("Rail width (mm)", railW), row("Fiducials (mm)", withBox(fe, fd, fo), "copper / mask opening, both sides"), row("Tooling holes (mm)", withBox(ge, gd)),
      row("Rail text", withBox(xe, xr, xd), "board names, revision, date"), row("Copper thieving", withBox(ce, cp), "on every copper layer of the rails"), row("Thieving size / pitch (mm)", pair(cs, cg)));

    // Fab profile, check, outputs.
    const FP = globalThis.AtriumFabProfiles, profs = FP?.list ? (() => { try { return FP.list(); } catch { return FP.BUILTIN || []; } })() : FP?.BUILTIN || [];
    const fab = sel([["", "From the board (default JLCPCB 2-layer)"], ...profs.map(x => [x.id, x.name])], p0.fabProfile || "");
    fab.onchange = () => set(p => { if (fab.value) p.fabProfile = fab.value; else delete p.fabProfile; });
    const drcList = el("ul", null, "panel-drc");
    const chk = section("Panel check (approximate)");
    chk.append(row("Check against", fab), drcList);
    const more = section("Name", false); more.append(row("Panel name", name));

    async function save(fileName, data) { const ok = await AtriumIO.exportFile(fileName, data); if (ok) status.textContent = "Exported " + fileName + "."; }
    const now = () => new Date();
    const actions = el("div", null, "work-actions");
    actions.append(
      button("Close", () => d.close(), "panel-close"),
      button("Drawing", async () => { try { const r = PN().drawing(host.project(), cur(), {date: now()}); await save(r.name, r.content); } catch (e) { status.textContent = e.message; } }),
      button("Order notes", async () => { try { const r = PN().orderNotes(host.project(), cur(), {date: now()}); await save(globalThis.AtriumFabOutputs.baseName(cur().name) + "-Order-Notes.txt", r.text); } catch (e) { status.textContent = e.message; } }),
      button("STEP", async () => {
        try { const L = globalThis.AtriumLazy; if (L && !globalThis.AtriumSTEP) await L.need("AtriumSTEP"); const r = PN().step(host.project(), cur(), {format: "step"}); await save(r.name, r.data); }
        catch (e) { status.textContent = e.message; }
      }),
      button("New panel", () => open(host, {create: true})),
      button("Export fab ZIP", async () => {
        try { const r = PN().build(host.project(), cur(), {date: now()}); await save(r.name, globalThis.AtriumFabOutputs.zip(r)); if (r.warnings.length) status.textContent += " " + r.warnings.length + " note(s) in the readme."; }
        catch (e) { status.textContent = e.message; }
      }, "is-primary"));

    const head = el("div", null, "panel-head");
    head.append(el("h2", "Panelize"), summary);
    d.append(head, el("h3", "Start from a preset"), presets, pv, pvCaption, cellBox, arr, sepS, frame, chk, more, status, actions);
    d.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); d.close(); } });

    function pick(i) { state.sel = i.row + "," + i.col; state.tab = null; refresh(); refreshInspector(); H.redraw(); }
    function refresh() {
      const dd = cur();
      if (dd.kind !== "panel") return;
      const q = P();
      let G = null;
      try { G = layoutOf(dd); } catch { G = null; }
      if (G) {
        const old = pv.querySelector("svg");
        const next = preview(G, pick);
        if (old) old.replaceWith(next); else pv.append(next);
      }
      for (const b of presets.children) b.setAttribute("aria-pressed", String(q.preset === b.dataset.preset));
      for (const b of seg.children) b.setAttribute("aria-checked", String(q.separation === b.dataset.value));
      tabRows.hidden = q.separation === "vscore";
      resetTabs.hidden = !q.tabs.manual;
      cellBox.replaceChildren(...cellEditor(dd, () => { refresh(); refreshInspector(); }));
      try {
        const r = PN().check(host.project(), dd);
        const e = r.items.filter(i => i.level === "error").length, w = r.items.filter(i => i.level === "warning").length;
        summary.textContent = fmt(r.size[0]) + " × " + fmt(r.size[1]) + " mm · " + r.boards + " board" + (r.boards === 1 ? "" : "s") + " · " +
          (q.separation === "vscore" ? r.vlines + " V-score lines" : r.tabs + " tabs, " + r.bites + " mouse bites") + " · " + (e ? e + " error" + (e === 1 ? "" : "s") : w ? w + " warning" + (w === 1 ? "" : "s") : "ready for fab");
        summary.dataset.level = e ? "error" : w ? "warning" : "ok";
        drcList.replaceChildren(...(r.items.length ? r.items : [{level: "ok", message: "No panel problems found."}]).map(i => {
          const li = el("li", null); li.dataset.level = i.level;
          const text = (i.level === "error" ? "Error: " : i.level === "warning" ? "Warning: " : "") + i.message;
          if (i.at) { const b = button(text, () => zoomTo(i.at), "panel-finding"); li.append(b); } else li.textContent = text;
          return li;
        }));
      } catch (e) { summary.textContent = e.message; }
    }
    function fill() {
      const q = P(), v = (i, x) => { if (document.activeElement !== i) i.value = String(x); };
      if (cur().kind !== "panel") return;
      if (document.activeElement !== name) name.value = cur().name;
      v(board, q.board); v(rows, q.rows); v(cols, q.cols); v(sx, q.spacing); v(sy, q.spacingY ?? q.spacing); link.checked = q.spacingY == null; v(rot, q.rotation); v(alt, q.alternate || "none");
      v(railW, q.rails.width); [...rails.querySelectorAll("input")].forEach((c, k) => { c.checked = q.rails[["top", "bottom", "left", "right"][k]]; });
      v(tw, q.tabs.width); v(tn, q.tabs.perEdge); v(th, q.tabs.hole); v(tp, q.tabs.pitch); v(to, q.tabs.offset); v(mill, q.mill?.radius || 0);
      fe.checked = q.fiducials.enabled; v(fd, q.fiducials.diameter); v(fo, q.fiducials.opening); ge.checked = q.tooling.enabled; v(gd, q.tooling.diameter);
      xe.checked = q.text.enabled; v(xr, q.text.revision); xd.checked = q.text.date; v(fab, q.fabProfile || "");
      const T = q.thieving || PN().THIEVING; ce.checked = T.enabled; v(cp, T.pattern); v(cs, T.size); v(cg, T.pitch);
    }
    // Typing previews at once; the value commits on change (one undo step).
    for (const i of d.querySelectorAll("input[type=number]")) i.addEventListener("input", () => { if (i.onchange && i.value !== "" && Number.isFinite(+i.value)) livePreview(); });
    function livePreview() {
      const q = P(), dd = cur(), n = (x, k) => Number.isFinite(+x.value) && x.value !== "" ? +x.value : k;
      const draft = {...q, rows: n(rows, q.rows), cols: n(cols, q.cols), spacing: n(sx, q.spacing), rails: {...q.rails, width: n(railW, q.rails.width)}, tabs: {...q.tabs, width: n(tw, q.tabs.width), perEdge: n(tn, q.tabs.perEdge)}};
      if (!link.checked) draft.spacingY = n(sy, q.spacingY ?? q.spacing);
      const G = layoutOf(dd, PN().normalize(draft));
      if (G) { const old = pv.querySelector("svg"), next = preview(G, pick); if (old) old.replaceWith(next); else pv.append(next); }
    }
    syncHook = () => { if (d.open) { fill(); refresh(); } };
    const offs = [host.on?.("change", () => { if (!d.open) return; fill(); refresh(); }), host.on?.("document", () => { if (!host.project().documents.some(x => x.id === pid)) d.close(); })];
    d.onclose = () => { offs.forEach(f => f?.()); if (dialog === d) { dialog = null; syncHook = null; } d.remove(); };
    document.body.append(d);
    globalThis.AtriumShell?.adoptDialog?.(d, {title:head.querySelector("h2"), body:[presets,pv,cellBox,arr,sepS,frame,chk,more,status], actions, sheet:true, order:"provided", defaultAction:false});
    d.show();
    fill(); refresh();
    return d;
  }
  let syncHook = null;
  const syncDialog = () => syncHook?.();
  function zoomTo(at) {
    if (!H?.zoomTo) return;
    const r = 6; H.zoomTo([at[0] - r, at[1] - r, at[0] + r, at[1] + r]);
  }

  // The picked cell: board, rotation and skip (mixed-board panels without a text syntax).
  function cellEditor(doc, after) {
    if (!state.sel) return [];
    const P = PN().normalize(doc.panel), [r, c] = state.sel.split(",").map(Number);
    if (r >= P.rows || c >= P.cols) { state.sel = null; return []; }
    const cell = P.cells[state.sel] || {}, boards = PN().panelBoards(H.project());
    const box = el("div", null, "panel-cell-editor"), head = el("p", "Cell row " + (r + 1) + ", column " + (c + 1), "panel-cell-title");
    const change = (fn, msg) => { if (commit(doc.id, next => { const k = state.sel, o = {...(next.cells[k] || {})}; fn(o); if (Object.keys(o).length) next.cells[k] = o; else delete next.cells[k]; }, msg)) { syncDialog(); after?.(); } };
    const b = sel([["", "Panel board (" + (boards.find(x => x.id === P.board)?.name || "?") + ")"], ...boards.map(x => [x.id, x.name])], cell.board || "");
    b.setAttribute("aria-label", "Board in this cell"); b.onchange = () => change(o => { if (b.value) o.board = b.value; else delete o.board; });
    const rot = sel([["", "Panel rotation"], [0, "0°"], [90, "90°"], [180, "180°"], [270, "270°"]], cell.rotation ?? "");
    rot.setAttribute("aria-label", "Rotation of this cell"); rot.onchange = () => change(o => { if (rot.value === "") delete o.rotation; else o.rotation = +rot.value; });
    const skip = checkbox(cell.skip, "Leave this cell empty"); skip.onchange = () => change(o => { if (skip.checked) o.skip = true; else delete o.skip; });
    const skipL = el("label", null, "panel-inline"); skipL.append(skip, " Leave empty");
    const reset = AtriumNavCommon.actionButton("Reset cell", () => change(o => { Object.keys(o).forEach(k => delete o[k]); }));
    box.append(head, row("Board", b), row("Rotation", rot), row("", skipL), row("", reset));
    return [box];
  }

  // ------------------------------------------------------------------ inspector
  function refreshInspector() {
    const n = state.inspector;
    if (n?.isConnected && liveDoc()) { n.replaceChildren(); inspect(n, H); }
  }
  function inspect(node, host) {
    H ||= host;
    state.inspector = node;
    const doc = host.doc(), ui = host.ui;
    node.append(el("h2", doc.name));
    try {
      const r = PN().check(host.project(), doc), P = PN().normalize(doc.panel), names = [...new Set((layoutOf(doc)?.instances || []).map(i => i.board.name))];
      const e = r.items.filter(i => i.level === "error").length, w = r.items.filter(i => i.level === "warning").length;
      const s = ui?.section ? ui.section(node, "Panel") : node;
      const line = (label, value) => ui?.row ? ui.row(s, label, value) : s.append(el("p", label + ": " + value));
      line("Boards", r.boards + " (" + (names.join(", ") || "none") + ", linked)");
      line("Array", P.rows + " × " + P.cols + (P.alternate ? ", alternating" : ""));
      line("Size", fmt(r.size[0]) + " × " + fmt(r.size[1]) + " mm");
      line("Separation", P.separation === "vscore" ? "V-score, " + r.vlines + " lines" : "Mouse bites, " + r.tabs + " tabs");
      line("Check", e ? e + " errors, " + w + " warnings" : w ? w + " warnings" : "ready for fab (approximate)");
    } catch (e) { node.append(el("p", e.message)); }
    if (state.sel) node.append(...cellEditor(doc, () => refreshInspector()));
    const G = layoutOf(doc), tab = state.tab && G?.tabs.find(t => t.key === state.tab.key && t.t === state.tab.t);
    if (tab) {
      const box = el("div", null, "panel-cell-editor");
      box.append(el("p", "Tab on board " + tab.instance + ", " + tab.side + " edge", "panel-cell-title"), el("p", "At " + fmt(tab.frac * tab.len) + " mm of " + fmt(tab.len) + " mm" + (tab.manual ? " (dragged)" : " (automatic)"), "panel-hint"),
        AtriumNavCommon.actionButton("Remove tab", () => removeTab(doc, state.tab)));
      node.append(box);
    }
    node.append(el("p", "Drag tabs, gaps and rails on the canvas; click a board to edit its cell.", "panel-hint"), AtriumNavCommon.actionButton("Edit panel…", () => open(host)));
  }

  // ------------------------------------------------------------------ install
  function attach(host) {
    if (H && H !== host) return;
    H = host;
    host.addRenderer?.((d, info) => d?.kind === "panel" && info?.active ? {overlay: (c, env) => paint(c, d, env)} : null);
    host.on?.("document", () => { state.sel = null; state.tab = null; state.hover = null; cancel(); });
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    const cancelPointer=e=>{if(state.drag?.pointerId===e.pointerId)cancel();};
    document.addEventListener("pointercancel",cancelPointer,true);
    document.addEventListener("lostpointercapture",cancelPointer,true);
    document.addEventListener("dblclick", onDbl, true);
    document.addEventListener("keydown", onKey, true);
    if (liveDoc()) host.redraw?.();
  }
  if (typeof document !== "undefined" && document.createElement) globalThis.AtriumNavCommon?.ready?.(attach);

  return Object.freeze({open, inspect, preview, handles, hitAt, inputAt, state});
})();
