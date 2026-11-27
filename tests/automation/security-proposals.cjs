"use strict";
// AI and agent proposals are untrusted input. Every path that
// applies one (the AI review dialog in ai.js, AtriumAPI.settle for extensions and agents) goes
// through AtriumProposal.applyChecked: code-bearing fields are refused, every guard is re-checked
// against the live project, and a proposal that would leave an invalid project changes nothing.
//   scripts/test-jsc.sh security-proposals        or      node tests/automation/security-proposals.cjs
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "altium-rules", "rules", "connectivity", "zip", "bom", "length-tuning", "proposal", "atrium-api", "ai"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, P = AtriumProposal;
const base = AtriumParts.example(), board = base.documents.find(d => d.kind === "pcb"), sheet = base.documents.find(d => d.kind === "schematic");
const track = board.items.find(i => i.kind === "track"), part = sheet.items.find(i => i.kind === "part");

// An editor-like context: edit() takes one undo snapshot; ai.js applies through it.
function ctx(project) {
  const c = {project, defs: new Map(project.library.map(d => [d.id, d])), undo: [], edit(fn) { c.undo.push(JSON.stringify(c.project)); fn(); }};
  return c;
}
const v2 = ops => ({format: "atrium-ai", version: 2, project: base.name, ops});

// 1. Code fields: neither the AI dialog nor an agent proposal can write them, at project or document level.
for (const field of P.CODE_FIELDS) {
  for (const op of [{op: "set", target: "project", path: [field], after: [{id: "x", code: "alert(1)"}]},
    {op: "set", target: "document", id: sheet.id, path: [field], after: "alert(1)"},
    {op: "add", target: "document", after_id: null, value: {id: "evil", kind: "schematic", name: "Evil", items: [], [field]: ["alert(1)"]}}]) {
    const c = ctx(A.clone(base)), before = JSON.stringify(c.project);
    assert.throws(() => AtriumAI.apply(c, v2([op])), /code/, "AI apply refuses " + field + " (" + op.op + " " + op.target + ")");
    assert.equal(JSON.stringify(c.project), before);
    assert.equal(c.undo.length, 0, "a refused proposal takes no undo step");
    const h = AtriumAPI.headless(A.clone(base));
    assert.throws(() => h.api.proposals.submit(v2([op])), /code/, "agent submit refuses " + field);
    assert.equal(h.steps.length, 0);
  }
}
// applyChecked itself refuses code fields even if inspect were bypassed by a caller.
assert.throws(() => P.applyChecked(A.clone(base), v2([{op: "set", target: "project", path: ["hooks"], after: {}}])), /code/);

// 2. Validation: a proposal that leaves an invalid project is refused before anything changes.
{
  const draft = A.clone(base);
  draft.documents.find(d => d.id === board.id).items.find(i => i.id === track.id).points = [[0, 0]];
  const {proposal} = P.build(base, draft, {allowV1: false});
  const c = ctx(A.clone(base)), before = JSON.stringify(c.project);
  assert.throws(() => AtriumAI.apply(c, proposal), /invalid/, "AI apply validates on a copy first");
  assert.equal(JSON.stringify(c.project), before);
  assert.equal(c.undo.length, 0);
  const h = AtriumAPI.headless(A.clone(base));
  assert.throws(() => h.api.proposals.submit(proposal), /invalid/, "agent submit validates");
  assert.equal(h.steps.length, 0);
}

// 3. Live re-validation: a proposal drafted against older data is refused by every path.
{
  const draft = A.clone(base);
  draft.documents.find(d => d.id === board.id).items.find(i => i.id === track.id).width = .9;
  const {proposal} = P.build(base, draft, {allowV1: false});
  assert.deepEqual(P.memberOwners(proposal), [board.id]);
  const live = A.clone(base);
  live.documents.find(d => d.id === board.id).items.find(i => i.id === track.id).width = .3; // the user edited meanwhile
  const c = ctx(live), before = JSON.stringify(live);
  assert.throws(() => AtriumAI.apply(c, proposal), /changed since/);
  assert.equal(JSON.stringify(c.project), before);
  const h = AtriumAPI.headless(A.clone(live));
  assert.throws(() => h.api.proposals.submit(proposal), /changed since/);
  // The same proposal applies cleanly on the project it was drafted from, as one undo step.
  const ok = ctx(A.clone(base));
  AtriumAI.apply(ok, proposal);
  assert.equal(ok.undo.length, 1);
  assert.equal(ok.project.documents.find(d => d.id === board.id).items.find(i => i.id === track.id).width, .9);
}

