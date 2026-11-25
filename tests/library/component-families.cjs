"use strict";
const assert = require("node:assert/strict");
const {nativeCAD, nativeRoundTrip} = require("../support/native-cad.cjs");
for (const file of ["model", "parts", "connectivity", "rules", "pcb-appearance", "pcb-edit", "sch-objects", "sch-appearance",
  "sch-author", "eco", "bom", "variants", "kicad-export", "save-cache", "undo-store", "component-families", "library-panel", "canvas"]) require(require("../support/app-source-paths.cjs").appFile(file + ".js"));
require("../../mcp/svg-canvas.js");
require("../../mcp/authoring.js");
const A = Atrium, F = AtriumComponentFamilies, L = AtriumLibrary, E = AtriumECO;
const member = (defId, part) => ({defId, part});
const get = (p, id) => p.library.find(d => d.id === id);
// Canonical live-state serialization is an equality oracle for undo and read-only views.
const save = p => E.serialize(p);

// Synthetic components deliberately have similar names and incompatible pin functions.
const fixture = nativeCAD("families");
const catalogue = fixture.library;
const entries = [member("a-q", "A"), member("b-q", "B"), member("b-g", "B")];

// BOM and assembly CSV identify the fitted component. The PCB always retains
// its placed package, even when only that side of the project is available.
for (const boardOnly of [false, true]) {
  const p = A.clone(fixture), V = AtriumVariants, K = AtriumKiCad;
  if (boardOnly) p.documents = p.documents.filter(d => d.kind === "pcb");
  const base = get(p, "b-g"), alt = get(p, "b-q");
  base.parameters = {MPN: "旧旧", Manufacturer: "Base", "Supplier Part Number": "BASE-SKU"};
  alt.parameters = {"Manufacturer Part Number": 'AFE "精密" Ω', Mfr: "製造商"};
  for (const d of p.documents) d.items.find(i => i.kind === "part").parameters = {"Mfr Part Number": "Instance Ω", MFG: "Instance lab"};
  function check(view, maker, mpn, sku, fitting) {
    const original = save(view), cell = s => '"' + s.replace(/"/g, '""') + '"';
    for (const doc of view.documents) {
      const row = AtriumBOM.collect(view, {source: doc.kind}).parts[0];
      const fp = fitting && doc.kind === "schematic" ? "QFN" : "BGA";
      assert.deepEqual([row.manufacturer, row.mpn, row.supplierPn, row.footprint], [maker, mpn, sku, fp], doc.kind);
      const csv = K.exportBOM(view, doc);
      assert.equal(csv.counts.components, 1);
      assert.equal(csv.content, '"Designator","Value","Footprint","Manufacturer","Manufacturer part number"\r\n' +
        ["U1", "Demo B", fp, maker, mpn].map(cell).join(",") + "\r\n");
    }
    assert.equal(save(view), original);
  }
  check(p, "Instance lab", "Instance Ω", "BASE-SKU", false);
  const variant = V.create(p, {name: "Assembly 精密"}), key = "u1-link";
  V.setParts(p, variant.id, [key], {alternate: {def: "b-q"}});
  V.setActive(p, variant.id);
  check(p, "製造商", 'AFE "精密" Ω', "", true);
  const fresh = A.validate(nativeRoundTrip(p));
  assert.equal(fresh.activeVariant, undefined, "the active view is local to the user");
  V.setActive(fresh, variant.id);
  check(fresh, "製造商", 'AFE "精密" Ω', "", true);
  check(JSON.parse(save(V.apply(fresh, variant.id))), "製造商", 'AFE "精密" Ω', "", true);
  V.setParts(p, variant.id, [key], {params: {MPN: "訂單 override", Manufacturer: null}});
  check(p, "", "訂單 override", "", true);
  assert.equal(V.resolve(p, variant.id)[key].params.MPN, "訂單 override");
  alt.parameters = {}; V.setParts(p, variant.id, [key], {params: null});
  check(p, "", "", "", true);
  // Older KiCad CSV exports accepted the generic part-number spelling too.
  base.parameters = {"PART NUMBER": "legacy-17"};
  delete p.activeVariant;
  for (const doc of p.documents) delete doc.items.find(i => i.kind === "part").parameters;
  assert.ok(K.exportBOM(p, p.documents[0].id).content.includes('"legacy-17"'));
}
{
  // An imported symbol and a separately defined physical footprint may share
  // only their designator/link. Parameter-only variants still inherit the symbol's SKU.
  const p = A.clone(fixture), pcb = p.documents[1], physical = get(p, "b-g");
  const fp = {id: "pcb-only", name: "Bare BGA", footprint: physical.footprint};
  p.library.push(fp); pcb.items[0].def = fp.id;
  const v = AtriumVariants.create(p, {name: "Marking"});
  AtriumVariants.setActive(p, v.id);
  AtriumVariants.setParts(p, v.id, ["u1-link"], {params: {Marking: "Ω"}});
  assert.equal(AtriumBOM.collect(p, {source: "pcb"}).parts[0].mpn, "b-g-order");
  assert.ok(AtriumKiCad.exportBOM(p, pcb).content.includes('"Example","b-g-order"'));
  AtriumVariants.setParts(p, v.id, ["u1-link"], {params: {"Manufacturer Part Number": null}});
  assert.equal(AtriumBOM.collect(p, {source: "pcb"}).parts[0].mpn, "");
  assert.ok(AtriumKiCad.exportBOM(p, pcb).content.includes('"Example",""'));
}

{
  const p = A.clone(fixture), W = AtriumAuthorV2, ctx = {project: () => p, page: items => ({items})};
  const hits = W.headless("find_parts", {query: "Analogue front ends"}, ctx).items;
  assert.deepEqual(hits.map(h => h.def_id).sort(), ["a-q", "b-g", "b-q"]);
  assert.ok(hits.every(h => h.untrusted_design_text.family === "Analogue front ends"));
  assert.throws(() => W.resolve(p, {query: "Analogue front ends"}), /exact definition ID/);
  assert.throws(() => W.resolve(p, {def: "Demo B"}), /exact definition ID/);
  assert.equal(W.resolve(p, {def: "b-g"}).id, "b-g");
  assert.equal(W.resolve(p, {query: "Analogue front ends", match: {mpn: "b-q-order"}}).id, "b-q");
}
{
  const p = AtriumParts.example(), before = save(p), objects = p.library.slice();
  assert.ok(!("componentFamilies" in p));
  assert.deepEqual(F.browse(p).map(r => r.parts[0].options[0].def), objects);
  assert.equal(save(p), before, "reading an ungrouped library leaves the live design unchanged");
  const id = F.create(p, "Passives", [member(objects[0].id, "R"), member(objects[1].id, "C")]);
  assert.equal(objects[0], p.library[0]);
  F.ungroup(p, id);
  assert.equal(save(p), before, "ungrouping restores the original design exactly");
}
{
  const p = A.project("Unplaced exact definitions", catalogue);
  // The browser gets the imported library name from its source binding.
  for (const definition of p.library) definition.sourceName = "Test parts.SchLib";
  const looseSym = {...catalogue[0], id: "loose-s", name: "Unpaired symbol"};
  delete looseSym.footprint;
  p.library.push(looseSym, {id: "loose-f", name: "QFN", footprint: catalogue[0].footprint},
    {...catalogue[0], id: "mirror", mirrorOf: "a-q"});
  const docs = E.serialize(p.documents), defs = E.serialize(p.library), refs = p.library.slice();
  const id = F.create(p, "Analogue front ends", entries);
  const rows = F.browse(p), family = rows[0];
  assert.equal(family.id, id);
  assert.deepEqual(rows.map(r => r.kind), ["family", "symbol", "footprint"]);
  assert.deepEqual(family.parts.map(x => [x.name, x.options.map(o => [o.id, o.packageName])]), [["A", [["a-q", "QFN"]]], ["B", [["b-q", "QFN"], ["b-g", "BGA"]]]]);
  assert.equal(family.parts[1].options[0].def, get(p, "b-q"));
  assert.deepEqual(F.browse(p, [get(p, "b-g")])[0].parts.map(x => x.options.map(o => o.id)), [["b-g"]]);
  assert.equal(rows[1].parts[0].options[0].footprint, null);
  assert.equal(rows[2].parts[0].options[0].symbol, null);
  assert.deepEqual(family.parts[0].options[0].symbol, {defId: "a-q", name: "Demo A", sourceName: "Test parts.SchLib"});
  assert.equal(E.serialize(p.documents), docs);
  assert.equal(E.serialize(p.library), defs);
  refs.forEach((d, i) => assert.equal(d, p.library[i]));
  assert.deepEqual(L.similar(p, get(p, "b-q")), [], "a sibling variant in the same source file is never an older copy");
  const a = F.create(p, "Separate group with overlapping names", [member("loose-s", "A")]);
  F.assign(p, a, [member("b-q", "B"), member("b-g", "B")]);
  assert.deepEqual(F.browse(p)[0].parts.map(x => x.name), ["A"]);
  const before = save(p);
  for (const bad of [[member("invalid", "A")], [member("a-q", " ")], [member("mirror", "B")], [member("a-q", "B"), member("a-q", "B")]]) {
    assert.throws(() => F.update(p, a, "rename on error", bad));
    assert.equal(save(p), before);
  }
  F.update(p, id, "Retitled family", entries);
  assert.deepEqual(F.memberships(p).get("b-q"), {id, name: "Retitled family", part: "B"});
  F.ungroup(p, a);
  F.ungroup(p, id, ["b-q"]);
  assert.ok(!F.memberships(p).has("b-q"));
  L.remove(p, "b-g");
  assert.deepEqual(p.componentFamilies[0].members, [member("a-q", "A")]);
}
{
  // Realistic legacy files may contain unrelated newer metadata. Family access stays
  // read-only on corrupt records, and editing known records preserves unknown fields.
  const p = A.project("Extensions", catalogue);
  p.componentFamilies = [{id: "bad", name: "Bad", members: [{}]}];
  const before = save(p);
  assert.equal(F.browse(p).length, 3);
  assert.throws(() => F.create(p, "New", entries), /family records/);
  assert.equal(save(p), before);
  p.componentFamilies = [{id: "good", name: "A", color: "green", members: [{...entries[0], note: "future field"}]}];
  F.update(p, "good", "B", [entries[0], entries[2]]);
  assert.equal(p.componentFamilies[0].color, "green");
  assert.equal(p.componentFamilies[0].members[0].note, "future field");
}
{
  const p = A.project("Exact placement", catalogue), [sch, pcb] = p.documents;
  const id = F.create(p, "AFE", entries);
  const options = F.browse(p)[0].parts.flatMap(part => part.options);
  for (const [n, o] of options.entries()) {
    const part = AtriumSchAuthor.placePart(p, {def: o.id, x: n * 25.4, y: 0});
    const actual = sch.items.find(i => i.ref === part.ref);
    assert.equal(actual.def, o.id);
    const sense = o.def.symbol.pins.find(pin => pin.name === "SENSE");
    AtriumSchAuthor.addNetLabel(p, {text: "SENSE" + n, at: {designator: part.ref, pin: sense.number}});
  }
  const docs = E.serialize(p.documents), defs = E.serialize(p.library);
  F.rename(p, id, "Measurement chips");
  assert.equal(E.serialize(p.documents), docs);
  assert.equal(E.serialize(p.library), defs);
  const plan = E.plan(p, {board: pcb.id});
  assert.deepEqual(plan.changes.filter(c => c.action === "addComponent").map(c => c.def).sort(), ["a-q", "b-g", "b-q"]);
  const applied = E.execute(p, plan);
  assert.equal(applied.failed, 0, JSON.stringify(applied.rows));
  const placed = pcb.items.filter(i => i.kind === "part");
  assert.deepEqual(placed.map(i => [i.def, Object.keys(i.pinNets).find(k => i.pinNets[k]?.startsWith("SENSE"))]),
    [["a-q", "2"], ["b-q", "1"], ["b-g", "B3"]]);
  const expected = [["a-q", "a-q-order", "QFN"], ["b-q", "b-q-order", "QFN"], ["b-g", "b-g-order", "BGA"]];
  for (const source of ["schematic", "pcb"]) {
    assert.deepEqual(AtriumBOM.collect(p, {source}).parts.map(e => [e.def.id, e.mpn, e.footprint]), expected);
  }
  const reopened = A.validate(nativeRoundTrip(p));
  assert.equal(AtriumSaveCache.serialize(reopened), save({...p, id:reopened.id}), "the first native save assigns the project identity");
  assert.equal(reopened.componentFamilies[0].id, id);
  assert.deepEqual(reopened.documents, p.documents);
  assert.deepEqual(F.browse(reopened)[0].parts.map(x => x.options.map(o => o.id)), [["a-q"], ["b-q", "b-g"]]);
}
{
  const p = A.project("Loose assets", catalogue), base = get(p, "a-q");
  delete base.footprint;
  base.footprintName = "previous source hint";
  const footprint = {id: "q", name: "Exact QFN", sourceName: "Physical.PcbLib", footprint: A.clone(catalogue[0].footprint)};
  footprint.footprint.pads[0].net = "Previous board net";
  const alternate = {id: "lead", name: "Alternate", footprint: {...A.clone(catalogue[0].footprint), name: "DFN"}};
  const symbolCredit = {kind: "kicad-symbol", attribution: {...L.kiCadCredit("symbols"), modified: true}};
  const landCredit = {kind: "kicad-footprint", attribution: {...L.kiCadCredit("footprints", "Package library licence", "v1"), modified: true}};
  const altCredit = {kind: "kicad-footprint", attribution: {...L.kiCadCredit("footprints", "Alternative package licence", "v2"), modified: true}};
  base.source = symbolCredit; footprint.source = landCredit; alternate.source = altCredit;
  p.library.push(footprint, alternate);
  const placed = A.instantiate(p, base, [10, 20]); placed.pinNets = {legacy: "imported note"}; p.documents[0].items.push(placed);
  const wasPlaced = E.serialize(placed);
  const connectivity = A.pins(placed, base, "schematic");
  const mismatch = F.pairing(base, get(p, "b-g"));
  assert.deepEqual(mismatch, {ok: false, missingPins: ["1", "2"], extraPads: ["B3", "A1"]});
  const before = save(p);
  assert.throws(() => F.bindFootprint(p, "a-q", "b-g"), /Pins without pads: 1, 2.*Pads without pins: B3, A1/);
  assert.equal(save(p), before);
  const combined = F.bindFootprint(p, "a-q", "q");
  assert.equal(combined.id, placed.def);
  assert.equal(E.serialize(placed), wasPlaced);
  assert.deepEqual(A.pins(placed, combined, "schematic"), connectivity);
  assert.equal(combined.footprintName, "QFN");
  assert.equal(combined.footprint.pads[0].net, undefined);
  assert.equal(footprint.footprint.pads[0].net, "Previous board net");
  assert.equal(F.browse(p)[0].parts[0].options[0].footprint.sourceName, "Physical.PcbLib");
  const option = F.addPackage(p, combined.id, alternate.id, {name: "Package DFN", part: "A", mpn: "A-DFN"});
  assert.notEqual(option.id, combined.id);
  assert.notEqual(option.symbol, combined.symbol);
  assert.equal(option.parameters["Manufacturer Part Number"], "A-DFN");
  assert.equal(option.footprint.name, "DFN");
  const savedOptions = L.readLibraryFile(L.libraryFile({id: "assets", name: "Assets", defs: [combined, option]}).text);
  assert.deepEqual(savedOptions.defs.map(d => d.source), [{...symbolCredit, footprint: landCredit}, {...symbolCredit, footprint: altCredit}]);
  const groupId = F.memberships(p).get(combined.id).id;
  assert.deepEqual(F.memberships(p).get(option.id), {id: groupId, name: "A", part: "A"});
  assert.deepEqual(base.parameters, {MPN: "a-q-order", Manufacturer: "Example"});
  const noOrderCode = F.addPackage(p, combined.id, "lead", {name: "Unordered version"});
  assert.ok(!noOrderCode.parameters?.MPN, "a variant never inherits another order code");
  assert.equal(placed.def, combined.id);
  assert.equal(F.memberships(p).get(noOrderCode.id).id, groupId);
  const prior = save(p);
  assert.throws(() => F.addPackage(p, combined.id, "b-g", {name: "Different pinout"}), /Pins without pads/);
  assert.equal(save(p), prior);
}
{
  const p = A.project("Library sources", catalogue), family = F.create(p, "Family", entries);
  const lib = {id: "source-A", name: "Lab parts", defs: []};
  for (const def of p.library) L.saveToLibrary(lib, def, p);
  const disk = L.readLibraryFile(L.libraryFile(lib).text);
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), saved = new Map();
  Object.defineProperty(globalThis, "localStorage", {configurable: true, value: {setItem: (k, v) => saved.set(k, v), getItem: k => saved.get(k)}});
  try {
    assert.ok(L.sourceStore.save([disk]));
    assert.deepEqual(F.browse(L.sourceStore.list()[0]), F.browse(disk));
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else delete globalThis.localStorage;
  }
  assert.equal(disk.id, lib.id);
  assert.deepEqual(disk.componentFamilies, p.componentFamilies);
  assert.deepEqual(disk.defs.map(d => d.name), ["Demo A", "Demo B", "Demo B"], "two exact entries may share a display name");
  const target = A.project("Target", []);
  const made = disk.defs.map(d => L.addFromLibrary(disk, d, target));
  assert.equal(L.addFromLibrary(disk, disk.defs[1], target), made[1]);
  assert.ok(made.every((d, i) => d.id !== disk.defs[i].id));
  const row = F.browse(target)[0], members = row.parts.flatMap(part => part.options.map(o => o.id));
  assert.deepEqual(members, made.map(d => d.id));
  assert.deepEqual(row.parts.map(part => part.options.map(o => o.def.libraryRef.id)), [["a-q"], ["b-q", "b-g"]]);
  const other = {...disk, id: "source-B"};
  L.addFromLibrary(other, other.defs[1], target);
  assert.equal(F.browse(target).length, 2, "different source files with identical names and entry IDs stay independent");
  assert.ok(L.libraryStatus(made[0], [other]).missing);
  const legacy = A.project("Old source name", []), copy = L.fromLibrary({name: disk.name}, disk.defs[1], legacy);
  legacy.library.push(copy);
  const different = A.clone(other);
  different.defs[1].parameters.MPN = "另一 ordering code";
  different.defs[1].footprint.pads[0].w += 0.3;
  assert.equal(L.libraryStatus(copy, [different, disk]).lib, disk);
  assert.ok(L.libraryStatus(copy, [other, disk]).missing, "two matching fingerprints cannot identify the original file");
  assert.ok(L.libraryStatus(copy, [different]).libraryChanged, "a sole name-only source can still report an edit");
  const exact = L.addFromLibrary(different, different.defs[1], legacy);
  assert.notEqual(exact.id, copy.id);
  assert.equal(exact.parameters.MPN, "另一 ordering code");
  assert.equal(F.memberships(legacy).get(exact.id).part, "B");
  F.rename(target, row.id, "Known ADIs");
  L.saveToLibrary(disk, made[0], target);
  assert.equal(disk.componentFamilies[0].id, family);
  assert.equal(disk.componentFamilies[0].name, "Known ADIs");
  assert.deepEqual(new Set(disk.componentFamilies[0].members.map(m => m.defId)), new Set(catalogue.map(d => d.id)));
  F.ungroup(target, row.id, [made[0].id]);
  L.saveToLibrary(disk, made[0], target);
  assert.ok(!F.memberships(disk).has("a-q"));
}
function electricalOutput(project) {
  const defs = new Map(project.library.map(d => [d.id, d]));
  const images = project.documents.map(doc => {
    const rec = AtriumSVGCanvas.create(320, 220);
    const canvas = AtriumCanvas.create(rec.canvas);
    canvas.restoreCamera({cx: 10, cy: 8, scale: 10, referenceScale: 10});
    canvas.render(doc, defs, {grid: false, origin: false, hidden: new Set(), selectedIds: new Set()});
    return rec.svg();
  });
  const boms = ["schematic", "pcb"].map(source => AtriumBOM.collect(project, {source}).parts.map(e => [e.ref, e.def.id, e.mpn, e.footprint]));
  const eco = E.plan(project, {board: project.documents[1].id}).changes.map(c => [c.action, c.object, c.pin, c.after]);
  return {images, boms, eco};
}
{
  const p = A.validate(A.clone(fixture)), U = AtriumUndoStore, history = [], future = [];
  delete p.componentFamilies;
  U.reset();
  const board = p.documents[1], states = [save(p)], expected = electricalOutput(p);
  U.mark(p, {});
  const seq = U.changed(board, null).seq, outer = U.outer(), version = U.libraryVersion();
  function checkOrganisation() {
    const changed = U.changed(board, seq);
    assert.deepEqual([...changed.ids], []);
    assert.equal(changed.seq, seq);
    assert.equal(U.outer(), outer);
    assert.equal(U.libraryVersion(), version);
    assert.deepEqual(electricalOutput(p), expected);
    assert.deepEqual(electricalOutput(A.validate(nativeRoundTrip(p))), expected, "fresh build of both canvases, ECO and BOM");
  }
  const edit = fn => {
    const mark = U.mark(p, {});
    fn(); U.checkpoint(history, future, mark); U.touch(p);
    states.push(save(p)); checkOrganisation();
  };
  let id;
  edit(() => {id = F.create(p, "Group", entries);});
  edit(() => F.update(p, id, "Updated group", [member("b-g", "B")]));
  edit(() => F.ungroup(p, id));
  for (const [direction, expected] of [[-1, states.slice(0, -1).reverse()], [1, states.slice(1)]]) for (const text of expected) {
    assert.ok(U.jump(history, future, U.mark(p, {}), direction));
    assert.equal(save(p), text);
    U.touch(p); checkOrganisation();
  }
  const mark = U.mark(p, {});
  F.addPackage(p, "a-q", "b-q", {part: "A", name: "Extra land pattern"});
  U.checkpoint(history, future, mark); U.touch(p); U.changed(board, seq);
  assert.ok(U.libraryVersion() > version, "adding physical geometry invalidates the definition cache");
}
console.log("PASS component family organisation, exact package placement and nets, both BOMs, loose assets, project and source round trips, undo and redo");
