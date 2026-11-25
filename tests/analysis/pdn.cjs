"use strict";
// PDN Analyzer (app/analysis/pdn.js): the DC sheet solver against analytic cases (uniform strip, a narrow
// 1D track, two vias in parallel, an L-shaped trace with the corner square), the return net,
// setup normalisation and the speed of a 100 × 160 mm four-layer pour.
const assert = require("node:assert/strict");
for (const m of ["model", "stackup", "pcb-pours", "pdn"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const P = AtriumPDN, S = AtriumStackup;
const now = () => globalThis.performance?.now?.() ?? Date.now();
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const near = (a, b, tol, m) => assert.ok(rel(a, b) <= tol, (m || "") + ": " + a + " vs " + b + " (" + (rel(a, b) * 100).toFixed(3) + " %)");
const out = [];
const log = s => { out.push(s); globalThis.print ? print(s) : console.log(s); };

// A footprint with two pads (rectangles) and an IC with N pads; parts carry pinNets.
const rect = (n, x, y, w, h, extra = {}) => ({number: String(n), x, y, w, h, shape: "rect", ...extra});
const def = (id, pads) => ({id, name: id, footprint: {pads, shapes: []}});
const part = (id, ref, d, x, y, pinNets, extra = {}) => ({id, kind: "part", ref, def: d, value: "", x, y, angle: 0, layer: "Top", pinNets, ...extra});
const twoLayer = () => ({version: 1, layers: S.build(["Signal", "Signal"]).layers});
const fourLayer = () => ({version: 1, layers: S.build(["Signal", "Plane", "Plane", "Signal"]).layers});
const board = (items, stackup = twoLayer(), outline = [[0, 0], [100, 0], [100, 100], [0, 100]]) => ({kind: "pcb", id: "b", name: "PDN", grid: .25, outline, notes: [], stackup, items});
const T = 25, RHO = P.rhoAt(T), tTop = S.get(board([])).layers.find(l => l.key === "Top").thickness;
const setup = (extra = {}) => P.normalize({temperature: T, ...extra});

// ---- 1. uniform strip: R = ρL/(wt) -------------------------------------------------------------
{
  // A 2 mm × 52 mm fill on Top; 2 × 2 mm pads cover each end, so the copper between the pad
  // edges is 48 mm long. Source at one end, 1 A load at the other.
  const defs = new Map([["pad1", def("pad1", [rect(1, 0, 0, 2, 2)])]]);
  for (const kind of ["fill", "track"]) {
    const strip = kind === "fill" ? {id: "s", kind: "track", net: "V", layer: "Top", fill: true, closed: true, width: 0, points: [[-1, -1], [51, -1], [51, 1], [-1, 1]]}
      : {id: "s", kind: "track", net: "V", layer: "Top", width: 2, points: [[0, 0], [50, 0]]};
    const doc = board([strip, part("p1", "J1", "pad1", 0, 0, {1: "V"}), part("p2", "U1", "pad1", 50, 0, {1: "V"})]);
    const net = {net: "V", voltage: 5, source: {ref: "J1"}, loads: [{ref: "U1", current: 1}]};
    const t0 = now(), r = P.analyze(doc, defs, net, setup({minPitch: .05})), ms = now() - t0;
    const want = RHO * 48 / (2 * tTop), got = r.report.loads[0].drop;
    near(got, want, .002, "uniform strip (" + kind + ")");
    near(r.report.power.supply, want, .002, "I²R power equals the drop at 1 A");
    log("strip " + kind + ": R = " + (got * 1000).toFixed(4) + " mΩ, analytic " + (want * 1000).toFixed(4) + " mΩ, error " + (rel(got, want) * 100).toFixed(3) + " %, pitch " + r.report.pitch + " mm, " + ms.toFixed(0) + " ms");
    // Current density in the strip: J = I/(w t).
    const J = 1 / (2 * tTop), jmax = r.report.density.find(d => d.layer === "Top").jMax;
    near(jmax, J, .03, "current density in the strip");
  }
}

// ---- 2. narrow track (exact 1D element) -------------------------------------------------------
{
  const defs = new Map([["pad1", def("pad1", [rect(1, 0, 0, 1, 1)])]]);
  const doc = board([{id: "t", kind: "track", net: "V", layer: "Top", width: .1, points: [[0, 0], [20, 0], [20, 10]]},
    part("p1", "J1", "pad1", 0, 0, {1: "V"}), part("p2", "U1", "pad1", 20, 10, {1: "V"})]);
  const r = P.analyze(doc, defs, {net: "V", voltage: 3.3, source: {ref: "J1"}, loads: [{ref: "U1", current: .5}]}, setup());
  const L = 20 - .5 + 10 - .5, want = .5 * RHO * L / (.1 * tTop), got = r.report.loads[0].drop;
  near(got, want, 1e-6, "narrow track from pad edge to pad edge");
  log("narrow track: drop " + (got * 1000).toFixed(4) + " mV, analytic " + (want * 1000).toFixed(4) + " mV, error " + (rel(got, want) * 100).toExponential(2) + " %");
  near(r.report.density.find(d => d.layer === "Top").jMax, .5 / (.1 * tTop), 1e-4, "density in the 1D track");
}

// ---- 3. two vias in parallel ------------------------------------------------------------------
{
  // Top pad (source) and Bottom pad (load) at the same place; one or two vias join them.
  const defs = new Map([["top", def("top", [rect(1, 0, 0, 3, 2)])]]);
  const st = twoLayer(), layers = P.copperStack(board([], st));
  const dz = layers[1].zMid - layers[0].zMid, drill = .3, tp = .025, A = Math.PI * (drill + tp) * tp, Rvia = RHO * dz / A;
  const viaLimit = .048 * Math.pow(10, .44) * Math.pow(A / (.0254 * .0254), .725);
  near(P.ipc2221(A, 10), viaLimit, 1e-12, "PDN via current");
  for (const n of [1, 2]) {
    const vias = [-.6, .6].slice(0, n).map((x, i) => ({id: "v" + i, kind: "via", net: "V", x, y: 0, diameter: .6, drill, layer: "Multi"}));
    const doc = board([part("p1", "J1", "top", 0, 0, {1: "V"}), part("p2", "U1", "top", 0, 0, {1: "V"}, {layer: "Bottom"}), ...vias], st);
    const r = P.analyze(doc, defs, {net: "V", voltage: 1, source: {ref: "J1"}, loads: [{ref: "U1", current: 2}]}, setup({plating: tp}));
    const want = 2 * Rvia / n, got = r.report.loads[0].drop;
    near(got, want, 1e-5, n + " via(s)");
    for (const v of r.report.vias) {
      near(v.current, 2 / n, 1e-4, "current per via");
      assert.equal(v.limit, Math.round(viaLimit * 1e4) / 1e4, "reported via limit");
    }
    log(n + " via" + (n > 1 ? "s in parallel" : "") + ": drop " + (got * 1000).toFixed(4) + " mV, analytic " + (want * 1000).toFixed(4) + " mV (R_via " + (Rvia * 1000).toFixed(4) + " mΩ), via current " + r.report.vias.map(v => v.current).join(", ") + " A");
  }
}

// ---- 4. L-shaped trace: corner square = 0.559 squares -----------------------------------------
{
  // Width w = 2 mm. Horizontal arm 20 mm (10 squares) from the source pad edge to the corner
  // square, corner square 2 × 2 mm, vertical arm 20 mm to the load pad edge.
  const w = 2, a = 20, p = 1;
  const defs = new Map([["ph", def("ph", [rect(1, 0, 0, p, w)])], ["pv", def("pv", [rect(1, 0, 0, w, p)])]]);
  const L = [[-p, 0], [a + w, 0], [a + w, w + a + p], [a, w + a + p], [a, w], [-p, w]];
  const doc = board([{id: "l", kind: "track", net: "V", layer: "Top", fill: true, closed: true, width: 0, points: L},
    part("p1", "J1", "ph", -p / 2, w / 2, {1: "V"}), part("p2", "U1", "pv", a + w / 2, w + a + p / 2, {1: "V"})]);
  const r = P.analyze(doc, defs, {net: "V", voltage: 5, source: {ref: "J1"}, loads: [{ref: "U1", current: 1}]}, setup({minPitch: .05}));
  const Rs = RHO / tTop, want = Rs * (a / w + .559 + a / w), naive = Rs * (a / w + 1 + a / w), got = r.report.loads[0].drop;
  near(got, want, .005, "L-shaped trace");
  assert.ok(rel(got, naive) > .015, "the corner is not counted as a full square");
  log("L-shaped trace: R = " + (got * 1000).toFixed(4) + " mΩ, analytic (corner 0.559 sq) " + (want * 1000).toFixed(4) + " mΩ, error " + (rel(got, want) * 100).toFixed(3) + " %; a 1D model (corner 1 sq) would be off by " + (rel(naive, want) * 100).toFixed(2) + " %");
}

// ---- 5. return net, per-pin loads, open load, limits ------------------------------------------
{
  const defs = new Map([["two", def("two", [rect(1, -1, 0, 1, 1), rect(2, 1, 0, 1, 1)])], ["ic", def("ic", [rect(1, -1, 0, 1, 1), rect(2, 1, 0, 1, 1), rect(3, 0, 2, 1, 1)])]]);
  const tr = (id, net, pts, w = .1) => ({id, kind: "track", net, layer: "Top", width: w, points: pts});
  const doc = board([part("j", "J1", "two", 0, 0, {1: "V", 2: "GND"}), part("u", "U1", "ic", 20, 0, {1: "V", 2: "GND", 3: "V"}), part("u2", "U2", "two", 40, 20, {1: "V", 2: "GND"}),
    tr("a", "V", [[-1, 0], [-1, -5], [19, -5], [19, 0]]), tr("b", "GND", [[1, 0], [1, 5], [21, 5], [21, 0]]), tr("c", "V", [[20, 2], [20, 10], [-20, 10]])]);
  const net = {net: "V", voltage: 3.3, source: {ref: "J1"}, loads: [{ref: "U1", pins: ["1"], current: .2, mode: "per-pin"}, {ref: "U2", current: .1}], returnNet: "GND", maxDropPct: .1};
  const r = P.analyze(doc, defs, net, setup()).report;
  const len = 5 - .5 + 20 + 5 - .5, R = RHO * len / (.1 * tTop);
  const u1 = r.loads.find(l => l.ref === "U1");
  near(u1.drop, 2 * .2 * R, 1e-6, "supply drop plus return rise");
  near(u1.supply, 3.3 - .2 * R, 1e-6);
  near(u1.ret, .2 * R, 1e-6, "ground rise at the load");
  assert.equal(u1.status, "fail", "drop over the 0.1 % limit");
  const u2 = r.loads.find(l => l.ref === "U2");
  assert.ok(u2.unreached && u2.status === "fail", "U2 is not connected");
  assert.ok(r.violations.some(v => v.kind === "pdn-open" && v.ref === "U2"));
  assert.ok(r.violations.some(v => v.kind === "pdn-drop" && v.ref === "U1"));
  // U1 pin 3 (copper "c" ends at an unconnected point) is a floating stub: no current, no error.
  assert.equal(P.normalizeNet({loads: [{current: -1, mode: "x"}]}).loads[0].current, 0, "currents clamp at 0");
  assert.equal(P.normalize({nets: [{net: "A", voltage: "5"}]}).nets[0].voltage, 5);
  assert.equal(P.voltageOf("+3V3"), 3.3); assert.equal(P.voltageOf("1V8"), 1.8); assert.equal(P.voltageOf("VCC_5V"), 5); assert.equal(P.voltageOf("12V"), 12);
  const g = P.guess(doc, defs, "V");
  assert.equal(g.source.ref, "J1"); assert.deepEqual(g.loads.map(l => l.ref), ["U1", "U2"]); assert.equal(g.returnNet, "GND");
  // Saved with the board and read back.
  const d2 = JSON.parse(JSON.stringify(doc));
  P.write(d2, {nets: [net]});
  assert.equal(P.read(JSON.parse(JSON.stringify(d2))).nets[0].loads[0].mode, "per-pin");
}

// ---- 6. MCP op ---------------------------------------------------------------------------------
{
  const defs = new Map([["pad1", def("pad1", [rect(1, 0, 0, 2, 2)])]]);
  const doc = board([{id: "s", kind: "track", net: "V", layer: "Top", width: .5, points: [[0, 0], [30, 0]]}, part("p1", "J1", "pad1", 0, 0, {1: "V"}), part("p2", "U1", "pad1", 30, 0, {1: "V"})]);
  P.write(doc, {nets: [{net: "V", voltage: 5, source: {ref: "J1"}, loads: [{ref: "U1", current: 1}]}]});
  const project = {library: [...defs.values()], documents: [doc]};
  const res = P.headless({}, {project: () => project, board: (p) => p.documents[0], defsOf: p => new Map(p.library.map(d => [d.id, d]))});
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].loads[0].ref, "U1");
  near(res.results[0].loads[0].drop_v, RHO * 28 / (.5 * tTop), 1e-6, "pdn_analyze drop");
  const g = P.headless({net: "V"}, {project: () => ({...project, documents: [{...doc, pdn: undefined}]}), board: p => p.documents[0], defsOf: p => new Map(p.library.map(d => [d.id, d]))});
  assert.equal(g.results[0].setup.source.ref, "J1", "a guessed setup when none is saved");
}

