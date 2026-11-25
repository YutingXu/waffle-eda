"use strict";

// Run against a fresh, disposable portable Waffle process in the interactive
// Windows console. The caller owns package verification, CDP and Win32 checks.
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BOARDS = {
  "MainBoard_6_layers.PcbDoc": {
    sha256: "627ede540df6411cfd9bb37b4a7d98e4574e1bd891e1a0cba15579ee8e703729",
    items: 11000, tracks: 7000, parts: 200,
  },
  "PiDP11IOExpander.PcbDoc": {
    sha256: "1ff7234670ec5e20092d23ecf0cd5e7380e842ef7efff2b5cb992f53f84c9c69",
    items: 250, tracks: 150, parts: 15,
  },
};
const budget = 8, settleMs = 600;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (client, fn, ...args) => client.evaluate(
  "(" + fn.toString() + ")(" + args.map(value => JSON.stringify(value)).join(",") + ")", 60000);

async function until(probe, message) {
  const deadline = Date.now() + 25000;
  for (;;) {
    // Reload invalidates the old Runtime execution context.
    const value = await probe().catch(() => null);
    if (value) return value;
    assert.ok(Date.now() < deadline, message);
    await wait(150);
  }
}

async function importBoard(name) {
  const h = AtriumNavHost, base64 = globalThis.__winFeelFixture.join("");
  delete globalThis.__winFeelFixture;
  const bin = atob(base64), bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  const file = new File([bytes], name);
  AtriumPrefs.set("general.autosave", false);
  const accept = setInterval(() => {
    const button = [...document.querySelectorAll("dialog[open] button")].find(b =>
      ["Open here", "Replace project", "Don’t Save"].includes(b.textContent.trim()));
    button?.click();
  }, 50);
  let opened;
  try { opened = await h.openFiles([file]); } finally { clearInterval(accept); }
  if (!opened || h.fileSession().imported?.sourceFile !== file) throw Error("Expected public source was not adopted");
  for (const report of document.querySelectorAll(".import-report[data-view]"))
    document.querySelector('.view-tab[data-view="' + CSS.escape(report.dataset.view) + '"] .view-tab-close')?.click();
  const board = h.project().documents.find(doc => doc.kind === "pcb" && doc.items.length);
  if (!board) throw Error("Imported fixture has no populated PCB");
  h.selectDocument(board.id);
  await AtriumLazy.need(["AtriumCamera", "AtriumCanvasGPU"]);
  for (const [key, value] of [["camera.animate", true], ["mouse.zoomAt", "pointer"],
    ["mouse.zoomSpeed", 1], ["mouse.invertZoom", false]]) AtriumCamera.setPref(key, value);
  return {id: board.id, items: board.items.length, tracks: board.items.filter(item => item.kind === "track").length,
    parts: board.items.filter(item => item.kind === "part").length};
}

function editorState() {
  const h = AtriumNavHost, view = h.view(), canvas = h.canvas(), gpu = globalThis.AtriumCanvasGPU;
  const r = canvas.getBoundingClientRect();
  const at = [Math.round(r.left + r.width * .43), Math.round(r.top + r.height * .46)];
  const hit = document.elementFromPoint(...at);
  const card = document.querySelector(".insight-card:not([hidden])");
  const ownedCard = card && card.getClientRects().length > 0 ? card : null;
  const g = gpu?.status(view.internals()), stats = g?.renderer === "gpu" ? gpu.stats(view.internals()) : null;
  return {
    boardId: h.doc()?.id, camera: view.camera(), revision: h.authoredRevision(),
    rect: {left:r.left, top:r.top, width:r.width, height:r.height}, at, backing:[canvas.width, canvas.height],
    cssViewport:[innerWidth,innerHeight,visualViewport.width,visualViewport.height], scale: visualViewport.scale,
    dpr: devicePixelRatio, visible: document.visibilityState === "visible", focused: document.hasFocus(),
    canvasHit: hit === canvas, hit: hit && [hit.tagName,hit.id,String(hit.className).slice(0,100)],
    openInsight: ownedCard && globalThis.AtriumInsightsUI?.cardFor?.()?.key || null,
    insightAtPoint: !!ownedCard?.contains(hit),
    renderer: g?.renderer || "2d", adapter: stats?.renderer || null,
    submitted: (stats?.submitted || 0) > 0, power: globalThis.AtriumPower?.state(),
  };
}

function verifiedEditorSurface(page, expectedInsight) {
  if (!expectedInsight) return page.canvasHit;
  return page.openInsight === expectedInsight && (page.canvasHit || page.insightAtPoint);
}

