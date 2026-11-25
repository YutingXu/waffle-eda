"use strict";
// One set of JLCPCB numbers (consolidation audit §7): the sourced fab presets (app/fab-presets/jlcpcb.json)
// are canonical, and fab-profiles.js, the project templates and the rule-set starters read them. Before the
// fix fab-profiles.js kept its own jlcpcb-2l (via 0.3/0.5, ring 0.1, min hole 0.2, hole-to-hole 0.45,
// preferred width 0.2) while jlcpcb.json says 0.15/0.25, 0.05, 0.15, 0.2 and 0.25, so File › New gave a
// "2-layer JLC" template and a "JLCPCB 2-layer" preset board different rules. Old boards stamped with the
// retired profile id jlcpcb-4-6l keep resolving (no file-format change).
const assert = require("node:assert/strict");
for (const m of ["model", "connectivity", "parts", "impedance", "stackup", "viastack", "polygon-pour", "query", "altium-rules", "rules", "rule-groups", "rigid-flex",
  "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "rule-sets", "templates", "fab-presets-start"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const F = AtriumFabProfiles, FP = AtriumFabPresets, T = AtriumTemplates, RS = AtriumRuleSets, R = AtriumRules, A = Atrium;
const COVERED = new Set(FP.ruleRecords(FP.get("jlcpcb-2l")).map(r => r.type));
// The board's fab rules without ids that only differ by origin: what DRC checks.
const fabRules = rules => R.normalize(rules).list.filter(r => COVERED.has(r.type) && /^fp-/.test(R.presetRuleKey(r)))
  .map(({type, name, scope, scope2, priority, comment, enabled, id, presetKey, ...v}) => ({type, scope, ...v}));

const run = async () => {
  // A ruleless project uses a deterministic view even on its first inspection.
  const previewProject = A.project("Preview", []), previewBoard = previewProject.documents[1];
  const preview = () => ({
    fab: FP.plan(previewProject, previewBoard, "jlcpcb-4l"),
    profile: F.compare(previewBoard, "oshpark-2l", {project: previewProject}).rows,
    set: RS.rulesFor(previewProject, previewBoard, "JLC 2-layer"),
  });
  const sentinel = "a".repeat(64);
  A.withRevisionIds(sentinel, () => {
    assert.deepEqual(preview(), preview());
    assert.equal(A.id(), "history-" + sentinel + "-1", "previews must not ask for a new model ID");
  });
  assert.equal(previewProject.rules, undefined);
  assert.equal(previewProject.ruleSets, undefined);

  // ---- The profile is the preset: same limits.
  for (const [profile, preset] of [["jlcpcb-2l", "jlcpcb-2l"], ["jlcpcb-4l", "jlcpcb-4l"], ["jlcpcb-6l", "jlcpcb-6l"]]) {
    const p = F.get(profile), L = FP.limits(preset);
    for (const [k, l] of [["track", "track"], ["space", "space"], ["viaDrill", "viaDrill"], ["viaDiameter", "viaDiameter"], ["annularRing", "viaRing"], ["pthRing", "pthRing"],
      ["minHole", "minHole"], ["maxHole", "maxHole"], ["holeToHole", "holeToHoleVia"], ["maskExpansion", "maskExpansion"], ["maskWeb", "maskWeb"], ["silkWidth", "silkWidth"],
      ["silkHeight", "silkHeight"], ["silkToPad", "silkToPad"], ["edgeClearance", "edgeClearance"]]) assert.equal(p[k], L[l], profile + " " + k + " = preset " + l);
    // Source metadata travels with the profile.
    assert.equal(p.preset.dataVersion, "2026.11.19"); assert.equal(p.preset.retrieved, "2026-11-19");
    assert.equal(p.sources.cap.url, "https://jlcpcb.com/capabilities/pcb-capabilities");
    assert.equal(FP.sourceOf(FP.get(preset), FP.get(preset).limits.viaDrill).quote, "Min via hole/diameter: 0.15/0.25mm (standard); 0.1/0.2 mm extra cost.");
  }
  assert.deepEqual([F.get("jlcpcb-2l").viaDrill, F.get("jlcpcb-2l").viaDiameter, F.get("jlcpcb-2l").annularRing, F.get("jlcpcb-2l").minHole, F.get("jlcpcb-2l").holeToHole], [.15, .25, .05, .15, .2]);

  // ---- The two new-project paths: the template and the preset start board get the same rules.
  const tpl = await T.build("2l-100x80-jlc", {name: "t"}), pre = await T.build("jlcpcb-2l", {name: "p"});
  const a = tpl.documents.find(d => d.kind === "pcb"), b = pre.documents.find(d => d.kind === "pcb");
  assert.deepEqual(fabRules(R.stored(a, tpl)), fabRules(R.stored(b, pre)), "2-layer template = JLCPCB 2-layer preset board");
  assert.equal(fabRules(R.stored(a, tpl)).find(r => r.type === "width").preferred, .25);
  const t4 = await T.build("4l-impedance", {name: "t4"}), p4 = await T.build("jlcpcb-4l", {name: "p4"});
  assert.deepEqual(fabRules(R.stored(t4.documents[1], t4)), fabRules(R.stored(p4.documents.find(d => d.kind === "pcb"), p4)), "4-layer template = JLCPCB 4-layer preset board");
  assert.equal(t4.documents[1].fabProfile.id, "jlcpcb-4l");

  // ---- Rule-set starters: the JLC sets are the preset rules.
  const starters = RS.starters();
  const jlc2 = starters.find(s => s.name === "JLC 2-layer"), jlc4 = starters.find(s => s.name === "JLC 4-layer");
  assert.deepEqual(fabRules(jlc2.rules), fabRules(R.stored(b, pre)), "JLC 2-layer starter = preset");
  assert.deepEqual(fabRules(jlc4.rules), fabRules(R.stored(p4.documents.find(d => d.kind === "pcb"), p4)), "JLC 4-layer starter = preset");
  assert.equal(jlc2.rules.list.filter(r => r.type === "boardOutlineClearance").length, 1, "one outline clearance rule");

  // ---- Compat: a board saved with the retired profile id (and the old limits) still works, untouched.
  const old = A.project("Old", []), pcb = old.documents.find(d => d.kind === "pcb");
  pcb.outline = [[0, 0], [50, 0], [50, 40], [0, 40]];
  pcb.fabProfile = {id: "jlcpcb-4-6l", name: "JLCPCB Standard 4–6 layer", approximate: true, maxAspect: 10, microviaAspect: 1, viaDrill: .2, microviaDrill: null,
    annularRing: .1, edgeClearance: .2, blind: false, buried: false, microvia: false, viaInPad: true, backdrill: true};
  const saved = JSON.stringify(old), loaded = A.validate(JSON.parse(saved)), board = loaded.documents.find(d => d.kind === "pcb");
  assert.equal(JSON.stringify(loaded), saved, "the file loads unchanged");
  assert.equal(F.get(board.fabProfile.id).id, "jlcpcb-4l", "the old id resolves to the preset profile");
  assert.equal(F.outputLayout(board.fabProfile.id).vendor, "JLCPCB");
  assert.ok(F.compare(board, board.fabProfile.id).rows.length > 0, "compare runs against the old id");
  assert.equal(F.panelRules(board.fabProfile.id).vendor, "JLCPCB");
  FP.apply(loaded, board, "jlcpcb-4l", {stackup: false});
  assert.equal(board.fabProfile.id, "jlcpcb-4-6l", "applying a preset keeps the recorded old profile (it still resolves)");
  console.log("PASS one set of JLCPCB numbers: fab profiles = fab presets = templates = rule-set starters; old profile ids resolve");
};
globalThis.__testDone = run();
