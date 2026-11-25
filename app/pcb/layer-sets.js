"use strict";
// Layer sets (Altium's layer sets): named layer-visibility presets for a board.
// Built in: All Layers, Signal Layers, Plane Layers, Non-Signal Layers, Mechanical Layers.
// Custom sets are saved with the board as doc.layerSets = [{name, shown:[layer, ...]}].
//
// The PCB layer bar (pcb-layer-bar.js) offers these sets and loads their editor on a selection.
//
// Headless API (pure):
//   AtriumLayerSets.layers(doc, defs, copper?)  -> {copper:[{key, type}], other:[key]}
//   AtriumLayerSets.shown(doc, defs, setId)      -> layer keys visible in that set
//   AtriumLayerSets.validate(list)               -> list (throws on a bad doc.layerSets)
globalThis.AtriumLayerSets = (() => {
  const MAX_SETS = 32, MAX_NAME = 60;
  const BUILTIN = [["all", "All Layers"], ["signal", "Signal Layers"], ["plane", "Plane Layers"], ["nonsignal", "Non-Signal Layers"], ["mech", "Mechanical Layers"]];
  const STANDARD = ["Silk", "Bottom silk", "Top mask", "Bottom mask", "Top paste", "Bottom paste", "Mechanical", "Multi"];
  const isMech = k => /mech|keep-?out|outline|dimension|assembly|courtyard|fab/i.test(k);
  const validName = s => typeof s === "string" && !!s.trim() && s === s.trim() && s.length <= MAX_NAME && !/[\u0000-\u001f]/.test(s);
  function validate(list) {
    if (!Array.isArray(list) || list.length > MAX_SETS) throw Error("Layer sets must be a list of at most " + MAX_SETS + ".");
    const names = new Set();
    for (const s of list) {
      if (!s || typeof s !== "object" || !validName(s.name) || names.has(s.name.toLowerCase()) || !Array.isArray(s.shown) || s.shown.length > 300 || !s.shown.every(k => typeof k === "string" && k.length <= 64))
        throw Error("A layer set is malformed.");
      names.add(s.name.toLowerCase());
    }
    return list;
  }
  const custom = doc => Array.isArray(doc?.layerSets) ? doc.layerSets.filter(s => s && validName(s.name) && Array.isArray(s.shown)) : [];
  // Board layers: copper with its stack-up type (Signal / Plane) and every non-copper layer used.
  function layers(doc, defs, copperKeys) {
    let copper = [];
    try {
      const st = globalThis.AtriumStackup?.get?.(doc, defs);
      if (st?.layers) copper = st.layers.filter(l => l.key && (l.type === "Signal" || l.type === "Plane")).map(l => ({key:l.key, type:l.type}));
    } catch {copper = [];}
    const keys = copperKeys || copper.map(c => c.key);
    if (!copper.length || copperKeys) {const t = new Map(copper.map(c => [c.key, c.type])); copper = keys.map(k => ({key:k, type:t.get(k) || "Signal"}));}
    const isCopper = new Set(copper.map(c => c.key)), other = new Set(STANDARD);
    const add = k => {if (k && !isCopper.has(k) && !/^(Top|Bottom|Inner \d+)$/.test(k)) other.add(k);};
    for (const i of doc.items) {
      add(i.layer);
      if (i.kind === "part") {const g = defs?.get?.(i.def)?.footprint; for (const p of [...(g?.shapes || []), ...(g?.pads || [])]) add(p.layer);}
    }
    return {copper, other:[...other]};
  }
  function shown(doc, defs, id, copperKeys) {
    const L = layers(doc, defs, copperKeys), cu = L.copper, all = [...cu.map(c => c.key), ...L.other];
    if (id.startsWith("custom:")) {const s = custom(doc).find(x => x.name === id.slice(7)); return s ? s.shown.filter(k => all.includes(k)) : null;}
    switch (id) {
      case "all": return all;
      case "signal": return [...cu.filter(c => c.type === "Signal").map(c => c.key), "Multi"];
      case "plane": return [...cu.filter(c => c.type === "Plane").map(c => c.key), "Multi"];
      case "nonsignal": return L.other.slice();
      case "mech": return L.other.filter(isMech);
    }
    return null;
  }
  const label = id => BUILTIN.find(b => b[0] === id)?.[1] || (id.startsWith("custom:") ? id.slice(7) : id);

  // ------------------------------------------------------------------ UI
  let host = null;
  const active = new Map();   // board id -> set id (view state, not saved)
  function universe() {const d = host.doc(); return layers(d, host.defs(), host.copperLayers?.());}
  // Hide everything outside the set. The current copper layer stays visible (it is the
  // drawing layer), so a set without copper still leaves one routable layer.
  function applySet(id) {
    const d = host.doc();
    if (d.kind !== "pcb") {host.info("Layer sets apply to board layouts."); return false;}
    const want = shown(d, host.defs(), id, host.copperLayers?.());
    if (!want) {host.info("No layer set " + label(id) + "."); return false;}
    const U = universe(), keep = new Set(want), hidden = host.hiddenLayers();
    const cur = host.activeLayer?.();
    if (cur && !keep.has(cur) && !want.some(k => U.copper.some(c => c.key === k))) keep.add(cur);
    if (!U.copper.some(c => keep.has(c.key)) && U.copper[0]) keep.add(U.copper[0].key);
    for (const k of [...U.copper.map(c => c.key), ...U.other]) {if (keep.has(k)) hidden.delete(k); else hidden.add(k);}
    active.set(d.id, id);
    refresh();
    host.info("Layer set: " + label(id) + " · " + keep.size + " layers shown");
    return true;
  }
  function refresh() {
    try {globalThis.dispatchEvent?.(new Event("atrium-pcb-appearance"));} catch {host.redraw();}
  }
  function currentShown() {
    const U = universe(), hidden = host.hiddenLayers();
    return [...U.copper.map(c => c.key), ...U.other].filter(k => !hidden.has(k));
  }
  function saveAs(name) {
    const d = host.doc(); name = String(name || "").trim();
    if (!validName(name)) throw Error("Give the layer set a name (up to " + MAX_NAME + " characters).");
    if (BUILTIN.some(b => b[1].toLowerCase() === name.toLowerCase())) throw Error(name + " is a built-in layer set.");
    const list = custom(d).filter(s => s.name !== name);
    if (list.length >= MAX_SETS) throw Error("A board keeps at most " + MAX_SETS + " layer sets.");
    const set = {name, shown:currentShown()};
    host.edit(() => {d.layerSets = [...list, set];});
    active.set(d.id, "custom:" + name);
    refresh();
    host.info("Saved layer set " + name + " (" + set.shown.length + " layers)");
  }
  function remove(name) {
    const d = host.doc(), list = custom(d).filter(s => s.name !== name);
    host.edit(() => {if (list.length) d.layerSets = list; else delete d.layerSets;});
    if (active.get(d.id) === "custom:" + name) active.delete(d.id);
    refresh();
  }
  function rename(from, to) {
    const d = host.doc(); to = String(to || "").trim();
    if (!validName(to)) throw Error("Give the layer set a name.");
    if (custom(d).some(s => s.name.toLowerCase() === to.toLowerCase() && s.name !== from) || BUILTIN.some(b => b[1].toLowerCase() === to.toLowerCase())) throw Error("A layer set named " + to + " already exists.");
    host.edit(() => {d.layerSets = custom(d).map(s => s.name === from ? {...s, name:to} : s);});
    refresh();
  }
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const btn = (text, fn, cls, title) => {const b = el("button", text, cls); b.classList.add("ui-button"); if (cls === "is-primary") b.dataset.variant = "primary"; if (cls === "ls-small" || cls === "ls-save") b.dataset.size = "sm"; b.type = "button"; b.onclick = fn; if (title) b.title = title; return b;};
  // Layer Sets dialog: pick, save the current visibility, rename or delete custom sets.
  function manage(focusSave) {
    const d0 = host.doc();
    if (d0.kind !== "pcb") {host.info("Open a board layout to use layer sets."); return null;}
    const dlg = el("dialog", null, "ui-dialog work-dialog ls-dialog"); dlg.setAttribute("aria-labelledby", "ls-title");
    const h = el("h2", "Layer Sets", "ui-dialog-title"); h.id = "ls-title";
    const help = el("p", "Show a named group of layers. Save the layers shown now as a set; sets are stored with the board.", "ls-help");
    const list = el("div", null, "ui-list ls-list ui-dialog-body"); list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Layer sets");
    const status = el("p", null, "ls-status"); status.setAttribute("role", "status");
    const safe = fn => (...a) => {try {status.textContent = ""; fn(...a);} catch (e) {status.textContent = e.message;}};
    function paint() {
      const d = host.doc(), cur = active.get(d.id);
      list.replaceChildren();
      const rows = [...BUILTIN.map(([id, name]) => ({id, name, builtin:true})), ...custom(d).map(s => ({id:"custom:" + s.name, name:s.name, count:s.shown.length}))];
      for (const r of rows) {
        // A library list row: the set's name (a button that shows it), its size, then its actions.
        const row = el("div", null, "ui-row ls-row"), text = el("span", null, "ui-row-text"); row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(r.id === cur)); row.tabIndex = -1; row.dataset.id = r.id;
        const pick = btn(r.name, safe(() => {applySet(r.id); paint();}), "ui-row-title ls-pick", "Show " + r.name);
        text.append(pick); row.append(text, el("small", r.builtin ? "Built in" : r.count + " layers", "ui-row-meta"));
        const actions = el("span", null, "ui-row-actions"); if (!r.builtin) row.append(actions); actions.append(
          btn("Rename", safe(() => {const to = globalThis.prompt?.("Rename layer set", r.name); if (to != null && to.trim() !== r.name) {rename(r.name, to); paint();}}), "ls-small"),
          btn("Delete", safe(() => {remove(r.name); paint();}), "ls-small", "Delete " + r.name));
        list.append(row);
      }
    }
    list.addEventListener("keydown", e => {
      const items = [...list.querySelectorAll(".ls-pick")], at = items.indexOf(document.activeElement);
      const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
      if (to == null) return;
      e.preventDefault(); items[Math.max(0, Math.min(items.length - 1, to))]?.focus();
    });
    const addRow = el("div", null, "ls-add"), input = el("input", null, "ui-field"); input.placeholder = "Name for the layers shown now"; input.maxLength = MAX_NAME; input.setAttribute("aria-label", "New layer set name");
    const save = safe(() => {saveAs(input.value); input.value = ""; paint();});
    input.onkeydown = e => {if (e.key === "Enter") {e.preventDefault(); save();}};
    addRow.append(input, btn("Save current", save, "ls-save"));
    const foot = el("div", null, "work-actions ui-dialog-actions"), done = btn("Done", () => dlg.close(), "is-primary");
    foot.append(done);
    dlg.append(h, help, list, addRow, status, foot);
    document.body.append(dlg);
    dlg.addEventListener("close", () => {dlg.remove(); host.canvas()?.focus();}, {once:true});
    paint(); globalThis.AtriumShell?.adoptDialog?.(dlg, {initialFocus: () => focusSave ? input : list.querySelector('[aria-selected="true"] .ls-pick') || list.querySelector(".ls-pick")}); dlg.showModal();
    (focusSave ? input : list.querySelector('[aria-selected="true"] .ls-pick') || list.querySelector(".ls-pick"))?.focus();
    return dlg;
  }
  // A choice from the layer bar's picker: "all", "signal", ..., "custom:Name", "save", "manage".
  function choose(value) {
    if (!host) return false;
    if (value === "manage") return !!manage(false);
    if (value === "save") return !!manage(true);
    return applySet(value);
  }
  function attach(h) {
    host = h;
    host.registerAction("layer-sets", () => manage(false));
  }
  if (typeof document !== "undefined") globalThis.AtriumNavCommon?.ready(attach);
  return {BUILTIN, layers, shown, validate, label, choose, applySet, saveAs, remove, rename, manage, attach, active:id => active.get(id)};
})();
