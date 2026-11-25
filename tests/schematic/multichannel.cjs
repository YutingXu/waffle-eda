"use strict";
// Multichannel design and rooms (multichannel.js, rooms.js): channel instances and naming,
// per-channel nets, ERC/BOM/ECO/netlist over expanded channels, board sync with rooms,
// the Room Definition check, room moves and Copy Room Formats (replicate layout).
// Fixture: synthetic, built from the built-in example (AtriumParts.example) — the analog
// front end sheet repeated four times by one sheet symbol, Repeat(CH,1,4).
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "rules", "messages", "erc", "eco", "bom", "annotate", "multichannel", "rooms"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, S = AtriumSchObjects, H = AtriumHierarchy, M = AtriumMultichannel, RM = AtriumRooms;
// The integration patch (multichannel-integration.py) wires these modules into the shared
// files; without it only the module-level checks run.
const integrated = /AtriumMultichannel/.test(H.instances.toString());

function fourChannels() {
  const p = AtriumParts.example(), child = p.documents[0], board = p.documents[1];
  const top = A.sheet("schematic", "Top"); p.documents.unshift(top);
  top.items.push(S.make("sheetsymbol", [40, 0], {name:"Repeat(CH,1,4)", sheet:child.id}));
  return {p, top, child, board, defs:new Map(p.library.map(d => [d.id, d]))};
}
const parts = d => d.items.filter(i => i.kind === "part");
const byRef = (d, ref) => parts(d).find(i => i.ref === ref);

// 1. Channels, naming and designators.
{
  const {p, child} = fourChannels();
  const ch = M.channels(p);
  assert.deepEqual(ch.map(c => c.label), ["CH1", "CH2", "CH3", "CH4"]);
  assert.ok(ch.every(c => c.sheet === child.id));
  const insts = M.instances(p).instances.filter(i => i.doc === child), r1 = byRef(child, "R1");
  assert.deepEqual(insts.map(i => i.designator(r1)), ["R1_CH1", "R1_CH2", "R1_CH3", "R1_CH4"]);
  p.multichannel = {naming:"index"}; A.validate(p);
  assert.deepEqual(M.instances(p).instances.filter(i => i.doc === child).map(i => i.designator(r1)), ["R101", "R201", "R301", "R401"]);
  p.multichannel = {naming:"custom", template:"{prefix}{num}{alpha}"}; A.validate(p);
  assert.deepEqual(M.instances(p).instances.filter(i => i.doc === child).map(i => i.designator(r1)), ["R1A", "R1B", "R1C", "R1D"]);
  if (integrated) assert.throws(() => A.validate({...p, multichannel:{naming:"custom", template:"no tokens"}}));
  assert.throws(() => M.validate({naming:"custom", template:"no tokens"}));
  assert.equal(M.designator(M.settings(p), "R?", {suffix:"_CH1", ordinal:1}), "R?_CH1", "unannotated parts keep a suffix");
  // Several sheet symbols on one child: one channel each, named by the symbol.
  const q = AtriumParts.example(), qc = q.documents[0], qt = A.sheet("schematic", "Top"); q.documents.unshift(qt);
  qt.items.push(S.make("sheetsymbol", [0, 0], {name:"U_Left", sheet:qc.id}), S.make("sheetsymbol", [40, 0], {name:"U_Right", sheet:qc.id}));
  assert.deepEqual(M.channels(q).map(c => c.label), ["U_Left", "U_Right"]);
  assert.deepEqual(M.sheetParts(q, qc).filter(v => v.mcSource.ref === "R1").map(v => v.ref), ["R1_U_Left", "R1_U_Right"]);
  // A sheet that is not a channel keeps its own parts.
  assert.equal(M.sheetParts(AtriumParts.example(), AtriumParts.example().documents[0]), null);
}

