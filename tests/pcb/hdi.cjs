"use strict";
// HDI vias (viastack.js AtriumViaStack.hdi, hdi.js, rules.js Layer Pairs / HDI Vias,
// router.js via choice, fab-outputs.js drill files and notes) on an 8-layer 2+4+2 test
// board: lamination stages and span validity, recommended drill pairs, the router's
// stacked microvias, DRC (drill pairs, aspect ratio, stacked count, stagger, controlled
// depth, via-in-pad filling) and the fabrication outputs, compared with goldens in
// tests/fixtures/hdi/. Boards without HDI keep their outputs (no HDI notes, no via-fill files).
//
// Regenerate the goldens after an intended output change:
//   TZ=UTC jsc tests/jsc-shim.js -- tests/pcb/hdi.cjs --print > /tmp/hdi.txt   (or: node tests/pcb/hdi.cjs --print)
//   python3 -c "import re,sys;t=open('/tmp/hdi.txt',newline='').read();[open('tests/fixtures/hdi/'+n,'w',newline='').write(b) for n,b in re.findall(r'^=== (\S+)\n(.*?)\n=== end\n',t,re.S|re.M)]"
require("../support/utc.cjs");   // drill headers carry local time and offset; the goldens are in UTC
const assert = require("node:assert/strict");
const fs = require("node:fs");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "hierarchy", "component-classes", "query", "stackup", "rules", "viastack", "board-shape", "polygon-pour", "bom", "fab-outputs", "router", "hdi"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, S = AtriumStackup, V = AtriumViaStack, H = V.hdi, R = AtriumRules, F = AtriumFabOutputs, RT = AtriumRouter, X = AtriumHDI;
const date = new Date(2026, 10, 18, 10, 30, 0);
const PRINT = (typeof process !== "undefined" && process.argv || []).includes("--print");
const FIX = __dirname + "/../fixtures/hdi/";

// ---- The test board: 8 layers, 2+4+2, 75 µm build-up prepregs -----------------------
function hdiBoard() {
  const p = A.project("HDI", AtriumParts.catalogue), b = p.documents.find(d => d.kind === "pcb");
  b.name = "HDI"; b.outline = [[0, 0], [50, 0], [50, 30], [0, 30]];
  const stack = S.preset("8");
  let k = 0;
  for (const l of stack.layers) if (l.type === "Dielectric") { k++; if (k <= 2 || k >= 6) { l.thickness = .075; l.dielectric = "Prepreg"; } }
  b.stackup = {version: 1, layers: stack.layers, drillPairs: []};
  b.hdi = {top: 2, bottom: 2, microvia: {diameter: .25, drill: .1, ipc4761: "VII"}};
  return {p, b, defs: new Map(p.library.map(d => [d.id, d]))};
}
const via = (id, x, y, extra = {}) => ({kind: "via", id, x, y, diameter: .6, drill: .3, layer: "Multi", net: "N" + id, ...extra});
const uvia = (id, x, y, from, to, extra = {}) => via(id, x, y, {diameter: .25, drill: .1, fromLayer: from, toLayer: to, microvia: true, ipc4761: "VII", ...extra});

