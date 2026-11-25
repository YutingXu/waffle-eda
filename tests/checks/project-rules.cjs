"use strict";
// Project rules (app/checks/project-rules.js): project.rules is the one
// rule store, for the schematic and the layout. Covered: the default book; each board's view (memoised, what
// AtriumRules.stored returns); per-board scoping through setBoard and imports (absorb); ERC settings from the
// ERC rules, a scoped ERC rule kept out of them; validation; a newer book version set aside and restored; a
// same-version book from a newer minor format set aside rule by rule and written back unchanged; every
// corpus file's boards read their view of the book.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const f of ["model", "parts", "spatial", "sch-objects", "hierarchy", "board-shape", "stackup", "pcb-appearance", "pcb-pours", "altium-rules",
  "pcb-draw", "component-classes", "net-intent", "signals", "rules", "project-rules", "viastack", "polygon-pour", "import-link", "net-ties", "connectivity", "messages", "erc", "drc",
  "sch-appearance", "multichannel", "variants", "blocks", "pcb-text-rich", "pcb-text", "eco"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, R = AtriumRules, P = AtriumProjectRules, E = AtriumERC;
const clone = v => JSON.parse(JSON.stringify(v));
const boards = p => p.documents.filter(d => d.kind === "pcb");
const {nativeCAD} = require("../support/native-cad.cjs");
const F=AtriumFormat2, M=AtriumFormat2Model;

// ---------------------------------------------------------------- the default book and each board's view
{
  const p = A.project("Defaults"), b = boards(p)[0];
  const book = P.book(p);
  assert.equal(p.rules, undefined, "reading never writes the book");
  assert.equal(P.book(p), book, "the default book is one object until an edit");
  assert.deepEqual([book.format, book.version, book.units], ["atrium-rules", 3, "mm"]);
  const semantics = list => list.map(({id, ...rule}) => rule);
  assert.deepEqual(semantics(book.list), semantics(R.migrate(R.defaults()).list), "the default constraints and priorities");
  assert.deepEqual(book.list.map(rule => rule.id), P.book(A.project("Another unsaved view")).list.map(rule => rule.id), "viewing defaults does not allocate IDs");
  P.validate(book);
  const view = P.forBoard(p, b);
  assert.equal(P.forBoard(p, b), view, "a board's view is memoised by the book");
  assert.equal(R.stored(b, p), view, "and is what the rule engine reads");
  assert.equal(view.version, 2); R.validate(view);
  P.edit(p, bk => { bk.list.find(r => r.type === "clearance").gap = .3; });
  assert.ok(p.rules && p.rules !== book, "an edit stores a new book");
  const durable = M.fromEditor(p).manifest, ruleRows = [...durable.records()].filter(row => row.kind === "rule");
  assert.equal(ruleRows.length, book.list.length);
  assert.deepEqual(ruleRows.map(row => row.id).sort(), p.rules.list.map(rule => rule.id).sort());
  assert.ok(ruleRows.every(row => AtriumUUID.isV7(row.id)), "the first validated edit materializes real UUIDv7 records");
  assert.ok(ruleRows.every(row => row.id === row.value.id));
  assert.notEqual(P.forBoard(p, b), view, "a new book, a new view");
  assert.equal(R.stored(b, p).list.find(r => r.type === "clearance").gap, .3);
  assert.equal(b.rules, undefined, "nothing is written on the board");
  // R.store: one edit of the book; the result is the board's view.
  const set = clone(R.stored(b, p)); set.list.find(r => r.type === "width").min = .2;
  R.store(b, p, set);
  assert.equal(R.stored(b, p).list.find(r => r.type === "width").min, .2);
  A.validate(JSON.parse(JSON.stringify(p)));
}

// Conversion also rebinds a board-local waiver to its rule when legacy input
// uses the same ordinal on multiple boards.
{
  const p = A.project("Legacy rule identity"), a = boards(p)[0], b = A.sheet("pcb", "Second board");
  p.documents.push(b);
  const clearance = R.migrate(R.defaults()).list.find(rule => rule.type === "clearance");
  p.rules = {...P.book(p),list:[{...clearance,boards:[a.id]}, {...clearance,gap:.35,boards:[b.id]}]};
  for (const d of [a,b]) d.drcWaivers = [{id:A.id(),rule:clearance.name,ruleId:clearance.id}];
  const converted = M.fromEditor(p), ruleRows = [...converted.manifest.records()].filter(row => row.kind === "rule");
  assert.equal(ruleRows.length, 2);
  assert.ok(ruleRows.every(row => AtriumUUID.isV7(row.id) && row.id === row.value.id));
  assert.notEqual(ruleRows[0].id, ruleRows[1].id);
  for (const doc of [a,b]) {
    const file = converted.files.find(member => member.file.header.id === doc.id).file;
    const expected = ruleRows.find(row => row.value.boards.includes(doc.id));
    assert.equal(M.document(file).drcWaivers[0].ruleId, expected.id);
    assert.equal(doc.drcWaivers[0].ruleId, clearance.id, "conversion copies the input model");
  }
}

