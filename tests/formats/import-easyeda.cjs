"use strict";
// EasyEDA import (app/formats/import-easyeda.js): Standard JSON schematics and boards, and the
// Professional line format inside an .epro ZIP. Fixtures in tests/fixtures/import are
// synthetic documents written for this test (MIT, like the rest of the repository).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const f of ["model", "sch-objects", "board-shape", "board-shape-sources", "stackup", "polygon-pour", "kicad-export", "sexpr", "import-easyeda", "net-intent", "signals", "rules", "import-link"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, I = AtriumImportFormats, enc = new TextEncoder();
const bytes = n => new Uint8Array(fs.readFileSync(path.join(__dirname, "../fixtures/import", n)));
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const nearP = (p, q, tol = 1e-3) => !!p && near(p[0], q[0], tol) && near(p[1], q[1], tol);
const valid = r => { const p = A.project("EasyEDA"); p.documents = r.documents; p.library = r.library; AtriumImportLink.reconcile(p, p.documents); return A.validate(p); };
const pinAt = (doc, defs, ref, n, kind) => {
  for (const part of doc.items.filter(i => i.kind === "part" && i.ref === ref)) {
    const hit = A.pins(part, defs.get(part.def), kind).find(q => q.number === n);
    if (hit) return hit;
  }
  return null;
};

