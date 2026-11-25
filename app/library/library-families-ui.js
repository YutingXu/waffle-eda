"use strict";
// Family membership and package choices operate on exact project definitions.
globalThis.AtriumLibraryFamiliesUI = (() => {
  const F = AtriumComponentFamilies, {el, dialog, show, button, label} = AtriumLibrary.ui;
  const compare = new Intl.Collator(undefined, {numeric: true}).compare;
  const projectOf = ctx => ctx.currentProject ? ctx.currentProject() : ctx.project;
  const packageOf = d => globalThis.AtriumCatalogue?.packageOf(d) || d.footprint?.name || "";
  const componentLabel = d => [d.name, packageOf(d) || (d.symbol ? "Symbol only" : "Footprint only")].filter((t, i, all) => all.indexOf(t) === i).join(" · ");

  function picker(defs, searchLabel, chooseLabel, onSelect) {
    const search = el("input"), select = el("select"), container = el("div", null, "lib-family-picker");
    search.type = "search"; search.placeholder = searchLabel; search.spellcheck = false;
    search.setAttribute("aria-label", searchLabel);
    const labels = new Map(defs.map(d => [d.id, componentLabel(d)]));
    const sorted = defs.slice().sort((a, b) => compare(labels.get(a.id), labels.get(b.id)));
    const byId = new Map(defs.map(d => [d.id, d]));
    const nameCounts = new Map();
    for (const def of sorted) {
      const key = labels.get(def.id);
      nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }
    const optionLabel = id => {
      const key = labels.get(id);
      return nameCounts.get(key) > 1 ? key + " · " + id : key;
    };
    const selected = () => byId.get(select.value);
    const matches = (def, q) => !q || (globalThis.AtriumCatalogue?.matches(def, q) ?? AtriumLibrary.search([def], q).length > 0) || def.id === q;
    let eligible = () => true;
    function refresh(filter = eligible) {
      eligible = filter;
      const before = select.value, q = search.value.trim(), limit = 80;
      const options = sorted.filter(def => eligible(def) && matches(def, q));
      select.replaceChildren(new Option(options.length ? chooseLabel : "No matching entries", ""));
      select.disabled = !options.length;
      for (const def of options.slice(0, limit)) select.add(new Option(optionLabel(def.id), def.id));
      if (options.length > limit) {
        const more = new Option("Search to see more entries", ""); more.disabled = true; select.add(more);
      }
      select.value = [...select.options].some(o => o.value === before) ? before : "";
      onSelect(selected());
    }
    search.oninput = () => refresh(); select.onchange = () => onSelect(selected());
    container.append(search, label(chooseLabel, select));
    return {container, search, selected, refresh, optionLabel};
  }

  function manage(ctx, {initial, done} = {}) {
    const owner = projectOf(ctx), defs = owner.library.filter(d => !d.mirrorOf && (d.symbol || d.footprint));
    const definitions = new Map(defs.map(d => [d.id, d])), membership = F.memberships(owner);
    const families = F.browse(owner, defs.filter(d => membership.has(d.id))).filter(row => row.kind === "family");
    const dlg = dialog("Component families", "lib-small lib-family-dialog"), body = el("div", null, "lib-family-body");
    const family = el("select"), name = el("input"), entries = el("div", null, "lib-family-members");
    const error = el("p", null, "lib-error"), footer = el("div", null, "lib-actions");
    error.setAttribute("role", "alert"); name.autocomplete = "off";
    family.add(new Option("New family…", ""));
    for (const f of families) family.add(new Option(f.name, f.id));
    const drafts = new Map(families.map(f => [f.id, {name: f.name, members: new Map(f.parts.flatMap(p => p.options.map(v => [v.id, p.name])))}]));
    const fresh = {name: "", members: new Map()};
    const initialDef = definitions.get(initial);
    if (initialDef && !membership.has(initial)) fresh.members.set(initial, initialDef.name);
    drafts.set("", fresh);
    family.value = membership.get(initial)?.id || (initialDef ? "" : families[0]?.id || "");
    let draft = drafts.get(family.value);

    function save(ungroup) {
      try {
        if (projectOf(ctx) !== owner) throw Error("Open the component families for the current project.");
        const id = family.value;
        const members = [...draft.members].map(([defId, part]) => ({defId, part: part.trim()}));
        let changed = false;
        ctx.edit(() => {
          if (ungroup) F.ungroup(owner, id);
          else if (id) F.update(owner, id, name.value.trim(), members);
          else F.create(owner, name.value.trim(), members);
          changed = true;
        }, ungroup ? "Ungroup component family" : "Save component family");
        if (!changed) return;
        dlg.close();
        done?.(initialDef?.id || members[0]?.defId);
      } catch (e) { error.textContent = e.message; }
    }
    const saveButton = button("Save family", () => save(false), "lib-primary");
    const ungroupButton = button("Ungroup family", () => save(true), "lib-ungroup");
    const validity = () => { saveButton.disabled = !name.value.trim() || !draft.members.size || [...draft.members.values()].some(s => !s.trim()); };
    function memberRows() {
      entries.replaceChildren();
      for (const [id, part] of draft.members) {
        const row = el("div", null, "lib-family-member"), input = el("input");
        input.value = part; input.autocomplete = "off";
        const title = addPicker.optionLabel(id), display = el("strong", title); display.title = title;
        input.setAttribute("aria-label", "Chip model for " + title);
        input.oninput = () => { draft.members.set(id, input.value); validity(); };
        const remove = button("Remove", () => { draft.members.delete(id); refresh(); addPicker.search.focus(); });
        remove.setAttribute("aria-label", "Remove " + title + " from this family");
        const chip = label("Chip model", input);
        chip.dataset.uiFieldColumn = "family chip models";
        row.append(display, chip, remove); entries.append(row);
      }
    }
    const add = button("Add component", () => {
      const def = addPicker.selected(); if (!def) return;
      draft.members.set(def.id, membership.get(def.id)?.part || def.name); refresh();
      entries.lastElementChild?.querySelector("input")?.focus();
    });
    const addPicker = picker(defs, "Find a component by name or package", "Component to add", def => { add.disabled = !def; });
    const pickRow = el("div", null, "lib-family-pick-row"); pickRow.append(addPicker.container, add);
    function refresh() {
      memberRows();
      addPicker.refresh(d => !draft.members.has(d.id) && (!membership.has(d.id) || membership.get(d.id).id === family.value));
      validity();
    }
    family.onchange = () => {
      draft = drafts.get(family.value); name.value = draft.name; ungroupButton.hidden = !family.value;
      error.textContent = ""; refresh();
    };
    name.oninput = () => { draft.name = name.value; validity(); };
    footer.append(ungroupButton, button("Cancel", () => dlg.close()), saveButton);
    body.append(label("Family", family), label("Family name", name), entries, pickRow, error);
    dlg.append(body, footer); family.onchange(); show(dlg);
    if (!family.value) name.focus();
    return dlg;
  }

  function attach(ctx, def, {variant = false, done} = {}) {
    const owner = projectOf(ctx), selectFootprint = !!def.symbol;
    const assets = owner.library.filter(d => d.id !== def.id && !d.mirrorOf && (selectFootprint ? d.footprint : d.symbol && !d.footprint));
    const noun = selectFootprint ? "footprint" : "symbol", action = variant ? "Add package" : "Attach " + noun;
    const dlg = dialog(action + " to " + def.name, "lib-small lib-family-dialog"), body = el("div", null, "lib-family-body");
    const preview = el("div"), name = el("input"), mpn = el("input"), status = el("p", null, "lib-error"), footer = el("div", null, "lib-actions");
    status.setAttribute("role", "alert");
    let valid = false;
    function save() {
      try {
        const asset = assetPicker.selected();
        if (!valid || !asset) return;
        if (projectOf(ctx) !== owner) throw Error("Open the component in the current project.");
        let exact;
        ctx.edit(() => {
          exact = variant ? F.addPackage(owner, def.id, asset.id, {name: name.value.trim(), mpn: mpn.value.trim()})
            : F.bindFootprint(owner, selectFootprint ? def.id : asset.id, selectFootprint ? asset.id : def.id);
        }, action);
        if (!exact) return;
        dlg.close(); done?.(exact.id);
      } catch (e) { status.textContent = e.message; }
    }
    const commit = button(action, save, "lib-primary");
    function validity() { commit.disabled = !valid || (variant && !name.value.trim()); }
    function inspect(asset) {
      preview.replaceChildren(); valid = false; status.textContent = "";
      if (asset) {
        const symbol = selectFootprint ? def : asset, footprint = selectFootprint ? asset : def;
        const result = F.pairing(symbol, footprint);
        valid = result.ok;
        const numbers = vals => vals.slice(0, 10).map(n => n || "unnumbered").join(", ") + (vals.length > 10 ? "…" : "");
        if (!valid) status.textContent = [
          result.missingPins.length ? "Missing pads for pins " + numbers(result.missingPins) + "." : "",
          result.extraPads.length ? "No matching pins for pads " + numbers(result.extraPads) + "." : ""
        ].filter(Boolean).join(" ") || "The symbol and footprint need numbered pins and pads.";
        globalThis.AtriumCatalogue?.preview(preview, {...symbol, footprint: footprint.footprint}, {title: false, params: false});
      }
      validity();
    }
    const assetPicker = picker(assets, "Find " + noun + " by name or package", selectFootprint ? "Footprint to use" : "Symbol to use", inspect);
    name.oninput = validity;
    footer.append(button("Cancel", () => dlg.close()), commit);
    body.append(assetPicker.container, preview);
    if (variant) body.append(el("p", "Uses the symbol and pin numbers from " + def.name + ".", "fe-note"), label("Component name", name), label("Manufacturer part number (optional)", mpn));
    body.append(status);
    dlg.append(body, footer); assetPicker.refresh(); show(dlg);
    return dlg;
  }

  return Object.freeze({manage, attach});
})();
