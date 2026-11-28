"use strict";
globalThis.__uiProbes = {async run(_only, input) {
  try { return "RECOVERY " + JSON.stringify(await testGPUProcessRecovery(input)); }
  catch (error) { return "JSERROR " + error.message + " " + error.stack; }
}};

async function testGPUProcessRecovery({renderer}) {
  const post = (op, fields = {}) => webkit.messageHandlers.harness.postMessage({op, ...fields});
  const wait = ms => new Promise(resolve => window.__rawTimeout(resolve, ms));
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const expect = (condition, message, value) => {
    if (!condition) throw Error(message + (value === undefined ? "" : " " + JSON.stringify(value)));
  };
  const until = async (check, limit = 5000) => {
    const deadline = performance.now() + limit;
    do {
      const state = await check();
      if (state) return state;
      await wait(35);
    } while (performance.now() < deadline);
    return null;
  };
  const H = AtriumNavHost;
  const [camera, GPU, , , hash] = await AtriumLazy.need([
    "AtriumCamera", "AtriumCanvasGPU", "AtriumCanvasInput", "AtriumCanvasFast", "AtriumSHA256"
  ]);
  const project = Atrium.project("GPU recovery test", AtriumParts.catalogue), {d: board} = makeAtriumBenchmarkBoard();
  project.documents = [board];
  expect(await H.replaceProject(project, {force:true, dirty:false}), "Open the dense recovery board");
  for (const modal of document.querySelectorAll("dialog[open]")) modal.close();
  camera.setPref("mouse.wheel", "zoom");
  camera.setPref("mouse.zoomAt", "pointer");
  camera.setPref("camera.animate", true);
  const canvas = H.canvas(), view = H.view(), internals = view.internals();
  GPU.enable(renderer === "gpu");
  await frame();
  view.fit(H.doc(), H.defs());
  const r = canvas.getBoundingClientRect();
  const x = Math.round(r.left + r.width * .41), y = Math.round(r.top + r.height * .46);
  view.zoom(3, [r.width * .41, r.height * .46]);
  H.redraw(true);
  const rendererReady = await until(() => {
    const state = GPU.status(internals);
    return state.renderer === renderer && (renderer === "2d" || GPU.stats(internals)?.submitted) && state;
  });
  if (!rendererReady && renderer === "gpu") {
    const probe = document.createElement("canvas");
    const accelerated = probe.getContext("webgl2", {failIfMajorPerformanceCaveat:true});
    if (!accelerated) return {skip:"hardware WebGL2 is unavailable", status:GPU.status(internals)};
  }
  expect(rendererReady, "Start the requested renderer", GPU.status(internals));
  const native = await post("feel-state");
  expect(native.wheelEventBindingSupported && native.requestedDisplayMatched, "Trusted input is available on the test display", native);
  const state = () => post("gpu-process-state");
  const initial = await until(async () => {
    const p = await state();
    return p.isolated && p;
  }, 2200);
  if (!initial) return {skip:"cannot establish an exclusive WebKit GPU process", state:await state()};

  const refused = [];
  for (const pid of [0, initial.hostPID, initial.webPID]) {
    const result = await post("gpu-process-exit", {pid});
    expect(!result.requested && (await state()).gpuPID === initial.gpuPID,
      "An unowned target is rejected before any termination", {pid,result});
    refused.push({pid, reason:result.reason});
  }

  const geometry = () => hash.bytes(new TextEncoder().encode(JSON.stringify([H.doc().outline, H.doc().items])));
  const initialGeometry = geometry(), itemCount = H.doc().items.length;
  expect(itemCount >= 25000, "The dense board has at least 25,000 items", itemCount);
  // Publishing the online checks changes the board overlay without an edit.
  // Keep the same findings visible in the recovery frame and its reference.
  const [drc] = await AtriumLazy.need(["AtriumDRCView", "AtriumDRCMarkers"]);
  expect(await until(() => drc.violations(H.doc().id).length > 0 && drc.status() === null, 15000),
    "The dense board published its DRC findings before the pixel comparison", drc.status());
  H.redraw(true);
  const clip = {x:Math.floor(r.left + r.width * .19), y:Math.floor(r.top + r.height * .20),
    w:Math.floor(r.width * .62), h:Math.floor(r.height * .57)};
  // The strip is outside the copper crop but travels in the same WebKit snapshot.
  const stamp = document.createElement("canvas");
  stamp.width = stamp.height = 4;
  stamp.setAttribute("aria-hidden", "true");
  stamp.style.cssText = `position:fixed;left:${clip.x}px;top:${clip.y + clip.h}px;width:8px;height:8px;image-rendering:pixelated;pointer-events:none;z-index:2147483647`;
  document.body.append(stamp);
  const ink = stamp.getContext("2d", {alpha:false});
  const snapshot = name => post("gpu-process-snapshot", {...clip, name, frameStrip:8});
  expect(Array.isArray(window.__inputs), "The document-start trusted input collector is loaded");
  window.__inputs.length = 0;
  const wheel = () => window.__inputs.filter(event => event.type === "wheel" && (event.dx || event.dy));
  const takeWheel = () => {
    const events = wheel();
    window.__inputs.length = 0;
    return events;
  };
  const steps = [1, 2, -2, -1, -2, 2, 1, 2, -2, -1, -2, 2].map(delta => [0, delta, 0]);
  const send = async afterThird => {
    const sent = [];
    for (const [index, step] of steps.entries()) {
      sent.push(...await post("feel-input", {kind:"ctrl-line", x, y, ms:36, steps:[step]}));
      expect(await until(() => wheel().length >= index + 1, 2000),
        "WebKit delivered the signed detent", {index,delivered:wheel().map(event => event.dy)});
      if (index === 2 && afterThird) await afterThird();
    }
    return sent;
  };
  const originalRender = view.render;
  let lastRender, draws = 0, drawnBy, recovery;
  const frames = new Map();
  globalThis.AtriumCanvasGPU = {...GPU, render(...args) {
    const painted = GPU.render(...args);
    if (args[0] === internals) drawnBy = painted ? "gpu" : "2d";
    return painted;
  }};
  view.render = function (...args) {
    lastRender = args;
    drawnBy = null;
    const result = originalRender.apply(this, args);
    const id = ++draws;
    if (drawnBy) {
      const drawn = {id, renderer:drawnBy, camera:view.camera(), ms:performance.now(), fresh:!!args[2]?.noReuse};
      if (recovery && id > recovery.atDraw) {
        recovery.firstSubmission ||= drawn;
        if (drawnBy === renderer) recovery.firstRequestedSubmission ||= drawn;
      }
      frames.set(id, drawn);
      for (let bit = 0; bit < 16; bit++) {
        ink.fillStyle = id & (1 << bit) ? "#fff" : "#000";
        ink.fillRect(bit % 4, bit >> 2, 1, 1);
      }
    }
    return result;
  };
  const checkInput = (sent, delivered) => {
    expect(sent.length === steps.length && delivered.length === steps.length, "Every signed wheel detent reached the canvas",
      {sent:sent.map(e => e.dy), delivered:delivered.map(e => e.dy), target:delivered.map(e => e.target)});
    for (let i = 0; i < steps.length; i++) {
      const e = delivered[i];
      expect(e.trusted && e.target === canvas.id && e.ctrl && e.x === x && e.y === y && e.dy === -40 * steps[i][1],
        "A wheel event kept its sign and targeted the trusted canvas", {i,e});
    }
  };
  const followsCamera = (before, after) => ["cx", "cy", "scale"].every(key => Math.abs(before[key] - after[key]) < 1e-7);
  let inspected;
  const presented = async (name, at, since, copper, fresh = false) => {
    const shot = await snapshot(name);
    const drawn = frames.get(shot.frameID);
    inspected = {drawn, copper:shot.copper, frameID:shot.frameID, error:shot.error};
    if (recovery && drawn?.id > recovery.atDraw && shot.copper >= copper) {
      recovery.firstPresented ||= {drawn, ms:performance.now() - recovery.requestMs};
    }
    return drawn?.id > since && drawn.renderer === renderer && followsCamera(at, drawn.camera) &&
      (!fresh || drawn.fresh) && shot.copper >= copper && {shot, drawn, ms:performance.now()};
  };
  try {
    const initialCamera = view.camera();
    const ordinary = await send();
    await wait(400);
    checkInput(ordinary, takeWheel());
    expect(followsCamera(initialCamera, view.camera()), "The ordinary signed zoom returns to its exact camera");
    const start = await until(() => presented("before", initialCamera, 0, 101));
    expect(start, "The requested renderer presents the starting camera and dense board copper", inspected);
    const baseline = start.shot;
    const runs = [];
    let current = initial;
    for (let n = 1; n <= 2; n++) {
      const precedingPID = current.gpuPID;
      const before = view.camera(), beforeDraw = draws;
      let beforeExitCount, drawsAtExit, during;
      const sent = await send(async () => {
        expect(await until(() => draws > beforeDraw && !followsCamera(before, view.camera()), 1500),
          "A zoomed scene was displayed before the process exit", view.camera());
        beforeExitCount = wheel().length;
        const exit = await post("gpu-process-exit", {pid:precedingPID});
        expect(exit.requested && exit.gpuPID === precedingPID, "The guarded WebKit GPU exit occurred", exit);
        drawsAtExit = draws;
        recovery = {atDraw:drawsAtExit, requestMs:performance.now()};
        during = snapshot("during-" + n);
      });
      checkInput(sent, takeWheel());
      current = await until(async () => {
        const p = await state();
        return p.isolated && p.webPID === initial.webPID &&
          p.gpuPID !== precedingPID && p.exited.includes(precedingPID) && p;
      }, 11000);
      expect(current, "The old test GPU process exited and a different isolated GPU process took over", await state());
      expect(await until(() => draws > drawsAtExit && followsCamera(before, view.camera()), 3500),
        "The signed zoom returned to its exact camera with a new scene draw", view.camera());
      await wait(350);
      const recovered = await until(() => presented("after-" + n, before, drawsAtExit, baseline.copper * .7), 5000);
      expect(recovered, "The requested renderer presents the exact camera and retained copper after GPU restart",
        {inspected, recovery, status:GPU.status(internals)});
      const {shot:after, drawn:afterDraw} = recovered, renderedBy = afterDraw.renderer;
      view.invalidate();
      view.settle();
      const repainted = await until(async () => {
        view.render(lastRender[0], lastRender[1], {...lastRender[2], noReuse:true});
        const freshId = draws;
        await frame(); await frame();
        const observed = await presented("fresh-" + n, before, freshId - 1, baseline.copper * .7, true);
        // The compositor can show a later automatic repaint before the snapshot arrives.
        // Request another reference only when this capture missed the submitted frame.
        if (inspected.frameID !== freshId) return null;
        expect(observed, "The presented reference has the exact camera, renderer and copper", inspected);
        return observed;
      }, 3000);
      expect(repainted, "A fresh complete render presents the same camera on the requested renderer", inspected);
      const {shot:fresh, drawn:freshDraw} = repainted;
      expect(fresh.sha256 === after.sha256, "Settled viewport pixels match a fresh complete render", {after, fresh, afterDraw, freshDraw});
      expect(geometry() === initialGeometry && H.doc().items.length === itemCount && !H.isDirty(),
        "Process recovery and signed zoom preserved the exact project geometry");
      runs.push({precedingPID, newPID:current.gpuPID, beforeExitCount, sent:sent.length, drawsAfterExit:draws - drawsAtExit,
        renderer:renderedBy, during:await during, after, fresh, afterDraw, freshDraw,
        firstSubmission:recovery.firstSubmission, firstRequestedSubmission:recovery.firstRequestedSubmission,
        firstPresented:recovery.firstPresented, presentationObservedMs:recovered.ms - recovery.requestMs,
        exitObservedMs:recovery.requestMs, status:GPU.status(internals)});
      recovery = null;
    }
    const finalCamera = view.camera(), finalBurst = await send();
    await wait(420);
    checkInput(finalBurst, takeWheel());
    expect(followsCamera(finalCamera, view.camera()), "Signed zoom still works after both process restarts");
    const afterInput = await presented("after-input", finalCamera, 0, baseline.copper * .7);
    expect(afterInput && geometry() === initialGeometry,
      "The requested renderer and copper survive post-restart signed input", inspected);
    const verifiedDetents = ordinary.length + finalBurst.length + runs.reduce((total, run) => total + run.sent, 0);
    return {renderer, native, initial, refused, itemCount, geometry:initialGeometry, baseline,
      runs, afterInput:afterInput.shot, verifiedDetents, final:await state()};
  } finally {
    view.render = originalRender;
    globalThis.AtriumCanvasGPU = GPU;
    stamp.remove();
  }
}
