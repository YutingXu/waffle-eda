"use strict";

// The frozen four-member control is only an input to the amended editor writer.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [product, original, destination] = process.argv.slice(2);

for (const module of ["core/uuid-v7", "core/model", "project/source-file", "formats/translator-provenance",
  "formats/format-2-codec", "formats/format-2-units", "formats/format-2-values", "formats/format-2-model"]) {
  require(path.join(product, "app", module + ".js"));
}
const M = globalThis.AtriumFormat2Model, F = globalThis.AtriumFormat2, U = globalThis.AtriumUUID;

function physical(root, relative) {
  const target = path.resolve(root, relative);
  assert.ok(target.startsWith(root + path.sep), "the member stays in its test folder");
  return target;
}

function project(root, {verifyDurable = false} = {}) {
  const load = (name, kind, id) => {
    const file = M.parse(fs.readFileSync(physical(root, name)), {kind, id});
    assert.equal(file.readOnly, false, "the control is editable");
    if (verifyDurable) {
      assert.ok(U.isV7(file.header.id), "the amended owner uses UUIDv7");
      for (const row of file.records()) assert.ok(U.isV7(row.id), "amended authored rows use UUIDv7");
    }
    return file;
  };
  const manifest = M.manifest(load("project.waffle", "project"));
  for (const {path:name, kind, id, name:title, order} of manifest.members) {
    const file = load(name, kind, id);
    const options = {name:title, order};
    if (kind === "library") manifest.project.library.push(M.library(file, options));
    else {
      assert.ok(["schematic", "pcb"].includes(kind), "a known dense-control document kind");
      manifest.project.documents.push(M.document(file, options));
    }
  }
  return {model:manifest.project, entry:manifest.entryDocument};
}

function geometry({model, entry}) {
  const replacements = new Map([[model.id, "project"]]);
  model.library.forEach((def, n) => replacements.set(def.id, `definition:${n}`));
  model.documents.forEach((doc, d) => {
    replacements.set(doc.id, `document:${d}`);
    doc.items.forEach((item, i) => replacements.set(item.id, `item:${d}:${i}`));
  });
  const normalized = value => {
    if (typeof value === "string") return replacements.get(value) ?? value;
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])]));
    return value;
  };
  return JSON.stringify(normalized({model, entry}));
}

const frozen = project(original), authored = structuredClone(frozen.model);
const active = authored.documents.findIndex(doc => doc.id === frozen.entry);
assert.equal(authored.documents[active].kind, "pcb");
assert.deepEqual(authored.documents.map(doc => doc.items.length).sort((a, b) => a - b), [2, 25600]);
globalThis.AtriumTranslatorProvenance.adoptIdentities(authored, {files:[]});
const converted = M.fromEditor(authored, {manifestPath:"project.waffle", entryDocument:authored.documents[active].id});
assert.equal(converted.files.length, 4);
assert.equal(converted.models.length + converted.assets.length, 0);
fs.mkdirSync(destination, {mode:0o700});
for (const member of converted.files) {
  const target = physical(destination, member.path);
  fs.mkdirSync(path.dirname(target), {recursive:true, mode:0o700});
  fs.writeFileSync(target, F.serialize(member.file), {flag:"wx", mode:0o600});
}
const reopened = project(destination, {verifyDurable:true});
const projection = geometry(frozen);
assert.ok(geometry(reopened) === projection, "normal re-authoring preserves every projected field apart from rebound identities");
assert.notEqual(reopened.model.id, frozen.model.id, "the measured project has a newly authored identity");
console.log(JSON.stringify({geometrySHA256:crypto.createHash("sha256").update(projection).digest("hex"),
  geometryUnchanged:true, projectAndAuthoredRowsUUIDv7:true}));
