"use strict";
// Stable ids of imported Altium objects (app/formats/altium-ids.js, used by sch-import.js and pcb-import.js):
//  1. Importing one file twice gives identical ids (documents, objects, library entries, links),
//     from the Altium ids where the file has them: schematic record UniqueIDs, PcbDoc component
//     UNIQUEIDs, primitive GUIDs (PrimitiveGuids) and pad UNIQUEIDs; else from what the object is.
//  2. Two revisions line up by id: a re-annotated, moved part and a moved wire keep their ids, an
//     unchanged junction or track keeps its content id when other records move around it, and the
//     diff engine matches them by id with no source-record bookkeeping reported.
//  3. Two files of one name in a project (different folders) still get distinct ids.
//  4. The three-way merge of re-imports: record indexes moving on both sides is no conflict, and two
//     branches adding one designator are told apart by the Altium id (one part, or a renumbered copy).
// Fixtures: tests/fixtures/altium (PiDP-11 project, PairsXSignals, signals-ascii) and synthetic ASCII files.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "polygon-pour", "import-link", "source-file", "altium-ids", "sch-import",
  "altium-rules", "pcb-pours", "pcb-import", "io", "import-worker-client", "connectivity", "pcb-draw", "component-classes", "rules", "revision-review", "diff",
  "eco", "merge3", "worker-source"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, D = AtriumDiff, M = AtriumMerge3, ROOT = path.join(__dirname, "../fixtures/altium"), enc = new TextEncoder();
const file = (dir, name) => ({name, bytes: new Uint8Array(fs.readFileSync(path.join(ROOT, dir, name)))});
const text = (name, body) => ({name, bytes: enc.encode(body)});
const clone = v => JSON.parse(JSON.stringify(v));
function open(files, workspace = A.project("x", AtriumParts.catalogue), into = false) {
  const all = files.map(f => AtriumIO.read(f.name, f.bytes));
  return A.validate(clone(AtriumImport.assemble(all, files, workspace, null, into).after));
}
const imported = p => p.documents.filter(d => d.sourceName);
const idsOf = p => JSON.stringify({docs: imported(p).map(d => [d.id, d.items.map(i => [i.id, i.def ?? null, i.link ?? null, i.sourcePour ?? null, (i.entries || []).map(e => e.id)])]),
  library: p.library.filter(d => d.sourceName).map(d => d.id), pours: imported(p).map(d => (d.pcbDrawing?.pours || []).map(r => r.polygon ?? null))});
const items = (p, kind) => imported(p).flatMap(d => d.items.filter(i => !kind || i.kind === kind));
const STABLE = /^a[uc]-[0-9a-z]{11}(-\d+)?$/, DURABLE = /^au-/;

