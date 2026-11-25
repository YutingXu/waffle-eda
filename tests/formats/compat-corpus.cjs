// Exercise the same bounded detector that guards the editor's reader and translator.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
require("../../app/project/obsolete-project.js");
const O = AtriumObsoleteProject, root = path.join(__dirname,"../fixtures/compat");
const index = JSON.parse(fs.readFileSync(path.join(root,"index.json"),"utf8"));
for (const row of index.projects) {
  const bytes = fs.readFileSync(path.join(root,"projects",row.file));
  let error;
  try { O.reject(bytes,row.file); } catch (e) { error = e; }
  assert.equal(error?.code,row.expect,row.file);
  assert.equal(error?.message,O.note,row.file);
}
const native = path.join(__dirname,"../fixtures/format-2");
for (const {directory,manifest} of JSON.parse(fs.readFileSync(path.join(native,"projects.json"),"utf8"))) {
  assert.equal(O.recognize(fs.readFileSync(path.join(native,directory,manifest)),manifest),false,manifest);
}
console.log("PASS " + index.projects.length + " historical projects and the native fixture headers");
