"use strict";
// Design Insights (app/checks/insights.js, insights-pcb.js, insights-sch.js): every check finds a crafted case
// (positive) and stays quiet on the same design built well (negative); fixes are one edit that clears
// the insight; keys survive moves and change with geometry; dismissals live in project.insights and
// survive validation and an older/newer store; the incremental engine matches a full run; MCP output;
// cost on the 25.6k-object board.
// Run: scripts/test-jsc.sh insights   (or node tests/checks/insights.cjs)
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "connectivity", "sch-objects", "pcb-pours", "pcb-appearance", "stackup", "impedance", "rigid-flex", "altium-rules", "net-intent", "signals", "rules",
  "board-shape", "viastack", "polygon-pour", "pdn", "ipc2152", "si", "return-path", "erc", "design-query", "undo-store", "insights", "insights-pcb", "insights-sch", "problem-marks", "insights-ui"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../pcb/dense-board.js");
const A = Atrium, I = AtriumInsights, S = AtriumStackup, R = AtriumRules, PP = AtriumPolygonPour;
const now = () => globalThis.performance?.now?.() ?? Date.now();
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
let uid = 0;
const id = p => (p || "i") + (++uid);
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const stack4 = () => ({version: 1, layers: S.build(["Signal", "Plane", "Plane", "Signal"]).layers});
const track = (net, layer, points, width = .2, extra = {}) => ({id: id("t"), kind: "track", net, layer, width, points, ...extra});
const via = (net, x, y, extra = {}) => ({id: id("v"), kind: "via", net, x, y, diameter: .6, drill: .3, layer: "Multi", ...extra});
const poly = (net, layer, points, extra = {}) => ({id: id("p"), kind: "polygon", net, layer, points, ...extra});
const ic = {id: "ic8", name: "IC", prefix: "U", footprint: {shapes: [], pads: Array.from({length: 8}, (_, i) => ({number: String(i + 1), x: 0, y: 1.27 * i, w: .6, h: .6, shape: "rect"}))}};
const cap = {id: "c0402", name: "C", prefix: "C", footprint: {shapes: [], pads: [{number: "1", x: -.5, y: 0, w: .5, h: .6, shape: "rect"}, {number: "2", x: .5, y: 0, w: .5, h: .6, shape: "rect"}]}};
const big = {id: "qfn", name: "QFN", prefix: "U", footprint: {shapes: [], pads: [{number: "1", x: 0, y: 0, w: 3, h: 3, shape: "rect"}, {number: "2", x: 3, y: 0, w: .4, h: .8, shape: "rect"}, {number: "3", x: -3, y: 0, w: .4, h: .8, shape: "rect"}]}};
const tht = {id: "tht", name: "Header", prefix: "J", footprint: {shapes: [], pads: [{number: "1", x: 0, y: 0, w: 1.7, h: 1.7, drill: 1, shape: "round"}, {number: "2", x: 2.54, y: 0, w: 1.7, h: 1.7, drill: 1, shape: "round"}]}};
const library = [ic, cap, big, tht];
const defs = new Map(library.map(d => [d.id, d]));
const part = (ref, def, x, y, pinNets, extra = {}) => ({id: id("u"), kind: "part", def, ref, value: ref, x, y, angle: 0, pinNets, ...extra});
function board(items, extra = {}) { const d = A.sheet("pcb", "Board"); d.outline = rect(0, 0, 60, 40); d.stackup = stack4(); d.items.push(...items); return Object.assign(d, extra); }
// A board's rules in these cases (doc.rules here) are the project's: the rule book (project.rules,
// app/checks/project-rules.js), and differential pairs signals (project.signals).
const project = (...documents) => {
  const p = {format: "atrium", version: 1, formatVersion: "1.4", name: "Insights", library, documents};
  const b = documents.find(d => d.kind === "pcb" && d.rules);
  if (b) {
    const keys = Object.fromEntries(["ruleSets", "netCurrents", "classCurrents"].filter(k => b.rules[k] !== undefined).map(k => [k, b.rules[k]]));
    p.rules = {format: "atrium-rules", version: 3, units: "mm", list: b.rules.list, ...(Object.keys(keys).length ? {keys} : {})};
    if (b.rules.diffPairs?.length) p.signals = {version: 1, tags: [], nets: {}, signals: b.rules.diffPairs.map(x => ({id: "s-" + x.name, name: x.name, kind: "diff", span: false,
      legs: [{polarity: 1, nets: [x.positive]}, {polarity: -1, nets: [x.negative]}]}))};
  }
  return p;
};
const run = (doc, check, o = {}) => I.analyze(o.project || project(doc), doc, defs, {checks: [check], ...o}).insights.filter(x => x.check === check);
const pair = (check, bad, good, o) => {
  const p = run(bad, check, o), n = run(good, check, o);
  assert.ok(p.length > 0, check + ": the case is found");
  assert.equal(n.length, 0, check + ": no false positive: " + JSON.stringify(n.map(i => i.message)));
  for (const x of p) { assert.ok(x.message && x.why && x.title && x.key.startsWith(check + ":"), check + " reads well"); assert.ok(x.at.every(Number.isFinite)); }
  return p;
};
const rule = (type, name, props) => ({id: "r-" + name, type, name, comment: "", enabled: true, priority: 1, scope: {kind: "all"}, ...props});
const ruleSet = (list, extra = {}) => { const c = R.create(); c.list.push(...list); Object.assign(c, extra); return R.validate(R.normalize(c)); };
const ringRules = list => ruleSet([], {list: list.map(([name, min, source], i) => rule("annularRing", name, {
  min, priority: i + 1, scope: AtriumDesignQueryRecord.create(source)
}))});
const poured = doc => { for (const i of doc.items) if (i.kind === "polygon" && !i.keepout) i.removeDeadCopper = false; PP.apply(doc, defs); return doc; };
const fixed = (doc, x) => { x.fix.apply(doc, project(doc), defs); };

