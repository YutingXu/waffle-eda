"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const source = fs.readFileSync(path.join(__dirname, "../../app/checks/diagnostics.js"), "utf8");
  const key = "atrium-diagnostics-v1", values = new Map(), handlers = new Map();
  const storage = {getItem: k => values.get(k), setItem: (k, v) => values.set(k, v)};
  const base = "file:///Users/example/Waffle.app/Contents/Resources/app/", script = base + "editor/editor.js";
  globalThis.addEventListener = (kind, fn) => handlers.set(kind, fn);
  Object.defineProperty(globalThis, "localStorage", {configurable: true, value: storage});
  globalThis.location = {href: base + "index.html"};
  globalThis.document = {scripts: [{src: script}]};
  const infos = [];
  globalThis.AtriumNavHost = {info: m => infos.push(String(m))};
  new Function(source)();
  new Function(fs.readFileSync(path.join(__dirname, "../../app/project/recover.js"), "utf8"))();
  const R = globalThis.AtriumRecover;
  handlers.get("error")({filename: script, lineno: 26, colno: 7, error: new TypeError("Project with secret IDs")});
  handlers.get("error")({filename: script, lineno: 26, colno: 7, error: new TypeError("Repeated")});
  handlers.get("unhandledrejection")({reason: {name: "RangeError", stack: "Rejected secret\nmethod@" + script + ":42:9"}});
  handlers.get("error")({filename: "file:///Users/example/project-secret.js", lineno: 8, error: {name: "SecretError"}});
  globalThis.AtriumDiagnostics.autosaveFailure("quota");
  let rows = await globalThis.AtriumDiagnostics.entries();
  assert.equal(rows.length, 4, "a repeated failure coalesces");
  if (typeof URL === "function") {
    const logged = R.format(rows);
    assert.match(logged, /TypeError · editor\.js:26:7/);
    assert.match(logged, /RangeError · editor\.js:42:9/);
  }
  if (typeof URL === "function") {
    assert.equal(infos.length, 1, "a failure in Waffle's code is told once in the status bar, not per repeat");
    assert.match(infos[0], /Internal error \(TypeError, editor\.js\).*Crash Diagnostics/);
  }
  assert.ok(!infos.some(m => /secret|Users/.test(m)), "the notice carries no message or path");
  // A benign ResizeObserver notice and a cancelled job are not failures.
  const before = (await globalThis.AtriumDiagnostics.entries()).length;
  handlers.get("error")({filename: "", message: "ResizeObserver loop completed with undelivered notifications.", error: null});
  handlers.get("unhandledrejection")({reason: Object.assign(Error("cancelled"), {cancelled: true})});
  handlers.get("unhandledrejection")({reason: {name: "AbortError"}});
  assert.equal((await globalThis.AtriumDiagnostics.entries()).length, before, "benign notices are not logged");
  // Worker failures and hangs (worker-pool.js) keep only a task code name.
  assert.equal(globalThis.AtriumDiagnostics.record("hang", "pour-solve"), true);
  assert.equal(globalThis.AtriumDiagnostics.record("worker", "/Users/example/secret.waffle"), false, "a task name is a code, never a path");
  assert.equal(globalThis.AtriumDiagnostics.record("bogus", "pour-solve"), false);
  rows = await globalThis.AtriumDiagnostics.entries();
  assert.ok(rows.some(r => r.kind === "hang" && r.type === "pour-solve"));
  const text = R.report(rows, {backend: () => "indexeddb"});
  assert.match(text, /diagnostics report/);
  assert.match(text, /stopped responding and was restarted · pour-solve/);
  assert.match(text, /Recovery storage: indexeddb/);
  assert.ok(!/secret|\/Users/.test(text), "the report has no paths or messages");
  let stored = values.get(key);
  assert.ok(!/secret|\/Users/.test(stored), "the history never contains raw messages, paths or custom error types");

  new Function(source)();
  globalThis.AtriumHost = {crashHistory: async () => [{at: Date.now() + 1, kind: "renderer", type: "macOS", reason: "terminated", extra: "secret"}]};
  rows = await globalThis.AtriumDiagnostics.entries();
  assert.equal(rows.length, 6, "stored entries and native failures survive a new page");
  assert.equal(rows[0].reason, "terminated");
  assert.equal(rows[0].extra, undefined);

  if (typeof URL === "function") {
    handlers.get("error")({filename: base + "private/editor.js", lineno: 81, error: new URIError("Unlisted script")});
    rows = await globalThis.AtriumDiagnostics.entries();
    assert.ok(rows.some(r => r.type === "URIError" && !r.module && r.line === undefined),
      "a different script with the same basename has no attribution");

    const foreign = "https://outside.invalid/app/editor/editor.js";
    globalThis.location.href = "https://waffle.invalid/app/index.html";
    globalThis.document.scripts.push({src: foreign});
    handlers.get("error")({filename: foreign, lineno: 82, error: new EvalError("Foreign script")});
    rows = await globalThis.AtriumDiagnostics.entries();
    assert.ok(rows.some(r => r.type === "EvalError" && !r.module && r.line === undefined),
      "a registered script on another origin has no attribution");
    globalThis.location.href = base + "index.html";

    for (let i = 1; i <= 60; i++) handlers.get("error")({filename: script, lineno: i, error: new Error()});
  } else {
    for (let i = 0; i < 60; i++) globalThis.AtriumDiagnostics.autosaveFailure(i % 2 ? "serialize" : "quota");
  }
  assert.equal(JSON.parse(values.get(key)).length, 32, "history is bounded");
  assert.equal((await globalThis.AtriumDiagnostics.entries()).length, 32, "the merged view is bounded");
  console.log("diagnostics: module locations, privacy, bounds and restart persistence OK");
}
globalThis.__testDone = main();
globalThis.__testDone.catch(e => { console.error(e); process.exitCode = 1; });
