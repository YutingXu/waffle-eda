"use strict";
// AtriumExtensionDev: tools for extension authors (lazy; registered in app/lazy.js).
//
//   Preferences › Extension Development   developer mode (off by default) and New Extension…
//   New Extension…                         asks for an id and saves a scaffold .zip (manifest, main.js,
//                                          test.cjs, README.md) through the system save dialog
//   Load unpacked…                         developer mode only: pick a folder with the system folder
//                                          picker; its files go to AtriumExtensions.installDev()
//   Reload from folder                     re-reads the files the picker granted (or asks for the
//                                          folder again) and loads them as a new, re-pinned load
//   Console                                the extension's log, live, with its digest
//
// Security: this module adds no capability. Unpacked code runs exactly like an installed
// extension: its own worker in the sandboxed iframe (CSP default-src 'none'), per-call permission
// checks and the same prompts. installDev() (app/extensions.js) keeps the code in memory only,
// pins each load to sha256(canonical [manifest, files]) with grants keyed id@sha256, re-checks the
// digest at activation and refuses to run anything while developer mode is off. Files are read
// only from what the user picks in the folder picker; the scaffold is only offered as a download.
globalThis.AtriumExtensionDev = (() => {
  const PREF = "extensions.developerMode";
  const doc = globalThis.document?.createElement ? globalThis.document : null;
  const ID = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/i; // as validateManifest
  const sources = new Map(); // extension id -> the File list the folder picker granted
  const lazy = name => globalThis[name] ? Promise.resolve(globalThis[name]) : globalThis.AtriumLazy ? AtriumLazy.need(name) : Promise.reject(Error(name + " is not available."));
  const host = () => lazy("AtriumExtensions");
  // i18n (docs/translating.md): static text is extracted into "prefs" (the page is in Preferences);
  // the dialogs below share it. The stub keeps English where i18n.js is absent (tests).
  const AtriumI18n = globalThis.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s), scope() {}};
  AtriumI18n.scope(".ext-dev-dialog, .ext-dev-console", ["prefs"]);
  const t = AtriumI18n.define({
    "extdev.console_title": "Console · {name} {version}",
    "extdev.no_output": "No output yet. console.log in the extension appears here." // i18n-ignore
  });

  // ------------------------------------------------------------------ scaffold
  // id -> placeholder values. Mirrors names() in scripts/new-extension.py.
  function names(id) {
    if (typeof id !== "string" || !ID.test(id) || id.length > 80) throw Error("Use an id like yourname.my-extension: letters, digits, - and _, with dots between parts.");
    const parts = id.split("."), words = parts[parts.length - 1].split(/[-_]+/).filter(Boolean);
    let prefix = words[0].toLowerCase() + words.slice(1).map(w => w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase()).join("");
    if (/^\d/.test(prefix)) prefix = "x" + prefix;
    return {__ID__: id, __NAME__: words.map(w => w.slice(0, 1).toUpperCase() + w.slice(1)).join(" "), __PUBLISHER__: parts[0], __PREFIX__: prefix};
  }
  // The scaffold's files. `atrium` is the path from the new folder to a Waffle checkout (for test.cjs).
  function scaffoldFiles(id, atrium = "../Waffle") {
    const T = globalThis.AtriumExtensionTemplate;
    if (!T?.files) throw Error("The extension template is missing from this build.");
    const values = {...names(id), __WAFFLE__: atrium}, out = {};
    for (const [name, text] of Object.entries(T.files)) out[name] = Object.entries(values).reduce((s, [k, v]) => s.split(k).join(v), text);
    JSON.parse(out["waffle-extension.json"]);
    return {folder: id.split(".").pop(), files: out};
  }
  async function scaffold(id, o = {}) {
    if (id == null) id = await ask("New Extension", "Extension id (publisher.name)", "yourname.my-extension",
      "Waffle makes a folder with waffle-extension.json, main.js, a sandbox test and a README, and saves it as a .zip.");
    if (id == null) return null;
    const {folder, files} = scaffoldFiles(String(id).trim());
    const Z = await lazy("AtriumZip");
    const bytes = Z.create(Object.entries(files).map(([name, data]) => ({name: folder + "/" + name, data})));
    if (o.save !== false) {
      const save = globalThis.AtriumIO?.exportFile;
      if (!save) throw Error("Saving files is unavailable here.");
      await save(folder + ".zip", bytes);
    }
    return {name: folder + ".zip", bytes, files};
  }

  // ------------------------------------------------------------------ unpacked
  // Skip what an author's folder often holds but a package never needs.
  const skip = f => /(^|\/)(node_modules|\.[^/]*)(\/|$)/.test(String(f.webkitRelativePath || f.name).replace(/\\/g, "/"));
  function pickFolder() {
    if (!doc) return Promise.reject(Error("Choosing a folder needs the editor."));
    return new Promise(resolve => {
      const input = doc.createElement("input");
      input.type = "file"; input.multiple = true; input.hidden = true; input.setAttribute("webkitdirectory", "");
      doc.body.append(input);
      const done = v => { input.remove(); resolve(v); };
      input.addEventListener("change", () => done(input.files?.length ? [...input.files] : null), {once: true});
      input.addEventListener("cancel", () => done(null), {once: true});
      input.click();
    });
  }
  async function loadList(list, o = {}) {
    const X = await host();
    const files = await X.packageFromFiles(list.filter(f => !skip(f)));
    const e = await X.installDev(files);
    sources.set(e.id, list);
    o.onLoaded?.(e.id);
    return {id: e.id, hash: e.hash};
  }
  async function load(_, o = {}) {
    const X = await host();
    if (!X.developerMode) throw Error("Turn on developer mode in Preferences › Extension Development first.");
    const list = o.files || await pickFolder();
    return list ? loadList([...list], o) : null;
  }
  async function reload(id, o = {}) {
    const X = await host();
    if (!X.developerMode) throw Error("Developer mode is off.");
    let list = o.files || sources.get(id);
    if (list) {
      // The picker's File objects: some engines read the new contents, others refuse after a change.
      try { return await loadList([...list], o); }
      catch (err) { if (!/NotReadable|could not be read|changed/i.test(String(err?.name) + " " + err?.message)) throw err; }
    }
    list = await pickFolder();
    return list ? loadList(list, o) : null;
  }

  // ------------------------------------------------------------------ dialogs
  function el(tag, text, cls) { return AtriumNavCommon.elementIn(doc, tag, text, cls); }
  function devBadge() { const b = el("span", "Developer", "ui-badge ext-dev-badge"); b.dataset.tone = "warning"; return b; }
  function button(text, fn, cls) { const b = el("button", text, cls); b.type = "button"; b.onclick = fn; return b; }
  function ask(title, label, value, note) {
    if (!doc) return Promise.resolve(value);
    return new Promise(resolve => {
      const d = el("dialog", null, "ext-dev-dialog"), form = el("form"), input = el("input", null, "ui-field"), err = el("p", null, "ext-dev-error");
      const heading = el("h2", title), help = note ? el("p", note, "ext-dev-note") : null;
      input.value = value; input.spellcheck = false; input.setAttribute("aria-label", label);
      const l = el("label", null, "ext-dev-field"); l.append(el("span", label), input);
      const actions = el("div");
      let result = null;
      const ok = () => { try { names(input.value.trim()); result = input.value.trim(); d.close(); } catch (e) { err.textContent = e.message; input.focus(); } };
      const save = button("Save scaffold…", null); save.type = "submit"; save.dataset.variant = "primary";
      actions.append(button("Cancel", () => d.close()), save);
      form.onsubmit = ev => { ev.preventDefault(); ok(); };
      const body = [l, help, err].filter(Boolean);
      form.append(heading, ...body, actions);
      d.append(form);
      AtriumShell.adoptDialog(d, {title:heading, body, actions, initialFocus:input});
      doc.body.append(d);
      d.addEventListener("close", () => { d.remove(); resolve(result); });
      d.showModal(); input.select();
    });
  }
  const consoles = new Map();
  /** @param {string} id @param {{onOpen?: () => void}} [options] */
  async function openConsole(id, {onOpen} = {}) {
    const X = await host();
    const ext = () => X.list().find(e => e.id === id);
    if (!doc || !ext()) throw Error("Load the extension first.");
    if (consoles.has(id)) { onOpen?.(); consoles.get(id).focus(); return; }
    const d = el("dialog", null, "ext-dev-console"), head = el("header", null, "ext-dev-console-head"), title = el("h2"), meta = el("small", null, "ext-dev-mono");
    const out = el("pre", null, "ext-code ext-dev-log"), foot = el("div", null, "work-actions");
    d.setAttribute("aria-label", "Extension console");
    out.setAttribute("role", "log"); out.setAttribute("aria-live", "polite"); out.tabIndex = 0;
    let since = 0, shown = "";
    const paint = () => {
      const e = ext();
      if (!e) { meta.textContent = "Unloaded."; return; }
      title.replaceChildren(el("span", t("extdev.console_title", {name: e.name, version: e.version})), e.developer ? devBadge() : "");
      meta.textContent = e.status + (e.hash ? " · " + e.hash : "");
      const text = X.logs(id).filter(l => l.time >= since).map(l => new Date(l.time).toLocaleTimeString() + "  " + l.level.toUpperCase().padEnd(5) + " " + l.text).join("\n") || t("extdev.no_output");
      if (text !== shown) { const end = out.scrollTop + out.clientHeight >= out.scrollHeight - 4; out.textContent = shown = text; if (end) out.scrollTop = out.scrollHeight; }
    };
    foot.append(button("Reload from folder", () => reload(id).then(paint, err => { meta.textContent = err.message; }), "is-primary"),
      button("Clear", () => { since = Date.now(); paint(); }), button("Close", () => d.close()));
    head.append(title, meta);
    d.append(head, out, foot);
    AtriumShell.adoptDialog(d, {title, body:out, actions:foot, initialFocus:out, order:"provided"});
    doc.body.append(d);
    const timer = setInterval(paint, 500);
    d.addEventListener("close", () => { clearInterval(timer); consoles.delete(id); d.remove(); });
    consoles.set(id, {focus: () => out.focus()});
    paint(); d.show(); onOpen?.(); out.focus();
  }

  // ------------------------------------------------------------------ preferences
  async function setMode(on) {
    const P = await lazy("AtriumPrefs");
    P.set(PREF, !!on);
  }
  // Turning developer mode off unloads every unpacked extension at once.
  function unloadAll() {
    const X = globalThis.AtriumExtensions;
    if (!X?.unloadDev) return Promise.resolve();
    return Promise.all(X.list().filter(e => e.developer).map(e => X.unloadDev(e.id).catch(() => {})));
  }
  function prefsPage(P) {
    P.registerPage({id: "extension-dev", title: "Extension Development", order: 5.5, keywords: "developer mode extension unpacked folder reload console scaffold new extension sdk", render(c, api) {
      const g = api.group(c, "Developer mode");
      const row = api.el("div", "prf-row prf-check"); row.dataset.search = "developer mode unpacked load folder reload console";
      const box = api.el("input"); box.type = "checkbox"; box.id = "prf-ext-dev"; box.checked = P.get(PREF) === true;
      box.onchange = () => P.set(PREF, box.checked);
      const l = api.el("label"); l.htmlFor = box.id; l.append(box, api.el("span", null, "Developer mode: load unpacked extensions from a folder"));
      const help = api.el("small", "prf-help", "Load temporary extensions with the usual permission prompts.");
      help.title = "Unpacked extensions are sandboxed and removed when Waffle quits or Developer mode ends.";
      help.id = "prf-ext-dev-help"; box.setAttribute("aria-describedby", help.id);
      row.append(l, help); g.append(row);
      const tools = api.el("div", "prf-row prf-link"); tools.dataset.search = "new extension scaffold template zip extensions manager";
      const note = api.el("small", "prf-help", "Save a starter extension as a ZIP file.");
      tools.append(api.button("New Extension…", () => scaffold().catch(e => { note.textContent = e.message; }), "prf-button"),
        api.button("Extensions…", () => api.act("extensions"), "prf-button"), note);
      g.append(tools);
    }});
    P.on?.("extensions.", ({key, value}) => { if (key === PREF && value !== true) unloadAll(); });
  }
  if (globalThis.AtriumPrefs?.registerPage) prefsPage(AtriumPrefs);
  else if (doc) globalThis.AtriumLazy?.need?.("AtriumPrefs").then(prefsPage, () => {});

  return Object.freeze({PREF, names, scaffoldFiles, scaffold, load, reload, console: openConsole, setMode, unloadAll});
})();
