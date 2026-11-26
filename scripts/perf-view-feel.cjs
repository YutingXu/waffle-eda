"use strict";
// PCB view feel on an imported Altium board with pours (default: the PiDP-11 I/O expander in
// tests/fixtures/altium/pidp11-io-expander), in headless Chrome with the GPU, for each board renderer
// (the WebGL2 renderer of app/canvas/canvas-gpu.js where it is hardware-accelerated, and the 2D canvas):
//
//   zoom   Pinch and wheel zooms in and out and a two-finger pan, in bursts of input every 16 ms. The
//          last gesture frame of each burst (the previous rendering moved and scaled while the exact
//          frame is prepared) is compared with the exact frame that replaces it at rest, at the same
//          camera: `blank` is the share of pixels of the exact frame that no pixel within one pixel of it in
//          the gesture frame matches within 64 levels per channel (resampling only shifts and softens edges).
//          Text, pad numbers or copper a gesture frame left out show up here as a gap that pops back.
//          Budget: every burst's blank <= BUDGET_ZOOM_BLANK (0.01). For an older GPU backend only,
//          a gesture scaling its previous raster text beyond 3× coverage uses BUDGET_ZOOM_SCALED_BLANK (0.03).
//   settle Bursts without pixel capture under CPU_THROTTLE (4×). Gesture render() p95 <= BUDGET_ZOOM_FRAME
//          (8 ms). Each outermost wrapped DOM, timer, animation-frame, idle or worker-message callback
//          starting within 700 ms after the last event dispatch returns contributes one sample.
//          Settled callback p95 <= BUDGET_ZOOM_SETTLE (8 ms), max <= 30 ms.
//   drag   A part in the pours (PART, default R4) dragged with pointer moves every 8 ms for 2 s, with
//          the default "Polygon pours while dragging: Follow the part". Our main-thread work (every
//          event listener, animation-frame, timer, idle and worker-message callback) is charged to the
//          pointer move it follows: `work` is p50/p95/max ms per move. Budget: p95 <= BUDGET_DRAG_P95 (8).
//          The last drag frame (the text layer repainted only where the part moved) is then compared with
//          the same state drawn whole, as for zoom: `mismatch` <= BUDGET_DRAG_MISMATCH (0.001).
//          On the GPU, `textShare` is the text layer uploaded per drag frame as a share of the whole layer
//          (the moved part's area only): <= BUDGET_DRAG_TEXT (0.25). WebKit copies a canvas for each upload
//          on the main thread, so a whole layer per frame made drags lag there (30 ms frames on a 4-layer board).
//          `frames` counts renders, `render` their time, `upload` the 2D layers sent to the GPU per frame and
//          `drop` the pointerup handler and its frame, reported only.
//   pan    A two-finger trackpad pan (trackpadStream: 120 Hz pixel deltas on both axes, four swipes with
//          momentum tails and short rests between them) at fit, x4 and x14. `frame` is the rAF interval
//          p50/p95/max with dropped frames (over 1.5 refresh intervals), `work` our main-thread ms charged
//          to each wheel event (up to two frames after it), `upload` the texture bytes per pan frame (on the
//          GPU, as a share of one full layer), `labels` the pan frames that placed the net names afresh and
//          `wide` the GPU's wide copies drawn mid-pan. A second run captures frames: `blank` compares the last
//          pan frame with the exact frame at rest, as for zoom. Budgets: blank <= BUDGET_PAN_BLANK (0.01),
//          work p95 <= BUDGET_PAN_WORK (4 ms), frame p95 <= BUDGET_PAN_FRAME (1.5) refresh intervals and, on
//          the GPU, upload <= BUDGET_PAN_UPLOAD (0.1) of a layer per frame: a pan moves the retained layers and
//          draws only the strips it uncovers. native/tests/macos-harness/pan.sh runs the same stream in WKWebView.
//
// Usage: scripts/perf-view-feel.sh [--json] (finds node and playwright-core), or node scripts/perf-view-feel.cjs [--json]
// Env:   CHROME=/path/to/chrome  APP=/path/to/app (A/B)  BOARD=file[,file...] (an Altium project's files: .PrjPcb, .SchDoc, .PcbDoc)
//        PART=R4  ONLY=gpu|2d  ZOOM=0 (skip)  DRAG=0 (skip)  PAN=0 (skip)  SETTLE=0 (skip)  CPU_THROTTLE=4  BUDGET_ZOOM_FRAME=8  BUDGET_ZOOM_SETTLE=8  BUDGET_ZOOM_BLANK=0.01  BUDGET_ZOOM_SCALED_BLANK=0.03  BUDGET_DRAG_P95=8
//        BUDGET_DRAG_MISMATCH=0.001  BUDGET_DRAG_TEXT=0.25  BUDGET_PAN_BLANK=0.01  BUDGET_PAN_WORK=4  BUDGET_PAN_FRAME=1.5
//        BUDGET_PAN_UPLOAD=0.1
// Exit status: 0 within budget, 1 over budget, 2 no browser or the probe failed.
const path = require("node:path"), {pathToFileURL} = require("node:url");
const {instrumentCallbacks, measureZoomSettle} = require("../tests/support/browser-zoom-probe.cjs");
const root = path.resolve(__dirname, ".."), app = path.resolve(process.env.APP || path.join(root, "app"));
const json = process.argv.includes("--json");
const fixture = path.join(root, "tests/fixtures/altium/pidp11-io-expander");
const files = process.env.BOARD ? process.env.BOARD.split(",") :
  ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"].map(n => path.join(fixture, n));
