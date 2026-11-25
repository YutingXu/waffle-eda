"use strict";
// Suggested DRC fixes (app/checks/drc-fixes.js): the net-antennae and missing-courtyard checks, and
// each fix verified by re-running the DRC on the previewed board.
const assert = require("node:assert/strict");
for (const m of ["model", "nav-common", "spatial", "connectivity", "pcb-appearance", "altium-rules", "rules", "drc", "pcb-edit", "drc-view", "problem-marks", "drc-markers", "drc-fixes"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const F = globalThis.AtriumDRCFixes, R = globalThis.AtriumRules, V = globalThis.AtriumDRCView;
const cases = [];
const test = (name, run) => cases.push({name, run});

const r2 = {id: "r2", name: "R", footprint: {name: "R0603", shapes: [{kind: "path", points: [[-1.2, -.5], [1.2, -.5]], width: .12, layer: "Silk"}, {kind: "path", points: [[-1.2, .5], [1.2, .5]], width: .12, layer: "Silk"}],
  pads: [{number: "1", x: -.75, y: 0, w: .8, h: .9, shape: "rect"}, {number: "2", x: .75, y: 0, w: .8, h: .9, shape: "rect"}]}};
const tht = {id: "tht", name: "Pin", footprint: {name: "PIN", courtyard: [-1, -1, 1, 1], shapes: [], pads: [{number: "1", x: 0, y: 0, w: .9, h: .9, drill: .8, shape: "round", layer: "Multi"}]}};
const defs = new Map([[r2.id, r2], [tht.id, tht]]);
const track = (id, net, points, width = .25, layer = "Top") => ({kind: "track", id, net, points, width, layer});
const pad = (id, net, x, y, w = 1, h = 1) => ({kind: "pad", id, net, x, y, w, h, shape: "rect", layer: "Top"});
const via = (id, net, x, y, d = .6, drill = .3) => ({kind: "via", id, net, x, y, diameter: d, drill, layer: "Multi"});
const board = items => ({kind: "pcb", id: "b1", name: "Test", items, outline: [[-20, -20], [40, -20], [40, 20], [-20, 20]]});
const rules = R.defaults();
const drc = (b, d = defs, types) => R.drc(b, d, rules, types ? {types} : {}).violations;
// Applies the fix the way the editor does (apply on the live board) and returns the board.
function fixWith(b, v, pick = f => true, project = {library: [...defs.values()].map(d => JSON.parse(JSON.stringify(d)))}) {
  const lib = new Map(project.library.map(d => [d.id, d]));
  const fixes = F.fixesFor(b, lib, rules, v);
  assert.ok(fixes.length, "a fix is offered for " + v.type);
  const ranked = fixes.map(f => ({f, p: F.preview(b, lib, rules, v, f)}));
  const best = ranked.find(x => x.p.ok && pick(x.f)) || ranked.find(x => pick(x.f));
  assert.ok(best, "a fix to choose");
  F.apply(b, project, best.f);
  return {fix: best.f, preview: best.p, ranked, lib: new Map(project.library.map(d => [d.id, d]))};
}

test("net antennae: dangling track ends and unconnected tracks are reported", () => {
  const b = board([pad("p1", "A", 0, 0), pad("p2", "A", 10, 0), track("ok", "A", [[0, 0], [10, 0]]), track("stub", "A", [[0, 0], [0, 3], [2, 5]]), track("lone", "B", [[5, 5], [8, 5]])]);
  const v = F.checks(b, defs).filter(x => x.type === "netAntennae");
  assert.deepEqual(v.map(x => [x.id, x.end]).sort(), [["lone", -1], ["stub", 1]]);
  assert.ok(v.every(x => x.warning && x.ruleName === "Net Antennae"));
});

test("dangling contacts follow the placed land through preview, commit and Undo", () => {
  const {F4,F5,mirroredLandPoint,mirroredTopRow}=require("../support/a1-geometry.cjs");
  require("../../app/pcb/stackup.js");
  require("../../app/pcb/viastack.js");
  require("../../app/history/undo-store.js");
  const A=Atrium, U=AtriumUndoStore, history=[], future=[];
  const d=board([]), row={...mirroredTopRow,shape:"ellipse",w:F5.w,h:F5.h};
  d.stackup=AtriumStackup.build(Array(4).fill("Signal"));
  const def={id:"antenna-land",name:"Pad",footprint:{shapes:[],pads:[
    {...F4.pad,number:"1",layer:"Bottom",drill:0,stackMode:"full",padStack:{Bottom:row}}
  ]}};
  const p={format:"atrium",version:1,name:"Antennae",documents:[d],library:[def]}, lib=new Map([[def.id,def]]);
  const placed={...F4.part,angle:-F4.part.angle,id:"placed",kind:"part",def:def.id,ref:"U1",pinNets:{"1":"A"}};
  d.items=[placed]; AtriumPCBEdit.applyFlip(d,p,AtriumPCBEdit.flipPlan(d,lib,[placed.id]),lib);
  const empty=mirroredLandPoint(F5.witness,row), occupied=mirroredLandPoint([.5,.1],row);
  const endpoint=[-8,-2], target=pad("target","A",...endpoint);
  const feeder=track("feeder","A",[occupied,endpoint],.12);
  const antenna=track("antenna","A",[endpoint,empty],.12);
  const bv={...via("blind","B",6,8),fromLayer:"Inner 1",toLayer:"Inner 2"};
  const wrong=track("absent-via-land","B",[[6,8],[8,8]],.12);
  const bg=Array.from({length:50},(_,i)=>pad("grid"+i,"A",11+i*.4,10));
  d.items.push(target,feeder,antenna,bv,wrong,...bg);
  const checks=()=>F.checks(d,lib,["netAntennae"]);
  const expected=[["absent-via-land",-1],["antenna",1]];
  const keys=rows=>rows.filter(x=>x.type==="netAntennae").map(x=>[x.id,x.end]).sort();
  const e=F.extras();
  let from=null;
  const report=()=>{const hint=U.changed(d,from);const out=e.update(d,lib,{...hint,from,to:hint.seq,outer:U.outer()});from=hint.seq;return keys(out);};
  try {
    U.mark(p); U.prime();
    assert.deepEqual(keys(checks()),expected,"placed contour and blind span");
    assert.deepEqual(report(),expected,"live queue");
    const bad=checks().find(v=>v.id===antenna.id), fix=F.fixesFor(d,lib,rules,bad)[0];
    const preview=F.preview(d,lib,rules,bad,fix);
    assert.ok(preview.ok&&preview.clears);
    assert.ok(d.items.some(i=>i.id===antenna.id),"preview owns no live mutation");
    const before=U.mark(p);
    F.apply(d,p,fix); U.checkpoint(history,future,before,fix.label); U.record(p,{doc:d,items:[antenna.id]});
    assert.deepEqual(report(),[["absent-via-land",-1]]);
    assert.ok(U.jump(history,future,U.mark(p),-1)); U.record(p);
    assert.deepEqual(report(),expected,"Undo reopens the actual dangling end");
    assert.ok(U.jump(history,future,U.mark(p),1)); U.record(p);
    assert.deepEqual(report(),[["absent-via-land",-1]],"Redo applies the verified fix");
  } finally { U.reset(); }
});

test("Altium Net Antennae is retained separately from the native open-track warning", () => {
  const b = board([
    pad("start", "A", 0, 0), pad("finish", "A", 10, 0),
    track("main", "A", [[0, 0], [10, 0]]),
    track("arm", "A", [[2, 0], [2, 3]]),
    track("tip", "A", [[2, 3], [4, 5]]),
    track("viaArm", "A", [[8, 0], [8, 3]]), via("viaEnd", "A", 8, 3)
  ]);
  const source = "RULEKIND=NetAntennae|NAME=Source antenna check|NETSCOPE=AnyNet|LAYERKIND=SameLayer|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|ENABLED=TRUE|PRIORITY=1|NETANTENNAETOLERANCE=";
  for (const tolerance of ["0mil", "1000mil"]) {
    const line = source + tolerance;
    b.sourceRules = [line];
    const adopted = R.replaceWithSource(R.create(), b.sourceRules, b);
    assert.equal(adopted.converted, 0);
    const [entry] = adopted.report;
    assert.equal(entry.status, "source-only");
    assert.equal(entry.text, line);
    assert.match(entry.reason, /retained for reference/);
    assert.match(entry.reason, /separate warning for open track ends/);
    assert.match(entry.reason, /stub-length tolerance, and via-terminated stubs/);

    const result = F.augment(AtriumDRC.batch(b, defs, adopted.set), b, defs);
    F.augment(result, b, defs);
    const warnings = V.toMessages(result, {doc:b}).filter(m => m.drc?.type === "netAntennae");
    assert.deepEqual(warnings.map(m => [m.class, m.drc.ruleId, m.drc.id, m.drc.at]),
      [["Warning", "atrium-netAntennae", "tip", [4, 5]]]);
    assert.equal(warnings[0].text, "Track (Top Layer) A · Unconnected track end (stub)");
    assert.deepEqual(b.sourceRules, [line]);
  }
});

test("missing courtyard: only footprints without one", () => {
  const b = board([{kind: "part", id: "u", def: "r2", ref: "R1", x: 0, y: 0, angle: 0, pinNets: {}}, {kind: "part", id: "j", def: "tht", ref: "J1", x: 5, y: 0, angle: 0, pinNets: {}}]);
  const v = F.checks(b, defs).filter(x => x.type === "courtyard");
  assert.deepEqual(v.map(x => x.id), ["u"]);
});

test("augment adds the extra checks and their rule rows to a DRC result", () => {
  const b = board([track("lone", "B", [[5, 5], [8, 5]])]);
  const r = F.augment(R.drc(b, defs, rules), b, defs);
  assert.ok(r.violations.some(v => v.type === "netAntennae"));
  assert.ok(r.rules.some(x => x.id === "atrium-netAntennae" && x.count === 1));
  assert.equal(r.total, r.violations.length);
  const rows = V.toMessages(r, {doc: b});
  assert.equal(rows.find(m => m.drc?.type === "netAntennae").class, "Warning");
});

test("clearance: nudging the track clears the gap, in one change", () => {
  const b = board([pad("pa", "A", 0, 0), pad("pb", "A", 10, 0), track("t", "A", [[0, 0], [10, 0]]), via("v", "B", 5, .62)]);
  const v = drc(b, defs, ["clearance"])[0];
  assert.equal(v.type, "clearance");
  const {fix, preview} = fixWith(b, v, f => /^nudge/.test(f.id));
  assert.ok(preview.clears && preview.ok, "the preview predicts the fix");
  assert.match(fix.label, /Nudge track/);
  assert.equal(drc(b, defs, ["clearance"]).length, 0, "no clearance violation left");
  const t = b.items.find(i => i.id === "t");
  assert.deepEqual(t.points[0], [0, 0]); assert.deepEqual(t.points.at(-1), [10, 0], "the track keeps its ends");
  assert.equal(F.checks(b, defs).filter(x => x.type === "netAntennae").length, 0);
});

test("clearance: reduce width within the rule", () => {
  const b = board([pad("pa", "A", 0, 0), pad("pb", "A", 10, 0), track("t", "A", [[0, 0], [10, 0]], .3), via("v", "B", 5, .64)]);
  const v = drc(b, defs, ["clearance"])[0];
  const {fix} = fixWith(b, v, f => /^width/.test(f.id));
  assert.match(fix.label, /Reduce width/);
  assert.equal(drc(b, defs, ["clearance", "width"]).length, 0);
});

test("width below the minimum: set to the minimum", () => {
  const b = board([pad("pa", "A", 0, 0), pad("pb", "A", 10, 0), track("t", "A", [[0, 0], [10, 0]], .1)]);
  const v = drc(b, defs, ["width"])[0];
  assert.equal(v.limit, "min");
  fixWith(b, v);
  assert.equal(b.items.find(i => i.id === "t").width, v.required);
  assert.equal(drc(b, defs, ["width"]).length, 0);
});

test("unconnected stub: delete it", () => {
  const b = board([pad("pa", "A", 0, 0), pad("pb", "A", 10, 0), track("ok", "A", [[0, 0], [10, 0]]), track("stub", "A", [[0, 0], [0, 3], [2, 5]])]);
  const v = F.checks(b, defs).find(x => x.type === "netAntennae");
  fixWith(b, v, f => /^trim/.test(f.id));
  const s = b.items.find(i => i.id === "stub");
  assert.deepEqual(s.points, [[0, 0], [0, 3]]);
  // The trimmed end still dangles; the next fix deletes the track.
  const v2 = F.checks(b, defs).find(x => x.type === "netAntennae");
  fixWith(b, v2);
  assert.ok(!b.items.some(i => i.id === "stub"));
  assert.equal(F.checks(b, defs).length, 0);
});

test("silk over pad: clip the footprint silk (all instances)", () => {
  const silky = JSON.parse(JSON.stringify(r2)); silky.id = "silky"; silky.footprint.courtyard = [-1.5, -1, 1.5, 1];
  silky.footprint.shapes = [{kind: "path", points: [[-1.4, .3], [1.4, .3]], width: .12, layer: "Silk"}];
  const d = new Map([...defs, ["silky", silky]]);
  const b = board([{kind: "part", id: "u", def: "silky", ref: "R1", x: 0, y: 0, angle: 90, pinNets: {"1": "A", "2": "B"}}]);
  const v = drc(b, d, ["silkToMask"])[0];
  assert.ok(v, "silk crosses the pads");
  const project = {library: [JSON.parse(JSON.stringify(silky))]};
  const lib = new Map(project.library.map(x => [x.id, x]));
  const fixes = F.fixesFor(b, lib, rules, v);
  assert.ok(fixes.some(f => f.lib === "silky"));
  let left = null;
  for (let k = 0; k < 3; k++) {
    const vv = drc(b, lib, ["silkToMask"])[0]; if (!vv) break;
    const fs = F.fixesFor(b, lib, rules, vv), best = fs.find(f => F.preview(b, lib, rules, vv, f).clears) || fs[0];
    F.apply(b, project, best); left = drc(b, lib, ["silkToMask"]);
  }
  assert.equal(drc(b, lib, ["silkToMask"]).length, 0, JSON.stringify(left));
  const kept = lib.get("silky").footprint.shapes;
  assert.ok(kept.length >= 1 && kept.every(s => Math.abs(s.points[0][0]) < 1.4), "the line is cut back from the pads");
});

test("silk over pad: board overlay line clipped", () => {
  const b = board([pad("p", "A", 0, 0), {kind: "graphic", id: "g", layer: "Silk", points: [[-3, 0], [3, 0]], width: .15}]);
  const v = drc(b, defs, ["silkToMask"])[0];
  assert.ok(v);
  fixWith(b, v);
  assert.equal(drc(b, defs, ["silkToMask"]).length, 0);
  assert.equal(b.items.filter(i => i.kind === "graphic").length, 2, "two pieces either side of the pad");
});

test("annular ring: enlarge the via within the rule", () => {
  const b = board([via("v", "A", 0, 0, .4, .3)]);
  const v = drc(b, defs, ["annularRing"])[0];
  assert.ok(v);
  fixWith(b, v);
  assert.equal(drc(b, defs, ["annularRing"]).length, 0);
});

test("annular ring: enlarge the footprint pad", () => {
  const small = JSON.parse(JSON.stringify(tht)); small.footprint.pads[0].w = small.footprint.pads[0].h = .9; small.footprint.pads[0].drill = .8;
  const d = new Map([["tht", small]]);
  const b = board([{kind: "part", id: "j", def: "tht", ref: "J1", x: 0, y: 0, angle: 0, pinNets: {"1": "A"}}]);
  const v = drc(b, d, ["annularRing"])[0];
  assert.ok(v);
  const project = {library: [JSON.parse(JSON.stringify(small))]};
  const r = fixWith(b, v, () => true, project);
  assert.equal(drc(b, r.lib, ["annularRing"]).length, 0);
});

test("missing courtyard: add one to the footprint", () => {
  const b = board([{kind: "part", id: "u", def: "r2", ref: "R1", x: 0, y: 0, angle: 0, pinNets: {}}]);
  const v = F.checks(b, defs).find(x => x.type === "courtyard");
  const r = fixWith(b, v);
  const fp = r.lib.get("r2").footprint;
  assert.ok(F.hasCourtyard(fp));
  assert.deepEqual(fp.courtyard, [-1.45, -.75, 1.45, .75]);
  assert.equal(F.checks(b, r.lib).filter(x => x.type === "courtyard").length, 0);
});

test("previews do not touch the board; hints name the fix", () => {
  const b = board([pad("pa", "A", 0, 0), pad("pb", "A", 10, 0), track("t", "A", [[0, 0], [10, 0]]), via("v", "B", 5, .62)]);
  const before = JSON.stringify(b), v = drc(b, defs, ["clearance"])[0];
  for (const f of F.fixesFor(b, defs, rules, v)) F.preview(b, defs, rules, v, f);
  assert.equal(JSON.stringify(b), before);
  assert.match(F.hint(v), /^Fix: nudge the track/);
  assert.equal(F.hint({type: "short"}), "");
});

test("clipOut cuts a line around a rotated box", () => {
  const pieces = F.clipOut([[-3, 0], [3, 0]], [0, 0], 2, 1, 0);
  assert.deepEqual(pieces, [[[-3, 0], [-1, 0]], [[1, 0], [3, 0]]]);
  assert.equal(F.clipOut([[-3, 5], [3, 5]], [0, 0], 2, 1, 30).length, 1);
});

let failed = 0;
for (const c of cases) {
  try { c.run(); console.log("PASS " + c.name); }
  catch (e) { failed++; console.log("FAIL " + c.name + "\n  " + (e && e.message) + "\n  " + String(e && e.stack || "").split("\n").slice(0, 3).join(" | ")); }
}
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " drc-fixes test(s) failed"); }
console.log("drc-fixes: " + cases.length + " tests passed");