function startObserver(mark, freezePaint, observeInputCamera) {
  const h = AtriumNavHost, view = h.view(), canvas = h.canvas(), W = window;
  if (!W.__rawRAF || W.__winFeelStop || W.__waffleFrameTrace || W.__waffleInputTrace)
    throw Error("The fresh callback probe is missing or another diagnostic owns the page");
  const camera = () => view.camera();
  const start = camera(), draws = [], inputs = [], ticks = [], tracedNotches = [];
  let previous = start, handle, running = true;
  const record = event => ({type:event.type, at:performance.now(), stamp:event.timeStamp, trusted:event.isTrusted,
    canvas:event.composedPath().includes(canvas), x:event.clientX, y:event.clientY,
    ctrl:event.ctrlKey, dy:event.deltaY, dx:event.deltaX, mode:event.deltaMode, button:event.button, buttons:event.buttons});
  const events = new AbortController();
  for (const type of ["pointerdown","pointermove","pointerup"]) addEventListener(type, event => {
    if (event.type !== "pointermove" || event.buttons === 4) inputs.push(record(event));
  }, {capture:true, passive:true, signal:events.signal});
  W.__waffleInputTrace = (event, taken, pane) => {
    if (event.type === "wheel") inputs.push({...record(event), accepted:!!taken, canvas:pane?.canvas === canvas,
      pinchStyle:AtriumCamera.wheelPinch(event),legacyDeltaY:event.wheelDeltaY,
      ...(observeInputCamera && {scaleAfter:camera().scale})});
  };
  W.__waffleFrameTrace = {commit() {}, editTask() {}, wheel(target, stamp) { if (target === canvas) tracedNotches.push(stamp); },
    draw(target, t, end) {
      if (target !== canvas || freezePaint) return;
      const pose = camera();
      const changed = pose.scale !== previous.scale || pose.cx !== previous.cx || pose.cy !== previous.cy;
      draws.push({t, end, camera:pose, changed, raf:W.__rafTime, inCallback:!!W.__depth});
      previous = pose;
    },
  };
  const render = view.render;
  if (freezePaint) view.render = () => {};
  const tick = t => {
    if (!running) return;
    ticks.push(t);
    handle = W.__rawRAF(tick);
  };
  const begin = performance.now();
  performance.mark(mark + "/start");
  W.__work.length = 0;
  handle = W.__rawRAF(tick);
  W.__winFeelStop = () => {
    const end = performance.now();
    performance.mark(mark + "/end");
    running = false;
    cancelAnimationFrame(handle);
    events.abort();
    delete W.__waffleFrameTrace;
    delete W.__waffleInputTrace;
    delete W.__winFeelStop;
    view.render = render;
    return {begin,end,start,finish:camera(),inputs,draws,ticks,tracedNotches,work:W.__work.slice()};
  };
  // Prime the unwrapped rAF clock before the host sends any input.
  return new Promise(resolve => W.__rawRAF(() => W.__rawRAF(resolve)));
}

async function restObservation() {
  const ticks = [], canvas = AtriumNavHost.canvas(), W = window;
  for (let i = 0; i < 36; i++) ticks.push(await new Promise(W.__rawRAF));
  let draws = 0;
  W.__waffleFrameTrace = {draw(target) { if (target === canvas) draws++; }, commit() {}, editTask() {}, wheel() {}};
  W.__work.length = 0;
  const start = performance.now();
  try {
    await new Promise(resolve => W.__rawTimeout(resolve, 400));
    return {ms:performance.now()-start, ticks, draws, callbacks:W.__work.length/2,
      workMs:W.__work.reduce((n,x,i)=>i%2?n+x:n,0)};
  } finally { delete W.__waffleFrameTrace; }
}

async function compareImages(before, after, rect, viewport) {
  async function sample(data) {
    const blob = new Blob([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))], {type:"image/png"});
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = 120; c.height = 90;
    const g = c.getContext("2d");
    const sx = bitmap.width / viewport[0], sy = bitmap.height / viewport[1];
    g.drawImage(bitmap, (rect.left+rect.width*.15)*sx, (rect.top+rect.height*.13)*sy,
      rect.width*.7*sx, rect.height*.74*sy, 0, 0, c.width, c.height);
    bitmap.close();
    return g.getImageData(0,0,c.width,c.height).data;
  }
  const [a,b] = await Promise.all([sample(before),sample(after)]);
  const colors = new Set();
  let pixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    colors.add((b[i] << 16) + (b[i+1] << 8) + b[i+2]);
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i+1] - b[i+1]), Math.abs(a[i+2] - b[i+2])) > 12) pixels++;
  }
  return {colors:colors.size, changedFraction:pixels / (a.length / 4)};
}

function distribution(values) {
  const a = [...values].sort((x,y) => x-y);
  const pick = p => a.length ? +a[Math.ceil(p*a.length)-1].toFixed(3) : null;
  return {n:a.length, p50:pick(.5), p95:pick(.95), max:pick(1)};
}

