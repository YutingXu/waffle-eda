"use strict";
// Editor tab strips that hold more tabs than fit (lazy; editor-demand.js loads it with the document tab
// commands, split-tabs.js hands it each pane strip). One policy for the document strip and every split
// pane's strip (docs/ui-library.md › Tabs):
//   - the strip scrolls sideways (a trackpad, or a mouse wheel turned over it) and never shows a scrollbar;
//   - each side that has tabs beyond it fades out (data-overflow="start", "end" or "start end" on the strip);
//   - a ⋯ button after the tabs, shown only while the strip overflows, lists every tab in strip order
//     (the shown one ticked) and shows the one chosen, through the shared dropdown menu;
//   - the selected tab scrolls fully into view, clear of the fades, whenever the selection moves to it.
// The ⋯ goes after the strip (the document strip, which is itself the tablist) or first into the strip's
// .ui-tab-strip-end, the group of trailing controls that stays in view while a pane strip scrolls.
// Measured on resize, scroll and tab changes, at most once per frame; nothing runs while nothing changes.
//
//   AtriumTabOverflow.watch(strip)  start watching a strip (idempotent)
//   AtriumTabOverflow.refresh(strip) / reveal(strip, tab)
globalThis.AtriumTabOverflow = (() => {
  const doc = globalThis.document;
  if (!doc) return Object.freeze({});
  const STRIPS = ".ui-editor-tab-strip:is([data-tab-strip=documents],[data-tab-strip=pane])";
  const TABS = ':scope > [role=tab]:not([hidden]), :scope > .document-tab:not([hidden])';
  const state = new WeakMap(); // strip -> {wrap, button, selected}
  const pending = new Set();
  let frame = 0;

  const tabsOf = strip => [...strip.querySelectorAll(TABS)];
  const selectedOf = strip => tabsOf(strip).find(t => t.getAttribute("aria-selected") === "true") || null;
  const fade = strip => parseFloat(getComputedStyle(strip).getPropertyValue("--ui-tab-fade")) || 0;
  const endGroup = strip => strip.querySelector(":scope > .ui-tab-strip-end");

  function moreButton() {
    const wrap = doc.createElement("span"), b = doc.createElement("button");
    wrap.className = "ui-tab-overflow"; wrap.hidden = true;
    b.type = "button"; b.className = "ui-icon-button";
    b.setAttribute("aria-label", "Open documents"); b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false");
    b.dataset.tooltipLabel = "Open documents";
    // The ⋯ every overflow menu uses (Projects, Messages, dock tab strips).
    const NS = "http://www.w3.org/2000/svg", icon = doc.createElementNS(NS, "svg"), dots = doc.createElementNS(NS, "g");
    icon.setAttribute("class", "icon"); icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
    dots.setAttribute("fill", "currentColor"); dots.setAttribute("stroke", "none");
    for (const cx of [5, 12, 19]) {const c = doc.createElementNS(NS, "circle"); c.setAttribute("cx", cx); c.setAttribute("cy", 12); c.setAttribute("r", 1.7); dots.append(c);}
    icon.append(dots); b.append(icon); wrap.append(b);
    return {wrap, button: b};
  }
  // ⋯ sits first in the strip's trailing group, or right after a strip without one.
  function place(strip, s) {
    const end = endGroup(strip);
    if (end) {if (end.firstElementChild !== s.wrap) end.prepend(s.wrap);}
    else if (strip.nextElementSibling !== s.wrap && strip.parentElement) strip.after(s.wrap);
  }
  function label(tab) {
    const text = tab.querySelector(":scope > span:not([aria-hidden])")?.textContent || tab.textContent || "";
    return text.trim() || tab.title || "Untitled";
  }
  function menu(strip, s) {
    const entries = tabsOf(strip).map(tab => ({label: label(tab), checked: tab.getAttribute("aria-selected") === "true", radio: true, enabled: true,
      run: () => {if (tab.isConnected) {tab.click(); reveal(strip, tab);}}}));
    const L = globalThis.AtriumLazy;
    const open = M => {if (s.button.isConnected) M.dropdown(s.button, entries);};
    if (globalThis.AtriumContextMenu) open(globalThis.AtriumContextMenu);
    else L?.need?.("AtriumContextMenu").then(open, e => globalThis.AtriumNavHost?.info?.(e.message));
  }

  // Scroll so the tab shows whole, clear of the fades and the trailing group. Whole pixels only.
  function reveal(strip, tab) {
    if (!tab || tab.parentElement !== strip || strip.scrollWidth - strip.clientWidth < 1) return;
    const box = strip.getBoundingClientRect(), t = tab.getBoundingClientRect(), f = fade(strip);
    const end = endGroup(strip), endW = end ? end.getBoundingClientRect().width : 0;
    const lo = box.left + strip.clientLeft + f, hi = box.left + strip.clientLeft + strip.clientWidth - endW - f;
    let dx = 0;
    if (t.left < lo) dx = t.left - lo;
    else if (t.right > hi) dx = Math.min(t.right - hi, t.left - lo);
    if (dx) strip.scrollLeft = Math.round(strip.scrollLeft + dx);
  }
  function measure(strip) {
    const s = state.get(strip);
    if (!s) return;
    if (!strip.isConnected) { // a pane strip whose split closed: let it go
      state.delete(strip); s.wrap.remove();
      if (resized) for (const n of [strip, ...strip.children]) resized.unobserve(n);
      return;
    }
    place(strip, s);
    // ⋯ first: showing it narrows the document strip. It hides only once the tabs fit without it.
    if (s.wrap.hidden) {if (strip.scrollWidth - strip.clientWidth >= 1) s.wrap.hidden = false;}
    else if (strip.scrollWidth - strip.clientWidth - s.wrap.offsetWidth < 1) s.wrap.hidden = true; // beside the strip or in it, ⋯ takes its width
    // The selected tab comes into view when the selection moves to it, and again when the strip resizes.
    const selected = selectedOf(strip), width = strip.clientWidth;
    if (selected && (selected !== s.selected || width !== s.width)) reveal(strip, selected);
    s.selected = selected; s.width = width;
    const max = strip.scrollWidth - strip.clientWidth, x = Math.abs(strip.scrollLeft);
    const sides = max >= 1 ? [x >= 1 && "start", x <= max - 1 && "end"].filter(Boolean).join(" ") : "";
    if ((strip.dataset.overflow || "") !== sides) {if (sides) strip.dataset.overflow = sides; else delete strip.dataset.overflow;}
    const endFade = sides.includes("end");
    if (("fade" in s.wrap.dataset) !== endFade) {if (endFade) s.wrap.dataset.fade = ""; else delete s.wrap.dataset.fade;}
  }
  function refresh(strip) {
    pending.add(strip);
    if (frame) return;
    frame = requestAnimationFrame(() => {frame = 0; const list = [...pending]; pending.clear(); for (const s of list) measure(s);});
  }

  const resized = typeof ResizeObserver === "function" ? new ResizeObserver(entries => {
    for (const e of entries) {const strip = e.target.matches(STRIPS) ? e.target : e.target.parentElement; if (strip) refresh(strip);}
  }) : null;
  const changed = new MutationObserver(records => {
    for (const r of records) {
      const strip = (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest(STRIPS);
      if (!strip) continue;
      if (r.type === "childList" && r.target === strip && resized) {
        for (const n of r.addedNodes) if (n.nodeType === 1 && n.matches(".document-tab")) resized.observe(n);
        for (const n of r.removedNodes) if (n.nodeType === 1) resized.unobserve(n);
      }
      refresh(strip);
    }
  });
  // A vertical wheel turn over the tabs scrolls them sideways (VS Code, Altium); a trackpad's sideways swipe already does.
  function wheel(e) {
    const strip = e.currentTarget;
    if (e.ctrlKey || e.deltaX || !e.deltaY || strip.scrollWidth - strip.clientWidth < 1) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  }

  function watch(strip) {
    if (!strip?.matches?.(STRIPS) || state.has(strip)) {if (strip && state.has(strip)) refresh(strip); return;}
    const s = {...moreButton(), selected: null, width: 0};
    state.set(strip, s);
    s.button.addEventListener("click", e => {e.stopPropagation(); menu(strip, s);});
    strip.addEventListener("scroll", () => refresh(strip), {passive: true});
    strip.addEventListener("wheel", wheel, {passive: false});
    resized?.observe(strip);
    for (const t of tabsOf(strip)) resized?.observe(t);
    changed.observe(strip, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-selected", "hidden"]});
    refresh(strip);
  }
  // The editor's strips; others (the gallery's specimen) call watch() themselves.
  for (const strip of doc.querySelectorAll("#document-tabs, .pane-tabs")) watch(strip);
  return Object.freeze({watch, refresh, reveal});
})();
