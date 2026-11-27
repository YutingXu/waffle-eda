"use strict";

// Signed WKWebView counterpart of the browser view-feel probes. Use a real
// folder project, the existing AppKit input driver, and no timed readbacks.
globalThis.__uiProbes = {async run(only, config) {
  try { return "LABEL_FEEL " + JSON.stringify(await nativeLabelFeel(config)); }
  catch (error) { return "JSERROR LABEL_FEEL: " + error.message + "\n" + error.stack; }
}};

async function nativeLabelFeel({display, hz, repetitions, lowPower, layerMode, crossView, settleMs, drawWork}) {
  const H = AtriumNavHost, W = window;
  const [C, G, M] = await AtriumLazy.need(["AtriumCamera", "AtriumCanvasGPU", "AtriumMotion", "AtriumCanvasInput"]);
  const post = (op, args = {}) => webkit.messageHandlers.harness.postMessage({op, ...args});
  const now = () => performance.now();
  const pause = ms => new Promise(resolve => W.__rawTimeout(resolve, ms));
  const frame = () => new Promise(resolve => W.__rawRAF(resolve));
  const check = (condition, message) => { if (!condition) throw Error(message); };
  async function until(test, message) {
    const deadline = now() + 8000;
    for (;;) {
      const value = test();
      if (value) return value;
      if (now() >= deadline) throw Error(typeof message === "function" ? message() : message);
      await pause(15);
    }
  }
  const displayOK = state => state.displayID === display && (hz === null || state.displayHz === hz) &&
    state.requestedDisplayMatched && state.wheelEventBindingSupported &&
    state.orderedOnScreen && document.visibilityState === "visible" &&
    (drawWork && state.screenLocked === true || state.windowVisible && state.windowKey && state.appActive && state.screenLocked !== true);
  await post("feel-state"); // Move this test window to its requested monitor before checking focus.
  await post("focusWindow");
  const native = await post("feel-state");
  check(displayOK(native), "Native display or window visibility mismatch: " + JSON.stringify(native));

  const board = await until(() => H.documentRefs().find(doc => doc.kind === "pcb"), "Saved folder has no PCB");
  if (H.doc()?.id !== board.id) {
    const id = CSS.escape(board.id);
    const tab = await until(() => document.querySelector('#document-tabs [data-tab="' + id + '"], #documents [data-doc="' + id + '"]'),
      "PCB tab missing");
    const r = tab.getBoundingClientRect();
    await post("mouse", {x: r.left + r.width / 2, y: r.top + r.height / 2});
  }
  await until(() => H.doc()?.id === board.id && H.doc().items.length, "Saved PCB is not active");
  const doc = H.doc(), v = H.view(), canvas = H.canvas(), I = v.internals(), defs = H.defs();
  const checkBoard = at => {
    check(H.doc() === doc && !canvas.inert && !canvas.parentElement.querySelector(":scope > .doc-view:not([hidden])") &&
      !document.querySelector("dialog[open]") &&
      (!at || document.elementFromPoint(...at) === canvas), "PCB canvas is covered or inactive");
  };
  checkBoard();
  check(G.resourceCounters, "This harness needs a build with PCB GPU diagnostics");
  const counters = () => G.resourceCounters(I);
  const exact = sample => sample?.renderState === "gpu" && sample.exactCamera && !sample.slicing;
  async function waitExact() {
    let frames = null, since = now();
    await until(() => {
      const sample = counters();
      if (moving || M.active() || !exact(sample) || sample.frames !== frames) {
        frames = sample?.frames;
        since = now();
        return false;
      }
      return now() - since >= 150;
    }, "GPU did not submit a stable exact camera");
  }
  const physical = await post("power"), priorPower = AtriumPower.state();
  if (lowPower) AtriumPower.host({...priorPower, lowPower: true});
  C.setPref("camera.animate", true);
  C.setPref("mouse.wheel", "zoom");
  C.setPref("mouse.zoomAt", "pointer");
  const normalRenderer = G.status(I);
  G.enable(true);
  H.redraw(true);
  try {
    await until(() => counters()?.renderState === "gpu" && counters()?.frames > 0,
      () => "GPU renderer did not submit real PCB geometry: " + JSON.stringify(G.status(I)));
  } catch (error) {
    const consoleState = await post("consoleEvents");
    const rows = consoleState?.entries ?? [];
    const reports = rows.filter(row => /gpu|webgl|texture/i.test(row.text || "")).slice(-8);
    throw Error(error.message + " " + JSON.stringify(reports));
  }
  check(["gridBufferAllocations", "driverFenceSubmissions", "driverMemoryChecks"].every(key => typeof counters()?.[key] === "number") &&
    typeof counters().exactCamera === "boolean", "GPU build lacks shared frame, allocation, fence or exact-camera diagnostics");
  const revision = H.authoredRevision(), dirty = H.isDirty(), beforeItems = doc.items.length;
  const engine = G.stats(I).renderer;
  const counts = {};
  for (const item of doc.items) counts[item.kind] = (counts[item.kind] || 0) + 1;
  const rect = canvas.getBoundingClientRect();
  const viewport = {css: [rect.width, rect.height], backing: [canvas.width, canvas.height], dpr: devicePixelRatio};
  const original = {render: v.render, moving: v.moving, settle: v.settle};
  let moving = false, previous = v.camera(), phase = null, renders = 0, lastOptions = null;
  // WKWebView's uploader gets ImageData from the visible board for coverage, or from
  // the detached band canvas for labels/exception geometry. Keep both observable.
  // Typed-array atlas uploads are reported separately by the renderer's own counters.
  const context = CanvasRenderingContext2D.prototype, getImage = context.getImageData;
  const imageSources = new WeakMap(), fullSurfaces = {boardCopies: 0, boardBytes: 0, detachedCopies: 0, detachedBytes: 0};
  context.getImageData = function (...args) {
    const image = getImage.apply(this, args);
    if (args[0] === 0 && args[1] === 0 && args[2] === this.canvas.width && args[3] === this.canvas.height)
      imageSources.set(image, this.canvas);
    return image;
  };
  W.__observeCanvasUpload = (image, width, height) => {
    if (width !== canvas.width || height !== canvas.height) return;
    const source = imageSources.get(image);
    if (!source) return;
    if (source === canvas) {
      fullSurfaces.boardCopies++;
      fullSurfaces.boardBytes += width * height * 4;
      phase?.surfaceUploads.push({at: now(), kind: "board", bytes: width * height * 4});
    } else if (!source.isConnected) {
      fullSurfaces.detachedCopies++;
      fullSurfaces.detachedBytes += width * height * 4;
      phase?.surfaceUploads.push({at: now(), kind: "detached", bytes: width * height * 4});
    }
  };
  const operations = {};
  v.moving = function (...args) {
    moving = true;
    return original.moving.apply(this, args);
  };
  v.settle = function (...args) {
    moving = false;
    return original.settle.apply(this, args);
  };
  v.render = function (...args) {
    const start = now(), camera = v.camera(), wasMoving = moving, inCallback = !!W.__depth;
    const beforeBytes = W.__uploads;
    moving = false; // The view consumes its moving flag during render.
    const result = original.render.apply(this, args);
    const end = now();
    lastOptions = args[2];
    renders++;
    if (phase) phase.draws.push({t: start, end, camera, changed: different(previous, camera), moving: wasMoving, raf: W.__rafTime,
      uploadBytes: W.__uploads - beforeBytes, inCallback});
    previous = camera;
    return result;
  };

  async function measure(name, operation) {
    const sampling = await post("measure", {boundary: "begin"}) === true;
    const before = counters(), canvasBefore = {...fullSurfaces}, row = {name, draws: [], ticks: [], surfaceUploads: []};
    W.__work.length = 0;
    W.__inputs.length = 0;
    let running = true;
    const clock = t => {
      if (!running) return;
      row.ticks.push(t);
      W.__rawRAF(clock);
    };
    W.__rawRAF(clock);
    await frame();
    row.begin = now();
    row.cameraBefore = v.camera();
    phase = row;
    try {
      row.operation = await operation();
      await frame();
      row.cameraAfter = v.camera();
      row.end = now();
    } finally {
      running = false;
      phase = null;
      row.after = counters();
      row.process = sampling ? await post("measure", {boundary: "end"}) : null;
    }
    row.inputs = W.__inputs.slice();
    row.work = W.__work.slice();
    row.before = before;
    row.fullSurfaces = {before: canvasBefore, after: {...fullSurfaces}};
    row.gpu = exact(row.after) && row.after.frames > before.frames;
    return row;
  }

  const approach = Array.from({length: 5}, () => [0, 1, 0]);
  const pan = Array.from({length: 48}, (_, i) => i === 47 ? [0, 0, 3] :
    [i < 32 ? 6 : -3, i < 32 ? -4 : 3, i ? 2 : 1]);
  const reverse = [1, 1, -1, -1, -1, 1, 1, 1, -1, 1, -1, -1].map(dy => [0, dy, 0]);
  const retreat = Array.from({length: 6}, () => [0, -1, 0]);
  async function durableFit() {
    // Use the normal Fit command; its action and time are outside the subsequently timed approach.
    H.act("fit");
    await waitExact();
    return v.camera();
  }
  function anchor() {
    const point = (x, y) => [Math.round(x + rect.left), Math.round(y + rect.top)];
    const onCanvas = ([x, y]) => x >= rect.left + 50 && x < rect.right - 50 && y >= rect.top + 50 && y < rect.bottom - 50 &&
      document.elementFromPoint(x, y) === canvas;
    let best = null;
    for (const item of doc.items) {
      if (item.kind !== "part") continue;
      const pads = defs.get(item.def)?.footprint?.pads?.length || 0;
      if (pads <= (best?.pads ?? 0)) continue;
      const at = point(...v.worldToScreen([item.x, item.y]));
      if (onCanvas(at)) best = {at, pads};
    }
    const target = best ?? {at: point(rect.width * .46, rect.height * .49), pads: 0};
    check(onCanvas(target.at), "The measured input point is covered");
    return target;
  }

  const labelOrigins = doc.items.filter(item => Number.isFinite(item.x) && Number.isFinite(item.y) && (
    item.kind === "part" || item.kind === "text" || item.kind === "label" || item.kind === "pad" || item.kind === "via"));
  const box = ({cx, cy, scale}) => [cx - rect.width / (2 * scale), cy - rect.height / (2 * scale),
    cx + rect.width / (2 * scale), cy + rect.height / (2 * scale)];
  const covers = ([x0, y0, x1, y1], {x, y}) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  function crossing(fit) {
    const camera = v.camera(), bounds = box(camera), fitBounds = box(fit);
    const deltaX = Math.ceil(rect.width * 1.11 / 60), deltaY = Math.ceil(rect.height * 1.11 / 60);
    const moves = [[deltaX, 0], [-deltaX, 0], [0, deltaY], [0, -deltaY],
      [deltaX, deltaY], [deltaX, -deltaY], [-deltaX, deltaY], [-deltaX, -deltaY]];
    const overlap = (a, b) => a[2] > b[0] && a[0] < b[2] && a[3] > b[1] && a[1] < b[3];
    const scored = moves.map(([dx, dy]) => {
      const after = box({...camera, cx: camera.cx - 60 * dx / camera.scale, cy: camera.cy - 60 * dy / camera.scale});
      return {dx, dy, n: labelOrigins.filter(item => item.kind !== "via" && covers(after, item)).length,
        supported: overlap(after, fitBounds) && !overlap(after, bounds)};
    }).filter(move => move.supported).sort((a, b) => b.n - a.n);
    check(scored[0]?.n > 0, "No non-overlapping destination with real PCB label origins");
    const {dx, dy} = scored[0];
    return [...Array.from({length: 60}, (_, i) => [dx, dy, i ? 2 : 1]), [0, 0, 3]];
  }
  function origins(camera) {
    const bounds = box(camera), result = {designators: 0, text: 0, padsWithCaptionSpace: 0, viasWithCaptionSpace: 0};
    // Counts independently check actual authored geometry at the endpoints. This is spatial coverage,
    // not a claim that each origin is an ink pixel or visible under the active layer policy.
    for (const item of labelOrigins.filter(item => covers(bounds, item))) {
      if (item.kind === "part") {
        result.designators++;
        for (const pad of defs.get(item.def)?.footprint?.pads ?? []) {
          if (Math.max(pad.w || 0, pad.h || 0, pad.diameter || 0) * camera.scale > 15 && (pad.number != null || pad.net))
            result.padsWithCaptionSpace++;
        }
      } else if (item.kind === "pad" && Math.max(item.w || 0, item.h || 0, item.diameter || 0) * camera.scale > 15 && item.net) {
        result.padsWithCaptionSpace++;
      } else if (item.kind === "via" && item.drill * camera.scale >= 6 && (item.ipc4761 || item.backdrill || item.net)) {
        result.viasWithCaptionSpace++;
      } else if (item.kind === "text" || item.kind === "label") {
        result.text++;
      }
    }
    return result;
  }

  async function gesture(name, kind, steps, ms, [x, y]) {
    checkBoard([x, y]);
    const row = await measure(name, async () => {
      const sent = await post("feel-input", {kind, steps, ms, x, y});
      const sentAcknowledged = now();
      await pause(settleMs);
      await waitExact();
      checkBoard([x, y]);
      return {sent, sentAcknowledged, sourceIntervalMs: ms, target: [x, y]};
    });
    const events = row.inputs.filter(changesCamera), sent = row.operation.sent;
    const multiple = sent.filter(e => e.dx || e.dy);
    const local = [x - rect.left, y - rect.top];
    const expected = expectedCamera(kind, "zoom", row.cameraBefore, sent, rect, local);
    const close = key => Math.abs(row.cameraAfter[key] - expected[key]) < 1e-6;
    const trusted = e => e.type === "wheel" && e.trusted && e.target === canvas.id && e.x === x && e.y === y &&
      e.ctrl === (kind === "ctrl-line");
    const delivered = kind === "pan" ? events.length > 0 && events.length <= multiple.length :
      events.length === multiple.length && events.every((e, i) => e.dx === 0 && e.dy === -40 * multiple[i].dy);
    row.verification = {
      signedTrustedCanvas: events.length > 0 && events.every(trusted),
      appKitCount: sent.length === steps.length,
      delivery: delivered, expected, camera: Object.keys(expected).every(close),
      drew: row.draws.some(r => r.changed), inputCount: events.length, sentOperative: multiple.length,
      cameraMotionEnded: !moving && !M.active(),
    };
    return row;
  }

  async function held() {
    checkBoard();
    const row = await measure("held", async () => {
      for (let n = 0; n < 4; n++) {
        await new Promise(resolve => requestAnimationFrame(() => {
          H.redraw(true);
          resolve();
        }));
        await pause(32);
      }
      await waitExact();
    });
    row.verification = {camera: !different(row.cameraBefore, row.cameraAfter),
      drew: row.draws.length >= 4, cameraHeld: row.draws.every(draw => !draw.changed && !draw.moving)};
    return row;
  }

  try {
    H.redraw();
    await until(() => lastOptions, "Initial PCB view options missing");
    for (let n = 0; n < 3 && layerMode !== "saved" && lastOptions.layerMode !== layerMode; n++) {
      // Cycle the app's own mode action in this ephemeral editor.
      H.act("layer-mode");
      for (let i = 0; i < 5; i++) await frame();
    }
    check(layerMode === "saved" || lastOptions.layerMode === layerMode, "Requested layer mode unavailable");
    for (let n = 0; n < repetitions; n++) {
      const fit = await durableFit();
      check(!fit.flipped && !fit.rotation && fit.scale * Math.exp(5 * 0.32) < 2000, "Fit camera needs an unrotated unclamped view");
      const target = anchor();
      const trial = {target, fit, phases: []};
      operations[n] = trial;
      trial.phases.push(await gesture(n === 0 ? "firstApproach" : "approach", "ctrl-line", approach, 45, target.at));
      trial.phases.push(await gesture("pan", "pan", pan, 1000 / 120, target.at));
      trial.phases.push(await gesture("reverse", "ctrl-line", reverse, 34, target.at));
      trial.phases.push(await held());
      if (crossView) {
        const crossingRow = await gesture("crossView", "pan", crossing(fit), 1000 / 120, target.at);
        const [a, b] = [box(crossingRow.cameraBefore), box(crossingRow.cameraAfter)];
        crossingRow.verification.disjointViewport = a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3];
        trial.phases.push(crossingRow);
        const retreatRow = await gesture("retreat", "ctrl-line", retreat, 45, target.at);
        retreatRow.verification.beyondFit = retreatRow.cameraAfter.scale < fit.scale * .9;
        trial.phases.push(retreatRow);
      }
    }
    for (const {phases} of Object.values(operations)) for (const row of phases) {
      row.authoredOrigins = {start: origins(row.cameraBefore), end: origins(row.cameraAfter)};
    }
    await waitExact();
    const idleSampling = await post("measure", {boundary: "begin"}) === true;
    const idleStart = now(), idleRenders = renders, idleTracks = M.active(), idleBytes = W.__uploads;
    const idleCounters = counters(), idleCallbacks = W.__work.length / 2, idleSurfaces = {...fullSurfaces};
    // No measurement rAF is queued continuously here. Observe callbacks scheduled by the app.
    await pause(400);
    const idle = {elapsedMs: now() - idleStart, renders: renders - idleRenders, tracks: [idleTracks, M.active()],
      callbacks: W.__work.length / 2 - idleCallbacks, uploadBytes: W.__uploads - idleBytes,
      before: idleCounters, after: counters(), fullSurfaces: {before: idleSurfaces, after: {...fullSurfaces}}};
    idle.process = idleSampling ? await post("measure", {boundary: "end"}) : null;
    const nativeEnd = await post("feel-state");
    return {native, nativeEnd, nativeEndOK: displayOK(nativeEnd) && nativeEnd.backingScale === native.backingScale, engine,
      viewport, normalRenderer, counts, beforeItems, layerMode: lastOptions?.layerMode, activeLayer: lastOptions?.layer, settleMs, drawWork,
      power: {physical, requestedLowPowerSimulation: lowPower,
        actualPriorState: priorPower, measured: AtriumPower.state()}, operations, idle,
      documentUnchanged: H.doc() === doc && H.authoredRevision() === revision && H.isDirty() === dirty && doc.items.length === beforeItems};
  } finally {
    Object.assign(v, original);
    context.getImageData = getImage;
    delete W.__observeCanvasUpload;
    if (lowPower) AtriumPower.host(priorPower);
  }
}
