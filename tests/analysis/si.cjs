"use strict";
// SI-lite (app/analysis/si.js): per-segment impedance against AtriumImpedance, reference-plane voids and
// splits, return-path vias, the crosstalk model against its formula, diff-pair coupling, the
// MCP op and speed on the 25k-object benchmark board.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "stackup", "impedance", "rigid-flex", "altium-rules", "net-intent", "signals", "rules", "si"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../pcb/dense-board.js");
const S = AtriumStackup, I = AtriumImpedance, R = AtriumRules, SI = AtriumSI;
const close = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, (m || "") + " " + a + " differs from " + b);
const now = () => globalThis.performance?.now?.() ?? Date.now();

const track = (id, net, layer, width, points) => ({id, kind: "track", net, layer, width, points});
const via = (id, net, x, y, extra = {}) => ({id, kind: "via", net, x, y, diameter: .6, drill: .3, layer: "Multi", ...extra});
const poly = (id, net, layer, x0, y0, x1, y1) => ({id, kind: "polygon", net, layer, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]});
const stack = {version: 1, layers: S.build(["Signal", "Plane", "Plane", "Signal"]).layers};
// A project holding one board; its rules go to the project rule book (and its pairs to the signal model).
const projectOf = (doc, rules) => { const p = {format: "atrium", version: 1, name: "P", library: [], documents: [doc]}; if (rules) R.store(doc, p, rules); return p; };
const board = (items, rules) => ({kind: "pcb", id: "b", name: "SI", outline: [[0, 0], [60, 0], [60, 40], [0, 40]], stackup: JSON.parse(JSON.stringify(stack)), items, ...(rules ? {rules} : {})});
const defs = new Map();

// ---- 1. impedance per segment matches AtriumImpedance on a solid plane ---------------------
{
  const doc = board([poly("g1", "GND", "Inner 1", 0, 0, 60, 40), poly("g2", "GND", "Inner 2", 0, 0, 60, 40), track("t1", "SIG", "Top", .2, [[5, 5], [25, 5]])]);
  const n = SI.analyzeNet(SI.context(doc, defs, {}), "SIG");
  const g = I.geometry(S.get(doc).layers, "Top"), want = I.solve({...g, w: .2}).z;
  assert.equal(n.events.length, 0, "a solid plane has no reference events");
  close(n.zMin, want, .01, "Z = AtriumImpedance microstrip");
  close(n.zMax, want, .01);
  assert.equal(n.target, 50); assert.equal(n.source, "default");
  close(n.worstDev, (want - 50) / 50 * 100, .01, "deviation from the default target");
  // Inner stripline between Inner 1 and Inner 2 is not possible here (no signal layer between):
  // a Bottom track references Inner 2.
  const doc2 = board([poly("g2", "GND", "Inner 2", 0, 0, 60, 40), track("b1", "B", "Bottom", .15, [[5, 5], [25, 5]])]);
  const nb = SI.analyzeNet(SI.context(doc2, defs, {}), "B");
  close(nb.zMin, I.solve({...I.geometry(S.get(doc2).layers, "Bottom"), w: .15}).z, .01, "Bottom microstrip over Inner 2");
  assert.equal(nb.profile.length, 1);
  close(nb.profile[0].d1, 20, 1e-6, "profile spans the length");
}

