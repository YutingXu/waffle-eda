"use strict";
// Pour oracle: Waffle's repour of public boards against the copper their source tool stored (Altium's
// polygon fill, KiCad's filled_polygon), pour by pour. The other pour suites compare the engine with
// itself (its DRC, a golden it recorded); here the reference is another tool's output.
//
// Each board is imported as File › Import does, under its own rules, its stored fill kept aside before
// anything repours; then a full repour is compared with it (tests/support/pour-oracle.cjs):
//   area         |repoured - stored| / stored
//   slivers      XOR islands no wider (2·area/perimeter) than the pour's arc approximation + 2 µm, as a
//                share of the stored copper. Altium tessellates each clearance circle as a circumscribed
//                regular polygon of 8k sides (k the smallest that keeps R·(1/cos(π/n) − 1) within the Arc
//                Approximation), so its straight clearances stand that much (4-14 µm here) farther out;
//                Waffle keeps true arcs and exact straight clearances. KiCad's own arc error is similar.
//   significant  the wider XOR islands not on the allowlist (mm²): these are objects, not offsets
//   deviation    the largest vertex distance between the two boundaries (mm)
// The allowlist names the lands near known, explained deviations, each with an area budget so an
// explained deviation cannot grow unnoticed. Altium copper outside the board shape is reported apart:
// Waffle clips a pour to the board shape (Altium pours to the polygon outline and leaves the board edge
// to its Board Outline Clearance rule).
//
// Run: node tests/formats/pour-oracle.cjs [--corpus | --require-corpus] [--report]
//   --corpus  also the verified public corpus in the fidelity cache (tests/altium-fidelity/fetch.py;
//             $XDG_CACHE_HOME or ~/.cache /waffle/altium-fidelity), when present. Or WAFFLE_POUR_CORPUS=1.
//   --require-corpus  as --corpus, and fail unless every corpus board is in the cache (CI, after
//             tests/e2e/run.py --fetch).
//   --report  print every pour's numbers and its widest islands.
// Test boards stay outside the checkout: only PiDP-11, already a fixture, runs without the corpus.
// SNES-Tap is the corpus board that exercises thermal reliefs with dead copper kept.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const O = require("../support/pour-oracle.cjs");
const argv = typeof process !== "undefined" ? process.argv.slice(2) : [];
const env = typeof process !== "undefined" && process.env || {};
const REPORT = argv.includes("--report"), REQUIRE = argv.includes("--require-corpus");
const CORPUS = REQUIRE || argv.includes("--corpus") || !!env.WAFFLE_POUR_CORPUS;
const FIX = path.join(__dirname, "../fixtures");

