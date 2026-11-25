"use strict";

globalThis.AtriumSurfaceMotion = (() => {
  const doc = globalThis.document, motion = globalThis.AtriumMotionUI;
  const dialogSelector = "dialog.ui-dialog:not(#palette)";
  const pending = new WeakMap(), dialogExits = new WeakMap(), departures = new WeakMap(), shown = new WeakSet();

  function releaseDialog(dialog, exit) {
    if (dialogExits.get(dialog) !== exit) return;
    dialogExits.delete(dialog);
    if (!exit.marked) return;
    dialog.inert = exit.inert;
    if (exit.hidden === null) dialog.removeAttribute("aria-hidden");
    else dialog.setAttribute("aria-hidden", exit.hidden);
  }

  // The native dialog changes modal state and restores focus immediately. The
  // visual exit holds only the top-layer painting, then releases close handlers
  // that may remove the dialog. A reopened dialog keeps its interrupted effect.
  function beforeToggle(event) {
    const dialog = event.target;
    if (!dialog.matches?.(dialogSelector)) return;
    const curve = dialog.classList.contains("ui-sheet") ? "drawer" : "decelerate";
    if (event.newState === "open") {
      for (const exit of pending.get(dialog) || []) exit.reopened = true;
      const exit = dialogExits.get(dialog);
      if (exit) { exit.reopened = true; releaseDialog(dialog, exit); }
      queueMicrotask(() => {
        if (dialog.open) motion.enter(dialog, {from:{opacity:0,transform:"scale(.97)"},curve,duration:"dialog-in"});
      });
      return;
    }
    const exit = {intercepted:false, reopened:false, inert:dialog.inert, hidden:dialog.getAttribute("aria-hidden")};
    const effect = motion.exit(dialog, {to:{opacity:0},curve,duration:"dialog-out",done() {
      releaseDialog(dialog, exit);
      if (exit.intercepted && !exit.reopened && !dialog.open) dialog.dispatchEvent(new Event("close"));
    }});
    if (effect.running) {
      if (!pending.has(dialog)) pending.set(dialog, []);
      pending.get(dialog).push(exit);
      exit.effect = effect;
      dialogExits.set(dialog, exit);
      queueMicrotask(() => {
        // Let the platform restore the opener first. Only the exiting paint survives.
        if (dialog.open || dialogExits.get(dialog) !== exit) return;
        exit.marked = true;
        dialog.inert = true;
        dialog.setAttribute("aria-hidden", "true");
      });
    }
  }
  function close(event) {
    if (!event.isTrusted) return;
    const queue = pending.get(event.target);
    const exit = queue?.shift();
    if (!exit) return;
    if (!queue.length) pending.delete(event.target);
    if (!exit.effect.running && !exit.reopened) return;
    event.stopImmediatePropagation();
    exit.intercepted = true;
  }
  if (doc) {
    doc.documentElement.dataset.uiSurfaceMotion = "";
    doc.addEventListener("beforetoggle", beforeToggle, true);
    doc.addEventListener("close", close, true);
  }

  function show(element, {instant = false} = {}) {
    const exit = departures.get(element);
    if (!exit && shown.has(element)) return;
    if (departures.delete(element)) element.inert = exit.previouslyInert;
    shown.add(element);
    if (instant) motion.cancel(element);
    else motion.enter(element, {from:{opacity:0,transform:"scale(.97)"},curve:"decelerate",duration:"menu-in"});
  }
  function hide(element, done, {instant = false} = {}) {
    if (instant || !motion.enabled()) {
      const exit = departures.get(element);
      if (departures.delete(element)) element.inert = exit.previouslyInert;
      motion.cancel(element);
      shown.delete(element);
      done();
      return;
    }
    if (departures.has(element)) return;
    const previouslyInert = element.inert;
    const exit = {previouslyInert};
    departures.set(element, exit);
    element.inert = true;
    motion.exit(element, {to:{opacity:0},curve:"decelerate",duration:"menu-out",done() {
      if (departures.get(element) !== exit) return;
      done();
      element.inert = previouslyInert;
      departures.delete(element);
      shown.delete(element);
    }});
  }
  function menu(details, open, instant) {
    const list = details.querySelector(":scope > .menu-items");
    if (!list) return false;
    if (open) {
      if (!details.open || departures.has(list)) {
        if (!details.open) shown.delete(list);
        details.open = true;
        show(list, {instant});
      }
    } else if (details.open) hide(list, () => { details.open = false; }, {instant});
    return true;
  }
  function popover(element, open, options = {}) {
    if (open) {
      if (element.hidden && !departures.has(element)) shown.delete(element);
      element.hidden = false;
      show(element, options);
    } else if (options.done) hide(element, options.done, options);
    else if (!element.hidden) {
      hide(element, () => {}, options);
      element.hidden = true;
    }
  }
  return Object.freeze({menu, popover});
})();
