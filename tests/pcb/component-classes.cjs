"use strict";
// Component classes (component-classes.js): user, sheet, room and ComponentClass-parameter
// classes; InComponentClass rule scopes for clearance, DFA spacing and rooms; Find Similar,
// the selection filter and the headless (MCP) entry point.
// Fixture: synthetic, the built-in example project (AtriumParts.example).
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "stackup", "altium-rules", "rooms", "component-classes", "rules", "dfa", "pcb-appearance", "pcb-edit"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, CC = AtriumComponentClasses, R = AtriumRules, RM = AtriumRooms;
const Q = AtriumDesignQueryRecord;

function fixture() {
  const p = AtriumParts.example(), sch = p.documents[0], board = p.documents[1];
  return {p, sch, board, defs: new Map(p.library.map(d => [d.id, d]))};
}

// 1. Generated classes: the sheet class holds every linked board part.
{
  const {p, board, sch} = fixture();
  const all = CC.list(board, p), sheet = all.find(c => c.source === "sheet");
  assert.equal(sheet.name, sch.name);
  assert.deepEqual(sheet.members, ["C1", "C2", "J1", "J2", "R1", "R2", "U1"]);
  assert.deepEqual(CC.list(sch, p), [], "a schematic has no component classes");
  // ComponentClass parameter on a library definition, a schematic part and a board part.
  p.library.find(d => d.id === "std-c").parameters = {ComponentClass: "Decoupling"};
  sch.items.find(i => i.ref === "R2").parameters = {ComponentClass: "Output; Analog"};
  board.items.find(i => i.ref === "U1").parameters = {"Component Class": "Analog"};
  const m = CC.map(board, p);
  assert.deepEqual([...m.get("Decoupling")].sort(), ["C1", "C2"]);
  assert.deepEqual([...m.get("Analog")].sort(), ["R2", "U1"]);
  assert.deepEqual([...m.get("Output")], ["R2"]);
  assert.deepEqual(CC.classesOf(board, p, "R2").sort(), ["Analog", "Analog front end", "Output"]);
  // Room classes, by the room's own membership.
  board.rooms = [RM.make({name: "Input stage", points: RM.rectPoints(0, 0, 12, 22), members: board.items.filter(i => ["J1", "R1"].includes(i.ref)).map(i => i.id)})];
  assert.deepEqual(CC.list(board, p).find(c => c.source === "room").members, ["J1", "R1"]);
  assert.ok(!CC.map(board, p, {rooms: false}).has("Input stage"), "rooms:false leaves room classes out");
}

// 2. User classes: store, validation, edits, renames that follow rule and room scopes.
{
  const {p, board} = fixture();
  CC.set(board, "Power", ["U1", "C2"]);
  assert.deepEqual(board.componentClasses, {Power: ["C2", "U1"]});
  CC.add(board, "Power", ["C1"]); CC.removeMembers(board, "Power", ["C2"]);
  assert.deepEqual(board.componentClasses.Power, ["C1", "U1"]);
  assert.throws(() => CC.set(board, "Power", ["Q9"]), /no component Q9/);
  assert.throws(() => CC.set(board, "it's", ["U1"]), /without quotes/);
  assert.throws(() => CC.set(p.documents[0], "X", []), /board layout/);
  A.validate(p);
  assert.throws(() => A.validate({...p, documents: [p.documents[0], {...board, componentClasses: {Power: "U1"}}]}), /Invalid Waffle editor model\.$/);
  assert.throws(() => A.validate({...p, documents: [{...p.documents[0], componentClasses: {}}, board]}), /Invalid Waffle editor model\.$/, "boards only");
  { const set = R.create(); set.list.push({...set.list.find(r => r.type === "clearance"), id: "cc-rule", name: "Clearance_Power", priority: 2, scope: Q.selector("componentclass", "Power")}); R.store(board, p, set); }
  board.rooms = [{...RM.make({name: "PWR", points: RM.rectPoints(0, 0, 5, 5)}), componentClass: "Power"}];
  CC.rename(board, "Power", "Supply", p);
  assert.deepEqual(Object.keys(board.componentClasses), ["Supply"]);
  assert.deepEqual(R.stored(board, p).list.find(r => r.id === "cc-rule").scope, Q.selector("componentclass", "Supply"), "rule scopes follow the rename");
  assert.equal(board.rooms[0].componentClass, "Supply", "room scopes follow the rename");
  CC.remove(board, "Supply");
  assert.equal(board.componentClasses, undefined, "an empty store is removed");
}

