"use strict";
// Placeholder components in the editor (lazy, with AtriumGenericPartsUI): Place › Placeholder…, the
// Placeholder section of the Properties panel and Resolve…, which browses family › chip › package
// candidates and shows the placeholder's pins beside the real part's with lines joining matched pins.
// The model work is in placeholder-parts.js.
globalThis.AtriumPlaceholderUI = (() => {
  const PH = () => globalThis.AtriumPlaceholders, GP = () => globalThis.AtriumGenericParts, GPUI = () => globalThis.AtriumGenericPartsUI, L = () => globalThis.AtriumLibrary;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const button = (text, fn, cls) => { const b = el("button", text, cls); b.type = "button"; if (fn) b.onclick = fn; return b; };
  const select = (options, value, label) => { const s = el("select"); s.setAttribute("aria-label", label); for (const [v, t] of options) s.add(new Option(t, v)); if (value != null) s.value = String(value); return s; };
  const field = (parent, label, control, cls = "gp-field") => { const l = el("label", null, cls); l.append(el("span", label), control); parent.append(l); return control; };
  // The parameters each family's form offers: [key, label, choices | "int" | "bool", min, max].
  const FORM = {
    opamp: [["units", "Units", [[1, "1"], [2, "2 (dual)"], [4, "4 (quad)"]]], ["power", "Power pins", [["shared", "On each unit"], ["separate", "Separate power unit"]]], ["shutdown", "Shutdown pin", "bool"]],
    comparator: [["units", "Units", [[1, "1"], [2, "2 (dual)"], [4, "4 (quad)"]]], ["power", "Power pins", [["shared", "On each unit"], ["separate", "Separate power unit"]]],
      ["output", "Output", [["push-pull", "Push-pull"], ["open-drain", "Open drain"]]]],
    bjt: [["polarity", "Polarity", [["npn", "NPN"], ["pnp", "PNP"]]]],
    mosfet: [["polarity", "Channel", [["n", "N-channel"], ["p", "P-channel"]]]],
    ldo: [["en", "Enable (EN)", "bool"], ["pg", "Power good (PG)", "bool"], ["fb", "Adjustable (FB/ADJ)", "bool"], ["nr", "Noise reduction (NR)", "bool"]],
    logic: [["function", "Function", ["and", "nand", "or", "nor", "xor", "xnor", "not", "buffer", "tristate"].map(f => [f, f === "tristate" ? "Tri-state buffer" : f.toUpperCase()])],
      ["inputs", "Inputs", "int", 2, 4], ["units", "Units", "int", 1, 6], ["schmitt", "Schmitt trigger", "bool"]],
    memory: [["type", "Type", [["sram", "SRAM"], ["dram", "DRAM"], ["nor", "NOR flash"], ["nand", "NAND flash"], ["eeprom", "EEPROM"], ["fram", "FRAM"]]],
      ["bus", "Interface", [["parallel", "Parallel"], ["spi", "SPI"], ["qspi", "Quad SPI"]]], ["address", "Address bits", "int", 1, 32], ["data", "Data bits", "int", 1, 32]],
    mcu: [["gpio", "GPIO pins", "int", 0, 64], ["spi", "SPI buses", "int", 0, 3], ["i2c", "I²C buses", "int", 0, 3], ["uart", "UARTs", "int", 0, 4], ["usb", "USB", "bool"], ["swd", "SWD debug", "bool"]],
    switch: [["type", "Type", [["spst", "SPST"], ["spdt", "SPDT"], ["tactile", "Tactile (4 pins)"]]]]
  };
  function paramForm(parent, family, params, change) {
    for (const [k, label, kind, min, max] of FORM[family] || []) {
      if (family === "memory" && (k === "address" || k === "data") && params.bus !== "parallel") continue;
      if (family === "logic" && k === "inputs" && ["not", "buffer", "tristate"].includes(params.function)) continue;
      let c;
      if (kind === "bool") { c = el("input"); c.type = "checkbox"; c.checked = !!params[k]; c.onchange = () => change({[k]: c.checked}); }
      else if (kind === "int") { c = el("input"); c.type = "number"; c.min = min; c.max = max; c.value = params[k]; c.onchange = () => change({[k]: Number(c.value)}); }
      else { c = select(kind, params[k], label); c.onchange = () => change({[k]: /^\d+$/.test(c.value) ? Number(c.value) : c.value}); }
      field(parent, label, c);
    }
  }
  const packageChoices = (family, params) => [["", "None (symbol only)"], ...PH().FAMILIES[family].packages(PH().FAMILIES[family].params(params)).map(p => [p, p + " (provisional)"])];

  // ------------------------------------------------------------------ Place › Placeholder…
  function placeDialog(host) {
    const ui = L().ui, d = ui.dialog("Place Placeholder", "gp-dialog");
    let family = "opamp", params = {}, pkg = undefined, def = null, views = null;
    const body = el("div", null, "gp-body"), list = el("div", null, "gp-families"), form = el("div", null, "gp-form"), preview = el("div", null, "gp-preview");
    list.setAttribute("role", "radiogroup"); list.setAttribute("aria-label", "Placeholder family");
    const status = el("p", null, "gp-status"); status.setAttribute("role", "status");
    function make() {
      try { def = GP().make({family, params, package: pkg}, host.project()); status.textContent = def.symbol.pins.length + " pins" + (def.symbol.parts > 1 ? " in " + def.symbol.parts + " units" : "") + (def.footprint ? " · provisional " + def.package : " · no footprint"); status.classList.remove("is-error"); }
      catch (e) { def = null; status.textContent = e.message; status.classList.add("is-error"); }
    }
    function tiles() {
      list.replaceChildren();
      for (const f of PH().ORDER) {
        const b = button(PH().FAMILIES[f].title, () => { family = f; params = {}; pkg = undefined; tiles(); build(); }, "gp-tile");
        b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(f === family)); b.tabIndex = f === family ? 0 : -1;
        list.append(b);
      }
    }
    function build() {
      const F = PH().FAMILIES[family];
      params = F.params(params);
      form.replaceChildren(el("h3", F.title + " placeholder"));
      paramForm(form, family, params, change => { params = {...params, ...change}; pkg = undefined; build(); });
      const choices = packageChoices(family, params);
      if (pkg === undefined) pkg = choices[1]?.[0] ?? "";
      field(form, "Footprint", select(choices, pkg, "Footprint")).onchange = e => { pkg = e.target.value; refresh(); };
      form.append(el("p", "A placeholder never carries a manufacturer part number. Resolve… replaces it with a library component later; nets stay connected.", "gp-note"));
      refresh();
    }
    function refresh() { make(); if (GPUI()?.stages) { if (!views) views = GPUI().stages(preview, () => def); views.refresh(); } }
    const foot = el("div", null, "lib-actions");
    const go = button("Place", () => { if (!def) return; d.close(); GPUI().startPlace(host, {family, params, package: pkg}); }, "is-primary");
    foot.append(status, button("Cancel", () => d.close()), go);
    body.append(list, form, preview); d.append(body, foot);
    tiles(); ui.show(d); build();
    return d;
  }

  // ------------------------------------------------------------------ Properties panel
  function inspect(section, part, def, ctx) {
    const host = globalThis.AtriumNavHost, g = def.generic, F = PH().FAMILIES[g.family];
    const box = el("div", null, "gp-inspector"); box.setAttribute("aria-label", "Placeholder");
    const head = el("p", null, "gp-inspector-head");
    head.append(el("strong", F ? F.title : g.family), el("span", " · placeholder" + (def.footprint ? " · provisional " + (g.package || def.footprint.name) : " · no footprint")));
    box.append(head);
    const edit = (fn, label) => { try { ctx.edit(() => fn(host.project()), label); } catch (e) { ctx.info?.(e.message); } };
    const apply = change => edit(p => { const r = GP().edit(p, part, change); if (r.refused) throw Error(r.message); }, "Edit placeholder");
    if (F) {
      paramForm(box, g.family, g.params, change => apply({params: {...g.params, ...change}, package: PH().FAMILIES[g.family].packages(F.params({...g.params, ...change})).includes(g.package) ? g.package : ""}));
      field(box, "Footprint", select(packageChoices(g.family, g.params), g.package || "", "Footprint"), "field-row").onchange = e => apply({package: e.target.value});
      for (const [k, label] of F.fields) {
        const c = Object.assign(el("input"), {type: "text", value: part.parameters?.[k] || ""});
        field(box, label, c, "field-row").onchange = () => apply({parameters: {[k]: c.value}});
      }
    }
    const actions = el("div", null, "gp-actions");
    actions.append(AtriumNavCommon.actionButton("Resolve…", () => resolveDialog(host, part)));
    box.append(actions);
    section.append(box);
  }
  // A resolved part: where it came from, and the way back.
  function resolvedSection(section, part, def, ctx) {
    const r = part.resolvedFrom, host = globalThis.AtriumNavHost;
    const box = el("div", null, "gp-inspector");
    box.append(el("p", "Resolved from a " + (PH().FAMILIES[r.family]?.label(r.params) || r.family) + " placeholder · " + Object.keys(r.map || {}).length + " pins mapped", "gp-note"));
    const actions = el("div", null, "gp-actions");
    actions.append(AtriumNavCommon.actionButton("Revert to Placeholder", () => { try { ctx.edit(() => PH().revert(host.project(), part), "Revert " + part.ref + " to placeholder"); } catch (e) { ctx.info?.(e.message); } }));
    box.append(actions); section.append(box);
  }

  // ------------------------------------------------------------------ Resolve…
  const MAP_W = 520;
  // Two columns: the placeholder's function pins and the candidate's pins, a line per matched pair.
  function mapSVG(ph, def, m) {
    const left = (ph.symbol?.pins || []).filter(p => p.fn), right = def.symbol?.pins || [], rowH = 16, h = Math.max(left.length, right.length) * rowH + 8;
    const ly = new Map(left.map((p, i) => [String(p.number), 12 + i * rowH])), ry = new Map(right.map((p, i) => [String(p.number), 12 + i * rowH]));
    const conn = new Set(m.connected), esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
    let s = '<svg xmlns="http://www.w3.org/2000/svg" class="ph-map" viewBox="0 0 ' + MAP_W + " " + h + '" role="img" aria-label="Pin mapping">';
    for (const p of left) {
      const y = ly.get(String(p.number)), to = m.map[String(p.number)], bad = conn.has(String(p.number)) && !to;
      s += '<text x="8" y="' + (y + 4) + '" class="' + (bad ? "ph-bad" : conn.has(String(p.number)) ? "ph-used" : "ph-idle") + '">' + esc(p.fn + (p.part ? " ·" + "ABCDEF"[p.part - 1] : "") + " (" + p.number + ")") + "</text>";
      if (to && ry.has(to)) s += '<line x1="150" y1="' + y + '" x2="' + (MAP_W - 190) + '" y2="' + ry.get(to) + '" class="' + (m.inferred.includes(String(p.number)) ? "ph-line ph-inferred" : "ph-line") + '"/>';
    }
    const taken = new Set(Object.values(m.map));
    right.forEach(p => { s += '<text x="' + (MAP_W - 182) + '" y="' + (ry.get(String(p.number)) + 4) + '" class="' + (taken.has(String(p.number)) ? "ph-used" : "ph-idle") + '">' + esc(p.number + " " + (p.name || "") + (p.part ? " ·" + "ABCDEF"[p.part - 1] : "")) + "</text>"; });
    return s + "</svg>";
  }
  function resolveDialog(host, part) {
    const ui = L().ui, F = globalThis.AtriumComponentFamilies;
    const project = () => host.project();
    const ph = project().library.find(d => d.id === part?.def);
    if (!PH().isPlaceholder(ph)) { host.info?.("Select a placeholder part on the schematic."); return null; }
    const d = ui.dialog("Resolve " + part.ref + " (" + (PH().FAMILIES[ph.generic.family]?.label(ph.generic.params) || "placeholder") + ")", "ph-dialog");
    const body = el("div", null, "ph-body"), list = el("div", null, "ui-list ph-list"), view = el("div", null, "ph-view");
    list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Candidates");
    const status = el("p", null, "gp-status"); status.setAttribute("role", "status");
    let all = PH().candidates(project(), part, {complete: false}), chosen = null, manual = {};
    const apply = button("Apply", () => go(), "is-primary"); apply.disabled = true;
    // Family › chip › package: the candidate's family membership, else its name, then the footprint.
    const memberships = new Map();
    const memberOf = c => { const owner = c.lib || project(); if (!memberships.has(owner)) memberships.set(owner, F?.memberships?.(owner) || new Map()); return memberships.get(owner).get(c.def_id); };
    function renderList() {
      list.replaceChildren();
      if (!all.length) { list.append(el("p", "No library component covers this placeholder's functions. Add one to the project or a library source (Symbol Wizard, import), then try again. Waffle does not invent part numbers.", "gp-note")); return; }
      const groups = new Map();
      for (const c of all) { const m = memberOf(c), fam = m?.name || c.name; if (!groups.has(fam)) groups.set(fam, []); groups.get(fam).push({c, chip: m?.part || c.name}); }
      for (const [fam, rows] of groups) {
        const g = el("div", null, "ph-group"); g.append(el("strong", fam));
        for (const {c, chip} of rows) {
          // A library list row: the chip and package, then its source and coverage as the detail.
          const b = button(null, () => pick(c), "ui-row ph-row"), text = el("span", null, "ui-row-text"); b.setAttribute("role", "option"); b.setAttribute("aria-selected", String(chosen === c));
          b.append(text); text.append(el("span", chip + (c.footprint ? " › " + c.footprint : " › no footprint"), "ui-row-title"), el("span", c.source + (c.missing.length ? " · ⚠ " + c.missing.length + " connected pin(s) unmatched" : " · covers every connected function") + (c.unused ? " · " + c.unused + " spare" : ""), "ui-row-detail"));
          g.append(b);
        }
        list.append(g);
      }
    }
    function pick(c) { chosen = c; manual = {}; renderList(); renderView(); }
    function current() { return chosen ? PH().mapping(project(), part, chosen.def, {manual}) : null; }
    function renderView() {
      view.replaceChildren();
      if (!chosen) { view.append(el("p", "Choose a candidate to see how its pins map.", "gp-note")); apply.disabled = true; return; }
      const m = current(), draw = el("div", null, "ph-draw");
      draw.innerHTML = mapSVG(ph, chosen.def, m);
      view.append(el("h3", chosen.name), draw);
      if (m.inferred.length) view.append(el("p", "Functions of " + m.inferred.length + " pin(s) were inferred from the library part's pin names (dashed lines).", "gp-note"));
      // Map by hand: one row per function pin.
      const t = el("table", null, "se-table ui-sheet-fields ph-table");
      const options = [["", "—"], ...chosen.def.symbol.pins.map(q => [String(q.number), q.number + " " + (q.name || "")])];
      for (const p of ph.symbol.pins.filter(q => q.fn)) {
        const tr = el("tr", null, m.connected.includes(String(p.number)) && !m.map[String(p.number)] ? "ph-bad" : "");
        const s = select(options, m.map[String(p.number)] || "", "Pin for " + p.fn);
        s.onchange = () => { manual[String(p.number)] = s.value; renderView(); };
        tr.append(el("td", p.fn + (p.part ? " (unit " + p.part + ")" : "")), el("td", m.connected.includes(String(p.number)) ? "connected" : ""), el("td")); tr.lastChild.append(s); t.append(tr);
      }
      view.append(t);
      const spare = m.unused.filter(q => !/^(NC|N\/C|DNC)$/i.test(q.name));
      if (spare.length) view.append(el("p", "Unused on " + chosen.name + ": " + spare.slice(0, 16).map(q => q.number + (q.name ? " " + q.name : "")).join(", ") + (spare.length > 16 ? "…" : "") + ". Tie off spare inputs and enables (Design Insights lists floating inputs).", "gp-note"));
      apply.disabled = m.missing.length > 0;
      status.textContent = m.missing.length ? "Map connected pins " + m.missing.join(", ") + " to continue." : Object.keys(m.map).length + " pins mapped.";
    }
    function go() {
      if (!chosen) return;
      let r;
      try {
        host.edit(() => {
          let id = chosen.def_id;
          if (chosen.lib) id = L().addFromLibrary(chosen.lib, chosen.def, project()).id;
          r = PH().resolve(project(), part, id, {mapping: manual});
          if (r.refused) throw Error(r.message);
        }, "Resolve " + part.ref + " to " + chosen.name);
      } catch (e) { status.textContent = e.message; return; }
      d.close();
      host.info?.(part.ref + " resolved to " + chosen.name + " · " + r.mapped + " pins mapped" + (r.labelled ? " · " + r.labelled + " net label pair(s) kept connections" : ""));
    }
    const foot = el("div", null, "lib-actions");
    foot.append(status, button("Cancel", () => d.close()), apply);
    body.append(list, view); d.append(body, foot); ui.show(d);
    renderList(); if (all[0] && !all[0].missing.length) pick(all[0]); else renderView();
    return d;
  }
  function selected(host) {
    const p = host.project(), sel = new Set(host.selection?.() || []);
    for (const d of p.documents) for (const i of d.items || []) if (sel.has(i.id) && i.kind === "part" && PH().isPlaceholder(p.library.find(x => x.id === i.def))) return i;
    return PH().unresolved(p)[0]?.part || null;
  }
  function install(host) {
    host.registerAction("generic-placeholder", () => placeDialog(host));
    host.registerAction("placeholder-resolve", () => { const part = selected(host); if (part) resolveDialog(host, part); else noneDialog(); });
  }
  function noneDialog() {
    const ui = L().ui, d = ui.dialog("Resolve Placeholder", "lib-small"), box = el("div", null, "lib-diff");
    box.append(el("p", "This design has no unresolved placeholders. Place one with Place › Placeholder…, then resolve it here, from its Properties or from Design Insights.", "fe-note"));
    const foot = el("div", null, "lib-actions"); foot.append(Object.assign(button("Close", () => d.close()), {className: "lib-primary"}));
    d.append(box, foot); ui.show(d);
    return d;
  }
  const boot = () => globalThis.AtriumNavCommon?.ready?.(install);
  if (globalThis.AtriumNavCommon) boot(); else if (globalThis.document?.addEventListener) document.addEventListener("DOMContentLoaded", boot, {once: true});
  return Object.freeze({install, placeDialog, inspect, resolvedSection, resolveDialog, mapSVG});
})();
