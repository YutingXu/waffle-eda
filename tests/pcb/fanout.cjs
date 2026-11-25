"use strict";
// Fanout tests. Run with Node 18+: node tests/pcb/fanout.cjs
const assert = require("node:assert/strict");
const H = require("./autorouter.cjs");
require("../../app/pcb/fanout.js");
const A = globalThis.Atrium, F = globalThis.AtriumFanout, AR = globalThis.AtriumAutorouter, C = globalThis.AtriumConnectivity;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function applyAndCheck(d, defs, plan) {
  const before = new Set(d.items.map(i => i.id));
  AR.apply(d, plan);
  const fresh = new Set(d.items.filter(i => !before.has(i.id)).map(i => i.id));
  const violations = H.clearanceViolations(d, defs, fresh);
  const outside = H.outsideOutline(d, fresh, 0.2);
  const conn = C.inspect(d, defs);
  return {fresh, violations, outside, shorts: conn.shorts};
}
// Every new via must be joined to a pad of its net by its escape track.
function viasReachPads(d, defs, plan) {
  const vias = plan.add.filter(i => i.kind === "via");
  const tracks = plan.add.filter(i => i.kind === "track");
  for (const v of vias) {
    const t = tracks.find(t => t.net === v.net && Math.hypot(t.points[1][0] - v.x, t.points[1][1] - v.y) < 1e-6);
    const under = !t && d.items.some(p => p.kind === "part" && A.pins(p, defs.get(p.def), "pcb").some(q => Math.hypot(q.at[0] - v.x, q.at[1] - v.y) < 1e-6));
    assert.ok(t || under, "via of " + v.net + " has no escape track");
  }
}

const tests = [];
const test = (name, fn) => tests.push({name, fn});

test("classifies BGA, QFP, SOIC and small parts", () => {
  const defs = new Map(H.footprints().map(d => [d.id, d]));
  const part = (def, angle = 0) => ({id: def, kind: "part", def, x: 10, y: 10, angle, pinNets: {}, ref: "U1"});
  assert.equal(F.classify(F.partPads(part("bga8"), defs.get("bga8"))).kind, "bga");
  assert.equal(F.classify(F.partPads(part("bga8"), defs.get("bga8"))).pitch.toFixed(3), "0.800");
  assert.equal(F.classify(F.partPads(part("qfp64", 90), defs.get("qfp64"))).kind, "qfp");
  assert.equal(F.classify(F.partPads(part("qfp64"), defs.get("qfp64"))).pitch.toFixed(3), "0.500");
  assert.equal(F.classify(F.partPads(part("soic14"), defs.get("soic14"))).kind, "soic");
  assert.equal(F.classify(F.partPads(part("r0603"), defs.get("r0603"))).kind, "small");
});
test("BGA dog-bone fanout: escape analysis, no violations, no shorts", () => {
  const {d, defs} = H.routingBoard({seed: 5, bga: true, ics: 6, passives: 40});
  const bga = d.items.find(i => i.def === "bga8");
  assert.ok(bga, "the generator places a BGA");
  const plan = F.plan(d, defs, {components: [bga.id]});
  const comp = plan.report.components[0];
  assert.equal(comp.kind, "bga");
  assert.ok(comp.escape.rings.length === 4);
  assert.equal(comp.escape.rings[0].via, false, "the outer ring escapes on the top layer");
  assert.ok(plan.report.vias > 0);
  viasReachPads(d, defs, plan);
  const r = applyAndCheck(d, defs, plan);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.shorts, []);
  assert.deepEqual(r.outside, []);
  // fanning again finds nothing new: every pad is connected or skipped
  assert.equal(F.plan(d, defs, {components: [bga.id]}).report.vias, 0);
});
test("BGA centred placement puts vias at the centre of four balls", () => {
  const {d, defs} = H.routingBoard({seed: 5, bga: true, ics: 2, passives: 10});
  const bga = d.items.find(i => i.def === "bga8");
  const plan = F.plan(d, defs, {components: [bga.id], viaPlacement: "centered", escapeOuter: false, powerNets: true, connectedOnly: false});
  assert.ok(plan.report.vias > 20);
  for (const v of plan.add.filter(i => i.kind === "via")) {
    // an 8 × 8 array has balls at odd multiples of half the pitch, so square centres sit on whole pitches
    const fx = (v.x - bga.x) / 0.8, fy = (v.y - bga.y) / 0.8;
    assert.ok(Math.abs(fx - Math.round(fx)) < 1e-6 && Math.abs(fy - Math.round(fy)) < 1e-6, "via off the ball grid centre");
  }
  assert.deepEqual(applyAndCheck(d, defs, plan).violations, []);
});
test("every style and direction on fine-pitch QFPs and SOICs is clean", () => {
  for (const style of ["auto", "inline", "staggeredIn", "staggeredOut"]) for (const direction of ["in", "out", "inThenOut", "outThenIn", "alternating"]) {
    const {d, defs} = H.routingBoard({seed: 3, ics: 6, passives: 30});
    const plan = F.plan(d, defs, {style, direction});
    assert.ok(plan.report.vias > 0, style + "/" + direction + " placed no vias");
    viasReachPads(d, defs, plan);
    const r = applyAndCheck(d, defs, plan);
    assert.deepEqual(r.violations, [], style + "/" + direction);
    assert.deepEqual(r.shorts, [], style + "/" + direction);
    assert.deepEqual(r.outside, [], style + "/" + direction);
  }
});
test("direction Disable and power nets are honoured", () => {
  const {d, defs} = H.routingBoard({seed: 3, ics: 4, passives: 20});
  assert.equal(F.plan(d, defs, {direction: "disable"}).report.vias, 0);
  const plain = F.plan(d, defs, {});
  assert.ok(!plain.add.some(i => i.net === "GND" || i.net === "VCC"));
  assert.ok(plain.report.skipped.some(s => /Power net/.test(s.reason)));
  const power = F.plan(d, defs, {powerNets: true});
  assert.ok(power.add.some(i => i.net === "GND" || i.net === "VCC"));
});
test("fanout then autoroute on a BGA board completes cleanly", () => {
  const {d, defs} = H.routingBoard({seed: 9, bga: true, ics: 8, passives: 60});
  const t = now();
  const r = H.routeAndCheck(d, defs, {fanout: true, fanoutOptions: {auto: "bga"}, layers: ["Top", "Inner 1", "Inner 2", "Bottom"]});
  const rep = r.plan.report;
  console.log("    BGA board: fanout " + (rep.fanout?.vias || 0) + " vias, routed " + rep.routed + "/" + rep.total + " in " + (now() - t).toFixed(0) + " ms, violations " + r.violations.length);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.shorts, []);
  assert.ok(rep.routed / rep.total >= 0.9);
});

