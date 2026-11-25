"use strict";
// A small routed 6-layer board for the Signal Integrity tests and screenshots (needs app/model.js and
// app/stackup.js loaded). Nets:
//   DQ0   U1.1 → R1 (22 Ω series) → DQ0_R: Top, via to Inner 2 (stripline), via back to Top, U2.1.
//         The second via is back-drilled from the bottom to Inner 2.
//   CLK   U1.2 → T-branch → U2.3 and U3.3, on Top, running 0.4 mm (edge to edge) beside DQ0/DQ0_R.
// Every IC uses tests/fixtures/si/atrium-demo.ibs (component ATRIUM_DEMO) when assigned.
function project() {
  const A = globalThis.Atrium, ST = globalThis.AtriumStackup;
  const ic = {id: "si-ic8", name: "SI test IC (8 pads)", prefix: "U", footprint: {shapes: [], pads: Array.from({length: 8}, (_, i) => ({number: String(i + 1), x: 0, y: 1.27 * i, w: 0.6, h: 0.6, shape: "rect"}))}};
  const r = {id: "si-r0402", name: "R 0402", prefix: "R", footprint: {shapes: [], pads: [{number: "1", x: -0.5, y: 0, w: 0.5, h: 0.6, shape: "rect"}, {number: "2", x: 0.5, y: 0, w: 0.5, h: 0.6, shape: "rect"}]}};
  const doc = A.sheet("pcb", "SI demo board");
  doc.id = "si-board";
  doc.outline = [[0, 0], [70, 0], [70, 40], [0, 40]];
  doc.stackup = ST.preset("6");
  const part = (id, ref, def, value, x, y, pinNets) => ({id, kind: "part", def, ref, value, x, y, angle: 0, pinNets});
  const track = (id, net, layer, points, width = 0.2) => ({id, kind: "track", net, layer, width, points});
  const via = (id, net, x, y, extra = {}) => ({id, kind: "via", net, x, y, diameter: 0.6, drill: 0.3, layer: "Multi", ...extra});
  doc.items.push(
    part("U1", "U1", ic.id, "Driver", 10, 10, {"1": "DQ0", "2": "CLK", "5": "GND"}),
    part("U2", "U2", ic.id, "Receiver A", 60, 10, {"1": "DQ0_R", "3": "CLK", "5": "GND"}),
    part("U3", "U3", ic.id, "Receiver B", 60, 30, {"3": "CLK", "5": "GND"}),
    part("R1", "R1", r.id, "22R", 20, 10, {"1": "DQ0", "2": "DQ0_R"}),
    track("t-dq0", "DQ0", "Top", [[10, 10], [19.5, 10]]),
    track("t-dqr1", "DQ0_R", "Top", [[20.5, 10], [35, 10]]),
    via("v-dq1", "DQ0_R", 35, 10),
    track("t-dqr2", "DQ0_R", "Inner 2", [[35, 10], [55, 10]], 0.15),
    via("v-dq2", "DQ0_R", 55, 10, {backdrill: {from: "bottom", toLayer: "Inner 2", stubMax: 0.2}}),
    track("t-dqr3", "DQ0_R", "Top", [[55, 10], [60, 10]]),
    track("t-clk1", "CLK", "Top", [[10, 11.27], [12, 10.6], [45, 10.6], [58, 10.6], [60, 12.54]]),
    track("t-clk2", "CLK", "Top", [[45, 10.6], [45, 32.54], [60, 32.54]])
  );
  const p = {format: "atrium", version: 1, name: "SI demo", library: [ic, r], documents: [doc]};
  return A.validate(p);
}
module.exports = {project};