// ---- Lamination stages and span validity ----------------------------------------------
{
  const {b, defs} = hdiBoard(), c = H.config(b, defs), keys = c.keys;
  assert.equal(H.name(c), "2+4+2");
  assert.deepEqual(c.core, [2, 5]);
  const st = H.stages(b, defs, c);
  assert.deepEqual(st.map(s => [s.kind, s.from, s.to]), [["core", "Inner 2", "Inner 5"], ["build-up", "Inner 1", "Inner 6"], ["build-up", "Top", "Bottom"]]);
  assert.equal(H.laminations(c, st), 3, "core press plus two build-up presses");
  const span = (a, z) => H.spanStatus(b, keys[a], keys[z], defs, c);
  assert.deepEqual([span(0, 7).kind, span(0, 7).method], ["through", "mechanical"]);
  assert.deepEqual([span(2, 5).kind, span(2, 5).stage], ["buried", 0], "the core buried via");
  assert.deepEqual([span(1, 6).kind, span(1, 6).stage], ["buried", 1], "drilled after the first build-up press");
  for (const [a, z, stage] of [[0, 1, 2], [1, 2, 1], [5, 6, 1], [6, 7, 2]]) assert.deepEqual([span(a, z).kind, span(a, z).laser, span(a, z).stage], ["microvia", true, stage], a + "-" + z);
  assert.ok(span(0, 2).skip, "L1-L3 is a skip via");
  assert.equal(span(0, 3).method, "controlled-depth");
  const bad = span(3, 4);
  assert.equal(bad.ok, false); assert.equal(bad.code, "lamination"); assert.match(bad.reason, /L4 or L5/);
  assert.equal(H.spanStatus(b, "Top", "Inner 9", defs, c).code, "layer");
  // Without a build-up every span is mechanical and only the stack's drill pairs matter.
  const plain = {...b, hdi: undefined};
  assert.equal(H.config(plain, defs), null);
  assert.deepEqual([H.spanStatus(plain, "Inner 3", "Inner 4", defs).ok, H.spanStatus(plain, "Inner 3", "Inner 4", defs).defined], [true, false]);
  // Any-layer: every adjacent pair is a laser step; a two-layer stack has no room for a build-up.
  const elic = {...b, hdi: {anyLayer: true}};
  assert.equal(H.name(H.config(elic, defs)), "Any-layer (8 layers)");
  for (let i = 0; i < 7; i++) assert.ok(H.spanStatus(elic, keys[i], keys[i + 1], defs).ok, "ELIC " + i);
  assert.equal(H.config({kind: "pcb", items: [], stackup: {version: 1, layers: S.preset("2").layers}, hdi: {top: 1, bottom: 1}}), null);
  assert.deepEqual(H.cleanConfig({top: 2, bottom: -1, skip: false, microvia: {drill: .1, ipc4761: "bogus"}}), {version: 1, top: 2, bottom: 0, skip: false, microvia: {drill: .1}});
}

// ---- Recommended drill pairs, written into the stack ----------------------------------
{
  const {p, b, defs} = hdiBoard();
  const rec = H.recommendedPairs(b, defs).map(q => q.from + "-" + q.to + ":" + q.method);
  assert.deepEqual(rec, ["Top-Bottom:mechanical", "Inner 2-Inner 5:mechanical", "Inner 1-Inner 6:mechanical", "Inner 1-Inner 2:laser", "Inner 5-Inner 6:laser", "Top-Inner 1:laser", "Inner 6-Bottom:laser"]);
  b.stackup.drillPairs = [{from: "Inner 3", to: "Inner 4"}, {from: "Top", to: "Inner 2"}];
  const out = X.apply(b, defs, {config: b.hdi}, p);
  assert.deepEqual(S.stored(b).drillPairs.map(q => q.from + "-" + q.to).sort(),
    ["Inner 1-Inner 2", "Inner 1-Inner 6", "Inner 2-Inner 5", "Inner 5-Inner 6", "Inner 6-Bottom", "Top-Inner 1", "Top-Inner 2"].sort(), "keeps buildable pairs, drops L4-L5");
  assert.deepEqual(out.rules, ["LayerPairs", "HDIVias", "RoutingVias_Microvia", "MinimumAnnularRing_Microvia"]);
  assert.deepEqual(R.effective(b, p).list.filter(r => r.type === "layerPairs" || r.type === "hdiVias").map(r => r.type), ["layerPairs", "hdiVias"]);
  assert.deepEqual(X.apply(b, defs, {config: b.hdi}, p).rules, [], "rules are added once");
  X.apply(b, defs, {config: null}, p);
  assert.equal(b.hdi, undefined, "build-up removed");
}

