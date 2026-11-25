"use strict";
require("../support/import-worker.cjs")();
// Synthetic browser selections: folder permission belongs to the chosen directory, and the
// manifest determines which of its documents the editor opens.
const assert = require("node:assert/strict");
for (const name of ["model","io","import-worker-client"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const file = (name, contents, relative = "") => ({
  name, webkitRelativePath:relative, async arrayBuffer() { return new TextEncoder().encode(contents).buffer; }
});
const manifest = "[Document1]\r\nDocumentPath=Left\\Sheet.SchDoc\r\n[Document2]\r\nDocumentPath=Right\\Sheet.SchDoc\r\n" +
  "[Document3]\r\nDocumentPath=Parts.SchLib\r\n[GeneratedDocument1]\r\nDocumentPath=Old.SchDoc\r\n";
async function test() {
  const top = file("Control.PrjPcb",manifest), folder = [
    file("Control.PrjPcb",manifest,"Root/Control.PrjPcb"), file("Sheet.SchDoc","right","Root/Right/Sheet.SchDoc"),
    file("Parts.SchLib","parts","Root/Parts.SchLib"), file("Control.PrjPcb","another project","Root/Reference/Control.PrjPcb"),
    file("Old.SchDoc","old","Root/Old.SchDoc"), file("Sheet.SchDoc","left","Root/Left/Sheet.SchDoc")
  ];
  const imported = await AtriumImport.projectFiles([top], async () => folder);
  assert.deepEqual(imported, [top, folder[5], folder[1], folder[2]]);
  assert.deepEqual(await AtriumImport.projectFiles([top], async () => []), []);
  await assert.rejects(AtriumImport.projectFiles([top], async () => [file(top.name,"other","Root/"+top.name)]), /containing/);
  const seen = {...top,altiumPath:top.name};
  assert.deepEqual(await AtriumImport.projectFiles([seen], () => { throw Error("native picker re-opened"); }), [seen]);
  const localSelection = [top, folder[2]];
  assert.deepEqual(await AtriumImport.projectFiles(localSelection), localSelection);
  await assert.rejects(AtriumImport.projectFiles([top, seen]), /one Altium project/);
  console.log("PASS Altium browser folder resolution, nested names, ignored files, cancellation, native and explicit selections");
}
test().catch(e => { console.error(e); process.exitCode = 1; });
