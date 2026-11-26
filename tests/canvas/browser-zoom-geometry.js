"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const launch = require("../support/standalone-chromium.cjs");
const {instrumentCallbacks, measureZoomSettle, visibleSettledLettering} = require("../support/browser-zoom-probe.cjs");
const root = path.join(__dirname, "../..");
const fixtureNames = [
  "tests/fixtures/import/demo.kicad_pcb",
  "tests/fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc"
];
function input() {
  const names = process.env.ZOOM_BOARDS?.split(",");
  const files = [...fixtureNames, ...(process.env.ZOOM_BOARD ? [process.env.ZOOM_BOARD] : [])]
    .filter(f => !names || names.includes(path.basename(f)));
  return {
    synthetic: !names || names.includes("synthetic"),
    mutations: process.env.ZOOM_MUTATION?.split(","),
    nativeBoard: process.env.ZOOM_NATIVE_BOARD,
    renderers: process.env.ZOOM_RENDERERS?.split(","),
    cases: process.env.ZOOM_CASES?.split(","),
    frameImages: process.env.ZOOM_FRAME_IMAGES === "1",
    fixtures: files.map(f => ({name: path.basename(f), data: fs.readFileSync(path.resolve(root, f)).toString("base64")}))
  };
}

const VIEWPORT = {width:1300, height:860};
const CASES = {
  geometry: [{check:checkGeometry, page:{viewport:VIEWPORT,deviceScaleFactor:2}, app:process.env.ZOOM_APP}],
  settle: [{check:checkSettle, page:{viewport:{width:1400,height:900}}, init:instrumentCallbacks}],
  surfaces: ["gpu","2d"].map(renderer => ({check:checkSurfaces, page:{viewport:VIEWPORT}, renderer}))
};

async function zoomChecks(cases = ["geometry"]) {
  const executablePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  for (const name of cases) {
    assert.ok(Object.hasOwn(CASES,name), "Unknown zoom case: " + name);
    try { require.resolve("playwright-core"); }
    catch { console.log("SKIP browser-zoom-" + name + ": Playwright Core is unavailable."); continue; }
    if (!fs.existsSync(executablePath)) {
      console.log("SKIP browser-zoom-" + name + ": Chrome is unavailable.");
      continue;
    }
    // The recovery checks deliberately crash the GPU process, so give each renderer its own browser.
    for (const {check, page:options, init, app, renderer} of CASES[name]) {
      await launch({headless:true, executablePath, args:["--allow-file-access-from-files"]}, async browser => {
        const page = await browser.newPage(options), errors = [];
        page.on("pageerror", error => errors.push(error.message));
        if (init) await page.addInitScript(init);
        await page.goto(pathToFileURL(path.resolve(app || path.join(root, "app"), "index.html")).href);
        await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
        await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
        await check({browser, page, errors, renderer});
      }, error => { throw error; });
    }
  }
}

async function checkGeometry({page, errors}) {
  const folder = process.env.ZOOM_REPORT;
  await page.addScriptTag({path: path.join(__dirname, "zoom-geometry-probe.js")});
  if (folder) {
    fs.mkdirSync(folder, {recursive: true});
    await page.exposeFunction("__geometryEvidence", (name, actual, expected) => {
      for (const [type, url] of [["actual", actual], ["reference", expected]])
        fs.writeFileSync(path.join(folder, name + "-" + type + ".png"), Buffer.from(url.split(",", 2)[1], "base64"));
    });
  }
  await page.exposeFunction("__geometryScreen", async clip => ({
    png: (await page.screenshot({clip, scale: "device"})).toString("base64"), source: "chrome-compositor"
  }));
  const result = await page.evaluate(options => atriumZoomGeometry({...options, evidence: globalThis.__geometryEvidence, screen: globalThis.__geometryScreen}), input());
  if (folder) fs.writeFileSync(path.join(folder, "chrome.json"), JSON.stringify({...result, errors}, null, 2) + "\n");
  const rows = Object.entries(result.boards).flatMap(([board, b]) => Object.entries(b.renders).map(([renderer, runs]) =>
    Array.isArray(runs) ? `${board}/${renderer} ${runs.reduce((n, p) => n + p.frames.filter(f => f.moving).length, 0)} moving frames` : `${board}/${renderer} skipped (${runs.skipped})`));
  console.log("browser-zoom-geometry: " + rows.join(", "));
  assert.equal(result.dpr, 2, "Chrome uses a Retina backing store");
  assert.deepEqual(errors, [], "no uncaught editor errors");
  if (result.mutations.length) {
    const runs = result.boards.synthetic?.renders.gpu;
    const injected = Array.isArray(runs) ? runs.flatMap(r => r.frames.filter(f => f.mutated)) : [];
    assert.deepEqual(injected.map(f => f.mutated), result.mutations, "each injection affected exactly one moving frame");
    for (const damaged of injected) {
      const target = damaged.mutated === "one-frame" ? "track" : damaged.mutated;
      assert.ok(damaged.moving && damaged.loss?.[target]?.loss, "geometry check caught " + target + " in the injected moving frame");
    }
  }
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures.slice(0, 20)));
}