const budget = {throttle: +(process.env.CPU_THROTTLE || 4), zoomFrame: +(process.env.BUDGET_ZOOM_FRAME || 8), zoomSettle: +(process.env.BUDGET_ZOOM_SETTLE || 8), zoomSettleMax: 30, zoomBlank: +(process.env.BUDGET_ZOOM_BLANK || .01), zoomScaledBlank: +(process.env.BUDGET_ZOOM_SCALED_BLANK || .03), dragP95: +(process.env.BUDGET_DRAG_P95 || 8), dragMismatch: +(process.env.BUDGET_DRAG_MISMATCH || .001),
  dragText: +(process.env.BUDGET_DRAG_TEXT || .25), panBlank: +(process.env.BUDGET_PAN_BLANK || .01), panWork: +(process.env.BUDGET_PAN_WORK || 4),
  panFrame: +(process.env.BUDGET_PAN_FRAME || 1.5), panUpload: +(process.env.BUDGET_PAN_UPLOAD || .1)};
const stream = trackpadStream();

// Pixel comparison and WebGL upload counters used by the existing view probes.
function instrument() {
  const W = window;
  // Bytes sent to WebGL textures (a pan should send only newly exposed strips, if anything).
  W.__uploads = 0;
  const GL = W.WebGL2RenderingContext?.prototype;
  if (GL) for (const k of ["texSubImage2D", "texImage2D"]) {
    const raw = GL[k];
    GL[k] = function (...a) {
      const src = a[a.length - 1], sub = k === "texSubImage2D";
      const w = a.length >= 9 ? a[sub ? 4 : 3] : src?.width, h = a.length >= 9 ? a[sub ? 5 : 4] : src?.height;
      if (src && typeof w === "number" && typeof h === "number") W.__uploads += w * h * 4;
      return raw.apply(this, a);
    };
  }
  HTMLCanvasElement.prototype.setPointerCapture = function () {}; HTMLCanvasElement.prototype.releasePointerCapture = function () {};
  // The share of pixels of frame b that no pixel within one pixel of it in frame a (both RGBA, w x h) matches
  // within 64 levels per channel: resampling and antialiasing shift and soften edges, a missing object does not match.
  W.__unmatched = (a, b, w, h) => {
    let n = 0;
    const near = (k, j) => Math.max(Math.abs(b[k] - a[j]), Math.abs(b[k + 1] - a[j + 1]), Math.abs(b[k + 2] - a[j + 2])) <= 64;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const k = (y * w + x) * 4;
      let ok = false;
      for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1 && !ok; dx++) ok = near(k, k + (dy * w + dx) * 4);
      if (!ok) n++;
    }
    return +(n / ((w - 2) * (h - 2))).toFixed(5);
  };
}

