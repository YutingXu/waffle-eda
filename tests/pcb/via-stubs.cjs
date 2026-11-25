"use strict";
// Via stub / back-drill report and the Max Via Stub Length DRC rule.
const assert = require("node:assert/strict");
for (const m of ["model", "stackup", "altium-rules", "rules", "viastack", "via-stubs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const S = AtriumStackup, V = AtriumViaStack, VS = AtriumViaStubs, R = AtriumRules;
const close = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-4, (m || "") + " " + a + " differs from " + b);
const via = (id, x, extra = {}) => ({id, kind: "via", x, y: 10, diameter: .6, drill: .3, layer: "Multi", net: "SIG", ...extra});
const track = (id, layer, x) => ({id: id + "-" + layer, kind: "track", layer, net: "SIG", width: .2, points: [[x - 3, 10], [x, 10]]});
const board = items => ({kind: "pcb", name: "Stubs", id: "b", grid: 1, notes: [], outline: [[0, 0], [60, 0], [60, 30], [0, 30]], items,
  stackup: {version: 1, layers: S.preset("4").layers}});
const doc = board([
  via("v1", 10), track("v1", "Top", 10), track("v1", "Bottom", 10),           // through, used top and bottom: no stub
  via("v2", 20), track("v2", "Top", 20), track("v2", "Inner 1", 20),          // stub below Inner 1
  via("v3", 30, {backdrill: {from: "bottom", toLayer: "Inner 1", stubMax: .1}}), track("v3", "Top", 30), track("v3", "Inner 1", 30),
  via("v4", 40, {backdrill: {from: "bottom", toLayer: "Top", stubMax: .1}}), track("v4", "Top", 40), track("v4", "Inner 2", 40), // cuts a used layer
  via("v5", 50)                                                                 // no connection
]);
const P = V.physical(doc), z = k => P.copper.get(k), defs = new Map();
const rep = VS.report(doc, defs, {max: .25});
const row = id => rep.rows.find(r => r.id === id);
assert.equal(rep.rows.length, 5);
close(rep.total, P.total, "board thickness from the stack");
assert.deepEqual(row("v1").used, ["Top", "Bottom"]);
assert.equal(row("v1").stub, 0); assert.equal(row("v1").status, "ok");
assert.deepEqual(row("v2").used, ["Top", "Inner 1"]);
close(row("v2").stubBottom, z("Bottom").z + z("Bottom").t - (z("Inner 1").z + z("Inner 1").t), "stub below Inner 1");
assert.equal(row("v2").stubTop, 0);
assert.equal(row("v2").status, "over");
assert.deepEqual(row("v2").recommend, {from: "bottom", toLayer: "Inner 1"});
assert.equal(row("v3").status, "backdrilled");
close(row("v3").residual, .1, "a back-drill leaves its stub limit");
assert.equal(row("v4").status, "severed", "a back-drill through a used layer is flagged");
assert.equal(row("v5").status, "unused");
assert.deepEqual(rep.counts, {vias: 5, stubs: 4, over: 1, backdrilled: 2, unused: 1, severed: 1});
// A larger limit accepts the stub.
assert.equal(VS.report(doc, defs, {max: 5}).rows.find(r => r.id === "v2").status, "ok");
// Back-drilling the recommendation clears the flag.
const fixed = JSON.parse(JSON.stringify(doc));
VS.setBackdrill(fixed.items.find(i => i.id === "v2"), row("v2").recommend);
assert.equal(VS.report(fixed, defs, {max: .25}).rows.find(r => r.id === "v2").status, "backdrilled");
VS.setBackdrill(fixed.items.find(i => i.id === "v2"), null);
assert.equal(fixed.items.find(i => i.id === "v2").backdrill, undefined);

// Exactly touching the via and track radii plus the existing contact tolerance
// connects. A zero-length segment and a reversed segment one coordinate tick
// long produce the same connection, including at a large board origin.
{
  const x=1e7,ulp=2**-29,threshold=.6/2+.2/2+1e-6;
  function used(points) {
    const copper={id:"touch",kind:"track",layer:"Top",net:"SIG",width:.2,points};
    return VS.report(board([via("contact",x,{y:0}),copper]),defs).rows[0].used;
  }
  assert.deepEqual(used([[x,threshold],[x,threshold]]),["Top"]);
  assert.deepEqual(used([[x+ulp,threshold],[x,threshold]]),["Top"]);
  assert.deepEqual(used([[x,threshold+1e-12],[x+ulp,threshold+1e-12]]),[]);
}

// ---- DRC rule ------------------------------------------------------------------------------
assert.ok(R.types.viaStub && R.checkedTypes.includes("viaStub"));
const rules = R.migrate(R.create());
assert.ok(!rules.list.some(r => r.type === "viaStub"), "no stub rule by default");
assert.equal(R.drc(doc, defs, rules, {types: ["viaStub"]}).total, 0);
rules.list.push({id: "stub-1", type: "viaStub", name: "MaxViaStubLength", comment: "", enabled: true, priority: 1, scope: AtriumDesignQueryRecord.selector("all"), max: .25});
R.validate(rules);
const res = R.drc(doc, defs, rules, {types: ["viaStub"]});
assert.deepEqual(res.violations.map(v => v.id).sort(), ["v2", "v4"]);
const v2 = res.violations.find(v => v.id === "v2");
close(v2.actual, row("v2").stubBottom); assert.equal(v2.required, .25); assert.equal(v2.limit, "max");
assert.match(res.violations.find(v => v.id === "v4").detail, /cuts a layer/);
assert.match(R.describe(rules.list.find(r => r.id === "stub-1")), /Max stub length=0\.25mm/);
// The report uses the rule's limit when no max is given.
assert.equal(VS.report(doc, defs, {rules}).rows.find(r => r.id === "v2").max, null, "no project rules: no rule limit");
doc.rules = rules;
assert.equal(VS.report(doc, defs).rows.find(r => r.id === "v2").max, .25);
// The report and batch DRC apply a diameter limit to the same physical via.
const selective = board(doc.items.map(v => v.id === "v2" ? {...v, diameter: .9} : v));
selective.rules = {...rules, list: rules.list.map(r => r.id === "stub-1" ?
  {...r, scope: AtriumDesignQueryRecord.create("via where diameter >= 0.8 mm")} : r)};
const scoped = R.drc(selective, defs, selective.rules, {types: ["viaStub"]}).violations;
assert.deepEqual(scoped.map(v => v.id), ["v2"]);
close(scoped[0].actual, v2.actual); assert.equal(scoped[0].required, v2.required);
const scopedRows = VS.report(selective, defs).rows;
assert.deepEqual(scopedRows.filter(r => r.max != null).map(r => [r.id, r.max]), [["v2", .25]]);
assert.equal(scopedRows.find(r => r.id === "v4").status, "severed");
assert.ok(VS.report(selective, defs, {max: .4}).rows.every(r => r.max === .4));
const notes = [];
VS.drc({kind: "schematic"}, defs, {notes});
assert.match(notes[0], /Via stub check skipped: Choose a PCB layout/);
assert.throws(() => VS.report({kind: "schematic"}, defs), /Choose a PCB layout/);
// Without a layer stack, a 1.6 mm board is assumed and said so.
const flat = {...board([via("w", 10), track("w", "Top", 10)]), stackup: undefined, thickness: 1.6};
const fr = VS.report(flat, defs, {max: .25});
assert.equal(fr.rows[0].status, "over");
console.log("via stubs: report, back-drill flags and DRC rule OK");
