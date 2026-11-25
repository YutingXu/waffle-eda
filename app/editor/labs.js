"use strict";
// Preview features are a per-profile choice. The formal release enables them for everyone.
globalThis.AtriumLabs = (() => {
  const key = "labs.notebook";
  let preferences;
  const butterEnabled = feature => typeof feature === "string" &&
    (preferences ?? globalThis.AtriumPref)?.get("butter." + feature) === true;
  const designQueryIntent = source => butterEnabled("query") ?
    /^\s*([a-z]+)\s+(?:where\b|in\s+(?:class|net|component|componentclass|pair|pairclass|differentialpair|differentialpairclass|signal|tag|xsignal|xsignalclass|room|polygon|pad|sheet)\b|on\s+layer\b|near\b)/i.exec(source)?.[1].toLowerCase() : undefined;
  async function designQueryService(source) {
    const kind = designQueryIntent(source);
    if (!kind) return null;
    const service = globalThis.AtriumQueryService ?? await globalThis.AtriumLazy?.need("AtriumQueryService");
    return butterEnabled("query") && globalThis.AtriumDesignQueryParser?.kinds.has(kind) ? service : null;
  }
  const preview = globalThis.document?.documentElement?.dataset.release !== "apricot";
  const optedIn = value => value === true || value === "true" || value === 1;
  const notebookActions = new Set(["sch-calculation", "review-notes", "camera-zoom-selection",
    "camera-turn-left", "camera-turn-right", "camera-turn-reset"]);
  const notebookAction = id => {
    if (notebookActions.has(id)) return true;
    const command = globalThis.AtriumKeymap?.command?.(id);
    return command?.builtin === true && command.notebook === true;
  };
  let enabled = !preview || optedIn(globalThis.AtriumPref?.get(key));
  let controller;
  const before = new Set();
  const listeners = new Set();
  const updateRoot = () => globalThis.document?.documentElement?.toggleAttribute("data-notebook-labs", enabled);
  updateRoot();
  function notebookSignal() {
    if (!controller) {
      controller = new AbortController();
      if (!enabled) controller.abort();
    }
    return controller.signal;
  }
  function bind(prefs) {
    preferences = prefs;
    function sync() {
      const next = !preview || optedIn(prefs.get(key));
      if (next === enabled) return;
      enabled = next;
      updateRoot();
      const previous = controller;
      controller = undefined;
      previous?.abort();
      notify(listeners, enabled);
    }
    sync();
    return prefs.on(key, sync);
  }
  function permits(pref, value) {
    if (pref !== key) return true;
    const next = !preview || optedIn(value);
    if (next === enabled) return true;
    for (const listener of [...before]) {
      try { if (listener(next) === false) return false; }
      catch (error) { globalThis.console?.warn?.(error); return false; }
    }
    return true;
  }
  function notify(subscriptions, next) {
    for (const listener of [...subscriptions]) {
      try { listener(next); } catch (error) { globalThis.console?.warn?.(error); }
    }
  }
  function subscribe(subscriptions, listener) {
    subscriptions.add(listener);
    return () => subscriptions.delete(listener);
  }
  return Object.freeze({preview, notebookEnabled: () => enabled, notebookSignal, permits, butterEnabled, designQueryIntent, designQueryService,
    notebookAction, allowsAction: id => enabled || !notebookAction(id),
    beforeChange: listener => subscribe(before, listener), onChange: listener => subscribe(listeners, listener), bind});
})();
