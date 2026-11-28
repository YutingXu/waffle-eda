"use strict";
// Layer sets (layer-sets.js): built-in sets from the stack-up (Signal / Plane), custom sets
// stored on the board and accepted by the project validator, and the editor host flow.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "stackup", "layer-sets", "pcb-appearance", "pcb-layer-bar"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const L = AtriumLayerSets, S = AtriumStackup;
const p = AtriumParts.example(), board = p.documents[1], defs = new Map(p.library.map(d => [d.id, d]));
board.stackup = S.preset("4");
const lay = L.layers(board, defs);
assert.deepEqual(lay.copper.map(c => c.type), ["Signal", "Plane", "Plane", "Signal"]);
assert.ok(lay.other.includes("Silk") && lay.other.includes("Multi"));
assert.deepEqual(L.shown(board, defs, "signal"), ["Top", "Bottom", "Multi"]);
assert.deepEqual(L.shown(board, defs, "plane"), ["Inner 1", "Inner 2", "Multi"]);
assert.ok(!L.shown(board, defs, "nonsignal").some(k => /^(Top|Bottom|Inner \d+)$/.test(k)));
assert.ok(L.shown(board, defs, "mech").every(k => /mech|keep|outline|dimension|assembly|courtyard|fab/i.test(k)));
assert.equal(L.shown(board, defs, "all").length, lay.copper.length + lay.other.length);
assert.equal(L.shown(board, defs, "nope"), null);
// A board can place the same footprint many times. Its artwork contributes the same layers at every placement.
let shapeReads = 0, revision = 1;
const artwork = [{layer:"Mechanical 3"}, {layer:"Bottom mask"}];
const footprint = {get shapes() {shapeReads++; return artwork;}, pads:[{layer:"Top"}]};
const layerDefs = new Map([["a",{footprint}], ["b",{footprint}]]);
const items = Array.from({length:200}, (_, i) => ({kind:"part", def:i % 2 ? "a" : "b"}));
items.push({kind:"track",layer:"Inner 9"}, {kind:"line",layer:"Bottom silk"});
const layersHost = {doc:() => ({items}), defs:() => layerDefs, revision:() => revision};
const names = AtriumPCBLayerBar.otherLayers(layersHost);
assert.deepEqual(names, ["Mechanical","Mechanical 3","Silk","Bottom silk","Bottom mask","Multi"]);
assert.equal(shapeReads, 1);
assert.equal(AtriumPCBLayerBar.otherLayers(layersHost), names, "reuse the same result between edits");
assert.equal(shapeReads, 1);
artwork.push({layer:"Top paste"}); revision++;
assert.ok(AtriumPCBLayerBar.otherLayers(layersHost).includes("Top paste"));
assert.equal(shapeReads, 2, "a new revision reads the shared artwork once");
const nextDoc = {id:"layers", items:[{kind:"line",layer:"Mechanical 7"}]};
const nextHost = {...layersHost, doc:() => nextDoc};
assert.ok(AtriumPCBLayerBar.otherLayers(nextHost).includes("Mechanical 7"));
const firstDoc = {id:nextDoc.id, items};
const firstHost = {...layersHost, doc:() => firstDoc};
const retainedNames = AtriumPCBLayerBar.otherLayers(firstHost);
assert.ok(retainedNames.includes("Mechanical 3") && !retainedNames.includes("Mechanical 7"),
  "distinct boards with the same ID discover their own layer names");
const tabs = {dataset:{layers:"board tabs"}, children:["old PCB tab"], replaceChildren(){this.children.length=0;}};
AtriumPCBLayerBar.release(tabs);
assert.deepEqual(tabs.children, [], "replacement releases the previous tab handlers");
assert.equal(tabs.dataset.layers, undefined);
assert.notEqual(AtriumPCBLayerBar.otherLayers(firstHost), retainedNames, "replacement releases the layer discovery cache");
// Host flow: apply a set, save the current visibility, rename and delete it (undoable edits).
const hidden = new Set(); let edits = 0, info = "";
const host = {doc:() => board, defs:() => defs, project:() => p, hiddenLayers:() => hidden, copperLayers:() => lay.copper.map(c => c.key), activeLayer:() => "Top",
  edit(fn) {edits++; fn();}, info(t) {info = t;}, redraw() {}, registerAction() {}, canvas:() => null};
L.attach(host);
assert.ok(L.applySet("plane"));
assert.ok(hidden.has("Silk") && hidden.has("Top") && !hidden.has("Inner 1"), [...hidden].join());
assert.ok(L.applySet("mech") && !hidden.has("Top"), "a set without copper keeps the current layer visible");
L.applySet("plane");
assert.equal(L.active(board.id), "plane");
L.saveAs("Planes and top");
assert.equal(edits, 1); assert.equal(board.layerSets[0].name, "Planes and top");
assert.deepEqual(board.layerSets[0].shown.sort(), ["Inner 1", "Inner 2", "Multi"]);
assert.ok(A_valid(), "the project validator accepts doc.layerSets");
assert.ok(L.applySet("all")); assert.equal(hidden.size, 0);
assert.ok(L.choose("custom:Planes and top")); assert.ok(hidden.has("Bottom"));
assert.throws(() => L.saveAs("Signal Layers"), /built-in/);
assert.throws(() => L.saveAs(""), /name/);
L.rename("Planes and top", "Inner"); assert.equal(board.layerSets[0].name, "Inner");
L.remove("Inner"); assert.equal(board.layerSets, undefined);
assert.throws(() => L.validate([{name:"a", shown:[1]}]), /malformed/);
assert.throws(() => L.validate(Array(40).fill(0).map((_, i) => ({name:"s" + i, shown:[]}))), /at most/);
function A_valid() {board.layerSets && L.validate(board.layerSets); try {Atrium.validate(JSON.parse(JSON.stringify(p))); return true;} catch (e) {console.log(e.message); return false;}}
console.log("PASS layer sets: built-in Signal/Plane/Non-Signal/Mechanical/All, custom sets on the board, " + info);
