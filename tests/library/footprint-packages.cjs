"use strict";
// Footprint wizard package families (app/library/footprint-packages.js with app/library/footprint-wizard.js):
// 1. every family × preset: valid definition, footprint checks clean (no warnings), courtyard holds
//    all copper, silk at SILK_W and ≥ 0.2 mm from copper, assembly body and height, deterministic,
//    and DFM-clean on the JLCPCB 2-layer preset (app/checks/dfm.js);
// 2. goldens of representative presets (tests/goldens/footprint-packages.json);
// 3. a cross-check against KiCad's IPC-generated footprints (published land values, see
//    docs/footprint-wizard.md for the supported package families);
// 4. densities A and C, family features (quad side counts, exposed pads, staggered / mapped BGAs,
//    DPAK tabs, PLCC numbering, mounting-hole vias, fiducials, net ties, connectors);
// 5. CSV batch and the read-only headless entry point (MCP footprint_wizard).
// Golden refresh: FPW_GOLDEN=emit prints the file between @@GOLDEN and @@END.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "pcb-text-rich", "pcb-text", "board-shape", "hierarchy", "component-classes", "query", "stackup", "rules", "viastack",
  "polygon-pour", "fab-presets", "fab-presets/jlcpcb", "dfm", "library-panel", "footprint-wizard", "footprint-packages", "generic-parts", "connector-gen"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const W = AtriumFootprintWizard, L = AtriumLibrary, D = AtriumDFM, LIM = AtriumFabPresets.limits("jlcpcb-2l");
const near = (a, b, t, msg) => assert.ok(Math.abs(a - b) <= t + 1e-9, (msg || "") + ": expected " + b + " ± " + t + ", got " + a);
const padBox = p => { const a = Math.abs(Math.round((p.angle || 0) / 90)) % 2, w = a ? p.h : p.w, h = a ? p.w : p.h; return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2]; };
// Distance from segment a-b to an axis-aligned box (0 when they meet).
function segBox(a, b, r) {
  const inside = p => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
  if (inside(a) || inside(b)) return 0;
  const ps = (p, q, s) => { const dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((s[0] - p[0]) * dx + (s[1] - p[1]) * dy) / L2)) : 0; return Math.hypot(p[0] + dx * t - s[0], p[1] + dy * t - s[1]); };
  const cs = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  for (let i = 0; i < 4; i++) { const c = cs[i], d = cs[(i + 1) % 4]; if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0; }
  const dPt = p => Math.max(r[0] - p[0], 0, p[0] - r[2]) ** 2 + Math.max(r[1] - p[1], 0, p[1] - r[3]) ** 2;
  return Math.min(Math.sqrt(dPt(a)), Math.sqrt(dPt(b)), ...cs.map(c => ps(a, b, c)));
}
const MECH = new Set(["mounting", "fiducial", "nettie", "testpad", "cardedge"]);
const NEW = new Set(W.FAMILIES.filter(f => !["chip", "melf", "sod", "sot23", "sot223", "gullwing", "nolead", "bga", "header", "dip", "smdheader"].includes(f.id)).map(f => f.id));

