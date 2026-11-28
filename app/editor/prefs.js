"use strict";
// AtriumPrefs: application preferences and the Preferences dialog (File › Preferences…, Mod+,).
//
//   AtriumPrefs.get("pcb.smartGuides")      -> value (or the default)
//   AtriumPrefs.get()                       -> every value
//   AtriumPrefs.set("pcb.hud", true)        AtriumPrefs.set({"general.units": "mil", ...})
//   AtriumPrefs.on(fn)                      fn({key, value, old}) after each change; returns off()
//   AtriumPrefs.on("pcb.", fn)              only keys starting with "pcb."
//   AtriumPrefs.exportJSON() / importJSON(text)   AtriumPrefs.reset(keys?)
//   AtriumPrefs.registerPage({id, title, order, keywords, render(container, api)})
//   AtriumPrefs.open(pageId?)               AtriumPrefs.openStartPage()
//
// Storage: one versioned object in localStorage ("atrium.prefs"):
//   {format:"atrium-prefs", version:1, values:{key: value}} holding only values that differ from
//   the defaults. The first load migrates the older scattered keys it replaces (object snap,
//   "atrium.snap.v1"); those keys are left in place for the modules that still read them.
// Secrets never enter prefs: keys that look like credentials are refused by set() and dropped
// from exports and imports (AI and supplier keys stay with their own modules).
// Appearance is AtriumTheme's own versioned store; the dialog shows its page and an export
// includes it under "appearance".
if (!globalThis.AtriumPref && typeof require === "function") require("./theme.js");
globalThis.AtriumPrefs = (() => {
  const STORE = "atrium.prefs", FORMAT = "atrium-prefs", VERSION = 1, SCH_PLACE = "atrium-sch-place";
  const SECRET = /(api.?key|token|secret|password|passwd|credential|auth(?!or))/i; // "author" is not a secret
  // Security-relevant switches (security review F8): an imported file never turns these on by itself.
  // They are held, listed with unticked boxes, and applied only when the user ticks them.
  const GUARDED = Object.freeze({"extensions.developerMode": "Developer mode: load unpacked extensions from a folder",
    "general.updateCheck": "Check for updates (contacts github.com)"});
  const heldBack = (k, v, allow) => k in GUARDED && (v === true || v === "true" || v === 1) && get(k) !== true && !(allow || []).includes(k);
  const DEFAULTS = Object.freeze({
    "general.language": "system", "general.units": "mm", "general.autosave": true, "general.autosaveMinutes": 5, "general.autoIncrement": true, "general.startPage": "auto",
    "schematic.grid": 1.27, "schematic.autoJunctions": true, "schematic.hopOvers": false, "schematic.sheetSize": "Altium A4", "schematic.orientation": "landscape", "schematic.titleBlock": "standard",
    "schematic.afterUpdatePcb": "show", "schematic.singleNegation": true,
    "pcb.grid": .25, "pcb.snapGrid": true, "pcb.snapObjects": true, "pcb.snapRadius": 8, "pcb.rerouteOnDrag": true, "pcb.smartGuides": true, "pcb.hud": false, "pcb.showRatsnest": true,
    "pcb.designatorsFollow": false, "pcb.trackWidth": .25, "pcb.viaDiameter": .6, "pcb.viaDrill": .3, "pcb.importRules": "use",
    "pcb.livePours": "live", "pcb.livePourDrag": "live",
    "routing.spaceCyclesCorner": false, "routing.padEntry": "centre", "routing.snapLabels": true, "routing.cornerGlyph": true,
    "routing.cornerStyle": "last", "routing.neckDown": true, "routing.jitterTolerance": 100,
    "routing.dragReroute": "on", "routing.dragRerouteCap": 32, "routing.dragRerouteDepth": 2,
    "checks.courtyard": false, "library.starterInNewProjects": true, "general.layoutByKind": false, "keyboard.peekCheatsheet": false, "labs.notebook": false
  });
  // Butter features ("butter.<feature>") start in beta, off by default. A feature comes out of beta by
  // joining this list: its key then defaults to true, and a stored false still turns it off. AtriumLabs
  // reads through get() once bound, and the MCP server mirrors the list (GRADUATED_BUTTER in mcp/server.py).
  const GRADUATED = Object.freeze(["links"]);
  const CHOICES = {"general.units": ["mm", "mil"], "general.startPage": ["auto", "always", "never"], "schematic.orientation": ["landscape", "portrait"],
    "schematic.titleBlock": ["standard", "ansi", "none"], "schematic.afterUpdatePcb": ["show", "stay"],
    "pcb.importRules": ["ask", "use", "keep"], "pcb.livePours": ["live", "manual"], "pcb.livePourDrag": ["live", "drop"], "routing.padEntry": ["centre", "edge", "any"], "routing.dragReroute": ["on", "off", "shift"],
    "routing.cornerStyle": ["last", "45", "45arc", "90", "90arc", "any"]};
  const RANGES = {"general.autosaveMinutes": [1, 120], "schematic.grid": [.0254, 25.4], "pcb.grid": [.001, 10], "pcb.snapRadius": [2, 40],
    "pcb.trackWidth": [.01, 20], "pcb.viaDiameter": [.05, 20], "pcb.viaDrill": [.02, 10], "routing.dragRerouteCap": [0, 256], "routing.dragRerouteDepth": [.1, 50], "routing.jitterTolerance": [0, 300]};
  const storage = (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  const listeners = new Set();
  let values = {};
  // Values a newer build stored (new choices): unused, kept on save.
  let foreign = {};

  // ------------------------------------------------------------------ values
  function clean(key, v) {
    if (SECRET.test(key)) throw Error("Preferences never store secrets (" + key + ").");
    if (key.startsWith("butter.")) {
      if (!/^butter\.[a-z][A-Za-z0-9]*$/.test(key) || typeof v !== "boolean") throw Error("Butter preferences need a feature key and a boolean.");
      return v;
    }
    if (!(key in DEFAULTS)) return v; // Keys other modules add are stored as given (JSON values).
    const d = DEFAULTS[key];
    if (typeof d === "boolean") return v === true || v === "true" || v === 1;
    if (typeof d === "number") {
      const n = Number(v), [lo, hi] = RANGES[key] || [-Infinity, Infinity];
      if (!Number.isFinite(n)) throw Error("Enter a number for " + key + ".");
      return Math.min(hi, Math.max(lo, n));
    }
    const s = String(v ?? "");
    if (CHOICES[key] && !CHOICES[key].includes(s)) throw Error(key + " must be one of " + CHOICES[key].join(", ") + ".");
    return s;
  }
  const json = v => { try { return JSON.parse(JSON.stringify(v)); } catch { return undefined; } };
  function get(key) {
    if (key == null) return {...DEFAULTS, ...values};
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : key.startsWith("butter.") ? GRADUATED.includes(key.slice(7)) : DEFAULTS[key];
  }
  const changed = () => ({...values});
  function persist() {
    if (!Object.keys(values).length && !Object.keys(foreign).length) storage?.removeItem?.(STORE);
    else storage?.setItem(STORE, JSON.stringify({format: FORMAT, version: VERSION, values: {...foreign, ...values}}));
  }
  function save() {
    const span = storage && globalThis.AtriumDiagnostics?.performance?.begin("settings","save");
    try { if (span) span.run(persist); else persist(); } catch {}
  }
  function emit(key, value, old) { for (const l of [...listeners]) if (!l.prefix || key.startsWith(l.prefix)) try { l.fn({key, value, old}); } catch (e) { globalThis.console?.warn?.(e); } }
  function set(key, value) {
    if (key && typeof key === "object") { for (const [k, v] of Object.entries(key)) set(k, v); return get(); }
    if (typeof key !== "string" || !key) throw Error("A preference needs a key.");
    const v = clean(key, json(value)), old = get(key);
    if (JSON.stringify(v) === JSON.stringify(old) && !(key in foreign)) return v;
    if (globalThis.AtriumLabs?.permits(key, v) === false) throw Error("Finish editing before changing Experimental features.");
    delete foreign[key];
    if (key in DEFAULTS && JSON.stringify(v) === JSON.stringify(DEFAULTS[key])) delete values[key]; else values[key] = v;
    save(); emit(key, v, old);
    return v;
  }
  function reset(keys) {
    for (const k of keys || Object.keys(values)) if (k in values && globalThis.AtriumLabs?.permits(k, DEFAULTS[k]) !== false) { const old = values[k]; delete values[k]; save(); emit(k, get(k), old); }
  }
  function on(prefix, fn) {
    const l = typeof prefix === "function" ? {fn: prefix, prefix: ""} : {fn, prefix: String(prefix || "")};
    listeners.add(l);
    return () => listeners.delete(l);
  }
  // Older keys this object replaces. Read once, when no prefs object exists yet.
  function migrate() {
    const out = {};
    try {
      const snap = JSON.parse(storage?.getItem("atrium.snap.v1") || "null");
      if (snap && typeof snap === "object") {
        if (typeof snap.grid === "boolean") out["pcb.snapGrid"] = snap.grid;
        if (typeof snap.objects === "boolean") out["pcb.snapObjects"] = snap.objects;
        if (typeof snap.radius === "number") out["pcb.snapRadius"] = snap.radius;
      }
    } catch {}
    return out;
  }
  function load() {
    const raw = globalThis.AtriumPref.envelope(storage);
    const own = raw?.format === FORMAT && raw.values && typeof raw.values === "object";
    // A store AtriumPref (theme.js) wrote before this file loaded still takes the migration.
    const input = own ? (raw.migrate ? {...migrate(), ...raw.values} : raw.values) : raw ? {} : migrate();
    values = {}; foreign = {};
    for (const [k, v] of Object.entries(input)) try { if (SECRET.test(k)) continue; const c = clean(k, v); if (!(k in DEFAULTS) || JSON.stringify(c) !== JSON.stringify(DEFAULTS[k])) values[k] = c; } catch { if (own) foreign[k] = v; }
    // Schematic placement kept auto-increment in its own key ("atrium-sch-place"); it moves here
    // once (the key keeps the increment step).
    let moved = false;
    try {
      const sp = JSON.parse(storage?.getItem(SCH_PLACE) || "null");
      if (sp && typeof sp.autoIncrement === "boolean") {
        if (!("general.autoIncrement" in values) && sp.autoIncrement !== DEFAULTS["general.autoIncrement"]) values["general.autoIncrement"] = sp.autoIncrement;
        delete sp.autoIncrement; storage.setItem(SCH_PLACE, JSON.stringify(sp)); moved = true;
      }
    } catch {}
    if ((!raw || raw.migrate || moved) && (Object.keys(values).length || raw)) save();
  }
  function exportJSON() {
    const out = {format: FORMAT, version: VERSION, values: {}};
    for (const [k, v] of Object.entries(values)) if (!SECRET.test(k)) out.values[k] = v;
    try { const t = globalThis.AtriumTheme?.get?.(); if (t) out.appearance = t; } catch {}
    return JSON.stringify(out, null, 2);
  }
  function importJSON(text, {allow = []} = {}) {
    let data;
    try { data = typeof text === "string" ? JSON.parse(text) : text; } catch { throw Error("This file is not valid JSON."); }
    if (!data || data.format !== FORMAT || typeof data.values !== "object") throw Error("This is not a Waffle preferences file.");
    if (data.version > VERSION) throw Error("These preferences come from a newer Waffle.");
    const skipped = [], held = [];
    for (const [k, v] of Object.entries(data.values)) { if (SECRET.test(k)) { skipped.push(k); continue; } if (heldBack(k, v, allow)) { held.push(k); continue; } try { set(k, v); } catch { skipped.push(k); } }
    if (data.appearance && globalThis.AtriumTheme?.importJSON) try { AtriumTheme.importJSON(JSON.stringify(data.appearance)); } catch { skipped.push("appearance"); }
    return {skipped, held};
  }
  // Defaults for a sheet the user adds (editor Add schematic sheet / Add PCB layout).
  function sheetDefaults(doc) {
    if (!doc) return doc;
    if (doc.kind === "pcb") { if (values["pcb.grid"]) doc.grid = values["pcb.grid"]; return doc; }
    if (values["schematic.grid"]) doc.grid = values["schematic.grid"];
    const s = {};
    if (values["schematic.sheetSize"]) s.size = values["schematic.sheetSize"];
    if (values["schematic.orientation"] === "portrait") s.orientation = "portrait";
    if (values["schematic.titleBlock"]) s.titleBlock = values["schematic.titleBlock"];
    if (values["schematic.hopOvers"] && doc.kind === "schematic") doc.hopOvers = true;
    if (Object.keys(s).length) doc.sheet = {...(doc.sheet || {}), ...s};
    return doc;
  }

  // ------------------------------------------------------------------ live settings
  const host = () => globalThis.AtriumNavHost;
  const SNAP = {"pcb.snapGrid": "grid", "pcb.snapObjects": "objects", "pcb.snapRadius": "radius"};
  function apply(key, value) {
    if (key === "general.autosave" || key === "general.autosaveMinutes") {
      const active = host();
      active?.folderProject?.()?.configureDrafts?.();
      globalThis.AtriumForeignDrafts?.configure(active);
    }
    if (SNAP[key]) { try { globalThis.AtriumPCBEdit?.setSnap?.(SNAP[key], value); host()?.redraw?.(); } catch {} return; }
    if (LIVE.test(key)) host()?.setPref?.(key, value);
    if (key === "schematic.singleNegation") globalThis.AtriumSchAppearance?.singleNegation?.(value, true); // redraws
  }
  // Editor state a preference drives directly (AtriumNavHost.setPref); the menu toggles for the
  // same state write back through AtriumPref.set, so both stay in step.
  const LIVE = /^(pcb\.(rerouteOnDrag|smartGuides|hud|designatorsFollow|trackWidth|showRatsnest)|schematic\.hopOvers)$/;
  // Where each preference is read. tests/prefs-wiring.cjs checks every key a page shows is listed
  // here and that each file named reads that key; "prefs.js" readers are checked by behaviour.
  const READERS = Object.freeze({
    "general.units": ["editor/editor.js", "project/templates.js"], "general.autosave": ["project/autosave.js", "project/folder-drafts.js"], "general.autosaveMinutes": ["project/folder-drafts.js"],
    "general.autoIncrement": ["schematic/sch-place.js", "editor/editor.js"], "general.startPage": ["editor/prefs.js"], "general.language": ["editor/i18n.js"],
    "schematic.grid": ["editor/prefs.js", "project/templates.js"], "schematic.autoJunctions": ["editor/prefs.js"], "schematic.hopOvers": ["editor/prefs.js", "editor/editor.js"],
    "schematic.sheetSize": ["editor/prefs.js", "project/templates.js"], "schematic.orientation": ["editor/prefs.js", "project/templates.js"], "schematic.titleBlock": ["editor/prefs.js", "project/templates.js"],
    "schematic.afterUpdatePcb": ["schematic/eco.js"], "schematic.singleNegation": ["schematic/sch-appearance.js"],
    "pcb.grid": ["editor/prefs.js", "project/templates.js"], "pcb.snapGrid": ["editor/prefs.js"], "pcb.snapObjects": ["editor/prefs.js", "pcb/pcb-edit.js"], "pcb.snapRadius": ["editor/prefs.js"],
    "pcb.rerouteOnDrag": ["editor/editor.js"], "pcb.smartGuides": ["editor/editor.js"], "pcb.hud": ["editor/editor.js"], "pcb.showRatsnest": ["editor/editor.js"], "pcb.designatorsFollow": ["editor/editor.js"],
    "pcb.trackWidth": ["pcb/router.js", "editor/editor.js"], "pcb.viaDiameter": ["pcb/router.js"], "pcb.viaDrill": ["pcb/router.js"], "pcb.importRules": ["formats/import-rules.js"],
    "pcb.livePours": ["pcb/polygon-pour.js"], "pcb.livePourDrag": ["pcb/polygon-pour.js"],
    "routing.spaceCyclesCorner": ["pcb/route-feel.js"], "routing.padEntry": ["pcb/route-feel.js"], "routing.snapLabels": ["pcb/route-feel.js"], "routing.cornerGlyph": ["pcb/route-feel.js"],
    "routing.cornerStyle": ["pcb/route-feel.js"], "routing.neckDown": ["pcb/route-feel.js"], "routing.jitterTolerance": ["pcb/route-feel.js"],
    "routing.dragReroute": ["pcb/drag-reroute.js"], "routing.dragRerouteCap": ["pcb/drag-reroute.js"], "routing.dragRerouteDepth": ["pcb/drag-reroute.js"],
    "checks.courtyard": ["checks/rules.js"], "library.starterInNewProjects": ["editor/start-page.js"], "general.layoutByKind": ["editor/dock.js"], "keyboard.peekCheatsheet": ["editor/vscode-keys.js"], "labs.notebook": ["editor/labs.js"]
  });
  // Auto-junctions: a junction where a new wire ends on the inside of another wire, or another
  // wire ends on the inside of the new one (a T), as Altium places them. Returns the junctions added.
  function junctions(doc, wire) {
    const A = globalThis.Atrium, out = [];
    if (!get("schematic.autoJunctions") || !A?.nearSegment || doc?.kind !== "schematic" || wire?.kind !== "wire") return out;
    const inside = (p, w) => w.points.some((q, n) => n > 0 && A.nearSegment(p, w.points[n - 1], q) < 1e-4 && !A.same(p, w.points[n - 1]) && !A.same(p, q));
    const ends = w => [w.points[0], w.points[w.points.length - 1]];
    const at = new Set(doc.items.filter(i => i.kind === "junction").map(i => A.pointKey([i.x, i.y])));
    const add = p => { const k = A.pointKey(p); if (at.has(k)) return; at.add(k); const j = {id: A.id(), kind: "junction", x: p[0], y: p[1]}; doc.items.push(j); out.push(j); };
    for (const w of doc.items) {
      if (w.kind !== "wire" || w === wire || !w.points?.length) continue;
      for (const p of ends(wire)) if (inside(p, w)) add(p);
      for (const p of ends(w)) if (inside(p, wire)) add(p);
    }
    return out;
  }
  on(e => apply(e.key, e.value));
  // Dynamic re-route on drag: Off here and the PCB page's (and the menu's) re-route toggle are the same switch.
  on("routing.dragReroute", e => { const v = e.value !== "off"; if (get("pcb.rerouteOnDrag") !== v) set("pcb.rerouteOnDrag", v); });
  on("pcb.rerouteOnDrag", e => { const m = get("routing.dragReroute"); if (!e.value && m !== "off") set("routing.dragReroute", "off"); else if (e.value && m === "off") set("routing.dragReroute", "on"); });
  // i18n: switch the locale live; text already on screen in other modules follows on its next render.
  on("general.language", e => { globalThis.AtriumI18n?.setLocale?.(e.value).then(() => { if (dialog?.open) status("Language changed. Some text changes the next time it is shown; restart Waffle to switch everything."); }, err => { if (dialog?.open) status(err.message, true); }); });

  // ------------------------------------------------------------------ pages
  const pages = [];
  // Older routes lead to their section on the parent page.
  const parents = {search:"keyboard", "route-suggestions":"routing", clipboard:"general", history:"general",
    energy:"display", "external-tools":"extensions", "extension-dev":"extensions"};
  const childPages = id => pages.filter(p => parents[p.id] === id && (p.id !== "search" || globalThis.AtriumLabs?.notebookEnabled()));
  const catalog = () => pages.filter(p => !Object.hasOwn(parents, p.id));
  const sections = [
    ["App", {general:"settings", appearance:"layers", display:"drawing", keyboard:"command", mouse:"pan"}],
    ["Design", {schematic:"schematic", pcb:"board", routing:"route", checks:"select", insights:"chip", library:"book"}],
    ["Connect", {extensions:"chip", collaboration:"comment"}],
    ["Advanced", {labs:"grid"}]
  ];
  function registerPage(spec) {
    if (!spec?.id || typeof spec.render !== "function") throw Error("A preferences page needs an id and render().");
    const i = pages.findIndex(p => p.id === spec.id), page = {order: 100, keywords: "", ...spec};
    if (i >= 0) pages[i] = page; else pages.push(page);
    pages.sort((a, b) => a.order - b.order);
    return {dispose() { const k = pages.indexOf(page); if (k >= 0) pages.splice(k, 1); }};
  }
  function resetPage(page) {
    if (!page) return;
    const parts = [page, ...childPages(page.id)];
    reset(Object.keys(values).filter(key => {
      if (key === "general.efficiency") return page.id === "display";
      return parts.some(p => p.resetKeys?.includes(key) ?? key.startsWith(p.id + "."));
    }));
    if (page.id === "appearance") globalThis.AtriumTheme?.reset?.();
    if (page.id === "keyboard") globalThis.AtriumKeymap?.setPreset?.("altium");
  }
  const doc = globalThis.document;
  function el(tag, cls, text) { return AtriumNavCommon.classedElement(doc, tag, cls, text); }
  function button(text, fn, cls, title) { const b = el("button", cls, text); b.type = "button"; b.onclick = fn; if (title) b.title = title; return b; }
  const act = a => { close(); setTimeout(() => host()?.act?.(a), 0); };
  const icon = name => AtriumNavCommon.icon(name);
  // Field rows: [key, label, help?, {type, options, unit, step}]
  function row(container, key, label, help, o = {}) {
    const d = DEFAULTS[key], id = "prf-" + key.replace(/\W/g, "-"), wrap = el("div", "prf-row");
    wrap.dataset.search = (label + " " + (help || "") + " " + key + " " + (o.keywords || "")).toLowerCase();
    let input;
    if (typeof d === "boolean") {
      wrap.classList.add("prf-check");
      input = el("input", "ui-checkbox"); input.type = "checkbox"; input.checked = !!get(key); input.id = id;
      input.onchange = () => { commit(key, input.checked, input); input.checked = !!get(key); };
      const l = el("label", "ui-checkbox-row"); l.htmlFor = id; l.append(input, el("span", null, label)); wrap.append(l);
    } else {
      const l = el("label", "prf-label", label); l.htmlFor = id;
      if (o.options) {
        input = el("select");
        for (const [v, t] of o.options) { const op = el("option", null, t); op.value = String(v); input.append(op); }
        input.value = String(get(key));
        input.onchange = () => commit(key, typeof d === "number" ? +input.value : input.value, input);
      } else {
        input = el("input"); input.type = "number"; input.step = String(o.step || "any"); const r = RANGES[key]; if (r) { input.min = String(r[0]); input.max = String(r[1]); }
        if (o.unit === "mm" || o.unit === "%") input.dataset.numericUnit = o.unit;
        input.dataset.increment = String(o.unit === "mm" ? .01 : 1); input.dataset.defaultValue = String(d);
        input.value = String(get(key));
        input.onchange = () => { commit(key, input.value, input); input.value = String(get(key)); };
      }
      input.id = id; input.classList.add("ui-field");
      const control = el("span", "prf-control"); control.append(input); if (o.unit) control.append(el("span", "prf-unit", o.unit));
      wrap.append(l, control);
    }
    if (help) { const h = el("small", "prf-help", help); h.id = id + "-help"; input.setAttribute("aria-describedby", h.id); wrap.append(h); }
    const restore = button("Reset", () => {
      reset([key]);
      if (input.type === "checkbox") input.checked = !!get(key);
      else input.value = String(get(key));
      updateReset(); input.focus();
    }, "prf-reset");
    restore.setAttribute("aria-label", "Reset " + label + " to default");
    const updateReset = () => {
      restore.hidden = get(key) === d;
      wrap.toggleAttribute("data-modified", !restore.hidden);
    };
    wrap.append(restore); input.addEventListener("change", updateReset); updateReset();
    container.append(wrap);
    return input;
  }
  function commit(key, value, input) {
    try { set(key, value); status(""); delete input.dataset.editRejected; } catch (e) { status(e.message, true); input.dataset.editRejected = ""; }
  }
  let groupId = 0;
  function group(container, title) {
    const section = el("section", "prf-group"), heading = el("h3", "prf-heading", title), card = el("div", "prf-card");
    heading.id = "prf-group-" + ++groupId;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading, card); container.append(section); return card;
  }
  function links(container, items) {
    const wrap = el("div", "prf-links");
    for (const [text, action, help] of items) {
      const r = el("div", "prf-row prf-link"); r.dataset.search = (text + " " + (help || "")).toLowerCase();
      r.append(button(text, () => act(action), "prf-button")); if (help) r.append(el("small", "prf-help", help));
      wrap.append(r);
    }
    container.append(wrap);
  }

  registerPage({id: "general", title: "General", order: 0, keywords: "units startup autosave increment start page", render(c) {
    const g = group(c, "Startup and units");
    // i18n: Language (AtriumI18n.available() lists app/locales; "system" follows the OS languages).
    const langs = (globalThis.AtriumI18n?.available?.() || [{id: "en", name: "English", native: "English"}]).map(l => [l.id, l.native && l.native !== l.name ? l.native + " – " + l.name : l.name]);
    row(g, "general.language", "Language", "Restart Waffle to apply the language everywhere.", {options: [["system", "System default"], ...langs], keywords: "language locale translation i18n"});
    row(g, "general.startPage", "Show the start page", "Auto opens it when no project is open.", {options: [["auto", "Auto: when no project is open"], ["always", "Always at launch"], ["never", "Never"]]});
    row(g, "general.units", "Units for new projects", "Switch units on the canvas.", {options: [["mm", "Millimetres (mm)"], ["mil", "Mils (mil)"]]});
    const e = group(c, "Editing");
    row(e, "general.autoIncrement", "Auto-increment designators and labels when placing repeatedly");
    row(e, "general.autosave", "Autosave recovery snapshots while editing", "Keep a private recovery draft between saves.");
    row(e, "general.autosaveMinutes", "Autosave interval", "Time between recovery drafts after the first draft.", {unit: "min", step: 1});
    const w = group(c, "Workspace");
    row(w, "general.layoutByKind", "Switch the workspace layout by document kind", "Keep separate panel layouts for sheets and boards.");
    const s = group(c, "Settings sync"); s.id = "prf-settings-sync";
    const r = el("div", "prf-row prf-link"); r.dataset.search = "settings sync export import bundle all theme keymap layout backup";
    const file = el("input"); file.type = "file"; file.accept = "application/json,.json"; file.hidden = true;
    file.onchange = () => {
      const f = file.files?.[0]; file.value = "";
      if (f) importSettingsFile(f, message => { render(); status(message); })
        .then(keys => { if (keys.length) render(); }).catch(e => status(e.message, true));
    };
    r.append(button("Export all settings…", exportAll, "prf-button"),
      button("Import all settings…", () => file.click(), "prf-button"), file,
      el("small", "prf-help", "Transfer preferences, shortcuts and layouts without secrets."));
    s.append(r);
    for (const x of extras.values()) x.render(s, api);
  }});
  registerPage({id: "schematic", title: "Schematic", order: 1, keywords: "grid junction sheet size template title block update pcb eco negation overline", render(c) {
    row(group(c, "General"), "schematic.singleNegation", "Single “\\” negation", "Draw \\RESET overlined without renaming the net.", {keywords: "overline active low bar backslash"});
    const g = group(c, "New sheets");
    row(g, "schematic.grid", "Snap grid", null, {options: [[.635, "25 mil (0.635 mm)"], [1.27, "50 mil (1.27 mm)"], [2.54, "100 mil (2.54 mm)"]]});
    const sizes = globalThis.AtriumSchAppearance?.sheetSizes || [{name: "Altium A4"}, {name: "A4"}, {name: "A3"}, {name: "ANSI A"}, {name: "ANSI B"}];
    row(g, "schematic.sheetSize", "Sheet size", null, {options: sizes.map(s => [s.name, s.family && s.label && s.name.startsWith(s.family + " ") ? s.label + " (" + s.family + "® legacy size)" : s.name])});
    row(g, "schematic.orientation", "Orientation", null, {options: [["landscape", "Landscape"], ["portrait", "Portrait"]]});
    row(g, "schematic.titleBlock", "Title block template", null, {options: [["standard", "Standard"], ["ansi", "ANSI"], ["none", "None"]]});
    const w = group(c, "Wiring");
    row(w, "schematic.autoJunctions", "Place junctions automatically where wires form a T");
    row(w, "schematic.hopOvers", "Hop-overs at unjoined wire crossings", "Applies to the open sheet and new sheets.");
    const u = group(c, "Update PCB");
    row(u, "schematic.afterUpdatePcb", "After Update PCB", "Fit the board in view after updating it.", {options: [["show", "Show the board"], ["stay", "Stay on the schematic"]], keywords: "eco engineering change order update pcb document"});
  }});
  registerPage({id: "pcb", title: "PCB", order: 2, keywords: "grid snap reroute drag smart guides hud designators via track width import rules", render(c) {
    const g = group(c, "Grid and snap");
    row(g, "pcb.grid", "Snap grid for new boards", null, {unit: "mm", step: .005});
    row(g, "pcb.snapGrid", "Snap to grid");
    row(g, "pcb.snapObjects", "Snap to objects (pads, vias, track ends, outline)");
    row(g, "pcb.snapRadius", "Object snap distance", null, {unit: "px", step: 1});
    const m = group(c, "Interactive editing");
    row(m, "pcb.rerouteOnDrag", "Re-route connected tracks when dragging a component");
    row(m, "pcb.smartGuides", "Smart guides (alignment and spacing hints while moving)");
    row(m, "pcb.hud", "Heads-up display at the cursor");
    row(m, "pcb.showRatsnest", "Show connection lines (ratsnest)", "Toggle on the board."); // key help: prefs-controls.js
    row(m, "pcb.designatorsFollow", "Designators follow moved and rotated parts");
    row(m, "pcb.livePours", "Repour polygons after each edit", "Repour the affected copper after each edit.",
      {options: [["live", "Automatically (live pours)"], ["manual", "Only with Repour"]], keywords: "polygon pour repour live copper fill plane dynamic shape"});
    row(m, "pcb.livePourDrag", "Polygon pours while dragging", "Large pours update when you drop the part.",
      {options: [["live", "Follow the part"], ["drop", "Repour on drop"]], keywords: "polygon pour drag realtime preview copper"});
    const r = group(c, "Routing defaults");
    row(r, "pcb.trackWidth", "Track width", "Used when no width rule applies.", {unit: "mm", step: .01});
    row(r, "pcb.viaDiameter", "Via diameter", null, {unit: "mm", step: .01});
    row(r, "pcb.viaDrill", "Via drill", null, {unit: "mm", step: .01});
    const i = group(c, "Imported boards");
    row(i, "pcb.importRules", "When importing a board with its own design rules", "Ask shows the rule choice in Messages after import.",
      {options: [["use", "Use the board's rules"], ["ask", "Ask"], ["keep", "Keep Waffle defaults"]], keywords: "import altium rules design rules source rules drc clearance"});
  }});
  registerPage({id: "routing", title: "Routing", order: 2.5, keywords: "route routing interactive corner style 45 90 arc any angle space shift+space altium pad entry snap glyph push shove drag reroute dynamic component", render: (c, api) => globalThis.AtriumRoutingPrefs(c, api)});
  registerPage({id: "appearance", title: "Appearance", order: 3, keywords: "theme dark light accent density font motion canvas colour color", render(c) {
    const T = globalThis.AtriumTheme, page = T?.appearancePage?.();
    if (page) {
      page.classList.add("prf-appearance"); c.append(page);
      // The gallery (theme-picker.js) has Import/Export theme, Customize… and the Color Theme picker.
      const bar = el("div", "prf-inline-actions");
      bar.append(button("Reset appearance", () => { T.reset(); status("Restored the default appearance."); }, null, "The Dark theme, theme accent, default density, font size, motion and canvas"));
      const vs = el("div", "prf-inline-actions"); vs.dataset.search = "vs code vscode theme import color theme json vsix";
      vs.append(button("Import VS Code theme…", () => vscode("themeDialog"), null, "Paste or open a VS Code colour theme (.json or .vsix), or try a built-in example"));
      c.append(bar, vs);
    }
  }});
  registerPage({id: "keyboard", title: "Keyboard", order: 4, keywords: "shortcuts keys bindings keymap preset", render(c) {
    // Key presets (docs/shortcuts.md); the start page has the same chooser.
    const K = globalThis.AtriumKeymap, vs = el("div", "prf-row prf-key-preset"), pick = el("select", "ui-field"), lab = el("label", "prf-label", "Key preset");
    vs.dataset.search = "key preset keymap vscode kicad allegro modern mac";
    pick.id = "prf-key-preset"; lab.htmlFor = pick.id;
    for (const p of K?.presets?.() || []) { const op = el("option", null, p.title); op.value = p.id; pick.append(op); }
    pick.value = K?.preset?.() || "altium";
    pick.onchange = () => { try { K.setPreset(pick.value); status((K.presets().find(p => p.id === pick.value)?.title || pick.value) + " keys on."); } catch (e) { status(e.message, true); pick.value = K.preset(); } };
    const pc = el("span", "prf-control"); pc.append(pick);
    const policy = el("small", "prf-help", "Changes defaults and keeps your custom shortcuts.");
    policy.id = "prf-key-preset-help"; pick.setAttribute("aria-describedby", policy.id);
    vs.append(lab, pc, policy);
    c.append(vs);
    row(group(c, "Cheat sheet"), "keyboard.peekCheatsheet", "Peek the cheat sheet while holding the primary modifier", "Hold Command or Ctrl for about half a second.");
    links(c, [["Keyboard shortcuts…", "keyboard-shortcuts", "Rebind, import or export keyboard shortcuts."], ["Shortcut reference", "shortcuts", "Look up keys and command sequences."]]);
    const r = el("div", "prf-row prf-link"); r.dataset.search = "vs code vscode keybindings json import";
    r.append(button("Import VS Code keybindings…", () => vscode("keysDialog"), "prf-button"), el("small", "prf-help", "Review conflicts before assigning matching shortcuts."));
    c.append(r);
  }});
  registerPage({id: "extensions", title: "Extensions and Tools", order: 5, keywords: "extensions plugins ai mcp assistant scripting", render(c) {
    c.append(el("p", "prf-note", "API keys stay with each integration and never appear in a preferences export."));
    links(c, [["Extensions…", "extensions", "Install, enable and configure extensions."], ["AI integration…", "mcp", "Connect an AI client through MCP or the built-in assistant."], ["Scripting console", "scripting-console"]]);
  }});
  registerPage({id: "search", title: "Command palette", order: 4.5, keywords: "palette aliases command shortcuts keyboard hotkeys quicklinks browser snippets clipboard templates",
    resetKeys: ["search.commandAliases", "search.quicklinks"], render(c) {
    const P = globalThis.AtriumPalettePersonal;
    if (P) {P.renderPreferences(c,api); return;}
    const note = el("p","prf-note","Loading search preferences…");
    c.append(note);
    queueMicrotask(() => {
      if (!c.isConnected) return;
      c.setAttribute("aria-busy","true");
      globalThis.AtriumLazy.need("AtriumPalettePersonal").then(personal => {
        if (c.isConnected && globalThis.AtriumLabs?.notebookEnabled()) personal.renderPreferences(c,api);
      }, error => {note.textContent = error.message;}).finally(() => c.removeAttribute("aria-busy"));
    });
  }});
  registerPage({id: "library", title: "Library", order: 6, keywords: "library sources atrlib starter parts components", render(c) {
    const g = group(c, "Starter library");
    row(g, "library.starterInNewProjects", "Add the starter library to new projects", "Start with common electronic and mechanical parts.");
    const r = el("div", "prf-row prf-link"); r.dataset.search = "add starter library current project";
    r.append(button("Add the starter library to this project", addStarter, "prf-button")); g.append(r);
    links(c, [["Library sources (.atrlib)…", "library-sources", "Library files this computer knows, with their paths."], ["Library panel", "library-panel"]]);
  }});
  async function addStarter() {
    try {
      const L = globalThis.AtriumLazy; if (!globalThis.AtriumStarterLibrary) await L.need("AtriumStarterLibrary");
      const h = host(); let n = 0;
      h.edit(() => { n = AtriumStarterLibrary.addTo(h.project()); });
      status(n ? n + " starter parts added to the project library." : "This project already has the starter library.");
    } catch (e) { status(e.message, true); }
  }

  // ------------------------------------------------------------------ settings sync
  // One file with preferences, appearance, key map and panel layout. Nothing that looks like a
  // credential is written or read: keys named like one are dropped at every depth, and so are
  // string values shaped like common API keys.
  const BUNDLE = "atrium-settings";
  const LAYOUT = {collapsedSections: "atrium.collapsed-sections", collapsedPanels: "atrium.collapsed-panels", pcbView: "atrium.pcbView.v1"};
  const extras = new Map();   // extend(): tools' own keys (prefs-storage.js)
  function extend(name, extra) {
    const fresh = !extras.has(name);
    extras.set(name, extra);
    if (dialog?.open) {
      const group = ui.main.querySelector("#prf-settings-sync");
      if (fresh && group) extra.render(group, api);
      if (ui.search.value.trim()) render(true);
    }
    return extras;
  }
  const SECRET_KEY = /(api.?key|secret|password|passwd|credential|bearer|^auth|token$)/i, SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|xox[abp]-|AIza|Bearer\s)/;
  function scrub(v, path = "", dropped = []) {
    if (Array.isArray(v)) return v.map((x, i) => scrub(x, path + "[" + i + "]", dropped));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) { if (SECRET_KEY.test(k) || typeof x === "string" && SECRET_VALUE.test(x)) { dropped.push(path + k); continue; } out[k] = scrub(x, path + k + ".", dropped); }
      return out;
    }
    return v;
  }
  function exportSettings() {
    const out = {format: BUNDLE, version: 1, prefs: JSON.parse(exportJSON()).values};
    try { const T = globalThis.AtriumTheme; if (T) out.theme = JSON.parse(T.exportJSON()); } catch {}
    try { const K = globalThis.AtriumKeymap; if (K) out.keymap = JSON.parse(K.exportJSON()); } catch {}
    const layout = {};
    for (const [k, key] of Object.entries(LAYOUT)) try { const t = storage?.getItem(key); if (t) layout[k] = JSON.parse(t); } catch {}
    out.layout = layout;
    for (const [n, x] of extras) out[n] = x.collect();
    return JSON.stringify(scrub(out), null, 2);
  }
  function importSettings(text, {allow = []} = {}) {
    let data;
    try { data = typeof text === "string" ? JSON.parse(text) : text; } catch { throw Error("This file is not valid JSON."); }
    // A preferences-only file (waffle-preferences.json, from older versions) imports too.
    if (data?.format === FORMAT && data.values && typeof data.values === "object") { const r = importJSON(data, {allow}); return {applied: ["preferences"], skipped: r.skipped, notes: [], held: r.held}; }
    if (!data || data.format !== BUNDLE) throw Error("This is not a Waffle settings file.");
    if (data.version > 1) throw Error("These settings come from a newer Waffle.");
    const dropped = []; data = scrub(data, "", dropped);
    const applied = [], skipped = dropped.slice(), notes = [], held = [];
    if (data.prefs && typeof data.prefs === "object") {
      for (const [k, v] of Object.entries(data.prefs)) { if (heldBack(k, v, allow)) { held.push(k); continue; } try { set(k, v); } catch { skipped.push(k); } }
      applied.push("preferences");
    }
    if (data.theme) try { globalThis.AtriumTheme.importJSON(JSON.stringify(data.theme)); applied.push("appearance"); } catch (e) { skipped.push("appearance (" + e.message + ")"); }
    if (data.keymap) try { const p = globalThis.AtriumKeymap.importJSON(data.keymap); applied.push("key map"); if (p?.length) skipped.push(...p); } catch (e) { skipped.push("key map (" + e.message + ")"); }
    if (data.layout && typeof data.layout === "object") {
      let n = 0;
      for (const [k, key] of Object.entries(LAYOUT)) if (k in data.layout) try { storage?.setItem(key, JSON.stringify(data.layout[k])); n++; } catch {}
      const V = globalThis.AtriumPCBAppearance, view = data.layout.pcbView;
      if (V && view && typeof view === "object") try {
        V.reset();
        for (const [l, c] of Object.entries(view.colors || {})) V.setColor(l, c);
        for (const [k, c] of Object.entries(view.system || {})) V.setSystem(k, c);
        for (const [k, o] of Object.entries(view.opacity || {})) V.setOpacity(k, o);
      } catch {}
      if (n) { applied.push("panel layout"); notes.push("Collapsed panels and sections apply the next time Waffle starts."); }
    }
    for (const [n, x] of extras) if (data[n]) applied.push(...x.restore(data[n], skipped));
    return {applied, skipped, notes, held};
  }
  // Preferences › General › Settings sync, and the command palette.
  function exportAll() {
    return AtriumLazy.need("AtriumPrefsControls")
      .then(controls => controls.exportSettingsFile(exportSettings(), {host:host(), status}))
      .catch(e => host()?.info?.(e.message));
  }
  async function importSettingsFile(file, report) {
    const controls = await AtriumLazy.need("AtriumPrefsControls");
    return controls.importSettingsFile(file, {importSettings, guarded:GUARDED, set, report});
  }
  async function importAll() {
    const h = host(), pick = globalThis.AtriumIO?.pickFile;
    if (!pick) { open("general"); return; }
    h?.info?.("Choose a Waffle settings file (.json)…");
    try {
      const f = await pick([".json"]); if (!f) return;
      const keys = await importSettingsFile(f, message => {
        h?.info?.(message);
        if (dialog?.open) { render(); status(message); }
      });
      if (keys.length && dialog?.open) render();
    } catch (e) { h?.info?.(e.message); }
  }
  // The VS Code theme and keybinding importer (vscode-theme.js) loads on first use.
  const vscode = (fn, ...args) => {
    const L = globalThis.AtriumLazy, ready = globalThis.AtriumVSCode ? Promise.resolve(globalThis.AtriumVSCode) : L ? L.need("AtriumVSCode") : Promise.reject(Error("The VS Code importer is not available."));
    return ready.then(V => V[fn](...args)).catch(e => { status(e.message, true); host()?.info?.(e.message); });
  };

  // ------------------------------------------------------------------ dialog
  let dialog = null, ui = null, current = "general", pendingPage = null, opening = 0;
  function status(text, error) { if (!ui) return; ui.status.textContent = text || ""; ui.status.classList.toggle("prf-status-error", !!error); }
  function build() {
    const d = el("dialog", "work-dialog prf-dialog"); d.setAttribute("aria-labelledby", "prf-title");
    const head = el("header", "prf-window-head"), title = el("h2", "prf-title", "Preferences"); title.id = "prf-title";
    const dismiss = button("", () => close(), "prf-close ui-button", "Close Preferences");
    dismiss.dataset.variant = "quiet"; dismiss.setAttribute("aria-label", "Close Preferences"); dismiss.append(icon("close"));
    if (globalThis.AtriumKeymap?.mac) head.append(dismiss, title); else head.append(title, dismiss);
    const search = el("input", "prf-search ui-field");
    search.type = "search"; search.placeholder = "Search preferences"; search.setAttribute("aria-label", "Search preferences");
    const searchBox = AtriumUI.searchField(search); searchBox.classList.add("prf-search-box");
    const body = el("div", "prf-body"), nav = el("nav", "prf-nav"); nav.setAttribute("aria-label", "Preference pages");
    const list = el("ul", "prf-page-groups"); list.setAttribute("role", "list");
    const jump = el("select", "prf-page-select ui-field");
    jump.setAttribute("aria-label", "Preference page");
    const show = (id, event) => { pendingPage = null; current = id; render(false, event?.detail > 0); };
    jump.onchange = () => show(jump.value);
    const picker = el("label", "prf-page-picker ui-field-row"); picker.append(jump);
    nav.append(head, searchBox, list, picker);
    const main = el("div", "prf-page"); main.setAttribute("role", "region"); main.tabIndex = -1;
    body.append(nav, main);
    const st = el("p", "prf-status"); st.setAttribute("role", "status");
    d.append(body, st);
    AtriumShell.adoptDialog(d, {title, body:[body, st], defaultAction:false});
    d.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault(); event.stopPropagation(); close();
    });
    search.addEventListener("input", () => { pendingPage = null; render(); });
    search.addEventListener("keydown", e => {
      if (e.key !== "ArrowDown") return;
      e.preventDefault();
      (jump.getClientRects?.()?.length ? jump : list.querySelector("button"))?.focus();
    });
    list.addEventListener("keydown", e => {
      const bs = [...list.querySelectorAll("button")], i = bs.indexOf(doc.activeElement);
      if (i < 0) return;
      const k = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (k) { e.preventDefault(); const b = bs[(i + k + bs.length) % bs.length]; b.focus(); b.click(); }
      else if (e.key === "Home" || e.key === "End") { e.preventDefault(); const b = bs[e.key === "Home" ? 0 : bs.length - 1]; b.focus(); b.click(); }
    });
    doc.body.append(d);
    dialog = d; ui = {search, list, jump, main, status: st, show, head};
  }
  function loadWindowControls() {
    if (ui.controls) return;
    AtriumLazy.need("AtriumPrefsControls").then(controls => {
      if (ui.controls) return;
      ui.controls = controls;
      controls.makeMovable(dialog, ui.head);
      if (dialog.open) controls.enhance(ui.main);
    }, error => status(error.message, true));
  }
  async function confirmRestore(p) {
    const controls = ui.controls || await AtriumLazy.need("AtriumPrefsControls");
    if (!dialog.open || current !== p.id) return;
    const message = await controls.confirmDefaults(p.title);
    if (!message) return;
    resetPage(p); render(); status(message);
    ui.main.querySelector(".prf-restore-link")?.focus({preventScroll:true});
  }
  function prepareFields(container) {
    for (const input of container.querySelectorAll('.prf-check > label > input[type="checkbox"], .prf-appearance .thp-check > input[type="checkbox"]'))
      { input.setAttribute("role", "switch"); input.classList.add("ui-switch"); input.parentElement.classList.add("ui-switch-row"); }
    ui.controls?.enhance(container);
  }
  function refreshSections(body, page) {
    const children = childPages(page.id);
    const mounted = new Map([...body.children].filter(node => node.dataset.prfSection).map(node => [node.dataset.prfSection,node]));
    const sections = children.map(child => {
      const existing = mounted.get(child.id);
      if (existing) { mounted.delete(child.id); return existing; }
      const section = el("div", "prf-page-section");
      section.dataset.prfSection = child.id;
      section.dataset.search = (child.title + " " + child.keywords).toLowerCase();
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", child.title);
      section.tabIndex = -1;
      try { child.render(section, api); }
      catch (e) { section.append(el("p", "prf-note", "This page failed to load: " + e.message)); }
      prepareFields(section);
      return section;
    });
    for (const obsolete of mounted.values()) obsolete.remove();
    // Late modules can add sections without detaching any previously rendered editor.
    let next = body.lastElementChild;
    for (const section of sections.reverse()) {
      if (!section.parentNode) body.insertBefore(section,next);
      next = section;
    }
  }
  function pageBody(p) {
    const c = el("div", "prf-page-body"), head = el("div", "prf-content-head");
    head.append(el("h3", "prf-page-title", p.title)); c.append(head);
    try { p.render(c, api); }
    catch (e) { c.append(el("p", "prf-note", "This page failed to load: " + e.message)); }
    prepareFields(c);
    const footer = el("div", "prf-page-footer");
    footer.append(button("Restore Defaults…", () => confirmRestore(p), "prf-restore-link")); c.append(footer);
    refreshSections(c,p);
    return c;
  }
  function pageNavigation(list, shown) {
    const remaining = new Map(shown.map(({p}) => [p.id, p]));
    const addGroup = (title, entries) => {
      if (!entries.length) return;
      const group = el("li"), options = el("ul"); options.setAttribute("role", "list");
      group.append(el("div", "prf-nav-label", title), options);
      for (const [p, symbol] of entries) {
        const li = el("li"), item = button("", event => ui.show(p.id, event), "prf-nav-item ui-button", p.title);
        item.append(icon(symbol), el("span", null, p.title));
        if (p.id === current) item.setAttribute("aria-current", "page");
        item.dataset.variant = p.id === current ? "primary" : "quiet";
        li.append(item); options.append(li);
      }
      list.append(group);
    };
    list.replaceChildren();
    for (const [title, items] of sections) {
      const entries = Object.entries(items).flatMap(([id, symbol]) => {
        const p = remaining.get(id); remaining.delete(id); return p ? [[p, symbol]] : [];
      });
      if (title === "Advanced") entries.push(...[...remaining.values()].map(p => [p, "settings"]));
      addGroup(title, entries);
    }
  }
  // Only a row search needs to build pages other than the selected one.
  function render(refresh = false, fade = false) {
    const q = ui.search.value.trim().toLowerCase(), list = ui.list, main = ui.main;
    const navFocused = list.contains(doc.activeElement), shown = [];
    for (const p of catalog()) {
      const titleMatch = !q || (p.title + " " + p.keywords).toLowerCase().includes(q);
      let c = refresh && main.dataset.shown === p.id ? main.querySelector(".prf-page-body") : null;
      if (c) refreshSections(c,p);
      if (!titleMatch) {
        c ||= pageBody(p);
        if (![...c.querySelectorAll("[data-search]")].some(n => n.dataset.search.includes(q))) continue;
      }
      shown.push({p, c, titleMatch});
    }
    if (!shown.some(x => x.p.id === current)) current = shown[0]?.p.id || current;
    pageNavigation(list, shown);
    const options = shown.map(({p}) => {
      const option = el("option", null, p.title); option.value = p.id; return option;
    });
    ui.jump.replaceChildren(...options);
    ui.jump.value = current;
    ui.jump.disabled = !shown.length;
    if (navFocused) list.querySelector('[aria-current="page"]')?.focus();
    const page = shown.find(x => x.p.id === current);
    if (!page) { main.removeAttribute("aria-label"); delete main.dataset.shown; main.replaceChildren(el("p", "prf-note", "No preferences match “" + ui.search.value + "”.")); return; }
    const body = page.c || pageBody(page.p);
    if (body.parentNode !== main) {
      main.setAttribute("aria-label", page.p.title);
      if (main.dataset.shown !== page.p.id) {
        main.dataset.shown = page.p.id; main.scrollTop = 0;
        if (fade) body.classList.add("prf-enter");
      }
      main.replaceChildren(body);
    }
    if (!page.titleMatch) {
      const matches = [...body.querySelectorAll("[data-search]")].filter(n => n.dataset.search.includes(q));
      for (const n of body.querySelectorAll("[data-search],.prf-group")) n.hidden = !matches.some(match => n.contains(match) || match.contains(n));
    }
  }
  function selectPage(page) {
    const parent = Object.hasOwn(parents, page) ? parents[page] : page;
    if (catalog().some(p => p.id === parent)) current = parent;
  }
  function focusSection(page) {
    if (!Object.hasOwn(parents, page)) return false;
    const section = ui.main.querySelector('[data-prf-section="' + page + '"]');
    if (!section) return false;
    (section.querySelector("select:not([disabled]), input:not([disabled]):not([type=hidden]), button:not([disabled])") || section).focus();
    return true;
  }
  function open(page) {
    if (!doc?.body) return null;
    if (!dialog) build();
    loadWindowControls();
    const request = ++opening; pendingPage = page;
    if (page) { ui.search.value = ""; selectPage(page); }
    render(); status("");
    if (!dialog.open) {
      const from = doc.activeElement;
      ui.opener = from?.closest(".work-menu")?.querySelector("summary") || from;
      dialog.show();
    }
    const pagePicker = ui.jump.getClientRects?.()?.length ? ui.jump : ui.list.querySelector('[aria-current="page"]');
    const focusedSection = focusSection(page);
    if (!focusedSection) (page ? pagePicker : ui.search)?.focus();
    const waitingForSection = !focusedSection && Object.hasOwn(parents,page);
    const initialFocus = doc.activeElement;
    const modules = ["AtriumCanvasGPUPref", "AtriumExtensionDev", "AtriumCollabPresence", "AtriumCamera",
      "AtriumChecks", "AtriumInsightsUI", "AtriumExternalTools", "AtriumClipHistory", "AtriumHistoryPanel", "AtriumRouteSuggest"];
    if (page === "search" && globalThis.AtriumLabs?.notebookEnabled()) modules.push("AtriumPalettePersonal");
    const missing = modules.filter(name => !globalThis[name]);
    if (missing.length && globalThis.AtriumLazy) Promise.allSettled(missing.map(name => globalThis.AtriumLazy.need(name))).then(() => {
      if (!dialog.open || request !== opening) return;
      const requested = pendingPage;
      const restoreSectionFocus = requested && waitingForSection && doc.activeElement === initialFocus;
      if (requested) selectPage(requested);
      pendingPage = null;
      render(true);
      if (restoreSectionFocus) focusSection(requested);
    });
    return dialog;
  }
  function close() {
    if (!dialog?.open) return;
    const restore = dialog.contains(doc.activeElement), from = ui.opener;
    dialog.close();
    if (restore) (from?.isConnected && from !== doc.body && from.getClientRects?.()?.length ? from : host()?.canvas?.())?.focus({preventScroll:true});
  }

  // ------------------------------------------------------------------ start page
  function openStartPage(o = {}) {
    return globalThis.AtriumLazy.need("AtriumStartPage").then(S => o.launch ? S.launch() : S.open(o)).catch(e => host()?.info?.(e.message));
  }
  // File › New from Template…: the start page on its templates.
  function newProject() { openStartPage({focus: "templates"}); return true; }

  if (globalThis.AtriumLabs?.preview !== false) registerPage({id: "labs", title: "Experimental features", order:95,
    keywords:"labs experimental preview notebook rich text math widgets images review notes palette touch pen", render(c) {
      const g = group(c, "Butter");
      row(g, "labs.notebook", "Enable notebook features", "Try notebooks, the new palettes and touch or pen tools.");
    }});

  // ------------------------------------------------------------------ boot
  const api = {get, set, on, reset, changed, row, group, links, el, button, act};
  load();
  globalThis.AtriumLabs?.bind(api);
  function syncDropPreference() {
    const enabled=get("butter.drop")===true;
    globalThis.AtriumHost?.butterDropEnabled?.(enabled);
    if (enabled) globalThis.AtriumLazy?.need("AtriumDropEditor").catch(error=>globalThis.console?.warn?.(error));
  }
  on("butter.drop",syncDropPreference);
  syncDropPreference();
  const bootButter = () => globalThis.AtriumLazy?.need("AtriumButterEditor").catch(error => globalThis.console?.warn?.(error));
  on("butter.", ({value}) => {if (value === true) bootButter();});
  if ([...Object.keys(values), ...GRADUATED.map(feature => "butter." + feature)].some(key => key.startsWith("butter.") && get(key) === true)) bootButter();
  try { const L = globalThis.AtriumLazy; L.register("AtriumVSCode", {scripts: ["editor/vscode-theme.js"]}); L.register("AtriumPrefsStorage", {scripts: ["editor/prefs-storage.js"]}); L.need("AtriumPrefsStorage").catch(() => {}); } catch {}
  if (doc) {
    const ready = () => {
      const h = host();
      for (const k of ["pcb.rerouteOnDrag", "pcb.smartGuides", "pcb.hud", "pcb.designatorsFollow", "pcb.trackWidth", "pcb.showRatsnest"]) if (k in values) apply(k, values[k]);
      for (const k of Object.keys(SNAP)) if (k in values && globalThis.AtriumPCBEdit?.snapPrefs?.[SNAP[k]] !== values[k]) apply(k, values[k]);
      const K = globalThis.AtriumKeymap;
      const add = (id, title, run, defaultKeys) => {
        if (id === "preferences") h?.registerAction?.("preferences-page", run);
        else h?.registerAction?.(id, run);
        try { if (!K?.command?.(id)) K?.registerCommand?.({id, title, run, defaultKeys, category: "File"}); } catch {}
      };
      add("preferences", "Preferences…", () => open(), ["Mod+,", "T P"]);
      add("start-page", "Start Page", () => openStartPage());
      add("new-from-template", "New project from template…", newProject);
      add("import-vscode-theme", "Import VS Code theme…", () => vscode("themeDialog"));
      add("import-vscode-keybindings", "Import VS Code keybindings…", () => vscode("keysDialog"));
      add("export-settings", "Export settings…", exportAll);
      add("import-settings", "Import settings…", () => { importAll(); });
      globalThis.AtriumNavCommon?.menuItem("file", "new-from-template", "New from Template…", {after: "new"});
      globalThis.AtriumAutosave?.launchHome?.(() => openStartPage({launch:true}));
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", ready, {once: true}); else ready();
  }
  return Object.freeze({STORE, FORMAT, VERSION, DEFAULTS, READERS, GUARDED, GRADUATED, get, set, on, reset, changed, exportJSON, importJSON, sheetDefaults, registerPage,
    junctions, exportSettings, importSettings, scrub, extend,
    pages: () => catalog().map(p => ({id: p.id, title: p.title})), open, close, openStartPage, newProject,
    // Tests: reload from storage.
    reload: load});
})();

globalThis.AtriumExternalTools?.prefsPage?.(AtriumPrefs);