async function open(browser) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(instrumentCallbacks);
  await page.addInitScript(instrument);
  await page.goto(pathToFileURL(path.join(app, "index.html")).href);
  const choosing = page.waitForEvent("filechooser");
  await page.locator('dialog.sp-dialog[open] [data-start-action="import"]').click();
  await (await choosing).setFiles(files);
  await page.waitForFunction(() => globalThis.AtriumNavHost?.project().documents.some(d => d.kind === "pcb" && d.items.length > 20), null, {timeout: 120000});
  await page.evaluate(() => { for (const d of document.querySelectorAll("dialog[open]")) d.close(); });
  await page.evaluate(() => AtriumLazy.need("AtriumCanvasGPU").then(() => undefined));
  // Post-import work (drafts, checks, pour tiles) settles before anything is timed.
  await page.waitForTimeout(6000);
  // Import can leave a report over the already-selected PCB. Choose the document tab as a user would.
  const target = await page.evaluate(() => {
    const board = AtriumNavHost.project().documents.find(d => d.kind === "pcb" && d.items.length > 20);
    return {id: board.id, tab: '#document-tabs [data-tab="' + CSS.escape(board.id) + '"]'};
  });
  await page.locator(target.tab).click();
  await page.waitForFunction(id => AtriumNavHost.doc()?.id === id && !AtriumNavHost.canvas().inert, target.id);
  return {page, errors};
}

async function renderer(page, which) {
  return page.evaluate(async which => {
    const G = globalThis.AtriumCanvasGPU, H = AtriumNavHost;
    if (which === "gpu" && !AtriumCanvasGPUPref.decision().use) return false;
    G?.enable?.(which === "gpu");
    window.dispatchEvent(new CustomEvent("atrium-command", {detail: "fit"}));
    H.redraw(true);
    await new Promise(r => setTimeout(r, 600)); H.redraw(true);
    await new Promise(r => setTimeout(r, 300));
    return G?.status(H.view().internals()) || {renderer:"2d"};
  }, which);
}

function zoomProbe(page, which) {
  return page.evaluate(async which => {
    const H = AtriumNavHost, v = H.view(), I = v.internals(), G = globalThis.AtriumCanvasGPU, cv = H.canvas();
    const wait = ms => new Promise(r => window.__rawTimeout(r, ms));
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    const r = cv.getBoundingClientRect(), at = [r.left + r.width * .45, r.top + r.height * .55];
    window.__requireBoardAt(cv, ...at);
    // Zoomed in far enough for pad numbers, around the middle of the board.
    v.zoom(4, [r.width * .45, r.height * .55]); H.redraw(true); await wait(500);
    const W = 480, Hh = Math.round(W * cv.height / cv.width), probe = document.createElement("canvas");
    probe.width = W; probe.height = Hh;
    const g = probe.getContext("2d", {willReadFrequently: true});
    // Every render is captured right after it (a WebGL frame is only readable then), with its camera and
    // whether the view was told it is a gesture frame (view.moving()) or an exact one.
    let shots = [], moving = false;
    const fallback = new Set();
    const render = v.render, move = v.moving;
    v.moving = function (...a) { moving = true; return move.apply(this, a); };
    v.render = function (...a) {
      const gesture = moving; moving = false;
      const out = render.apply(this, a);
      const actual = G?.status(I) || {renderer:"2d"};
      const src = actual.renderer === "gpu" ? G.composite(I) : cv;
      const backend = actual.renderer !== "gpu" ? "2d" : typeof G.perfCounters === "function" ? "retained" : "legacy";
      let data = null;
      if (src) { g.clearRect(0, 0, W, Hh); g.drawImage(src, 0, 0, W, Hh); data = g.getImageData(0, 0, W, Hh).data; }
      if (actual.renderer !== which || !src) fallback.add(actual.reason || `no ${which} frame`);
      const counters = backend === "legacy" && G.resourceCounters?.(I);
      const scaled = backend === "legacy" && (counters && "gestureScale" in counters ? counters.gestureScale : G.stats(I)?.gestureScale);
      shots.push({gesture, camera:JSON.stringify(v.camera()), data, backend, scaled});
      if (shots.length > 3) shots.shift();
      return out;
    };
    const wheel = w => cv.dispatchEvent(new WheelEvent("wheel", {clientX: at[0], clientY: at[1], bubbles: true, cancelable: true, ...w}));
    const bursts = [
      ["pinch out", {deltaY: 6, ctrlKey: true}], ["pinch out", {deltaY: 6, ctrlKey: true}], ["pinch in", {deltaY: -6, ctrlKey: true}],
      ["wheel out", {deltaY: 3, deltaMode: 1}], ["wheel in", {deltaY: -3, deltaMode: 1}], ["pan", {deltaX: 14, deltaY: 9}], ["pan back", {deltaX: -14, deltaY: -9}]];
    const out = [];
    try {
      for (const [name, w] of bursts) {
        shots = []; fallback.clear(); let frames = 0;
        const counting = v.render, count = function (...a) { frames++; return counting.apply(this, a); };
        v.render = count;
        for (let i = 0; i < 10; i++) { wheel(w); await wait(16); }
        // A notched wheel glides on for 120 ms; then the exact frame follows the last gesture frame.
        await wait(600); await frame(); await frame();
        // A cheap 2D board paints every gesture frame exactly and has no later frame: draw one to compare.
        if (shots[shots.length - 1]?.gesture) { H.redraw(true); await frame(); await frame(); }
        v.render = counting;
        const exact = shots[shots.length - 1], gesture = shots.slice(0, -1).reverse().find(s => s.gesture && s.camera === exact?.camera);
        if (!gesture?.data || !exact?.data || exact.gesture) {
          out.push({name, blank:null, frames, fallback:[...fallback]});
          continue;
        }
        const k = gesture.scaled || 1;
        out.push({name, blank:window.__unmatched(gesture.data, exact.data, W, Hh), frames,
          backend:gesture.backend, fallback:[...fallback], scaled:k > 3 || k < 1 / 3 ? +k.toFixed(1) : undefined});
      }
    } finally { v.render = render; }
    return out;
  }, which);
}

