"use strict";

const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");
const {parseExcellon, parseGerber} = require("./gerber-compare.cjs");
const {nativeRoundTrip} = require("../support/native-cad.cjs");
for (const name of ["parts", "spatial", "connectivity", "stackup", "board-shape", "pcb-pours", "pcb-appearance",
  "pcb-edit", "altium-rules", "rules", "dfm", "viastack", "pcb-import", "zip", "vendor/zipjs-deflate",
  "fab-outputs", "odb-eda", "odb"]) require(appFile(name + ".js"));

const A = Atrium, R = AtriumRules, F = AtriumFabOutputs;
const unit = .00000254;
const center = [6, -5];
const near = (a, b, tolerance = 5 * unit) => assert.ok(Math.abs(a - b) <= tolerance, a + " differs from " + b);
const nearPoint = (a, b, tolerance) => a.forEach((n, i) => near(n, b[i], tolerance));
const put = (pt, offset) => pt.map((n, i) => n + offset[i]);

function block(data) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
const record = fields => block(Buffer.from("|" + fields + "\0"));
function pad(name, {first, second = 0, type = 0, holeRotation = 0, rotation = 0, at = center, owner = 65535}) {
  const geometry = Buffer.alloc(160), details = Buffer.alloc(596), blank = block(Buffer.alloc(0));
  geometry[0] = 74; // MultiLayer
  geometry.writeUInt16LE(65535, 3);
  geometry.writeUInt16LE(65535, 5);
  geometry.writeUInt16LE(owner, 7);
  for (const [offset, value] of [[13, at[0]], [17, -at[1]], [21, 3], [25, 3], [45, first]])
    geometry.writeInt32LE(Math.round(value / unit), offset);
  geometry[49] = 1;
  geometry[60] = 1;
  geometry.writeDoubleLE(rotation, 52);
  details[262] = type;
  details.writeInt32LE(Math.round(second / unit), 263);
  details.writeDoubleLE(holeRotation, 267);
  return Buffer.concat([Buffer.from([2]), block(Buffer.concat([Buffer.from([name.length]), Buffer.from(name)])),
    blank, blank, blank, block(geometry), block(details)]);
}
const outline = "VX0=0mm|VY0=0mm|VX1=30mm|VY1=0mm|VX2=30mm|VY2=15mm|VX3=0mm|VY3=15mm";
function streamsOf(pads, side = "TOP") {
  return new Map([
    ["board6/data", record(outline)],
    ["components6/data", record("SOURCEDESIGNATOR=J1|PATTERN=Connector|X=5mm|Y=5mm|ROTATION=40|LAYER=" + side)],
    ["pads6/data", Buffer.concat(pads)]
  ]);
}
const read = streams => AtriumPCB.read("Slot.PcbDoc", streams, null);
const binary = pads => read(streamsOf(pads));
const projectOf = ({documents, library}) => ({...A.project("Slot axis", []), documents, library});
const defs = p => new Map(p.library.map(d => [d.id, d]));
const slotPad = p => p.library[0].footprint.pads[0];
const nativeRule = R.fromAltium("RECORD=Rule|RULEKIND=HoleToHoleClearance|NAME=Hole gap|ENABLED=TRUE|PRIORITY=1|" +
  "SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|GAP=0.25mm").rule;
const rules = {...R.create(), list: [nativeRule]};
const run = p => R.drc(p.documents[0], defs(p), rules, {types: ["holeToHole"]}).violations;
const distance = [-47, 43].map(angle => A.rotate([1.4, 0], angle));
const round = (number, at) => pad(number, {first: .4, second: 2.1, at});
const slotStreams = (transpose, side) => streamsOf([
  pad("S", {first: transpose ? 2.1 : .6, second: transpose ? .6 : 2.1, type: 2,
    holeRotation: transpose ? 121 : 31, rotation: 16, owner: 0}),
  round("tip", put(center, distance[0])),
  round("side", put(center, distance[1]))
], side);
const source = (transpose, side) => read(slotStreams(transpose, side));
const expected = [-.75, .75].map(t => put(center, A.rotate([t, 0], -47)));
const options = {origin: "absolute", date: new Date("2026-01-01T00:00:00Z")};
const yUp = ([x, y]) => [x, -y];

