"use strict";
// Design rule sets: starter sets from fab profiles, save/activate, JSON export and
// import with a schema check, set names in DRC reports and model validation.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "stackup", "altium-rules", "net-intent", "signals", "rules", "viastack", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "rule-sets", "connectivity", "drc"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, RS = AtriumRuleSets, R = AtriumRules;

// ---- starter sets ------------------------------------------------------------------------
const starters = RS.starters();
assert.deepEqual(starters.map(s => s.name), ["JLC 2-layer", "JLC 4-layer", "PCBWay standard"]);
for (const s of starters) {
  assert.equal(s.approximate, true, s.name + " is marked approximate");
  assert.match(s.description, /Approximate/);
  R.validate(s.rules);
  assert.ok(s.rules.list.some(r => r.type === "boardOutlineClearance"), s.name + " has a board outline clearance rule");
}
const jlc = starters[0];
assert.equal(jlc.rules.list.find(r => r.type === "clearance").gap, AtriumFabProfiles.get("jlcpcb-2l").space);
assert.equal(jlc.rules.list.find(r => r.type === "boardOutlineClearance").gap, AtriumFabProfiles.get("jlcpcb-2l").edgeClearance);

// ---- project store, activate, label --------------------------------------------------------
const project = AtriumParts.example(), doc = project.documents[1];
assert.equal(RS.label(project, doc), "");
assert.equal(RS.list(project).length, 3);
R.store(doc, project, {...R.migrate(R.create()), netClasses: {Power: ["VDD", "GND"]}});
RS.activate(project, doc, "JLC 2-layer");
assert.equal(RS.label(project, doc), "JLC 2-layer (approximate)");
assert.deepEqual(R.effective(doc, project).netClasses, {Power: ["GND", "VDD"]}, "net classes stay with the design (the signal model's, sorted)");
assert.equal(R.effective(doc, project).list.find(r => r.type === "clearance").gap, .1);
assert.ok(A.validate(JSON.parse(JSON.stringify(project))), "a project with an active set validates");
{ const set = JSON.parse(JSON.stringify(R.stored(doc, project))); set.list.find(r => r.type === "clearance").gap = .3; R.store(doc, project, set); }
assert.equal(RS.label(project, doc), "JLC 2-layer (modified)");
// Save the board rules as a user set; it shadows nothing and is listed first.
const mine = RS.save(project, RS.fromBoard(project, doc, "House rules", {description: "Our defaults"}));
assert.equal(mine.name, "House rules");
assert.deepEqual(RS.list(project).map(s => [s.name, s.builtin]), [["House rules", false], ["JLC 2-layer", true], ["JLC 4-layer", true], ["PCBWay standard", true]]);
RS.activate(project, doc, "house rules");
assert.equal(RS.label(project, doc), "House rules");
RS.validateStore(project.ruleSets);
assert.ok(A.validate(JSON.parse(JSON.stringify(project))));

// Already-saved library templates can still contain old opaque IDs. Selecting
// such a set is read-only. Activating it creates a distinct native board rule.
{
  const legacy = AtriumParts.example(), target = legacy.documents[1];
  const width = R.create().list.find(r => r.type === "width");
  legacy.rules = {format: "atrium-rules", version: 3, units: "mm", list: [{...width, id: "board-width"}]};
  legacy.ruleSets = {version: 1, sets: [{name: "Legacy house rules", rules: R.normalize({
    list: [{...width, id: "house-width", min: .24}],
  })}]};
  const savedTemplate = A.clone(legacy.ruleSets.sets);
  assert.equal(RS.rulesFor(legacy, target, "Legacy house rules").list[0].id, "house-width");
  assert.equal(legacy.rules.list[0].id, "board-width");
  RS.activate(legacy, target, "Legacy house rules");
  const [installed] = legacy.rules.list;
  assert.ok(AtriumUUID.isV7(installed.id));
  assert.equal(installed.min, .24);
  assert.deepEqual(legacy.ruleSets.sets, savedTemplate);
  RS.activate(legacy, target, "Legacy house rules");
  assert.deepEqual(legacy.rules.list, [installed], "reactivating the legacy template keeps the new rule ID");
}

// ---- DRC report names the set -----------------------------------------------------------------
const result = AtriumDRC.run(doc, new Map(project.library.map(d => [d.id, d])), R.stored(doc, project));
const html = AtriumDRC.report(result, {board: doc.name, project: project.name, rules: R.effective(doc, project), ruleSet: RS.label(project, doc), date: new Date(0)});
assert.match(html, /rule set House rules/);
assert.doesNotMatch(AtriumDRC.report(result, {board: doc.name, date: new Date(0)}), /rule set/);

// ---- export and import ---------------------------------------------------------------------------
const text = RS.exportText(RS.get(project, "House rules"));
const parsed = JSON.parse(text);
assert.equal(parsed.format, "atrium-rule-set"); assert.equal(parsed.version, 1); assert.equal(parsed.name, "House rules");
assert.equal(parsed.builtin, undefined, "exports carry no runtime flags");
const back = RS.importText(text);
assert.equal(back.length, 1); assert.equal(back[0].name, "House rules");
assert.deepEqual(back[0].rules, RS.get(project, "House rules").rules, "round trip");
const many = RS.importText(RS.exportText(RS.starters().map(({builtin, ...s}) => s)));
assert.deepEqual(many.map(s => s.name), ["JLC 2-layer", "JLC 4-layer", "PCBWay standard"]);
assert.ok(many.every(s => s.approximate));
// A plain rules file becomes a set named after the file.
assert.equal(RS.importText(JSON.stringify(R.create()), "/x/Board A.waffle-rules.json")[0].name, "Board A");
// Schema check: unknown keys, bad rules, code-like content and prototype keys are refused.
const bad = [
  JSON.stringify({...parsed, script: "alert(1)"}),
  JSON.stringify({...parsed, rules: {...parsed.rules, list: [{...parsed.rules.list[0], onLoad: "x"}]}}),
  JSON.stringify({...parsed, rules: {...parsed.rules, list: [{...parsed.rules.list[0], gap: "1 mm"}]}}),
  JSON.stringify({...parsed, version: 2}),
  JSON.stringify({...parsed, name: ""}),
  '{"format":"atrium-rule-set","version":1,"name":"x","__proto__":{"polluted":true},"rules":' + JSON.stringify(parsed.rules) + "}",
  "function(){return 1}",
  "[".repeat(40) + "]".repeat(40),
  JSON.stringify({format: "other"})];
for (const t of bad) assert.throws(() => RS.importText(t), Error, t.slice(0, 60));
assert.equal({}.polluted, undefined);
assert.throws(() => RS.validateStore({version: 1, sets: [{name: "a", rules: R.create()}, {name: "A", rules: R.create()}]}), /unique/);

// ---- remove ------------------------------------------------------------------------------------------
assert.equal(RS.remove(project, "House rules"), true);
assert.equal(RS.active(project, doc), null, "removing the active set clears it");
assert.equal(project.ruleSets?.sets?.length ?? 0, 0);
assert.throws(() => RS.activate(project, doc, "Nope"), /No rule set/);
console.log("rule sets: starters, activate, export/import, schema and report OK");
