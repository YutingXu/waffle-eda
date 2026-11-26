"use strict";
// Local hardware regression for retained pour meshes. Run with Node and Playwright Core.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const launch = require("../support/standalone-chromium.cjs");

async function testPourLOD({requireHardware = false} = {}) {
  const unavailable = reason => {
    if (requireHardware) throw Error("browser-gpu-pour-lod: " + reason);
    console.log("SKIP browser-gpu-pour-lod: " + reason);
  };
  try { require.resolve("playwright-core"); }
  catch { return unavailable("Playwright Core is unavailable."); }
  const executablePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!fs.existsSync(executablePath)) return unavailable("Chromium is unavailable.");
  return launch({headless:true, executablePath, args:["--allow-file-access-from-files"]}, async browser => {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    const result = await page.evaluate(pourLOD);
    if (result.skip) return unavailable(result.skip);
    assert.ok(result.device && result.photos, JSON.stringify(result));
    const expected = {
      levels:[5,4,-1], cold:{uploads:1,visible:true,fresh:true},
      group:{fans:5,stencilStarts:2,stencilEnds:2,opacity:true,track:true},
      retriedGroup:{injected:true,fallback:true,pixels:true,freshCanvas:true},
      long:{levels:[7,6,5,4,-1],fresh:true}, edited:{changed:true,fresh:true,reuploaded:true},
      undone:{matches:true,reuploaded:true}, removed:{pourBytes:0,pourCacheBytes:0},
      cap:{gpu:true,evicted:true,rejected:true}, restored:{freshCanvas:true,freshPixels:true,reuploaded:true},
      driverOOM:{waited:true,keptFence:true,readAfterSignal:true,reported:true,canvasInk:true}
    };
    for (const [name, value] of Object.entries(expected)) assert.deepEqual(result[name],value,name);
    assert.deepEqual([result.warm.uploads,result.warm.uploadBytes,result.warm.reuses],[0,0,6],JSON.stringify(result.warm));
    assert.ok(result.warm.retainedBytes > 0 && result.warm.retainedBytes <= 16 * 1048576);
    assert.ok(result.cover.stencilElements > 7000,"the stored contour must exercise the dense stencil pass");
    assert.equal(result.cover.indexedColorElements,0,"color must not replay the contour indices");
    assert.equal(result.cover.quads,result.cover.parityDraws);
    assert.ok(result.cover.copper && result.cover.hole,"the cover must include copper and respect the stencil hole");
    assert.equal(result.fault.uploads,6,"single-mesh control must upload both levels on every reversal");
    assert.ok(result.fault.uploadBytes > 0 && !result.fault.reuses);
    console.log("browser-gpu-pour-lod: " + JSON.stringify(result));
    await require("../pcb/browser-pour-open-connectivity.js")(browser, ["composition"]);
  }, error => { throw error; });
}