// ---------------------------------------------------------------- PCB
test("neck: a pour narrowing to 0.3 mm between two wide areas; none in a solid pour, parallel bridges or a peninsula", () => {
  const dumbbell = [[2, 2], [22, 2], [22, 11.85], [26, 11.85], [26, 2], [46, 2], [46, 22], [26, 22], [26, 12.15], [22, 12.15], [22, 22], [2, 22]];
  const bad = poured(board([poly("GND", "Bottom", dumbbell, {removeDeadCopper: false})]));
  assert.ok((bad.pcbDrawing?.pours || []).length, "poured");
  const solid = poured(board([poly("GND", "Bottom", rect(2, 2, 46, 22))]));
  assert.ok(solid.pcbDrawing.pours.length, "the solid pour has copper");
  const [n] = pair("neck", bad, solid);
  assert.ok(Math.abs(n.value - .3) < .05, "measured width " + n.value);
  assert.equal(n.severity, "advice", "ground pour: advice");
  assert.ok(n.at[0] > 21.5 && n.at[0] < 26.5 && Math.abs(n.at[1] - 12) < .2, "located in the neck " + n.at);
  assert.ok(n.line && Math.abs(Math.hypot(n.line[0][0] - n.line[1][0], n.line[0][1] - n.line[1][1]) - .3) < .05, "drawn across the neck");
  // Two 0.3 mm bridges in parallel: not a single neck.
  const two = poured(board([poly("GND", "Bottom", [[2, 2], [22, 2], [22, 5], [26, 5], [26, 2], [46, 2], [46, 22], [26, 22], [26, 19], [22, 19], [22, 22], [2, 22]]),
    {id: "ko", kind: "polygon", layer: "Bottom", net: "", keepout: true, points: rect(21, 5.3, 27, 18.7)}]));
  assert.equal(run(two, "neck").filter(x => x.value < .45).length, 0, "parallel bridges are not a neck");
  // A thin strip that leads nowhere (a peninsula) is not a neck.
  assert.equal(run(poured(board([poly("GND", "Bottom", [[2, 2], [22, 2], [22, 11.8], [40, 11.8], [40, 12.2], [22, 12.2], [22, 22], [2, 22]])])), "neck").length, 0);
  // A signal net's pour: a tip. Higher sensitivity finds wider necks; low finds fewer.
  const sig = poured(board([poly("SENSE", "Bottom", dumbbell.map(p => [p[0], p[1] === 11.85 ? 11.8 : p[1] === 12.15 ? 12.2 : p[1]]))]));
  assert.equal(run(sig, "neck")[0]?.severity, "tip");
  assert.equal(run(sig, "neck", {sensitivity: "low"}).length, 0, "0.4 mm is not narrow at low sensitivity (0.3 mm)");
  assert.equal(run(sig, "neck", {sensitivity: "high"}).length, 1);
  // Memoised per poured region: an unchanged region is not measured again.
  const e = I.engine(), p = project(bad);
  const first = e.update(p, bad, defs, {from: null, to: 1, ids: null, items: null}, {prefs: false, checks: ["neck"]});
  let r = first.next(); while (!r.done) r = first.next();
  const t0 = now(), again = e.update(p, bad, defs, null, {prefs: false, checks: ["neck"], force: true});
  r = again.next(); while (!r.done) r = again.next();
  assert.equal(r.value.insights.length, 1);
  assert.ok(now() - t0 < 50, "memoised re-run is quick");
});

test("returnPlane: a high-speed track over a split, a void, and a layer change without a stitching via (with its fix)", () => {
  const split = net => board([poly("GND", "Inner 1", rect(0, 0, 20, 40)), poly("VCC", "Inner 1", rect(20.5, 0, 60, 40)), poly("GND", "Inner 2", rect(0, 0, 60, 40)), track(net, "Top", [[5, 5], [35, 5]])]);
  const ok = board([poly("GND", "Inner 1", rect(0, 0, 60, 40)), poly("GND", "Inner 2", rect(0, 0, 60, 40)), track("USB_DP", "Top", [[5, 5], [35, 5]])]);
  const found = pair("returnPlane", split("USB_DP"), ok);
  assert.ok(found.some(x => /split/.test(x.message) && x.severity === "advice"), JSON.stringify(found.map(x => x.message)));
  assert.equal(found.filter(x => /split/.test(x.message)).length, 1, "pieces of one crossing are one insight");
  assert.equal(run(split("LED_EN"), "returnPlane").length, 0, "a slow net is left alone");
  // A 3 mm gap in the GND plane (same net both sides): a void, not a split.
  const gap = board([poly("GND", "Inner 1", rect(0, 0, 20, 40)), poly("GND", "Inner 1", rect(23, 0, 60, 40)), poly("GND", "Inner 2", rect(0, 0, 60, 40)), track("USB_DP", "Top", [[5, 5], [35, 5]])]);
  const v = run(gap, "returnPlane");
  assert.ok(v.length === 1 && /gap/.test(v[0].message) && Math.abs(v[0].value - 3) < .1, JSON.stringify(v.map(x => x.message)));
  assert.ok(run(split("LED_EN"), "returnPlane", {allSignals: true}).length > 0, "unless every signal net is asked for");
  const covered = split("USB_DP"); covered.rules = ruleSet([rule("returnPath", "RP", {voids: true, splits: true, layerChange: true, distance: 1, capDistance: 5, minVoid: .1})]);
  assert.equal(run(covered, "returnPlane").length, 0, "a Return Path rule leaves it to DRC");
  // Layer change Top → Bottom; GND on Inner 1 and Inner 2: a GND stitching via within 2 mm.
  const lc = board([poly("GND", "Inner 1", rect(0, 0, 60, 40)), poly("GND", "Inner 2", rect(0, 0, 60, 40)), track("CLK", "Top", [[5, 10], [20, 10]]), via("CLK", 20, 10), track("CLK", "Bottom", [[20, 10], [35, 10]])]);
  const miss = run(lc, "returnPlane").find(x => /stitching via/.test(x.message));
  assert.ok(miss && miss.fix, "the missing via has a fix");
  const doc = lc, before = doc.items.length;
  const r = I.analyze(project(doc), doc, defs, {checks: ["returnPlane"]}).insights.find(x => x.key === miss.key);
  r.fix.apply(doc, project(doc), defs);
  assert.equal(doc.items.length, before + 1, "one via added");
  assert.equal(run(doc, "returnPlane").filter(x => /stitching via/.test(x.message)).length, 0, "the fix clears it");
  // A via of the reference net 1.5 mm away already counts (within 2 mm).
  const near = board([poly("GND", "Inner 1", rect(0, 0, 60, 40)), poly("GND", "Inner 2", rect(0, 0, 60, 40)), track("CLK", "Top", [[5, 10], [20, 10]]), via("CLK", 20, 10), via("GND", 21.5, 10), track("CLK", "Bottom", [[20, 10], [35, 10]])]);
  assert.equal(run(near, "returnPlane").length, 0);
});

test("acuteAngle: a 45° corner (fixed by cutting it) and a 45° junction; 90° and 135° are fine", () => {
  const bad = board([track("A", "Top", [[5, 5], [15, 5], [7, 13]])]);
  const [x] = pair("acuteAngle", bad, board([track("A", "Top", [[5, 5], [15, 5], [22, 12]]), track("B", "Top", [[5, 20], [15, 20], [15, 30]])]));
  assert.equal(x.value, 45);
  fixed(bad, run(bad, "acuteAngle").find(i => i.check === "acuteAngle") && I.analyze(project(bad), bad, defs, {checks: ["acuteAngle"]}).insights[0]);
  assert.equal(bad.items[0].points.length, 4, "the corner became two bends");
  assert.equal(run(bad, "acuteAngle").length, 0, "both new bends are obtuse");
  pair("acuteAngle", board([track("A", "Top", [[5, 20], [25, 20]]), track("A", "Top", [[15, 20], [25, 30]])]), board([track("A", "Top", [[5, 20], [25, 20]]), track("A", "Top", [[15, 20], [15, 30]])]));
  // Different nets or layers meeting are not a junction.
  assert.equal(run(board([track("A", "Top", [[5, 20], [25, 20]]), track("A", "Bottom", [[15, 20], [25, 30]])]), "acuteAngle").length, 0);
});

