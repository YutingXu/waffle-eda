"use strict";

// A board whose ground is joined only through a stored bottom pour: via v1 and the stitching via
// reach each other through the pour, and v3 hangs off the stitching via by a top track. A scoped
// polygon-connect rule (in class "Power") decides how the pour meets the ground vias, so the
// copper's inputs include a rule that only the scoped-rule compiler can read.
// twoNets: a second pour, VCC on the top layer, joins vias p1 and p2 under a clearance scoped to a
// second class (in class "Supply") and a Supply connect style, so two nets each depend on their own
// scoped rules and class.
// barePour: an earlier bottom pour inside the ground pour that fills nothing (every island is under its
// area threshold), as a source pour the tool left without copper.
// imported: the copper is the source tool's artwork (tagged regions without links, adopted on first
// inspection), as the Altium importer leaves it.
function board({imported = false, twoNets = false, barePour = false} = {}) {
  const A = globalThis.Atrium, P = globalThis.AtriumPolygonPour, R = globalThis.AtriumRules;
  const project = A.project("Stitched ground"), doc = project.documents.find(d => d.kind === "pcb");
  globalThis.AtriumBoardShape.apply(doc, globalThis.AtriumBoardShape.rect({x:0, y:20, width:40, height:20}));
  const via = (id, x, y, net) => ({id, kind:"via", x, y, diameter:0.8, drill:0.4, layer:"Multi", net});
  doc.items = [via("v1", 4, 10, "GND"), via("stitch", 24, 10, "GND"), via("v3", 34, 10, "GND"),
    {id:"t-gnd", kind:"track", layer:"Top", net:"GND", width:0.3, points:[[24, 10], [34, 10]]},
    via("s1", 15, 4, "VCC"), via("s2", 15, 16, "VCC"),
    {id:"t-vcc", kind:"track", layer:"Top", net:"VCC", width:0.3, points:[[15, 4], [15, 16]]}];
  const pour = P.make([[1, 1], [28, 1], [28, 19], [1, 19]], {layer:"Bottom", net:"GND", pourIndex:0});
  pour.id = "pour-gnd";
  doc.items.push(pour);
  if (barePour) {
    pour.pourIndex = 1;
    const bare = P.make([[14, 8], [16, 8], [16, 9.5], [14, 9.5]], {layer:"Bottom", net:"VBUS", pourIndex:0, islandAreaThreshold:50});
    bare.id = "pour-bare";
    doc.items.push(bare);
  }
  if (twoNets) {
    doc.items = doc.items.filter(i => !["s1", "s2", "t-vcc"].includes(i.id));
    doc.items.push(via("p1", 8, 4, "VCC"), via("p2", 8, 16, "VCC"));
    const top = P.make([[2, 2], [13, 2], [13, 18], [2, 18]], {layer:"Top", net:"VCC", pourIndex:1});
    top.id = "pour-vcc";
    doc.items.push(top);
  }
  const defs = new Map(project.library.map(d => [d.id, d]));
  const rules = R.migrate(R.stored(doc, project));
  rules.netClasses = {...rules.netClasses, Power:["GND"], ...(twoNets ? {Supply:["VCC"]} : {})};
  for (const r of rules.list) if (r.type === "polygonConnect") r.priority = 2;
  rules.list.push({id:"rule-power-relief", type:"polygonConnect", name:"PowerRelief", enabled:true, priority:1,
    scope:{languageVersion:1, source:'object in class "Power"'}, style:"relief", conductorWidth:.3, entries:4, angle:90, airGap:.3});
  if (twoNets) rules.list.push({id:"rule-vcc-clearance", type:"clearance", name:"SupplyGap", enabled:true, priority:1,
    scope:{languageVersion:1, source:'object in class "Supply"'}, scope2:{languageVersion:1, source:"object"}, gap:.6},
    {id:"rule-supply-relief", type:"polygonConnect", name:"SupplyRelief", enabled:true, priority:1,
      scope:{languageVersion:1, source:'object in class "Supply"'}, style:"relief", conductorWidth:.4, entries:2, angle:45, airGap:.35});
  R.store(doc, project, rules);
  P.apply(doc, defs, {project});
  if (imported) {
    const d = doc.pcbDrawing;
    for (const r of d.pours) {r.source = "altium"; r.links = [];}
    delete d.pourSignatures; delete d.pourSignatureVersion;
    // The source stored no copper and no record of a fill for the bare pour.
    if (barePour) for (const p of doc.items) if (p.id === "pour-bare") delete p.copperBasis;
    d.sourceFill = true;
    globalThis.AtriumPCBPours.storeSignature(doc, defs, project);
  }
  return {project, doc, defs};
}
module.exports = {board};
