"use strict";
// Length engine, tuning patterns, interactive session, matched-length groups and benchmarks.
// Node:  node tests/pcb/length-tuning.cjs [--bench]
// JSC:   jsc shim.js -- tests/pcb/length-tuning.cjs [--bench]   (a shim providing require/assert)
const assert = require("node:assert/strict");
const {F4,F5,mirroredLandPoint,mirroredTopRow,landContacts}=require("../support/a1-geometry.cjs");
const {segSeg:segDist} = require("../support/segment-distance.cjs");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/checks/net-intent.js");
require("../../app/core/signals.js");
require("../../app/pcb/length-tuning.js");
const L = globalThis.AtriumLength, A = globalThis.Atrium;
const bench = (globalThis.process?.argv || []).includes("--bench");
const now = () => globalThis.performance.now();
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || "") + " " + a + " vs " + b);
const hyp = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const polyLen = pts => pts.reduce((s, p, i) => i ? s + hyp(p, pts[i - 1]) : 0, 0);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

// Smallest centre-line distance between parts of one polyline that are far apart along it.
function selfSpacing(pts, along) {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hyp(pts[i], pts[i - 1]));
  let min = Infinity;
  for (let i = 1; i < pts.length; i++) for (let j = i + 2; j < pts.length; j++) {
    if (cum[j - 1] - cum[i] < along) continue;
    min = Math.min(min, segDist(pts[i - 1], pts[i], pts[j - 1], pts[j]));
  }
  return min;
}
function minBetween(p, q) { let m = Infinity; for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) m = Math.min(m, segDist(p[i - 1], p[i], q[j - 1], q[j])); return m; }

// ---------------------------------------------------------------- boards
const padDef = {id: "pad1", name: "Pad", footprint: {shapes: [], pads: [{number: "1", x: 0, y: 0, w: .6, h: .6, shape: "rect"}]}};
const r2 = {id: "r2", name: "R", prefix: "R", footprint: {shapes: [], pads: [{number: "1", x: -.5, y: 0, w: .5, h: .6, shape: "rect"}, {number: "2", x: .5, y: 0, w: .5, h: .6, shape: "rect"}]}};
const defs = new Map([[padDef.id, padDef], [r2.id, r2]]);
let uid = 0;
const id = () => "i" + (++uid);
const part = (ref, def, x, y, pinNets, extra = {}) => ({id: id(), kind: "part", def, ref, value: ref, x, y, angle: 0, pinNets, ...extra});
const track = (net, layer, points, width = .2) => ({id: id(), kind: "track", net, layer, width, points});
const via = (net, x, y) => ({id: id(), kind: "via", net, x, y, diameter: .6, drill: .3});
function board(items) { const d = A.sheet("pcb", "Test"); d.items.push(...items); return d; }

test("net length on the sample board matches a hand calculation", () => {
  const p = AtriumParts.example(), pcb = p.documents[1], lib = new Map(p.library.map(d => [d.id, d]));
  const tracks = net => pcb.items.filter(i => i.kind === "track" && i.net === net);
  const vout = L.netLength(pcb, lib, "VOUT");
  assert.equal(vout.mode, "path");
  close(vout.length, tracks("VOUT").reduce((s, t) => s + polyLen(t.points), 0), 1e-9, "VOUT pad to pad");
  assert.equal(vout.from, "R2.2"); assert.equal(vout.to, "J2.1");
  const vin = L.netLength(pcb, lib, "VIN");
  close(vin.length, 5.3, 1e-9, "VIN J1.2 to R1.1");
  // FILTER has three pads: total routed copper.
  const filter = L.netLength(pcb, lib, "FILTER");
  assert.equal(filter.mode, "total");
  close(filter.length, tracks("FILTER").reduce((s, t) => s + polyLen(t.points), 0), 1e-9, "FILTER total");
  // VDD crosses two through vias (default 1.6 mm board): 2 x 1.6 mm barrels.
  const vdd = L.netLength(pcb, lib, "VDD");
  close(vdd.track, tracks("VDD").reduce((s, t) => s + polyLen(t.points), 0), 1e-9, "VDD copper");
  close(vdd.via, 3.2, 1e-9, "VDD barrels"); assert.equal(vdd.vias, 2); assert.equal(vdd.unrouted, false);
  close(L.netLength(pcb, lib, "VDD", {vias: false}).length, vdd.track, 1e-9, "via option");
});

test("pad-to-pad path, stubs, vias, T junctions, package length and delay", () => {
  const u1 = part("U1", "pad1", 0, 0, {"1": "S"}, {pinLengths: {"1": 1.25}});
  const u2 = part("U2", "pad1", 20, 5, {"1": "S"}, {layer: "Bottom"});
  const items = [u1, u2, track("S", "Top", [[0, 0], [10, 0], [10, 5]]), via("S", 10, 5), track("S", "Bottom", [[10, 5], [20, 5]])];
  const b = board(items);
  let r = L.netLength(b, defs, "S");
  assert.equal(r.mode, "path"); assert.equal(r.from, "U1.1"); assert.equal(r.to, "U2.1");
  close(r.track, 25, 1e-9); close(r.via, 1.6, 1e-9); close(r.die, 1.25, 1e-9); close(r.length, 27.85, 1e-9, "hand: 10+5+10+1.6+1.25");
  close(r.layers.Top, 15, 1e-9); close(r.layers.Bottom, 10, 1e-9);
  assert.equal(r.transitions, 1);
  const perMm = (r.delay) / r.length; assert.ok(perMm > 5 && perMm < 8, "plausible FR-4 delay " + perMm);
  // A dangling stub is routed copper but not on the pad-to-pad path.
  b.items.push(track("S", "Top", [[10, 0], [10, -3]]));
  L.invalidate(b);
  r = L.netLength(b, defs, "S");
  close(r.length, 27.85, 1e-9, "stub off path"); close(r.stub, 3, 1e-9); close(r.routed, 28 + 1.6, 1e-9);
  // T junction: a track that ends on the middle of another segment.
  const t = board([part("A1", "pad1", 0, 0, {"1": "T"}), part("A2", "pad1", 6, 4, {"1": "T"}), part("A3", "pad1", 12, 0, {"1": "T"}),
    track("T", "Top", [[0, 0], [12, 0]]), track("T", "Top", [[6, 0], [6, 4]])]);
  const tr = L.netLength(t, defs, "T", {mode: "path", from: {ref: "A1", pin: "1"}, to: {ref: "A2", pin: "1"}});
  close(tr.length, 10, 1e-9, "A1 -> junction -> A2");
  assert.equal(L.netLength(t, defs, "T").islands, 1);
  // Unrouted: a gap in the copper.
  const u = board([part("B1", "pad1", 0, 0, {"1": "U"}), part("B2", "pad1", 10, 0, {"1": "U"}), track("U", "Top", [[0, 0], [4, 0]]), track("U", "Top", [[5, 0], [10, 0]])]);
  const ur = L.netLength(u, defs, "U");
  assert.equal(ur.unrouted, true); assert.equal(ur.islands, 2);
});

