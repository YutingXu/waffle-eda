"use strict";
// Classic scripts are the common path for the browser and file:// desktop shells.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const read = f => fs.readFileSync(require("../support/app-source-paths.cjs").appFile(f), "utf8");
function browser(settings = {}, missing, blocked = false) {
  const requested = [], compiled = [], G = {...settings};
  const wasm = Object.create(WebAssembly);
  if (blocked) wasm.compile = () => Promise.reject(Error("WebAssembly blocked by policy"));
  wasm.instantiate = (bytes, imports) => { compiled.push(bytes.length); return WebAssembly.instantiate(bytes, imports); };
  let sent;
  const request = new Promise(resolve => { sent = resolve; });
  const run = source => new Function("globalThis", "module", "WebAssembly", source)(G, undefined, wasm);
  G.document = {visibilityState: "visible", createElement: () => ({}), head: {append(script) {
    requested.push(script.src);
    sent();
    Promise.resolve().then(() => {
      if (script.src === missing) { script.onerror(); return; }
      run(read(script.src)); script.onload();
    });
  }}};
  run(read("engine-core.js"));
  return {engine: G.AtriumEngine, requested, request, compiled, document: G.document};
}
async function test() {
  const pane = browser(), e = pane.engine, first = "engine-" + e.candidates[0] + ".js";
  assert.deepEqual(pane.requested, [], "reading the bridge does not request a payload");
  pane.document.visibilityState = "hidden";
  await e.loadBrowser();
  assert.deepEqual(pane.requested, [], "a hidden editor requests nothing");
  pane.document.visibilityState = "visible";
  const load = e.loadBrowser();
  assert.equal(load, e.loadBrowser(), "two callers share their load");
  await pane.request;
  pane.document.visibilityState = "hidden"; await load;
  assert.equal(pane.compiled.length, 0, "hiding between request and delivery defers compilation");
  pane.document.visibilityState = "visible"; await e.loadBrowser();
  assert.deepEqual(pane.requested, [first]); assert.equal(pane.compiled.length, 1);
  assert.equal(e.variant, e.candidates[0]);
  const scalar = browser({ATRIUM_ENGINE_SIMD: "0"}); await scalar.engine.loadBrowser();
  assert.deepEqual(scalar.requested, ["engine-mvp.js"]); assert.equal(scalar.engine.variant, "mvp");
  const js = browser({ATRIUM_ENGINE: "js"}); await js.engine.loadBrowser();
  assert.equal(js.engine.pourSolve({}), null); assert.equal(js.requested.length, 0);
  const blocked = browser({}, null, true); await blocked.engine.loadBrowser();
  assert.equal(blocked.engine.available, false); assert.deepEqual(blocked.requested, [], "CSP-blocked Wasm needs no payload");
  const failed = browser({ATRIUM_ENGINE_SIMD: "0"}, "engine-mvp.js"); await failed.engine.loadBrowser();
  assert.equal(failed.engine.airwires([], []), null); assert.equal(failed.engine.settled, true);
  if (e.candidates.includes("simd128")) {
    const fallback = browser({}, "engine-simd128.js"); await fallback.engine.loadBrowser();
    assert.deepEqual(fallback.requested, ["engine-simd128.js", "engine-mvp.js"]);
    assert.equal(fallback.engine.variant, "mvp");
  }
  console.log("engine loading: one local payload, suspended visibility, forced modes and fallbacks OK");
}
globalThis.__testDone = test();
globalThis.__testDone.catch(error => { console.error(error); process.exitCode = 1; });
