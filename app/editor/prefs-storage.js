"use strict";
// AtriumPrefsStorage: tools that keep their own localStorage key take part in Preferences › General ›
// Settings sync (Export / Import all settings) and in Reset all settings (consolidation audit §12).
//
//   "setting": a choice the user made in a tool (SI and stress options, print, 3D view, ECO
//              options, net colours, online DRC, ...). Exported, imported and reset.
//   "state":   what a tool remembers per viewer: recents, one-time hints, filters, last inputs,
//              panel sizes and collapsed sections. Reset, never exported.
// A key ending in ":" or "." is a prefix (atrium.eco.<option>, atrium-eco-unticked:<board>).
//
// Left out on purpose, so neither export nor reset touches them: project data and recovery
// (autosave, the editor's workspace), secrets (atrium.suppliers), the user's own content (fab
// profiles, user themes, clipboard pins, saved scripts, library list, per-document saved views and
// selection memories), extensions and their storage, and stores with their own export and reset
// (atrium.prefs, atrium.theme, atrium-keymap-v1). tests/prefs-storage.cjs keeps the list complete:
// a new localStorage key in app/ must be registered here or listed there as left out.
//
//   AtriumPrefsStorage.register(key, "setting" | "state")   another module or an extension
//   AtriumPrefsStorage.kind(key) -> "setting" | "state" | undefined
//   AtriumPrefsStorage.keys(kind?) -> stored keys a registration covers
//   AtriumPrefsStorage.collect() / restore(obj, skipped) / clear() / resetAll()
// prefs.js loads this file right after itself and calls collect/restore/render through extend().
globalThis.AtriumPrefsStorage = (() => {
  const G = globalThis;
  const ls = () => { try { return G.localStorage || null; } catch { return null; } };
  const KEYS = new Map();
  const add = (kind, keys) => { for (const k of keys) KEYS.set(k, kind); };
  add("setting", ["atrium.autorouter.engine", "atrium-bom-v1", "atrium-swap-v1", "atrium-constraints-v1", "atrium.diff.prefs.v1",
    "atrium.navigator.modes.v1", "atrium.query.modes.v1", "atrium.selectionFilter.v2", "atrium.snap.v1", "waffle.si.options", "atrium.stress.options",
    "atrium-sch-place", "atrium-3d-v1", "atrium-cross-select", "atrium-drc-markers", "atrium-online-drc", "atrium.eco.", "atrium-net-colours",
    "atrium.print.v1", "atrium.rules.units", "atrium-timing-vision", "atrium-annotate-v1", "atrium.script.timeout",
    "atrium.print.report.v1", "atrium.footprintWizard.roundOff", "waffle.notes.brush"]);
  add("state", ["atrium.busRoute.hint", "atrium.routing.spaceHint", "atrium.hint.ecoClusters", "atrium-split-follow-hint-v1", "atrium.diff.recent.v1",
    "atrium-palette-recent", "atrium.query.history.v1", "atrium.query.favourites.v1", "atrium.vscode-themes", "atrium.git.seen.v2", "atrium.genericParts.v1",
    "atrium.comments.v1", "atrium.routing.habits", "atrium.tutorial.v1", "atrium.welcome.v1", "atrium.script.draft", "atrium.script.height", "atrium.script.history",
    "atrium-calculators", "atrium.update", "atrium.selectionFilter.v1", "atrium-eco-unticked:", "atrium.bom.dismissed:",
    // Exported with the panel layout by prefs.js; Reset all clears them here.
    "atrium.collapsed-sections", "atrium.collapsed-panels", "atrium.pcbView.v1", "atrium.bar-faces",
    // Review notes: which note kinds each sheet shows or hides.
    "waffle.notes.sheet."]);

  // Reset also removes the old Last Opened history, which used local project paths as keys.
  add("state", ["atrium.git.seen.v1"]);

  function register(key, kind = "state") {
    if (typeof key !== "string" || !/^(?:atrium|waffle)/.test(key) || (kind !== "setting" && kind !== "state")) throw Error('register(key, "setting" | "state") needs a key that starts with "atrium" or "waffle".');
    KEYS.set(key, kind);
  }
  const isPrefix = k => k.endsWith(":") || k.endsWith(".");
  function kind(key) {
    if (KEYS.has(key)) return KEYS.get(key);
    for (const [p, v] of KEYS) if (isPrefix(p) && key.length > p.length && key.startsWith(p)) return v;
    return undefined;
  }
  function keys(want) {
    const s = ls(), out = new Set();
    if (!s) return [];
    for (const [k, v] of KEYS) if (!isPrefix(k) && (!want || v === want)) try { if (s.getItem(k) != null) out.add(k); } catch {}
    try { for (let i = 0, n = s.length || 0; i < n; i++) { const k = s.key(i), v = k && kind(k); if (v && (!want || v === want)) out.add(k); } } catch {}
    return [...out].sort();
  }
  // {key: stored text} for every stored setting; the text is kept exactly as the tool wrote it.
  function collect() {
    const s = ls(), out = {};
    for (const k of keys("setting")) try { out[k] = s.getItem(k); } catch {}
    return out;
  }
  // Writes the settings of an exported object back; anything else is listed in `skipped`.
  function restore(data, skipped = []) {
    const s = ls();
    let n = 0;
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== "string" || kind(k) !== "setting") { skipped.push(k); continue; }
      try { s.setItem(k, v); n++; } catch { skipped.push(k); }
    }
    return n ? ["tool settings (each tool picks them up when it next opens)"] : [];
  }
  function clear() {
    const s = ls(), gone = keys();
    for (const k of gone) try { s.removeItem(k); } catch {}
    return gone;
  }
  // Preferences, the appearance, the panel layout and every registered key go back to the defaults.
  // The key map has its own Reset all (Keyboard shortcuts), so custom bindings are kept.
  function resetAll() {
    try { G.AtriumPrefs?.reset?.(); } catch {}
    try { G.AtriumTheme?.reset?.(); } catch {}
    try { G.AtriumPCBAppearance?.reset?.(); } catch {}
    return clear();
  }
  // Preferences › General › Settings sync: the Reset all settings row.
  function render(group, api) {
    const r = api.el("div", "prf-row prf-link");
    r.dataset.search = "reset all settings defaults factory clear remembered";
    r.append(api.button("Reset all settings…", () => {
      if (typeof G.confirm === "function" && !G.confirm("Return every preference, the appearance, the panel layout and each tool's remembered settings to the defaults? Projects, libraries, fab profiles and the key map are kept.")) return;
      const n = resetAll().length;
      G.AtriumPrefs?.open?.("general");
      G.AtriumNavHost?.info?.("Restored the default settings" + (n ? " and cleared " + n + " remembered tool settings" : "") + ". Open tools pick this up the next time they start.");
    }, "prf-button"), api.el("small", "prf-help", "Projects, libraries, fab profiles and the key map are kept. Export first to keep a copy."));
    group.append(r);
  }
  const api = Object.freeze({register, kind, keys, collect, restore, clear, resetAll});
  try { G.AtriumPrefs?.extend?.("storage", {collect, restore, render}); } catch {}
  return api;
})();