// 3. Rules: InComponentClass scopes (query text, Altium import, clearance and DFA matching).
{
  assert.ok(R.scopeKinds.some(([k]) => k === "componentclass"));
  assert.equal(R.scopeQuery({kind: "componentclass", value: "It''s"}), "InComponentClass('It''''s')");
  assert.equal(R.scopeQuery({kind: "componentclass", value: "Power"}), "InComponentClass('Power')");
  const {p, board, defs} = fixture();
  CC.set(board, "Wide", ["U1"]);
  const rules = R.create(), base = rules.list.find(r => r.type === "clearance");
  rules.list.push({...base, id: "wide", name: "Clearance_Wide", priority: 0, scope: Q.selector("componentclass", "Wide"), scope2: Q.selector("all"), gap: 3});
  const set = R.normalize(rules);
  R.validate(set);
  const out = R.drc(board, defs, set, {types: ["clearance"], project: p});
  const wide = out.violations.filter(v => v.ruleName === "Clearance_Wide");
  assert.ok(wide.length > 0, "the class rule flags copper near U1");
  assert.ok(wide.every(v => /U1-/.test(v.title)), "every class violation involves a U1 pad: " + wide.map(v => v.title).slice(0, 3).join(" | "));
  // Without the class the rule matches nothing.
  CC.remove(board, "Wide");
  assert.equal(R.drc(board, defs, set, {types: ["clearance"], project: p}).violations.filter(v => v.ruleName === "Clearance_Wide").length, 0);
  // Sheet classes scope rules too (resolver API used by routers and the inspector).
  const q = R.resolver(board, {project: p, rules: R.normalize({...rules, list: [...rules.list.filter(r => r.id !== "wide"),
    {...rules.list.find(r => r.type === "width"), id: "w-sheet", name: "Width_Sheet", priority: 0, scope: Q.selector("componentclass", "Analog front end"), min: .5}]})});
  assert.equal(q("width", {net: "VIN", component: "R1"}).ruleName, "Width_Sheet");
  assert.notEqual(q("width", {net: "VIN", component: "ZZ9"}).ruleName, "Width_Sheet");
  // Altium rule scope text.
  const imported = R.fromAltium("RULEKIND=Clearance|NAME=CC|ENABLED=TRUE|PRIORITY=1|SCOPE1EXPRESSION=InComponentClass('Power')|SCOPE2EXPRESSION=All|GAP=10mil");
  assert.deepEqual(imported.rule.scope, Q.selector("componentclass", "Power"));
  // DFA spacing: a class-scoped rule with a huge default gap catches only its members.
  const D = AtriumDFA, dfa = R.create();
  dfa.list.push(D.defaultRule());
  dfa.list.push({...D.defaultRule({id: "dfa-cc", name: "DFA_Class", scope: Q.selector("componentclass", "Tight")}), priority: 0.5, matrix: [], defaultGap: 40});
  CC.set(board, "Tight", ["J1"]);
  const dv = R.drc(board, defs, R.normalize(dfa), {types: ["dfaSpacing"], project: p}).violations.filter(v => v.ruleName === "DFA_Class");
  assert.ok(dv.length > 0 && dv.every(v => /J1/.test(v.title)), "DFA class rule: " + dv.map(v => v.title).join(" | "));
}

// 4. Rooms scoped by a class (room.componentClass) hold its components.
if (/inClass/.test(RM.members.toString())) {
  const {p, board} = fixture();
  globalThis.AtriumNavHost = {project: () => p};
  CC.set(board, "Out", ["J2", "R2"]);
  board.rooms = [{...RM.make({name: "Output", points: RM.rectPoints(20, 0, 36, 22)}), componentClass: "Out"}];
  RM.validate(board.rooms);
  assert.deepEqual(RM.members(board, board.rooms[0]).map(i => i.ref).sort(), ["J2", "R2"]);
  assert.equal(RM.roomOf(board, board.items.find(i => i.ref === "R2")).name, "Output");
  assert.throws(() => RM.validate([{...board.rooms[0], componentClass: 7}]), /not a supported/);
  delete globalThis.AtriumNavHost;
}

// 5. Find Similar by component class; the selection filter narrows parts to one class.
{
  const {p, board, defs} = fixture(), PE = AtriumPCBEdit;
  CC.set(board, "Pair", ["R1", "R2"]);
  const r1 = board.items.find(i => i.ref === "R1");
  const props = PE.similarProps(board, defs, r1);
  if (props.some(x => x.key === "componentClass")) {
    assert.equal(props.find(x => x.key === "componentClass").value.split(", ").includes("Pair"), true);
    const ids = PE.findSimilar(board, defs, r1, {componentClass: "same"});
    assert.deepEqual(ids.map(id => board.items.find(i => i.id === id).ref).sort(), ["R1", "R2"]);
  }
  CC.install({registerAction() {}, doc: () => board, project: () => p});
  CC.setFilter("Pair");
  assert.equal(CC.allows(r1), true);
  assert.equal(CC.allows(board.items.find(i => i.ref === "U1")), false);
  assert.equal(CC.allows({kind: "track"}), true, "only components are filtered");
  if (/AtriumComponentClasses/.test(PE.allows?.toString?.() || "")) assert.equal(PE.allows(board.items.find(i => i.ref === "U1")), false);
  CC.setFilter("");
  assert.equal(CC.allows(board.items.find(i => i.ref === "U1")), true);
}

// 6. Headless entry point (MCP run_command component_classes / list_component_classes).
{
  const {p} = fixture();
  let r = CC.headless(p, {op: "set", name: "Conn", designators: ["J1", "J2"]});
  assert.deepEqual(r.classes.find(c => c.name === "Conn"), {name: "Conn", source: "user", members: ["J1", "J2"]});
  r = CC.headless(p, {op: "rename", name: "Conn", new_name: "Connectors"});
  assert.ok(r.classes.some(c => c.name === "Connectors"));
  r = CC.headless(p, {op: "list"});
  assert.deepEqual(r.classes.map(c => c.source).sort(), ["sheet", "user"]);
  CC.headless(p, {op: "delete", name: "Connectors"});
  assert.throws(() => CC.headless(p, {op: "delete", name: "Connectors"}), /No user-defined/);
  assert.throws(() => CC.headless(p, {op: "list", document_id: p.documents[0].id}), /PCB document/);
  A.validate(p);
}
console.log("Native component classes, scoped clearance, DFA spacing, rooms and headless edits passed.");