// ---- 7. speed: 100 × 160 mm, four layers fully poured, 160 stitching vias --------------------
{
  const W = 100, H = 160, items = [];
  for (const layer of ["Top", "Inner 1", "Inner 2", "Bottom"]) items.push({id: "f" + layer, kind: "polygon", net: "P", layer, points: [[0, 0], [W, 0], [W, H], [0, H]]});
  for (let i = 0; i < 160; i++) items.push({id: "v" + i, kind: "via", net: "P", x: 5 + (i % 10) * 10, y: 5 + Math.floor(i / 10) * 10, diameter: .6, drill: .3, layer: "Multi"});
  const defs = new Map([["pad1", def("pad1", [rect(1, 0, 0, 3, 3)])]]);
  items.push(part("j", "J1", "pad1", 3, 3, {1: "P"}));
  for (const [k, [x, y]] of [[90, 150], [50, 80], [90, 20], [20, 140]].entries()) items.push(part("u" + k, "U" + (k + 1), "pad1", x, y, {1: "P"}));
  const doc = board(items, fourLayer(), [[0, 0], [W, 0], [W, H], [0, H]]);
  const net = {net: "P", voltage: 1.2, source: {ref: "J1"}, loads: [1, 2, 3, 4].map(k => ({ref: "U" + k, current: 2.5}))};
  const t0 = now(), r = P.analyze(doc, defs, net, setup()), ms = now() - t0, s = r.supply.stats;
  log("speed 100 × 160 mm, 4 layers poured: " + ms.toFixed(0) + " ms total (mesh " + s.ms.mesh.toFixed(0) + ", factor " + s.ms.factor.toFixed(0) + ", solve " + s.ms.solve.toFixed(0) + ", post " + s.ms.post.toFixed(0) +
    " ms); pitch " + r.report.pitch + " mm, " + s.cells + " cells, " + s.nodes + " nodes after coarsening, " + s.iterations + " CG iterations, residual " + s.residual.toExponential(1));
  assert.ok(r.report.loads.every(l => l.status === "ok" && l.drop > 0 && l.drop < .01), "plausible drops on a solid four-layer pour");
  assert.ok(s.cells <= 4e6 * 1.6, "the grid is capped");
  assert.ok(ms < 8000, "solves in seconds");
}