function summarizeMotion(raw, refreshHz) {
  const cadence = distribution([]), drawWork = distribution([]);
  if (!raw.inputs.length || raw.ticks.length < 2)
    return {cadence,drawWork,work:distribution([]),paintFrameWork:distribution([]),settle:distribution([]),terminal:distribution([])};
  const first = raw.inputs[0].at, last = raw.inputs.at(-1).at;
  const changed = raw.draws.filter(draw => draw.changed && draw.end >= first);
  const finalMotion = changed.at(-1);
  const bounds = raw.end > raw.ticks.at(-1) ? [...raw.ticks,raw.end] : raw.ticks;
  const bins = Array(bounds.length - 1).fill(0);
  const bucket = t => Math.min(bins.length - 1, Math.max(0, bounds.findLastIndex(b => b <= t)));
  const callbacks = [];
  for (let i = 0; i < raw.work.length; i += 2) {
    const start = raw.work[i], duration = raw.work[i+1];
    if (start < bounds[0] || start >= raw.end) continue;
    const bin = bucket(start);
    callbacks.push({start,end:start+duration,bin});
    bins[bin] += duration;
  }
  const drawBins = new Map();
  for (const draw of raw.draws) {
    if (draw.inCallback) {
      // The presentation timestamp can be on the opposite side of a bin
      // boundary from the actual callback that contains this draw.
      const owner = callbacks.findLast(c => c.start <= draw.t && c.end + 1e-6 >= draw.end);
      if (owner) drawBins.set(draw,owner.bin);
    } else if (draw.t >= bounds[0]) {
      const bin = bucket(draw.t);
      drawBins.set(draw,bin);
      bins[bin] += draw.end-draw.t;
    }
  }
  const motionEnd = Math.max(last,finalMotion?.end ?? last);
  const intervals = raw.ticks.slice(1).map((end,i) => [raw.ticks[i],end]).filter(([a,b]) => b >= first && a <= motionEnd);
  const active = intervals.map(([a,b]) => b-a);
  const work = intervals.map(([a]) => bins[bucket(a)]);
  const paintTimes = [...new Set(changed.map(draw => draw.raf ?? draw.t))];
  const paintBins = new Set(changed.map(draw => drawBins.get(draw)));
  paintBins.delete(undefined);
  const paintFrameWork = [...paintBins].map(i => bins[i]);
  const stationary = finalMotion ? raw.draws.filter(draw => !draw.changed && draw.t >= finalMotion.end) : [];
  // A renderer can end a gesture with an exact moving draw and no further draw.
  // Report which camera draw we actually observed rather than making a settle sample.
  const terminal = stationary.at(-1) || finalMotion;
  const terminalBin = drawBins.get(terminal);
  const terminalWork = terminalBin === undefined ? [] : [bins[terminalBin]];
  const unattributedPaintDraws = [...new Set([...changed,terminal].filter(Boolean))]
    .filter(draw => !drawBins.has(draw)).length;
  const postInput = bins.filter((ms,i) => ms > 0 && bounds[i+1] > last);
  const drawsAfterInput = raw.inputs.map(event => changed.find(draw => draw.end >= event.at))
    .map((draw,i) => draw && draw.end-raw.inputs[i].at).filter(Number.isFinite);
  return {
    work:distribution(work), paintFrameWork:distribution(paintFrameWork), drawWork:distribution(changed.map(d => d.end-d.t)),
    settle:distribution(postInput),
    terminal:distribution(terminalWork), unattributedPaintDraws,
    terminalKind: stationary.length ? "stationary draw" : "last changed draw",
    cadence:distribution(active), callbackHz:active.length ? 1000*active.length/active.reduce((a,b) => a+b,0) : null,
    estimatedMissedCallbackSlots:refreshHz > 0 ?
      active.reduce((sum,ms) => sum+Math.max(0,Math.round(ms*refreshHz/1000)-1),0) : null,
    changedPaintFrames:paintTimes.length, changedPaintHz:paintTimes.length > 1 ?
      1000*(paintTimes.length-1)/(paintTimes.at(-1)-paintTimes[0]) : null,
    activeInputMs:last-first, domToCompletedDraw:distribution(drawsAfterInput),
    samples:{work,paintFrameWork,settle:postInput,terminal:terminalWork},
  };
}

function nativeWheelProof(raw, steps, prepared) {
  const {start,finish,inputs} = raw, {at,rect:r} = prepared;
  const wheel = inputs.filter(e => e.type === "wheel");
  const nonzero = wheel.filter(e => e.dx !== 0 || e.dy !== 0);
  const [x,y] = nonzero.length ? [nonzero[0].x,nonzero[0].y] : at;
  const center = [finish.cx,finish.cy];
  const anchor = scale => {
    const delta = 1/start.scale - 1/scale;
    return [start.cx + (x-r.left-r.width/2)*delta,start.cy + (y-r.top-r.height/2)*delta];
  };
  const atAnchor = scale => anchor(scale).every((v,i) => Math.abs(v-center[i])<=.02);
  const endpoint = deltas => {
    const scale = deltas.reduce((s,dy) => Math.min(2000,Math.max(Math.min(start.referenceScale || start.scale,.0001),
      s*Math.exp(-dy*.008))),start.scale);
    return {scale,center:anchor(scale),matches:Math.abs(finish.scale-scale)<=1e-6 && atAnchor(scale)};
  };
  const observedDeltas = nonzero.map(e => {
    const dy = e.dy*(e.mode === 1 ? 16 : 1), legacy = e.legacyDeltaY;
    // Independently track the browser's observed detent counts for the known
    // Windows 100-pixel/120-legacy-unit packet shape, before the camera clamp.
    if (e.mode === 0 && !e.dx && e.pinchStyle === false && Number.isSafeInteger(legacy) &&
        legacy % 120 === 0 && dy*6 === -legacy*5) return dy;
    return Math.max(-120,Math.min(120,dy));
  });
  return {
    neutralEvents:wheel.length-nonzero.length, nonzeroPinchEvents:nonzero.filter(e => e.pinchStyle).length,
    intended:endpoint(steps.map(d=>-Math.sign(d)*100)), delivered:endpoint(observedDeltas),
    observedAnchorMatches:atAnchor(finish.scale), observedScale:finish.scale,
  };
}

