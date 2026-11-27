"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const name of ["obsolete-project","model","sch-objects","hierarchy","board-shape","board-shape-sources","net-intent","signals",
  "altium-rules","altium-ids","pcb-draw","component-classes","query","rules","project-rules","pcb-pours","pcb-import","stackup","source-file","sexpr",
  "import-eagle","import-link","io","import-rules","translator-table","translator-registry","translator-provenance","translator-adapters",
  "translators","messages","net-ties","erc","export-eagle","translator-exports"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const A = Atrium, T = AtriumTranslators, E = AtriumEagleExport, S = AtriumBoardShape, encoder = new TextEncoder();
const root = path.join(__dirname,"../fixtures/import");
const file = (name,text) => ({name,bytes:encoder.encode(text)});
const data = name => fs.readFileSync(path.join(root,name),"utf8");
const importPair = files => T.import(files,{source_rules:"use"});
const positions = p => p.map(v=>+v.toFixed(4)+0);
const sort = values => values.map(value=>JSON.stringify(value)).sort();
function write(model,provenance,options) {
  const rows = [];
  const out = E.export(model,{provenance,...options},{add(kind,status,source,reason,count=1) {
    assert.ok(source.file && status && kind && count>0);
    if (status !== "kept") assert.ok(reason,kind+" has no explanation");
    rows.push({kind,status,source,reason,count});
  }});
  return {...out,rows};
}
function records(project,doc,kind) {
  const defs = new Map(project.library.map(def=>[def.id,def]));
  if (kind === "part") return sort(doc.items.filter(i=>i.kind === kind).map(i=>[i.ref,i.unit || 1,
    !!i.mirror,i.layer || "",...positions([i.x,i.y,i.angle || 0]),i.value || "",
    sort(A.pins(i,defs.get(i.def),doc.kind).map(p=>[p.number,...positions(p.at),p.w,p.h,p.drill,p.shape,p.layer]))]));
  if (kind === "track" || kind === "wire") return sort(doc.items.filter(i=>i.kind === kind).flatMap(i=>i.points.slice(1).map((p,index)=>
    [i.net,i.layer,i.width,...sort([positions(i.points[index]),positions(p)])])));
  if (kind === "via") return sort(doc.items.filter(i=>i.kind === kind).map(i=>[i.net,...positions([i.x,i.y,i.drill,i.diameter]),i.fromLayer,i.toLayer]));
  if (kind === "polygon") return sort(doc.items.filter(i=>i.kind === kind).map(i=>[i.net,i.layer,i.pourIndex,i.clearance,i.fillMode,
    i.points.map(p=>positions(Array.isArray(p)?p:[p.x,p.y]))]));
  throw Error("Unexpected fixture vector "+kind);
}
const sch = data("demo-eagle.sch").replace("<libraries>", "<description>Example &amp; text</description><libraries>");
const board = data("demo-eagle.brd").replace("<plain>", '<plain><dimension x1="0" y1="0" x2="2" y2="0" x3="1" y3="1" layer="47" width="0.1" textsize="1"/>')
  .replace("<autorouter>", '<autorouter><pass name="Legacy" refer=""><param name="OldSetting" value="1"/></pass>');
