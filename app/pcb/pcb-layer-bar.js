"use strict";

// The active board's copper tabs, layer visibility and named sets.
globalThis.AtriumPCBLayerBar = (() => {
  const groupSize = 16;
  let group = "auto", cachedLayers, renderedDoc, menuTrigger;
  globalThis.AtriumI18n?.define({
    "pcb_layers.display": "Layer display · {mode}",
    "pcb_layers.all": "All layers",
    "pcb_layers.dim": "Dim other layers",
    "pcb_layers.single": "Active layer only",
    "pcb_layers.near": "Layers near current",
    "pcb_layers.all_copper": "All copper",
    "pcb_layers.used": "Used layers",
    "pcb_layers.outer": "Top and Bottom",
    "pcb_layers.sets": "Visibility sets",
    "pcb_layers.save_set": "Save Current Set…",
    "pcb_layers.manage_sets": "Manage Layer Sets…",
    "pcb_layers.select_layer": "Select layer",
    "pcb_layers.copper_tabs": "Copper tabs",
    "pcb_layers.controls": "Layer Controls"
  });
  const t = (key, params) => globalThis.AtriumI18n.t(key, params);
  const modes = () => [[t("pcb_layers.all"), "all"], [t("pcb_layers.dim"), "dim"], [t("pcb_layers.single"), "single"]];
  function nameOf(doc, key) {
    const name = doc.layerNames?.[key];
    return typeof name === "string" && name ? name : AtriumPCBAppearance.name(key);
  }

  function otherLayers(host) {
    const doc = host.doc(), defs = host.defs(), revision = host.revision();
    if (cachedLayers?.items === doc.items && cachedLayers.length === doc.items.length &&
        cachedLayers.defs === defs && cachedLayers.revision === revision) return cachedLayers.names;
    const names = new Set(["Silk", "Multi", "Mechanical"]), footprints = new Set();
    const add = layer => { if (layer && AtriumPCBAppearance.index(layer) < 0) names.add(layer); };
    for (const item of doc.items) {
      add(item.layer);
      if (item.kind === "part") footprints.add(defs.get(item.def)?.footprint);
    }
    for (const footprint of footprints) {
      for (const shape of footprint?.shapes || []) add(shape.layer);
      for (const pad of footprint?.pads || []) add(pad.layer);
    }
    const rank = key => /^Mechanical/.test(key) ? 0 : key === "Silk" ? 1 : key === "Bottom silk" ? 2 :
      /paste/i.test(key) ? 3 : /mask|solder/i.test(key) ? 4 : /drill/i.test(key) ? 5 :
      /keep/i.test(key) ? 6 : key === "Multi" ? 8 : 7;
    cachedLayers = {items:doc.items, length:doc.items.length, defs, revision,
      names:[...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, {numeric:true}))};
    return cachedLayers.names;
  }

  function copperTabs(copper, doc, layer) {
    if (copper.length <= groupSize || group === "all") return copper;
    let shown;
    if (group === "outer") shown = [copper[0], copper.at(-1)];
    else if (group === "used") {
      const used = new Set();
      for (const item of doc.items) for (const key of [item.layer, item.fromLayer, item.toLayer]) if (key) used.add(key);
      shown = copper.filter(key => used.has(key));
    } else {
      const start = group === "auto" ? Math.floor(Math.max(0, copper.indexOf(layer)) / groupSize) * groupSize : +group.slice(1);
      shown = copper.slice(start, start + groupSize);
    }
    return shown.includes(layer) || !copper.includes(layer) ? shown :
      [...shown, layer].sort((a, b) => copper.indexOf(a) - copper.indexOf(b));
  }

  function tabGroups(copper) {
    const labels = [[t("pcb_layers.near"), "auto"], [t("pcb_layers.all_copper"), "all"],
      [t("pcb_layers.used"), "used"], [t("pcb_layers.outer"), "outer"]];
    for (let i = 0; i < copper.length; i += groupSize) {
      labels.push(["L" + (i + 1) + "–L" + Math.min(copper.length, i + groupSize), "g" + i]);
    }
    return labels;
  }

  function bindMenu(trigger, bar, host, actions) {
    trigger.disabled = false;
    let loading = false;
    trigger.onclick = async () => {
      if (loading) return;
      const doc = host.doc();
      loading = true;
      try {
        const [menu, manager] = await AtriumLazy.need(["AtriumContextMenu", "AtriumLayerSets"]);
        if (host.doc() !== doc || !trigger.isConnected) return;
        const mode = bar.closest(".layer-bar").dataset.mode, copper = host.copperLayers();
        const activeSet = manager.active(doc.id), visible = copper.filter(layer => !host.hiddenLayers().has(layer));
        const command = (label, run, checked) => ({label, enabled:true, checked, radio:checked != null,
          run:() => { if (host.doc() === doc) run(); }});
        const modeItems = modes().map(([label, value]) => command(label, () => actions.setMode(value), mode === value));
        const sets = [...manager.BUILTIN,
          ...(Array.isArray(doc.layerSets) ? doc.layerSets.map(set => ["custom:" + set.name, set.name]) : [])];
        const entries = [...modeItems, "-", {sub:t("pcb_layers.sets"), items:[
          ...sets.map(([id, label]) => command(label, () => manager.choose(id), activeSet === id)),
          "-", command(t("pcb_layers.save_set"), () => manager.choose("save")),
          command(t("pcb_layers.manage_sets"), () => manager.choose("manage"))
        ]}];
        if (visible.length) entries.push({sub:t("pcb_layers.select_layer"), items:visible.map(key =>
          command(nameOf(doc, key), () => host.setLayer(key), host.activeLayer() === key))});
        if (copper.length > groupSize) entries.push({sub:t("pcb_layers.copper_tabs"), items:tabGroups(copper).map(([label, value]) =>
          command(label, () => { group = value; actions.refresh(); }, group === value))});
        entries.push(command(t("pcb_layers.controls"), controls));
        menu.dropdown(trigger, entries, {host, above:true});
      } catch (error) {
        if (host.doc() === doc) host.info(error.message);
      } finally {
        loading = false;
      }
    };
    trigger.addEventListener("keydown", event => {
      if (event.key === "ArrowDown") { event.preventDefault(); trigger.click(); }
    });
    trigger.addEventListener("mousedown", event => {
      if (trigger.getAttribute("aria-expanded") === "true") event.preventDefault();
    });
    host.on?.("document", () => {
      if (trigger.getAttribute("aria-expanded") === "true") globalThis.AtriumContextMenu?.close(false, true);
    });
  }

  function layerModeShortcut(bar) {
    const display = bar?.querySelector(".layer-menu-button");
    if (!display) return;
    const label = modes().find(([, value]) => value === bar.dataset.mode)?.[0];
    if (label) AtriumNavCommon.shortcutTitle(display, t("pcb_layers.display", {mode:label}), globalThis.AtriumKeymap?.hintKey("layer-mode", "pcb"));
  }
  globalThis.AtriumKeymap?.onChange(() => layerModeShortcut(globalThis.document?.querySelector(".layer-bar")));

  function sync(bar, host, copper, mode, actions) {
    const doc = host.doc(), tabs = copperTabs(copper, doc, host.activeLayer()), others = otherLayers(host);
    const layer = tabs.includes(host.activeLayer()) ? host.activeLayer() : tabs[0] || "";
    const signature = group + "#" + tabs.join("|") + "/" + others.join("|") + "/" + JSON.stringify(doc.layerNames || null);
    const appearance = AtriumPCBAppearance, ui = AtriumNavCommon;
    if (doc !== renderedDoc || bar.dataset.layers !== signature) {
      renderedDoc = doc;
      bar.replaceChildren();
      const addTab = (key, isCopper) => {
        const button = ui.button(null, () => {
          if (isCopper) host.setLayer(key);
          else {
            const hidden = host.hiddenLayers();
            if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
            actions.visibilityChanged();
          }
        }, "layer-tab ui-chrome-action ui-layer-action" + (isCopper ? " copper" : ""));
        button.dataset.layer = key;
        const swatch = ui.el("i", null, "layer-swatch");
        swatch.style.setProperty("--swatch", appearance.color(key));
        button.append(swatch, ui.el("span", nameOf(doc, key)));
        bar.append(button);
      };
      for (const key of tabs) addTab(key, true);
      if (tabs.length && others.length) {
        const divider = ui.el("span", null, "layer-group-divider ui-toolbar-sep");
        divider.setAttribute("aria-hidden", "true");
        bar.append(divider);
      }
      for (const key of others) addTab(key, false);
      bar.dataset.layers = signature;
    }
    for (const button of bar.children) {
      const key = button.dataset.layer;
      if (!key) continue;
      const name = nameOf(doc, key);
      if (button.classList.contains("copper")) {
        button.setAttribute("aria-pressed", String(key === layer));
        button.title = key === layer ? name + " (current layer)" : "Make " + name + " the current layer";
      } else {
        const shown = !host.hiddenLayers().has(key);
        button.setAttribute("aria-pressed", String(shown));
        button.title = (shown ? "Hide " : "Show ") + name;
      }
    }
    const parent = bar.closest(".layer-bar");
    parent?.setAttribute("data-mode", mode);
    const trigger = parent?.querySelector(".layer-menu-button");
    if (trigger && trigger !== menuTrigger) {
      menuTrigger = trigger;
      bindMenu(trigger, bar, host, actions);
    }
    layerModeShortcut(parent);
    return layer;
  }

  function controls() {
    document.body.classList.remove("hide-right");
    const details = document.getElementById("inspector").querySelector("[data-t=Layers]")?.closest("details");
    if (details) {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      details.querySelector("summary").focus();
    } else {
      const active = document.querySelector('#layer-tabs button[aria-pressed="true"]');
      if (active instanceof HTMLElement) active.focus();
    }
  }
  function release(bar) {
    cachedLayers = renderedDoc = undefined;
    if (menuTrigger?.getAttribute("aria-expanded") === "true") globalThis.AtriumContextMenu?.close(false, true);
    if (bar) {
      bar.replaceChildren();
      delete bar.dataset.layers;
    }
  }
  return {otherLayers, copperTabs, sync, controls, release};
})();
