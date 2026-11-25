"use strict";

const assert = require("node:assert/strict");
for (const name of ["model", "parts", "component-families", "pcb-appearance", "pcb-pours", "board-shape",
  "stackup", "variants", "bom", "kicad-export", "fab-outputs", "output-jobs", "release"]) {
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
}

const A = Atrium, V = AtriumVariants, B = AtriumBOM, F = AtriumFabOutputs, J = AtriumOutputJobs;
const date = new Date("2026-01-02T12:00:00Z");
const standard = A.clone(AtriumParts.example().library.find(def => def.id === "std-r"));
Object.assign(standard, {description: "Standard 0603", parameters: {MPN: "BASE-0603"}, footprintName: "R_0603"});
standard.footprint.name = "R_0603";
const precision = {...A.clone(standard), id: "precision", description: "Precision 0603", parameters: {MPN: "PRECISION-0603"}};
const larger = {...A.clone(standard), id: "larger", description: "Standard 0805", parameters: {MPN: "BASE-0805"}, footprintName: "R_0805"};
larger.footprint.name = "R_0805";
larger.footprint.pads.forEach(pad => { pad.x *= 1.5; });
const project = A.project("Assembly audit", [standard, precision, larger]);
const [sheet, board] = project.documents;
board.outline = [[0, 0], [25, 0], [25, 12], [0, 12]];
for (const [n, def] of [[1, standard], [2, larger], [3, standard]]) {
  const ref = "R" + n, item = A.instantiate(project, def, [n * 5, 5], 0, {ref, link: "link-" + ref});
  sheet.items.push({...item, ...(n === 3 && {parameters: {Assembly: "Do not fit"}})});
  board.items.push({...item, id: A.id(), layer: "Top"});
}
project.componentFamilies = [{id: "resistors", name: "Resistors", members: [
  {defId: standard.id, part: "Standard resistor"}, {defId: larger.id, part: "Standard resistor"}, {defId: precision.id, part: "Precision resistor"}
]}];
project.variants = [{id: "full", name: "Full", parts: {}}, {id: "lean", name: "Lean", parts: {}}];
V.setParts(project, "full", ["link-R1"], {alternate: {def: precision.id, value: "10k 0.1%"}});
V.setParts(project, "full", ["link-R3"], {fitted: true});
V.setParts(project, "lean", ["link-R1"], {alternate: {def: larger.id}});
V.setParts(project, "lean", ["link-R2"], {fitted: false});
V.setActive(project, "full");
A.validate(project);
const original = JSON.stringify(project);

function fabrication(p, variant) {
  const b = p.documents.find(d => d.kind === "pcb");
  const model = F.analyse(p, b.id, {variant}), o = F.settle({date});
  const csv = F.pickPlace(model, o).content;
  return {csv, dnp: [...model.dnp].map(item => item.ref), svg: F.assembly(model, "Top", o).content};
}
function output(variant, source = "pcb") {
  return {name: "Assembly run", folder: "out", outputs: [
    {kind: "bom", id: "bom", options: {variant, source, style: "pcbway"}},
    {kind: "pnp", id: "pnp", options: {variant}},
    {kind: "assembly", id: "assembly", options: {variant, bottom: false}}
  ]};
}
function text(data) { return typeof data === "string" ? data : new TextDecoder().decode(data); }
function selection(p, variant, source = "pcb") {
  return B.collect(p, {source, variant}).parts.find(e => e.ref === "R1");
}

