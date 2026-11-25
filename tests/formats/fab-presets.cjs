"use strict";
// Fab Capability Presets (app/formats/fab-presets.js, app/fab-presets/jlcpcb.json): the data and its sources,
// preset application as one idempotent change, the preview diff, adopting updated data, the JLCPCB
// BOM / CPL goldens against JLCPCB's documented format, the vendor bundle, MCP operations, and the
// controlled-impedance widths of the stack-ups against JLCPCB calculator results.
// Run: scripts/test-jsc.sh fab-presets   (or node tests/formats/fab-presets.cjs)
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "altium-rules", "query", "rules", "connectivity", "drc", "messages", "erc", "parts", "spatial", "pcb-appearance", "pcb-pours", "pcb-text-rich", "pcb-text", "stackup",
  "board-shape", "rigid-flex", "viastack", "zip", "fab-outputs", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "bom", "step-export", "kicad-export", "kicad-schematic", "ipc2581", "panel", "waivers", "drc-waivers",
  "output-jobs", "impedance", "field-solver", "dfm"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const FP = AtriumFabPresets, ST = AtriumStackup, I = AtriumImpedance, J = AtriumOutputJobs, MIL = .0254;
const APP = path.join(__dirname, "../../app"), GOLD = path.join(__dirname, "../goldens/fab-presets");
const text = d => typeof d === "string" ? d : new TextDecoder().decode(d);
const date = new Date(Date.UTC(2026, 10, 19, 12, 0, 0));
const json = JSON.parse(fs.readFileSync(path.join(APP, "fab-presets", "jlcpcb.json"), "utf8"));

