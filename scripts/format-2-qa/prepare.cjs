"use strict";
// Historical QA setup. Run with the pre-Apricot product pin from the associated report.
// Convert an immutable 1.5 native input with that product's model codec into an isolated
// format-2 input. Private member paths, object identifiers and digests stay inside the trial.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const [product, snapshot, target, meta, privacy] = process.argv.slice(2);
const isPrivate = privacy === "private";
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
function put(relative, bytes) {
  const destination = path.resolve(target, relative);
  if (!destination.startsWith(path.resolve(target) + path.sep)) throw Error("Bad member path");
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.writeFileSync(destination, bytes, {flag:"wx"});
}
try {
  for (const mod of ["core/model", "compat", "pcb/pcb-appearance", "formats/io", "project/source-file", "project/revisions", "formats/sexpr",
                     "core/signals", "formats/translator-provenance", "formats/format-2-codec", "formats/format-2-units", "formats/format-2-values", "formats/format-2-model"]) {
    require(path.resolve(product, "app", mod + ".js"));
  }
  const modelCodec = path.resolve(product, "app", "formats/format-2-models.js");
  if (fs.existsSync(modelCodec)) {
    for (const mod of ["core/zip", "vendor/zipjs-deflate", "formats/format-2-models"]) require(path.resolve(product, "app", mod + ".js"));
  }
  const frozen = fs.readFileSync(snapshot);
  const input = AtriumIO.read("project.waffle", frozen).project;
  const originalId = input.documents[0].id;
  const formatted = AtriumFormat2Model.fromLegacy(input, {entryDocument:originalId, manifestPath:"project.waffle"});
  fs.mkdirSync(target, {mode:0o700});
  const byID = new Map(formatted.files.map(member => [member.file.header.id, member]));
  const first = byID.get(originalId);
  if (!first) throw Error("Format conversion lost the first document");
  const dependencies = AtriumFormat2Model.documentDependencies(first.file);
  const visiblePaths = new Set([formatted.manifestPath, first.path]);
  for (const id of dependencies.libraries) {
    if (!byID.has(id)) throw Error("The active document refers to a missing definition");
    visiblePaths.add(byID.get(id).path);
  }
  for (const asset of dependencies.assets) visiblePaths.add(asset.path);
  let textBytes = 0, assetBytes = 0, modelBytes = 0, compressedBytes = 0;
  for (const {file, path: name} of formatted.files) {
    const bytes = AtriumFormat2.serialize(file);
    put(name, bytes);
    textBytes += bytes.byteLength;
  }
  for (const {path: name, bytes, ref} of formatted.assets) {
    if (digest(bytes) !== ref.sha256 || bytes.byteLength !== ref.byteLength) throw Error("Attachment identity failed");
    put(name, bytes);
    assetBytes += bytes.byteLength;
  }
  // Supply the spec's reference bytes as oracle input. This tests actual codec output, reads and native saves.
  // Shipping model compression has a separate conformance gate.
  for (const {path: name, raw, ref} of formatted.models) {
    if (digest(raw) !== ref.sha256 || raw.byteLength !== ref.byteLength) throw Error("Model identity failed");
    const work = fs.mkdtempSync(path.join(path.dirname(target), "reference-"));
    const inputFile = path.join(work, "input");
    const outputFile = path.join(work, "output");
    try {
      fs.writeFileSync(inputFile, raw, {mode:0o600});
      const gzip = spawnSync("python3", [path.join(__dirname, "refgzip.py"), inputFile, outputFile], {timeout:45000});
      if (gzip.status !== 0) throw Error("The 1.2.12 reference encoder failed");
      const oracle = fs.readFileSync(outputFile);
      const packed = globalThis.AtriumFormat2Models ? Buffer.from(AtriumFormat2Models.encode(raw)) : oracle;
      if (!packed.equals(oracle)) throw Error("The production model encoder differs from the pinned reference");
      put(name, packed);
      modelBytes += raw.byteLength;
      compressedBytes += packed.byteLength;
    } finally { fs.rmSync(work, {recursive:true, force:true}); }
  }
  const receipts = {manifest:formatted.manifestPath, items:input.documents.map(d=>d.items.length),
    visiblePaths: [...visiblePaths], sourceBytes:frozen.length, textBytes, assetBytes, modelBytes, compressedBytes,
    coreBytes:textBytes + assetBytes + compressedBytes, models:formatted.models.length,
    members:formatted.files.length + formatted.assets.length + formatted.models.length,
    productionModelCodec:!!globalThis.AtriumFormat2Models,
    frozenVerified: digest(fs.readFileSync(snapshot)) === digest(frozen)};
  if (!receipts.frozenVerified) throw Error("Frozen source changed during conversion");
  fs.writeFileSync(meta, JSON.stringify(receipts) + "\n", {flag:"wx", mode:0o600});
  console.log(JSON.stringify({bytes:receipts.coreBytes, models:receipts.models, modelBytes, compressedBytes, members:receipts.members}));
} catch (error) {
  console.error(isPrivate ? "Format-2 preparation failed on the approved input." : (error.stack || error.message));
  process.exitCode = 1;
}
