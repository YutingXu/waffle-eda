"use strict";

const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");
for (const name of ["model", "pcb-pours", "polygon-pour", "board-shape", "spatial", "connectivity", "connectivity-live",
  "net-ties", "net-intent", "signals", "pcb-appearance", "geometry", "rules", "viastack"]) require(appFile(name + ".js"));
const {nativeRoundTrip} = require("../support/native-cad.cjs");

const A = Atrium, P = AtriumPolygonPour, Archive = AtriumPCBPours, C = AtriumConnectivity, defs = new Map();
const rectangle = (x, y, right, top) => [[x,y],[right,y],[right,top],[x,top]];
const docOf = p => p.documents.find(d=>d.kind==="pcb");
const track = (id, net, points, layer="Top") => ({id,kind:"track",net,points,layer,width:.2});
const misses = (result, net) => result.nets.find(row=>row.name===net).missing;
function fixture(points) {
  const project = A.project("Stored contour boundary");
  const doc = docOf(project), contour = rectangle(0,0,10,10);
  doc.outline = rectangle(-2,-2,30,14);
  doc.items = [
    track("anchor","N",[[2,5],[3,5]]), track("probe","N",points),
    track("other-a","OTHER",[[21,5],[23,5]],"Bottom"), track("other-b","OTHER",[[23,5],[25,5]],"Bottom"),
    P.make(contour,{id:"zone",layer:"Top",net:"N",removeDeadCopper:false})
  ];
  doc.pcbDrawing = {annotations:{},sourceFill:true,pours:[
    Archive.region([contour],"Top","N",{polygon:"zone",source:"altium",links:[]})
  ]};
  Archive.storeSignature(doc,defs,project);
  return {project, doc};
}
function graph(project) {
  const doc = docOf(project);
  const live = C.inspect(doc,defs,undefined,{project});
  const full = C.inspectFull(doc,defs,{project});
  assert.deepEqual(live.airwires,full.airwires);
  assert.deepEqual(live.nets,full.nets);
  assert.equal(misses(full,"OTHER"),0);
  return full;
}
const payload = r => [r.source,r.layer,r.net,r.data,r.arcs];
for (const {label, points, wanted} of [
  {label:"enter the highest horizontal edge", points:[[5,11],[5,8]], wanted:true},
  {label:"leave the highest horizontal edge", points:[[5,8],[5,11]], wanted:true},
  {label:"enter the lowest horizontal edge", points:[[5,-1],[5,2]], wanted:true},
  {label:"remain just outside copper", points:[[5,11],[5,10.103]], wanted:false},
  {label:"pass along the outside", points:[[4,10.103],[6,10.103]], wanted:false}
]) {
  const {project,doc} = fixture(points), region=doc.pcbDrawing.pours[0], stored=payload(region);
  const raw=JSON.stringify(doc);
  assert.equal(P.inspectCopper(doc,defs,{project}).reason,"source-adoption");
  assert.equal(misses(graph(project),"N"),1);
  assert.equal(JSON.stringify(doc),raw,"inspection does not adopt raw source");
  assert.ok(P.adopt(doc,defs,{project},false));
  assert.equal(doc.pcbDrawing.pours[0],region);
  assert.deepEqual(payload(region),stored);
  assert.deepEqual(region.links,wanted?[["anchor",0],["probe",0]]:[["anchor",0]],label);
  assert.equal(misses(graph(project),"N"),wanted?0:1,label);
  const accepted=JSON.stringify(doc);
  assert.equal(P.adopt(doc,defs,{project},false),false,"already-indexed copper needs no extra adoption");
  assert.equal(JSON.stringify(doc),accepted);
  const reopened=nativeRoundTrip(project), saved=docOf(reopened);
  assert.deepEqual(payload(saved.pcbDrawing.pours[0]),stored);
  assert.deepEqual(saved.pcbDrawing.pours[0].links,region.links);
  assert.equal(P.inspectCopper(saved,defs,{project:reopened}).state,"current");
  assert.equal(misses(graph(reopened),"N"),wanted?0:1,label+" after native reopen");
}

{
  const {project,doc}=fixture([[5,11],[5,8]]);
  doc.items.find(i=>i.id==="probe").points=[[5,11.5],[5,10.25]];
  const edited=JSON.stringify(doc);
  assert.equal(P.inspectCopper(doc,defs,{project}).state,"stale");
  assert.equal(P.adopt(doc,defs,{project},false),false,"an edited raw import cannot be adopted");
  assert.equal(misses(graph(project),"N"),1);
  assert.equal(JSON.stringify(doc),edited);
}

for (const remove of [false,true]) {
  const {project,doc}=fixture([[5,11],[5,8]]);
  assert.ok(P.adopt(doc,defs,{project},false));
  if(remove)doc.items=doc.items.filter(i=>i.id!=="probe");
  else doc.items.find(i=>i.id==="probe").points=[[5,11.5],[5,10.25]];
  const edited=JSON.stringify(doc);
  assert.equal(P.inspectCopper(doc,defs,{project}).state,"stale");
  assert.equal(P.contactRegions(doc,defs,{project}).length,0);
  assert.equal(misses(graph(project),"N"),remove?0:1);
  assert.equal(JSON.stringify(doc),edited);
  const reopened=nativeRoundTrip(project);
  assert.equal(P.inspectCopper(docOf(reopened),defs,{project:reopened}).state,"stale");
  assert.equal(P.contactRegions(docOf(reopened),defs,{project:reopened}).length,0);
}

{
  const {project,doc}=fixture([[5,11],[5,8]]);
  assert.ok(P.adopt(doc,defs,{project},false));
  // Simulate a previously saved board whose current contour certificate has the old links.
  doc.pcbDrawing.pours[0].links=[["anchor",0]];
  const old=nativeRoundTrip(project), oldDoc=docOf(old);
  assert.equal(P.inspectCopper(oldDoc,defs,{project:old}).state,"current");
  assert.equal(misses(graph(old),"N"),1);
  P.repourOne(oldDoc,defs,"zone",{project:old});
  assert.equal(misses(graph(old),"N"),0,"explicit selected-pour refill repairs a previously saved link");
}
console.log("PASS imported pour contacts at the top and bottom contour bounds, exact source retention, native reopen and stale-link controls");
