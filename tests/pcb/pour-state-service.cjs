"use strict";

const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");
for (const name of ["model", "parts", "spatial", "sch-objects", "hierarchy", "board-shape", "stackup", "impedance",
  "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "design-query-record",
  "query", "net-intent", "signals", "rules", "viastack", "polygon-pour", "pour-manager", "net-ties", "connectivity",
  "connectivity-live", "fab-outputs"]) require(appFile(name + ".js"));

const {board} = require("../support/stitched-ground.cjs");
const A = Atrium, P = AtriumPolygonPour, Archive = AtriumPCBPours, C = AtriumConnectivity, F = AtriumFabOutputs;
const rectangle = [[1,1],[8,1],[8,8],[1,8]];
const setGap = (project, gap) => AtriumProjectRules.edit(project, book => {
  book.list.find(r => r.type === "clearance" && AtriumDesignQueryRecord.isAll(r.scope)).gap = gap;
});
const missing = result => result.nets.find(n => n.name === "GND").missing;

{
  const {doc,defs,project} = board();
  const foreign = A.clone(project);
  setGap(foreign, .85);
  assert.equal(P.inspectCopper(doc,defs,{project}).state, "current");
  assert.equal(P.inspectCopper(doc,defs,{project:foreign}).state, "stale");
  assert.equal(missing(C.inspect(doc,defs,undefined,{project})), 0);
  const live = C.inspect(doc,defs,undefined,{project:foreign}), full = C.inspectFull(doc,defs,{project:foreign});
  assert.deepEqual(live.airwires, full.airwires);
  assert.equal(missing(full), 1, "both graph paths use the explicit project");

  const imported = Archive.region([rectangle],"Top","GND");
  doc.items = [];
  doc.pcbDrawing = {annotations:{},pours:[imported]};
  Archive.storeSignature(doc,defs,project);
  assert.equal(Archive.matchesSignature(doc,defs,foreign), false);
  assert.equal(F.pourStatus(doc,defs,project), "current");
  assert.equal(F.pourStatus(doc,defs,foreign), "stale");
  const plotted = P.outputCopper(doc,defs,{project:foreign,solve:false});
  assert.equal(plotted.regions[0], imported);
  assert.deepEqual(plotted.imported, {count:1,fresh:false}, "preserve imported metal and report its true provenance");
  doc.pcbDrawing.sourceFill = true;
  Archive.storeSignature(doc,defs,project);
  const stored = P.outputCopper(doc,defs,{project,solve:false});
  assert.equal(F.pourStatus(doc,defs,project),"current");
  assert.equal(stored.state,"current","unowned source artwork needs no editable-owner indexing");
  assert.equal(stored.regions[0],imported);
  assert.equal(doc.pcbDrawing.sourceFill,true);
}

{
  const compiler = globalThis.AtriumDesignQuery;
  const {doc,defs,project} = board({imported:true});
  const initial = JSON.stringify(doc);
  let requests = 0;
  try {
    delete globalThis.AtriumDesignQuery;
    assert.equal(P.inspectCopper(doc,defs,{project}).state,"unknown","unavailable compiler cannot prove the board is stale");
    globalThis.AtriumLazy = {need() { requests++; throw Error("unexpected rule load"); }};
    const report = P.inspectCopper(doc,defs,{project});
    assert.equal(report.state,"pending");
    assert.equal(report.reason,"AtriumDesignQuery");
    assert.deepEqual(report.stale,[]);
    assert.deepEqual(report.verified,[]);
    assert.equal(AtriumPourManager.rows(doc,defs,{project})[0].state,"pending");
    assert.equal(P.outputCopper(doc,defs,{project,solve:false}).state,"pending");
    assert.equal(requests,0,"availability queries, manager rows and output probes do not load modules");
  } finally {
    globalThis.AtriumDesignQuery = compiler;
    delete globalThis.AtriumLazy;
  }
  assert.equal(P.inspectCopper(doc,defs,{project}).reason,"source-adoption");
  assert.equal(P.outputCopper(doc,defs,{project,solve:false}).state,"pending");
  const output = P.outputCopper(doc,defs,{project});
  assert.equal(output.state,"current");
  assert.deepEqual(output.regions.map(r => r.data),doc.pcbDrawing.pours.map(r => r.data));
  assert.ok(output.regions.every(r=>r.links.length>1));
  assert.equal(JSON.stringify(doc),initial,"the exact output links a private copy of imported regions");
  assert.equal(P.adopt(doc,defs,{project},false),true);
  assert.deepEqual(P.inspectCopper(doc,defs,{project}).verified,["pour-gnd"]);
  assert.equal(missing(C.inspectFull(doc,defs,{project})),0);
}

{
  const {doc,defs,project} = board();
  doc.pcbDrawing = {annotations:{},sourceFill:"pour"};
  delete doc.sourcePourSignature;
  for (const p of P.polygons(doc)) delete p.copperBasis;
  const initial = JSON.stringify(doc);
  assert.equal(P.inspectCopper(doc,defs,{project}).reason, "source-fill");
  const noSolve = P.outputCopper(doc,defs,{project,solve:false});
  assert.equal(noSolve.state,"pending");
  assert.deepEqual(noSolve.pending,["pour-gnd"]);
  assert.equal(JSON.stringify(doc),initial);
  const exact = P.outputCopper(doc,defs,{project});
  assert.equal(exact.state,"filled");
  assert.ok(exact.regions.length);
  assert.equal(JSON.stringify(doc),initial,"an Eagle-style first fill also leaves the input intact");
  assert.equal(P.outputCopper(doc,defs,{project,evaluatedOnly:true}).state,"none","editable exchange keeps this zone unpoured");
}

console.log("PASS pure pour state, explicit project, preserved source artwork and staged source preparation");