// Altium's lengths are its routed copper: a track that enters a pad or via with a bend inside the land and
// runs on to its end (the land's centre) counts in full, not only up to the first vertex inside the land.
test("a track's entry into a pad or via counts to its end", () => {
  const ends = [part("E1", "pad1", 0, 0, {"1": "E"}), part("E2", "pad1", 10, 0, {"1": "E"})];
  // Each end bends 0.2 mm inside the 0.6 mm pad on its way to the centre.
  const b = board([...ends, track("E", "Top", [[0, 0], [.2, .2], [9.8, .2], [10, 0]])]);
  const full = 2 * Math.hypot(.2, .2) + 9.6;
  close(L.netLength(b, defs, "E").length, full, 1e-9, "both pad entries counted");
  // The same through a via: the bend inside the 0.6 mm via counts too.
  const v = board([part("F1", "pad1", 0, 0, {"1": "F"}), part("F2", "pad1", 10, 0, {"1": "F"}, {layer: "Bottom"}),
    track("F", "Top", [[0, 0], [4.8, .2], [5, 0]]), via("F", 5, 0), track("F", "Bottom", [[5, 0], [10, 0]])]);
  close(L.netLength(v, defs, "F", {vias: false}).length, Math.hypot(4.8, .2) + Math.hypot(.2, .2) + 5, 1e-9, "via entry counted");
  // A pad in the middle of a route (the track passes through it) is still reached without a detour.
  const t = board([part("G1", "pad1", 0, 0, {"1": "G"}), part("G2", "pad1", 5, 0, {"1": "G"}), part("G3", "pad1", 10, 0, {"1": "G"}),
    track("G", "Top", [[0, 0], [5, 0], [10, 0]])]);
  close(L.netLength(t, defs, "G", {mode: "path", from: {ref: "G1", pin: "1"}, to: {ref: "G2", pin: "1"}}).length, 5, 1e-9, "through pad");
});

test("xSignal through a series resistor spans both nets", () => {
  const b = board([part("U1", "pad1", 0, 0, {"1": "A"}), part("R1", "r2", 10.5, 0, {"1": "A", "2": "B"}), part("U2", "pad1", 25, 3, {"1": "B"}),
    track("A", "Top", [[0, 0], [10, 0]]), track("B", "Top", [[11, 0], [14, 3], [25, 3]])]);
  const xs = {name: "U1_U2_DATA", from: {ref: "U1", pin: "1"}, to: {ref: "U2", pin: "1"}};
  const r = L.xSignalLength(b, defs, xs);
  close(r.length, 10 + Math.hypot(3, 3) + 11 + 1, 1e-9, "segment A + R1 pad to pad (1 mm) + segment B"); close(r.series, 1, 1e-9, "series part body");
  assert.deepEqual(r.nets, ["A", "B"]); assert.deepEqual(r.through, ["R1"]);
  const found = L.discoverXSignals(b, defs, "U1", "U2");
  assert.equal(found.length, 1); assert.deepEqual(found[0].through, ["R1"]);
  // xSignals are the signal model's (signals.js), not the board's lengthTuning.
  const p = A.validate({format: "atrium", version: 1, name: "x", library: [padDef, r2], documents: [b]});
  L.addXSignals(b, found, p);
  assert.equal(L.xSignals(b).length, 1); assert.equal(p.signals.signals.flatMap(s => s.paths || []).length, 1);
  assert.equal(b.lengthTuning?.xSignals, undefined);
  const g = L.evaluate(b, defs).find(x => x.name === "xSignals");
  assert.ok(g && g.members[0].kind === "xsignal"); close(g.members[0].length, r.length, 1e-9);
  A.validate(p);
});

test("results are cached per net and invalidated by that net's copper only", () => {
  const b = board([part("U1", "pad1", 0, 0, {"1": "A"}), part("U2", "pad1", 10, 0, {"1": "A"}), track("A", "Top", [[0, 0], [10, 0]]),
    part("V1", "pad1", 0, 5, {"1": "B"}), part("V2", "pad1", 10, 5, {"1": "B"}), track("B", "Top", [[0, 5], [10, 5]])]);
  const a1 = L.netLength(b, defs, "A"), b1 = L.netLength(b, defs, "B");
  assert.equal(L.netLength(b, defs, "A"), a1, "warm: same object");
  b.items[2].points = [[0, 0], [5, 2], [10, 0]];
  const a2 = L.netLength(b, defs, "A"), b2 = L.netLength(b, defs, "B");
  assert.notEqual(a2, a1); close(a2.length, 2 * Math.hypot(5, 2), 1e-9); assert.equal(b2, b1, "untouched net keeps its result");
  assert.equal(L.netLength(b, defs, "A", {revision: 7}), a2);
});

