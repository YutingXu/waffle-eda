// Real Altium Designer project fixture: imports a binary SchDoc + PcbDoc + PrjPcb from an
// open-source design and compares an import report with a snapshot. The report records what
// was imported (parts, pins, nets, wires, labels, tracks, vias, pours, pads, outline) and what
// was not (the importer's notes: omitted records, approximations), so a regression in either
// direction shows up as a diff.
//
// Fixture: tests/fixtures/altium/pidp11-io-expander/ (PiDP-11 I/O Expander by Steven Stallion,
// https://github.com/sstallion/PCB-PiDP11IOExpander at d97b8164, BSD-2-Clause; see its NOTICE
// and LICENSE). The files are unmodified.
//
// Run: scripts/test-jsc.sh import-altium-real   (or node tests/formats/import-altium-real.cjs)
//      add --print to print the current report (to refresh the snapshot after a deliberate change).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "polygon-pour", "import-link", "source-file", "sch-import",
  "altium-rules", "pcb-pours", "pcb-import", "io", "connectivity", "rules", "drc"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, DIR = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
const FILES = ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"];
const bytes = name => new Uint8Array(fs.readFileSync(path.join(DIR, name)));

// ---------------------------------------------------------------- import (as File › Import › Altium)
const read = FILES.map(name => ({name, r: AtriumIO.read(name, bytes(name))}));
const manifest = read.find(x => x.r.manifest)?.r.manifest;
const p = A.project("PiDP-11 I/O Expander"); p.documents = []; p.library = []; p.importNotes = [];
for (const {r} of read) { p.documents.push(...(r.documents || [])); p.library.push(...(r.library || [])); p.importNotes.push(...(r.notes || [])); }
if (globalThis.AtriumImportLink) AtriumImportLink.reconcile(p, p.documents);
A.validate(p);
const defs = new Map(p.library.map(d => [d.id, d]));
const sch = p.documents.find(d => d.kind === "schematic"), pcb = p.documents.find(d => d.kind === "pcb");
assert.ok(sch && pcb, "the project has one schematic and one board");
assert.equal(pcb.sourceRuleChecks.kinds.length,pcb.sourceRules.length);
assert.ok(pcb.sourceRuleChecks.batch.includes(2)&&!pcb.sourceRuleChecks.batch.includes(11));
assert.ok(pcb.sourceRuleChecks.online.includes(11));
assert.equal(pcb.ruleCheckSelection,undefined,"reading a source board retains its check selection for adoption");

// ---------------------------------------------------------------- report
const count = (d, k) => d.items.filter(i => i.kind === k).length;
const kinds = d => Object.fromEntries(Object.entries(d.items.reduce((m, i) => (m[i.kind] = (m[i.kind] || 0) + 1, m), {})).sort());
function schematicReport(d) {
  const cn = A.connectivity(d, defs);
  let pins = 0, pinsOnNets = 0;
  for (const i of d.items) if (i.kind === "part") for (const pin of A.pins(i, defs.get(i.def), "schematic")) { pins++; if (cn.byPin.has(i.id + "/" + pin.number)) pinsOnNets++; }
  return {name: d.name, kinds: kinds(d), parts: count(d, "part"), pins, pinsOnNets, nets: cn.nets.length, namedNets: cn.nets.filter(n => !/^Net(-|[A-Z]+\d+_)/.test(n.name)).length, // not automatic names (Net-U1-7, Altium NetC1_2)
    conflicts: cn.nets.filter(n => n.conflict).length, sha256: d.sourceSha256 || null};
}
function boardReport(d) {
  let pads = 0; const padNets = new Set();
  for (const i of d.items) if (i.kind === "part") { pads += defs.get(i.def)?.footprint?.pads?.length || 0; for (const v of Object.values(i.pinNets || {})) if (v) padNets.add(v); }
  const nets = new Set([...d.items.map(i => i.net).filter(Boolean), ...padNets]);
  return {name: d.name, kinds: kinds(d), parts: count(d, "part"), bottomParts: d.items.filter(i => i.kind === "part" && i.side === "bottom" || i.layer === "Bottom" && i.kind === "part").length,
    pads, nets: nets.size, tracks: count(d, "track"), arcs: d.items.filter(i => A.pathArc(i)).length + d.items.filter(i => i.kind === "part").reduce((n, i) => n + defs.get(i.def).footprint.shapes.filter(s => A.pathArc(s)).length, 0), vias: count(d, "via"), pours: count(d, "polygon"), storedPours: (d.pcbDrawing?.pours || []).length,
    outlineVertices: Array.isArray(d.outline) ? d.outline.length : 0, layers: [...new Set(d.items.map(i => i.layer).filter(Boolean))].sort(), layerNames: d.layerNames || null,
    sourceRules: (d.sourceRules || []).length, sha256: d.sourceSha256 || null};
}
// Notes say what was not imported or was approximated. Numbers inside them are kept, so a change
// in how much is dropped shows up too.
const notes = [...new Set(p.importNotes)].sort();
// Connectivity with the imported pours (their stored fill, linked on first inspection) and without them.
function unrouted(d) {
  const c = AtriumConnectivity.inspect(d, defs);
  return {airwires: c.airwires.length, shorts: c.shorts.length, nets: c.nets.filter(n => n.missing).map(n => n.name + ":" + n.missing).sort()};
}
const bare = A.clone(pcb); delete bare.pcbDrawing; delete bare.sourcePourSignature; bare.items = bare.items.filter(i => i.kind !== "polygon");
assert.ok(AtriumPolygonPour.adopt(pcb,defs,{project:p},false));
const connectivity = {withoutPours: unrouted(bare).airwires, state: AtriumPolygonPour.state(pcb, defs), ...unrouted(pcb),
  links: pcb.pcbDrawing.pours.map(r => r.links.length)};
