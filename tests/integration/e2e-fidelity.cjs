"use strict";
// End-to-end fidelity, fast tier: import -> model checks against the source -> outputs ->
// comparison with the original tool's own outputs -> render stage -> native round trip, on the
// vendored PiDP-11 I/O Expander (tests/fixtures/altium/pidp11-io-expander, BSD-2-Clause; its
// altium-outputs-reva/ are the Gerber and NC drill files Altium Designer generated for this exact
// PcbDoc). The oracles are never Waffle: an independent PcbDoc reader (tests/e2e/altium-oracle.cjs)
// and Altium's own films. See tests/e2e/pipeline.cjs.
//
// It then proves the suite can see the failures it exists for: each mutation (a pad turned into a
// capsule, a track widened or moved, a track moved to the other layer, a pour dropped, and the
// pour-outline "spaghetti" renderer bug restored) must turn at least one gating check red.
//
// The full tier (fetched Altium and KiCad corpora, the private corpus) is tests/e2e/run.py.
// Run with scripts/test-jsc.sh e2e-fidelity, or run this file with Node after preparing app assets.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const ROOT = path.join(__dirname, "../..");
require("../e2e/modules.cjs").load(ROOT);
const P = require("../e2e/pipeline.cjs");
const DIR = path.join(__dirname, "../fixtures/altium/pidp11-io-expander"), OUT = path.join(DIR, "altium-outputs-reva");
const bytes = name => new Uint8Array(fs.readFileSync(path.join(DIR, name)));
// Latin-1 by hand: the JavaScriptCore shim's readFileSync returns bytes for any encoding but UTF-8.
const text = name => { const b = new Uint8Array(fs.readFileSync(path.join(OUT, name))); let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
const fixture = {id:"pidp11-io-expander", name:"PiDP-11 I/O Expander", origin:"auto"};
const sources = ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"].map(name => ({name, bytes:bytes(name)}));
const gerbers = ["GTL", "GBL", "GTS", "GBS", "GTP", "GBP", "GTO", "GBO", "GM1"].map(key =>
  ({key, layer:key === "GM1" ? "profile" : key, text:text("PiDP11IOExpander." + key)}));
const references = {gerbers, drills:[text("PiDP11IOExpander.TXT")]};
const known = JSON.parse(fs.readFileSync(path.join(__dirname, "../e2e/known-failures.json"), "utf8")).failures;
const print = process.argv.includes("--print");

const report = P.run({fixture, sources, references});
const {failures, expected, fixed} = P.verdict(report, known);
if (print) for (const r of report.results) console.log((r.pass ? "ok   " : r.gating ? "FAIL " : "info ") + r.id + " " + JSON.stringify(r.metric));
assert.deepEqual(failures.map(r => r.id + " " + JSON.stringify(r.metric) + " " + r.detail.join("; ")), [], "unexpected end-to-end failures");
assert.deepEqual(fixed.map(r => r.id + " (" + r.bug + ")"), [], "listed known failures now pass: remove them from tests/e2e/known-failures.json");
// The stages that must have run: a stage that throws reports "stage.<name>", which is a failure above.
for (const id of ["model.tracks", "model.pads", "model.vias", "model.slots", "model.netlist", "model.outline", "model.placement", "checks.erc-drc",
  "outputs.generated", "outputs.netlist", "plot.GTL", "plot.GBL", "drill", "render.GTL", "render.GBL", "roundtrip.reopen-no-rewrite"])
  assert(report.results.some(r => r.id === id), id + " did not run");

// Mutations: each must add a gating failure the clean run does not have.
const canvasText = fs.readFileSync(path.join(ROOT, "app/canvas/canvas.js"), "utf8");
for (const name of ["any-pad-to-round", "track-width", "track-endpoint", "layer-remap", "drop-polygon", "pour-outline-stroke"]) {
  let applied;
  const spec = {fixture, sources, references, roundTrip:false};
  if (P.SOURCE_MUTATIONS[name]) applied = P.applySourceMutation(name, () => canvasText);
  else spec.mutate = model => { applied = P.MUTATIONS[name](model); };
  let mutated;
  try { mutated = P.run(spec); }
  finally { if (P.SOURCE_MUTATIONS[name]) (0, eval)(canvasText); }
  assert.equal(applied, true, name + " could not be applied to this board");
  const red = P.newlyRed(report, mutated);
  assert(red.length, "mutation " + name + " left the suite green");
  if (print) console.log("mutation " + name + ": red (" + red.join(", ") + ")");
}

// Reproduce the stack-pad import regression. Altium stores each face's rounded-rectangle shape and
// corner radius in an extension block. Reading only the legacy shape yielded circles or capsules.
// Add that block to four top-middle-bottom pads, with shape 9 and a 30% radius on the outer faces.
{
  const O = require("../e2e/altium-oracle.cjs");
  const streams = O.compoundFile(bytes("PiDP11IOExpander.PcbDoc"));
  const records = O.binaryRecords(streams.get("pads6/data"), t => t === 2 ? 6 : 0);
  let changed = 0;
  for (const r of records) {
    if (r.blocks[4][62] !== 1 || r.blocks[5].length || changed === 4) continue;
    const details = new Uint8Array(596);
    details[532] = details[532 + 31] = 9;      // alternate shape: rounded rectangle (top, bottom)
    details[564] = details[564 + 31] = 30;     // corner radius, percent of half the smaller side
    r.blocks[5] = details; changed++;
  }
  assert.equal(changed, 4);
  streams.set("pads6/data", O.writeRecords(records));
  const input = AtriumPCB.read("PiDP11IOExpander.PcbDoc", streams, null);
  const pads = P.altiumModelChecks(O.readStreams(streams), {documents:input.documents, library:input.library}).find(r => r.id === "model.pads");
  const entry = known.find(k => k.project === "pidp11-stack-roundrect" && k.check === "model.pads");
  if (entry) assert.equal(pads.pass, false, "stack-pad rounded rectangles now import: remove the known failure (" + entry.bug + ")");
  else assert(pads.pass, "stack-pad rounded rectangles: " + JSON.stringify(pads.metric) + " " + pads.detail.join("; "));
  if (print) console.log("stack-pad roundrect reproduction: " + (pads.pass ? "passes" : "known failure, " + pads.metric.missing + " faces wrong"));
}
console.log("e2e-fidelity: " + report.results.filter(r => r.pass).length + " checks pass, " + expected.length + " known failures, 6 mutations caught, stack-pad roundrect reproduction run");
