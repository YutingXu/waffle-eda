"use strict";
// Schematic <-> PCB sync and smart placement of support components.
// Test design (tests/fixtures/sync-design.js): MCU with 6 power pins, six 100 nF + one 10 µF,
// crystal with two load capacitors, 4 SPI series resistors, 3 pull-ups, 2 connectors, 2 sheets.
const assert = require("node:assert/strict");
for (const m of ["model", "connectivity", "parts", "net-ties", "sch-objects", "altium-rules", "rules", "pcb-appearance", "pcb-edit", "hierarchy", "multichannel", "rooms",
  "library-panel", "footprint-wizard", "starter-library", "eco", "sch-author", "support-placement", "sync-status", "drc", "drc-fixes"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../fixtures/sync-design.js");
const A = Atrium, E = AtriumECO, S = AtriumSupportPlace, D = AtriumSyncDesign;
const defsOf = p => new Map(p.library.map(d => [d.id, d]));
const parts = d => d.items.filter(i => i.kind === "part");
const boardOf = p => p.documents.find(d => d.kind === "pcb");
const by = (doc, ref) => doc.items.find(i => i.kind === "part" && i.ref === ref);
function box(item, def) {
  const fp = def.footprint, c = Array.isArray(fp.courtyard) && fp.courtyard.length === 4 ? fp.courtyard : A.bounds(A.symbolPoints(fp));
  return A.bounds([[c[0], c[1]], [c[2], c[1]], [c[2], c[3]], [c[0], c[3]]].map(q => A.world(q, item)));
}
const overlap = (a, b) => a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
function test(name, fn) { fn(); console.log("PASS " + name); }

// ---------------------------------------------------------------- first Update PCB: clusters by sheet
const p = D.build(), board = boardOf(p), sch = p.documents.filter(d => d.kind === "schematic");
const plan = E.plan(p, {board: board.id});
test("first Update PCB clusters new parts by schematic sheet beside the board", () => {
  assert.equal(plan.issues.length, 0, plan.issues.join("\n"));
  const adds = plan.changes.filter(c => c.action === "addComponent");
  assert.equal(adds.length, 20);
  assert.deepEqual(plan.clusters.map(c => c.name), ["MCU", "IO"]);
  const sheetOf = new Map(sch.flatMap(s => parts(s).map(i => [i.ref, s.id])));
  const defs = defsOf(p), boxes = [];
  for (const cl of plan.clusters) for (const id of cl.ids) {
    const c = adds.find(x => x.id === id);
    assert.equal(sheetOf.get(c.object), cl.sheet, c.object + " is in its sheet's cluster");
    const b = box({x: c.at[0], y: c.at[1], angle: 0}, defs.get(c.def));
    assert.ok(b[0] > 50, c.object + " waits beside the board outline");
    assert.ok(b[0] >= cl.bounds[0] - 1e-6 && b[2] <= cl.bounds[2] + 1e-6 && b[1] >= cl.bounds[1] - 1e-6 && b[3] <= cl.bounds[3] + 1e-6, c.object + " inside its cluster box");
    boxes.push([c.object, b]);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i][1], boxes[j][1]), boxes[i][0] + " overlaps " + boxes[j][0]);
  assert.ok(!overlap(plan.clusters[0].bounds, plan.clusters[1].bounds), "clusters do not overlap");
});
test("inside a cluster, parts drawn near each other start near each other", () => {
  // Rank correlation (Spearman) of schematic and board distances over all pairs of the MCU sheet.
  const adds = new Map(plan.changes.filter(c => c.action === "addComponent").map(c => [c.object, c.at]));
  const mcu = parts(sch[0]), pairs = [];
  for (let i = 0; i < mcu.length; i++) for (let j = i + 1; j < mcu.length; j++) {
    const a = mcu[i], b = mcu[j], pa = adds.get(a.ref), pb = adds.get(b.ref);
    pairs.push([Math.hypot(a.x - b.x, a.y - b.y), Math.hypot(pa[0] - pb[0], pa[1] - pb[1])]);
  }
  const rank = v => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = []; o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rs = rank(pairs.map(q => q[0])), rb = rank(pairs.map(q => q[1])), n = pairs.length;
  const rho = 1 - 6 * rs.reduce((s, r, i) => s + (r - rb[i]) ** 2, 0) / (n * (n * n - 1));
  assert.ok(rho > 0.6, "Spearman rho " + rho.toFixed(2));
  console.log("  relative arrangement: Spearman rho " + rho.toFixed(2) + " over " + n + " pairs");
});
test("rooms per sheet follow the clusters", () => {
  const withRooms = E.plan(p, {board: board.id, rooms: true}), rooms = withRooms.changes.filter(c => c.action === "room");
  assert.deepEqual(rooms.map(r => r.object).sort(), ["IO", "MCU"]);
});
const done = E.execute(p, plan);
test("execute is one change set; the base, clusters and sync state are recorded", () => {
  assert.equal(done.failed, 0, JSON.stringify(done.rows.filter(r => r.state === "failed")));
  assert.equal(parts(board).length, 20);
  assert.equal(Object.keys(board.sync.base).length, 20);
  assert.deepEqual(board.sync.clusters.map(c => [c.name, c.ids.length]), [["MCU", 15], ["IO", 5]]);
  A.validate(JSON.parse(E.serialize(p)));
  assert.equal(E.plan(p, {board: board.id}).changes.length, 0, "in sync afterwards");
  const groups = AtriumSyncStatus.clusters(board, defsOf(p));
  assert.equal(groups.length, 2, "both groups wait outside the outline");
});

