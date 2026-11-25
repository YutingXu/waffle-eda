"use strict";
// A small board for the ECAD-MCAD tests (mcad-idx, mcad-step, mcad-idf): a 60 x 40 mm outline with a
// rounded corner and a rectangular cutout, three components (one on the bottom, one locked), a plated
// and a non-plated mounting hole, a component keep-out with a height and a copper keep-out.
globalThis.mcadBoard = function mcadBoard() {
  const A = Atrium, BS = AtriumBoardShape;
  const body = (w, h, height) => ({kind: "path", layer: "Mechanical 13", closed: true, points: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]});
  const lib = [
    {id: "res", name: "R0603", prefix: "R", footprint: {name: "R0603", pads: [{number: "1", x: -0.8, y: 0, w: 0.8, h: 0.9}, {number: "2", x: 0.8, y: 0, w: 0.8, h: 0.9}], shapes: [body(1.6, 0.8)], height: 0.5}},
    {id: "qfn", name: "QFN16", prefix: "U", footprint: {name: "QFN16", pads: [{number: "1", x: -1.4, y: -0.75, w: 0.6, h: 0.3}, {number: "2", x: 1.4, y: 0.75, w: 0.6, h: 0.3}], shapes: [body(3, 3)], height: 0.9}},
    {id: "conn", name: "JST", prefix: "J", footprint: {name: "JST-2", pads: [{number: "1", x: -1, y: 0, w: 1.6, h: 1.6, drill: 0.9}, {number: "2", x: 1, y: 0, w: 1.6, h: 1.6, drill: 0.9},
      {number: "", x: 0, y: 2, w: 1.2, h: 1.2, drill: 1.2, plated: false}], shapes: [body(6, 4.5)], height: 6}}
  ];
  const doc = A.sheet("pcb", "Board");
  doc.id = "pcb1";
  BS.apply(doc, {contour: [BS.line([0, 0], [55, 0]), BS.arc([55, 5], 5, 90, 0, false), BS.line([60, 5], [60, 40]), BS.line([60, 40], [0, 40]), BS.line([0, 40], [0, 0])],
    cutouts: [[BS.line([20, 15], [30, 15]), BS.line([30, 15], [30, 22]), BS.line([30, 22], [20, 22]), BS.line([20, 22], [20, 15])]]}, "test");
  doc.items.push(
    {id: "pR1", kind: "part", def: "res", ref: "R1", value: "10k", x: 10, y: 10, angle: 0},
    {id: "pU1", kind: "part", def: "qfn", ref: "U1", value: "MCU", x: 40, y: 12, angle: 90, layer: "Bottom"},
    {id: "pJ1", kind: "part", def: "conn", ref: "J1", value: "PWR", x: 45, y: 32, angle: 180, locked: true},
    {id: "h1", kind: "pad", number: "", x: 4, y: 36, w: 3.2, h: 3.2, drill: 3.2, shape: "round", layer: "Multi", net: "", plated: false},
    {id: "h2", kind: "pad", number: "", x: 56, y: 36, w: 4, h: 4, drill: 3, shape: "round", layer: "Multi", net: "GND"},
    {id: "k1", kind: "graphic", layer: "Keepout", points: [[5, 20], [15, 20], [15, 30], [5, 30]], fill: true, closed: true, width: 0, mcadKind: "component", mcadZ: [0, 2.5]},
    {id: "k2", kind: "graphic", layer: "Top", keepout: true, points: [[35, 25], [40, 25], [40, 30], [35, 30]], fill: true, closed: true, width: 0}
  );
  return {name: "MCADTest", format: "atrium", version: 1, formatVersion: "1.3", library: lib, documents: [doc]};
};
