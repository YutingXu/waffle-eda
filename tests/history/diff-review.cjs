"use strict";
// Adversarial review of the design-diff engine (app/history/diff.js). Each check states the behaviour the
// engine should have. Runs under Node and the JSC shim:
//   scripts/test-jsc.sh diff-review      node tests/history/diff-review.cjs
// All checks run; failures are listed together at the end.
const assert = require("node:assert/strict");
const {nativeCAD} = require("../support/native-cad.cjs");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "altium-rules", "pcb-draw", "component-classes", "rules",
  "messages", "erc", "eco", "bom", "annotate", "multichannel", "rooms", "diff"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const D = AtriumDiff;
const clone = v => JSON.parse(JSON.stringify(v));
const base = () => nativeCAD("design-diff");
const sch = p => p.documents[0], pcb = p => p.documents[1];
const item = (d, id) => d.items.find(i => i.id === id);
const texts = r => r.changes.map(c => c.severity[0] + " " + c.kind + ": " + c.text).join("\n    ");
const setNet = (p, from, to, refs) => { for (const d of p.documents) for (const i of d.items) if (i.kind === "part" && (!refs || refs.includes(i.ref))) for (const k in i.pinNets) if (i.pinNets[k] === from) i.pinNets[k] = to; };
const PIN_NETS = {schematicNets: "pinNets"};

const failures = [];
function check(name, fn) {
  try { fn(); console.log("ok    " + name); }
  catch (e) { failures.push(name); console.log("FAIL  " + name + "\n    " + String(e && e.message || e).split("\n").slice(0, 14).join("\n    ")); }
}

// ------------------------------------------------------------------ severity: board copper attachment
// Board connectivity comes only from part pinNets; copper touching pads is never checked, so
// edits that open or short nets on the board read as harmless mechanical moves.
check("R1 pcb-rotate-polarised-part-180", () => {
  const a = base(), b = clone(a);
  item(pcb(b), "b-J2").angle = 180; // pad 1 (VOUT) now sits on the GND track end and pad 2 (GND) on VOUT's
  const r = D.compare(a, b);
  assert.ok(r.changes.some(c => c.severity === "electrical"), "only mechanical:\n    " + texts(r));
});
check("R2 pcb-track-pulled-off-pad", () => {
  const a = base(), b = clone(a);
  const t = item(pcb(b), "amwmqqymdr2v9hhc58sf"); // VOUT: R2.2 -> J2.1
  t.points = t.points.map(p => [p[0], p[1] + 1.5]); // both ends leave their pads: VOUT is open
  const r = D.compare(a, b);
  assert.ok(r.changes.some(c => c.severity === "electrical"), "only mechanical:\n    " + texts(r));
});

// ------------------------------------------------------------------ connectivity: merge / split classification
const selfMoves = r => r.changes.filter(c => /^pin\./.test(c.kind) && c.before != null && c.before === c.after);
check("R3 merge-into-smaller-named-net", () => {
  // FILTER (3 pins) joins VIN (2 pins) and the result keeps the name VIN.
  const a = base(), b = clone(a);
  setNet(b, "FILTER", "VIN");
  for (const i of sch(b).items) if (i.kind === "netlabel" && i.text === "FILTER") i.text = "VIN";
  const r = D.compare(a, b);
  assert.equal(selfMoves(r).length, 0, "pins reported as moving from a net to itself:\n    " + texts(r));
  assert.ok(r.changes.some(c => c.kind === "net.merged" && c.after === "VIN" && c.before.includes("FILTER")), "no merge:\n    " + texts(r));
  assert.ok(!r.changes.some(c => c.kind === "net.renamed" && c.before === "FILTER"), "a merge reported as a rename");
  assert.ok(!r.changes.some(c => c.kind === "routing.changed" && c.target.net === "VIN"), "VIN copper did not change:\n    " + texts(r));
});
check("R4 split-name-stays-on-smaller-piece", () => {
  // GND splits: most pins move to AGND, J2.2 and C2.2 stay on GND.
  const a = base(), b = clone(a);
  setNet(b, "GND", "AGND", ["J1", "C1", "U1"]);
  const r = D.compare(a, b, PIN_NETS);
  assert.equal(selfMoves(r).length, 0, "pins reported as moving from a net to itself:\n    " + texts(r));
  assert.ok(r.changes.some(c => c.kind === "net.split" && c.before === "GND"), "no split:\n    " + texts(r));
});
check("R5 merge-not-also-a-rename", () => {
  const a = base(), b = clone(a);
  setNet(b, "VIN", "SIG"); setNet(b, "VOUT", "SIG");
  const r = D.compare(a, b, PIN_NETS);
  const sch = r.changes.filter(c => c.target.domain === "schematic" && /^net\./.test(c.kind));
  assert.deepEqual(sch.map(c => c.kind), ["net.merged"], "one event, two sentences:\n    " + texts(r));
});

