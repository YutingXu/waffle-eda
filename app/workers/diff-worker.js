"use strict";
// Web Worker for AtriumDiff.compareAsync on large designs (diff.js starts it beside itself).
// It loads the DOM-free model, the schematic connectivity compiler and the engine, compares the
// two posted projects and posts back the change set. It never touches the page.
// Message in: {before, after, opts}. Messages out: {progress: true} heartbeats, then {result} or {error}.
globalThis.AtriumDiffWorker = (() => {
  let loaded = false;
  function load(drc) {
    if (!loaded) { importScripts("../core/uuid-v7.js", "../core/model.js", "../schematic/sch-objects.js", "../project/hierarchy.js", "../schematic/multichannel.js", "../library/component-match.js", "../pcb/resolved-geometry-curves.js", "../pcb/board-shape-core.js", "../checks/waivers.js", "../checks/net-intent.js", "../core/signals.js", "../history/diff.js"); loaded = true; }
    if (drc && !globalThis.AtriumRules) {
      try { importScripts("../checks/altium-rules.js", "../core/geometry.js", "../pcb/pcb-appearance.js", "../pcb/land-contours.js", "../pcb/pcb-draw.js", "../pcb/component-classes.js", "../checks/net-intent.js", "../checks/rules.js", "../checks/project-rules.js", "../core/signals.js"); } catch { /* DRC delta is skipped */ }
    }
  }
  function strip(result) {
    // `matching` is a non-enumerable Map bundle; structured clone drops it anyway.
    return {summary: result.summary, changes: result.changes, byObject: result.byObject, byNet: result.byNet, stats: result.stats, routing: result.routing, components: result.components};
  }
  // AtriumDiff.compare, step by step, with a heartbeat ({progress: true}) at most once a second: diff.js
  // stops a worker that stays silent for its watchdog time, so a long comparison (a large board with
  // drc: true) says it is still working instead of being killed and redone in main-thread slices.
  const BEAT_MS = 1000;
  function compare(before, after, opts) {
    let beat = Date.now();
    const run = steps => {
      let s;
      do {
        s = steps.next();
        const t = Date.now();
        if (t - beat >= BEAT_MS) { beat = t; self.postMessage({progress: true}); }
      } while (!s.done);
      return s.value;
    };
    if (opts.validate !== false) {
      const A = globalThis.Atrium;
      if (A?.validationSteps) { run(A.validationSteps(before)); run(A.validationSteps(after)); }
      else if (A?.validate) { A.validate(before); A.validate(after); }
    }
    return run(AtriumDiff.compareSteps(before, after, {...opts, validate: false}));
  }
  if (typeof self !== "undefined" && typeof importScripts === "function") {
    self.onmessage = async e => {
      try {
        // {warm}: load the scripts now, while the page paints; the comparison follows.
        if (e.data?.warm) { load(!!e.data.drc); return; }
        if (e.data?.folder) {
          load(false);
          if (!globalThis.AtriumSHA256) importScripts("../core/sha256.js");
          if (!globalThis.AtriumFormat2Git) importScripts("../core/base64.js", "../project/obsolete-project.js", "../project/source-file.js", "../formats/format-2-codec.js", "../formats/format-2-units.js", "../formats/format-2-values.js",
            "../formats/format-2-model.js", "../formats/import-sidecars.js", "../formats/format-2-closure.js", "../core/zip.js", "../formats/sexpr.js", "../vendor/zipjs-deflate.js",
            "../formats/format-2-models.js", "../project/folder-project-engine.js", "../history/project-history-summary.js", "../formats/format-2-git.js");
          self.postMessage({result: await globalThis.AtriumFormat2Git.run(e.data.folder)});
          return;
        }
        if (e.data?.history && (e.data.sources || e.data.project)) {
          load(false);
          if (!globalThis.AtriumSHA256) importScripts("../core/sha256.js");
          if (!globalThis.AtriumHistorySummary) importScripts("../history/project-history-summary.js");
          if (!globalThis.AtriumHistorySource) importScripts("../vendor/cfb.min.js", "../library/parts.js", "../formats/altium-ids.js", "../project/source-file.js", "../project/obsolete-project.js",
            "../formats/sch-import.js", "../checks/altium-rules.js", "../pcb/pcb-pours.js", "../formats/pdf-fonts.js", "../formats/altium-typefaces.js", "../formats/pcb-import.js", "../formats/io.js", "../pcb/board-shape.js", "../formats/board-shape-sources.js", "../formats/sexpr.js",
            "../formats/import-kicad.js", "../core/geometry.js", "../pcb/pcb-appearance.js", "../pcb/land-contours.js", "../pcb/pcb-draw.js", "../pcb/component-classes.js", "../checks/rules.js", "../checks/project-rules.js", "../pcb/pcb-text-rich.js", "../formats/import-link.js", "../workers/import-worker-client.js", "../library/library-import-altium.js", "../history/project-history-source.js");
          if (e.data.project) { self.postMessage({result: AtriumHistorySource.project(e.data.project)}); return; }
          const result = AtriumHistorySummary.fromProjects(AtriumHistorySource.project(e.data.before),
            AtriumHistorySource.project(e.data.after), e.data.region, true);
          self.postMessage({result});
          return;
        }
        const {before, after, opts} = e.data || {};
        load(!!opts?.drc);
        self.postMessage({result: strip(compare(before, after, {...(opts || {}), worker: false}))});
      } catch (error) {
        self.postMessage({error: String(error?.message || error)});
      }
    };
  }
  return {strip, compare, BEAT_MS};
})();