test("stub: a branch off a high-speed net mid-route; a daisy chain through the pad is fine", () => {
  const u = (ref, x, y) => part(ref, "ic8", x, y, {"1": "CLK"});
  pair("stub", board([u("U1", 5, 5), u("U2", 40, 5), u("U3", 20, 15), track("CLK", "Top", [[5, 5], [40, 5]]), track("CLK", "Top", [[20, 5], [20, 15]])]),
    board([u("U1", 5, 5), u("U2", 40, 5), u("U3", 20, 15), track("CLK", "Top", [[5, 5], [20, 15]]), track("CLK", "Top", [[20, 15], [40, 5]])]));
  assert.equal(run(board([u("U1", 5, 5), u("U2", 40, 5), track("LED", "Top", [[5, 5], [40, 5]]), track("LED", "Top", [[20, 5], [20, 15]])]), "stub").length, 0, "slow nets may branch");
});

test("widthCurrent and thermalCurrent: IPC-2152 against the net's current, with fixes", () => {
  const rules = ruleSet([], {netCurrents: {VBUS: 3}});
  const bad = board([track("VBUS", "Top", [[5, 5], [30, 5]], .2)], {rules});
  const [w] = pair("widthCurrent", bad, board([track("VBUS", "Top", [[5, 5], [30, 5]], 3)], {rules}));
  assert.equal(w.severity, "advice");
  I.analyze(project(bad), bad, defs, {checks: ["widthCurrent"]}).insights[0].fix.apply(bad);
  assert.ok(bad.items[0].width > 1, "widened " + bad.items[0].width);
  assert.equal(run(bad, "widthCurrent").length, 0, "fix clears it (with margin)");
  assert.equal(run(board([track("SIG", "Top", [[5, 5], [30, 5]], .1)], {rules}), "widthCurrent").length, 0, "nets without a current are not judged");
  // Thermal relief: a THT pad on VBUS relief-connected to a VBUS pour with 4 × 0.254 mm spokes, 8 A.
  const hot = ruleSet([], {netCurrents: {VBUS: 8}});
  const mk = (rs, style) => board([part("J1", "tht", 20, 20, {"1": "VBUS", "2": "VBUS"}), poly("VBUS", "Top", rect(5, 5, 45, 35), {connectStyle: style})], {rules: rs});
  const t = pair("thermalCurrent", mk(hot, "relief"), mk(hot, "direct"));
  assert.match(t[0].message, /8 A/);
  const d = mk(hot, "relief"), x = I.analyze(project(d), d, defs, {checks: ["thermalCurrent"]}).insights[0];
  x.fix.apply(d);
  assert.equal(run(d, "thermalCurrent").length, 0, "direct-connect override clears it");
  assert.equal(run(mk(ruleSet([], {netCurrents: {VBUS: .1}}), "relief"), "thermalCurrent").length, 0, "small currents are fine");
});

test("viaInPad, ringMin and edgeCopper, with fixes", () => {
  const vip = board([part("U1", "qfn", 20, 20, {"1": "GND", "2": "A", "3": "B"}), via("GND", 20.5, 20.5)]);
  pair("viaInPad", vip, board([part("U1", "qfn", 20, 20, {"1": "GND", "2": "A", "3": "B"}), via("GND", 20.5, 20.5, {ipc4761: "VII", viaInPad: true})]));
  // The diamond sits up and right of the via's land, clear of its drill (insights-ui.js markAt).
  const vipFound = I.analyze(project(vip), vip, defs, {checks: ["viaInPad"]}).insights[0], vipVia = vip.items.find(i => i.kind === "via");
  assert.equal(vipFound.land, (+vipVia.diameter || .6) / 2);
  {
    const m = AtriumInsightsUI._markAt(vipFound, .2), off = (vipFound.land + .2) * Math.SQRT1_2;
    assert.ok(Math.abs(m[0] - vipFound.at[0] - off) < 1e-9 && Math.abs(vipFound.at[1] - m[1] - off) < 1e-9 && Math.hypot(m[0] - vipFound.at[0], m[1] - vipFound.at[1]) > vipFound.land);
  }
  vipFound.fix.apply(vip);
  assert.equal(run(vip, "viaInPad").length, 0);
  assert.equal(run(board([part("U1", "qfn", 20, 20, {"1": "GND"}), via("GND", 30, 30)]), "viaInPad").length, 0, "a via beside the pad is fine");
  const rr = ruleSet([rule("annularRing", "AR", {min: .1})]);
  const ring = board([via("A", 10, 10, {diameter: .5, drill: .3})], {rules: rr});
  pair("ringMin", ring, board([via("A", 10, 10, {diameter: .6, drill: .3})], {rules: rr}));
  I.analyze(project(ring), ring, defs, {checks: ["ringMin"]}).insights[0].fix.apply(ring);
  assert.equal(run(ring, "ringMin").length, 0);
  assert.equal(run(board([via("A", 10, 10, {diameter: .45, drill: .3})], {rules: rr}), "ringMin").length, 0, "below the minimum is DRC's");
  const er = ruleSet([rule("boardOutlineClearance", "BO", {gap: .25})]);
  pair("edgeCopper", board([track("A", "Top", [[5, .4], [30, .4]], .2)], {rules: er}), board([track("A", "Top", [[5, 1.5], [30, 1.5]], .2)], {rules: er}));
});

