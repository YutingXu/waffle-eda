"use strict";
const {appFile} = require("../support/app-source-paths.cjs");

const assert = require("node:assert/strict");
for (const name of ["model", "parts", "edit-selection", "blocks"]) require(appFile(name + ".js"));

const A = Atrium, B = AtriumBlocks, E = AtriumEditSelection;
const defsOf = project => new Map(project.library.map(def => [def.id, def]));
const example = AtriumParts.example();
const definition = A.clone(defsOf(example).get("std-r"));
definition.footprint.pads[0].id = "nested-pad";

function packets(def = definition, refs = ["R5"]) {
  const project = A.project("Source", [def]), board = project.documents[1], defs = defsOf(project);
  board.items = refs.map((ref, index) => ({...A.instantiate(project, def, [index * 5, 0], 0, {ref}), pinNets: {1: "GND"}}));
  const clip = E.capture(board, defs, new Set(board.items.map(item => item.id)));
  const block = B.capture(board, defs, [-4, -4], [8, 4], "Resistors");
  return {clip, block};
}
function reorderKeys(value) {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorderKeys(entry)]));
}
function paste(project, clip) {
  const board = project.documents[1], plan = E.prepare(project, board, clip, defsOf(project));
  plan.commit([30, 10]);
  return plan.items;
}
function place(project, block) {
  const plan = B.prepare(project, block, [30, 10]);
  project.library.push(...plan.library);
  project.documents[1].items.push(...plan.items);
  return plan.items;
}

// The definitions match through reordered keys at every depth. Their competing IDs
// establish paste's same-ID and first-match preference, and the block's last match.
{
  const {clip, block} = packets();
  const reordered = reorderKeys(definition);
  assert.deepEqual(reordered, definition);
  assert.notEqual(JSON.stringify(reordered.footprint.pads[0]), JSON.stringify(definition.footprint.pads[0]));
  const first = {...reordered, id: "first"}, last = {...reordered, id: "last"};
  const preferred = A.project("Preferred", [first, reordered, last]);
  assert.equal(paste(preferred, clip)[0].def, definition.id);
  assert.equal(preferred.library.length, 3);
  const fallback = A.project("Fallback", [first, last]);
  assert.equal(paste(fallback, clip)[0].def, first.id);
  assert.equal(fallback.library.length, 2);
  assert.equal(place(preferred, block)[0].def, last.id);
  assert.equal(preferred.library.length, 3);
  A.validate(preferred);
  A.validate(fallback);
}

// Geometry, nested IDs, and array order all count, including with an identical root ID.
for (const change of [
  def => { def.footprint.pads[0].w += 1e-13; },
  def => { def.footprint.pads[0].id = "different-pad"; },
  def => { def.footprint.pads.reverse(); },
]) {
  const {clip, block} = packets();
  const different = reorderKeys(definition);
  change(different);
  assert.notDeepEqual(different, definition);
  for (const insert of [project => paste(project, clip), project => place(project, block)]) {
    const project = A.project("Different", [different]);
    const [item] = insert(project);
    assert.equal(project.library.length, 2);
    assert.equal(item.def, project.library[1].id);
    assert.deepEqual({...project.library[1], id: definition.id}, definition);
    A.validate(project);
  }
}

// Paste preserves embedded pad nets. Blocks compare after mapping and use a new
// definition for each isolated pad net, or the existing definition when explicitly mapped.
{
  const withNet = A.clone(definition);
  withNet.footprint.pads[0].net = "GND";
  const {clip, block} = packets(withNet);
  const project = A.project("Embedded pad net", [reorderKeys(withNet)]);
  assert.equal(paste(project, clip)[0].def, withNet.id);
  const explicit = B.prepare(project, block, [20, 20], new Map([["GND", "GND"]]));
  assert.equal(explicit.library.length, 0);
  assert.equal(explicit.items[0].def, withNet.id);
  for (const net of ["B1/GND", "B2/GND"]) {
    const [copy] = place(project, block);
    assert.equal(project.library.at(-1).id, copy.def);
    assert.equal(project.library.at(-1).footprint.pads[0].net, net);
    assert.equal(copy.pinNets["1"], net);
  }
  assert.equal(project.library.length, 3);
  assert.equal(block.library[0].footprint.pads[0].net, "GND");
}

// Mixed case references on other documents and earlier items count in both plans.
{
  const project = A.project("References", [definition]);
  project.documents[0].items.push(A.instantiate(project, definition, [0, 0], 0, {ref: "r1"}));
  const [schematic, board] = project.documents;
  for (const [refs, pasteRefs, blockRefs] of [
    [["R5", "r8"], ["R2", "r3"], ["R2", "r3"]],
    [["MH"], ["R2"], ["MH1"]],
    [["100"], ["R2"], ["U1"]],
  ]) {
    const {clip, block} = packets(definition, refs);
    assert.deepEqual(E.prepare(project, board, clip, defsOf(project)).items.map(item => item.ref), pasteRefs);
    assert.deepEqual(B.prepare(project, block, [30, 10]).items.map(item => item.ref), blockRefs);
  }
  assert.equal(schematic.items[0].ref, "r1");
  assert.equal(board.items.length, 0);
  assert.equal(A.nextRef(project, "R"), "R1");
}

console.log("PASS placement definition equivalence, matching policies, embedded nets and case-insensitive plan references");
