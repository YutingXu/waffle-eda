"use strict";
// DFA spacing matrix: package types, matrix lookup, body/courtyard gaps, sides, the
// dfaSpacing DRC rule, starter rule sets, live check and speed on a dense board.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "stackup", "altium-rules", "rules", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "rule-sets", "dfa"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, D = AtriumDFA, R = AtriumRules;
const close = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, (m || "") + " " + a + " differs from " + b);

// ---- package types ---------------------------------------------------------------------------
const chip = (id, name, L) => ({id, name, footprint: {name, shapes: [{kind: "path", style: "package", closed: true, points: [[-L / 2, -L / 4], [L / 2, -L / 4], [L / 2, L / 4], [-L / 2, L / 4]]}],
  pads: [{number: "1", x: -L / 2, y: 0, w: L / 3, h: L / 2, drill: 0}, {number: "2", x: L / 2, y: 0, w: L / 3, h: L / 2, drill: 0}]}});
const c0402 = chip("c0402", "C_0402", 1), r0603 = chip("r0603", "R_0603_1608Metric", 1.6);
const bga = {id: "bga", name: "FPGA", footprint: {name: "BGA-256", wizard: {family: "bga", preset: "BGA-256 1.0"}, courtyard: [-9, -9, 9, 9],
  shapes: [{kind: "path", layer: "Mechanical 13", style: "assembly", closed: true, points: [[-8.5, -8.5], [8.5, -8.5], [8.5, 8.5], [-8.5, 8.5]]}], pads: [{number: "A1", x: -7.5, y: -7.5, w: .5, h: .5}]}};
const hdr = {id: "hdr", name: "Header", footprint: {name: "PinHeader_1x2", pads: [{number: "1", x: 0, y: 0, w: 1.7, h: 1.7, drill: 1}, {number: "2", x: 2.54, y: 0, w: 1.7, h: 1.7, drill: 1}], shapes: []}};
const qfnParam = {id: "u", name: "Sensor", parameters: {"DFA Package": "qfn"}, footprint: {name: "Weird", pads: [{number: "1", x: 0, y: 0, w: 2, h: 2}], shapes: []}};
const wizChip = {id: "w", name: "X", footprint: {name: "RESC1005X40N", wizard: {family: "chip", preset: "0402"}, pads: [{number: "1", x: 0, y: 0, w: .5, h: .5}], shapes: []}};
assert.equal(D.packageType({}, c0402), "0402");
assert.equal(D.packageType({}, r0603), "0603");
assert.equal(D.packageType({}, bga), "bga");
assert.equal(D.packageType({}, hdr), "connector", "a header name reads as a connector");
assert.equal(D.packageType({}, qfnParam), "qfn", "a library parameter names the type");
assert.equal(D.packageType({parameters: {"Package Type": "BGA"}}, c0402), "bga", "a part parameter wins");
assert.equal(D.packageType({}, wizChip), "0402", "the IPC wizard family and preset");
assert.equal(D.packageType({}, {id: "t", name: "Thing", footprint: {name: "Odd", pads: [{number: "1", x: 0, y: 0, w: 1, h: 1, drill: .8}], shapes: []}}), "tht");
assert.equal(D.fromText("SOIC-8"), "soic"); assert.equal(D.fromText("LQFP-64"), "qfp"); assert.equal(D.fromText("SOT-23-5"), "sot"); assert.equal(D.fromText("QFN-32"), "qfn");

// ---- matrix lookup -------------------------------------------------------------------------
const rule = D.defaultRule();
assert.equal(D.gapFor(rule, "0402", "0402"), .2);
assert.equal(D.gapFor(rule, "bga", "0402"), 1, "BGA–any");
assert.equal(D.gapFor(rule, "0603", "0402"), .25, "exact pair in either order");
assert.equal(D.gapFor(rule, "melf", "sod"), rule.defaultGap, "no entry: the default gap");
assert.equal(D.gapFor(rule, "bga", "connector"), 1, "the larger of two type–any entries");
D.setGap(rule, "melf", "sod", .33); assert.equal(D.gapFor(rule, "sod", "melf"), .33);
D.setGap(rule, "sod", "melf", null); assert.equal(D.gapFor(rule, "melf", "sod"), rule.defaultGap);
assert.doesNotThrow(() => D.validateMatrix(rule.matrix));
assert.throws(() => D.validateMatrix([{a: "nope", b: "any", gap: 1}]), /Unknown package type/);

