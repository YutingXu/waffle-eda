"use strict";
// A private CLI process. Stable IDs fix equal-length MST tie breaks on independent imports.
const {performance: realClock} = require("node:perf_hooks");
let id = 0, tick = 0;
function resetId() { id = 0; }
Object.defineProperty(globalThis, "crypto", {configurable: true, value: {
  randomUUID: () => "00000000-0000-4000-8000-" + (++id).toString(16).padStart(12, "0")
}});
// The shipped worker checks its clock in bounded search loops. Charge a fixed amount per
// read across all strategies so CPU contention cannot change geometry; measure wall time separately.
function resetClock() { tick = 0; id = 0x10000000; }
Object.defineProperty(globalThis, "performance", {configurable: true, value: {now: () => ++tick / 64}});
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "parts", "sch-objects", "hierarchy", "net-intent", "signals", "altium-rules",
  "component-classes", "query", "pcb-draw", "rules", "project-rules", "board-shape", "stackup", "pcb-appearance", "pcb-pours",
  "net-ties", "connectivity", "polygon-pour", "drc-pours", "sexpr", "import-eagle", "source-file", "altium-ids",
  "altium-typefaces", "sch-import", "pcb-import", "io", "import-link", "import-rules", "viastack", "router",
  "length-tuning", "diffpair", "teardrops", "fanout", "autorouter", "autorouter-v2"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
function imported(source, name) {
  resetId();
  const p = Atrium.project(name);
  const result = /\.brd$/i.test(source.name) ? AtriumImportFormats.read(source.name, source.bytes) : AtriumIO.read(source.name, source.bytes);
  p.documents = result.documents;
  p.library = result.library;
  AtriumImportLink.reconcile(p, p.documents);
  const d = p.documents.find(d => d.kind === "pcb");
  if (d.sourceRules?.length) AtriumImportRules.apply(d, p, definitions(p));
  return p;
}
const definitions = p => new Map(p.library.map(def => [def.id, def]));
module.exports = {resetClock, definitions, imported, now: () => realClock.now()};
