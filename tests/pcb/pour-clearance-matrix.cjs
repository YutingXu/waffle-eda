"use strict";
// Polygon pours read the Clearance rule's object-kind matrix (Polygon row: track-poly, via-poly,
// smd-poly, th-poly, ...). Boards without Polygon cells pour and fingerprint exactly as before, so
// their pours stay current; a board whose Polygon cells change the effective clearance goes stale.
// Also: stored (imported) fill adoption, and repouring one pour (AtriumPolygonPour.repourOne).
const assert = require("node:assert/strict");
for (const m of ["model", "spatial", "pcb-appearance", "pcb-pours", "query", "stackup", "polygon-pour", "rules", "connectivity"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
if (!globalThis.performance) globalThis.performance = require("node:perf_hooks").performance;
const PP = AtriumPolygonPour, RU = AtriumRules;
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
let nid = 0; const id = () => "o" + (++nid);
const via = (x, y, net) => ({id:id(), kind:"via", x, y, diameter:.6, drill:.3, layer:"Multi", net});
const track = (pts, net, width = .25) => ({id:id(), kind:"track", points:pts, width, layer:"Top", net});
function pip(x, y, r) {let ins = false; const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) {const x1 = r[2 * j], y1 = r[2 * j + 1], x2 = r[2 * i], y2 = r[2 * i + 1]; if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) * (x2 - x1) / (y2 - y1)) ins = !ins;} return ins;}
const copperAt = (x, y, regs) => regs.some(g => {const rs = PP.rings(g); return pip(x, y, rs[0]) && !rs.slice(1).some(h => pip(x, y, h));});
// A rule set (version 2) with one Clearance rule: gap .2, optional matrix cells.
function rules(objects) {
  const set = RU.migrate(RU.defaults());
  const c = set.list.find(r => r.type === "clearance"); c.gap = .2;
  if (objects) c.objects = objects; else delete c.objects;
  return set;
}
function board(objects) {
  const p = PP.make(rect(0, 0, 40, 30), {net:"GND", layer:"Top"});
  const items = [via(5, 5, "GND"), track([[10, 15], [30, 15]], "SIG"), via(20, 25, "SIG"), p];
  return {doc:{id:"b", kind:"pcb", items, outline:rect(0, 0, 40, 30), rules:rules(objects)}, p};
}

