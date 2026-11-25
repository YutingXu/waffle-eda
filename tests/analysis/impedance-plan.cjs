"use strict";
// Impedance plan (app/analysis/impedance-plan.js): per-layer solutions of an impedance spec on a stack-up,
// per-layer targets ("inner 85"), substack zones, binding to a stored profile, and the ranked
// one-step fixes for an unreachable target, each checked by solving the fixed geometry again.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh impedance-plan).
const assert = require("node:assert/strict");
for (const m of ["model", "impedance", "stackup", "rigid-flex", "impedance-plan"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const S = AtriumStackup, I = AtriumImpedance, P = AtriumImpedancePlan;
const close = (a, b, eps, m) => assert.ok(Math.abs(a - b) <= eps, (m ? m + ": " : "") + a + " vs " + b);
const four = () => S.normalize(S.preset(4));
// Top / 0.075 prepreg / GND / core / PWR (as a signal layer) / 0.075 prepreg / Bottom.
function thin() {
  const st = JSON.parse(JSON.stringify(four()));
  st.layers[3].thickness = .075; st.layers[7].thickness = .075; st.layers[6].type = "Signal";
  return S.normalize(st);
}
const zAt = (layers, key, refs, w, extra) => I.solve({...I.geometry(layers, key, refs), w, ...extra});

// Reachable: every signal layer of the 4-layer preset, the fab policy's values, no suggestions.
{
  const p = P.plan(four(), {target: 90, kind: "diff"});
  assert.equal(p.reachable, true); assert.deepEqual(p.layers.map(r => r.key), ["Top", "Bottom"]);
  for (const r of p.layers) {
    assert.equal(r.reachable, true); assert.equal(r.suggestions, undefined); assert.equal(r.structure, "microstrip");
    close(r.z, 90, .05); close(r.gap, .2, 1e-9, "gap = max(min space, h)"); assert.equal(r.window, 5);
    assert.ok(r.minWidth < r.warnMinWidth && r.warnMaxWidth < r.maxWidth);
    close(zAt(four().layers, r.key, undefined, r.width, {s: r.gap}).zdiff, 90, .05, "solved width and gap give the target");
  }
  assert.deepEqual(p.limits, {track: .1, space: .1, clearance: 0, source: "default"});
  assert.match(p.summary, /2 of 2 layer rows reach 90/);
}
// Per-layer targets (v1): 90 Ω outer, 85 Ω inner; named planes can be targeted, scope words skip them.
{
  const st = four(), p = P.plan(st, {target: 90, kind: "diff", layers: ["all", "GND"], overrides: [{layers: ["inner"], target: 85}]});
  assert.deepEqual(p.layers.map(r => [r.key, r.target]), [["Top", 90], ["Inner 1", 85], ["Bottom", 90]]);
  assert.equal(p.layers[1].structure, "stripline");
  close(p.layers[1].z, 85, .05);
  assert.deepEqual(P.plan(st, {target: 50, layers: ["inner"]}).layers, [], "the preset's inner layers are planes");
  assert.equal(P.plan(st, {target: 50, layers: ["inner"]}).reachable, false);
}
// Unreachable single-ended: 75 Ω over a 0.075 mm prepreg needs a track below the 0.1 mm fab minimum.
{
  const st = thin(), p = P.plan(st, {target: 75, kind: "se", layers: ["Top", "Inner 2"]});
  const top = p.layers.find(r => r.key === "Top");
  assert.equal(p.reachable, false); assert.equal(top.reachable, false); assert.equal(top.reason, "width");
  assert.ok(top.need > 0 && top.need < .1); assert.match(top.error, /below the fab minimum width 0\.1 mm/);
  const kinds = top.suggestions.map(x => x.kind);
  assert.deepEqual(top.suggestions.map(x => x.rank), kinds.map((_, i) => i + 1));
  assert.equal(kinds.at(-1), "target", "the target change comes last");
  assert.ok(kinds.indexOf("reference") < kinds.indexOf("dielectric") && kinds.indexOf("dielectric") < kinds.indexOf("avoidLayer"),
    "no other layer reaches 75 Ω, so keeping off the layer ranks after the copper fixes");
  assert.ok(!kinds.includes("coplanar"), "coplanar ground only lowers Z: not offered for a target that is too high");
  // Another reference: the farther plane with the nearer one voided; its width gives the target.
  const ref = top.suggestions.find(x => x.kind === "reference");
  assert.deepEqual(ref.reference, [null, "Inner 2"]); assert.deepEqual(ref.void, ["Inner 1"]); assert.ok(ref.width >= .1);
  close(zAt(st.layers, "Top", ref.reference, ref.width).z, 75, .1, "reference fix");
  // Dielectric: the prepreg thickness that reaches 75 Ω at the fab minimum width.
  const die = top.suggestions.find(x => x.kind === "dielectric");
  assert.equal(die.layers.length, 1); assert.equal(die.layers[0].from, .075); assert.ok(die.layers[0].to > .075); assert.match(die.text, /^Thicken /);
  const moved = JSON.parse(JSON.stringify(st)); moved.layers[3].thickness = die.layers[0].to;
  close(zAt(moved.layers, "Top", undefined, .1).z, 75, .1, "dielectric fix");
  // The nearest reachable target, rounded inward, is reachable and never preselected.
  const tgt = top.suggestions.at(-1);
  assert.equal(tgt.preselect, false); assert.ok(tgt.target < 75);
  assert.equal(P.plan(st, {target: tgt.target, kind: "se", layers: ["Top"]}).reachable, true);
}
// Keeping off the layer ranks first when another targeted layer reaches the target.
{
  const st = JSON.parse(JSON.stringify(four())); st.layers[3].thickness = .075;
  const p = P.plan(S.normalize(st), {target: 75, kind: "se"});
  const top = p.layers.find(r => r.key === "Top"), bottom = p.layers.find(r => r.key === "Bottom");
  assert.equal(bottom.reachable, true, "Bottom keeps its 0.2 mm prepreg"); assert.equal(top.reachable, false);
  assert.equal(top.suggestions[0].kind, "avoidLayer"); assert.deepEqual(top.suggestions[0].others, ["Bottom"]);
}
// A stored profile with a fixed gap: the gap fix at the fab minimum width hits the target.
{
  const st = thin();
  st.impedanceProfiles = [{id: "d100", name: "USB 100", type: "diff", target: 100, tolerance: 10, policy: "fab", layers: {Top: {enabled: true, gap: .1}}}];
  const p = P.plan(st, {profile: "USB 100"});
  assert.equal(p.profile, "d100"); assert.equal(p.kind, "diff"); assert.deepEqual(p.layers.map(r => r.key), ["Top"]);
  const top = p.layers[0], gap = top.suggestions.find(x => x.kind === "gap");
  assert.equal(top.reachable, false); assert.ok(gap.gap > .1); assert.equal(gap.width, .1);
  close(zAt(st.layers, "Top", undefined, .1, {s: gap.gap}).zdiff, 100, .1, "gap fix");
  // Fab limits from the board: a finer process reaches it.
  assert.equal(P.plan(st, {profile: "d100"}, {limits: {track: .05, space: .05}}).reachable, true);
  assert.throws(() => P.plan(st, {profile: "nope"}), /No impedance profile nope/);
}
// A solved fixed width must also meet the requested tolerance to be recommended.
{
  const st = four();
  const profile = {id: "fixed", name: "Fixed", type: "single", target: 50, tolerance: 10, policy: "fab",
    layers: {Top: {enabled: true, width: .12}, Bottom: {enabled: true}}};
  st.impedanceProfiles = [profile];
  const plan = P.plan(st, {profile: "fixed"});
  const [top, bottom] = plan.layers;
  assert.equal(top.within, false);
  assert.equal(top.reachable, false);
  assert.equal(top.reason, "fixedWidth");
  assert.equal(top.width, .12);
  assert.equal(bottom.reachable, true);
  assert.equal(plan.reachable, false);
  assert.match(plan.summary, /^1 of 2 layer rows reach 50/);
  const change = top.suggestions.find(s => s.kind === "width");
  close(zAt(st.layers, "Top", top.reference, change.width).z, 50, .05, "suggested width meets the target");
  assert.equal(P.plan(st, {profile: "fixed"}, {suggestions: false}).layers[0].suggestions, undefined);

  // The public command must not turn that fixed row into use_layer advice.
  require("../../mcp/headless.js");
  const project = Atrium.project("Width plan"), doc = project.documents.find(d => d.kind === "pcb");
  doc.stackup = st;
  const mcp = (op, args, payload) => JSON.parse(AtriumHeadless(JSON.stringify({op, args}), payload));
  mcp("load", {digest: "width-plan"}, JSON.stringify(project));
  const result = mcp("impedance_plan", {profile: "fixed"});
  assert.deepEqual(result.suggestions.filter(s => s.action === "use_layer").map(s => s.layer), ["Bottom"]);
  assert.ok(result.suggestions.some(s => s.action === "width" && s.layer === "Top"));
}

// A target too low for the widest track (10 mm): a thinner dielectric, the nearest target above.
// (Coplanar ground is offered only where the CPWG model confirms it; it does not here, w >> h.)
{
  const st = four(), p = P.plan(st, {target: 3, kind: "se", layers: ["Top"]}), top = p.layers[0];
  assert.equal(top.reachable, false); assert.equal(top.reason, "maxWidth"); assert.ok(top.need > 10);
  const die = top.suggestions.find(x => x.kind === "dielectric");
  assert.match(die.text, /^Thin /); assert.ok(die.layers[0].to < die.layers[0].from); assert.equal(die.width, 10);
  const moved = JSON.parse(JSON.stringify(st)); moved.layers[3].thickness = die.layers[0].to;
  close(zAt(moved.layers, "Top", undefined, 10).z, 3, .02, "thinner dielectric fix");
  assert.ok(top.suggestions.at(-1).target > 3);
}
// Rigid-flex zones: the flex substack gets its own row (and its own target).
{
  const st = JSON.parse(JSON.stringify(four()));
  st.substacks = [{id: "flex", name: "Flex", flex: true, layers: S.flexLayers(["Top", "Inner 1"], st.layers)}];
  const n = S.normalize(st), p = P.plan(n, {target: 50, kind: "se", layers: ["Top"], zones: {flex: {target: 35}}});
  assert.deepEqual(p.layers.map(r => [r.key, r.stack, r.target]), [["Top", "main", 50], ["Top", "flex", 35]]);
  assert.ok(p.layers.every(r => r.reachable)); close(p.layers[1].z, 35, .05);
}
// Spec validation.
{
  assert.throws(() => P.plan(four(), {kind: "diff"}), /target impedance or a profile/);
  assert.throws(() => P.plan(four(), {target: 50, kind: "triple"}), /kind must be se or diff/);
  assert.throws(() => P.plan(four(), {target: 50, overrides: [{target: 40}]}), /needs layers/);
  assert.equal(P.cleanSpec({target: 90, kind: "differential"}).kind, "diff");
}
console.log("PASS impedance plan: per-layer solutions and targets, zones, profiles, ranked fixes checked by re-solving.");