// ------------------------------------------------------------ 1. every family × preset
{
  assert.ok(W.FAMILIES.length >= 50, "at least 50 families");
  assert.deepEqual([...new Set(W.FAMILIES.map(f => f.group))].sort(), ["Mechanical", "SMD", "THT"]);
  let count = 0;
  for (const f of W.FAMILIES) for (const p of f.presets) {
    const tag = f.id + " " + p, a = W.generate({family: f.id, preset: p, id: "x"}), b = W.generate({family: f.id, preset: p, id: "x"});
    assert.equal(JSON.stringify(a), JSON.stringify(b), "deterministic " + tag);
    const fp = a.footprint, v = L.validateDef(a, {footprintWarnings: false});
    assert.ok(v.ok, tag + ": " + v.errors.join("; "));
    assert.deepEqual(L.checkFootprint(fp).filter(x => x.level !== "info").map(x => x.message), [], "footprint checks " + tag);
    assert.ok(fp.name && fp.ipc.name, "name " + tag);
    // Courtyard (Mechanical 15) holds every pad, thermal vias included.
    const c = fp.courtyard;
    assert.ok(fp.shapes.some(s => s.layer === "Mechanical 15"), "courtyard shape " + tag);
    for (const q of fp.pads) { const r = padBox(q); assert.ok(r[0] >= c[0] - 1e-6 && r[1] >= c[1] - 1e-6 && r[2] <= c[2] + 1e-6 && r[3] <= c[3] + 1e-6, "courtyard holds pad " + q.number + " of " + tag); }
    // Silk: SILK_W lines, 0.2 mm from every pad (edge to edge).
    for (const s of fp.shapes.filter(s => s.style === "silk" && !s.fill && s.kind === "path")) {
      assert.ok(s.width >= W.SILK_W - 1e-9, "silk width " + tag);
      const pts = s.points, segs = pts.map((q, i) => [q, pts[(i + 1) % pts.length]]).slice(0, s.closed ? pts.length : pts.length - 1);
      for (const [p0, p1] of segs) for (const q of fp.pads) {
        const d = segBox(p0, p1, padBox(q)) - s.width / 2;
        assert.ok(d >= .2 - 1e-6, "silk " + d.toFixed(3) + " mm from pad " + q.number + " of " + tag);
      }
    }
    // A body for the 3D view (assembly outline on Mechanical 13) and a height, except mechanical items.
    if (!MECH.has(f.id)) {
      assert.ok(fp.shapes.some(s => s.layer === "Mechanical 13" && (s.closed || s.kind === "circle") || s.style === "assembly"), "assembly body " + tag);
      assert.ok(fp.height > 0, "height " + tag);
    }
    if (NEW.has(f.id) && !MECH.has(f.id) && !["inductor", "connector"].includes(f.id)) assert.ok(fp.shapes.some(s => s.style === "silk"), "silk " + tag);
    // DFM on the JLCPCB 2-layer preset: the part alone on a board with room around it.
    const w = c[2] - c[0] + 20, h = c[3] - c[1] + 20;
    const doc = {id: "b", kind: "pcb", name: "DFM", items: [{id: "p", kind: "part", def: "x", ref: "U1", x: w / 2 - (c[0] + c[2]) / 2, y: h / 2 - (c[1] + c[3]) / 2, angle: 0, layer: "Top", pinNets: {}}],
      outline: [[0, 0], [w, 0], [w, h], [0, h]], grid: .25, notes: []};
    const dfm = D.run(doc, new Map([["x", a]]), LIM, {});
    assert.deepEqual(dfm.issues.map(i => i.check + ": " + i.text), [], "DFM (JLCPCB 2-layer) " + tag);
    count++;
  }
  assert.ok(count >= 330, "presets checked: " + count);
  console.log("PASS " + W.FAMILIES.length + " families, " + count + " presets: valid, checks clean, courtyard, silk, body, deterministic, DFM-clean on JLCPCB 2-layer");
}

