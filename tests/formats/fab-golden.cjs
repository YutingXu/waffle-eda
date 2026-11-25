"use strict";
// Golden self-regression of Waffle's fabrication outputs. Every file the
// Fabrication Outputs dialog writes (Gerber, NC drill, drill drawing and
// report, pick and place, assembly drawing, readme) is generated for three
// boards and compared with tests/goldens/fab/:
//   sample   AtriumParts.example() (the shipped sample board); full text kept in goldens/fab/sample/
//   dense    the 25,600-object board (tests/pcb/dense-board.js); SHA-256 and size only (about 8 MB)
//   pidp11   the real Altium fixture as imported (tests/fixtures/altium/pidp11-io-expander)
// Outputs are normalised first: dates and times become <date>, so the files do
// not depend on the clock or the time zone. Any other change to any output
// fails this test until the goldens are updated on purpose:
//   scripts/update-goldens.sh        (then review `git diff tests/goldens`)
// Run: scripts/test-jsc.sh fab-golden   (or node tests/formats/fab-golden.cjs); --emit prints the new goldens.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const f of ["model", "parts", "spatial", "sch-objects", "hierarchy", "board-shape", "board-shape-sources", "stackup", "impedance", "pcb-pours", "pcb-appearance", "zip", "vectorize",
  "pcb-text-rich", "pcb-text", "rigid-flex", "altium-rules", "pcb-draw", "component-classes", "rules", "viastack", "polygon-pour", "import-link", "source-file", "sch-import", "pcb-import",
  "io", "connectivity", "bom", "fab-outputs"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
require("../pcb/dense-board.js");
const A = Atrium, F = AtriumFabOutputs, DIR = path.join(__dirname, "../goldens/fab"), EMIT = process.argv.includes("--emit");
const DATE = new Date(Date.UTC(2026, 5, 15, 12));

// ISO date-times (with or without a zone), bare ISO dates, and the Altium-style
// pick-and-place header's "Date: dd/mm/yy" and "Time: hh:mm" lines.
const normalise = text => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, "<date>").replace(/\b\d{4}-\d\d-\d\d\b/g, "<date>")
  .replace(/^(Date:\s*)\d\d\/\d\d\/\d\d(\d\d)?/gm, "$1<date>").replace(/^(Time:\s*)\d\d:\d\d(:\d\d)?/gm, "$1<time>");
const sha = text => AtriumSourceFile.sha256(new TextEncoder().encode(text));
const boards = {
  sample() { const p = AtriumParts.example(); return {p, doc: p.documents.find(d => d.kind === "pcb")}; },
  dense() { const {d, defs} = makeAtriumBenchmarkBoard(160), p = A.project("Dense"); p.documents = [d]; p.library = [...defs.values()]; return {p, doc: d}; },
  pidp11() {
    const fix = path.join(__dirname, "../fixtures/altium/pidp11-io-expander"), p = A.project("PiDP-11 I/O Expander");
    p.documents = []; p.library = [];
    for (const name of ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"]) {
      const r = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(fix, name))));
      p.documents.push(...(r.documents || [])); p.library.push(...(r.library || []));
    }
    AtriumImportLink.reconcile(p, p.documents); A.validate(p);
    return {p, doc: p.documents.find(d => d.kind === "pcb")};
  }};
