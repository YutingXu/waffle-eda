"use strict";
// A local upstream edit can leave a dependent's own input signature unchanged
// while the old upstream copper is retained. Its saved freshness still depends
// on the result of the upstream solve.
if (!globalThis.process?.versions?.node) return;
const assert = require("node:assert/strict");
const {resolve} = require("node:path");
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, "../..");
const app = resolve(root, "app");
const {appFileFrom} = require("../support/app-source-paths.cjs");
const {nativeRoundTrip} = require(resolve(root, "tests/support/native-cad.cjs"));
for (const name of ["spatial", "pcb-appearance", "pcb-pours", "rules", "stackup", "viastack", "board-shape", "polygon-pour"])
  require(appFileFrom(app, name + ".js"));
const P = AtriumPolygonPour, core = P._internal.core, defs = new Map();
const rect = (x, y, X, Y) => [[x,y],[X,y],[X,Y],[x,Y]];
const get = (d, id) => d.items.find(p => p.id === id);
const unpack = r => [r.polygon, r.layer, r.net, r.data, r.count, r.arcs || null];
const rows = d => d.pcbDrawing?.pours || [];
const copper = (d, id) => rows(d).filter(r => r.polygon === id).map(unpack);
const affected = ["early", "direct", "tail"];

function board() {
  const project = Atrium.project("Failed dependency");
  const doc = project.documents.find(d => d.kind === "pcb");
  doc.outline = rect(0,0,92,40);
  const pad = (id, net, x, y, w) => ({id, kind:"pad", net, layer:"Top", shape:"rect", x, y, w, h:w});
  const make = (id, net, pourIndex, ...bounds) => P.make(rect(...bounds), {
    id, net, layer:"Top", pourIndex, removeDeadCopper:false, connectStyle:"relief", reliefAirGap:.12, clearance:.23
  });
  doc.items = [pad("a", "GROUND", 41.7,19,2.6), pad("b", "SUPPLY", 48,19,2.2),
    pad("c", "CONTROL", 61,18,2.1), pad("d", "ISOLATED", 81,18,2.8),
    make("early", "GROUND", 0, 2,2,42,34), make("direct", "SUPPLY", 1, 15,8,58,31),
    make("tail", "CONTROL", 2, 43.3,4,69,33), make("independent", "ISOLATED", 3, 75,4,89,33)];
  const deps = P.pourDependencies(doc, defs, P.polygons(doc), {project});
  assert.deepEqual(deps, [[], [0], [1], []]);
  return {doc, project};
}
function coldOf(project, doc) {
  const ref = Atrium.clone(project), cold = ref.documents.find(d => d.id === doc.id);
  delete cold.pcbDrawing;
  for (const i of cold.items) delete i.copperBasis;
  const r = P.apply(cold, defs, {project:ref, reuse:false});
  assert.deepEqual(r.failed, []);
  return cold;
}
function failCore(doc, project, fn) {
  const task = P._internal.prepare(doc, defs, get(doc,"early"), {project}).task;
  const witness = JSON.stringify(task.shapes[0].ring), solve = core.solve;
  let failures = 0;
  core.solve = t => {
    if (t.K === task.K && JSON.stringify(t.shapes[0]?.ring) === witness) {
      failures++;
      throw Error("synthetic upstream failure");
    }
    return solve(t);
  };
  try { return fn(); }
  finally { core.solve = solve; assert.ok(failures, "the upstream solver fault was exercised"); }
}
function initial(doc, project, only) { P.apply(doc, defs, {project, only, reuse:false}); }
function readSaved(project, d) {
  const reopened = nativeRoundTrip(project), doc = reopened.documents.find(q => q.id === d.id);
  return {doc, project:reopened};
}