const settleBursts = [
  {deltaY:6,ctrlKey:true}, {deltaY:-6,ctrlKey:true}, {deltaY:3,deltaMode:1}, {deltaY:-2,deltaMode:1},
  {deltaX:14,deltaY:9}, {deltaY:-6,ctrlKey:true}, {deltaY:6,ctrlKey:true},
];

function dragProbe(page, part) {
  return page.evaluate(async part => {
    const H = AtriumNavHost, v = H.view(), cv = H.canvas(), wait = ms => new Promise(r => window.__rawTimeout(r, ms));
    const p = H.doc().items.find(i => i.kind === "part" && (i.ref || i.designator) === part);
    if (!p) throw Error("no part " + part);
    window.dispatchEvent(new CustomEvent("atrium-command", {detail: "fit"})); H.redraw(true); await wait(300);
    const r = cv.getBoundingClientRect(), s = v.worldToScreen([p.x, p.y]);
    v.pan(r.width / 2 - s[0], r.height / 2 - s[1]); v.zoom(3, [r.width / 2, r.height / 2]); H.redraw(true); await wait(800);
    const q = v.worldToScreen([p.x, p.y]), x0 = r.left + q[0], y0 = r.top + q[1];
    window.__requireBoardAt(cv, x0, y0);
    const pev = (type, x, y, o = {}) => cv.dispatchEvent(new PointerEvent(type, {clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1, bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", ...o}));
    // Each render's main-thread time and, on the GPU, the bytes of 2D layers it uploaded (text bands, pour coverage).
    const G = globalThis.AtriumCanvasGPU, I = v.internals(), gpu = G?.status?.(I).renderer === "gpu", ms = [], bytes = [];
    let renders = 0; const render = v.render;
    v.render = function (...a) {
      const t = performance.now(), out = render.apply(this, a); ms.push(performance.now() - t); renders++;
      if (gpu) { const s = G.resourceCounters(I); bytes.push([s?.textUpload || 0, s?.coverageUpload || 0]); }
      return out;
    };
    const before = [p.x, p.y];
    pev("pointermove", x0, y0, {buttons: 0}); pev("pointerdown", x0, y0); await wait(30);
    window.__work.length = 0;
    const moves = [], t0 = performance.now();
    for (let i = 1; performance.now() - t0 < 2000; i++) {
      moves.push(performance.now());
      pev("pointermove", x0 + 60 * Math.sin(i / 25), y0 + 40 * (1 - Math.cos(i / 25)));
      await wait(8);
    }
    const end = performance.now(); moves.push(end);
    const work = window.__work.slice(); window.__work.length = 0;
    // The last drag frame, drawn from the moved part's damaged area alone, against the same state drawn whole.
    const grab = () => { const src = (gpu && G.composite?.(I)) || cv, c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
      const g = c.getContext("2d", {willReadFrequently: true}); g.drawImage(src, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    let shot = null; const drawn = v.render;
    v.render = function (...a) { const o = drawn.apply(this, a); shot = grab(); return o; };
    pev("pointermove", x0 + 60 * Math.sin(1), y0 + 40 * (1 - Math.cos(1))); await wait(400); await frame(); await frame();
    const partial = shot; v.invalidate(H.doc()); H.redraw(); await frame(); await frame();
    const whole = shot; v.render = drawn;
    const mismatch = partial && whole ? window.__unmatched(partial, whole, cv.width, cv.height) : null;
    const tu = performance.now(); pev("pointerup", x0 + 20, y0 + 10); await new Promise(r => requestAnimationFrame(() => r()));
    const drop = performance.now() - tu;
    v.render = render;
    const after = H.doc().items.find(i => i.id === p.id);
    // Charge each callback to the move window it starts in.
    const per = new Array(moves.length - 1).fill(0);
    for (let k = 0; k < work.length; k += 2) {
      const t = work[k];
      if (t < moves[0] || t >= end) continue;
      let lo = 0, hi = moves.length - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (moves[m] <= t) lo = m; else hi = m; }
      per[lo] += work[k + 1];
    }
    const pct = (a, f) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))].toFixed(2); };
    return {mismatch, moves: per.length, work: {p50: pct(per, .5), p95: pct(per, .95), max: pct(per, 1)}, frames: renders, drop: +drop.toFixed(1),
      render: {p50: pct(ms, .5), p95: pct(ms, .95)}, uploadMB: gpu ? [0, 1].map(j => +(bytes.reduce((a, b) => a + b[j], 0) / Math.max(1, bytes.length) / 1048576).toFixed(2)) : undefined,
      textShare: gpu ? +(bytes.reduce((a, b) => a + b[0], 0) / Math.max(1, bytes.length) / (cv.width * cv.height * 4)).toFixed(3) : undefined,
      moved: Math.hypot(after.x - before[0], after.y - before[1]) > .01};
  }, part);
}

