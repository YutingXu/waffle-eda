"use strict";
// AtriumDocTabs: closing document tabs, as Altium's document tab menu (lazy; prefetched when the editor is
// idle, so each document's saved state is known from the start). Used by the tab context menu
// (context-menu.js explorer) and by Close Document (Ctrl/⌘+F4, ⌘W in the Mac and VS Code presets).
//
//   close   the clicked tab            others  every other tab in its strip
//   right   the tabs to its right      left    the tabs to its left
//   all     every tab in the strip     kind    Close All <type> Documents (Schematic, PCB, …)
//   saved   the tabs without unsaved changes
//
// A strip is the document strip, or one split pane's strip (split-tabs.js): Left, Right, Others and All count
// in the strip the tab was clicked in. Closing never removes a document from the project: in the document
// strip the tab is hidden (Reopen Closed Document, the Projects panel and Ctrl+Tab bring it back); in a pane
// strip it leaves that pane. When the document strip is left empty, the Start Page opens; the shown document's
// tab returns when it closes. Tabs cannot be pinned, so no tab is exempt from Others, Left, Right or All.
//
// Unsaved changes: the documents in a batch that have changes since the last save and leave every strip are
// listed once, in one dialog, as Altium's "Confirm Save for N Documents": each has a Save box (ticked); Save
// All / Save Selected saves the project file (one file holds every document, so other documents' changes are
// saved with it), Don't Save takes each unticked document back to its saved state (one undo step), and Cancel
// (or Escape) closes nothing. A document added since the last save has no saved state: Don't Save closes its
// tab and the changes stay in the project, unsaved.
//
//   AtriumDocTabs.pick(cmd, id, ids, kindOf, saved) -> ids to close (pure)
//   AtriumDocTabs.run(host, cmd, {id, pane}) -> Promise<boolean>: false when cancelled
//   AtriumDocTabs.modified(id) -> boolean;  kindName(kind) -> "Schematic", "PCB", …
globalThis.AtriumDocTabs = (() => {
  const KINDS = {schematic: "Schematic", pcb: "PCB", drawing: "Draftsman", panel: "Panel", library: "Library", schlib: "Schematic Library",
    pcblib: "PCB Library", rules: "Rules", compare: "Compare"};
  const kindName = k => KINDS[k] || (k ? k[0].toUpperCase() + k.slice(1) : "Other");
  const D = () => globalThis.document, V = () => globalThis.AtriumVSKeys, ST = () => globalThis.AtriumSplitTabs;
  globalThis.AtriumI18n?.define?.({"tabs.closed": "Closed {name}", "tabs.closed_n": "Closed {count} documents",
    "tabs.kept": "{name} has no saved copy to go back to: its changes stay in the project, unsaved.",
    "tabs.confirm_one": "Save changes to “{name}” before closing?", "tabs.confirm_n": "Save changes to {count} documents before closing?",
    "tabs.lost_one": "Your changes to “{name}” are lost if you close it without saving.",
    "tabs.lost_n": "These documents have unsaved changes. Untick a document to close it without saving.",
    "tabs.one_file": "Saving writes the project file, with the changes in every document.", "tabs.none_saved": "Every open document has unsaved changes."});
  const t = (k, a) => globalThis.AtriumI18n?.t?.(k, a) ?? k;

  function pick(cmd, id, ids, kindOf = () => "", saved = () => false) {
    const at = ids.indexOf(id);
    if (cmd === "close") return at < 0 ? [] : [id];
    if (cmd === "others") return ids.filter(x => x !== id);
    if (cmd === "right") return at < 0 ? [] : ids.slice(at + 1);
    if (cmd === "left") return at < 0 ? [] : ids.slice(0, at);
    if (cmd === "all") return ids.slice();
    if (cmd === "kind") { const k = kindOf(id); return ids.filter(x => kindOf(x) === k); }
    if (cmd === "saved") return ids.filter(x => saved(x));
    return [];
  }

  // ------------------------------------------------------------------ saved state
  // The JSON of each document at the last clean moment (a save, an open, a clean derive). null: unknown, so
  // every document counts as changed while the project is unsaved.
  let host = null, base = null, baseFor = null, pending = 0;
  function capture() {
    pending = 0;
    if (!host || host.folderProject?.() || host.isDirty?.()) { base = null; return; }
    const p = host.project();
    base = new Map(p.documents.map(d => [d.id, JSON.stringify(d)])); baseFor = p;
  }
  const later = () => { if (pending) return; const I = globalThis.AtriumIdle; pending = 1; if (I?.idle) I.idle(capture, {timeout: 500}); else setTimeout(capture, 0); };
  const known = id => base && baseFor === host?.project() && base.has(id);
  function modified(id) {
    const folder = host?.folderProject?.();
    if (folder) return folder.modified(id);
    if (!host?.isDirty?.()) return false;
    const d = host.docById(id);
    return !d || !known(id) || JSON.stringify(d) !== base.get(id);
  }

  // ------------------------------------------------------------------ strips
  const mainTabs = () => [...(D()?.querySelectorAll("#document-tabs [data-tab]") || [])].filter(n => !n.hidden).map(n => n.dataset.tab);
  const split = () => (host?.panes?.() || []).length > 1 && ST()?.groups;
  function strip(pane) {
    const g = split();
    if (g && pane != null) return g[pane] || [];
    return mainTabs();
  }
  // Where a keyboard close applies: the active pane while split, else the document strip.
  function activePane() { const g = split(); if (!g) return null; const k = (host.panes() || []).findIndex(p => p.active); return k < 0 ? 0 : k; }
  // Documents that stay open somewhere after these leave strip `pane`.
  function stillOpen(ids, pane) {
    const g = split(); if (!g || pane == null) return new Set();
    const other = new Set(g[1 - pane] || []), shown = host.panes()[1 - pane]?.docId; if (shown) other.add(shown);
    return new Set(ids.filter(id => other.has(id)));
  }

  // ------------------------------------------------------------------ the unsaved dialog
  // -> {save: [ids], discard: [ids]} or null (cancelled)
  async function confirm(ids) {
    const S = globalThis.AtriumShell, docs = ids.map(id => host.docById(id)).filter(Boolean);
    if (!docs.length) return {save: [], discard: []};
    const one = docs.length === 1, name = docs[0].name || "Untitled";
    if (!S?.dialog) return globalThis.confirm?.(t(one ? "tabs.confirm_one" : "tabs.confirm_n", {name, count: docs.length})) ? {save: ids, discard: []} : null;
    const el = (tag, text, cls) => { const n = D().createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    const body = [el("p", t(one ? "tabs.lost_one" : "tabs.lost_n", {name}))], boxes = [];
    if (!one) {
      const ul = el("ul", null, "doc-tabs-list");
      for (const d of docs) {
        const li = el("li"), label = el("label"), box = el("input"); box.type = "checkbox"; box.checked = true; box.dataset.doc = d.id;
        label.append(box, el("span", d.name || "Untitled"), el("small", " " + kindName(d.kind))); li.append(label); ul.append(li); boxes.push(box);
      }
      body.push(ul);
    }
    if (!host.folderProject?.()) body.push(el("p", t("tabs.one_file"), "side-note"));
    let choice = null;
    const actions = [{label: "Cancel", run: () => { choice = null; }}, {label: "Don’t Save", run: () => { choice = "discard"; }},
      {label: one ? "Save" : "Save All", primary: true, run: () => { choice = "save"; }}];
    const dlg = S.dialog({title: t(one ? "tabs.confirm_one" : "tabs.confirm_n", {name, count: docs.length}), body, className: "doc-tabs-dialog", actions});
    const primary = actions[2].button;
    for (const b of boxes) b.addEventListener("change", () => { const all = boxes.every(x => x.checked), none = !boxes.some(x => x.checked);
      if (primary) { primary.textContent = all ? "Save All" : none ? "Close Without Saving" : "Save Selected"; } });
    await dlg.done;
    if (!choice) return null;
    if (choice === "discard") return {save: [], discard: docs.map(d => d.id)};
    const keep = one ? new Set([docs[0].id]) : new Set(boxes.filter(b => b.checked).map(b => b.dataset.doc));
    return {save: docs.filter(d => keep.has(d.id)).map(d => d.id), discard: docs.filter(d => !keep.has(d.id)).map(d => d.id)};
  }
  // Don't Save: each document goes back to its saved JSON, in one undo step. -> ids without a saved copy
  async function revert(ids) {
    const folder = host.folderProject?.();
    if (folder) {
      const keep = [];
      for (const id of ids) if (!await globalThis.AtriumFolderProjectUI.revertOwner(folder,id,host)) keep.push(id);
      return keep;
    }
    const back = ids.filter(known), none = ids.filter(id => !known(id));
    if (back.length) host.edit(() => {
      for (const id of back) { const d = host.docById(id); if (!d) continue; const s = JSON.parse(base.get(id)); for (const k of Object.keys(d)) delete d[k]; Object.assign(d, s); }
    }, "Don’t Save");
    return none;
  }

  // ------------------------------------------------------------------ closing
  function hideMain(ids) {
    const K = V(), now = host.currentId();
    K?.hide?.(ids);
    if (!ids.includes(now)) return;
    const next = (K?.order?.() || mainTabs()).find(id => !ids.includes(id));
    if (next) { host.selectDocument(next); return; }
    // The strip is empty: the Start Page, as Altium's Home; the shown document's tab returns when it closes.
    const back = () => { if (!mainTabs().length) K?.show?.(host.currentId()); };
    const L = globalThis.AtriumLazy;
    if (!L?.need) { back(); return; }
    L.need("AtriumStartPage").then(S => { const d = S.open(); if (d?.addEventListener) d.addEventListener("close", back, {once: true}); else back(); }, back);
  }
  function closeIn(pane, ids) {
    const session = host.folderProject?.();
    if (session) session.setView({openTabs:(session.localState.openTabs || []).filter(id => !ids.includes(id))});
    if (pane == null) { hideMain(ids); return; }
    const T = ST(), shown = host.panes()[pane]?.docId;
    // The shown tab last, so the pane moves to a remaining tab once.
    for (const id of [...ids.filter(x => x !== shown), ...ids.filter(x => x === shown)]) T.closeTab(pane, id);
  }
  let busy = false;
  async function run(h, cmd, o = {}) {
    if (h) attach(h);
    if (busy) return false;
    const pane = o.pane != null && split() ? +o.pane : o.pane === undefined ? activePane() : null;
    const id = o.id || host.currentId(), list = strip(pane);
    const kindOf = x => host.docById(x)?.kind || "", ids = pick(cmd, id, list, kindOf, x => !modified(x));
    if (!ids.length) { if (cmd === "saved") host.info(t("tabs.none_saved")); return true; }
    busy = true;
    try {
      const open = stillOpen(ids, pane), ask = ids.filter(x => !open.has(x) && modified(x));
      if (ask.length) {
        const r = await confirm(ask);
        if (!r) return false;
        const kept = r.discard.length ? await revert(r.discard) : [];
        if (r.save.length && (await host.saveProject?.({only:r.save}) === false || r.save.some(modified))) return false;
        for (const x of kept) host.info(t("tabs.kept", {name: host.docById(x)?.name || ""}));
      }
      closeIn(pane, ids);
      const name = host.docById(ids[0])?.name || "";
      host.info(ids.length > 1 ? t("tabs.closed_n", {count: ids.length}) : t(pane == null ? "keys.closed_document" : "tabs.closed", {name}));
      return true;
    } finally { busy = false; }
  }

  function attach(h) {
    if (host === h) return;
    host = h;
    h.on?.("dirty", v => { if (!v) later(); else if (pending) pending = 0; });
    h.on?.("replace", () => { base = null; if (!h.isDirty?.()) later(); });
    capture();
  }
  if (globalThis.AtriumNavHost) attach(globalThis.AtriumNavHost); else globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({pick, run, modified, kindName, capture, attach});
})();
