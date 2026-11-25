"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const file of ["model", "source-file", "format-2-codec", "format-2-units", "format-2-values", "format-2-model",
  "format-2-closure", "folder-project-engine"]) require(require("../support/app-source-paths.cjs").appFile(file + ".js"));
const {checkSchema} = require("../../integrations/vscode/lib/validate.js");
const F = AtriumFormat2, M = AtriumFormat2Model, E = AtriumFolderProjectEngine, A = Atrium;
const base = path.join(__dirname, "../fixtures/format-2/notebook");
const read = name => new Uint8Array(fs.readFileSync(path.join(base, name)));
const string = bytes => new TextDecoder().decode(bytes);

async function main() {
  const manifestPath = "Notebook.waffle", sheetPath = "Notebook.wsch";
  const manifestBytes = read(manifestPath), sheetBytes = read(sheetPath);
  const manifest = M.parse(manifestBytes), sheet = M.parse(sheetBytes);
  assert.equal(manifest.header.formatVersion, "2.0");
  assert.equal(sheet.header.formatVersion, "2.0");
  const closure = await AtriumFormat2Closure.verify(manifest, read);
  assert.equal(closure.sha256, "16b4469296e1bf5ee23059be39c24d00629f2e6ddc9e8d0fd95ce8ba1adcc421");
  assert.deepEqual(M.dependencies(sheet).filter(ref => ref.kind === "asset").map(ref => ref.mediaType).sort(), ["application/pdf", "image/png"]);
  assert.deepEqual(F.serialize(manifest), manifestBytes);
  assert.deepEqual(F.serialize(sheet), sheetBytes);

  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../integrations/vscode/schema/waffle-folder-record.schema.json"), "utf8"));
  const notebookSchema = {$defs: schema.$defs, $ref: "#/$defs/notebookRecord"};
  for (const [file, kind] of [[sheet, "schematic"], [manifest, "project"]]) {
    const ownerSchema = {$defs: schema.$defs, $ref: "#/$defs/" + kind + "Record"};
    for (const record of file.records()) assert.deepEqual(checkSchema(record, ownerSchema), [], record.id);
  }
  assert.deepEqual(checkSchema(sheet.get("bench-table"), notebookSchema), []);
  assert.ok(checkSchema({...sheet.get("photo-arrow"), at: [-1, 0]}, notebookSchema).length);
  assert.ok(checkSchema({...sheet.get("math-note"), tex: undefined}, notebookSchema).length);
  assert.equal(sheet.get("bench-table").kind, "widget");
  assert.equal(sheet.get("review-todo").kind, "widget");
  assert.equal(sheet.get("bench-table").widget.state.rows[0].c_Reading.blockId, "rail-calc");
  assert.equal(sheet.get("review-todo").widget.state.rows[0].threadId, "review-thread");
  assert.equal(sheet.get("review-todo").widget.state.rows[0].done, false);
  assert.equal(manifest.get("review-thread").value.status, "resolved");
  assert.equal(manifest.get("review-reply").value.thread, "review-thread");
  assert.equal(manifest.get("rail-rule").value.origin.assertion, "rail-assertion");
  assert.deepEqual(sheet.get("notebook-sheet/settings").value.notesLayer, {id: "notes-default", print: false});
  assert.deepEqual(sheet.get("pen-stroke").ink.path, [5000000, 1000000, 128000000, 3000000, -1000000, 255000000]);
  assert.equal(sheet.get("fallback-widget").widget.fallback.assetRef.sha256, sheet.get("photo").asset.sha256);

  const engine = E.create(), file = (path, bytes) => ({path, bytes, sha256: F.sha256(bytes)});
  const attached = await engine.run({op: "manifest", record: file(manifestPath, manifestBytes)});
  const ref = attached.members.find(member => member.path === sheetPath);
  const {owner} = await engine.run({op: "owner", ref, record: file(sheetPath, sheetBytes)});
  const content = M.manifest(manifest).project;
  content.documents.push(owner);
  assert.equal(A.validate(content), content);
  const recreated = M.createDocument(owner);
  assert.deepEqual(recreated.header.requires, []);
  const settings = file => [...file.records()].find(row => row.kind === "documentSettings");
  const items = file => [...file.records()].filter(row => row.kind !== "documentSettings");
  assert.deepEqual(settings(recreated).value, settings(sheet).value);
  assert.deepEqual(items(recreated), items(sheet));
  const refs = [...manifest.records()].filter(row => row.kind === "document");
  assert.deepEqual(F.serialize(M.createManifest(content, {references: refs, entryDocument: owner.id, previous: manifest})), manifestBytes);
  const byId = new Map(owner.items.map(item => [item.id, item]));
  for (const name of ["AtriumMath", "AtriumCalculations", "AtriumSheetWidgetRuntime", "AtriumReviewNotes", "AtriumNotebookImages"]) {
    assert.equal(globalThis[name], undefined, "The required model does not load " + name);
  }
  for (const [id, kind] of Object.entries({"rich-note":"richtext", "math-note":"math", "rail-calc":"calculation",
    "bench-table":"widget", "review-todo":"widget", "fallback-widget":"widget", photo:"image", "photo-arrow":"imageMarkup",
    "sticky-note":"sticky", "callout-note":"callout", "pen-stroke":"inkStroke", "plain-text":null, "plain-label":null})) {
    assert.equal(A.notebookItemKind(byId.get(id)), kind, id);
  }
  assert.equal(A.notebookItemKind({kind: "textframe", role: "frame"}), null);
  assert.equal(A.notebookItemKind({kind: "image", src: "data:image/png;base64,"}), null);
  assert.equal(A.notebookItemKind({kind: "notesLayer"}), "notesLayer");
  assert.deepEqual(byId.get("pen-stroke").ink.path, [5, 1, 128, 3, -1, 255]);
  assert.equal(byId.get("rail-calc").text, "Vout = 3.3 V");

  // Named project font assets use the same owned reference as native image fallbacks.
  const font = {sha256: "a".repeat(64), mediaType: "font/ttf", byteLength: 128};
  const fontNote = {id: "embedded-font", kind: "richtext", richText: {font: {source: "asset", assetRef: font, license: "OFL-1.1"}}};
  assert.deepEqual(M.ownerDependencies(fontNote, {purpose: "display"}), [{...font, path: M.assetPath(font), ownerId: fontNote.id}]);

  const label = {...byId.get("plain-label"), text: "SENSE2"};
  const edit = {id: owner.id, kind: "schematic", put: [label], remove: []};
  const {plan} = await engine.run({op: "plan", changes: [edit], attachments: []});
  assert.deepEqual(plan.map(target => target.path), [sheetPath]);
  assert.equal(plan[0].expected, F.sha256(sheetBytes));
  assert.equal(plan[0].splice.edits.length, 1);
  const [{offset, remove, insert}] = plan[0].splice.edits;
  const after = string(sheetBytes.subarray(0, offset)) + insert + string(sheetBytes.subarray(offset + remove));
  assert.equal(after, string(sheetBytes).replace('"text":"SENSE"', '"text":"SENSE2"'));

  const unknown = {kind: "futureNotebookPayload", id: "future-note", settings: {precision: {digits: 4}}};
  const rows = [...sheet.records(), unknown];
  const compatible = M.parse(F.serialize(F.create(sheet.header, rows, M.readOptions("schematic", sheet.header.id))));
  assert.ok(compatible.isOpaque(unknown.id));
  assert.equal(compatible.readOnly, false);
  const future = M.parse(F.serialize(F.create({...sheet.header, formatVersion: "2.99"}, rows, M.readOptions("schematic", sheet.header.id))));
  assert.ok(future.isOpaque(unknown.id));
  const updated = F.applyDelta(future, M.documentEdits(future, owner, {put: [label]})).file;
  assert.deepEqual(updated.get(unknown.id), unknown);
  assert.equal(string(F.serialize(updated)), string(F.serialize(future)).replace('"text":"SENSE"', '"text":"SENSE2"'));
  console.log("format-2-notebook: immutable project and assets, bare projection, scoped Save and future opacity passed");
}

globalThis.__testDone = main().catch(error => {console.error(error); process.exitCode = 1;});