const report = {
  manifest: manifest ? manifest.paths.slice().sort() : null,
  library: p.library.length,
  schematic: schematicReport(sch),
  board: boardReport(pcb),
  connectivity,
  warnings: notes.length,
  notes,
};
if (process.argv.includes("--print")) { console.log(JSON.stringify(report, null, 2)); }

// ---------------------------------------------------------------- snapshot
const SNAPSHOT = {
  "manifest": ["PiDP11IOExpander.PcbDoc", "PiDP11IOExpander.SchDoc"],
  "library": 38,
  "schematic": {
    "name": "PiDP11IOExpander",
    "kinds": {"graphic":3, "junction":16, "label":3, "netlabel":74, "noerc":1, "part":23, "textframe":1, "wire":69},
    "parts": 23,
    "pins": 96,
    "pinsOnNets": 95,
    "nets": 30,
    "namedNets": 28,
    "conflicts": 0,
    "sha256": "8555c4ece52cebd911b6152bd211d4e8b7dc59f003fc5a031e1c7d525ff4325d"
  },
  "board": {
    "name": "PiDP11IOExpander",
    "kinds": {"graphic":24, "label":19, "pad":4, "part":23, "polygon":2, "track":194, "via":59},
    "parts": 23,
    "bottomParts": 0,
    "pads": 96,
    "nets": 30,
    "tracks": 194,
    "arcs": 3,
    "vias": 59,
    "pours": 2,
    "storedPours": 5,
    "outlineVertices": 5,
    "layers": ["Bottom", "Bottom silk", "Mechanical 1", "Multi", "Silk", "Top"],
    "layerNames": {"Mechanical 1":"Board Shape", "Mechanical 2":"Top Assembly", "Mechanical 4":"Top Courtyard"},
    "sourceRules": 41,
    "sha256": "1ff7234670ec5e20092d23ecf0cd5e7380e842ef7efff2b5cb992f53f84c9c69"
  },
  "connectivity": {
    "withoutPours": 48,
    "state": "source",
    "airwires": 2,
    "shorts": 0,
    "nets": ["GP0.3:1", "VCC_3V3:1"],
    "links": [2, 3, 32, 1, 46]
  },
  "warnings": 21,
  "notes": [
    "19 free region(s) imported as filled shapes (Bottom 1, Silk 18).",
    "2 polygon pours imported as editable Waffle pours (outline, net, pour order, island removal). Clearance and connect style come from the design rules.",
    "2 pours set Altium's Remove Necks option; a repour removes the necks narrower than its width.",
    "24 paired region record(s) reconciled with their shape-based contours.",
    "5 stored polygon fill region(s) kept as the pours' current copper. They count for connectivity until a repour regenerates them.",
    "Imported 3D bodies (0 extruded, 23 STEP references).",
    "Kept 1 net class (signals and tags).",
    "Kept 4 component classes. 4 of them follow component placement in Altium; Waffle keeps their members from the import.",
    "Omitted 2 × template images, 1 × template text frames, 2 × embedded images.",
    "Omitted advanced placer options6 (1).",
    "Omitted boardregions (1).",
    "Omitted constraintmanager (1).",
    "Omitted embeddedfonts6 (1).",
    "Omitted fileversioninfo (1).",
    "Omitted layerkindmapping (1).",
    "Omitted pin swap options6 (1).",
    "Omitted unionnames (1).",
    "Omitted uniqueidprimitiveinformation (100).",
    "Omitted waivedviolations (15).",
    "Omitted widestrings6 (65).",
    "PCB import includes 3D bodies. Layer-specific pad stacks, pours and manufacturing settings require review in the source design."
  ]
};
assert.deepEqual(report, SNAPSHOT);