// ---------------------------------------------------------------- associations
const assoc = S.associate(p, board);
test("support associations on the test design", () => {
  let ok = 0;
  const rows = [];
  for (const [ref, [kind, tref, pin]] of Object.entries(D.EXPECTED)) {
    const r = assoc.roles.find(x => x.ref === ref), good = !!r && r.kind === kind && r.target?.ref === tref && r.target?.pin === pin;
    if (good) ok++; else rows.push(ref + ": got " + (r ? r.kind + " " + r.target?.ref + "." + r.target?.pin : "none") + ", want " + kind + " " + tref + "." + pin);
  }
  assert.deepEqual(rows, []);
  assert.equal(assoc.roles.filter(r => !D.EXPECTED[r.ref]).length, 0, "no association for connectors or the MCU");
  console.log("  association accuracy " + ok + "/" + Object.keys(D.EXPECTED).length);
  assert.equal(S.explain(assoc.roles.find(r => r.ref === "C4")), "Decoupling for U1 pin 24 VDD (100 nF, 0402)");
  assert.equal(S.explain(assoc.roles.find(r => r.ref === "C7")), "Bulk decoupling for U1 pin 48 VDD (10 µF, 0805)");
  assert.match(S.explain(assoc.roles.find(r => r.ref === "R2")), /^Series termination at U1 pin 15 SPI_SCK \(driver\)/);
  assert.match(S.explain(assoc.roles.find(r => r.ref === "R5")), /^Pull-up for U1 pin 7 NRST to \+3V3/);
});
test("values and sizes", () => {
  assert.equal(S.quantity("100 nF"), 1e-7); assert.equal(S.quantity("4u7"), 4.7e-6); assert.equal(S.quantity("10k"), 1e4); assert.equal(S.quantity("4R7"), 4.7);
  assert.equal(S.showFarads(2.2e-11), "22 pF");
  assert.equal(S.sizeOf({name: "CAPC1608X90N"}), "0603"); assert.equal(S.sizeOf({name: "R_0402_1005Metric"}), "0402");
});