// ---- 8. quadtree coarsening agrees with the uniform fine grid ----------------------------------
{
  const W = 40, H = 30, items = [];
  for (const layer of ["Top", "Bottom"]) items.push({id: "f" + layer, kind: "polygon", net: "P", layer, points: [[0, 0], [W, 0], [W, H], [W / 2, H], [W / 2, H / 2], [0, H / 2]]});
  items.push({id: "hole", kind: "track", net: "P", layer: "Top", width: 3, points: [[5, 10], [30, 5]]});
  for (let i = 0; i < 6; i++) items.push({id: "v" + i, kind: "via", net: "P", x: 3 + 6 * i, y: 3, diameter: .6, drill: .3, layer: "Multi"});
  const defs = new Map([["pad1", def("pad1", [rect(1, 0, 0, 2, 2)])]]);
  items.push(part("j", "J1", "pad1", 2, 12, {1: "P"}), part("u", "U1", "pad1", 37, 27, {1: "P"}, {layer: "Bottom"}), part("u2", "U2", "pad1", 30, 2, {1: "P"}));
  const doc = board(items, twoLayer(), [[0, 0], [W, 0], [W, H], [0, H]]);
  const net = {net: "P", voltage: 5, source: {ref: "J1"}, loads: [{ref: "U1", current: 3}, {ref: "U2", current: 1}]};
  const run = noBlocks => { const j = P.job(doc, defs, net, setup({minPitch: .1}), "supply"); j.noBlocks = noBlocks; return P.solve(j); };
  const a = run(false), b = run(true);
  for (const k of [1, 2]) near(a.terms[k].u, b.terms[k].u, .005, "coarsened vs uniform grid, load " + k);
  log("coarsening: " + a.stats.nodes + " nodes vs " + b.stats.nodes + " uniform; load drops " + a.terms.slice(1).map(t => (t.u * 1000).toFixed(4)).join(", ") + " mV vs " + b.terms.slice(1).map(t => (t.u * 1000).toFixed(4)).join(", ") + " mV");
}