// ---- Router: microvias and stacked chains from the build-up ---------------------------
{
  const {b, p, defs} = hdiBoard();
  X.addRules(b,p,defs); // normal HDI Setup installs the laser-specific drill and annular ring rules
  b.items.push({id: "start", kind: "pad", x: 5, y: 5, w: .5, h: .5, shape: "round", layer: "Top", net: "SIG"});
  const route = (to, layer) => {
    const s = RT.begin(b, defs, {net: "SIG", layer: "Top", start: [5, 5], mode: "ignore"});
    s.move([8, 5]); s.click();
    const sw = s.switchLayer(layer);
    assert.ok(sw.ok, sw.message);
    s.move(to); s.click();
    return s.commit().add.filter(i => i.kind === "via");
  };
  let vias = route([11, 5], "Inner 1");
  assert.equal(vias.length, 1);
  assert.deepEqual([vias[0].fromLayer, vias[0].toLayer, vias[0].microvia, vias[0].drill, vias[0].diameter, vias[0].ipc4761], ["Top", "Inner 1", true, .1, .25, "VII"]);
  vias = route([11, 5], "Inner 2");
  assert.deepEqual(vias.map(v => v.fromLayer + "-" + v.toLayer), ["Top-Inner 1", "Inner 1-Inner 2"], "two stacked microvias");
  assert.ok(vias.every(v => v.microvia && v.x === vias[0].x && v.y === vias[0].y));
  vias = route([11, 5], "Inner 3");
  assert.equal(vias.length, 1); assert.equal(vias[0].fromLayer, undefined, "a through via is cheaper than three stacked vias into the core");
  // The chain itself: L2 to L4 uses the stage-1 buried via.
  assert.deepEqual(H.chain(b, "Inner 1", "Inner 3", defs).map(s => s.from + "-" + s.to), ["Inner 1-Inner 6"]);
  // Without a build-up the router keeps its drill-pair choice.
  const plain = {...b, hdi: undefined};
  assert.equal(H.routeSpan(plain, "Top", "Inner 2", defs), null);
  assert.deepEqual(RT.core.viaSpan(plain, "Top", "Inner 2"), {lo: 0, hi: 127});
}

