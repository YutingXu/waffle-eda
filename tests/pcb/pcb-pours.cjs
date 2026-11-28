"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
globalThis.CFB=require("../../app/vendor/cfb.min.js");
for(const m of ["model","eco","source-file","io","pcb-pours","altium-rules","pcb-import","pcb-patch","source-copy","pcb-appearance","spatial","canvas","connectivity","kicad-export"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const unit=.00000254,defs=new Map(),args=key=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]:null;
function props(text){
  const raw=Buffer.from("|"+text+"\0","latin1"),length=Buffer.alloc(4);length.writeUInt32LE(raw.length);return Buffer.concat([length,raw]);
}
function region(rings,{owner=65535,polygon=0,layer=1,flags=0,extra=""}={}){
  const main=Buffer.alloc(18);main[0]=layer;main[2]=flags;main.writeUInt16LE(65535,3);
  main.writeUInt16LE(polygon,5);main.writeUInt16LE(owner,7);main.writeUInt16LE(rings.length-1,14);
  const geometry=rings.map(points=>{
    const raw=Buffer.alloc(4+16*points.length);raw.writeUInt32LE(points.length);
    points.forEach(([x,y],i)=>{raw.writeDoubleLE(x/unit,4+16*i);raw.writeDoubleLE(-y/unit,12+16*i);});
    return raw;
  });
  const data=Buffer.concat([main,props("KIND=0|SUBPOLYINDEX=0|V7_LAYER=TOP"+extra),...geometry]),header=Buffer.alloc(5);
  header[0]=11;header.writeUInt32LE(data.length,1);return Buffer.concat([header,data]);
}
const outer=[[0,0],[20,0],[20,20],[0,20]],hole=[[2,2],[5,2],[5,5],[2,5]],island=[[0,22],[2,22],[0,23]];
const perimeter="VX0=0mm|VY0=0mm|VX1=100mm|VY1=0mm|VX2=100mm|VY2=-100mm|VX3=0mm|VY3=-100mm";
const zone="LAYER=TOP|HATCHSTYLE=Solid|POLYGONTYPE=Polygon|SHELVED=FALSE|NET=0|"+perimeter;
const native=new Map([["board6/data",props(perimeter)],["nets6/data",props("NAME=GND")],["polygons6/data",props(zone)]]);
function imported(frames,source=native,appearance=true){
  const streams=new Map(source);if(frames)streams.set("regions6/data",frames);
  return AtriumPCB.read("Example.PcbDoc",streams,null,{appearance}).documents[0];
}
const raw=Buffer.concat([region([outer,hole]),region([island])]),doc=imported(raw),P=AtriumPCBPours;
assert.deepEqual(doc.pcbDrawing.pours.map(r=>[r.layer,r.net,r.count,r.bounds.map(v=>+v.toFixed(12))]),[["Top","GND",2,[0,0,20,20]],["Top","GND",1,[0,22,2,23]]]);
assert.deepEqual(P.contours(doc.pcbDrawing.pours[0]).map(r=>Array.from(r)),[outer.flat(),hole.flat()]);
// The zone becomes an editable polygon pour; its stored islands are that pour's copper.
assert.deepEqual(doc.items.map(i=>[i.kind,i.layer,i.net,i.points.length]),[["polygon","Top","GND",4]],"the zone imports as a polygon pour");
assert.ok(doc.pcbDrawing.pours.every(r=>r.polygon===doc.items[0].id)&&doc.pcbDrawing.sourceFill===true,"stored islands are tagged with their pour");
assert.equal(imported().pcbDrawing.pours,undefined,"unpoured zone has no artwork");
assert.equal(imported(raw,native,false).pcbDrawing,undefined,"reader preserves legacy project shape when comparing native copies");
for(const invalid of [{owner:5},{polygon:65535},{layer:32},{flags:2},{extra:"|KIND=1"},{extra:"|SUBPOLYINDEX=-1"},{extra:"|ISSHAPEBASED=TRUE"},{extra:"|ISBOARDCUTOUT=TRUE"},{extra:"|V7_LAYER=BOTTOM"}]){
  assert.equal(imported(region([outer],invalid)).pcbDrawing.pours,undefined);
}
const shelved=new Map(native);shelved.set("polygons6/data",props(zone.replace("SHELVED=FALSE","SHELVED=TRUE")));
assert.equal(imported(raw,shelved).pcbDrawing.pours,undefined);
const faulty=imported(raw.subarray(0,-2));assert.equal(faulty.pcbDrawing.pours,undefined);assert.ok(faulty.notes.some(n=>n.includes("Truncated Regions6")));
const marks=[],ctx=new Proxy({fill(...args){if(args.includes("evenodd"))marks.push(this.fillStyle);}},{get:(o,k)=>o[k]??(()=>{})});
const view=AtriumCanvas.create({getContext:()=>ctx,getBoundingClientRect:()=>({width:800,height:570})});
function render(opts={}){marks.length=0;view.render(doc,defs,{grid:false,layer:"Top",...opts});return marks.length;}
view.fit(doc,defs,"board");
let computes=0;const original=P.signature;P.signature=(...a)=>{computes++;return original(...a);};
assert.equal(render(),2);assert.equal(view.pourState(doc,defs),"source");
for(let i=0;i<12;i++){view.pan(1,0);render();}assert.equal(computes,1,"panning never rescans board copper");
assert.equal(render({layer:"Bottom",layerMode:"single"}),0);assert.equal(render({hidden:new Set(["Top"])}),0);
assert.equal(render({hidden:new Set(["Source pours"])}),0);assert.equal(render({transientGeometry:true}),0);
assert.equal(view.hit(doc,defs,[8,8],{}),null);assert.deepEqual(view.snapPoint(doc,defs,[8.13,8.27],{grid:false}),[8.13,8.27]);
const graph=AtriumConnectivity.inspect(doc,defs);
assert.equal(graph.nets.length,0);
// Unedited, the stored islands are the pour's current copper, and a KiCad save carries them as filled polygons.
const filledPolygons=text=>(text.match(/\(filled_polygon \(layer "F\.Cu"\)/g)||[]).length;
{const fresh=Atrium.project("Pours");fresh.documents=[doc];
  assert.equal(filledPolygons(AtriumKiCad.exportBoard(fresh,doc.id).content),doc.pcbDrawing.pours.length,"stored islands as filled polygons");}
const track={id:Atrium.id(),kind:"track",layer:"Top",net:"SIG",width:.3,points:[[9,9],[13,9]]};
doc.items.push(track);view.invalidate(doc,[track]);assert.equal(render(),0);assert.equal(view.pourState(doc,defs),"stale");
const project=Atrium.project("Pours");project.documents=[doc];
const {nativeRoundTrip,nativeImported}=require("../support/native-cad.cjs");
function reopened(){return nativeRoundTrip(project).documents[0];}
assert.equal(view.pourState(reopened(),defs),"stale");
const output=AtriumKiCad.exportBoard(project,doc.id);
assert.match(output.content,/\(segment /);
// The pour exports as a KiCad zone on its layer and net. The board has changed since the fill was stored, so
// the zone carries the copper the fabrication outputs plot (the fill made on a copy), never the stale islands.
const zones=output.content.split("\n").filter(l=>/^\s*\(zone /.test(l));
assert.equal(zones.length,1,"one zone for the one pour");
assert.match(zones[0],/\(net_name "GND"\) \(layer "F\.Cu"\)/);assert.doesNotMatch(zones[0],/\(keepout /);
assert.equal(filledPolygons(zones[0]),AtriumPolygonPour.outputCopper(doc,defs,{project}).regions.filter(r=>r.polygon===doc.items.find(i=>i.kind==="polygon").id).length,"the outputs' copper as filled polygons");
assert.match(output.content,/\(width 0\.3\)/);
doc.items.pop();view.invalidate(doc);assert.equal(render(),2);assert.equal(view.pourState(reopened(),defs),"source");
assert.equal(view.pourState(Atrium.sheet("pcb","Older project"),defs),"none");
P.signature=original;
const annotation={field:"ref",at:[1,-2],angle:90,size:1.25,layer:"Silk",mirrored:false};
doc.pcbDrawing.annotations["components6/data#0"]=[annotation];assert.doesNotThrow(reopened);
for(const change of [
  d=>d.sourcePourSignature="001",d=>delete d.sourcePourSignature,d=>delete d.pcbDrawing,
  d=>d.pcbDrawing.annotations=[],d=>d.pcbDrawing.annotations.bad=[],d=>d.pcbDrawing.annotations["components6/data#0"]={},
  d=>d.pcbDrawing.annotations["components6/data#0"][0].field="constructor",d=>d.pcbDrawing.annotations["components6/data#0"][0].at=[1],
  d=>d.pcbDrawing.annotations["components6/data#0"][0].size=-1,d=>d.pcbDrawing.annotations["components6/data#0"][0].mirrored=1,
  d=>d.pcbDrawing.pours[0].bounds=[2,1,0,3],d=>d.pcbDrawing.pours[0].bounds=[0,"x",1,2],
  d=>d.pcbDrawing.pours[0].count=65537,d=>d.pcbDrawing.pours[0].count=1.5,d=>d.pcbDrawing.pours[0].count=20,
  d=>d.pcbDrawing.pours[0].data={},d=>d.pcbDrawing.pours[0].data="AA==",d=>d.pcbDrawing.pours[0].data=d.pcbDrawing.pours[0].data.replace(/^./,"%"),
  d=>d.pcbDrawing.pours[0].layer="Silk",d=>d.kind="schematic"
]){
  const bad=Atrium.clone(project);change(bad.documents[0]);assert.throws(()=>Atrium.validate(bad),/Invalid Waffle editor model/);
}
console.log("PASS saved board drawing validation rejects malformed annotations, bounds, layers, signatures and packed contour envelopes.");
console.log("PASS stored island and hole geometry, rendering, visibility, viewport cache, source bounds, stale save/reopen, undo, copper-only export and picking.");
{
  // Save, reopen and export a board with two independently owned fills. The project file
  // stores rounded coordinates and checking connectivity attaches editor-only links.
  const compound=CFB.utils.cfb_new();
  const outline=perimeter.replace(/100mm/g,"973.3175mil");
  for(const [p,data] of [["Board6/Data",props(outline)],["Nets6/Data",props("NAME=GND")],
    ["Polygons6/Data",Buffer.concat([props(zone),props(zone.replace(perimeter,outline))])],
    ["Regions6/Data",Buffer.concat([region([outer,hole]),region([island],{polygon:1})])]])
    CFB.utils.cfb_add(compound,p,data);
  const bytes=Buffer.from(CFB.write(compound,{type:"buffer"})),read=AtriumIO.read("Pours.PcbDoc",bytes);
  const project=Atrium.project("Pours",read.library);project.documents=read.documents;
  const [a,b]=read.documents[0].items, drawing=read.documents[0].pcbDrawing;
  assert.deepEqual([a.sourceRecord,b.sourceRecord],["polygons6/data#0","polygons6/data#1"]);
  delete drawing.sourceFill;
  drawing.pourSignatures={[a.id]:"indexed",[b.id]:"indexed"};drawing.pourSignatureVersion=2;
  drawing.pours[0].links=[[a.id,0]];
  const source={name:"Pours.PcbDoc",bytes,documents:[read.documents[0].id]};
  const stored=nativeImported(project,[source]);
  const {documents:[saved],library}=AtriumTranslatorProvenance.toLegacy(stored.project,stored.provenance);
  const copy=d=>AtriumSourceCopy.prepare(d,library,bytes,{provenance:stored.provenance});
  assert.deepEqual(Buffer.from(copy(saved).bytes),bytes);
  const legacy=Atrium.clone(saved);for(const p of legacy.items)delete p.sourceRecord;
  assert.deepEqual(Buffer.from(copy(legacy).bytes),bytes);
  for(const edit of [d=>d.pcbDrawing.pours[0].polygon=b.id,d=>d.pcbDrawing.pours[0].data=d.pcbDrawing.pours[1].data,
    d=>d.items[0].points[0][0]+=.01]){
    const changed=Atrium.clone(saved);edit(changed);
    assert.throws(()=>copy(changed),/pcbDrawing|standalone copper/);
  }
  console.log("PASS byte-identical native copies of saved and older pours; changed artwork, ownership and polygon geometry rejected.");
}
{
  // An imported board first visited after the undo store was initialized. Adopting its
  // stored artwork precedes the next user edit, even when that edit is on another sheet.
  require("../../app/pcb/polygon-pour.js"); require("../../app/history/undo-store.js");
  const board = imported(raw), sheet = Atrium.sheet("schematic", "Sheet");
  const label = {id: "note", kind: "label", x: 2, y: 3, text: "Before"};
  sheet.items.push(label);
  board.items.push({id: "copper", kind: "track", layer: "Top", net: "GND", width: .3, points: [[1, 1], [2, 1]]});
  board.sourcePourSignature = P.signature(board, defs);
  const design = Atrium.project("Stored copper"), U = AtriumUndoStore, history = [], future = [];
  design.documents = [sheet, board]; U.mark(design);
  assert.ok(AtriumPolygonPour.adopt(board, defs, {project: design}, false));
  assert.ok(board.pcbDrawing.pours[0].links.some(l => l[0] === "copper"));
  const before = JSON.stringify(design);
  U.checkpoint(history, future, U.mark(design)); label.text = "After"; U.record(design, {doc: sheet, items: [label]});
  const after = JSON.stringify(design);
  U.jump(history, future, U.mark(design), -1);
  assert.equal(JSON.stringify(design) === before, true, "unrelated Undo preserves the materialized PCB copper exactly");
  U.jump(history, future, U.mark(design), 1);
  assert.equal(JSON.stringify(design) === after, true, "Redo preserves links and signatures as well as the schematic edit");
}
{
  for (const mod of ["project-rules", "import-reports", "translator-provenance"]) require(require("../support/app-source-paths.cjs").appFile(mod + ".js"));
  const board = imported(raw), project = Atrium.project("Translated copper");
  project.documents = [board];
  board.sourceRules = ["RULEKIND=Width|NAME=Native rule|ENABLED=TRUE|MINLIMIT=10mil"];
  P.storeSignature(board, defs);

  const provenance = {}, session = {};
  AtriumTranslatorProvenance.separate(project, provenance);
  AtriumImportReports.attach({fileSession: () => session, on() {}, registerAction() {}});
  AtriumImportReports.remember(session, {provenance}, [board.id], ["Example.PcbDoc"]);
  assert.equal(board.sourceRules, undefined);
  assert.ok(P.matchesSignature(board, defs), "the original fill stamp includes the rule rows held in provenance");
  board.items[0].points[1][0] += 1;
  assert.equal(P.matchesSignature(board, defs), false, "a geometry edit invalidates the original fill");
}
if(args("--fixtures")){
  const dump={};
  for(const [name,islands,holes] of [["qfsae-0",8,131],["qfsae-1",1,47],["RegressionA",1,3],["Panel",0,0],["Routing",0,0]]){
    const file=name+".PcbDoc",bytes=fs.readFileSync(path.join(args("--fixtures"),file));
    const {documents:[d],library}=AtriumIO.read(file,bytes),byDef=new Map(library.map(v=>[v.id,v])),pour=d.pcbDrawing.pours||[];
    assert.equal(pour.length,islands);assert.equal(pour.reduce((n,r)=>n+r.count-1,0),holes);
    if(islands)assert.equal(view.pourState(d,byDef),"source");
    if(args("--dump"))dump[file]=pour.map(r=>({layer:r.layer,net:r.net,bounds:r.bounds,rings:P.contours(r).map(a=>Array.from(a))}));
    if(name==="qfsae-0"){
      const record=d.items.find(i=>i.sourceRecord==="tracks6/data#497");record.width=.3302;
      view.invalidate(d,[record]);assert.equal(view.pourState(d,byDef),"stale");
      const out=AtriumSourceCopy.prepare(d,library,bytes);
      assert.deepEqual(out.records,["tracks6/data#497"]);
      const orig=AtriumSourceFile.open(bytes),copy=AtriumSourceFile.open(out.bytes);
      for(const key of ["Regions6/Data","Polygons6/Data"])assert.deepEqual(copy.read(key),orig.read(key));
      assert.match(out.diagnostics.join(" "),/repour/i);
    }
    console.log("PASS "+name+" — "+islands+" stored island(s), "+holes+" hole(s).");
  }
  if(args("--dump"))fs.writeFileSync(args("--dump"),JSON.stringify(dump));
}
