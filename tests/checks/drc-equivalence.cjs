"use strict";
// DRC and connectivity results stay identical through performance work (throughput pass).
// Runs the full batch DRC (every rule type, connectivity for shorts and un-routed nets) on
//   * the 25.6k-object dense board (tests/pcb/dense-board.js) with nets on every copper object, and
//   * the real Altium fixture board (tests/fixtures/altium/pidp11-io-expander),
// and compares a digest of every violation (order, rule, objects, values, locations) and of the
// connectivity result (nets, shorts, airwires) with the digests the code produced before the
// pass. A deliberate change to DRC output must update EXPECTED (run with --print).
// Run: scripts/test-jsc.sh drc-equivalence   (or node tests/checks/drc-equivalence.cjs [--print])
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {appFile} = require("../support/app-source-paths.cjs");
// Keep the historical benchmark IDs so the frozen geometry digests are comparable.
let serial = 0, schematicImport = false;
require(appFile("uuid-v7.js"));
AtriumUUID.next = () => (schematicImport ? "10000000" : "00000000") +
  "-0000-4000-8000-" + (++serial).toString(16).padStart(12, "0");
globalThis.CFB = require(appFile("vendor/cfb.min.js"));
for (const f of ["model", "parts", "pcb-appearance", "net-ties", "sch-objects", "hierarchy", "board-shape", "stackup", "viastack", "polygon-pour", "component-classes", "query",
  "import-link", "source-file", "sch-import", "altium-rules", "pcb-pours", "pcb-import", "io", "engine-core", "connectivity", "rules", "impedance", "dfa", "drc"]) require(appFile(f + ".js"));
require("../pcb/dense-board.js");
// The Rust/WebAssembly kernels (engine-core.js) must give the same digests: ATRIUM_ENGINE=wasm
// requires them, =js runs the JS fallbacks only (scripts/test-jsc.sh passes it through).
const engineMode = globalThis.ATRIUM_ENGINE ?? process.env.ATRIUM_ENGINE;
if (engineMode === "wasm") assert.ok(AtriumEngine.available, "Rust/WebAssembly kernels: " + AtriumEngine.failure);
if (engineMode === "js") assert.ok(!AtriumEngine.available);

// FNV-1a over the JSON text, two lanes (64 bits as 16 hex digits); numbers are rounded to 1 nm
// so the digest names the result, not floating-point noise in the last place.
function digest(value) {
  const text = JSON.stringify(value, (k, v) => typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v) ? Math.round(v * 1e6) / 1e6 : v);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x5bd1e995) >>> 0; }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
function summary(doc, defs) {
  const conn = AtriumConnectivity.inspect(doc, defs);
  const out = AtriumRules.drc(doc, defs, doc.rules || null, {connections: conn});
  return {violations: out.violations.length, total: out.total, drc: digest([out.violations, out.rules, out.notes, out.total]),
    connectivity: digest([conn.nets, conn.shorts, conn.airwires, conn.excluded, conn.unassigned])};
}

// Dense board: as mcp_headless_performance.py builds it (every copper object on one of 400 nets).
const {d: dense, defs: denseDefs} = makeAtriumBenchmarkBoard(160);
let n = 0;
for (const i of dense.items) if (i.kind !== "part") i.net = "N" + (n++ % 400); else i.pinNets = {"1": "N" + (n % 400), "2": "N" + ((n + 1) % 400)};

// Altium fixture: imported as File › Import › Altium does (tests/formats/import-altium-real.cjs).
const DIR = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
const p = Atrium.project("PiDP-11 I/O Expander"); p.documents = []; p.library = [];
for (const name of ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"]) {
  // Keep the pre-throughput fixture's PCB IDs independent of schematic imports.
  // Adding an editable schematic note otherwise shifts every generated PCB ID.
  schematicImport = name.endsWith(".SchDoc");
  if (name.endsWith(".PcbDoc")) serial = 239;
  const r = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(DIR, name))));
  p.documents.push(...(r.documents || [])); p.library.push(...(r.library || []));
}
if (globalThis.AtriumImportLink) AtriumImportLink.reconcile(p, p.documents);
Atrium.validate(p);
const altiumDefs = new Map(p.library.map(x => [x.id, x])), board = p.documents.find(x => x.kind === "pcb");
if (board.pcbDrawing?.sourceFill) AtriumPolygonPour.adopt(board, altiumDefs);

const got = {dense: summary(dense, denseDefs), altium: summary(board, altiumDefs)};
// The DRC digests use the editor's layer names and the glyph diagnostics from
// this standalone module set. Connectivity retains the original corpus digests.
const EXPECTED = {dense: {violations: 5417, total: 31220, drc: "46eb90a05ac92e1d", connectivity: "dc4c5e8d3aeaef82"},
  altium: {violations: 54, total: 54, drc: "b827946604301473", connectivity: "78066be112fa0ae6"}};
if (process.argv.includes("--print") || !EXPECTED) { console.log(JSON.stringify(got)); }
else assert.deepEqual(got, EXPECTED);
console.log("drc-equivalence (" + (AtriumEngine.available ? "Rust/WebAssembly kernels" : "JS") + "): dense " + got.dense.total + " violations, Altium fixture " + got.altium.total + " violations; digests match");
