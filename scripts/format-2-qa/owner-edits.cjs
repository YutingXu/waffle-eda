"use strict";
// Send real codec edit plans to the independent native/Git driver; the caller supplies a scratch folder.
const fs = require("node:fs");
const path = require("node:path");
const [product, folder, filename, which, mode, repetitions] = process.argv.slice(2);
for (const key of ["core/model", "pcb/pcb-appearance", "project/source-file", "formats/format-2-codec", "formats/format-2-units", "formats/format-2-values", "formats/format-2-model"])
  require(path.resolve(product, "app", key + ".js"));
require(path.join(__dirname, "..", "format-baseline", "edits.js"));
const F = AtriumFormat2, M = AtriumFormat2Model;
const load = member => M.parse(fs.readFileSync(path.join(folder, member)));
const manifest = load(filename);
const info = M.manifest(manifest);
const p = info.project;
const cursors = new Map();
for (const row of info.members) {
  const document = Object.hasOwn(F.documentSuffix, row.kind);
  if (!document && row.kind !== "library") continue;
  const file = load(row.path);
  if (document) {
    const doc = M.document(file, {name:row.name});
    p.documents.push(doc);
    cursors.set(doc.id, {file, path:row.path});
  } else p.library.push(M.library(file));
}
const picked = WaffleBaselineEdits.select(p, {kicadGlobalLabel:which === "lily58"})[mode];
if (!picked) throw Error("No benchmark target");
const cursor = cursors.get(picked.doc.id);
const def = p.library.find(value => value.id === picked.item.def);
for (let n = 1; n <= Number(repetitions); n++) {
  const item = mode === "track" ? {...picked.item, id:n === 1 ? picked.item.id : picked.item.id + "-" + n} : picked.item;
  if (mode === "part") Atrium.transformPart(picked.doc, item, def, {x:item.x + WaffleBaselineEdits.MOVE_MM});
  else if (mode === "label") item.text += WaffleBaselineEdits.LABEL_SUFFIX;
  else picked.doc.items.push(item);
  const patch = F.applyDelta(cursor.file, M.documentEdits(cursor.file, picked.doc, {put:[item]}));
  cursor.file = patch.file;
  const line = {n, projectId:manifest.header.id, path:cursor.path, edits:patch.splices};
  if (n === Number(repetitions)) line.finalSha = F.sha256(F.serialize(cursor.file));
  process.stdout.write(JSON.stringify(line) + "\n");
}
