"use strict";
// Schematic signal directives act on the board live (signals.js directives();
// unified-rules Q1 answered "live"): a directive is collected from the sheet whenever the model is built and
// never copied into the store; deleting it removes the intent; tags follow the signal across series parts;
// a stored signal of the same name wins (reported); Update PCB plans no class or pair rows; the change shows
// in a design diff; the rules see a directive's class live (no copy anywhere).
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "net-intent", "altium-rules", "pcb-draw", "component-classes", "signals", "rules", "pcb-appearance", "pcb-edit", "eco", "diff"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, S = AtriumSignals, R = AtriumRules, E = AtriumECO, D = AtriumDiff;
const clone = v => JSON.parse(JSON.stringify(v));
function sample() {
  const p = AtriumParts.example(), sch = p.documents.find(d => d.kind === "schematic"), pcb = p.documents.find(d => d.kind === "pcb");
  const label = name => sch.items.find(i => i.kind === "netlabel" && i.text === name);
  return {p, sch, pcb, label};
}
{
  const {p, pcb, label} = sample();
  assert.equal(S.scopeEnv(pcb, p), null, "no store and no directives: the legacy keys");
  // A tag on BUF follows its signal across R2 to VOUT (the sample's series resistor).
  label("BUF").tags = ["Analog"];
  assert.deepEqual(R.netClasses(pcb, {project: p}), {Analog: ["BUF", "VOUT"]});
  assert.ok(S.scopeEnv(pcb, p), "directives alone give the rule engine a signal model");
  // netClass is the older, exact form: only the labelled net.
  label("VDD").netClass = "Power";
  assert.deepEqual(R.netClasses(pcb, {project: p}).Power, ["VDD"]);
  // A named signal with explicit polarity: a differential pair with no naming convention.
  label("FILTER").signal = "PAIR"; label("FILTER").polarity = -1;
  label("VIN").signal = "PAIR";
  assert.deepEqual(R.diffPairs(pcb, {project: p}).map(x => [x.name, x.positive, x.negative]), [["PAIR", "VIN", "FILTER"]]);
  const M = S.model(p, pcb);
  assert.ok(M.signals.find(s => s.name === "PAIR").derived, "directive signals are marked derived");
  assert.equal(p.signals, undefined, "nothing was written");
  // Update PCB plans no class or pair rows; it reports nothing for nets the board has.
  const plan = E.plan(p, {board: pcb.id});
  assert.ok(!plan.changes.some(c => c.action === "netClass" || c.action === "diffPair"));
  // Deleting the directive removes the intent.
  delete label("BUF").tags;
  assert.equal(R.netClasses(pcb, {project: p}).Analog, undefined);
}
{
  // A stored signal of the same name wins and the double source is reported.
  const {p, pcb, label} = sample();
  S.edit(p, st => st.signals.push({id: "s-out", name: "OUT", kind: "single", legs: [{nets: ["BUF"]}], tags: ["Stored"]}));
  label("VOUT").signal = "OUT"; label("VOUT").tags = ["FromSheet"];
  const M = S.model(p, pcb);
  assert.deepEqual(M.signals.find(s => s.name === "OUT").tags, ["Stored"]);
  assert.ok(M.issues.some(i => i.kind === "double" && i.signal === "OUT"));
  assert.ok(!p.signals.signals.some(s => s.origin?.kind === "directive"), "never copied into the store");
  // A directive's net class is a class the rules see at once, with no edit of the store.
  label("FILTER").netClass = "Filter";
  assert.deepEqual(R.netClasses(pcb, {project: p}).Filter, ["FILTER"]);
  assert.deepEqual(R.effective(pcb, p).netClasses.Filter, ["FILTER"]);
}
{
  // Live in diffs: a directive added on the schematic is a signal change on the board.
  const {p} = sample(), q = clone(p), label = q.documents.find(d => d.kind === "schematic").items.find(i => i.kind === "netlabel" && i.text === "BUF");
  label.signal = "BUFSIG"; label.tags = ["Analog"];
  const r = D.compare(A.validate(clone(p)), A.validate(q));
  assert.ok(r.changes.some(c => c.kind === "signal.added" && /BUFSIG/.test(c.text)), r.changes.map(c => c.kind + " " + c.text).join("\n"));
}
{
  // Wires carry directives too; a pair directive on one net is reported, not applied.
  const {p, sch, pcb} = sample(), w = sch.items.find(i => i.kind === "wire");
  w.diffPair = "HALF";
  const M = S.model(p, pcb);
  assert.ok(M.issues.some(i => i.kind === "pair" && i.signal === "HALF"), JSON.stringify(M.issues));
  assert.ok([...E.plan(p, {board: pcb.id}).issues].some(t => /HALF needs two nets/.test(t)));
  // Validation: polarity is 1 or -1; tags a list of names.
  w.polarity = 2; assert.throws(() => A.validate(p)); w.polarity = 1; A.validate(p);
  w.tags = "HS"; assert.throws(() => A.validate(p)); w.tags = ["HS"]; A.validate(p);
}
console.log("signals-directives ok");