// ---- data: format, every value sourced or marked unverified, loader in step with the JSON
assert.equal(json.format, "atrium-fab-preset"); assert.equal(json.version, 1); assert.match(json.retrieved, /^\d{4}-\d{2}-\d{2}$/);
for (const [k, s] of Object.entries(json.sources)) { assert.match(s.url, /^https:\/\//, k); assert.match(s.retrieved, /^\d{4}-\d{2}-\d{2}$/, k); }
(function walk(o, where) {
  if (Array.isArray(o)) return o.forEach((x, i) => walk(x, where + "[" + i + "]"));
  if (!o || typeof o !== "object") return;
  if ("v" in o) assert.ok(o.unverified === true ? typeof o.note === "string" && o.note.length > 10 : json.sources[o.src] || o.note, where + ": a value needs a source or an unverified note");
  if ("src" in o && o.src !== null) assert.ok(json.sources[o.src], where + ": unknown source " + o.src);
  for (const [k, v] of Object.entries(o)) if (k !== "sources") walk(v, where + "." + k);
})(json, "jlcpcb");
const loader = fs.readFileSync(path.join(APP, "fab-presets", "jlcpcb.js"), "utf8");
assert.deepEqual(JSON.parse(loader.slice(loader.indexOf("define(") + 7, loader.lastIndexOf(");"))), json, "jlcpcb.js is generated from jlcpcb.json (scripts/fab-presets.py)");
assert.throws(() => FP.readData({...json, version: 2}), /newer Waffle/);
assert.throws(() => FP.readData({...json, format: "x"}), /Not a fab preset/);
// A data file from an earlier version still reads (tests/fixtures/compat/stores/fab-preset-v1.json).
assert.equal(FP.readData(JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/compat/stores/fab-preset-v1.json"), "utf8"))).vendor, "Example");

// ---- the presets
const ids = FP.list().map(p => p.id);
for (const id of ["jlcpcb-2l", "jlcpcb-4l", "jlcpcb-6l"]) assert.ok(ids.includes(id), id);
const two = FP.get("jlcpcb-2l"), four = FP.get("jlcpcb-4l"), six = FP.get("jlcpcb-6l");
assert.equal(two.name, "JLCPCB 2-layer (cheapest)"); assert.equal(FP.val(two.build.thickness), 1.6); assert.equal(FP.val(two.build.finish), "HASL"); assert.equal(two.build.mask, "Green");
assert.equal(four.stackup.name, "JLC04161H-7628"); assert.equal(six.stackup.name, "JLC06161H-3313");
assert.equal(FP.val(six.build.finish), "ENIG", "JLCPCB does not offer HASL on 6 layers");
const enig = FP.get("jlcpcb-2l-enig"), thin = FP.get("jlcpcb-2l-0.8");
assert.equal(FP.val(enig.costTier), "extra"); assert.equal(enig.costTier.unverified, true, "cost tiers carry no prices and say so");
assert.equal(FP.val(thin.build.thickness), .8); assert.equal(thin.stackup.layers.find(l => l.type === "Dielectric").thickness, .73);
assert.equal(FP.limits("jlcpcb-2l-0.8").track, .1, "variants inherit the limits");
assert.equal(FP.get("jlcpcb-4l-3313").stackup.layers.filter(l => l.material === "3313").length, 2);
assert.ok(FP.unverified("jlcpcb-2l").some(u => /acidTrapAngle/.test(u.key)), "unverified values are listed");
assert.ok(FP.sourceOf(two, two.limits.track).url.startsWith("https://jlcpcb.com/capabilities"), "each value names its source");
for (const p of FP.list()) ST.normalize({version: 1, layers: p.stackup.layers}); // every stack-up is valid

// ---- applying: one change, previewed, idempotent, recorded
const sample = () => AtriumParts.example();
const boardOf = p => p.documents.find(d => d.kind === "pcb");
const defsOf = p => new Map(p.library.map(d => [d.id, d]));
{
  const p = sample(), doc = boardOf(p), defs = defsOf(p), before = JSON.stringify(p);
  const pl = FP.plan(p, doc, "jlcpcb-2l", {defs});
  assert.equal(JSON.stringify(p), before, "planning changes nothing");
  assert.ok(pl.rules.rows.some(r => r.kind === "added" && r.type === "boardOutlineClearance"));
  assert.ok(pl.rules.rows.some(r => r.kind === "changed" && r.diff.length), "changed rules list their fields");
  assert.ok(pl.stack.ok && pl.stack.changes.length, "the stack-up diff is shown");
  assert.equal(pl.noop, false);
  const out = FP.apply(p, doc, pl, {defs});
  assert.equal(out.changed, true);
  assert.deepEqual(doc.fabPreset, {format: "atrium-fab-preset", version: 1, vendor: "JLCPCB", id: "jlcpcb-2l", name: "JLCPCB 2-layer (cheapest)", dataVersion: json.dataVersion, hash: two.hash});
  AtriumRules.validate(AtriumRules.stored(doc, p));
  const once = JSON.stringify(p);
  assert.equal(FP.plan(p, doc, "jlcpcb-2l", {defs}).noop, true, "re-applying has nothing to do");
  assert.equal(FP.apply(p, doc, "jlcpcb-2l", {defs}).changed, false);
  assert.equal(JSON.stringify(p), once, "re-applying is idempotent");
  Atrium.validate(JSON.parse(once));
  // 2 -> 4 -> 6 -> 2 layers: every step is a plan, and coming back gives the same board.
  for (const id of ["jlcpcb-4l", "jlcpcb-6l", "jlcpcb-2l"]) { const x = FP.plan(p, doc, id, {defs}); assert.ok(x.stack.ok, id + ": " + x.stack.problems); FP.apply(p, doc, x, {defs}); }
  assert.equal(JSON.stringify(p), once, "switching presets and back is lossless");
  assert.equal(ST.copperLayers(doc, defs).length, 2);
  // Net-scoped user rules stay ahead of the preset.
  const set = AtriumRules.migrate(AtriumRules.stored(doc, p));
  set.list.push({id: "power-width", type: "width", name: "Power width", enabled: true, priority: 1, scope: {kind: "net", value: "VOUT"}, min: .5, preferred: .6, max: null});
  AtriumRules.store(doc, p, set);
  FP.apply(p, doc, "jlcpcb-4l", {defs});
  assert.ok(AtriumRules.stored(doc, p).list.some(r => r.name === "Power width"), "net rules are kept");
  const installed = AtriumRules.stored(doc, p).list.filter(r => r.presetKey?.startsWith("fp-"));
  assert.equal(installed.length, FP.ruleRecords(four).length);
  assert.ok(installed.every(r => AtriumUUID.isV7(r.id)));
}
// Rule sets (format 1.3): a preset replaces the Default set's board-wide rules only; a rule in another
// set is kept, and every replaced rule is listed (two of one type and scope used to show as one).
{
  const p = sample(), doc = boardOf(p), defs = defsOf(p), R = AtriumRules, base = R.migrate(R.stored(doc, p));
  const clr = base.list.find(r => r.type === "clearance");
  const production = {...clr, id: Atrium.id(), name: "Prod clearance", set: "Production", presetKey: "fp-jlcpcb-2l-clearance", gap: .3};
  R.store(doc, p, ({...base, ruleSets: [{name: "Default", enabled: true}, {name: "Production", enabled: false}],
    list: [...base.list, production, {...clr, id: "clr-2", name: "Clearance 2", priority: 2}]}));
  const pl = FP.plan(p, doc, "jlcpcb-2l", {defs}), rows = pl.rules.rows.filter(r => r.type === "clearance");
  assert.ok(!rows.some(r => r.name === "Prod clearance" || r.from === "Prod clearance"), JSON.stringify(rows));
  assert.deepEqual(rows.map(r => r.kind).sort(), ["changed", "removed"], "both replaced Default rules are listed");
  FP.apply(p, doc, pl, {defs});
  const kept = AtriumRules.stored(doc, p).list.find(r => r.id === production.id);
  assert.ok(kept && kept.set === "Production" && kept.gap === .3, "the Production set keeps its clearance rule");
  R.validate(R.stored(doc, p));
}
// The DRC still passes on the sample after the cheapest preset (it was designed to these limits).
{
  const p = sample(), doc = boardOf(p), defs = defsOf(p);
  FP.apply(p, doc, "jlcpcb-2l", {defs});
  const r = AtriumRules.drc(doc, defs, AtriumRules.stored(doc, p), {connections: null, project: p});
  assert.equal(r.total, 0, JSON.stringify(r.violations.slice(0, 3).map(v => v.ruleName + " " + v.title)));
}
// A rigid-flex board keeps its stack-up; the rules still apply.
{
  const p = sample(), doc = boardOf(p), defs = defsOf(p);
  doc.stackup = ST.normalize({...ST.preset(2), substacks: [{id: "flex", name: "Flex", flex: true, layers: [{type: "Signal", name: "F1", material: "Copper", thickness: .018, key: "Top"}, {type: "Dielectric", name: "PI", thickness: .05, dielectric: "Core"}, {type: "Signal", name: "F2", material: "Copper", thickness: .018, key: "Bottom"}]}]});
  const pl = FP.plan(p, doc, "jlcpcb-4l", {defs});
  assert.equal(pl.stack.ok, false); assert.match(pl.stack.problems[0], /rigid-flex/);
  FP.apply(p, doc, pl, {defs});
  assert.equal(ST.copperLayers(doc, defs).length, 2); assert.equal(doc.fabPreset.id, "jlcpcb-4l");
}
// ---- updated preset data: the board is told, with a diff to adopt it
{
  const p = sample(), doc = boardOf(p), defs = defsOf(p);
  FP.apply(p, doc, "jlcpcb-2l", {defs});
  assert.equal(FP.update(p, doc, {defs}).outdated, false);
  const next = JSON.parse(JSON.stringify(json));
  next.dataVersion = "2027.01.01"; next.presets[0].limits.space = {v: .09, src: "cap", q: "test"};
  FP.define(next);
  const u = FP.update(p, doc, {defs});
  assert.equal(u.outdated, true); assert.equal(u.current.dataVersion, "2027.01.01");
  const ch = u.plan.rules.rows.find(r => r.type === "clearance");
  assert.equal(ch.kind, "changed"); assert.deepEqual(ch.diff, [{field: "gap", from: .1, to: .09}]);
  FP.apply(p, doc, u.plan, {defs});
  assert.equal(FP.update(p, doc, {defs}).outdated, false);
  FP.define(json); // restore
  assert.equal(FP.update(p, doc, {defs}).outdated, true, "and back");
  doc.fabPreset = {...doc.fabPreset, version: 9};
  assert.equal(FP.update(p, doc).newer, true, "a newer record is left alone");
}

// ---- outputs: the vendor layout the release bundle reads, and the BOM / CPL goldens
{
  const L = FP.outputLayout("JLCPCB");
  assert.equal(L.x2, false, "JLCPCB's Altium guide: RS-274X, not X2"); assert.equal(L.gerberZip, "{stem}-Gerber.zip");
  assert.deepEqual(AtriumFabProfiles.outputLayout("JLCPCB").pnp, L.pnp, "fab-profiles and the preset agree on the CPL");
  assert.deepEqual(AtriumFabProfiles.outputLayout("JLCPCB").bom, L.bom);
  const p = sample(), doc = boardOf(p), defs = defsOf(p);
  // LCSC numbers on two lines (test fixtures, not real parts), so the golden shows the fourth column.
  // R2 becomes a second 10 kΩ so one BOM line carries two designators.
  for (const d of p.documents) for (const i of d.items) if (i.kind === "part" && /^R\d/.test(i.ref)) { i.parameters = {...(i.parameters || {}), "LCSC #": "C900001"}; if (i.ref === "R2") { const r1 = d.items.find(x => x.ref === "R1"); i.value = r1.value; i.def = r1.def; } }
  FP.apply(p, doc, "jlcpcb-2l", {defs});
  const set = FP.releaseSet("jlcpcb-2l"), out = J.run(p, set, {date});
  const file = re => out.files.find(f => re.test(f.name));
  const bom = text(file(/\/BOM-[^/]+\.csv$/).data), cpl = text(file(/\/CPL-[^/]+\.csv$/).data);
  const bomGold = fs.readFileSync(path.join(GOLD, "BOM-Sensor-interface.csv"), "utf8"), cplGold = fs.readFileSync(path.join(GOLD, "CPL-Sensor-interface.csv"), "utf8");
  assert.equal(bom, bomGold, "BOM golden (tests/goldens/fab-presets)"); assert.equal(cpl, cplGold, "CPL golden");
  // The golden follows JLCPCB's documented format (Sample-BOM_JLCSMT.xlsx, Sample-CPL_JLCSMT.xlsx).
  const out_ = four.outputs, rows = s => s.trim().split("\r\n").map(l => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).slice(0, -1).map(c => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, "\"")));
  const B = rows(bom), C = rows(cpl);
  assert.deepEqual(B[0], FP.val(out_.bom.columns));
  assert.ok(B.slice(1).some(r => /^R\d+,R\d+$/.test(r[1])), "designators joined by \",\" as in the sample (R5,R6)");
  assert.ok(B.slice(1).some(r => /^C\d{3,10}$/.test(r[3])), "LCSC part numbers in the fourth column");
  assert.deepEqual(C[0], FP.val(out_.cpl.columns));
  for (const r of C.slice(1)) {
    assert.match(r[1], /^-?\d+\.\d{4}mm$/); assert.match(r[2], /^-?\d+\.\d{4}mm$/, "mm with the unit suffix, 4 decimals (sample: 95.0518mm)");
    assert.ok(["Top", "Bottom"].includes(r[3])); assert.ok(+r[4] >= 0 && +r[4] < 360, "degrees");
  }
  // The bundle: flat files, the Gerber zip with Protel names, and no X2 attributes.
  const names = out.files.map(f => f.name.split("/").pop());
  for (const n of ["Sensor-interface-Gerber.zip", "BOM-Sensor-interface.csv", "CPL-Sensor-interface.csv", "Sensor-interface-Order-Notes.txt"]) assert.ok(names.includes(n), n);
  assert.ok(out.files.every(f => f.name.split("/").length === 2 || /Reports\//.test(f.name)), "flat layout");
}
// RS-274X without X2 (JLCPCB's Altium guide): the attribute commands go, the artwork stays.
{
  const p = sample(), gerbers = x2 => J.run(p, {name: "g", outputs: [{kind: "gerber", options: {readme: false, drill: false, ...(x2 === false ? {x2} : {})}}]}, {date}).files.filter(f => /\.GTL$/.test(f.name)).map(f => text(f.data));
  const [plain] = gerbers(false), [x2] = gerbers(true);
  assert.match(x2, /^%TF\.FileFunction/m); assert.doesNotMatch(plain, /^%T[FAOD]/m);
  assert.equal(plain, x2.replace(/^%T[FAOD][^\n]*\n/gm, ""));
  assert.match(plain, /^%FSLAX46Y46\*%/m); assert.match(plain, /M02\*/);
}
// The release pre-flight runs DFM for a preset board.
{
  const p = sample(), doc = boardOf(p);
  FP.apply(p, doc, "jlcpcb-2l", {defs: defsOf(p)});
  const g = AtriumDFM.releaseGate(p, FP.releaseSet("jlcpcb-2l"), (id, label, status, summary, items = [], fix = null) => ({id, label, status, summary, items, fix}));
  assert.equal(g.id, "dfm"); assert.ok(["pass", "warn"].includes(g.status), g.summary);
}

// ---- MCP operations (headless)
{
  let proj = sample(), touched = 0;
  const env = {project: () => proj, mutable: () => proj, touched: () => touched++};
  const list = FP.headless("fab_presets_list", {}, env);
  assert.ok(list.presets.length >= 3 && list.presets.every(r => r.retrieved && r.hash));
  assert.equal(FP.headless("fab_presets_list", {layers: 4}, env).presets.every(r => r.layers === 4), true);
  const full = FP.headless("fab_presets_list", {id: "jlcpcb-4l"}, env).presets[0];
  assert.equal(full.limits.track, .09); assert.ok(full.unverified.length);
  const before = JSON.stringify(proj);
  const plan = FP.headless("fab_preset_apply", {preset: "jlcpcb-4l", plan_only: true}, env);
  assert.equal(JSON.stringify(proj), before); assert.equal(plan.noop, false); assert.ok(plan.rules.length && plan.stackup.changes.length);
  const done = FP.headless("fab_preset_apply", {preset: "jlcpcb-4l"}, env);
  assert.equal(done.applied, true); assert.equal(touched, 1);
  assert.equal(FP.headless("fab_preset_apply", {preset: "jlcpcb-4l"}, env).noop, true, "idempotent through MCP too");
  assert.throws(() => FP.headless("fab_preset_apply", {preset: "nope"}, env), /Unknown fab preset/);
  const dfm = AtriumDFM.headless({}, env);
  assert.equal(dfm.preset, "jlcpcb-4l"); assert.ok(Array.isArray(dfm.issues));
}

// ---- controlled impedance: the stack-ups give JLCPCB's widths
// JLCPCB publishes no width tables; its calculator is interactive. The results below are calculator
// results users reported on JLCPCB's Q&A pages (sources qa331, qa794 in the data). JLCPCB's stated
// impedance tolerance is ±10 %: at JLCPCB's width our solvers must give the target within it.
const withKeys = layers => { const n = layers.filter(ST.isCopper).length; let i = 0; return layers.map(l => ST.isCopper(l) ? {...l, key: ST.keyAt(i++, n)} : l); };
const etchOf = (p, t) => t / (FP.val(p.impedance?.etchMil ?? {v: .7}) * MIL / 2);
let solverChecks = 0;
for (const p of [two, four]) for (const c of p.impedanceChecks) {
  const layers = withKeys(p.stackup.layers), g = I.geometry(layers, c.layer, c.reference);
  const geom = {structure: g.structure, h: g.h, er: g.er, t: g.t, cover: g.cover, etch: etchOf(p, g.t), ...(c.ground ? {g: c.ground} : {})};
  const z = I.solve({...geom, w: c.width}).z;
  assert.ok(Math.abs(z - c.target) <= c.target * .1, p.id + " " + c.id + ": " + z.toFixed(1) + " Ω at JLCPCB's " + c.width + " mm (target " + c.target + " Ω ±10 %)");
  const fs_ = AtriumFieldSolver.solve({...geom, w: c.width}, {quality: "fast"});
  if (fs_.ok !== false) { const zf = fs_.z0 ?? fs_.z; assert.ok(Math.abs(zf - c.target) <= c.target * .1, p.id + " " + c.id + " field solver: " + zf); solverChecks++; }
  if (c.type === "single") { const w = I.synthesize(geom, {target: c.target}).w; assert.ok(Math.abs(w - c.width) <= c.width * .1, c.id + " width " + w + " vs " + c.width); }
}
assert.ok(solverChecks >= 2, "the field solver checked the published points");
// Every 4- and 6-layer preset solves its profiles on every signal layer, inside the fab's limits,
// and the widths match the recorded values (tests/goldens/fab-presets/impedance.json).
{
  const gold = JSON.parse(fs.readFileSync(path.join(GOLD, "impedance.json"), "utf8")), got = {};
  for (const p of FP.list().filter(x => x.layers >= 4 && !/enig/.test(x.id))) {
    const proj = sample(), doc = boardOf(proj), defs = defsOf(proj);
    FP.apply(proj, doc, p.id, {defs});
    got[p.id] = {};
    for (const pr of doc.stackup.impedanceProfiles) for (const k of Object.keys(pr.layers)) {
      const v = ST.profileValues(doc, pr.id, k, defs);
      assert.ok(!v.error && v.width >= FP.limits(p).track - 1e-9, p.id + " " + pr.id + " " + k + ": " + (v.error || v.width));
      got[p.id][pr.id + " " + k] = v.width;
    }
  }
  assert.deepEqual(got, gold, "impedance widths");
  // JLC04161H-7628 50 Ω outer microstrip is about 0.35 mm (14 mil) with JLCPCB's inputs.
  assert.ok(Math.abs(got["jlcpcb-4l"]["jlc-se50 Top"] - .356) < .02);
}
// ---- the new-project step: File › New / start page templates that start with a preset
globalThis.__testDone = (async () => {
  require("../../app/project/templates.js"); require("../../app/formats/fab-presets-start.js");
  const T = AtriumTemplates;
  for (const [id, layers] of [["jlcpcb-2l", 2], ["jlcpcb-4l", 4], ["jlcpcb-6l", 6]]) {
    assert.ok(T.list().some(t => t.id === id), id + " is offered");
    const p = await T.build(id, {name: "New"}), doc = boardOf(p);
    assert.equal(doc.fabPreset.id, id); assert.equal(ST.copperLayers(doc, defsOf(p)).length, layers);
    assert.equal(FP.plan(p, doc, id, {defs: defsOf(p)}).noop, true, "a new board is already on its preset");
  }
  console.log("fab-presets: ok");
})();
globalThis.__testDone.catch(e => { console.error(e); process.exitCode = 1; });