// ---- DRC: Layer Pairs and HDI Vias ---------------------------------------------------
function drcBoard() {
  const t = hdiBoard(), {b} = t;
  b.items.push(
    via("through", 4, 4), // fine
    uvia("s1", 8, 4, "Top", "Inner 1"), uvia("s2", 8, 4, "Inner 1", "Inner 2"), // two stacked: within the limit of 2
    uvia("x1", 12, 4, "Top", "Inner 1"), uvia("x2", 12, 4, "Inner 1", "Inner 2"), via("x3", 12, 4, {fromLayer: "Inner 2", toLayer: "Inner 5"}),
    uvia("x4", 12, 4, "Inner 5", "Inner 6"), uvia("x5", 12, 4, "Inner 6", "Bottom"), // a full stack: two runs of two microvias around the core via
    uvia("t1", 16, 4, "Top", "Inner 1"), uvia("t2", 16.15, 4, "Inner 1", "Inner 2"), // staggered 0.15 mm apart (< 0.25)
    uvia("u1", 20, 4, "Top", "Inner 1"), uvia("u2", 20.4, 4, "Inner 1", "Inner 2"), // staggered 0.4 mm apart: fine
    via("core", 24, 4, {fromLayer: "Inner 3", toLayer: "Inner 4"}), // L4-L5: not buildable, not a drill pair
    via("deep", 28, 4, {fromLayer: "Top", toLayer: "Inner 3"}), // controlled depth
    via("thin", 32, 4, {drill: .1, diameter: .35, microvia: false}), // 1.055 mm / 0.1 mm > 10:1
    uvia("fat", 36, 4, "Top", "Inner 1", {drill: .05, diameter: .2}), // 0.075 / 0.05 = 1.5:1 > 1:1
    {kind: "pad", id: "padA", number: "1", x: 40, y: 4, w: .6, h: .8, shape: "rect", layer: "Top", net: "NvipOpen"},
    via("vipOpen", 40, 4, {drill: .2, diameter: .35}), // through via in an SMD pad, not filled
    {kind: "pad", id: "padB", number: "2", x: 44, y: 4, w: .6, h: .8, shape: "rect", layer: "Top", net: "NvipFilled"},
    uvia("vipFilled", 44, 4, "Top", "Inner 1"), // Type VII microvia in pad: fine
    via("bd", 4, 12, {backdrill: {from: "bottom", toLayer: "Inner 2", stubMax: .15, diameter: .55}})
  );
  for (const v of b.items) if (v.id === "vipOpen") v.net = "NvipOpen"; else if (v.id === "vipFilled") v.net = "NvipFilled";
  for (const id of ["s2", "x2", "x3", "x4", "x5"]) b.items.find(i => i.id === id).net = "N" + id[0] + "1";
  b.items.find(i => i.id === "t2").net = "Nt1"; b.items.find(i => i.id === "u2").net = "Nu1";
  return t;
}
{
  const {p, b, defs} = drcBoard();
  X.apply(b, defs, {config: b.hdi}, p);
  const res = R.drc(b, defs, R.effective(b, p), {types: ["layerPairs", "hdiVias"], project: p});
  const got = res.violations.map(v => v.type + ":" + v.id + ":" + v.what).sort();
  assert.deepEqual(got, [
    "hdiVias:deep:Drill depth",
    "hdiVias:fat:Aspect ratio",
    "hdiVias:t1:Microvia stagger",
    "hdiVias:thin:Aspect ratio",
    "hdiVias:vipOpen:Via in pad",
    "layerPairs:core:Layer pair",
    "layerPairs:deep:Layer pair"
  ].sort(), JSON.stringify(res.violations.map(v => [v.id, v.what, v.detail || v.actual])));
  const by = id => res.violations.find(v => v.id === id);
  assert.match(by("core").detail, /not a drill pair|L4 or L5/);
  assert.match(by("thin").detail, /exceeds 10:1$/);
  assert.match(by("fat").detail, /1\.50:1 .* exceeds 1:1 for a microvia/);
  assert.match(by("vipOpen").detail, /^Via in pad 1 is not filled \(IPC-4761 Type None\)/);
  assert.equal(by("t1").otherId, "t2"); assert.equal(by("t1").actual, .15);
  // A stricter rule: one stacked microvia, no skip vias, and controlled depth allowed.
  const set = R.effective(b, p), hv = set.list.find(r => r.type === "hdiVias");
  Object.assign(hv, {maxStacked: 1, allowDepth: true, microviaAspect: .75});
  b.items.push(uvia("skip", 8, 20, "Top", "Inner 2", {net: "Nskip", diameter: .3, drill: .15}));
  hv.allowSkip = false;
  const strict = R.drc(b, defs, R.validate(R.normalize(set)), {types: ["hdiVias"], project: p}).violations.map(v => v.id + ":" + v.what).sort();
  for (const e of ["s1:Stacked microvias", "x1:Stacked microvias", "skip:Skip via", "skip:Microvia span"]) assert.ok(strict.includes(e), e + " in " + strict.join(", "));
  assert.ok(!strict.includes("deep:Drill depth"), "controlled depth allowed");
  // Rules are optional and validated like the others; the rule types appear under Manufacturing.
  assert.equal(R.types.hdiVias.category, "Manufacturing"); assert.equal(R.types.layerPairs.altium, "LayerPairs");
  assert.ok(!R.create().list.some(r => r.type === "hdiVias" || r.type === "layerPairs"), "boards without HDI rules are unchanged");
  assert.throws(() => R.validate({...set, list: [{...hv, maxStacked: 0}]}), /whole number/);
  // The microvia-scoped Routing Via Style and Annular Ring rules keep the board-wide via rules off the microvias.
  const sizes = R.drc(b, defs, R.effective(b, p), {types: ["viaStyle", "annularRing"], project: p}).violations.map(v => v.id);
  for (const id of ["s1", "s2", "x1", "t1", "u2", "vipFilled"]) assert.ok(!sizes.includes(id), id + " in " + sizes.join(", "));
  assert.ok(sizes.includes("fat"), "a 0.05 mm hole is below the microvia rule's 0.1 mm");
  // Stacked microvias sit in different dielectrics: no hole-to-hole violation between them
  // (Altium: Allow stacked micro vias); through holes at one point still collide.
  const h2h = R.drc(b, defs, R.create(), {types: ["holeToHole"]}).violations.map(v => [v.id, v.otherId].sort().join("+"));
  for (const pair of ["s1+s2", "x1+x2", "x2+x3", "x3+x4", "x4+x5"]) assert.ok(!h2h.includes(pair), pair + " in " + h2h.join(", "));
  // Via-in-pad: geometric detection of vias in SMD pads of placed parts too.
  const vip = H.viasInPads(b, defs).map(e => e.via.id + ":" + e.filled).sort();
  assert.deepEqual(vip, ["vipFilled:true", "vipOpen:false"]);
  // Stacks: the full stack is one site with a longest microvia run of two.
  const stacks = H.stacks(b, defs);
  assert.deepEqual(stacks.map(s => s.ids.join(",") + ":" + s.microvias), ["s1,s2:2", "x1,x2,x3,x4,x5:2"]);
}