// A document field needs whole-document validation but does not hide exact item writes from Undo.
{
  const p = A.clone(base), d = p.documents.find(d => d.id === board.id), s = p.documents.find(d => d.id === sheet.id);
  const changed = d.items.find(i => i.id === track.id);
  const ops = [
    {op:"set", target:"document", id:d.id, path:["grid"], before:d.grid, after:.75},
    {op:"set", target:"item", document:d.id, id:changed.id, path:["width"], before:changed.width, after:.9},
    {op:"set", target:"document", id:s.id, path:["grid"], before:s.grid, after:2}
  ];
  const proposal = P.guarded(p, "test.mixed-sets", ops);
  const untouched = d.items.find(i => i.id !== changed.id && i.kind === "track"), width = untouched.width;
  untouched.width = -1;
  assert.throws(() => P.prepare(p, proposal, A.validate), /invalid/i, "document sets still validate every item in that document");
  untouched.width = width;
  const prepared = P.prepare(p, proposal, A.validate);
  let journal;
  assert.equal(prepared.apply((change, touched) => {journal = new Map(touched.map(row => [row.doc, row.items])); change(); return true;}), true);
  assert.deepEqual(journal.get(d), [changed]);
  assert.deepEqual(journal.get(s), []);
  assert.equal(changed.width, .9);
}

// 4. Version 1: one field list (AtriumProposal.V1_FIELDS), the same answer on every path.
{
  assert.deepEqual([...P.V1_FIELDS], ["value", "ref", "x", "y", "angle"]);
  const row = (field, after) => ({format: "atrium-ai", version: 1, project: base.name, changes: [{document: sheet.id, id: part.id, ref: part.ref, field, before: part[field] ?? 0, after}]});
  for (const field of ["value", "ref"]) {
    const c = ctx(A.clone(base)), proposal = row(field, "R99");
    assert.deepEqual(P.memberOwners(proposal), [sheet.id]);
    assert.equal(AtriumAI.inspect(proposal, c.project).length, 1);
    AtriumAI.apply(c, proposal);
    assert.equal(c.undo.length, 1);
    assert.deepEqual(JSON.parse(c.undo[0]), base);
    assert.equal(c.project.documents.find(d => d.id === sheet.id).items.find(i => i.id === part.id)[field], "R99");
  }
  {
    const c = ctx(A.clone(base));
    AtriumAI.apply(c, row("x", part.x + sheet.grid));
    assert.equal(c.project.documents.find(d => d.id === sheet.id).items.find(i => i.id === part.id).x, part.x + sheet.grid, "a v1 proposal with x is accepted");
  }
  for (const bad of [row("extensions", "alert(1)"), row("def", "other"), row("__proto__", "x"), row("net", "GND"), row("x", "1"), row("x", 1e9), row("ref", " ")]) {
    const c = ctx(A.clone(base)), before = JSON.stringify(c.project);
    assert.throws(() => AtriumAI.apply(c, bad), "v1 refuses " + bad.changes[0].field + "=" + bad.changes[0].after);
    assert.throws(() => P.applyChecked(c.project, bad, {validate: A.validate}));
    assert.equal(JSON.stringify(c.project), before);
  }
  // Agents submit version 2 only: a v1 proposal is never a back door around the v2 checks.
  assert.throws(() => AtriumAPI.headless(A.clone(base)).api.proposals.submit(row("x", 1)), /version 2/);
  // A duplicate designator is refused.
  const other = sheet.items.find(i => i.kind === "part" && i.id !== part.id);
  assert.throws(() => AtriumAI.apply(ctx(A.clone(base)), row("ref", other.ref)), /already used/);
}
// An invalid list traversal must fail before the earlier field edit is written.
{
  const p = A.clone(base), pcb = p.documents.find(d => d.id === board.id);
  const wire = pcb.items.find(i => i.id === track.id);
  const width = wire.width, points = A.clone(wire.points);
  const edit = P.guarded(p, "geometry", [
    {op: "set", target: "item", document: pcb.id, id: wire.id, path: ["width"], before: wire.width, after: wire.width + .1},
    {op: "set", target: "item", document: pcb.id, id: wire.id, path: ["points", "0"], after: [9, 9]}
  ]);
  assert.throws(() => P.applyChecked(p, edit, {trial: false, validate: A.validate}), /edits inside a list/);
  assert.equal(wire.width, width, "preflight prevents the first edit");
  assert.deepEqual(wire.points, points);
}