// Fitted identity supplies the description and order code. The installed land is its own definition.
for (const [variant, fitted, comment] of [["full", precision, "10k 0.1%"], ["lean", larger, larger.value]]) {
  const onBoard = selection(project, variant), onSheet = selection(project, variant, "schematic");
  assert.equal(onBoard.def.id, standard.id);
  assert.equal(onBoard.footprint, "R_0603");
  assert.equal(onBoard.description, fitted.description);
  assert.equal(onBoard.mpn, fitted.parameters.MPN);
  assert.equal(onSheet.description, fitted.description);
  assert.ok(fabrication(project, variant).csv.includes('"R1","' + comment + '","TopLayer","R_0603","5.0000","7.0000","0","' + fitted.description + '"'));
}
const base = fabrication(project, null), full = fabrication(project, "full"), lean = fabrication(project, "lean");
assert.deepEqual(base.dnp, ["R3"]);
assert.deepEqual(full.dnp, []);
assert.deepEqual(lean.dnp, ["R2", "R3"]);
assert.equal((lean.svg.match(/stroke="#d0281e"/g) || []).length, 4);
assert.ok(AtriumKiCad.exportBOM(V.forOutput(project, "lean"), board.id).content.includes('"R3"'));
assert.equal(selection(project, null).description, standard.description);

{
  const boardOnly = A.clone(project);
  boardOnly.documents = boardOnly.documents.filter(doc => doc.kind === "pcb");
  V.setParts(boardOnly, "full", ["link-R1"], {params: {Description: "Assembly-specific description"}});
  assert.equal(selection(boardOnly, "full").description, "Assembly-specific description");
  assert.ok(fabrication(boardOnly, "full").csv.includes('"Assembly-specific description"'));
}

// A board BOM and fabrication model share the PCB collection only inside the same job context.
{
  const collect = B.collect, calls = [];
  B.collect = (p, o) => { calls.push(o.source); return collect(p, o); };
  try {
    const first = J.run(project, output("lean"), {date});
    assert.equal(first.report.ok, true);
    assert.deepEqual(calls, ["pcb"]);
    calls.length = 0;
    J.run(project, {...output("lean"), outputs: output("lean").outputs.reverse()}, {date});
    assert.deepEqual(calls, ["pcb"]);
    calls.length = 0;
    J.run(project, output("lean", "schematic"), {date});
    assert.deepEqual(calls, ["schematic", "pcb"]);
    calls.length = 0;
    const separate = output("lean");
    separate.outputs[1].options.variant = "full";
    separate.outputs[2].options.variant = "full";
    const mixed = J.run(project, separate, {date});
    assert.deepEqual(calls, ["pcb", "pcb"]);
    const pnp = mixed.report.outputs.find(row => row.id === "pnp").files[0].name;
    const file = mixed.files.find(file => file.name === mixed.report.folder + "/" + pnp);
    assert.ok(text(file.data).includes('"Precision 0603"'));
  } finally {
    B.collect = collect;
  }
}

// Generate a packaged release for both targets. The grouped vendor BOM retains the placed package.
const grouped = A.clone(project);
for (const doc of grouped.documents) {
  const r1 = doc.items.find(item => item.ref === "R1");
  doc.items.push({...r1, id: A.id(), link: "link-R4", ref: "R4", x: 20});
}
V.setParts(grouped, "lean", ["link-R4"], {alternate: {def: larger.id}});
const jobs = output(undefined);
for (const out of jobs.outputs) delete out.options.variant;
const released = AtriumRelease.releaseSync(grouped, jobs, {date, variants: ["full", "lean"], preflight: {checks: []}});
assert.equal(released.ok, true);
for (const name of ["Full", "Lean"]) {
  const pkg = released.packages.find(p => p.variant === name);
  const file = suffix => text(released.files.find(f => f.name.startsWith(pkg.name + "/") && f.name.endsWith(suffix)).data);
  const bom = JSON.parse(file("/release.json")).outputs.find(row => row.id === "bom");
  const mismatch = bom.warnings.filter(warning => /R1.*R_0805.*R_0603/.test(warning));
  assert.equal(mismatch.length, name === "Lean" ? 1 : 0);
  if (name === "Lean") {
    assert.ok(bom.warnings.some(warning => /R4.*R_0805.*R_0603/.test(warning)));
    assert.ok(file("BOM.csv").includes('"R1, R4",2,,BASE-0805,' + larger.value + ",R_0603"));
    assert.equal(bom.status, "warning");
  }
}
assert.equal(JSON.stringify(project), original);
console.log("PASS fitted descriptions, physical footprint, DNP, PCB BOM job reuse and package mismatch warnings");