// limits: per pour. allow: lands (part ref and pad numbers, or a free pad's number) whose wide islands,
// centred within `grow` mm of the land, are explained; `budget` bounds their area per board (mm²).
const BOARDS = [
  {id: "pidp11-io-expander", dir: path.join(FIX, "altium/pidp11-io-expander"), files: ["PiDP11IOExpander.PcbDoc"],
    limits: {area: .5, slivers: .6, significant: .4, deviation: .25}, allow: []},
];
// The public corpus (licences in tests/altium-fidelity/fixtures.json and tests/e2e/corpus.json). Its
// KiCad boards carry deviations of KiCad's own fill model that the import does not map yet: a land's
// local clearance (oneincheye's mounting holes keep 1.4 mm), 45° spokes on round lands (each land's
// thermal_bridge_angle), zones inside footprints, and KiCad's relief shapes; their limits say so.
const CACHE = path.join(env.XDG_CACHE_HOME || path.join(env.HOME || "", ".cache"), "waffle/altium-fidelity");
const CORPUS_BOARDS = [
  {id: "snes-tap", rev: "077a5c6763dcb347dad2b30f85d84aebaf9b1488", files: ["maxout_conn.PcbDoc"],
    limits: {area: .6, slivers: .7, significant: .5, deviation: .25},
    allow: [{ref: "U3", pads: ["2"], grow: .6, budget: .3,
      reason: "Altium draws one spoke, Waffle two: the second spoke's end meets the copper only along its centre line, where Altium's tessellated clearance is a few µm wider"}]},
  {id: "ds4-type-c-001", rev: "ea4fb99778ea226f78e109af980c7838af0d62cb", files: ["001-v2.kicad_pcb", "001-v2.kicad_pro"],
    limits: {area: 2, slivers: .4, significant: 1.5, deviation: 1},
    allow: [
      {ref: "J1", pads: ["S1"], grow: 1.2, budget: 8,
        reason: "KiCad's relief around an oval slotted land follows the land outline and starts its spokes at the land edge; Waffle's reliefs are Altium's (spokes from the centre, gap from the land's core)"},
      {ref: "J2", pads: ["1", "2", "4"], grow: .8, budget: 3.5,
        reason: "fine-pitch same-net lands: KiCad keeps each land's own relief where Waffle's spokes meet the neighbouring same-net land"}]},
  {id: "midas-communication", rev: "2ffc166dc3783158e0b00906e13b2d650d676887", files: ["Communication.PcbDoc"],
    limits: {area: .5, slivers: .5, significant: .6, deviation: .3}, allow: []},
  {id: "cm4-5-shim", rev: "e6177f6c34380cf98977ed652572ec0b436b5b6f", files: ["CM5_Adapter.PcbDoc"],
    limits: {area: .5, slivers: .5, significant: 1.5, deviation: 1.5}, allow: []},
  {id: "esp32c3-haptic", rev: "b4e8dbe455286089c4bbfbf0b1348886112ec994", files: ["ESP32-C3_V1.PcbDoc"],
    limits: {area: .5, slivers: .5, significant: .1, deviation: .1}, allow: []},
  {id: "garganturam", rev: "7d48745b4b1027b681f03a2f810d2202c69f7508", files: ["MainBoard_6_layers.PcbDoc"],
    limits: {area: .5, slivers: .4, significant: 30, deviation: 5}, outside: 1600,
    allow: [{pad: "12", grow: 3, budget: 45,
      reason: "unexplained: Altium's fill covers this 5 mm mounting land whole (direct) though its only Polygon Connect rule is a relief"}]},
  {id: "nanocomp", rev: "b32047d792edc6d4d71bbbbef758ab545becbcf4", files: ["nanoComp.kicad_pcb", "nanoComp.kicad_pro"],
    limits: {area: 1, slivers: .2, significant: 100, deviation: 1.6}, allow: []},
  {id: "oneincheye", rev: "95fd695905b14ef6db79789743de0b3649cbbc88", files: ["OneInchEye.kicad_pcb", "OneInchEye.kicad_pro"],
    limits: {area: 15, slivers: .8, significant: 80, deviation: 3.5}, allow: []},
];