// ---------------------------------------------------------------- Place Support Components
test("Place Support Components puts every capacitor within the configured distance of its pin, DRC clean", () => {
  const defs = defsOf(p), move = (ref, x, y) => { const i = by(board, ref); A.transformPart(board, i, defs.get(i.def), {x, y, angle: 0}); };
  move("U1", 25, 20); move("J1", 4, 20); move("J2", 46, 20);
  by(board, "C9").locked = true;
  const before = E.serialize(p), dry = S.propose(p, board, {set: "support"});
  assert.equal(E.serialize(p), before, "propose never edits");
  assert.ok(dry.skipped.some(s => s.ref === "C9" && s.reason === "locked"), "locked parts are never moved");
  delete by(board, "C9").locked;
  const prop = S.propose(p, board, {set: "support"});
  assert.equal(prop.moves.length, 17, prop.moves.map(m => m.ref).join());
  assert.deepEqual(prop.skipped, []);
  const r = S.apply(p, board, prop);
  assert.equal(r.moved, 17);
  const maxD = prop.prefs.maxDistance, report = [];
  for (const m of prop.moves) {
    const it = by(board, m.ref), t = by(board, m.target?.ref || "");
    if (!t) continue;
    const pads = A.pins(it, defs.get(it.def), "pcb"), tp = A.pins(t, defs.get(t.def), "pcb").find(q => q.number === m.target.pin);
    const near = Math.min(...pads.filter(q => (it.pinNets?.[q.number] || "") === (t.pinNets?.[tp.number] || "x")).map(q => Math.hypot(q.at[0] - tp.at[0], q.at[1] - tp.at[1])));
    report.push(m.ref + " " + near.toFixed(2));
    if (/^C/.test(m.ref)) assert.ok(near <= maxD + 1e-6, m.ref + " is " + near.toFixed(2) + " mm from " + m.target.ref + "." + m.target.pin);
  }
  console.log("  pad-to-pin distances (mm): " + report.join(", "));
  // Smallest value closest: the 100 nF of pin 48 is nearer than the 10 µF.
  const d = ref => prop.moves.find(m => m.ref === ref).distance;
  assert.ok(d("C6") < d("C7"), "100 nF closer than 10 µF");
  // No courtyard overlaps; every placed part inside the outline.
  const all = parts(board).map(i => [i.ref, box(i, defs.get(i.def))]);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const inBoard = q => q[1][0] >= 0 && q[1][2] <= 50 && q[1][1] >= 0 && q[1][3] <= 40;
    if (inBoard(all[i]) && inBoard(all[j])) assert.ok(!overlap(all[i][1], all[j][1]), all[i][0] + " overlaps " + all[j][0]);
  }
  for (const m of prop.moves) assert.ok(m.box[0] >= 0 && m.box[2] <= 50 && m.box[1] >= 0 && m.box[3] <= 40, m.ref + " inside the outline");
  const rules = AtriumRules.stored(board, p) || AtriumRules.defaults();
  const res = AtriumDRCFixes.augment(AtriumRules.drc(board, defs, rules, {}), board, defs);
  const errors = res.violations.filter(v => v.type !== "unrouted").map(v => (v.warning ? "warning " : "error ") + v.type + ": " + (v.title || v.id));
  assert.deepEqual(errors, [], "DRC after placement");
  // Done: nothing left outside the board to place.
  assert.equal(S.propose(p, board, {set: "support"}).moves.length, 0);
  assert.equal(AtriumSyncStatus.clusters(board, defs).filter(g => g.name === "MCU").length, 0, "the MCU group label goes once its parts are on the board");
});
test("overrides stored with the board change an association; MCP proposal mode", () => {
  S.setOverride(board, by(board, "R5").id, {kind: "none"});
  assert.ok(!S.associate(p, board).roles.some(r => r.ref === "R5"));
  S.setOverride(board, by(board, "R5").id, {kind: "pullup", ref: "U1", pin: "44"});
  const r5 = S.associate(p, board).roles.find(r => r.ref === "R5");
  assert.equal(r5.manual, true); assert.equal(r5.target.pin, "44");
  S.setOverride(board, by(board, "R5").id, null);
  assert.equal(board.sync.support, undefined);
  const snap = E.serialize(p);
  const out = S.headless({mode: "plan", scope: "all", set: "decoupling"}, {project: () => p, mutable: () => p, board: () => board, touched() { throw Error("plan must not write"); }});
  assert.equal(out.mode, "plan"); assert.equal(out.moved, 0); assert.ok(out.moves.length >= 7); assert.equal(E.serialize(p), snap);
  assert.ok(out.moves.every(m => m.untrusted_design_text.ref), "design text is marked untrusted");
});

