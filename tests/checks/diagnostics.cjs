"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function performanceRecorder(D) {
  const G = globalThis, oldClock = Object.getOwnPropertyDescriptor(G, "performance"), oldTimeout = G.setTimeout;
  let now = 100, clockReads = 0;
  Object.defineProperty(G, "performance", {configurable: true, value: {now() { clockReads++; return now; }}});
  G.setTimeout = () => assert.fail("the recorder must never schedule work");
  try {
    const off = {version: 1, recording: false, rows: []};
    assert.equal(D.performance, null);
    assert.deepEqual(D.performanceSnapshot(), off);
    assert.deepEqual(D.performanceSnapshot({shareable: true}), off);
    assert.equal(clockReads, 0, "an inactive recorder or snapshot never reads a clock");

    const monitor = D.startPerformance(), recorder = D.performance, qa = D.startPerformance();
    assert.equal(D.performance, recorder, "both leases share one recorder and one capture");
    assert.equal(clockReads, 0, "leases start without a clock read");
    let notices = 0, failingObserverCalls = 0;
    const unsubscribe = recorder.onChange(() => { notices++; D.performanceSnapshot(); });
    recorder.onChange(() => { failingObserverCalls++; throw new Error("observer failure"); });
    const privateMarker = "SYNTHETIC_PRIVATE_WORK_236";
    const privateObject = {toString() { assert.fail("an opaque object was coerced"); }, data: privateMarker};
    const noop = recorder.onChange(privateObject);
    noop();
    assert.equal(recorder.begin(privateMarker, "compute"), null);
    assert.equal(recorder.begin("pcb", privateObject), null);
    assert.equal(recorder.queue(privateObject, "draw"), null);
    assert.equal(recorder.queue("pcb", privateMarker), null);
    assert.equal(clockReads, 0, "invalid input never starts a span");
    assert.equal(notices, 0);

    const draw = recorder.queue("pcb", "draw", privateObject);
    now = 110;
    assert.equal(draw.ready(), false, "queued work cannot finish processing before it starts");
    assert.equal(draw.start(), true);
    assert.equal(draw.start(), false);
    now = 116;
    assert.equal(draw.ready(), true);
    assert.equal(draw.ready(), false);
    now = 123;
    assert.equal(draw.end(privateObject), false);
    assert.equal(draw.end(privateMarker), false);
    assert.equal(draw.end("visible"), true);
    assert.equal(draw.end("failed"), false);
    assert.equal(draw.start(), false);
    assert.equal(clockReads, 4, "each accepted transition reads one clock");
    assert.equal(notices, 4, "observers see each accepted transition once");
    const firstSnapshot = D.performanceSnapshot();
    assert.equal(firstSnapshot.version, 1);
    assert.deepEqual(firstSnapshot.rows[0], {component: "pcb", operation: "draw",
      counts: {queued: 1, started: 1, ready: 1, visible: 1, durable: 0, completed: 0, cancelled: 0, failed: 0},
      queueP95: 10, runP95: 6, endToEndP95: 23});
    const shareable = D.performanceSnapshot({shareable: true});
    assert.equal(shareable.version, 1);
    assert.equal(Object.hasOwn(shareable, "frame"), false, "rows alone provide no display measurement");
    assert.deepEqual(shareable.rows[0], {component: "pcb", operation: "draw",
      counts: {queued: "1-to-4", started: "1-to-4", ready: "1-to-4", visible: "1-to-4", durable: "none",
        completed: "none", cancelled: "none", failed: "none"},
      queueP95: "8-to-16ms", runP95: "4-to-8ms", endToEndP95: "16-to-33ms"});
    assert.equal(clockReads, 4);
    assert.equal(notices, 4, "snapshots do not trigger observers");
    assert.doesNotMatch(JSON.stringify([firstSnapshot, shareable]), /SYNTHETIC_PRIVATE_WORK_236/);
    firstSnapshot.rows[0].counts.visible = 100;
    assert.equal(D.performanceSnapshot().rows[0].counts.visible, 1, "the exact snapshot is detached from live counts");

    let frameReads = 0;
    const frameSource = Object.assign(Object.create({wheelToDrawP95: 43}), {
      drawCpuP95: 0, commitCpuP95: 5.22, callbackIntervalP95: 17.31, documentTitle: privateMarker,
      toJSON() { assert.fail("the original summary must not be retained"); }
    });
    Object.defineProperty(frameSource, "followUpCpuP95", {get() { frameReads++; return 9; }});
    const exactFrame = {drawCpuP95: 0, wheelToDrawP95: null, commitCpuP95: 5.22,
      followUpCpuP95: null, callbackIntervalP95: 17.31};
    assert.equal(recorder.frame(frameSource), true);
    assert.equal(recorder.frame(null), false);
    assert.equal(recorder.frame({drawCpuP95: null}), false);
    assert.equal(recorder.frame({drawCpuP95: Infinity, callbackIntervalP95: 1795618999000, commitCpuP95: privateObject}), false);
    const revoked = Proxy.revocable({drawCpuP95: 20}, {});
    revoked.revoke();
    assert.equal(recorder.frame(revoked.proxy), false);
    frameSource.drawCpuP95 = 55;
    const frameSnapshot = D.performanceSnapshot();
    assert.deepEqual(frameSnapshot.frame, exactFrame);
    frameSnapshot.frame.commitCpuP95 = -1;
    assert.deepEqual(D.performanceSnapshot({shareable: true}).frame, {
      drawCpuP95: "under-4ms", wheelToDrawP95: "not-measured", commitCpuP95: "4-to-8ms",
      followUpCpuP95: "not-measured", callbackIntervalP95: "16-to-33ms"
    });
    const wheelTail = {stampSource: "native-wheel-replay", stampToHandlerMs: 31, handlerToDrawMs: 2, drawMs: 1};
    const sourceTail = {...wheelTail, sourceStamp: 1795618999000, canvas: privateObject};
    assert.equal(recorder.frame({wheelToDrawP95: 34, wheelTail: sourceTail}), true);
    sourceTail.drawMs = 80;
    const capturedTail = D.performanceSnapshot().frame.wheelTail;
    assert.deepEqual(capturedTail, wheelTail, "only the paired elapsed times and fixed source survive");
    capturedTail.drawMs = 40;
    assert.deepEqual(D.performanceSnapshot().frame.wheelTail, wheelTail, "exact wheel details are detached");
    const publicFrame = D.performanceSnapshot({shareable:true}).frame;
    assert.equal(publicFrame.wheelToDrawP95, "33-to-67ms");
    assert.equal(Object.hasOwn(publicFrame, "wheelTail"), false, "the support file keeps its existing wheel field only");
    assert.equal(recorder.frame({wheelToDrawP95: 34, wheelTail: {...wheelTail, drawMs: 2}}), true);
    assert.equal(D.performanceSnapshot().frame.wheelTail, undefined, "a mismatched set of timings is omitted");
    assert.equal(recorder.frame({wheelToDrawP95: 34, wheelTail: {...wheelTail,
      get drawMs() { frameReads++; return 1; }}}), true);
    assert.equal(D.performanceSnapshot().frame.wheelTail, undefined);
    assert.equal(recorder.frame({wheelToDrawP95: 34, wheelTail: {...wheelTail, stampSource: privateMarker}}), true);
    assert.equal(D.performanceSnapshot().frame.wheelTail, undefined, "private or unknown provenance is omitted");
    assert.deepEqual(D.performanceSnapshot({shareable:true}).frame, publicFrame);
    assert.equal(frameReads, 0, "frame payload getters and inherited fields are ignored");
    assert.equal(recorder.resetFrame(), true);
    assert.equal(recorder.resetFrame(), false);
    assert.equal(D.performanceSnapshot().frame, undefined);
    assert.equal(D.performanceSnapshot({shareable: true}).frame, undefined);
    assert.equal(clockReads, 4, "frame publication and projection avoid the clock");
    assert.equal(notices, 4, "frame publication and projection avoid observer notifications");
    const lastFrame = {...exactFrame, drawCpuP95: null, wheelToDrawP95: 4, commitCpuP95: null,
      callbackIntervalP95: null};
    assert.equal(recorder.frame({wheelToDrawP95: 4}), true);
    assert.deepEqual(D.performanceSnapshot().frame, lastFrame, "the latest summary replaces earlier metrics");

    now = 130;
    const replaced = recorder.queue("pcb", "draw");
    now = 144;
    replaced.end("cancelled");
    assert.equal(D.performanceSnapshot().rows[0].queueP95, 14, "cancellation while queued records its wait");
    assert.equal(D.performanceSnapshot().rows[0].runP95, 6, "cancellation while queued supplies no run sample");

    now = 150;
    const save = recorder.begin("save", "save");
    now = 155;
    save.ready();
    now = 190;
    save.end("durable");
    now = 200;
    const a = recorder.begin("drc");
    now = 204;
    const b = recorder.begin("drc");
    now = 209;
    a.end();
    now = 214;
    b.end("failed");
    assert.deepEqual(D.performanceSnapshot().rows.map(row => [row.component, row.operation]), [
      ["pcb", "draw"], ["drc", "compute"], ["save", "save"]
    ], "rows are ordered by the fixed catalog");
    const rows = D.performanceSnapshot().rows;
    assert.deepEqual(rows[1], {component: "drc", operation: "compute",
      counts: {queued: 0, started: 2, ready: 0, visible: 0, durable: 0, completed: 1, cancelled: 0, failed: 1},
      queueP95: null, runP95: 10, endToEndP95: 10}, "overlap is recorded as independent elapsed spans");
    assert.deepEqual(rows[2], {component: "save", operation: "save",
      counts: {queued: 0, started: 1, ready: 1, visible: 0, durable: 1, completed: 0, cancelled: 0, failed: 0},
      queueP95: null, runP95: 5, endToEndP95: 40}, "durability can arrive after processing is ready");

    now = NaN;
    const missing = recorder.queue("native", "request");
    now = -2;
    missing.start();
    now = Infinity;
    missing.ready();
    now = 250;
    missing.end("failed");
    const last = D.performanceSnapshot().rows.at(-1);
    assert.equal(last.counts.failed, 1);
    assert.deepEqual([last.queueP95, last.runP95, last.endToEndP95], [null, null, null], "invalid clock samples stay missing");

    assert.equal(monitor.stop(), true);
    assert.equal(monitor.stop(), false);
    assert.equal(D.performance, recorder, "QA keeps recording after Frame Monitor closes");
    unsubscribe();
    const noticesBeforeStop = notices;
    const stale = recorder.queue("pcb", "draw");
    assert.equal(notices, noticesBeforeStop, "an unsubscribed observer stays quiet");
    assert.equal(qa.stop(), true);
    assert.equal(D.performance, null);
    const listenerCallsAtStop = failingObserverCalls;
    const retained = D.performanceSnapshot();
    const clockBeforeStale = clockReads;
    assert.equal(retained.recording, false);
    assert.deepEqual(retained.frame, lastFrame, "the last valid producer sample remains after close");
    assert.equal(stale.end("cancelled"), false);
    assert.equal(recorder.begin("pcb", "draw"), null);
    assert.equal(recorder.frame({drawCpuP95: 1}), false);
    assert.deepEqual(D.performanceSnapshot(), retained);
    assert.equal(clockReads, clockBeforeStale, "closed scopes have no timing cost even with outstanding handles");

    const next = D.startPerformance(), resumed = D.performance;
    assert.notEqual(resumed, recorder);
    assert.deepEqual(D.performanceSnapshot(), {version: 1, recording: true, rows: []}, "a new recording resets the retained capture");
    assert.equal(recorder.frame({drawCpuP95: 5}), false, "a stale frame producer cannot write into a later capture");
    assert.equal(resumed.frame({drawCpuP95: 36}), true);
    assert.equal(recorder.resetFrame(), false, "a stale frame producer cannot clear a later capture");
    assert.equal(D.performanceSnapshot().frame.drawCpuP95, 36);
    assert.equal(stale.start(), false);
    assert.equal(qa.stop(), false);
    now = 300;
    for (let i = 0; i < 148; i++) {
      const work = resumed.queue("workers", "retry");
      now += i < 20 ? 100 : 3;
      work.start();
      now += i < 20 ? 100 : 4;
      work.end();
      if (i === 19) {
        const early = D.performanceSnapshot().rows[0];
        assert.deepEqual([early.queueP95, early.runP95, early.endToEndP95], [100, 100, 200]);
        assert.deepEqual(D.performanceSnapshot().rows[0], early, "an unchanged phase keeps the same percentile");
      }
    }
    resumed.begin("workers", "fallback").end();
    const bounded = D.performanceSnapshot().rows[1];
    assert.equal(bounded.operation, "retry");
    assert.equal(bounded.counts.completed, 148, "counts include the full recording");
    assert.deepEqual([bounded.queueP95, bounded.runP95, bounded.endToEndP95], [3, 4, 7], "p95 uses only the latest 128 samples");
    assert.equal(notices, noticesBeforeStop);
    assert.equal(failingObserverCalls, listenerCallsAtStop, "a prior session's observer does not run in the next recording");
    next.stop();

    const sync = D.startPerformance(), syncRecorder = D.performance;
    now = 5000;
    const work = syncRecorder.queue("editor", "edit");
    const promise = Promise.resolve("result");
    now = 5011;
    let calls = 0;
    assert.equal(work.run((left, right) => {
      calls++;
      assert.equal(left + right, 23, "run passes arguments to the original function");
      now = 5016;
      return promise;
    }, 11, 12), promise, "run preserves promise identity and does not wait for settlement");
    const thrown = {message: "original failure"};
    now = 5020;
    const alreadyStarted = syncRecorder.begin("editor", "command");
    assert.throws(() => alreadyStarted.run(() => {
      calls++;
      now = 5026;
      throw thrown;
    }), error => error === thrown, "run rethrows the original synchronous failure");
    assert.equal(calls, 2);
    const [command, edit] = D.performanceSnapshot().rows;
    assert.deepEqual([edit.counts.started, edit.counts.completed, edit.queueP95, edit.runP95, edit.endToEndP95],
      [1, 1, 11, 5, 16]);
    assert.deepEqual([command.counts.started, command.counts.failed, command.queueP95, command.runP95],
      [1, 1, null, 6]);
    const pending = syncRecorder.queue("editor", "edit");
    sync.stop();
    const stoppedClockReads = clockReads, stoppedSnapshot = D.performanceSnapshot();
    assert.equal(pending.run(value => { calls++; return value; }, undefined), undefined);
    assert.equal(calls, 3, "a stale span runs ordinary work exactly once");
    assert.equal(clockReads, stoppedClockReads, "a stale span performs no timing");
    assert.deepEqual(D.performanceSnapshot(), stoppedSnapshot, "a stale span cannot modify the retained snapshot");

    const ordinary = D.startPerformance(null), renderer = D.performance;
    assert.equal(renderer.rendererStages, false);
    const textStages = [["full-text", 11], ["full-text-caption-occlusion", 4], ["full-text-upload", 9], ["full-text-readback", 0]];
    for (const [name, elapsed] of textStages) assert.equal(renderer.renderStage(name, elapsed), false);
    renderer.begin("pcb", "draw").end("visible");
    const publicBefore = D.performanceSnapshot({shareable:true});
    const stagesClockReads = clockReads, detailed = D.startPerformance({rendererStages:true});
    assert.equal(D.performance, renderer, "the detailed lease augments the ordinary recording");
    assert.equal(renderer.rendererStages, true);
    assert.equal(renderer.renderStage("private-board-stage", 11), false, "renderer stage names are closed");
    for (const [name, elapsed] of textStages) assert.equal(renderer.renderStage(name, elapsed), true);
    const [drawRow, ...stages] = D.performanceSnapshot().rows;
    assert.equal(drawRow.operation, "draw");
    assert.deepEqual(stages.map(row => [row.operation, row.runP95, row.counts.completed]),
      textStages.map(([name, elapsed]) => [name, elapsed, 1]));
    assert.deepEqual(D.performanceSnapshot({shareable:true}), publicBefore);
    assert.equal(detailed.stop(), true);
    assert.equal(D.performance, renderer, "the remaining ordinary lease stays active");
    assert.equal(renderer.rendererStages, false);
    assert.equal(renderer.renderStage("full-text", 12), false, "stage collection stops immediately");
    assert.equal(D.performanceSnapshot().rows[1].counts.completed, 1, "the final exact sample remains readable");
    assert.equal(clockReads, stagesClockReads, "renderer stage publication and projection need no recorder clocks");
    ordinary.stop();
    const later = D.startPerformance({rendererStages:true});
    assert.equal(renderer.rendererStages, false, "a stale recorder does not see the later lease");
    assert.equal(renderer.renderStage("full-text", 20), false);
    assert.deepEqual(D.performanceSnapshot().rows, []);
    later.stop();
  } finally {
    if (oldClock) Object.defineProperty(G, "performance", oldClock);
    else delete G.performance;
    G.setTimeout = oldTimeout;
  }
}

