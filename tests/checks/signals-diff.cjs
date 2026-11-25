"use strict";
// Design diff of signals and tags (app/history/diff.js signalsDiff): the models
// are compared, not the stores, so adopting an unconfigured board diffs as empty; declaration changes (added,
// removed, polarity flipped, tags, exclusions), a span that moved with the netlist, the tag registry
// and net-level tags are reported; merge3 merges two branches' keyed signal edits.
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "altium-rules", "pcb-draw", "component-classes", "rules", "signals", "diff", "merge3"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, S = AtriumSignals, D = AtriumDiff;
const clone = v => JSON.parse(JSON.stringify(v));
const kinds = r => r.changes.map(c => c.kind);
const sig = r => r.changes.filter(c => /^(signal|tag|netTag|netClass|diffPair|rules)\b/.test(c.kind));
const {nativeCAD} = require("../support/native-cad.cjs");
const load = name => A.validate(nativeCAD(name));

{
  // Adoption is not a change: an unconfigured board against the same board after its first signals edit.
  for (const name of ["sample-sensor", "eco-benchmark"]) {
    const before = load(name), after = clone(before);
    S.edit(after, () => {});
    assert.ok(after.signals, name + " adopted");
    const r = D.compare(before, after);
    assert.deepEqual(sig(r).map(c => c.text), [], name + ": adoption diffs as empty");
  }
}
{
  const before = load("signal-board"), b0 = before.documents.find(d => d.kind === "pcb");
  const flip = clone(before);
  S.edit(flip, st => { const s = st.signals.find(x => x.name === "LINK"); s.legs.forEach(l => l.polarity = -l.polarity); s.tags.push("PCIe"); s.exclude = [b0.items.find(i => i.ref === "C3").id]; });
  const r = D.compare(before, flip);
  const ch = r.changes.find(c => c.kind === "signal.changed");
  assert.ok(ch, kinds(r).join());
  assert.match(ch.text, /Signal LINK \(.*\): polarity flipped; tags \+PCIe; no longer crosses C3/);
  assert.ok(!r.changes.some(c => c.kind.startsWith("netClass") || c.kind.startsWith("diffPair")), "no duplicate legacy-key rows");
  // Added and removed, the tag registry and net-level tags.
  const more = clone(before);
  S.edit(more, st => { st.signals = st.signals.filter(s => s.name !== "OUT"); st.signals.push({id: "s-new", name: "DQ", kind: "single", legs: [{nets: ["FILTER"]}]}); st.tags.push({name: "New"}); st.nets.GND = {tags: ["New"]}; });
  const r2 = D.compare(before, more);
  for (const k of ["signal.added", "signal.removed", "tag.added", "netTag.changed"]) assert.ok(kinds(r2).includes(k), k + " in " + kinds(r2).join());
  assert.match(r2.changes.find(c => c.kind === "netTag.changed").text, /Net GND .* tags \+New/);
  // A span that moves with the netlist (a series part added), the declarations unchanged.
  const grown = clone(before), b = grown.documents.find(d => d.kind === "pcb"), c3 = b.items.find(i => i.ref === "C3");
  b.items.push({...clone(c3), id: "sig-R9", ref: "R9", pinNets: {1: "TX_P_C", 2: "TX_P_J"}}, {...clone(c3), id: "sig-R10", ref: "R10", pinNets: {1: "TX_N_C", 2: "TX_N_J"}});
  const r3 = D.compare(before, grown), span = r3.changes.find(c => c.kind === "signal.span");
  assert.ok(span && span.derived, kinds(r3).join());
  assert.match(span.text, /Signal LINK .* now also spans TX_N_J, TX_P_J \(R9, R10\)/);
}
{
  // Three-way merge: two branches edit different signals; both edits survive.
  const base = load("signal-board");
  const left = clone(base), right = clone(base);
  S.edit(left, st => { st.signals.find(s => s.name === "LINK").tags.push("Left"); });
  S.edit(right, st => { st.signals.find(s => s.name === "OUT").tags.push("Right"); });
  const m = AtriumMerge3.merge(base, left, right), st = m.project.signals;
  assert.ok(st.signals.find(s => s.name === "LINK").tags.includes("Left"));
  assert.ok(st.signals.find(s => s.name === "OUT").tags.includes("Right"));
  assert.ok(!m.conflicts.some(c => /signals\b.*signals\[/.test(JSON.stringify(c.path || ""))), "no conflict on the signal records");
  // The merged mirrors are whatever the merge made; the model reads the merged store either way.
  const mb = m.project.documents.find(d => d.kind === "pcb");
  assert.ok(S.model(m.project, mb).signals.find(s => s.name === "LINK").tags.includes("Left"));
}
console.log("signals-diff ok");