// ------------------------------------------------------------ 2. goldens
const REP = [["chiparray", "0402×4 (2010)"], ["molded", "Tantalum B (3528-21)"], ["molded", "SMA (DO-214AC)"], ["capae", "6.3×5.4 (D)"], ["sodfl", "SOD-123F"], ["sotfl", "SOT-563"],
  ["sotx", "SOT-363 (SC-70-6)"], ["sotx", "SOT-23-8"], ["sot143", "SOT-143"], ["sot89", "SOT-89-3"], ["dpak", "TO-252-2 (DPAK)"], ["dpak", "TO-263-5 (D2PAK-5)"], ["jlead", "PLCC-44"],
  ["jlead", "SOJ-26 (300 mil)"], ["lcc", "LCC-28"], ["qfp", "LQFP-144 20×20 0.5"], ["qfp", "PQFP-100 14×20 0.65"], ["qfp", "HTQFP-64 10×10 0.5 EP"], ["sop", "TSSOP-16"], ["sop", "MSOP-10"],
  ["sop", "TSOP-II-44 400 mil"], ["sop", "SOIC-8 EP"], ["qfn", "QFN-24 4×4 0.5"], ["qfn", "PQFN-12 4×4 0.65 (pull-back)"], ["qfn2row", "QFN-2ROW-84 7×7 0.5"], ["lga", "LGA-16 3×3 0.65"],
  ["csp", "WLCSP-16 0.4"], ["csp", "BGA-81 0.8 staggered"], ["inductor", "Power 4040 (4×4×2)"], ["inductor", "Wire-wound 0603 (1608)"], ["xtal", "4-pad 3225"], ["xtal", "2-pad 3215 (32.768 kHz)"],
  ["led", "PLCC-2 3528"], ["led", "PLCC-6 5050"], ["tact", "6×6 SMD, 4 leads"], ["buzzer", "Magnetic 9×9 SMD"], ["testpad", "Round 1.0"], ["castellated", "Module 18×25.5, 1.27, 3 sides (14+10+14)"],
  ["axial", "DIN0207 P10.16"], ["axial", "DO-41 standing P5.08"], ["radial", "Can D6.3 P2.5"], ["radial", "Box 13×4 P10"], ["to92", "TO-92 inline 1.27"], ["to220", "TO-220-3 vertical"],
  ["to220", "TO-247-3 horizontal"], ["tocan", "TO-5 (8 leads)"], ["sip", "SIP-8"], ["pga", "PGA-68 11×11 2.54 (2 rows)"], ["connector", "IDC box header 2×5 2.54"], ["xtaltht", "HC-49/S"],
  ["fuseholder", "5×20 holder, 22.5 mm"], ["pingrid", "Relay DPDT, 8 pins (signal)"], ["mounting", "M3 plated, 8 vias"], ["fiducial", "1.0 dot, 2.0 opening"], ["cardedge", "Card edge 2×10 1.27"],
  ["nettie", "2 pads, 0.5"]];
const summary = (f, p) => {
  const fp = W.generate({family: f, preset: p, symbol: false}).footprint, i = fp.ipc;
  const pads = fp.pads.filter(q => !q.thermalVia);
  return JSON.parse(JSON.stringify({family: f, preset: p, name: fp.name, height: fp.height ?? null, courtyard: fp.courtyard, Z: i.Z ?? null, G: i.G ?? null, X: i.X ?? null,
    hole: i.hole ?? null, land: i.land ?? null, pads: pads.length, vias: fp.pads.length - pads.length,
    first: pads.slice(0, 2).map(q => [q.number, q.x, q.y, q.w, q.h, q.drill || 0, q.shape]), last: [pads.at(-1).number, pads.at(-1).x, pads.at(-1).y, pads.at(-1).w, pads.at(-1).h]}));
};
{
  const golden = {silkWidth: W.SILK_W, families: W.FAMILIES.map(f => f.id), packages: REP.map(([f, p]) => summary(f, p))};
  for (const f of new Set(REP.map(r => r[0]))) assert.ok(W.FAMILIES.some(x => x.id === f), f);
  for (const f of NEW) assert.ok(REP.some(r => r[0] === f), "a golden for every new family: " + f);
  const file = path.join(__dirname, "../goldens/footprint-packages.json");
  if (globalThis.process?.env?.FPW_GOLDEN === "emit" || !fs.existsSync(file)) print("@@GOLDEN\n" + JSON.stringify(golden, null, 1) + "\n@@END");
  const want = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(golden.silkWidth, want.silkWidth);
  assert.deepEqual(golden.families, want.families, "family list");
  for (const [k, g] of golden.packages.entries()) assert.deepEqual(g, want.packages[k], "golden " + g.family + " " + g.preset);
  console.log("PASS goldens: " + REP.length + " representative presets");
}