// ---- 2. voids and splits on the reference -------------------------------------------------
{
  // Inner 1: GND for x < 20, a 0.5 mm gap, VCC for x > 20.5; Inner 2 solid GND.
  const items = [poly("gl", "GND", "Inner 1", 0, 0, 20, 40), poly("vr", "VCC", "Inner 1", 20.5, 0, 60, 40), poly("g2", "GND", "Inner 2", 0, 0, 60, 40),
    track("t1", "SIG", "Top", .2, [[5, 5], [35, 5]])];
  const doc = board(items), ctx = SI.context(doc, defs, {});
  const n = SI.analyzeNet(ctx, "SIG");
  const kinds = n.events.map(e => e.kind).sort();
  assert.ok(kinds.includes("void"), "the gap is a void under the track: " + kinds);
  assert.ok(kinds.includes("split-crossing"), "GND → VCC crossing is flagged");
  const v = n.events.find(e => e.kind === "void");
  close(v.length, .5, 1e-6, "void length is exact (cut at the copper edges)");
  close(v.at[0], 20.25, 1e-6);
  const sc = n.events.find(e => e.kind === "split-crossing");
  assert.equal(sc.from, "GND"); assert.equal(sc.to, "VCC");
  // Over the void the reference moves to Inner 2 (the next copper outward), so Z rises.
  const pieces = [...n.results.values()].flat(), over = pieces.find(p => Math.abs((p.a[0] + p.b[0]) / 2 - 20.25) < 1e-6);
  assert.equal(over.refs[1], "Inner 2", "reference falls back to Inner 2");
  const far = I.solve({...I.geometry(S.get(doc).layers, "Top", [null, "Inner 2"]), w: .2}).z;
  close(over.z, far, .01, "Z over the void = microstrip over Inner 2");
  assert.ok(over.z > n.zMin + 10, "Z rises over the void");
  assert.equal(n.status, "fail");
  // A track straddling the split edge lengthwise: partial / split.
  const doc2 = board([poly("gl", "GND", "Inner 1", 0, 0, 20, 10.05), poly("vr", "VCC", "Inner 1", 0, 10.05, 60, 40), track("t2", "E", "Top", .2, [[2, 10], [15, 10]])]);
  const n2 = SI.analyzeNet(SI.context(doc2, defs, {}), "E");
  assert.ok(n2.events.some(e => e.kind === "split"), "track straddling two nets: " + n2.events.map(e => e.kind));
  // Poured regions (AtriumPCBPours contours) are used when present: a hole under the track.
  const ring = pts => { const b = new Uint8Array(4 + pts.length * 16), dv = new DataView(b.buffer); dv.setUint32(0, pts.length, true); pts.forEach((p, i) => { dv.setFloat64(4 + 16 * i, p[0] / .00000254, true); dv.setFloat64(12 + 16 * i, -p[1] / .00000254, true); }); return b; };
  const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
  const b64 = u => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
  if (globalThis.AtriumPCBPours || (() => { try { require("../../app/pcb/pcb-pours.js"); return true; } catch { return false; } })()) {
    const data = b64(cat(ring([[0, 0], [60, 0], [60, 40], [0, 40]]), ring([[10, 4], [12, 4], [12, 6], [10, 6]])));
    const doc3 = board([track("t3", "P", "Top", .2, [[5, 5], [25, 5]])]);
    doc3.pcbDrawing = {pours: [{layer: "Inner 1", net: "GND", count: 2, data, bounds: [0, 0, 60, 40]}]};
    const n3 = SI.analyzeNet(SI.context(doc3, defs, {}), "P");
    const v3 = n3.events.find(e => e.kind === "void");
    assert.ok(v3, "a hole in a poured region is a void");
    close(v3.length, 2, 1e-6, "hole width");
  }
}

// A fallback plane ending inside a nominal void models only the covered span.
{
  const doc = board([
    poly("near", "GND", "Inner 1", 0, 20, 40, 30),
    poly("far", "GND", "Inner 2", 0, 0, 17, 20),
    track("trace", "SIG", "Top", .3, [[10, 10], [30, 10]]),
    track("control", "CTRL", "Bottom", .3, [[10, 5], [14, 5]])
  ]);
  const ctx = SI.context(doc, defs), n = SI.analyzeNet(ctx, "SIG");
  const pieces = [...n.results.values()][0];
  assert.deepEqual(pieces.map(p => [p.a[0], p.b[0], p.refs[1]]), [[10, 17, "Inner 2"], [17, 30, null]]);
  close(pieces[0].z, I.solve({...I.geometry(S.get(doc).layers, "Top", [null, "Inner 2"]), w: .3}).z, .01);
  assert.equal(pieces[1].z, null);
  assert.equal(n.length, 20);
  assert.equal(n.unmodeled, 13);
  assert.deepEqual(n.events.map(e => [e.kind, e.ref, e.length]), [["void", "Inner 1", 20]]);
  assert.equal(SI.analyzeNet(ctx, "CTRL").events.length, 0);
  const report = SI.headless({nets: ["SIG", "CTRL"]}, {project: () => projectOf(doc), board: () => doc, defsOf: () => defs});
  assert.equal(report.items.find(row => row.net === "SIG").length_unmodeled, 13);
  assert.equal(report.items.find(row => row.net === "CTRL").length_unmodeled, undefined);
}