// ------------------------------------------------------------------ determinism
check("R6 same-design-reordered-gives-same-report", () => {
  const a = base(), b = clone(a);
  setNet(b, "VIN", "SIG"); setNet(b, "VOUT", "SIG");
  const c = clone(b); for (const d of c.documents) d.items.reverse();
  const x = D.compare(a, b, PIN_NETS), y = D.compare(a, c, PIN_NETS);
  assert.deepEqual(y.changes.map(z => z.kind + ": " + z.text), x.changes.map(z => z.kind + ": " + z.text));
});

// ------------------------------------------------------------------ rules and classes stored as objects
check("R7 net-class-membership-change", () => {
  const a = base(); a.rules = AtriumRules.defaults(); a.rules.netClasses = {Power: ["VDD"]};
  const b = clone(a); b.rules.netClasses = {Power: ["VDD", "VIN", "GND"]};
  const r = D.compare(a, b, {validate: false});
  assert.ok(r.changes.some(c => c.category === "rules" && c.severity === "electrical"), "net class change not reported (" + r.summary.total + " changes)");
});
check("R8 diff-pair-class-membership-change", () => {
  const a = base(); a.rules = AtriumRules.defaults(); a.rules.diffPairs = [{name: "P", positive: "VIN", negative: "VOUT"}]; a.rules.diffPairClasses = {Fast: []};
  const b = clone(a); b.rules.diffPairClasses = {Fast: ["P"]};
  const r = D.compare(a, b, {validate: false});
  assert.ok(r.changes.length > 0, "diff pair class change not reported");
});
check("R9 component-class-membership-change", () => {
  const a = base(); pcb(a).componentClasses = {Analog: ["U1"]};
  const b = clone(a); pcb(b).componentClasses = {Analog: ["U1", "R1", "R2"]};
  const r = D.compare(a, b, {validate: false});
  assert.ok(r.changes.length > 0, "component class change not reported");
});

// ------------------------------------------------------------------ severity: BOM parameters
check("R10 bom-parameters-are-electrical", () => {
  const a = base(), b = clone(a);
  item(sch(b), "s-C2").parameters = {Comment: "1uF", Dielectric: "Y5V", LCSC: "C12345", Mfr: "Murata", DNP: "yes"};
  const r = D.compare(a, b);
  const cosmetic = r.changes.filter(c => c.kind === "part.parameter" && c.severity === "cosmetic").map(c => c.target.field);
  assert.deepEqual(cosmetic, [], "BOM fields classed cosmetic");
});
check("R11 designator-swap-changes-bom", () => {
  // Stable ids, R1 (10 kΩ) and R2 (100 Ω) exchange designators on both sides: the BOM line for R1
  // is now 100 Ω, and designator-keyed component classes / rooms move to the other part.
  const a = base(), b = clone(a);
  item(pcb(b), "b-R1").ref = "R2"; item(pcb(b), "b-R2").ref = "R1"; item(sch(b), "s-R2").ref = "R1"; item(sch(b), "s-R1").ref = "R2";
  const r = D.compare(a, b);
  assert.ok(r.changes.some(c => c.severity !== "cosmetic"), "only cosmetic re-annotation:\n    " + texts(r));
});

// ------------------------------------------------------------------ pin keys: part ids with "/"
const slashIds = () => { const a = base(); for (const d of a.documents) for (const i of d.items) if (i.kind === "part") i.id = d.kind + "/" + i.ref.replace("?", "1"); return a; };
check("R12 part-id-with-slash-disconnect", () => {
  const a = slashIds(), b = clone(a);
  delete item(pcb(b), "pcb/R2").pinNets["2"]; delete item(sch(b), "schematic/R2").pinNets["2"];
  const r = D.compare(a, b, PIN_NETS);
  assert.ok(r.changes.some(c => c.kind === "pin.disconnected"), "R2.2 lost VOUT and nothing was reported (" + r.summary.total + " changes)");
});
check("R13 part-id-with-slash-no-cross-part-swap", () => {
  const a = slashIds(), b = clone(a);
  item(pcb(b), "pcb/R2").pinNets["2"] = "GND"; item(pcb(b), "pcb/C2").pinNets["2"] = "VOUT";
  const r = D.compare(a, b, PIN_NETS);
  assert.ok(!r.changes.some(c => c.kind === "pin.swapped"), "two parts' pins reported as one part's pin swap:\n    " + texts(r));
});