// A two-finger trackpad pan as macOS delivers it: pixel deltas (deltaMode 0), fractional, both axes, at
// 120 Hz, in four swipes (fingers 200 ms, a 150 ms momentum tail), each in a new direction, with the
// fingers resting 180 ms between them: long enough for the exact frame at rest, too short for anything
// prepared after it, as a user lifts and swipes again. The same stream as native/tests/macos-harness/pan-probes.js.
function trackpadStream() {
  const out = [], angles = [25, 205, 118, 298];
  for (const a of angles) {
    const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180);
    let m = 0;
    for (let i = 0; i < 24; i++) { m = i < 8 ? 2 + i * 1.6 : 14 - (i - 8) * .25; out.push([+(m * c).toFixed(2), +(m * s).toFixed(2), 0]); }
    for (let i = 0; i < 18; i++) { m *= .9; out.push([+(m * c).toFixed(2), +(m * s).toFixed(2), 1]); }
    for (let i = 0; i < 22; i++) out.push(null);
  }
  return out;
}

function panProbe(page, zoom, stream, capture) {
  return page.evaluate(async ({zoom, stream, capture}) => {
    const H = AtriumNavHost, v = H.view(), I = v.internals(), G = globalThis.AtriumCanvasGPU, cv = H.canvas();
    const wait = ms => new Promise(r => window.__rawTimeout(r, ms));
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    const gpu = G?.status?.(I).renderer === "gpu";
    window.dispatchEvent(new CustomEvent("atrium-command", {detail: "fit"})); H.redraw(true); await wait(400);
    const r = cv.getBoundingClientRect(), at = [r.left + r.width * .5, r.top + r.height * .5];
    window.__requireBoardAt(cv, ...at);
    if (zoom > 1) { v.zoom(zoom, [r.width * .47, r.height * .53]); H.redraw(true); }
    // At rest long enough for the exact frame and anything prepared after it (the GPU path's wide copy).
    await wait(900); await frame();
    const refresh = await new Promise(done => { const t = []; const tick = ts => { t.push(ts); if (t.length < 31) requestAnimationFrame(tick); else {
      const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b); done(d[d.length >> 1]); } }; requestAnimationFrame(tick); });
    // Per render: main-thread ms, texture bytes uploaded, net label placements, and whether it was a gesture frame.
    const renders = [];
    let moving = false, shots = [];
    const W = 480, Hh = Math.round(W * cv.height / cv.width), probe = document.createElement("canvas");
    probe.width = W; probe.height = Hh;
    const g = probe.getContext("2d", {willReadFrequently: true});
    const render = v.render, move = v.moving, settle = v.settle;
    v.settle = function (...a) { moving = false; return settle.apply(this, a); };
    v.moving = function (...a) { moving = true; return move.apply(this, a); };
    v.render = function (...a) {
      const gesture = moving; moving = false;
      // canvas.js places the net labels afresh (a new list) each time it paints its top layer for a camera.
      const u0 = window.__uploads, l0 = I.netLabels?.(), t = performance.now(), out = render.apply(this, a);
      renders.push({ms: performance.now() - t, bytes: window.__uploads - u0, labels: I.netLabels?.() !== l0 ? 1 : 0, gesture});
      if (capture) {
        const src = (gpu && G.composite?.(I)) || cv;
        g.clearRect(0, 0, W, Hh); g.drawImage(src, 0, 0, W, Hh);
        shots.push({gesture, camera: JSON.stringify(v.camera()), data: g.getImageData(0, 0, W, Hh).data});
        if (shots.length > 3) shots.shift();
      }
      return out;
    };
    const ticks = [];
    let ticking = true;
    const tick = t => { ticks.push(t); if (ticking) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const wide0 = gpu ? G.resourceCounters(I)?.wideBuilds || 0 : 0;
    window.__work.length = 0;
    const times = [], t0 = performance.now(), step = 1000 / 120;
    try {
      for (let i = 0; i < stream.length; i++) {
        // Real time at 120 Hz: each event at its slot, however long the last one took.
        const due = t0 + i * step;
        while (performance.now() < due - 1) await wait(Math.max(0, due - performance.now() - 1));
        if (!stream[i]) continue;
        times.push(performance.now());
        const [dx, dy] = stream[i];
        cv.dispatchEvent(new WheelEvent("wheel", {clientX: at[0], clientY: at[1], deltaX: dx, deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true}));
      }
      const end = performance.now(); times.push(end);
      await frame(); ticking = false;
      const work = window.__work.slice(); window.__work.length = 0;
      const per = new Array(times.length - 1).fill(0);
      for (let k = 0; k < work.length; k += 2) {
        const t = work[k];
        if (t < times[0] || t >= end) continue;
        let lo = 0, hi = times.length - 1;
        while (lo < hi - 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
        // Up to two frames after the event: the exact frame once the fingers rest is not the pan's.
        if (t - times[lo] <= 34) per[lo] += work[k + 1];
      }
      const during = renders;
      const wide = gpu ? (G.resourceCounters(I)?.wideBuilds || 0) - wide0 : 0;
      // At rest: the exact frame replaces the last pan frame; compare them at the same camera.
      await wait(500); await frame(); await frame();
      if (capture && shots[shots.length - 1]?.gesture) { H.redraw(true); await frame(); await frame(); }
      let blank = null;
      if (capture) {
        const exact = shots[shots.length - 1], last = shots.slice(0, -1).reverse().find(s => s.gesture && s.camera === exact?.camera);
        if (exact && last && !exact.gesture) blank = window.__unmatched(last.data, exact.data, W, Hh);
      }
      const pct = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))].toFixed(2); };
      const dt = ticks.slice(1).map((x, i) => x - ticks[i]).filter((x, i) => ticks[i + 1] <= end);
      const gest = during.filter(x => x.gesture);
      return {zoom, refresh: +refresh.toFixed(2), events: per.length,
        frame: {p50: pct(dt, .5), p95: pct(dt, .95), max: pct(dt, 1), dropped: dt.filter(x => x > refresh * 1.5).length, frames: dt.length},
        work: {p50: pct(per, .5), p95: pct(per, .95), max: pct(per, 1)},
        renders: during.length, exactDuring: during.filter(x => !x.gesture).length, render: {p50: pct(during.map(x => x.ms), .5), p95: pct(during.map(x => x.ms), .95)},
        uploadKB: +(gest.reduce((a, x) => a + x.bytes, 0) / Math.max(1, gest.length) / 1024).toFixed(1),
        uploadShare: gpu ? +(gest.reduce((a, x) => a + x.bytes, 0) / Math.max(1, gest.length) / (cv.width * cv.height * 4)).toFixed(3) : undefined,
        labelPlacements: +(gest.reduce((a, x) => a + x.labels, 0) / Math.max(1, gest.length)).toFixed(2), wideBuilds: wide, blank};
    } finally { v.render = render; v.moving = move; v.settle = settle; ticking = false; }
  }, {zoom, stream, capture});
}