function validateMotion({raw, metrics, pixels, prepared, after, kind, steps, endPoint}) {
  const faults = [];
  const fail = (ok, message) => { if (!ok) faults.push(message); };
  const same = (a,b, tolerance = 1e-6) => Math.abs(a-b) <= tolerance;
  const {inputs, start, finish} = raw, [x,y] = prepared.at, r = prepared.rect;
  const wheel = inputs.filter(e => e.type === "wheel");
  const moves = inputs.filter(e => e.type === "pointermove");
  if (kind === "zoom" || kind === "native-wheel" || kind === "native-scroll") {
    const scroll = kind === "native-scroll", native = kind !== "zoom";
    // A Chromium target with device-metric emulation can divide CDP deltas by
    // DPR. Preserve the actual browser mapping and require it for every step.
    const cdpScale = [1,1/(prepared.dpr || 1)].find(scale => same(wheel[0]?.dy,steps[0]*scale));
    const atRequestedPoint = e => native ? same(e.x,x,1/prepared.dpr) && same(e.y,y,1/prepared.dpr) : e.x === x && e.y === y;
    fail((native ? wheel.length > 0 : wheel.length === steps.length) && wheel.every((e,i) => e.trusted && e.canvas && e.accepted && e.ctrl === !scroll && e.dx === 0 &&
      typeof e.pinchStyle === "boolean" && (native ? !e.pinchStyle && [0,1].includes(e.mode) && !!e.dy :
        e.mode === 0 && same(e.dy,steps[i]*cdpScale)) && atRequestedPoint(e)), "trusted signed wheel delivery");
    if (scroll) {
      const scrollDelta = wheel.reduce((n,e)=>n+e.dy*(e.mode===1 ? 16 : 1),0);
      fail(same(finish.scale,start.scale) && same(finish.cx,start.cx,.02) &&
        same(finish.cy,start.cy+scrollDelta/start.scale,.02), "plain wheel vertical pan endpoint");
    } else if (native) {
      fail(raw.tracedNotches.length > 0, "native Control notches entered the editor's wheel timing path");
      const proof = nativeWheelProof(raw,steps,prepared);
      fail(proof.delivered.matches && proof.intended.matches, "zoom endpoint and pointer anchor");
    } else {
      const deltaSum = steps.reduce((sum,dy) => sum + dy*cdpScale,0);
      const target = start.scale * Math.exp(-deltaSum*.008);
      const delta = 1/start.scale - 1/target;
      fail(same(finish.scale,target) && same(finish.cx,start.cx+(x-r.left-r.width/2)*delta, .02) &&
        same(finish.cy,start.cy+(y-r.top-r.height/2)*delta, .02), "zoom endpoint and pointer anchor");
    }
  } else {
    const requiredMoves = kind === "fast-pan" ? 30 : steps.length*.7;
    fail(inputs.some(e => e.type === "pointerdown" && e.trusted && e.canvas && e.button === 1 && e.x === x && e.y === y) &&
      inputs.some(e => e.type === "pointerup" && e.trusted && e.canvas && e.button === 1 && e.x === endPoint[0] && e.y === endPoint[1]) &&
      moves.length >= requiredMoves && moves.every(e => e.trusted && e.canvas && e.buttons === 4), "trusted middle-pan delivery");
    fail(same(finish.scale,start.scale) && same(finish.cx,start.cx-(endPoint[0]-x)/start.scale,.02) &&
      same(finish.cy,start.cy-(endPoint[1]-y)/start.scale,.02), "two-axis pan endpoint");
  }
  fail(start.scale > 0 && !start.flipped && !start.rotation &&
    [finish.scale,finish.cx,finish.cy].every(Number.isFinite), "supported camera orientation");
  fail(prepared.revision === after.revision && prepared.boardId === after.boardId &&
    [prepared.scale,after.scale].every(scale => scale === 1) &&
    JSON.stringify(prepared.backing) === JSON.stringify(after.backing) &&
    JSON.stringify(prepared.cssViewport) === JSON.stringify(after.cssViewport), "stable project/viewport");
  fail(metrics.activeInputMs >= 1600 && metrics.work.n >= 30 && metrics.cadence.n >= 30 &&
    metrics.settle.n > 0 && metrics.terminal.n > 0, "nonempty sustained work, cadence and settle");
  fail(metrics.changedPaintFrames >= 20 && metrics.drawWork.n >= 20 && metrics.paintFrameWork.n >= 20 &&
    metrics.changedPaintHz > 0, "changed PCB draws");
  fail(!metrics.unattributedPaintDraws, "measured paint draws must be charged to their owning callbacks");
  fail(pixels?.colors >= 8 && pixels.changedFraction >= .005, "nonblank changed compositor pixels");
  return faults;
}

