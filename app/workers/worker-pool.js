"use strict";
// @ts-check
// A small shared worker pool. Lazy: no worker starts until a job needs
// one, and a pool keeps its workers for the next job. A pool runs one kind of task: its worker
// source answers {id, task} with {id, result} or {id, error}. Results come back in the order the
// caller asks for them (map() returns them by index), never in finishing order, so a parallel
// run merges exactly as the serial loop would.
//
//   const pool = AtriumWorkerPool.get("pour-solve", () => source, {local: task => solve(task)});
//   pool.run(task, transfer?, progress?) -> Promise<result>  (a free worker, else queued; progress(p) for
//                               {id, progress} messages the worker posts before its result)
//   pool.run(task, transfer, progress, original)  original: what local() runs if the job falls back to
//                               this thread after `transfer` may have detached task's buffers
//   promise.cancel()           cancels only that queued or in-flight job
//   pool.map(tasks)             -> Promise<results[]> in the order of tasks
//   pool.cancel()               stops the workers of jobs in flight; their promises reject "cancelled"
//   pool.size, pool.available   (available: workers can start here)
//   AtriumWorkerPool.script(url) -> Worker for a script file beside the app, started so that it runs
//                                   from file:// in WKWebView and WebKitGTK too (see script())
//   AtriumWorkerPool.blobWorker(src) -> one-shot Blob Worker for source text. Its object URL is
//                                   revoked after 30s even when construction throws; undefined if blocked.
//
// Energy: a pool only runs work someone asked for and is waiting on (race to idle; nothing
// speculative), a worker idle for IDLE_MS is terminated, and nothing spins. Size:
// navigator.hardwareConcurrency less one for the page (WebKit reports at most 8), at most
// MAX_WORKERS, at most the cap: setCap(n) (the one power hook), else 2 while
// AtriumPower.efficient() says to save energy (when that module is loaded). stats() gives the
// jobs run and the worker time they took (post to reply), so CPU cost can be read beside wall time.
// Where workers cannot start (headless JavaScriptCore, a host that blocks Blob
// workers) or a worker fails, the task runs through `local` on this thread instead, after a
// macrotask, so the caller sees the same results either way.
//
// Watchdog: a job whose worker posts nothing (no result, no progress) for options.watchdogMs
// (WATCHDOG_MS by default; 0 turns it off) is taken as hung. Its worker is terminated, the job
// rejects with an error whose .hung is true (it is not rerun here: the same task would hang this
// thread), later jobs start a fresh worker, the failure is logged (AtriumDiagnostics, the pool's
// name only) and the status bar says so once. A worker that crashes is logged the same way.
// With options.crash "fail" a crashed job is retried once in a fresh worker and then rejected
// (error.crashed), never run on this thread; `local` then runs only where no worker can start.
globalThis.AtriumWorkerPool = (() => {
  const MAX_WORKERS = 8, IDLE_MS = 10000, EFFICIENT_WORKERS = 2, WATCHDOG_MS = 240000;
  let cap = 0;
  /** @type {Map<string, any>} */
  const pools = new Map();
  const cores = () => {
    const n = Number(globalThis.navigator?.hardwareConcurrency) || 1;
    let limit = MAX_WORKERS;
    if (cap > 0) limit = Math.min(limit, cap);
    else { try { if (globalThis.AtriumPower?.efficient?.()) limit = Math.min(limit, EFFICIENT_WORKERS); } catch { /* no power module */ } }
    return Math.max(1, Math.min(limit, n - 1));
  };
  /** Cap every pool at n workers (0: no cap). The hook for power settings. @param {number} n */
  function setCap(n) { cap = Math.max(0, Math.floor(+n || 0)); }
  const canStart = () => typeof Worker === "function" && typeof Blob === "function" && typeof globalThis.URL?.createObjectURL === "function";
  const later = (/** @type {() => void} */ f) => setTimeout(f, 0);
  class Cancelled extends Error { constructor() { super("cancelled"); this.cancelled = true; } }
  class Hung extends Error { constructor(name) { super("The background task " + name + " stopped responding and was restarted."); this.hung = true; } }
  class Crashed extends Error { constructor(name) { super("The background task " + name + " crashed in two workers."); this.crashed = true; } }
  const told = new Map();
  function report(kind, name) {
    try { globalThis.AtriumDiagnostics?.record?.(kind, name); } catch { /* no log */ }
    const now = Date.now();
    if (now - (told.get(kind + name) || -Infinity) < 60000) return;
    told.set(kind + name, now);
    try {
      globalThis.AtriumNavHost?.info?.(kind === "hang" ? "A background task (" + name + ") stopped responding. Waffle restarted it; the editor kept running."
        : "A background worker (" + name + ") failed; Waffle finished its work on the main thread.");
    } catch { /* no editor */ }
  }
  // One trusted Blob launch. The object URL lives for 30s after it is created, including when
  // Worker construction throws, then it is revoked. undefined: Blob workers are blocked here.
  /** @param {string} src @returns {Worker|undefined} */
  function blobWorker(src) {
    let url = "";
    try { url = URL.createObjectURL(new Blob([src], {type: "text/javascript"})); return new Worker(url); }
    catch { /* Blob workers blocked here: the file itself */ }
    finally { const u = url; if (u) setTimeout(() => URL.revokeObjectURL(u), 30000)?.unref?.(); } // never keeps a CLI process alive
  }
  // A worker for a script file beside the app (release-worker.js, diff-worker.js, ...). WKWebView and
  // WebKitGTK never start a worker from a file:// URL (the page's origin is opaque; the error event
  // fires and nothing runs), but they start Blob workers, and a Blob worker may importScripts() an
  // absolute file URL under the app folder. So the worker is a small Blob bootstrap that resolves
  // importScripts() against the script's folder and then loads the script: the script's own relative
  // importScripts("model.js") work unchanged, and nothing is bundled. Chrome and WebView2 (its https
  // virtual host) take the same path. Where Blob workers cannot be made, the script URL itself.
  /** @param {string} scriptURL absolute, or relative to the page @returns {Worker} */
  function script(scriptURL) {
    const href = new URL(scriptURL, globalThis.document?.baseURI || globalThis.location?.href).href;
    if (canStart()) {
      const src = '"use strict";\n(() => { const load = self.importScripts.bind(self), base = ' + JSON.stringify(new URL(".", href).href) + ';\n' +
        '  self.importScripts = (...files) => load(...files.map(f => new URL(String(f), base).href)); })();\nimportScripts(' + JSON.stringify(href) + ');\n';
      const worker = blobWorker(src);
      if (worker) return worker;
    }
    return new Worker(href);
  }

  /**
   * @param {string} name
   * @param {() => string} source worker source, built on first use of each version
   * @param {{size?: number, local?: (task: any) => any, sourceVersion?: () => string, watchdogMs?: number, crash?: string}} [options]
   */
  function create(name, source, options = {}) {
    const watchdog = options.watchdogMs ?? WATCHDOG_MS;
    const fixed = options.size || 0, size = () => Math.max(1, Math.min(MAX_WORKERS, fixed ? Math.min(fixed, cores()) : cores()));
    const stat = {jobs: 0, workerMs: 0, local: 0, started: 0};
    const clock = () => globalThis.performance?.now?.() ?? Date.now();
    let generation = {key: "", url: ""};
    /** @type {{w: Worker, job: any, idle: number, dog?: any, source: typeof generation}[]} */
    const workers = [];
    /** @type {any[]} */
    const queue = [];
    const localJobs = new Set();
    let broken = !canStart(), seq = 0, closed = false;
    const local = options.local || null;
    function releaseSource(g) {
      if (g.url && (closed || g !== generation) && !workers.some(s => s.source === g)) {
        try { URL.revokeObjectURL(g.url); } catch { /* already gone */ }
        g.url = "";
      }
    }
    function retire(slot) {
      const i = workers.indexOf(slot);
      if (i < 0) return;
      workers.splice(i, 1);
      if (slot.idle) clearTimeout(slot.idle);
      if (slot.dog) clearTimeout(slot.dog);
      try { slot.w.terminate(); } catch { /* already gone */ }
      releaseSource(slot.source);
    }
    function selectSource(key) {
      if (key === generation.key) return;
      const old = generation;
      generation = {key, url: ""}; broken = !canStart();
      // Busy workers finish their original jobs. Both versions count against the same cap.
      for (const slot of [...workers]) if (!slot.job) retire(slot);
      releaseSource(old);
    }
    function runLocal(job) {
      if (!local) { job.reject(Error("No worker is available for " + name + ".")); return; }
      stat.local++;
      localJobs.add(job);
      const finish = (callback, value) => {
        localJobs.delete(job);
        if (!job.cancelled) callback(value);
        pump();
      };
      job.timer = later(() => {
        if (job.cancelled) return;
        try { const p = local(job.original ?? job.task); job.stopLocal = p?.cancel; Promise.resolve(p).then(value => finish(job.resolve, value), e => finish(job.reject, e)); }
        catch (e) { finish(job.reject, e); }
      });
    }
    function spawn() {
      if (broken) return null;
      try {
        if (!generation.url) generation.url = URL.createObjectURL(new Blob([source()], {type: "text/javascript"}));
        const w = new Worker(generation.url), slot = {w, job: null, idle: 0, source: generation};
        stat.started++;
        w.onmessage = e => {
          const job = slot.job, d = e.data || {};
          if (!job || d.id !== job.id) return;
          // A progress message (e.g. a pour preview ahead of the exact solve): the job goes on.
          if ("progress" in d) { guard(slot); try { job.progress?.(d.progress); } catch { /* the caller's */ } return; }
          slot.job = null; guard(slot); stat.jobs++; stat.workerMs += clock() - job.at;
          if (d.error) job.reject(Error(d.error)); else job.resolve(d.result);
          if (slot.source !== generation) retire(slot);
          pump();
          if (workers.includes(slot)) rest(slot);
        };
        w.onerror = w.onmessageerror = e => {
          e?.preventDefault?.();
          // A worker that fails (or sends what cannot be read) is dropped; its job (and any later
          // one, if none can start) runs here.
          if (!workers.includes(slot)) return;
          report("worker", name);
          const job = slot.job; slot.job = null;
          retire(slot);
          // options.crash "fail" (pour solves: a crash may be the task itself, e.g. out of memory): the
          // job runs once more in a fresh worker, sent again from its original (the first post may have
          // transferred its buffers); a second crash rejects it (error.crashed). Never on this thread.
          if (options.crash === "fail") {
            if (job && !job.cancelled) {
              if (!job.retried) { job.retried = true; if (job.original) { job.task = job.original; job.transfer = []; } queue.unshift(job); }
              else {
                job.cancelled = true; job.reject(new Crashed(name));
                // Two crashes before any job ever finished: workers do not run here (later jobs go to local).
                if (!stat.jobs) broken = true;
              }
            }
            pump();
            return;
          }
          if (slot.source === generation && !workers.some(s => s.source === generation)) broken = true;
          if (job && !job.cancelled) { job.useLocal = true; queue.unshift(job); }
          pump();
        };
        workers.push(slot);
        return slot;
      } catch { broken = true; return null; }
    }
    function pump() {
      if (queue.length && options.sourceVersion) selectSource(options.sourceVersion());
      while (!closed && queue.length && localJobs.size + workers.filter(s => s.job).length < size()) {
        if (queue[0].retried && broken && !workers.some(s => s.source === generation)) { const job = queue.shift(); job.cancelled = true; job.reject(new Crashed(name)); continue; }
        if (queue[0].useLocal || broken && !workers.some(s => s.source === generation)) { runLocal(queue.shift()); continue; }
        let slot = workers.find(s => !s.job);
        if (!slot && workers.length < size()) slot = spawn();
        if (!slot) {
          if (broken && !workers.some(s => s.source === generation)) continue;
          return;
        }
        const job = queue.shift();
        if (job.cancelled) continue;
        slot.job = job; job.at = clock();
        if (slot.idle) { clearTimeout(slot.idle); slot.idle = 0; }
        guard(slot);
        try { slot.w.postMessage({id: job.id, task: job.task}, job.transfer || []); }
        catch { slot.job = null; runLocal(job); rest(slot); }
      }
    }
    // (Re)arm the watchdog while the slot has a job; a message from the worker re-arms it.
    function guard(slot) {
      if (slot.dog) { clearTimeout(slot.dog); slot.dog = 0; }
      if (!(watchdog > 0) || !slot.job) return;
      slot.dog = setTimeout(() => {
        slot.dog = 0;
        const job = slot.job;
        if (!job || !workers.includes(slot)) return;
        slot.job = null;
        retire(slot);
        report("hang", name);
        if (!job.cancelled) { job.cancelled = true; job.reject(new Hung(name)); }
        pump();
      }, watchdog);
    }
    // A worker with nothing to do is terminated after IDLE_MS (the next job starts a new one).
    function rest(slot) {
      if (slot.job || slot.idle) return;
      slot.idle = setTimeout(() => {
        slot.idle = 0;
        if (slot.job) return;
        retire(slot);
      }, IDLE_MS);
    }
    function cancelJob(job) {
      const queued = queue.indexOf(job), index = workers.findIndex(s => s.job === job);
      if (queued >= 0) queue.splice(queued, 1);
      else if (index >= 0) {
        const slot = workers[index];
        slot.job = null;
        retire(slot);
      } else if (localJobs.delete(job)) { clearTimeout(job.timer); try { job.stopLocal?.(); } catch { /* finished */ } }
      else return;
      job.cancelled = true;
      job.reject(new Cancelled());
      pump();
    }
    /** @param {any} task @param {Transferable[]} [transfer] @param {(p: any) => void} [progress] messages the worker posts before its result @param {any} [original] task used in the local fallback @returns {Promise<any> & {cancel?: () => void}} */
    function run(task, transfer, progress, original) {
      if (closed) return Promise.reject(new Cancelled());
      let job;
      const result = new Promise((resolve, reject) => {
        job = {id: ++seq, task, transfer, progress, original, resolve, reject, cancelled: false};
        queue.push(job); pump();
      });
      return Object.assign(result, {cancel: () => cancelJob(job)});
    }
    /** @param {any[]} tasks */
    const map = tasks => Promise.all(tasks.map(t => run(t)));
    function cancel() {
      for (const job of queue) { job.cancelled = true; job.reject(new Cancelled()); }
      queue.length = 0;
      for (const job of localJobs) { clearTimeout(job.timer); job.cancelled = true; try { job.stopLocal?.(); } catch { /* finished */ } job.reject(new Cancelled()); }
      localJobs.clear();
      for (let i = workers.length - 1; i >= 0; i--) {
        const s = workers[i];
        if (!s.job) continue;
        s.job.cancelled = true; s.job.reject(new Cancelled());
        s.job = null;
        retire(s);
      }
    }
    function close() {
      closed = true; cancel();
      for (const s of [...workers]) retire(s);
      releaseSource(generation);
      pools.delete(name);
    }
    return Object.freeze({name, get size() { return size(); }, run, map, cancel, close, stats: () => ({...stat}),
      get available() { return !broken || !!options.sourceVersion && options.sourceVersion() !== generation.key && canStart(); },
      get busy() { return workers.filter(s => s.job).length + localJobs.size + queue.length; }, get started() { return workers.length; }});
  }
  /**
   * The named pool, made on first use (one per kind of task, shared by every caller).
   * @param {string} name @param {() => string} source @param {{size?: number, local?: (task: any) => any, sourceVersion?: () => string, watchdogMs?: number, crash?: string}} [options]
   */
  function get(name, source, options) {
    let p = pools.get(name);
    if (!p) { p = create(name, source, options); pools.set(name, p); }
    return p;
  }
  /** The named pool if one was made, else null. @param {string} name */
  const find = name => pools.get(name) || null;
  return Object.freeze({get, find, create, script, blobWorker, cores, canStart, setCap, MAX_WORKERS, IDLE_MS, WATCHDOG_MS, Cancelled, Hung, Crashed});
})();
