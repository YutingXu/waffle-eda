"use strict";
// AtriumThemePicker: the colour theme quick pick (Ctrl/⌘+K Ctrl/⌘+T, View › Theme › Color Theme…)
// and the Preferences › Appearance gallery (docs/themes.md). Lazy; needs AtriumThemes.
//
// Quick pick, as in VS Code: arrow through the list and each theme previews live; Enter keeps it,
// Esc puts the previous appearance back; typing filters. The gallery shows every theme with a
// thumbnail rendered from the sample design (its board and sheet drawn with that theme's canvas
// colours by the real canvas renderer), the OS light/dark following with a preferred theme for
// each, the accent, layout and canvas overrides.
globalThis.AtriumThemePicker = (() => {
  const T = globalThis.AtriumTheme, C = T.color, doc = globalThis.document;
  const Lib = () => globalThis.AtriumThemes;
  // Translatable text (docs/translating.md): each English string is defined once under "themes.<slug>".
  // One translator per surface: its defined set and English inverse stay with that caller.
  function labelTranslator() {
    const defined = new Set();
    // i18n-inv: a "themes.*" key is looked up as is; in another locale the English catalogue is loaded, and
    // an English string uses the key it was extracted under.
    let inv = null;
    function t(s, a) {
      if (/^themes\.\w+$/.test(s)) return globalThis.AtriumI18n?.t?.(s, a) ?? s;
      const E = globalThis.AtriumI18n?.catalogue?.("en");
      if (E && !inv) { inv = new Map(); for (const k in E) if (k.startsWith("themes.") && !inv.has(E[k])) inv.set(E[k], k); }
      if (inv?.has(s)) return globalThis.AtriumI18n.t(inv.get(s), a);
      const I = globalThis.AtriumI18n;
      if (!I?.define) return a ? s.replace(/\{(\w+)\}/g, (m, n) => a[n] ?? m) : s;
      const k = "themes." + s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
      if (!defined.has(k)) { defined.add(k); I.define({[k]: s}); }
      return I.t(k, a);
    }
    return t;
  }
  const t = labelTranslator();
  // i18n-defs: messages with placeholders, and lower-case ones (docs/translating.md).
  globalThis.AtriumI18n?.define?.({"themes.light_themes": "light themes", "themes.dark_themes": "dark themes", "themes.high_contrast_themes": "high contrast themes",
    "themes.from_ext": "from {ext}", "themes.your_theme": "your theme", "themes.current": "current", "themes.color_theme_name": "Color theme: {name}",
    "themes.imported_appearance_settings_from_file": "Imported appearance settings from {file}.",
    "themes.imported_name_as_one_of_your_themes": "Imported {name} as one of your themes.",
    "themes.n_contrast_warnings": "{n} contrast warning(s): Customize… shows them.",
    "themes.import_failed_why": "Import failed: {why}", "themes.exported_file": "Exported {file}.", "themes.export_failed_why": "Export failed: {why}",
    "themes.what_use_the_theme_default": "{what}: use the theme default", "themes.removed_name": "Removed {name}.", "themes.remove_name": "Remove {name}",
    "themes.accent_on_panels_r": "Accent on panels {r}:1"});
  // Rendered text in these roots is matched against the catalogue, so a live language switch updates it.
  globalThis.AtriumI18n?.scope?.(".thq-dialog, .thg-page", ["themes", "prefs"]);
  function el(tag, cls, text) { return AtriumNavCommon.classedElement(doc, tag, cls, text); }
  function button(text, fn, cls, title) { const b = el("button", cls, text); b.type = "button"; b.onclick = fn; if (title) b.title = title; return b; }
  const host = () => globalThis.AtriumNavHost;
  const info = m => { try { host()?.info?.(m); } catch {} };
  const keyHint = id => { try { return globalThis.AtriumKeymap?.hintFor?.(id, doc.body?.dataset.kind || "pcb") || ""; } catch { return ""; } };

  // ------------------------------------------------------------------ swatches and thumbnails
  // Five colours that identify a theme: app, panel, ink, accent, selection.
  function strip(id) {
    const r = Lib().resolved(id), s = el("span", "thq-strip"); s.setAttribute("aria-hidden", "true");
    for (const k of ["app", "panel", "accent", "selection", "ink"]) { const i = el("i"); i.style.setProperty("--swatch", C.hex(r.tokens[k]) || "#808080"); s.append(i); }
    return s;
  }
  let sample = null;
  function sampleDesign() {
    if (sample) return sample;
    const P = globalThis.AtriumParts?.example?.();
    if (!P) return null;
    sample = {defs: new Map(P.library.map(d => [d.id, d])), pcb: P.documents.find(d => d.kind === "pcb"), sch: P.documents.find(d => d.kind === "schematic")};
    return sample;
  }
  const thumbs = new Map();
  // The board and the sheet, drawn by the canvas renderer with the theme's palettes. Nothing global
  // changes: the PCB colours are swapped for the one synchronous render, the sheet palette restored.
  function renderThumb(id, kind, w = 168, h = 104) {
    const S = sampleDesign(), V = globalThis.AtriumCanvas, PCB = globalThis.AtriumPCBAppearance, SCH = globalThis.AtriumSchAppearance;
    if (!S || !V || !PCB) return null;
    const r = Lib().resolved(id), c = el("canvas");
    c.style.cssText = "position:fixed;left:-10000px;top:0;width:" + w + "px;height:" + h + "px";
    doc.body.append(c);
    try {
      const view = V.create(c), d = S[kind];
      const draw = () => { view.fit(d, S.defs, kind === "pcb" ? "board" : "document");
        view.render(d, S.defs, {grid: false, origin: false, hidden: new Set(), selectedIds: new Set(), showUnrouted: false, layer: "Top", layerMode: "all"}); }; // i18n-ignore: layer name
      if (kind === "pcb") PCB.withPalette?.({...r.canvas.pcb.system, layers: r.canvas.pcb.layers}, draw);
      else { try { SCH?.setTheme?.(r.canvas.sch); draw(); } finally { SCH?.setTheme?.(T.canvasPalette("sch")); } }
      return c.toDataURL("image/png");
    } catch { return null; } finally { c.remove(); }
  }
  function thumb(id) {
    const fig = el("span", "thg-thumb"); fig.setAttribute("aria-hidden", "true");
    const r = Lib().resolved(id);
    fig.style.setProperty("--swatch", C.hex(r.tokens.app));
    const a = el("img", "thg-pcb"), b = el("img", "thg-sch");
    a.alt = b.alt = ""; a.style.setProperty("--swatch", C.hex(r.canvas.pcb.system.workspace)); b.style.setProperty("--swatch", C.hex(r.canvas.sch.workspace));
    const chips = el("span", "thg-layers");
    for (const k of ["Top", "Bottom", "Inner 1", "Inner 2", "Inner 3", "Inner 4"]) { // i18n-ignore: layer names
      const i = el("i"); i.style.setProperty("--swatch", r.canvas.pcb.layers[k] || globalThis.AtriumPCBAppearance?.defaultColor?.(k) || "#808080"); i.title = k; chips.append(i);
    }
    fig.append(a, b, chips);
    queueThumb(id, a, b);
    return fig;
  }
  let queue = [], busy = false;
  function queueThumb(id, a, b) {
    const have = thumbs.get(id);
    if (have) { if (have.pcb) a.src = have.pcb; if (have.sch) b.src = have.sch; return; }
    queue.push([id, a, b]);
    if (!busy) { busy = true; setTimeout(drain, 30); }
  }
  function drain() {
    const job = queue.shift();
    if (!job) { busy = false; return; }
    const [id, a, b] = job;
    let have = thumbs.get(id);
    if (!have) { have = {pcb: renderThumb(id, "pcb"), sch: renderThumb(id, "sch")}; thumbs.set(id, have); }
    if (have.pcb) a.src = have.pcb; if (have.sch) b.src = have.sch;
    (globalThis.requestIdleCallback || (f => setTimeout(f, 16)))(drain, {timeout: 200});
  }
  // Edited themes redraw.
  const forget = id => thumbs.delete(id);

  // ------------------------------------------------------------------ quick pick
  let qp = null;
  function groups(filter) {
    const q = String(filter || "").trim().toLowerCase(), all = Lib().list().filter(x => !q || (x.name + " " + x.type + " " + x.source + " " + (x.ext || "")).toLowerCase().includes(q));
    return [["themes.light_themes", all.filter(x => x.type === "light")], ["themes.dark_themes", all.filter(x => x.type === "dark")],
      ["themes.high_contrast_themes", all.filter(x => x.type.startsWith("hc-"))]].filter(g => g[1].length);
  }
  function openPicker() {
    if (!doc?.body) return null;
    if (qp?.d.open) { qp.input.focus(); return qp.d; }
    if (!qp) buildPicker();
    qp.snapshot = T.get(); qp.input.value = ""; qp.committed = false;
    renderPicker(T.effectivePreset());
    qp.d.showModal?.();
    qp.input.focus();
    return qp.d;
  }
  function buildPicker() {
    const d = el("dialog", "thq-dialog"); d.setAttribute("aria-label", t("Select color theme"));
    const input = el("input", "thq-input ui-field"); input.type = "text"; input.spellcheck = false;
    input.placeholder = t("Select Color Theme (Up/Down Keys to Preview)"); input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-controls", "thq-list"); input.setAttribute("aria-autocomplete", "list");
    const list = el("ul", "ui-list thq-list"); list.id = "thq-list"; list.dataset.layout = "flush"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", t("Color themes"));
    const foot = el("div", "thq-foot");
    foot.append(button(t("Customize Current Theme…"), () => { commit(); act("theme-editor"); }, "thq-link"),
      button(t("Import Theme…"), () => { commit(); importFile(); }, "thq-link"),
      button(t("Appearance Settings…"), () => {
        commit(); d.addEventListener("close", () => act("theme-preferences"), {once: true}); d.close();
      }, "thq-link"));
    d.append(input, list, foot);
    for (const b of foot.querySelectorAll("button")) { b.dataset.variant = "quiet"; b.dataset.size = "sm"; }
    AtriumShell.adoptDialog(d, {body:[input, list], actions:foot});
    input.addEventListener("input", () => renderPicker(qp.items[qp.active]?.id, true));
    d.addEventListener("keydown", e => {
      const n = qp.items.length; if (!n && e.key !== "Escape") return;
      const step = {ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8}[e.key];
      if (step) { e.preventDefault(); move(Math.max(0, Math.min(n - 1, qp.active + step))); }
      else if ((e.key === "Home" || e.key === "End") && e.ctrlKey) { e.preventDefault(); move(e.key === "Home" ? 0 : n - 1); }
      else if (e.key === "Enter") { e.preventDefault(); commit(); d.close(); }
    });
    d.addEventListener("cancel", e => { e.preventDefault(); revert(); d.close(); });
    d.addEventListener("close", () => { if (!qp.committed) revert(); restoreFocus(); });
    d.addEventListener("click", e => { if (e.target === d) { revert(); d.close(); } });
    list.addEventListener("click", e => {
      const li = e.target.closest?.("[data-theme-id]"); if (!li) return;
      move(qp.items.findIndex(x => x.id === li.dataset.themeId)); commit(); d.close();
    });
    doc.body.append(d);
    qp = {d, input, list, items: [], active: 0, snapshot: null, committed: false, previous: null};
  }
  let focusBack = null;
  const restoreFocus = () => { const f = focusBack; focusBack = null; (f?.isConnected ? f : doc.getElementById("canvas"))?.focus?.(); };
  function renderPicker(keep, typed) {
    const current = qp.snapshot ? (qp.snapshot.followSystem ? T.effectivePreset() : qp.snapshot.preset) : T.effectivePreset();
    const frag = doc.createDocumentFragment(); qp.items = [];
    for (const [title, rows] of groups(qp.input.value)) {
      const h = el("li", "thq-group", t(title)); h.setAttribute("role", "presentation"); frag.append(h);
      for (const x of rows) {
        const li = el("li", "ui-row thq-item"); li.id = "thq-" + qp.items.length; li.dataset.themeId = x.id; li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        const name = el("span", "thq-name", x.name);
        const detail = el("span", "thq-detail", x.source === "extension" ? t("themes.from_ext", {ext: x.ext}) : x.source === "user" ? t("themes.your_theme") : x.id === current ? "" : "");
        li.append(strip(x.id), name, detail);
        if (x.id === current) li.append(el("span", "thq-current", t("themes.current")));
        frag.append(li); qp.items.push(x);
      }
    }
    if (!qp.items.length) { const li = el("li", "thq-empty", t("No matching themes.")); li.setAttribute("role", "presentation"); frag.append(li); }
    qp.list.replaceChildren(frag);
    let i = qp.items.findIndex(x => x.id === keep);
    if (i < 0) i = typed ? 0 : Math.max(0, qp.items.findIndex(x => x.id === current));
    move(i, !typed || i !== qp.active);
  }
  function move(i, previewIt = true) {
    if (!qp.items.length) return;
    qp.active = i;
    qp.items.forEach((x, k) => qp.list.querySelector("#thq-" + k)?.setAttribute("aria-selected", String(k === i)));
    const li = qp.list.querySelector("#thq-" + i);
    qp.input.setAttribute("aria-activedescendant", li?.id || "");
    li?.scrollIntoView?.({block: "nearest"});
    if (previewIt) try { Lib().select(qp.items[i].id, {persist: false, reason: "preview"}); } catch (e) { globalThis.console?.warn?.(e); }
  }
  function commit() {
    const x = qp?.items[qp.active]; if (!x || !qp.d.open) return;
    qp.committed = true;
    try { Lib().select(x.id); info(t("themes.color_theme_name", {name: x.name})); } catch (e) { info(e.message); }
  }
  function revert() {
    if (!qp?.snapshot || qp.committed) return;
    const s = qp.snapshot; qp.snapshot = null;
    try { T.set(s, {reason: "revert"}); } catch {}
  }
  const act = a => { try { host()?.act?.(a); } catch {} };

  // ------------------------------------------------------------------ import / export
  function importFile() {
    const f = el("input"); f.type = "file"; f.accept = ".json,.jsonc,application/json"; f.hidden = true; doc.body.append(f);
    f.onchange = async () => {
      const file = f.files?.[0]; f.remove(); if (!file) return;
      try {
        const r = await Lib().importText(await file.text());
        status(r.settings ? t("themes.imported_appearance_settings_from_file", {file: file.name}) : t("themes.imported_name_as_one_of_your_themes", {name: r.doc.name}) + (r.report?.warnings?.length ? " " + t("themes.n_contrast_warnings", {n: r.report.warnings.length}) : ""));
        refresh();
      } catch (e) { status(t("themes.import_failed_why", {why: e.message}), true); }
    };
    f.click();
  }
  function exportFile(id = T.effectivePreset()) {
    try {
      const name = (Lib().get(id)?.doc.name || "theme").toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".waffle-theme.json";
      const text = Lib().exportJSON(id), H = host();
      if (H?.exportFile) H.exportFile(name, text);
      else { const a = el("a"), url = URL.createObjectURL(new Blob([text], {type: "application/json"})); a.href = url; a.download = name; doc.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      status(t("themes.exported_file", {file: name}));
    } catch (e) { status(t("themes.export_failed_why", {why: e.message}), true); }
  }

  // ------------------------------------------------------------------ gallery (Preferences › Appearance)
  const pages = new Set();
  let statusNode = null;
  function status(text, error) {
    for (const p of pages) { const s = p.querySelector(".thp-status"); if (s) { s.textContent = text || ""; s.classList.toggle("is-error", !!error); } }
    if (!pages.size && text) info(text);
  }
  function setSafe(partial, persist = true) { try { T.set(partial, {persist}); status(""); } catch (e) { status(e.message, true); } }
  function field(label, control, hint) {
    const row = el("div", "thp-field"); row.append(el("span", "thp-label", label), control); if (hint) row.append(el("small", "thp-hint", hint)); return row;
  }
  function radioGroup(name, label, options) {
    const group = el("div", "thp-segment ui-segmented"); group.setAttribute("role", "radiogroup"); group.setAttribute("aria-label", label);
    const inputs = [];
    for (const [value, text, title] of options) {
      const l = el("label", "ui-segment"), input = el("input"); input.type = "radio"; input.name = name; input.value = String(value);
      if (title) l.title = title; l.append(input, el("span", null, text)); group.append(l); inputs.push(input);
    }
    return {group, inputs};
  }
  let seq = 0;
  function appearanceGroup(pageId, key, title) {
    const section = el("section", "thp-group"), heading = el("h3", "thp-heading", title), card = el("div", "thp-card");
    heading.id = "thp-" + pageId + "-" + key;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading, card);
    return card;
  }
  function appearancePage(page) {
    page = page || el("div", "thp-page");
    page.classList.add("thp-page", "thg-page"); page.replaceChildren();
    const n = ++seq, c = {page}, preferences = page.classList.contains("prf-appearance");
    // Theme gallery.
    const themes = appearanceGroup(n, "theme", t("Color theme"));
    // The gallery is the picker, so the actions sit on the heading row and the themes need no card around them.
    const tools = el("div", "thg-tools");
    tools.append(button(t("Customize…"), () => act("theme-editor"), null, t("Edit any colour on top of the current theme")),
      button(t("Import theme…"), importFile, null, t("A Waffle theme (.json) or a VS Code colour theme")),
      button(t("Export theme…"), () => exportFile(), null, t("Save the current theme as a Waffle theme JSON file")));
    const grid = el("div", "thg-grid"); grid.setAttribute("role", "radiogroup"); grid.setAttribute("aria-label", t("Color theme"));
    themes.classList.add("thg-gallery"); themes.parentElement.classList.add("thg-group");
    themes.before(tools); themes.append(grid); c.grid = grid;
    // Follow the OS light/dark setting, with a preferred theme for each.
    const follow = el("label", "thp-check"), followBox = el("input", "ui-checkbox"); followBox.type = "checkbox";
    if (preferences) { followBox.setAttribute("role", "switch"); followBox.classList.add("ui-switch"); follow.classList.add("ui-switch-row"); }
    follow.append(followBox, el("span", null, t("Follow the operating system's light/dark setting")));
    followBox.addEventListener("change", () => setSafe({followSystem: followBox.checked}));
    const followRow = el("div", "thp-follow");
    const select = (label, family, key) => {
      const s = el("select", "ui-field"); s.setAttribute("aria-label", label);
      s.addEventListener("change", () => { try { const e = Lib().entryFor(s.value); if (e) T.register(s.value, e); } catch {} setSafe({[key]: s.value, followSystem: T.get().followSystem}); });
      const l = el("label", "thp-inline thp-field"); l.append(el("span", "thp-label", label), s); followRow.append(l); return [s, family];
    };
    c.selects = [select(t("Preferred light theme"), "light", "systemLight"), select(t("Preferred dark theme"), "dark", "systemDark")];
    const osSet = appearanceGroup(n, "system", t("Light and dark")); osSet.append(follow, followRow);
    c.follow = followBox; c.followRow = followRow;
    // Accent.
    const accentSet = appearanceGroup(n, "accent", t("Accent colour"));
    const swatches = el("div", "thp-swatches"); swatches.setAttribute("role", "radiogroup"); swatches.setAttribute("aria-label", t("Accent colour"));
    c.accents = [];
    const swatch = (value, label, color) => {
      const l = el("label", "thp-swatch"), input = el("input"), chip = el("span", "thp-chip");
      input.type = "radio"; input.name = "thp-accent-" + n; input.value = value; input.setAttribute("aria-label", label); l.title = label;
      if (color) chip.style.setProperty("--swatch", color); else chip.classList.add("thp-chip-default");
      l.append(input, chip); swatches.append(l); c.accents.push(input); return input;
    };
    swatch("", t("Theme default")).addEventListener("change", () => setSafe({accent: ""}));
    for (const a of T.ACCENTS) swatch(a.hex, t(a.label), a.hex).addEventListener("change", () => setSafe({accent: a.hex}));
    const custom = el("input"); custom.type = "color"; custom.className = "thp-custom"; custom.setAttribute("aria-label", t("Custom accent colour")); custom.title = t("Custom accent colour");
    custom.addEventListener("input", () => setSafe({accent: custom.value}, false));
    custom.addEventListener("change", () => setSafe({accent: custom.value}));
    swatches.append(custom); c.custom = custom;
    c.derived = el("div", "thp-derived"); c.derived.setAttribute("aria-live", "polite");
    accentSet.append(swatches, c.derived);
    // Layout.
    const layout = appearanceGroup(n, "layout", t("Layout"));
    const density = radioGroup("thp-density-" + n, t("UI density"), [["compact", t("Compact")], ["default", t("Default")], ["comfortable", t("Comfortable")]]);
    density.inputs.forEach(i => i.addEventListener("change", () => setSafe({density: i.value})));
    const font = radioGroup("thp-font-" + n, t("UI font size"), T.FONT_SIZES.map(v => [v, v + " px"]));
    font.inputs.forEach(i => i.addEventListener("change", () => setSafe({fontSize: +i.value})));
    const motion = radioGroup("thp-motion-" + n, t("Animations"), [["system", t("System"), t("Full, or Reduced when the operating system asks for less motion")], ["full", t("Full"), t("Menus, panels and the camera move; changes on the canvas pulse")], ["reduce", t("Reduced"), t("Fades only: nothing slides, grows or flies")], ["off", t("Off"), t("No animations or transitions")]]);
    motion.inputs.forEach(i => i.addEventListener("change", () => setSafe({motion: i.value})));
    layout.append(field(t("Density"), density.group), field(t("UI font size"), font.group), field(t("Animations"), motion.group));
    c.density = density.inputs; c.font = font.inputs; c.motion = motion.inputs;
    // Canvas overrides.
    const canvasSet = appearanceGroup(n, "canvas", t("Canvas"));
    const fc = el("label", "thp-check"), fcBox = el("input", "ui-checkbox"); fcBox.type = "checkbox";
    if (preferences) { fcBox.setAttribute("role", "switch"); fcBox.classList.add("ui-switch"); fc.classList.add("ui-switch-row"); }
    fc.append(fcBox, el("span", null, t("Canvas colours follow the colour theme")));
    fcBox.addEventListener("change", () => setSafe({canvas: {follow: fcBox.checked}}));
    c.canvasFollow = fcBox; c.colors = [];
    const colorControl = (label, key) => {
      const wrap = el("span", "thp-color"), input = el("input"), clear = button(t("Default"), () => setSafe({canvas: {[key]: ""}}), "thp-default");
      input.type = "color"; input.setAttribute("aria-label", label); clear.setAttribute("aria-label", t("themes.what_use_the_theme_default", {what: label}));
      input.addEventListener("input", () => setSafe({canvas: {[key]: input.value}}, false));
      input.addEventListener("change", () => setSafe({canvas: {[key]: input.value}}));
      wrap.append(input, clear); c.colors.push({input, clear, key}); return wrap;
    };
    canvasSet.append(fc, field(t("PCB background"), colorControl(t("PCB background"), "pcbBackground")),
      field(t("Schematic workspace"), colorControl(t("Schematic workspace"), "schBackground")),
      field(t("Schematic sheet"), colorControl(t("Schematic sheet"), "schSheet"), t("Layer colours come from the theme; View Configuration (L) overrides them per layer.")));
    const st = el("p", "thp-status"); st.setAttribute("role", "status");
    page.append(...[themes, osSet, accentSet, layout, canvasSet].map(card => card.parentElement), st);
    for (const f of page.querySelectorAll(".thp-group")) f.dataset.search = f.textContent.toLowerCase();
    page._thg = c; pages.add(page);
    fillGrid(c); sync();
    return page;
  }
  function fillGrid(c) {
    const frag = doc.createDocumentFragment(), sections = [["builtin", t("Built-in")], ["extension", t("From extensions")], ["user", t("Your themes")]];
    for (const [source, title] of sections) {
      const rows = Lib().list().filter(x => x.source === source);
      if (!rows.length) continue;
      frag.append(el("h4", "thg-head", title));
      for (const x of rows) {
        const card = el("label", "thg-card"), input = el("input"); input.type = "radio"; input.name = "thg-theme"; input.value = x.id;
        input.setAttribute("aria-label", x.name);
        input.addEventListener("change", () => { try { Lib().select(x.id); status(""); } catch (e) { status(e.message, true); } });
        const name = el("span", "thg-name", x.name);
        card.append(input, thumb(x.id), name);
        if (x.description) card.title = x.description;
        if (x.source === "user") {
          const del = button("", () => { if (Lib().removeUser(x.id)) { forget(x.id); refresh(); status(t("themes.removed_name", {name: x.name})); } }, "thg-remove", t("themes.remove_name", {name: x.name}));
          del.setAttribute("aria-label", t("themes.remove_name", {name: x.name})); card.append(del);
        }
        frag.append(card);
      }
    }
    c.grid.replaceChildren(frag);
  }
  function refresh() { for (const p of pages) if (p.isConnected) fillGrid(p._thg); else pages.delete(p); sync(); if (qp?.d.open) renderPicker(qp.items[qp.active]?.id); }
  function sync() {
    const s = T.get(), id = T.effectivePreset(), tokens = T.tokensFor();
    for (const p of [...pages]) {
      if (!p.isConnected) { pages.delete(p); continue; }
      const c = p._thg, check = (inputs, v) => inputs.forEach(i => { i.checked = i.value === String(v); });
      for (const i of c.grid.querySelectorAll("input[type=radio]")) { i.checked = i.value === id; i.closest(".thg-card")?.classList.toggle("is-current", i.checked); }
      c.follow.checked = s.followSystem; c.followRow.hidden = !s.followSystem;
      for (const [sel, fam] of c.selects) {
        if (sel.options.length !== Lib().list({family: fam}).length) sel.replaceChildren(...Lib().list({family: fam}).map(x => { const o = el("option", null, x.name); o.value = x.id; return o; }));
        sel.value = fam === "light" ? s.systemLight : s.systemDark;
      }
      const known = T.ACCENTS.some(a => a.hex === s.accent);
      check(c.accents, s.accent && !known ? "__custom" : s.accent);
      c.custom.classList.toggle("is-current", !!s.accent && !known);
      if (doc.activeElement !== c.custom) c.custom.value = C.hex(s.accent || tokens.accent) || T.PRESETS.dark.tokens.accent;
      c.derived.replaceChildren();
      const chip = (label, bg, ink) => { const x = el("span", "thp-sample", label); x.style.setProperty("--swatch", C.hex(bg)); x.style.color = C.hex(ink); x.title = label + " " + C.hex(bg) + " · " + C.contrast(ink, bg).toFixed(1) + ":1"; c.derived.append(x); };
      chip(t("Accent"), tokens.accent, tokens["on-accent"]); chip(t("Selection"), tokens.selection, tokens["selection-ink"]);
      c.derived.append(el("small", "thp-hint", t("themes.accent_on_panels_r", {r: C.contrast(tokens.accent, tokens.panel).toFixed(1)})));
      check(c.density, s.density); check(c.font, s.fontSize); check(c.motion, s.motion);
      c.canvasFollow.checked = s.canvas.follow;
      const pcb = {...(globalThis.AtriumPCBAppearance?.defaultSystem || {workspace: "#3b3b3b"}), ...T.canvasPalette("pcb")}, sch = T.canvasPalette("sch");
      const cur = {pcbBackground: pcb.workspace, schBackground: sch.workspace, schSheet: sch.paper};
      for (const x of c.colors) { if (doc.activeElement !== x.input) x.input.value = C.hex(cur[x.key]) || "#000000"; x.clear.disabled = !s.canvas[x.key]; }
    }
  }
  // ------------------------------------------------------------------ boot
  function attach(h) {
    h?.registerAction?.("theme-picker", () => { focusBack = doc.activeElement; openPicker(); });
  }
  if (doc) { if (globalThis.AtriumNavHost) attach(globalThis.AtriumNavHost); else globalThis.AtriumNavCommon?.ready?.(attach); }
  T.onChange(d => { if (d.reason !== "preview") sync(); });

  return Object.freeze({open: openPicker, openPicker, appearancePage, sync, refresh, forget, importFile, exportFile, renderThumb, labelTranslator,
    isOpen: () => !!qp?.d.open});
})();