// ---- geometry and check ----------------------------------------------------------------------
const defs = new Map([c0402, r0603, bga, hdr].map(d => [d.id, d]));
const part = (id, def, x, y, extra = {}) => ({id, kind: "part", def, ref: id, x, y, angle: 0, pinNets: {}, ...extra});
// Two 0402 bodies (1 mm long) 0.15 mm apart: closer than 0.2 mm.
const doc = {kind: "pcb", id: "b", name: "DFA", items: [part("C1", "c0402", 0, 0), part("C2", "c0402", 1.15, 0), part("C3", "c0402", 3, 0),
  part("U1", "bga", 14, 0), part("C4", "c0402", 4, 9.2, {layer: "Bottom"}), part("J1", "hdr", -6, 0)], outline: [[-20, -20], [40, -20], [40, 20], [-20, 20]]};
let res = D.check(doc, defs, rule);
const pairOf = v => v.refs.slice().sort().join("-");
assert.deepEqual(res.violations.map(pairOf).sort(), ["C1-C2"], "only C1–C2 are too close");
close(res.violations[0].actual, .15); close(res.violations[0].required, .2);
// BGA–any 1.0 mm: C3 body ends at 3.5; the BGA body starts at 5.5 → 2 mm, fine. Move the BGA closer.
doc.items[3].x = 12.2;  // body from 3.7: 0.2 mm from C3
res = D.check(doc, defs, rule);
assert.ok(res.violations.some(v => pairOf(v) === "C3-U1" && Math.abs(v.required - 1) < 1e-9), "BGA–any applies");
// Bottom-side C4 overlaps the BGA in plan but is on the other side: skipped, unless sides = both.
doc.items[4].x = 12; doc.items[4].y = 0;
assert.ok(!D.check(doc, defs, rule).violations.some(v => v.refs.includes("C4")), "opposite sides are not checked");
assert.ok(D.check(doc, defs, {...rule, sides: "both"}).violations.some(v => v.refs.includes("C4")), "Both sides checks them");
// Through-hole parts conflict on both sides.
doc.items[4].x = -6; doc.items[4].y = 1.6;
assert.ok(D.check(doc, defs, rule).violations.some(v => pairOf(v) === "C4-J1"), "a through-hole part blocks the other side too");
// Courtyard: the BGA courtyard (±9) is wider than its body (±8.5).
doc.items[4].x = 30; doc.items[3].x = 13.2;  // body from 4.7 (1.2 mm from C3), courtyard from 4.2
assert.ok(!D.check(doc, defs, rule).violations.some(v => pairOf(v) === "C3-U1"), "body gap 1.2 mm passes");
assert.ok(D.check(doc, defs, {...rule, measure: "courtyard"}).violations.some(v => pairOf(v) === "C3-U1"), "courtyard gap fails");
// Rotation: C2 turned 90° is 0.5 mm wide along x, so the gap to C1 grows.
doc.items[1].angle = 90; doc.items[1].x = 1.15;
res = D.check(doc, defs, rule);
assert.ok(!res.violations.some(v => pairOf(v) === "C1-C2"), "rotated C2: " + JSON.stringify(res.violations.map(pairOf)));
doc.items[1].angle = 0;

