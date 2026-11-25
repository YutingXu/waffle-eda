"use strict";
// Worker start probes for the WKWebView harness (and the WebKitGTK harness): appended after
// ui-probes.js and tests/workers/worker-start-probe.js, it boots through the stock probes (none selected),
// runs atriumWorkerProbe() and prints one PASS/FAIL line per worker and per release, plus the
// result as "NOTE  WORKERS <json>" lines (tests/workers/worker-start.py reads them back).
// Run: tests/workers/worker-start.py --webkit (macOS) or --gtk (Linux). Test-only.
{
  const P = globalThis.__uiProbes, post = (op, a = {}) => webkit.messageHandlers.harness.postMessage({op, ...a});
  globalThis.__uiProbes = {...P, async run() {
    await P.run("__boot_only__");
    try {
      const r = await globalThis.atriumWorkerProbe(globalThis.__workerProbeOptions || {});
      for (const [name, w] of Object.entries(r.workers)) P.log(w.ok, "worker starts: " + name, w.supply + " · " + w.state + " · " + w.ms + " ms" + (w.detail ? " · " + w.detail : ""));
      for (const [job, x] of Object.entries(r.releases)) P.log(!x.error && x.outputs.every(o => o.status !== "error") && (x.page ? x.stats.worker === 0 : x.stats.worker > 0), "release: " + job, x.error || JSON.stringify({stats: x.stats, ms: x.ms, outputs: x.outputs.length, messages: x.messages}));
      const text = JSON.stringify(r);
      for (let i = 0, n = 0; i < text.length; i += 3000, n++) await post("note", {text: "WORKERS " + n + " " + text.slice(i, i + 3000)});
      await post("note", {text: "WORKERS end"});
    } catch (e) { P.log(false, "worker probe ran", String(e?.stack || e).slice(0, 400)); }
    return {passed: 0, failed: 0};
  }};
}
