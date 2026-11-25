"use strict";
const native = (op, data = {}) => webkit.messageHandlers.formatBenchmark.postMessage({op, ...data});
const frame = () => new Promise(requestAnimationFrame);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok, why) => { if (!ok) throw Error(why); };
const wait = async (test, why, timeout = 25000) => {
  const end = performance.now() + timeout;
  while (!test()) { if (performance.now() > end) throw Error(typeof why === "function" ? why() : why); await Promise.race([frame(), pause(100)]); }
};
const stamp = () => performance.now();
const h = AtriumNavHost;
await wait(() => document.visibilityState === "visible", "hidden native editor", 5000);
AtriumPower.host({occluded: false});
const starter = h.project();
const prefs = await AtriumLazy.need("AtriumPrefs");
// The benchmark's own data store starts at File Open. An automatic Home may still be queued.
prefs.set("general.startPage", "never");
const start = await AtriumLazy.need("AtriumStartPage");
start.close();
await frame(); await frame();
await native("open");
await wait(() => h.project() !== starter && h.project().documents.some(d => d.kind === "pcb" && d.bodyModels?.length),
  () => "Native File Open did not supply the populated board: " + JSON.stringify({starter: h.isStarter(), docs: h.project().documents.length, dialog: document.querySelector("dialog[open]")?.textContent?.slice(0, 250)}));
await native("finishOpen");
const pcb = h.project().documents.find(d => d.kind === "pcb");
await wait(() => !!globalThis.AtriumImportReports?.recent(pcb.id), "Open did not finish the import report");
const tab = () => [...document.querySelectorAll("#document-tabs [data-tab]")].find(t => t.dataset.tab === pcb.id);
await wait(tab, "Board tab did not open");
tab().click();
await frame(); await frame();
const assets = pcb.bodyModels || [];
const bodyKeys = new Set(pcb.items.flatMap(i => (i.bodies3d || []).filter(b => b.type === "step" && assets.some(a => a.id === b.modelId))
  .map(b => i.id + "|" + b.sourceRecord)));
const extrusionKeys = new Set(pcb.items.flatMap(i => (i.bodies3d || []).filter(b => b.type === "extruded")
  .map(b => i.id + "|" + b.sourceRecord)));
check(assets.length && bodyKeys.size, "No populated STEP component bodies");

