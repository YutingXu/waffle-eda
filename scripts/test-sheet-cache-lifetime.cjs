"use strict";
// node --expose-gc scripts/test-sheet-cache-lifetime.cjs
// Retain a working project and its live ERC cache, then check that old compiled nets can die.
const assert = require("node:assert/strict");
for (const mod of ["core/model", "library/parts", "schematic/sch-objects", "project/hierarchy", "schematic/multichannel", "checks/rules", "checks/project-rules", "checks/erc", "history/undo-store"])
  require("../app/" + mod + ".js");
require("../tests/schematic/sch-bench-project.js");
if (!global.gc) throw Error("Run this check with node --expose-gc.");

async function retained(mode) {
  const {project} = makeAtriumSchBenchProject({sheets:18, cells:2});
  const sheets = project.documents.filter(d => d.kind === "schematic");
  const defs = new Map(project.library.map(d => [d.id, d])), cache = new WeakMap();
  const refs = [], U = AtriumUndoStore;
  U.mark(project); U.prime();
  function editAndCompile(sheet) {
    const label = sheet.items.find(i => i.kind === "netlabel");
    label.x += .15; U.record(project, {doc:sheet, items:[label]});
    const h = mode === "erc" ? AtriumERC.run(project, {cache}).hierarchy : AtriumHierarchy[mode](project, {defs});
    refs.push({result:new WeakRef(h), nets:new WeakRef(h.nets)});
  }
  for (let k = 1; k <= 14; k++) editAndCompile(sheets[k]);
  // A WeakRef target stays alive through the current JS job, even when gc() runs.
  for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); global.gc(); }
  const count = key => refs.filter(r => r[key].deref()).length;
  const expected = mode === "compile" ? 0 : 1;
  assert.equal(count("result"), expected, mode + " retains only its current result");
  assert.equal(count("nets"), expected, mode + " releases all prior project net tables");
  if (mode === "erc") assert.ok(cache.get(project));
  U.reset();
}
(async () => {
  for (const mode of ["compile", "compileCached", "erc"]) await retained(mode);
  console.log("PASS full, cached and live ERC released obsolete hierarchy generations");
})().catch(e => { console.error(e); process.exitCode = 1; });
