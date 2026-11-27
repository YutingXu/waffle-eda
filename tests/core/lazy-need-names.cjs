"use strict";
// Every literal name the app passes to AtriumLazy.need() can load. need() loads a registered
// module; for any other name lazy.js load() resolves only when the global already exists and
// otherwise rejects "<name> is not available in this build." So a name must be one of:
//   - a module registered at startup (lazy.js, an inline index.html script or an eager script);
//   - a global an eager <script src> defines;
//   - registered or defined by the calling file itself, or by a file of the calling file's
//     module or its dependencies (a lazy file runs only after those);
//   - listed in SAFE below, with the reason it exists whenever that call runs.
// Runs under Node and under JavaScriptCore (scripts/test-jsc.sh lazy-need-names).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {inventoryFrom} = require("../support/app-source-paths.cjs");
const app = path.join(__dirname, "../../app");
const read = f => String(fs.readFileSync(path.join(app, f), "utf8"));

require("../../app/lazy.js");
const L = globalThis.AtriumLazy;
const html = read("index.html").replace(/<!--[\s\S]*?-->/g, "");
const eager = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g)].map(m => m[1]);
const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
// Run the inline scripts against an inert document so their registrations are real.
const inert = new Proxy(function () {}, {get: () => inert, apply: () => undefined});
for (const body of inline) Function("document", "localStorage", "setTimeout", body)(inert, inert, () => 0);

const registered = name => { try { L.files([name]); return true; } catch { return false; } };
const REGISTERS = /\bregister\??\.?\(\s*"([A-Za-z_$][\w$]*)"\s*,\s*\{\s*scripts\s*:/g;
const registers = source => new Set([...source.matchAll(REGISTERS)].map(m => m[1]));
function defines(source) {
  // globalThis.X = …, or the same through a local alias (const G = globalThis).
  const aliases = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*globalThis\s*[,;]/g)].map(m => m[1].replace(/[$]/g, "\\$&"));
  const receiver = ["globalThis", "window", "self", ...aliases].join("|");
  return new Set([...source.matchAll(new RegExp("\\b(?:" + receiver + ")\\.([A-Za-z_$][\\w$]*)\\s*(?:=(?!=)|\\?\\?=|\\|\\|=)", "g"))].map(m => m[1]));
}
const eagerNames = new Set(eager.flatMap(f => { const s = read(f); return [...registers(s), ...defines(s)]; }));

// The calls: X.need("A"), X.need?.(["A", "B"]), appendOnLoad() and prefetch() (both load through need()),
// and local wrappers of need() such as const need = name => G[name] || G.AtriumLazy.need(name).
const literals = text => [...text.matchAll(/"([A-Z][\w$]*)"/g)].map(m => m[1]);
function calls(source) {
  const found = [], at = i => source.slice(0, i).split("\n").length;
  for (const m of source.matchAll(/\.(?:need|appendOnLoad|prefetch)\??\.?\(\s*(\[[^\]]*\]|"[^"]*")/g)) for (const n of literals(m[1])) found.push([n, at(m.index)]);
  for (const w of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?\s*[A-Za-z_$][\w$]*[^=\n]*=>[^\n]*AtriumLazy\??\.need\b/g)) {
    const call = new RegExp("(?<![.\\w$])" + w[1].replace(/[$]/g, "\\$&") + "\\(\\s*(\\[[^\\]]*\\]|\"[^\"]*\")", "g");
    for (const m of source.matchAll(call)) for (const n of literals(m[1])) found.push([n, at(m.index)]);
  }
  return found;
}

// Names that resolve for a reason this check cannot see. Key: "caller file|name".
const SAFE = {
  // collab-presence.js registers the pairing engine itself, in a loop at load.
  "project/collab-presence.js|AtriumCollabPair": "registered by this file at load",
  // modules() first awaits AtriumOutputJobs, whose output-jobs.js registers AtriumReleaseUI.
  "project/revisions-ui.js|AtriumReleaseUI": "registered by output-jobs.js, awaited first",
  // "Move to New Window" is listed only once AtriumProjectWindowClient exists, and its file registers AtriumWindowsUI.
  "editor/context-menu.js|AtriumWindowsUI": "registered by project-window-client.js, which the menu requires",
  // prefs.js registers AtriumVSCode; index.html requests AtriumPrefs at DOMContentLoaded, before the
  // theme picker or the extension manager (both opened by the user) can run.
  "editor/theme-library.js|AtriumVSCode": "registered by prefs.js, loaded at startup",
  "extension-host/extensions.js|AtriumVSCode": "registered by prefs.js, loaded at startup",
};

const files = [...inventoryFrom().values()].filter(f => /\.js$/.test(f) && !f.startsWith("vendor/")).sort();
// A lazy file runs only as part of a module, so the files every module that loads it shares
// have run by then.
const closures = L.modules().map(n => L.files([n]));
const loadedWith = file => {
  const sets = closures.filter(c => c.includes(file));
  return sets.length ? sets.reduce((a, b) => a.filter(f => b.includes(f))) : [];
};
const cache = new Map(), source = f => { if (!cache.has(f)) cache.set(f, read(f)); return cache.get(f); };
const provides = (f, name) => registers(source(f)).has(name) || defines(source(f)).has(name);
const problems = [], used = new Set();
for (const file of ["index.html", ...files]) {
  for (const [name, line] of calls(source(file))) {
    if (registered(name) || eagerNames.has(name) || provides(file, name)) continue;
    if (file !== "index.html" && loadedWith(file).some(f => provides(f, name))) continue;
    if (SAFE[file + "|" + name]) { used.add(file + "|" + name); continue; }
    problems.push(file + ":" + line + " needs " + name + ", which is neither a registered module nor a global defined before that call");
  }
}
assert.deepEqual(problems, [], "\n" + problems.join("\n") + "\nAsk for the registered module whose files define the global, or register it.");
assert.deepEqual(Object.keys(SAFE).filter(k => !used.has(k)), [], "stale SAFE entries");
console.log("lazy need() names: every literal module name resolves OK");
