"use strict";
// Board renderer choice (app/canvas/canvas-gpu-pref.js): Preferences › Display › Renderer against what WebGL2 the
// page has. Automatic leaves software rasterizers (SwiftShader, llvmpipe, Microsoft Basic Render Driver) and
// contexts that fail failIfMajorPerformanceCaveat to the 2D renderer; GPU takes any WebGL2; 2D never loads
// canvas-gpu.js; without a page (headless, MCP) nothing is probed. The old experimental switch migrates.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh gpu-pref).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const src = fs.readFileSync(path.join(__dirname, "../../app/canvas/canvas-gpu-pref.js"), "utf8");

function page({renderer = "Apple M2", caveat = false, webgl2 = true, prefs = {}, visible = true, idle = null, lost = false, queryError = false} = {}) {
  const values = {...prefs}, listeners = [], power = [], pages = [], need = [], requests = [];
  globalThis.AtriumPrefs = {get: k => values[k], set: (k, v) => { values[k] = v; for (const f of listeners) f({key: k, value: v}); }, reset: ks => { for (const k of ks) delete values[k]; },
    on: (k, f) => listeners.push(f), registerPage: p => pages.push(p)};
  globalThis.AtriumLazy = {need: name => { need.push(name); return Promise.resolve(); }};
  globalThis.AtriumPower = {visible: () => visible, onChange: f => power.push(f)};
  globalThis.AtriumIdle = idle;
  globalThis.WebGL2RenderingContext = webgl2 ? function () {} : undefined;
  const contexts = [];
  globalThis.document = {createElement: () => ({getContext(kind, o) {
    requests.push({...o, width:this.width, height:this.height});
    if (kind !== "webgl2" || !webgl2 || (caveat && o?.failIfMajorPerformanceCaveat)) return null;
    const gl = {RENDERER: 1, isContextLost: () => lost || !!gl.lost, getExtension: n => n === "WEBGL_debug_renderer_info" ? {UNMASKED_RENDERER_WEBGL: 2} : n === "WEBGL_lose_context" ? {loseContext() { gl.lost = true; }} : null,
      getParameter(p) { if (queryError) throw Error("renderer query failed"); return p === 2 ? (typeof renderer === "function" ? renderer(o?.powerPreference) : renderer) : "WebKit WebGL"; }};
    contexts.push(gl); return gl;
  }})};
  delete globalThis.AtriumCanvasGPU;
  new Function(src)();
  const show = next => { visible = next; for (const f of power) f({visible: next}); };
  return {P: globalThis.AtriumCanvasGPUPref, values, pages, need, contexts, requests, show};
}

