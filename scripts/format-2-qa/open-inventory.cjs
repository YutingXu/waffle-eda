"use strict";

// The reader, version checks, and display dependencies come from the product.
const fs = require("node:fs");
const path = require("node:path");
const [product, manifest] = process.argv.slice(2);
for (const module of ["formats/format-2-codec", "formats/format-2-units", "formats/format-2-values", "formats/format-2-model"]) {
  require(path.join(product, "app", module + ".js"));
}
const Model = globalThis.AtriumFormat2Model;
const root = path.dirname(manifest);
const read = (relative, options) => {
  const member = path.resolve(root, relative);
  if (!member.startsWith(root + path.sep) || !fs.lstatSync(member).isFile()) throw Error("Invalid prepared member");
  return Model.parse(fs.readFileSync(member), options);
};
const file = read(path.basename(manifest), {kind:"project"});
if (file.header.formatVersion !== "2.0" || file.readOnly) throw Error("Expected an editable native 2.0 manifest");
const project = Model.manifest(file);
const documents = project.members.filter(row => ["schematic", "pcb", "drawing", "panel"].includes(row.kind));
const active = documents.find(row => row.id === project.entryDocument) || documents[0];
if (!active) throw Error("No visible native document");
const display = Model.documentDependencies(read(active.path, {kind:active.kind, id:active.id}));
const definitions = display.libraries.map(id => {
  const row = project.members.find(member => member.kind === "library" && member.id === id);
  if (!row) throw Error("A visible library definition is absent");
  return row.path;
});
console.log(JSON.stringify({activeKind:active.kind, activeId:active.id, documents:documents.length,
  visiblePaths:[path.basename(manifest), active.path, ...definitions, ...display.assets.map(asset => asset.path)]}));