// Insertions use an existing predecessor in the exact destination list.
{
  const p = A.project("Proposal ordering");
  const pcb = p.documents.find(d => d.kind === "pcb"), other = A.sheet("pcb", "Other");
  p.documents.push(other);
  const wire = id => ({id, kind: "track", layer: "Top", points: [[0, 0], [2, 0]], width: .2});
  const a = wire("a"), b = wire("b");
  pcb.items.push(a);
  other.items.push(b);
  const add = (id, after_id) => ({op: "add", target: "item", document: pcb.id, after_id, value: wire(id)});
  const apply = (ops, options) => P.apply(p, P.guarded(p, "add tracks", ops), options);
  const setWidth = {op: "set", target: "item", document: pcb.id, id: a.id,
    path: ["width"], before: a.width, after: 1};
  for (const after of ["missing", b.id]) {
    assert.throws(() => apply([setWidth, add("c", after)]), /insertion predecessor/);
    assert.equal(a.width, .2);
    assert.deepEqual(pcb.items, [a]);
  }
  const chain = [add("c", a.id), add("d", "c")];
  assert.throws(() => apply(chain, {select: [1]}), /insertion predecessor/);
  assert.deepEqual(pcb.items, [a]);
  assert.equal(apply(chain), 2);
  assert.deepEqual(pcb.items.map(i => i.id), ["a", "c", "d"]);
}

// Version 2 designator edits follow the version 1 rules: never blank, never another part's designator.
{
  const sheetParts = sheet.items.filter(i => i.kind === "part"), [a, b] = sheetParts;
  const setRef = (i, after) => ({op: "set", target: "item", document: sheet.id, id: i.id, path: ["ref"], before: i.ref, after});
  for (const [ops, re] of [[[setRef(a, b.ref)], /already used/], [[setRef(a, "")], /Invalid proposed text/], [[setRef(a, "  ")], /Invalid proposed text/],
    [[{op: "set", target: "item", document: sheet.id, id: a.id, path: ["ref"], before: a.ref}], /Invalid proposed text/],
    [[{op: "set", target: "item", document: sheet.id, id: a.id, path: ["x"], before: a.x, after: 1e9}], /geometry/],
    [[{op: "add", target: "item", document: sheet.id, after_id: null, value: {...a, id: "copy"}}], /already used/]]) {
    const proposal = P.guarded(base, "test.ref", ops);
    assert.throws(() => P.inspect(proposal, A.clone(base)), re, JSON.stringify(ops[0]));
    const c = ctx(A.clone(base)), before = JSON.stringify(c.project);
    assert.throws(() => AtriumAI.apply(c, proposal), re);
    assert.equal(JSON.stringify(c.project), before);
    const h = AtriumAPI.headless(A.clone(base));
    assert.throws(() => h.api.proposals.submit(proposal), re);
    assert.equal(h.steps.length, 0);
  }
  // The final designators decide: a swap, or reusing the designator of a removed part, is fine.
  const swap = ctx(A.clone(base));
  AtriumAI.apply(swap, P.guarded(base, "test.swap", [setRef(a, b.ref), setRef(b, a.ref)]));
  assert.deepEqual(swap.project.documents.find(d => d.id === sheet.id).items.filter(i => i.kind === "part").slice(0, 2).map(i => i.ref), [b.ref, a.ref]);
  const reuse = P.guarded(base, "test.reuse", [{op: "remove", target: "item", document: sheet.id, id: b.id, before: b}, setRef(a, b.ref)]);
  assert.equal(P.apply(A.clone(base), reuse), 2);
  // An unselected duplicate is not applied, so it does not block the others.
  const mixed = P.guarded(base, "test.mixed", [setRef(a, b.ref), {op: "set", target: "item", document: sheet.id, id: b.id, path: ["value"], before: b.value, after: "47k"}]);
  assert.equal(P.apply(A.clone(base), mixed, {select: [1]}), 1);
  assert.throws(() => P.apply(A.clone(base), mixed), /already used/);
  // Another gate of the same multi-gate symbol shares its designator.
  const gated = A.clone(base), def = gated.library.find(d => d.id === a.def);
  def.symbol = {...def.symbol, parts: 2};
  const gate = P.guarded(gated, "test.gate", [{op: "add", target: "item", document: sheet.id, after_id: a.id, value: {...a, id: "gate-b", unit: 2}}]);
  assert.equal(P.apply(A.clone(gated), gate), 1);
  const clash = P.guarded(gated, "test.gate", [{op: "add", target: "item", document: sheet.id, after_id: a.id, value: {...a, id: "gate-a"}}]);
  assert.throws(() => P.apply(A.clone(gated), clash), /already used/, "the same gate twice is a duplicate");
}

