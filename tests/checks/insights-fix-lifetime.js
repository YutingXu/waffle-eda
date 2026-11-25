"use strict";
// Keep the engine and its real findings alive while collecting old analysis generations.
// Run with node --expose-gc tests/insights-fix-lifetime.js.
const assert = require("node:assert/strict");
for (const file of ["model", "parts", "sch-objects", "hierarchy", "multichannel", "net-intent",
  "net-intent-index", "signals", "insights", "insights-sch", "insights-intent", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(file + ".js"));
require("../schematic/sch-bench-project.js");

const I = AtriumInsights, U = AtriumUndoStore, X = AtriumNetIntentIndex;
const engine = I.engine(), checks = ["netTypo", "nameSuggestion", "retainProbe"];
const {project} = makeAtriumSchBenchProject({sheets: 15, cells: 2, channels: 2});
const sheets = project.documents.filter(d => d.kind === "schematic").slice(1, 13);
const defs = new Map(project.library.map(d => [d.id, d]));
for (const [i, doc] of sheets.entries()) doc.items.push({kind: "netlabel", id: "miss-" + i, text: "GDN", x: i / 2, y: -35});

for (let n = 0; n < 4; n++) for (const [dy, suffix] of ["P", "N"].entries()) {
  const net = "LANE" + n + "_" + suffix;
  sheets[0].items.push({kind: "netlabel", id: net, text: net, x: -80 + n * 2, y: -50 + dy});
}

const contexts = [], netTables = [], intentTables = [];
I.register({id: "retainProbe", kind: "schematic", severity: "tip", scope: "doc", run(ctx) {
  contexts.push(new WeakRef(ctx));
  netTables.push(new WeakRef(ctx._prj.nets));
  intentTables.push(new WeakRef(X.facts(project, defs)));
  return [];
}});

function populate() {
  U.mark(project); U.prime();
  const item = sheets[0].items.find(i => i.id === "miss-0");
  for (const doc of sheets) {
    item.x += .1;
    U.record(project, {doc: sheets[0], items: [item]});
    const pass = engine.update(project, doc, defs, null, {checks, prefs: false});
    while (!pass.next().done) {}
  }
}
function exerciseActions() {
  const rows = sheets.flatMap(d => engine.list(d.id));
  const typo = rows.find(i => i.check === "netTypo");
  const suggestions = rows.filter(i => i.check === "nameSuggestion");
  const single = suggestions.find(i => !i.sig.startsWith("pairs:"));
  const group = suggestions.find(i => i.sig.startsWith("pairs:"));
  assert.ok(typo?.fix?.apply && single?.fix?.open && group?.fix?.open);
  const history = [], future = [], doc = sheets[0];
  const host = {project: () => project, edit(fn, label) {
    const before = U.mark(project);
    const result = fn();
    U.checkpoint(history, future, before, label); U.touch(project);
    return result;
  }};
  const go = n => { assert.ok(U.jump(history, future, U.mark(project), n)); U.touch(project); };
  const misses = () => sheets.map(d => d.items.find(i => i.id.startsWith("miss-")).text);
  const originalNames = misses(), originalSignals = JSON.stringify(project.signals);
  const oldName = doc.name;
  host.edit(() => { doc.name += " edited"; }, "Rename sheet");
  go(-1);
  assert.equal(doc.name, oldName);
  const changed = host.edit(() => typo.fix.apply(doc, project, defs), typo.fix.label);
  assert.ok(changed.includes("miss-0"));
  assert.deepEqual(misses(), sheets.map(() => "GND"));
  go(-1); assert.deepEqual(misses(), originalNames);
  go(1); assert.deepEqual(misses(), sheets.map(() => "GND"));
  single.fix.open(host);
  const declared = JSON.stringify(project.signals);
  assert.notEqual(declared, originalSignals);
  go(-1); assert.equal(JSON.stringify(project.signals), originalSignals);
  go(1); assert.equal(JSON.stringify(project.signals), declared);
  group.fix.open(host);
  assert.equal(project.signals.signals.filter(s => /^LANE[0-3]$/.test(s.name)).length, 4);
  const grouped = JSON.stringify(project.signals);
  go(-1); assert.equal(JSON.stringify(project.signals), declared);
  go(1); assert.equal(JSON.stringify(project.signals), grouped);
}

(async () => {
  assert.equal(typeof global.gc, "function", "run Node with --expose-gc");
  populate();
  for (let i = 0; i < 4; i++) { await new Promise(r => setImmediate(r)); global.gc(); }
  const held = refs => refs.filter(r => r.deref()).length;
  assert.equal(contexts.length, sheets.length);
  assert.equal(held(contexts), 0, "cached quick fixes retain discarded check contexts");
  assert.ok(held(netTables) <= 1, "discarded project net tables are still live");
  assert.ok(held(intentTables) <= 1, "discarded project intent tables are still live");
  exerciseActions();
  console.log(sheets.length + " generations collected down to the current tables. Cached rename, single and grouped declarations survive intervening edit, undo and redo");
})().catch(error => { console.error(error); process.exitCode = 1; });
