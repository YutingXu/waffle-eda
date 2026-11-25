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
console.log("PASS proposals: code fields refused, validated on a copy, stale guards re-checked on the live project, one v1 field list");