// ---- 3. return-path vias ------------------------------------------------------------------
{
  const base = [poly("g1", "GND", "Inner 1", 0, 0, 60, 40), poly("g2", "GND", "Inner 2", 0, 0, 60, 40),
    track("t1", "SIG", "Top", .2, [[5, 5], [20, 5]]), via("v1", "SIG", 20, 5), track("t2", "SIG", "Bottom", .2, [[20, 5], [35, 5]])];
  let n = SI.analyzeNet(SI.context(board(base), defs, {}), "SIG");
  assert.equal(n.returns.length, 1);
  assert.equal(n.returns[0].kind, "missing-via", "GND on Inner 1 → GND on Inner 2 needs a stitching via");
  assert.equal(n.returns[0].status, "fail");
  n = SI.analyzeNet(SI.context(board([...base, via("gv", "GND", 20.8, 5)]), defs, {}), "SIG");
  assert.equal(n.returns[0].kind, "via"); assert.equal(n.returns[0].status, "ok"); close(n.returns[0].distance, .8, 1e-6);
  n = SI.analyzeNet(SI.context(board([...base, via("gv", "GND", 22, 5)]), defs, {returnRadius: 1}), "SIG");
  assert.equal(n.returns[0].kind, "missing-via", "a stitching via 2 mm away is outside 1 mm");
  n = SI.analyzeNet(SI.context(board([...base, via("gv", "GND", 22, 5)]), defs, {returnRadius: 2.5}), "SIG");
  assert.equal(n.returns[0].kind, "via", "returnRadius widens the search");
  // Different reference nets: GND above, VCC below → stitching capacitor.
  const mixed = [poly("g1", "GND", "Inner 1", 0, 0, 60, 40), poly("p2", "VCC", "Inner 2", 0, 0, 60, 40), ...base.slice(2)];
  n = SI.analyzeNet(SI.context(board(mixed), defs, {}), "SIG");
  assert.equal(n.returns[0].kind, "net-change");
  const cap = {id: "c1", kind: "part", ref: "C7", def: "x", x: 23, y: 6, angle: 0, pinNets: {1: "GND", 2: "VCC"}};
  n = SI.analyzeNet(SI.context(board([...mixed, cap]), defs, {}), "SIG");
  assert.equal(n.returns[0].kind, "capacitor"); assert.equal(n.returns[0].by, "C7");
  // Top → Inner 2 sharing Inner 1? (Top refs Inner 1; a Top-to-Top via has no layer change.)
}

