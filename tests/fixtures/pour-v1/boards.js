"use strict";
// Boards for tests/pour-v2-deviation.cjs: copper.json beside this file holds their copper as the
// single-stage pour engine (before 2026-11-20: earlier pours cleared in the same overlay, unclipped,
// ring start and order as traced) stored it. Needs model, parts, polygon-pour and tests/dense-board.js.
globalThis.atriumPourV1Boards = function () {
  const A = Atrium, PP = AtriumPolygonPour;
  const board = (size, polys, label) => {
    const {d, defs} = makeAtriumBenchmarkBoard(size), p = A.project("Pours"); p.documents = [d]; p.library = [...defs.values()];
    let k = 0;
    for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 16), "2": "N" + ((k + 1) % 16)}; else if (i.kind !== "track") i.net = "N" + (k % 16); k++; }
    const b = A.bounds(d.outline), w = b[2] - b[0], h = b[3] - b[1];
    const rect = (x0, y0, x1, y1) => [[b[0] + x0 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y1 * h], [b[0] + x0 * w, b[1] + y1 * h]];
    polys.forEach(([layer, net, o, extra], j) => d.items.push(PP.make(rect(...o), {layer, net, pourIndex: j, removeDeadCopper: j % 3 === 0, ...extra})));
    return {label, p, d, defs};
  };
  // GND / VCC halves per side, six small net pours over them (each clears the larger ones' copper),
  // a pour on an inner layer, one with no net, one of a net already poured, and a hatched pour.
  const layout = [["Top", "GND", [0, 0, .5, 1]], ["Top", "VCC", [.5, 0, 1, 1]], ["Bottom", "GND", [0, 0, 1, .5]], ["Bottom", "VCC", [0, .5, 1, 1]],
    ...[0, 1, 2, 3, 4, 5].map(j => [j % 2 ? "Top" : "Bottom", "N" + j, [.03 + j * .15, .04, .14 + j * .15, .15]]),
    ["Inner 1", "GND", [0, 0, 1, 1]], ["Top", "", [.4, .4, .6, .6]], ["Top", "GND", [.45, .7, .55, .8]], ["Bottom", "N7", [.6, .6, .9, .9], {fillMode: "hatched"}]];
  // Overlapping pours on one layer, later ones over earlier ones (every later pour clears them).
  const stack = [["Top", "GND", [0, 0, 1, 1]], ["Top", "N1", [.1, .1, .6, .6]], ["Top", "N2", [.4, .4, .9, .9]], ["Top", "N3", [.2, .5, .5, .95], {islandAreaThreshold: .05}]];
  return [board(24, layout, "benchmark 24"), board(30, stack, "stacked 30")];
};