// ---- rules engine ------------------------------------------------------------------------------
assert.ok(R.types.dfaSpacing && R.checkedTypes.includes("dfaSpacing") && R.categories.includes("Placement"));
const rules = R.create();
assert.ok(!rules.list.some(r => r.type === "dfaSpacing"), "no DFA rule by default");
rules.list.push(D.defaultRule());
const valid = R.validate(R.normalize(rules));
assert.equal(valid.list.find(r => r.type === "dfaSpacing").matrix.length, D.DEFAULT_MATRIX.length);
assert.throws(() => R.validate({...valid, list: valid.list.map(r => r.type === "dfaSpacing" ? {...r, matrix: [{a: "bogus", b: "any", gap: 1}]} : r)}), /package type pairs/);
assert.match(R.describe(valid.list.find(r => r.type === "dfaSpacing"), "mm"), /Matrix=11 package pairs/);
const out = R.drc(doc, defs, valid, {types: ["dfaSpacing"]});
assert.equal(out.total, 1, JSON.stringify(out.violations));
assert.equal(out.violations[0].type, "dfaSpacing");
assert.match(out.violations[0].title, /C1 \(0402\) ↔ C2 \(0402\)/);
// A component-scoped rule: C1 may sit at 0.1 mm.
const scoped = R.normalize({...valid, list: [...valid.list, {...D.defaultRule({id: "dfa-c1", name: "DFA_C1", scope: {kind: "component", value: "C1"}}), priority: 0.5, matrix: [{a: "0402", b: "0402", gap: .1}]}]});
assert.equal(R.drc(doc, defs, scoped, {types: ["dfaSpacing"]}).total, 0, "the C1 rule allows 0.1 mm");
// Starter rule sets carry the default matrix.
for (const s of AtriumRuleSets.starters()) assert.ok(s.rules.list.some(r => r.type === "dfaSpacing" && r.matrix.length === D.DEFAULT_MATRIX.length), s.name + " has a DFA rule");
assert.equal(D.activeRule({rules: valid}, null).type, "dfaSpacing");

// ---- live check (moving parts against a static index) -----------------------------------------
const live = D.liveCheck(doc, defs, rule, [{...doc.items[2], x: 1.1 + 1.15}], 1);
assert.ok(live.violations.some(v => v.refs.includes("C2")), "a part dragged next to C2 is flagged");

// ---- speed: 2 000+ parts on the dense benchmark board -------------------------------------------
require("../pcb/dense-board.js");
const bench = makeAtriumBenchmarkBoard(160);
const t0 = Date.now(), big = D.check(bench.d, bench.defs, rule);
const ms = Date.now() - t0;
assert.ok(big.parts > 2000, "parts " + big.parts);
assert.ok(ms < 1500, "DFA check on " + big.parts + " parts took " + ms + " ms");
const sel = bench.d.items.filter(i => i.kind === "part").slice(0, 20);
const t1 = Date.now(); for (let k = 0; k < 10; k++) D.liveCheck(bench.d, bench.defs, rule, sel.map(p => ({...p, x: p.x + k * .01})), 7);
const liveMs = (Date.now() - t1) / 10;
assert.ok(liveMs < 30, "live check per frame " + liveMs + " ms");
{
  const fp={id:"cache-fp",name:"C",footprint:{name:"C_0402",courtyard:[-.5,-.3,.5,.3],
    shapes:[{kind:"path",style:"package",closed:true,points:[[-.4,-.2],[.4,-.2],[.4,.2],[-.4,.2]]}],
    pads:[{number:"1",x:0,y:0,w:.4,h:.3}]}};
  const lib=new Map([["cache-fp",fp]]);
  const doc={kind:"pcb",id:"b",name:"DFA",items:[
    {id:"C1",kind:"part",def:"cache-fp",ref:"C1",x:0,y:0,angle:0,pinNets:{}},
    {id:"C2",kind:"part",def:"cache-fp",ref:"C2",x:1.3,y:0,angle:0,pinNets:{}}],outline:[]};
  const rule=D.defaultRule({measure:"courtyard",defaultGap:.2,matrix:[]});
  assert.equal(D.check(doc,lib,rule).violations.length,0);
  fp.footprint.courtyard=[-.9,-.6,.9,.6];
  const after=D.check(doc,lib,rule);
  assert.equal(after.violations.length,1);
  close(after.violations[0].actual,0);
  fp.footprint.courtyard.splice(0,4,-.5,-.3,.5,.3);
  assert.equal(D.check(doc,lib,rule).violations.length,0);
}

console.log("dfa: types, matrix, sides, courtyard, DRC rule, starters, live (" + big.parts + " parts " + ms + " ms, live " + liveMs.toFixed(1) + " ms/frame) OK");
