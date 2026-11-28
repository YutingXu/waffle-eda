"use strict";
// Active Bar tooltips and flyout gestures; the flyout and custom bars are lazy (active-bar-menu.js, bars.js).
globalThis.AtriumActiveBar = (() => {
  let want = null, pressTimer = 0, suppress = false;
  const G = globalThis, D = document, kind = () => D.body.dataset.kind || "schematic", M = () => G.AtriumActiveBarMenu;
  const load = () => G.AtriumLazy.need("AtriumActiveBarMenu");
  function titles() {
    for (const b of D.querySelectorAll("#tools .tool[data-action]")) {
      const a = b.dataset.action;
      if (a === "route" || a === "label") continue; // named by the editor
      const base = b.dataset.baseTitle || (b.dataset.baseTitle = (b.getAttribute("aria-label") || b.dataset.tooltip || b.title || "").replace(/\s*\(.*\)$/, ""));
      const key = G.AtriumKeymap?.menuHintKey(b, kind()), more = b.dataset.toolGroup ? " · hold for more" : "";
      G.AtriumNavCommon?.shortcutTitle(b, key ? base : base + more, key, more);
    }
  }
  // Escape, Tab, ← or a click elsewhere cancels a flyout that is still loading.
  function cancel(refocus = true) {
    const b = want; want = null;
    b?.setAttribute("aria-expanded", "false");
    if (refocus) b?.focus();
  }
  function open(button) {
    if (M()) return M().open(button);
    if (!button.dataset.toolGroup) return null;
    want = button; button.setAttribute("aria-expanded", "true");
    load().then(m => { if (want === button) { want = null; m.open(button); } }, e => { if (want === button) { cancel(false); G.AtriumNavHost?.info(e.message); } });
    return null;
  }
  // A kind with a custom bar or flyout face stays hidden until bars.js draws it.
  function bars(overflow) {
    const bar = D.getElementById("tools");
    if (G.AtriumBars || !bar) return;
    let hold = false;
    try { hold = !!(G.AtriumPref.get("workbench.bars")?.active?.[kind()] || JSON.parse(localStorage.getItem("atrium.bar-faces") || "{}")[kind()]); } catch {}
    if (!hold && !overflow) return;
    if (hold) bar.dataset.pending = "";
    load().then(() => G.AtriumBars.sync(), () => {}).finally(() => delete bar.dataset.pending);
  }
  function attach() {
    const bar = D.getElementById("tools");
    if (!bar) return;
    titles(); bars();
    // A settings import changes the key map and may bring flyout faces (written a moment later).
    G.AtriumKeymap?.onChange?.(() => { titles(); queueMicrotask(() => bars()); });
    new MutationObserver(() => { titles(); bars(); }).observe(D.body, {attributes:true, attributeFilter:["data-kind"]});
    new ResizeObserver(() => { if (bar.scrollWidth > bar.clientWidth + 1) bars(true); }).observe(bar);
    // Every flyout owner opens the same way: a markup tool, a user's group, More tools.
    bar.addEventListener("pointerdown", e => {
      const b = e.target.closest?.(".tool[data-tool-group]");
      if (!b || e.button !== 0) return;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {suppress = true; open(b);}, 380);
    });
    for (const t of ["pointerup", "pointerleave", "pointercancel"]) bar.addEventListener(t, () => clearTimeout(pressTimer));
    bar.addEventListener("click", e => {if (suppress) {suppress = false; e.preventDefault(); e.stopPropagation();}}, true);
    bar.addEventListener("contextmenu", e => {
      const b = e.target.closest?.(".tool");
      if (b && !b.dataset.toolGroup) return;
      e.preventDefault();
      if (b) open(b); else load().then(() => G.AtriumBars.menu(), () => {});
    });
    bar.addEventListener("keydown", e => {
      const b = e.target.closest?.(".tool[data-tool-group]");
      if (b && e.key === "ArrowDown") {e.preventDefault(); e.stopPropagation(); open(b);}
    });
    D.addEventListener("keydown", e => {
      if (want && ["Escape", "Tab", "ArrowLeft"].includes(e.key)) {e.preventDefault(); e.stopPropagation(); cancel();}
    }, true);
    for (const t of ["pointerdown", "focusin"]) D.addEventListener(t, e => {if (want && !want.contains(e.target)) cancel(false);}, true);
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, {once:true}); else attach();
  }
  return {open, close: (...a) => M() ? M().close(...a) : cancel(...a), titles};
})();