test("thermal via-in-pad follows a rotated exposed pad", () => {
  const fp = {name: "ep", pads: [
    {number: "1", x: -15, y: 0, w: .4, h: .8, layer: "Top"},
    {number: "2", x: 15, y: 0, w: .4, h: .8, layer: "Top"},
    {number: "EP", x: 0, y: 0, w: 5, h: 2, angle: 90, layer: "Top", shape:"rect"}]};
  const def = {id: "ep", footprint: fp};
  const part = {id: "u", kind: "part", def: "ep", ref: "U1", x: 20, y: 20, angle: 0, pinNets: {"1": "A", "2": "B", EP: "GND"}};
  const doc = A.sheet("pcb", "Fan");
  doc.outline = [[0, 0], [40, 0], [40, 40], [0, 40]];
  doc.items = [part, {id: "g", kind: "pad", x: 5, y: 5, w: 1, h: 1, layer: "Top", net: "GND"}];
  const plan = F.planV2(doc, new Map([["ep", def]]), {components: [part.id], powerNets: true, connectedOnly: false});
  const ep = F.partPads(part, def).find(p => p.number === "EP");
  const vias = plan.add.filter(i => i.kind === "via" && i.net === "GND" && i.viaInPad);
  const local = vias.map(v => A.rotate([v.x - ep.at[0], v.y - ep.at[1]], -(ep.pad.angle || 0)));
  const span = k => Math.max(...local.map(p => p[k])) - Math.min(...local.map(p => p[k]));
  assert.ok(vias.length >= 2, "thermal vias were placed");
  for (const [i,[u,v]] of local.entries()) {
    const r=vias[i].diameter/2;
    assert.ok(Math.abs(u)+r<=ep.pad.w/2+1e-6 && Math.abs(v)+r<=ep.pad.h/2+1e-6,"via land off the exposed pad at " + u + "," + v);
  }
  assert.ok(span(0) >= 3, "array runs along the pad's long axis, span " + span(0));
  assert.ok(span(1) <= ep.pad.h, "array stays on the pad's short axis, span " + span(1));
});

let failed = 0;
for (const t of tests) {
  try { const s = now(); t.fn(); console.log("ok   " + t.name + " (" + (now() - s).toFixed(0) + " ms)"); }
  catch (error) { failed++; console.log("FAIL " + t.name + "\n" + (error && (error.message + "\n" + error.stack) || error)); }
}
console.log(tests.length - failed + "/" + tests.length + " fanout tests passed");
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " fanout test" + (failed === 1 ? "" : "s") + " failed"); }
