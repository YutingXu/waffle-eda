"use strict";
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/history/undo-store.js");
const A = Atrium, U = AtriumUndoStore;
const makeWire = (id, points) => ({id, kind: "wire", points});
const apply = (wire, start, end, anchors, options) => A.wireStretch(wire, anchors, options).apply(start, end);

{
  const original = [[0, 0], [0, 5], [2, 5], [4, 5], [4, 9]];
  const wire = makeWire("bent", A.clone(original));
  const view = A.wireStretch(wire, [[0, 3]]);
  assert.deepEqual(view.apply([3, -1]), [[3, -1], [3, 3], [0, 3], ...original.slice(1)], "the stationary tap and every authored vertex survive stretching");
  assert.deepEqual(view.apply(), original, "return in the same gesture resets the whole path");
  view.apply([3, -1]);
  assert.deepEqual(apply(wire, [0, 0], null, [[0, 3]]), original, "return in a new gesture removes only generated lead geometry");
  apply(wire, [3, -1]);
  apply(wire, [-2, 2], [7, 9]);
  assert.deepEqual(apply(wire, [0, 0], [4, 9]), original, "moving either end keeps the same authored route as a reference");
}

{
  const original = [[0, 0], [10, 0]], wire = makeWire("straight", A.clone(original));
  assert.deepEqual(apply(wire, [0, 2], [10, 2]), [[0, 2], [10, 2]], "an unconstrained span follows its endpoints together");
  assert.deepEqual(apply(wire, [0, 0], [10, 0]), original);
  assert.deepEqual(apply(wire, [0, 2], [10, -2], [[3, 0], [7, 0]]), [[0, 2], [3, 2], [3, 0], [7, 0], [7, -2], [10, -2]], "stationary taps hold both sides of a stretched span");
  assert.deepEqual(apply(wire, [0, 0], [10, 0], [[3, 0], [7, 0]]), original);
}

{
  const wire = makeWire("manual", [[0, 0], [0, 4]]);
  apply(wire, [3, 0]);
  wire.points[1][1] = 5;
  assert.deepEqual(apply(wire, [0, 0]), [[0, 0], [0, 5], [3, 5], [0, 4]], "editing a vertex in place sets a new authored path");
  const equalShape = makeWire("redrawn", [[0, 0], [0, 4]]);
  apply(equalShape, [3, 0]);
  equalShape.points = A.clone(equalShape.points);
  assert.deepEqual(apply(equalShape, [0, 0]), [[0, 0], [0, 4], [3, 4], [0, 4]], "a manually redrawn bend with the same coordinates is authored");
  const tapped = makeWire("new-tap", [[0, 0], [0, 4]]);
  apply(tapped, [3, 0]);
  assert.deepEqual(apply(tapped, [0, 0], null, [[3, 2]]), [[0, 0], [0, 2], [3, 2], [3, 4], [0, 4]], "a new tap on a stretched lead becomes a stationary anchor");
}

{
  const p = A.project("Transient routes"), doc = p.documents[0];
  const original = [[0, 0], [0, 5], [4, 5]], wire = makeWire("moving", A.clone(original));
  const other = makeWire("unrelated", [[5, 8], [8, 8]]);
  doc.items = [wire, other];
  const history = [], future = [], commit = (fn, affected) => {
    const before = U.mark(p);
    fn();
    U.record(p, {doc, items: affected});
    U.checkpoint(history, future, before);
  };
  const jump = delta => U.jump(history, future, U.mark(p), delta);
  commit(() => apply(wire, [3, 0]), [wire]);
  const away = A.clone(wire.points);
  assert.equal(A.wireStretchState(A.clone(wire)), undefined, "save/reopen or copy does not carry transient provenance");
  assert.equal(A.wireStretchState({...wire}), undefined, "an item copy sharing the original array also starts fresh");
  jump(-1);
  assert.deepEqual(wire.points, original);
  jump(1);
  assert.deepEqual(wire.points, away);
  commit(() => { other.points[1][1] = 9; }, [other]);
  commit(() => apply(wire, [0, 0]), [wire]);
  assert.deepEqual(wire.points, original, "undo/redo and an unrelated edit leave this wire's automatic lead reversible");
  assert.deepEqual(other.points.at(-1), [8, 9]);
  jump(-1);
  commit(() => { wire.points[1][1] = 6; }, [wire]);
  jump(-1);
  assert.deepEqual(wire.points, away);
  const tip = U.branches().at(-1)?.trees.at(-1);
  assert.ok(tip);
  U.adopt(history, future, U.mark(p), tip);
  assert.deepEqual(wire.points, original, "switching branches replays the same authored geometry");
  jump(-1);
  assert.deepEqual(wire.points, away);
  commit(() => { doc.items.shift(); }, [wire]);
  jump(-1);
  assert.equal(doc.items[0], wire);
  assert.deepEqual(apply(wire, [0, 0]), original, "undoing deletion restores the automatic lead state alongside its wire");
  U.reset();
}

{
  const origin = [0, 0], wire = makeWire("spur", [origin, origin]);
  assert.deepEqual(apply(wire, null, [3, 4], [origin], {spur:true}), [[0, 0], [0, 4], [3, 4]]);
  assert.equal(A.wireStretch(wire, [origin]).spur, true);
  assert.deepEqual(apply(wire, null, origin, [origin]), [origin, origin]);
  assert.equal(A.wireStretch(A.clone(wire)).spur, false);
}

console.log("PASS reversible schematic wire stretching, authored vertices and taps, manual edits, and existing undo history");