// ------------------------------------------------------------ 3. KiCad cross-check (IPC-7351B generated footprints)
// Every case is a KiCad library footprint made by kicad-footprint-generator (its descr says
// "generated with kicad-footprint-generator"), with that generator's inputs from its published size
// definitions (data/… YAML, read 2026-11-19). Fed the same inputs with roundOff "kicad" (0.05; 0.02
// for chips < 0603; round half to even), the wizard's equations must give KiCad's pad 1 to 0.01 mm:
// [label, KiCad footprint, wizard spec, KiCad pad 1 |centre|, length, width]. Conventions carried by
// the inputs: BSC lead spans have zero tolerance (TSSOP, TQFP, LQFP-144, SOT, QFN-20); KiCad's PLCC
// "lead inside" S has Smax = Smin + √(CL² + CS²); KiCad keeps 0.20 mm from the exposed pad (also the
// wizard's default) and QFN-16 carries KiCad's heel_reduction 0.05.
const R = (min, max) => ({min, max}), IN = (a, b) => R(a * 25.4, b * 25.4);
const plccS = (L, S) => ({min: S.min, max: S.min + Math.hypot(L.max - L.min, S.max - S.min)});
const KICAD = [
  ["TSSOP-16", "TSSOP-16_4.4x5mm_P0.65mm", {family: "sop", preset: "TSSOP-16", L: 6.4, T: R(.45, .75), W: R(.17, .3)}, 2.8625, 1.475, .4],
  ["TSSOP-14", "TSSOP-14_4.4x5mm_P0.65mm", {family: "gullwing", preset: "TSSOP-14", L: 6.4, T: R(.45, .75), W: R(.17, .3)}, 2.8625, 1.475, .4],
  ["TSSOP-20", "TSSOP-20_4.4x6.5mm_P0.65mm", {family: "gullwing", preset: "TSSOP-20", L: 6.4, T: R(.45, .75), W: R(.17, .3)}, 2.8625, 1.475, .4],
  ["TQFP-100", "TQFP-100_14x14mm_P0.5mm", {family: "qfp", preset: "TQFP-100 14×14 0.5", L: 16, T: R(.45, .75), W: R(.17, .27)}, 7.6625, 1.475, .3],
  ["LQFP-144", "LQFP-144_20x20mm_P0.5mm", {family: "qfp", preset: "LQFP-144 20×20 0.5", L: 22, T: R(.45, .75), W: R(.17, .27)}, 10.6625, 1.475, .3],
  ["LQFP-32", "LQFP-32_7x7mm_P0.8mm", {family: "qfp", preset: "LQFP-32 7×7 0.8"}, 4.175, 1.5, .5],
  ["LQFP-48", "LQFP-48_7x7mm_P0.5mm", {family: "gullwing", preset: "LQFP-48", L: 9, T: R(.45, .75), W: R(.17, .27)}, 4.1625, 1.475, .3],
  ["LQFP-64", "LQFP-64_10x10mm_P0.5mm", {family: "gullwing", preset: "LQFP-64", L: R(11.8, 12.2), T: R(.45, .75), W: R(.17, .27)}, 5.675, 1.55, .3],
  ["LQFP-100", "LQFP-100_14x14mm_P0.5mm", {family: "gullwing", preset: "LQFP-100"}, 7.675, 1.6, .3],
  ["SOIC-8", "SOIC-8_3.9x4.9mm_P1.27mm", {family: "gullwing", preset: "SOIC-8"}, 2.475, 1.95, .6],
  ["SOIC-16", "SOIC-16_3.9x9.9mm_P1.27mm", {family: "sop", preset: "SOIC-16"}, 2.475, 1.95, .6],
  ["SOIC-20W", "SOIC-20W_7.5x12.8mm_P1.27mm", {family: "sop", preset: "SOIC-20W", L: R(9.97, 10.63)}, 4.65, 2.05, .6],
  ["SOT-23-5", "SOT-23-5", {family: "sot23", preset: "SOT-23-5", L: 2.8}, 1.1375, 1.325, .6],
  ["SOT-23-6", "SOT-23-6", {family: "sot23", preset: "SOT-23-6", L: 2.8}, 1.1375, 1.325, .6],
  ["SOT-23-8", "SOT-23-8", {family: "sotx", preset: "SOT-23-8", L: 2.8}, 1.1375, 1.325, .5],
  ["TSOT-23-6", "TSOT-23-6", {family: "sotx", preset: "TSOT-23-6", L: 2.8}, 1.1375, 1.325, .6],
  ["QFN-16 3×3", "QFN-16-1EP_3x3mm_P0.5mm_EP1.7x1.7mm", {family: "nolead", preset: "QFN-16 3×3", W: R(.18, .3), EP: {D: 1.7, E: 1.7}, heelReduction: .05}, 1.4625, .825, .25],
  ["QFN-20 4×4", "QFN-20-1EP_4x4mm_P0.5mm_EP2.7x2.7mm", {family: "qfn", preset: "QFN-20 4×4 0.5", D: 4, E: 4, T: R(.35, .45), W: R(.2, .3), EP: {D: 2.7, E: 2.7}}, 1.95, .8, .25],
  ["QFN-24 4×4", "QFN-24-1EP_4x4mm_P0.5mm_EP2.7x2.7mm", {family: "qfn", preset: "QFN-24 4×4 0.5", W: R(.18, .28), EP: {D: 2.7, E: 2.7}}, 1.9625, .825, .25],
  ["QFN-32 5×5", "QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm", {family: "nolead", preset: "QFN-32 5×5", W: R(.2, .3), EP: {D: 3.45, E: 3.45}}, 2.4375, .875, .25],
  ["QFN-48 7×7", "QFN-48-1EP_7x7mm_P0.5mm_EP5.15x5.15mm", {family: "nolead", preset: "QFN-48 7×7", W: R(.2, .3), EP: {D: 5.15, E: 5.15}}, 3.4375, .875, .25],
  ["DFN-10 3×3", "DFN-10-1EP_3x3mm_P0.5mm_EP1.65x2.38mm", {family: "nolead", preset: "DFN-8 3×3", pins: 10, pitch: .5, T: R(.28, .48), W: R(.2, .3), EP: {D: 2.38, E: 1.65}}, 1.45, .85, .25],
  ["DFN-8 2×2", "DFN-8-1EP_2x2mm_P0.5mm_EP0.9x1.6mm", {family: "qfn", preset: "DFN-8 2×2 0.5", D: R(1.85, 2.15), E: R(1.85, 2.15), T: R(.2, .5), W: R(.18, .3), EP: {D: 1.6, E: .9}}, 1.0125, .725, .25],
  ["PLCC-44", "PLCC-44_16.6x16.6mm_P1.27mm", {family: "jlead", preset: "PLCC-44", L: IN(.685, .695), L2: IN(.685, .695), S: plccS(IN(.685, .695), IN(.59, .63)), S2: plccS(IN(.685, .695), IN(.59, .63)), W: IN(.013, .021)}, 8, 1.7, .6],
  ["PLCC-68", "PLCC-68_24.2x24.2mm_P1.27mm", {family: "jlead", preset: "PLCC-68", L: IN(.985, .995), L2: IN(.985, .995), S: plccS(IN(.985, .995), IN(.89, .93)), S2: plccS(IN(.985, .995), IN(.89, .93)), W: IN(.013, .021)}, 11.8, 1.7, .6],
  ["R 0402", "R_0402_1005Metric", {family: "chip", preset: "0402"}, .51, .54, .64],
  ["C 0402", "C_0402_1005Metric", {family: "chip", preset: "0402", kind: "CAP", L: R(.9, 1.1), W: R(.4, .6)}, .48, .56, .62],
  ["R 0603", "R_0603_1608Metric", {family: "chip", preset: "0603"}, .825, .8, .95],
  ["C 0603", "C_0603_1608Metric", {family: "chip", preset: "0603", kind: "CAP", L: R(1.45, 1.75), W: R(.65, .95), T: R(.2, .5)}, .775, .9, .95],
  ["R 0805", "R_0805_2012Metric", {family: "chip", preset: "0805"}, .9125, 1.025, 1.4],
  ["C 0805", "C_0805_2012Metric", {family: "chip", preset: "0805", kind: "CAP", L: R(1.8, 2.2), W: R(1.05, 1.45), T: R(.25, .55)}, .95, 1, 1.45],
  ["R 1206", "R_1206_3216Metric", {family: "chip", preset: "1206"}, 1.4625, 1.125, 1.75],
  ["C 1206", "C_1206_3216Metric", {family: "chip", preset: "1206", kind: "CAP", L: R(3, 3.4), W: R(1.4, 1.8)}, 1.475, 1.15, 1.8]
];
{
  const pad1 = fp => { const p = fp.pads.find(q => q.number === "1"), v = Math.abs(p.x) < 1e-9; return [v ? Math.abs(p.y) : Math.abs(p.x), v ? p.h : p.w, v ? p.w : p.h]; };
  for (const [label, kicad, spec, cx, len, wid] of KICAD) {
    const [c, l, w] = pad1(W.generate({...spec, roundOff: "kicad", symbol: false}).footprint);
    near(c, cx, .01, label + " (" + kicad + ") pad 1 centre"); near(l, len, .01, label + " pad length"); near(w, wid, .01, label + " pad width");
  }
  // Round-off choices: 0.05 (IPC, default), 0.025 and 0.01; the land values land on that grid.
  for (const ro of [.05, .025, .01]) {
    const i = W.generate({family: "sop", preset: "TSSOP-16", roundOff: ro}).footprint.ipc;
    for (const v of [i.Z, i.G, i.X]) near(Math.round(v / ro) * ro, v, 1e-9, "round-off " + ro);
    assert.equal(i.roundOff, ro);
  }
  assert.equal(W.roundTo(1.55, .02, true), 1.56); assert.equal(W.roundTo(.45, .1, true), .4); assert.equal(W.roundTo(.55, .1, true), .6);
  assert.equal(W.generate({family: "chip", preset: "0402", roundOff: "kicad"}).footprint.ipc.roundOff, "kicad");
  assert.equal(W.generate({family: "chip", preset: "0402", roundOff: 7}).footprint.ipc.roundOff, .05, "an unknown round-off falls back to 0.05");
  console.log("PASS KiCad reproduction: " + KICAD.length + " generated footprints to 0.01 mm with KiCad's inputs and round-off; round-off choices");
}