const original = importPair([file("Pair.sch",sch),file("Pair.brd",board)]);
const state = original.model, [sheet,second,layout] = state.documents;
assert.deepEqual(state.documents.map(d=>d.kind),["schematic","schematic","pcb"]);
const before = A.clone(state);
const placed = layout.items.find(item=>item.kind === "part" && item.ref === "J1");
const track = layout.items.find(item=>item.kind === "track");
const editedWire = sheet.items.find(item=>item.kind === "wire");
placed.x += 2.54; placed.angle += 90; track.points[1][0] += 0.1524; editedWire.points[1][1] += 0.254;
sheet.items.push({kind:"frame",id:"author-frame",x:0,y:0,w:10,h:10});
const saved = JSON.stringify(state);
const out = write(state,original.provenance,{scope:"project"});
assert.equal(JSON.stringify(state),saved);
assert.deepEqual(out.files.map(f=>f.name),["Pair.sch","Pair.brd"]);
assert.equal(out.details.outputs[0].documentIds.length,2);
assert.match(out.files[0].text,/<description>Example &amp; text<\/description>/);
assert.match(out.files[1].text,/<dimension /);
assert.ok(out.files.every((f,i)=>f.text !== [sch,board][i]));
const droppedFrame = out.rows.filter(r=>r.source.object === "author-frame");
assert.deepEqual(droppedFrame.map(r=>[r.kind,r.status,r.count]),[["frame","dropped",1]]);
assert.deepEqual(out.rows.filter(r=>r.kind === "Original EAGLE pass").map(r=>[r.status,r.count]),[["dropped",1]]);
assert.deepEqual(out.rows.filter(r=>r.kind === "Original EAGLE dimension").map(r=>[r.status,r.count]),[["kept",1]]);
assert.ok(!out.rows.some(r=>r.kind === "Design rule"),"stock rules and rules emitted to EAGLE must not count as source losses");
const exchange = T.export("eagle",state,{scope:"project",provenance:original.provenance});
assert.deepEqual(exchange.files,out.files);
assert.equal(exchange.report.translator,"eagle");
assert.equal(exchange.report.kinds.find(row=>row.kind === "frame").dropped,1);
{
  const Q = AtriumDesignQueryRecord, ruled = A.clone(state);
  const base = ruled.rules.list.find(r=>r.type === "clearance" && Q.toSelector(r.scope)?.kind === "all");
  const pair = {...base,id:"used-typed-rule",scope:Q.selector("net","SIG"),scope2:Q.selector("net","GND"),gap:.55};
  ruled.rules.keys = {...ruled.rules.keys,ruleSets:[{name:"Dormant",enabled:false}]};
  const width = ruled.rules.list.find(r=>r.type === "width" && Q.toSelector(r.scope)?.kind === "all");
  ruled.rules.list.unshift({...width,id:"disabled-width",set:"Dormant",priority:1,min:9});
  ruled.rules.list.push(pair,{...pair,id:"unused-typed-rule",scope:Q.selector("net","UNUSED")},
    {...pair,id:"disabled-pair",set:"Dormant"});
  const report = write(ruled,original.provenance,{scope:"project"});
  assert.deepEqual(report.rows.filter(row=>row.kind === "Design rule").map(row=>[row.source.object,row.status,row.count]),
    [["used-typed-rule","dropped",1]]);
  assert.match(report.files[1].text,/<param name="msWidth" value="0.254mm"\/>/);
}
const read = importPair(out.files.map(f=>file(f.name,f.text))).model, [outSheet,outSecond,outBoard] = read.documents;
assert.deepEqual(read.documents.map(d=>d.kind),state.documents.map(d=>d.kind));
for (const kind of ["part","track","via","polygon"]) assert.deepEqual(records(read,outBoard,kind),records(state,layout,kind),kind);
assert.notDeepEqual(records(read,outBoard,"part"),records(before,before.documents[2],"part"));
assert.notDeepEqual(records(read,outBoard,"track"),records(before,before.documents[2],"track"));
for(const [from,to] of [[sheet,outSheet],[second,outSecond]]) {
  assert.deepEqual(records(read,to,"part"),records(state,from,"part"));
  assert.deepEqual(records(read,to,"wire"),records(state,from,"wire"));
}
assert.notDeepEqual(records(read,outSheet,"wire"),records(before,before.documents[0],"wire"));
assert.deepEqual(S.bounds(S.current(outBoard)).map(v=>+v.toFixed(3)),S.bounds(S.current(layout)).map(v=>+v.toFixed(3)));
assert.equal(S.current(outBoard).cutouts.length,1);
assert.ok(S.current(outBoard).contour.some(s=>s.kind==="arc"));
assert.deepEqual(AtriumRules.stored(outBoard,read).defaults,AtriumRules.stored(layout,state).defaults);
assert.deepEqual(AtriumRules.stored(outBoard,read).nets,AtriumRules.stored(layout,state).nets);
{
  for (const name of ["format-2-codec","format-2-units","format-2-values","format-2-model"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const M = AtriumFormat2Model, F = AtriumFormat2;
  const imported = importPair([file("Saved.brd",board),file("Other.brd",board)]);
  const edited = imported.model, first = edited.documents.find(d=>d.kind === "pcb");
  const owns = rule=>rule.boards?.includes(first.id);
  const width = edited.rules.list.find(r=>owns(r) && r.origin?.kind === "default" && r.type === "width");
  const ring = edited.rules.list.find(r=>owns(r) && r.type === "annularRing");
  const stock = edited.rules.list.find(r=>owns(r) && r.type === "routingTopology");
  const authored = {...stock,id:A.id()};
  delete authored.origin;
  width.min = .31;
  width.max = .45;
  ring.min = .27;
  edited.rules.list[edited.rules.list.indexOf(stock)] = authored;
  const saved = M.fromEditor({model:edited,provenance:imported.provenance});
  const reopened = M.manifest(M.parse(F.serialize(saved.manifest))).project;
  for (const {file:member} of saved.files) {
    const loaded = M.parse(F.serialize(member));
    if (loaded.header.kind === "library") reopened.library.push(M.library(loaded));
    if (["schematic","pcb"].includes(loaded.header.kind)) reopened.documents.push(M.document(loaded));
  }
  const restored = reopened.rules.list.find(r=>r.id === width.id);
  assert.ok(AtriumUUID.isV7(restored.id));
  assert.deepEqual(restored.origin,width.origin,"the native save retains the stock template identity");
  assert.equal(restored.max,.45);
  const exported = write(reopened,saved.provenance,{scope:"document",documentId:first.id});
  const losses = exported.rows.filter(r=>r.kind === "Design rule").map(r=>[r.source.object,r.status,r.count]);
  assert.deepEqual(sort(losses),sort([[width.id,"approximated",1],[ring.id,"dropped",1],[authored.id,"dropped",1]]));
  assert.match(exported.files[0].text,/<param name="msWidth" value="0.31mm"\/>/);
  assert.ok(exported.rows.some(r=>r.kind === "Original EAGLE dimension" && r.status === "kept"));
  const other = reopened.documents.find(d=>d.kind === "pcb" && d.id !== first.id);
  assert.ok(!write(reopened,saved.provenance,{scope:"document",documentId:other.id}).rows.some(r=>r.kind === "Design rule"));
  const roundTrip = importPair(exported.files.map(f=>file(f.name,f.text))).model;
  const roundTripWidth = roundTrip.rules.list.find(r=>r.type === "width" && AtriumDesignQueryRecord.isAll(r.scope));
  assert.equal(roundTripWidth.min,.31);
  assert.equal(roundTripWidth.max,null);
}
const xml = AtriumEagleImport.parseXML(out.files[0].text);
const sheetItems = node=>node.children.flatMap(child=>[child,...sheetItems(child)]);
const all = sheetItems(xml);
assert.ok(all.some(row=>row.name === "pinref") && all.some(row=>row.name === "connect"));
assert.equal(all.filter(row=>row.name === "instance" && row.attrs.part === "IC1").length,2);
const single = write(state,original.provenance,{scope:"document",documentId:layout.id});
assert.equal(single.files.length,1);
assert.match(single.files[0].name,/\.brd$/);
const schOnly = importPair([file("Only.sch",data("demo-eagle.sch"))]);
const only = write(schOnly.model,schOnly.provenance,{scope:"project"});
assert.deepEqual(only.files.map(f=>f.name),["Only.sch"]);
assert.equal(importPair(only.files.map(f=>file(f.name,f.text))).model.documents.length,2);
const stale = {...original.provenance,files:original.provenance.files.map(member=>({...member,
  bytes:member.name.endsWith(".brd") ? encoder.encode("different bytes") : member.bytes}))};
const regenerated = write(state,stale,{scope:"document",documentId:layout.id});
assert.ok(regenerated.rows.some(r=>r.kind==="Original EAGLE data" && r.status==="dropped"));
assert.doesNotMatch(regenerated.files[0].text,/<dimension /);
const bottom = importPair([file("Mirrored.sch",data("review/eagle-mr90.sch")),file("Mirrored.brd",data("review/eagle-mr90.brd"))]);
const mirrored = importPair(write(bottom.model,bottom.provenance,{scope:"project"}).files.map(f=>file(f.name,f.text)));
for(const [i,d] of bottom.model.documents.entries())
  assert.deepEqual(records(mirrored.model,mirrored.model.documents[i],"part"),records(bottom.model,d,"part"));
const native = A.project("Native");
const [nativeSheet,nativeBoard] = native.documents;
native.library.push({id:"part",name:"Part",prefix:"J",value:"pin",symbol:{pins:[{x:0,y:0,number:"1",name:"PIN",electrical:4}],shapes:[]},
  footprint:{name:"Pin pad",pads:[{x:0,y:0,number:"1",w:1,h:1,shape:"round",layer:"Top",drill:0}],shapes:[]}});
nativeSheet.items.push({id:"connector",kind:"part",def:"part",ref:"J1",value:"pin",x:1,y:2,angle:0});
nativeBoard.items.push({id:"loose-pad",kind:"pad",number:"3",x:4,y:5,w:1.2,h:1.2,shape:"round",layer:"Top",drill:0,net:"SENSE"});
const nativeSingle = write(native,undefined,{scope:"document",documentId:nativeSheet.id});
assert.match(nativeSingle.files[0].text,/<package name="Pin_pad">/);
assert.match(nativeSingle.files[0].text,/<connect gate="G\$1" pin="PIN" pad="1"\/>/);
const padExport = write(native,undefined,{scope:"document",documentId:nativeBoard.id});
assert.match(padExport.files[0].text,/<contactref element="PAD" pad="3"\/>/);
assert.deepEqual(padExport.rows.filter(row=>row.kind === "pad").map(row=>[row.source.object,row.status]),[["loose-pad","approximated"]]);
// An unconnected via is drilled, so the board keeps it: EAGLE vias live in signals, so it gets one
// of its own (named clear of the design's nets). A slot written as a round EAGLE hole is reported.
{
  const free = A.project("Free"), freeBoard = free.documents.find(d=>d.kind === "pcb");
  freeBoard.items.push({id:"bare-via",kind:"via",x:8,y:8,diameter:.6,drill:.3,layer:"Multi",net:""},
    {id:"vcc-via",kind:"via",x:12,y:8,diameter:.6,drill:.3,layer:"Multi",net:"VCC"},
    {id:"named-like-eagle",kind:"track",layer:"Top",width:.2,points:[[1,1],[2,1]],net:"N$1"},
    {id:"slot-hole",kind:"pad",number:"",x:20,y:8,w:4,h:.8,shape:"round",layer:"Multi",drill:.8,slotLength:4,plated:false});
  const brd = write(free,undefined,{scope:"document",documentId:freeBoard.id});
  const text = brd.files[0].text, signals = [...text.matchAll(/<signal name="([^"]*)"[^>]*>([\s\S]*?)<\/signal>/g)];
  const viaIn = name => signals.filter(m=>m[1] === name).map(m=>(m[2].match(/<via /g) || []).length);
  assert.deepEqual(viaIn("VCC"),[1]);
  assert.deepEqual(viaIn("N$2"),[1],"the unconnected via has its own signal");
  assert.match(text,/<via x="8" y="-8" extent="1-16" drill="0.3" diameter="0.6"/);
  const row = id => brd.rows.filter(r=>r.source.object === id).map(r=>[r.status,r.reason]);
  assert.deepEqual(row("bare-via"),[["approximated","The unconnected via is written in a signal of its own."]]);
  assert.deepEqual(row("slot-hole").map(r=>r[0]),["approximated"]);
  const back = importPair(brd.files.map(f=>file(f.name,f.text))).model.documents.find(d=>d.kind === "pcb");
  assert.deepEqual(back.items.filter(i=>i.kind === "via").map(i=>[i.x,i.y,i.net]).sort(),[[12,8,"VCC"],[8,8,"N$2"]]);
}
console.log("PASS EAGLE XML pair and single-source export, live edits, net references, mirrored pads, outlines, classes and exact loss rows");
