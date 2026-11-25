"use strict";
// GPU board renderer experiment in WKWebView (gpu.sh): runs tests/canvas/perf-gpu.js's atriumGpuBench in the real
// Desktop class and WKWebView and returns its numbers on one line. See docs/design/gpu-renderer.md.
globalThis.__uiProbes = {run: async () => {
  try { return "GPUBENCH " + JSON.stringify(await atriumGpuBench({mode: globalThis.__gpuMode || undefined})); }
  catch (e) { return "JSERROR " + e.message + " " + e.stack; }
}};