// ------------------------------------------------------------ 4. densities and family features
{
  for (const dn of ["A", "C"]) for (const f of W.FAMILIES) for (const p of f.presets) {
    const d = W.generate({family: f.id, preset: p, density: dn});
    assert.deepEqual(L.checkFootprint(d.footprint).filter(x => x.level === "error").map(x => x.message), [], dn + " " + f.id + " " + p);
    assert.ok(!f.presets.length || d.footprint.name, dn + " name");
  }
  const pad = (fp, n) => fp.pads.find(q => q.number === String(n) && !q.thermalVia);
  // Rectangular PQFP: 30 pins on the long (left/right) sides, 20 on the top and bottom.
  const pq = W.generate({family: "qfp", preset: "PQFP-100 14×20 0.65"}).footprint;
  assert.equal(pq.pads.length, 100); assert.ok(pad(pq, 30).x < 0 && pad(pq, 31).y > 0 && pad(pq, 51).x > 0 && pad(pq, 81).y < 0);
  assert.equal(pq.name, "QFP65P1720X2320X340-100N");
  // Exposed pads on SOP and QFP, with paste windows and thermal vias.
  const so = W.generate({family: "sop", preset: "SOIC-8 EP"}).footprint, ep = pad(so, 9);
  assert.ok(ep.thermal && ep.pasteApertures.length && so.name.endsWith("-9N")); assert.ok(so.pads.some(q => q.thermalVia && q.number === "9"));
  const ht = W.generate({family: "qfp", preset: "HTQFP-64 10×10 0.5 EP"}).footprint;
  assert.ok(pad(ht, 65)?.thermal && ht.pads.filter(q => q.thermalVia).length >= 9);
  for (const v of ht.pads.filter(q => q.thermalVia)) assert.ok((v.w - v.drill) / 2 >= .2 - 1e-9, "thermal via ring ≥ 0.20");
  const win = W.generate({family: "qfn", preset: "QFN-40 6×6 0.5", pasteWindows: [3, 2]}).footprint;
  assert.equal(pad(win, 41).pasteApertures.length, 6, "paste window grid override");
  // BGA staggered rows and a custom ball map; CSP mask web stays ≥ 0.1 mm.
  const st = W.generate({family: "csp", preset: "BGA-81 0.8 staggered"}).footprint;
  assert.equal(st.pads.length, 81 - 4); near(pad(st, "B1").x - pad(st, "A1").x, .4, 1e-9, "odd rows shift by half a pitch");
  const map = W.generate({family: "csp", preset: "BGA custom map 1.0"}).footprint;
  assert.equal(map.pads.length, 24); assert.ok(pad(map, "A1") && !pad(map, "B2") && pad(map, "C3"));
  const wl = W.generate({family: "csp", preset: "WLCSP-16 0.4"}).footprint;
  assert.ok(.4 - wl.pads[0].w - 2 * wl.pads[0].maskExpansion >= .1 - 1e-9, "WLCSP mask web");
  // DPAK: the tab takes the cut centre lead's number; with the centre lead present it is the next number.
  const dp2 = W.generate({family: "dpak", preset: "TO-252-2 (DPAK)"}).footprint, dp3 = W.generate({family: "dpak", preset: "TO-252-3 (DPAK)"}).footprint;
  assert.deepEqual(dp2.pads.map(q => q.number), ["1", "3", "2"]); assert.deepEqual(dp3.pads.map(q => q.number), ["1", "2", "3", "4"]);
  assert.ok(pad(dp2, 2).w > 5 && pad(dp2, 2).x > 0);
  // SOT-143: the wide pin 1 shares its outer edge with a narrow lead; SOT-89: the tab joins pin 2.
  const s143 = W.generate({family: "sot143", preset: "SOT-143"}).footprint;
  assert.ok(pad(s143, 1).h > pad(s143, 2).h && pad(s143, 1).y > -.95);
  const s89 = W.generate({family: "sot89", preset: "SOT-89-3"}).footprint;
  assert.equal(s89.pads.filter(q => q.number === "2").length, 2);
  // PLCC: pin 1 at the centre of the top row, counter-clockwise (pin 2 to its left, then down the left side).
  const pl = W.generate({family: "jlead", preset: "PLCC-44"}).footprint;
  assert.equal(pad(pl, 1).x, 0); assert.ok(pad(pl, 1).y < 0 && pad(pl, 2).x < 0 && pad(pl, 7).x < pad(pl, 1).x && pad(pl, 7).y < pad(pl, 8).y);
  assert.ok(pad(pl, 44).x > 0 && pad(pl, 44).y < 0, "pin 44 right of pin 1 on the top row");
  // LCC corner heels shortened (flagged) so the corners stay clear.
  assert.ok(W.generate({family: "lcc", preset: "LCC-20"}).footprint.ipc.flagged.some(x => /corners/.test(x)));
  // Mounting holes: unplated holes carry no number and no symbol; plated rings take a via ring.
  const npth = W.generate({family: "mounting", preset: "M3 unplated"});
  assert.equal(npth.footprint.pads[0].plated, false); assert.equal(npth.symbol, undefined); assert.equal(npth.prefix, "H");
  const via = W.generate({family: "mounting", preset: "M3 plated, 8 vias"}).footprint;
  assert.equal(via.pads.filter(q => q.thermalVia).length, 8); assert.equal(via.name, "MTGP600H320V8");
  // Fiducial: no paste, mask opening 2× the dot; net tie: copper bridge and one net-tie group.
  const fid = W.generate({family: "fiducial", preset: "1.0 dot, 2.0 opening"}).footprint.pads[0];
  assert.ok(fid.fiducial && fid.noPaste && fid.maskExpansion === .5 && fid.pasteExpansion === -.5);
  const nt = W.generate({family: "nettie", preset: "3 pads, 0.5"}).footprint;
  assert.ok(nt.netTie && nt.netTieGroups[0].length === 3 && nt.shapes.some(s => s.layer === "Top"));
  // Connectors come from connector-gen.js (generic parts), not a second copy of its geometry.
  const idc = W.generate({family: "connector", preset: "IDC box header 2×5 2.54"});
  assert.equal(idc.footprint.name, AtriumConnectorGen.make(AtriumConnectorGen.normalise({family: "connector", type: "box", rows: 2, cols: 5, pitch: 2.54})).footprint.name);
  // THT lands keep a 0.20 mm ring (JLCPCB minimum 0.18) even at 1.27 mm pitch (flagged).
  const h127 = W.generate({family: "header", preset: "2×10 1.27"}).footprint;
  assert.ok((h127.pads[0].w - h127.pads[0].drill) / 2 >= .2 - 1e-9 && h127.ipc.flagged.some(x => /allowance reduced/.test(x)));
  // Every preset names its source; recalled values are flagged.
  for (const f of W.FAMILIES.filter(x => NEW.has(x.id))) assert.ok(W.generate({family: f.id, preset: f.presets[0]}).footprint.ipc.sources?.length, "source " + f.id);
  console.log("PASS densities A/C, quad side counts, exposed pads, BGA stagger/map, DPAK tabs, PLCC numbering, mounting, fiducial, net tie, connectors");
}