async function qualifyViewFeel(client, options) {
  const {fixture,expectedPid,refreshHz,expectedAdapter,checkWindow,expectedItems,repetitions=2,
    writeReceipt=()=>{},negativeControl=true,expectedDisplay,tag="",sendNativeWheel,sendNativePointer,
    hostInputAcceptance=false,diagnostic=false} = options;
  const pointerOnly = hostInputAcceptance === "pointer-only";
  const name = path.basename(fixture), expected = BOARDS[name];
  assert.ok(expected && Number.isInteger(Number(expectedPid)) && Number(expectedPid)>0 && typeof checkWindow === "function" &&
    refreshHz>0 && typeof expectedAdapter === "string" && expectedAdapter && Number.isInteger(repetitions) && repetitions>=(diagnostic ? 1 : 2) && repetitions<=8,
  "Use a supported public fixture, a physical Windows display/adapter and two or more bursts per renderer");
  const bytes = fs.readFileSync(fixture), sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256,expected.sha256,"Public board source bytes changed");
  const receipt = {status:"invalid", pass:false, fixture:{name,sha256}, refreshHz, expectedAdapter, expectedPid:Number(expectedPid),
    workBudgetMs:budget, input:"trusted CDP mouse events in native WebView2", paintClock:"editor canvas draws and untimed compositor screenshots",
    presentation:"unmeasured by this lane", modes:{}, invalid:[], budgetFailures:[], deliveryLimitations:[]};
  const persist = () => writeReceipt("view-feel-result",receipt);
  let display;
  const verified = async (renderer, board, expectedInsight) => {
    const os = await checkWindow(), page = await evaluate(client,editorState);
    try {
      assert.ok(os?.activeConsole === true && os.visible === true && os.foreground === true && Number(os.pid) === Number(expectedPid) &&
        os.monitor && os.windowHandle > 0 && os.foregroundHandle === os.windowHandle && Number(os.refreshHz) > 0 &&
        os.width>0 && os.height>0 && Math.abs(page.dpr-os.dpi/96)<.02 && page.visible && page.focused &&
        verifiedEditorSurface(page,expectedInsight),
      "Native Waffle window, physical display, or unobstructed canvas is unavailable: " + JSON.stringify({os,
        page:{visible:page.visible,focused:page.focused,canvasHit:page.canvasHit,hit:page.hit,dpr:page.dpr,
          openInsight:page.openInsight,insightAtPoint:page.insightAtPoint,expectedInsight}}));
      if (expectedDisplay) assert.deepEqual([os.width,os.height],expectedDisplay,"Unexpected physical display size");
      const mode = [os.width,os.height,os.monitor,os.windowHandle];
      if (display) assert.deepEqual(mode,display,"Native window or display changed");
      else display = mode;
      assert.equal(page.boardId,board.id,"A different active PCB received input");
      assert.equal(page.renderer,renderer,"Requested an unexpected renderer or it fell back");
      if (renderer === "gpu") {
        const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g,"");
        assert.ok(normalize(page.adapter || "").includes(normalize(expectedAdapter)) && normalize(expectedAdapter) &&
          page.submitted && !/warp|swiftshader|llvmpipe|software|Microsoft Basic Render/i.test(page.adapter),
        "No real board submission on the required Windows GPU");
      }
    } catch (error) {
      error.observation = {os,page};
      throw error;
    }
    return {os,page};
  };
  const mouse = (type, point, extra={}) => client.send("Input.dispatchMouseEvent",{type,x:point[0],y:point[1],...extra});
  const paced = async (rows, ms, send, pipeline=false) => {
    const t = performance.now(), times = [], inFlight = new Set();
    let error;
    for (let i=0;i<rows.length;i++) {
      if (inFlight.size >= 16) await Promise.race(inFlight);
      if (error) break;
      const delay = t+i*ms-performance.now();
      if (delay>0) await wait(delay);
      times.push(performance.now()-t);
      if (!pipeline) await send(rows[i]);
      else {
        const message = send(rows[i]).catch(failure => { error ||= failure; }).finally(() => inFlight.delete(message));
        inFlight.add(message);
      }
    }
    await Promise.all(inFlight);
    if (error) throw error;
    return times;
  };
  // Capture the full compositor surface. CDP clip scaling can change page DPI.
  const shot = () => client.send("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false});
  async function one(renderer,board,kind,repeat,freezePaint=false,nativeIntervalMs=35) {
    const mark = ["waffle-view-feel",tag || name,renderer,kind,freezePaint ? "freeze-paint" : repeat].join("/");
    const start = await verified(renderer,board), point = start.page.at;
    await mouse("mouseMoved",point);
    const before = await shot();
    const zoom = Array.from({length:72},(_,i) => i%6<3 ? -40 : 40).concat(-40,-40);
    const {width,height} = start.page.rect;
    const fast = kind === "fast-pan", panCount = fast ? 252 : 126;
    const pan = Array.from({length:panCount},(_,i) => {
      const t = (i+1)/panCount;
      return [point[0]+Math.round(width*(.14*t+.06*Math.sin(4*Math.PI*t))),
        point[1]+Math.round(height*(.12*t+.04*Math.sin(4*Math.PI*t)))];
    });
    const nativeWheel = Array.from({length:72},(_,i) => i%4<2 ? 120 : -120).concat(120);
    const native = kind === "native-wheel" || kind === "native-scroll";
    const steps = kind === "zoom" ? zoom : native ? nativeWheel : pan;
    let times, raw, nativeInput, pressed = false, end, pixels;
    const faults = [];
    await evaluate(client,startObserver,mark,freezePaint,hostInputAcceptance && kind === "zoom");
    try {
      if (kind === "zoom") times = await paced(steps,30,dy => mouse("mouseWheel",point,{deltaX:0,deltaY:dy,modifiers:2}));
      else if (native) {
        nativeInput = await sendNativeWheel({point,dpr:start.page.dpr,steps,intervalMs:nativeIntervalMs,
          ctrl:kind==="native-wheel",window:start.os});
        assert.ok(nativeInput?.status === "performed" && nativeInput.sourceMs?.length === steps.length,
          "Win32 native wheel injection did not complete");
        times = nativeInput.sourceMs;
      }
      else {
        await mouse("mousePressed",point,{button:"middle",buttons:4,clickCount:1});
        pressed = true;
        times = await paced(steps,fast ? 1000/120 : 18,pos => mouse("mouseMoved",pos,{button:"middle",buttons:4}),fast);
      }
      if (pressed) {
        await mouse("mouseReleased",pan.at(-1),{button:"middle",buttons:0,clickCount:1});
        pressed = false;
      }
      await wait(settleMs);
    } catch (error) {
      faults.push("input transport: " + error.message);
    } finally {
      if (pressed) await mouse("mouseReleased",pan.at(-1),{button:"middle",buttons:0,clickCount:1}).catch(()=>{});
      raw = await client.evaluate("__winFeelStop()").catch(error => {
        faults.push("callback capture: " + error.message);
        return null;
      });
    }
    try { end = await verified(renderer,board); }
    catch (error) { end = error.observation; faults.push("end verification: " + error.message); }
    if (end?.os?.activeConsole && end.os.visible && end.os.foreground && end.page.visible && end.page.focused) {
      try { pixels = await evaluate(client,compareImages,before.data,(await shot()).data,start.page.rect,start.page.cssViewport); }
      catch (error) { faults.push("compositor pixel proof: " + error.message); }
    }
    const fixedHz = end && start.os.refreshHz === end.os.refreshHz ? Number(start.os.refreshHz) : null;
    const metrics = raw ? summarizeMotion(raw,fixedHz) : null;
    if (raw && end) faults.push(...validateMotion({raw,metrics,pixels,prepared:start.page,after:end.page,kind,steps,endPoint:pan.at(-1)}));
    const wheelEvents = raw?.inputs.filter(e => e.type === "wheel") || [];
    const moves = raw?.inputs.filter(e => e.type === "pointermove" && e.trusted && e.canvas) || [];
    const hz = samples => samples.length>1 && samples.at(-1)>samples[0] ? 1000*(samples.length-1)/(samples.at(-1)-samples[0]) : null;
    const offeredHz = times ? hz(times) : null, trustedMoveHz = hz(moves.map(event => event.at));
    return {kind,repeat,marks:[mark+"/start",mark+"/end"],start,end,raw,steps,sourceMs:times,pixels,metrics,faults,nativeInput,
      nativeZoom:kind === "native-wheel" && raw ? nativeWheelProof(raw,steps,start.page) : null,
      nativeIntervalMs:native ? nativeIntervalMs : null,
      refresh:{beforeHz:start.os.refreshHz,afterHz:end?.os.refreshHz ?? null,fixedHz,
        requestedHz:refreshHz,matchedRequested:fixedHz === refreshHz},
      delivery:{planned:steps.length,sent:times?.length ?? nativeInput?.sourceMs?.length ?? null,
        trustedWheel:wheelEvents.filter(e => e.trusted && e.accepted && e.canvas).length,
        observedWheelDelta:wheelEvents.reduce((sum,e)=>sum+(e.dy||0),0),
        singlePacketClampedWheelDelta:wheelEvents.reduce((sum,e)=>sum+Math.max(-120,Math.min(120,(e.dy||0)*(e.mode === 1 ? 16 : 1))),0),
        legacyDetentsRepresented:native ? wheelEvents.reduce((sum,e)=>sum+Math.abs(e.legacyDeltaY || 0)/120,0) : null,
        nativeDetentsOneToOne:native ? wheelEvents.length === steps.length &&
          wheelEvents.every((e,i)=>e.legacyDeltaY === steps[i]) : null,
        firstCdpDeltaRatio:kind === "zoom" && wheelEvents.length ? wheelEvents[0].dy/steps[0] : null,
        trustedMoves:moves.length,offeredHz,trustedMoveHz,
        fastPan:fast ? {targetHz:120,offeredRateReached:offeredHz >= 108,deliveredRateReached:trustedMoveHz >= 108,
          unobservedMoves:Math.max(0,(times?.length || 0)-moves.length)} : null},
      wheelPaths:wheelEvents.length ? {notched:wheelEvents.filter(e => (e.dx !== 0 || e.dy !== 0) && e.pinchStyle === false).length,
        pinchStyle:wheelEvents.filter(e => (e.dx !== 0 || e.dy !== 0) && e.pinchStyle === true).length,
        zeroDelta:wheelEvents.filter(e => e.dx === 0 && e.dy === 0).length} : null};
  }
  const acceptRow = async (renderer,mode,row) => {
    mode.bursts.push(row);
    const label = [renderer,row.kind,row.repeat].join("/");
    for (const fault of row.faults) receipt.invalid.push(label+": "+fault);
    if (row.delivery.fastPan && !row.delivery.fastPan.deliveredRateReached)
      receipt.deliveryLimitations.push(label+": 120/s trusted pan delivery was capped");
    if (row.delivery.nativeDetentsOneToOne === false)
      receipt.deliveryLimitations.push(label+": Win32 native detents were coalesced or dropped before the editor");
    if (!row.faults.length) for (const metric of ["work","paintFrameWork","settle","terminal"])
      if (!(row.metrics[metric].p95 <= budget)) receipt.budgetFailures.push(label+" "+metric+" p95 "+row.metrics[metric].p95+" ms");
    await persist();
  };
  async function verifyPointerControls(board,actions,renderer="gpu") {
    const {pointerTrial} = require("./view-feel-input-controls.cjs");
    if (typeof sendNativePointer !== "function") receipt.invalid.push("native pointer control was unavailable");
    else for (const action of actions) {
      await client.evaluate('dispatchEvent(new CustomEvent("atrium-command",{detail:"fit"}));');
      await wait(16000);
      const check = await pointerTrial(client,{action,sendNativePointer,verify:expectedInsight=>verified(renderer,board,expectedInsight)});
      receipt.hostInput.pointer.push(check);
      if (!check.pass) receipt.invalid.push("native pointer "+action+": "+check.reason);
      await persist();
    }
  }
  async function verifyHostInput(board,mode) {
    receipt.hostInput = {physicalTouchpad:"unmeasured",wheel:[],pointer:[]};
    const {hostInput} = receipt;
    for (const [i, intervalMs] of [35,35,25,60,35].entries()) {
      const kind = i === 4 ? "native-scroll" : "native-wheel";
      await client.evaluate('dispatchEvent(new CustomEvent("atrium-command",{detail:"fit"}));');
      if (kind === "native-scroll") await client.evaluate('AtriumCamera.setPref("mouse.wheel","altium");');
      await wait(16000);
      const row = await one("gpu",board,kind,i+1,false,intervalMs);
      if (row.nativeInput?.transport !== "SendInput" || row.nativeInput.acceptedDetents !== row.steps.length)
        row.faults.push("Win32 did not confirm each submitted detent");
      if (!row.delivery.nativeDetentsOneToOne || row.wheelPaths?.zeroDelta)
        row.faults.push("signed physical wheel sequence must arrive exactly");
      hostInput.wheel.push({kind,intervalMs,repeat:row.repeat,pass:!row.faults.length});
      await acceptRow("gpu",mode,row);
    }
    const directZoom = mode.bursts.filter(row => row.kind === "zoom");
    hostInput.cdpPinchStyle = directZoom.length>0 && directZoom.every(row => {
      if (row.faults.length || row.wheelPaths?.pinchStyle !== row.steps.length) return false;
      const {inputs,start}=row.raw;
      let scale=start.scale;
      return inputs.filter(e=>e.type==="wheel").every(e=>{
        scale*=Math.exp(-e.dy*.008);
        return Math.abs(e.scaleAfter-scale)<1e-6;
      });
    });
    if (!hostInput.cdpPinchStyle) receipt.invalid.push("CDP pinch-style zoom did not apply directly at each input");
    await verifyPointerControls(board,["inside","outside","cancel","pan"]);
    await client.evaluate('AtriumCamera.setPref("mouse.wheel","zoom");');
  }
  try {
    const early = fs.readFileSync(path.join(__dirname,"../../tests/macos-harness/pan-early.js"),"utf8");
    await client.send("Page.enable");
    const {identifier} = await client.send("Page.addScriptToEvaluateOnNewDocument",{source:early+"\nglobalThis.__winFeelEarly=true;"});
    await client.send("Page.reload");
    await until(() => client.evaluate("!!globalThis.__winFeelEarly && !!globalThis.AtriumNavHost && document.readyState === 'complete'"),
      "Fresh WebView2 startup did not install callback instrumentation");
    await client.send("Page.removeScriptToEvaluateOnNewDocument",{identifier});
    const b64 = bytes.toString("base64");
    await client.evaluate("globalThis.__winFeelFixture=[]");
    for (let i=0;i<b64.length;i+=500000)
      await client.evaluate("__winFeelFixture.push("+JSON.stringify(b64.slice(i,i+500000))+");void 0");
    const board = await evaluate(client,importBoard,name);
    receipt.board = board;
    assert.ok(board.items >= Math.max(expected.items,expectedItems || 0) && board.parts>=expected.parts &&
      board.tracks>=expected.tracks,"Wrong public PCB or missing imported geometry");
    for (const renderer of pointerOnly ? ["gpu"] : ["gpu","2d"]) {
      await client.evaluate('AtriumPrefs.set("display.renderer",'+JSON.stringify(renderer === "gpu" ? "auto" : "2d")+'); AtriumNavHost.redraw(true);');
      const initial = await until(() => verified(renderer,board),"Native window or requested hardware/renderer never became ready");
      const mode = receipt.modes[renderer] = {initial,bursts:[]};
      await wait(850);
      mode.rest = await evaluate(client,restObservation);
      mode.rest.sampledIdleCadence = distribution(mode.rest.ticks.slice(1).map((t,i) => t-mode.rest.ticks[i]));
      mode.rest.end = await verified(renderer,board);
      if (pointerOnly) {
        receipt.scope = "native pointer functional comparison";
        receipt.hostInput = {physicalTouchpad:"unmeasured",wheel:[],pointer:[]};
        await verifyPointerControls(board,["marker","insight"]);
        const clear = await evaluate(client,require("./view-feel-input-controls.cjs").mountTwoPartBoard);
        const findings = await until(()=>client.evaluate(`(() => {
          const H=AtriumNavHost, insights=AtriumInsightsUI, pass=insights.lastPass();
          if (pass?.docId!==H.doc().id || insights.running()) return null;
          return {designInsights:insights.current().length, shownDRC:AtriumDRCView.violations(H.doc().id).length};
        })()`),"Checks did not complete for the two-part native pointer fixture");
        receipt.hostInput.clearBoard={...clear,...findings,renderer:"2d"};
        assert.ok(clear.partCount===2 && clear.rules===0 && findings.designInsights===0 && findings.shownDRC===0,
          "Two-part fixture needs exactly two parts and zero DRC or Design Insights findings");
        await verifyPointerControls(clear,["inside","cancel","pan"],"2d");
        break;
      }
      for (let r=1;r<=repetitions;r++) {
        await client.evaluate('dispatchEvent(new CustomEvent("atrium-command",{detail:"fit"}));');
        await wait(600);
        const kinds = renderer === "gpu" && name === "MainBoard_6_layers.PcbDoc" && r === 1 ? ["zoom","pan","fast-pan"] : ["zoom","pan"];
        for (const kind of kinds) {
          await acceptRow(renderer,mode,await one(renderer,board,kind,r));
        }
      }
      if (renderer === "gpu" && name === "MainBoard_6_layers.PcbDoc") {
        if (typeof sendNativeWheel === "function" && hostInputAcceptance) await verifyHostInput(board,mode);
        else if (typeof sendNativeWheel === "function") {
          await client.evaluate('dispatchEvent(new CustomEvent("atrium-command",{detail:"fit"}));');
          await wait(600);
          await acceptRow(renderer,mode,await one(renderer,board,"native-wheel",1));
        } else if (!diagnostic) receipt.invalid.push("GargantuRAM needs a sustained Win32 Control-notch capture");
      }
      mode.summary = Object.fromEntries([...new Set(mode.bursts.map(row => row.kind))].map(kind => [kind,
        Object.fromEntries(["work","paintFrameWork","settle","terminal"].map(metric => [metric,
          distribution(mode.bursts.filter(row => row.kind === kind && !row.faults.length)
            .flatMap(row => row.metrics.samples[metric]))]))]));
    }
    if (negativeControl && receipt.modes["2d"]?.bursts.some(row => !row.faults.length)) {
      const row = await one("2d",board,"zoom",0,true);
      receipt.negativeControl = row;
      if (!row.faults.includes("changed PCB draws") || !row.faults.includes("nonblank changed compositor pixels") ||
          row.faults.includes("trusted signed wheel delivery") || row.faults.includes("zoom endpoint and pointer anchor"))
        receipt.invalid.push("Frozen paint control was not rejected despite valid trusted camera motion");
      await client.evaluate("AtriumNavHost.redraw(true)");
    }
    const bursts = Object.values(receipt.modes).flatMap(mode => mode.bursts);
    receipt.fixedRefreshQualified = bursts.length > 0 && bursts.every(row => !row.faults.length && row.refresh.matchedRequested);
    receipt.status = receipt.invalid.length ? "invalid" : diagnostic || pointerOnly ? "diagnostic" : receipt.budgetFailures.length ? "over-budget" :
      receipt.deliveryLimitations.length ? "input-limited" : "pass";
    receipt.pass = receipt.status === "diagnostic" ? null : receipt.status === "pass";
  } catch (error) {
    receipt.invalid.push(String(error.stack || error));
    receipt.status = "invalid";
  }
  await persist();
  return receipt;
}

module.exports = {qualifyViewFeel, summarizeMotion, validateMotion, verifiedEditorSurface};
