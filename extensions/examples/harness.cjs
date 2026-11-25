"use strict";
// Sandbox test harness for Waffle extensions (the one tests/extensions.cjs uses).
//
// Extension code runs in a SEPARATE JS realm (JavaScriptCore $262.createRealm, or Node's vm),
// joined to the editor-side host only by JSON strings, the way a Worker is. The host is the
// real AtriumExtensions + AtriumAPI over an in-memory project, so permissions, proposals,
// limits and panels behave as in the editor. Consent prompts are answered by `answers`.
//
//   const harness = require("<atrium>/extensions/examples/harness.cjs");
//   module.exports = async function test(h, dir) {
//     const ext = await h.installFolder(dir);
//     await h.X.execute("myExt.run");
//     h.assert.equal(...);
//   };
//   if (require.main === module) harness.run(module.exports, __dirname);
//
// Run one test:  jsc tests/jsc-shim.js -- path/to/test.cjs   (macOS, no Node), or  node path/to/test.cjs
// Run them all:  scripts/test-jsc.sh extension-examples
const assert = require("node:assert/strict");
const fs = require("node:fs");
const APP = __dirname + "/../../app/";
let ready = null;

// Binary-safe JSON: ArrayBuffers and typed arrays cross the realm boundary as byte lists.
const CODEC = `const __enc = (k, v) => v instanceof ArrayBuffer ? {$ab: Array.from(new Uint8Array(v))} : ArrayBuffer.isView(v) ? {$view: v.constructor.name, $ab: Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))} : v;
const __dec = (k, v) => v && typeof v === "object" && Array.isArray(v.$ab) ? (b => v.$view ? new globalThis[v.$view](b) : b)(new Uint8Array(v.$ab).buffer) : v;`;
const BOOT = CODEC + `(function(){
  const post = globalThis.__hostPost; delete globalThis.__hostPost;
  const inbox = [];
  globalThis.self = globalThis;
  self.postMessage = m => post(JSON.stringify(m, __enc));
  self.addEventListener = (type, f) => { if (type === "message") inbox.push(f); };
  globalThis.__deliver = text => { const data = JSON.parse(text, __dec); for (const f of inbox) f({data}); };
  const nativeTimeout = setTimeout, live = new Map(); let id = 0, ticking = false, dead = false;
  const tick = () => { const now = Date.now(); for (const [k, t] of [...live]) if (t.at <= now && live.delete(k)) { if (t.every) live.set(k, {...t, at: now + t.every}); t.f(); } if (live.size && !dead) nativeTimeout(tick, 4); else ticking = false; };
  const add = (f, ms, every) => { if (dead) return 0; live.set(++id, {f, at: Date.now() + (ms || 0), every}); if (!ticking) { ticking = true; nativeTimeout(tick, 0); } return id; };
  globalThis.setTimeout = (f, ms) => add(f, ms, 0);
  globalThis.setInterval = (f, ms) => add(f, ms, Math.max(1, ms || 0));
  globalThis.clearTimeout = globalThis.clearInterval = k => { live.delete(k); };
  globalThis.__stopTimers = () => { dead = true; live.clear(); };
})();`;