// Dense board gesture and settled callback budgets, plus exact lettering at rest.
async function checkSettle({page, errors}) {
  await page.addScriptTag({path: path.join(__dirname, "../pcb/dense-board.js")});
  const ready = await page.evaluate(async () => {
    const wait = ms => new Promise(r => window.__rawTimeout(r, ms)), H = AtriumNavHost;
    await AtriumLazy.need(["AtriumCanvasFast", "AtriumCanvasGPU"]);
    const G = globalThis.AtriumCanvasGPU;
    const hardware = AtriumCanvasGPUPref.decision(true);
    if (!hardware.use || hardware.software) return {unavailable: hardware.reason || "no hardware WebGL2"};
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    const p = Atrium.project("Dense", AtriumParts.catalogue);
    const {d} = makeAtriumBenchmarkBoard(); p.documents = [d]; // no sheet: no cross-document badges (checks-cross.js)
    let k = 0;
    for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++; }
    await H.replaceProject(p, {force: true}); H.selectDocument(d.id);
    for (const x of document.querySelectorAll("dialog[open]")) x.close();
    G.enable(null);
    window.dispatchEvent(new CustomEvent("atrium-command", {detail: "fit"})); H.redraw(true); await wait(1500);
    const v = H.view(), r = H.canvas().getBoundingClientRect();
    v.zoom(8, [r.width / 2, r.height / 2]); H.redraw(true); await wait(2500);
    // The synthetic board breaks every clearance rule: thousands of DRC markers, repainted at screen size for
    // each zoom frame, are a separate cost (drc-markers.js, problem-marks.js). This measures the board's own.
    await AtriumLazy.need("AtriumDRCMarkers").catch(() => null);
    globalThis.AtriumDRCMarkers?.setVisible?.(false, H); H.redraw(true); await wait(800);
    return G.status(v.internals());
  });
  if (ready.unavailable) { console.log("SKIP browser-zoom-settle: " + ready.unavailable); return; }
  assert.equal(ready.renderer, "gpu", `hardware WebGL2 rendered the dense board: ${JSON.stringify(ready)}`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", {rate: 4});
  let result;
  try {
    result = await page.evaluate(measureZoomSettle, {renderer:"gpu", events:8, quietMs:900, bursts:[
      {deltaY:6,ctrlKey:true}, {deltaY:-6,ctrlKey:true}, {deltaY:3,deltaMode:1}, {deltaY:-3,deltaMode:1},
      {deltaX:14,deltaY:9}, {deltaY:-4,ctrlKey:true}, {deltaY:4,ctrlKey:true},
    ]});
  } finally { await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1}); }
  const ink = await page.evaluate(visibleSettledLettering);
  const s = JSON.stringify({...result, glyphs:ink});
  assert.deepEqual(result.fallback, [], "the measured frames stay on GPU: " + s);
  assert.ok(result.perBurst.every(row => row.gesture && row.settled), "each burst has measured gesture and settled callbacks: " + s);
  assert.ok(result.gesture.n > 20 && result.gesture.p95 <= 8, "gesture frames p95 <= 8 ms at 4x CPU throttle: " + s);
  assert.ok(result.settled.p95 <= 8, "main-thread work after a zoom p95 <= 8 ms at 4x CPU throttle: " + s);
  assert.ok(result.settled.max <= 30, "no callback after a zoom over 30 ms (including rendering) at 4x CPU throttle: " + s);
  assert.deepEqual(ink.fallback, [], "actual GPU lettering: " + JSON.stringify(ink));
  assert.ok(ink.initialInk && ink.gestureInk && ink.settledInk && ink.exactInk && ink.sameSettledInk,
    "visible lettering survives zoom and exactly matches at rest: " + JSON.stringify(ink));
  if (ink.backend === "retained")
    assert.ok(ink.sameGestureInk && ink.reusedRetainedData,
      "retained lettering renders the exact camera without rebuilding: " + JSON.stringify(ink));
  assert.deepEqual(errors, [], "no page errors");
  console.log("browser-zoom-settle: ok (" + s + ")");
}