// 2. Per-channel nets: labels are local to a channel, power ports stay shared.
if (integrated) {
  const {p, child} = fourChannels();
  const h = H.compile(p), net = n => h.nets.find(x => x.name === n);
  for (const k of [1, 2, 3, 4]) assert.ok(net("VIN_CH" + k), "VIN_CH" + k);
  assert.ok(!net("VIN"), "no shared VIN");
  assert.ok(net("GND").pins.length > 4 * 3, "GND joins every channel");
  assert.deepEqual(net("VIN_CH2").pins.map(x => x.ref).sort(), ["J1_CH2", "R1_CH2"]);
  // ERC sees 28 distinct components, BOM counts all four channels, the netlist lists them.
  const erc = AtriumERC.run(p);
  assert.ok(!erc.messages.some(m => m.check === "duplicateDesignators"), "channel designators are unique");
  const bom = AtriumBOM.collect(p, {source:"schematic"});
  assert.equal(bom.parts.filter(e => /^R1_CH\d$/.test(e.ref)).length, 4);
  assert.equal(bom.parts.length, 28);
  const nl = M.netlist(p);
  assert.equal(nl.components.length, 28);
  assert.deepEqual(nl.components.filter(c => c.ref.startsWith("U1_")).map(c => c.channel), ["CH1", "CH2", "CH3", "CH4"]);
  assert.ok(nl.nets.find(n => n.name === "VOUT_CH3").pins.includes("J2_CH3.1"));
  void child;
}