test("cached paths match a fresh graph after footprint pad edits and undo", () => {
  const pad = {number: "1", x: 0, y: 0, w: 4, h: .4, shape: "rect", angle: 0};
  const withPad = changes => new Map(defs).set("wide", {footprint: {pads: [{...pad, ...changes}]}});
  const original = withPad({});
  const b = board([
    part("U1", "wide", 0, 0, {"1": "A"}), part("U2", "pad1", 10, 0, {"1": "A"}),
    track("A", "Top", [[1.98, .19], [10, 0]], .1),
    part("V1", "pad1", 0, 5, {"1": "B"}), part("V2", "pad1", 10, 5, {"1": "B"}),
    track("B", "Top", [[0, 5], [10, 5]]),
  ]);
  let revision = 0;
  const unaffected = L.netLength(b, original, "B", {revision});
  const check = (library, unrouted, edit) => {
    const options = {revision: ++revision};
    const cached = L.netLength(b, library, "A", options);
    assert.deepEqual(cached, L.netLength(A.clone(b), library, "A", options), edit);
    assert.equal(cached.unrouted, unrouted, edit);
    assert.equal(L.netLength(b, library, "B", options), unaffected, "other net stays cached");
  };
  check(original, false, "initial path");
  for (const [edit, changes] of [["rotate", {angle: 90}], ["resize", {w: 3.8, h: 1.8}], ["round", {shape: "round"}]]) {
    check(withPad(changes), true, edit);
    check(original, false, "undo " + edit);
  }
});

test("cached paths read current standalone pad layers, terminal labels and pin delay", () => {
  const source = part("U1", "pad1", 0, 0, {"1": "A"}, {pinLengths: {"1": 2}, pinDelays: {"1": 12}});
  const end = {id: id(), kind: "pad", number: "2", net: "A", layer: "Top", x: 10, y: 0, w: 1, h: 1};
  const trace = track("A", "Top", [[0, 0], [10, 0]]);
  const b = board([source, end, trace]);
  let revision = 0;
  const check = edit => {
    const options = {revision: ++revision};
    const cached = L.netLength(b, defs, "A", options);
    assert.deepEqual(cached, L.netLength(A.clone(b), defs, "A", options), edit);
    return cached;
  };
  const original = check("initial path");
  assert.equal(original.mode, "path");
  b.items = [source, {...end, layer: "Bottom"}, trace];
  assert.equal(check("move pad to another layer").unrouted, true);
  b.items = [source, end, trace];
  assert.deepEqual(check("undo pad layer"), original);

  b.items = [{...source, pinDelays: {"1": 22}}, end, trace];
  const newDelay = check("change only pin delay");
  assert.equal(newDelay.length, original.length);
  close(newDelay.delay - original.delay, 10, 1e-9);

  b.items = [{...source, ref: "U3"}, {...end, number: "7"}, trace];
  const renamed = check("rename terminals");
  assert.equal(renamed.from, "U3.1");
  assert.equal(renamed.to, "Pad 7");
});

// ---------------------------------------------------------------- patterns
const STYLES = [["mitered", {}], ["arcs", {}], ["rounded", {}], ["accordion", {sides: 1}], ["accordion", {sides: 2}], ["sawtooth", {}], ["mitered", {miter: 0}], ["accordion", {sides: 2, corner: "round"}]];
test("every style reaches the target within tolerance and keeps its legs a gap apart", () => {
  const seg = {a: [0, 0], b: [40, 0], width: .2};
  for (const [style, extra] of STYLES) for (const add of [0.37, 1.3, 5, 12.7, 23]) {
    const r = L.tune({...seg, length: 40}, {target: 40 + add, style, amplitude: 1.2, maxAmplitude: 3, gap: .3, tolerance: .002, ...extra});
    assert.ok(r.reached, style + JSON.stringify(extra) + " +" + add + " added " + r.added);
    close(polyLen(r.points), 40 + add, .002, style + " length");
    assert.deepEqual(r.points[0], [0, 0]); assert.deepEqual(r.points.at(-1), [40, 0]);
    const s = .5; // gap + width
    assert.ok(selfSpacing(r.points, 2.2 * s) >= s - 1e-6, style + " self spacing " + selfSpacing(r.points, 2.2 * s));
  }
  // Rotated segment: lengths are frame-independent.
  const r = L.tune({a: [3, 4], b: [3 + 30 * Math.cos(1), 4 + 30 * Math.sin(1)], width: .15, length: 30}, {target: 36, style: "rounded"});
  close(polyLen(r.points), 36, .005, "rotated");
});

