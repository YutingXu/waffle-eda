"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {nativeRoundTrip} = require("../support/native-cad.cjs");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "source-file", "pcb-import", "io", "pcb-appearance", "pcb-draw", "fab-outputs", "altium-export", "output-jobs"]) {
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
}
const {parseGerber, parseExcellon} = require("./gerber-compare.cjs");
const F = AtriumFabOutputs, date = new Date("2026-01-01T00:00:00Z");

const perimeter = "|VX0=12mm|VY0=16mm|VX1=35mm|VY1=16mm|VX2=35mm|VY2=29mm|VX3=12mm|VY3=29mm";
const originFields = "|ORIGINX=400mil|ORIGINY=15mm";
const text = fields => [
  "|RECORD=Board" + perimeter + fields,
  "|RECORD=Component|ID=0|SOURCEDESIGNATOR=J1|PATTERN=Connector|X=20mm|Y=25mm|LAYER=TOP",
  "|RECORD=Pad|COMPONENT=0|NAME=1|X=20mm|Y=25mm|LAYER=MULTILAYER|XSIZE=2mm|YSIZE=2mm|HOLESIZE=1mm|SHAPE=ROUND",
].join("\r\n");
const ascii = fields => AtriumIO.read("Origin.PcbDoc", new TextEncoder().encode(text(fields)));

const {documents: [board], library} = ascii(originFields);
assert.deepEqual(board.origin, [10.16, -15], "uses the source's separate relative origin and flips Y");
assert.deepEqual(board.outline, [[12, -16], [35, -16], [35, -29], [12, -29]]);
assert.deepEqual([board.items[0].x, board.items[0].y], [20, -25], "the origin does not move placement geometry");

const record = new TextEncoder().encode(perimeter + originFields + "\0");
const stream = new Uint8Array(4 + record.length);
new DataView(stream.buffer).setUint32(0, record.length, true);
stream.set(record, 4);
assert.deepEqual(AtriumPCB.read("Binary.PcbDoc", new Map([["board6/data", stream]]), null).documents[0].origin, board.origin);
const pi = path.join(__dirname, "../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc");
assert.deepEqual(AtriumIO.read("PiDP11IOExpander.PcbDoc", new Uint8Array(fs.readFileSync(pi))).documents[0].origin, [0, 0], "an explicit zero remains a datum");

for (const fields of ["", "|ORIGINX=400mil", "|ORIGINX=400mil|ORIGINY=bad", "|ORIGINX=1e309mm|ORIGINY=1mm"]) {
  assert.equal(ascii(fields).documents[0].origin, undefined, "an incomplete or unreadable pair supplies no datum");
}

const project = Atrium.validate({...Atrium.project("Origin", library), documents: [board]});
function points(result) {
  const gerber = ext => parseGerber(result.files.find(f => f.name.endsWith(ext)).content);
  const drills = parseExcellon(result.files.find(f => f.kind === "drill").content).hits;
  const pnp = result.files.find(f => f.kind === "pnp").content.split(/\r?\n/).find(line => line.startsWith('"J1",'));
  assert.ok(pnp, "placement row");
  return [
    ...[".GTL", ".GBL", ".GTS", ".GBS"].map(ext => gerber(ext).flashes.map(({x, y}) => [x, y])),
    drills.map(({x, y}) => [x, y]),
    [pnp.split(",").slice(4, 6).map(s => Number(JSON.parse(s)))],
  ];
}
function verify(p, d, origin, point, tolerance = 0) {
  const coordinates = points(F.build(p, d.id, {origin, date}));
  for (const rows of coordinates) {
    assert.equal(rows.length, 1);
    assert.ok(rows[0].every((v, axis) => Math.abs(v - point[axis]) <= tolerance), origin + " frame " + rows[0] + " expected " + point);
  }
}
verify(project, board, "auto", [9.84, 10]);
verify(project, board, "user", [9.84, 10]);
verify(project, board, "outline", [8, 9]);
verify(project, board, "absolute", [20, 25]);

const saved = JSON.stringify(project);
function roundTrip(source) {
  const [d] = source.documents, written = AtriumAltiumExport.exportBoard(source, d);
  const recovered = AtriumIO.read(written.name, written.bytes);
  const [r] = recovered.documents, reimported = {...Atrium.project("Reimported", recovered.library), documents: [r]};
  // The ASCII writer quantizes both placement and relative origin to 1/10000 mil.
  verify(reimported, r, "auto", [9.84, 10], .00000304);
  return written.offset;
}
assert.ok(roundTrip(project).every(v => v === 0), "positive Altium workspace coordinates are stable");
assert.equal(JSON.stringify(project), saved, "export leaves the active project's origin intact");

const moved = JSON.parse(saved), [movedBoard] = moved.documents;
const move = ([x, y]) => [x - 30, y + 45];
movedBoard.outline = movedBoard.outline.map(move);
movedBoard.origin = move(movedBoard.origin);
for (const i of movedBoard.items) [i.x, i.y] = move([i.x, i.y]);
assert.ok(roundTrip(moved).every(v => v !== 0), "an export shift moves both geometry and its datum");

