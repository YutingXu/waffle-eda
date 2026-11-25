"use strict";
// AtriumCanvasGPUPref: which renderer draws the board views (canvas-gpu.js; docs/design/gpu-renderer.md).
// Loaded by a PCB view or Preferences › Display › Renderer (key display.renderer, stored by AtriumPrefs):
//   "auto"  Automatic: the GPU (WebGL2) where it is hardware-accelerated, else 2D
//   "gpu"   the GPU wherever WebGL2 exists, a software rasterizer included
//   "2d"    the 2D canvas renderer
// The 2D renderer also draws print, export, previews and thumbnails whatever the choice, and stays the
// fallback (no WebGL2, a lost context that does not come back, too little GPU memory, an error).
// Software rasterizers are told apart by their renderer string (WEBGL_debug_renderer_info: SwiftShader,
// llvmpipe, Microsoft Basic Render Driver, ...) and by failIfMajorPerformanceCaveat. canvas-gpu.js loads
// only when the decision is to use it. Without a page (headless, MCP) nothing here runs: boards stay 2D.
globalThis.AtriumCanvasGPUPref = (() => {
  const G = globalThis, KEY = "display.renderer", OLD = "experimental.gpuBoard", MODES = ["auto", "gpu", "2d"];
  // Automatic picks the GPU on hardware-accelerated WebGL2 (docs/design/gpu-renderer.md "Default").
  const AUTO_GPU = true;
  const SOFT = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|mesa offscreen|gdi generic|microsoft basic/i;
  const probes = new Map();
  let cached = null, cancelRequest = null, requested = false;
  const mode = () => { let v; try { v = G.AtriumPrefs?.get?.(KEY); } catch {} return MODES.includes(v) ? v : "auto"; };
  const visible = () => G.AtriumPower?.visible?.() ?? G.document?.visibilityState !== "hidden";
  // Automatic leaves adapter selection power-aware. Only an explicit GPU setting requests high performance.
  const powerFor = m => m === "gpu" ? "high-performance" : "low-power";
  // The two power hints may resolve to different adapters. Probe each once, on screen.
  function probe(m = mode()) {
    const powerPreference = powerFor(m);
    if (probes.has(powerPreference)) return probes.get(powerPreference);
    const probed = {webgl2: false, software: false, device: ""};
    if (m === "2d" || !visible()) return probed;
    probes.set(powerPreference, probed);
    try {
      const doc = G.document;
      if (!doc || typeof G.WebGL2RenderingContext !== "function") return probed;
      let gl = doc.createElement("canvas").getContext("webgl2", {powerPreference, failIfMajorPerformanceCaveat: true}), caveat = false;
      if (!gl) { gl = doc.createElement("canvas").getContext("webgl2", {powerPreference}); caveat = !!gl; }
      if (!gl) return probed;
      const x = gl.getExtension("WEBGL_debug_renderer_info");
      probed.webgl2 = true;
      probed.device = String(gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
      probed.software = caveat || SOFT.test(probed.device);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {}
    return probed;
  }
  // Reason says why the 2D renderer is used or why the board view is paused.
  function decision() {
    const m = mode();
    const paused = m !== "2d" && !visible();
    if (!paused && cached?.mode === m) return cached;
    const powerPreference = powerFor(m);
    const options = {mode: m, powerPreference, use: false, reason: "", device: "", software: false};
    if (paused) return {...options, reason: "the editor window is hidden"};
    if (m === "2d") return cached = {...options, reason: "Preferences › Display › Renderer is set to 2D"};
    const p = probe(m), out = {...options, device: p.device, software: p.software};
    if (!p.webgl2) out.reason = "WebGL2 is not available here";
    else if (m === "gpu") out.use = true;
    else if (p.software) out.reason = "WebGL2 is not hardware-accelerated here (" + (p.device || "software renderer") + ")";
    else if (!AUTO_GPU) out.reason = "Automatic uses the 2D renderer in this version";
    else out.use = true;
    return cached = out;
  }
  function cancel() {
    cancelRequest?.();
    cancelRequest = null;
  }
  // Requested by an onscreen editor PCB pane. Paint its first 2D frame before probing for a GPU.
  function request(needsBoard) {
    const m = mode(), L = G.AtriumLazy;
    if (!L || G.AtriumCanvasGPU || cancelRequest || requested || !visible() || m === "2d" || (cached?.mode === m && !cached.use) || !needsBoard()) return;
    const start = () => {
      cancelRequest = null;
      if (!visible() || !needsBoard() || !decision().use) return;
      requested = true;
      L.need("AtriumCanvasGPU").then(() => {
        if (visible() && needsBoard()) G.AtriumNavHost?.redraw?.(true);
      }).catch(() => {});
    };
    const idle = G.AtriumIdle;
    if (idle) {
      const id = idle.idle(start, {timeout: 300});
      cancelRequest = () => idle.cancel(id);
    } else start();
  }
  // One line for Preferences and About: "GPU (WebGL2, Apple M2)" or "2D: <reason>".
  function describe() {
    const m = mode();
    if (m === "2d") return "2D: " + decision().reason;
    if (!visible()) return "Paused while the editor window is hidden";
    if (!probes.has(powerFor(m))) return "No PCB view is using a renderer";
    const s = G.AtriumCanvasGPU?.status?.();
    const d = decision();
    const gpu = s ? s.renderer === "gpu" : d.use;
    const device = s?.device || d.device;
    return gpu ? "GPU (WebGL2" + (device ? ", " + device : "") + ")" : "2D: " + (s?.reason || d.reason || "the GPU renderer is not in use");
  }
  function attach() {
    const P = G.AtriumPrefs;
    if (!P?.registerPage) return false;
    // The experiment's switch (Preferences › Experimental) becomes Renderer: GPU once.
    try { if (P.get(OLD) === true && P.get(KEY) == null) P.set(KEY, "gpu"); if (P.get(OLD) != null) P.reset([OLD]); } catch {}
    P.registerPage({id: "display", title: "Display and Energy", order: 3.2, keywords: "display renderer gpu webgl webgl2 2d canvas hardware acceleration graphics performance board",
      render(c, api) {
        const g = api.group(c, "Board view");
        const row = api.el("div", "prf-row"); row.dataset.search = "renderer gpu webgl 2d canvas hardware acceleration graphics board view";
        const label = api.el("label", "prf-label", "Renderer"); label.htmlFor = "prf-display-renderer";
        const sel = api.el("select", "ui-field"); sel.id = "prf-display-renderer";
        for (const [v, t] of [["auto", "Automatic"], ["gpu", "GPU (WebGL2)"], ["2d", "2D"]]) { const o = api.el("option", null, t); o.value = v; sel.append(o); }
        sel.value = mode();
        const now = api.el("small", "prf-help"); now.id = "prf-display-renderer-now";
        const detail = api.el("span", "visually-hidden"); detail.id = now.id + "-detail";
        const show = () => {
          const actual = describe();
          now.textContent = actual.startsWith("GPU (") ? "Using GPU (WebGL2)" :
            actual.startsWith("2D:") ? "Using 2D renderer" : actual;
          now.title = actual;
          detail.textContent = actual === now.textContent ? "" : actual;
        };
        sel.onchange = () => { P.set(KEY, sel.value); show(); setTimeout(show, 300); };
        const control = api.el("span", "prf-control"); control.append(sel);
        const help = api.el("small", "prf-help", "Automatic uses the GPU when hardware-accelerated. Exports and previews use 2D.");
        help.id = "prf-display-renderer-help"; sel.setAttribute("aria-describedby", help.id + " " + now.id + " " + detail.id);
        row.append(label, control, help, now, detail); g.append(row); show();
      }});
    G.AtriumPower?.onChange?.(s => { if (!s.visible) cancel(); });
    P.on(KEY, () => {
      cancel(); cached = null; requested = false;
      if (G.AtriumCanvasGPU) G.AtriumCanvasGPU.refresh(true);
      else if (visible()) G.AtriumNavHost?.redraw?.(true);
    });
    return true;
  }
  if (!attach() && G.document) G.AtriumLazy?.need?.("AtriumPrefs").then(attach, () => {});
  return Object.freeze({attach, key: KEY, modes: MODES, decision, describe, probe, request, autoGPU: AUTO_GPU});
})();