test("viaInPad reads the flipped face and its actual layer row through Undo", () => {
  require("../../app/pcb/pcb-edit.js");
  const {F4,F5,mirroredLandPoint,mirroredTopRow,landContacts} = require("../support/a1-geometry.cjs");
  const U = AtriumUndoStore, history = [], future = [];
  const at = (q,row) => mirroredLandPoint(q,row).map(v=>v+20);
  const row = {...mirroredTopRow};
  const def = {id:"vip-land", name:"Land", footprint:{shapes:[],pads:[
    {...F4.pad, number:"1", layer:"Top", drill:0, stackMode:"full", padStack:{Top:row}}
  ]}};
  const placed = part("U1", def.id, F4.part.x+20, F4.part.y+20, {"1":"A"}, {angle:-F4.part.angle});
  const [x,y] = at([.53,.64],row);
  const correct = via("A",x,y,{fromLayer:"Inner 2",toLayer:"Bottom"});
  const wrong = via("A",x,y,{fromLayer:"Top",toLayer:"Inner 1"});
  const [nx,ny] = at([.75,.22]);
  const nominal = via("A",nx,ny,{fromLayer:"Inner 2",toLayer:"Bottom"});
  const doc = board([placed,correct,wrong,nominal]);
  const p = {...project(doc),library:[def]}, lib = new Map([[def.id,def]]);
  AtriumPCBEdit.applyFlip(doc,p,AtriumPCBEdit.flipPlan(doc,lib,[placed.id]),lib);
  const e = I.engine(), opts = {prefs:false,checks:["viaInPad"]};
  function read(mode, expected) {
    const from=e.state(doc.id)?.at??null, hint=U.changed(doc,from);
    let result; const queue=e.update(p,doc,lib,{...hint,from,to:hint.seq},{...opts,outer:U.outer()});
    do { result=queue.next(); } while (!result.done);
    assert.equal(result.value.mode,mode);
    const hints=result.value.insights;
    assert.deepEqual(hints.map(h=>h.objects[0]),expected,"actual placed Bottom row");
    assert.deepEqual(hints.map(h=>h.key),I.analyze(p,doc,lib,opts).insights.map(h=>h.key),"live and batch verdicts");
    return hints[0];
  }
  try {
    U.mark(p); U.prime();
    const hit=read("full",[correct.id]), before=U.mark(p);
    hit.fix.apply(doc,p,lib);
    U.checkpoint(history,future,before,hit.fix.label);
    U.record(p,{doc,items:[correct]});
    read("incremental",[]);
    assert.equal(doc.items.find(i=>i.id===correct.id).ipc4761,"VII");
    assert.ok(U.jump(history,future,U.mark(p),-1));
    U.record(p);
    read("incremental",[correct.id]);
    assert.ok(U.jump(history,future,U.mark(p),1));
    U.record(p);
    read("incremental",[]);
  } finally { U.reset(); }

  const pins = lib.get(placed.def).footprint.pads;
  for (const {shape,poly,point,inside} of landContacts) {
    const [vx,vy]=at(point,row);
    const q=via("A",vx,vy,{fromLayer:"Inner 2",toLayer:"Bottom"});
    doc.items=[placed,q];
    // The actual flipped row was placed once. Its local polygon reverses X as the footprint does.
    const physical=pins[0].padStack.Bottom;
    Object.assign(physical,{shape,w:F5.w,h:F5.h,roundrectRadiusRatio:F5.radiusRatio,
      poly:poly?.map(([u,v])=>[-u,v])});
    assert.equal(I.analyze(p,doc,lib,opts).insights.some(h=>h.objects[0]===q.id),inside,shape+" via-centre policy");
  }
});

test("ringMin uses DRC's via layer span and individual footprint pad scope", () => {
  const hole = {number: "1", x: 0, y: 0, w: .64, h: .64, drill: .4, shape: "round", layer: "Multi"};
  const header = {id: "ring-header", name: "Header", footprint: {shapes: [], pads: [
    hole, {...hole, number: "2", x: 2}, {...hole, number: "2", x: 4}
  ]}};
  const lib = new Map(defs).set(header.id, header);
  const ruled = via("A", 10, 10, {diameter: .54, fromLayer: "Top", toLayer: "Inner 1"});
  const roomy = via("A", 15, 10, {diameter: .64, fromLayer: "Top", toLayer: "Inner 1"});
  const otherSpan = via("A", 20, 10, {diameter: .54, fromLayer: "Inner 2", toLayer: "Bottom"});
  const stacked = via("A", 25, 10, {diameter: .54, stackMode: "simple"});
  const component = part("J1", header.id, 10, 20, {"1": "A", "2": "A"});
  const freePad = {...hole, id: id("pad"), kind: "pad", x: 20, y: 20, net: "A"};
  const doc = board([ruled, roomy, otherSpan, stacked, component, freePad], {rules: ringRules([
    ["Via span", .15, 'via on layer "Inner 1"'],
    ["First connector pin", .15, 'pad where component.designator = "J1" and pin.number = "1"'],
    ["Default ring", .1, "object"]
  ])});
  const p = project(doc);
  p.library = [...lib.values()];
  const check = R.drc(doc, lib, R.stored(doc, p), {project: p, types: ["annularRing"]});
  assert.ok(check.violations.some(x => x.id === ruled.id && x.ruleName === "Via span" && x.required === .15), JSON.stringify(check.violations));
  assert.ok(check.violations.some(x => x.id === component.id && x.ruleName === "First connector pin" && x.required === .15), JSON.stringify(check.violations));
  const insights = I.analyze(p, doc, lib, {checks: ["ringMin"]}).insights;
  assert.deepEqual(insights.map(x => x.objects[0]), [roomy.id, otherSpan.id, component.id, component.id, freePad.id]);
  assert.match(insights[0].message, /0\.15 mm minimum/, "a via above its scoped minimum still gets a margin hint");
  assert.match(insights[1].message, /0\.1 mm minimum/);
  assert.deepEqual(insights.filter(x => x.objects[0] === component.id).map(x => x.subject.padIndex), [1, 2],
    "equal rings on two footprint pads with the same pin number produce separate hints");
});

test("ringMin dismissal keys identify physical footprint pads and accept unambiguous old dismissals", () => {
  const pad = {number: "1", x: 0, y: 0, w: .64, h: .64, drill: .4, shape: "round", layer: "Multi", nativeId: "pad-a"};
  const other = {...pad, x: 2, nativeId: "pad-b"};
  const def = {id: "ring-pin", name: "Test Point", footprint: {shapes: [], pads: [pad]}};
  const lib = new Map(defs).set(def.id, def), tp = part("TP1", def.id, 10, 10, {"1": "A"});
  const doc = board([tp]), p = project(doc);
  p.library = [...lib.values()];
  const hints = () => I.analyze(p, doc, lib, {checks: ["ringMin"]}).insights;
  const [single] = hints();
  const oldKey = I.keyOf(single.check, single, "");
  I.dismiss(p, {...single, key: oldKey});
  assert.equal(hints()[0].dismissed, true, "a legacy single-hole dismissal is still honoured");
  def.footprint.pads.push(other);
  assert.equal(hints().filter(x => x.dismissed).length, 0, "an old part-wide key is ambiguous on a multi-hole footprint");
  const [first] = hints();
  I.dismiss(p, first);
  def.footprint.pads.reverse();
  const dismissed = hints().filter(x => x.dismissed);
  assert.deepEqual(dismissed.map(x => [x.key, x.subject.padIndex, x.at]), [[first.key, 1, first.at]],
    "reordering native footprint pads keeps the dismissal on the same physical pad");
});

