"use strict";
// Apricot's project boundary accepts native 2.0 records. Independent preferences,
// extensions, proposals and other versioned stores are covered by compat-stores.cjs.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
require("../../app/project/obsolete-project.js");
const {nativeRecords, nativeCAD} = require("../support/native-cad.cjs");
const obsolete = AtriumObsoleteProject, M = AtriumFormat2Model, F = AtriumFormat2;
const utf8 = value => new TextEncoder().encode(value);
const error = code => value => value?.code === code;

for (const name of ["v1.3-inline-step-models.atrium","v1.4-generic-parts.atrium","v1.5-altium-geometry.waffle"]) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname,"../fixtures/compat/projects",name)));
  const digest = F.sha256(bytes);
  assert.equal(obsolete.recognize(bytes,name), true);
  assert.throws(() => obsolete.reject(bytes,name), e => e.code === "pre-release-format" && e.message.includes("re-import"));
  assert.throws(() => M.parse(bytes));
  assert.equal(F.sha256(bytes),digest, "refusal preserves every source byte");
}
for (const [name, text] of [
  ["Older.waffle",'{"kind":"project","formatVersion":"1.5","id":"p"}\n'],
  ["Older.atrium.journal","ATRIUM-JOURNAL 1\npatch"],
  ["Copied.json",'{"format":"atrium","version":1,"documents":[]}']
]) assert.throws(() => obsolete.reject(utf8(text),name),error("pre-release-format"),name);

const {manifest, read} = nativeRecords("design-diff");
assert.equal(manifest.header.formatVersion,"2.0");
assert.equal(obsolete.recognize(read("Project.waffle"),"Project.waffle"),false);
assert.equal(M.manifest(manifest).releases.length,12);
assert.equal(nativeCAD("design-diff").documents.length,2);
const future = options => F.canonical({kind:"project",id:"p",name:"Future project",...options})+"\n";
assert.throws(() => M.parse(future({formatVersion:"3.0"})),error("unsupported-version"));
const newer = M.parse(future({formatVersion:"3.0",compatibleWith:"2.0"}));
assert.equal(newer.readOnly,true);
assert.throws(() => F.edit(newer,{put:[{kind:"projectSetting",id:"change",key:"title",value:"Edited"}]}),error("read-only-format"));
const requiredBytes = future({formatVersion:"2.1",requires:["future-control"]});
const required = M.parse(requiredBytes);
assert.equal(required.readOnly, true);
assert.match(F.unsupportedMessage(required), /future-control.*native format 2\.1/);
assert.equal(new TextDecoder().decode(F.serialize(required)), requiredBytes);
assert.throws(() => F.edit(required, {put:[]}), error("read-only-format"));
console.log("Native 2.0 and frozen revisions open, obsolete designs refuse without writes, unsupported formats preserve source bytes");