// ---- 4. crosstalk against the formula -----------------------------------------------------
{
  const doc = board([poly("g1", "GND", "Inner 1", 0, 0, 60, 40), poly("g2", "GND", "Inner 2", 0, 0, 60, 40),
    track("a", "AGG", "Top", .2, [[5, 10], [35, 10]]), track("v", "VIC", "Top", .2, [[5, 10.4], [35, 10.4]])]);
  const ctx = SI.context(doc, defs, {rise: .1}), n = SI.analyzeNet(ctx, "VIC");
  assert.equal(n.crosstalk.length, 1);
  const x = n.crosstalk[0];
  assert.equal(x.aggressor, "AGG"); assert.equal(x.relation, "same"); close(x.length, 30, 1e-6); close(x.minGap, .2, 1e-6);
  // Independent evaluation of the model from the coupled-line modes.
  const g = I.geometry(S.get(doc).layers, "Top"), r = I.solve({...g, w: .2, s: .2});
  const Ce = Math.sqrt(r.eeffEven) / r.zeven, Co = Math.sqrt(r.eeffOdd) / r.zodd, Le = r.zeven * Math.sqrt(r.eeffEven), Lo = r.zodd * Math.sqrt(r.eeffOdd);
  const kc = (Co - Ce) / (Co + Ce), kl = (Le - Lo) / (Le + Lo), Kb = (kc + kl) / 4;
  close(x.kb, Kb, 1e-9, "Kb = (Cm/C + Lm/L)/4");
  const v = 299.792458 / Math.sqrt((r.eeffEven + r.eeffOdd) / 2), lsat = v * .1 / 2;
  assert.ok(30 > lsat, "30 mm saturates at 0.1 ns");
  close(x.next, Kb, 1e-9, "saturated NEXT = Kb");
  close(x.fext, 30 / (2 * v * .1) * Math.abs(kc - kl), 1e-9, "FEXT = Lc/(2 v Tr)·|Cm/C − Lm/L|");
  assert.ok(x.next > .005 && x.next < .1, "a plausible microstrip NEXT at s = w: " + x.next);
  // Short runs scale linearly below saturation.
  const short = SI.crosstalk({kb: .04, kf: 0, length: 10, v: 150, rise: 1});
  close(short.lsat, 75, 1e-9); close(short.next, .04 * 10 / 75, 1e-12); assert.equal(short.saturated, false);
  // Kb falls with the gap; a homogeneous stripline has no FEXT.
  const k1 = SI.kb(g, .2, .2), k2 = SI.kb(g, .2, .6);
  assert.ok(k2.kb < k1.kb / 2, "coupling falls with spacing");
  const strip = I.geometry(S.build(["Plane", "Signal", "Plane"]).layers, "Inner 1"), ks = SI.kb(strip, .15, .2);
  assert.ok(Math.abs(ks.kf) < 1e-3, "stripline Cm/C ≈ Lm/L (no FEXT): " + ks.kf);
  // Broadside estimate: monotonic in offset and symmetric.
  const b0 = SI.broadside(.2, .2, .035, .2, .4, 0), b1 = SI.broadside(.2, .2, .035, .2, .4, 1);
  assert.ok(b0.kb > b1.kb && b1.kb > 0);
  // Diff-pair mates do not count as crosstalk; far tracks are ignored.
  const doc2 = board([poly("g1", "GND", "Inner 1", 0, 0, 60, 40), track("a", "AGG", "Top", .2, [[5, 10], [35, 10]]), track("v", "VIC", "Top", .2, [[5, 14], [35, 14]])]);
  assert.equal(SI.analyzeNet(SI.context(doc2, defs, {}), "VIC").crosstalk.length, 0, "4 mm away is outside the search");
}

// ---- 5. diff pairs: coupled Zdiff, uncoupled runs, skew and phase ----------------------------
{
  const rules = R.create();
  rules.diffPairs = [{name: "USB", positive: "USB_P", negative: "USB_N"}];
  rules.list = rules.list.filter(r => r.type !== "diffPairsRouting");
  rules.list.push({id: "dp-1", type: "diffPairsRouting", name: "DP", comment: "", enabled: true, priority: 1, scope: {kind: "all"}, widthMin: .1, widthPreferred: .15, widthMax: .3,
    gapMin: .1, gapPreferred: .15, gapMax: .2, maxUncoupled: 3, layers: {}});
  const doc = board([poly("g1", "GND", "Inner 1", 0, 0, 60, 40), poly("g2", "GND", "Inner 2", 0, 0, 60, 40),
    track("p1", "USB_P", "Top", .15, [[0, 10], [20, 10]]), track("n1", "USB_N", "Top", .15, [[0, 10.3], [12, 10.3], [12, 14], [20, 14]])]);
  const rep = SI.analyze(doc, defs, {project: projectOf(doc, rules)});
  const p = rep.pairs.find(x => x.name === "USB");
  assert.ok(p, "pair analysed");
  close(p.lengthP, 20, 1e-6); close(p.lengthN, 12 + 3.7 + 8, 1e-6); close(p.skew, 3.7, 1e-6);
  close(p.uncoupledP, 8, 1e-6, "P is uncoupled beyond x = 12");
  assert.ok(p.uncoupled > 3 && p.status === "fail", "uncoupled run over Max Uncoupled Length");
  close(p.worstPhase, 3.7, 1e-6, "phase mismatch at the far end equals the detour");
  const pn = rep.nets.find(n => n.net === "USB_P"), g = I.geometry(S.get(doc).layers, "Top");
  const coupled = [...pn.results.values()].flat().find(x => x.coupled);
  close(coupled.z, I.solve({...g, w: .15, s: .15}).zdiff, .01, "coupled piece: Zdiff at the actual gap");
  assert.equal(coupled.target, 100);
  const unc = [...pn.results.values()].flat().find(x => x.coupled === false);
  close(unc.z, 2 * I.solve({...g, w: .15}).z, .01, "uncoupled piece: 2·Z0");
  assert.ok(rep.violations.some(v => v.kind === "diff-pair"));
  assert.ok(!rep.crosstalk.some(x => x.victim === "USB_P" && x.aggressor === "USB_N"), "mates are not aggressors");
}