async function pourLOD() {
  await AtriumLazy.need(["AtriumCanvasGPU","AtriumPolygonPour"]);
  const G = AtriumCanvasGPU, P = AtriumPCBPours, hardware = AtriumCanvasGPUPref.decision();
  if (!hardware.use || hardware.software) return {skip:hardware.reason || "no hardware WebGL2"};
  const cv = document.createElement("canvas");
  cv.style.cssText = "position:fixed;left:20px;top:20px;width:360px;height:260px";
  document.body.append(cv);
  const view = AtriumCanvas.create(cv), I = view.internals(), defs = new Map();
  const board = Atrium.sheet("pcb","Copper mesh rotation");
  board.outline = [[-28,-22],[28,-22],[28,22],[-28,22]];
  const polygon = x => P.region([
    Array.from({length:2400},(_,i) => {
      const a = i * Math.PI / 1200, r = 14 + .19 * Math.sin(a * 11);
      return [x + Math.cos(a) * r, Math.sin(a) * r];
    }),
    [[x-6,-6],[x+6,-6],[x+6,6],[x-6,6]]
  ],"Top","GND");
  const region = polygon(0);
  board.pcbDrawing = {annotations:{},pours:[region]};
  board.sourcePourSignature = P.signature(board,defs);
  const options = {editorPane:true,noReuse:true,grid:false,origin:false,showUnrouted:false,netNames:false};
  const glCanvas = () => cv.previousElementSibling;
  async function waitFor(fn, failure) {
    for (let i=0; i<120; i++) {
      if (fn()) return;
      await new Promise(resolve => setTimeout(resolve,20));
    }
    throw Error(failure);
  }
  async function prepare() {
    await waitFor(() => P.lodRingsAt(region,6)?.level === 5 && P.lodRingsAt(region,10)?.level === 4,
      "Both genuine display meshes must be available");
  }
  function draw(pitch, requireGPU = true, opts = options) {
    const scale = pitch / devicePixelRatio;
    view.restoreCamera({cx:0,cy:0,scale,referenceScale:scale});
    view.render(board,defs,opts);
    if (!requireGPU) return;
    const capture = G.composite(I);
    if (!capture) throw Error("GPU board did not draw: " + G.status(I).reason);
    return capture.getContext("2d").getImageData(0,0,capture.width,capture.height).data;
  }
  const equal = (a,b) => a.length === b.length && a.every((channel,i) => channel === b[i]);
  const counters = () => G.resourceCounters(I);
  const fresh = pitch => { G.release(I); return draw(pitch); };
  function fanCover() {
    const gl = glCanvas().getContext("webgl2"), {colorMask,drawElements,drawArrays} = gl;
    let color = true;
    const result = {stencilElements:0,indexedColorElements:0,parityDraws:0,quads:0};
    gl.colorMask = function (...args) { color = args[0]; return colorMask.apply(this,args); };
    gl.drawElements = function (...args) {
      if (color) result.indexedColorElements += args[1];
      else { result.stencilElements += args[1]; result.parityDraws++; }
      return drawElements.apply(this,args);
    };
    gl.drawArrays = function (mode,first,count) {
      if (color && mode === gl.TRIANGLE_STRIP && count === 4) result.quads++;
      return drawArrays.call(this,mode,first,count);
    };
    try {
      const image = draw(20);
      const redAt = x => {
        const [px,py] = view.worldToScreen([x,0]).map(v => Math.floor(v * devicePixelRatio));
        const n = (py * cv.width + px) * 4;
        return image[n] > image[n+1] + 30 && image[n] > image[n+2] + 30;
      };
      return {...result,copper:redAt(8),hole:!redAt(0)};
    } finally { Object.assign(gl,{colorMask,drawElements,drawArrays}); }
  }
  function fanGroup() {
    const gl = glCanvas().getContext("webgl2"), {enable,disable,drawElements} = gl;
    const ring = (x,y) => [[x-1,y-2],[x+1,y-2],[x+1,y+2],[x-1,y+2]];
    const zones = [-6,-2,2,6].map(x => P.region([ring(x,0)],"Top","GND"));
    const track = {id:"after-fans",kind:"track",layer:"Top",width:.5,points:[[-4,4],[4,4]]};
    const previousAnim = globalThis.AtriumPourAnim;
    const result = {fans:0,stencilStarts:0,stencilEnds:0,opacity:false,track:false};
    board.items.push(track); board.pcbDrawing.pours = zones;
    board.sourcePourSignature = P.signature(board,defs);
    view.invalidate(board);
    globalThis.AtriumPourAnim = {active: doc => doc === board, gpu(r,cam,width) {
      if (r === zones[1]) return {x0:0,x1:width,alpha:.35};
      return null;
    }};
    gl.enable = function (cap) { if (cap === gl.STENCIL_TEST) result.stencilStarts++; return enable.call(this,cap); };
    gl.disable = function (cap) { if (cap === gl.STENCIL_TEST) result.stencilEnds++; return disable.call(this,cap); };
    gl.drawElements = function (...args) { result.fans++; return drawElements.apply(this,args); };
    let retried;
    try {
      const image = draw(20);
      const red = (x,y) => {
        const [px,py] = view.worldToScreen([x,y]).map(v => Math.floor(v * devicePixelRatio));
        const n = (py * cv.width + px) * 4;
        return image[n] - image[n+1];
      };
      result.opacity = red(-6,0) > red(-2,0) + 25 && red(2,0) > red(-2,0) + 25;
      result.track = red(0,4) > red(0,5) + 35;
      Object.assign(gl,{enable,disable,drawElements});

      const ordinary = {...options,grid:true,hidden:new Set(["Board","Source pours"])};
      const expected = draw(20,true,ordinary), before = glCanvas();
      let injected = false;
      globalThis.AtriumPourAnim = {active: doc => doc === board, gpu(r) {
        if (r === zones[1]) { injected = true; throw Error("interrupted pour pass"); }
        return null;
      }};
      draw(20,false);
      const status = G.status(I);
      const fallback = status.renderer === "2d" && /interrupted pour pass/.test(status.reason) && G.composite(I) === null;
      globalThis.AtriumPourAnim = previousAnim;
      G.enable(true);
      const pixels = equal(expected,draw(20,true,ordinary));
      retried = {injected,fallback,pixels,freshCanvas:glCanvas() !== before};
    } finally {
      Object.assign(gl,{enable,disable,drawElements});
      globalThis.AtriumPourAnim = previousAnim;
      board.items.pop(); board.pcbDrawing.pours = [region];
      board.sourcePourSignature = P.signature(board,defs);
      view.invalidate(board);
    }
    return {group:result,retriedGroup:retried};
  }
  function reversals() {
    const a = draw(6), b = draw(10), before = counters();
    let stayed = true;
    for (let i=0; i<3; i++) stayed = stayed && equal(a,draw(6)) && equal(b,draw(10));
    if (!stayed) throw Error("A repeated camera chose a different mesh");
    const after = counters();
    return {a,b,metrics:{uploads:after.pourUploads-before.pourUploads,uploadBytes:after.pourUploadBytes-before.pourUploadBytes,
      reuses:after.pourCacheHits-before.pourCacheHits,retainedBytes:after.pourCacheBytes}};
  }
  async function driverOOM() {
    await waitFor(() => counters().driverMemoryChecks > 0,"The initial allocation check did not complete");
    const gl = glCanvas().getContext("webgl2"), {fenceSync, clientWaitSync, getError} = gl;
    let hold = true, waits = 0, fences = 0, signal = false, reads = 0;
    const readAfterSignal = [];
    gl.fenceSync = function (...args) { fences++; return fenceSync.apply(this,args); };
    gl.clientWaitSync = function (...args) {
      waits++;
      if (hold) return this.TIMEOUT_EXPIRED;
      const status = clientWaitSync.apply(this,args);
      signal = status === this.ALREADY_SIGNALED || status === this.CONDITION_SATISFIED;
      return status;
    };
    gl.getError = function () {
      readAfterSignal.push(signal);
      if (++reads === 1) return this.INVALID_OPERATION;
      if (reads === 2) return this.OUT_OF_MEMORY;
      return getError.call(this);
    };
    try {
      draw(20,false);
      await waitFor(() => waits >= 2 || reads > 0,"The allocation check did not poll its fence");
      if (reads) throw Error("The allocation error was read while the completion fence was pending");
      const waited = G.status(I).renderer === "gpu";
      const oldFences = fences, oldWaits = waits;
      draw(10,false);
      await waitFor(() => waits > oldWaits || reads > 0,"The check must keep polling after another draw");
      const keptFence = fences === oldFences && !reads;
      hold = false;
      await waitFor(() => /GPU ran out of memory/.test(G.status(I).reason),"The driver allocation failure did not fall back");
      const reported = G.status(I).renderer === "2d" && G.composite(I) === null;
      draw(6,false);
      const pixels = cv.getContext("2d").getImageData(0,0,cv.width,cv.height).data;
      const canvasInk = pixels.some((r,i) => i % 4 === 0 && r > pixels[i+1]+30 && r > pixels[i+2]+30);
      return {waited,keptFence,readAfterSignal:reads === 2 && readAfterSignal.every(Boolean),reported,canvasInk};
    } finally { Object.assign(gl,{fenceSync,clientWaitSync,getError}); }
  }
  try {
    G.enable(true);
    await prepare();
    const levels = [6,10,20].map(pitch => P.lodRingsAt(region,pitch)?.level ?? -1);
    const initial = reversals(), warm = initial.metrics;
    const beforeCold = counters(), firstStored = draw(20), afterCold = counters();
    const cold = {uploads:afterCold.pourUploads-beforeCold.pourUploads,
      visible:firstStored.some((r,i) => i % 4 === 0 && r > firstStored[i+1]+30 && r > firstStored[i+2]+30),
      fresh:equal(firstStored,fresh(20))};
    const cover = fanCover();
    const {group,retriedGroup} = fanGroup();
    const extended = [[1.6,7],[2.5,6],[6,5],[10,4],[20,-1]];
    for (const [pitch,level] of extended)
      await waitFor(() => (P.lodRingsAt(region,pitch)?.level ?? -1) === level,"A long zoom can reach display level " + level);
    G.release(I);
    const traversal = extended.concat(extended.slice(0,-1).reverse()).map(([pitch]) => [pitch,draw(pitch)]);
    const long = {levels:extended.map(([pitch]) => P.lodRingsAt(region,pitch)?.level ?? -1),
      fresh:traversal.every(([pitch,image]) => equal(image,fresh(pitch)))};
    const fallbackPixels = fresh(6), lowBytes = G.stats(I).gpuBytes;
    const highPixels = fresh(10), highBytes = G.stats(I).gpuBytes;
    const photos = equal(initial.a,fallbackPixels) && equal(initial.b,highPixels);
    globalThis.__atriumGpuFault = "pourLodReuse";
    G.release(I);
    const fault = reversals().metrics;
    delete globalThis.__atriumGpuFault;
    const saved = {...region};
    draw(6); draw(10);
    const beforeEdit = counters();
    Object.assign(region,polygon(4));
    AtriumCanvas.edited(false);
    await prepare();
    const moved = draw(6), afterEdit = counters();
    const edited = {changed:!equal(moved,fallbackPixels),fresh:equal(moved,fresh(6)),
      reuploaded:afterEdit.pourUploads > beforeEdit.pourUploads && afterEdit.pourCacheBytes === 0};
    draw(10);
    const beforeUndo = counters();
    Object.assign(region,saved);
    AtriumCanvas.edited(false);
    await prepare();
    const undonePixels = draw(10);
    const undone = {matches:equal(undonePixels,highPixels),reuploaded:counters().pourUploads > beforeUndo.pourUploads};
    board.pcbDrawing.pours = [];
    AtriumCanvas.edited(false);
    draw(6);
    const {pourBytes,pourCacheBytes} = counters(), removed = {pourBytes,pourCacheBytes};
    board.pcbDrawing.pours = [region];
    AtriumCanvas.edited(false);
    globalThis.__atriumGpuCapMB = (Math.max(lowBytes,highBytes) + 1) / 1048576;
    fresh(6); draw(10);
    const cap = {gpu:G.status(I).renderer === "gpu",evicted:counters().pourCacheBytes === 0};
    G.release(I); globalThis.__atriumGpuCapMB = .000001;
    draw(6,false);
    cap.rejected = G.status(I).renderer === "2d" && /GPU memory/.test(G.status(I).reason);
    delete globalThis.__atriumGpuCapMB;
    fresh(6); draw(10);
    const old = glCanvas(), extension = old.getContext("webgl2").getExtension("WEBGL_lose_context");
    if (!extension) throw Error("The hardware probe cannot exercise real context loss");
    const beforeLoss = counters();
    extension.loseContext();
    await waitFor(() => /context was lost/.test(G.status(I).reason),"Context loss was not observed");
    extension.restoreContext();
    await waitFor(() => {
      draw(6,false);
      return G.status(I).renderer === "gpu";
    },"Context did not restore");
    const firstRestored = counters();
    const restored = {freshCanvas:glCanvas() !== old,freshPixels:equal(draw(6),fallbackPixels),
      reuploaded:firstRestored.pourUploads > beforeLoss.pourUploads && firstRestored.pourCacheBytes === 0};
    return {device:hardware.device,levels,photos,warm,cold,cover,group,retriedGroup,long,fault,edited,undone,removed,cap,restored,driverOOM:await driverOOM()};
  } finally {
    delete globalThis.__atriumGpuFault;
    delete globalThis.__atriumGpuCapMB;
    G.release(I); G.enable(null); cv.remove();
  }
}

module.exports = testPourLOD;
if (require.main === module)
  testPourLOD({requireHardware:process.argv.includes("--require-hardware")}).catch(error => { console.error(error); process.exitCode = 1; });