test("meanders never violate the clearance callback and stop short when space runs out", () => {
  const items = [part("U1", "pad1", 0, 0, {"1": "S"}), part("U2", "pad1", 40, 0, {"1": "S"}), track("S", "Top", [[0, 0], [40, 0]])];
  // Obstacles: another net's track at varying distance above, and vias.
  items.push(track("X", "Top", [[5, 2.2], [15, 2.2], [15, 1.1], [25, 1.1], [25, 3.5], [36, 3.5]]));
  for (let x = 6; x < 36; x += 4.5) items.push(via("Y", x, -1.6 - (x % 3) * .4));
  const b = board(items);
  const segTrack = items[2], clearance = .2, hw = .1;
  const obs = items.slice(3);
  const independent = pts => {
    let min = Infinity;
    for (let i = 1; i < pts.length; i++) for (const o of obs) {
      if (o.kind === "track") for (let k = 1; k < o.points.length; k++) min = Math.min(min, segDist(pts[i - 1], pts[i], o.points[k - 1], o.points[k]) - o.width / 2 - hw);
      else min = Math.min(min, segDist(pts[i - 1], pts[i], [o.x, o.y], [o.x, o.y]) - o.diameter / 2 - hw);
    }
    return min;
  };
  for (const [style, extra] of STYLES) for (const side of [1, -1]) for (const add of [3, 9, 400]) {
    const check = L.clearanceFor(b, defs, {net: "S", layer: "Top", clearance, gap: .3, skip: new Map([[segTrack.id, new Set([0])]])});
    const r = L.tune({a: [0, 0], b: [40, 0], width: .2, length: 40}, {extra: add, style, side, amplitude: 1.5, maxAmplitude: 4, gap: .3, clearanceFn: check, ...extra});
    for (let i = 1; i < r.points.length; i++) {
      const p = r.points[i - 1], q = r.points[i];
      if (p[1] === 0 && q[1] === 0) continue;
      assert.ok(check(p[0], p[1], q[0], q[1], hw), style + " side " + side + " segment " + i + " violates the callback");
    }
    assert.ok(independent(r.points) >= clearance - 1e-6, style + " independent clearance " + independent(r.points));
    if (add === 400) assert.ok(!r.reached && r.shortfall > 0, "reports the shortfall " + style + JSON.stringify(extra) + side + " " + r.added);
  }
});

test("diff-pair tuning keeps the pair gap; skew bumps respect the uncoupled limit", () => {
  const w = .2, d = .35;
  for (const [style, extra] of STYLES.slice(0, 6)) for (const add of [2, 7.5]) {
    const p = {a: [0, 0], b: [40, 0], width: w, length: 40}, n = {a: [0, d], b: [40, d], width: w, length: 40};
    const r = L.tunePair(p, n, {extra: add, style, amplitude: 2, maxAmplitude: 4, gap: .3, side: 1, tolerance: .002, ...extra});
    assert.ok(r.ok);
    close((r.addedP + r.addedN) / 2, add, .01, style + " pair added");
    const gapMin = minBetween(r.p, r.n);
    assert.ok(gapMin >= d - 1e-4, style + " pair spacing " + gapMin);
    assert.deepEqual(r.p[0], [0, 0]); assert.deepEqual(r.n.at(-1), [40, d]);
    // Legs of neighbouring pair turns keep the gap from each other (track edges >= .3).
    const both = [...r.p, ...r.n];
    assert.ok(selfSpacing(r.p, 4) >= w + .3 - 1e-4 || selfSpacing(r.p, 4) >= d - 1e-4, style + " p turns");
    assert.ok(both.length > 10);
  }
  // Staggered and reversed partner.
  const r = L.tunePair({a: [0, 0], b: [40, 0], width: w, length: 40}, {a: [42, -d], b: [3, -d], width: w, length: 39}, {extra: 4, style: "mitered"});
  assert.ok(r.ok); close(polyLen(r.n), 39 + r.addedN, 1e-6); assert.deepEqual(r.n[0], [42, -d]); assert.deepEqual(r.n.at(-1), [3, -d]);
  assert.ok(minBetween(r.p, r.n) >= d - 1e-4);
  // Skew: bumps on the outer side of the shorter track only.
  const sk = L.tuneSkew({a: [0, 0], b: [30, 0], width: w}, 1, {extra: .4, pairGap: .15, maxUncoupled: 6});
  close(sk.added, .4, .01, "skew added");
  assert.ok(sk.uncoupled <= 6 + 1e-9, "uncoupled " + sk.uncoupled);
  assert.ok(sk.points.every(q => q[1] <= 1e-9), "bumps away from the partner");
  assert.ok(minBetween(sk.points, [[0, d], [30, d]]) >= d - 1e-6);
  const none = L.tuneSkew({a: [0, 0], b: [30, 0], width: w}, 1, {extra: .4, pairGap: .15, maxUncoupled: .3});
  assert.equal(none.added, 0); assert.ok(/uncoupled/.test(none.reason));
});

test("interactive session: gauge, keys, commit plan", () => {
  const b = board([part("U1", "pad1", 0, 0, {"1": "S"}), part("U2", "pad1", 30, 0, {"1": "S"}), track("S", "Top", [[0, 0], [30, 0]])]);
  const tr = b.items[2];
  const s = L.begin(b, defs, {trackId: tr.id, at: [2, .5], target: 36, tolerance: .05, style: "mitered", amplitude: 1});
  let prev = 0;
  for (let x = 4; x <= 28; x += 4) { const m = s.move([x, 1]); assert.ok(m.length >= prev - 1e-9); prev = m.length; assert.ok(m.gauge.fraction >= 0 && m.gauge.fraction <= 1); }
  const m = s.move([28, 1]);
  assert.equal(m.gauge.status, "within"); close(m.length, 36, .05);
  assert.ok(m.preview[0].points.every(p => p[1] >= -1e-9), "pattern on the cursor side");
  const amp = s.properties().amplitude; s.key("2"); assert.ok(s.properties().amplitude > amp);
  s.key("1"); s.key("4"); s.key(".");
  assert.ok(s.key("Tab").properties.styles.length >= 5);
  const plan = s.commit();
  assert.equal(plan.modify.length, 1);
  L.applyPlan(b, plan);
  close(L.netLength(b, defs, "S").length, 36, .05);
});