test("ringMin: one edited via stays local through live edit, Undo and Redo", () => {
  const U = AtriumUndoStore, history = [], future = [];
  const changed = via("A", 10, 10, {diameter: .54});
  const background = Array.from({length: 200}, (_, n) => via("A", 30 + n * 3, 10, {diameter: .64}));
  const doc = board([changed, ...background], {rules: ringRules([
    ["Via ring", .15, "via"],
    ["Default ring", .1, "object"]
  ])});
  const p = project(doc), e = I.engine(), opts = {prefs: false, checks: ["ringMin"]};
  const signature = list => list.map(x => [x.key, x.message, x.value, x.subject]);
  const pass = (mode, hintCount) => {
    const from = e.state(doc.id)?.at ?? null, delta = U.changed(doc, from);
    const it = e.update(p, doc, defs, {...delta, from, to: delta.seq}, {...opts, outer: U.outer()});
    let r; do { r = it.next(); } while (!r.done);
    const actual = r.value.insights.filter(x => x.objects[0] === changed.id);
    assert.equal(r.value.mode, mode);
    assert.equal(actual.length, hintCount);
    if (hintCount) assert.match(actual[0].message, /0\.15 mm minimum/);
    const copy = A.clone(p), fresh = I.analyze(copy, copy.documents[0], defs, opts).insights;
    assert.deepEqual(signature(r.value.insights), signature(fresh));
  };
  const compiled = R.compiled;
  let matched = 0;
  R.compiled = (...args) => {
    const rules = compiled(...args), first = rules.first;
    return {...rules, first(type, subject) {
      if (type === "annularRing") matched++;
      return first(type, subject);
    }};
  };
  try {
    U.mark(p); U.prime();
    pass("full", 0);
    assert.equal(matched, 2 * doc.items.length, "one match per via in the initial and fresh analysis");
    const before = U.mark(p);
    changed.diameter = .64;
    U.checkpoint(history, future, before, "Enlarge via");
    U.record(p, {doc, items: [changed]});
    matched = 0; pass("incremental", 1);
    assert.equal(matched, doc.items.length + 1, "only the edited via matches a rule in the live pass");
    for (const [direction, hintCount] of [[-1, 0], [1, 1]]) {
      assert.ok(U.jump(history, future, U.mark(p), direction));
      U.record(p);
      matched = 0; pass("incremental", hintCount);
      assert.equal(matched, doc.items.length + 1, "Undo and Redo also visit only the edited via");
    }
  } finally {
    R.compiled = compiled;
    U.reset();
  }
});

test("ringMin uses the drill geometry and updates when a distant scope anchor moves", () => {
  const v = via("A", 10, 10, {diameter: .54});
  const anchor = part("U3", "ic8", 20.1, 10, {});
  const doc = board([v, anchor], {rules: ringRules([
    ["Ring near connector", .15, "via near origin of U3 within 10 mm"],
    ["Default ring", .1, "object"]
  ])});
  const p = project(doc), e = I.engine(), opts = {prefs: false, checks: ["ringMin"]};
  const drain = hint => {
    const pass = e.update(p, doc, defs, hint, opts);
    let r; do { r = pass.next(); } while (!r.done);
    return r.value.insights;
  };
  const drc = () => R.drc(doc, defs, R.stored(doc, p), {project: p, types: ["annularRing"]}).violations;
  assert.ok(drc().some(x => x.id === v.id && x.required === .15), "the drilled edge is within 10 mm");
  assert.equal(drain({to: 1}).length, 0);
  anchor.x += 5;
  assert.equal(drc().length, 0);
  const changed = drain({from: 1, to: 2, ids: new Set([anchor.id]), items: new Map([[anchor.id, anchor]])});
  assert.equal(changed.length, 1, "the via 15 mm from the edited anchor now meets its governing minimum");
  assert.match(changed[0].message, /0\.1 mm minimum/);
  assert.deepEqual(changed.map(x => x.key), I.analyze(p, doc, defs, opts).insights.map(x => x.key));
  anchor.x -= 5;
  assert.equal(drain({from: 2, to: 3, ids: new Set([anchor.id]), items: new Map([[anchor.id, anchor]])}).length, 0);
  const duplicate = part("U3", "ic8", 40, 10, {});
  doc.items.push(duplicate);
  assert.equal(drain({from: 3, to: 4, ids: new Set([duplicate.id]), items: new Map([[duplicate.id, duplicate]])}).length, 1);
  doc.items.pop();
  const restored = drain({from: 4, to: 5, ids: new Set([duplicate.id]), items: new Map()});
  assert.deepEqual(restored, [], "resolving the ambiguous reference restores the strict rule away from the deletion");
});

test("decap: the nearest decoupling capacitor 20 mm from a power pin; 2 mm is fine", () => {
  const mk = x => board([part("U1", "ic8", 10, 10, {"1": "3V3", "2": "GND", "3": "SIG"}), part("C1", "c0402", x, 10, {"1": "3V3", "2": "GND"})]);
  const [d] = pair("decap", mk(30), mk(12));
  assert.match(d.message, /C1/);
  // The key survives moving both parts together (a block move) and changes when the cap moves away.
  const a = mk(30), b = mk(30);
  b.items[0].id = a.items[0].id; b.items[1].id = a.items[1].id;
  for (const i of b.items) { i.x += 7; i.y += 3; }
  assert.equal(run(a, "decap")[0].key, run(b, "decap")[0].key, "moved together: same key");
  const c = mk(30); c.items[0].id = a.items[0].id; c.items[1].id = a.items[1].id; c.items[1].x = 45;
  assert.notEqual(run(a, "decap")[0].key, run(c, "decap")[0].key, "moved farther: raised again");
});