check(h.currentId() === pcb.id, "PCB did not become the active document");
let clears = [], inPhase = false, firstClear, glRef, coldResolve;
const proto = WebGL2RenderingContext.prototype, clear = proto.clear, draws = proto.drawElementsInstanced;
let issued = 0;
proto.clear = function(mask) {
  if (this.canvas.classList.contains("v3d-canvas")) {
    glRef = this;
    const now = stamp();
    if (inPhase) clears.push(now);
    if (coldResolve) {
      firstClear = now;
      const resolve = coldResolve; coldResolve = null;
      queueMicrotask(() => native("present").then(() => resolve(stamp())));
    }
  }
  return clear.call(this, mask);
};
proto.drawElementsInstanced = function(...args) {
  if (this.canvas.classList.contains("v3d-canvas")) issued++;
  return draws.apply(this, args);
};
const viewer = () => globalThis.Atrium3D && [...Atrium3D.viewers.values()][0];
function detailState() {
  const s = viewer()?.scene?.();
  const steps = assets.map(a => globalThis.AtriumSTEPImport?.cachedAsset(a));
  const loaded = new Set(assets.filter((a, i) => steps[i]?.parts.length).map(a => a.id));
  const expected = new Set(pcb.items.flatMap(i => (i.bodies3d || []).filter(b => b.type === "step" && loaded.has(b.modelId))
    .map(b => i.id + "|" + b.sourceRecord)));
  const visible = new Set((s?.batches || []).flatMap(b => b.instances.filter(i => i.bodyRecord && !i.boundsOnly).map(i => i.id + "|" + i.bodyRecord)));
  const shown = [...bodyKeys].filter(k => visible.has(k)).length;
  return {settled: !!s?.hasLayers && steps.every(Boolean) && [...expected, ...extrusionKeys].every(k => visible.has(k)),
    layers: !!s?.hasLayers, decodedAssets: loaded.size, expectedAssets: assets.length, shownPlacements: shown,
    expectedPlacements: bodyKeys.size, shownExtrusions: [...extrusionKeys].filter(k => visible.has(k)).length, expectedExtrusions: extrusionKeys.size, errors: [...new Set(steps.map(t => t?.error).filter(Boolean))]};
}
const quantile = (array, q) => {
  const sorted = array.slice().sort((a, b) => a - b);
  const index = (sorted.length - 1) * q, lo = Math.floor(index);
  return +(sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo)).toFixed(2);
};
async function enter() {
  // The nonactivating test window can receive its native occlusion update after File Open.
  // Establish the visible-view condition at the start of each measurement.
  check(document.visibilityState === "visible", "Native WebKit document is hidden");
  AtriumPower.host({occluded: false});
  check(AtriumPower.visible(), "Visible-view measurement could not start");
  const t = stamp();
  const presented = new Promise(resolve => { coldResolve = resolve; });
  h.act("view-3d");
  await wait(() => glRef && typeof firstClear === "number", () => "No real WebGL2 board draw: " + JSON.stringify({api: !!globalThis.Atrium3D,
    power: AtriumPower.state(), visibility: document.visibilityState, canvas: !!document.querySelector(".v3d-canvas"),
    hud: document.querySelector(".v3d-hud")?.textContent, stats: viewer()?.stats?.()}));
  const submitted = firstClear - t;
  const first = await presented;
  await wait(() => detailState().settled, () => "Detailed scene did not settle: " + JSON.stringify(detailState()));
  await frame(); await native("present");
  const detailPresentMs = stamp() - t;
  const v = viewer(), scene = v.scene(), detail = detailState();
  check(trial.allowMissing || detail.decodedAssets === detail.expectedAssets && detail.shownPlacements === detail.expectedPlacements,
    "The run lacks source component meshes: " + JSON.stringify(detail));
  return {submitMs: submitted, firstPresentMs: first - t, detailPresentMs, ...v.stats(),
    detail, layers: scene.hasLayers};
}
const initiallyLoaded = !!globalThis.Atrium3D;
const cold = await enter();
h.act("view-2d");
await wait(() => !document.querySelector(".v3d-canvas"), "3D canvas did not close");
firstClear = null; glRef = null;
const warm = await enter(), v = viewer();
const canvas = document.querySelector(".v3d-canvas"), rect = canvas.getBoundingClientRect();
const rendererInfo = glRef.getExtension("WEBGL_debug_renderer_info");
const gpu = {...await native("gpu"), webgl: glRef.getParameter(glRef.VERSION), renderer: glRef.getParameter(glRef.RENDERER),
  vendor: glRef.getParameter(glRef.VENDOR), unmaskedRenderer: rendererInfo ? glRef.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : null,
  unmaskedVendor: rendererInfo ? glRef.getParameter(rendererInfo.UNMASKED_VENDOR_WEBGL) : null,
  gpuTimer: !!glRef.getExtension("EXT_disjoint_timer_query_webgl2"), width: canvas.width, height: canvas.height, dpr: devicePixelRatio};
