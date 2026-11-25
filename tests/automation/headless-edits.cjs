"use strict";

const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");
for (const name of ["model", "automation/legacy-command-contract", "commands-headless"])
  require(appFile(name + ".js"));
const A = Atrium, H = AtriumCommandsHeadless;

// A rejected add_items batch leaves the existing item list intact.
{
  const project = A.project("Add items");
  const pcb = project.documents.find(doc => doc.kind === "pcb");
  const via = {id: "existing", kind: "via", x: 1, y: 2, diameter: .6, drill: .3, layer: "Multi"};
  pcb.items.push(via);
  const items = pcb.items;
  const first = {...via, id: "added", x: 3};
  for (const invalid of [{kind: "not-a-kind"}, {...via}]) {
    assert.throws(() => H.run(project, "add_items", {document_id: pcb.id, items: [first, invalid]}));
    assert.deepEqual(items, [via], "reject the entire batch");
    assert.equal(pcb.items, items);
    assert.equal(pcb.items[0], via);
  }
  assert.deepEqual(H.run(project, "add_items", {document_id: pcb.id, items: [first]}).added, ["added"]);
  assert.deepEqual(pcb.items.map(item => item.id), ["existing", "added"]);
}

// Exact IDs win over a name on an earlier document.
{
  const project = A.project("Document lookup");
  const [sch, pcb] = project.documents;
  const grid = sch.grid;
  sch.name = pcb.id;
  const changed = H.run(project, "set_grid", {document_id: pcb.id, grid: 1.5});
  assert.equal(changed.document_id, pcb.id);
  assert.equal(pcb.grid, 1.5);
  assert.equal(sch.grid, grid);
  assert.equal(H.run(project, "set_grid", {document_id: pcb.name, grid: .5}).document_id, pcb.id);
  assert.equal(pcb.grid, .5);
}

console.log("headless edits: ok");