// Colour ramp: boundary, fractional and invalid samples stay on the fixed triples.
{
  const first = [68, 1, 84], last = [253, 231, 37], mid = [70, 18.5, 100.5];
  for (const t of [0, -0.25, NaN, null, undefined, -Infinity]) assert.deepEqual(P.ramp(t), first, "pdn ramp boundary " + t);
  for (const t of [1, 1.5, Infinity]) assert.deepEqual(P.ramp(t), last, "pdn ramp end " + t);
  assert.deepEqual(P.ramp(0.05), mid, "fractional ramp stop stays between the first two viridis stops");
  assert.equal(P.rgb(0.05), "rgb(70,19,101)");
  assert.equal(P.rgb(NaN), "rgb(68,1,84)");
  assert.equal(P.rgb(1), "rgb(253,231,37)");
  const legend = "linear-gradient(to right,rgb(68,1,84) 0%,rgb(72,36,117) 10%,rgb(65,68,135) 20%,rgb(53,95,141) 30%,rgb(42,120,142) 40%,rgb(33,145,140) 50%,rgb(34,168,132) 60%,rgb(68,191,112) 70%,rgb(122,209,81) 80%,rgb(189,223,38) 90%,rgb(253,231,37) 100%)";
  assert.equal(P.gradient(), legend);
  assert.equal(P.gradient("to top"), legend.replace("to right", "to top"));
  const stand = P.paletteRamp([[0, 0, 0], [10, 20, 40], [100, 0, 0], [0, 0, 255]]);
  assert.deepEqual(stand.ramp(1 / 6), [5, 10, 20], "rounding the fractional stop would snap to 10,20,40");
  assert.equal(stand.rgb(1 / 6), "rgb(5,10,20)");
  const light = P.paletteRamp([[255, 255, 255], [200, 180, 20], [0, 80, 200], [0, 0, 0]]);
  assert.deepEqual(light.ramp(1 / 6), [227.5, 217.5, 137.5]);
  assert.equal(light.rgb(1 / 6), "rgb(228,218,138)");
  log("colour ramp: fractional t=0.05 is 70,18.5,100.5; stand-in t=1/6 is 5,10,20");
}