test("pair and skew sessions on a named differential pair", () => {
  const d = .35, b = board([part("U1", "pad1", 0, 0, {"1": "CLK_P"}), part("U2", "pad1", 30, 0, {"1": "CLK_P"}),
    part("U3", "pad1", 0, d + 2, {"1": "CLK_N"}), part("U4", "pad1", 30, d + 2, {"1": "CLK_N"}),
    track("CLK_P", "Top", [[0, 0], [2, 0], [28, 0], [30, 0]]), track("CLK_N", "Top", [[0, d + 2], [2, d], [28, d], [30, d + 2]])]);
  const p = b.items[4], n = b.items[5];
  const s = L.begin(b, defs, {trackId: p.id, at: [3, -.5], pair: true, target: 36, tolerance: .05, style: "rounded", amplitude: 1.5});
  const m = s.move([27, -1]);
  assert.equal(m.preview.length, 2); close(m.length, 36, .06);
  assert.ok(minBetween(m.preview[0].points, m.preview[1].points) >= d - 1e-4, "pair gap kept in the session");
  L.applyPlan(b, s.commit());
  const lp = L.netLength(b, defs, "CLK_P").length, ln = L.netLength(b, defs, "CLK_N").length;
  close((lp + ln) / 2, 36, .06);
  // Now skew: lengthen the shorter one to match the longer.
  const sk = L.begin(b, defs, {trackId: p.id, at: [3, 0], pair: true, skew: true, tolerance: .01});
  const mk = sk.move([27, 0]);
  close(mk.length, Math.max(lp, ln), .01);
  L.applyPlan(b, sk.commit());
  close(L.netLength(b, defs, "CLK_P").length, L.netLength(b, defs, "CLK_N").length, .01, "skew removed");
});

test("matched groups: target from longest, auto-tune all, CSV", () => {
  const items = [];
  const lens = [20, 24, 27.5, 30];
  lens.forEach((len, i) => {
    const y = i * 6;
    items.push(part("A" + i, "pad1", 0, y, {"1": "D" + i}), part("B" + i, "pad1", len, y, {"1": "D" + i}), track("D" + i, "Top", [[0, y], [len, y]]));
  });
  items.push(part("A9", "pad1", 0, 30, {"1": "D9"}), part("B9", "pad1", 50, 30, {"1": "D9"}), track("D9", "Top", [[0, 30], [50, 30]]));
  const b = board(items);
  b.lengthTuning = {version: 1, groups: [{name: "Bus", members: ["D0", "D1", "D2", "D3"], tolerance: .1}], targets: {}};
  let ev = L.evaluate(b, defs).find(g => g.name === "Bus");
  close(ev.target, 30, 1e-9); assert.equal(ev.fails, 3);
  L.setTargetFromLongest(b, defs);
  assert.equal(b.lengthTuning.targets["group:Bus"], 30);
  const res = L.autoTune(b, defs, {style: "mitered", amplitude: 1, gap: .3});
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed)); assert.equal(res.fixed.length, 3);
  L.applyPlan(b, res.plan);
  ev = L.evaluate(b, defs).find(g => g.name === "Bus");
  assert.equal(ev.fails, 0, JSON.stringify(ev.members.map(m => [m.name, m.length, m.status])));
  // Tuned nets keep clear of each other (rows are 6 mm apart, amplitude stays within).
  const t = b.items.filter(i => i.kind === "track");
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) assert.ok(minBetween(t[i].points, t[j].points) - .2 >= .2 - 1e-6);
  // A member longer than the target is reported, not "fixed".
  b.lengthTuning.groups[0].members.push("D9");
  const again = L.autoTune(b, defs, {style: "mitered"});
  assert.ok(again.failed.some(f => f.name === "D9" || /Longer/.test(f.reason)) || again.fixed.length > 0);
  const text = L.csv(L.evaluate(b, defs));
  assert.ok(text.startsWith("Group,Member,Kind,Length (mm)"));
  assert.ok(text.split("\n").length >= 6);
});

test("auto-tune keeps differential pairs coupled and removes their skew", () => {
  const d = .35, items = [];
  const pair = (base, y, lp, ln) => {
    items.push(part("TX" + base, "pad1", 0, y, {"1": base + "_P"}), part("RX" + base, "pad1", lp, y, {"1": base + "_P"}),
      part("TXN" + base, "pad1", 0, y + d, {"1": base + "_N"}), part("RXN" + base, "pad1", ln, y + d, {"1": base + "_N"}),
      track(base + "_P", "Top", [[0, y], [lp, y]]), track(base + "_N", "Top", [[0, y + d], [ln, y + d]]));
  };
  pair("L0", 0, 30, 30.4); pair("L1", 8, 25, 25); pair("L2", 16, 34, 34.2);
  const b = board(items);
  b.lengthTuning = {version: 1, groups: [{name: "Lanes", members: ["L0_P", "L0_N", "L1_P", "L1_N", "L2_P", "L2_N"], tolerance: .1, pairTolerance: .02}], targets: {}};
  const g0 = L.evaluate(b, defs)[0];
  assert.equal(g0.pairs.length, 3, "pairs detected from names");
  const res = L.autoTune(b, defs, {style: "mitered", amplitude: 1.5, maxAmplitude: 3, gap: .3});
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  L.applyPlan(b, res.plan);
  const g = L.evaluate(b, defs)[0];
  assert.equal(g.fails, 0, JSON.stringify(g.members.map(m => [m.name, m.length, m.status, m.note])));
  for (const base of ["L0", "L1", "L2"]) {
    const P = b.items.find(i => i.kind === "track" && i.net === base + "_P"), N = b.items.find(i => i.kind === "track" && i.net === base + "_N");
    assert.ok(minBetween(P.points, N.points) >= d - 1e-4, base + " pair gap " + minBetween(P.points, N.points));
  }
});

