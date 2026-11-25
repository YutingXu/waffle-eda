"use strict";
// Temperature Rise Map (app/analysis/thermal.js): the grid solver against closed forms (a uniformly heated
// plate with convection, one layer and two layers through the dielectric; a 1D convecting fin
// with a held base), the direction of a thermal-via array, board extraction (part power from a
// parameter, variant DNP, PDN I²R scaled to the PDN's power), the MCP op and the speed.
const assert = require("node:assert/strict");
for (const m of ["model", "stackup", "pcb-pours", "pdn", "variants", "thermal"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const TH = AtriumThermal, P = AtriumPDN, S = AtriumStackup;
const now = () => globalThis.performance?.now?.() ?? Date.now();
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const near = (a, b, tol, m) => assert.ok(rel(a, b) <= tol, (m || "") + ": " + a + " vs " + b + " (" + (rel(a, b) * 100).toFixed(3) + " %)");
const log = s => globalThis.print ? print(s) : console.log(s);
const flat = pts => Float64Array.from(pts.flat());
const rect = (x0, y0, x1, y1) => flat([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
// A synthetic job: W × H mm, one copper sheet per layer fully covered unless given.
function plate({W = 50, H = 50, h = .5, layers = [{t: .035}], gaps = [], hTop = 10, hBottom = 10, edge = {mode: "adiabatic"}, sinks = [], vias = [], fill = true}) {
  const x0 = -h, y0 = -h, nx = Math.round(W / h) + 2, ny = Math.round(H / h) + 2, n = nx * ny;
  return {x0, y0, nx, ny, h, outline: [rect(0, 0, W, H)], kCu: 385, plating: .025,
    layers: layers.map((l, i) => ({key: "L" + i, t: l.t, kd: l.kd || 0, td: l.td || 0, shapes: fill === true || fill[i] ? [[rect(0, 0, W, H)]] : l.shapes || [], tracks: []})),
    gaps, vias, hTop, hBottom, edge, sinks, q: layers.map(() => new Float64Array(n)), tol: 1e-12, maxIter: 50000, meta: {}};
}
const cellOf = (j, x, y) => Math.floor((y - j.y0) / j.h) * j.nx + Math.floor((x - j.x0) / j.h);

// ---- 1. uniformly heated plate, convection both faces, adiabatic edges: ΔT = P / ((hT + hB)·A)
{
  const j = plate({}), P0 = 2;
  for (let iy = 0; iy < j.ny; iy++) for (let ix = 0; ix < j.nx; ix++) {
    const x = j.x0 + (ix + .5) * j.h, y = j.y0 + (iy + .5) * j.h;
    if (x > 0 && x < 50 && y > 0 && y < 50) j.q[0][iy * j.nx + ix] = P0 / (100 * 100);
  }
  const r = TH.solve(j), want = P0 / ((10 + 10) * 50e-3 * 50e-3);
  near(r.layers[0].max, want, 1e-6, "uniform plate (max)");
  near(r.layers[0].mean, want, 1e-6, "uniform plate (mean)");
  assert.ok(Math.abs(r.balance) < 1e-6, "energy balance " + r.balance);
  log("uniform plate: ΔT " + r.layers[0].max.toFixed(4) + " °C vs closed form " + want.toFixed(4) + " °C, error " + (rel(r.layers[0].max, want) * 100).toExponential(2) + " %");
}
// ---- 2. two layers through 1.5 mm FR-4, heat on the top only
{
  const kz = .3, d = 1.5, hT = 10, hB = 6, P0 = 1, A = 40e-3 * 40e-3;
  const j = plate({W: 40, H: 40, layers: [{t: .035}, {t: .035}], gaps: [{d, kz}], hTop: hT, hBottom: hB});
  for (let iy = 0; iy < j.ny; iy++) for (let ix = 0; ix < j.nx; ix++) { const x = j.x0 + (ix + .5) * j.h, y = j.y0 + (iy + .5) * j.h; if (x > 0 && x < 40 && y > 0 && y < 40) j.q[0][iy * j.nx + ix] = P0 / (80 * 80); }
  const Gz = kz * A / (d * 1e-3), Tb = 1, Tt = (Gz + hB * A) / Gz;          // Tt per unit Tb from the bottom balance
  const scale = P0 / (hT * A * Tt + hB * A * Tb), wantT = Tt * scale, wantB = Tb * scale;
  const r = TH.solve(j);
  near(r.layers[0].max, wantT, 1e-6, "two-layer plate, top");
  near(r.layers[1].max, wantB, 1e-6, "two-layer plate, bottom");
  log("two-layer plate: top " + r.layers[0].max.toFixed(4) + " / " + wantT.toFixed(4) + " °C, bottom " + r.layers[1].max.toFixed(4) + " / " + wantB.toFixed(4) + " °C");
}
// ---- 3. 1D fin: copper strip, h on both faces, base held at θb, adiabatic tip
{
  const h = .25, W = 100, Wd = 5, t = .1, hc = 15, thb = 10;
  const j = plate({W, H: Wd, h, layers: [{t}], hTop: hc, hBottom: hc, sinks: [{layer: 0, ring: rect(-1, -1, h, Wd + 1), rise: thb}]});
  const r = TH.solve(j), m = Math.sqrt(2 * hc / (385 * t * 1e-3)), xb = h / 2, L = (W - xb) * 1e-3;
  let worst = 0;
  for (const x of [5, 10, 20, 40, 60, 99.8]) {
    const c = cellOf(j, x, Wd / 2), xc = j.x0 + ((c % j.nx) + .5) * h, s = (xc - xb) * 1e-3;
    const want = thb * Math.cosh(m * (L - s)) / Math.cosh(m * L), got = r.layers[0].t[c];
    worst = Math.max(worst, Math.abs(got - want) / thb);
  }
  // Heat through the base: k A m θb tanh(mL) (A the strip cross-section).
  const Q = 385 * (Wd * 1e-3 * t * 1e-3) * m * thb * Math.tanh(m * L);
  assert.ok(worst < .005, "fin profile within 0.5 % of θb: " + (worst * 100).toFixed(3) + " %");
  log("1D fin (mL " + (m * L).toFixed(2) + "): worst error " + (worst * 100).toFixed(3) + " % of θb; analytic base heat " + (Q * 1000).toFixed(2) + " mW");
}
// ---- 4. board extraction: a part's power, a thermal-via array lowers its temperature
const defs = new Map([["qfn", {id: "qfn", name: "qfn", parameters: {"Power Dissipation": "1.5 W"}, footprint: {pads: [{number: "EP", x: 0, y: 0, w: 4, h: 4, shape: "rect"}], shapes: []}}],
  ["r", {id: "r", name: "r", parameters: {Power: "0.25W"}, footprint: {pads: [{number: "1", x: -.5, y: 0, w: .6, h: .6, shape: "rect"}, {number: "2", x: .5, y: 0, w: .6, h: .6, shape: "rect"}], shapes: []}}]]);
const twoLayer = () => ({version: 1, layers: S.build(["Signal", "Signal"]).layers});
function board(items, stackup = twoLayer()) { return {kind: "pcb", id: "b", name: "T", grid: .25, outline: [[0, 0], [40, 0], [40, 40], [0, 40]], notes: [], stackup, items}; }
const part = (id, ref, def, x, y, extra = {}) => ({id, kind: "part", ref, def, x, y, angle: 0, layer: "Top", value: "", pinNets: {}, ...extra});
{
  const plane = {id: "gp", kind: "polygon", net: "GND", layer: "Bottom", points: [[1, 1], [39, 1], [39, 39], [1, 39]]};
  const base = [part("u1", "U1", "qfn", 20, 20), part("r1", "R1", "r", 5, 5), plane];
  const viaArray = [];
  for (let a = -1.2; a <= 1.21; a += .8) for (let b = -1.2; b <= 1.21; b += .8) viaArray.push({id: "v" + viaArray.length, kind: "via", net: "GND", x: 20 + a, y: 20 + b, diameter: .6, drill: .3});
  const setup = TH.normalize({pitch: .25, minPitch: .1, includePDN: false});
  const pw = TH.powers(board(base), defs, null, setup);
  assert.deepEqual(pw.map(p => [p.ref, p.power]), [["U1", 1.5]], "Power Dissipation counts; a resistor's Power (a rating) does not");
  assert.ok(pw.ignored.includes("R1"));
  const a = TH.analyze(board(base), defs, setup), b = TH.analyze(board([...base, ...viaArray]), defs, setup);
  const ta = a.report.summary.maxRise, tb = b.report.summary.maxRise;
  near(a.report.summary.power, 1.5, 1e-9, "total power");
  assert.ok(Math.abs(a.result.balance) < 1e-4 && Math.abs(b.result.balance) < 1e-4, "energy balance");
  assert.ok(tb < ta * .9, "a 4 × 4 thermal-via array to a bottom plane lowers the peak: " + ta + " → " + tb);
  // Bottom plane gets hotter with the vias (heat reaches it).
  assert.ok(b.report.layers[1].maxRise > a.report.layers[1].maxRise, "vias carry heat to the bottom");
  assert.equal(a.report.hotspots[0].ref, "U1");
  log("thermal vias: U1 peak rise " + ta + " °C → " + tb + " °C with 16 vias (" + ((1 - tb / ta) * 100).toFixed(1) + " % lower); bottom " + a.report.layers[1].maxRise + " → " + b.report.layers[1].maxRise + " °C");
  // A heatsink held at ambient under U1 cools it further; forced air cools the whole board.
  const sink = TH.analyze(board(base), defs, TH.normalize({...setup, sinks: [{side: "bottom", box: [15, 15, 25, 25], mode: "fixed", rise: 0}]}));
  log("cold plate under U1 (no vias): " + sink.report.summary.maxRise + " °C");
  assert.ok(sink.report.summary.maxRise < ta, "cold plate under the part");
  const forced = TH.analyze(board(base), defs, TH.normalize({...setup, air: "forced-3"}));
  assert.ok(forced.report.summary.maxRise < ta, "forced air");
  // A panel value wins; DNP parts and variants drop out.
  assert.equal(TH.powers(board(base), defs, null, TH.normalize({power: {U1: 3}}))[0].power, 3);
  assert.equal(TH.powers(board([part("u1", "U1", "qfn", 20, 20, {dnp: true})]), defs, null, setup).length, 0);
  assert.equal(TH.parsePower("250 mW"), .25);
}
// ---- 5. PDN I²R: a 2 A load through a narrow track heats it; total equals the PDN power
{
  const pd = new Map([["pad1", {id: "pad1", name: "pad1", footprint: {pads: [{number: "1", x: 0, y: 0, w: 2, h: 2, shape: "rect"}], shapes: []}}]]);
  const doc = board([{id: "t", kind: "track", net: "V", layer: "Top", width: .2, points: [[5, 20], [35, 20]]},
    part("p1", "J1", "pad1", 5, 20, {pinNets: {1: "V"}}), part("p2", "U1", "pad1", 35, 20, {pinNets: {1: "V"}})]);
  doc.pdn = P.normalize({nets: [{net: "V", voltage: 5, source: {ref: "J1"}, loads: [{ref: "U1", current: 2}]}]});
  const r = TH.analyze(doc, pd, TH.normalize({pitch: .25, minPitch: .1}));
  const pdn = P.analyze(doc, pd, doc.pdn.nets[0], doc.pdn).report.power.supply;
  near(r.result.meta.sources.pdn, pdn, 1e-6, "PDN I²R total");
  const mid = r.report.hotspots[0];
  assert.ok(mid && Math.abs(mid.at[1] - 20) < 1 && mid.at[0] > 10 && mid.at[0] < 30, "the hottest point is on the track");
  log("PDN heating: " + (pdn * 1000).toFixed(1) + " mW in a 0.2 mm track at 2 A → peak rise " + r.report.summary.maxRise + " °C at " + mid.at.join(", "));
}
// ---- 6. MCP op and speed on a 100 × 160 mm four-layer board
{
  const st = {version: 1, layers: S.build(["Signal", "Plane", "Plane", "Signal"]).layers};
  const items = [];
  for (const [k, l] of [["Inner 1", "GND"], ["Inner 2", "P"]]) items.push({id: "pl" + k, kind: "polygon", net: l, layer: k, points: [[1, 1], [99, 1], [99, 159], [1, 159]]});
  for (let i = 0; i < 12; i++) items.push(part("u" + i, "U" + (i + 1), "qfn", 15 + (i % 3) * 35, 20 + Math.floor(i / 3) * 38));
  for (let i = 0; i < 400; i++) items.push({id: "v" + i, kind: "via", net: "GND", x: 3 + (i % 20) * 4.8, y: 3 + Math.floor(i / 20) * 7.9, diameter: .6, drill: .3});
  for (let i = 0; i < 300; i++) items.push({id: "t" + i, kind: "track", net: "S" + i, layer: i % 2 ? "Top" : "Bottom", width: .15, points: [[2 + (i % 30) * 3.2, 5 + Math.floor(i / 30) * 15], [2 + (i % 30) * 3.2, 15 + Math.floor(i / 30) * 15]]});
  const doc = {kind: "pcb", id: "big", name: "big", outline: [[0, 0], [100, 0], [100, 160], [0, 160]], stackup: st, items, notes: []};
  const t0 = now(), r = TH.analyze(doc, defs, TH.normalize({includePDN: false})), ms = now() - t0, s = r.result.stats;
  log("speed: 100 × 160 mm, 4 layers, " + s.nodes.toLocaleString() + " nodes at " + r.result.grid.h + " mm, " + s.iterations + " CG iterations, total " + ms.toFixed(0) + " ms (raster " + s.ms.raster.toFixed(0) +
    ", assemble " + s.ms.assemble.toFixed(0) + ", factor " + s.ms.factor.toFixed(0) + ", CG " + s.ms.solve.toFixed(0) + ", post " + s.ms.post.toFixed(0) + "; job " + (ms - s.ms.total).toFixed(0) + ")");
  assert.ok(Math.abs(r.result.balance) < 1e-3, "energy balance on the big board: " + r.result.balance);
  assert.ok(ms < 8000, "solve time " + ms);
  const host = {project: () => ({documents: [doc], library: [...defs.values()]}), board: (p, id) => p.documents[0], defsOf: () => defs};
  const out = TH.headless({max_hotspots: 5}, host);
  assert.equal(out.estimate, true);
  assert.ok(out.hotspots.length >= 1 && out.hotspots.length <= 5 && out.summary.power === 18);
  assert.ok(/ESTIMATE/.test(out.model));
  // Setup normalisation clamps and keeps only valid sinks.
  const n = TH.normalize({air: "custom", hTop: -5, sinks: [{box: [0, 0, 1]}, {box: [0, 0, 1, 1], side: "bottom", mode: "fixed"}]});
  assert.equal(n.hTop, .1); assert.equal(n.sinks.length, 1); assert.equal(n.sinks[0].side, "bottom");
}
// Cancel on both sides of readiness, including a late reply from terminate().
{
  const fs = require("node:fs"), vm = require("node:vm");
  const files = require("../support/app-source-paths.cjs");
  const deadlines = new Map();
  let timer = 0, worker;
  const realm = vm.createContext({
    Blob: class {},
    URL: {createObjectURL: () => "blob:solver", revokeObjectURL() {}},
    Worker: class {
      constructor() { worker = this; }
      postMessage() {}
      terminate() { const late = this.late; this.late = null; late?.({data: {type: "result", value: {}}}); }
    },
    setTimeout(fn, ms) { deadlines.set(++timer, ms); return timer; },
    clearTimeout(id) { deadlines.delete(id); }
  });
  for (const name of ["worker-pool", "electrical-material", "pdn", "thermal"]) vm.runInContext(fs.readFileSync(files.appFile(name + ".js"), "utf8"), realm);
  Promise.all([realm.AtriumPDN, realm.AtriumThermal].flatMap(api => [false, true].map(ready => {
    const request = api.run({meta: {}, q: []});
    if (ready) worker.onmessage({data: {type: "ready"}});
    assert.equal([...deadlines.values()].includes(4000), !ready, "only an unready worker has a startup deadline");
    worker.late = worker.onmessage;
    const rejected = assert.rejects(request.promise, /Cancelled\./);
    request.cancel();
    assert.ok(![...deadlines.values()].includes(4000), "cancel removes the startup timeout");
    return rejected;
  }))).catch(error => { console.error(error); process.exitCode = 1; });
}
// Colour ramps: boundary, fractional and invalid samples stay on the fixed theme triples.
{
  const t = 1 / 16, dark0 = [70, 30, 12], dark1 = [254, 230, 210], light0 = [253, 236, 222], light1 = [110, 38, 10];
  for (const bad of [0, -0.25, NaN, null, undefined, -Infinity]) {
    assert.deepEqual(TH.ramp(bad), dark0, "thermal dark boundary " + bad);
    assert.deepEqual(TH.ramp(bad, false), light0, "thermal light boundary " + bad);
  }
  for (const hi of [1, 1.5, Infinity]) {
    assert.deepEqual(TH.ramp(hi, true), dark1);
    assert.deepEqual(TH.ramp(hi, false), light1);
  }
  assert.deepEqual(TH.ramp(t), [87, 36, 13], "fractional dark stop stays between the first two stops");
  assert.deepEqual(TH.ramp(t, false), [252.5, 225, 204]);
  assert.equal(TH.rgb(t), "rgb(87,36,13)");
  assert.equal(TH.rgb(t, false), "rgb(253,225,204)");
  assert.equal(TH.rgb(NaN, false), "rgb(253,236,222)");
  assert.equal(TH.rgb(t, null), "rgb(253,225,204)");
  const darkLegend = "linear-gradient(to right,rgb(70,30,12) 0%,rgb(104,42,14) 13%,rgb(140,55,17) 25%,rgb(178,70,22) 38%,rgb(214,92,36) 50%,rgb(236,124,66) 63%,rgb(246,160,110) 75%,rgb(251,197,160) 88%,rgb(254,230,210) 100%)";
  const lightLegend = "linear-gradient(to right,rgb(253,236,222) 0%,rgb(252,214,186) 13%,rgb(249,186,145) 25%,rgb(244,155,103) 38%,rgb(235,122,65) 50%,rgb(216,92,36) 63%,rgb(184,69,22) 75%,rgb(147,52,15) 88%,rgb(110,38,10) 100%)";
  assert.equal(TH.gradient(), darkLegend);
  assert.equal(TH.gradient(true), darkLegend);
  assert.equal(TH.gradient(false), lightLegend);
  assert.equal(TH.gradient("to top"), darkLegend, "a direction string is a truthy dark flag and does not change the direction");
  assert.equal(TH.gradient(false, "to top"), lightLegend.replace("to right", "to top"));
  assert.deepEqual(TH.ramp(t, true), P.paletteRamp(TH.RAMP_DARK).ramp(t));
  assert.equal(TH.rgb(t, false), P.paletteRamp(TH.RAMP_LIGHT).rgb(t));
  assert.equal(TH.gradient(false, "to bottom"), P.paletteRamp(TH.RAMP_LIGHT).gradient("to bottom"));
  log("colour ramp: dark t=1/16 is 87,36,13; light is 252.5,225,204");
}

log("thermal: ok");
// ---- 7. plated barrel conductance: non-default hole, asymmetric spacing
{
  const drill = .8, tp = .035, gap = 1.6;
  const annulus = Math.PI * ((drill / 2 + tp) ** 2 - (drill / 2) ** 2);
  const G = 385 * (annulus * 1e-6) / (gap * 1e-3);
  const via = (x, y) => ({x, y, from: 0, to: 1, drill, plating: tp});
  const rise = (vias, heat) => {
    const j = plate({W: 2, H: 2, h: 2, layers: [{t: 0}, {t: 0}], gaps: [{d: gap, kz: 0}], hTop: 0, hBottom: 0, plating: tp,
      vias, sinks: [{layer: 1, ring: rect(0, 0, 2, 2), rise: 0}]});
    const c = cellOf(j, 1, 1);
    j.q[0][c] = heat;
    return TH.solve(j).layers[0].t[c];
  };
  near(rise([via(1, 1)], G), 1, 1e-6, "non-default barrel conductance kA/L");
  const pair = (dx, dy) => [via(1 - dx / 2, 1 - dy / 2), via(1 + dx / 2, 1 + dy / 2)];
  const wide = rise(pair(.35, 1.27), G), tall = rise(pair(1.27, .35), G);
  near(wide, .5, 1e-6, "two barrels at 0.35×1.27 mm");
  near(tall, wide, 1e-9, "asymmetric spacing 1.27×0.35 mm matches");
  log("plated barrel conductance: one via " + (G).toExponential(6) + " W/K; 0.35×1.27 matches 1.27×0.35");
}
// Annealed copper at 0 °C, the 20 °C reference, and 100 °C. Explicit resistivity is the sibling.
{
  require(require("../support/app-source-paths.cjs").appFile("calculators.js"));
  const analytical = T => 1.7241e-5 * (1 + 0.00393 * (T - 20));
  assert.equal(analytical(20), 1.7241e-5, "reference control");
  const doc = board([]), t = P.copperStack(doc).find(l => l.key === "Top").t;
  const h = 10, j = 1, cv = 255, cell = h * h, heat = rho => rho * j * j * t * cell * cv / 255;
  const setup = TH.normalize({includeParts: false, pitch: h, minPitch: h});
  const grid = {h, nx: 1, ny: 1, x0: 0, y0: 0, cov: Uint8Array.of(cv), j: Float64Array.of(j)};
  const message = "fixed hotter/colder copper values must distinguish it from the reference control";
  for (const T of [-20, 0, 20, 100]) {
    const want = analytical(T);
    assert.equal(AtriumCalc._internal.resistance(1, 1, T), 1.7241e-8 * (1 + 0.00393 * (T - 20)) * 1e3, message);
    assert.equal(P.rhoAt(T), want, message);
    assert.equal(P.RHO20, 1.7241e-5, message);
    const res = {meta: {temperature: T, net: "V"}, layers: [{key: "Top", grid}]};
    assert.equal(TH.job(doc, new Map(), setup, {pdn: [res]}).meta.sources.pdn, heat(want), message);
  }
  globalThis.AtriumPDN = {...P, rhoAt: undefined};
  try {
    const legacy = {meta: {temperature: 100, net: "V"}, layers: [{key: "Top", grid}]};
    assert.equal(TH.job(doc, new Map(), setup, {pdn: [legacy]}).meta.sources.pdn, heat(1.7241e-5), "no PDN resistivity API uses the reference");
  } finally { globalThis.AtriumPDN = P; }
  const sibling = {rho: 2.5e-5, meta: {temperature: 100, net: "V"}, layers: [{key: "Top", grid}]};
  assert.equal(TH.job(doc, new Map(), setup, {pdn: [sibling]}).meta.sources.pdn, heat(2.5e-5), "explicit resistivity");
  log("annealed copper: −20 °C, 0 °C, 20 °C and 100 °C match; explicit 2.5e-5 stays");
}
