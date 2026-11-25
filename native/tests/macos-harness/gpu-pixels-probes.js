"use strict";
// GPU pixel test in WKWebView (gpu-pixels.sh): runs tests/canvas/gpu-pixels.js's atriumGpuPixels in the real Desktop
// class and WKWebView. Images go to the work folder through the harness's "save" op (one data URL a file);
// the numbers come back on one line. See docs/design/gpu-renderer.md.
globalThis.__uiProbes = {run: async () => {
  const post = (op, a = {}) => webkit.messageHandlers.harness.postMessage({op, ...a});
  try {
    // A Terminal-launched window can receive a real occlusion update after the WebKit test
    // override. Keep this window visible for pixel captures and the simulated lifecycle checks.
    await post("window", {act: "unhide"});
    await post("window", {act: "restore"});
    globalThis.AtriumPower?.host?.({occluded: false});
    const {dpr, ...select} = globalThis.__gpuSelect || {}, native = globalThis.devicePixelRatio;
    if (typeof dpr === "number") Object.defineProperty(globalThis, "devicePixelRatio", {value: dpr, configurable: true});
    const o = await atriumGpuPixels({...select, images: globalThis.__gpuImages ? true : select.images});
    if (o.pixelRatio) Object.assign(o.pixelRatio, {native, requested: dpr ?? "native"});
    if (dpr && dpr !== 1) (o.notes ??= []).push("Per-case WKWebView budgets use DPR 1. This run uses the general limits.");
    const images = o.images || {}; delete o.images;
    const names = [];
    for (const [k, v] of Object.entries(images)) for (const [kind, url] of Object.entries(v)) { const n = k + "." + kind + ".png.b64"; await post("save", {name: n, text: url.split(",", 2)[1]}); names.push(n); }
    o.imageFiles = names;
    return "GPUPIXELS " + JSON.stringify(o);
  } catch (e) { return "JSERROR " + e.message + " " + e.stack; }
}};