async function main() {
  const G = globalThis, HANDLERS = new Map(), writes = [], reads = [], infos = [], privateReads = [];
  const source = file => fs.readFileSync(path.join(__dirname, "../..", file), "utf8");
  const legacy = "atrium-diagnostics-v1", oldCounts = "atrium-diagnostics-counts-v1", key = "atrium-diagnostics-counts-v2";
  const day = 86400000, firstDay = 20782;
  let wall = firstDay * day + day - 1, unavailable = false;
  Date.now = () => wall;
  const marker = "PRIVATE_MARKER_48B1", privatePath = "file:///fixtures/example/" + marker + ".waffle";
  const oldRows = [{at: wall - 6 * day, kind: "hang", type: marker, module: privatePath},
    {at: wall - 7 * day, kind: "error"}, {at: wall + 1, kind: "error"}, {at: "invalid", kind: "error"},
    {at: wall, kind: marker, module: privatePath}];
  const storage = new Map([[legacy, JSON.stringify(oldRows)],
    [oldCounts, JSON.stringify({workerTimeouts: 17, javascriptErrors: 32, autosaveFailures: 999999,
      scriptLoadFailures: privatePath, extra: marker, toJSON: marker})]]);
  G.addEventListener = (kind, fn) => HANDLERS.set(kind, fn);
  Object.defineProperty(G, "localStorage", {configurable: true, value: {
    getItem(k) { if (unavailable) throw Error("Storage unavailable"); reads.push(k); return storage.get(k) ?? null; },
    setItem(k, v) { if (unavailable) throw Error("Storage unavailable"); writes.push([k, v]); storage.set(k, v); },
    removeItem(k) { if (unavailable) throw Error("Storage unavailable"); storage.delete(k); }
  }});
  const privateGetter = () => { privateReads.push(true); throw new Error(marker); };
  let failureClock = 100;
  Object.defineProperty(G, "performance", {configurable: true, value: {now: () => failureClock}});
  G.ErrorEvent = class {
    constructor(message, error = null) { this.message = message; this.error = error; }
    get filename() { return privateGetter(); }
  };
  Object.defineProperty(G, "navigator", {configurable: true, value: {
    get userAgent() { return privateGetter(); },
    get hardwareConcurrency() { return privateGetter(); }
  }});
  G.document = {querySelector: selector => selector === 'meta[name="application-version"]' ? {content: "0.8.1"} : null};
  G.AtriumNavHost = {info: m => infos.push(m), doc: privateGetter, project: privateGetter,
    viewportDiagnostics: () => ({kind: "pcb", presentation: "foreground", width: 1234, height: 881, path: privatePath, title: marker,
      gpu: {state: "context-lost", contexts: 2, losses: 1, activeBytes: 55 * 1048576, parkedScenes: 0, warmupPending: true,
        work: {frames: 7351, gridBufferAllocations: 2, driverFenceSubmissions: 0, driverMemoryChecks: 61, gestureScale: 9876.456,
          get extra() { return privateGetter(); }, label: marker},
        device: marker, renderer: privatePath, coordinates: [111235.876, 644931.113], toJSON: privateGetter}})};
  G.AtriumCanvasGPUPref = {diagnosticState: () => ({preference: "auto", capability: "software", device: marker,
    reason: privatePath, get exception() { return privateGetter(); }})};
  G.AtriumPower = {visible: () => true, efficient: () => false, state: privateGetter};
  G.AtriumFrameMonitor = {get diagnosticSample() { return privateGetter(); }};
  G.AtriumPrefs = {all: privateGetter};
  G.AtriumUndoStore = {stats: privateGetter};
  G.AtriumHost = {crashHistory: privateGetter, inputDiagnostics: privateGetter, supportDiagnostics: async () => ({
    platform: "macos", architecture: "arm64", displayCount: "two",
    rendererTerminations: {exited: 0, unresponsive: 3, browserExited: "no" + marker, memoryLimit: 32, terminated: 1,
      trace: privatePath}, date: 1795665432100, nativeStack: privatePath, toJSON: privateGetter
  })};
  G.devicePixelRatio = 1.54;
  new Function(source("app/checks/performance-diagnostics.js"))();
  new Function(source("app/checks/diagnostics.js"))();
  new Function(source("app/project/recover.js"))();
  new Function(source("app/canvas/input-diagnostics.js"))();
  let D = G.AtriumDiagnostics;
  assert.deepEqual(reads, [], "starting diagnostics does not read its storage");
  assert.deepEqual(writes, [], "starting diagnostics does not write its storage");

  const thrown = {get stack() { return privateGetter(); }, get message() { return privateGetter(); }};
  const errorEvent = HANDLERS.get("error"), muted = () => errorEvent(new G.ErrorEvent("Script error."));
  assert.equal(D.failures().workerTimeouts, 1, "only eligible dated legacy failures are imported");
  assert.equal(storage.has(legacy), false, "migration removes the old detailed log");
  assert.equal(storage.has(oldCounts), false, "undated totals cannot be assigned a retention day");
  muted();
  assert.equal(D.failures().javascriptErrors, 1, "a desktop muted Script error counts without a handled exception");
  D.failed(thrown);
  errorEvent(new G.ErrorEvent("Uncaught", thrown));
  failureClock += 999;
  muted();
  assert.equal(D.failures().javascriptErrors, 2, "the muted echo of a recently handled failure is skipped");
  failureClock++;
  muted();
  errorEvent(new G.ErrorEvent("ResizeObserver loop completed with undelivered notifications."));
  errorEvent({target: {localName: "img"}, error: null});
  HANDLERS.get("error")({target: {localName: "script", get src() { return privateGetter(); }}});
  HANDLERS.get("unhandledrejection")({reason: {name: marker, get stack() { return privateGetter(); }}});
  HANDLERS.get("unhandledrejection")({reason: {cancelled: true, message: marker}});
  HANDLERS.get("unhandledrejection")({reason: {name: "AbortError", message: marker}});
  D.autosaveFailure({name: "quota", data: marker});
  D.autosaveFailure("quota");
  assert.equal(D.record("worker", {toString: () => "known-worker", privatePath}), true);
  assert.equal(D.record("hang", privatePath), true);
  assert.equal(D.record({toString: () => "worker", privatePath}, marker), false);
  assert.equal(infos.length, 1, "a burst of editor failures shows one notice");
  assert.match(infos[0], /Help › Troubleshooting › Crash Diagnostics/);

  const expected = {javascriptErrors: 3, unhandledRejections: 1, scriptLoadFailures: 1, autosaveFailures: 1,
    workerFailures: 1, workerTimeouts: 2};
  assert.deepEqual(D.failures(), expected);
  assert.ok(writes.every(([k, v]) => k === key && !v.includes(marker) && !v.includes("Users") &&
    JSON.parse(v).days.every(([number, fields]) => Number.isInteger(number) &&
      Object.keys(fields).every(name => Object.hasOwn(expected, name)))));
  assert.equal(reads.filter(name => name === legacy).length, 1);
  const before = writes.length;
  const frameLease = D.startPerformance();
  assert.equal(D.performance.frame({drawCpuP95: 7.443, wheelToDrawP95: 23.334,
    commitCpuP95: 3.739, followUpCpuP95: 14.119, callbackIntervalP95: 42.681, date: 1795665432100,
    displayPresentedFps: 241.093, camera: marker, get extra() { return privateGetter(); }}), true);
  const report = await G.AtriumRecover.report();
  assert.deepEqual(JSON.parse(report), {
    format: "waffle-diagnostics", schemaVersion: 1, applicationVersion: [0, 8, 1],
    host: {kind: "desktop", platform: "macos", architecture: "arm64", availableDisplays: "two"},
    viewport: {kind: "pcb", presentation: "foreground", windowVisible: true, efficiencyActive: false, cssArea: "medium", pixelRatio: "near-1.5"},
    boardRenderer: {preference: "auto", webgl2: "software", renderState: "context-lost", retainedContexts: "two-to-four",
      contextLosses: "one", warmupPending: true, activeParkedScenes: "none", activeEstimatedGpuBytes: "32-to-128MiB",
      activeViewWork: {scope: "active-pcb-gpu-view", frames: "1000-to-9999", gridBufferAllocations: "1-to-4",
        driverFenceSubmissions: "none", driverMemoryChecks: "25-to-99"}},
    performance: {canvasMainThreadP95: "4-to-8ms", controlWheelToDrawP95: "16-to-33ms", editCommitMainThreadP95: "under-4ms",
      editFollowUpMainThreadP95: "8-to-16ms", animationCallbackIntervalP95: "33-to-67ms",
      displayPresentedFps: "not-measured", systemCpuUtilization: "not-measured", activity: {version: 1, recording: true, rows: [],
        frame: {drawCpuP95: "4-to-8ms", wheelToDrawP95: "16-to-33ms", commitCpuP95: "under-4ms",
          followUpCpuP95: "8-to-16ms", callbackIntervalP95: "33-to-67ms"}}},
    recordedEditorFailures: {javascriptErrors: "two-to-four", unhandledRejections: "one", scriptLoadFailures: "one",
      autosaveFailures: "one", workerFailures: "one", workerTimeouts: "two-to-four"},
    rendererTerminations: {exited: "none", unresponsive: "two-to-four", browserExited: "unknown",
      memoryLimit: "five-or-more", terminated: "one"}
  });
  assert.doesNotMatch(report, /PRIVATE_MARKER|\/Users\/|1795665432100|111235|1234|881|7\.443|23\.334|7351|9876\.456/);
  assert.doesNotMatch(report, /3\.739|14\.119|42\.681|241\.093/);
  assert.doesNotMatch(report, new RegExp(String(firstDay)), "the report carries no UTC day buckets");
  assert.equal(writes.length, before, "previewing does not write storage");
  frameLease.stop();

  const diagnosticLease = D.startPerformance();
  assert.equal(D.performance.begin(marker, "check"), null);
  assert.equal(D.performance.begin("drc", privatePath), null);
  const calculation = D.performance.begin("drc", "check", {privatePath, title: marker});
  assert.equal(calculation.end(marker), false);
  assert.equal(calculation.end("visible"), true);
  assert.equal(D.performance.frame({drawCpuP95: -2, wheelToDrawP95: marker,
    commitCpuP95: privatePath, get followUpCpuP95() { return privateGetter(); },
    callbackIntervalP95: 1795665432100, displayPresentedFps: marker}), false);
  const recordedReport = await G.AtriumRecover.report();
  const activityReport = JSON.parse(recordedReport).performance.activity;
  assert.deepEqual(activityReport, D.performanceSnapshot({shareable: true}));
  assert.equal(activityReport.rows.length, 1, "the report uses only the shared recorder's allowlisted rows");
  assert.equal(activityReport.rows[0].counts.visible, "1-to-4");
  assert.doesNotMatch(recordedReport, /PRIVATE_MARKER|\/Users\//);
  diagnosticLease.stop();

  G.AtriumHost.supportDiagnostics = async () => ({platform: privatePath, architecture: marker, displayCount: marker,
    rendererTerminations: {memoryLimit: 1795665432100, get terminated() { return privateGetter(); }}});
  G.AtriumNavHost.viewportDiagnostics = () => ({kind: "pcb", presentation: marker, width: Infinity, height: marker,
    gpu: {state: marker, contexts: 1e12, activeBytes: Infinity, warmupPending: {}, work: privatePath,
      get losses() { return privateGetter(); }}});
  G.AtriumCanvasGPUPref.diagnosticState = () => Object.create({preference: "auto", capability: marker});
  G.AtriumPower.visible = () => marker;
  G.document.querySelector = () => ({content: "0.8.1-" + marker});
  const rejected = await G.AtriumRecover.report(), projected = JSON.parse(rejected);
  assert.doesNotMatch(rejected, /PRIVATE_MARKER|\/Users\//);
  assert.equal(projected.applicationVersion, null);
  assert.deepEqual(projected.host, {kind: "desktop", platform: "unknown", architecture: "unknown", availableDisplays: "unknown"});
  assert.deepEqual(projected.viewport, {kind: "pcb", presentation: "unknown", windowVisible: null, efficiencyActive: false,
    cssArea: "unknown", pixelRatio: "near-1.5"});
  assert.deepEqual(projected.boardRenderer, {preference: "unknown", webgl2: "unknown", renderState: "unknown",
    retainedContexts: "unknown", contextLosses: "unknown", warmupPending: null, activeParkedScenes: "unknown", activeEstimatedGpuBytes: "unknown",
    activeViewWork: {scope: "not-applicable", frames: "not-applicable", gridBufferAllocations: "not-applicable",
      driverFenceSubmissions: "not-applicable", driverMemoryChecks: "not-applicable"}});
  const {activity, ...measurements} = projected.performance;
  assert.deepEqual(activity, {...activityReport, recording: false}, "the report includes retained results when recording is off");
  assert.ok(Object.values(measurements).every(value => value === "not-measured"));
  assert.ok(Object.values(projected.rendererTerminations).every(value => value === "unknown"));

  delete G.AtriumFrameMonitor;
  G.AtriumLazy = {need: privateGetter};
  G.AtriumIdle = {sampleFrame: privateGetter, cancelSample: privateGetter};
  G.requestAnimationFrame = privateGetter;
  const unopened = JSON.parse(await G.AtriumRecover.report());
  G.AtriumNavHost.registerAction = () => {};
  new Function(source("app/canvas/frame-monitor.js"))();
  assert.equal(Object.hasOwn(G.AtriumFrameMonitor, "diagnosticSample"), false, "Frame Monitor exports no parallel summary");
  assert.equal(G.__waffleFrameTrace, undefined);
  const closedMonitor = JSON.parse(await G.AtriumRecover.report());
  assert.deepEqual(unopened.performance, projected.performance, "a missing monitor stays unloaded and unmeasured");
  assert.deepEqual(closedMonitor.performance, projected.performance, "reading a closed monitor does not start sampling");

  const input = G.AtriumInputDiagnostics.text({screens: [{name: marker}], os: marker,
    rows: [{event: "NSTouch began", source: "touch (direct)", route: "touch scheme", count: 2, detail: marker},
      {event: marker, source: privatePath, route: marker}]},
  [{type: "pointerdown", pointer: "touch", from: "host touch", taken: true, drag: marker},
    {type: marker, pointer: marker, from: privatePath}]);
  assert.match(input, /NSTouch began ×2.*touch \(direct\).*touch scheme/);
  assert.match(input, /pointerdown.*touch.*host touch.*taken/);
  assert.doesNotMatch(input, /PRIVATE_MARKER|\/Users\//);
  assert.deepEqual(privateReads, [], "private property traps were never accessed");

  new Function(source("app/checks/performance-diagnostics.js"))();
  const sibling = D;
  storage.set(legacy, JSON.stringify(oldRows));
  new Function(source("app/checks/diagnostics.js"))();
  D = G.AtriumDiagnostics;
  assert.deepEqual(D.failures(), expected, "bounded safe counts survive a reload");
  assert.equal(storage.has(legacy), false, "a valid v2 store also removes old detailed data without re-importing it");
  wall++;
  assert.equal(D.failures().workerTimeouts, 1, "the oldest UTC day expires at the midnight boundary");
  for (let n = 0; n < 200; n++) D.record("hang", marker);
  assert.equal(D.failures().workerTimeouts, 32, "recorded counts saturate");
  const saturatedWrites = writes.length;
  D.record("hang");
  assert.equal(writes.length, saturatedWrites, "a saturated counter does not write storage");
  const saturated = {writes: writes.length, reads: reads.length};
  performanceRecorder(D);
  assert.deepEqual({writes: writes.length, reads: reads.length}, saturated, "performance never reads or writes storage");
  const zero = Object.fromEntries(Object.keys(expected).map(field => [field, 0]));
  const stale = storage.get(key);
  sibling.failures(); // Another page has already read these nonzero counts.
  D.clearFailures();
  assert.deepEqual(D.failures(), zero);
  assert.deepEqual(sibling.failures(), zero, "an open sibling observes the clear");
  storage.set(key, stale); // A write begun before the clear arrived afterward.
  assert.deepEqual(sibling.failures(), zero, "a late pre-clear write cannot restore cleared counts");
  sibling.record("worker");
  assert.equal(D.failures().workerFailures, 1, "new failures are recorded after clearing");
  unavailable = true;
  D.record("worker");
  assert.equal(D.failures().workerFailures, 2, "failures still count in memory when storage is unavailable");
  D.clearFailures();
  assert.deepEqual(D.failures(), zero, "clear works in memory while the store is unavailable");
  unavailable = false;
  assert.deepEqual(D.failures(), zero, "recovering storage cannot undo a local clear");
  D.record("hang");
  wall += 7 * day;
  assert.deepEqual(D.failures(), zero, "even the newest UTC bucket expires after seven days");
  storage.set(key, "{malformed" + marker);
  storage.set(legacy, JSON.stringify(oldRows));
  new Function(source("app/checks/diagnostics.js"))();
  assert.deepEqual(G.AtriumDiagnostics.failures(), zero, "a malformed aggregate is safely discarded");
  assert.equal(storage.has(legacy), false);
  console.log("diagnostics: fixed schema, privacy, bounded persistence and opt-in elapsed performance recorder OK");
}
globalThis.__testDone = main();
globalThis.__testDone.catch(e => { console.error(e); process.exitCode = 1; });