// Compare compositor screenshots before and after GPU process crashes during zoom reversals.
async function checkSurfaces({browser, page, errors, renderer:which}) {
  const crashGpu = await browser.newBrowserCDPSession();
  await page.exposeFunction("__crashGpu", () => crashGpu.send("Browser.crashGpuProcess").then(() => true, () => false));
  await page.exposeFunction("__screen", async (x, y, width, height) => (await page.screenshot({clip: {x, y, width, height}})).toString("base64"));
  const ready = await page.evaluate(async which => {
    const H = AtriumNavHost, wait = ms => new Promise(r => setTimeout(r, ms));
    await AtriumLazy.need(["AtriumCanvasGPU"]).catch(() => null);
    const G = globalThis.AtriumCanvasGPU;
    if (which === "gpu") {
      if (!G) throw Error("The GPU renderer module did not load");
      const hardware = AtriumCanvasGPUPref.decision(true);
      if (!hardware.use || hardware.software) return {unavailable: hardware.reason || "no hardware WebGL2"};
    }
    G?.enable?.(which === "gpu" ? null : false);
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    // A via with a net, in the middle of the view, for its caption.
    const v = H.view(), cv = H.canvas(), r = cv.getBoundingClientRect(), [x, y] = v.screenToWorld([r.width / 2, r.height / 2]);
    H.edit(() => H.doc().items.push({id: "zoom-via", kind: "via", x, y, diameter: .8, drill: .4, net: "VIANET", fromLayer: "Top", toLayer: "Bottom"}));
    window.dispatchEvent(new CustomEvent("atrium-command", {detail: "fit"}));
    H.redraw(true); await wait(700); H.redraw(true); await wait(400);
    return G?.status(v.internals()) ?? {renderer:"2d"};
  }, which);
  if (ready.unavailable) { console.log("SKIP browser-zoom-surfaces: " + ready.unavailable); return; }
  assert.equal(ready.renderer, which, "the requested renderer drew before the crash test: " + JSON.stringify(ready));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", {rate: 4});
  const result = await page.evaluate(async which => {
    const H = AtriumNavHost, v = H.view(), cv = H.canvas(), I = v.internals(), G = globalThis.AtriumCanvasGPU;
    const wait = ms => new Promise(r => setTimeout(r, ms)), frame = () => new Promise(r => requestAnimationFrame(() => r()));
    const r = cv.getBoundingClientRect(), W = 320, Hh = Math.round(W * r.height / r.width);
    const probe = document.createElement("canvas"); probe.width = W; probe.height = Hh;
    const g = probe.getContext("2d", {willReadFrequently: true});
    const inks = ["Top", "Bottom", "Multi"].map(l => AtriumPCBAppearance.color(l).match(/[\da-f]{2}/gi).map(h => parseInt(h, 16)));
    // The share of the view's on-screen pixels in a copper colour.
    const copper = async () => {
      const img = new Image(); img.src = "data:image/png;base64," + await window.__screen(r.left, r.top, r.width, r.height); await img.decode();
      g.clearRect(0, 0, W, Hh); g.drawImage(img, 0, 0, W, Hh);
      const d = g.getImageData(0, 0, W, Hh).data; let n = 0;
      for (let k = 0; k < d.length; k += 4) if (inks.some(c => Math.abs(d[k] - c[0]) < 40 && Math.abs(d[k + 1] - c[1]) < 40 && Math.abs(d[k + 2] - c[2]) < 40)) n++;
      return n / (W * Hh);
    };
    // Renders stopped (the exact frame after the gesture, and anything after a context restore).
    let renders = 0; const render = v.render;
    v.render = function (...a) { renders++; return render.apply(this, a); };
    // A lost 2D canvas (between the crash and Chrome restoring it, seconds under load) shows nothing whatever
    // the app does: the check is what the view shows once Chrome hands the canvas back.
    const lost = () => !!cv.getContext("2d").isContextLost?.();
    const settle = async () => {
      await wait(500);
      for (let k = 0; k < 8; k++) {
        for (let n = 0; n < 160 && lost(); n++) await wait(125);
        for (let n = 0, last = -1; n < 40 && last !== renders; n++) { last = renders; await wait(250); }
        if (!lost()) break;
      }
      await frame(); await frame();
    };
    const wheel = (dy, fx, fy) => cv.dispatchEvent(new WheelEvent("wheel", {clientX: r.left + fx * r.width, clientY: r.top + fy * r.height, bubbles: true, cancelable: true, deltaY: dy, deltaMode: 1}));
    v.zoom(2, [r.width / 2, r.height / 2]); H.redraw(true); await settle();
    const baseline = await copper(), shares = [], crashes = [];
    for (let c = 0; c < 6; c++) {
      const fx = .4 + c * .04, fy = .45 + (c % 3) * .04;
      for (let i = 0; i < 6; i++) { wheel(3, fx, fy); await wait(14); }
      // Chrome reports the loss some time after the crash: the bursts go on meanwhile, as a user's would.
      if (c === 1 || c === 4) crashes.push(await window.__crashGpu());
      for (let i = 0; i < 6; i++) { wheel(-3, fx, fy); await wait(14); }
      await settle();
      if (c === 1 || c === 4) { await wait(1500); await settle(); }
      shares.push(+(await copper()).toFixed(4));
    }
    v.render = render;
    // Isolate the via and compare the same pixels with net names on and off.
    const doc = H.doc(), via = doc.items.find(i => i.id === "zoom-via"), captions = {};
    const opts = {editorPane: true, noReuse: true, grid: false, origin: false, hide: new Set(doc.items.filter(i => i !== via)), hidden: new Set(["Source pours"])};
    const sample = (layer, netNames) => {
      v.render(doc, H.defs(), {...opts, layer, netNames});
      const surface = G?.composite(I) || cv;
      return surface.getContext("2d").getImageData(Math.floor(surface.width / 2) - 12, Math.floor(surface.height / 2) - 3, 24, 6).data;
    };
    const rgb = (a, i) => a[i] + a[i + 1] + a[i + 2];
    for (const [name, px, layer, sign] of [["large", 34, "Top", 1], ["small", 8, "Top", 0], ["light", 34, "Silk", -1]]) {
      v.restoreCamera({...v.camera(), cx: via.x, cy: via.y, scale: px / via.diameter});
      const blank = sample(layer, false), shown = sample(layer, true);
      captions[name] = 0;
      for (let i = 0; i < shown.length; i += 4) {
        const delta = rgb(shown, i) - rgb(blank, i);
        if ((sign ? sign * delta : Math.abs(delta)) > 120) captions[name]++;
      }
    }
    return {baseline: +baseline.toFixed(4), shares, crashes, captions, renderer: G?.status?.(I)?.renderer || "2d"};
  }, which);
  await cdp.send("Emulation.setCPUThrottlingRate", {rate: 1});
  assert.ok(result.baseline > .02, which + ": the zoomed board shows copper before the bursts: " + JSON.stringify(result));
  result.shares.forEach((s, c) => assert.ok(s >= result.baseline * .5,
    which + ": after zoom burst " + c + " (GPU process ended mid-burst in bursts 1 and 4) the board's copper is on screen: " + JSON.stringify(result)));
  const {large, small, light} = result.captions;
  assert.ok(large >= 6 && small === 0 && light >= 6, which + ": a via shows a contrasting net caption only when large enough: " + JSON.stringify(result.captions));
  assert.deepEqual(errors, [], which + ": no page errors");
  console.log("browser-zoom-surfaces: " + which + " copper " + result.baseline + " -> " + result.shares.join("/") + " (ends on " + result.renderer + "; via pixels " + [large, small, light].join("/") + ")");
}

module.exports = zoomChecks;
if (require.main === module) {
  const cases = process.argv.slice(2);
  if (cases.includes("--input")) console.log(JSON.stringify(input()));
  else zoomChecks(cases.length ? cases : undefined).catch(error => { console.error(error); process.exitCode = 1; });
}