const historical = JSON.parse(saved);
delete historical.documents[0].origin;
const native = nativeRoundTrip(historical);
verify(native, native.documents[0], "auto", [8, 9]);

// The override belongs to the output request. Two boards with distinct datums
// can make mixed-frame and shared-frame packages without affecting each other.
const multiple = JSON.parse(saved), first = multiple.documents[0];
first.items.push({id: "tooling", kind: "pad", layer: "Multi", number: "", net: "", x: 24, y: -22, w: 1.8, h: 1.8,
  shape: "round", drill: 1.8, plated: false});
const second = Atrium.sheet("pcb", "Second");
second.origin = [28, -20];
second.outline = [[29, -21], [40, -21], [40, -30], [29, -30]];
second.items.push({id: "via", kind: "via", layer: "Multi", x: 31, y: -25, diameter: .75, drill: .35, net: "GND"});
multiple.documents.push(second);

const common = {date, origin: "auto"};
const byKind = (files, kind) => files.filter(f => f.kind === kind);
const viewDrills = files => byKind(files, "drill").map(f => ({
  name: f.name, ...parseExcellon(f.content), stats: f.stats,
}));
const plot = F.build(multiple, first.id, common);
const mixed = F.build(multiple, first.id, {...common, drillOrigin: "absolute"});
assert.deepEqual(F.drillOriginFor(mixed.model, mixed.options), [0, 0]);
assert.deepEqual(F.originFor(mixed.model, mixed.options), first.origin);
const drillOwned = ["drill", "readme", "drillreport"];
assert.deepEqual(mixed.files.filter(f => !drillOwned.includes(f.kind)), plot.files.filter(f => !drillOwned.includes(f.kind)),
  "Gerber, drill drawings, other reports and placement files retain their bytes");
assert.match(byKind(mixed.files, "drillreport")[0].content, /^Units: millimetres\. Coordinates: design origin, viewed from the top, Y up\.\r?$/m,
  "the drill report names the origin the drill files use");
assert.match(byKind(plot.files, "drillreport")[0].content, /^Units: millimetres\. Coordinates: board origin \(Edit > Origin\), viewed from the top, Y up\.\r?$/m);
assert.match(byKind(mixed.files, "readme")[0].content, /^NC drill coordinates: design origin, viewed from the top, Y up\.$/m);
const drillData = viewDrills(mixed.files), sharedDrills = viewDrills(plot.files);
assert.equal(drillData.length, 2);
for (const [i, d] of drillData.entries()) {
  const prior = sharedDrills[i], {hits, ...same} = d;
  const {hits: before, ...old} = prior;
  assert.deepEqual(same, old, "names, tools and hit counts stay the same");
  assert.deepEqual(hits, before.map(p => ({...p, x: p.x + first.origin[0], y: p.y - first.origin[1]})));
}
const secondDefault = F.build(multiple, second.id, common);
assert.deepEqual(F.build(multiple, second.id, {...common, drillOrigin: "shared"}).files, secondDefault.files);
assert.deepEqual(viewDrills(secondDefault.files)[0].hits.map(q => [q.x, q.y]), [[3,5]]);
const secondSeparate = F.build(multiple, second.id, {date, origin: "absolute", drillOrigin: "auto"});
assert.deepEqual(viewDrills(secondSeparate.files)[0].hits.map(q => [q.x, q.y]), [[3,5]]);

const jobs = AtriumOutputJobs;
for (const [board, options] of [[first, {drillOrigin: "absolute", profileWidth: .0254}], [second, {}]]) {
  jobs.save(multiple, {name: board.name, board: board.id, outputs: [{kind: "gerber", options}]});
}
const persisted = nativeRoundTrip(multiple), snapshot = JSON.stringify(persisted);
for (const [board, expected] of [[first, mixed], [second, secondDefault]]) {
  const run = jobs.run(persisted, board.name, {date});
  assert.equal(run.report.ok, true);
  const profile = run.files.find(f => f.name.endsWith(".GM1"));
  assert.equal(parseGerber(new TextDecoder().decode(profile.data)).draws[0].width, board === first ? .0254 : .1);
  for (const f of byKind(expected.files, "drill")) {
    const suffix = f.name.slice(f.name.lastIndexOf("-"));
    const file = run.files.find(g => g.name.endsWith(suffix));
    assert.ok(file, "the saved job produced the drill group");
    assert.equal(new TextDecoder().decode(file.data), f.content, "saved job uses the selected board and origin");
  }
}
assert.equal(JSON.stringify(persisted), snapshot, "generating either saved job leaves the designs and job settings intact");
assert.throws(() => F.build(multiple, first.id, {...common, drillOrigin: "unknown"}), /valid NC drill origin/);

console.log("PASS Altium relative origin, unchanged geometry, and matched Gerber, drill and placement frames");
