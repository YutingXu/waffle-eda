"use strict";

const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");
for (const name of ["model", "parts", "sch-objects", "sch-object-tools", "hierarchy", "stackup", "viastack", "hdi",
  "automation/legacy-command-contract", "commands-headless"])
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

// An HDI preset must fit before the command changes the board or its rules.
{
  const project = A.project("HDI preflight");
  const pcb = project.documents.find(d => d.kind === "pcb");
  const args = {document_id: pcb.id, build_up: "2"};
  for (const layers of ["2", "4"]) {
    pcb.stackup = {version: 1, layers: AtriumStackup.preset(layers).layers};
    const before = JSON.stringify(project);
    assert.throws(() => H.run(project, "hdi_setup", args), /more copper layers/);
    assert.equal(JSON.stringify(project), before);
  }
  pcb.stackup = {version: 1, layers: AtriumStackup.preset("6").layers};
  assert.equal(H.run(project, "hdi_setup", {...args, rules: false}).build_up, "2+2+2");
  assert.equal(H.run(project, "hdi_setup", {...args, build_up: "none"}).build_up, null);
  assert.equal(pcb.hdi, undefined);
}

async function sheetSyncRegression() {
  const S = AtriumSchObjects, resistor = AtriumParts.catalogue.find(d => d.id === "std-r");
  for (const command of ["headless", "editor"]) {
    const project = A.project("Sheet sync", [resistor]), parent = project.documents[0];
    const child = A.sheet("schematic", "Child"), defs = new Map([[resistor.id, resistor]]);
    project.documents.push(child);
    const symbol = S.make("sheetsymbol", [0, 0], {w:20.32, h:10.16, name:"U", sheet:child.id,
      entries:[{id:"a", name:"A", side:"right", offset:5.08, io:"output"}]});
    const entry = S.entryPoint(symbol, symbol.entries[0]), tail = [entry[0] + 10, entry[1]];
    parent.items.push(symbol, {id:"wire", kind:"wire", points:[entry, tail]},
      {id:"label", kind:"netlabel", x:tail[0], y:tail[1], text:"KEEP"});
    const part = A.instantiate(project, resistor, [10.16, 0]);
    const pin = A.pins(part, resistor, child.kind).find(p => p.number === "1").at;
    child.items.push(part, S.make("port", [0, 0], {text:"A", io:"output"}),
      {id:"child-wire", kind:"wire", points:[[0, 0], pin]},
      S.make("port", [0, 10], {text:"LONG_PORT_NAME_THAT_WIDENS", io:"output"}));
    const net = () => AtriumHierarchy.compile(project, {defs, scope:"hierarchical"}).netOf(child.id, part.id, "1");
    assert.equal(net(), "KEEP");
    if (command === "headless") {
      const result = H.run(project, "sync_sheet_entries", {document_id:parent.id, id:symbol.id});
      assert.deepEqual(result.added, ["LONG_PORT_NAME_THAT_WIDENS"]);
    } else {
      await S.command("sch-sync-entries", {project:() => project, doc:() => parent, defs:() => defs,
        selected:() => symbol, edit:fn => fn(), info() {}});
    }
    assert.equal(symbol.entries.length, 2);
    assert.ok(symbol.w > entry[0], "the new port expands the symbol");
    assert.equal(net(), "KEEP", command + " sync keeps the existing entry on its parent net");
  }
}

sheetSyncRegression().then(() => console.log("headless edits: ok")).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
