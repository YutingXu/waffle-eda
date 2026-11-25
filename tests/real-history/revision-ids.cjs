"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const {createHash} = require("node:crypto");
const worker = require.resolve("../../app/workers/diff-worker.js");
globalThis.self = globalThis;
globalThis.importScripts = (...names) => {
  for (const name of names) {
    const file = path.resolve(path.dirname(worker), name);
    vm.runInThisContext(fs.readFileSync(file, "utf8"), {filename: file});
  }
};
importScripts("diff-worker.js");
function board(x) {
  const text = '(kicad_pcb (version 20240108) (generator pcbnew) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) '+
    '(net 1 "TEST") (segment (start '+x+' 0) (end 8 8) (width 0.25) (layer "F.Cu") (net 1)))';
  return {blob:createHash("sha256").update(text).digest("hex"),files:[{name:"Board.kicad_pcb",data:Buffer.from(text).toString("base64")}]};
}
function read(snapshot) {
  let result;
  self.postMessage = value => { if (value.error) throw Error(value.error); result = value.result; };
  self.onmessage({data:{history:true,project:snapshot}});
  return result;
}
const first = read(board(0)), second = read(board(1));
read(board(2));  // Retire the first parsed side so the next request reads the original bytes again.
const again = read(board(0));
assert.notEqual(first,again);
assert.deepEqual(first,again);
assert.equal(first.documents[0].items.length,1);
assert.notEqual(first.documents[0].items[0].id,second.documents[0].items[0].id);
assert.throws(()=>Atrium.withRevisionIds(board(0).blob,()=>{throw Error("read failed");}),/read failed/);
assert.ok(!Atrium.id().startsWith("history-"));
console.log("PASS stable regenerated IDs within one immutable source snapshot and independent ordinary editor IDs");
