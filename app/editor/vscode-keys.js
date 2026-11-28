"use strict";
// AtriumVSKeys: the workbench side of the VS Code keys (docs/shortcuts.md "VS Code keys"). Lazy;
// prefetched once the editor is idle so the document history is recorded from the start.
//
//   quick-open        Ctrl/⌘+P (VS Code preset), the palette's search-everything mode
//   doc-next/prev     Ctrl+Tab / Ctrl+Shift+Tab: hold Ctrl, tap Tab through recent documents, release to switch
//   close-document    Ctrl/⌘+F4 (and Ctrl/⌘+W in the VS Code preset): hides the tab; the document stays in the project
//   reopen-document   Ctrl/⌘+Shift+T in the VS Code preset
//   focus-projects    Ctrl/⌘+Shift+E
//   rename-object     F2: the selection's Designator, label text or Net field in Properties
//   cheatsheet        Ctrl/⌘+? : a cheat sheet overlay built from the live key map and preset
globalThis.AtriumVSKeys = (() => {
  const doc = globalThis.document, KM = () => globalThis.AtriumKeymap;
  // Translatable text (docs/translating.md): each English string is defined once under "keys.<slug>".
  const defined = new Set();
  // i18n-inv: a "keys.*" key is looked up as is; in another locale the English catalogue is loaded, and
  // an English string uses the key it was extracted under.
  let inv = null;
  function t(s, a) {
    if (/^keys\.\w+$/.test(s)) return globalThis.AtriumI18n?.t?.(s, a) ?? s;
    const E = globalThis.AtriumI18n?.catalogue?.("en");
    if (E && !inv) { inv = new Map(); for (const k in E) if (k.startsWith("keys.") && !inv.has(E[k])) inv.set(E[k], k); }
    if (inv?.has(s)) return globalThis.AtriumI18n.t(inv.get(s), a);
    const I = globalThis.AtriumI18n;
    if (!I?.define) return a ? s.replace(/\{(\w+)\}/g, (m, n) => a[n] ?? m) : s;
    const k = "keys." + s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
    if (!defined.has(k)) { defined.add(k); I.define({[k]: s}); }
    return I.t(k, a);
  }
  // i18n-defs: messages with placeholders, and lower-case ones (docs/translating.md).
  globalThis.AtriumI18n?.define?.({"keys.after_keys": "After {keys}",
    "keys.closed_document": "Closed {name}. It stays in the project; reopen it from Projects or with Reopen Closed Document.",
    "keys.cheatsheet_foot": "{escape} or {key} closes · the list follows your key map and preset",
    "keys.cheatsheet_close": "{escape} closes · the list follows your key map and preset", "keys.more": "more…"});
  // Rendered text in these roots is matched against the catalogue, so a live language switch updates it.
  globalThis.AtriumI18n?.scope?.(".vsk-switch, .kcs-dialog", ["keys"]);
  function el(tag, cls, text) { return AtriumNavCommon.classedElement(doc, tag, cls, text); }
  let host = null;
  const info = m => { try { host?.info?.(m); } catch {} };
  const docs = () => host?.project?.()?.documents || [];
  const tabOf = id => doc.querySelector('#document-tabs [data-tab="' + CSS.escape(id) + '"]');

  // ------------------------------------------------------------------ document history
  let mru = [], closed = [];
  function noteDocument() {
    const id = host?.currentId?.(); if (!id) return;
    const ids = new Set(docs().map(d => d.id));
    mru = [id, ...mru.filter(x => x !== id && ids.has(x))];
    closed = closed.filter(x => ids.has(x) && x !== id);
    const tab = tabOf(id); if (tab?.hidden) tab.hidden = false;
  }
  // A native folder may contain hydrated owners with no open tab.
  function openTabs() {
    const byId = new Map(docs().map(d => [d.id,d]));
    return [...doc.querySelectorAll("#document-tabs [data-tab]")].flatMap(tab =>
      !tab.hidden && byId.has(tab.dataset.tab) ? [byId.get(tab.dataset.tab)] : []);
  }
  // Open documents, most recent first, then the rest in tab order.
  function order() {
    const open = openTabs().map(d => d.id);
    return [...mru.filter(id => open.includes(id)), ...open.filter(id => !mru.includes(id))];
  }

  // ⌘1…⌘8 go to that document tab and ⌘9 to the last one, as in Safari and Chrome (Modern (Mac) preset).
  function docTab(n) {
    const open = openTabs(), d = n >= 9 ? open.at(-1) : open[n - 1];
    if (!d) { info(t("There is no document tab {n}.", {n})); return; }
    if (d.id !== host.currentId()) host.selectDocument(d.id);
  }
  // ------------------------------------------------------------------ Ctrl+Tab switcher
  let sw = null;
  function switcher(step) {
    const list = order();
    if (list.length < 2) { info(t("Only one document is open.")); return; }
    if (!sw) {
      const box = el("div", "ui-popover vsk-switch"), ul = el("ul", "ui-list");
      ul.setAttribute("role", "listbox"); ul.setAttribute("aria-label", t("Open documents"));
      box.append(el("div", "vsk-switch-head", t("Open documents · release Ctrl to switch, Esc to cancel")), ul); doc.body.append(box);
      sw = {box, ul, list, at: 0};
      const up = e => { if (e.key === "Control" || e.key === "Meta" || e.key === "Alt") finish(true); };
      const key = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } else if (e.key === "Enter") { e.preventDefault(); finish(true); } };
      const blur = () => finish(false);
      sw.off = () => { removeEventListener("keyup", up, true); removeEventListener("keydown", key, true); removeEventListener("blur", blur); };
      addEventListener("keyup", up, true); addEventListener("keydown", key, true); addEventListener("blur", blur);
      box.addEventListener("pointerdown", e => { const li = e.target.closest?.("[data-doc]"); if (li) { e.preventDefault(); sw.at = sw.list.indexOf(li.dataset.doc); finish(true); } });
      for (const id of list) {
        const d = docs().find(x => x.id === id), li = el("li", "ui-row"); li.dataset.doc = id; li.setAttribute("role", "option");
        const svg = AtriumNavCommon.icon(d.kind === "pcb" ? "board" : "schematic");
        li.append(svg, el("span", null, d.name), el("small", "ui-row-meta", d.kind === "pcb" ? t("Board") : t("Schematic"))); ul.append(li);
      }
      // A quick tap and release switches without the list flashing up.
      sw.timer = setTimeout(() => sw?.box.classList.add("is-shown"), 120);
    }
    sw.at = (sw.at + step + sw.list.length) % sw.list.length;
    [...sw.ul.children].forEach((li, i) => { li.setAttribute("aria-selected", String(i === sw.at)); if (i === sw.at) li.scrollIntoView?.({block: "nearest"}); });
    // Without a held modifier (menu, palette) switch at once.
    if (!heldMods) finish(true);
  }
  function finish(go) {
    if (!sw) return;
    const s = sw; sw = null; s.off(); clearTimeout(s.timer); s.box.remove();
    if (go && s.list[s.at] && s.list[s.at] !== host.currentId()) host.selectDocument(s.list[s.at]);
  }
  let heldMods = false;
  const track = e => { heldMods = e.ctrlKey || e.metaKey || e.altKey; };

  // ------------------------------------------------------------------ close and reopen
  // Close Document goes through the tab closer (doc-tabs.js): unsaved changes ask first, a split closes the
  // active pane's tab, and the last tab opens the Start Page.
  function closeDocument() {
    return globalThis.AtriumLazy.need("AtriumDocTabs").then(T => T.run(host, "close", {id: host.currentId()}), e => info(e.message));
  }
  // The document strip's tabs hide (closed, most recent first) and show again; the documents stay in the project.
  function hide(ids) {
    const apply = () => { for (const id of ids) { const tab = tabOf(id); if (tab) tab.hidden = true; } };
    const motion = globalThis.AtriumSpatialMotion;
    if (motion) motion.tabLayout(doc.getElementById("document-tabs"),apply); else apply();
    closed = [...ids.slice().reverse(), ...closed.filter(x => !ids.includes(x))].slice(0, 20);
  }
  function show(id) {
    const tab = tabOf(id), motion = globalThis.AtriumSpatialMotion;
    if (tab?.hidden) {
      const apply = () => { tab.hidden = false; };
      if (motion) motion.tabLayout(tab.parentElement,apply); else apply();
    }
    closed = closed.filter(x => x !== id);
  }
  function reopenDocument() {
    const ids = new Set(docs().map(d => d.id));
    const id = closed.find(x => ids.has(x));
    if (!id) { info(t("No closed document to reopen.")); return; }
    show(id);
    host.selectDocument(id);
  }

  // ------------------------------------------------------------------ focus and rename
  function focusProjects() {
    if (doc.body.classList.contains("hide-left")) host.act("toggle-left");
    const panel = doc.querySelector(".panel-projects");
    const target = panel?.querySelector('[aria-selected="true"],[aria-current],button,[tabindex="0"],a') || panel;
    if (target) { if (!target.hasAttribute("tabindex") && !/^(BUTTON|A|INPUT)$/.test(target.tagName)) target.tabIndex = -1; target.focus(); }
  }
  function rename() {
    const ids = host.selection?.() || [];
    if (ids.length !== 1) { info(t("Select one part, label or track to rename (F2).")); return; }
    if (doc.body.classList.contains("hide-right")) host.act("toggle-right");
    setTimeout(() => {
      const ins = doc.getElementById("inspector");
      const f = ins?.querySelector('input[aria-label="Designator"],input[aria-label="Text"],input[aria-label="Net"]');
      if (!f) { info(t("This object has no designator or net to rename.")); return; }
      f.scrollIntoView?.({block: "nearest"}); f.focus(); f.select?.();
      info(t("Type the new name and press Enter."));
    }, 0);
  }

  // ------------------------------------------------------------------ cheat sheet overlay
  // Grouped by context from the live key map: Single keys (tool letters such as W, R, V, with or without Shift),
  // Global, Schematic, PCB, Routing, Chords (sequences).
  const SKIP = /^(pan-hold|keep-routing|escape(?!-)|place-at-pointer|select-at-pointer|tool-properties|context-menu|cursor-|nudge-|length-(amplitude|gap|miter|rounding|properties)|camera-pan-|selmem-|camera-(store|recall)-)/;
  const GROUPS = ["Single keys", "Global", "Schematic", "PCB", "Routing", "Chords"];
  function sheet(raw = false, kind) {
    const K = KM(), tb = K.table(), groups = new Map(GROUPS.map(g => [g, new Map()]));
    for (const rec of tb.all) {
      if (!kind && SKIP.test(rec.id)) continue;
      const k = K.kinds(rec);
      if (kind ? !k[kind] : !k.pcb && !k.schematic) continue;
      const g = rec.key.includes(" ") ? "Chords" : /routing|tuning/.test(rec.when + " " + rec.command.when) || rec.command.category === "Routing" ? "Routing"
        : /^(Shift\+)?[A-Z]$/.test(rec.key) ? "Single keys"
        : k.pcb && k.schematic ? "Global" : k.pcb ? "PCB" : "Schematic";
      const rows = groups.get(g), title = rec.label && g === "Chords" ? rec.command.title : rec.command.titles?.[kind || (k.pcb && !k.schematic ? "pcb" : "schematic")] || rec.command.title;
      const row = rows.get(rec.id) || {id: rec.id, title, keys: []};
      const text = raw ? rec.key : K.display(rec.key);
      if (!row.keys.includes(text)) row.keys.push(text);
      rows.set(rec.id, row);
    }
    return GROUPS.map(g => ({group: g, rows: [...groups.get(g).values()]})).filter(x => x.rows.length);
  }
  // A pending sequence prefix (P, T W …): its continuations, from the keys typed in the last 2 s.
  let typed = [];
  function noteKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) { if (!e.ctrlKey && !e.metaKey) typed = []; return; }
    const now = Date.now(); typed = typed.filter(x => now - x.at < 2000).concat({key: e.key.toUpperCase(), at: now}).slice(-4);
  }
  function pending(raw = false, kind = doc.body.dataset.kind || "pcb") {
    const K = KM(), s = {kind, tool: "select", canvas: true, documentId: "d"};
    const keys = typed.filter(x => Date.now() - x.at < 2000).map(x => x.key);
    for (let i = 0; i < keys.length; i++) {
      const seq = keys.slice(i).join(" ");
      try { if (K.resolve(seq, s) === "prefix") return {prefix: seq, rows: continuations(seq, s, raw)}; } catch {}
    }
    return null;
  }
  function continuations(prefix, s, raw) {
    const K = KM(), out = [];
    for (const L of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
      let r; try { r = K.resolve(prefix + " " + L, s); } catch { continue; }
      if (!r) continue;
      const c = r === "prefix" ? null : K.command(r);
      const key = prefix + " " + L;
      out.push({id: r, title: r === "prefix" ? t("keys.more") : c?.titles?.[s.kind] || c?.title || r, keys: [raw ? key : K.display(key)]});
    }
    return out;
  }
  let cs = null;
  function motionOff() {
    return doc.documentElement.getAttribute("data-motion") === "off";
  }
  function cheatsheet(o = {}) {
    if (cs?.d.open) { closeSheet(); return; }
    const K = KM(), d = el("dialog", "kcs-dialog"); d.setAttribute("aria-labelledby", "kcs-title");
    if (motionOff()) d.classList.add("no-motion");
    const head = el("header", "kcs-head"), h = el("h2", null, t("Keyboard shortcuts")); h.id = "kcs-title";
    const preset = K.presets().find(p => p.id === K.preset())?.title || K.preset();
    const filter = el("input", "kcs-filter ui-field"); filter.type = "search"; filter.placeholder = t("Filter by command or key"); filter.setAttribute("aria-label", t("Filter shortcuts"));
    const scope = AtriumUIKit.select([["schematic", t("Schematic")], ["pcb", t("PCB layout")]], {
      label: t("Shortcut scope"), value: host?.doc?.()?.kind === "pcb" ? "pcb" : "schematic", onChange: render
    });
    const edit = AtriumUIKit.button(t("Customise…"), {variant: "quiet", size: "sm", run: () => {
      closeSheet(true);
      const {exportFile, pickFile} = globalThis.AtriumIO || {};
      K.open({kind: scope.value, exportFile, pickFile});
    }});
    head.append(h, el("span", "kcs-preset", preset), scope, AtriumUI.searchField(filter), edit,
      AtriumUIKit.closeButton(() => closeSheet(), t("Close keyboard shortcuts")));
    const body = el("div", "kcs-body"), foot = el("p", "kcs-foot");
    function filterRows() {
      const q = filter.value.trim().toLowerCase();
      for (const r of body.querySelectorAll(".kcs-row")) r.hidden = !!q && !r.dataset.q.includes(q);
      for (const g of body.querySelectorAll(".kcs-group")) g.hidden = ![...g.querySelectorAll(".kcs-row")].some(r => !r.hidden);
    }
    function render() {
      body.replaceChildren();
      const kind = scope.value, pend = pending(true, kind), groups = sheet(true, kind);
      if (pend?.rows.length) groups.unshift({group: t("keys.after_keys"), rows: pend.rows, pending: true});
      groups.forEach((g, i) => {
        const col = el("section", "kcs-group" + (g.pending ? " is-pending" : "")); col.style.setProperty("--i", String(i));
        const heading = el("h3");
        heading.append(...(g.pending ? AtriumNavCommon.shortcutParts(g.group, {keys:pend.prefix}) : [t(g.group)]));
        col.append(heading);
        const dl = el("dl");
        for (const r of g.rows) {
          const dt = el("dt", null, r.title), dd = el("dd");
          for (const key of r.keys) { const kb = el("span", "kcs-keys"); kb.append(AtriumShortcut.render(key)); dd.append(kb); }
          const wrap = el("div", "kcs-row"); wrap.dataset.q = [r.title, r.id, ...r.keys.flatMap(k => [k, K.display(k), K.display(k, true)])].join(" ").toLowerCase(); wrap.append(dt, dd); dl.append(wrap);
        }
        col.append(dl); body.append(col);
      });
      const key = K.hintKey("cheatsheet", kind);
      foot.replaceChildren(...AtriumNavCommon.shortcutParts(t(key ? "keys.cheatsheet_foot" : "keys.cheatsheet_close"), {escape:"Escape", key}));
      filterRows();
    }
    render();
    d.append(head, body, foot);
    AtriumShell.adoptDialog(d, {title:h, body});
    filter.addEventListener("input", () => {
      d.classList.add("is-filtered"); // columns shown again by the filter do not replay their entrance
      filterRows();
    });
    d.addEventListener("cancel", e => { e.preventDefault(); closeSheet(); });
    d.addEventListener("click", e => { if (e.target === d) closeSheet(); });
    d.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && (e.key === "?" || e.key === "/")) { e.preventDefault(); closeSheet(); } });
    doc.body.append(d); d.showModal();
    cs = {d, peek: !!o.peek, previous: o.previous || null};
    if (!o.peek) filter.focus(); else d.focus();
    return d;
  }
  // The exit is quicker than the entrance (about 90 ms), then the dialog goes.
  function closeSheet(now) {
    if (!cs) return;
    const {d, previous} = cs; cs = null;
    const done = () => { if (d.open) d.close(); d.remove(); (previous?.isConnected ? previous : doc.getElementById("canvas"))?.focus?.(); };
    if (now || d.classList.contains("no-motion") || motionOff()) { done(); return; }
    d.classList.add("is-closing"); let fin = false; const end = () => { if (!fin) { fin = true; done(); } };
    d.addEventListener("animationend", e => { if (e.target === d) end(); }); setTimeout(end, 250); // fallback if no animation runs
  }
  // Optional peek: hold Ctrl/⌘ (with Shift) for about 600 ms and no other key (Preferences › Keyboard).
  let peekTimer = 0;
  const PEEK = "keyboard.peekCheatsheet";
  function peekDown(e) {
    clearTimeout(peekTimer);
    if (!(e.key === "Control" || e.key === "Meta") || e.repeat || cs || doc.querySelector("dialog[open]:not(.doc-view dialog)")) return;
    if (!globalThis.AtriumPref?.get?.(PEEK, false)) return;
    peekTimer = setTimeout(() => cheatsheet({peek: true, previous: doc.activeElement}), 600);
  }
  function peekUp(e) {
    clearTimeout(peekTimer);
    if (cs?.peek && (e.key === "Control" || e.key === "Meta")) closeSheet();
  }

  // ------------------------------------------------------------------ boot
  function quickOpen() {
    globalThis.AtriumNavCommon?.openPalette("files");
  }
  function attach(h) {
    host = h;
    const on = (id, f) => h.registerAction(id, f);
    on("quick-open", quickOpen); on("doc-next", () => switcher(1)); on("doc-prev", () => switcher(-1));
    on("close-document", closeDocument); on("reopen-document", reopenDocument); on("focus-projects", focusProjects);
    on("rename-object", rename);
    for (const id of ["shortcuts", "cheatsheet"]) on(id, () => cheatsheet({previous: doc.activeElement}));
    for (let n = 1; n <= 9; n++) on("doc-tab-" + n, () => docTab(n));
    h.on?.("document", noteDocument); noteDocument();
    addEventListener("keydown", e => { track(e); noteKey(e); peekDown(e); }, true);
    addEventListener("keyup", e => { track(e); peekUp(e); }, true);
    const C = globalThis.AtriumNavCommon;
    C?.menuItem?.("edit", "rename-object", "Rename Designator or Net", {after: "goto-location"});
  }
  if (doc) { if (globalThis.AtriumNavHost) attach(globalThis.AtriumNavHost); else globalThis.AtriumNavCommon?.ready?.(attach); }
  return Object.freeze({sheet, switcher, closeDocument, reopenDocument, hide, show, cheatsheet, close: closeSheet, order: () => order(), pending: () => pending(), isOpen: () => !!cs});
})();
