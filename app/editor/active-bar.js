"use strict";
// Active Bar flyouts (Altium-style). Long-press a tool, right-click it, or press
// Alt+↓ / ↓ on a focused tool to open its group: the group's other tools with their
// shortcuts. Every tool's tooltip shows its current shortcut from the key map.
globalThis.AtriumActiveBar = (() => {
  let fly = null, owner = null, pressTimer = 0, suppress = false;
  const kind = () => document.body.dataset.kind || "schematic";
  const K = () => globalThis.AtriumKeymap;
  function titles() {
    for (const b of document.querySelectorAll("#tools .tool[data-action]")) {
      const a = b.dataset.action;
      if (a === "route" || a === "label") continue;   // the editor names these per document
      const base = b.dataset.baseTitle || (b.dataset.baseTitle = (b.getAttribute("aria-label") || b.dataset.tooltip || b.title || "").replace(/\s*\(.*\)$/, ""));
      const key = K()?.hintKey(a, kind()), more = b.dataset.toolGroup ? " · hold for more" : "";
      globalThis.AtriumNavCommon?.shortcutTitle(b, key ? base : base + more, key, more);
    }
  }
  function close(refocus = true, instant = false) {
    if (!fly) return;
    const f = fly, surface = globalThis.AtriumSurfaceMotion;
    fly = null;
    if (surface && f.isConnected) surface.popover(f, false, {instant, done:() => f.remove()});
    else f.remove();
    owner?.setAttribute("aria-expanded", "false");
    owner?.removeAttribute("aria-controls");
    if (refocus) owner?.focus();
    owner = null;
  }
  function open(button) {
    const switching = !!fly?.isConnected;
    close(false, true);
    if (!button.dataset.toolGroup) return null;
    const menu = fly = document.createElement("div");
    menu.id = "active-bar-flyout";
    owner = button; button.setAttribute("aria-expanded", "true"); button.setAttribute("aria-controls", menu.id);
    const show = ui => {
      if (fly !== menu) return;
      if (!button.isConnected || !button.getClientRects().length || globalThis.AtriumPower?.visible?.() === false) {close(false); return;}
      ui.show(menu, button, kind(), close, switching);
    };
    if (globalThis.AtriumActiveBarMenu) show(globalThis.AtriumActiveBarMenu);
    else globalThis.AtriumLazy.need("AtriumActiveBarMenu").then(show, e => {
      if (fly === menu) { close(false); globalThis.AtriumNavHost?.info(e.message); }
    });
    return menu;
  }
  function attach() {
    const bar = document.getElementById("tools");
    if (!bar) return;
    titles();
    globalThis.AtriumKeymap?.onChange?.(titles);
    new MutationObserver(titles).observe(document.body, {attributes:true, attributeFilter:["data-kind"]});
    bar.addEventListener("pointerdown", e => {
      const b = e.target.closest?.(".tool[data-action]");
      if (!b || e.button !== 0 || !b.dataset.toolGroup) return;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {suppress = true; open(b);}, 380);
    });
    for (const t of ["pointerup", "pointerleave", "pointercancel"]) bar.addEventListener(t, () => clearTimeout(pressTimer));
    bar.addEventListener("click", e => {if (suppress) {suppress = false; e.preventDefault(); e.stopPropagation();}}, true);
    bar.addEventListener("contextmenu", e => {const b = e.target.closest?.(".tool[data-action]"); if (b && b.dataset.toolGroup) {e.preventDefault(); open(b);}});
    bar.addEventListener("keydown", e => {
      const b = e.target.closest?.(".tool[data-action]");
      if (b && b.dataset.toolGroup && e.key === "ArrowDown") {e.preventDefault(); e.stopPropagation(); open(b);}
    });
    document.addEventListener("keydown", e => {
      if (fly && !fly.isConnected && ["Escape", "Tab", "ArrowLeft"].includes(e.key)) {e.preventDefault(); e.stopPropagation(); close();}
    }, true);
    const outside = e => {if (fly && !fly.contains(e.target) && !owner?.contains(e.target)) close(false);};
    for (const t of ["pointerdown", "focusin"]) document.addEventListener(t, outside, true);
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, {once:true}); else attach();
  }
  return {open, close, titles};
})();
