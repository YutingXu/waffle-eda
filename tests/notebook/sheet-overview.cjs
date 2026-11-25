"use strict";
const assert = require("node:assert/strict");
for (const m of ["model", "sch-objects", "hierarchy", "sheet-connections", "sheet-overview-model"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const H = AtriumHierarchy, M = AtriumSheetOverviewModel;
const sheet = name => ({id:name, kind:"schematic", name, items:[]});
const source = (doc, kind, name, y = 0) => {
  const item = {id:doc.id+"/"+doc.items.length, kind, text:name, x:8, y};
  doc.items.push(item);
  return item;
};
function symbol(doc, name, child, names = []) {
  const item = {id:doc.id+"/"+doc.items.length, kind:"sheetsymbol", name, sheet:child, x:60, y:doc.items.length*40, w:25, h:30,
    entries:names.map((name, i) => ({id:"e"+i, name, side:"left", offset:5+5*i}))};
  doc.items.push(item);
  return item;
}
function build(documents, scope) {
  const project = {documents, library:[]}, before = JSON.stringify(project);
  const compiled = H.compile(project, {scope});
  const graph = M.build(compiled, AtriumSheetConnections.index(compiled).nets);
  assert.equal(JSON.stringify(project), before, "building an overview leaves the project untouched");
  return {compiled, graph};
}

{
  const top = sheet("Control"), child = sheet("Sensor"), sibling = sheet("Analog"), leaf = sheet("Probe");
  const sensor = symbol(top,"Sensors",child.id,["CLK","DATA[0..3]"]);
  symbol(top,"Analog input",sibling.id);
  symbol(child,"Probe",leaf.id);
  symbol(leaf,"Loop",top.id);
  symbol(top,"Missing","missing");
  const clk = source(child,"port","CLK"), bus = source(child,"port","DATA[0..3]",8);
  source(child,"offsheet","TRIG",16); source(sibling,"offsheet","TRIG");
  source(child,"netlabel","LOCAL",24); source(sibling,"netlabel","LOCAL",24);
  const {compiled, graph} = build([top,child,sibling,leaf], "hierarchical");
  assert.equal(graph.hierarchical,true);
  assert.equal(graph.sheetCount,4);
  const [root,sense,probe,analog] = graph.nodes;
  assert.deepEqual(graph.nodes.map(n => n.doc.id), [top.id, child.id, leaf.id, sibling.id]);
  assert.deepEqual(root.children,[sense,analog]);
  assert.equal(probe.parent,sense);
  assert.ok(root.x < sense.x && sense.x < probe.x, "sheet symbols set column depth");
  assert.ok(analog.y - sense.y >= M.height, "branches do not overlap");
  assert.equal(M.adjacent(graph.nodes,sense,"ArrowLeft"),root);
  assert.equal(M.adjacent(graph.nodes,sense,"ArrowRight"),probe);
  assert.equal(M.adjacent(graph.nodes,sense,"ArrowDown"),analog);
  assert.equal(M.adjacent(graph.nodes,sense,"End"),analog);
  assert.ok(compiled.issues.some(i => i.kind === "cycle"));
  assert.ok(compiled.issues.some(i => i.kind === "missingSheet"));
  assert.deepEqual(graph.links.map(l => l.name), ["CLK", "DATA[0..3]", "TRIG"], "use the compiled scope, including bare bus members");
  const [clock, data, trigger] = graph.links;
  assert.equal(clock.a.entry, sensor.entries[0]); assert.equal(clock.b.item,clk);
  assert.equal(data.a.entry, sensor.entries[1]); assert.equal(data.b.item,bus);
  assert.equal(data.bus,true);
  assert.equal(trigger.from,sense); assert.equal(trigger.to,analog);
  assert.notEqual(M.wire(root,sense).d, M.wire(root,sense,0,true).d, "hierarchy and electrical strokes are distinct");
}

{
  const top = sheet("Top"), channel = sheet("Channel"), leaf = sheet("Channel IO");
  symbol(top,"Repeat(CH,1,256)",channel.id,["Repeat(SIG)"]);
  symbol(channel,"IO",leaf.id);
  source(top,"netlabel","SIG1"); source(top,"netlabel","SIG256",8);
  source(channel,"port","SIG");
  const {graph} = build([top,channel,leaf], "hierarchical");
  assert.equal(graph.nodes.length,3);
  assert.equal(graph.nodes[1].instances.length,256);
  assert.equal(graph.nodes[2].instances.length,256);
  assert.equal(graph.nodes[2].parent,graph.nodes[1]);
  assert.equal(graph.links.find(l => l.name === "SIG1").b.instance.label,"CH1");
  assert.equal(graph.links.find(l => l.name === "SIG256").b.instance.label,"CH256");
}

{
  const docs = Array.from({length:128}, (_,i) => sheet("Sheet " + i));
  for (const d of docs) source(d,"power","GND");
  for (const d of docs.slice(0,2)) {
    source(d,"netlabel","LOCAL",8);
    d.items.push({id:d.id+"wire", kind:"wire", points:[[20,20],[30,20]], net:"WIRED"});
  }
  const {graph} = build(docs, "global");
  assert.equal(graph.hierarchical,false);
  assert.equal(graph.links.length,129);
  assert.equal(graph.links.filter(l => l.name === "GND").length,127, "shared rails expand linearly across roots");
  assert.equal(graph.links.find(l => l.name === "WIRED").b.kind,"wire");
  assert.equal(M.adjacent(graph.nodes,graph.nodes[0],"ArrowRight"),graph.nodes[1]);
  assert.ok(build(docs,"flat").graph.links.every(l => l.name === "GND"), "Flat leaves name-only labels and wires local");
  assert.equal(build([{id:"pcb", kind:"pcb", items:[]}], "automatic").graph.nodes.length,0);
}

console.log("Sheet overview: hierarchy, buses, cycles, missing sheets, repeated channels, flat/global and bounded shared rails");