// Hardware WebGL2: Automatic decides by AUTO_GPU; GPU uses it; 2D does not; the probe context is let go.
{
  const {P, need, pages, contexts, requests} = page();
  assert.deepEqual(requests, [], "loading renderer settings alone starts no GPU probe");
  assert.match(P.describe(), /No PCB view/);
  assert.match(P.decision().reason, /no PCB view/);
  assert.deepEqual(requests, []);
  P.request(() => true);
  const d = P.decision();
  assert.equal(d.mode, "auto"); assert.equal(d.software, false); assert.equal(d.device, "Apple M2");
  assert.equal(d.powerPreference, "low-power"); assert.equal(requests[0].powerPreference, "low-power");
  assert.deepEqual(requests[0], {powerPreference:"low-power",failIfMajorPerformanceCaveat:true,width:1,height:1});
  assert.equal(d.use, P.autoGPU); assert.equal(need.includes("AtriumCanvasGPU"), P.autoGPU, "canvas-gpu.js loads only when it is used");
  assert.ok(contexts.every(g => g.lost), "the probe context is released");
  assert.deepEqual(pages.map(p => p.id), ["display"]);
  globalThis.AtriumPrefs.set("display.renderer", "gpu");
  P.request(() => true);
  assert.equal(P.decision().use, true); assert.ok(need.includes("AtriumCanvasGPU"));
  assert.equal(P.decision().powerPreference, "high-performance"); assert.equal(requests[1].powerPreference, "high-performance");
  globalThis.AtriumPrefs.set("display.renderer", "2d");
  assert.equal(P.decision().use, false); assert.match(P.decision().reason, /set to 2D/);
  assert.match(P.describe(), /^2D: /);
}
// An explicit 2D choice starts no GPU probe or renderer. Foregrounding a hidden view only
// probes the current choice, then reuses the result through later visibility changes.
{
  const {P, need, requests, show} = page({visible: false, prefs: {"display.renderer": "2d"}});
  assert.match(P.describe(), /set to 2D/);
  show(true);
  P.request(() => true);
  assert.deepEqual(requests, []); assert.deepEqual(need, []);
  show(false);
  globalThis.AtriumPrefs.set("display.renderer", "auto");
  P.request(() => true);
  assert.match(P.decision().reason, /window is hidden/);
  assert.deepEqual(requests, []); assert.deepEqual(need, []);
  show(true);
  P.request(() => true);
  assert.equal(P.decision().use, P.autoGPU);
  assert.equal(requests[0].powerPreference, "low-power");
  show(false); show(true);
  P.request(() => true);
  assert.equal(requests.length, 1);
}
// A deferred probe is canceled offscreen and skips a board that closed before it could start.
{
  const jobs = new Map(); let id = 0;
  const idle = {idle(fn) { jobs.set(++id, fn); return id; }, cancel(token) { jobs.delete(token); }};
  const {P, need, requests, show} = page({idle});
  let board = true;
  P.request(() => board);
  assert.equal(jobs.size, 1);
  show(false);
  assert.equal(jobs.size, 0);
  show(true);
  P.request(() => board);
  board = false;
  const task = jobs.get(id); jobs.delete(id); task();
  assert.deepEqual(requests, []); assert.deepEqual(need, []);
  board = true;
  P.request(() => board);
  const retry = jobs.get(id); jobs.delete(id); retry();
  assert.equal(need.includes("AtriumCanvasGPU"), P.autoGPU);
}
// On a machine with two adapters, the Automatic eligibility and the explicit override use
// their own context requests and device names.
{
  const {P, need} = page({renderer: power => power === "low-power" ? "llvmpipe" : "Metal GPU"});
  assert.equal(P.decision(true).use, false); assert.deepEqual(need, []);
  globalThis.AtriumPrefs.set("display.renderer", "gpu");
  assert.equal(P.decision(true).device, "Metal GPU"); assert.equal(P.decision().use, true);
  globalThis.AtriumPrefs.set("display.renderer", "auto");
  assert.equal(P.decision().device, "llvmpipe"); assert.equal(P.decision().use, false);
}
// Software rasterizers: by name, or by failIfMajorPerformanceCaveat.
for (const renderer of ["Google SwiftShader", "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", "llvmpipe (LLVM 15.0.7, 256 bits)",
  "Microsoft Basic Render Driver", "Mesa OffScreen", "softpipe"]) {
  const {P, need} = page({renderer});
  const d = P.decision(true);
  assert.equal(d.software, true, renderer); assert.equal(d.use, false, renderer); assert.match(d.reason, /not hardware-accelerated/);
  assert.ok(!need.includes("AtriumCanvasGPU"), renderer + ": canvas-gpu.js is not loaded");
  globalThis.AtriumPrefs.set("display.renderer", "gpu");
  assert.equal(P.decision(true).use, true, renderer + ": Renderer GPU still uses it");
}
{
  const {P,requests,contexts} = page({caveat:true});
  P.request(() => true);
  assert.equal(P.decision().use, false);
  assert.equal(requests.length,1,"Automatic makes one strict request");
  assert.equal(contexts.length,0,"a major caveat must not acquire a fallback adapter");
}
for (const failure of [{lost:true},{queryError:true}]) {
  const {P,contexts,requests} = page(failure);
  P.request(() => true);
  assert.equal(P.decision().use,false);
  assert.equal(requests.length,1);
  assert.ok(contexts[0].lost,"a rejected context is released");
}
// No WebGL2: 2D whatever the choice.
{
  const {P} = page({webgl2: false, prefs: {"display.renderer": "gpu"}});
  assert.equal(P.decision(true).use, false); assert.match(P.decision().reason, /WebGL2 is not available/);
}
// The experiment's switch becomes Renderer: GPU once.
{
  const {values} = page({prefs: {"experimental.gpuBoard": true}});
  assert.equal(values["display.renderer"], "gpu"); assert.ok(!("experimental.gpuBoard" in values));
}
// A loaded renderer still does not probe from status, preference changes or non-editor paints.
{
  const {requests} = page();
  const gpuSource = fs.readFileSync(path.join(__dirname, "../../app/canvas/canvas-gpu.js"), "utf8");
  globalThis.AtriumPCBAppearance = {};
  new Function(gpuSource)();
  const gpu = globalThis.AtriumCanvasGPU;
  gpu.status();
  globalThis.AtriumPrefs.set("display.renderer", "gpu");
  assert.equal(gpu.render({}, {kind:"schematic"}, new Map(), {editorPane:true}), false);
  assert.equal(gpu.render({}, {kind:"pcb"}, new Map(), {print:true}), false);
  assert.deepEqual(requests, []);
  delete globalThis.AtriumCanvasGPU;
  delete globalThis.AtriumPCBAppearance;
}
// Without a page nothing is probed and the board stays 2D.
{
  delete globalThis.document; delete globalThis.AtriumPrefs; delete globalThis.AtriumLazy; delete globalThis.AtriumPower; delete globalThis.AtriumCanvasGPUPref;
  new Function(src)();
  const d = globalThis.AtriumCanvasGPUPref.decision();
  assert.equal(d.use, false);
}
console.log("SHIM-OK gpu-pref");