async function main() {
  const initialOptions = {reuse:false};
  const {doc, project} = board();
  initial(doc, project);
  const F = AtriumFormat2, M = AtriumFormat2Model;
  const originalNative = M.fromEditor(project).files.find(member => member.file.header.id === doc.id).file;
  const unknownMetadata = {note:"An unrelated extension owns this record field"};
  const originalRecord = {...originalNative.get("direct"), "x-qaCopperNote":unknownMetadata};
  const base = F.applyDelta(originalNative,{put:[originalRecord]}).file;
  const oldSig = doc.pcbDrawing.pourSignatures.direct, oldRows = rows(doc), independent = rows(doc).find(r => r.polygon === "independent");
  get(doc,"early").reliefAirGap = .85;
  assert.equal(P.polygonSignatures(doc, defs, {project}).direct, oldSig, "local edit preserves the dependent's old signature while upstream copper remains");
  const cold = coldOf(project,doc);
  assert.notDeepEqual(copper(doc,"direct"), copper(cold,"direct"), "the expected dependent refill changes physical copper");
  const failed = failCore(doc, project, () => P.apply(doc, defs, {...initialOptions, project, only:["early"]}));
  assert.deepEqual(failed.failed.map(x => x.id), ["early"]);
  assert.deepEqual(P.stale(doc, defs, {project}), affected, "unselected dependents are stale after failure");
  assert.equal(P.state(doc, defs, {project}), "stale");
  assert.deepEqual(doc.pcbDrawing.pourUnverified, affected);
  assert.equal(rows(doc).length, oldRows.length);
  assert.ok(rows(doc).every((r,k) => r === oldRows[k]), "the last good copper objects are retained");

  const blocked = P.apply(doc, defs, {project, only:["direct","tail"], reuse:false});
  assert.deepEqual(blocked.blocked, ["direct","tail"], "previously failed unselected prerequisite blocks its dependents");
  assert.deepEqual(blocked.failed, [], "being blocked is distinct from a failed solver call");
  assert.deepEqual(P.stale(doc, defs, {project}), affected);
  assert.equal(doc.pcbDrawing.pourSignatures.direct, oldSig, "retaining a stamp cannot make the blocked result current");
  const saved = readSaved(project,doc);
  assert.deepEqual(P.stale(saved.doc, defs, {project:saved.project}), affected, "native reopen keeps the dependent stale despite the saved copper basis");
  assert.deepEqual(rows(saved.doc).map(unpack), rows(doc).map(unpack));
  assert.deepEqual(saved.doc.items.filter(i => i.copperBasis).map(i => i.id), ["independent"], "full native save removes certificates for unverified copper");
  const folderSave = M.documentEdits(base, doc, {settings:true});
  const incremental = F.applyDelta(base,folderSave).file;
  const incrementalBoard = M.document(M.parse(F.serialize(incremental)));
  assert.deepEqual(incrementalBoard.pcbDrawing.pourUnverified, affected);
  assert.deepEqual(incrementalBoard.items.filter(i => i.copperBasis).map(i => i.id), ["independent"], "metadata-only folder save removes obsolete polygon certificates");
  assert.deepEqual(incremental.get("direct")["x-qaCopperNote"], unknownMetadata, "certificate removal preserves unknown native fields");
  const incoming = {...get(doc,"direct"),name:"A later item-only edit"};
  assert.ok(incoming.copperBasis, "the in-memory old stamp stays available for Undo");
  const itemOnly = F.applyDelta(incremental, M.documentEdits(incremental, {id:doc.id,kind:"pcb"}, {put:[incoming]})).file;
  assert.equal(itemOnly.get("direct").copperBasis, undefined, "a later item-only save cannot restore the stale certificate");
  assert.deepEqual(M.document(itemOnly).pcbDrawing.pourUnverified, affected);
  assert.deepEqual(itemOnly.get("direct")["x-qaCopperNote"], unknownMetadata);
  const uncertifiedLegacy = Atrium.clone(saved.doc);
  delete uncertifiedLegacy.pcbDrawing.pourUnverified;
  assert.deepEqual(P.stale(uncertifiedLegacy,defs,{project:saved.project}),affected,"packed copper stays stale in readers that ignore the marker");
  assert.deepEqual(P.outputCopper(saved.doc, defs, {project:saved.project,solve:false}).pending, affected);
  const old = JSON.stringify(doc);
  assert.throws(() => failCore(doc, project, () => P.outputCopper(doc, defs, {project})), /no outputs were made/);
  assert.equal(JSON.stringify(doc), old, "a continued detached failure leaves the source snapshot intact");
  const output = P.outputCopper(doc, defs, {project});
  assert.deepEqual(output.regions.map(unpack), rows(cold).map(unpack));
  assert.equal(output.regions.find(r => r.polygon === "independent"), independent);
  assert.equal(JSON.stringify(doc), old, "successful manufacturing also leaves the source snapshot intact");
  P.apply(doc, defs, {project});
  assert.deepEqual(rows(doc), rows(cold), "explicit retry settles the same copper as a cold repour");
  assert.deepEqual(P.stale(doc, defs, {project}), []);
  assert.equal(doc.pcbDrawing.pourUnverified, undefined);
  assert.deepEqual(P.failures(doc), {});
  const recovered = readSaved(project, doc);
  assert.deepEqual(P.stale(recovered.doc, defs, {project:recovered.project}), []);
  console.log("serial failure: retained copper, unavailable dependency, native reopen, persistent export refusal, exact retry");

  // The pool can prepare and start downstream stage 1 before the failure arrives.
  // It must withhold dependent stage 2 and commit the independent solve.
  const parallel = board();
  initial(parallel.doc, parallel.project);
  const before = rows(parallel.doc);
  get(parallel.doc,"early").reliefAirGap = .85;
  get(parallel.doc,"independent").reliefAirGap = .55;
  const expected = coldOf(parallel.project,parallel.doc);
  const tasks = [];
  let next;
  const pool = {size:4, available:true, run(_packed, _transfer, _progress, task) {
    const [id, stage] = next;
    tasks.push([id, stage]);
    if (id === "early" && stage === 1) return new Promise((_, reject) => setTimeout(() => reject(Error("synthetic pool failure")), 10));
    return Promise.resolve().then(() => core.solve(task));
  }};
  const result = await P.repourParallel(parallel.doc, defs, {project:parallel.project, reuse:false,
    onSolving(id, stage) { next = [id, stage]; }
  }, pool);
  assert.deepEqual(result.failed.map(r => r.id), ["early"]);
  assert.deepEqual(result.blocked.slice().sort(), ["direct", "tail"]);
  assert.ok(tasks.some(([id, stage]) => id === "direct" && stage === 1), "dependent stage 1 was started speculatively");
  assert.ok(!tasks.some(([id, stage]) => (id === "direct" || id === "tail") && stage === 2));
  P.apply(parallel.doc, defs, {project:parallel.project, result});
  assert.deepEqual(P.stale(parallel.doc, defs, {project:parallel.project}), affected);
  assert.deepEqual(copper(parallel.doc,"independent"), copper(expected,"independent"));
  for (const id of affected) assert.equal(rows(parallel.doc).find(r => r.polygon === id), before.find(r => r.polygon === id));
  console.log("pooled failure: independent copper completes, dependent stage 2 withheld");

  const moved = board();
  initial(moved.doc,moved.project);
  const movedCopper = rows(moved.doc), zone = get(moved.doc,"early");
  zone.points = zone.points.map(([x,y]) => [x-30,y]);
  assert.deepEqual(P.pourDependencies(moved.doc,defs,P.polygons(moved.doc),{project:moved.project}),[[],[],[1],[]]);
  const movedCold = coldOf(moved.project,moved.doc);
  assert.notDeepEqual(copper(moved.doc,"direct"), copper(movedCold,"direct"), "moving upstream copper changes the later fill");
  const movedFailure = failCore(moved.doc,moved.project,() => P.apply(moved.doc,defs,{project:moved.project,reuse:false}));
  assert.deepEqual(movedFailure.blocked, ["direct","tail"], "retained copper at an old position still blocks publication");
  assert.deepEqual(P.stale(moved.doc,defs,{project:moved.project}),affected);
  assert.ok(rows(moved.doc).filter(r => affected.includes(r.polygon)).every(r => movedCopper.includes(r)));
  assert.deepEqual(P.outputCopper(moved.doc, defs, {project:moved.project}).regions.map(unpack),rows(movedCold).map(unpack));
  console.log("moved outline: retained old copper remains a dependency until the failed owner recovers");

  for (const known of [false,true]) {
    const b = board();
    get(b.doc,"early").removeDeadCopper = true;
    get(b.doc,"a").net = "SIGNAL";
    initial(b.doc,b.project,known?undefined:["direct","tail","independent"]);
    assert.equal(copper(b.doc,"early").length,0);
    get(b.doc,"early").reliefAirGap = .85;
    failCore(b.doc, b.project, () => P.apply(b.doc, defs, {project:b.project,only:["early"],reuse:false}));
    const reopened = readSaved(b.project,b.doc);
    assert.deepEqual(P.stale(reopened.doc,defs,{project:reopened.project}),affected);
    assert.equal(P.stateOf(reopened.doc,defs).polygons.early,"stale","failed zero-island attempt remains eligible after reopening");
    assert.equal(copper(reopened.doc,"early").length,0);
  }
  console.log("zero-island and previously unpoured prerequisites survive a failed attempt and reopen");

  const opaque = board();
  initial(opaque.doc,opaque.project);
  const oldValue = {writtenBy:"older native extension"}, oldFallback = ["", {opaque:true}];
  opaque.doc.pcbDrawing.pourUnverified = oldValue;
  opaque.doc.pcbDrawing.wafflePourUnverified = oldFallback;
  const rawOld = readSaved(opaque.project,opaque.doc).doc;
  assert.deepEqual(rawOld.pcbDrawing.pourUnverified, oldValue);
  assert.deepEqual(rawOld.pcbDrawing.wafflePourUnverified, oldFallback);
  assert.deepEqual(P.stale(opaque.doc,defs,{project:opaque.project}), []);
  get(opaque.doc,"early").reliefAirGap = .85;
  failCore(opaque.doc,opaque.project,() => P.apply(opaque.doc,defs,{project:opaque.project,only:["early"],reuse:false}));
  const oldAndFailed = readSaved(opaque.project,opaque.doc);
  assert.deepEqual(P.stale(oldAndFailed.doc,defs,{project:oldAndFailed.project}), affected);
  assert.deepEqual(oldAndFailed.doc.pcbDrawing.pourUnverified,oldValue);
  assert.deepEqual(oldAndFailed.doc.pcbDrawing.wafflePourUnverified,oldFallback);
  assert.deepEqual(oldAndFailed.doc.items.filter(i => i.copperBasis).map(i => i.id), ["independent"]);
  initial(opaque.doc,opaque.project);
  assert.deepEqual(P.stale(opaque.doc,defs,{project:opaque.project}), []);
  assert.equal(globalThis.AtriumPourMarker.read(opaque.doc.pcbDrawing),undefined);
  assert.deepEqual(opaque.doc.pcbDrawing.pourUnverified,oldValue);
  assert.deepEqual(opaque.doc.pcbDrawing.wafflePourUnverified,oldFallback);
  console.log("old optional drawing metadata survives ordinary saves, actual failure and recovery");
}
main().catch(error => {console.error(error);process.exitCode=1;});