function lands(board, defs) {
  const out = [];
  for (const i of board.items) {
    if (i.kind === "pad") out.push({ref: "", number: String(i.number ?? ""), at: [i.x, i.y], r: Math.max(+i.w || 0, +i.h || 0) / 2});
    else if (i.kind === "part") for (const p of defs.get(i.def)?.footprint?.pads || [])
      out.push({ref: i.ref || "", number: String(p.number ?? ""), at: Atrium.world([p.x, p.y], i), r: Math.max(+p.w || +p.diameter || 0, +p.h || +p.diameter || 0) / 2});
  }
  return out;
}
function check(spec) {
  const loaded = O.load(spec.files.map(name => ({name, bytes: new Uint8Array(fs.readFileSync(path.join(spec.dir, name)))})));
  const poured = O.repour(loaded), all = lands(loaded.board, loaded.defs), L = spec.limits, used = spec.allow.map(() => 0);
  const allowed = isl => spec.allow.findIndex(a => all.some(l => (a.pad != null ? !l.ref && l.number === a.pad : l.ref === a.ref && a.pads.includes(l.number)) &&
    Math.hypot(isl.at[0] - l.at[0], isl.at[1] - l.at[1]) <= l.r + a.grow));
  const nearest = isl => { let best = null; for (const l of all) { const d = Math.hypot(isl.at[0] - l.at[0], isl.at[1] - l.at[1]) - l.r; if (!best || d < best.d) best = {d, l}; } return best ? (best.l.ref || "pad") + "." + best.l.number : "-"; };
  let pours = 0, outside = 0;
  for (const polygon of loaded.board.items.filter(i => i.kind === "polygon" && !i.cutout && !i.shelved)) {
    const r = O.compare(loaded.stored, poured, {tol: O.settings(polygon).arcApproximation + .002, board: loaded.board.outline, polygon});
    const label = spec.id + " " + r.pour + " (" + r.layer + ")";
    if (r.skipped) { if (REPORT) console.log("  " + label + ": " + r.skipped); continue; }
    pours++; outside += r.outside;
    const pct = v => v / r.stored * 100, significant = [];
    for (const isl of r.islands) { const k = allowed(isl); if (k >= 0) used[k] += isl.area; else significant.push(isl); }
    const sig = significant.reduce((s, i) => s + i.area, 0);
    if (REPORT) {
      console.log("  " + label + ": stored " + r.stored.toFixed(2) + " mm², area " + pct(r.poured - r.stored).toFixed(3) + "%, slivers " + pct(r.slivers).toFixed(3) +
        "%, significant " + sig.toFixed(3) + " mm² (" + significant.length + "), deviation " + r.maxDeviation.toFixed(3) + " mm, outside " + r.outside.toFixed(2) + " mm²");
      for (const i of significant.slice(0, 5)) console.log("      " + i.sign + " " + i.area.toFixed(4) + " mm² wide " + i.width.toFixed(3) + " at " + i.at.map(v => v.toFixed(3)) + " near " + nearest(i));
    }
    const where = significant.slice(0, 3).map(i => i.sign + " " + i.area.toFixed(3) + " mm² at " + i.at.map(v => v.toFixed(2)) + " near " + nearest(i)).join("; ");
    assert.ok(Math.abs(pct(r.poured - r.stored)) <= L.area, label + ": copper differs by " + pct(r.poured - r.stored).toFixed(3) + "% (limit " + L.area + "%)");
    assert.ok(pct(r.slivers) <= L.slivers, label + ": slivers " + pct(r.slivers).toFixed(3) + "% (limit " + L.slivers + "%)");
    assert.ok(sig <= L.significant, label + ": " + sig.toFixed(3) + " mm² of deviations wider than the tessellation (limit " + L.significant + " mm²): " + where);
    assert.ok(r.maxDeviation <= L.deviation, label + ": boundary deviation " + r.maxDeviation.toFixed(3) + " mm (limit " + L.deviation + " mm)");
  }
  assert.ok(pours > 0, spec.id + ": no pour with stored fill");
  if (REPORT) spec.allow.forEach((a, k) => console.log("  " + spec.id + " allowed near " + (a.ref ? a.ref + "." + a.pads.join("/") : "pad " + a.pad) + ": " + used[k].toFixed(3) + " mm² (budget " + a.budget + ")"));
  spec.allow.forEach((a, k) => assert.ok(used[k] <= a.budget, spec.id + ": the deviation near " + (a.ref ? a.ref + "." + a.pads.join("/") : "pad " + a.pad) +
    " grew to " + used[k].toFixed(3) + " mm² (budget " + a.budget + " mm²; " + a.reason + ")"));
  assert.ok(outside <= (spec.outside || 0) + .01, spec.id + ": " + outside.toFixed(2) + " mm² of the stored fill lies outside the board shape");
  return pours;
}

let pours = 0, boards = 0;
for (const spec of BOARDS) { pours += check(spec); boards++; }
let corpus = "skipped (pass --corpus)";
if (CORPUS) {
  let found = 0;
  for (const spec of CORPUS_BOARDS) {
    const dir = path.join(CACHE, spec.id, spec.rev);
    if (!spec.files.every(f => fs.existsSync(path.join(dir, f)))) continue;
    pours += check({...spec, dir}); boards++; found++;
  }
  corpus = found + " of " + CORPUS_BOARDS.length + " corpus boards found in " + CACHE;
  assert.ok(!REQUIRE || found === CORPUS_BOARDS.length, "pour oracle: " + corpus + " (fetch them with python3 tests/e2e/run.py --fetch)");
}
console.log("PASS pour oracle: " + pours + " pours on " + boards + " boards repoured against their stored fill; corpus " + corpus);