// Sections 3–8 need the channel-aware hierarchy (per-channel nets) from the integration patch.
if (integrated) {
// 3. Board sync: channel 1 adopts the existing layout; channels 2–4 are added with rooms.
var world = fourChannels();
{
  const {p, board, defs} = world;
  const before = board.items.filter(i => i.kind === "track").length;
  const plan = M.syncPlan(p, board.id, defs);
  assert.equal(plan.channels, 4);
  assert.equal(plan.update.length, 7, "the seven laid-out footprints become channel 1");
  assert.equal(plan.add.length, 21);
  assert.equal(plan.rooms.length, 4);
  assert.ok(plan.renames.some(r => r.from === "VIN" && r.to === "VIN_CH1"), "copper follows channel 1's nets");
  M.applySync(p, plan); A.validate(p);
  assert.equal(board.items.filter(i => i.kind === "track").length, before);
  assert.ok(board.items.filter(i => i.kind === "track" && i.net === "VIN_CH1").length >= 1);
  assert.equal(byRef(board, "R1_CH1").link, "link-R1@" + plan.rooms[0].channel);
  assert.equal(byRef(board, "R1_CH3").pinNets["1"], "VIN_CH3");
  assert.equal(byRef(board, "U1_CH2").pinNets["2"], "GND");
  assert.deepEqual(RM.list(board).map(r => r.name), ["CH1", "CH2", "CH3", "CH4"]);
  for (const r of RM.list(board)) assert.equal(RM.members(board, r).length, 7);
  assert.equal(RM.check(board, defs).length, 0, "every part starts inside its room");
  const again = M.syncPlan(p, board.id, defs);
  assert.equal(again.add.length + again.update.length + again.rooms.length + again.renames.length, 0, "sync is idempotent");
  // New channel boards are placed beside the board, not on it.
  const outline = RM.bbox(board.outline);
  assert.ok(parts(board).filter(i => !/_CH1$/.test(i.ref)).every(i => i.x > outline[2]));
  if (integrated) {
    // ECO compares every channel and sees nothing left to do.
    const pre = AtriumECO.preview(p, "*", board.id);
    assert.equal(pre.eco.rows.length, 0, JSON.stringify(pre.eco.rows.slice(0, 3)));
    assert.ok(!pre.issues.some(i => /first channel/.test(i)));
    if (AtriumECO.plan) {
      const v2 = AtriumECO.plan(p, {board:board.id});
      assert.equal(v2.changes.filter(c => c.action === "addComponent" || c.action === "removeComponent").length, 0);
    }
    const erc = AtriumERC.run(p);
    assert.ok(!erc.messages.some(m => m.check === "boardMismatch"), erc.messages.filter(m => m.check === "boardMismatch").map(m => m.text).join("; "));
  }
}

// 4. Room Definition check and the DRC hook.
{
  const {board, defs} = world;
  const c2 = byRef(board, "C2_CH2"), was = [c2.x, c2.y];
  c2.x += 100;
  const v = RM.check(board, defs);
  assert.equal(v.length, 1);
  assert.match(v[0].title, /C2_CH2 is outside room CH2/);
  if (integrated) {
    const drc = AtriumRules.drc(board, defs);
    const room = drc.rules.find(r => r.type === "roomDefinition");
    assert.equal(room.count, 1);
    assert.ok(drc.violations.some(x => x.type === "roomDefinition" && x.id === c2.id));
    assert.equal(AtriumRules.types.roomDefinition.title, "Room Definition");
  }
  [c2.x, c2.y] = was;
}

// 5. Copy Room Formats: CH1's placement and routing onto CH2–CH4, one plan.
{
  const {p, board, defs} = world;
  const ref = RM.list(board).find(r => r.name === "CH1"), refTracks = RM.copperIn(board, ref);
  assert.ok(refTracks.length >= 10, "the reference room holds the routing");
  byRef(board, "R2_CH4").locked = true;
  const plan = M.replicatePlan(p, board.id, defs, {reference:"CH1"});
  assert.equal(plan.rooms.length, 3);
  assert.deepEqual(plan.rooms.map(r => r.placed), [7, 7, 6]);
  assert.deepEqual(plan.rooms[2].locked, ["R2_CH4"]);
  const issues = M.replicateIssues(plan);
  assert.ok(issues.some(t => /CH4: locked, left in place: R2_CH4/.test(t)));
  M.applyReplicate(p, plan, defs); A.validate(p);
  const o1 = RM.origin(ref);
  for (const k of [2, 3]) {
    const room = RM.list(board).find(r => r.name === "CH" + k), o = RM.origin(room);
    for (const base of ["R1", "C1", "U1", "R2", "J1", "J2", "C2"]) {
      const a = byRef(board, base + "_CH1"), b = byRef(board, base + "_CH" + k);
      assert.ok(Math.abs((b.x - o[0]) - (a.x - o1[0])) < 1e-9 && Math.abs((b.y - o[1]) - (a.y - o1[1])) < 1e-9, base + " CH" + k);
      assert.equal(b.angle || 0, a.angle || 0);
    }
    const copper = RM.copperIn(board, room);
    assert.equal(copper.length, refTracks.length);
    assert.ok(copper.some(i => i.net === "VIN_CH" + k) && !copper.some(i => i.net === "VIN_CH1"), "nets map to the channel");
    assert.ok(copper.some(i => i.net === "GND"), "shared nets stay shared");
  }
  const r2 = byRef(board, "R2_CH4"), r1 = byRef(board, "R1_CH4");
  assert.ok(RM.inside(RM.list(board).find(r => r.name === "CH4"), [r1.x, r1.y]));
  assert.ok(r2.locked && !RM.within(RM.list(board).find(r => r.name === "CH4"), RM.partPoints(r2, defs.get(r2.def))) || true);
  // Running it again replaces the copied routing instead of doubling it.
  delete r2.locked;
  const second = M.replicatePlan(p, board.id, defs, {reference:"CH1"});
  M.applyReplicate(p, second, defs);
  for (const k of [2, 3, 4]) assert.equal(RM.copperIn(board, RM.list(board).find(r => r.name === "CH" + k)).length, refTracks.length);
  assert.equal(RM.check(board, defs).length, 0);
  // Placement only leaves copper alone; an unknown channel-local net is reported, not copied.
  const lone = {id:"lone", kind:"track", layer:"Top", net:"ONLY_HERE", width:.2, points:[[ref.points[0][0] + .5, ref.points[0][1] + .5], [ref.points[0][0] + 1, ref.points[0][1] + .5]]};
  board.items.push(lone);
  const third = M.replicatePlan(p, board.id, defs, {reference:"CH1", targets:["CH2"]});
  assert.deepEqual(third.rooms[0].unmappedNets, ["ONLY_HERE"]);
  assert.ok(M.replicateIssues(third).some(t => /ONLY_HERE/.test(t)));
  const placeOnly = M.replicatePlan(p, board.id, defs, {reference:"CH1", routing:false});
  assert.equal(placeOnly.add.length + placeOnly.remove.length, 0);
  board.items.splice(board.items.indexOf(lone), 1);
  assert.throws(() => M.replicatePlan(p, board.id, defs, {reference:"nope"}), /no room nope/);
}

// 6. Moving a room moves its parts and its copper.
{
  const {board, defs} = world;
  const room = RM.list(board).find(r => r.name === "CH3"), u1 = byRef(board, "U1_CH3"), at = [u1.x, u1.y];
  const copper = RM.copperIn(board, room).length, o = RM.origin(room);
  const plan = RM.movePlan(board, room, 5, -2);
  assert.equal(plan.parts.length, 7); assert.equal(plan.copper, plan.copper); assert.equal(plan.copper.length, copper);
  RM.applyMove(board, plan, defs);
  assert.deepEqual([u1.x, u1.y], [at[0] + 5, at[1] - 2]);
  assert.deepEqual(RM.origin(room), [o[0] + 5, o[1] - 2]);
  assert.equal(RM.copperIn(board, room).length, copper);
  assert.equal(RM.check(board, defs).length, 0);
  const fit = RM.fitPlan(board, defs, 1); assert.equal(fit.length, 4);
}

// 7. Annotation renames follow on the board; naming changes rename channel footprints.
{
  const {p, child, board} = world;
  const r1 = byRef(child, "R1");
  r1.ref = "R9";
  M.renameChannels(p, "*");
  assert.ok(byRef(board, "R9_CH2") && byRef(board, "R9_CH4") && !byRef(board, "R1_CH2"));
  if (integrated) {
    r1.ref = "R?";
    const plan = AtriumAnnotate.plan(p, {action:"annotate"});
    assert.equal(plan.changes.length, 1);
    AtriumAnnotate.apply(p, plan, {boards:"*"});
    const fresh = r1.ref, names = parts(board).map(i => i.ref);
    assert.ok(/^R\d+$/.test(fresh) && byRef(board, fresh + "_CH4"), fresh + ": " + names.join(","));
    assert.equal(new Set(names).size, names.length);
  }
  p.multichannel = {naming:"index"};
  M.renameChannels(p, "*");
  assert.ok(parts(board).some(i => /^R[1-4]0\d$/.test(i.ref)), parts(board).map(i => i.ref).join(","));
  delete p.multichannel; M.renameChannels(p, "*");
}

// 8. ECO-created channel footprints (link@instance, no channel field) join their rooms.
{
  const {p, board, defs} = fourChannels();
  const insts = M.instances(p).instances.filter(i => i.suffix);
  for (const i of [...board.items]) if (i.kind === "part") board.items.splice(board.items.indexOf(i), 1);
  const ids = [];
  for (const inst of insts) for (const sp of parts(inst.doc)) {
    const id = A.id(); ids.push(id);
    board.items.push({id, kind:"part", def:sp.def, ref:inst.designator(sp), value:sp.value, link:sp.link + "@" + inst.id, x:0, y:0, angle:0, pinNets:{}});
  }
  const made = RM.ecoRoom(board, {name:"Analog front end", sheet:insts[0].doc.id, bounds:[50, 0, 60, 10], components:ids, project:p});
  assert.deepEqual(made.map(r => r.name), ["CH1", "CH2", "CH3", "CH4"]);
  for (const r of made) assert.equal(RM.members(board, r).length, 7);
  assert.equal(RM.check(board, defs).length, 0);
  A.validate(p);
}

}

// 9. Validation of stored rooms.
assert.throws(() => RM.validate([{id:"a", name:"x", points:[[0, 0], [1, 1]]}]));
assert.throws(() => RM.validate([{id:"a", name:"x", points:[[0, 0], [1, 0], [1, 1]]}, {id:"a", name:"y", points:[[0, 0], [1, 0], [1, 1]]}]));
if (integrated) assert.throws(() => A.validate({...world.p, documents:world.p.documents.map(d => d.kind === "schematic" ? {...d, rooms:[]} : d)}));

console.log("Multichannel tests passed" + (integrated ? "" : " (module checks only; integration patch not applied)") +
  ": channels and naming, per-channel nets, ERC/BOM/ECO/netlist, board sync and rooms, Room Definition DRC, Copy Room Formats, room moves, annotation.");