// ------------------------------------------------------------------ helpers
{
  const lines = AtriumEasyEDAImport.svgPath("M 0 0 L 10 0 A 5 5 0 0 1 10 10 Z m 20 0 h 5 v 5");
  assert.equal(lines.length, 2);
  for (const p of lines[0].slice(2, -2)) assert.ok(near(Math.hypot(p[0] - 10, p[1] - 5), 5, 1e-6), "arc radius");
  assert.ok(lines[0].slice(2, -2).every(p => p[0] >= 10 - 1e-9), "sweep flag picks the right side");
  assert.deepEqual(lines[1], [[20, 0], [25, 0], [25, 5]]);
  // Deflate: fixed, dynamic and stored blocks round-trip through the ZIP reader.
  const files = I.unzip(bytes("demo-easyeda.epro"));
  assert.ok(files.get("README.txt").length > 10 && /^\["DOCTYPE"/.test(I.utf8(files.get("PCB/board1.epcb"))));
  assert.deepEqual(Array.from(I.base64("V2FmZmxl")), Array.from(enc.encode("Waffle")));
}

{
  const {pointSeg} = require("../support/segment-distance.cjs");
  const a = Math.PI / 6, u = [12 * Math.cos(a), 12 * Math.sin(a)], v = [-3 * Math.sin(a), 3 * Math.cos(a)];
  const d = "M " + u.join(" ") + " A 12 3 30 0 1 " + u.map(n => -n).join(" ");
  const source = {head: {docType: "3"}, shape: ["ARC~1~3~~" + d]};
  const [board] = I.readSet([{name: "ellipse.json", bytes: enc.encode(JSON.stringify(source))}])[0].documents;
  const [poly] = board.items;
  assert.equal(poly.layer, "Silk");
  assert.ok(nearP(poly.points[0], u.map(n => n * .254), .00005));
  assert.ok(nearP(poly.points.at(-1), u.map(n => -n * .254), .00005));
  for (let i = 0; i <= 512; i++) {
    const t = i * Math.PI / 512, at = u.map((x, j) => .254 * (x * Math.cos(t) + v[j] * Math.sin(t)));
    const miss = Math.min(...poly.points.slice(1).map((b, j) => pointSeg(at, poly.points[j], b)));
    assert.ok(miss <= .00516, "EasyEDA rotated arc chord error " + miss);
  }
}

// ------------------------------------------------------------------ Standard schematic
{
  const [r] = I.readSet([{name: "demo-easyeda-sch.json", bytes: bytes("demo-easyeda-sch.json")}]);
  valid(r);
  const doc = r.documents[0], defs = new Map(r.library.map(d => [d.id, d]));
  assert.equal(doc.kind, "schematic");
  assert.ok(nearP(pinAt(doc, defs, "R1", "1", "schematic").at, [96.52, 76.2]) && nearP(pinAt(doc, defs, "R1", "2", "schematic").at, [106.68, 76.2]));
  assert.ok(nearP(pinAt(doc, defs, "R2", "1", "schematic").at, [127, 71.12]) && nearP(pinAt(doc, defs, "R2", "2", "schematic").at, [127, 81.28]), "rotated symbol");
  const R1 = doc.items.find(i => i.ref === "R1"), R2 = doc.items.find(i => i.ref === "R2");
  assert.deepEqual([R1.value, defs.get(R1.def).footprintName, R1.parameters.Manufacturer, R2.angle], ["10k", "R0603", "Acme", 90]);
  assert.deepEqual(defs.get(R2.def).symbol.pins.map(q => [q.x, q.y]), [[-5.08, 0], [5.08, 0]], "rotated copies are stored unrotated");
  const power = doc.items.filter(i => i.kind === "power").map(p => [p.text, p.style, p.direction, p.x, p.y]).sort();
  assert.deepEqual(power, [["GND", "gnd", 3, 127, 86.36], ["VCC", "bar", 3, 93.98, 71.12]]);
  assert.ok(doc.items.some(i => i.kind === "netlabel" && i.text === "SIG") && doc.items.some(i => i.kind === "junction") && doc.items.some(i => i.kind === "noerc"));
  assert.ok(doc.items.some(i => i.kind === "label" && /fixture/.test(i.text)) && doc.items.some(i => i.kind === "graphic"));
  const c = A.connectivity(doc, defs), net = (ref, n) => c.byPin.get(doc.items.find(i => i.ref === ref).id + "/" + n);
  assert.deepEqual([net("R1", "2"), net("R2", "1"), net("R2", "2"), net("R1", "1")], ["SIG", "SIG", "GND", "VCC"]);
  // Sub-parts U1.1 and U1.2 become gates of one definition.
  const us = doc.items.filter(i => i.kind === "part" && i.ref === "U1");
  assert.equal(us.length, 2); assert.equal(us[0].def, us[1].def);
  assert.deepEqual([defs.get(us[0].def).symbol.parts, us.map(u => u.unit).sort()], [2, [1, 2]]);
  assert.ok(nearP(pinAt(doc, defs, "U1", "7", "schematic").at, [172.72, 76.2]));
  assert.deepEqual(A.pins(us.find(u => u.unit === 2), defs.get(us[0].def), "schematic").map(q => q.number).sort(), ["6", "7"]);
  console.log("PASS EasyEDA Standard schematic: symbols, rotation, pins, wires, labels, net flags and nets");
}

// ------------------------------------------------------------------ Standard PCB
{
  const [r] = I.readSet([{name: "demo-easyeda-pcb.json", bytes: bytes("demo-easyeda-pcb.json")}]);
  const p = valid(r), board = r.documents[0], defs = new Map(r.library.map(d => [d.id, d]));
  const box = A.bounds(board.outline);
  assert.ok(nearP(box.slice(0, 2), [0, 0]) && nearP(box.slice(2), [50.8, 25.4]), "outline relative to the canvas origin");
  assert.equal(board.boardShape.cutouts.length, 1);
  assert.ok(board.items.some(i => i.kind === "pad" && i.plated === false && near(i.drill, 3.048) && nearP([i.x, i.y], [48.26, 22.86])));
  const R1 = board.items.find(i => i.ref === "R1"), J1 = board.items.find(i => i.ref === "J1"), R3 = board.items.find(i => i.ref === "R3");
  assert.deepEqual([R1.value, R1.layer, R1.angle], ["10k", "Top", 0]);
  assert.ok(nearP(pinAt(board, defs, "R1", "1", "pcb").at, [10.668, 12.7]) && nearP(pinAt(board, defs, "R1", "2", "pcb").at, [14.732, 12.7]));
  assert.deepEqual([pinAt(board, defs, "R1", "1", "pcb").w, pinAt(board, defs, "R1", "1", "pcb").h], [1.524, 2.032]);
  assert.deepEqual(R1.pinNets, {1: "SIG", 2: "GND"});
  const fp = defs.get(R1.def).footprint;
  assert.ok(fp.shapes.some(s => s.layer === "Silk") && fp.shapes.some(s => s.style === "package"));
  // EasyEDA turns components the other way from Waffle (checked on real boards): LIB rotation 90 is -90.
  assert.equal(J1.angle, -90);
  const j = pinAt(board, defs, "J1", "1", "pcb");
  assert.ok(nearP(j.at, [38.1, 10.16]) && nearP(pinAt(board, defs, "J1", "2", "pcb").at, [38.1, 15.24]));
  assert.deepEqual([j.shape, j.layer, j.drill, j.angle], ["round", "Multi", 1.016, 0]);
  assert.equal(R3.layer, "Bottom");
  assert.deepEqual(R3.pinNets, {1: "GND"});
  const tracks = board.items.filter(i => i.kind === "track");
  assert.deepEqual(tracks.map(t => [t.layer, t.net, t.width, t.points.length]).sort(), [["Bottom", "GND", .254, 4], ["Top", "SIG", .254, 4]]);
  const via = board.items.find(i => i.kind === "via");
  assert.deepEqual([via.x, via.y, via.diameter, via.drill, via.net], [25.4, 7.62, .6096, .3048, "SIG"]);
  const pour = board.items.find(i => i.kind === "polygon");
  assert.deepEqual([pour.layer, pour.net, pour.clearance, pour.points.length, pour.removeDeadCopper], ["Bottom", "GND", .508, 4, true]);
  AtriumPolygonPour.validate(pour);
  assert.ok(board.items.some(i => i.kind === "graphic" && i.layer === "Silk" && i.points.length > 3), "silk arc");
  assert.ok(board.items.some(i => i.kind === "label" && i.text === "EASYEDA"));
  assert.deepEqual(AtriumRules.stored(board, p).defaults, {clearance: .1524, trackWidth: .254, viaDrill: .3048});
  const k = AtriumKiCad.exportBoard(p, board);
  assert.deepEqual([k.counts.components, k.counts.vias, k.counts.segments], [3, 1, 6]);
  console.log("PASS EasyEDA Standard PCB: footprints, rotation, sides, pads, holes, tracks, vias, copper areas, outline and rules");
}

// ------------------------------------------------------------------ Professional .epro
{
  const [r] = I.readSet([{name: "demo-easyeda.epro", bytes: bytes("demo-easyeda.epro")}]);
  valid(r);
  const board = r.documents.find(d => d.kind === "pcb"), sheet = r.documents.find(d => d.kind === "schematic"), defs = new Map(r.library.map(d => [d.id, d]));
  const box = A.bounds(board.outline);
  assert.ok(nearP(box.slice(0, 2), [0, 0]) && nearP(box.slice(2), [50.8, 25.4]));
  const R1 = board.items.find(i => i.ref === "R1");
  assert.ok(nearP([R1.x, R1.y], [12.7, 12.7]));
  assert.ok(nearP(pinAt(board, defs, "R1", "1", "pcb").at, [11.684, 12.7]) && nearP(pinAt(board, defs, "R1", "2", "pcb").at, [13.716, 12.7]));
  assert.deepEqual(R1.pinNets, {1: "SIG", 2: "GND"});
  assert.equal(defs.get(R1.def).footprint.name, "R0603");
  assert.ok(board.items.some(i => i.kind === "track" && i.net === "SIG"));
  const via = board.items.find(i => i.kind === "via");
  assert.deepEqual([via.diameter, via.drill], [.6096, .3048]);
  assert.ok(board.items.some(i => i.kind === "polygon" && i.layer === "Bottom" && i.net === "GND"));
  assert.ok(nearP(pinAt(sheet, defs, "R1", "1", "schematic").at, [20.32, 25.4]));
  assert.ok(sheet.items.some(i => i.kind === "power" && i.text === "GND"));
  const c = A.connectivity(sheet, defs), id = sheet.items.find(i => i.ref === "R1").id;
  assert.deepEqual([c.byPin.get(id + "/1"), c.byPin.get(id + "/2")], ["SIG", "GND"]);
  console.log("PASS EasyEDA Pro archive: ZIP, board outline, footprints from the project library, pads, nets, pours, symbols and wires");
}
// A malformed track must not shift the coordinate pairing of the remaining tokens.
{
  const input = {head: {docType: "3"}, shape: [
    "TRACK~1~1~MALFORMED~10 20 foo 30 40 50~broken~0",
    "TRACK~1~1~GOOD~0 20 30 40~good~0"
  ]};
  const [result] = I.readSet([{name: "points.json", bytes: enc.encode(JSON.stringify(input))}]);
  const tracks = result.documents[0].items.filter(i => i.kind === "track");
  assert.deepEqual(tracks.map(track => track.net), ["GOOD"]);
  assert.deepEqual(tracks[0].points, [[0, 5.08], [7.62, 10.16]]);
  assert.ok(result.notes.some(note => /malformed required values/.test(note)));
}
// Pro pad nets name their component by id, so a PADNET row may come before the COMPONENT row.
{
  const pro = (name, rows) => I.readSet([{name, bytes: enc.encode(rows.map(r => JSON.stringify(r)).join("\n"))}])[0];
  for (const net of [["PADNET", "n1", 0, "c1", "1", "SIG"], ["PAD_NET", "c1", "1", "SIG", "p1"]]) {
    const comp = ["COMPONENT", "c1", 0, 1, 0, 0, 0, {}];
    for (const rows of [[net, comp], [comp, net]]) {
      const r = pro("nets.epcb", [["DOCTYPE", "PCB", "1.1"], ...rows]);
      assert.deepEqual(r.documents[0].items.find(i => i.kind === "part").pinNets, {1: "SIG"}, net[0] + " in either order");
    }
  }
  // A value that is present but not a number rejects its record instead of reading as 0.
  const malformed = r => assert.ok(r.notes.some(note => /malformed required values/.test(note)));
  const wire = pro("wire.esch", [["DOCTYPE", "SCH", "1.1"], ["WIRE", "w1", [[0, 0, 10, 0, "X", 30, 40, 30]], "st"], ["WIRE", "w2", [[0, 0, 10, 0]], "st"]]);
  assert.deepEqual(wire.documents[0].items.filter(i => i.kind === "wire").map(w => w.points), [[[0, 0], [2.54, 0]]]);
  malformed(wire); valid(wire);
  const line = pro("line.epcb", [["DOCTYPE", "PCB", "1.1"], ["LINE", "l1", 0, "N", 1, 10, 10, "bad", 20, 10], ["LINE", "l2", 0, "N", 1, 0, 0, 10, 0, 10]]);
  assert.deepEqual(line.documents[0].items.filter(i => i.kind === "track").map(t => t.points), [[[0, 0], [.254, 0]]]);
  malformed(line);
  const path = pro("path.epcb", [["DOCTYPE", "PCB", "1.1"], ["POLY", "p1", 0, "", 3, 10, [0, 0, "L", 10, "X", 20, 0]], ["VIA", "v1", 0, "", "", "nope", 0, 12, 24]]);
  assert.deepEqual(path.documents[0].items.filter(i => i.kind === "graphic" || i.kind === "via"), []);
  malformed(path);
  // A Pro schematic component with a malformed position is skipped without failing the sheet.
  const comp = pro("comp.esch", [["DOCTYPE", "SCH", "1.1"], ["COMPONENT", "c1", "sym.1", "bad", 0, 0, 0], ["WIRE", "w1", [[0, 0, 10, 0]], "st"]]);
  assert.equal(comp.documents[0].items.filter(i => i.kind === "wire").length, 1);
  malformed(comp);
  // Standard: a bad footprint child drops that child only, and a stray path token rejects the path.
  const std = {head: {docType: "3"}, shape: [
    "LIB~100~100~package`R0603`~0~~g1~~~#@$TRACK~1~3~~100 100 bad 110#@$TRACK~1~3~~90 100 110 100~t2~0#@$TEXT~P~100~95~0.8~0~0~3~~4~R1~~~t3",
    "ARC~1~3~~M 0 0 A 5 5 0 0 1 X 10 10~a1~0",
    "ARC~1~3~~M 0 0 A 5 5 0 0 1 10~a2~0"
  ]};
  const [board] = I.readSet([{name: "std.json", bytes: enc.encode(JSON.stringify(std))}]);
  const R1 = board.documents[0].items.find(i => i.kind === "part");
  assert.equal(R1.ref, "R1");
  assert.deepEqual(board.library.find(d => d.id === R1.def).footprint.shapes.map(s => s.points.length), [2]);
  assert.equal(board.documents[0].items.filter(i => i.kind === "graphic").length, 0, "malformed arc paths are skipped");
  malformed(board);
  assert.throws(() => AtriumEasyEDAImport.svgPath("M 0 0 L 10 X 20 30"), /Invalid EasyEDA path/);
  const [sheet] = I.readSet([{name: "sheet.json", bytes: enc.encode(JSON.stringify({head: {docType: "1"}, shape: ["J~bad~0", "J~10~0"]}))}]);
  assert.deepEqual(sheet.documents[0].items.filter(i => i.kind === "junction").map(j => [j.x, j.y]), [[2.54, 0]]);
  console.log("PASS EasyEDA malformed numbers reject their record; pad nets read in any order");
}

assert.throws(() => I.read("x.json", enc.encode('{"head":{"docType":"2"}}')), /library/);
assert.throws(() => I.read("x.json", enc.encode('{"a":1}')), /not an EasyEDA/);