// 1. No Polygon cells: same copper as the legacy single value; signature unchanged by matrix support.
{
  const a = board(null), b = board({"track-smd":.3});
  const ra = PP.pour(a.doc, null, a.p, {}), rb = PP.pour(b.doc, null, b.p, {});
  // The track edge is at y 15.125; the pour starts .2 beyond it.
  assert.ok(copperAt(20, 15.125 + .25, ra) && !copperAt(20, 15.125 + .15, ra), "single value .2 from the track");
  assert.ok(copperAt(20, 15.125 + .25, rb), "a cell without Polygon leaves the pour unchanged");
  // Fingerprints: the cell-free rules hash as before (no polygon-cells token).
  const before = PP.polygonSignatures(b.doc, null);
  b.doc.rules.list.find(r => r.type === "clearance").objects = {"track-smd":.31};
  assert.notEqual(PP.polygonSignatures(b.doc, null)[b.p.id], before[b.p.id], "rules still enter the fingerprint");
}
function scopedBoard(source){
  const {doc,p}=board(), trace=doc.items.find(i=>i.kind==="track");
  const base=doc.rules.list.find(r=>r.type==="clearance");
  base.priority=2;
  doc.rules.list.unshift({...base,id:"guarded-track",priority:1,gap:1,
    scope:AtriumDesignQueryRecord.create(source),
    scope2:AtriumDesignQueryRecord.create("polygon")});
  const project=Atrium.project("Query clearance",[]);project.documents=[doc];project.rules=doc.rules;delete doc.rules;
  return {doc,p,trace,project};
}
// A rule can depend on an editable field that is not itself a copper dimension.
{
  const {doc,p,project,trace}=scopedBoard('track where comment = "guard"');
  const other=PP.make(rect(1,1,8,8),{id:"bottom-guard",net:"GND",layer:"Bottom",removeDeadCopper:false});
  doc.items.push(other);
  PP.apply(doc,null,{project});
  const {nativeRoundTrip}=require("../support/native-cad.cjs"),saved=nativeRoundTrip(project);
  const reopened=saved.documents[0],edited=reopened.items.find(i=>i.id===trace.id),opts={project:saved};
  assert.ok(AtriumUUID.isV7(saved.rules.list.find(r=>r.type==="clearance"&&r.priority===1).id));
  assert.equal(reopened.pcbDrawing.pourSignatures,undefined);
  const before=PP.outputCopper(reopened,null,{...opts,solve:false});
  assert.equal(before.state,"current");
  assert.ok(copperAt(20,15.8,before.regions.filter(r=>r.layer==="Top")));
  edited.comment="guard";
  assert.deepEqual(PP.stale(reopened,null,opts),[p.id],"only the top zone reads the changed gap");
  const out=PP.outputCopper(reopened,null,opts);
  assert.deepEqual(out.filled,[p.id]);
  assert.ok(!copperAt(20,15.8,out.regions.filter(r=>r.layer==="Top")),"manufacturing clears the full millimetre");
  assert.deepEqual(out.regions.filter(r=>r.layer==="Bottom"),before.regions.filter(r=>r.layer==="Bottom"));
  delete edited.comment;
  assert.deepEqual(PP.stale(reopened,null,opts),[],"restoring the rule operand restores the original copper");
  trace.comment="guard";
  const staleSaved=nativeRoundTrip(project), pending=PP.outputCopper(staleSaved.documents[0],null,{project:staleSaved,solve:false});
  assert.equal(pending.state,"pending","assigning rule IDs preserves stale copper evidence");
  assert.deepEqual(pending.pending,[p.id]);
}
// A change made between source translation and adoption cannot certify old artwork.
{
  const {doc,p,project,trace}=scopedBoard('track where comment = "guard"'),defs=new Map(),opts={project};
  doc.pcbDrawing={annotations:{},sourceFill:true,pours:PP.pour(doc,defs,p,opts).map(r=>({...r,source:"altium",links:[]}))};
  try{
    globalThis.AtriumPolygonPour=undefined;
    AtriumPCBPours.storeSignature(doc,defs,project);
    assert.match(doc.sourcePourSignature,/^[0-9a-f]{16}$/);
    assert.equal(AtriumPCBPours.matchesSignature(doc,defs,project),false,"the file reader alone cannot certify a physical query");
  }finally{globalThis.AtriumPolygonPour=PP;}
  assert.equal(AtriumPCBPours.matchesSignature(doc,defs,project),false,"an unstamped physical decision cannot be adopted later");
  AtriumPCBPours.storeSignature(doc,defs,project);
  assert.ok(AtriumPCBPours.matchesSignature(doc,defs,project));
  trace.comment="guard";
  assert.equal(AtriumPCBPours.matchesSignature(doc,defs,project),false);
  const out=PP.outputCopper(doc,defs,opts);
  assert.deepEqual(out.filled,[p.id]);
  assert.ok(!copperAt(20,15.8,out.regions));
  delete trace.comment;
  assert.equal(PP.outputCopper(doc,defs,opts).state,"current","restoring the original input accepts the verified source artwork");
  assert.ok(AtriumPCBPours.matchesSignature(doc,defs,project),"the adopted board retains its regular artwork stamp");
}
// A live editor journal owns the actual board, while fabrication calculates on a copy.
{
  const {doc,p,project}=scopedBoard("track near origin of U3 within 16 mm"),defs=new Map(),opts={project};
  const anchor={id:"external-anchor",kind:"part",ref:"U3",x:60,y:15,angle:0};doc.items.push(anchor);
  require("../../app/history/undo-store.js");const U=AtriumUndoStore;
  U.reset();U.touch(project);U.sync(project);
  PP.apply(doc,defs,opts);
  assert.ok(copperAt(20,15.8,doc.pcbDrawing.pours));
  anchor.x=45;U.touch(project);U.sync(project);
  assert.deepEqual(PP.stale(doc,defs,opts),[p.id]);
  const fresh=PP.pour(doc,defs,p,opts),out=PP.outputCopper(doc,defs,opts);
  assert.ok(!copperAt(20,15.8,fresh));assert.deepEqual(out.filled,[p.id]);
  assert.deepEqual(out.regions.map(r=>r.data),fresh.map(r=>r.data),"the spatially scoped copy emits the complete physical solve");
  assert.ok(copperAt(20,15.8,doc.pcbDrawing.pours),"a fabrication preview preserves the saved design");
  anchor.x=60;U.touch(project);U.sync(project);assert.deepEqual(PP.stale(doc,defs,opts),[]);
  U.reset();
}
// 2. Polygon cells: track-poly .5 and via-poly .8 (keys follow the kind order: track arc smd th via fill poly ...).
{
  const {doc, p} = board({"track-poly":.5, "via-poly":.8});
  const regs = PP.pour(doc, null, p, {});
  assert.ok(!copperAt(20, 15.125 + .45, regs) && copperAt(20, 15.125 + .55, regs), "track-poly cell .5");
  // Via at (20,25), radius .3: clear to .3 + .8 = 1.1.
  assert.ok(!copperAt(20, 25 - 1.05, regs) && copperAt(20, 25 - 1.15, regs), "via-poly cell .8");
  // A cell equal to the gap pours like the single value.
  const same = board({"track-poly":.2}), rs = PP.pour(same.doc, null, same.p, {});
  assert.ok(copperAt(20, 15.125 + .25, rs) && !copperAt(20, 15.125 + .15, rs));
}
// 3. Existing pours: a pour stored before matrix support stays current when no Polygon cell differs
//    from its rule's gap, and goes stale when one does (its effective clearance changed).
{
  const {doc, p} = board({"track-smd":.3});
  PP.apply(doc, null);
  assert.deepEqual(PP.stale(doc, null), [], "fresh after a repour");
  const c = doc.rules.list.find(r => r.type === "clearance");
  c.objects = {"track-smd":.3, "track-poly":.2};     // equal to the gap: no effective change
  const sig = doc.pcbDrawing.pourSignatures[p.id];
  doc.pcbDrawing.pourSignatures[p.id] = PP.polygonSignatures(doc, null)[p.id];
  assert.deepEqual(PP.stale(doc, null), []);
  c.objects = {"track-smd":.3, "track-poly":.4};     // effective clearance changes
  assert.deepEqual(PP.stale(doc, null), [p.id], "a Polygon cell that changes the gap makes the pour stale");
  assert.ok(sig);
}
// 4. Stored fill adoption: an imported island tagged with its pour, links:[], sourceFill.
{
  const p = PP.make(rect(0, 0, 20, 20), {net:"GND", layer:"Top"}), v = via(5, 5, "GND"), t = track([[10, 2], [10, 18]], "GND");
  const doc = {id:"s", kind:"pcb", items:[v, t, via(15, 15, "SIG"), p], outline:rect(0, 0, 20, 20)};
  const island = AtriumPCBPours.region([rect(1, 1, 19, 19), [[14, 14], [16, 14], [16, 16], [14, 16]]], "Top", "GND", {polygon:p.id, links:[]});
  doc.pcbDrawing = {annotations:{}, pours:[island], sourceFill:true};
  doc.sourcePourSignature = AtriumPCBPours.signature(doc, new Map());
  assert.ok(PP.adopt(doc,new Map(),{},false));
  assert.equal(PP.state(doc, null), "source");
  assert.ok(!doc.pcbDrawing.sourceFill && doc.pcbDrawing.pourSignatures[p.id], "adopted: signature recorded");
  assert.deepEqual(island.links.map(l => l[0]).sort(), [t.id, v.id].sort(), "the island links the GND via and track it covers, not the SIG via in its hole");
  t.points[0][0] = 11;
  assert.deepEqual(PP.stale(doc, null), [p.id], "an edit near the stored fill makes it stale");
}
// 5. Repour one pour: only that pour (and later pours on its layer) is repoured.
{
  const a = PP.make(rect(0, 0, 20, 30), {net:"GND", pourIndex:0}), b = PP.make(rect(20, 0, 40, 30), {net:"VCC", pourIndex:1}), c = PP.make(rect(0, 0, 40, 30), {net:"GND", layer:"Bottom", pourIndex:2});
  const doc = {id:"r", kind:"pcb", items:[via(5, 5, "GND"), via(35, 5, "VCC"), a, b, c], outline:rect(0, 0, 40, 30), rules:rules(null)};
  PP.apply(doc, null);
  const keep = doc.pcbDrawing.pours.filter(r => r.polygon === c.id);
  a.points[1][0] = 19;
  const r = PP.repourOne(doc, null, a.id);
  assert.deepEqual(r.repoured, [a.id, b.id], "the pour and the later pour on its layer");
  assert.ok(doc.pcbDrawing.pours.filter(x => x.polygon === c.id).every((x, i) => x === keep[i]), "other layers keep their copper");
  assert.deepEqual(PP.stale(doc, null), []);
  assert.throws(() => PP.repourOne(doc, null, "nope"), /not a polygon pour/);
}
console.log("PASS pour clearance matrix (Polygon cells, unchanged fingerprints without them), stored fill adoption, single-pour repour");
