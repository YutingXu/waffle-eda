"use strict";
const {appFile} = require("../support/app-source-paths.cjs");

const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "parts", "board-shape", "board-shape-sources", "stackup", "pcb-pours", "import-link",
  "source-file", "altium-ids", "altium-rules", "pcb-import", "io", "sexpr", "import-kicad", "edit-selection", "blocks",
  "blame", "component-match"]) require(appFile(name + ".js"));

const A = Atrium, B = AtriumBlocks, E = AtriumEditSelection;
const defsOf = project => new Map(project.library.map(def => [def.id, def]));
const fixture = name => fs.readFileSync(path.join(__dirname, "../fixtures", name));
function importedProject({documents, library}) {
  return {...A.project("Imported", library), documents};
}
function paste(project, board, items, point, cut = false) {
  const ids = new Set(items.map(item => item.id)), defs = defsOf(project);
  const clip = E.capture(board, defs, ids, cut);
  if (cut) board.items = board.items.filter(item => !ids.has(item.id));
  const plan = E.prepare(project, board, clip, defs);
  plan.commit(point);
  return plan.items;
}
function place(project, board, block, point) {
  const plan = B.prepare(project, block, point);
  project.library.push(...plan.library);
  board.items.push(...plan.items);
  return plan.items;
}
function assertNewInstance(copy, source) {
  assert.notEqual(copy.id, source.id);
  for (const field of ["sourceRecord", "schSource", "altiumSourceId", "kicadSourceId", "kicadPath"]) {
    assert.equal(Object.hasOwn(copy, field), false, `${copy.kind} kept ${field}`);
  }
  if (copy.kind === "part") {
    assert.ok(copy.link);
    assert.notEqual(copy.link, source.link);
  }
}

// A binary Altium import supplies the real source IDs that Update PCB reads.
{
  const name = "PiDP11IOExpander.PcbDoc";
  const project = importedProject(AtriumIO.read(name, new Uint8Array(fixture(`altium/pidp11-io-expander/${name}`))));
  const [board] = project.documents;
  const source = board.items.find(item => item.kind === "part" && item.ref === "R7");
  const definition = defsOf(project).get(source.def), original = A.clone(source);
  assert.ok(source.altiumSourceId && source.sourceRecord);
  assert.deepEqual(AtriumComponentMatch.describe(source, definition).sourceIds, [source.altiumSourceId]);
  const [x0, y0, x1, y1] = A.bounds(A.itemPoints(source, definition, "pcb"));
  const block = A.clone(B.capture({...board, items:[source]}, defsOf(project), [x0 - 1, y0 - 1], [x1 + 1, y1 + 1], "R7"));
  const [pasted] = paste(project, board, [source], [100, 100]);
  assertNewInstance(pasted, source);
  const [placed] = place(project, board, block, [200, 200]);
  assertNewInstance(placed, source);
  const placedRecord = AtriumComponentMatch.describe(placed, defsOf(project).get(placed.def));
  assert.deepEqual(placedRecord.sourceIds, []);
  assert.equal(placedRecord.detachedSource, false);
  assert.deepEqual(source, original);
  assert.equal(board.items.filter(item => item.altiumSourceId === original.altiumSourceId).length, 1);
  const [restored] = paste(project, board, [source], [source.x, source.y], true);
  assert.deepEqual(restored, original);
}

// An older portable block is read from disk with its original part and track stamps intact.
{
  const partId = "15a74096-22a5-4f23-9d9b-14f2cb390881", trackId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const project = importedProject(AtriumKiCadImport.readBoard("Identity.kicad_pcb", `(kicad_pcb (version 20240108) (net 1 "GND")
    (footprint "Test:R" (layer "F.Cu") (at 5 5) (uuid "${partId}") (path "/${partId}")
      (property "Reference" "R5") (property "Value" "10k")
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND")))
    (segment (start 5 5) (end 6 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "${trackId}")))`));
  const [board] = project.documents, originals = board.items.slice();
  const [part, track] = originals;
  const sourceValue = (project, item) => AtriumBlame.engine.sourceValue(project, {item}, true, "pcb");
  const before = originals.map(item => sourceValue(project, item));
  const oldBlock = fixture("placement/legacy-import.waffle-block").toString("utf8"), block = B.validate(JSON.parse(oldBlock));
  assert.equal(part.kicadSourceId, partId);
  assert.equal(track.kicadSourceId, trackId);
  assert.equal(block.items[0].kicadSourceId, partId);
  assert.equal(block.items[0].kicadPath, part.kicadPath);
  assert.equal(block.items[1].kicadSourceId, trackId);

  function check(items, net) {
    assert.equal(items[0].pinNets["1"], net);
    assert.equal(items[1].net, net);
    items.forEach((item, index) => assertNewInstance(item, originals[index]));
  }
  check(paste(project, board, originals, [20, 20]), "GND");
  check(place(project, board, block, [40, 40]), "B1/GND");
  check(place(project, board, block, [60, 60]), "B2/GND");
  assert.equal(new Set(board.items.map(item => item.id)).size, board.items.length);
  assert.equal(project.library.length, 1);
  assert.deepEqual(originals.map(item => sourceValue(project, item)), before);

  const foreign = A.project("Foreign"), foreignBoard = foreign.documents[1];
  check(place(foreign, foreignBoard, block, [20, 20]), "B1/GND");
  assert.deepEqual(originals.map(item => sourceValue(foreign, item)), [null, null]);
  assert.deepEqual(block, JSON.parse(oldBlock));
  A.validate(foreign);

  const restored = paste(project, board, originals, [part.x, part.y], true);
  assert.deepEqual(restored, originals);
  assert.deepEqual(restored.map(item => sourceValue(project, item)), before);
  A.validate(project);
}

console.log("PASS placement identity for real Altium and KiCad imports, repeat and foreign legacy-block placement, original history, and cut restore");
