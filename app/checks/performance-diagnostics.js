"use strict";
globalThis.AtriumPerformanceDiagnostics = (() => {
  const G = globalThis;
  // Performance recording is opt-in. Durations are elapsed wall times on the monotonic
  // clock. Concurrent operations may overlap, and their durations should not be summed as CPU time.
  const COMPONENTS = "editor pcb schematic drawing panel 3d connectivity pours drc erc dfm insights routing library search notebook " +
    "history collaboration save autosave project import export manufacturing analysis extensions automation native ui workers idle settings";
  const OPERATIONS = "load command edit draw check compute request search save sync build publish idle fallback retry";
  const RENDER_STAGES = "retained-pan-text retained-pan-overlay retained-pan-draw retained-zoom-draw retained-zoom-overlay " +
    "retained-copy-draw retained-copy-overlay full-scope full-text full-band-paint " +
    "full-text-caption-occlusion full-text-upload full-text-readback full-coverage " +
    "full-coverage-paint full-coverage-upload full-coverage-readback full-overlay full-airwires full-draw";
  const PERFORMANCE_VERSION = 1, SAMPLE_LIMIT = 128, MAX_DURATION = 2 ** 40;
  const catalog = text => new Map(text.split(" ").map((name, index) => [name, index]));
  const range = () => ({samples: [], next: 0, percentile: null});
  const emptyCounts = () => ({queued: 0, started: 0, ready: 0, visible: 0, durable: 0, completed: 0, cancelled: 0, failed: 0});
  let session = null, generation = 0, components, operations, renderStages, durationBands, countBands;

  function performanceTime() {
    try {
      const clock = G.performance;
      const value = clock && Object.hasOwn(clock, "__waffleDiagnosticsNow")
        ? Reflect.get(clock, "__waffleDiagnosticsNow")?.() : clock?.now?.();
      if (Number.isFinite(value) && value >= 0) return value;
    } catch { /* the monotonic clock is unavailable */ }
    return null;
  }
  function sample(series, from, until) {
    if (from === null || until === null || until < from || until - from > MAX_DURATION) return;
    series.samples[series.next] = until - from;
    series.next = (series.next + 1) % SAMPLE_LIMIT;
    series.percentile = null;
  }
  function p95(series) {
    const {samples} = series;
    if (!samples.length || series.percentile !== null) return series.percentile;
    const sorted = samples.slice().sort((a, b) => a - b);
    series.percentile = sorted[Math.ceil(sorted.length * .95) - 1];
    return series.percentile;
  }
  const bounded = value => Number.isFinite(value) && value >= 0 && value <= MAX_DURATION;
  function bucket(value, {bounds, labels}) {
    const index = bounds.findIndex(bound => value < bound);
    return labels[index < 0 ? bounds.length : index];
  }
  function durationBucket(value) {
    if (!bounded(value)) return "not-measured";
    return bucket(value, durationBands ??= {bounds: [4, 8, 16, 33, 67],
      labels: ["under-4ms", "4-to-8ms", "8-to-16ms", "16-to-33ms", "33-to-67ms", "67ms-or-more"]});
  }
  function countBucket(value) {
    if (!Number.isSafeInteger(value) || !bounded(value)) return "unknown";
    return bucket(value, countBands ??= {bounds: [1, 5, 25, 100, 1000, 10000],
      labels: ["none", "1-to-4", "5-to-24", "25-to-99", "100-to-999", "1000-to-9999", "10000-or-more"]});
  }

  const activeSession = id => session?.id === id && session.leases > 0 ? session : null;
  const noop = () => {};
  function ownValue(source, key) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
  }
  function frameDuration(source, key) {
    const value = ownValue(source, key);
    return bounded(value) ? value : null;
  }
  function frameWheelTail(source, total) {
    if (total === null || total > 5000) return null;
    try {
      const tail = ownValue(source, "wheelTail");
      if (!tail || typeof tail !== "object") return null;
      const stampSource = ownValue(tail, "stampSource");
      if (stampSource !== "dom-event" && stampSource !== "native-wheel-replay") return null;
      const stampToHandlerMs = frameDuration(tail, "stampToHandlerMs");
      const handlerToDrawMs = frameDuration(tail, "handlerToDrawMs");
      const drawMs = frameDuration(tail, "drawMs");
      if (stampToHandlerMs === null || handlerToDrawMs === null || drawMs === null ||
          Math.abs(stampToHandlerMs + handlerToDrawMs + drawMs - total) > 1e-6) return null;
      return {stampSource, stampToHandlerMs, handlerToDrawMs, drawMs};
    } catch { return null; }
  }
  // The Frame Monitor owns the distribution and sample window. Keep only its latest summary.
  function publishFrame(id, source) {
    const state = activeSession(id);
    if (!state || !source || typeof source !== "object") return false;
    let frame;
    try {
      frame = {
        drawCpuP95: frameDuration(source, "drawCpuP95"),
        wheelToDrawP95: frameDuration(source, "wheelToDrawP95"),
        commitCpuP95: frameDuration(source, "commitCpuP95"),
        followUpCpuP95: frameDuration(source, "followUpCpuP95"),
        callbackIntervalP95: frameDuration(source, "callbackIntervalP95")
      };
    } catch { return false; }
    if (Object.values(frame).every(value => value === null)) return false;
    const wheelTail = frameWheelTail(source, frame.wheelToDrawP95);
    if (activeSession(id) !== state) return false;
    state.frame = frame;
    state.wheelTail = wheelTail;
    return true;
  }
  function changed(state) {
    const listeners = state.listeners;
    if (!listeners?.size || state.notifying) return;
    state.notifying = true;
    try {
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try { listener(); } catch { /* an observer cannot break editor work */ }
      }
    } finally { state.notifying = false; }
  }

  // Spans keep only a generation and a catalog key, with no references to an old session or app data.
  function createSpan(id, key, queued, enteredAt) {
    let phase = queued ? "queued" : "running", startedAt = queued ? null : enteredAt;
    function start() {
      const state = activeSession(id);
      if (!state || phase !== "queued") return false;
      startedAt = performanceTime();
      phase = "running";
      const row = state.rows.get(key);
      row.counts.started++;
      sample(row.queue, enteredAt, startedAt);
      changed(state);
      return true;
    }
    function end(outcome = "completed") {
      const state = activeSession(id);
      if (!state || phase === "ended") return false;
      if (outcome !== "visible" && outcome !== "durable" && outcome !== "completed" &&
        outcome !== "cancelled" && outcome !== "failed") return false;
      const at = performanceTime(), row = state.rows.get(key);
      if (phase === "queued") sample(row.queue, enteredAt, at);
      if (phase === "running") sample(row.run, startedAt, at);
      phase = "ended";
      row.counts[outcome]++;
      sample(row.endToEnd, enteredAt, at);
      changed(state);
      return true;
    }
    return {
      start,
      end,
      ready() {
        const state = activeSession(id);
        if (!state || phase !== "running") return false;
        phase = "ready";
        const row = state.rows.get(key);
        row.counts.ready++;
        sample(row.run, startedAt, performanceTime());
        changed(state);
        return true;
      },
      run(fn, ...args) {
        start();
        let result;
        try { result = fn(...args); }
        catch (error) { end("failed"); throw error; }
        end();
        return result;
      }
    };
  }
  function openSpan(id, component, operation, queued) {
    const state = activeSession(id);
    if (!state) return null;
    const group = state.components.get(component), kind = state.operations.get(operation);
    if (group === undefined || kind === undefined) return null;
    const key = group * state.operations.size + kind;
    const row = rowFor(state, key, component, operation);
    const span = createSpan(id, key, queued, performanceTime());
    row.counts[queued ? "queued" : "started"]++;
    changed(state);
    return span;
  }
  function rowFor(state, key, component, operation, diagnosticOnly = false) {
    let row = state.rows.get(key);
    if (!row) {
      row = {component, operation, diagnosticOnly, counts: emptyCounts(), queue: range(), run: range(), endToEnd: range()};
      state.rows.set(key, row);
    }
    return row;
  }
  function createRecorder(id) {
    return Object.freeze({
      begin(component, operation = "compute") { return openSpan(id, component, operation, false); },
      queue(component, operation = "compute") { return openSpan(id, component, operation, true); },
      get rendererStages() { return !!activeSession(id)?.stageLeases; },
      renderStage(operation, elapsed) {
        const state = activeSession(id);
        if (!state?.stageLeases || !bounded(elapsed)) return false;
        const stage = (renderStages ??= catalog(RENDER_STAGES)).get(operation);
        if (stage === undefined) return false;
        const key = state.components.size * state.operations.size + stage;
        const row = rowFor(state, key, "pcb", operation, true);
        row.counts.started++;
        row.counts.completed++;
        sample(row.run, 0, elapsed);
        return true;
      },
      frame(summary) { return publishFrame(id, summary); },
      resetFrame() {
        const state = activeSession(id);
        if (!state?.frame) return false;
        state.frame = null;
        state.wheelTail = null;
        return true;
      },
      onChange(listener) {
        const state = activeSession(id);
        if (!state || typeof listener !== "function") return noop;
        (state.listeners ??= new Set()).add(listener);
        return () => { activeSession(id)?.listeners?.delete(listener); };
      }
    });
  }
  function startPerformance(options) {
    const detailed = options?.rendererStages === true;
    if (!session?.leases) {
      const id = ++generation;
      session = {id, leases: 0, stageLeases: 0, rows: new Map(), frame: null, wheelTail: null,
        components: components ??= catalog(COMPONENTS), operations: operations ??= catalog(OPERATIONS),
        recorder: createRecorder(id), listeners: null, notifying: false};
    }
    const {id} = session;
    session.leases++;
    if (detailed) session.stageLeases++;
    let stopped = false;
    return Object.freeze({stop() {
      const state = activeSession(id);
      if (!state || stopped) return false;
      stopped = true;
      if (detailed) state.stageLeases--;
      if (--state.leases === 0) state.listeners?.clear();
      return true;
    }});
  }
  function performanceSnapshot({shareable = false} = {}) {
    const state = session, rows = [];
    if (state) {
      for (const [, row] of [...state.rows].sort(([a], [b]) => a - b)) {
        if (shareable === true && row.diagnosticOnly) continue;
        const {component, operation, counts} = row;
        const queueP95 = p95(row.queue), runP95 = p95(row.run), endToEndP95 = p95(row.endToEnd);
        rows.push({component, operation,
          counts: shareable === true ? Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, countBucket(n)])) : {...counts},
          queueP95: shareable === true ? durationBucket(queueP95) : queueP95,
          runP95: shareable === true ? durationBucket(runP95) : runP95,
          endToEndP95: shareable === true ? durationBucket(endToEndP95) : endToEndP95});
      }
    }
    const frame = state?.frame, wheelTail = state?.wheelTail;
    return {version: PERFORMANCE_VERSION, recording: !!state?.leases, rows, ...(frame && {
      frame: shareable === true ? Object.fromEntries(Object.entries(frame).map(([key, value]) => [key, durationBucket(value)])) :
        {...frame, ...(wheelTail && {wheelTail: {...wheelTail}})}
    })};
  }

  return Object.freeze({
    get performance() { return session?.leases ? session.recorder : null; },
    startPerformance,
    performanceSnapshot,
    durationBucket,
    countBucket,
  });
})();
