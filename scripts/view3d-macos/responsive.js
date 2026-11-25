"use strict";

let stage = "native-open";
const partial = {};
try {
  const native = (op, data = {}) => webkit.messageHandlers.formatBenchmark.postMessage({op, ...data});
  const frame = () => new Promise(requestAnimationFrame);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const stamp = () => performance.now();
  const check = (ok, why) => { if (!ok) throw Error(why); };
  const wait = async (test, why, timeout = 25000) => {
    const end = stamp() + timeout;
    while (!test()) {
      if (stamp() > end) throw Error(typeof why === "function" ? why() : why);
      await Promise.race([frame(), pause(50)]);
    }
  };
  const power = AtriumPower, h = AtriumNavHost;
  const prefs = await AtriumLazy.need("AtriumPrefs");
  prefs.set("general.startPage", "never");
  const startPage = await AtriumLazy.need("AtriumStartPage");
  startPage.close();
  await native("open");
  const boardRef = () => h.documentRefs().find(d => d.kind === "pcb");
  const fromSource = !!trial.foreignFiles?.length;
  await wait(() => (fromSource ? !h.isStarter() : h.folderProject()) && boardRef(), "Native File Open did not open a PCB");
  await native("finishOpen");
  stage = "pcb-selection";
  const id = boardRef().id;
  const tab = () => document.querySelector('#document-tabs [data-tab="' + CSS.escape(id) + '"]') ||
    document.querySelector('#documents [data-doc="' + CSS.escape(id) + '"]');
  if (fromSource) await wait(() => !!globalThis.AtriumImportReports?.recent(id), "The import did not finish");
  if (fromSource || h.doc().id !== id) {
    await wait(tab, "The opened project's PCB tab is missing");
    tab().click();
  }
  await wait(() => !document.querySelector(".doc-view:not([hidden])"), "A report still covers the PCB");
  await wait(() => h.doc().id === id && h.doc().items.length > 0 && !document.querySelector("dialog[open]"),
    () => "The real PCB did not become available: " + JSON.stringify({isPCB: h.doc().kind === "pcb",
      correctBoard: h.doc().id === id, items: h.doc().items.length, hasTab: !!tab(), dialog: !!document.querySelector("dialog[open]")}));
  const pcb = h.doc();
  h.canvas().focus({preventScroll: true});
  await frame(); await frame();
  check(document.visibilityState === "visible" && power.visible(), "Native editor is hidden");
  check(!globalThis.Atrium3D, "The cold viewer was already loaded");
  const startedDirty = h.isDirty();
  check(fromSource || !startedDirty, "The editor marked the opened project as changed");

  stage = "authored-body-references";
  const placedAliases = new Set(), expectedSteps = new Map(), expectedExtrusions = new Set();
  for (const item of pcb.items) {
    for (const body of item.bodies3d || []) {
      const key = item.id + "|" + body.sourceRecord;
      if (body.type === "step") { expectedSteps.set(key, body.modelId); placedAliases.add(body.modelId); }
      if (body.type === "extruded") expectedExtrusions.add(key);
    }
  }
  const assets = (pcb.bodyModels || []).filter(a => placedAliases.has(a.id));
  check(assets.length === placedAliases.size && expectedSteps.size + expectedExtrusions.size > 0,
    "The test requires source-authored 3D bodies and all referenced assets");
  const viewer = () => [...(globalThis.Atrium3D?.viewers.values() || [])].find(v => v.doc?.()?.id === pcb.id);
  function detail(v) {
    const s = v?.scene();
    const visible = new Set();
    let standIns = 0;
    for (const batch of s?.batches || []) {
      for (const inst of batch.instances) {
        if (inst.kind !== "component" || !inst.rgba || !batch.gl?.count) continue;
        if (inst.bodyRecord && !inst.boundsOnly) visible.add(inst.id + "|" + inst.bodyRecord);
        else standIns++;
      }
    }
    const shown = keys => [...keys].filter(k => visible.has(k)).length;
    // A placed authored mesh proves successful decoding even when a dense model's worker
    // cache has already evicted the payload or the saved alias is a transient reference.
    const loaded = new Set([...expectedSteps].filter(([key]) => visible.has(key)).map(([, alias]) => alias));
    return {layers: !!s?.hasLayers, decodedAssets: loaded.size, expectedAssets: assets.length,
      shownPlacements: shown(expectedSteps.keys()), expectedPlacements: expectedSteps.size,
      shownExtrusions: shown(expectedExtrusions), expectedExtrusions: expectedExtrusions.size, standInInstances: standIns};
  }
  const fullyDrawn = d => d.layers && d.decodedAssets === d.expectedAssets &&
    d.shownPlacements === d.expectedPlacements && d.shownExtrusions === d.expectedExtrusions;

  let clears = 0, draws = 0, glRef, openRequest = null;
  const proto = WebGL2RenderingContext.prototype, clear = proto.clear, instanced = proto.drawElementsInstanced;
  proto.clear = function(mask) {
    if (this.canvas.classList.contains("v3d-canvas")) {
      glRef = this;
      clears++;
      if (openRequest) {
        const request = openRequest, callsBefore = draws;
        queueMicrotask(() => {
          // The first real draw may precede publication of the viewer's public handle.
          if (request !== openRequest || draws <= callsBefore) return;
          const v = viewer();
          if (!v?.scene().batches.some(batch => batch.kind === "board" && batch.gl?.count > 0)) return;
          const ms = stamp() - request.time;
          if (!request.firstDraw) {
            request.firstDraw = {ms, batches: draws - callsBefore};
            request.firstPresent = native("present").then(() => stamp() - request.time);
          }
          if (!request.detailDraw && fullyDrawn(detail(v))) {
            request.detailDraw = ms;
            request.detailPresent = native("present").then(() => stamp() - request.time);
          }
        });
      }
    }
    return clear.call(this, mask);
  };
  proto.drawElementsInstanced = function(...args) {
    const value = instanced.apply(this, args);
    if (this.canvas.classList.contains("v3d-canvas") && args[1] > 0 && args[4] > 0) draws++;
    return value;
  };
  let keyEvents = [];
  document.addEventListener("keydown", e => {
    if (e.isTrusted && ["0", "2", "3"].includes(e.key)) keyEvents.push({key: e.key, time: stamp()});
  }, true);
  function keyCounts(key) { return keyEvents.filter(e => e.key === key).length; }
  async function shortcut(key) {
    const count = keyCounts(key);
    await native("key", {key});
    await wait(() => keyCounts(key) === count + 1, "Missing trusted native shortcut " + key, 3000);
  }
  async function enter(label) {
    stage = label + "-first-board";
    check(power.visible() && document.visibilityState === "visible", "Native view went hidden before opening");
    const request = openRequest = {time: stamp()};
    await shortcut("3");
    await wait(() => request.firstDraw && viewer()?.R, "No real board draw followed 3D");
    stage = label + "-full-geometry";
    await wait(() => request.detailDraw, () => "Full authored 3D geometry did not draw: " + JSON.stringify(detail(viewer())));
    const [firstPresentMs, detailPresentMs] = await Promise.all([request.firstPresent, request.detailPresent]);
    const v = viewer(), d = detail(v);
    openRequest = null;
    return {firstDrawMs: request.firstDraw.ms, firstPresentMs, detailSubmittedMs: request.detailDraw, detailPresentMs, detail: d,
      firstDrawCalls: request.firstDraw.batches, stats: v.stats()};
  }
  async function exit() {
    stage = "2d-return";
    const prior = viewer(), canvas = prior.canvas, began = stamp();
    await shortcut("2");
    await wait(() => !canvas.isConnected && !viewer(), "2D did not destroy the 3D viewer");
    await native("present");
    const status = {focusReturned: document.activeElement === h.canvas(), remainingBuffers: prior.freed?.live,
      canvasAvailable: h.canvas().isConnected && !h.canvas().hasAttribute("aria-hidden"), noEdit: h.isDirty() === startedDirty};
    check(status.remainingBuffers === 0 && status.canvasAvailable && status.noEdit,
      "2D did not release renderer buffers or preserve the open PCB: " + JSON.stringify(status));
    return {ms: stamp() - began, ...status};
  }

  const cold = await enter("cold");
  partial.cold = cold.detail;
  const firstExit = await exit(), warm = await enter("warm");
  partial.warm = warm.detail;
  stage = "native-display";
  const v = viewer(), canvas = v.canvas, rect = canvas.getBoundingClientRect();
  const gl = glRef, extension = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = {...await native("gpu"), webgl: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER),
    unmaskedRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
    unmaskedVendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null,
    gpuTimer: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"), samples: gl.getParameter(gl.SAMPLES),
    backingPixels: [canvas.width, canvas.height], cssPixels: [rect.width, rect.height], dpr: devicePixelRatio,
    fileOrigin: location.protocol === "file:"};
  check(gpu.displayOnline && gpu.active === trial.foreground && gpu.keyWindow === trial.foreground &&
    gpu.windowOrdered && gpu.windowAlpha === 1 && gpu.windowOcclusionVisible,
    "Expected native window focus and display state are unavailable: " + JSON.stringify({
      active: gpu.active, key: gpu.keyWindow, ordered: gpu.windowOrdered, visible: gpu.windowOcclusionVisible}));
  check(!trial.displayID || gpu.displayID === trial.displayID, "Native window chose the wrong display");

  const camera = () => structuredClone(v.camera());
  const math = Atrium3D.math;
  const hash = c => [c.yaw, c.pitch, c.dist, c.fov, ...c.target].join("|");
  const targetDelta = (a, b) => Math.hypot(...a.target.map((value, i) => value - b.target[i]));
  const componentState = () => JSON.stringify(detail(v));
  const startingBodies = componentState();
  partial.gestureStart = JSON.parse(startingBodies);
  let sample = null, phase = null, capture = null;
  const render = v.R.draw;
  v.R.draw = function(params) {
    const calls = render.call(this, params);
    if (phase && calls) {
      const now = stamp(), current = hash(v.camera()), projected = Array.from(params.m.vp).join("|");
      phase.draws.push(now);
      if (current !== phase.lastCamera && projected !== phase.lastProjection) {
        phase.changed.push(now);
        if (phase.pending.length) {
          const newest = phase.pending.at(-1);
          phase.inputLatency.push(now - newest.time);
          phase.pairedInputs++;
          phase.coalescedInputs += phase.pending.length - 1;
          phase.pending.length = 0;
        }
        phase.lastCamera = current;
        phase.lastProjection = projected;
      }
    }
    if (capture) {
      const done = capture; capture = null;
      done(canvas.toDataURL("image/png"));
    }
    if (sample) {
      // Read a small fixed grid only in a separate correctness redraw. These samples never
      // overlap the paced input or first-use measurements. Retain only aggregate counts.
      const values = [], occupancy = [], pixels = new Uint8Array(params.w * params.h * 4);
      gl.readPixels(0, 0, params.w, params.h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const background = params.bg.map(c => Math.round(c * 255));
      let content = 0;
      for (let y = 1; y <= 15; y++) for (let x = 1; x <= 15; x++) {
        const offset = 4 * (Math.floor(y * params.h / 16) * params.w + Math.floor(x * params.w / 16));
        const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
        const occupied = rgb.some((value, i) => Math.abs(value - background[i]) > 2);
        if (occupied) content++;
        occupancy.push(occupied);
        values.push(rgb.join(","));
      }
      const done = sample; sample = null;
      done({values, occupancy, content});
    }
    return calls;
  };
  async function samplePixels() {
    const picture = new Promise(resolve => { sample = resolve; });
    v.invalidate();
    const pixels = await Promise.race([picture, pause(2000).then(() => null)]);
    check(pixels?.content > 3, "No visible PCB pixels at the camera position");
    return pixels;
  }
  const pixelDifference = (a, b) => a.values.filter((p, i) => p !== b.values[i]).length;
  const coverageDifference = (a, b) => a.occupancy.filter((p, i) => p !== b.occupancy[i]).length;
  const gap = times => times.slice(1).map((t, i) => t - times[i]);
  async function quiescent(reason) {
    // Camera save, pointer hover, and presentation may finish independently.
    await pause(180);
    const before = [clears, draws], start = stamp(), heartbeat = [];
    const until = stamp() + 350;
    while (stamp() < until) heartbeat.push(await frame());
    const result = {ms: stamp() - start, draws: clears - before[0], calls: draws - before[1], rafIntervalsMs: gap(heartbeat)};
    partial.quiescence ||= [];
    partial.quiescence.push({stage, ms: result.ms, draws: result.draws, calls: result.calls,
      visible: v.visible(), pendingViewerWork: !!v.pending()});
    check(!result.draws && !result.calls, reason + ": " + JSON.stringify({draws: result.draws, calls: result.calls}));
    return result;
  }
  stage = "fully-populated-idle";
  const idle = await quiescent("CONTROL_IDLE_KEPT_DRAWING");
  async function top() {
    const pressed = stamp(), before = clears;
    await shortcut("0");
    await wait(() => clears > before, "Top view did not start drawing");
    let last = clears, lastDrawMs = stamp() - pressed, quiet = 0;
    const limit = stamp() + 1800;
    while (quiet < 3 && stamp() < limit) {
      await frame();
      if (last === clears) quiet++;
      else { last = clears; lastDrawMs = stamp() - pressed; quiet = 0; }
    }
    check(quiet === 3 && Math.abs(v.camera().pitch - 90) < .001, "Top view did not settle");
    await native("present");
    return {lastDrawMs, acknowledgedMs: stamp() - pressed};
  }
  stage = "top-pose";
  const topPose = await top(), topCamera = camera(), topPixels = await samplePixels();
  const events = [];
  for (const name of ["wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
    canvas.addEventListener(name, e => {
      if (!e.isTrusted) return;
      const entry = {type: name, time: stamp(), eventTime: e.timeStamp, x: e.clientX, y: e.clientY, shift: e.shiftKey,
        delta: e.deltaY, wheelDelta: e.wheelDeltaY, target: e.target === canvas, pointerId: e.pointerId};
      events.push(entry);
      if (phase?.type === name && entry.target) {
        phase.pending.push(entry);
        phase.trustedInputs.push(entry);
      }
    }, true);
  }
  function findInputCenter() {
    for (const [fx, fy] of [[.47, .53], [.34, .46], [.57, .43], [.24, .51], [.28, .72], [.62, .60]]) {
      const pt = [Math.round(rect.left + rect.width * fx), Math.round(rect.top + rect.height * fy)];
      if (document.elementFromPoint(...pt) === canvas) return pt;
    }
    const probe = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    throw Error("The 3D viewport is covered by " + probe?.tagName + "#" + probe?.id + "." + String(probe?.className) +
      ", modal=" + !!document.querySelector("dialog[open]"));
  }
  async function gesture(label, mode, options, verify) {
    const gestureStage = stage, before = camera(), offset = events.length, start = stamp();
    stage = gestureStage + "-target";
    check(!phase && document.elementFromPoint(options.x, options.y) === canvas, "Input point is covered during " + label);
    const track = phase = {type: mode === "zoom" ? "wheel" : "pointermove", lastCamera: hash(before), draws: [], changed: [],
      lastProjection: Array.from(v.lastMatrices.vp).join("|"), trustedInputs: [], coalescedInputs: 0,
      pairedInputs: 0, pending: [], inputLatency: []};
    stage = gestureStage + "-dispatch";
    const sent = await native("input", {mode, hz: trial.inputHz, responsive: true, ...options});
    const release = stamp();
    await frame(); await frame();
    phase = null;
    partial[gestureStage] = {nativeInputs: sent.sent, trustedInputs: track.trustedInputs.length, changedDraws: track.changed.length};
    stage = gestureStage + "-camera";
    const motion = verify(before, camera());
    stage = gestureStage + "-trusted-stream";
    check(sent.sent === options.count && track.trustedInputs.length >= Math.min(4, Math.floor(options.count / 2)) &&
      track.changed.length >= 2 && track.pairedInputs >= 2, "Trusted input did not drive actual changed-camera draws: " + JSON.stringify({label, sent: sent.sent, expected: options.count,
        trusted: track.trustedInputs.length, changed: track.changed.length, paired: track.pairedInputs}));
    const received = events.slice(offset), end = received.find(e => e.type === "pointerup");
    if (mode !== "zoom") check(end?.target, "Trusted pointer release did not reach the canvas");
    else check(received.filter(e => e.type === "wheel").every(e => Math.hypot(e.x - options.x, e.y - options.y) <= 2),
      "Trusted wheel moved away from the component inspection point");
    const wheel = received.filter(e => e.type === "wheel" && e.target);
    const lastDraw = track.changed.at(-1);
    stage = gestureStage + "-presentation";
    await native("present");
    const ack = stamp();
    stage = gestureStage + "-geometry";
    const after = componentState();
    partial[gestureStage].visibleAfterAcknowledgement = JSON.parse(after);
    check(after === startingBodies, "A gesture changed the visible geometry cohort");
    return {nativeInputs: sent.sent, inputOffsetsMs: sent.offsetsMs, trustedInputs: track.trustedInputs.length, pairedInputs: track.pairedInputs,
      coalescedInputs: track.coalescedInputs, pendingInputs: track.pending.length, draws: track.draws.length,
      changedDraws: track.changed.length, changedIntervalsMs: gap(track.changed), allDrawIntervalsMs: gap(track.draws),
      changedDrawOffsetsMs: track.changed.map(t => t - start),
      trustedDOMArrivalOffsetsMs: track.trustedInputs.map(e => e.time - start),
      trustedEventTimestampOffsetsMs: track.trustedInputs.map(e => e.eventTime - start),
      latestDOMInputToDrawMs: track.inputLatency, firstChangedDrawMs: track.changed[0] - start,
      lastChangedDrawRelativeToDispatchReturnMs: lastDraw - release, acknowledgedAfterDispatchReturnMs: ack - release,
      nativeDispatchMs: sent.elapsedMs,
      ...(mode === "zoom" ? {wheel: {trustedEvents: wheel.length, cssDeltaY: wheel.reduce((n, e) => n + e.delta, 0),
        legacyDeltaY: wheel.reduce((n, e) => n + (e.wheelDelta || 0), 0), intendedLegacyDeltaY: options.count * 120}} : {}), motion};
  }

  stage = "orbit";
  const center = findInputCenter();
  const orbit = await gesture("orbit", "orbit", {x: center[0], y: center[1], dx: Math.min(110, rect.width * .22),
    dy: -Math.min(114, rect.height * .24), count: trial.steps}, (before, after) => {
    check(before.pitch - after.pitch > 20 && Math.abs(after.yaw - before.yaw) > 20 && before.dist === after.dist &&
      targetDelta(before, after) === 0, "CONTROL_ORBIT_DID_NOT_MOVE");
    return {yawDeg: after.yaw - before.yaw, pitchDeg: after.pitch - before.pitch};
  });
  stage = "orbit-pixels";
  const obliqueCamera = camera(), obliquePixels = await samplePixels(), orbitPixelDelta = pixelDifference(topPixels, obliquePixels);
  partial.orbitPixels = {topContent: topPixels.content, obliqueContent: obliquePixels.content,
    changedColors: orbitPixelDelta, changedCoverage: coverageDifference(topPixels, obliquePixels)};
  check(orbitPixelDelta > 5 && coverageDifference(topPixels, obliquePixels) > 3,
    "Orbit changed camera state without visibly moving the rendered PCB");
  stage = "return-top";
  const returnTop = await top(), returnTopPixels = await samplePixels();
  check(hash(camera()) === hash(topCamera), "The Top shortcut did not return to its original pose");
  check(pixelDifference(topPixels, returnTopPixels) < orbitPixelDelta, "Returning to Top did not restore the board view");

  function inspectionPoint() {
    const vp = math.matrices(v.camera(), rect.width / rect.height, v.scene().sphere).vp;
    for (const part of v.scene().parts) {
      if (!part.bodyRecord || part.boundsOnly) continue;
      const p = math.project(vp, part.box.slice(0, 3).map((x, i) => (x + part.box[i+3]) / 2), rect.width, rect.height);
      if (!p || p[0] < rect.width * .19 || p[0] > rect.width * .81 || p[1] < rect.height * .18 || p[1] > rect.height * .77) continue;
      const x = Math.round(rect.left + p[0]), y = Math.round(rect.top + p[1]);
      if (document.elementFromPoint(x, y) !== canvas) continue;
      const picked = v.pickAt(x - rect.left, y - rect.top, false);
      if (picked.inst?.kind === "component" && picked.inst?.bodyRecord && !picked.inst?.boundsOnly && picked.point)
        return {x, y, point: picked.point};
    }
    throw Error("No source-authored component can be picked for a real inspection");
  }
  stage = "inspection-point";
  const {x, y, point} = inspectionPoint();
  stage = "zoom";
  const zoom = await gesture("component inspection", "zoom", {x, y, count: 16, directions: Array(16).fill(1)}, (before, after) => {
    const projected = math.project(math.matrices(after, rect.width / rect.height, v.scene().sphere).vp, point, rect.width, rect.height);
    const drift = Math.hypot(projected[0] - (x - rect.left), projected[1] - (y - rect.top));
    check(after.dist < before.dist * .85 && after.yaw === before.yaw && after.pitch === before.pitch && drift < 2,
      "Component zoom failed to zoom in on the original 3D cursor anchor");
    return {beforeMm: before.dist, afterMm: after.dist, anchorDriftCssPx: drift};
  });
  const zoomCamera = camera(), zoomPixels = await samplePixels();
  check(pixelDifference(returnTopPixels, zoomPixels) > 5 && coverageDifference(returnTopPixels, zoomPixels) > 3, "Component inspection did not visibly change the PCB");
  // Return to a known full view through the normal Top command after inspecting a part.
  stage = "return-from-zoom";
  const returnFromZoom = await top();
  check(hash(camera()) === hash(topCamera), "The Top shortcut did not restore the fitted PCB after inspection");
  stage = "pan";
  const pan = await gesture("traverse board", "pan", {x: center[0], y: center[1], dx: Math.min(170, rect.width * .28),
    dy: Math.min(48, rect.height * .08), count: trial.steps}, (before, after) => {
    const distance = targetDelta(before, after);
    check(distance > .25 && before.dist === after.dist && before.yaw === after.yaw && before.pitch === after.pitch, "Shift-drag failed to translate the camera");
    return {targetDeltaMm: distance};
  });
  const panPixels = await samplePixels();
  check(pixelDifference(returnTopPixels, panPixels) > 5 && coverageDifference(returnTopPixels, panPixels) > 3, "Pan did not visibly translate the PCB");
  const settled = await quiescent("Viewer kept drawing after input release");
  stage = "cancel-start";
  const offset = events.length;
  const cancelBefore = hash(camera());
  const drag = native("input", {mode: "orbit", responsive: true, x: center[0], y: center[1], dx: 90, dy: -80, count: 54, hz: 120});
  await wait(() => hash(camera()) !== cancelBefore, "The drag to cancel never moved", 2000);
  const down = events.slice(offset).find(e => e.type === "pointerdown");
  stage = "cancel-pointer-down";
  check(down?.target, "The cancel control requires a real pointer-down");
  stage = "cancel-continuation";
  const atCancel = hash(camera()), cancelEvent = events.length;
  canvas.dispatchEvent(new PointerEvent("pointercancel", {bubbles: true, pointerId: down.pointerId, pointerType: "mouse"}));
  await drag;
  await frame(); await frame();
  const afterCancel = events.slice(cancelEvent);
  const cancellation = {trustedRemainingMoves: afterCancel.filter(e => e.type === "pointermove").length,
    trustedPointerUp: afterCancel.some(e => e.type === "pointerup"), moved: hash(camera()) !== atCancel};
  partial.cancellation = cancellation;
  check(!cancellation.moved && cancellation.trustedRemainingMoves > 0 && cancellation.trustedPointerUp,
    "Canceled drag kept moving or received no trusted continuation");
  stage = "cancel-settle";
  const cancelled = {syntheticCancel: true, trustedRemainingEvents: afterCancel.length, movementAfterCancel: false,
    settled: await quiescent("Viewer kept drawing after input cancellation")};

  // Drive the normal host occlusion handler without changing the user's display configuration.
  stage = "occlusion";
  const afterPan = hash(camera()), hiddenPixels = await samplePixels(), start = stamp();
  power.host({occluded: true});
  const hiddenStart = [clears, draws];
  v.invalidate();
  await pause(350);
  const hidden = {ms: stamp() - start, draws: clears - hiddenStart[0], calls: draws - hiddenStart[1]};
  check(!power.visible() && !hidden.draws && !hidden.calls && hash(camera()) === afterPan, "Occluded model rendered or moved");
  power.host({occluded: false});
  await wait(() => clears > hiddenStart[0], "Revealed 3D view did not render the pending frame");
  await native("present");
  check(componentState() === startingBodies, "Reveal discarded source geometry");
  const finalPixels = await samplePixels();
  check(pixelDifference(hiddenPixels, finalPixels) < orbitPixelDelta, "Returning from occlusion changed the board image");
  async function capturePose(cameraPose) {
    const original = camera(), pixels = new Promise(resolve => { capture = resolve; });
    v.camera(cameraPose);
    const image = await Promise.race([pixels, pause(2000).then(() => null)]);
    v.camera(original);
    await frame();
    check(image?.startsWith("data:image/png;base64,"), "Public proof capture failed");
    return image;
  }
  let images;
  if (trial.capture) {
    images = {oblique: await capturePose(obliqueCamera), inspection: await capturePose(zoomCamera)};
    await quiescent("Public proof draw did not settle");
  }
  const beforeExit = [clears, draws], finalExit = await exit(), afterExit = [clears, draws];
  await pause(350);
  check(clears === afterExit[0] && draws === afterExit[1], "Exited 3D viewer kept submitting WebGL work");
  stage = "final-window";
  const finalWindow = await native("gpu");
  check(finalWindow.displayID === gpu.displayID && finalWindow.displayHz === gpu.displayHz &&
    finalWindow.active === gpu.active && finalWindow.keyWindow === gpu.keyWindow,
    "Native display or keyboard ownership changed during the trial");
  const folderReads = h.folderProject()?.metrics().reads.filter(r => r.purpose === "3D model") || [];
  const phases = {orbit, pan, zoom};
  return {...(images ? {images} : {}), cold, warm, firstExit, finalExit, finalExitDraws: afterExit[0] - beforeExit[0], gpu, idle, settled, hidden,
    phases, topPose, returnTop, returnFromZoom, cancelled,
    finalWindow: {displayID: finalWindow.displayID, displayHz: finalWindow.displayHz, active: finalWindow.active, keyWindow: finalWindow.keyWindow},
    folderModelReadBatches: folderReads.length, trustedShortcuts: keyEvents.length,
    visual: {topContentSamples: topPixels.content, orbitChangedSamples: orbitPixelDelta,
      returnTopChangedSamples: pixelDifference(topPixels, returnTopPixels),
      zoomChangedSamples: pixelDifference(returnTopPixels, zoomPixels), panChangedSamples: pixelDifference(returnTopPixels, panPixels),
      revealChangedSamples: pixelDifference(hiddenPixels, finalPixels)},
    workload: {items: pcb.items.length, components: pcb.items.filter(i => i.kind === "component" || i.kind === "part" || i.kind === "footprint").length}};
} catch (error) {
  // Return only the fixed project-independent checkpoint for the approved fixture.
  if (!trial.private) throw error;
  return {failureStage: stage, aggregate: partial};
}