// ---------------------------------------------------------------- two boards
{
  const p = A.project("Two"), b1 = boards(p)[0], b2 = {...clone(b1), id: "board-2", name: "Board 2", items: []};
  p.documents.push(b2);
  // A rule for Board 2 only; Board 1 keeps its rules.
  P.edit(p, bk => { bk.list.push({...clone(bk.list.find(r => r.type === "width")), id: "w-b2", name: "Narrow", priority: 1, boards: [b2.id], min: .1}); });
  assert.ok(R.stored(b2, p).list.some(r => r.name === "Narrow") && !R.stored(b1, p).list.some(r => r.name === "Narrow"));
  // setBoard edits Board 1's view; a rule shared with Board 2 is the project's, Board 2's own rule stays.
  { const set = clone(P.forBoard(p, b1)); set.list.find(r => r.type === "clearance").gap = .4; P.edit(p, bk => P.setBoard(bk, p, b1, set)); }
  assert.equal(R.stored(b1, p).list.find(r => r.type === "clearance").gap, .4);
  assert.equal(R.stored(b2, p).list.find(r => r.type === "clearance").gap, .4, "a shared rule edited from one board is edited for both");
  assert.ok(R.stored(b2, p).list.some(r => r.name === "Narrow"));
  // A rule scoped to one board through the editor's extras (Boards field).
  { const set = clone(P.forBoard(p, b1)); set.list.push({...clone(set.list.find(r => r.type === "width")), id: "w-b1", name: "Wide", priority: 1, min: .5});
    P.edit(p, bk => P.setBoard(bk, p, b1, set, new Map([["w-b1", {boards: [b1.id]}]]))); }
  assert.ok(R.stored(b1, p).list.some(r => r.name === "Wide") && !R.stored(b2, p).list.some(r => r.name === "Wide"));
  P.validate(p.rules);
}
{
  // Two imported boards (AtriumImportLink.reconcile → absorb): each keeps its own rules.
  const p = A.project("Imported"), mk = (id, gap) => {
    const set = R.migrate(R.defaults()); set.list.find(r => r.type === "clearance").gap = gap;
    return {...clone(boards(p)[0]), id, name: id, items: [], rules: R.validate(R.normalize(set))};
  };
  const a = mk("import-a", .15), b = mk("import-b", .35);
  p.documents = [...p.documents.filter(d => d.kind !== "pcb"), a, b];
  AtriumImportLink.reconcile(p, [a, b]);
  assert.equal(a.rules, undefined); assert.equal(b.rules, undefined);
  assert.equal(R.stored(a, p).list.find(r => r.type === "clearance").gap, .15);
  assert.equal(R.stored(b, p).list.find(r => r.type === "clearance").gap, .35);
  assert.ok(p.rules.list.every(rule => AtriumUUID.isV7(rule.id)));
  A.validate(JSON.parse(JSON.stringify(p)));
  // A net identifier scope hint becomes the ERC rule, once.
  const q = A.project("Hint"), sheet = {...clone(q.documents.find(d => d.kind === "schematic")), id: "hint-sheet", netScope: "hierarchical"};
  q.documents.push(sheet);
  AtriumImportLink.reconcile(q, [sheet]);
  assert.equal(E.settings(q).scope, "hierarchical");
  const scope = P.book(q).list.filter(r => r.type === "ercNetScope");
  assert.equal(scope.length, 1);
  assert.ok(AtriumUUID.isV7(scope[0].id));
  P.setNetScope(q, "flat");
  assert.equal(P.book(q).list.find(r => r.type === "ercNetScope").id, scope[0].id);
}

// ---------------------------------------------------------------- ERC rules
{
  const p = A.project("Erc");
  P.edit(p, bk => {
    bk.list.push({id: "erc-unconnectedPins", type: "ercUnconnectedPins", name: "UnconnectedPins", enabled: true, priority: 1, scope: AtriumDesignQueryRecord.selector("all"), severity: "error", where: "schematic"});
    bk.list.push({id: "erc-matrix", type: "ercPinMatrix", name: "ConnectionMatrix", enabled: true, priority: 1, scope: AtriumDesignQueryRecord.selector("all"), where: "schematic", matrix: {"2,2": "warning"}});
    // A scoped ERC rule (no Altium equivalent): it applies per finding, not to the settings.
    bk.list.push({id: "erc-tp", type: "ercUnconnectedPins", name: "TestPointsUnconnected", enabled: true, priority: 2, scope: AtriumDesignQueryRecord.selector("componentclass", "TestPoints"), severity: "off", where: "schematic"});
  });
  const s = E.settings(p);
  assert.equal(s.checks.unconnectedPins, "Error");
  assert.equal(s.matrix["2,2"], "Warning");
  assert.deepEqual(P.erc(p), E.stored(s), "P.erc is the settings in AtriumERC.stored's shape");
  assert.ok(P.book(p).list.some(r => r.id === "erc-tp"), "the scoped rule stays in the book");
  P.edit(p, bk => { bk.list.find(r => r.id === "erc-unconnectedPins").severity = "fatal"; });
  assert.equal(E.settings(p).checks.unconnectedPins, "Fatal");
  assert.equal(R.stored(boards(p)[0], p).list.some(r => P.isErc(r.type)), false, "ERC rules are not board rules");
  assert.equal(P.erc(A.project("Plain")), null, "the default book gives the default settings");
}

