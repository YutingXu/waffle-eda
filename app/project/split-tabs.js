"use strict";
// Split editor tab strips (lazy: editor.js loads it when a second pane opens). Like VS Code's
// editor groups, each pane has its own strip of open documents:
//   - click a tab to show it in that pane; drag a tab onto the other pane (its strip or canvas) to move it;
//   - × (or a middle click, or Delete on a focused tab) closes the tab; closing a pane's last tab closes the pane;
//   - the × at the end of a strip closes that pane; Mod+K ←/→ move focus to the previous / next pane, F6 / Shift+F6 cycle.
// The global document strip hides while split and comes back when the split closes. Per-pane tab lists
// live in sessionStorage next to the split itself (editor.js "atrium-split-v1").
//
// Pure helpers (headless): AtriumSplitTabs.plan(groups, docIds, shown, activeIndex) -> groups
globalThis.AtriumSplitTabs = (() => {
  const KEY = "atrium-split-tabs-v1", MIME = "application/x-atrium-document", PANE = "application/x-atrium-pane", VIEW = "application/x-atrium-document-view";
  let host = null, groups = null, strips = [];
  const closed = new Set(); // tabs closed while split; shown again when a pane shows the document
  const D = () => globalThis.document;

  // Keep each pane's list valid: drop deleted documents, add each pane's shown document, and give
  // documents that are in neither list (new sheets) to the active pane, except tabs closed in this split.
  function plan(gs, docIds, shown, active = 0, closed = null) {
    const ok = new Set(docIds), out = [0, 1].map(k => [...new Set((gs?.[k] || []).filter(id => ok.has(id)))]);
    shown.forEach((id, k) => {if (id && ok.has(id) && !out[k].includes(id)) out[k].push(id);});
    for (const id of docIds) if (!out[0].includes(id) && !out[1].includes(id) && !closed?.has(id)) out[active].push(id);
    return out;
  }
  function load() {try {const s = JSON.parse(globalThis.sessionStorage?.getItem(KEY) || "null"); return Array.isArray(s) && s.length === 2 ? s : null;} catch {return null;}}
  function save() {try {globalThis.sessionStorage?.setItem(KEY, JSON.stringify(groups));} catch {}}

  function panes() {return host?.panes?.() || [];}
  const stacked = () => !!D()?.getElementById("editor-panes")?.classList.contains("split-down");
  function el(tag, text, cls) { return AtriumNavCommon.elementIn(D(), tag, text, cls); }

  // Show document id in pane k (its canvas takes focus, which activates the pane).
  function show(k, id) {
    const ps = panes(), p = ps[k], q = ps[1 - k];
    if (!p) return;
    if (p.active) {
      if (p.docId === id) {p.canvas.focus(); return;}
      if (q?.docId === id) {q.canvas.focus(); host.showInOther(id); p.canvas.focus(); return;}
      host.selectDocument(id); p.canvas.focus(); return;
    }
    if (p.docId !== id) host.showInOther(id);
    p.canvas.focus();
  }
  function closePane(k) {
    const ps = panes(); if (ps.length < 2) return;
    // The pane that stays becomes active first, so closeSplit keeps its document in the primary pane.
    ps[1 - k].canvas.focus();
    host.act("split-close");
  }
  function closeTab(k, id) {
    const g = groups?.[k]; if (!g) return;
    const at = g.indexOf(id); if (at < 0) return;
    g.splice(at, 1); save();
    if (!groups.some(x => x.includes(id))) closed.add(id);
    if (!g.length) {closePane(k); return;}
    if (panes()[k]?.docId === id) show(k, g[Math.min(at, g.length - 1)]);
    else render();
  }
  function moveTab(from, to, id) {
    if (!groups) return;
    if (from !== to && from != null) {const g = groups[from], at = g.indexOf(id); if (at >= 0) g.splice(at, 1);}
    if (!groups[to].includes(id)) groups[to].push(id);
    save();
    const emptied = from != null && from !== to && !groups[from].length;
    show(to, id);
    if (emptied) closePane(from); else if (from != null && from !== to && panes()[from]?.docId === id) show(from, groups[from][0]);
    if (!emptied) panes()[to]?.canvas.focus();
  }
  // The panes trade tab lists (editor.js: a pane's only tab dropped on the far edge, so the panes trade places).
  function swap() {if (groups) {groups = [groups[1], groups[0]]; save();}}
  // Mod+K ←/→ move towards the first or the last pane; F6 / Shift+F6 cycle.
  function focusPane(step, wrap) {
    const ps = panes();
    if (ps.length < 2) {
      ps[0]?.canvas.focus();
      const hint = globalThis.AtriumKeymap?.hintFor("split-toggle", host.doc().kind);
      host.info("There is one pane. " + (hint ? hint + " splits the editor." : "Use Window › Split Right to open a second pane."));
      return;
    }
    const k = Math.max(0, ps.findIndex(p => p.active)), n = wrap ? (k + step + ps.length) % ps.length : Math.max(0, Math.min(ps.length - 1, k + step));
    const canvas = ps[n].canvas;
    if (canvas.inert && globalThis.AtriumDocViews?.focusPane) globalThis.AtriumDocViews.focusPane(canvas);
    else canvas.focus();
    const d = host.docById(ps[n].docId); host.info("Pane " + (n + 1) + " · " + (d?.name || ""));
  }

  function strip(k) {
    const s = el("div", null, "pane-tabs ui-tabs ui-editor-tab-strip"); s.dataset.tabStrip = "pane"; s.dataset.pane = String(k);
    s.addEventListener("click", e => {
      const x = e.target.closest?.(".pane-tab-close"); if (x) {e.stopPropagation(); closeTab(k, x.closest(".pane-tab").dataset.tab); return;}
      if (e.target.closest?.(".pane-close")) {closePane(k); return;}
      if (e.target.closest?.(".pane-arrange")) {host.act(stacked() ? "split-right" : "split-down"); return;}
      const t = e.target.closest?.(".pane-tab"); if (t) show(k, t.dataset.tab);
    });
    s.addEventListener("auxclick", e => {const t = e.target.closest?.(".pane-tab"); if (t && e.button === 1) {e.preventDefault(); closeTab(k, t.dataset.tab);}});
    s.addEventListener("keydown", e => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target.closest?.("[role=tab]"); if (!t) return;
      const list = [...s.querySelectorAll("[role=tab]")], at = list.indexOf(t);
      const go = {ArrowLeft:at - 1, ArrowRight:at + 1, Home:0, End:list.length - 1}[e.key];
      if (go != null) {e.preventDefault(); e.stopPropagation(); list[(go + list.length) % list.length]?.focus(); return;}
      if (!t.matches(".pane-tab")) return;
      if (e.key === "Enter" || e.key === " ") {e.preventDefault(); e.stopPropagation(); show(k, t.dataset.tab);}
      else if (e.key === "Delete") {e.preventDefault(); e.stopPropagation(); closeTab(k, t.dataset.tab);}
    });
    s.addEventListener("dragstart", e => {
      const t = e.target.closest?.(".pane-tab"); if (!t || !e.dataTransfer) return;
      e.dataTransfer.setData(MIME, t.dataset.tab); e.dataTransfer.setData(PANE, String(k)); e.dataTransfer.effectAllowed = "move";
    });
    return s;
  }
  // Drops on a pane (its strip or its canvas) move the tab there; the editor's own drop handler is skipped.
  function bindDrop(stage, k) {
    if (stage.dataset.tabDrop) return; stage.dataset.tabDrop = "1";
    const ours = e => [...(e.dataTransfer?.types || [])].some(type => type === MIME || type === VIEW);
    const highlight = on => globalThis.AtriumSpatialMotion?.target(stage, on);
    stage.addEventListener("dragover", e => {if (!ours(e) || !groups) return; e.preventDefault(); highlight(true);});
    stage.addEventListener("dragleave", e => {if (!stage.contains(e.relatedTarget)) highlight(false);});
    stage.addEventListener("drop", e => {
      highlight(false);
      if (!ours(e) || !groups) return;
      e.preventDefault(); e.stopPropagation();
      const id = e.dataTransfer.getData(MIME), raw = e.dataTransfer.getData(PANE), from = raw === "" ? null : +raw;
      const now = panes().findIndex(p => p.canvas.parentElement === stage);
      const target = now < 0 ? k : now, view = e.dataTransfer.getData(VIEW);
      if (view) globalThis.AtriumDocViews?.move(view, target);
      else if (host.docById(id)) moveTab(from, target, id);
    });
  }

  function render() {
    const ps = panes(), d = D(); if (!d) return;
    const area = d.getElementById("editor-area");
    if (ps.length < 2 || !groups) {
      for (const s of strips) s.remove(); strips = [];
      area?.classList.remove("has-pane-tabs"); globalThis.AtriumDocViews?.decorate?.(); return;
    }
    area?.classList.add("has-pane-tabs");
    ps.forEach((p, k) => {
      const stage = p.canvas.parentElement; if (!stage) return;
      let s = strips[k];
      if (!s || s.parentElement !== stage) {s?.remove(); s = strips[k] = strip(k); stage.prepend(s);}
      bindDrop(stage, k);
      globalThis.AtriumSpatialMotion?.tabs(s, order => {
        groups[k] = order; save(); globalThis.AtriumDocViews?.rememberOrder(s); ownTabs(s);
      });
      s.classList.toggle("is-active", !!p.active);
      const want = groups[k], have = [...s.querySelectorAll(".pane-tab")];
      const spatial = globalThis.AtriumSpatialMotion;
      if (!spatial?.dragOrder(s) && have.map(t => t.dataset.tab).join("|") !== want.join("|")) {
        const rebuild = () => {
          const list = el("div", null, "pane-tab-list visually-hidden");
          list.setAttribute("role", "tablist"); list.setAttribute("aria-label", "Pane " + (k + 1) + " documents");
          s.replaceChildren(list);
          for (const [index, id] of want.entries()) {
            const doc = host.docById(id); if (!doc) continue;
            const t = el("button", null, "document-tab ui-document-tab pane-tab ui-tab editor-chrome-tab");
            t.type = "button"; t.id = "pane-tab-" + k + "-" + index; t.setAttribute("role", "tab");
            t.setAttribute("aria-controls", stage.id); t.setAttribute("aria-keyshortcuts", "Delete");
            t.setAttribute("aria-description", "Press " + (globalThis.AtriumKeymap?.display("Delete", true) || "Delete") + " to close this tab.");
            t.dataset.tab = id; t.draggable = true;
            const close = el("span", null, "pane-tab-close document-tab-close ui-chrome-action ui-dismiss-glyph"); close.setAttribute("aria-hidden", "true");
            globalThis.AtriumNavCommon?.shortcutTitle(close, "Close", "Delete");
            t.append(AtriumNavCommon.icon(doc.kind === "pcb" ? "board" : "schematic"), el("span", doc.name), close);
            s.append(t);
          }
          // Each strip keeps a split control (beta: "split controls are gone once clicked"): it turns the split
          // between side by side and stacked. The pane engine holds two panes; more panes are a proposal.
          const arrange = el("button", null, "ui-icon-button pane-arrange"); arrange.type = "button";
          const ns = "http://www.w3.org/2000/svg", svg = D().createElementNS(ns, "svg"), frame = D().createElementNS(ns, "rect"), line = D().createElementNS(ns, "path");
          svg.setAttribute("class", "icon"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
          for (const [a, v] of [["x", "3.5"], ["y", "4.5"], ["width", "17"], ["height", "15"], ["rx", "1.5"]]) frame.setAttribute(a, v);
          svg.append(frame, line); arrange.append(svg); s.append(arrange);
          const x = el("button", null, "pane-close ui-chrome-action"); x.type = "button"; x.dataset.hover = "focus"; x.title = "Close Pane"; x.setAttribute("aria-label", "Close pane " + (k + 1)); x.append(AtriumNavCommon.icon("close"));
          s.append(x);
        };
        if (spatial && have.length) spatial.tabLayout(s,rebuild,false); else rebuild();
      }
      for (const t of s.querySelectorAll(".pane-tab")) {
        const doc = host.docById(t.dataset.tab), on = t.dataset.tab === p.docId;
        t.dataset.kind = doc?.kind || ""; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1;
        const label = t.querySelector("span"); if (doc && label.textContent !== doc.name) label.textContent = doc.name;
        t.title = doc?.sourceName || doc?.name || "";
      }
      const arrange = s.querySelector(":scope > .pane-arrange");
      if (arrange) {
        const down = stacked(), label = down ? "Split right (side by side)" : "Split down (stacked)";
        if (arrange.getAttribute("aria-label") !== label) {
          arrange.setAttribute("aria-label", label);
          globalThis.AtriumNavCommon?.shortcutTitle(arrange, label, globalThis.AtriumKeymap?.hintKey(down ? "split-right" : "split-down", host.doc().kind));
          arrange.querySelector("path").setAttribute("d", down ? "M12 4.5v15" : "M3.5 12h17");
        }
      }
      ownTabs(s);
      globalThis.AtriumSplitFollow?.decorate?.(s, p, k); // split-follow: the Follow eye on the inactive strip
    });
    globalThis.AtriumDocViews?.decorate?.(); // doc-views.js: view tabs (the rules editor) in their pane's strip
  }
  function ownTabs(strip) {
    const list = strip.querySelector(":scope > .pane-tab-list");
    if (!list) return;
    const ids = [...strip.querySelectorAll(":scope > [role=tab]")].map(tab => tab.id).join(" ");
    if (ids !== list.getAttribute("aria-owns")) list.setAttribute("aria-owns", ids);
  }
  // editor.js calls this from syncSplit() (every refresh while split, and once when it closes).
  function sync() {
    if (!host) return;
    const ps = panes(), docs = host.project().documents.map(d => d.id);
    if (ps.length < 2) {closed.clear(); if (groups) {groups = null; try {globalThis.sessionStorage?.removeItem(KEY);} catch {}} render(); return;}
    if (!groups) {
      // First split: the primary pane keeps every document (the old strip); the new pane starts with its own.
      const saved = load();
      groups = saved || [docs.slice(), [ps[1].docId]];
    }
    for (const p of ps) closed.delete(p.docId);
    groups = plan(groups, docs, ps.map(p => p.docId), Math.max(0, ps.findIndex(p => p.active)), closed);
    save(); render();
  }

  function attach(h) {
    host = h;
    host.registerAction("focus-pane-next", () => focusPane(1, false));
    host.registerAction("focus-pane-prev", () => focusPane(-1, false));
    host.registerAction("focus-pane-other", () => focusPane(1, true));
    sync();
  }
  globalThis.AtriumNavCommon?.ready(attach);
  return Object.freeze({plan, sync, ownTabs, show, closeTab, moveTab, swap, focusPane, get groups() {return groups && groups.map(g => [...g]);}});
})();