test("silk tests the entire stroke against placed land", () => {
  const {F4,mirroredLandPoint,mirroredTopRow}=require("../support/a1-geometry.cjs");
  const offset=[[.65,-.4],[1.4,-.4],[1.4,.4],[.65,.4]];
  const pad={id:"pad",kind:"pad",x:10,y:10,w:3,h:1,shape:"custom",poly:offset,layer:"Top",net:"N"};
  const silk=(points,props={})=>({id:"silk",kind:"graphic",layer:"Silk",points,width:.1,...props});
  const observe=(points,opts={},land=pad)=>run(board([land,silk(points,opts)]),"silk");
  const [cross]=observe([[9,10],[12,10]]);
  assert.ok(cross && cross.at[0]>=10.65 && cross.at[0]<=11.4 && cross.at[1]===10,"witness at the crossed copper");
  assert.equal(observe([[9,10],[10.5,10]]).length,0,"near the anchor but clear of copper");
  assert.equal(observe([[10.9,10],[12,10]]).length,1,"segment endpoint inside copper");
  const open=[[9,10],[9,11],[12,11],[12,10]];
  assert.equal(observe(open).length,0);
  assert.equal(observe(open,{closed:true}).length,1,"closing edge crosses the land");

  // The editor's graphic item box encloses only points. Stroke reach belongs in the candidate query.
  require("../../app/editor/nav-common.js");
  const thin={...pad,poly:[[.65,-.04],[1.4,-.04],[1.4,.04],[.65,.04]]};
  assert.equal(observe([[11.44,9.8],[11.44,10.2]],{},thin).length,1,"stroke reaches beyond its centreline bounds");
  assert.equal(observe([[11.451,9.8],[11.451,10.2]],{},thin).length,0,"gap exceeds the half-width");

  // A tilted tangent uses the true ellipse boundary at a distance below the usual curve tolerance.
  const ellipse={...pad,shape:"ellipse",poly:undefined,w:1.8,h:.8}, rx=.9, ry=.4;
  const c=Math.cos(.63), s=Math.sin(.63), n=Math.hypot(c/rx,s/ry), nx=c/rx/n, ny=s/ry/n;
  const tangent=gap=>[-.7,.7].map(t=>[10+rx*c+gap*nx-t*ny,10+ry*s+gap*ny+t*nx]);
  assert.equal(observe(tangent(.04995),{},ellipse).length,1,"elliptical tangent enters stroke width");
  assert.equal(observe(tangent(.05005),{},ellipse).length,0,"elliptical tangent clears stroke width");

  require("../../app/pcb/pcb-edit.js");
  const row={...mirroredTopRow,shape:"custom",poly:offset};
  const def={id:"silk-offset",name:"Offset",footprint:{shapes:[],pads:[
    {...F4.pad,number:"1",drill:0,layer:"Top",stackMode:"full",padStack:{Top:row}}
  ]}};
  const placed=part("U1",def.id,F4.part.x+20,F4.part.y+20,{"1":"N"},{angle:-F4.part.angle});
  const at=points=>points.map(q=>mirroredLandPoint(q,row).map(x=>x+20));
  const doc=board([placed]), p={...project(doc),library:[def]}, lib=new Map([[def.id,def]]);
  AtriumPCBEdit.applyFlip(doc,p,AtriumPCBEdit.flipPlan(doc,lib,[placed.id]),lib);
  const crosses=[[-1,0],[2,0]];
  const check=(points,layer)=>{
    doc.items=[placed,silk(at(points),{layer})];
    return I.analyze(p,doc,lib,{prefs:false,checks:["silk"]}).insights.length;
  };
  assert.equal(check(crosses,"Bottom silk"),1,"rotated and mirrored Bottom row");
  assert.equal(check([[-1,0],[.5,0]],"Bottom silk"),0,"rotated and mirrored gap");
  assert.equal(check(crosses,"Silk"),0,"silk on the opposite face");
});

test("silk keeps an elliptical tangent across board scales and placement angles", () => {
  const theta=Math.PI/6, c=Math.cos(theta), s=Math.sin(theta), normal=Math.hypot(c/2,s/.5);
  for (const scale of [.001,1,16]) for (const angle of [0,17,47]) {
    const radians=angle*Math.PI/180, co=Math.cos(radians), si=Math.sin(radians);
    const land={id:"pad",kind:"pad",x:10,y:10,angle,w:4*scale,h:scale,shape:"ellipse",layer:"Top",net:"N"};
    const locate=([x,y])=>[10+scale*(x*co-y*si),10+scale*(x*si+y*co)];
    const hit=point=>{
      const at=locate(point), silk={id:"silk",kind:"graphic",layer:"Silk",points:[at,at.slice()],width:.25*scale};
      return run(board([land,silk]),"silk").length;
    };
    const alongNormal=d=>[2*c+d*(c/2)/normal,.5*s+d*(s/.5)/normal];
    assert.equal(hit([0,.625]),1,"axis tangent "+scale+"/"+angle);
    assert.equal(hit([0,.6251]),0,"axis near miss "+scale+"/"+angle);
    assert.equal(hit(alongNormal(.125)),1,"off-axis tangent "+scale+"/"+angle);
    assert.equal(hit(alongNormal(.1251)),0,"off-axis near miss "+scale+"/"+angle);
  }
});

test("silk, diffPair and crosstalk", () => {
  const pad = part("J1", "tht", 20, 20, {"1": "A"});
  pair("silk", board([pad, {id: "s1", kind: "graphic", layer: "Silk", width: .15, points: [[18, 20], [22, 20]]}]), board([pad, {id: "s1", kind: "graphic", layer: "Silk", width: .15, points: [[18, 23], [22, 23]]}]));
  const gnd = [poly("GND", "Inner 1", rect(0, 0, 60, 40)), poly("GND", "Inner 2", rect(0, 0, 60, 40))];
  const pr = ruleSet([], {diffPairs: [{name: "USB", positive: "USB_P", negative: "USB_N"}]});
  const coupled = board([...gnd, track("USB_P", "Top", [[5, 10], [40, 10]], .2), track("USB_N", "Top", [[5, 10.35], [40, 10.35]], .2)], {rules: pr});
  const split = board([...gnd, track("USB_P", "Top", [[5, 10], [40, 10]], .2), track("USB_N", "Top", [[5, 10.35], [15, 10.35], [15, 10.75], [20.2, 10.75], [20.2, 10.35], [40, 10.35]], .2)], {rules: pr});
  // About 6 mm uncoupled against the default rule's 6.35 mm: close to the limit (beyond it is DRC's).
  assert.ok(run(split, "diffPair").some(x => /uncoupled/.test(x.message)), JSON.stringify(run(split, "diffPair").map(x => x.message)));
  assert.equal(run(coupled, "diffPair").length, 0, "a well-coupled pair");
  const xt = board([...gnd, track("CLK", "Top", [[5, 10], [45, 10]], .15), track("USB_DP", "Top", [[5, 10.3], [45, 10.3]], .15)]);
  const far = board([...gnd, track("CLK", "Top", [[5, 10], [45, 10]], .15), track("USB_DP", "Top", [[5, 20], [45, 20]], .15)]);
  const c = pair("crosstalk", xt, far);
  assert.equal(c.length, 1, "one insight per pair of nets");
});

// ---------------------------------------------------------------- schematic
const sym = (id, prefix, pins) => ({id, name: id, prefix, symbol: {shapes: [], pins: pins.map(([n, name, x, y, e]) => ({number: String(n), name, x, y, ...(e != null ? {electrical: e} : {})}))}});
const schLib = [sym("mcu", "U", [[1, "VCC", -5, 0, 7], [2, "GND", 5, 0, 7], [3, "EN", -5, 2.54, 0], [4, "SDA", 5, 2.54, 1], [5, "SCL", 5, 5.08, 1]]),
  sym("res", "R", [[1, "1", -2.54, 0], [2, "2", 2.54, 0]]), sym("capc", "C", [[1, "1", -2.54, 0], [2, "2", 2.54, 0]]), sym("dev", "U", [[1, "SDA", -5, 0, 1], [2, "SCL", -5, 2.54, 1]])];
