"use strict";
// AtriumThemeEditor: View › Theme › Customize Theme… (docs/themes.md). Every UI token, PCB system
// and layer colour, schematic colour and syntax colour can be changed on top of a base theme, with
// a live preview, a contrast check per text pair, Export theme… (a self-contained atrium-theme
// JSON file) and Import theme… (Waffle or VS Code theme JSON). Saved edits are one of "your themes".
// Lazy; needs AtriumThemes. Colours go through the library's validation; nothing else is read.
globalThis.AtriumThemeEditor = (() => {
  const T = globalThis.AtriumTheme, C = T.color, doc = globalThis.document, Lib = () => globalThis.AtriumThemes;
  // Translatable text (docs/translating.md): each English string is defined once under "themes.<slug>".
  const t = globalThis.AtriumThemePicker.labelTranslator();
  // i18n-defs: messages with placeholders, and lower-case ones (docs/translating.md).
  globalThis.AtriumI18n?.define?.({"themes.name_customised": "{name} (customised)", "themes.hex": "hex", "themes.reset_what": "Reset {what}",
    "themes.not_a_hex_colour": "{v} is not a hex colour like #3794ff.",
    "themes.pair_needs_min": "{token} on {on}: {r}:1 (needs {min}:1)", "themes.failing_pair": "{token} on {on} {r}:1 ({min}:1)",
    "themes.n_pairs_below_minimum": "{n} pair(s) below the minimum:", "themes.closest_pair": "Closest pair {a} / {b}: ΔE {d}",
    "themes.closest_pair_deuteranopia": "With deuteranopia: ΔE {d} {pair}", "themes.saved_name": "Saved {name}.",
    "themes.theme_saved_name": "Theme saved: {name}", "themes.exported_file": "Exported {file}.",
    "themes.imported_name_save_to_keep": "Imported {name}; save to keep your changes on top of it.",
    "themes.import_failed_why": "Import failed: {why}"});
  // Rendered text in these roots is matched against the catalogue, so a live language switch updates it.
  globalThis.AtriumI18n?.scope?.(".the-dialog", ["themes"]);
  function el(tag, cls, text) { return AtriumNavCommon.classedElement(doc, tag, cls, text); }
  function button(text, fn, cls, title) { const b = el("button", cls, text); b.type = "button"; b.onclick = fn; if (title) b.title = title; return b; }
  const host = () => globalThis.AtriumNavHost;

  // Token groups, in the order a designer works through them. Anything not listed is under "Other".
  const GROUPS = [
    ["Surfaces", ["app", "chrome", "panel", "panel-head", "raised", "hover", "pressed", "field", "menu-bg", "tab-bg", "tab-hover", "soft", "canvas-bg", "bar-bg", "ls-bg", "layer-on", "button", "button-hover"]],
    ["Text", ["ink", "muted", "faint", "ink-bright", "ink-strong", "head-ink", "chrome-ink", "tool-ink", "tab-ink", "tab-hover-ink", "coords-ink", "soft-ink", "icon-ink", "dim-ink", "caption-ink", "split-ink"]],
    ["Accent and selection", ["accent", "on-accent", "on-accent-2", "accent-btn-ink", "selection", "selection-ink", "sel-sub-ink", "focus", "primary", "on-primary", "primary-line"]],
    ["Status", ["danger", "warning", "info", "error-ink", "warn-ink", "ok-ink", "bad-ink", "danger-fill", "on-danger", "err-mark", "warn-mark", "ok-mark", "km-warn", "ls-ink", "diff-changed", "diff-added", "diff-removed"]],
    ["Lines", ["line", "line-strong", "divider", "rule", "bar-line", "button-line", "input-line", "ok-line", "warn-line", "bad-line", "conflict-line", "badge-line"]],
    ["Icons", ["icon-folder", "icon-sch", "icon-pcb"]]
  ];
  const SYSTEM_NAMES = () => globalThis.AtriumPCBAppearance?.systemNames || {};
  let ui = null, state = null;

  // The document being edited: {name, type, extends, colors, canvas, syntax}.
  function startFrom(id) {
    const e = Lib().get(id), d = e?.doc || Lib().get("dark").doc;
    if (e?.source === "user") return {id, doc: JSON.parse(JSON.stringify(d))};
    return {id: null, doc: {"atrium-theme": 1, name: t("themes.name_customised", {name: d.name}), type: d.type, extends: e ? id : "dark", colors: {}, canvas: {pcb: {system: {}, layers: {}}, sch: {}}, syntax: {}}};
  }
  const tidy = d => {
    const out = JSON.parse(JSON.stringify(d));
    const cv = out.canvas || {};
    if (cv.pcb) { if (!Object.keys(cv.pcb.system || {}).length) delete cv.pcb.system; if (!Object.keys(cv.pcb.layers || {}).length) delete cv.pcb.layers; if (!Object.keys(cv.pcb).length) delete cv.pcb; }
    if (cv.sch && !Object.keys(cv.sch).length) delete cv.sch;
    if (!Object.keys(cv).length) delete out.canvas;
    for (const k of ["colors", "syntax", "palette"]) if (out[k] && !Object.keys(out[k]).length) delete out[k];
    return out;
  };

  function open(id = T.effectivePreset()) {
    if (!doc?.body) return null;
    if (!ui) build();
    if (!ui.d.open) state = {snapshot: T.get(), ...startFrom(id === Lib().PREVIEW_ID ? "dark" : id), dirty: false};
    render(); preview();
    ui.d.showModal?.(); ui.name.focus();
    return ui.d;
  }
  function build() {
    const d = el("dialog", "work-dialog the-dialog"); d.setAttribute("aria-labelledby", "the-title");
    const head = el("header", "thp-head"), h = el("h2", null, t("Customize Theme")); h.id = "the-title"; head.append(h);
    const meta = el("div", "the-meta");
    const name = el("input", "ui-field"); name.type = "text"; name.maxLength = 80; name.setAttribute("aria-label", t("Theme name"));
    const base = el("select", "ui-field"); base.setAttribute("aria-label", t("Base theme"));
    const search = el("input", "ui-field"); search.type = "search"; search.placeholder = t("Filter colours"); search.setAttribute("aria-label", t("Filter colours"));
    const lab = (text, c) => { const l = el("label", "thp-inline"); l.append(el("span", null, text), c); return l; };
    const searchWrap = AtriumUI.searchField(search);
    meta.append(lab(t("Name"), name), lab(t("Based on"), base), searchWrap);
    const body = el("div", "the-body"), list = el("div", "the-list"), side = el("aside", "the-side");
    side.setAttribute("aria-label", t("Contrast"));
    body.append(list, side);
    const st = el("p", "thp-status"); st.setAttribute("role", "status");
    const actions = el("div", "work-actions the-actions"), saveButton = button(t("Save"), save);
    saveButton.dataset.variant = "primary"; saveButton.dataset.uiDefault = "false";
    const tools = el("div", "the-tools");
    tools.append(button(t("Import theme…"), importTheme, "ui-button", t("Waffle or VS Code theme JSON")),
      button(t("Export theme…"), exportTheme, "ui-button", t("A self-contained Waffle theme JSON file")),
      button(t("Reset all"), () => { const keep = state.doc; state.doc = {...startFrom(keep.extends || "dark").doc, name: keep.name}; state.dirty = true; render(); preview(); }, "ui-button", t("Drop every customised colour")));
    actions.append(tools, el("span", "thp-spacer"), button(t("Cancel"), cancel), saveButton);
    d.append(head, meta, body, st, actions);
    AtriumShell.adoptDialog(d, {title:h, body:[meta, body, st], actions});
    name.addEventListener("input", () => { state.doc.name = name.value || t("Untitled theme"); state.dirty = true; });
    base.addEventListener("change", () => { const keep = state.doc; state.doc = {...keep, extends: base.value, type: Lib().get(base.value).doc.type}; state.dirty = true; render(); preview(); });
    search.addEventListener("input", () => filter(search.value));
    d.addEventListener("cancel", e => { e.preventDefault(); cancel(); });
    doc.body.append(d);
    ui = {d, name, base, search, searchWrap, list, side, status: st};
  }
  const status = (text, error) => { ui.status.textContent = text || ""; ui.status.classList.toggle("is-error", !!error); };
  // One row: a colour well, its hex, a reset and (for text tokens) the worst contrast it has.
  function row(label, key, get, set, def, sub) {
    const r = el("div", "the-row"); r.dataset.search = (label + " " + key + " " + (sub || "")).toLowerCase(); r.dataset.key = key;
    const well = el("input"); well.type = "color"; well.setAttribute("aria-label", label);
    const text = el("input", "the-hex ui-field"); text.type = "text"; text.maxLength = 9; text.spellcheck = false; text.setAttribute("aria-label", label + " " + t("themes.hex"));
    const reset = button("", () => { set(null); changed(); }, "the-reset", t("Use the base theme's colour")); reset.setAttribute("aria-label", t("themes.reset_what", {what: label}));
    const badge = el("span", "the-badge");
    const name = el("span", "the-name"); name.append(el("span", null, label)); if (sub) name.append(el("small", null, sub));
    r.append(name, well, text, badge, reset);
    const show = () => { const own = get(), v = own || def(); well.value = C.hex(v) || "#000000"; if (doc.activeElement !== text) text.value = v || ""; reset.disabled = !own; r.classList.toggle("is-own", !!own); };
    const changed = () => { state.dirty = true; show(); preview(); };
    well.addEventListener("input", () => { set(well.value); changed(); });
    text.addEventListener("change", () => { const v = text.value.trim(); if (!v) { set(null); changed(); return; } if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) { status(t("themes.not_a_hex_colour", {v}), true); show(); return; } set(v.toLowerCase()); changed(); });
    r._show = show; r._badge = badge;
    return r;
  }
  function section(title, rows) { const s = el("section", "the-group"); s.append(el("h3", null, t(title)), ...rows); return s; }
  function render() {
    const d = state.doc, L = Lib();
    ui.name.value = d.name;
    ui.base.replaceChildren(...L.list().filter(x => x.id !== state.id).map(x => { const o = el("option", null, x.name); o.value = x.id; return o; }));
    ui.base.value = d.extends || "dark"; ui.base.disabled = !d.extends;
    const baseR = () => L.resolved(d.extends || "dark") || L.resolved("dark");
    d.colors ||= {}; d.canvas ||= {}; d.canvas.pcb ||= {}; d.canvas.pcb.system ||= {}; d.canvas.pcb.layers ||= {}; d.canvas.sch ||= {}; d.syntax ||= {};
    const tok = k => row("--" + k, k, () => d.colors[k], v => { if (v) d.colors[k] = v; else delete d.colors[k]; }, () => baseR().tokens[k]);
    const listed = new Set(GROUPS.flatMap(g => g[1]));
    const sections = GROUPS.map(([g, keys]) => section(g, keys.map(tok)));
    const rest = T.TOKENS.filter(k => !listed.has(k));
    if (rest.length) sections.push(section("Other", rest.map(tok)));
    const sysNames = SYSTEM_NAMES();
    sections.push(section("PCB canvas", L.SYSTEM.map(k => row(sysNames[k] || k, "pcb." + k, () => d.canvas.pcb.system[k], v => { if (v) d.canvas.pcb.system[k] = v; else delete d.canvas.pcb.system[k]; }, () => baseR().canvas.pcb.system[k], k))));
    const layers = ["Top", "Bottom", ...Array.from({length: 12}, (_, i) => "Inner " + (i + 1)), "Silk", "Bottom silk", "Multi", "Top mask", "Bottom mask", "Top paste", "Bottom paste", "Keepout", "Mechanical"]; // i18n-ignore: layer names
    const P = globalThis.AtriumPCBAppearance;
    sections.push(section("PCB layers", layers.map(k => row(P?.name?.(k) || k, "layer." + k, () => d.canvas.pcb.layers[k], v => { if (v) d.canvas.pcb.layers[k] = v; else delete d.canvas.pcb.layers[k]; },
      () => baseR().canvas.pcb.layers[k] || P?.defaultColor?.(k) || "#808080", k))));
    sections.push(section("Schematic canvas", ["workspace", "paper", "grid"].map(k => row(t({workspace: "Workspace", paper: "Sheet", grid: "Sheet grid"}[k]), "sch." + k, () => d.canvas.sch[k], v => { if (v) d.canvas.sch[k] = v; else delete d.canvas.sch[k]; }, () => baseR().canvas.sch[k]))));
    sections.push(section("Scripting console syntax", L.SYNTAX.map(k => row(k, "syntax." + k, () => d.syntax[k], v => { if (v) d.syntax[k] = v; else delete d.syntax[k]; }, () => baseR().syntax[k]))));
    ui.list.replaceChildren(...sections);
    for (const r of ui.list.querySelectorAll(".the-row")) r._show();
    filter(ui.search.value);
  }
  function filter(q) {
    q = String(q || "").trim().toLowerCase();
    for (const r of ui.list.querySelectorAll(".the-row")) r.hidden = !!q && !r.dataset.search.includes(q);
    for (const s of ui.list.querySelectorAll(".the-group")) s.hidden = ![...s.querySelectorAll(".the-row")].some(r => !r.hidden);
    ui.searchWrap.setCount?.(q ? ui.list.querySelectorAll(".the-row:not([hidden])").length : null);
  }
  let timer = 0;
  function preview() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const r = Lib().preview(tidy(state.doc));
        contrastReport(r); status("");
        try { globalThis.AtriumNavHost?.redraw?.(); } catch {}
      } catch (e) { status(e.message, true); }
    }, 40);
  }
  // Text pairs below their minimum, worst first; each row shows its own worst pair.
  function contrastReport(r) {
    const worst = new Map();
    for (const c of r.report.contrast) { const w = worst.get(c.token); if (!w || c.ratio / c.min < w.ratio / w.min) worst.set(c.token, c); }
    for (const row of ui.list.querySelectorAll(".the-row")) {
      const c = worst.get(row.dataset.key); row._badge.textContent = c ? c.ratio.toFixed(1) + ":1" : "";
      row._badge.classList.toggle("is-bad", !!c && c.ratio < c.min); row._badge.title = c ? t("themes.pair_needs_min", {token: "--" + c.token, on: "--" + c.on, r: c.ratio, min: c.min}) : "";
    }
    const bad = r.report.contrast.filter(c => c.ratio < c.min).sort((a, b) => a.ratio / a.min - b.ratio / b.min);
    const L = r.report.layers;
    ui.side.replaceChildren(el("h3", null, t("Contrast")));
    if (!bad.length) ui.side.append(el("p", "the-ok", t("Every text pair meets WCAG AA (4.5:1; 3:1 for focus rings and markers).")));
    else {
      ui.side.append(el("p", "the-warn", t("themes.n_pairs_below_minimum", {n: bad.length})));
      const ul = el("ul", "the-pairs");
      for (const c of bad) {
        const li = el("li"), a = el("i"), b = el("i"); a.style.setProperty("--swatch", C.hex(r.tokens[c.token])); b.style.setProperty("--swatch", C.hex(r.tokens[c.on]));
        li.append(a, b, el("span", null, t("themes.failing_pair", {token: "--" + c.token, on: "--" + c.on, r: c.ratio.toFixed(2), min: c.min})));
        li.tabIndex = 0; li.onclick = () => { const row = ui.list.querySelector('[data-key="' + c.token + '"]'); row?.scrollIntoView({block: "center"}); row?.querySelector("input")?.focus(); };
        ul.append(li);
      }
      ui.side.append(ul);
    }
    ui.side.append(el("h3", null, t("Copper layers")),
      el("p", L.minDeltaE < 25 ? "the-warn" : "the-ok", t("themes.closest_pair", {a: L.closest.a, b: L.closest.b, d: L.minDeltaE})),
      el("p", "thp-hint", t("themes.closest_pair_deuteranopia", {d: L.minDeltaEDeuteranopia, pair: "(" + L.closestDeuteranopia.a + " / " + L.closestDeuteranopia.b + ")"})));
  }
  function save() {
    try {
      const L = Lib(), id = L.saveUser(tidy(state.doc), state.id || undefined);
      state.id = id; state.dirty = false; L.select(id);
      globalThis.AtriumThemePicker?.forget?.(id); globalThis.AtriumThemePicker?.refresh?.();
      status(t("themes.saved_name", {name: state.doc.name})); ui.d.close();
      try { host()?.info?.(t("themes.theme_saved_name", {name: state.doc.name})); } catch {}
    } catch (e) { status(e.message, true); }
  }
  function cancel() { try { T.set(state.snapshot, {reason: "revert"}); } catch {} ui.d.close(); }
  function exportTheme() {
    try {
      const text = JSON.stringify(Lib().flatten(tidy(state.doc)), null, 2) + "\n", name = (state.doc.name || "theme").toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".waffle-theme.json";
      const H = host(); if (H?.exportFile) H.exportFile(name, text); else globalThis.AtriumThemePicker?.exportFile?.();
      status(t("themes.exported_file", {file: name}));
    } catch (e) { status(e.message, true); }
  }
  function importTheme() {
    const f = el("input"); f.type = "file"; f.accept = ".json,.jsonc,application/json"; f.hidden = true; doc.body.append(f);
    f.onchange = async () => {
      const file = f.files?.[0]; f.remove(); if (!file) return;
      try {
        const r = await Lib().importText(await file.text(), {select: false});
        if (r.settings) { status(t("That was an appearance settings file; it was applied.")); return; }
        state = {...state, ...startFrom(r.id)}; render(); preview();
        status(t("themes.imported_name_save_to_keep", {name: r.doc.name}));
      } catch (e) { status(t("themes.import_failed_why", {why: e.message}), true); }
    };
    f.click();
  }
  function attach(h) { h?.registerAction?.("theme-editor", () => open()); }
  if (doc) { if (globalThis.AtriumNavHost) attach(globalThis.AtriumNavHost); else globalThis.AtriumNavCommon?.ready?.(attach); }
  return Object.freeze({open, GROUPS, isOpen: () => !!ui?.d.open});
})();