// ---------------------------------------------------------------- cross-checks independent of the snapshot
// The source hashes match the NOTICE (the fixture is unmodified and binary OLE).
assert.equal(sch.sourceSha256, "8555c4ece52cebd911b6152bd211d4e8b7dc59f003fc5a031e1c7d525ff4325d");
assert.equal(pcb.sourceSha256, "1ff7234670ec5e20092d23ecf0cd5e7380e842ef7efff2b5cb992f53f84c9c69");
const stacked = pcb.items.flatMap(i => i.kind === "part" ? defs.get(i.def).footprint.pads : [i]).filter(p => p.stackMode === "tmb");
assert.equal(stacked.length, 32, "all Top/Middle/Bottom pad stacks remain editable");
for (const pad of stacked) {
  assert.deepEqual(pad.padStack.Top, pad.padStack.Mid);
  assert.deepEqual(pad.padStack.Top, pad.padStack.Bottom);
}
// The schematic Note record keeps its authored paragraphs as an editable frame.
const importedNote = sch.items.find(i => i.kind === "textframe" && i.note === true);
assert.equal(importedNote?.text, ["Single board operation is assumed by default.",
  "Multiple boards may be connected in series via J2, however one or more address jumpers (A0, A1, A2) must be fitted to avoid I²C bus conflicts.",
  "R2 and R3 may also be fitted to assist the 1.8K pull-up resistors provided by  the Raspberry Pi."].join("\n\n"));
// Every board part has a schematic part with the same designator (the ECO link a real project needs).
const schRefs = new Set(sch.items.filter(i => i.kind === "part").map(i => i.ref));
const unmatched = pcb.items.filter(i => i.kind === "part" && !schRefs.has(i.ref)).map(i => i.ref);
assert.ok(unmatched.length <= 2, "board parts without a schematic part: " + unmatched.join(", "));
// The imported pours are real polygon pours: outline, net GND, Altium pour order and island threshold.
const pours = pcb.items.filter(i => i.kind === "polygon").sort((a, b) => a.pourIndex - b.pourIndex);
assert.deepEqual(pours.map(q => [q.name, q.layer, q.net, q.pourIndex, q.pourOverSameNet, q.removeDeadCopper]),
  [["GND_TOP", "Top", "GND", 0, false, true], ["GND_BOTTOM", "Bottom", "GND", 1, false, true]]);
assert.ok(pours.every(q => AtriumPolygonPour.validate(q) && Math.abs(q.islandAreaThreshold - 1.6129) < 1e-4 && Math.abs(q.minPrimLength - .0762) < 1e-9));
assert.deepEqual(AtriumPolygonPour.stale(pcb, defs), [], "the stored fill is current for the imported board");
// The two connections left are stub tracks lying wholly inside a pad's drill hole: drilled away, so
// Waffle's connectivity (unlike Altium's) does not count them as touching the pad.
for (const a of AtriumConnectivity.inspect(pcb, defs).airwires) {
  const ends = [[a.fromId, a.fromLabel], [a.toId, a.toLabel]], pad = ends.find(([id]) => pcb.items.find(i => i.id === id)?.kind === "part");
  const t = pcb.items.find(i => i.id === ends.find(e => e !== pad)[0]), part = pcb.items.find(i => i.id === pad[0]), ref = pad[1].split(".");
  const land = defs.get(part.def).footprint.pads.find(q => q.number === ref[1]), c = A.world([land.x, land.y], part);
  assert.ok(t.kind === "track" && t.points.every(q => Math.hypot(q[0] - c[0], q[1] - c[1]) + t.width / 2 < land.drill / 2), a.net + ": stub inside the drill of " + pad[1]);
}
// A repour regenerates the fill with Waffle's engine and keeps the same connectivity.
const repoured = A.clone(pcb), result = AtriumPolygonPour.apply(repoured, defs);
assert.ok(result.regions.length > 0 && repoured.pcbDrawing.pours.every(r => r.polygon != null));
assert.equal(AtriumConnectivity.inspect(repoured, defs).airwires.length, 2);
console.log("PASS real Altium project (PiDP-11 I/O Expander): " + report.schematic.parts + " schematic parts, " + report.board.parts + " board parts, " +
  report.board.nets + " nets, " + report.board.tracks + " tracks, " + report.board.vias + " vias, " + report.board.pours + " editable pours (" + report.board.storedPours + " stored fill regions), unrouted " + report.connectivity.withoutPours + " -> " + report.connectivity.airwires + ", " + report.warnings + " notes");