function plottedSlot(out, wanted) {
  const nc = out.files.filter(f => f.kind === "drill").map(f => parseExcellon(f.content));
  assert.ok(nc.every(f => f.warnings.length === 0));
  const [slot] = nc.flatMap(f => f.slots);
  assert.equal(nc.flatMap(f => f.slots).length, 1);
  assert.equal(nc.flatMap(f => f.hits).length, 2, "round holes keep their drill hits");
  near(slot.d, .6, .0001);
  assert.equal(slot.plated, true);
  nearPoint(slot.a, yUp(wanted[0]), .0001);
  nearPoint(slot.b, yUp(wanted[1]), .0001);
}

for (const [transposed, side] of [[false, "TOP"], [true, "TOP"], [true, "BOTTOM"]]) {
  const project = nativeRoundTrip(projectOf(source(transposed, side)));
  const board = project.documents[0], item = board.items.find(i => i.kind === "part"), slot = slotPad(project);
  assert.equal((item.angle + 360) % 360, 320);
  assert.equal(slot.angle, 24);
  assert.equal((slot.slotAngle + 360) % 360, 329, "the hole angle stays pad-relative");
  near(slot.drill, .6);
  near(slot.slotLength, 2.1);
  for (const pad of board.items.filter(i => i.kind === "pad")) {
    near(pad.drill, .4);
    assert.equal(pad.slotLength, undefined);
  }
  const holes = R.kit.extract(board, defs(project), {holesOnly: true}).holes;
  const slotFeature = holes.find(h => h.item.number === "S");
  nearPoint(slotFeature.core[0], expected[0]);
  nearPoint(slotFeature.core[1], expected[1]);
  near(R.kit.gap(slotFeature, holes.find(h => h.item.number === "side")).d, .9);
  const [failure] = run(project);
  assert.equal(run(project).length, 1, "only the round hole near the slot end violates the source rule");
  assert.match(failure.title, /tip/);
  near(failure.actual, .15);
  near(failure.required, .25);
  const dfm = AtriumDFM.run(board, defs(project), {holeToHolePad: .25}, {checks: ["holeToHole"]}).issues;
  assert.equal(dfm.length, 1);
  near(dfm[0].actual, .15);

  const out = F.build(project, board, options);
  plottedSlot(out, expected);
  const copper = parseGerber(out.files.find(f => f.kind === "gerber" && /\.GTL$/i.test(f.name)).content);
  assert.ok(copper.flashes.some(f => Math.hypot(f.x - center[0], f.y + center[1]) < .0001), "Gerber retains the plated pad land");
}

// The independent source oracle treats both encodings as the same drilled geometry and gates
// width, length and the placed axis. A long circular drill or a 90° error must turn it red.
{
  const O = require("../e2e/altium-oracle.cjs"), P = require("../e2e/pipeline.cjs");
  for (const transposed of [false, true]) {
    const streams = slotStreams(transposed);
    const raw = O.readStreams(streams), original = projectOf(read(streams));
    const decoded = raw.pads.find(p => p.name === "S").slot;
    near(decoded.width, .6);
    near(decoded.length, 2.1);
    const actualEnds = decoded.ends.map(yUp);
    for (const [x, y] of expected) assert.ok(actualEnds.some(([u, v]) => Math.hypot(x - u, y - v) < 5 * unit));
    const modelReport = model => ({results:P.altiumModelChecks(raw, model)});
    const clean = modelReport(original);
    for (const id of ["model.pads", "model.slots"]) assert.ok(clean.results.find(r => r.id === id).pass);
    const turned = A.clone(original);
    slotPad(turned).slotAngle += 90;
    assert.deepEqual(P.newlyRed(clean, modelReport(turned)), ["model.slots"]);
    const longCircle = A.clone(original), hole = slotPad(longCircle);
    hole.drill = hole.slotLength;
    delete hole.slotLength;
    delete hole.slotAngle;
    assert.deepEqual(P.newlyRed(clean, modelReport(longCircle)), ["model.pads", "model.slots"]);
  }
}

// Manufacturing distances use the routed centerline even when the tool's center is far from each object.
{
  const pcb = projectOf(source(true));
  const board = pcb.documents[0], point = put(center, A.rotate([1.2, 0], -47));
  const edgeStart = put(point, A.rotate([-2, 0], 43)), edgeEnd = put(point, A.rotate([2, 0], 43));
  const interior = A.rotate([-4, 0], -47);
  board.items = [board.items[0], {id: "track", kind: "track", layer: "Top", net: "foreign", width: .1, points: [edgeStart, edgeEnd]}];
  board.outline = [edgeStart, edgeEnd, put(edgeEnd, interior), put(edgeStart, interior)];
  const failures = AtriumDFM.run(board, defs(pcb), {pthToTrack: .25, holeToEdge: .25}, {checks: ["drillEdge", "drillCopper"]}).issues;
  assert.match(failures.find(f => f.check === "drillEdge").text, /0\.15 mm from the board edge/);
  assert.match(failures.find(f => f.check === "drillCopper").text, /0\.1 mm, minimum/);
}