const schDefs = new Map(schLib.map(d => [d.id, d]));
const sp = (ref, def, x, y) => ({id: id("s"), kind: "part", def, ref, value: ref, x, y, angle: 0});
const wire = (points, extra = {}) => ({id: id("w"), kind: "wire", points, ...extra});
const label = (text, x, y) => ({id: id("l"), kind: "netlabel", text, x, y});
const sheet = items => { const d = A.sheet("schematic", "Sheet"); d.items.push(...items); return d; };
const sprj = (...docs) => ({format: "atrium", version: 1, formatVersion: "1.3", name: "S", library: schLib, documents: docs});
const srun = (doc, check, o = {}) => I.analyze(o.project || sprj(doc), doc, schDefs, {checks: [check]}).insights.filter(x => x.check === check);
const spair = (check, bad, good) => {
  const p = srun(bad, check), n = srun(good, check);
  assert.ok(p.length > 0, check + ": found");
  assert.equal(n.length, 0, check + ": no false positive: " + JSON.stringify(n.map(i => i.message)));
  return p;
};
// U1 at (50, 50): VCC pin at (45, 50), GND (55, 50), EN (45, 52.54), SDA (55, 52.54), SCL (55, 55.08).
function mcuSheet({decap = true, pull = true, en = true, typo = null, near = false} = {}) {
  const items = [sp("U1", "mcu", 50, 50), wire([[45, 50], [40, 50]]), label("VCC", 40, 50), wire([[55, 50], [60, 50]]), label(typo || "GND", 60, 50),
    wire([[55, 52.54], [70, 52.54]]), label("SDA", 70, 52.54), wire([[55, 55.08], [70, 55.08]]), label("SCL", 70, 55.08),
    sp("U2", "dev", 80, 52.54), wire([[75, 52.54], [72, 52.54]]), label("SDA", 72, 52.54), wire([[75, 55.08], [72, 55.08]]), label("SCL", 72, 55.08)];
  if (en) items.push(wire([[45, 52.54], near ? [30, 52.54] : [30, 52.54]]), label("VCC", 30, 52.54));
  if (decap) items.push(sp("C1", "capc", 20, 30), wire([[17.46, 30], [15, 30]]), label("VCC", 15, 30), wire([[22.54, 30], [25, 30]]), label("GND", 25, 30));
  if (pull) for (const [n, y, r] of [["SDA", 70, "R1"], ["SCL", 75, "R2"]]) items.push(sp(r, "res", 100, y), wire([[97.46, y], [95, y]]), label(n, 95, y), wire([[102.54, y], [105, y]]), label("VCC", 105, y));
  if (typo) items.push(sp("C9", "capc", 20, 80), wire([[17.46, 80], [15, 80]]), label("VCC", 15, 80), wire([[22.54, 80], [25, 80]]), label("GND", 25, 80), wire([[25, 80], [25, 85]]), label("GND", 25, 85));
  return sheet(items);
}
test("schematic: net-name typos (and the rename fix), never digits or P/N suffixes", () => {
  const S2 = AtriumInsightsSch;
  assert.equal(S2.typoKind("GND", "GDN"), "swap"); assert.equal(S2.typoKind("VCC3V3", "VCC_3V3"), "separators"); assert.equal(S2.typoKind("VCC", "VCCC"), "double");
  for (const [a, b] of [["D0", "D1"], ["USB_DP", "USB_DM"], ["CANH", "CANL"], ["AGND", "DGND"], ["GND", "GNDA"], ["SDA", "SCL"], ["TX", "RX"], ["LED1", "LED2"]]) assert.equal(S2.typoKind(a, b), null, a + " / " + b);
  const bad = mcuSheet({typo: "GDN"}), x = spair("netTypo", bad, mcuSheet())[0];
  assert.match(x.message, /GDN.*GND/);
  x.fix.apply(bad, sprj(bad));
  assert.equal(srun(bad, "netTypo").length, 0, "renamed");
});
test("schematic: decoupling, I²C pull-ups, floating inputs, single-pin nets and wire ends near pins", () => {
  spair("decoupling", mcuSheet({decap: false}), mcuSheet());
  spair("i2cPullup", mcuSheet({pull: false}), mcuSheet());
  spair("floatingInput", mcuSheet({en: false}), mcuSheet());
  const lone = mcuSheet(); lone.items.push(sp("R9", "res", 120, 20), wire([[117.46, 20], [112, 20]]), label("TESTPT", 112, 20));
  spair("singlePin", lone, mcuSheet());
  // EN wire stopping 0.3 mm short of the pin at (45, 52.54).
  const gap = mcuSheet({en: false}); gap.items.push(wire([[44.7, 52.54], [30, 52.54]]), label("VCC", 30, 52.54));
  const [n] = spair("wireNearPin", gap, mcuSheet());
  n.fix.apply(gap);
  assert.equal(srun(gap, "wireNearPin").length, 0, "snapped onto the pin");
  assert.equal(srun(gap, "floatingInput").length, 0, "and now connected");
  // Across sheets: SDA pulled up on another sheet counts.
  const a = mcuSheet({pull: false}), b = sheet([sp("R7", "res", 10, 10), wire([[7.46, 10], [5, 10]]), label("SDA", 5, 10), wire([[12.54, 10], [15, 10]]), label("VCC", 15, 10)]);
  assert.equal(srun(a, "i2cPullup", {project: sprj(a, b)}).filter(x => x.net === "SDA").length, 0, "pull-up on another sheet");
});

// ---------------------------------------------------------------- store and engine
test("dismissals: per object and check, stored in project.insights, kept by validation, undoable data", () => {
  const doc = board([part("U1", "ic8", 10, 10, {"1": "3V3", "2": "GND"}), part("C1", "c0402", 40, 10, {"1": "3V3", "2": "GND"}), track("A", "Top", [[5, 30], [15, 30], [7, 38]])]);
  const p = project(doc), list = () => I.visible(p, I.analyze(p, doc, defs, {checks: ["decap", "acuteAngle"]}).insights);
  assert.equal(list().length, 2);
  const d = list().find(x => x.check === "decap");
  const key = I.dismiss(p, d, {date: "2026-11-19"});
  assert.deepEqual(Object.keys(p.insights), ["version", "dismissed", "muted"]);
  assert.equal(p.insights.dismissed[key].check, "decap");
  assert.equal(list().length, 1, "dismissed one");
  // The store survives validation (an optional project field) and a JSON round trip.
  const q = A.validate(JSON.parse(JSON.stringify(p)));
  assert.equal(I.visible(q, I.analyze(q, q.documents[0], defs, {checks: ["decap", "acuteAngle"]}).insights).length, 1);
  I.mute(p, "acuteAngle");
  assert.equal(list().length, 0, "all of this kind");
  assert.equal(I.restore(p, null, {check: "acuteAngle"}), 1);
  assert.equal(list().length, 1);
  assert.equal(I.restore(p), 1, "restore all");
  assert.equal(list().length, 2);
  // A damaged store is ignored, never thrown on; a store from a newer version is read and extended, not rewritten.
  p.insights = "garbage";
  assert.equal(list().length, 2);
  assert.throws(() => I.dismiss(p, d), /not readable/);
  p.insights = {version: 2, dismissed: {[d.key]: {check: "decap", doc: doc.id, objects: d.objects, sig: d.sig, date: "2027-01-01", extra: {kept: true}}}, muted: {}, future: [1, 2]};
  assert.equal(list().length, 1, "a newer store's dismissals still apply");
  I.dismiss(p, list()[0]);
  assert.equal(p.insights.version, 2); assert.deepEqual(p.insights.future, [1, 2]); assert.deepEqual(p.insights.dismissed[d.key].extra, {kept: true});
  assert.equal(list().length, 0);
});

