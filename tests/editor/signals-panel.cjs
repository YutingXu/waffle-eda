"use strict";
// Signals panel (app/editor/signals-panel.js): the headless view model (signals with legs, nets and crossed parts,
// tags, suggestions, issues; filtering) and the actions behind the toolbar, each one store edit: declare,
// make differential, flip, tag, rename, split at a part, merge, remove, accept / decline a suggestion and
// detach a schematic directive.
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "net-intent", "altium-rules", "query", "signals", "rules", "signals-panel"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const S = AtriumSignals, P = AtriumSignalsPanel, R = AtriumRules;
const part = (ref, pinNets) => ({id: "p-" + ref, kind: "part", ref, def: "d", value: "", x: 0, y: 0, pinNets});
const ic = (ref, nets) => part(ref, Object.fromEntries(nets.map((n, i) => [String(i + 1), n])));
const b = {id: "b1", kind: "pcb", name: "Board", grid: 1, outline: [], notes: [], items: [
  ic("U1", ["TX_P", "TX_N", "USB_DP", "USB_DM", "CLK", "GND", "a", "b"]), part("C1", {1: "TX_P", 2: "TX_P_C"}), part("C2", {1: "TX_N", 2: "TX_N_C"}), ic("J1", ["TX_P_C", "TX_N_C", "USB_DP", "USB_DM", "GND"])]};
const p = S.attach({format: "atrium", version: 1, name: "P", library: [], documents: [b]});
const kinds = list => list.map(r => r.type + ":" + (r.name || r.text));

// Suggestions from net names; accept declares a pair; decline remembers.
let rows = P.rows(p, b, {filter: "suggestions"});
assert.deepEqual(rows.map(r => r.name).sort(), ["TX", "TX_C", "USB"]);
P.actions.accept(p, b, {suggestion: rows.find(r => r.name === "TX")});
P.actions.decline(p, b, {suggestion: P.rows(p, b, {filter: "suggestions"}).find(r => r.name === "USB")});
assert.deepEqual(P.rows(p, b, {filter: "suggestions"}), [], "accepted and declined suggestions are gone, and TX_C is in the accepted span");
assert.ok(Object.keys(p.signals.declined).length === 1);
// The declared pair spans the AC-coupling caps: two stages, and the row shows the crossed parts.
const tx = P.rows(p, b, {filter: "diff"})[0];
assert.equal(tx.name, "TX");
assert.deepEqual(tx.legs.map(l => [l.polarity, l.nets.join(), l.parts.join()]), [[1, "TX_P,TX_P_C", "C1"], [-1, "TX_N,TX_N_C", "C2"]]);
assert.deepEqual(R.diffPairs(b, {project: p}).map(x => x.name), ["TX", "TX.1"]);
// Tag, rename, flip, split.
P.actions.tag(p, b, {id: tx.id, tag: "PCIe"});
P.actions.rename(p, b, {id: tx.id, name: "PCIE_TX0"});
P.actions.flip(p, b, {id: tx.id});
assert.equal(R.diffPairs(b, {project: p})[0].positive, "TX_N");
assert.deepEqual(R.netClasses(b, {project: p}).PCIe, ["TX_N", "TX_N_C", "TX_P", "TX_P_C"]);
P.actions.split(p, b, {id: tx.id, part: "C1"});
assert.ok(P.rows(p, b, {filter: "issues"}).some(r => r.kind === "stage"), "splitting one leg leaves an unpaired stage");
P.actions.split(p, b, {id: tx.id, part: "C1", cross: true});
assert.deepEqual(R.diffPairs(b, {project: p}).map(x => x.name), ["PCIE_TX0", "PCIE_TX0.1"]);
// New single-ended signals, make differential from two, merge two, remove.
P.actions.newSignal(p, b, {nets: ["USB_DP"]});
P.actions.newSignal(p, b, {nets: ["USB_DM"]});
const [dp, dm] = ["USB_DP", "USB_DM"].map(n => P.rows(p, b, {filter: "single"}).find(r => r.name === n));
P.actions.makeDiff(p, b, {ids: [dp.id, dm.id], name: "USB"});
assert.deepEqual(R.diffPairs(b, {project: p}).find(x => x.name === "USB"), {name: "USB", positive: "USB_DP", negative: "USB_DM", signal: "USB", classes: []});
assert.throws(() => P.actions.rename(p, b, {id: dp.id, name: "PCIE_TX0"}), /already named/);
P.actions.remove(p, b, {id: dp.id});
assert.ok(!P.rows(p, b, {}).some(r => r.type === "signal" && r.name === "USB"));
// Tags list and filtering.
rows = P.rows(p, b, {filter: "tags"});
assert.deepEqual(rows.map(r => [r.name, r.nets.length]), [["PCIe", 4]]);
assert.deepEqual(kinds(P.rows(p, b, {query: "tx_p_c"})).filter(k => k.startsWith("signal")), ["signal:PCIE_TX0"]);
// Every action was one store edit; the board's rules (the project rule book's view) still validate.
R.validate(R.effective(b, p));
assert.equal(S.effective(p), p.signals);
{
  // Detach a schematic directive: the signal becomes stored and the directive fields go.
  const q = AtriumParts.example(), sch = q.documents.find(d => d.kind === "schematic"), pcb = q.documents.find(d => d.kind === "pcb");
  const label = sch.items.find(i => i.kind === "netlabel" && i.text === "BUF");
  label.signal = "OUT"; label.tags = ["Analog"];
  const row = P.rows(q, pcb, {filter: "single"}).find(r => r.name === "OUT");
  assert.ok(row.derived);
  P.actions.detach(q, pcb, {id: row.id});
  assert.equal(label.signal, undefined);
  const stored = q.signals.signals.find(s => s.name === "OUT");
  assert.deepEqual(stored.tags, ["Analog"]);
  assert.ok(!P.rows(q, pcb, {filter: "single"}).find(r => r.name === "OUT").derived);
}
// DOM smoke test (Node with LinkeDOM; skipped elsewhere): the panel opens, lists the signals and its Flip
// button is one host edit.
(async () => {
  let parseHTML;
  try { ({parseHTML} = require("linkedom")); } catch { console.log("SKIP signals panel DOM: linkedom is not installed"); return; }
  const {document, window} = parseHTML('<html><body><aside id="properties"></aside></body></html>');
  globalThis.document = document; globalThis.window = window;
  require("../../app/editor/nav-common.js");
  require("../../app/ui/dialog.js");
  let edits = 0, info = "";
  const host = {project: () => p, doc: () => b, defs: () => new Map(), edit: fn => { edits++; fn(); }, info: m => { info = m; }, selection: () => [], setHighlight() {}, zoomTo() {},
    registerAction() {}, on() {}, canvas: () => null};
  P.toggle(host, true);
  const names = [...document.querySelectorAll(".sig-signal .sig-name")].map(n => n.textContent);
  assert.ok(names.includes("PCIE_TX0"), names.join());
  [...document.querySelectorAll(".sig-signal")].find(n => n.querySelector(".sig-name").textContent === "PCIE_TX0").onclick({});
  [...document.querySelectorAll(".sig-actions button")].find(x => x.textContent === "Flip").onclick();
  assert.equal(edits, 1); assert.match(info, /Polarity of PCIE_TX0 flipped/);
  assert.equal(R.diffPairs(b, {project: p})[0].positive, "TX_P");
  console.log("signals-panel ok");
})().catch(e => { console.error(e); process.exitCode = 1; });