function setup() {
  if (ready) return ready;
  for (const f of ["core/model.js", "library/parts.js", "core/spatial.js", "checks/altium-rules.js", "checks/rules.js", "checks/connectivity.js", "core/zip.js", "editor/keymap.js", "automation/proposal.js",
    "editor/messages.js", "core/atrium-api.js", "workers/extension-host-worker.js", "extension-host/extensions.js", "automation/scripting.js", "extensions/manifests.js"]) require(APP + f);
  const {__enc, __dec} = new Function(CODEC + ";return {__enc,__dec};")();
  const X = globalThis.AtriumExtensions, A = globalThis.Atrium;
  const realms = [];
  function realmWorker(source, config) {
    const outer = {onmessage: null, terminated: false, config, terminate() { this.terminated = true; stopTimers?.(); }};
    let stopTimers = null, deliver;
    realms.push(outer);
    const hostPost = text => { if (!outer.terminated) Promise.resolve().then(() => { if (!outer.terminated) outer.onmessage?.({data: JSON.parse(text, __dec)}); }); };
    if (globalThis.$262?.createRealm) {
      const r = $262.createRealm(); r.global.__hostPost = hostPost; r.evalScript(BOOT);
      deliver = r.global.__deliver; stopTimers = r.global.__stopTimers;
      r.evalScript("delete globalThis.__deliver; delete globalThis.__stopTimers"); r.evalScript(source);
    } else {
      const vm = require("node:vm"), ctx = vm.createContext({__hostPost: hostPost, setTimeout, clearTimeout});
      vm.runInContext(BOOT, ctx); deliver = vm.runInContext("__deliver", ctx); stopTimers = vm.runInContext("__stopTimers", ctx);
      vm.runInContext("delete globalThis.__deliver; delete globalThis.__stopTimers", ctx); vm.runInContext(source, ctx);
    }
    outer.postMessage = m => { const text = JSON.stringify(m, __enc); Promise.resolve().then(() => { if (!outer.terminated) deliver(text); }); };
    return outer;
  }

  // An editor-like host over one in-memory project.
  const state = {project: AtriumParts.example(), current: null, selection: new Set(), revision: 0, developerMode: false};
  state.current = state.project.documents.find(d => d.kind === "pcb").id;
  const history = [], messages = [], exported = [], actions = [], prompts = [];
  const host = {
    project: () => state.project, documentId: () => state.current, revision: () => state.revision, selection: () => state.selection,
    select(ids) { state.selection = new Set(ids); X.notify("selectionChanged"); },
    edit(fn) { const before = JSON.stringify(state.project); try { fn(); } catch (e) { state.project = JSON.parse(before); throw e; } history.push(before); state.revision++; X.notify("documentChanged"); },
    amend(fn) { const before = JSON.stringify(state.project); try { fn(); } catch (e) { state.project = JSON.parse(before); throw e; } state.revision++; X.notify("documentChanged"); },
    info: t => messages.push(t), activate(id) { state.current = id; X.notify("activeDocumentChanged"); },
    runAction: a => actions.push(a), exportFile: (n, t) => { exported.push([n, t]); return true; }, locate: () => {}
  };
  // What the user answers, per prompt kind. Tests may change these.
  const answers = {install: r => Object.fromEntries(r.permissions.map(p => [p, !p.startsWith("network:")])), activate: null, write: "always", review: r => r.rows.map(x => x.index)};
  const consent = r => { prompts.push(r.kind + ":" + r.manifest.id); const a = answers[r.kind]; return typeof a === "function" ? a(r) : a; };
  X.attach(host, {createWorker: realmWorker, consent, heartbeatMs: 100, developerMode: () => state.developerMode});

  const read = (dir, name) => String(fs.readFileSync(dir + "/" + name, "utf8"));
  const h = {
    assert, X, A, host, history, messages, exported, actions, prompts, answers, realms,
    get project() { return state.project; }, set project(p) { state.project = p; state.revision++; X.notify("documentChanged"); },
    get selection() { return state.selection; },
    set developerMode(on) { state.developerMode = !!on; },
    board: () => state.project.documents.find(d => d.kind === "pcb"),
    sheet: () => state.project.documents.find(d => d.kind === "schematic"),
    open(kind) { const d = state.project.documents.find(x => x.kind === kind); host.activate(d.id); return d; },
    ref: (doc, r) => doc.items.find(i => i.ref === r),
    select: ids => host.select(ids),
    undo() { state.project = JSON.parse(history.pop()); state.revision++; X.notify("documentChanged"); },
    reset() { state.project = AtriumParts.example(); state.current = state.project.documents.find(d => d.kind === "pcb").id; state.selection = new Set(); state.revision++; history.length = 0; X.notify("documentChanged"); },
    wait: ms => new Promise(r => setTimeout(r, ms)),
    // The package in a folder: waffle-extension.json, its main file and any extra files named.
    files(dir, extra = []) {
      const manifest = JSON.parse(read(dir, "waffle-extension.json"));
      const out = {"waffle-extension.json": read(dir, "waffle-extension.json")};
      for (const f of [manifest.main, ...extra]) out[f] = read(dir, f);
      return out;
    },
    async installFolder(dir, extra) { return X.install(h.files(dir, extra)); },
    panel: (id, panel) => X._panel(id, panel),
    logs: id => X.logs(id),
    // Messages panel rows an extension reported (ui.showMessage with {messages}).
    reported: source => globalThis.AtriumMessages.messages().filter(m => !source || m.group === source)
  };
  return ready = Promise.resolve(h);
}

// Run test functions in sequence on one harness; sets the promise the JSC shim waits for.
function run(tests, dir) {
  const list = Array.isArray(tests) ? tests : [[tests, dir]];
  const done = (async () => {
    const h = await setup();
    for (const [fn, d, name] of list) { await fn(h, d); h.X.stopAll("test finished"); if (name) console.log("  ok " + name); }
    h.X.shutdown();
    console.log("extension tests passed");
  })();
  globalThis.__testDone = done.catch(e => { console.error(e && e.stack || e); globalThis.AtriumExtensions?.shutdown(); if (globalThis.process) process.exitCode = 1; throw e; });
  return globalThis.__testDone;
}

module.exports = {setup, run};