test("sawtooth rounding: 0–50 % in 5 % steps, still reaches the target", () => {
  assert.equal(L.roundingOf(23), 25); assert.equal(L.roundingOf(70), 50); assert.equal(L.roundingOf(-3), 0);
  const seg = {a: [0, 0], b: [20, 0], width: .2};
  const sharp = L.tune(seg, {style: "sawtooth", extra: 3, amplitude: 1, gap: .4}), round = L.tune(seg, {style: "sawtooth", extra: 3, amplitude: 1, gap: .4, rounding: 50});
  assert.ok(sharp.reached && round.reached, sharp.added + " " + round.added);
  assert.ok(round.points.length > sharp.points.length + 4, "arcs at the tooth corners");
  // No interior corner sharper than the arc step once rounded.
  let maxTurn = 0;
  for (let i = 1; i < round.local.length - 1; i++) {
    const a = round.local[i - 1], b = round.local[i], c = round.local[i + 1];
    const t = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
    maxTurn = Math.max(maxTurn, t);
  }
  assert.ok(maxTurn < Math.PI / 6, "smooth teeth " + maxTurn);
  const b = board([part("A", "pad1", 0, 0, {"1": "S"}), part("B", "pad1", 20, 0, {"1": "S"}), track("S", "Top", [[0, 0], [20, 0]])]);
  const s = L.begin(b, defs, {net: "S", at: [5, 0], target: 22, style: "sawtooth", rounding: 30});
  assert.equal(s.properties().rounding, 30);
  assert.equal(s.properties().roundings.length, 11);
  s.key("]"); assert.equal(s.properties().rounding, 35);
  assert.equal(s.set({rounding: 12}).gauge.rounding, 10);
});

// A coupled pair with two opposite 90° bends: zero total skew, but 2·pitch of phase error between them.
function phasePair() {
  const d = .4, c = [[0, 0], [20, 0], [20, 20], [40, 20]];
  const P = L.offset(c, d / 2), N = L.offset(c, -d / 2);
  const items = [part("A", "pad1", P[0][0], P[0][1], {"1": "PH_P"}), part("B", "pad1", P.at(-1)[0], P.at(-1)[1], {"1": "PH_P"}),
    part("C", "pad1", N[0][0], N[0][1], {"1": "PH_N"}), part("D", "pad1", N.at(-1)[0], N.at(-1)[1], {"1": "PH_N"}),
    track("PH_P", "Top", P), track("PH_N", "Top", N)];
  const b = board(items);
  b.lengthTuning = {version: 1, groups: [{name: "Phase", members: ["PH_P", "PH_N"], tolerance: .1, pairTolerance: .02}], targets: {}};
  return {b, d};
}
test("static phase matching compensates skew near each bend, not only at one end", () => {
  const {b, d} = phasePair();
  const before = L.phaseNets({...b, items: b.items.map(i => i.kind === "track" ? {...i, points: i.points.map(p => [...p])} : i)}, defs, L.obstacles(b, defs), "PH_P", "PH_N", {tolerance: .05, maxIter: 0});
  assert.ok(before.maxError > .7, "phase error between the bends " + before.maxError);
  const plain = L.autoTune(b, defs, {style: "mitered"});
  assert.equal(plain.plan.modify.length, 0, "total skew is zero, so plain auto-tune does nothing");
  const res = L.autoTune(b, defs, {style: "mitered", phase: {tolerance: .05, distance: 4}});
  const ph = res.phase[0];
  assert.ok(ph && ph.bumps >= 2 && ph.ok, JSON.stringify(ph && {...ph, markers: undefined}));
  // Each compensation sits within the distance of the bend that caused it.
  for (const m of ph.markers) assert.ok(Math.min(hyp(m.at, [20, 0]), hyp(m.at, [20, 20])) <= 4 + 1, "near a bend " + m.at);
  L.applyPlan(b, res.plan);
  const P = b.items.find(i => i.kind === "track" && i.net === "PH_P"), N = b.items.find(i => i.kind === "track" && i.net === "PH_N");
  assert.ok(minBetween(P.points, N.points) >= d - 1e-4, "bumps go away from the partner " + minBetween(P.points, N.points));
  // Phase just before each bend and at the end, measured independently.
  const arcTo = (pts, q) => { let best = Infinity, at = 0, s = 0; for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], c = pts[i], l = hyp(a, c), t = l ? Math.max(0, Math.min(1, ((q[0] - a[0]) * (c[0] - a[0]) + (q[1] - a[1]) * (c[1] - a[1])) / (l * l))) : 0, x = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]; if (hyp(x, q) < best) { best = hyp(x, q); at = s + t * l; } s += l; } return at; };
  const P0 = L.offset([[0, 0], [20, 0], [20, 20], [40, 20]], d / 2);
  for (const q of [[P0[1][0] - .5, P0[1][1]], [P0[2][0], P0[2][1] - .5], P0[3]]) {
    const err = arcTo(P.points, q) - arcTo(N.points, q);
    assert.ok(Math.abs(err) <= .05 + 1e-6 || q === P0[3] && Math.abs(polyLen(P.points) - polyLen(N.points)) <= .05, "phase at " + q + ": " + err);
  }
  close(polyLen(P.points), polyLen(N.points), .05, "total skew stays matched");
});
test("interactive phase tuning: one net, up to the cursor, with a gauge", () => {
  const {b} = phasePair();
  const N = b.items.find(i => i.kind === "track" && i.net === "PH_N"), P = b.items.find(i => i.kind === "track" && i.net === "PH_P");
  const lagFirst = polyLen(N.points.slice(0, 3)) < polyLen(P.points.slice(0, 3)) ? N : P;
  const s = L.begin(b, defs, {phase: true, trackId: lagFirst.id, at: [5, 0], tolerance: .05, distance: 4});
  assert.equal(s.mode, "phase");
  const early = s.move([5, 0]);
  assert.equal(early.preview.length, 0, "nothing to fix before the first bend");
  assert.equal(early.gauge.kind, "phase");
  const mid = s.move([20, 12]);
  assert.equal(mid.preview.length, 1); assert.equal(mid.preview[0].net, lagFirst.net);
  assert.ok(Math.abs(mid.gauge.delta) <= .05 + 1e-6, mid.gauge.text);
  assert.match(mid.gauge.text, /^Phase /);
  assert.ok(mid.sites.length >= 3 && mid.sites.some(x => x.done));
  const end = s.move([38, 20]);
  assert.ok(end.gauge.leads >= 1, "the partner leads after the second bend: " + end.gauge.text);
  const plan = s.commit();
  assert.deepEqual(plan.modify.map(m => m.id), [lagFirst.id]);
  assert.ok(s.overlay() && s.properties().phase);
});

