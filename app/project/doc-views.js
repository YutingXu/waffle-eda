"use strict";
// Document views (lazy): tabs that are not documents, such as the Rules and Constraints Editor, hosted in an editor
// pane beside the documents. A view covers its pane's canvas and has a tab in the document strip, or in its
// pane's strip while the editor is split (split-tabs.js calls decorate() after each render). Choosing a document
// in that pane shows the canvas again; the view keeps its tab until it is closed (its ×, a middle click, or Delete
// on the focused tab). One view per id; opening an open view shows it.
//
//   AtriumDocViews.open(id, {title, icon?, mount(el), onClose?}) -> the view's element (mount runs once)
//   AtriumDocViews.show(id) / hide(id) / close(id) / isOpen(id) / decorate()
globalThis.AtriumDocViews = (() => {
  const G = globalThis, views = new Map(), MIME = "application/x-atrium-document-view";
  const D = () => G.document;
  const host = () => G.AtriumNavHost || null;
  const panes = () => host()?.panes?.() || [];
  const split = () => panes().length > 1;
  const activeIndex = () => Math.max(0, panes().findIndex(p => p.active));
  const stageOf = k => panes()[k]?.canvas?.parentElement || D()?.getElementById("canvas-stage") || null;
  function el(tag, text, cls) { return AtriumNavCommon.elementIn(D(), tag, text, cls); }

  function open(id, o = {}) {
    let v = views.get(id);
    if (!v) {
      const box = el("div", null, "doc-view");
      box.id = "doc-view-" + id; box.setAttribute("role", "tabpanel");
      box.setAttribute("aria-labelledby", "doc-view-tab-" + id); box.dataset.view = id; box.hidden = true;
      v = {id, title: o.title || id, tip: o.tip || o.title || id, icon: o.icon || "book", pane: activeIndex(), el: box, onClose: o.onClose || null, tab: null};
      views.set(id, v);
      place(v);
      o.mount?.(box);
    }
    show(id);
    return v.el;
  }
  // A view stays in a pane that exists (the second pane closed: it moves to the first).
  function place(v) {
    if (v.pane >= panes().length) v.pane = 0;
    const stage = stageOf(v.pane);
    if (stage && v.el.parentElement !== stage) stage.append(v.el);
  }
  function show(id) {
    const v = views.get(id); if (!v) return;
    for (const w of views.values()) if (w !== v && w.pane === v.pane) w.el.hidden = true;
    if (v.pane !== activeIndex()) {
      const canvas = panes()[v.pane]?.canvas;
      if (canvas) { canvas.inert = false; canvas.focus(); }
    }
    place(v); v.el.hidden = false; decorate();
  }
  function hide(id) { const v = views.get(id); if (!v || v.el.hidden) return; v.el.hidden = true; decorate(); host()?.canvas?.()?.focus?.(); }
  function close(id) {
    const v = views.get(id); if (!v) return;
    const doc = D(), focused = doc.activeElement;
    const restoreFocus = !focused || focused === doc.body || v.el.contains(focused) || v.tab?.contains(focused);
    views.delete(id); v.el.remove();
    const strip = v.tab?.parentElement, motion = G.AtriumSpatialMotion;
    if (strip && motion) motion.tabLayout(strip, () => v.tab.remove()); else v.tab?.remove();
    decorate();
    try { v.onClose?.(); } catch { /* the view's own clean-up */ }
    // A delayed close leaves focus on any control the user has already reached.
    if (restoreFocus && (doc.activeElement === focused || doc.activeElement === doc.body)) {
      host()?.canvas?.()?.focus?.({preventScroll:true});
    }
  }
  function focusPane(canvas) {
    const v = [...views.values()].find(view => !view.el.hidden && view.el.parentElement === canvas.parentElement);
    if (!v) {canvas.focus({preventScroll:true}); return;}
    if (v.pane !== activeIndex()) show(v.id);
    const target = v.el.querySelector('pre[tabindex="0"],[role=treeitem][tabindex="0"],[role=grid][tabindex="0"]')
      || v.el.querySelector('button:enabled,[tabindex="0"]');
    if (target) target.focus({preventScroll:true}); else v.tab?.focus();
  }
  function tabOf(v) {
    if (v.tab) return v.tab;
    const t = el("button", null, "document-tab ui-document-tab view-tab ui-tab");
    t.type = "button"; t.id = "doc-view-tab-" + v.id; t.setAttribute("role", "tab");
    t.setAttribute("aria-controls", v.el.id); t.setAttribute("aria-keyshortcuts", "Delete");
    t.setAttribute("aria-description", "Press " + (G.AtriumKeymap?.display("Delete", true) || "Delete") + " to close this tab.");
    t.dataset.view = v.id; t.title = v.tip; t.draggable = true;
    t.addEventListener("dragstart", event => {
      if (!event.dataTransfer) return;
      event.dataTransfer.setData(MIME, v.id);
      event.dataTransfer.effectAllowed = "move";
    });
    const x = el("span", null, "view-tab-close ui-chrome-action ui-chrome-action-compact");
    x.setAttribute("aria-hidden", "true");
    G.AtriumNavCommon?.shortcutTitle?.(x, "Close", "Delete");
    t.append(G.AtriumNavCommon.icon(v.icon), el("span", v.title), x);
    t.addEventListener("click", e => { e.stopPropagation(); if (e.target.closest(".view-tab-close")) close(v.id); else show(v.id); });
    t.addEventListener("auxclick", e => { if (e.button === 1) { e.preventDefault(); close(v.id); } });
    t.addEventListener("keydown", e => { if (e.key === "Delete") { e.preventDefault(); e.stopPropagation(); close(v.id); } });
    return v.tab = t;
  }
  // Each view's tab in its strip: the document strip, or its pane's strip while split.
  function decorate() {
    const d = D(); if (!d) return;
    for (const v of views.values()) place(v);
    const shown = [...views.values()].filter(v => !v.el.hidden), openPanes = panes();
    const activeView = shown.find(v => v.pane === activeIndex());
    d.body.classList.toggle("document-view-active", !!activeView);
    d.body.classList.toggle("history-view-active", activeView?.id === "history");
    openPanes.forEach((pane, index) => {
      const under = shown.some(v => v.pane === index), stage = pane.canvas.parentElement;
      // The tool bar and canvas are covered by the document view. Remove them
      // from the accessibility tree and the Tab order until the canvas returns.
      if (pane.canvas.inert !== under) pane.canvas.inert = under;
      const toolbar = stage.querySelector(":scope > .active-bar");
      if (toolbar && toolbar.inert !== under) toolbar.inert = under;
      if (stage.id === "canvas-stage" && openPanes.length === 1) {
        stage.setAttribute("role", under ? "group" : "tabpanel");
        if (under) stage.removeAttribute("aria-labelledby"); else stage.setAttribute("aria-labelledby", "current-document-tab");
      }
    });
    for (const strip of d.querySelectorAll("#document-tabs, .pane-tabs")) {
      const pane = +(strip.dataset.pane || 0), active = shown.some(v => v.pane === pane);
      for (const n of strip.querySelectorAll("[data-tab]")) {
        n.classList.toggle("is-under-view", active);
        if (!openPanes[pane]?.docId) continue;
        const selected = !active && n.dataset.tab === openPanes[pane].docId;
        n.setAttribute("aria-selected", String(selected));
        n.tabIndex = selected ? 0 : -1;
      }
    }
    for (const v of views.values()) {
      const strip = split() ? d.querySelector('.pane-tabs[data-pane="' + v.pane + '"]') : d.getElementById("document-tabs");
      if (!strip) continue;
      const t = tabOf(v), nextDocument = [...strip.querySelectorAll(":scope > [data-tab]")].find(tab => tab.dataset.tab === v.before);
      const before = nextDocument || strip.querySelector(":scope > :is(.pane-arrange,.pane-close)");
      let next = t.nextElementSibling;
      while (next?.dataset.view) next = next.nextElementSibling;
      if (t.parentElement !== strip || next !== before) {
        const insert = () => strip.insertBefore(t, before || null), motion = G.AtriumSpatialMotion;
        if (motion) motion.tabLayout(strip,insert); else insert();
      }
      const on = !v.el.hidden;
      t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; t.classList.toggle("is-shown", on);
    }
    for (const strip of d.querySelectorAll(".pane-tabs")) G.AtriumSplitTabs?.ownTabs(strip);
  }
  function rememberOrder(strip) {
    let before;
    for (const tab of [...strip.querySelectorAll(":scope > .document-tab")].reverse()) {
      if (tab.dataset.tab) before = tab.dataset.tab;
      else if (views.has(tab.dataset.view)) views.get(tab.dataset.view).before = before;
    }
  }
  function move(id, pane) {
    const v = views.get(id);
    if (!v || !panes()[pane]) return;
    if (pane !== v.pane) {
      v.pane = pane;
      v.before = undefined;
    }
    show(id);
  }
  // Choosing a document in a pane (its tab, the Explorer, a shortcut) shows that pane's canvas again.
  function documentChosen(e) {
    const t = e.target.closest?.("#document-tabs [data-tab], .pane-tab[data-tab]"); if (!t) return;
    const k = split() ? +(t.closest(".pane-tabs")?.dataset.pane ?? activeIndex()) : 0;
    for (const v of views.values()) if (v.pane === k && !v.el.hidden) hide(v.id);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("click", documentChosen, true);
    G.AtriumNavCommon?.ready?.(h => {
      h.on?.("document", () => { const k = activeIndex(); for (const v of views.values()) if (v.pane === k && !v.el.hidden) hide(v.id); decorate(); });
      h.on?.("panes", decorate);
    });
  }
  return Object.freeze({open, show, hide, close, decorate, focusPane, rememberOrder, move, isOpen: id => views.has(id), isShown: id => !!views.get(id) && !views.get(id).el.hidden});
})();
