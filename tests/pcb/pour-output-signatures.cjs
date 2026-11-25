"use strict";
// Detached output may need another refill after an upstream zone changes its stored copper.
const assert = require("node:assert/strict");
for (const name of ["model", "spatial", "pcb-appearance", "pcb-pours", "rules", "board-shape", "polygon-pour"]) {
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
}
const P = AtriumPolygonPour;
const box = (x, y, X, Y) => [[x, y], [X, y], [X, Y], [x, Y]];
const clone = value => JSON.parse(JSON.stringify(value));
const fill = (doc, options) => P.apply(doc, null, {reuse: false, ...options});
const region = (doc, id) => doc.pcbDrawing.pours.find(r => r.polygon === id);

const track = {id: "track", kind: "track", points: [[4, 5], [9, 5], [10, 7]], layer: "Top", width: .25, net: "GND"};
const wide = P.make(box(1, 1, 34, 14), {id: "upstream", net: "GND", pourIndex: 0});
const overlap = P.make(box(25, 5, 48, 20), {id: "downstream", net: "VCC", pourIndex: 1, removeDeadCopper: false});
const bottom = P.make(box(10, 24, 20, 34), {id: "untouched", net: "GND", layer: "Bottom", pourIndex: 2, removeDeadCopper: false});
const unpoured = P.make(box(30, 25, 42, 34), {id: "unpoured", net: "VCC", pourIndex: 3, removeDeadCopper: false});
const doc = Atrium.sheet("pcb", "Detached copper");
const outline = box(0, 0, 50, 40), cutout = box(39, 10, 41, 12);
const shape = AtriumBoardShape.fromPolygon(outline);
shape.cutouts.push(AtriumBoardShape.polySegments(cutout, true));
AtriumBoardShape.apply(doc, shape);
assert.equal(AtriumBoardShape.holes(doc).length, 1);
doc.items = [track, wide, overlap, bottom];
fill(doc);
assert.deepEqual(P.stale(doc, null), []);
assert.equal(region(doc, "downstream").count, 2, "downstream stored copper contains the board hole");
const initial = clone(doc);
doc.items.push(unpoured);

// Change the upstream track's net and one existing coordinate in place. It is too far away to
// stale the downstream zone directly. That zone needs the replacement upstream fill before
// its own clearance changes.
track.net = "VCC";
track.points[1][1] = 6;
const exchange = {evaluatedOnly: true};
assert.deepEqual(P.outputCopper(doc, null, {...exchange, solve: false}).pending, ["upstream"]);
const first = clone(doc);
fill(first, {only: ["upstream"], detached: true});
assert.deepEqual(P.stale(first, null), ["downstream", "unpoured"]);
const saved = JSON.stringify(doc);
const ref = clone(doc);
fill(ref);
const output = P.outputCopper(doc, null);
assert.deepEqual(output.filled, ["upstream", "downstream", "unpoured"]);
assert.deepEqual(output.regions, ref.pcbDrawing.pours, "export settles the same islands, holes and links as a full repour");
assert.equal(output.regions.find(r => r.polygon === "untouched"), region(doc, "untouched"));
assert.equal(JSON.stringify(doc), saved, "detached output leaves source items, regions and stamps untouched");

// Exchange leaves unevaluated zones alone. A shallow-frozen document still shares its contents with
// the detached view, and no source object may receive a new stamp or copper.
Object.freeze(doc.items);
Object.freeze(doc.pcbDrawing);
Object.freeze(doc);
const exchanged = P.outputCopper(doc, null, exchange);
assert.deepEqual(exchanged.filled, ["upstream", "downstream"]);
assert.deepEqual(exchanged.regions, ref.pcbDrawing.pours.filter(r => r.polygon !== "unpoured"));
assert.equal(JSON.stringify(doc), saved);

// Reopening the original snapshot restores the previous stamp. Change only the stored copper's
// packed rings: a valid input signature alone is insufficient to certify that region.
const restored = clone(initial);
assert.equal(P.outputCopper(restored, null).state, "current");
const stored = region(restored, "untouched");
const replacement = P.encode([box(11, 25, 19, 33).flat()], stored.layer, stored.net);
stored.data = replacement.data;
assert.deepEqual(P.outputCopper(restored, null, {solve: false}).pending, ["untouched"]);
assert.deepEqual(P.outputCopper(restored, null).regions, initial.pcbDrawing.pours);
console.log("pour-output-signatures: chained fills and detached output match a full repour");