// ------------------------------------------------------------ 5. batch and headless
{
  const rows = W.parseBatch("family;preset;density;L;EP.D\nsop;SOIC-16;C;5.8..6.2;\nqfn;QFN-20 4×4 0.5;B;;2.6±0.1\n# comment\nchip;0603;A;;\n");
  assert.equal(rows.length, 3); assert.deepEqual(rows[0].spec.L, {min: 5.8, max: 6.2}); assert.deepEqual(rows[1].spec.EP, {D: {nom: 2.6, tol: .1}});
  const out = W.batch("family,preset,density,pins\nsop,SOIC-16,B,\nsop,SOIC-16,B,7\nbogus,,B,\n");
  assert.deepEqual(out.map(r => r.ok), [true, false, false]); assert.equal(out[0].name, "SOIC127P600X175-16N");
  assert.throws(() => W.parseBatch("preset\nSOIC-8\n"), /family column/);
  const list = W.headless({action: "list", group: "Mechanical"});
  assert.deepEqual(list.families.map(f => f.id), ["mounting", "fiducial", "cardedge", "nettie"]);
  const g = W.headless({action: "generate", family: "dpak", preset: "TO-263-2 (D2PAK)"});
  assert.equal(g.pad_count, 3); assert.ok(g.sources[0].includes("TO-263")); assert.deepEqual(g.issues, []);
  const desc = W.headless({action: "describe", family: "pingrid", preset: "Transformer EE16, 2×5"});
  assert.ok(desc.fields.some(x => x.key === "pins")); assert.match(desc.spec.pins, /^1 /);
  const custom = W.generate({family: "pingrid", pins: "1 0 0; 2 5 0; 3 2.5 4", lead: {min: .5, max: .6}, BL: 8, BW: 7, H: 5});
  assert.equal(custom.footprint.pads.length, 3);
  assert.throws(() => W.generate({family: "pingrid", pins: "1 0 0; 1 5 0"}), /unique/);
  assert.throws(() => W.headless({action: "nope"}), /action/);
  console.log("PASS CSV batch (ranges, ±, dotted keys, comments), headless list / describe / generate");
}