(async () => {
  let chromium;
  try { ({chromium} = require("playwright-core")); } catch { console.error("perf-view-feel: playwright-core is not installed"); process.exit(2); }
  const browser = await chromium.launch({...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"}), headless: true, args: ["--allow-file-access-from-files"]}).catch(e => { console.error("perf-view-feel: " + e.message); process.exit(2); });
  const result = {board: path.basename(files.find(f => /\.pcbdoc$/i.test(f)) || files[0]), budget, renderers: {}}, fail = [];
  try {
    for (const which of process.env.ONLY ? [process.env.ONLY] : ["gpu", "2d"]) {
      const {page, errors} = await open(browser);
      try {
        const initial = await renderer(page, which);
        if (initial === false) { result.renderers[which] = {skipped:"no hardware-accelerated WebGL2"}; continue; }
        if (initial.renderer !== which) {
          fail.push(`${which}: hardware selected the wrong renderer (${initial.reason || initial.renderer})`);
          continue;
        }
        const r = result.renderers[which] = {};
        if (process.env.ZOOM !== "0") {
          r.zoom = await zoomProbe(page, which);
          for (const b of r.zoom) {
            const limit = b.backend === "legacy" && b.scaled ? budget.zoomScaledBlank : budget.zoomBlank;
            if (b.fallback.length) fail.push(`${which} ${b.name}: renderer fallback (${b.fallback.join(", ")})`);
            if (b.blank == null || b.blank > limit) fail.push(`${which} ${b.name}: ${b.blank == null ? "no frame" : (b.blank * 100).toFixed(2) + "% of pixels"} differ between the last gesture frame and the exact frame (budget ${limit * 100}%${b.scaled ? ", legacy layers scaled x" + b.scaled : ""})`);
          }
        }
        if (process.env.ZOOM !== "0" && process.env.SETTLE !== "0") {
          await renderer(page, which);
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Emulation.setCPUThrottlingRate", {rate: budget.throttle});
          try {
            r.settle = await page.evaluate(measureZoomSettle, {renderer:which, events:10, quietMs:700, prepare:true, bursts:settleBursts});
          } finally { await cdp.send("Emulation.setCPUThrottlingRate", {rate:1}); }
          if (r.settle.fallback.length) fail.push(`${which} zoom settle: renderer fallback (${r.settle.fallback.join(", ")})`);
          if (!r.settle.perBurst.every(row => row.gesture && row.settled))
            fail.push(`${which} zoom settle: missing gesture or settled callback samples`);
          if (r.settle.gesture.p95 > budget.zoomFrame) fail.push(`${which} zoom: gesture frame p95 ${r.settle.gesture.p95} ms > ${budget.zoomFrame} ms at ${budget.throttle}x CPU throttle`);
          if (r.settle.settled.p95 > budget.zoomSettle) fail.push(`${which} zoom: callback p95 ${r.settle.settled.p95} ms > ${budget.zoomSettle} ms at ${budget.throttle}x CPU throttle`);
          if (r.settle.settled.max > budget.zoomSettleMax) fail.push(`${which} zoom: callback max ${r.settle.settled.max} ms > ${budget.zoomSettleMax} ms at ${budget.throttle}x CPU throttle`);
        }
        if (process.env.DRAG !== "0") {
          await renderer(page, which);
          r.drag = await dragProbe(page, process.env.PART || "R4");
          if (!r.drag.moved) fail.push(`${which} drag: the part did not move`);
          if (r.drag.mismatch == null || r.drag.mismatch > budget.dragMismatch) fail.push(`${which} drag: the last drag frame differs from the same state drawn whole in ${r.drag.mismatch == null ? "?" : (r.drag.mismatch * 100).toFixed(3) + "%"} of pixels (budget ${budget.dragMismatch * 100}%)`);
          if (r.drag.textShare > budget.dragText) fail.push(`${which} drag: ${(r.drag.textShare * 100).toFixed(1)}% of a full text layer uploaded per frame (budget ${budget.dragText * 100}%)`);
          if (r.drag.work.p95 > budget.dragP95) fail.push(`${which} drag: work per pointer move p95 ${r.drag.work.p95} ms > ${budget.dragP95} ms`);
        }
        if (process.env.PAN !== "0") {
          r.pan = [];
          for (const [name, zoom] of [["fit", 1], ["mid", 4], ["close", 14]]) {
            await renderer(page, which);
            const timed = await panProbe(page, zoom, stream, false);
            await renderer(page, which);
            const shown = await panProbe(page, zoom, stream, true);
            const b = {name, ...timed, blank: shown.blank};
            r.pan.push(b);
            if (b.blank == null || b.blank > budget.panBlank) fail.push(`${which} pan ${name}: ${b.blank == null ? "no frame" : (b.blank * 100).toFixed(2) + "% of pixels"} differ between the last pan frame and the exact frame (budget ${budget.panBlank * 100}%)`);
            if (b.uploadShare > budget.panUpload) fail.push(`${which} pan ${name}: ${(b.uploadShare * 100).toFixed(1)}% of a full layer uploaded per pan frame (budget ${budget.panUpload * 100}%)`);
            if (b.work.p95 > budget.panWork) fail.push(`${which} pan ${name}: work per wheel event p95 ${b.work.p95} ms > ${budget.panWork} ms`);
            if (b.frame.p95 > budget.panFrame * b.refresh) fail.push(`${which} pan ${name}: frame interval p95 ${b.frame.p95} ms > ${budget.panFrame} refresh intervals (${(budget.panFrame * b.refresh).toFixed(1)} ms)`);
          }
        }
        if (errors.length) fail.push(`${which}: page errors: ${errors.slice(0, 3).join("; ")}`);
      } finally { await page.close(); }
    }
  } catch (e) { console.error("perf-view-feel: " + (e.stack || e)); await browser.close(); process.exit(2); }
  await browser.close();
  result.fail = fail;
  if (json) console.log(JSON.stringify(result, null, 1));
  else {
    console.log(`perf-view-feel on ${result.board}`);
    for (const [k, r] of Object.entries(result.renderers)) {
      if (r.skipped) { console.log(`  ${k}: skipped (${r.skipped})`); continue; }
      if (r.zoom) console.log(`  ${k} zoom blank: ` + r.zoom.map(b => `${b.name} ${b.blank == null ? "-" : (b.blank * 100).toFixed(2) + "%"} (${b.frames}${b.scaled ? ", scaled x" + b.scaled : ""})`).join(", "));
      if (r.settle) console.log(`  ${k} zoom at ${budget.throttle}x CPU throttle: gesture render p50 ${r.settle.gesture.p50} p95 ${r.settle.gesture.p95} max ${r.settle.gesture.max} ms (${r.settle.gesture.n}); after the move, main-thread callbacks p50 ${r.settle.settled.p50} p95 ${r.settle.settled.p95} max ${r.settle.settled.max} ms (${r.settle.settled.n})`);
      for (const b of r.pan || []) console.log(`  ${k} pan ${b.name} (x${b.zoom}): frame p50 ${b.frame.p50} p95 ${b.frame.p95} max ${b.frame.max} ms, ${b.frame.dropped}/${b.frame.frames} dropped; work/event p50 ${b.work.p50} p95 ${b.work.p95} max ${b.work.max} ms; ${b.renders} renders (${b.exactDuring} exact, render p50 ${b.render.p50} p95 ${b.render.p95} ms); ${b.uploadKB} KB${b.uploadShare != null ? ` (${(b.uploadShare * 100).toFixed(1)}% of a layer)` : ""} uploaded and ${b.labelPlacements} net label placements per pan frame, ${b.wideBuilds} wide copies; blank ${b.blank == null ? "-" : (b.blank * 100).toFixed(2) + "%"}`);
      if (r.drag) console.log(`  ${k} drag: work/move p50 ${r.drag.work.p50} p95 ${r.drag.work.p95} max ${r.drag.work.max} ms over ${r.drag.moves} moves, ${r.drag.frames} frames (render p50 ${r.drag.render.p50} p95 ${r.drag.render.p95} ms${r.drag.uploadMB ? `, ${r.drag.uploadMB[0]} MB text and ${r.drag.uploadMB[1]} MB pour coverage uploaded per frame (${(r.drag.textShare * 100).toFixed(1)}% of the text layer)` : ""}), drop ${r.drag.drop} ms; last frame vs whole ${(r.drag.mismatch * 100).toFixed(3)}%`);
    }
    console.log(fail.length ? "FAIL\n  " + fail.join("\n  ") : "OK");
  }
  process.exit(fail.length ? 1 : 0);
})();
