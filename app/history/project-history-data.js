"use strict";
// A source belongs to one open native project. Only immutable blob pairs cross project boundaries.
globalThis.AtriumProjectHistoryData = (() => {
  const G = globalThis, S = G.AtriumHistorySummary;
  const build = G.document?.querySelector('meta[name="application-version"]')?.content || "dev";
  const workerURL = new URL("../workers/diff-worker.js", document.currentScript?.src || new URL("history/project-history-data.js", document.baseURI)).href;
  const memory = new Map();
  let database, repository;
  function db() {
    if (!database) database = new Promise(resolve => {
      try {
        const request = indexedDB.open("atrium-project-history", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("summaries");
        request.onerror = request.onblocked = () => resolve(null);
        request.onsuccess = () => resolve(request.result);
      } catch { resolve(null); }
    });
    return database;
  }
  async function cached(key) {
    if (memory.has(key)) return memory.get(key);
    const d = await db();
    if (!d) return null;
    return new Promise(resolve => {
      try {
        const r = d.transaction("summaries").objectStore("summaries").get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async function remember(key, value) {
    memory.set(key, value);
    if (memory.size > 80) memory.delete(memory.keys().next().value);
    const d = await db();
    if (d) try {
      const store = d.transaction("summaries", "readwrite").objectStore("summaries");
      store.put(value, key);
      const count = store.count();
      count.onsuccess = () => {
        if (count.result <= 512) return;
        let excess = count.result - 480;
        const r = store.openKeyCursor();
        r.onsuccess = () => {
          const cursor = r.result;
          if (!cursor || excess <= 0) return;
          if (cursor.key !== key) { store.delete(cursor.key); excess--; }
          cursor.continue();
        };
      };
    } catch { /* Private or full browser storage: session cache still works. */ }
  }

  const objectId = value => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
  const cancelled = () => Error("Project history request cancelled.");
  const COMMIT_CACHE_BYTES = 16 * 1024 * 1024, COMMIT_CACHE_COUNT = 3;
  function commitScope() {
    const host = G.AtriumHost, grant = host?.folderGitGrant;
    const generation = host?.projectGeneration, historyPath = host?.historyPath;
    if (!repository?.current()) {
      repository?.clear();
      const entries = new Map();
      repository = {
        entries, epoch:0,
        current: () => !!grant && host === G.AtriumHost && grant === host.folderGitGrant &&
          generation === host.projectGeneration && historyPath === host.historyPath,
        clear() {
          this.epoch++;
          for (const entry of entries.values()) entry.controller?.abort();
          entries.clear();
        }
      };
    }
    return repository;
  }
  // Each reader gets its own project. Compare validates it and Restore as Copy renames it.
  async function decodeCommit(bundle, revision, signal) {
    const worker = G.AtriumWorkerPool.script(workerURL);
    try {
      return await new Promise((done, fail) => {
        const abort = () => finish(cancelled());
        const watchdog = setTimeout(() => finish(Error("The saved revision timed out.")), 120000);
        function finish(error, result) {
          clearTimeout(watchdog);
          signal.removeEventListener("abort", abort);
          if (error) fail(error); else done(result);
        }
        signal.addEventListener("abort", abort, {once:true});
        if (signal.aborted) return abort();
        worker.onmessage = event => finish(event.data?.error ? Error(event.data.error) : null, event.data?.result?.value);
        worker.onerror = () => finish(Error("The comparison worker could not read the saved revision."));
        try { worker.postMessage({folder:{bundle, project:revision}}); }
        catch (error) { finish(error); }
      });
    } finally { worker.terminate(); }
  }
  function commitBlob(revision) {
    return commitScope().entries.get(revision)?.value?.blob;
  }
  async function readCommit(git, revision, {active = () => true, signal} = {}) {
    if (!objectId(revision)) throw Error("Choose an exact Git commit.");
    const scope = commitScope(), {entries, epoch} = scope;
    const valid = () => scope.current() && scope.epoch === epoch && active() && !signal?.aborted;
    if (!valid()) throw cancelled();
    let entry = entries.get(revision);
    if (!entry) {
      const controller = new AbortController();
      entry = {controller, readers:0};
      entries.set(revision, entry);
      const usable = () => scope.current() && entries.get(revision) === entry && !controller.signal.aborted;
      entry.work = (async () => {
        try {
          const bundle = await git.q("folderRevisions", {revisions:[revision]});
          if (!usable()) throw cancelled();
          const side = bundle.revisions?.find(item => item.revision === revision);
          if (!side || side.blob !== null && !objectId(side.blob)) throw Error("Git returned an invalid project revision.");
          // Even a missing manifest goes through the worker's legacy-format rejection.
          const value = await decodeCommit(bundle, revision, controller.signal);
          if (!usable()) throw cancelled();
          if (!value || value.blob !== side.blob) throw Error("Git returned a different project revision.");
          entry.value = value;
          entry.controller = null;
          entry.bytes = Object.values(bundle.objects || {}).reduce((sum, bytes) => sum + bytes.length, 0);
          if (entry.bytes > COMMIT_CACHE_BYTES) entries.delete(revision);
          const completed = [...entries].filter(([, item]) => item.value);
          let bytes = completed.reduce((sum, [, item]) => sum + item.bytes, 0);
          while (completed.length > COMMIT_CACHE_COUNT || bytes > COMMIT_CACHE_BYTES) {
            const [key, item] = completed.shift();
            entries.delete(key); bytes -= item.bytes;
          }
          return value;
        } catch (error) {
          if (entries.get(revision) === entry) entries.delete(revision);
          throw error;
        }
      })();
    }
    entry.readers++;
    try {
      const value = await new Promise((done, fail) => {
        const pendingSignal = entry.controller?.signal;
        const abort = () => finish(null, cancelled());
        function finish(value, error) {
          signal?.removeEventListener("abort", abort);
          pendingSignal?.removeEventListener("abort", abort);
          if (error) fail(error); else done(value);
        }
        signal?.addEventListener("abort", abort, {once:true});
        pendingSignal?.addEventListener("abort", abort, {once:true});
        entry.work.then(value => finish(value), error => finish(null, error));
        if (signal?.aborted || pendingSignal?.aborted) abort();
      });
      if (!valid()) throw cancelled();
      return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    } finally {
      entry.readers--;
      if (!entry.readers && entry.controller && entries.get(revision) === entry) {
        entries.delete(revision);
        entry.controller.abort();
      }
    }
  }
  G.addEventListener?.("atrium-git-binding", () => repository?.clear());

  function source(git) {
    const blobs = new Map(), generation = G.AtriumHost?.projectGeneration, host = G.AtriumHost;
    const binding = () => host?.historyPath || host?.folderGitGrant;
    const path = binding(), foreign = !!host?.historyPath, folder = !foreign && !!host?.folderGitGrant;
    const query = (op, args) => foreign ? host.historyQuery(op, args) : git.q(op, args);
    let worker = null, idle, closed = false, epoch = 0, folderKnown = [];
    const current = () => !closed && host === G.AtriumHost && generation === host?.projectGeneration && path === binding();
    function check(signal) {
      if (!current() || signal?.aborted) throw Error("Project history request cancelled.");
    }
    // The native transport has no cancel message. Drop queued requests immediately, ignore
    // stale completions and keep one more native slot available when the user changes rows.
    const pending = [];
    let inFlight = 0;
    function pumpReads() {
      while (inFlight < 2 && pending.length) {
        const job = pending.shift();
        if (job.signal.aborted || !current()) { job.abort(); continue; }
        inFlight++;
        Promise.resolve().then(() => { check(job.signal); return job.run(); }).then(job.done, job.fail).finally(() => {
          job.signal.removeEventListener("abort", job.abort);
          inFlight--; pumpReads();
        });
      }
    }
    function request(signal, run) {
      check(signal);
      return new Promise((done, fail) => {
        const job = {signal, run, done, fail, abort() {
          const i = pending.indexOf(job);
          if (i >= 0) pending.splice(i, 1);
          fail(Error("Project history request cancelled."));
        }};
        signal.addEventListener("abort", job.abort, {once:true});
        pending.push(job); pumpReads();
      });
    }
    function stopWorker() {
      clearTimeout(idle);
      worker?.terminate(); worker = null;
      folderKnown = [];
    }
    async function resolve(before, after, signal) {
      check(signal);
      const started = epoch;
      const verified = rev => folder ? commitBlob(rev) : undefined;
      const missing = [...new Set([before, after].filter(rev => rev && !blobs.has(rev) && verified(rev) === undefined))];
      if (missing.length) {
        const r = await request(signal, () => query("projectBlobs", {revisions: missing}));
        check(signal);
        if (epoch !== started) throw Error("The repository history changed. Refresh project history.");
        for (const rev of missing) {
          const blob = r.blobs?.[rev];
          if (blob !== null && !(typeof blob === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blob))) throw Error("Git returned an invalid project blob.");
          blobs.set(rev, blob);
        }
      }
      const blobAt = rev => {
        const value = verified(rev);
        return value === undefined ? blobs.get(rev) ?? null : value;
      };
      return [blobAt(before), blobAt(after)];
    }
    async function read(rev, blob, signal) {
      if (!blob) return null;
      const result = await request(signal, () => query("sourceRevision", {revision: rev}));
      check(signal);
      if (result.blob !== blob) throw Error("Git returned a different project blob. Refresh project history.");
      return result;
    }
    async function folderBundle(sides, signal) {
      clearTimeout(idle);
      const revisions = [...new Set(sides.filter(([rev, blob]) => rev && blob).map(([rev]) => rev))];
      const bundle = await request(signal, () => query("folderRevisions", {revisions, known: folderKnown}));
      check(signal);
      for (const [rev, blob] of sides) {
        if (blob && !bundle.revisions?.some(item => item.revision === rev && item.blob === blob)) {
          throw Error("Git returned a different project revision. Refresh project history.");
        }
      }
      return bundle;
    }
    function compute(message, signal) {
      check(signal);
      clearTimeout(idle);
      worker ??= G.AtriumWorkerPool.script(workerURL);
      return new Promise((done, fail) => {
        let watchdog;
        function finish(error, result) {
          signal.removeEventListener("abort", abort);
          clearTimeout(watchdog);
          if (error) { stopWorker(); fail(error); }
          else { idle = setTimeout(stopWorker, 5000); done(result); }
        }
        const abort = () => finish(Error("Project history request cancelled."));
        signal.addEventListener("abort", abort, {once: true});
        watchdog = setTimeout(() => finish(Error("The design summary timed out.")), 120000);
        worker.onmessage = e => {
          const result = e.data?.result;
          if (message.folder && result) folderKnown = result.known;
          finish(e.data?.error ? Error(e.data.error) : null, message.folder ? result?.value : result);
        };
        worker.onerror = () => finish(Error("The background comparison worker could not read this revision."));
        try { worker.postMessage({history: true, ...message}); } catch (e) { finish(e); }
      });
    }
    async function summary(commit, signal, region = 0) {
      const parent = commit.parents[0] || null;
      const [a, b] = await resolve(parent, commit.revision, signal);
      if (a === b && (!folder || !a)) return S.unchanged();
      const key = S.key(folder && a ? "folder:" + a : a, folder && b ? "folder:" + b : b, build, region), hit = await cached(key);
      check(signal);
      if (hit) return hit;
      if (folder) {
        const bundle = await folderBundle([[parent, a], [commit.revision, b]], signal);
        const result = await compute({folder: {bundle, before: a ? parent : null, after: b ? commit.revision : null, region}}, signal);
        check(signal);
        remember(key, result);
        return result;
      }
      const [left, right] = await Promise.all([read(parent, a, signal), read(commit.revision, b, signal)]);
      check(signal);
      const result = await compute({before: left, after: right, region, sources: true}, signal);
      check(signal);
      remember(key, result);
      return result;
    }
    async function project(revision, signal) {
      if (folder && revision) {
        check(signal);
        const expected = blobs.get(revision);
        const result = await readCommit(git, revision, {active:current, signal});
        if (expected !== undefined && result.blob !== expected)
          throw Error("Git returned a different project revision. Refresh project history.");
        return result;
      }
      const [, blob] = await resolve(null, revision, signal);
      if (!blob) return {blob: null, project: null};
      const data = await read(revision, blob, signal);
      const design = await compute({project: data}, signal);
      check(signal);
      return {blob, project: design, ...(data.missing?.length ? {unavailableLibraries: data.missing.length} : {})};
    }
    async function compare(before, after, signal, options = {}) {
      const [a, b] = await resolve(before?.revision, after.revision, signal);
      async function side(commit, blob) {
        const label = commit ? git.short(commit.revision) + " · " + commit.subject : "Before first commit";
        if (!blob) return {missing: true, label, project: S.empty()};
        return {label, ...await project(commit.revision, signal)};
      }
      const left = await side(before, a), right = await side(after, b);
      check(signal);
      return git.compare(left, right, {...options, active: () => current() && !signal.aborted});
    }
    return {summary, compare, project, resolve, query, refresh({commits = false} = {}) { epoch++; blobs.clear(); if (commits && folder) commitScope().clear(); }, available: () => foreign || git.available(), current, close() { closed = true; stopWorker(); blobs.clear(); }};
  }
  return Object.freeze({source, readCommit});
})();