// A routed hole's independent angle follows the pad and part even for an already-saved mirror.
{
  const project = projectOf(source(true)), board = project.documents[0], part = board.items.find(i => i.kind === "part");
  const reflected = expected.map(([x, y]) => [2 * part.x - x, y]).reverse();
  assert.equal(AtriumPCBEdit.flip(board, project, [part.id]).length, 1);
  const mirror = project.library.find(d => d.id === part.def);
  assert.equal(mirror.footprint.pads[0].slotAngle, 31);
  const clean = F.build(project, board, options);
  plottedSlot(clean, reflected);
  for (const oldSig of ["1234abcd", "p2:1234abcd"]) {
    mirror.mirrorSig = oldSig;
    mirror.footprint.pads[0].slotAngle = -31;
    const reopened = nativeRoundTrip(project), doc = reopened.documents[0], lib = defs(reopened);
    const hole = R.kit.extract(doc, lib, {holesOnly: true}).holes.find(h => h.item.number === "S");
    nearPoint(hole.core[0], reflected[0]);
    nearPoint(hole.core[1], reflected[1]);
    plottedSlot(F.build(reopened, doc, options), reflected);
    const override = lib.get(mirror.id).footprint.pads[0];
    override.slotAngle = -20;
    assert.equal(AtriumPCBAppearance.readDefinition(lib, mirror.id, doc).footprint.pads[0].slotAngle, -20);
  }

  mirror.mirrorSig = "1234abcd";
  const projectData = AtriumODBData;
  let files;
  globalThis.AtriumODBData = {...projectData, electrical(...args) {
    const writer = projectData.electrical(...args);
    return {...writer, write(out, root) { files = out; return writer.write(out, root); }};
  }};
  try { AtriumODB.build(project, board.id, options); }
  finally { globalThis.AtriumODBData = projectData; }
  const route = [...files].filter(([name]) => /\/rout_[^/]*\/features$/.test(name));
  assert.equal(route.length, 1);
  const feature = route[0][1];
  assert.match(feature, /^\$\d+ r600$/m, "ODB++ uses the 0.6 mm tool");
  assert.match(feature, /^@\d+ \.rout_plated$/m);
  const coords = feature.split("\n").find(row => row.startsWith("L ")).split(" ").slice(1, 5).map(Number);
  nearPoint(coords.slice(0, 2), yUp(reflected[0]), .0001);
  nearPoint(coords.slice(2, 4), yUp(reflected[1]), .0001);
}

// Degenerate slots yield circles. Rectangular, unknown and incomplete slot records retain the
// supported drill width with an import diagnostic and source record identity for review.
{
  const imported = binary([
    pad("equal", {first: .8, second: .8, type: 2, at: [4, -4]}),
    pad("rect", {first: 1.8, second: .8, type: 1, at: [8, -4]}),
    pad("unknown", {first: 1.8, second: .8, type: 9, at: [12, -4]}),
    pad("badAngle", {first: 1.8, second: .8, type: 2, holeRotation: NaN, at: [16, -4]})
  ]);
  for (const pad of imported.documents[0].items.filter(i => i.kind === "pad")) {
    near(pad.drill, .8);
    assert.equal(pad.slotLength, undefined);
    assert.match(pad.sourceRecord, /^pads6\/data#\d$/);
  }
  for (const name of [/Rectangular pad holes/, /Unknown pad hole shapes/, /Incomplete slotted pad holes/])
    assert.ok(imported.notes.some(note => name.test(note)));
}

// The ASCII form can express the same native hole axes.
{
  const ascii = "|RECORD=Board|" + outline + "\n" +
    "|RECORD=Pad|NAME=1|LAYER=MULTILAYER|X=10mm|Y=6mm|XSIZE=3mm|YSIZE=3mm|SHAPE=ROUND|" +
    "HOLETYPE=Slot|HOLESIZE=2.1mm|HOLELENGTH=0.6mm|HOLEROTATION=121|ROTATION=16|PLATED=TRUE";
  const [pad] = AtriumPCB.read("Slot.PcbDoc", null, ascii).documents[0].items;
  assert.deepEqual([pad.drill, pad.slotLength, pad.slotAngle], [.6, 2.1, -31]);
}

console.log("Altium slot axes survive native import, saving, endpoint clearance, flip, and NC, Gerber and ODB++ export.");
