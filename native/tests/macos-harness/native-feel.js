"use strict";
// A paced native input pass, separate isolated presentation-ack and settled fresh-frame witnesses.
globalThis.__uiProbes = {async run(only, config) {
  try { return "FEEL " + JSON.stringify(await nativeFeel(config)); }
  catch (e) { return "JSERROR " + e.message + " " + e.stack; }
}};

async function nativeFeel({kind, renderer, zoom = 4, ack = 5, proof = false, idle = false, motion = "full", preference = "zoom", anchorAt = "pointer", requireSameFrame = false, sourceHz, monitor = false}) {
  const post = (op, data = {}) => webkit.messageHandlers.harness.postMessage({op: "feel-" + op, ...data});
  const wait = ms => new Promise(r => window.__rawTimeout(r, ms)), frame = () => new Promise(r => requestAnimationFrame(r));
  const H = AtriumNavHost, C = await AtriumLazy.need("AtriumCamera");
  await AtriumLazy.need(["AtriumCanvasInput", "AtriumCanvasGPU", "AtriumMotion", "AtriumCanvasFast"]);
  const p = Atrium.project("Dense native input", AtriumParts.catalogue), {d} = makeAtriumBenchmarkBoard();
  p.documents = [d];
  await H.replaceProject(p, {force: true, dirty: false});
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  H.selectDocument(d.id);
  document.documentElement.dataset.motion = motion;
  C.setPref("camera.animate", true);
  C.setPref("mouse.wheel", preference);
  C.setPref("mouse.zoomAt", anchorAt);
  const G = AtriumCanvasGPU, v = H.view(), canvas = H.canvas(), I = v.internals();
  G.enable(renderer === "gpu");
  const native = await post("state");
  if (!native.requestedDisplayMatched) throw Error("Requested NATIVE_FEEL_DISPLAY_ID is not the test window display");
  if (!native.wheelEventBindingSupported) throw Error("This AppKit version cannot bind synthetic wheel events to the test window");
  await frame(); await frame();
  v.fit(H.doc(), H.defs());
  const fit = v.camera();
  const reset = async () => {
    C.stopWheel();
    v.restoreCamera(fit);
    const r = canvas.getBoundingClientRect();
    v.zoom(zoom, [r.width / 2, r.height / 2]); H.redraw(true);
    await wait(400); await frame();
  };
  await reset(); await wait(500);
  const status = G.status(I), gpu = renderer === "gpu" ? G.stats(I) : null;
  if (status.renderer !== renderer) throw Error("requested renderer " + renderer + ", got " + JSON.stringify(status));
  if (renderer === "gpu" && !gpu?.submitted) throw Error("hardware renderer did not submit board geometry");
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width * .43), y = Math.round(rect.top + rect.height * .46);
  window.__inputs.length = 0;
  await post("input", {x, y, kind: "ctrl-pixel", ms: 8, steps: [[0, 2, 0]]});
  await wait(100);
  const calibration = window.__inputs.find(e => e.type === "wheel");
  const trustedWheelAtPoint = e => e.type === "wheel" && e.trusted && e.target === canvas.id && e.x === x && e.y === y;
  if (!calibration || !trustedWheelAtPoint(calibration) || !calibration.ctrl || calibration.dy !== -2)
    throw Error("Native wheel calibration did not reach the trusted canvas at the requested point: " + JSON.stringify(calibration));
  const send = (steps, ms) => post("input", {kind, x, y, steps, ms});
  await reset();
  const monitorRow = () => Array.from(document.querySelectorAll("#frame-monitor .ui-prop-row")).find(row =>
    row.firstElementChild?.textContent === "Ctrl+wheel → draw")?.lastElementChild?.textContent;
  let emptyMonitorRow;
  if (monitor) {
    if (monitor === "menu") await webkit.messageHandlers.harness.postMessage({op: "frame-monitor-item"});
    else H.act("frame-monitor");
    for (let n = 0; n < 40 && !monitorRow(); n++) await wait(25);
    emptyMonitorRow = monitorRow();
    if (!emptyMonitorRow) throw Error("Frame Monitor did not open");
  }
  const idleTicks = [];
  for (let n = 0; n < 24; n++) idleTicks.push(await frame());
  const interval = native.displayHz > 0 ? 1000 / native.displayHz : 1000 / 60;
  const steps = feelStream(kind), ms = 1000 / (sourceHz ?? (kind.endsWith("line") ? 40 : 120));
  const render = v.render, zoomCamera = v.zoom, shots = [];
  const historySettles = [], savedViewWrites = [];
  const removeCameraObserver = idle ? C.onMoved(() => historySettles.push(performance.now())) : () => {};
  const store = Storage.prototype.setItem;
  if (idle) Storage.prototype.setItem = function (key, value) {
    if (key === "atrium.camera.views.v1") savedViewWrites.push(performance.now());
    return store.call(this, key, value);
  };
  let draws = [], zooms = [], latestArgs, observeAck = false, ackPromise, capturePixels = null;
  let previous = v.camera();
  v.zoom = function (...args) {
    const before = v.scale(), rv = zoomCamera.apply(this, args);
    if (before !== v.scale()) zooms.push({raf: window.__rafTime, scale: v.scale()});
    return rv;
  };
  v.render = function (...args) {
    const t = performance.now(), camera = v.camera(), changed = different(previous, camera), result = render.apply(this, args);
    const end = performance.now();
    draws.push({t, end, changed, camera, raf: window.__rafTime}); previous = camera; latestArgs = args;
    if (capturePixels) capturePixels();
    if (changed && observeAck) { observeAck = false; ackPromise = post("ack"); }
    return result;
  };
  const before = () => { draws = []; zooms = []; previous = v.camera(); window.__inputs.length = 0; window.__work.length = 0; return previous; };
  const start = before(), revision = H.revision(), wasDirty = H.isDirty();
  const local = anchorAt === "centre" && (kind === "ctrl-line" || kind === "plain-line") ? [rect.width / 2, rect.height / 2] : [x - rect.left, y - rect.top];
  const world = v.screenToWorld(local), ticks = [];
  let ticking = true;
  const tick = t => { ticks.push(t); if (ticking) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  let sent, events, work, finish;
  try {
    sent = await send(steps, ms);
    await wait(340); await frame();
    ticking = false;
    finish = v.camera(); events = window.__inputs.slice(); work = window.__work.slice();
    const renderSamples = draws.slice(), changed = renderSamples.filter(r => r.changed);
    const operative = events.filter(changesCamera);
    if (kind !== "pinch" && (!operative.length || operative.some(e => !trustedWheelAtPoint(e))))
      throw Error("Paced native wheel did not stay on the trusted canvas at the calibrated point");
    const first = operative[0], last = operative.at(-1);
    const activeEnd = last && Math.max(last.at + interval, changed.at(-1)?.end ?? 0);
    const frameSamples = differences(ticks).filter((dt, i) => first && ticks[i + 1] >= first.at && ticks[i] <= activeEnd);
    const vsyncWork = [];
    for (let i = 1; i < ticks.length; i++) {
      if (!first || ticks[i] < first.at || ticks[i - 1] > activeEnd) continue;
      let total = 0;
      for (let n = 0; n < work.length; n += 2) if (work[n] >= ticks[i - 1] && work[n] < ticks[i]) total += work[n + 1];
      vsyncWork.push(total);
    }
    const latency = operative.map(e => {
      const r = changed.find(r => r.t >= e.at);
      return r && {domToDraw: r.end - e.at, eventStampToDraw: r.end - e.stamp};
    }).filter(Boolean);
    const final = expectedCamera(kind, preference, start, sent, rect, local);
    const actualPoint = v.worldToScreen(world);
    const operativeSent = sent.filter(e => e.dx || e.dy).length;
    const result = {kind, renderer, zoom, preference, anchorAt, native, documentVisibility: document.visibilityState,
      visibilityOverride: true, motion: AtriumMotion.describePolicy(), engine: gpu?.renderer ?? renderer, boardItems: d.items.length,
      sourceHz: 1000 / ms, physicalRefreshIntervalMs: interval, idleRAF: stats(differences(idleTicks)),
      events: {sent: sent.length, arrived: events.length, trusted: events.filter(e => e.trusted).length, operativeSent, operative: operative.length,
        fewerDeliveredSamples: Math.max(0, operativeSent - operative.length), canvasTargets: events.filter(e => e.target === canvas.id).length,
        completedDrawLatencySamples: latency.length, cameraFrames: changed.length},
      frame: {...stats(frameSamples), drops: frameSamples.filter(t => t > 1.5 * interval).length,
        missedRefreshSlots: frameSamples.reduce((sum, t) => sum + Math.max(0, Math.round(t / interval) - 1), 0)},
      jsWorkPerFrame: stats(vsyncWork), renderWork: stats(renderSamples.map(r => r.end - r.t)),
      domToScene: stats(latency.map(r => r.domToDraw)), eventStampToScene: stats(latency.map(r => r.eventStampToDraw)),
      finalCameraDrawMsAfterLastDOM: last && changed.at(-1) ? changed.at(-1).end - last.at : null,
      lastRenderMsAfterLastDOM: last && renderSamples.at(-1) ? renderSamples.at(-1).end - last.at : null,
      settled: {start, finish, expected: final, cameraOK: Object.entries(final).every(([k, n]) => Math.abs(n - finish[k]) < 1e-7),
        anchorErrorPx: kind === "pan" || kind === "plain-line" && preference === "altium" ? null : Math.hypot(actualPoint[0] - local[0], actualPoint[1] - local[1])},
      samples: {sent, events, renders: renderSamples, zooms: zooms.slice(), frame: frameSamples, jsWorkPerFrame: vsyncWork}};
    if (monitor) {
      for (let n = 0; n < 40 && !/ms p95/.test(monitorRow() || ""); n++) await wait(25);
      const value = monitorRow();
      result.monitor = {input: monitor === "menu" ? "AppKit Help menu" : "editor action", initially: emptyMonitorRow, value};
      if (!/ms p95/.test(value || "")) throw Error("Frame Monitor received no Control wheel draw sample (" + JSON.stringify(result.events) + ")");
    }
    if (idle) {
      await wait(425);
      const at = performance.now(), rendered = draws.length, uploads = window.__uploads;
      const notes = historySettles.length, trackCount = AtriumMotion.active();
      await wait(400);
      result.idle = {firstMsAfterLastDOM: last ? at - last.at : null, durationMs: performance.now() - at,
        motionTracks: [trackCount, AtriumMotion.active()], renderCalls: draws.length - rendered, uploadedBytes: window.__uploads - uploads,
        historySettlesFromLastInputMs: last ? historySettles.filter(t => t >= last.at).map(t => t - last.at) : [],
        historySettledDuringIdle: historySettles.length - notes, savedViewWrites: savedViewWrites.length,
        revisionUnchanged: H.revision() === revision, dirtyBefore: wasDirty, dirtyAfter: H.isDirty()};
    }
    if (proof && renderSamples.length) {
      const pixels = () => {
        const c = renderer === "gpu" ? G.composite(I) : canvas;
        return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      };
      await reset(); const replayStart = before();
      const replaySent = await send(steps, ms);
      let settled, replayCamera;
      capturePixels = () => { replayCamera = v.camera(); settled = pixels(); };
      await wait(340);
      capturePixels = null;
      if (!settled) throw Error("no settled frame to compare");
      const expectedCameraAtReplay = expectedCamera(kind, preference, replayStart, replaySent, rect, local);
      const replayEvents = window.__inputs.filter(changesCamera);
      const replaySentCount = replaySent.filter(e => e.dx || e.dy).length;
      const replay = {expected:expectedCameraAtReplay, camera:replayCamera, sent:replaySentCount, arrived:replayEvents.length};
      // WebKit coalesces the momentum stream. Its accumulated camera must still match every delta sent.
      const countOK = kind === "pan" ? replay.arrived > 0 && replay.arrived <= replay.sent : replay.arrived === replay.sent;
      if (!countOK || replayEvents.some(e => kind === "pinch" ? !e.trusted || e.target !== canvas.id : !trustedWheelAtPoint(e)) ||
          !Object.entries(replay.expected).every(([key, value]) => Math.abs(value - replay.camera[key]) < 1e-7))
        throw Error("pixel replay input or camera mismatch: " + JSON.stringify(replay));
      v.restoreCamera(replayCamera);
      v.invalidate(); v.settle();
      render.call(v, latestArgs[0], latestArgs[1], {...latestArgs[2], noReuse: true});
      const fresh = pixels();
      const SHA = await AtriumLazy.need("AtriumSHA256");
      const hash = rgba => SHA.bytes(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
      result.freshFrame = {bytes: fresh.length, bytesDifferent: fresh.reduce((n, b, i) => n + (b !== settled[i]), 0),
        settledSHA256: hash(settled), freshSHA256: hash(fresh), replay};
    }
    if (ack && kind === "ctrl-line") {
      for (let i = 0; i < ack; i++) {
        await reset(); const camera = before(); ackPromise = undefined; observeAck = true;
        await send([[0, i % 2 ? -1 : 1, 0]], ms);
        for (let n = 0; !ackPromise && n < 35; n++) await wait(16);
        const presentation = ackPromise ? await ackPromise : {missingSceneDraw: true};
        observeAck = false;
        const event = window.__inputs.find(e => e.type === "wheel"), scene = draws.find(d => d.changed);
        if (!event || !trustedWheelAtPoint(event) || !event.ctrl || event.dy !== (i % 2 ? 40 : -40))
          throw Error("Isolated Control wheel did not retain its trusted canvas point and signed notch");
        shots.push({camera, event, firstChangedScene: scene, presentation, firstCameraChange: zooms[0],
          domToScene: event && scene ? scene.end - event.at : null, eventStampToScene: event && scene ? scene.end - event.stamp : null});
      }
      result.isolated = {shots, domToScene: stats(shots.map(s => s.domToScene)), eventStampToScene: stats(shots.map(s => s.eventStampToScene)),
        webKitPresentationAcknowledgement: stats(shots.filter(s => s.presentation.acknowledged).map(s => s.presentation.ms)),
        sameRAF: shots.filter(s => s.firstCameraChange?.raf != null && s.firstChangedScene?.raf === s.firstCameraChange.raf).length};
    }
    result.nativeEnd = await post("state");
    if (requireSameFrame && (!ack || result.isolated?.sameRAF !== ack))
      throw Error("zoom-to-draw frame handoff: " + (result.isolated?.sameRAF ?? 0) + "/" + ack + " scenes in the camera frame");
    return result;
  } finally {
    ticking = false; v.render = render; v.zoom = zoomCamera;
    removeCameraObserver();
    if (idle) Storage.prototype.setItem = store;
  }
}

function different(a, b) {
  return a.scale !== b.scale || a.cx !== b.cx || a.cy !== b.cy || a.rotation !== b.rotation || a.flipped !== b.flipped;
}
function changesCamera(event) {
  return event.type === "gesturechange" || event.type === "wheel" && (event.dx || event.dy);
}
function differences(a) { return a.slice(1).map((t, i) => t - a[i]); }
function stats(samples) {
  const s = samples.filter(Number.isFinite).sort((a, b) => a - b);
  const p = q => s.length ? +s[Math.ceil(q * s.length) - 1].toFixed(2) : null;
  return {n: s.length, p50: p(.5), p95: p(.95), max: p(1)};
}
function feelStream(kind) {
  const out = [];
  if (kind === "pan") {
    for (let i = 0; i < 100; i++) out.push([i < 70 ? 5 : -4, i < 70 ? -3 : 3, i === 0 ? 1 : 2]);
    out.push([0, 0, 3]);
    for (let i = 0; i < 18; i++) out.push([-2, 1, i === 0 ? 5 : i === 17 ? 7 : 6]);
  } else if (kind === "pinch") {
    out.push([0, 0, 1]);
    for (let i = 0; i < 96; i++) out.push([0, i % 24 < 12 ? .02 : -.015, 2]);
    out.push([0, 0, 3]);
  } else {
    const signed = kind === "ctrl-pixel" ? [3, 4, -4, -2, -3, 2] : [1, 2, -2, -1, -2, 2];
    for (let n = 0; n < 8; n++) signed.forEach(dy => out.push([0, dy, 0]));
    out.push([0, 1, 0]);
  }
  return out;
}
function expectedCamera(kind, pref, start, sent, rect, [x, y]) {
  const {scale, cx, cy} = start;
  if (kind === "pan") return {scale, cx: cx - sent.reduce((n, e) => n + e.dx, 0) / scale, cy: cy - sent.reduce((n, e) => n + e.dy, 0) / scale};
  if (kind === "plain-line" && pref === "altium") return {scale, cx, cy: cy - sent.reduce((n, e) => n + e.dy * 40, 0) / scale};
  const units = kind.endsWith("line") ? 40 : 1;
  // WebKit stores the magnification accumulator as a float between AppKit updates.
  const ratio = kind === "pinch" ? sent.reduce((n, e) => Math.fround(n * (1 + e.dy)), 1) :
    Math.exp(sent.reduce((n, e) => n + Math.max(-120, Math.min(120, e.dy * units)) * .008, 0));
  const target = scale * ratio, shift = 1 / scale - 1 / target;
  return {scale: target, cx: cx + (x - rect.width / 2) * shift, cy: cy + (y - rect.height / 2) * shift};
}