test("engine: incremental runs from the undo journal match a full run, and touch only what changed", () => {
  const doc = board([part("U1", "ic8", 10, 10, {"1": "3V3", "2": "GND"}), part("C1", "c0402", 40, 10, {"1": "3V3", "2": "GND"}), track("A", "Top", [[5, 30], [15, 30], [7, 38]]),
    track("B", "Top", [[30, 30], [40, 30], [50, 38]]), via("A", 10, 10, {diameter: .5, drill: .3})], {rules: ruleSet([rule("annularRing", "AR", {min: .1})])});
  const p = project(doc), e = I.engine(), checks = ["decap", "acuteAngle", "ringMin", "stub", "widthCurrent"];
  const drain = it => { let r = it.next(), steps = 0; while (!r.done) { r = it.next(); steps++; } return {...r.value, steps}; };
  let r = drain(e.update(p, doc, defs, {from: null, to: 1, ids: null, items: null}, {prefs: false, checks}));
  assert.equal(r.mode, "full"); assert.ok(r.steps >= checks.length, "yields between checks");
  const keys = () => drain(e.update(p, doc, defs, {from: e.state(doc.id).at, to: e.state(doc.id).at, ids: new Set(), items: new Map()}, {prefs: false, checks})).insights.map(x => x.key).sort();
  assert.deepEqual(keys(), I.analyze(p, doc, defs, {checks}).insights.map(x => x.key).sort());
  // Bend track B into an acute corner: one area re-checked.
  const b = doc.items[3]; b.points[2] = [32, 36];
  r = drain(e.update(p, doc, defs, {from: 1, to: 2, ids: new Set([b.id]), items: new Map([[b.id, b]])}, {prefs: false, checks}));
  assert.equal(r.mode, "incremental"); assert.equal(r.dirty, 1);
  assert.deepEqual(r.insights.map(x => x.key).sort(), I.analyze(p, doc, defs, {checks}).insights.map(x => x.key).sort(), "incremental = full");
  // Move the capacitor next to the IC: the decap insight goes.
  const c = doc.items[1]; c.x = 12;
  r = drain(e.update(p, doc, defs, {from: 2, to: 3, ids: new Set([c.id]), items: new Map([[c.id, c]])}, {prefs: false, checks}));
  assert.ok(!r.insights.some(x => x.check === "decap"));
  assert.deepEqual(r.insights.map(x => x.key).sort(), I.analyze(p, doc, defs, {checks}).insights.map(x => x.key).sort());
  // Delete the via: its ring insight goes.
  const v = doc.items.pop();
  r = drain(e.update(p, doc, defs, {from: 3, to: 4, ids: new Set([v.id]), items: new Map()}, {prefs: false, checks}));
  assert.ok(!r.insights.some(x => x.check === "ringMin"));
  // Nothing changed: no work.
  r = drain(e.update(p, doc, defs, {from: 4, to: 4, ids: new Set(), items: new Map()}, {prefs: false, checks}));
  assert.equal(r.mode, "none");
  // A journal gap (ids unknown) runs everything.
  r = drain(e.update(p, doc, defs, {from: 4, to: 6, ids: null, items: null}, {prefs: false, checks}));
  assert.equal(r.mode, "full");
});

test("headless list_insights and Messages rows", () => {
  const doc = board([track("A", "Top", [[5, 5], [15, 5], [7, 13]]), part("U1", "ic8", 10, 20, {"1": "3V3", "2": "GND"}), part("C1", "c0402", 40, 20, {"1": "3V3", "2": "GND"})]);
  const p = project(doc), out = I.headless({document_id: doc.id}, {project: p});
  assert.ok(out.total >= 2 && out.items.every(x => x.key && x.check && x.message && x.at && x.document_id === doc.id));
  assert.ok(out.items.some(x => x.fix === "Cut the corner"), "fix labels, not functions");
  assert.ok(/advice/i.test(out.note));
  assert.equal(I.headless({document_id: doc.id, check: "decap"}, {project: p}).total, 1);
  I.dismiss(p, I.analyze(p, doc, defs, {checks: ["decap"]}).insights[0]);
  assert.equal(I.headless({check: "decap"}, {project: p}).total, 0, "dismissed are left out");
  assert.equal(I.headless({check: "decap", include_dismissed: true}, {project: p}).items[0].dismissed, true);
  assert.throws(() => I.headless({check: "nope"}, {project: p}), /Unknown insight check/);
  const rows = I.messages(I.analyze(p, doc, defs).insights, doc, {ms: 3});
  assert.ok(rows.every(r => r.class === "Info"), "never errors or warnings");
  assert.ok(rows.at(-1).insightSummary);
});

test("cost on the 25.6k-object board: full run and an incremental edit", () => {
  const {d} = makeAtriumBenchmarkBoard();
  // Nets and two pours, so the net and pour checks have work.
  let n = 0;
  for (const i of d.items) if (i.kind === "track") i.net = "N" + (n++ % 400); else if (i.kind === "via") i.net = "GND";
  d.stackup = stack4();
  d.items.push(poly("GND", "Inner 1", rect(0, 0, 368, 275)), poly("VCC", "Inner 2", rect(0, 0, 368, 275)));
  const p = {format: "atrium", version: 1, name: "Bench", library: AtriumParts.catalogue, documents: [d]}, bd = new Map(AtriumParts.catalogue.map(x => [x.id, x]));
  const e = I.engine(), checks = I.checks("pcb").filter(c => !c.heavy).map(c => c.id);
  let t0 = now(), it = e.update(p, d, bd, {from: null, to: 1, ids: null, items: null}, {prefs: false, checks}), r = it.next(), worst = 0, last = now();
  while (!r.done) { const t = now(); worst = Math.max(worst, t - last); r = it.next(); last = now(); }
  const full = now() - t0;
  const tr = d.items.find(i => i.kind === "track"); tr.points[1] = [tr.points[1][0], tr.points[1][1] - .2];
  t0 = now(); it = e.update(p, d, bd, {from: 1, to: 2, ids: new Set([tr.id]), items: new Map([[tr.id, tr]])}, {prefs: false, checks}); r = it.next(); while (!r.done) r = it.next();
  const inc = now() - t0;
  console.log("  ran: " + JSON.stringify(r.value.ran));
  console.log("  25.6k board: full " + full.toFixed(0) + " ms (" + r.value.insights.length + " insights), incremental " + inc.toFixed(1) + " ms");
  assert.equal(r.value.mode, "incremental");
  assert.ok(inc < 400, "an edit re-checks quickly: " + inc.toFixed(1) + " ms");
});

console.log(passed + " insight tests passed");
console.log("SHIM-OK");
