"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {execFileSync} = require("node:child_process");

// Generate independent grants with the same implementation as the signed macOS host.
module.exports = function macosScopes(manifest, files) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),"waffle-autosave-folders-"));
  try {
    const source = path.join(temp,"main.swift"), binary = path.join(temp,"grants");
    fs.writeFileSync(source,`import Foundation
for path in CommandLine.arguments.dropFirst(2) {
  let store = try FolderTransactions(root: URL(fileURLWithPath:path), manifest:CommandLine.arguments[1])
  let data = try JSONSerialization.data(withJSONObject:store.selection)
  print(String(decoding:data,as:UTF8.self))
}
`);
    execFileSync("xcrun",["swiftc",path.resolve(__dirname,"../../native/macos/FolderTransactions.swift"),source,"-o",binary]);
    const directories = ["left","right"].map(side=>path.join(temp,side,"Board"));
    for (const root of directories) for (const [name,bytes] of files) {
      const file = path.join(root,name);
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,bytes);
    }
    const grants = (...dirs) => execFileSync(binary,[manifest,...dirs],{encoding:"utf8"}).trim().split("\n").map(line=>JSON.parse(line));
    const [first,second,reopened] = grants(...directories,directories[0]);
    assert.equal(first.name,second.name);
    assert.equal(first.manifest,second.manifest);
    assert.match(first.draftScope,/^[0-9a-f]{64}$/); assert.match(second.draftScope,/^[0-9a-f]{64}$/);
    assert.notEqual(first.draftScope,second.draftScope);
    assert.notEqual(first.grant,reopened.grant); assert.equal(first.draftScope,reopened.draftScope);
    const renamed = path.join(temp,"renamed");
    fs.renameSync(directories[0],renamed);
    assert.equal(grants(renamed)[0].draftScope,first.draftScope);
    console.log("PASS macOS physical folders with identical names and bytes retain distinct draft scopes across reopen and rename");
    return [first.draftScope,second.draftScope];
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
};