check(!gpu.active && !gpu.keyWindow, "The benchmark window took focus");
const x = Math.round(rect.left + rect.width * .59), y = Math.round(rect.top + rect.height * .48);
let events = [], zoomAnchor, captureAnchor = false;
const input = e => {
  const event = {type: e.type, trusted: e.isTrusted, x: e.clientX, y: e.clientY, shift: e.shiftKey, target: e.target === canvas,
    dx: e.deltaX, dy: e.deltaY, deltaMode: e.deltaMode, wheelDeltaY: e.wheelDeltaY};
  events.push(event);
  if (captureAnchor && !zoomAnchor && event.type === "wheel" && event.trusted && event.target)
    zoomAnchor = anchor(v.camera(), event.x - rect.left, event.y - rect.top);
};
for (const name of ["wheel", "pointerdown", "pointermove", "pointerup"]) document.addEventListener(name, input, true);
const initialCamera = structuredClone(v.camera());
await native("input", {mode: "calibrate", x, y, count: 1});
await wait(() => events.some(e => e.type === "wheel" && e.trusted), "No trusted test wheel event", 2000);
const zero = events.find(e => e.type === "wheel"), wx = 2 * x - zero.x, wy = 2 * y - zero.y;
await pause(180);
v.camera(initialCamera);
// Settle redraws and editor work before observing quiescence.
await pause(1000);
const idleStart = stamp(), heartbeat = [], n0 = issued;
inPhase = true; clears = [];
for (let i = 0; i < 61; i++) heartbeat.push(await frame());
inPhase = false;
const idle = {elapsedMs: stamp() - idleStart, draws: clears.length, instancedCalls: issued - n0,
  displayFrameMedianMs: quantile(heartbeat.slice(1).map((t, i) => t - heartbeat[i]), .5)};
check(!idle.draws && !idle.instancedCalls, "The fully detailed idle scene kept drawing");
function anchor(camera, bx, by) {
  const picked = v.pickAt(bx, by, false);
  if (picked.point) return picked.point;
  const {o, d} = picked.ray, z = o[2] >= v.scene().thickness / 2 ? v.scene().thickness : 0;
  const k = Math.abs(d[2]) > 1e-6 && (z - o[2]) / d[2] > 0 ? (z - o[2]) / d[2] : camera.dist;
  return o.map((a, i) => a + k * d[i]);
}
const coordinates = e => [e.x, e.y];
const displacement = (a, b) => Math.hypot(...a.target.map((value, i) => value - b.target[i]));
const atPointer = e => Math.abs(e.x - x) < 2 && Math.abs(e.y - y) < 2;
const phases = {};
for (const mode of ["orbit", "pan", "zoom"]) {
  const hit = document.elementFromPoint(x, y);
  check(hit === canvas, "Canvas is covered at the input point: " + hit?.tagName + "." + hit?.className +
    ", open dialog " + document.querySelector("dialog[open]")?.className);
  const before = structuredClone(v.camera());
  captureAnchor = mode === "zoom";
  events = []; clears = []; inPhase = true;
  const n = issued, clock = stamp();
  const sent = await native("input", {mode, x: mode === "zoom" ? wx : x, y: mode === "zoom" ? wy : y, count: trial.steps});
  await frame(); await frame(); inPhase = false;
  const times = clears.slice(1).map((t, i) => t - clears[i]);
  const type = mode === "zoom" ? "wheel" : "pointermove";
  const used = events.filter(e => e.type === type && e.target && e.trusted);
  check(times.length >= 3 && used.length >= 3, "Input did not redraw active viewer: " + mode + " " + JSON.stringify([times.length, used.length, events.slice(0, 2)]));
  const after = v.camera();
  let zoomErrorPx = null;
  if (mode === "orbit") check(before.yaw !== after.yaw || before.pitch !== after.pitch, "Orbit did not rotate camera");
  if (mode === "pan") check(used.every(e => e.shift) && after.target.some((p, i) => p !== before.target[i]) && after.yaw === before.yaw, "Pan did not translate camera");
  if (mode === "zoom") {
    check(after.dist !== before.dist, "Mouse wheel did not zoom: " + JSON.stringify([before.dist, after.dist, used[0]]));
    check(zoomAnchor && used.every(atPointer),
      "Wheel missed the off-centre pointer: " + JSON.stringify({wanted: [x, y], actual: [used[0], used.at(-1)]}));
    const m = Atrium3D.math, projected = m.project(m.matrices(after, rect.width / rect.height, v.scene().sphere).vp, zoomAnchor, rect.width, rect.height);
    zoomErrorPx = Math.hypot(projected[0] - (used[0].x - rect.left), projected[1] - (used[0].y - rect.top));
    check(zoomErrorPx < 2, "Zoom moved the pointer anchor: " + zoomErrorPx);
  }
  phases[mode] = {nativeInputs: sent.sent, trustedEvents: used.length, draws: clears.length, instancedCalls: issued - n,
    inputElapsedMs: sent.elapsedMs, observedMs: stamp() - clock, p50Ms: quantile(times, .50), p95Ms: quantile(times, .95),
    worstMs: Math.max(...times), over33ms: times.filter(g => g > 33.4).length, intervalsMs: times, zoomErrorPx,
    firstPointer: coordinates(used[0]), lastPointer: coordinates(used.at(-1)),
    motion: {yawDeg: after.yaw - before.yaw, pitchDeg: after.pitch - before.pitch,
      targetMm: displacement(after, before), distanceBeforeMm: before.dist, distanceAfterMm: after.dist},
    wheel: mode === "zoom" ? used[0] : null};
  await pause(120);
}
captureAnchor = false; events = [];
const beforeScroll = structuredClone(v.camera());
await native("input", {mode: "precision", x: wx, y: wy, count: 4});
await wait(() => events.filter(e => e.type === "wheel" && e.target && e.trusted).length >= 3, "Missing trusted precision scroll");
await frame(); await frame();
const precisionEvents = events.filter(e => e.type === "wheel" && e.target && e.trusted), afterScroll = v.camera();
const precision = {event: precisionEvents[0], events: precisionEvents.length,
  targetMm: displacement(afterScroll, beforeScroll), distanceChangeMm: afterScroll.dist - beforeScroll.dist};
