"use strict";
// AtriumI18nDOM: translates the shell where it is rendered, for any locale but English. Loaded
// by AtriumI18n.setLocale() together with locales/en.js and the locale's own file; never in English.
//
// Text is matched by its English source. scripts/i18n-extract.py writes every shell string into
// locales/en.json under a namespace ("menu.open_more": "Open…"); this module inverts that table
// per namespace, so a text node or a title/aria-label/placeholder whose text is an English
// source string becomes the locale's string. Which namespaces apply depends on where the node
// is (SCOPES below, plus AtriumI18n.scope() registrations): menus use "menu", Preferences
// "prefs", and every scope also tries "common" (OK, Cancel, Apply, Close…).
// A MutationObserver translates what modules add later (menu items, dialogs, status text), and
// switching locale (or back to English) maps the current text through the previous locale.
// Keyboard command titles (AtriumKeymap) are retitled from "cmd.<id>" keys.
//
//   AtriumI18nDOM.apply(from, to)    AtriumI18nDOM.refresh()
//   AtriumI18nDOM.audit()  -> [{text, scope}] shell text that is not in the English catalogue
//   AtriumI18nDOM.translate(text, namespaces) -> string
globalThis.AtriumI18nDOM = (() => {
  const g = globalThis, I = g.AtriumI18n, doc = g.document;
  // Most specific first: the first scope that contains a node gives its namespaces.
  const SCOPES = [
    {selector: ".work-menu", namespaces: ["menu"]},
    {selector: ".palette-insert-launch", namespaces: ["shell"]},
    {selector: ".nav-palette", namespaces: ["category"]},
    {selector: ".sp-dialog", namespaces: ["start"]},
    {selector: ".prf-dialog", namespaces: ["prefs"]},
    // Dialogs and panels of the preview wave (scripts/i18n-extract.py SOURCES: "preview polish").
    {selector: ".fps-dialog", namespaces: ["fab", "dfm"]},
    {selector: '.ui-tool-panel[data-tool="thermal"]', namespaces: ["thermal"]},
    {selector: ".si-dialog, [data-extension=\"waffle.si\"]", namespaces: ["si"]},
    {selector: ".gp-dialog, .gp-bind, .gp-finalise, .gp-addpart", namespaces: ["generic"]},
    {selector: ".cmdbar", namespaces: ["cmdbar"]},
    {selector: ".rset-dialog, .rgrp", namespaces: ["rules"]},
    {selector: ".rel-dialog", namespaces: ["related"]},
    {selector: ".msg-panel", namespaces: ["messages", "dfm", "status"]},
    {selector: "#inspector", namespaces: ["props", "status"]},
    {selector: ".statusbar", namespaces: ["status", "shell"]},
    {selector: ".appbar, .pane-heading, .active-bar, .layer-bar, .editor-tabbar, .tree-folder > summary, .ui-toast, #library-dialog", namespaces: ["shell", "status"]},
    {selector: "dialog", namespaces: []}
  ];
  const ATTRS = ["title", "data-tooltip", "data-tooltip-label", "data-tooltip-shortcut-suffix", "aria-label", "placeholder", "data-label", "label"];
  const SKIP = "script, style, canvas, textarea, code, pre, kbd, svg, [contenteditable], [translate=no], .no-i18n";
  const LETTER = /[A-Za-zÀ-ɏͰ-￿]/;
  let target = "en", cat = null, maps = null, observer = null;
  const back = new Map(), warned = new Set();

  function scopes() { return I.scopes().concat(SCOPES); }
  // namespace -> Map(English text -> key), from the extracted catalogue (plain strings only).
  function build() {
    if (maps) return maps;
    maps = new Map();
    for (const [k, v] of Object.entries(I.catalogue("en") || {})) {
      if (k[0] === "@" || typeof v !== "string" || v.includes("{")) continue;
      const ns = k.slice(0, k.indexOf("."));
      if (!maps.has(ns)) maps.set(ns, new Map());
      if (!maps.get(ns).has(v)) maps.get(ns).set(v, k);
    }
    return maps;
  }
  const ORDER = ["status", "shell", "menu", "common"];
  // Status-bar labels that eager modules build at run time: matched whole against these English
  // templates ({name} matches any text and is carried over), so English loads no table.
  const PATTERNS = ["status.units_mm_aria", "status.units_mil_aria", "status.units_mm_title", "status.units_mil_title", "status.drc_off",
    "status.drc_count", "status.drc_count_one", "status.drc_count_ms", "status.drc_count_ms_one", "status.split_close", "status.split_right",
    "status.split_close_key", "status.split_right_key"];
  g.AtriumI18n?.define?.({
    "status.units_mm_aria": "Units mm, switch to mil",
    "status.units_mil_aria": "Units mil, switch to mm",
    "status.units_mm_title": "Units: millimetres. Click or press Q for mil.",
    "status.units_mil_title": "Units: mils. Click or press Q for mm.",
    "status.drc_off": "Online DRC is off. Click to run the design rule check.",
    "status.drc_count": "{count} rule violations on this board. Click to run the full design rule check.",
    "status.drc_count_one": "{count} rule violation on this board. Click to run the full design rule check.",
    "status.drc_count_ms": "{count} rule violations on this board · last check {ms} ms ({mode}). Click to run the full design rule check.",
    "status.drc_count_ms_one": "{count} rule violation on this board · last check {ms} ms ({mode}). Click to run the full design rule check.",
    "status.split_close": "Close split",
    "status.split_right": "Split editor right",
    "status.split_close_key": "Close split ({key})",
    "status.split_right_key": "Split editor right ({key})"
  });
  let pats = null;
  function patterns() {
    if (pats) return pats;
    const en = I.catalogue("en") || {};
    return (pats = PATTERNS.filter(k => typeof en[k] === "string").map(k => {
      const names = [], re = en[k].replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (s, n) => (names.push(n), "(.+?)"));
      return {key: k, ns: k.slice(0, k.indexOf(".")), names, re: new RegExp("^" + re + "$")};
    }));
  }
  function byPattern(en, namespaces) {
    if (!cat) return null;
    for (const p of patterns()) {
      const m = (!namespaces || namespaces.includes(p.ns)) && p.key in cat && p.re.exec(en);
      if (m) return cat[p.key].replace(/\{(\w+)\}/g, (s, n) => (p.names.includes(n) ? m[p.names.indexOf(n) + 1] : s));
    }
    return null;
  }
  function keyOf(en, namespaces) {
    for (const ns of (namespaces || ORDER).concat("common")) { const k = maps.get(ns)?.get(en); if (k) return k; }
    return null;
  }
  // The text in the target locale for any string (English or a previous locale's), or the string.
  function translate(s, namespaces) {
    if (typeof s !== "string") return s;
    const core = s.trim();
    if (!core || !LETTER.test(core)) return s;
    const en = back.get(core) ?? core;
    let out = en;
    if (target !== "en") {
      const k = keyOf(en, namespaces);
      if (k) {
        if (cat && k in cat) out = cat[k];
        else if (I.dev && !warned.has(target + k)) { warned.add(target + k); g.console?.warn?.("[i18n] " + target + " has no " + k); }
      } else { const p = byPattern(en, namespaces); if (p != null) { out = p; if (!back.has(p)) back.set(p, en); } }
    }
    return out === core ? s : s.replace(core, () => out);
  }

  // ------------------------------------------------------------------ DOM
  const cacheNS = new WeakMap();
  function nsOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (cacheNS.has(el)) return cacheNS.get(el);
    let ns = null;
    if (!el.closest(SKIP)) for (const s of scopes()) if (el.closest(s.selector)) { ns = s.namespaces; break; }
    cacheNS.set(el, ns);
    return ns;
  }
  function attrs(el, ns) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) { const t = translate(v, ns); if (t !== v) el.setAttribute(a, t); }
    }
  }
  function textNode(n) {
    const ns = nsOf(n.parentElement);
    if (!ns) return;
    const v = n.nodeValue, t = translate(v, ns);
    if (t !== v) n.nodeValue = t;
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return textNode(root);
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    const each = el => { const ns = nsOf(el); if (ns) attrs(el, ns); };
    if (root.nodeType === 1) { if (root.closest(SKIP)) return; each(root); }
    const w = doc.createTreeWalker(root, 5, {acceptNode: n => n.nodeType === 1 && n.matches(SKIP) ? 2 : 1});
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeType === 3) textNode(n); else each(n);
  }
  function pass() {
    const sel = scopes().map(s => s.selector).join(", "), roots = [...doc.querySelectorAll(sel)];
    for (const r of roots) if (!roots.some(o => o !== r && o.contains(r))) walk(r);
  }
  function observe(on) {
    if (!on) { observer?.disconnect(); observer = null; return; }
    if (observer || typeof MutationObserver === "undefined" || !doc?.body) return;
    observer = new MutationObserver(recs => {
      for (const r of recs) {
        if (r.type === "childList") { for (const n of r.addedNodes) walk(n); }
        else if (r.type === "characterData") textNode(r.target);
        else { const ns = nsOf(r.target); if (ns) attrs(r.target, ns); }
      }
    });
    observer.observe(doc.body, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS});
  }

  // ------------------------------------------------------------------ commands
  function retitle() {
    const K = g.AtriumKeymap;
    if (!K?.commands) return;
    const pick = (key, en) => (target === "en" || en == null || !cat || !(key in cat) ? en : cat[key]);
    for (const c of K.commands()) {
      if (!c.builtin) continue;
      const en = c.__en || (c.__en = {title: c.title, short: c.short, titles: c.titles ? {...c.titles} : null});
      c.title = pick("cmd." + c.id, en.title);
      if (en.short != null) c.short = pick("cmd." + c.id + ".short", en.short);
      if (en.titles) c.titles = Object.fromEntries(Object.entries(en.titles).map(([k, v]) => [k, pick("cmd." + c.id + "." + k, v)]));
    }
    try { K.setPlatform(K.mac); } catch {} // drops the compiled table's cached sequence hints
  }

  // ------------------------------------------------------------------ switching
  function apply(from, to) {
    build();
    const old = from && from !== "en" ? I.catalogue(from) : null, en = I.catalogue("en") || {};
    target = to; cat = to === "en" ? null : I.catalogue(to);
    // Translated text maps back to English: the previous locale's (to switch again) and this one's (idempotent passes, audit).
    for (const c of [old, cat]) if (c) for (const k in c) if (typeof c[k] === "string" && typeof en[k] === "string" && c[k] !== en[k] && !back.has(c[k])) back.set(c[k], en[k]);
    if (doc?.body) pass();
    retitle();
    if (to === "en") { observe(false); I.setReverse(null); }
    else { observe(true); I.setReverse((s, ns) => translate(s, ns ? [].concat(ns) : null)); }
  }
  function refresh() { if (doc?.body) { pass(); } }
  // Shell text with no English catalogue entry (needs the extract script or a t() call).
  function audit() {
    build();
    const out = new Map();
    const note = (s, ns, where) => { const c = s?.trim(); if (c && LETTER.test(c) && !keyOf(back.get(c) ?? c, ns) && !out.has(c)) out.set(c, where); };
    const sel = scopes().map(s => s.selector).join(", ");
    for (const r of doc.querySelectorAll(sel)) {
      const w = doc.createTreeWalker(r, 5, {acceptNode: n => n.nodeType === 1 && n.matches(SKIP) ? 2 : 1});
      for (let n = w.currentNode; n; n = w.nextNode()) {
        const el = n.nodeType === 3 ? n.parentElement : n, ns = nsOf(el);
        if (!ns) continue;
        const where = (el.closest("[data-menu]")?.dataset.menu || el.className || el.tagName).toString().slice(0, 40);
        if (n.nodeType === 3) note(n.nodeValue, ns, where); else for (const a of ATTRS) note(n.getAttribute(a), ns, where + " @" + a);
      }
    }
    return [...out].map(([text, scope]) => ({text, scope}));
  }
  return {apply, refresh, translate: (s, ns) => (build(), translate(s, ns)), audit, scopes};
})();