log("SHIM-OK pdn");
// ---- 9. plated barrel: non-default hole and asymmetric spacing ---------------------------------
{
  const drill = .8, tp = .035, Tvia = 85, rise = 20, Lmm = 1.6;
  const annulus = Math.PI * ((drill / 2 + tp) ** 2 - (drill / 2) ** 2);
  const area = P.core.platedBarrelArea(drill, tp);
  near(area, annulus, 1e-12, "plated barrel area is the annulus, not the drill disk");
  near(area, 0.0918130453012, 1e-9, "non-default barrel area");
  const rho = P.rhoAt(Tvia);
  near(rho * Lmm / area, 0.000377205019248, 1e-9, "analytic resistance of a 1.6 mm barrel");
  near(area * 1e-6 / (Lmm * 1e-3), 0.0000573831533132, 1e-9, "conductance per unit conductivity");
  near(P.ipc2221(area, rise), 6.52816662691, 1e-9, "IPC-2221 current of the barrel");
  const defs = new Map([["top", def("top", [rect(1, 0, 0, 4, 4)])]]);
  const st = twoLayer(), layers = P.copperStack(board([], st)), dz = layers[1].zMid - layers[0].zMid;
  const run = (vias, current) => {
    const doc = board([part("p1", "J1", "top", 0, 0, {1: "V"}), part("p2", "U1", "top", 0, 0, {1: "V"}, {layer: "Bottom"}), ...vias], st);
    return P.analyze(doc, defs, {net: "V", voltage: 1, source: {ref: "J1"}, loads: [{ref: "U1", current}]}, setup({plating: tp, temperature: Tvia, viaRise: rise}));
  };
  const via = (id, x, y) => ({id, kind: "via", net: "V", x, y, diameter: drill + .4, drill, layer: "Multi"});
  const one = run([via("v0", 0, 0)], 1);
  near(one.report.loads[0].drop, rho * dz / area, 1e-5, "non-default plated-hole resistance");
  near(one.report.vias[0].limit, P.ipc2221(annulus, rise), 5e-4, "via current limit uses the annulus");
  const pair = (dx, dy) => run([via("va", -dx / 2, -dy / 2), via("vb", dx / 2, dy / 2)], 1);
  const wide = pair(.35, 1.27), tall = pair(1.27, .35);
  near(wide.report.loads[0].drop, rho * dz / area / 2, 1e-5, "two barrels at 0.35×1.27 mm");
  near(tall.report.loads[0].drop, wide.report.loads[0].drop, 1e-9, "asymmetric spacing 0.35×1.27 mm matches 1.27×0.35 mm");
  log("plated barrel " + drill + " mm / " + (tp * 1000) + " µm at " + Tvia + " °C: R " + one.report.loads[0].drop.toExponential(6) + " Ω over " + dz.toFixed(4) + " mm; 0.35×1.27 matches 1.27×0.35");
}
