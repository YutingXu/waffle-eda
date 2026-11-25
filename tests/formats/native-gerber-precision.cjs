"use strict";
// Exercise a new folder open and the same export worker as the fabrication dialog.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const name of ["model","source-file","sexpr","format-2-codec","format-2-units","format-2-values","format-2-model",
  "translator-precision","import-sidecars","import-reports","undo-store"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
require("../../app/translator-worker-modules.js");
for (const file of AtriumTranslatorWorkerModules["polygon-pour"]) require(require("../support/app-source-paths.cjs").appFile(file));
const cleanup = require("../support/import-worker.cjs")({client:true});
const C = AtriumTranslatorClient, M = AtriumFormat2Model, S = AtriumImportSidecars, R = AtriumImportReports;
const date = "2026-06-15T12:00:00Z";
const fixture = path.join(__dirname,"../fixtures/altium/pidp11-io-expander");
const names = ["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"];
const boardOf = p => p.documents.find(d => d.kind === "pcb");
const plot = async p => {
  const result = await C.export("gerber", p, {date,documentId:boardOf(p).id});
  return Object.fromEntries(["GTO","GBO","GTL"].map(ext => [ext,result.files.find(f => f.name.endsWith("." + ext)).text]));
};
const gp07 = film => film.split("\n").filter(line => /^X2717869[89]Y15087600D0[12]\*$/.test(line));
const legs = film => [film.GTO, film.GBO];
function reopen(saved) {
  const p = M.manifest(M.parse(AtriumFormat2.serialize(saved.manifest))).project;
  for (const m of saved.files) {
    const f = M.parse(AtriumFormat2.serialize(m.file));
    if (f.header.kind === "schematic" || f.header.kind === "pcb") {
      const ref = M.manifest(saved.manifest).members.find(row => row.id === f.header.id);
      p.documents.push(M.document(f, {name:ref.name || path.basename(ref.path,path.extname(ref.path))}));
    }
    if (f.header.kind === "library") p.library.push(M.library(f));
  }
  return p;
}
async function main() {
  const inputs = names.map(name => ({name,bytes:new Uint8Array(fs.readFileSync(path.join(fixture,name)))}));
  const imported = await C.import(inputs, {translator:"altium",source_rules:"use"});
  const source = JSON.parse(JSON.stringify(imported.model));
  const oracle = await plot(source), saved = M.fromEditor(imported), project = reopen(saved);
  const files = imported.provenance.files.map(f => ({...JSON.parse(JSON.stringify({...f,bytes:undefined})),
    bytes:inputs.find(i => i.name === f.name).bytes}));
  const entry = {scopeId:"pidp-film",adopted:true,names,documents:source.documents.map(d => d.id),
    provenance:{...JSON.parse(JSON.stringify({...imported.provenance,files:[]})),files},
    report:JSON.parse(JSON.stringify(imported.report)),residuals:saved.residuals};
  const packed = await S.prepare([entry]), ref = packed.refs[0];
  const restored = S.restore(S.parse(packed.files.get(ref.path),ref));
  const without = await plot(project);
  function changedLines(original, rounded) {
    const a = original.split("\n"), b = rounded.split("\n");
    assert.equal(a.length,b.length);
    return a.reduce((n,line,i) => n + (line !== b[i]),0);
  }
  assert.equal(changedLines(oracle.GTO,without.GTO),114);
  assert.equal(changedLines(oracle.GBO,without.GBO),442);
  assert.equal(gp07(oracle.GTL).length,2);
  assert.equal(gp07(without.GTL).length,2);
  assert.ok(gp07(oracle.GTL).every(line => line.startsWith("X27178699")));
  assert.ok(gp07(without.GTL).every(line => line.startsWith("X27178698")));
  const session = {}, folder = {ensureImportReports:async () => R.installRetained(session,[restored])};
  globalThis.AtriumNavHost = {folderProject:() => folder,project:() => project,fileSession:() => session,
    edit:apply => apply(),on(){},registerAction(){}};
  R.attach(AtriumNavHost);
  const film = await plot(project);
  assert.deepEqual(legs(film),legs(oracle));
  assert.deepEqual(gp07(film.GTL),gp07(oracle.GTL));
  const counts = S.manufacturingProvenance(R.provenance(),boardOf(project).id);
  assert.ok(counts.length === 1 && counts[0].precision.rows.length > 0);
  assert.deepEqual(Object.keys(counts[0]),["precision"]);
  assert.ok(counts[0].precision.rows.every(row => row.owner === boardOf(project).id));
  project.parameters = {...project.parameters, "Bench check":"Unrelated edit"};
  assert.deepEqual(legs(await plot(project)),legs(oracle));

  const history = [], redo = [], U = AtriumUndoStore;
  const board = boardOf(project), label = board.items.find(i => i.kind === "label" && i.text === "GP0");
  const bottom = board.items.find(i => i.kind === "label" && i.text === ".ProjectURL");
  const track = board.items.find(i => i.kind === "track" && i.net === "GP0.7" &&
    i.points.some(([x]) => x === 27.178698));
  assert.ok(label && bottom && track);
  const originalWidth = label.sourceTextBox.width;
  const precision = groups => AtriumTranslatorPrecision.forExport(project,groups,"gerber").item(board,label);
  // A draft edit inside the same native nanometre and any competing import binding
  // must give the exact field back to the author. Plotting cannot edit the document.
  const sourceWidth = boardOf(source).items.find(i => i.id === label.id).sourceTextBox.width;
  assert.notEqual(originalWidth,sourceWidth);
  assert.equal(precision(counts).sourceTextBox.width,sourceWidth);
  assert.equal(label.sourceTextBox.width,originalWidth);
  const other = {precision:{...counts[0].precision,scopeId:"other-import"}};
  assert.equal(precision([...counts,other]).sourceTextBox.width,originalWidth);
  const draftWidth = originalWidth + .0000001;
  label.sourceTextBox.width = draftWidth;
  assert.equal(precision(counts).sourceTextBox.width,draftWidth);
  label.sourceTextBox.width = originalWidth;
  const j = track.points.findIndex(([x]) => x === 27.178698);
  // Only these three field values change. The expected contours still use the old
  // source precision on all other fields, annotations and the other track endpoint.
  function editFields(doc) {
    doc.items.find(i => i.id === label.id).sourceTextBox.width = 2.25;
    doc.items.find(i => i.id === bottom.id).sourceTextBox.height = 1;
    doc.items.find(i => i.id === track.id).points[j][0] = 26.5;
  }
  const editedSource = JSON.parse(JSON.stringify(source));
  editFields(boardOf(editedSource));
  const expected = await plot(editedSource);
  U.reset();
  const mark = U.mark(project,{current:board.id});
  editFields(board);
  U.checkpoint(history,redo,mark,"Edit legend metrics and track"); U.touch(project);
  const edited = await plot(project);
  assert.notEqual(edited.GTO,oracle.GTO); assert.notEqual(edited.GBO,oracle.GBO);
  assert.deepEqual(legs(edited),legs(expected));
  assert.equal(gp07(edited.GTL).length,1);
  assert.deepEqual(gp07(edited.GTL),gp07(expected.GTL));
  assert.ok(U.jump(history,redo,U.mark(project,{current:board.id}),-1)); U.touch(project);
  const undone = await plot(project);
  assert.deepEqual(legs(undone),legs(oracle)); assert.deepEqual(gp07(undone.GTL),gp07(oracle.GTL));
  const reports = R.capture();
  assert.ok(R.discard("pidp-film"));
  const discarded = await plot(project);
  assert.deepEqual(legs(discarded),legs(without)); assert.deepEqual(gp07(discarded.GTL),gp07(without.GTL));
  R.restore(session,reports);
  assert.deepEqual(legs(await plot(project)),legs(oracle));
  console.log("PASS public PiDP legend bytes and half-nanometre track endpoints after native reopen, edit, Undo and Discard");
}
main().finally(() => { C.cancel(); cleanup(); }).catch(error => { console.error(error); process.exitCode = 1; });