// Verify the 1 nm legend grid against source integers independently of the PCB importer.
// Arcs6 records 0–2 belong to D1, U1 and U2. Texts6 record 63 is the mirrored, bottom-left
// project title. These offsets are inside the named streams of the pinned Rev A binary.
function checkLegendPrecision(files) {
  const fixture = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
  const bytes = fs.readFileSync(path.join(fixture, "PiDP11IOExpander.PcbDoc"));
  assert.equal(AtriumSourceFile.sha256(bytes), "1ff7234670ec5e20092d23ecf0cd5e7380e842ef7efff2b5cb992f53f84c9c69");
  const source = AtriumSourceFile.open(bytes), parse = require("./gerber-compare.cjs").parseGerber;
  const view = name => { const data = source.read(name + "/Data"); return new DataView(data.buffer, data.byteOffset, data.byteLength); };
  const arcs = view("Arcs6"), texts = view("Texts6"), title = 16821;
  const widths = [5, 70, 135].map(start => arcs.getInt32(start + 41, true));
  assert.deepEqual(widths, [98425, 98425, 98425]);
  const anchor = texts.getInt32(title + 248, true), height = texts.getInt32(title + 128, true), pen = texts.getInt32(title + 36, true);
  assert.deepEqual([anchor, height, pen], [1100000, 433225, 50000]);
  // The upper stroke centre is one pen inside the native layout rectangle. Each tick is 127/50 nm.
  // The Gerber writer uses toFixed for apertures and Math.round for coordinates. On positive
  // exact half steps both select the larger integer (ECMA-262 §§21.1.3.3 and 21.3.2.29).
  function verify(read, gridNm) {
    const plottedNm = ticks => Math.floor((ticks * 127 + 25 * gridNm) / (50 * gridNm)) * gridNm;
    const toNm = mm => Math.round(mm * 1e6);
    const circles = parse(read("GTO")).draws.filter(s => s.arc);
    assert.deepEqual(circles.map(s => toNm(s.width)), widths.map(plottedNm), "native circle pens at the film resolution");
    const row = parse(read("GBO")).draws.filter(s => s.points.every(p => p[1] > 2.8 && p[1] < 4.1));
    const upper = Math.max(...row.flatMap(s => s.points.map(p => p[1])));
    assert.equal(toNm(upper), plottedNm(anchor + height - pen), "native title stroke centre at the film resolution");
  }
  verify(ext => files.find(f => f.name.endsWith("." + ext)).content, 1);
  verify(ext => fs.readFileSync(path.join(fixture, "altium-outputs-reva", "PiDP11IOExpander." + ext), "utf8"), 254);
}
const FULL_TEXT = new Set(["sample"]);
const manifest = {}, texts = {};
for (const [board, make] of Object.entries(boards)) {
  const {p, doc} = make(), out = F.build(p, doc.id, {date: DATE});
  if (board === "pidp11") checkLegendPrecision(out.files);
  manifest[board] = {};
  for (const f of out.files) {
    const text = normalise(f.content);
    // The D1, U1 and U2 footprints in the PiDP-11 source each have a complete
    // circular silkscreen mark with a 0.12500102 mm radius.
    if (board === "pidp11" && f.name.endsWith(".GTO")) {
      const circles = text.match(/X(-?\d+)Y(-?\d+)D02\*\r?\nG03X\1Y\2I-125001J0D01\*/g) || [];
      assert.equal(circles.length, 3, "each mark is one full Gerber circle at its source radius");
    }
    if (board === "pidp11" && f.name.endsWith("-Assembly-Top.svg")) {
      const circles = text.match(/<path d="M([-\d.]+ [-\d.]+)A0\.125 0\.125 0 0 0 [-\d.]+ [-\d.]+A0\.125 0\.125 0 0 0 \1"/g) || [];
      assert.equal(circles.length, 3, "the SVG closes each circle with two half-arcs");
    }
    manifest[board][f.name] = {sha256: sha(text), bytes: text.length, lines: text.split("\n").length};
    if (FULL_TEXT.has(board)) texts[board + "/" + f.name] = text;
  }
}
if (EMIT) {
  // scripts/update-goldens.sh splits this into files.
  console.log("@@@FILE manifest.json"); console.log(JSON.stringify(manifest, null, 1)); console.log("@@@END");
  for (const [name, text] of Object.entries(texts)) { console.log("@@@FILE " + name); console.log(text); console.log("@@@END"); }
} else {
  const golden = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8")), problems = [];
  for (const board of Object.keys(boards)) {
    const want = golden[board] || {}, got = manifest[board];
    for (const name of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (!want[name]) { problems.push(board + ": new output " + name); continue; }
      if (!got[name]) { problems.push(board + ": output no longer written: " + name); continue; }
      if (want[name].sha256 === got[name].sha256) continue;
      let detail = " (" + want[name].bytes + " -> " + got[name].bytes + " bytes)";
      const key = board + "/" + name;
      if (texts[key] != null) {
        // The first differing line, so the change is visible without running the update.
        const old = fs.readFileSync(path.join(DIR, board, name), "utf8").split("\n"), now = texts[key].split("\n");
        const i = now.findIndex((l, k) => l !== old[k]);
        detail += i < 0 && now.length === old.length ? ", same text as goldens/fab/" + key + " (manifest hash out of date)"
          : ", line " + (i < 0 ? old.length + 1 : i + 1) + ": " + JSON.stringify((old[i < 0 ? old.length : i] ?? "").slice(0, 80)) + " -> " + JSON.stringify((now[i < 0 ? old.length : i] ?? "").slice(0, 80));
      }
      problems.push(board + ": " + name + " changed" + detail);
    }
  }
  assert.deepEqual(problems, [], "Fabrication outputs differ from tests/goldens/fab. If the change is intended, run scripts/update-goldens.sh and review the diff:\n  " + problems.join("\n  "));
  console.log("fab-golden: " + Object.entries(manifest).map(([b, m]) => b + " " + Object.keys(m).length + " files").join(", ") + " match tests/goldens/fab");
}
