"use strict";
// Web Worker for File › Release… (release.js starts it beside itself). It loads the DOM-free
// output modules the page has loaded, keeps one copy of the project, and makes one output at a
// time with AtriumOutputJobs.session, so the fabrication model is built once per release.
// Messages in:  {type: "init", globals: ["Atrium", ...]}
//               {type: "project", project}   (replaces the project; the next runs start fresh)
//               {type: "run", id, set, out, opts: {date, revision}}
// Messages out: {type: "ready", globals: [...]}  (release.js compares them with the page's)
//               {type: "result", id, result} | {type: "result", id, error}
globalThis.AtriumReleaseWorker = (() => {
  if (typeof importScripts === "function") importScripts("../workers/design-query-worker-modules.js", "../workers/release-worker-modules.js");
  const modules = globalThis.AtriumReleaseWorkerModules;
  let project = null;
  const sessions = new Map();
  function init(msg) {
    const requested = new Set(Array.isArray(msg.globals) ? msg.globals : []), loaded = [];
    for (const [name, file] of modules) {
      if (!requested.has(name)) continue;
      // The caller selects a declared global; the worker owns every script URL.
      if (!globalThis[name]) {
        try { importScripts(file); } catch { continue; }
      }
      if (globalThis[name]) loaded.push(name);
    }
    return loaded;
  }
  async function run(msg) {
    const J = globalThis.AtriumOutputJobs;
    if (!J || !project) throw Error("The output worker is not ready.");
    const set = msg.set, key = JSON.stringify([set.board, set.panel, set.fabProfile, set.folder, set.revision, set.package, msg.opts?.date, msg.opts?.revision]);
    let s = sessions.get(key);
    if (!s) { s = J.session(project, {...set, outputs: []}, {date: msg.opts?.date, revision: msg.opts?.revision}); sessions.set(key, s); }
    const r = await s.generate(msg.out);
    return {files: (r.files || []).map(f => ({name: f.name, data: f.data})), warnings: r.warnings || [], summary: r.summary || "", status: r.status, message: r.message};
  }
  if (typeof self !== "undefined" && typeof importScripts === "function") {
    self.onmessage = async e => {
      const msg = e.data || {};
      if (msg.type === "init") { let globals = []; try { globals = init(msg); } catch { globals = []; } self.postMessage({type: "ready", globals}); return; }
      if (msg.type === "project") { project = msg.project; sessions.clear(); return; }
      if (msg.type === "run") {
        try { self.postMessage({type: "result", id: msg.id, result: await run(msg)}); }
        catch (error) { self.postMessage({type: "result", id: msg.id, error: String(error?.message || error)}); }
      }
    };
  }
  return Object.freeze({init, run});
})();