// ------------------------------------------------------------------ multichannel naming
check("R14 multichannel-index-naming-keeps-every-channel", () => {
  const four = naming => { const p = AtriumParts.example(), child = p.documents[0], top = Atrium.sheet("schematic", "Top"); p.documents.unshift(top);
    top.items.push(AtriumSchObjects.make("sheetsymbol", [40, 0], {name: "Repeat(CH,1,4)", sheet: child.id})); if (naming) p.multichannel = {naming}; return p; };
  const count = naming => { const a = four(naming), b = clone(a); b.documents[1].items.find(i => i.kind === "part" && i.ref === "R2").x += 50.8;
    return D.compare(a, b).changes.filter(c => c.category === "connectivity").length; };
  assert.equal(count(null), 8, "suffix naming: R2 disconnects in 4 channels × 2 pins");
  assert.equal(count("index"), 8, "index naming (R102, R202, …) loses channels");
});

// ------------------------------------------------------------------ matching
check("R15 pour-reimport-other-start-vertex", () => {
  const a = base(), b = clone(a);
  const g = item(pcb(b), "gndpour"); g.id = "reimported-pour"; g.points = g.points.slice(1).concat([g.points[0]]);
  const r = D.compare(a, b);
  assert.ok(r.summary.identical, "same pour, new id and start vertex:\n    " + texts(r));
});
check("R16 collinear-track-split-is-noise", () => {
  const a = base(), b = clone(a);
  const t = item(pcb(b), "amwmqqymdz6qwm82446"); // VIN [[3.8, 11], [9.1, 11]]
  t.points = [[3.8, 11], [6, 11]]; pcb(b).items.push({...t, id: "vin-b", points: [[6, 11], [9.1, 11]]});
  const r = D.compare(a, b);
  assert.ok(r.summary.identical, "same copper, broken at a collinear point:\n    " + texts(r));
});

// ------------------------------------------------------------------ session cache
check("R19 session-cached-netlist-after-replace", () => {
  // Review Changes keeps a session against HEAD. The user replaces R2 with a fresh R2 (new id,
  // matched by designator) and drags it off its wires. The cached baseline netlist is keyed by
  // the previous comparison's ids; the cache check only compares the number of matched objects.
  const a = base(), b1 = clone(a), b2 = clone(a);
  const r2 = item(sch(b2), "s-R2"); r2.id = "s-R2-new"; r2.x += 2.54;
  const conn = r => r.changes.filter(c => c.category === "connectivity").map(c => c.text);
  const fresh = conn(D.compare(a, b2));
  assert.ok(fresh.length > 0, "precondition: a fresh compare reports R2.1 disconnected");
  const s = D.session(a); s.compare(b1);
  assert.deepEqual(conn(s.compare(b2)), fresh, "the session hides the disconnection");
});

// ------------------------------------------------------------------ performance
require("../pcb/dense-board.js");
const board = (n, nets) => { const {d} = makeAtriumBenchmarkBoard(n); d.id = "pcb-perf"; const P = Atrium.project("Dense", AtriumParts.catalogue); P.documents = [d];
  let k = 0; if (nets) for (const i of d.items) if (i.kind === "part") i.pinNets = {"1": "N" + (k++), "2": "GND"}; return P; };
check("R17 added-board-is-linear", () => {
  // A file added or deleted (git difftool with /dev/null): every part is added and partNets()
  // scans the whole netlist for each one.
  const time = n => { const P = board(n, true), E = clone(P); E.documents[0].items = []; let best = Infinity;
    for (let k = 0; k < 2; k++) { const r = D.compare(E, P, {validate: false}); best = Math.min(best, r.stats.phases.objects); } return best; };
  const t1 = time(160), t2 = time(320); // 25.6k -> 102.4k objects
  assert.ok(t2 / t1 < 7, "objects phase " + t1 + " ms -> " + t2 + " ms for 4× the objects (" + (t2 / t1).toFixed(1) + "×)");
});
check("R18 geometry-stage-stacked-objects", () => {
  // Objects sharing one anchor (re-import with new ids and renamed nets) all land in one grid cell.
  const time = n => { const P = board(1, false); P.documents[0].items = [];
    for (let k = 0; k < n; k++) P.documents[0].items.push({id: "v" + k, kind: "via", x: 10, y: 10, diameter: .6, drill: .3, net: "N" + k, layer: "Multi"});
    const Q = clone(P); for (const i of Q.documents[0].items) { i.id = "w" + i.id; i.net = "M" + i.net; }
    return D.compare(P, Q, {validate: false}).stats.phases.match; };
  const t1 = time(2000), t2 = time(8000);
  assert.ok(t2 / t1 < 8, "match phase " + t1 + " ms -> " + t2 + " ms for 4× the objects (" + (t2 / t1).toFixed(1) + "×)");
});

if (failures.length) throw Error(failures.length + " diff review checks failed: " + failures.join(", "));