check(precisionEvents.every(atPointer) && precision.targetMm > 0 && precision.distanceChangeMm === 0,
  "Precision scroll did not pan at the pointer: " + JSON.stringify(precision));

// A journaled track edit can rebuild copper while reusing board and component buffers.
// Hide the active viewer first and prove that the edit waits for visibility.
await pause(180);
const scene = v.scene(), track = pcb.items.find(i => i.kind === "track" && i.layer === "Top" && i.points?.length > 1);
const reusable = scene.batches.filter(b => b.kind === "board" || b.kind === "component")
  .map(b => ({positions: b.positions, buffer: b.gl?.pos}));
check(track && pcb.outline?.length && reusable.length && reusable.every(b => b.buffer), "Missing incremental test geometry");
const matchingCopper = new Set(scene.batches.filter(b => b.kind === "copper").map(b => b.positions));
AtriumPower.host({occluded: true});
const hideTime = stamp(), hiddenIssued = issued;
clears = []; inPhase = true;
check(!AtriumPower.visible() && h.edit(() => { track.width += .05; }, "Widen a track", [track]), "Hidden track edit failed");
await pause(500);
const hidden = {elapsedMs: stamp() - hideTime, draws: clears.length, instancedCalls: issued - hiddenIssued};
check(!AtriumPower.visible() && !hidden.draws && !hidden.instancedCalls && v.scene() === scene,
  "An occluded viewer drew or rebuilt its scene");
clears = [];
const revealTime = stamp();
AtriumPower.host({occluded: false});
await wait(() => v.scene() !== scene && v.scene().hasLayers && v.scene().batches.some(b => b.kind === "copper" && !matchingCopper.has(b.positions)),
  "The track edit did not reach the shown viewer");
await wait(() => clears.length, "The shown viewer did not draw the track edit");
await native("present"); inPhase = false;
const reused = reusable.filter(old => v.scene().batches.some(b => b.positions === old.positions && b.gl?.pos === old.buffer)).length;
check(reused === reusable.length && detailState().settled, "The track edit discarded unchanged 3D geometry");
Object.assign(hidden, {revealedMs: stamp() - revealTime, revealedDraws: clears.length,
  reusedGeometryBuffers: reused, originalGeometryBuffers: reusable.length});
const focus = await native("gpu");
check(!focus.active && !focus.keyWindow, "The benchmark window took focus during input");
return {cold, warm, gpu, idle, phases, precision, hidden, requestedPointer: [x, y],
  focus: {active: focus.active, keyWindow: focus.keyWindow}, initiallyLoaded, fileOrigin: location.protocol === "file:", inputSteps: trial.steps};
