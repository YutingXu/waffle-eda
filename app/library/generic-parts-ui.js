"use strict";
// Generic parts in the editor (lazy, AtriumGenericPartsUI): Place › Generic Part, the palette's
// "Place resistor" and friends, the Generic Part and Connector / Header dialogs with live previews,
// the Generic section of the Properties panel (value with engineering notation and E-series hints,
// ratings, package, symbol style), Bind to Manufacturer Part, and the dynamic connector's Finalise
// and Add Part commands. The model work is in generic-parts.js and connector-gen.js.
globalThis.AtriumGenericPartsUI = (() => {
  const GP = () => globalThis.AtriumGenericParts, CG = () => globalThis.AtriumConnectorGen, L = () => globalThis.AtriumLibrary;
  const H = () => globalThis.AtriumNavHost;
  const KEY = "atrium.genericParts.v1";
  const FAMILY_ACTIONS = ["resistor", "capacitor", "polarised", "electrolytic", "inductor", "ferrite", "diode", "led", "crystal", "fuse", "testpoint", "jumper"];

  // ------------------------------------------------------------------ remembered choices (per viewer)
  function memory() { try { const v = JSON.parse(globalThis.localStorage?.getItem(KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } }
  function remember(change) { try { globalThis.localStorage?.setItem(KEY, JSON.stringify({...memory(), ...change})); } catch { /* private window */ } }
  function lastSpec(family) {
    const m = memory().families?.[family] || {}, f = GP().FAMILIES[family];
    return {family, package: f.packages.includes(m.package) ? m.package : f.pkg, style: m.style, subtype: m.subtype, value: m.value ?? f.value, parameters: m.parameters || null};
  }
  function rememberSpec(spec) {
    const all = memory().families || {};
    all[spec.family] = {package: spec.package, style: spec.style, subtype: spec.subtype, value: spec.value, parameters: spec.parameters || null};
    remember({families: all, lastFamily: spec.family});
  }
  const seriesPref = () => memory().series || "auto";

  // ------------------------------------------------------------------ DOM helpers
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const button = (text, fn, cls) => { const b = el("button", text, cls); b.type = "button"; if (fn) b.onclick = fn; return b; };
  function select(options, value, label) {
    const s = el("select"); s.setAttribute("aria-label", label);
    for (const o of options) { const [v, t] = Array.isArray(o) ? o : [o, o]; s.add(new Option(t, v)); }
    if (value != null) s.value = value;
    return s;
  }
  // Tile radio groups: one tab stop (the checked tile), arrow keys pick the next one, and focus stays on
  // the chosen tile when choosing rebuilds the tiles (WAI-ARIA radio group).
  function radios(group) {
    const all = root => [...root.querySelectorAll('[role="radio"]')], again = t => { const d = group.closest("dialog") || document, x = all(d).find(r => r.textContent === t || globalThis.AtriumI18nDOM?.translate(r.textContent, ["generic"]) === t); x?.focus(); };
    for (const r of all(group)) r.tabIndex = r.getAttribute("aria-checked") === "true" ? 0 : -1;
    group.onclick = e => { const r = e.target.closest?.('[role="radio"]'); if (r && e.detail === 0) again(r.textContent); };
    group.onkeydown = e => {
      const k = {ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1}[e.key], list = all(group), i = list.indexOf(e.target);
      if (!k || i < 0) return;
      e.preventDefault(); const n = list[(i + k + list.length) % list.length], t = n.textContent; n.click(); again(t);
    };
  }
  function field(parent, label, control, cls = "gp-field") { const l = el("label", null, cls); l.append(el("span", label), control); if (!control.getAttribute("aria-label")) control.setAttribute("aria-label", label); parent.append(l); return control; }
  function ensureCss() {
    if (typeof document === "undefined" || document.querySelector('link[href="library/generic-parts.css"]')) return;
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "library/generic-parts.css"; document.head.append(l);
  }
  // Cross-fade a preview after a change (motion.js; nothing moves with Animations off or reduced motion).
  function fade(node) {
    const M = globalThis.AtriumMotion;
    if (!M?.animate || !node || M.level?.() === "off") return;
    M.animate({duration: "fast", ease: "decelerate", step: t => { node.style.opacity = String(.55 + .45 * t); }, done: () => { node.style.opacity = ""; }});
  }

  // ------------------------------------------------------------------ the value field (shared)
  // An input that reads engineering notation and shows what it understood plus E-series neighbours.
  function valueInput(parent, family, get, o = {}) {
    const wrap = el("div", null, "gp-value"), input = el("input"), note = el("p", null, "gp-hint"), snaps = el("div", null, "gp-snaps");
    input.type = "text"; input.autocomplete = "off"; input.spellcheck = false; input.value = get(); input.setAttribute("aria-label", "Value");
    note.setAttribute("role", "status"); note.setAttribute("aria-live", "polite");
    const F = GP().FAMILIES[family];
    if (F?.colours) {
      const s = field(parent, "Colour", select(F.colours.includes(get()) ? F.colours : [get(), ...F.colours], get(), "Colour"));
      s.onchange = () => o.apply?.(s.value);
      return {input: s, refresh() { s.value = get(); }};
    }
    const seriesSel = select([["auto", "E-series: by tolerance"], ["E6", "E6 (20 %)"], ["E12", "E12 (10 %)"], ["E24", "E24 (5 %)"], ["E48", "E48 (2 %)"], ["E96", "E96 (1 %)"], ["none", "No E-series hint"]], seriesPref(), "E-series");
    function show() {
      const h = GP().hint(input.value, family, {tolerance: o.tolerance?.(), series: seriesSel.value === "auto" ? null : seriesSel.value});
      note.textContent = h.message; note.classList.toggle("is-error", !h.ok); note.classList.toggle("is-warning", !!h.offSeries);
      snaps.replaceChildren(...(h.snap || []).map(s => button("Use " + s.text, () => { input.value = s.text; show(); o.apply?.(s.text); }, "gp-snap")));
      return h;
    }
    input.addEventListener("input", show);
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); input.dispatchEvent(new Event("change")); } });
    input.addEventListener("change", () => { const h = show(); if (h.ok) { input.value = GP().UNIT[family] ? (family === "ferrite" ? h.text + " @ 100 MHz" : h.text) : input.value.trim(); o.apply?.(input.value); } });
    seriesSel.onchange = () => { remember({series: seriesSel.value}); show(); };
    const row = el("div", null, "gp-value-row"); row.append(input);
    wrap.append(row, note, snaps);
    if (GP().UNIT[family] && !["crystal", "fuse", "ferrite"].includes(family)) wrap.append(seriesSel);
    const label = el("div", null, "gp-field gp-field-value"); label.append(el("span", "Value"), wrap); parent.append(label);
    show();
    return {input, refresh() { input.value = get(); show(); }, show};
  }

  // ------------------------------------------------------------------ previews
  function stages(box, def) {
    const ui = L().ui, sym = el("canvas", null, "gp-canvas"), foot = el("canvas", null, "gp-canvas");
    sym.setAttribute("aria-label", "Symbol preview"); foot.setAttribute("aria-label", "Footprint preview");
    const cap = (t, c) => { const f = el("figure", null, "gp-figure"); f.append(c, el("figcaption", t)); return f; };
    box.append(cap("Symbol", sym), cap("Footprint", foot));
    let gate = 1;
    const s1 = ui.stage(sym, {kind: "schematic", def: () => { const d = def(); return d ? {...d, symbol: globalThis.Atrium.gate(d.symbol, {part: gate})} : null; }, item: () => ({part: gate})});
    // The footprint preview leaves out ".Designator"-style placeholders: fitted to a small part they covered the pads.
    const s2 = ui.stage(foot, {kind: "pcb", def: () => { const d = def(); return d?.footprint ? {...d, footprint: {...d.footprint, shapes: (d.footprint.shapes || []).filter(x => !(x.kind === "text" && /^\./.test(x.text || "")))}} : d; }});
    s1.observe(); s2.observe();
    return {refresh() { s1.fit(); s2.fit(); }, setGate(g) { gate = g; s1.fit(); }, sym, foot};
  }

  // ------------------------------------------------------------------ placing
  function needSheet(host) {
    if (host.doc()?.kind === "schematic") return true;
    const sheet = host.project().documents.find(d => d.kind === "schematic");
    if (!sheet) { host.info("Add a schematic sheet first."); return false; }
    host.selectDocument(sheet.id);
    return true;
  }
  // Add the definition (no undo step of its own: an unused generic definition is pruned on the next
  // generic edit) and start Place Component with the value and ratings as the placement template.
  // A definition added here and still unused when placement ends (Escape) is taken out again.
  function startPlace(host, spec) {
    if (!needSheet(host)) return;
    let def, added = false;
    const project = host.project(), unused = () => !project.documents.some(d => (d.items || []).some(i => i.kind === "part" && i.def === def.id));
    const drop = () => { if (added && host.project() === project && unused()) host.derive(() => { project.library = project.library.filter(d => d !== def); }); };
    try { host.derive(() => { const n = project.library.length; def = GP().ensure(project, spec); added = project.library.length > n; }); } catch (e) { host.info(e.message); return; }
    const value = spec.value != null ? (GP().valueText(def.generic.family, spec.value) ?? def.value) : def.value;
    const params = {...GP().defaults(def.generic), ...(spec.parameters || {})};
    const probe = {parameters: {}, value};
    GP().applyValues(probe, def, value, params);
    if (!host.placeDef(def, "schematic")) { drop(); return; }
    if (added) { const watch = () => host.tool?.() === "place" ? setTimeout(watch, 400) : drop(); setTimeout(watch, 400); }
    // Schematic placement (sch-place.js) carries the value and ratings onto each placed copy.
    const template = () => globalThis.AtriumSchPlace?.setTemplate?.({value, parameters: probe.parameters});
    if (globalThis.AtriumSchPlace) template();
    else { try { Promise.resolve(globalThis.AtriumLazy?.need?.("AtriumSchPlace")).then(template, () => {}); } catch { /* not a lazy module in this build */ } }
    rememberSpec({...spec, family: def.generic.family, package: def.generic.package, style: def.generic.style, subtype: def.generic.subtype, value});
    host.info("Click to place a " + (GP().FAMILIES[def.generic.family]?.short || GP().FAMILIES[def.generic.family]?.title.toLowerCase() || (def.generic.role === "placeholder" ? def.name : "connector")) + " (" + value + ", " + (def.generic.package || def.footprint?.name) + "). Tab edits the value; Escape ends.");
  }
  const quickPlace = (host, family) => startPlace(host, lastSpec(family));

  // ------------------------------------------------------------------ Generic Part dialog
  function partDialog(host, family0) {
    ensureCss();
    const ui = L().ui, d = ui.dialog("Place Generic Component", "gp-dialog");
    let family = family0 || memory().lastFamily || "resistor";
    if (!GP().FAMILIES[family]) family = "resistor"; // the last placement was a placeholder or connector
    let spec = lastSpec(family);
    const body = el("div", null, "gp-body"), list = el("div", null, "gp-families"), form = el("div", null, "gp-form"), preview = el("div", null, "gp-preview");
    list.setAttribute("role", "radiogroup"); list.setAttribute("aria-label", "Part family");
    const status = el("p", null, "gp-status"); status.setAttribute("role", "status");
    let def = null, views = null;
    function make() { try { def = GP().make(spec, host.project()); status.textContent = def.footprint.name + " · " + def.footprint.pads.length + " pad" + (def.footprint.pads.length === 1 ? "" : "s") + (def.footprint.height ? " · " + def.footprint.height + " mm tall" : ""); status.classList.remove("is-error"); }
      catch (e) { def = null; status.textContent = e.message; status.classList.add("is-error"); } }
    function tiles() {
      list.replaceChildren();
      for (const f of GP().ORDER) {
        const b = button(GP().FAMILIES[f].title, () => { family = f; spec = lastSpec(f); tiles(); build(); }, "gp-tile");
        b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(f === family));
        list.append(b);
      }
      list.append(el("hr"), button("Connector / header…", () => { d.close(); connectorDialog(host); }, "gp-tile gp-tile-link"));
      if (globalThis.AtriumPlaceholderUI) list.append(button("Placeholder (op-amp, LDO, memory…)…", () => { d.close(); AtriumPlaceholderUI.placeDialog(host); }, "gp-tile gp-tile-link"));
      radios(list);
    }
    function build() {
      const F = GP().FAMILIES[family];
      form.replaceChildren(el("h3", F.title));
      const pkg = field(form, "Package", select(groupedPackages(F), spec.package, "Package"));
      pkg.onchange = () => { const was = GP().defaults({family, package: spec.package}); spec.package = pkg.value;
        const now = GP().defaults({family, package: spec.package}); spec.parameters = {...(spec.parameters || {})};
        for (const k of Object.keys(now)) if (!spec.parameters[k] || spec.parameters[k] === was[k]) spec.parameters[k] = now[k];
        build(); };
      if (F.subtypes) { const st = field(form, "Type", select(F.subtypes, spec.subtype || F.subtypes[0][0], "Diode type")); st.onchange = () => { spec.subtype = st.value; refresh(); }; }
      if (F.styled) {
        const style = field(form, "Symbol style", select([["iec", "IEC (rectangle)"], ["ansi", "ANSI (zigzag / curved)"]], spec.style || (host.project().symbolPreferences?.resistor === "ansi" ? "ansi" : "iec"), "Symbol style"));
        style.onchange = () => { spec.style = style.value; refresh(); };
      }
      const params = {...GP().defaults({family, package: spec.package}), ...(spec.parameters || {})};
      spec.parameters = params;
      valueInput(form, family, () => spec.value ?? F.value, {tolerance: () => params.Tolerance, apply: v => { spec.value = v; }});
      for (const [k, label, options] of F.fields) {
        const c = options ? select(["", ...options].map(o => [o, o || "—"]), params[k] || "", label) : Object.assign(el("input"), {type: "text", value: params[k] || ""});
        field(form, label, c).onchange = () => { params[k] = c.value; };
        if (!options) c.oninput = () => { params[k] = c.value; };
      }
      refresh();
    }
    function refresh() { make(); if (!views) views = stages(preview, () => def); views.refresh(); fade(preview); }
    const foot = el("div", null, "lib-actions");
    const go = button("Place", () => { if (!def) return; d.close(); startPlace(host, spec); }, "is-primary");
    const shortcutLabel = "Place on the schematic";
    globalThis.AtriumNavCommon?.shortcutTitle(go, globalThis.AtriumI18n?.text(shortcutLabel, "generic") || shortcutLabel, "Enter");
    foot.append(status, button("Cancel", () => d.close()), go);
    d.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.target?.tagName !== "BUTTON") && e.target?.tagName !== "SELECT") { e.preventDefault(); go.click(); } });
    body.append(list, form, preview);
    d.append(body, foot);
    tiles(); ui.show(d); build();
    list.querySelector('[aria-checked="true"]')?.focus();
    return d;
  }
  function groupedPackages(F) {
    return F.packages.map(p => [p, GP().PACKAGES[p]?.title || p]);
  }

  // ------------------------------------------------------------------ Connector / Header dialog
  // mode: place (a new connector) or edit (the selected generic connector: Apply regenerates it).
  function connectorDialog(host, o = {}) {
    ensureCss();
    const C = CG(), ui = L().ui;
    const editing = o.part && GP().isGeneric(o.def);
    const d = ui.dialog(editing ? "Edit Connector " + o.part.ref : "Connector / Header Generator", "gp-dialog gp-connector");
    let spec = editing ? {...o.def.generic} : {...C.defaults(memory().connector?.type || "header"), ...(memory().connector || {})};
    for (const k of ["digest", "fields", "v"]) delete spec[k];
    const body = el("div", null, "gp-body gp-body-conn"), form = el("div", null, "gp-form"), preview = el("div", null, "gp-preview");
    const status = el("p", null, "gp-status"); status.setAttribute("role", "status");
    const warn = el("div", null, "gp-warnings"); warn.setAttribute("role", "alert");
    const gates = el("div", null, "gp-gates");
    let def = null, views = null, gate = 1;
    function make() {
      try { spec = C.normalise(spec); def = GP().make(spec, host.project()); }
      catch (e) { def = null; status.textContent = e.message; status.classList.add("is-error"); return; }
      status.classList.remove("is-error");
      const fp = def.footprint, n = def.symbol.pins.length;
      status.textContent = fp.name + " · " + n + " pin" + (n === 1 ? "" : "s") + " · " + fp.pads.length + " pads · " + (fp.height > .1 ? fp.height + " mm tall" : "board edge") + (def.symbol.parts > 1 ? " · " + def.symbol.parts + " parts" : "");
      warn.replaceChildren();
      if (editing) {
        const loss = GP().losses(host.project(), o.part, def);
        if (loss.lost.length) warn.append(el("p", "Removes pin" + (loss.lost.length === 1 ? " " : "s ") + compact(loss.lost) + (loss.connected.length ? ". Connected and would be disconnected: " + compact(loss.connected) + "." : ". None of them is connected."), loss.connected.length ? "gp-warn is-danger" : "gp-warn"));
        if (loss.gates.length) warn.append(el("p", "Removes part" + (loss.gates.length === 1 ? " " : "s ") + loss.gates.join(", ") + " from the schematic.", "gp-warn is-danger"));
        if (!loss.lost.length && !loss.gates.length) warn.append(el("p", "Every pin keeps its connections (matched by pin number).", "gp-note"));
      }
      gates.replaceChildren();
      const parts = def.symbol.parts || 1;
      if (gate > parts) gate = 1;
      if (parts > 1) for (let k = 1; k <= parts; k++) { const b = button("Part " + String.fromCharCode(64 + k), () => { gate = k; views?.setGate(k); make(); }, "ui-chip"); b.setAttribute("aria-pressed", String(k === gate)); gates.append(b); }
    }
    function refresh() { make(); if (!views) views = stages(preview, () => def); views.setGate(gate); views.refresh(); fade(preview); }
    const set = (k, v) => { spec[k] = v; if (k === "type") { spec = {...C.defaults(v), cols: spec.cols}; build(); return; } refresh(); };
    function build() {
      form.replaceChildren();
      const types = el("div", null, "gp-types"); types.setAttribute("role", "radiogroup"); types.setAttribute("aria-label", "Connector type");
      for (const [k, t] of Object.entries(C.TYPES)) { const b = button(t.title, () => set("type", k), "gp-tile"); b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(k === spec.type)); types.append(b); }
      radios(types); form.append(types);
      const grid = el("div", null, "gp-grid2");
      const pitchSel = select([...C.PITCHES.map(p => [String(p), p + " mm"]), ["custom", "Custom…"]], C.PITCHES.includes(Number(spec.pitch)) ? String(spec.pitch) : "custom", "Pitch");
      const custom = Object.assign(el("input"), {type: "text", inputMode: "decimal", value: String(spec.pitch)}); custom.dataset.unit = "mm"; custom.setAttribute("aria-label", "Custom pitch in mm"); custom.hidden = pitchSel.value !== "custom";
      pitchSel.onchange = () => { custom.hidden = pitchSel.value !== "custom"; if (pitchSel.value !== "custom") set("pitch", Number(pitchSel.value)); else custom.focus(); };
      custom.onchange = () => { const v = globalThis.Atrium.units.parse(custom.value, "mm"); if (Number.isFinite(v)) set("pitch", v); };
      const pitchWrap = el("div", null, "gp-inline"); pitchWrap.append(pitchSel, custom);
      field(grid, "Pitch", pitchWrap);
      const t = C.TYPES[spec.type];
      const rows = field(grid, "Rows", Object.assign(el("input"), {type: "number", min: t.rows[0], max: t.rows[1], value: spec.rows}));
      rows.disabled = t.rows[0] === t.rows[1]; rows.onchange = () => set("rows", Number(rows.value));
      const cols = field(grid, "Pins per row", Object.assign(el("input"), {type: "number", min: 1, max: 100, value: spec.cols}));
      cols.oninput = () => { if (cols.value) set("cols", Number(cols.value)); };
      field(grid, "Numbering", select(C.NUMBERING, spec.numbering, "Numbering")).onchange = e => set("numbering", e.target.value);
      field(grid, "Gender", select([["male", "Male (pins)"], ["female", "Female (socket)"]], spec.gender, "Gender")).onchange = e => set("gender", e.target.value);
      field(grid, "Orientation", select([["vertical", "Vertical"], ["right-angle", "Right-angle"]], spec.orientation, "Orientation")).onchange = e => set("orientation", e.target.value);
      field(grid, "Mount", select([["tht", "Through-hole"], ["smd", "SMD"]], spec.mount, "Mount")).onchange = e => set("mount", e.target.value);
      field(grid, "Split symbol", select([["0", "One part"], ["10", "Parts of 10 pins"], ["16", "Parts of 16 pins"], ["20", "Parts of 20 pins"], ["32", "Parts of 32 pins"], ["40", "Parts of 40 pins"], ["50", "Parts of 50 pins"]], String(spec.split || 0), "Split symbol")).onchange = e => set("split", Number(e.target.value));
      form.append(grid);
      const flags = el("div", null, "gp-flags");
      for (const [k, label] of [["shrouded", "Shrouded"], ["key", "Polarisation key"], ["pegs", "Mounting pegs"]]) {
        const l = el("label", null, "gp-check"), c = el("input"); c.type = "checkbox"; c.checked = !!spec[k]; c.onchange = () => set(k, c.checked);
        l.append(c, document.createTextNode(" " + label)); flags.append(l);
      }
      form.append(flags, warn);
      refresh();
    }
    const foot = el("div", null, "lib-actions");
    const go = button(editing ? "Apply" : "Place", () => {
      if (!def) return;
      if (editing) {
        const loss = GP().losses(host.project(), o.part, def);
        if ((loss.connected.length || loss.gates.length) && !globalThis.confirm?.("Pins " + compact(loss.connected) + " of " + o.part.ref + " are connected and will be removed" + (loss.gates.length ? ", with parts " + loss.gates.join(", ") : "") + ". Apply?")) return;
        let r = null;
        try { host.edit(() => { r = GP().edit(host.project(), o.part, {...spec, force: true}); }, "Edit connector"); } catch (e) { status.textContent = e.message; return; }
        d.close();
        host.select([o.part.id], o.part.id);
        host.info(o.part.ref + " regenerated" + (r?.rewired ? ", " + r.rewired + " wire end(s) followed" : "") + (r?.disconnected_pins?.length ? " · disconnected: " + compact(r.disconnected_pins) : "") + ".");
        return;
      }
      remember({connector: spec});
      d.close();
      startPlace(host, {...spec, value: def.value});
    }, "is-primary");
    foot.append(status, button("Cancel", () => d.close()), go);
    body.append(form, preview);
    const right = preview; right.append(gates);
    d.append(body, foot);
    ui.show(d); build();
    return d;
  }
  function compact(list) {
    const nums = list.map(Number);
    if (!nums.every(Number.isInteger)) return list.join(", ");
    const out = [];
    for (let i = 0; i < nums.length;) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++; out.push(j - i >= 2 ? nums[i] + "–" + nums[j] : nums.slice(i, j + 1).join(", ")); i = j + 1; }
    return out.join(", ");
  }

  // ------------------------------------------------------------------ Properties panel section
  function inspect(section, part, def, ctx) {
    // Placeholders (placeholder-ui.js): their own section; a part resolved from one offers the way back.
    if (section && part?.resolvedFrom && !GP()?.isGeneric(def) && globalThis.AtriumPlaceholderUI) { AtriumPlaceholderUI.resolvedSection(section, part, def, ctx); return; }
    if (!section || !GP()?.isGeneric(def)) return;
    if (def.generic.role === "placeholder" && globalThis.AtriumPlaceholderUI) { ensureCss(); AtriumPlaceholderUI.inspect(section, part, def, ctx); return; }
    ensureCss();
    const host = H(), g = def.generic, F = GP().FAMILIES[g.family];
    const box = el("div", null, "gp-inspector"); box.setAttribute("aria-label", "Generic part");
    const head = el("p", null, "gp-inspector-head");
    head.append(el("strong", g.family === "connector" ? def.name : (F?.title || g.family)), el("span", " · generic" + (GP().customised(def) ? " · edited by hand" : "")));
    box.append(head);
    const edit = (fn, label) => { try { ctx.edit(() => fn(host.project()), label); } catch (e) { ctx.info?.(e.message); } };
    const apply = change => edit(p => {
      const r = GP().edit(p, part, change);
      if (r.refused) throw Error(r.message);
    }, "Edit generic part");
    if (g.family === "connector") {
      const s = g;
      box.append(el("p", s.rows + "×" + s.cols + " · " + s.pitch + " mm · " + CG().NUMBERING.find(n => n[0] === s.numbering)?.[1] + " · " + (s.orientation === "right-angle" ? "right-angle" : "vertical") + ", " + (s.mount === "smd" ? "SMD" : "through-hole"), "gp-note"));
      const cols = Object.assign(el("input"), {type: "number", min: 1, max: 100, value: s.cols});
      field(box, "Pins per row", cols, "field-row").onchange = () => {
        const next = Number(cols.value);
        let made; try { made = GP().make({...s, cols: next}, host.project()); } catch (e) { ctx.info?.(e.message); cols.value = s.cols; return; }
        const loss = GP().losses(host.project(), part, made);
        if (loss.connected.length && !globalThis.confirm?.("Pins " + compact(loss.connected) + " of " + part.ref + " are connected and will be removed. Apply?")) { cols.value = s.cols; return; }
        edit(p => GP().edit(p, part, {cols: next, force: true}), "Edit connector");
      };
      box.append(AtriumNavCommon.actionButton("Edit Connector…", () => connectorDialog(host, {part, def})));
    } else {
      if (!F.colours) valueInput(box, g.family, () => part.value, {tolerance: () => part.parameters?.Tolerance, apply: v => { if (v !== part.value) apply({value: v}); }});
      else field(box, "Colour", select(F.colours.includes(part.value) ? F.colours : [part.value, ...F.colours], part.value, "Colour"), "field-row").onchange = e => apply({value: e.target.value});
      field(box, "Package", select(groupedPackages(F), g.package, "Package"), "field-row").onchange = e => apply({package: e.target.value});
      if (F.subtypes) field(box, "Type", select(F.subtypes, g.subtype, "Diode type"), "field-row").onchange = e => apply({subtype: e.target.value});
      if (F.styled) field(box, "Symbol style", select([["iec", "IEC"], ["ansi", "ANSI"]], g.style, "Symbol style"), "field-row").onchange = e => apply({style: e.target.value});
      for (const [k, label, options] of F.fields) {
        const v = part.parameters?.[k] || "";
        const c = options ? select(["", ...(options.includes(v) || !v ? options : [v, ...options])].map(o => [o, o || "—"]), v, label) : Object.assign(el("input"), {type: "text", value: v});
        field(box, label, c, "field-row").onchange = () => apply({parameters: {[k]: c.value}});
      }
    }
    const bound = part.boundTo ? Object.entries(part.parameters || {}).find(([k]) => /^(mpn|manufacturer part)/i.test(k))?.[1] : null;
    const actions = el("div", null, "gp-actions");
    if (bound) { box.append(el("p", "Bound to " + bound + " (" + (part.boundTo.source || "library") + ")", "gp-note")); actions.append(AtriumNavCommon.actionButton("Unbind", () => edit(p => GP().unbind(p, part), "Unbind manufacturer part"))); }
    actions.append(AtriumNavCommon.actionButton(bound ? "Bind to Another Part…" : "Bind to Manufacturer Part…", () => bindDialog(host, part)));
    if (GP().customised(def)) actions.append(AtriumNavCommon.actionButton("Regenerate", () => edit(p => GP().regenerate(p, def.id), "Regenerate generic part")));
    box.append(actions);
    section.append(box);
  }

  // ------------------------------------------------------------------ Bind to Manufacturer Part
  function selectedGeneric(host) {
    const p = host.project(), sel = new Set(host.selection());
    for (const d of p.documents) for (const i of d.items || []) if (sel.has(i.id) && i.kind === "part" && GP().isGeneric(p.library.find(x => x.id === i.def))) return i;
    return null;
  }
  function bindDialog(host, part) {
    part ||= selectedGeneric(host);
    if (!part) { host.info("Select a generic component (placed from Place › Generic Component) first."); return null; }
    ensureCss();
    const ui = L().ui, d = ui.dialog("Bind " + part.ref + " to a Manufacturer Part", "lib-small gp-bind");
    let list = [];
    try { list = GP().candidates(host.project(), part); } catch (e) { host.info(e.message); return null; }
    const box = el("div", null, "gp-bind-body");
    box.append(el("p", "Parts from the project library and your library sources with a manufacturer part number, the same package" + (GP().UNIT[GP().make && host.project().library.find(x => x.id === part.def)?.generic?.family] ? " and value (" + part.value + ")" : "") + ". The part stays generic; its Manufacturer and MPN fields are copied from the part you choose.", "gp-note"));
    if (!list.length) box.append(el("p", "No library part matches. Add one with an MPN (Library panel or a library source), or assign part numbers from Reports › Bill of Materials › Optimise › Suppliers.", "ui-empty"));
    const table = el("div", null, "ui-list gp-candidates"); table.setAttribute("role", "listbox"); table.setAttribute("aria-label", "Matching parts");
    for (const c of list) {
      const b = button(null, () => {
        let r = null;
        try { host.edit(() => { r = GP().bind(host.project(), part, c.def_id); }, "Bind manufacturer part"); } catch (e) { host.info(e.message); return; }
        d.close(); host.select([part.id], part.id); host.info(part.ref + " bound to " + r.mpn + (r.manufacturer ? " (" + r.manufacturer + ")" : "") + ".");
      }, "ui-row gp-candidate");
      // A library list row: the part number and maker, its value as the meta, the source as the detail.
      b.setAttribute("role", "option");
      const text = el("span", null, "ui-row-text");
      text.append(el("span", c.mpn + " · " + (c.manufacturer || "—"), "ui-row-title"), el("span", c.source + " · " + c.name, "ui-row-detail"));
      b.append(text, el("span", c.value || "", "ui-row-meta"));
      table.append(b);
    }
    box.append(table);
    const foot = el("div", null, "lib-actions"); foot.append(button("Cancel", () => d.close()));
    d.append(box, foot); ui.show(d);
    return d;
  }

  // ------------------------------------------------------------------ dynamic connector: Finalise, Add Part
  function selectedDynamic(host) {
    const DS = globalThis.AtriumDynamicSymbol, p = host.project(), sel = new Set(host.selection());
    for (const i of host.doc().items) if (sel.has(i.id) && i.kind === "part" && DS?.isDynamic(p.library.find(d => d.id === i.def))) return i;
    return null;
  }
  function finaliseDialog(host) {
    const part = selectedDynamic(host);
    if (!part) { host.info("Select a dynamic connector on the schematic first."); return null; }
    ensureCss();
    const DS = globalThis.AtriumDynamicSymbol, ui = L().ui, def = host.project().library.find(x => x.id === part.def);
    const d = ui.dialog("Finalise " + part.ref, "lib-small gp-finalise");
    const box = el("div", null, "gp-bind-body");
    const n = def.dynamic.pins.length;
    box.append(el("p", "Freezes the " + n + "-pin dynamic connector into a normal component. Wires stay connected; new wires no longer add pins.", "gp-note"));
    const name = field(box, "Name", Object.assign(el("input"), {type: "text", value: def.name === "Dynamic Connector" ? "Connector " + n + " pins" : def.name}));
    const libs = L().sourceStore?.list?.() || [];
    const save = el("input"); save.type = "checkbox";
    const lab = el("label", null, "gp-check"); lab.append(save, document.createTextNode(" Also save it to a library"));
    const which = select([...libs.map(l => [l.id, l.name + " (" + l.defs.length + ")"]), ["@new", "New library…"]], libs[0]?.id || "@new", "Library");
    const libName = Object.assign(el("input"), {type: "text", value: "My parts"}); libName.setAttribute("aria-label", "New library name");
    const libRow = el("div", null, "gp-inline"); libRow.append(which, libName); libRow.hidden = true;
    const sync = () => { libRow.hidden = !save.checked; libName.hidden = which.value !== "@new"; };
    save.onchange = sync; which.onchange = sync; sync();
    box.append(lab, libRow);
    const status = el("p", null, "gp-status"); status.setAttribute("role", "status");
    const foot = el("div", null, "lib-actions");
    const go = button("Finalise", () => {
      if (!n) { status.textContent = "Wire at least one pin before finalising the connector."; return; }
      let frozen = null;
      try { host.edit(() => { frozen = DS.freeze(host.project(), part.def, {name: name.value.trim() || undefined}); }, "Finalise dynamic connector"); } catch (e) { status.textContent = e.message; return; }
      let saved = "";
      if (save.checked) {
        const all = L().sourceStore.list();
        let lib = all.find(l => l.id === which.value);
        if (!lib) { lib = {id: globalThis.Atrium.id(), name: libName.value.trim() || "My parts", description: "", defs: [], path: "", added: new Date().toISOString()}; all.push(lib); }
        host.edit(() => { const project = host.project(); L().saveToLibrary(lib, project.library.find(x => x.id === frozen.id), project); }, "Save to library");
        saved = L().sourceStore.save(all) ? " and saved to " + lib.name : " (the library could not be saved in this browser)";
      }
      d.close();
      host.select([part.id], part.id);
      host.info(frozen.name + " is now a normal component" + saved + ".");
    }, "is-primary");
    foot.append(status, button("Cancel", () => d.close()), go);
    d.append(box, foot); ui.show(d);
    return d;
  }
  function addPartDialog(host) {
    const part = selectedDynamic(host);
    if (!part) { host.info("Select a dynamic connector on the schematic first."); return null; }
    ensureCss();
    const DS = globalThis.AtriumDynamicSymbol, ui = L().ui, sheets = host.project().documents.filter(x => x.kind === "schematic");
    const d = ui.dialog("Add a Part of " + part.ref, "lib-small gp-addpart");
    const box = el("div", null, "gp-bind-body");
    box.append(el("p", "Adds part " + String.fromCharCode(65 + Math.max(1, host.project().library.find(x => x.id === part.def).dynamic.parts || 1)) + " of " + part.ref + " to a sheet. Wire to its edge there to add pins; they are numbered on from the other parts.", "gp-note"));
    const sheet = field(box, "Sheet", select(sheets.map(s => [s.id, s.name]), sheets.find(s => s.id !== host.doc().id)?.id || host.doc().id, "Sheet"));
    const status = el("p", null, "gp-status"); status.setAttribute("role", "status");
    const foot = el("div", null, "lib-actions");
    const go = button("Add Part", () => {
      let made = null;
      const target = host.project().documents.find(x => x.id === sheet.value);
      try { host.edit(() => { made = DS.addPart(host.project(), part.def, target, [part.x, part.y]); }, "Add dynamic connector part"); } catch (e) { status.textContent = e.message; return; }
      d.close();
      if (target.id !== host.doc().id) host.selectDocument(target.id);
      host.select([made.id], made.id);
      host.info("Added " + made.ref + String.fromCharCode(64 + made.unit) + " on " + target.name + ". Draw wires to its edge to add pins.");
    }, "is-primary");
    foot.append(status, button("Cancel", () => d.close()), go);
    d.append(box, foot); ui.show(d);
    return d;
  }

  // ------------------------------------------------------------------ install
  let installed = false;
  function install(host) {
    // Literal ids, so scripts/headless-inventory.py finds each action.
    const quick = {"generic-resistor": "resistor", "generic-capacitor": "capacitor", "generic-polarised": "polarised", "generic-electrolytic": "electrolytic",
      "generic-inductor": "inductor", "generic-ferrite": "ferrite", "generic-diode": "diode", "generic-led": "led", "generic-crystal": "crystal", "generic-fuse": "fuse",
      "generic-testpoint": "testpoint", "generic-jumper": "jumper"};
    for (const [id, f] of Object.entries(quick)) host.registerAction(id, () => quickPlace(host, f));
    host.registerAction("generic-part", () => partDialog(host));
    host.registerAction("generic-connector", () => connectorDialog(host));
    host.registerAction("generic-bind", () => bindDialog(host));
    host.registerAction("dynamic-connector-finalise", () => finaliseDialog(host));
    host.registerAction("dynamic-connector-add-part", () => addPartDialog(host));
    if (installed) return;
    installed = true;
    // Properties: a part shown before this module loaded gets its Generic section now.
    if (host.selection().length) host.select(host.selection());
  }
  const boot = () => globalThis.AtriumNavCommon?.ready?.(install);
  if (globalThis.AtriumNavCommon) boot(); else if (globalThis.document?.addEventListener) document.addEventListener("DOMContentLoaded", boot, {once: true});
  return Object.freeze({install, inspect, partDialog, connectorDialog, bindDialog, finaliseDialog, addPartDialog, quickPlace, startPlace, valueInput, stages, FAMILY_ACTIONS});
})();
