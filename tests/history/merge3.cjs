"use strict";
// Semantic three-way merge (app/history/merge3.js): the Git merge driver and the merge view use it.
// Branch scenarios on the example project: different parts moved on each side (auto), the same part
// moved on both (one conflict, resolvable as ours, theirs or both), a net renamed on one side and a
// part added on the other (auto, and the new part follows the rename), comments, deletes against
// edits, document-level fields, keyed ordering, the driver entry point and the file layout.
const assert = require("node:assert/strict"), path = require("node:path");
for (const name of ["model", "parts", "eco", "merge3"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const M = globalThis.AtriumMerge3;
const clone = v => JSON.parse(JSON.stringify(v));

function run() {
  const base = AtriumParts.example();
  const pcb = p => p.documents.find(d => d.kind === "pcb"), sch = p => p.documents.find(d => d.kind === "schematic");
  const part = (p, ref, kind = "pcb") => (kind === "pcb" ? pcb(p) : sch(p)).items.find(i => i.kind === "part" && i.ref === ref);
  const refs = pcb(base).items.filter(i => i.kind === "part").map(i => i.ref);
  assert.ok(refs.length >= 3, "the example board has parts");
  const [r1, r2] = refs;

  // 1. Different parts moved on each side: merges with no conflict and keeps both moves.
  {
    const ours = clone(base), theirs = clone(base);
    part(ours, r1).x += 5; part(theirs, r2).y += 7;
    const r = M.merge(base, ours, theirs);
    assert.equal(r.conflicts.length, 0);
    assert.equal(part(r.project, r1).x, part(base, r1).x + 5);
    assert.equal(part(r.project, r2).y, part(base, r2).y + 7);
    assert.ok(r.changes.some(c => c.side === "ours" && c.objectId === part(base, r1).id));
    assert.ok(r.changes.some(c => c.side === "theirs" && c.objectId === part(base, r2).id));
    // The same field changed the same way on both sides is not a conflict either.
    const both = clone(ours); part(both, r2).y += 7;
    assert.equal(M.merge(base, ours, both).conflicts.length, 0);
  }
  // 2. The same part moved differently on both sides: one conflict for that object, fields named.
  {
    const ours = clone(base), theirs = clone(base);
    part(ours, r1).x += 5; part(theirs, r1).x -= 3; part(theirs, r1).angle = 90; part(ours, r2).y += 1;
    const r = M.merge(base, ours, theirs);
    assert.equal(r.conflicts.length, 1);
    const c = r.conflicts[0];
    assert.equal(c.objectId, part(base, r1).id);
    assert.deepEqual(c.fields, ["x"]);
    assert.equal(c.status, "modified-both");
    assert.equal(c.docId, pcb(base).id);
    // ours/theirs both keep the non-conflicting field from the other side (angle from theirs).
    assert.equal(c.ours.x, part(base, r1).x + 5); assert.equal(c.ours.angle, 90);
    assert.equal(c.theirs.x, part(base, r1).x - 3); assert.equal(c.theirs.angle, 90);
    assert.equal(part(r.project, r1).x, part(base, r1).x + 5, "unresolved conflicts keep ours");
    assert.equal(part(r.project, r2).y, part(base, r2).y + 1, "other changes still merge");
    assert.equal(part(M.resolve(r, {[c.id]: "theirs"}), r1).x, part(base, r1).x - 3);
    const keepBoth = {[c.id]: "both"}, copyIds = new Map();
    const kept = M.resolve(r, keepBoth, copyIds), original = part(base, r1);
    const items = pcb(kept).items, index = items.findIndex(i => i.id === original.id), copy = items[index + 1];
    assert.equal(items.length, pcb(r.project).items.length + 1, "both adds one copy beside its original");
    assert.equal(copy.x, c.theirs.x, "the neighboring record is the copy of theirs");
    assert.notEqual(items[index].ref, copy.ref, "the copy gets a free designator");
    assert.ok(AtriumUUID.isV7(copy.id), "the new record gets a durable UUIDv7");
    assert.notEqual(copy.id, original.id);
    assert.equal(pcb(M.resolve(r, keepBoth, copyIds)).items[index + 1].id, copy.id, "a review keeps the same UUID when it is applied");
  }
  // 3. Net renamed on one side, a part added on the other: auto, and the new part is on the new name.
  {
    const ours = clone(base), theirs = clone(base), original = part(base, r1);
    part(ours, r1).x += 5;
    part(theirs, r1).y -= 3;
    part(theirs, r1).value = "chosen independently";
    const nativeConflicts = [{owner:pcb(base).id, id:original.id, kind:"part", fields:["at"]}];
    const result = M.merge(base, ours, theirs, {nativeConflicts});
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.conflicts[0].fields, ["x","y"]);
    assert.deepEqual([part(result.project, r1).x, part(result.project, r1).y], [original.x + 5, original.y]);
    const picked = part(M.resolve(result, {[result.conflicts[0].id]:"theirs"}), r1);
    assert.deepEqual([picked.x, picked.y, picked.value], [original.x, original.y - 3, "chosen independently"]);
  }
  {
    const ours = clone(base), theirs = clone(base);
    const net = pcb(base).items.find(i => typeof i.net === "string" && i.net)?.net;
    assert.ok(net, "the example has a routed net");
    const rename = p => { for (const d of p.documents) for (const i of d.items) {
      if (i.net === net) i.net = net + "_RENAMED";
      if (i.pinNets) for (const k of Object.keys(i.pinNets)) if (i.pinNets[k] === net) i.pinNets[k] = net + "_RENAMED";
      if ((i.kind === "netlabel" || i.kind === "power") && i.text === net) i.text = net + "_RENAMED";
    } };
    rename(ours);
    const template = clone(part(base, r1));
    const added = {...template, id: "added-part", ref: "R99", x: template.x + 20, pinNets: {1: net, 2: "GND"}};
    pcb(theirs).items.push(added);
    const r = M.merge(base, ours, theirs);
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual(r.renames.ours, {[net]: net + "_RENAMED"});
    const merged = pcb(r.project).items.find(i => i.id === "added-part");
    assert.ok(merged, "the added part is kept");
    assert.equal(merged.pinNets[1], net + "_RENAMED", "the added part follows the rename");
    assert.ok(!pcb(r.project).items.some(i => i.net === net), "no object is left on the old name");
    assert.equal(pcb(r.project).items.at(-1).id, "added-part", "theirs' new object keeps its place after its predecessor");
  }
  // A retarget beside a deletion is incomplete evidence for a net rename.
  {
    const design = Atrium.project("Partial net edit", AtriumParts.catalogue);
    const board = pcb(design);
    const track = id => ({id, kind: "track", layer: "Top", points: [[0, 0], [1, 0]], width: .2, net: "NET_A"});
    board.items.push(track("retarget"), track("remove"));
    const ours = clone(design), theirs = clone(design);
    pcb(ours).items[0].net = "NET_B";
    pcb(ours).items.pop();
    const added = {...clone(part(base, r1)), id: "new-part", ref: "R99", pinNets: {1: "NET_A"}};
    pcb(theirs).items.push(added);
    const result = M.merge(design, ours, theirs);
    assert.equal(result.conflicts.length, 0);
    assert.equal(pcb(result.project).items.find(i => i.id === added.id).pinNets[1], "NET_A",
      "partial retargeting keeps the other branch's new pin on the original net");
    assert.deepEqual(result.renames.ours, {});
  }
  // 4. Comments, deletes and document fields.
  {
    const ours = clone(base), theirs = clone(base);
    ours.review = [{id: "t1", text: "Check C1"}]; theirs.review = [{id: "t2", text: "Move J1"}];
    pcb(theirs).name = "Board B";
    const gone = part(base, r2).id;
    pcb(ours).items = pcb(ours).items.filter(i => i.id !== gone); part(theirs, r2).value = "22k";
    const r = M.merge(base, ours, theirs);
    assert.deepEqual(r.project.review.map(t => t.id), ["t1", "t2"], "comments from both sides");
    assert.equal(pcb(r.project).name, "Board B");
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].status, "deleted-ours");
    assert.ok(!pcb(r.project).items.some(i => i.id === gone), "ours (deleted) until resolved");
    assert.ok(pcb(M.resolve(r, {c1: "theirs"})).items.some(i => i.id === gone && i.value === "22k"));
    // Project name changed differently on both sides: a value conflict.
    const o2 = clone(base), t2 = clone(base); o2.name = "A"; t2.name = "B";
    const n = M.merge(base, o2, t2);
    assert.equal(n.conflicts.length, 1); assert.deepEqual(n.conflicts[0].path, ["name"]);
    assert.equal(M.resolve(n, {c1: "theirs"}).name, "B");
  }
  // 5. The driver entry point and the file layout (the editor's serializer, byte for byte).
  {
    const ours = clone(base), theirs = clone(base);
    part(ours, r1).x += 1; part(theirs, r2).x += 1;
    const out = JSON.parse(AtriumMergeDriver("{}", [base, ours, theirs].map(p => JSON.stringify(p)).join("\u001e")));
    assert.equal(out.conflicts.length, 0);
    const text = out.text;
    assert.equal(text, AtriumECO.serialize(JSON.parse(text)));
    const saved = globalThis.AtriumECO; delete globalThis.AtriumECO;
    try { assert.equal(M.serialize(JSON.parse(text)), text, "the driver's own serializer matches eco.js"); } finally { globalThis.AtriumECO = saved; }
    assert.throws(() => AtriumMergeDriver("{}", "x\u001ey"), /base, ours and theirs/);
    assert.throws(() => AtriumMergeDriver("{}", "{}\u001e{}\u001e{}"), /not a Waffle project/);
  }
  // 7. Concurrent edits to one object: fields merge, nested maps merge per key, only a field both
  //    sides changed differently conflicts, and every resolution is a valid project.
  {
    const id = part(base, r1).id;
    // Different fields of one part (move vs value): no conflict, both kept.
    let ours = clone(base), theirs = clone(base);
    part(ours, r1).x += 3; part(theirs, r1).value = "47k";
    let r = M.merge(base, ours, theirs);
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual([part(r.project, r1).x, part(r.project, r1).value], [part(base, r1).x + 3, "47k"]);
    assert.ok(r.changes.some(c => c.side === "both" && c.objectId === id), "listed as merged from both sides");
    // Different pins of one part on different nets: pinNets merge per pin.
    ours = clone(base); theirs = clone(base);
    const pins = Object.keys(part(base, r1).pinNets || {});
    if (pins.length >= 2) {
      part(ours, r1).pinNets[pins[0]] = "NET_OURS"; part(theirs, r1).pinNets[pins[1]] = "NET_THEIRS";
      r = M.merge(base, ours, theirs);
      assert.equal(r.conflicts.length, 0, "different pins of one part");
      assert.deepEqual([part(r.project, r1).pinNets[pins[0]], part(r.project, r1).pinNets[pins[1]]], ["NET_OURS", "NET_THEIRS"]);
    }
    // Parameters: different keys merge, the same key changed differently conflicts on that key only.
    ours = clone(base); theirs = clone(base);
    part(ours, r1).parameters = {...part(base, r1).parameters, MPN: "A-1", Tolerance: "1%"};
    part(theirs, r1).parameters = {...part(base, r1).parameters, MPN: "B-2", Power: "0.1W"};
    r = M.merge(base, ours, theirs);
    assert.equal(r.conflicts.length, 1);
    assert.deepEqual(r.conflicts[0].fields, ["parameters.MPN"]);
    const pt = M.resolve(r, {[r.conflicts[0].id]: "theirs"}), po = M.resolve(r, {[r.conflicts[0].id]: "ours"});
    assert.deepEqual([part(pt, r1).parameters.MPN, part(pt, r1).parameters.Tolerance, part(pt, r1).parameters.Power], ["B-2", "1%", "0.1W"], "theirs keeps our other keys");
    assert.deepEqual([part(po, r1).parameters.MPN, part(po, r1).parameters.Tolerance, part(po, r1).parameters.Power], ["A-1", "1%", "0.1W"], "ours keeps their other keys");
    // Both delete one part: no conflict. Delete against a move: one conflict, and both answers are valid projects.
    ours = clone(base); theirs = clone(base);
    pcb(ours).items = pcb(ours).items.filter(i => i.id !== id); pcb(theirs).items = pcb(theirs).items.filter(i => i.id !== id);
    assert.equal(M.merge(base, ours, theirs).conflicts.length, 0);
    ours = clone(base); theirs = clone(base);
    pcb(ours).items = pcb(ours).items.filter(i => i.id !== id); part(theirs, r1).x += 1;
    r = M.merge(base, ours, theirs);
    assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].status, "deleted-ours");
    assert.ok(!part(M.resolve(r, {}), r1) && part(M.resolve(r, {[r.conflicts[0].id]: "theirs"}), r1).x === part(base, r1).x + 1);
    for (const p of [M.resolve(r, {}), M.resolve(r, {[r.conflicts[0].id]: "theirs"})]) Atrium.validate(M.parse(M.serialize(p), "merged"));
    // A track reshaped differently on both sides: one conflict on its points; the same reshape: none.
    const tr = pcb(base).items.find(i => i.kind === "track");
    if (tr) {
      ours = clone(base); theirs = clone(base);
      const t = p => pcb(p).items.find(i => i.id === tr.id);
      t(ours).points = t(ours).points.map(q => [q[0] + 1, q[1]]); t(theirs).points = t(theirs).points.map(q => [q[0], q[1] + 1]);
      r = M.merge(base, ours, theirs);
      assert.equal(r.conflicts.length, 1); assert.deepEqual(r.conflicts[0].fields, ["points"]);
      t(theirs).points = clone(t(ours).points);
      assert.equal(M.merge(base, ours, theirs).conflicts.length, 0);
    }
  }
  // 8. Both sides add a part under one designator (different ids): theirs is renumbered on the sheet
  //    and the board alike, to a designator free everywhere; gates and R? are left alone.
  {
    const ours = clone(base), theirs = clone(base);
    const add = (p, kind, id, ref, extra = {}) => (kind === "pcb" ? pcb(p) : sch(p)).items.push({...clone(part(base, r1, kind)), id, ref, ...extra});
    add(ours, "schematic", "o-sch", "R90"); add(ours, "pcb", "o-pcb", "R90", {x: 1});
    add(theirs, "schematic", "t-sch", "R90"); add(theirs, "pcb", "t-pcb", "R90", {x: 2});
    add(ours, "schematic", "o-u", "U90", {gate: "A"}); add(theirs, "schematic", "t-u", "U90", {gate: "B"});   // two gates of one part
    add(ours, "schematic", "o-q", "R?"); add(theirs, "schematic", "t-q", "R?");                              // not annotated yet
    add(ours, "schematic", "o-91", "R91");                                                                    // R91 is taken
    const r = M.merge(base, ours, theirs);
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual(r.renumbered.map(x => [x.from, x.to, x.ids.sort()]), [["R90", "R92", ["t-pcb", "t-sch"]]]);
    const byId = new Map(r.project.documents.flatMap(d => d.items).map(i => [i.id, i]));
    assert.deepEqual(["o-sch", "o-pcb", "t-sch", "t-pcb", "t-u", "t-q"].map(k => byId.get(k).ref), ["R90", "R90", "R92", "R92", "U90", "R?"]);
    assert.ok(r.changes.some(c => c.status === "renumbered" && c.from === "R90" && c.to === "R92"), "listed with the merged changes");
    assert.deepEqual(JSON.parse(AtriumMergeDriver("{}", [base, ours, theirs].map(p => JSON.stringify(p)).join("\u001e"))).renumbered, [{from: "R90", to: "R92"}]);
    assert.equal(M.merge(base, ours, theirs, {renumber: false}).renumbered.length, 0);
    // One side alone adding a second R90 (its own duplicate) is not the merge's to fix.
    const solo = clone(base); add(solo, "schematic", "s1", "R95"); add(solo, "schematic", "s2", "R95");
    assert.equal(M.merge(base, solo, clone(base)).renumbered.length, 0);
  }
  // A schematic collision changes the matching placement, not an unrelated board reference.
  {
    const design = Atrium.project("Designator domains", AtriumParts.catalogue);
    const ours = clone(design), theirs = clone(design);
    sch(ours).items.push({...part(base, r1, "schematic"), id: "our-sheet-part", ref: "R7", link: "ours"});
    sch(theirs).items.push({...part(base, r1, "schematic"), id: "their-sheet-part", ref: "R7", link: "theirs"});
    const placement = {...part(base, r1), id: "board-part", ref: "R7", link: "board-only"};
    pcb(theirs).items.push(placement);
    const result = M.merge(design, ours, theirs);
    assert.equal(pcb(result.project).items[0].ref, "R7", "the board-only designator did not clash");
    assert.deepEqual(result.renumbered.map(row => row.ids), [["their-sheet-part"]]);

    placement.link = "theirs";
    const linked = M.merge(design, ours, theirs);
    assert.equal(pcb(linked.project).items[0].ref, "R8", "a linked placement follows its schematic part");
  }
  // 9. An item moved to another sheet is one object: moved to different sheets on each side, or moved
  //    against a delete, is one conflict, and every merge and resolution keeps each id once.
  {
    const design = Atrium.project("Moves", AtriumParts.catalogue), first = sch(design);
    first.id = "sheet-a";
    first.items.push({id: "K", kind: "label", x: 0, y: 0, text: "Keep"}, {id: "L", kind: "label", x: 1, y: 1, text: "Note"});
    design.documents.push({...clone(first), id: "sheet-b", name: "B", items: [{id: "P", kind: "label", x: 5, y: 5, text: "Before"}, {id: "Q", kind: "label", x: 6, y: 6, text: "After"}]},
      {...clone(first), id: "sheet-c", name: "C", items: []});
    const doc = (p, id) => p.documents.find(d => d.id === id);
    const where = p => p.documents.filter(d => d.items.some(i => i.id === "L")).map(d => d.id);
    const move = (p, to, at = doc(p, to).items.length, x) => {
      const from = p.documents.find(d => d.items.some(i => i.id === "L")), item = from.items.find(i => i.id === "L");
      from.items = from.items.filter(i => i !== item); if (x != null) item.x = x; doc(p, to).items.splice(at, 0, item);
    };
    const valid = p => Atrium.validate(M.parse(M.serialize(p), "merged"));
    // Moved to different sheets: ours' sheet until resolved; theirs and both answers are valid too.
    let ours = clone(design), theirs = clone(design);
    move(ours, "sheet-b", 1); move(theirs, "sheet-c");
    let r = M.merge(design, ours, theirs);
    assert.deepEqual(where(r.project), ["sheet-b"], "one copy, on our sheet");
    assert.deepEqual(doc(r.project, "sheet-b").items.map(i => i.id), ["P", "L", "Q"], "in our place on that sheet");
    assert.equal(r.conflicts.length, 1);
    let c = r.conflicts[0];
    assert.deepEqual([c.objectId, c.status, c.fields, c.docId], ["L", "modified-both", ["document"], "sheet-b"]);
    assert.deepEqual(c.documents, {base: "sheet-a", ours: "sheet-b", theirs: "sheet-c"});
    assert.ok(!Object.keys(c.ours).some(k => k.startsWith("\u0000")) && !Object.keys(c.sides.theirs).some(k => k.startsWith("\u0000")), "no internal field leaks");
    valid(r.project);
    const picked = M.resolve(r, {[c.id]: "theirs"});
    assert.deepEqual(where(picked), ["sheet-c"]); valid(picked);
    const kept = M.resolve(r, {[c.id]: "both"});
    assert.deepEqual(where(kept), ["sheet-b"]);
    assert.equal(doc(kept, "sheet-c").items.length, 1, "both keeps a copy of theirs on their sheet");
    assert.notEqual(doc(kept, "sheet-c").items[0].id, "L"); valid(kept);
    // Deleted on one side, moved (and edited) on the other: one conflict that keeps ours, either way round.
    ours = clone(design); theirs = clone(design);
    doc(ours, "sheet-a").items = doc(ours, "sheet-a").items.filter(i => i.id !== "L"); move(theirs, "sheet-b", 0, 9);
    r = M.merge(design, ours, theirs);
    assert.deepEqual(where(r.project), [], "our delete stands until resolved");
    assert.deepEqual(r.conflicts.map(x => [x.objectId, x.status]), [["L", "deleted-ours"]]);
    valid(r.project);
    const back = M.resolve(r, {[r.conflicts[0].id]: "theirs"});
    assert.deepEqual([where(back), doc(back, "sheet-b").items.find(i => i.id === "L").x], [["sheet-b"], 9]); valid(back);
    r = M.merge(design, theirs, ours);
    assert.deepEqual([where(r.project), r.conflicts.map(x => x.status)], [["sheet-b"], ["deleted-theirs"]]);
    assert.deepEqual(where(M.resolve(r, {[r.conflicts[0].id]: "theirs"})), []);
    // Moved on one side, edited on the other: merges by itself onto the new sheet.
    ours = clone(design); theirs = clone(design);
    move(ours, "sheet-c"); doc(theirs, "sheet-a").items.find(i => i.id === "L").text = "Edited";
    r = M.merge(design, ours, theirs);
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual([where(r.project), doc(r.project, "sheet-c").items[0].text], [["sheet-c"], "Edited"]);
    assert.ok(r.changes.some(x => x.objectId === "L" && x.docId === "sheet-c"), "listed on the sheet it now sits on");
    // Moved to the same sheet on both sides: no conflict.
    ours = clone(design); theirs = clone(design); move(ours, "sheet-c"); move(theirs, "sheet-c");
    r = M.merge(design, ours, theirs);
    assert.deepEqual([where(r.project), r.conflicts.length], [["sheet-c"], 0]);
    // Moved (and edited) onto a sheet the other side deleted: a conflict, not a silent return to the old sheet.
    ours = clone(design); theirs = clone(design);
    move(ours, "sheet-b", 0, 9); theirs.documents = theirs.documents.filter(d => d.id !== "sheet-b");
    r = M.merge(design, ours, theirs);
    assert.deepEqual(r.conflicts.map(x => [x.objectId, x.status, x.fields, x.documents]), [["L", "deleted-theirs", ["document"], {base: "sheet-a", ours: "sheet-b", theirs: "sheet-a"}]]);
    assert.deepEqual([where(r.project), doc(r.project, "sheet-b").items.map(i => i.id)], [["sheet-b"], ["L"]], "ours kept: their sheet comes back with our item only");
    valid(r.project);
    let side = M.resolve(r, {[r.conflicts[0].id]: "theirs"});
    assert.deepEqual([where(side), doc(side, "sheet-b"), doc(side, "sheet-a").items.find(i => i.id === "L").x], [["sheet-a"], undefined, 9], "theirs: the sheet stays deleted, the item stays on its sheet");
    valid(side);
    // Their sheets both deleted: the conflict keeps ours, and the merge holds it.
    ours = clone(design); theirs = clone(design);
    move(ours, "sheet-b"); theirs.documents = theirs.documents.filter(d => d.id !== "sheet-a" && d.id !== "sheet-b");
    r = M.merge(design, ours, theirs);
    assert.deepEqual(r.conflicts.map(x => [x.objectId, x.status, x.documents]), [["L", "deleted-theirs", {base: "sheet-a", ours: "sheet-b", theirs: undefined}]]);
    assert.deepEqual(where(r.project), ["sheet-b"]); valid(r.project);
    assert.deepEqual(where(M.resolve(r, {[r.conflicts[0].id]: "ours"})), ["sheet-b"]);
    side = M.resolve(r, {[r.conflicts[0].id]: "theirs"});
    assert.deepEqual([where(side), side.documents.map(d => d.id).filter(id => id.startsWith("sheet-"))], [[], ["sheet-c"]]); valid(side);
    // Ours moves onto sheet B and renames it; theirs deletes it: the sheet and the item are two conflicts, every answer valid.
    ours = clone(design); theirs = clone(design);
    move(ours, "sheet-b"); doc(ours, "sheet-b").name = "B2"; theirs.documents = theirs.documents.filter(d => d.id !== "sheet-b");
    r = M.merge(design, ours, theirs);
    assert.deepEqual(r.conflicts.map(x => [x.objectId, x.status]), [["sheet-b", "deleted-theirs"], ["L", "deleted-theirs"]]);
    for (const a of ["ours", "theirs"]) for (const b of ["ours", "theirs"]) {
      side = M.resolve(r, {[r.conflicts[0].id]: a, [r.conflicts[1].id]: b});
      assert.deepEqual(where(side), [b === "ours" ? "sheet-b" : "sheet-a"], a + "/" + b); valid(side);
    }
    // A sheet whose only item moved onto it, renamed differently on each side: its name conflicts, not the whole sheet.
    ours = clone(design); theirs = clone(design);
    move(ours, "sheet-c"); doc(ours, "sheet-c").name = "Ours"; doc(theirs, "sheet-c").name = "Theirs";
    r = M.merge(design, ours, theirs);
    assert.deepEqual(r.conflicts.map(x => x.path.slice(1).map(p => p.id || p)), [["sheet-c", "name"]]);
    for (const a of ["ours", "theirs"]) assert.deepEqual(where(M.resolve(r, {[r.conflicts[0].id]: a})), ["sheet-c"], "the moved item stays when " + a + " names the sheet");
  }
  // 10. Cross-document matrix: each side does one thing to item L (nothing, edit, move to sheet B, move
  //     to sheet C, delete) and one thing to the sheets (nothing, delete A, B, C, A+B or A+C, rename B).
  //     Every merge validates; L is kept once where the merge says, or dropped only by a clean delete
  //     or a conflict that keeps our delete; and every answer to every conflict validates and puts L
  //     where the chosen side has it.
  {
    const design = Atrium.project("Matrix", AtriumParts.catalogue), first = sch(design);
    design.documents = design.documents.filter(d => d.kind === "schematic");
    const label = (id, x) => ({id, kind: "label", x, y: 0, text: id});
    Object.assign(first, {id: "sheet-a", items: [label("K", 0), label("L", 1), label("M", 2)]});
    design.documents.push({...clone(first), id: "sheet-b", name: "B", items: [label("P", 5), label("Q", 6)]}, {...clone(first), id: "sheet-c", name: "C", items: [label("R", 7)]},
      {...clone(first), id: "sheet-d", name: "D", items: []});
    const doc = (p, id) => p.documents.find(d => d.id === id);
    const find = (p, id) => { const out = []; for (const d of p.documents) for (const i of d.items) if (i.id === id) out.push([d.id, i]); return out; };
    const items = {
      unchanged: () => {},
      edit: (p, side) => { find(p, "L")[0][1].text = side; },
      moveB: p => { const [[from, it]] = find(p, "L"); doc(p, from).items = doc(p, from).items.filter(i => i !== it); doc(p, "sheet-b").items.splice(1, 0, it); },
      moveC: p => { const [[from, it]] = find(p, "L"); doc(p, from).items = doc(p, from).items.filter(i => i !== it); doc(p, "sheet-c").items.push(it); },
      delete: p => { for (const d of p.documents) d.items = d.items.filter(i => i.id !== "L"); }
    };
    const drop = (...ids) => p => { p.documents = p.documents.filter(d => !ids.includes(d.id)); };
    const sheets = {none: () => {}, delA: drop("sheet-a"), delB: drop("sheet-b"), delC: drop("sheet-c"), delAB: drop("sheet-a", "sheet-b"), delAC: drop("sheet-a", "sheet-c"),
      renameB: p => { if (doc(p, "sheet-b")) doc(p, "sheet-b").name = "Renamed"; }};
    const side = (name, item, sheet) => { const p = clone(design); items[item](p, name); sheets[sheet](p); return p; };
    const valid = (p, what) => { try { Atrium.validate(M.parse(M.serialize(p), "merged")); } catch (e) { assert.fail(what + ": " + e.message); } };
    const once = (p, what) => { const seen = new Set(); for (const d of p.documents) for (const i of d.items) { assert.ok(!seen.has(i.id), what + ": " + i.id + " twice"); seen.add(i.id); } };
    const at = p => find(p, "L").map(([d, i]) => [d, i.text]), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const base = at(design)[0];
    let combos = 0, conflicted = 0;
    for (const oi of Object.keys(items)) for (const os of Object.keys(sheets)) for (const ti of Object.keys(items)) for (const ts of Object.keys(sheets)) {
      const what = "ours " + oi + "+" + os + " / theirs " + ti + "+" + ts, O = side("ours", oi, os), T = side("theirs", ti, ts);
      let r;
      assert.doesNotThrow(() => { r = M.merge(design, O, T); }, what);
      combos++;
      valid(r.project, what); once(r.project, what);
      const o = at(O)[0], t = at(T)[0], got = at(r.project), c = r.conflicts.find(x => x.objectId === "L");
      const sheetsOf = x => x.documents || {base: base[0], ours: o?.[0], theirs: t?.[0]};
      if (c) {
        conflicted++;
        const moved = [o, t].some(x => x && x[0] !== base[0]);
        assert.equal(!!c.documents, moved, what + ": a conflict on a moved L names each side's sheet");
        assert.deepEqual(sheetsOf(c), {base: "sheet-a", ours: o?.[0], theirs: t?.[0]}, what);
        assert.deepEqual(got, c.ours === undefined ? [] : [[sheetsOf(c).ours, c.ours.text]], what + ": the merge holds what the conflict keeps (ours)");
      } else if (!o || !t) {
        // Deleted on one side: dropped if the other left it as it was, else a conflict on its sheet keeps ours.
        const sheetConflict = r.conflicts.some(x => x.path.length === 2 && x.path[1].id === (o || t)?.[0]);
        assert.ok(!o && !t || same(o || t, base) || sheetConflict, what + ": L lost without a conflict");
        assert.deepEqual(got, o && !same(o, base) ? [o] : [], what);
      } else {
        const sheet = o[0] !== base[0] ? o[0] : t[0], text = o[1] !== base[1] ? o[1] : t[1];
        assert.ok(o[0] === base[0] || t[0] === base[0] || o[0] === t[0], what + ": moved apart without a conflict");
        assert.ok(o[1] === base[1] || t[1] === base[1] || o[1] === t[1], what + ": edited apart without a conflict");
        assert.deepEqual(got, [[sheet, text]], what);
        assert.ok(doc(O, sheet) && doc(T, sheet) || !doc(design, sheet), what + ": moved onto a sheet the other side deleted, without a conflict");
      }
      // Every combination of answers.
      const ids = r.conflicts.map(x => x.id), options = r.conflicts.map(x => x.both ? ["ours", "theirs", "both"] : ["ours", "theirs"]);
      const pick = (k, choices) => {
        if (k === ids.length) {
          const how = what + " " + JSON.stringify(choices), p = M.resolve(r, choices);
          valid(p, how); once(p, how);
          if (!c) return;
          const choice = choices[c.id];
          const S = sheetsOf(c), expect = choice === "both" ? [[S.ours, c.ours.text]] : c[choice] === undefined ? [] : [[S[choice], c[choice].text]];
          assert.deepEqual(at(p), expect, how + ": L where the chosen side has it");
          if (choice === "both") assert.ok(p.documents.find(d => d.id === S.theirs)?.items.some(i => i.id !== "L" && i.text === c.theirs.text), how + ": a copy of theirs on their sheet");
          return;
        }
        for (const ch of options[k]) pick(k + 1, {...choices, [ids[k]]: ch});
      };
      pick(0, {});
    }
    assert.equal(combos, 35 * 35);
    console.log("merge3: cross-document matrix, " + combos + " merges, " + conflicted + " with a conflict on the moved item");
  }
  // 11. Speed: 20k labels, half moved to another sheet on one side, while the other edits one.
  {
    const design = Atrium.project("Moves", AtriumParts.catalogue), first = sch(design), N = 20000;
    design.documents = design.documents.filter(d => d.kind === "schematic");
    first.id = "sheet-a";
    for (let i = 0; i < N; i++) first.items.push({id: "L" + i, kind: "label", x: i % 100, y: Math.floor(i / 100), text: "t" + i});
    design.documents.push({...clone(first), id: "sheet-b", name: "B", items: []});
    const ours = clone(design), theirs = clone(design);
    ours.documents[1].items.push(...ours.documents[0].items.splice(0, N / 2).reverse());
    theirs.documents[0].items[3].text = "edited";
    const t0 = Date.now(), r = M.merge(design, ours, theirs), ms = Date.now() - t0;
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual(r.project.documents.map(d => d.items.length), [N / 2, N / 2]);
    assert.deepEqual(r.project.documents[1].items.slice(-4).map(i => [i.id, i.text]), [["L3", "edited"], ["L2", "t2"], ["L1", "t1"], ["L0", "t0"]], "in our order, with their edit");
    console.log("merge3: 20k labels, 10k moved across sheets, merged in " + ms + " ms");
    assert.ok(ms < 20000);
  }
  // 6. Speed: two sides each moving 200 parts of a 25.6k-object board.
  {
    require("../pcb/dense-board.js");
    const {d} = makeAtriumBenchmarkBoard(160);
    const big = Atrium.project("Dense", AtriumParts.catalogue); big.documents = [d];
    const ours = clone(big), theirs = clone(big);
    const parts = i => i.documents[0].items.filter(x => x.kind === "part");
    parts(ours).slice(0, 200).forEach(p => { p.x += 1; }); parts(theirs).slice(200, 400).forEach(p => { p.y += 1; });
    const t0 = Date.now(), r = M.merge(big, ours, theirs), ms = Date.now() - t0;
    assert.equal(r.conflicts.length, 0); assert.equal(r.stats.changes, 400);
    console.log("merge3: 25.6k-object board, 400 changes merged in " + ms + " ms");
    assert.ok(ms < 20000);
  }
  console.log("PASS three-way merge: different parts auto-merge, the same part conflicts (ours/theirs/both), net rename + added part auto-merge, comments, deletes, document fields, driver entry, file layout, 25.6k board.");
}
globalThis.__testDone = Promise.resolve().then(run);
globalThis.__testDone.catch(error => { console.error(error); process.exitCode = 1; });