// ---------------------------------------------------------------- 1. the same file twice
const pidp = ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"].map(n => file("pidp11-io-expander", n));
const sets = {pidp, pairs: [file("pairs-xsignals", "PairsXSignals.PcbDoc")], ascii: [file("signals-ascii", "Signals.PcbDoc")]};
for (const [name, files] of Object.entries(sets)) {
  const a = open(files), b = open(files);
  assert.equal(idsOf(a), idsOf(b), name + ": importing the same files twice gives identical ids");
  for (const d of imported(a)) {
    assert.match(d.id, STABLE, name + ": document id");
    for (const i of d.items) assert.match(i.id, STABLE, name + ": " + i.kind + " id");
  }
  const r = D.compare(a, b);
  assert.equal(r.summary.total, 0, name + ": two imports of one file have no differences");
  assert.equal(r.stats.matched.total, r.stats.matched.id, name + ": every object pairs by id");
  assert.equal(r.stats.unmatched.before + r.stats.unmatched.after, 0);
}
{
  const p = open(pidp), sch = imported(p).find(d => d.kind === "schematic"), pcb = imported(p).find(d => d.kind === "pcb");
  assert.ok(sch.items.filter(i => i.kind !== "junction").every(i => DURABLE.test(i.id)), "schematic records carry UniqueIDs (junctions do not)");
  assert.ok(sch.items.filter(i => i.kind === "junction").every(i => /^ac-/.test(i.id)), "junctions: content ids");
  assert.ok(pcb.items.filter(i => i.kind === "part").every(i => DURABLE.test(i.id)), "PcbDoc components: UNIQUEID");
  assert.ok(pcb.items.some(i => i.kind === "pad" && DURABLE.test(i.id)), "free pads: UniqueIDPrimitiveInformation");
  assert.ok(pcb.items.filter(i => i.kind === "track").every(i => /^ac-/.test(i.id)), "a board saved before PrimitiveGuids: tracks by content");
  // Linked schematic and board parts share one link, the same on every import.
  const linked = sch.items.filter(i => i.kind === "part" && pcb.items.some(j => j.kind === "part" && j.link === i.link));
  assert.ok(linked.length >= 20, "imported parts are linked (" + linked.length + ")");
  assert.ok(new Set(items(p).map(i => i.id)).size === items(p).length, "ids are unique in the project");
  // A revision that only moves records in the file (Altium rewrites them in another order): no changes.
  const moved = clone(p);
  for (const d of imported(moved)) for (const i of d.items) {
    if (i.schSource) i.schSource = {...i.schSource, record: i.schSource.record + 7};
    if (i.sourceRecord) i.sourceRecord = i.sourceRecord.replace(/#(\d+)$/, (_, n) => "#" + (+n + 3));
  }
  const r = D.compare(p, moved);
  assert.equal(r.summary.total, 0, "source record positions are bookkeeping, not changes");
  assert.ok(r.summary.suppressed.metadata > 100, "and are counted as suppressed metadata");
  assert.equal(D.compare(p, moved, {ignoreMetadata: false}).changes.filter(c => /\.property$/.test(c.kind)).length > 100, true, "ignoreMetadata: false shows them");
  const pairs = open(sets.pairs), board = imported(pairs)[0];
  assert.ok(board.items.filter(i => i.kind === "track").length && board.items.filter(i => i.kind === "track").every(i => DURABLE.test(i.id)), "PrimitiveGuids: tracks keep Altium's GUID");
}
// The offline import worker carries the id module.
assert.ok(AtriumImportWorkerSource.includes("globalThis.AtriumAltiumIds"), "worker-source.js bundles altium-ids.js (python3 scripts/bundle-worker.py)");

// ---------------------------------------------------------------- 2. two revisions
// A minimal ASCII SchDoc: records in order, children name their owner by key.
function schDoc(records) {
  const at = new Map(records.map((r, i) => [r.key, i]));
  return "|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=" + records.length + "\r\n" + records.map(r =>
    "|" + Object.entries({RECORD: r.record, ...(r.owner ? {OWNERINDEX: at.get(r.owner), OWNERPARTID: 1} : {}), ...r.f}).map(([k, v]) => k + "=" + v).join("|")).join("\r\n") + "\r\n";
}
const part = (key, uid, ref, x, y, more = []) => [
  {key, record: 1, f: {LIBREFERENCE: "RES", CURRENTPARTID: 1, PARTCOUNT: 2, "LOCATION.X": x, "LOCATION.Y": y, UNIQUEID: uid}},
  {owner: key, record: 2, f: {PINCONGLOMERATE: 2, PINLENGTH: 20, "LOCATION.X": x - 10, "LOCATION.Y": y, NAME: "1", DESIGNATOR: "1", UNIQUEID: uid.slice(0, 6) + "P1"}},
  {owner: key, record: 2, f: {PINCONGLOMERATE: 0, PINLENGTH: 20, "LOCATION.X": x + 10, "LOCATION.Y": y, NAME: "2", DESIGNATOR: "2", UNIQUEID: uid.slice(0, 6) + "P2"}},
  {owner: key, record: 34, f: {TEXT: ref, "LOCATION.X": x, "LOCATION.Y": y + 20, UNIQUEID: uid.slice(0, 6) + "DS"}},
  {owner: key, record: 41, f: {NAME: "Comment", TEXT: "10k", "LOCATION.X": x, "LOCATION.Y": y - 20, UNIQUEID: uid.slice(0, 6) + "CM"}},
  {owner: key, record: 45, f: {MODELNAME: "R0603", MODELTYPE: "PCBLIB", ISCURRENT: "T"}}, ...more];
const sheet = {record: 31, f: {}};
const wire = (uid, x1, y1, x2, y2) => ({record: 27, f: {LOCATIONCOUNT: 2, X1: x1, Y1: y1, X2: x2, Y2: y2, UNIQUEID: uid}});
const junction = (x, y) => ({record: 29, f: {"LOCATION.X": x, "LOCATION.Y": y}});
const label = (uid, t, x, y) => ({record: 25, f: {TEXT: t, "LOCATION.X": x, "LOCATION.Y": y, UNIQUEID: uid}});
const R1 = part("r1", "PARTAAAA", "R1", 100, 500), R9 = part("r9", "PARTBBBB", "R9", 400, 500);
const revA = schDoc([sheet, ...R1, wire("WIREAAAA", 120, 500, 300, 500), junction(300, 500), wire("WIREBBBB", 300, 500, 300, 400), label("LABELAAA", "NET1", 200, 500), ...R9]);
// Rev B: R1 re-annotated as R2 and moved; the first wire lengthened; R9 now first; a new wire.
const R2 = part("r1", "PARTAAAA", "R2", 100, 450);
const revB = schDoc([sheet, ...R9, wire("WIRECCCC", 300, 400, 300, 300), ...R2, junction(300, 500), wire("WIREAAAA", 110, 450, 300, 500), wire("WIREBBBB", 300, 500, 300, 400), label("LABELAAA", "NET1", 200, 500)]);
// A board: ASCII PcbDoc, components with UNIQUEIDs, tracks without.
const pcbDoc = (comps, tracks) => ["|RECORD=Board|VX0=0mil|VY0=0mil|VX1=2000mil|VY1=0mil|VX2=2000mil|VY2=2000mil|VX3=0mil|VY3=2000mil",
  "|RECORD=Net|ID=0|NAME=NET1", "|RECORD=Net|ID=1|NAME=GND",
  ...comps.flatMap(([ref, uid, src, x, y], i) => ["|RECORD=Component|ID=" + i + "|PATTERN=R0603|SOURCEDESIGNATOR=" + ref + "|X=" + x + "mil|Y=" + y + "mil|ROTATION=0|LAYER=TOP|UNIQUEID=" + uid + "|SOURCEUNIQUEID=\\" + src,
    "|RECORD=Pad|COMPONENT=" + i + "|NAME=1|X=" + (x - 30) + "mil|Y=" + y + "mil|XSIZE=20mil|YSIZE=20mil|SHAPE=RECTANGLE|LAYER=TOP|NET=0",
    "|RECORD=Pad|COMPONENT=" + i + "|NAME=2|X=" + (x + 30) + "mil|Y=" + y + "mil|XSIZE=20mil|YSIZE=20mil|SHAPE=RECTANGLE|LAYER=TOP|NET=1"]),
  ...tracks.map(([n, x1, y1, x2, y2]) => "|RECORD=Track|LAYER=TOP|NET=" + n + "|X1=" + x1 + "mil|Y1=" + y1 + "mil|X2=" + x2 + "mil|Y2=" + y2 + "mil|WIDTH=6mil")].join("\r\n") + "\r\n";
const boardA = pcbDoc([["R1", "COMPAAAA", "PARTAAAA", 500, 500], ["R9", "COMPBBBB", "PARTBBBB", 900, 500]], [[0, 530, 500, 870, 500], [1, 100, 100, 600, 100], [1, 100, 100, 600, 100]]);
const boardB = pcbDoc([["R9", "COMPBBBB", "PARTBBBB", 900, 500], ["R2", "COMPAAAA", "PARTAAAA", 500, 600]], [[1, 100, 900, 600, 900], [1, 100, 100, 600, 100], [0, 530, 600, 870, 500], [1, 100, 100, 600, 100]]);
const project = (sch, board, workspace) => open([text("Demo.SchDoc", sch), text("Demo.PcbDoc", board)], workspace, !!workspace);
{
  // A PCB with the old annotation must still connect to the re-annotated symbols on import.
  const crossed = schDoc([sheet, ...part("a", "PARTAAAA", "R9", 100, 450), ...part("b", "PARTBBBB", "R1", 400, 500)]);
  const p = project(crossed, boardA), sch = imported(p).find(d => d.kind === "schematic"), pcb = imported(p).find(d => d.kind === "pcb");
  const layout = pcb.items.filter(i => i.kind === "part").map(i => [i.id, i.x, i.y, i.def]);
  for (const symbol of sch.items.filter(i => i.kind === "part")) {
    const footprint = pcb.items.find(i => i.kind === "part" && i.altiumSourceId === symbol.altiumSourceId);
    assert.ok(symbol.altiumSourceId && footprint && symbol.ref !== footprint.ref);
    assert.equal(symbol.link, footprint.link, "Altium source identity wins over the crossed designators");
  }
  const q = AtriumECO.plan(p, {board:pcb.id, scope:sch.id, reconcile:false});
  assert.equal(q.review.pending, 0);
  assert.deepEqual(q.changes.filter(c => c.action === "ref").map(c => [c.before,c.after]).sort(), [["R1","R9"],["R9","R1"]]);
  assert.equal(AtriumECO.execute(p, q).failed, 0);
  assert.deepEqual(pcb.items.filter(i => i.kind === "part").map(i => [i.id, i.x, i.y, i.def]), layout);
}
{
  const a = project(revA, boardA), b = project(revB, boardB);
  const byUid = (p, ref) => items(p, "part").filter(i => i.ref === ref);
  const [sa, pa] = byUid(a, "R1"), [sb, pb] = byUid(b, "R2");
  assert.equal(sb.id, sa.id, "a re-annotated, moved schematic part keeps its id (UniqueID)");
  assert.equal(pb.id, pa.id, "a re-annotated, moved board part keeps its id (UNIQUEID)");
  assert.equal(sa.link, pa.link, "the schematic and board parts are linked");
  assert.equal(sb.link, sa.link, "the link is stable across revisions");
  const sheetOf = p => imported(p).find(d => d.kind === "schematic"), boardOf = p => imported(p).find(d => d.kind === "pcb");
  assert.equal(sheetOf(a).id, sheetOf(b).id, "a document keeps its id");
  const wiresA = new Map(sheetOf(a).items.filter(i => i.kind === "wire").map(i => [JSON.stringify(i.points), i.id]));
  assert.ok(sheetOf(b).items.some(i => i.kind === "wire" && [...wiresA.values()].includes(i.id) && !wiresA.has(JSON.stringify(i.points))), "a moved wire keeps its id (UniqueID)");
  const jA = sheetOf(a).items.find(i => i.kind === "junction"), jB = sheetOf(b).items.find(i => i.kind === "junction");
  assert.ok(/^ac-/.test(jA.id) && jA.id === jB.id, "an unchanged junction keeps its content id while records move around it");
  // Identical stacked tracks: "-2" in record order; an unchanged track keeps its id when a record is inserted before it.
  const tracks = p => boardOf(p).items.filter(i => i.kind === "track");
  const stacked = tracks(a).filter(i => i.points[0][1] === tracks(a)[1].points[0][1]).map(i => i.id);
  assert.equal(stacked.length, 2); assert.equal(stacked[1], stacked[0] + "-2", "a repeated content id takes -2");
  assert.deepEqual(tracks(b).filter(i => stacked.includes(i.id)).map(i => i.id).sort(), stacked.slice().sort(), "unchanged tracks keep their ids");
  assert.ok(new Set(items(b).map(i => i.id)).size === items(b).length, "ids are unique");
  // The diff: paired by id, re-annotation and moves reported, no bookkeeping (record positions).
  const r = D.compare(a, b), kinds = r.changes.map(c => c.kind);
  const re = r.changes.filter(c => c.kind === "part.reannotated");
  assert.equal(re.length, 2, "R1 → R2 on the sheet and on the board: " + kinds.join(", "));
  assert.ok(re.every(c => c.match?.by === "id"), "matched by id");
  assert.ok(r.changes.some(c => c.kind === "wire.reshaped" && c.match?.by === "id"), "the lengthened wire pairs by id");
  assert.ok(kinds.includes("wire.added") && kinds.includes("track.added"), "new objects are added");
  assert.ok(!r.changes.some(c => c.kind === "part.property"), "no link or bookkeeping property rows");
  // Without the stable ids (the old importer), the same pair needs designator and geometry matching.
  const fresh = p => { const q = clone(p); for (const d of q.documents) { d.id = "x" + d.id; for (const i of d.items) i.id = "x" + i.id; } return q; };
  assert.ok(D.compare(fresh(a), b).stats.matched.id === 0, "ids are what pairs them");
}

// ---------------------------------------------------------------- 3. two files of one name
{
  const one = file("pairs-xsignals", "PairsXSignals.PcbDoc"), all = [one, one].map(f => AtriumIO.read(f.name, f.bytes));
  const [x, y] = AtriumAltiumIds.distinct(all);
  assert.equal(x, all[0], "the first keeps its ids");
  assert.notEqual(y.documents[0].id, x.documents[0].id);
  const ids = new Set(y.documents[0].items.map(i => i.id));
  assert.ok(y.documents[0].items.every(i => !x.documents[0].items.some(j => j.id === i.id)), "every object id is re-derived");
  assert.ok(y.documents[0].items.filter(i => i.kind === "part").every(i => y.library.some(d => d.id === i.def)), "definition references follow");
  assert.equal(ids.size, y.documents[0].items.length);
  const p = A.validate(clone(AtriumImport.assemble(all, [one, one], A.project("x", AtriumParts.catalogue), null).after));
  assert.equal(imported(p).length, 2, "both open in one project");
  const again = AtriumAltiumIds.distinct([one, one].map(f => AtriumIO.read(f.name, f.bytes)));
  assert.equal(JSON.stringify(again[1].documents[0].items.map(i => i.id)), JSON.stringify(y.documents[0].items.map(i => i.id)), "deterministic");
}

// ---------------------------------------------------------------- 4. three-way merge of re-imports
{
  const workspace = A.project("x", AtriumParts.catalogue);
  const revision = (sch, board) => project(sch, board, clone(workspace));
  const base = revision(revA, boardA), ours = revision(revB, boardB);
  // Theirs: rev A with a new part R7 and the records in another order.
  const R7 = part("r7", "PARTCCCC", "R7", 700, 500);
  const reordered = first => schDoc([sheet, ...R9, ...R7, label("LABELAAA", "NET1", 200, 500), junction(300, 500), wire("WIREBBBB", 300, 500, 300, 400), ...first, wire("WIREAAAA", 120, 500, 300, 500)]);
  const theirs = revision(reordered(R1), boardA);
  assert.ok(AtriumUUID.isV7(workspace.id));
  assert.ok([base, ours, theirs].every(p => p.id === workspace.id), "the re-imports are revisions of one authored project");
  const r = M.merge(base, ours, theirs);
  assert.equal(r.conflicts.length, 0, "record indexes moving on both sides is no conflict: " + r.conflicts.map(c => c.label + " " + c.fields).join("; "));
  const sch = r.project.documents.find(d => d.kind === "schematic" && d.sourceName);
  assert.ok(sch.items.some(i => i.kind === "part" && i.ref === "R2"), "ours: R1 re-annotated as R2");
  assert.ok(sch.items.some(i => i.kind === "part" && i.ref === "R7"), "theirs: R7 added");
  assert.ok(sch.items.some(i => i.kind === "wire" && i.points[0][0] === 110 * 0.254), "ours: the moved wire");
  A.validate(clone(r.project));
  const originalPart = items(base, "part").find(i => i.ref === "R1");
  const diverged = revision(reordered(part("r1", "PARTAAAA", "R1", 100, 550)), boardA);
  const conflicting = M.merge(base, ours, diverged);
  const conflict = conflicting.conflicts.find(c => c.objectId === originalPart.id && c.fields.includes("y"));
  assert.ok(conflict, "different moves of one source part conflict despite reordered records");
  const resolved = M.resolve(conflicting, {[conflict.id]:"theirs"});
  const installed = items(resolved, "part").find(i => i.id === originalPart.id);
  assert.equal(installed.y, items(diverged, "part").find(i => i.id === originalPart.id).y);
  assert.equal(installed.ref, "R2", "resolving the move keeps the other revision's nonconflicting annotation");
  A.validate(clone(resolved));
  // Both branches add R7. The same Altium part (one UniqueID) is one object; two different parts
  // are two objects, and theirs is renumbered where the merge renumbers designator clashes.
  const withPart = (uid, x) => revision(schDoc([sheet, ...R1, wire("WIREAAAA", 120, 500, 300, 500), junction(300, 500), wire("WIREBBBB", 300, 500, 300, 400), label("LABELAAA", "NET1", 200, 500), ...R9, ...part("r7", uid, "R7", x, 500)]), boardA);
  const same = M.merge(base, withPart("PARTCCCC", 700), withPart("PARTCCCC", 700));
  assert.equal(same.conflicts.length, 0);
  assert.equal(same.project.documents.find(d => d.kind === "schematic" && d.sourceName).items.filter(i => i.kind === "part" && i.ref === "R7").length, 1, "one Altium part added on both branches is one part");
  assert.ok(!(same.renumbered || []).length, "and is not renumbered");
  const two = M.merge(base, withPart("PARTCCCC", 700), withPart("PARTDDDD", 800));
  const refs = two.project.documents.find(d => d.kind === "schematic" && d.sourceName).items.filter(i => i.kind === "part").map(i => i.ref).sort();
  assert.equal(two.conflicts.length, 0);
  assert.equal(refs.length, 4, "two different parts added as R7 are both kept");
  if (two.renumbered) assert.deepEqual(refs, ["R1", "R7", "R8", "R9"], "theirs is renumbered to R8");
}
console.log("altium-ids: ok");