// ---- 6. impedance profiles from the rules ---------------------------------------------------
{
  const doc = board([poly("g1", "GND", "Inner 1", 0, 0, 60, 40), track("t1", "RF", "Top", .3, [[5, 5], [25, 5]])]);
  doc.stackup.impedanceProfiles = [{id: "z50", name: "Z50", type: "single", target: 55, tolerance: 5, layers: {Top: {width: null, reference: [null, "Inner 1"], etch: 0, enabled: true}}}];
  const rules = R.create();
  rules.list = rules.list.filter(r => r.type !== "width");
  rules.list.push({id: "w1", type: "width", name: "W", comment: "", enabled: true, priority: 1, scope: {kind: "net", value: "RF"}, min: .1, preferred: .2, max: 1, impedanceProfile: "Z50"});
  const n = SI.analyzeNet(SI.context(doc, defs, {project: projectOf(doc, rules)}), "RF");
  assert.equal(n.source, "profile"); assert.equal(n.target, 55); assert.equal(n.tolerance, 5); assert.equal(n.profileName, "Z50");
}

// ---- 7. MCP op --------------------------------------------------------------------------------
{
  const doc = board([poly("g1", "GND", "Inner 1", 0, 0, 20, 40), track("t1", "SIG", "Top", .2, [[5, 5], [35, 5]]), track("t9", "OTHER", "Top", .2, [[5, 5.4], [35, 5.4]])]);
  const p = {name: "P", library: [], documents: [doc]};
  const out = SI.headless({nets: ["SIG"]}, {project: () => p, board: () => doc, defsOf: () => defs, page: items => ({total: items.length, items})});
  assert.equal(out.items.length, 1); assert.equal(out.items[0].net, "SIG");
  assert.ok(out.items[0].events.length && out.items[0].pieces.length && out.items[0].crosstalk.length);
  assert.ok(out.violations.some(v => v.kind === "reference"));
  JSON.stringify(out);
}

// ---- 8. speed: one net on demand and the 25k-object board -----------------------------------
{
  const {d} = makeAtriumBenchmarkBoard(160);
  let k = 0;
  for (const i of d.items) if (i.kind === "track") i.net = "N" + (k++ % 3000);
  d.items.push(poly("gnd", "GND", "Bottom", 0, 0, 368, 275));
  d.stackup = {version: 1, layers: S.build(["Signal", "Signal"]).layers};
  assert.ok(d.items.length > 25000);
  let t0 = now();
  const ctx = SI.context(d, new Map(), {revision: 1});
  const tCtx = now() - t0;
  t0 = now(); SI.analyzeNet(ctx, "N1"); const tFirst = now() - t0;
  t0 = now(); SI.analyzeNet(ctx, "N2"); const tNet = now() - t0;
  t0 = now(); const rep = SI.analyze(d, new Map(), {context: ctx}); const tAll = now() - t0;
  assert.equal(rep.nets.length, 3000);
  console.log("si perf: context " + tCtx.toFixed(1) + " ms, first net " + tFirst.toFixed(1) + " ms, next net " + tNet.toFixed(2) + " ms, board " + tAll.toFixed(0) + " ms (" + rep.stats.segments + " segments)");
  assert.ok(tNet < 50, "a net on demand under 50 ms: " + tNet);
}
console.log("si ok");
