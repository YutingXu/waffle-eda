"use strict";
// Page-side worker probe (tests/workers/worker-start.py drives it in headless Chrome from file://, and in
// the macOS WKWebView harness and the WebKitGTK harness through native/tests/macos-harness/worker-probes.js). Test-only.
//
// atriumWorkerProbe() starts every worker the app has, the way the app starts it, and reports for
// each whether it ran (a message came back from inside it), then makes a release of the sample
// board with the output worker and returns the SHA-256 of every file, so the hosts can be compared
// byte for byte.
//   {workers: {name: {supply, ok, state, ms, detail}}, release: {...}, errors: [...]}
globalThis.atriumWorkerProbe = (() => {
  const L = () => globalThis.AtriumLazy, wait = ms => new Promise(r => setTimeout(r, ms));
  // output-jobs.js registers the Release modules (release.js) when it loads.
  const needRelease = async () => { await L().need("AtriumOutputJobs"); await L().need("AtriumReleaseUI"); };
  const releaseDate = "2026-06-15T12:00:00Z";
  // Snapshot IDs come from the same revision seed on every host. Each probe gets its own copy
  // because output preparation may update the project it receives.
  let fixture;
  function sample() {
    fixture ??= Atrium.withRevisionIds("c9496e4cabe9f65650f33fe93eb0b0852432196163d682ad6053753b7d742f34", () => {
      const p = AtriumParts.example(), board = p.documents.find(d => d.kind === "pcb");
      const source = "components6/data#0";
      board.items.find(i => i.kind === "part" && i.ref === "R1").sourceRecord = source;
      board.pcbDrawing = {annotations: {[source]: [
        {at: [1.25, 2], angle: 0, field: "ref", layer: "Bottom silk", size: 1, width: .2, mirrored: true,
          sourceTextBox: {mode: "ink", text: "R1", size: 1, width: 2.5, height: 1.1, font: "stroke", strokeWidth: .2, strokeFont: "default"}}
      ]}};
      board.items.find(i => i.kind === "part" && i.ref === "R2").designator = {x: 1, y: 2, height: 1, angle: 0};
      return JSON.stringify(p);
    });
    return JSON.parse(fixture);
  }
  const blob = s => URL.createObjectURL(new Blob([s], {type: "text/javascript"}));
  const appBase = () => { const s = document.querySelector('script[src$="lazy.js"]') || document.querySelector('script[src$="model.js"]'); return new URL(".", s ? s.src : document.baseURI).href; };
  // Resolves on the worker's first message (it ran), its error event, or the time limit.
  function answer(w, send, ms = 8000) {
    const t0 = performance.now();
    return new Promise(res => {
      if (!w) { res({ok: false, state: "none", ms: 0}); return; }
      const done = (ok, state, detail) => { clearTimeout(t); try { w.terminate(); } catch { /* gone */ } res({ok, state, ms: Math.round(performance.now() - t0), detail}); };
      const t = setTimeout(() => done(false, "timeout"), ms);
      w.onmessage = e => done(e.data?.type !== "unavailable" && e.data?.type !== "error", "message", JSON.stringify(e.data || null).slice(0, 160));
      w.onerror = e => { e.preventDefault?.(); done(false, "error", String(e.message || "")); };
      try { send?.(w); } catch (e) { done(false, "post", String(e.message || e)); }
    });
  }
  // A file-script worker as the app starts it: the shared helper when there is one, else the file URL.
  const fileWorker = name => globalThis.AtriumWorkerPool?.script ? AtriumWorkerPool.script(appBase() + name) : new Worker(appBase() + name);
  const supplyOf = () => globalThis.AtriumWorkerPool?.script ? "blob bootstrap (worker-pool.js script())" : "file URL";
  const WORKERS = [
    // Script files next to the app (file URL before this fix).
    ["release-worker.js", "file", async () => {
      await needRelease();
      const globals = ["AtriumFabPresets", "AtriumFabPresetsJLCPCB", "AtriumFabProfiles", "AtriumSHA256", "AtriumOutputJobs"];
      const r = await answer(fileWorker("workers/release-worker.js"), w => w.postMessage({type: "init", globals: [...globals].reverse()}));
      return {...r, ok: r.ok && r.detail === JSON.stringify({type: "ready", globals})};
    }],
    ["diff-worker.js", "file", async () => { await L().need("AtriumDiff"); return answer(fileWorker("workers/diff-worker.js"), w => w.postMessage({before: {documents: []}, after: {documents: []}, opts: {validate: false}})); }],
    ["route-suggest-worker.js", "file", async () => { await L().need("AtriumRouteSuggest"); return answer(fileWorker("workers/route-suggest-worker.js"), w => w.postMessage({type: "ping"}), 15000); }],
    ["import-worker.js (file fallback)", "file", async () => answer(fileWorker("workers/import-worker.js"))],
    ["pdn-worker.js (file fallback)", "file", async () => answer(fileWorker("workers/pdn-worker.js"))],
    ["thermal-worker.js (file fallback)", "file", async () => answer(fileWorker("workers/thermal-worker.js"), w => w.postMessage({type: "solve", id: 1, job: null}))],
    ["autorouter-worker.js (file fallback)", "file", async () => answer(fileWorker("workers/autorouter-worker.js"), w => w.postMessage({type: "route", id: 1, job: null}))],
    ["field-solver-worker.js (file fallback)", "file", async () => answer(fileWorker("workers/field-solver-worker.js"), w => w.postMessage({type: "solve", id: 1, geom: null}))],
    // Blob workers built from in-page source, constructed as their modules construct them.
    ["import (bundled worker-source.js)", "blob", async () => { await L().need("AtriumImportWorkerSource"); return answer(new Worker(blob(globalThis.AtriumImportWorkerSource))); }],
    ["pdn (Blob of AtriumPDNCore)", "blob", async () => { await L().need("AtriumPDN"); return answer(new Worker(blob('"use strict";\n' + AtriumPDNCore + "\n" + AtriumPDNServe + "\nAtriumPDNServe(self, AtriumPDNCore());\n"))); }],
    ["thermal (Blob of AtriumThermalCore)", "blob", async () => { await L().need("AtriumThermal"); return answer(new Worker(blob('"use strict";\n' + AtriumPDNCore + "\n" + AtriumThermalCore + "\n" + AtriumPDNServe + "\nAtriumPDNServe(self, AtriumThermalCore(AtriumPDNCore()));\n")), w => w.postMessage({type: "solve", id: 1, job: null})); }],
    ["autorouter (production Blob)", "blob", async ({fault}) => {
      await L().need("AtriumAutorouter");
      const source = AtriumAutorouter.workerSource();
      const missing = JSON.stringify(appBase() + "worker-start-missing-dependency.js");
      const url = blob(fault === "worker-import" ? `importScripts(${missing});\n` + source : source);
      try {
        const r = await answer(new Worker(url));
        return {...r, ok: r.ok && r.detail === JSON.stringify({type: "ready"})};
      } finally { URL.revokeObjectURL(url); }
    }],
    ["field solver (Blob of AtriumFieldSolverFactory)", "blob", async () => { await L().need("AtriumFieldSolver"); return answer(new Worker(blob('"use strict";\n' + AtriumFieldSolverFactory + "\n" + AtriumFieldSolverServe + "\nAtriumFieldSolverServe(self, AtriumFieldSolverFactory());\n")), w => w.postMessage({type: "solve", id: 1, geom: null})); }],
    ["STEP import (Blob of STEPCore)", "blob", async () => { await L().need("AtriumSTEPImport"); const C = AtriumSTEPImport.core; return answer(new Worker(blob('"use strict";const C=(' + C + ')();onmessage=e=>postMessage({id:e.data.id,ok:typeof C.tessellate});')), w => w.postMessage({id: 1})); }],
    ["extension host (Blob in the sandbox frame)", "blob", async () => {
      const t0 = performance.now();
      for (let i = 0; i < 100 && !globalThis.AtriumExtensions?.attached; i++) await wait(100);
      const X = globalThis.AtriumExtensions;
      if (!X?.attached) return {ok: false, state: "no extension host on this page", ms: 0};
      await Promise.race([X.activate("waffle.calculators"), wait(15000)]);
      const e = X.list().find(x => x.id === "waffle.calculators");
      return {ok: e?.status === "active" && X.workers.length > 0, state: (e?.status || "missing") + ", " + X.workers.length + " worker(s)", ms: Math.round(performance.now() - t0), detail: JSON.stringify(e?.errors || [])};
    }],
    ["worker pool (worker-pool.js)", "blob", async () => {
      await L().need("AtriumWorkerPool");
      const t0 = performance.now(), p = AtriumWorkerPool.create("probe-" + Math.random(), () => "onmessage=e=>postMessage({id:e.data.id,result:e.data.task*2})");
      try { const r = await Promise.race([p.run(21), wait(8000).then(() => "timeout")]); const s = p.stats(); return {ok: r === 42 && s.local === 0 && s.jobs === 1, state: s.local ? "local" : "message", ms: Math.round(performance.now() - t0), detail: JSON.stringify(s)}; }
      finally { p.close(); }
    }],
    ["diff compareAsync (diff.js client)", "client", async () => {
      await L().need("AtriumDiff");
      const P = sample(), Q = JSON.parse(JSON.stringify(P)), seen = spy();
      const t0 = performance.now(), r = await AtriumDiff.compareAsync(P, Q, {workerThreshold: 0});
      seen.stop();
      return {ok: !!r && seen.answered > 0, state: seen.answered ? "worker" : "main-thread slices", ms: Math.round(performance.now() - t0), detail: JSON.stringify(seen)};
    }],
    ["release generate (release.js client)", "client", async () => {
      await needRelease();
      const t0 = performance.now(), r = await AtriumRelease.generate(sample(), "Generic fab + assembly", {worker: true, date: releaseDate});
      return {ok: r.stats.worker > 0, state: "worker " + r.stats.worker + ", page " + r.stats.page, ms: Math.round(performance.now() - t0), detail: JSON.stringify(r.stats)};
    }]
  ];
  // Counts Worker constructions and the ones that sent a message back (for the client checks).
  function spy() {
    const W = globalThis.Worker, s = {made: 0, answered: 0, errors: 0};
    globalThis.Worker = function (...a) {
      const w = new W(...a); s.made++;
      w.addEventListener("message", () => { s.answered++; }, {once: true});
      w.addEventListener("error", () => { s.errors++; }, {once: true});
      return w;
    };
    globalThis.Worker.prototype = W.prototype;
    return {get made() { return s.made; }, get answered() { return s.answered; }, get errors() { return s.errors; }, stop() { globalThis.Worker = W; }, toJSON: () => ({...s})};
  }
  // Use the same translator and release packager in the page lane. The legacy synchronous
  // release entry point bypasses translator diagnostics, which are part of the package bytes.
  async function pageTranslator(jobs, fault) {
    L().register("AtriumTranslatorWorkerModules", {scripts: ["translator-worker-modules.js"]});
    await L().need("AtriumTranslatorWorkerModules");
    L().register("AtriumTranslatorExports", {scripts: ["formats/translator-exports.js"]});
    L().register("AtriumTranslatorManufacturing", {scripts: ["formats/translator-manufacturing.js"]});
    const translators = new Set(jobs.flatMap(job => AtriumOutputJobs.translatorNeeds(job)));
    const modules = [...translators].flatMap(id => AtriumTranslatorRegistry.get(id).modules.export);
    const scripts = [...new Set(modules.flatMap(root => AtriumTranslatorWorkerModules[root]))];
    L().register("AtriumTranslators", {scripts: [...scripts, "formats/translators.js"], deps: ["AtriumTranslatorRegistry", "AtriumTranslatorProvenance"]});
    await L().need(["AtriumTranslators", "AtriumTranslatorExports", "AtriumTranslatorManufacturing"]);
    return {exportSession() {
      const translate = AtriumTranslators.exportSession();
      return {
        export(id, project, options) {
          const result = translate(id, project, options);
          if (fault === "release-artifact" && id === "fabrication" && options.include?.includes("gerber")) {
            const copper = result.files.find(f => /\.GTL$/i.test(f.name) && typeof f.text === "string");
            if (!copper) throw Error("The release fixture has no top copper Gerber to mutate.");
            copper.text = "G04 worker-start byte comparison fault*\n" + copper.text;
          }
          return result;
        },
        close() {}
      };
    }};
  }
  // A release of the sample board with the Release page's worker pool; hashes of every file.
  async function release({name: job, ref, crossHost}, pageClient) {
    const page = !!pageClient, project = sample(), K = AtriumOutputJobs.KINDS, set = AtriumOutputJobs.resolve(project, ref);
    for (const o of set.outputs) if (K[o.kind]?.needs && !globalThis[K[o.kind].needs]) { try { await L().need(K[o.kind].needs); } catch { /* reported as skipped */ } }
    const before = (globalThis.AtriumMessages?.messages?.() || []).length;
    const pool = page ? null : AtriumRelease.workerPool(), t0 = performance.now();
    const client = await L().need("AtriumTranslatorClient");
    if (page) globalThis.AtriumTranslatorClient = pageClient;
    try {
      const opts = {worker: pool || false, date: releaseDate, force: true, git: {available: false}, toolVersion: "probe"};
      const r = await AtriumRelease.release(project, ref, opts);
      const files = {}, kinds = {};
      for (const p of r.packages) {
        const kindOf = new Map(p.report.outputs.map(o => [o.id, o.kind]));
        for (const f of p.manifest.files) { files[p.name + "/" + f.path] = f.sha256; kinds[p.name + "/" + f.path] = kindOf.get(f.output) || f.output; }
      }
      for (const f of r.files) files["package:" + f.name] = AtriumOutputJobs.sha256(f.data);
      const outputs = r.packages.flatMap(p => p.report.outputs.map(o => ({kind: o.kind, status: o.status, files: (o.files || []).length})));
      const messages = (globalThis.AtriumMessages?.messages?.() || []).slice(before).map(m => String(m.text || m.message || m.description || JSON.stringify(m)).slice(0, 200));
      const stats = page ? {...r.stats, worker: 0, page: r.stats.worker + r.stats.page} : r.stats;
      return {job, page, crossHost, ok: r.ok, design: r.record.designHash, stats, ms: Math.round(performance.now() - t0), outputs, files, kinds, messages};
    } finally { globalThis.AtriumTranslatorClient = client; pool?.close(); }
  }
  return async function probe(opts = {}) {
    const errors = [];
    addEventListener("error", e => errors.push("error: " + e.message + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno));
    addEventListener("unhandledrejection", e => errors.push("rejection: " + (e.reason?.message || e.reason)));
    const workers = {};
    if (opts.helper !== false) { try { await L().need("AtriumWorkerPool"); } catch { /* reported per worker */ } }
    for (const [name, kind, f] of WORKERS) {
      try { workers[name] = {supply: kind === "file" ? supplyOf() : kind, ...await f(opts)}; } catch (e) { workers[name] = {supply: kind, ok: false, state: "threw", detail: String(e?.message || e).slice(0, 200)}; }
    }
    const releases = {};
    const project = sample(), board = project.documents.find(d => d.kind === "pcb");
    const jobs = (opts.jobs || ["Generic fab + assembly", "Everything"]).flatMap(name => {
      const set = AtriumOutputJobs.resolve(project, name);
      const pdf = set.outputs.some(o => o.enabled && o.kind === "pdf");
      const full = {name, ref: name, crossHost: !pdf};
      if (!pdf) return [full];
      // Schematic text positioning uses font baselines measured by the host. Keep the full
      // release check on each host and also make a real PCB PDF package for strict host parity.
      const outputs = set.outputs.map(o => o.kind === "pdf" ? {...o, options: {...o.options, documents: [board.id]}} : o);
      return [full, {name: name + " (PCB PDF)", ref: {...set, outputs}, crossHost: true}];
    });
    const local = await pageTranslator(jobs.map(job => AtriumOutputJobs.resolve(project, job.ref)), opts.fault);
    await L().need("AtriumPCBNetLabels");
    // PDF uses the board and schematic renderers. Match the print scale of the two test hosts
    // so a Retina WKWebView and a headless Chrome window produce the same labels and layout.
    const dpr = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
    Object.defineProperty(globalThis, "devicePixelRatio", {configurable: true, value: 1});
    try {
      for (const job of jobs) {
        for (const [suffix, client] of [["", null], [" (page only)", local]]) {
          try { releases[job.name + suffix] = await release(job, client); }
          catch (e) { releases[job.name + suffix] = {job: job.name, error: String(e?.stack || e).slice(0, 400)}; }
        }
      }
    } finally {
      if (dpr) Object.defineProperty(globalThis, "devicePixelRatio", dpr);
      else delete globalThis.devicePixelRatio;
    }
    return {engine: navigator.userAgent, href: location.href, fixture: AtriumOutputJobs.sha256(fixture), workers, releases, errors};
  };
})();
