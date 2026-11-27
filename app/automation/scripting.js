"use strict";
// Scripting: an Altium-style console in the editor, and the same script text run
// headlessly (JavaScriptCore or Node) for MCP.
//
// A script is the body of an async function. It receives `api` (AtriumAPI v1),
// `console` and `args`, may `await`, and its `return` value is the result.
//
//   const parts = await api.items.list({kind: "part", fields: ["id", "ref", "x"]});
//   await api.transaction("Nudge", tx => parts.forEach(p => tx.move(p.id, 1, 0)));
//   return parts.length;
//
// In the editor the script runs in a worker; adjacent transactions from that run share an undo
// step. Headless, it runs on a private copy of the project and returns that copy.
globalThis.AtriumScripting = (() => {
  const doc = globalThis.document?.createElement ? globalThis.document : null;

  // ------------------------------------------------------------- headless
  // Names hidden from headless scripts. This is scope hygiene, not a security
  // boundary: in one JS realm code can still reach the global object (for example
  // through a function constructor). Isolation needs the worker or a separate
  // JSContext/process with a time limit, which the MCP runner provides.
  const HIDDEN = ["globalThis", "self", "window", "global", "document", "require", "process", "Buffer", "module", "exports",
    "load", "loadString", "readFile", "read", "readline", "run", "runString", "print", "printErr", "quit", "debug", "gc", "drainMicrotasks",
    "fetch", "XMLHttpRequest", "WebSocket", "importScripts", "Worker", "localStorage", "sessionStorage", "indexedDB", "$262", "setTimeout", "setInterval"];
  function hiddenNames() {
    const names = new Set(HIDDEN);
    for (const k of Object.getOwnPropertyNames(globalThis)) if (/^Atrium/.test(k)) names.add(k);
    for (const k of ["api", "console", "args"]) names.delete(k);
    return [...names].filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
  }
  function format(args, deadline) {
    return args.map(a => {
      if (typeof a === "string" || typeof a === "bigint") return String(a);
      if (a instanceof Error) return a.message;
      // A log line keeps 4000 characters, so a value too large to write is shown by its type.
      try { const s = JSON.stringify(globalThis.AtriumAPI?.toPlain ? AtriumAPI.toPlain(a, true, {values: 1e6, text: 4e6, deadline}) : a); return s === undefined ? String(a) : s; } catch { return String(a); }
    }).join(" ").slice(0, 4000);
  }
  /**
   * runHeadless(project, code, {timeoutMs, documentId, selection, args, write, storage})
   * → Promise<{ok, project, log, result, error, transactions, steps, ms}>
   * `project` may be an object or JSON text; it is never modified. The returned
   * project is the edited copy (identical to the input when nothing changed).
   */
  function runHeadless(project, code, options = {}) {
    // Never evaluate script text in the editor's realm: there, scripts run in the sandbox worker.
    if (globalThis.document && globalThis.window === globalThis) return Promise.reject(Error("runHeadless is for headless hosts. In the editor, scripts run in the sandboxed worker (AtriumExtensions.runScript)."));
    const started = Date.now(), timeoutMs = Math.max(1, options.timeoutMs ?? 5000), log = [];
    const push = (level, args) => { if (log.length < 2000) log.push({level, text: format(args, started + timeoutMs)}); };
    const out = extra => ({ms: Date.now() - started, log, ...extra});
    let h;
    try {
      const copy = typeof project === "string" ? JSON.parse(project) : JSON.parse(JSON.stringify(project));
      h = AtriumAPI.headless(copy, {documentId: options.documentId, selection: options.selection, deadline: started + timeoutMs,
        extension: {id: "script", permissions: {"read:project": true, ...(options.write === false ? {} : {"write:edits": true}), ...(options.propose ? {"propose:edits": true} : {})}},
        storage: new Map(Object.entries(options.storage || {})), log: push, info: text => push("status", [text])});
    } catch (e) {
      return Promise.resolve(out({ok: false, project: null, result: null, error: {message: e.message}, transactions: 0, steps: []}));
    }
    const consoleObject = Object.freeze({log: (...a) => push("info", a), info: (...a) => push("info", a), debug: (...a) => push("debug", a),
      warn: (...a) => push("warn", a), error: (...a) => push("error", a)});
    const hidden = hiddenNames();
    let running;
    try {
      const fn = new Function("api", "console", "args", ...hidden, '"use strict";\nreturn (async () => {\n' + String(code) + "\n})();");
      running = fn(h.api, consoleObject, options.args ?? null, ...hidden.map(() => undefined));
    } catch (e) { running = Promise.reject(e); }
    const failed = e => out({ok: false, project: h.project, result: null, error: {message: String(e?.message || e), line: lineOf(e)}, transactions: h.steps.length, steps: h.steps});
    return Promise.resolve(running).then(value => {
      if (Date.now() - started > timeoutMs) throw Error("The script exceeded its " + timeoutMs + " ms time limit.");
      // Preparing the result counts toward the time limit and is bounded in size.
      let result;
      try { result = AtriumAPI.toPlain(value, true, {values: 5e6, text: 1e8, deadline: started + timeoutMs, late: "The script exceeded its " + timeoutMs + " ms time limit while preparing its result."}) ?? null; }
      catch (e) { return failed({message: e.message}); }
      return out({ok: true, project: h.project, result, error: null, transactions: h.steps.length, steps: h.steps});
    }, failed);
  }
  // Script line of an error, when the engine reports one (the wrapper adds 2 lines).
  function lineOf(e) {
    const m = String(e?.stack || "").match(/(?:<anonymous>|eval|Function)[^\n]*?:(\d+):\d+/);
    return m ? Math.max(1, Number(m[1]) - 2) : null;
  }

  // Two-phase entry for the JavaScriptCore C API. JSC drains the microtask queue
  // when the outermost API call returns, so `start` then `take` settles any script
  // that does not wait on a timer. Both use strings so the caller never holds JS objects.
  //   handle = headlessStart('{"code":"…","timeoutMs":5000,"documentId":null}', projectText)
  //   json   = headlessTake(handle)  →  {"done":true,"ok":…,"project":…,"log":[…],"result":…}
  // headlessProject is the raw take for the MCP adapter. A render function passed to
  // headlessStart receives the settled value at the one collection, so a large project
  // is not serialized and parsed again.
  const jobs = new Map();
  let nextJob = 0;
  function headlessStart(requestText, projectText, render) {
    const request = JSON.parse(requestText), id = ++nextJob, job = {done: false, value: null, render};
    jobs.set(id, job);
    runHeadless(projectText ?? request.project, request.code, request).then(v => { job.done = true; job.value = v; },
      e => { job.done = true; job.value = {ok: false, error: {message: String(e?.message || e)}, log: []}; });
    return id;
  }
  function takeJob(id) {
    const job = jobs.get(Number(id));
    if (!job) return null;
    if (!job.done) return {pending: Number(id)};
    jobs.delete(Number(id));
    return job;
  }
  function headlessTake(id, {includeProject = true} = {}) {
    const job = takeJob(id);
    if (!job) return JSON.stringify({done: true, ok: false, error: {message: "Unknown or collected script job."}});
    if (job.pending != null) return JSON.stringify({done: false});
    const v = job.value;
    if (!includeProject) delete v.project;
    return JSON.stringify({done: true, ...v});
  }
  function headlessProject(id) {
    const job = takeJob(id);
    if (!job || job.pending != null) return job;
    return typeof job.render === "function" ? job.render(job.value) : job.value;
  }

  // ----------------------------------------------------------------- snippets
  const SNIPPETS = [
    {name: "Count objects by kind", code: `const items = await api.items.list({fields: ["kind"]});
const counts = {};
for (const i of items) counts[i.kind] = (counts[i.kind] || 0) + 1;
return counts;`},
    {name: "List the selection", code: `const items = await api.selection.items({fields: ["id", "kind", "ref", "net", "x", "y"]});
console.log(items.length + " selected");
return items;`},
    {name: "Move the selection 1 mm right", code: `const ids = await api.selection.get();
if (!ids.length) return "Select something first.";
await api.transaction("Move selection", tx => ids.forEach(id => tx.move(id, 1, 0)));
return ids.length + " moved";`},
    {name: "Renumber selected parts left to right", code: `const parts = (await api.selection.items({fields: ["id", "ref", "x", "y"]})).filter(p => p.ref);
const groups = {};
for (const p of parts) (groups[p.ref.replace(/\\d+.*$/, "")] ||= []).push(p);
await api.transaction("Renumber left to right", tx => {
  for (const [prefix, list] of Object.entries(groups)) {
    list.sort((a, b) => a.x - b.x || a.y - b.y).forEach((p, n) => tx.update(p.id, {ref: prefix + (n + 1)}));
  }
});
return parts.length + " renumbered";`},
    {name: "Track length per net", code: `const unit = await api.units.get();
const tracks = await api.items.list({kind: "track", fields: ["net", "points"]});
const total = {};
for (const t of tracks) total[t.net || "(no net)"] = (total[t.net || "(no net)"] || 0) + api.geometry.length(t.points);
return Object.entries(total).sort((a, b) => b[1] - a[1]).slice(0, 20)
  .map(([net, mm]) => ({net, length: api.units.format(mm, unit, 2)}));`},
    {name: "Via grid in a box", code: `// Places vias on a grid inside [x0, y0, x1, y1], skipping occupied spots.
const [x0, y0, x1, y1] = [0, 0, 10, 10], pitch = 2.5, net = "GND";
const added = await api.transaction("Via grid", async tx => {
  let n = 0;
  for (let x = x0; x <= x1; x += pitch) for (let y = y0; y <= y1; y += pitch) {
    const busy = await api.query.spatial([x - .5, y - .5, x + .5, y + .5], {fields: ["id"]});
    if (!busy.length) { tx.add({kind: "via", x, y, diameter: .6, drill: .3, layer: "Multi", net}); n++; }
  }
  return n;
});
return added;`},
    {name: "Design rule check summary", code: `if (!(await api.features()).includes("drc")) return "DRC is unavailable in this build.";
const r = await api.drc({limit: 200});
const by = {};
for (const v of r.violations || []) by[v.type] = (by[v.type] || 0) + 1;
return {violations: (r.violations || []).length, byType: by};`},
    {name: "Export a component list (CSV)", code: `const parts = await api.items.list({kind: "part", fields: ["ref", "value", "x", "y", "angle"]});
const csv = ["Designator,Value,X (mm),Y (mm),Rotation", ...parts.map(p => [p.ref, p.value, p.x, p.y, p.angle || 0].join(","))].join("\\n");
await api.files.export("components.csv", csv);
return parts.length + " rows";`}
  ];

  // ------------------------------------------------------------------- console
  const DRAFT = "atrium.script.draft", HISTORY = "atrium.script.history", SAVED = "atrium.scripts.v1", HEIGHT = "atrium.script.height";
  const ls = {
    get(k, f) { try { const v = globalThis.localStorage?.getItem(k); return v == null ? f : JSON.parse(v); } catch { return f; } },
    set(k, v) { try { globalThis.localStorage?.setItem(k, JSON.stringify(v)); } catch {} }
  };
  let panel = null, running = false;
  function el(tag, text, cls) { return AtriumNavCommon.elementIn(doc, tag, text, cls); }
  function button(text, fn, cls, title) { const b = el("button", text, cls); b.type = "button"; b.onclick = fn; if (title) { b.title = title; b.setAttribute("aria-label", title); } return b; }
  const mac = () => /Mac|iPhone|iPad/i.test(globalThis.navigator?.platform || "");

  function build() {
    const root = el("section", null, "script-console");
    root.id = "script-console"; root.setAttribute("aria-label", "Scripting console"); root.hidden = true;
    const sash = el("div", null, "script-sash"); sash.setAttribute("role", "separator"); sash.setAttribute("aria-label", "Resize scripting console"); sash.tabIndex = 0;
    const bar = el("header", null, "script-bar ui-toolbar");
    bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Script controls");
    const title = el("h2", "Scripting Console");
    const runB = button("Run", () => runCurrent(), "script-run ui-button", "Run script");
    AtriumNavCommon.shortcutTitle(runB, "Run script", "Mod+Enter");
    runB.dataset.variant = "primary";
    const stopB = button("Stop", () => { globalThis.AtriumExtensions?.stopScripts(); }, "script-stop ui-button", "Stop the running script");
    stopB.disabled = true;
    const snippets = el("select", null, "ui-field"); snippets.setAttribute("aria-label", "Insert snippet");
    snippets.add(new Option("Snippets…", ""));
    SNIPPETS.forEach((s, i) => snippets.add(new Option(s.name, String(i))));
    snippets.onchange = () => { const s = SNIPPETS[Number(snippets.value)]; snippets.value = ""; if (s) setCode(s.code, true); };
    const scripts = el("select", null, "ui-field"); scripts.setAttribute("aria-label", "Saved scripts");
    scripts.onchange = () => { const v = scripts.value; scripts.value = ""; openSaved(v); };
    const saveB = button("Save…", () => saveDialog(), "ui-button", "Save this script");
    const timeout = el("input"); timeout.type = "number"; timeout.min = "1"; timeout.max = "600"; timeout.value = String(ls.get("atrium.script.timeout", 5));
    timeout.className = "script-timeout ui-field"; timeout.title = "Time limit in seconds"; timeout.setAttribute("aria-label", "Time limit in seconds");
    timeout.onchange = () => ls.set("atrium.script.timeout", Math.max(1, Math.min(600, Number(timeout.value) || 5)));
    const clearB = button("Clear", () => output.replaceChildren(), "ui-button", "Clear output");
    const closeB = button("×", () => toggle(false), "ui-close script-close", "Close scripting console");
    const spacer = el("span", null, "ui-toolbar-spacer script-spacer");
    const tl = el("label", null, "script-timeout-label"); tl.append(el("span", "Limit (s)"), timeout);
    const execution = el("div", null, "script-tools");
    execution.append(runB, stopB);
    const files = el("div", null, "script-tools script-files");
    files.append(snippets, scripts, saveB);
    const outputTools = el("div", null, "script-tools");
    outputTools.append(tl, clearB);
    bar.append(title, execution, files, spacer, outputTools, closeB);

    const body = el("div", null, "script-body");
    const editor = el("div", null, "script-editor"), gutter = el("div", null, "script-gutter"), area = el("textarea");
    gutter.setAttribute("aria-hidden", "true");
    area.spellcheck = false; area.autocapitalize = "off"; area.autocomplete = "off"; area.wrap = "off";
    area.setAttribute("aria-label", "Script"); area.placeholder = "// await api.items.list({kind: \"part\"})";
    editor.append(gutter, area);
    const output = el("div", null, "script-output"); output.setAttribute("role", "log"); output.setAttribute("aria-label", "Script output"); output.setAttribute("aria-live", "polite");
    body.append(editor, output);
    root.append(sash, bar, body);
    (doc.getElementById("editor-area") || doc.body).append(root);
    root.style.height = Math.max(160, Math.min(900, ls.get(HEIGHT, 280))) + "px";

    let lines = 0;
    function gutterSync() {
      const n = area.value.split("\n").length;
      if (n !== lines) { lines = n; let s = ""; for (let i = 1; i <= n; i++) s += i + "\n"; gutter.textContent = s; }
      gutter.scrollTop = area.scrollTop;
    }
    let draftTimer = 0;
    area.addEventListener("input", () => { gutterSync(); clearTimeout(draftTimer); draftTimer = setTimeout(() => ls.set(DRAFT, area.value), 400); });
    area.addEventListener("scroll", () => { gutter.scrollTop = area.scrollTop; });
    area.addEventListener("keydown", e => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); runCurrent(); return; }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); saveDialog(); return; }
      if (e.key === "Tab") { e.preventDefault(); e.stopPropagation(); indent(e.shiftKey); return; }
      if (e.key === "Enter" && !mod && !e.altKey) {
        const start = area.selectionStart, lineStart = area.value.lastIndexOf("\n", start - 1) + 1;
        const lead = area.value.slice(lineStart, start).match(/^\s*/)[0], extra = /[{[(]\s*$/.test(area.value.slice(lineStart, start)) ? "  " : "";
        e.preventDefault(); insert("\n" + lead + extra);
      }
      e.stopPropagation();
    });
    function insert(text) {
      const s = area.selectionStart, end = area.selectionEnd;
      area.setRangeText(text, s, end, "end"); area.dispatchEvent(new Event("input"));
    }
    function indent(out) {
      const v = area.value, s = area.selectionStart, e = area.selectionEnd;
      if (s === e && !out) { insert("  "); return; }
      const a = v.lastIndexOf("\n", s - 1) + 1, b = e > s && v[e - 1] === "\n" ? e - 1 : e;
      const block = v.slice(a, b), next = block.split("\n").map(l => out ? l.replace(/^ {1,2}/, "") : "  " + l).join("\n");
      area.setRangeText(next, a, b, "select"); area.dispatchEvent(new Event("input"));
    }
    // Drag the top edge to resize.
    sash.addEventListener("pointerdown", e => {
      e.preventDefault(); sash.setPointerCapture?.(e.pointerId);
      const y0 = e.clientY, h0 = root.offsetHeight;
      const move = ev => { root.style.height = Math.max(140, Math.min(globalThis.innerHeight * .85, h0 + y0 - ev.clientY)) + "px"; };
      const up = () => { sash.removeEventListener("pointermove", move); sash.removeEventListener("pointerup", up); ls.set(HEIGHT, root.offsetHeight); };
      sash.addEventListener("pointermove", move); sash.addEventListener("pointerup", up);
    });
    sash.addEventListener("keydown", e => {
      const step = e.key === "ArrowUp" ? 20 : e.key === "ArrowDown" ? -20 : 0;
      if (step) { e.preventDefault(); root.style.height = Math.max(140, root.offsetHeight + step) + "px"; ls.set(HEIGHT, root.offsetHeight); }
    });
    function setCode(code, append) {
      area.value = append && area.value.trim() ? area.value.replace(/\s*$/, "\n\n") + code : code;
      area.dispatchEvent(new Event("input")); area.focus();
    }
    function write(level, text) {
      const line = el("div", null, "script-line is-" + level);
      line.textContent = text;
      output.append(line);
      while (output.childElementCount > 1000) output.firstChild.remove();
      output.scrollTop = output.scrollHeight;
      return line;
    }
    function savedList() {
      const p = globalThis.AtriumExtensions?.attached ? hostProject()?.scripts : null;
      return {user: ls.get(SAVED, []), project: Array.isArray(p) ? p.filter(s => s && typeof s.name === "string" && typeof s.code === "string") : []};
    }
    function fillScripts() {
      const {user, project} = savedList(), history = ls.get(HISTORY, []);
      scripts.replaceChildren(new Option("Scripts…", ""));
      const group = (label, rows, prefix) => { if (!rows.length) return; const g = el("optgroup"); g.label = label; rows.forEach((s, i) => g.append(new Option(s.name, prefix + i))); scripts.append(g); };
      group("This project", project, "p:"); group("My scripts", user, "u:");
      group("History", history.map((code, i) => ({name: code.split("\n").find(l => l.trim())?.trim().slice(0, 48) || "Script " + (i + 1)})), "h:");
    }
    function openSaved(key) {
      const [kind, n] = [key.slice(0, 1), Number(key.slice(2))], {user, project} = savedList();
      const s = kind === "p" ? project[n] : kind === "u" ? user[n] : kind === "h" ? {code: ls.get(HISTORY, [])[n]} : null;
      if (s?.code != null) setCode(s.code, false);
    }
    function saveDialog() {
      const d = el("dialog", null, "script-save"), form = el("form"), heading = el("h2", "Save script");
      const name = el("input", null, "ui-field"), where = el("select", null, "ui-field");
      const fields = el("div", null, "script-save-fields"), actions = el("div");
      form.method = "dialog"; name.value = "Untitled script"; name.setAttribute("aria-label", "Script name");
      where.add(new Option("My scripts (this computer)", "user")); where.add(new Option("This project (saved in the .waffle file)", "project"));
      where.setAttribute("aria-label", "Save location");
      const ok = button("Save", null); ok.type = "submit"; ok.dataset.variant = "primary";
      actions.append(button("Cancel", () => d.close()), ok);
      fields.append(name, where);
      form.append(heading, fields, actions); d.append(form);
      AtriumShell.adoptDialog(d, {title:heading, body:fields, actions, initialFocus:name});
      doc.body.append(d);
      form.onsubmit = ev => {
        ev.preventDefault();
        const entry = {name: name.value.trim() || "Untitled script", code: area.value};
        try {
          if (where.value === "user") { ls.set(SAVED, ls.get(SAVED, []).filter(s => s.name !== entry.name).concat([entry])); }
          else editProject(p => { p.scripts = (Array.isArray(p.scripts) ? p.scripts : []).filter(s => s?.name !== entry.name).concat([entry]); });
          write("info", "Saved “" + entry.name + "”" + (where.value === "project" ? " in the project." : "."));
        } catch (e) { write("error", e.message); }
        d.close(); fillScripts();
      };
      d.addEventListener("close", () => d.remove(), {once: true});
      d.showModal(); name.select();
    }
    async function runCurrent() {
      if (running) return;
      const code = area.value;
      if (!code.trim()) return;
      const ext = globalThis.AtriumExtensions;
      if (!ext?.attached) { write("error", "The scripting host is not connected to the editor."); return; }
      const history = ls.get(HISTORY, []).filter(c => c !== code); history.unshift(code); ls.set(HISTORY, history.slice(0, 30)); fillScripts();
      running = true; runB.disabled = true; runB.textContent = "Running…"; stopB.disabled = false;
      write("input", "› Run · " + code.split("\n").length + " line" + (code.split("\n").length === 1 ? "" : "s"));
      const r = await ext.runScript(code, {timeoutMs: (Number(timeout.value) || 5) * 1000, onLog: (level, text) => write(level === "error" ? "error" : level === "warn" ? "warn" : "info", text)});
      running = false; runB.disabled = false; runB.textContent = "Run"; stopB.disabled = true;
      const meta = " · " + r.ms + " ms" + (r.transactions ? " · " + r.transactions + " transaction" + (r.transactions === 1 ? "" : "s") + " (" + (r.undoSteps === 1 ? "one undo step" : r.undoSteps + " undo steps") + ")" : "") + (r.isolated ? "" : " · not isolated");
      if (r.ok) {
        let text;
        if (r.value === undefined || r.value === null) text = "Done";
        else if (typeof r.value === "string") text = r.value;
        else { try { text = JSON.stringify(globalThis.AtriumAPI?.toPlain ? AtriumAPI.toPlain(r.value, true) : r.value, null, 2); } catch { text = String(r.value); } }
        if (text.length > 20000) text = text.slice(0, 20000) + "\n… (truncated)";
        write("result", text).append(el("small", meta));
      } else write("error", (r.error?.message || "Script failed") + meta);
    }
    const draft = ls.get(DRAFT, null);
    area.value = draft ?? SNIPPETS[0].code;
    gutterSync(); fillScripts();
    return {root, area, write, fillScripts, run: runCurrent, setCode};
  }
  function hostProject() {
    // The extension host owns the editor binding; ask it through the API.
    return globalThis.AtriumScripting._project?.() ?? null;
  }
  function editProject(fn) {
    const edit = globalThis.AtriumScripting._edit;
    if (!edit) throw Error("Saving into the project needs the editor.");
    edit(fn);
  }
  function toggle(force) {
    if (!doc) return false;
    panel ??= build();
    const open = typeof force === "boolean" ? force : panel.root.hidden;
    panel.root.hidden = !open;
    doc.body.classList.toggle("script-console-open", open);
    for (const n of doc.querySelectorAll('[data-action="scripting-console"]')) n.setAttribute("aria-pressed", String(open));
    if (open) { panel.fillScripts(); panel.area.focus(); }
    return open;
  }
  // The editor (or a test page) connects saving-to-project here.
  function bind({project, edit} = {}) { api._project = project; api._edit = edit; }

  const api = {runHeadless, headlessStart, headlessTake, headlessProject, snippets: () => SNIPPETS.map(s => ({...s})), toggle, open: () => toggle(true), close: () => toggle(false),
    run: code => { toggle(true); panel.setCode(code, false); return panel.run(); }, bind, hiddenNames, _project: null, _edit: null};
  return api;
})();