// ---------------------------------------------------------------- validation
{
  const p = A.project("Valid"); P.edit(p, () => {});
  const ok = clone(p.rules);
  assert.throws(() => P.validate({...clone(ok), list: [...ok.list, {id: "x", type: "ercNoSuchCheck", name: "X", enabled: true, priority: 1, scope: AtriumDesignQueryRecord.selector("all")}]}), /Unknown schematic rule type/);
  assert.throws(() => P.validate({...clone(ok), list: [{...ok.list[0], severity: "loud"}]}), /severity/);
  assert.throws(() => P.validate({...clone(ok), version: 2}), /pre-release/);
  assert.throws(() => P.validate({...clone(ok), mirror: {}}), /unsupported setting mirror/);
  assert.throws(() => P.validate({...clone(ok), keys: {netClasses: {X: ["A"]}}}), /rule sets and currents only/, "class keys are the signal model's");
  assert.throws(() => A.validate({...clone(p), documents: p.documents.map(d => d.kind === "pcb" ? {...d, rules: R.defaults()} : d)}), /pre-release Waffle format/);
}

// Native future records carry the original nested bytes across edits of unrelated rules.
{
  const p=AtriumParts.example();
  P.edit(p,book=>{book.keys={...book.keys,ruleSets:[{name:"Default",enabled:true}]};});
  const manifest=M.fromEditor(p).manifest, rows=Array.from(manifest.records(),r=>clone(r));
  const settings=rows.find(row=>row.kind==="projectSetting"&&row.key==="rules");
  const clearance=rows.find(row=>row.kind==="rule"&&row.value.type==="clearance");
  const width=rows.find(row=>row.kind==="rule"&&row.value.type==="width");
  settings.value.wireBondProfiles=[{name:"low"}];
  settings.value.keys.ruleSets[0].colour="#3366ff";
  clearance.value.dieAware=true;
  const extra={kind:"futureDieAttach",id:"zz-future-rule",value:{fillet:100000}};
  rows.push(extra);
  const encoded=header=>[F.canonical({...manifest.header,formatVersion:"2.1",...header}),
    ...rows.slice().sort((a,b)=>F.compare(a.id,b.id)).map(r=>F.canonical(r))].join("\n")+"\n";
  const future=M.parse(encoded({}));
  assert.equal(future.isOpaque(extra.id),true);
  const amended=F.edit(future,{put:[{...width,value:{...width.value,min:200000}}]});
  const saved=M.parse(F.serialize(amended));
  for(const row of [settings,clearance,extra]) assert.deepEqual(saved.get(row.id),row);
  assert.equal(saved.get(width.id).value.min,200000);
  assert.throws(()=>F.edit(saved,{remove:[extra.id]}),e=>e.code==="read-only-format");

  const current=M.manifest(saved).project.rules;
  const aside=P.setAside(clone(current));
  assert.ok(aside.fields[clearance.value.id] && aside.keys.wireBondProfiles && aside.entries["keys.ruleSets"].default,
    "the rule editor classifies fields it cannot evaluate");
  const guarded=M.parse(encoded({compatibleWith:"2.0",requires:["rule-store-v4"]}));
  assert.equal(guarded.readOnly,true);
  assert.throws(()=>F.edit(guarded,{remove:[width.id]}),e=>e.code==="read-only-format");
}

for (const design of [nativeCAD("sample-sensor"),nativeCAD("signal-board"),nativeCAD("eco-benchmark"),
  nativeCAD("families"),nativeCAD("design-diff"),...["reroute","pin-swap","reannotate","merge-nets","delete-add"].map(r=>nativeCAD("design-diff",r))]) {
  for(const d of boards(design)) {
    assert.equal(d.rules,undefined,design.name);
    assert.equal(R.stored(d,design),P.forBoard(design,d),d.name);
    R.validate(R.stored(d,design));
  }
  if(design.rules) P.validate(design.rules);
}

// ---------------------------------------------------------------- a view read inside edit() is not kept stale
{
  const p = A.validate(A.project("Memo")), b1 = boards(p)[0];
  P.edit(p, bk => { const s = clone(P.forBoard(p, b1, bk)); s.list.find(r => r.type === "clearance").gap = .4; P.setBoard(bk, p, b1, s); });
  assert.equal(R.stored(b1, p).list.find(r => r.type === "clearance").gap, .4);
}
console.log("Project rules pass on ten native design states.");