// ---- Fabrication outputs: drill pairs, back-drill, via fill, notes (goldens) -----------
{
  const {p, b, defs} = drcBoard();
  b.items = b.items.filter(i => !["core", "deep", "thin", "fat"].includes(i.id));
  X.apply(b, defs, {config: b.hdi}, p);
  const out = F.build(p, b, {date, viaFill: true}), names = out.files.map(f => f.name);
  const drills = out.files.filter(f => f.kind === "drill").map(f => f.name);
  assert.deepEqual(drills, ["HDI-Plated.TXT", "HDI-Microvia-TOP-IN1.TXT", "HDI-Microvia-IN1-IN2.TXT", "HDI-Plated-IN2-IN5.TXT", "HDI-Microvia-IN5-IN6.TXT",
    "HDI-Microvia-IN6-BOT.TXT", "HDI-BackDrill-IN3-BOT.TXT", "HDI-ViaFill-TOP-IN1.TXT", "HDI-ViaFill-IN1-IN2.TXT", "HDI-ViaFill-IN5-IN6.TXT", "HDI-ViaFill-IN6-BOT.TXT"]);
  const file = n => out.files.find(f => f.name === n).content;
  const fn = n => (/^; #@! TF\.FileFunction,(.*)$/m.exec(file(n)) || [])[1];
  assert.equal(fn("HDI-Microvia-TOP-IN1.TXT"), "Plated,1,2,Blind,Drill");
  assert.equal(fn("HDI-Microvia-IN1-IN2.TXT"), "Plated,2,3,Buried,Drill");
  assert.equal(fn("HDI-Plated-IN2-IN5.TXT"), "Plated,3,6,Buried");
  assert.equal(fn("HDI-BackDrill-IN3-BOT.TXT"), "NonPlated,8,4,Blind,Drill");
  assert.equal(fn("HDI-ViaFill-TOP-IN1.TXT"), "Other,ViaFill,1,2");
  assert.match(file("HDI-Microvia-TOP-IN1.TXT"), /^; #@! TA\.AperFunction,ViaDrill,VII$/m);
  assert.match(file("HDI-Microvia-TOP-IN1.TXT"), /^;DRILL_PAIR=.* \(blind\)$/m, "defined in the stack: not flagged");
  assert.doesNotMatch(file("HDI-Plated-IN2-IN5.TXT"), /not a drill pair/);
  assert.deepEqual(out.model.layerIssues, []);
  const readme = file("HDI-Fabrication-Readme.txt"), report = file("HDI-DrillReport.txt");
  assert.match(readme, /HDI and via construction:\r\n  - Construction: 2\+4\+2 sequential build-up, 8 copper layers, 3 laminations: core L3-L6, then L2-L7, then L1-L8\.\r\n/);
  assert.match(readme, /Via-in-pad: 2 vias in SMD pads; .* 1 is not filled\./);
  assert.match(report, /^  - Stacked microvias: 2 sites, up to 2 high/m);
  assert.match(report, /Back-drill IN2 stub 0\.15/);
  // The drill drawing's table has a row per tool across the drill files (via fill files excluded).
  const table = F.drillMapLayer(out.model, F.settle({date}));
  assert.equal(table.count, out.files.filter(f => f.kind === "drill" && !/ViaFill/.test(f.name)).reduce((n, f) => n + f.tools.length, 0));
  // Goldens.
  const golden = names.filter(n => /\.TXT$|-DrillReport\.txt$|-Fabrication-Readme\.txt$/.test(n));
  if (PRINT) { for (const n of golden) console.log("=== " + n + "\n" + file(n) + "\n=== end"); }
  else for (const n of golden) assert.equal(file(n), fs.readFileSync(FIX + n, "utf8"), "golden " + n + " (see the header to regenerate)");
  // Deterministic.
  assert.equal(F.build(p, b, {date, viaFill: true}).files.map(f => f.content).join("\u0000"), out.files.map(f => f.content).join("\u0000"));
  // Via-fill files are opt-in.
  assert.ok(!F.build(p, b, {date}).files.some(f => /ViaFill/.test(f.name)));
}

// ---- Boards without HDI: no notes, no new files ----------------------------------------
{
  const s = AtriumParts.example(), b = s.documents[1], out = F.build(s, b, {date, viaFill: true});
  assert.ok(!out.files.some(f => /ViaFill|Microvia|BackDrill/.test(f.name)));
  assert.doesNotMatch(out.files.find(f => /Readme/.test(f.name)).content, /HDI and via construction/);
  assert.deepEqual(H.notes(b, new Map(s.library.map(d => [d.id, d]))), []);
  assert.deepEqual(R.drc(b, new Map(s.library.map(d => [d.id, d])), R.effective(b, s), {types: ["layerPairs", "hdiVias"]}).violations, []);
}
console.log("hdi: ok");