// ---------------------------------------------------------------- reverse sync and conflicts
const schPart = ref => sch.flatMap(parts).find(i => i.ref === ref);
test("a footprint changed on the board syncs back to the schematic", () => {
  const c1 = by(board, "C1"), was = c1.def;
  c1.def = "starter-c-0603";
  const fwd = E.plan(p, {board: board.id}), row = fwd.changes.find(c => c.action === "footprint" && c.object === "C1");
  assert.equal(row.origin, "board", "traced to the board");
  assert.equal(row.use, "reverse", "Update PCB keeps the board's newer footprint instead of overwriting it");
  assert.match(E.describe(row.alt), /^C1: footprint CAPC1005X\w+ → CAPC1608X\w+$/);
  const back = E.plan(p, {board: board.id, direction: "sch"}), r2 = back.changes.find(c => c.action === "footprint" && c.object === "C1");
  assert.equal(r2.origin, "board"); assert.ok(r2.selected && !r2.conflict);
  const res = E.execute(p, back);
  assert.equal(res.failed, 0);
  assert.equal(schPart("C1").def, "starter-c-0603");
  assert.equal(E.plan(p, {board: board.id}).changes.filter(c => c.object === "C1").length, 0, "in sync again");
  assert.equal(board.sync.base[c1.id][2], defsOf(p).get("starter-c-0603").footprint.name, "base follows");
  assert.notEqual(was, c1.def);
});
test("both sides changed: a conflict, never resolved silently", () => {
  const c2 = by(board, "C2"), s2 = schPart("C2");
  c2.def = "starter-c-0603"; s2.def = "starter-c-0805";
  const fwd = E.plan(p, {board: board.id}), row = fwd.changes.find(c => c.action === "footprint" && c.object === "C2");
  assert.equal(row.origin, "both"); assert.ok(row.conflict); assert.equal(row.selected, false); assert.equal(row.use, null);
  assert.match(row.conflict.schematic, /2012/); assert.match(row.conflict.board, /1608/);
  // Ticked without a choice: skipped, explained.
  row.selected = true;
  const chk = E.validate(p, fwd);
  assert.equal(chk.rows.find(r => r.id === row.id).held, true);
  assert.ok(E.warnings(p, fwd, chk).some(w => w.kind === "conflict" && /C2/.test(w.text)));
  E.execute(p, fwd);
  assert.equal(c2.def, "starter-c-0603"); assert.equal(s2.def, "starter-c-0805");
  // Keep the board's value: the schematic follows in the same execute.
  const again = E.plan(p, {board: board.id}), r2 = again.changes.find(c => c.action === "footprint" && c.object === "C2");
  r2.use = "reverse"; r2.selected = true;
  const done2 = E.execute(p, again);
  assert.equal(done2.rows.find(r => r.id === r2.id).state, "done");
  assert.equal(s2.def, "starter-c-0603"); assert.equal(c2.def, "starter-c-0603");
  assert.equal(E.plan(p, {board: board.id}).changes.filter(c => c.object === "C2").length, 0);
});
test("never sync: rules are honoured, listed and reversible", () => {
  const s3 = schPart("C3");
  s3.value = "220 nF";
  let pl = E.plan(p, {board: board.id}), row = pl.changes.find(c => c.action === "value" && c.object === "C3");
  assert.ok(row.selected && row.origin === "schematic");
  assert.equal(E.describe(row), "C3: comment 100 nF → 220 nF");
  E.neverSync(board, row);
  assert.deepEqual(E.ignores(board).map(r => [r.action, r.object, r.label]), [["value", "C3", "C3: comment 100 nF → 220 nF"]]);
  pl = E.plan(p, {board: board.id}); row = pl.changes.find(c => c.action === "value" && c.object === "C3");
  assert.ok(row.ignored && !row.selected, "left out of the update");
  assert.equal(AtriumSyncStatus.boardPrint(board) === AtriumSyncStatus.boardPrint(JSON.parse(JSON.stringify(board))), true);
  E.syncAgain(board, E.ignores(board)[0]);
  assert.equal(E.ignores(board).length, 0);
  row = E.plan(p, {board: board.id}).changes.find(c => c.action === "value" && c.object === "C3");
  assert.ok(row.selected && !row.ignored);
  s3.value = "100 nF";
});
test("removing parts that carry routed copper warns with a count", () => {
  const q = JSON.parse(E.serialize(p)), qb = boardOf(q), defs = defsOf(q), j2 = by(qb, "J2"), pin = A.pins(j2, defs.get(j2.def), "pcb")[2].at;
  qb.items.push({id: A.id(), kind: "track", layer: "Top", width: 0.25, net: "I2C_SCL", points: [pin, [pin[0] - 5, pin[1]]]}, {id: A.id(), kind: "via", x: pin[0] - 5, y: pin[1], diameter: .6, drill: .3, net: "I2C_SCL"});
  const s = q.documents.find(d => d.name === "IO"); s.items = s.items.filter(i => !(i.kind === "part" && i.ref === "J2"));
  const pl = E.plan(q, {board: qb.id, removeExtras: true}), rm = pl.changes.find(c => c.action === "removeComponent");
  assert.equal(rm.object, "J2");
  const w = E.warnings(q, pl, E.validate(q, pl)).find(x => x.kind === "copper");
  assert.match(w.text, /Removing 1 footprint with routed copper: 1 track and vias stay behind \(J2 \(1\)\)/);
  qb.items.find(i => i.ref === "J2").locked = true;
  const pl2 = E.plan(q, {board: qb.id, removeExtras: true});
  assert.ok(!pl2.changes.some(c => c.action === "removeComponent"), "locked parts are never removed");
});
test("sync status fingerprints ignore positions and copper", () => {
  const a = AtriumSyncStatus.boardPrint(board), u1 = by(board, "U1");
  u1.x += 1; board.items.push({id: "t-x", kind: "track", layer: "Top", width: .2, net: "GND", points: [[1, 1], [2, 2]]});
  assert.equal(AtriumSyncStatus.boardPrint(board), a, "moving and routing never re-compares");
  u1.x -= 1; board.items.pop();
  u1.value = "MCU2"; assert.notEqual(AtriumSyncStatus.boardPrint(board), a); u1.value = "MCU";
  const s = AtriumSyncStatus.sheetsPrint(p);
  schPart("R1").value = "22 Ω"; assert.notEqual(AtriumSyncStatus.sheetsPrint(p), s); schPart("R1").value = "33 Ω";
});
console.log("sync-placement: all checks passed");