// Every path that checks or applies a proposal judges designators the same way, on the project
// the proposal leaves: blank and "?" designators are unannotated, every schematic sheet shares
// one set of designators compared without case, and two gates of one symbol share a designator
// only as different gates in range on the same footprint.
{
  const fx = A.clone(base), s = fx.documents.find(d => d.id === sheet.id), find = ref => s.items.find(i => i.ref === ref);
  fx.library.find(d => d.id === find("U1").def).symbol.parts = 2;
  const u = find("U1");
  Object.assign(u, {ref: "U71", unit: 1});
  s.items.push({...A.clone(u), id: "gate-b", ref: "U72", unit: 2, link: "link-U72"}, {...A.clone(u), id: "gate-g", ref: "U74", unit: 2});
  find("R1").ref = "R?";
  const other = A.sheet("schematic", "Sheet 2");
  // Sheet 2 already holds a duplicate the proposals below never touch.
  other.items.push({...A.clone(find("R2")), id: "q9", ref: "Q9", link: "link-Q9"}, {...A.clone(find("R2")), id: "q9b", ref: "Q9", link: "link-Q9b"});
  fx.documents.push(other);
  A.validate(fx);
  const byId = id => fx.documents.flatMap(d => d.items).find(i => i.id === id);
  const set = (i, field, after, doc = s) => ({op: "set", target: "item", document: doc.id, id: i.id, path: [field], before: i[field], after});
  const add = value => { const v = {...A.clone(find("R2")), ...value}; delete v.link; return {op: "add", target: "item", document: s.id, after_id: null, value: v}; };
  // name: [v2 operations, version 1 changes (when it can say it), expected v2, expected v1]
  const C1 = find("C1"), C2 = find("C2"), R2 = find("R2"), b = byId("gate-b"), g = byId("gate-g");
  const cases = {
    "blank designator set": [[set(C2, "ref", "")], true, false, false],
    "blank designator added": [[add({id: "n1", ref: ""})], false, true],
    "? designator set beside another": [[set(R2, "ref", "R?")], true, true, false], // version 1 keeps main's exact-match rule
    "? designator added beside another": [[add({id: "n2", ref: "R?"})], false, true],
    "duplicate on the same sheet": [[set(C1, "ref", "J2")], true, false, false],
    "duplicate on another sheet": [[set(C1, "ref", "Q9")], true, false, false],
    "duplicate in another case": [[set(C1, "ref", " j2 ")], true, false, false],
    "duplicate added on another sheet": [[{...add({id: "n3", ref: "q9"}), document: other.id}], false, false],
    "gate shares on the same footprint": [[set(g, "ref", "U71")], true, true, true],
    "gate shares on another footprint": [[set(b, "ref", "U71")], true, false, false],
    "same gate twice after a unit change": [[set(g, "ref", "U71"), set(g, "unit", 1)], false, false],
    "unit set past the gate count": [[set(g, "unit", 3)], false, false],
    "gate added past the gate count": [[add({...A.clone(u), id: "n4", ref: "U75", unit: 7})], false, false],
    "value edit on an existing duplicate": [[set(byId("q9b"), "value", "1k", other)], true, true, true]
  };
  for (const [name, [ops, hasV1, ok2, ok1]] of Object.entries(cases)) {
    const proposal = P.guarded(fx, "test.matrix", ops), outcome = {};
    const tryIt = (path, fn) => { try { fn(); outcome[path] = true; } catch (e) { outcome[path] = /already used|Invalid proposed text|gate/.test(e.message) ? false : "error: " + e.message; } };
    tryIt("v2 inspect", () => P.inspect(proposal, A.clone(fx)));
    tryIt("v2 apply", () => P.apply(A.clone(fx), proposal));
    tryIt("checked apply", () => P.applyChecked(A.clone(fx), proposal, {validate: A.validate}));
    tryIt("prepare", () => { const q = A.clone(fx); P.prepare(q, proposal, A.validate).apply(fn => { fn(); return true; }); });
    tryIt("staged sets", () => { if (P.stageSets(A.clone(fx), proposal) === null) throw Error("n/a"); });
    if (outcome["staged sets"] === "error: n/a") delete outcome["staged sets"];
    tryIt("AI apply", () => AtriumAI.apply(ctx(A.clone(fx)), proposal));
    tryIt("headless submit", () => AtriumAPI.headless(A.clone(fx)).api.proposals.submit(proposal));
    tryIt("script transaction", () => AtriumAPI.headless(A.clone(fx)).api.transaction("matrix", tx => {
      const sets = new Map();
      for (const o of ops) if (o.op === "add") tx.add(o.value, {doc: o.document});
      else sets.set(o.id, {...sets.get(o.id), [o.path[0]]: o.after});
      for (const [id, patch] of sets) tx.update(id, patch);
    }));
    for (const [path, got] of Object.entries(outcome)) assert.equal(got, ok2, name + " · " + path);
    if (!hasV1) continue;
    const v1 = {format: "atrium-ai", version: 1, project: fx.name,
      changes: ops.map(o => ({document: o.document, id: o.id, ref: byId(o.id).ref, field: o.path[0], before: o.before, after: o.after}))};
    const outcome1 = {};
    const tryV1 = (path, fn) => { try { fn(); outcome1[path] = true; } catch (e) { outcome1[path] = /already used|Invalid proposed text/.test(e.message) ? false : "error: " + e.message; } };
    tryV1("v1 inspect", () => P.inspectV1(v1, A.clone(fx)));
    tryV1("v1 checked apply", () => P.applyChecked(A.clone(fx), v1, {validate: A.validate}));
    tryV1("v1 AI apply", () => AtriumAI.apply(ctx(A.clone(fx)), v1));
    for (const [path, got] of Object.entries(outcome1)) assert.equal(got, ok1, name + " · " + path);
  }
  // Replaying the user's own editor edits (a detached tab, a reviewed Git merge) skips only the
  // designator rules: guards, code fields and the validator still apply.
  const dup = P.guarded(fx, "workspace-edit", [set(C1, "ref", "J2")]), replayed = {designators: false};
  assert.throws(() => P.inspect(dup, A.clone(fx)), /already used/);
  P.inspect(dup, A.clone(fx), undefined, 0, replayed);
  assert.equal(P.applyChecked(A.clone(fx), dup, {...replayed, validate: A.validate}), 1);
  assert.throws(() => P.applyChecked(A.clone(fx), P.guarded(fx, "workspace-edit", [{...set(C1, "ref", "J2"), before: "stale"}]), {...replayed, validate: A.validate}), /changed since/);
  assert.throws(() => P.applyChecked(A.clone(fx), P.guarded(fx, "workspace-edit", [{op: "set", target: "document", id: s.id, path: ["scripts"], after: "x"}]), replayed), /code/);
}

console.log("PASS proposals: code fields refused, validated on a copy, stale guards re-checked on the live project, one v1 field list");