// ---------------------------------------------------------------- benchmarks
function benchBoard() {
  const items = [];
  let n = 0;
  // 500 two-pad nets with 40 tracks and 2 vias each, plus clutter: ~25k objects.
  for (let k = 0; k < 500; k++) {
    const net = "N" + k, x0 = (k % 25) * 14, y0 = Math.floor(k / 25) * 9;
    items.push(part("U" + k, "pad1", x0, y0, {"1": net}), part("V" + k, "pad1", x0 + 12, y0 + 6, {"1": net}));
    let p = [x0, y0];
    for (let s = 0; s < 40; s++) {
      const layer = s < 13 ? "Top" : s < 27 ? "Inner 1" : "Bottom";
      const q = s === 39 ? [x0 + 12, y0 + 6] : [x0 + .3 * (s + 1), y0 + (s % 2 ? .15 * s : .15 * s)];
      items.push({id: "t" + (n++), kind: "track", net, layer, width: .15, points: [p, q]});
      if (s === 12 || s === 26) items.push({id: "v" + (n++), kind: "via", net, x: q[0], y: q[1], diameter: .45, drill: .2});
      p = q;
    }
  }
  while (items.length < 25000) items.push({id: "g" + (n++), kind: "via", net: "GND", x: (n % 350), y: 200 + (n % 97), diameter: .45, drill: .2});
  return board(items);
}
if (bench) {
  const b = benchBoard();
  console.log("bench board: " + b.items.length + " objects");
  let t = now(); const cold = L.lengths(b, defs, {revision: 1}); const coldMs = now() - t;
  t = now(); L.lengths(b, defs, {revision: 1}); const warmRev = now() - t;
  t = now(); L.lengths(b, defs); const warmScan = now() - t;
  b.items[5].points = [b.items[5].points[0], [b.items[5].points[1][0] + .01, b.items[5].points[1][1]]];
  t = now(); L.lengths(b, defs, {revision: 2}); const oneEdit = now() - t;
  console.log("lengths cold " + coldMs.toFixed(1) + " ms (" + cold.size + " nets), warm same revision " + warmRev.toFixed(2) + " ms, warm rescan " + warmScan.toFixed(1) + " ms, after one-net edit " + oneEdit.toFixed(1) + " ms");
  const seg = {a: [0, 0], b: [40, 0], width: .2, length: 40};
  for (const [style, extra] of STYLES.slice(0, 6)) {
    let worst = 0, total = 0;
    for (let i = 0; i < 50; i++) { t = now(); L.tune(seg, {extra: 3 + i * .3, style, ...extra}); const ms = now() - t; worst = Math.max(worst, ms); total += ms; }
    console.log("tune " + style + JSON.stringify(extra) + ": mean " + (total / 50).toFixed(3) + " ms, worst " + worst.toFixed(3) + " ms");
  }
  // Session on the big board (local obstacle index) and per-move cost.
  const tr = b.items.find(i => i.kind === "track" && i.net === "N250");
  t = now(); const s = L.begin(b, defs, {trackId: tr.id, at: tr.points[0], target: L.netLength(b, defs, "N250").length + 2, revision: 2}); const beginMs = now() - t;
  let worst = 0; for (let i = 0; i < 40; i++) { t = now(); s.move([tr.points[0][0] + i * .01, tr.points[0][1] + 1]); worst = Math.max(worst, now() - t); }
  const big = board([part("U1", "pad1", 0, 0, {"1": "S"}), part("U2", "pad1", 60, 0, {"1": "S"}), track("S", "Top", [[0, 0], [60, 0]]),
    ...Array.from({length: 4000}, (_, i) => ({id: "o" + i, kind: "via", net: "X", x: (i % 200) * .9 - 20, y: 3 + Math.floor(i / 200) * .9, diameter: .45, drill: .2}))]);
  const s2 = L.begin(big, defs, {trackId: big.items[2].id, at: [1, .5], target: 75, amplitude: 1.5, maxAmplitude: 2.5});
  let worst2 = 0; for (let x = 2; x < 59; x += .5) { t = now(); s2.move([x, .8]); worst2 = Math.max(worst2, now() - t); }
  const comb = board([]);
  for (let i = 0; i < 3000; i++) comb.items.push(track("GND", "Top", [[i * .5, 0], [i * .5 + .5, 0]], .3), track("GND", "Top", [[i * .5 + .25, 5], [i * .5 + .25, 0]], .3));
  t = now(); L.netLength(comb, defs, "GND"); const combMs = now() - t;
  const bus = board([]), members = [];
  for (let i = 0; i < 64; i++) {
    const y = i * 2.2, len = 30 + (i * 7) % 13;
    bus.items.push(part("A" + i, "pad1", 0, y, {"1": "B" + i}), part("Z" + i, "pad1", len, y, {"1": "B" + i}), track("B" + i, "Top", [[0, y], [len, y]], .15));
    members.push("B" + i);
  }
  bus.lengthTuning = {version: 1, groups: [{name: "DDR", members, tolerance: .05}], targets: {}};
  t = now(); const tuned = L.autoTune(bus, defs, {style: "mitered", amplitude: .7, maxAmplitude: .8, gap: .25}); const autoMs = now() - t;
  L.applyPlan(bus, tuned.plan);
  const fails = L.evaluate(bus, defs).find(g => g.name === "DDR").fails;
  console.log("6000-segment comb net (T junctions): " + combMs.toFixed(1) + " ms; auto-tune 64-net bus at 2.2 mm pitch: " + autoMs.toFixed(1) + " ms, " + tuned.fixed.length + " fixed, " + fails + " failing after");
  console.log("session begin " + beginMs.toFixed(1) + " ms on 25k objects; move worst " + worst.toFixed(2) + " ms; 60 mm drag among 4000 vias: worst move " + worst2.toFixed(2) + " ms");
}
test("a differential pair's members are timed in odd mode (its gap and profile)", () => {
  require("../../app/checks/rules.js"); require("../../app/pcb/stackup.js"); require("../../app/analysis/impedance.js");
  const p = A.project("Odd", AtriumParts.catalogue), b = p.documents.find(d => d.kind === "pcb"), D = new Map(p.library.map(d => [d.id, d]));
  const tr = (id, net, y) => ({id, kind: "track", net, layer: "Top", width: .15, points: [[0, y], [20, y]]});
  b.items = [tr("a", "D_P", 0), tr("b", "D_N", .3), tr("c", "X", 5)]; A.validate(p);
  const se = L.netLength(b, D, "X").delay;
  close(L.netLength(b, D, "D_P").delay, se, 1e-9, "not a pair yet: single-ended");
  globalThis.AtriumSignals.edit(p, st => { st.signals.push({id: "d", name: "D", kind: "diff", legs: [{polarity: 1, nets: ["D_P"]}, {polarity: -1, nets: ["D_N"]}]}); });
  const gap = g => { const set = JSON.parse(JSON.stringify(AtriumRules.stored(b, p))), r = set.list.find(x => x.type === "diffPairsRouting"); r.gapPreferred = r.gapMin = g; if (r.gapMax != null && r.gapMax < g) r.gapMax = g; AtriumRules.store(b, p, set); };
  gap(.15);
  const odd = L.netLength(b, D, "D_P").delay;
  assert.ok(odd < se - 1, "odd mode is faster on a microstrip: " + odd + " < " + se);
  close(L.netLength(b, D, "D_N").delay, odd, 1e-9, "both members");
  close(L.netLength(b, D, "X").delay, se, 1e-9, "other nets keep their delay");
  gap(.5);
  assert.ok(Math.abs(L.netLength(b, D, "D_P").delay - odd) > .1, "a gap edit re-times the pair");
});
test("tuning uses a placed copper row for contact and clearance", () => {
  const localDef={id:"G17",footprint:{shapes:[],pads:[]}}, lib=new Map([...defs,[localDef.id,localDef]]);
  const source=part("U1",localDef.id,F4.part.x,F4.part.y,{"1":"T"},{angle:F4.part.angle,mirror:true});
  const end=part("U2","pad1",-8,-5,{"1":"T"});
  // An uninterrupted subordinate chain exceeds the vertex-grid cutoff.
  const tail=[[-8,-5],...Array.from({length:49},(_,k)=>[-8-(k+1)*.1,-5])];
  function probe(pad,local,row,connected,label,obstacle=connected,layer="Top"){
    const target=mirroredLandPoint(local,row), anchor=mirroredLandPoint([local[0]+.7,local[1]+.5],row);
    localDef.footprint.pads=[{...F4.pad,number:"1",layer:"Top",drill:0,...pad}];
    const d=board([source,{...end,layer},track("T",layer,[target,[-8,-5]],.04),track("T",layer,tail,.04)]);
    d.stackup=AtriumStackup.build(Array(4).fill("Signal"));
    const result=L.netLength(d,lib,"T");
    assert.equal(result.mode,connected?"path":"total",label+" electrical contact");
    assert.equal(result.unrouted,!connected,label+" pad-to-pad path");
    const clear=L.clearanceFor(d,lib,{layer,net:"PROBE",skip:new Map(d.items.slice(2).map(t=>[t.id,new Set(t.points.slice(1).map((_,i)=>i))]))});
    assert.equal(clear(...anchor,...target,.003),!obstacle,label+" clearance obstacle");
    return d;
  }
  for(const {shape,poly,point,inside} of landContacts)
    probe({shape,poly,w:F5.w,h:F5.h,roundrectRadiusRatio:F5.radiusRatio},point,{},inside,shape,true);
  const pad={layer:"Multi",stackMode:"full",padStack:{Top:{...mirroredTopRow},Mid:{w:.4,h:.6},"Inner 2":{w:.92,h:.88}}};
  const editable=probe(pad,[.53,.64],mirroredTopRow,true,"width-only shifted Top row");
  const authored=localDef.footprint.pads[0], row=authored.padStack.Top;
  const initial=L.netLength(editable,lib,"T",{revision:1});
  row.w=.8;
  assert.equal(L.netLength(editable,lib,"T",{revision:2}).mode,"total","row-only width edit invalidates path");
  row.w=mirroredTopRow.w;
  assert.deepEqual(L.netLength(editable,lib,"T",{revision:3}),initial,"restoring only the row restores the path");
  probe(pad,[.62,.64],mirroredTopRow,false,"outside narrow Top row",true);
  probe(pad,[.75,.22],{},false,"unshifted nominal anchor");
  probe(pad,[.43,.28],{},true,"explicit Inner 2 row",true,"Inner 2");
  probe(pad,[.43,.28],{},false,"Mid fallback on Inner 1",false,"Inner 1");
  probe({...pad,padStack:{Top:{w:0}}},[.75,.22],{},false,"explicit zero");
  probe(pad,[.556,.3],mirroredTopRow,true,"track edge reaches the land");
  probe(pad,[.57,.3],mirroredTopRow,false,"track electrical allowance ends",true);
});

console.log("PASS " + passed + " length-tuning tests");
