"use strict";
const assert = require("node:assert/strict");
for (const file of ["model", "source-file", "sexpr", "format-2-codec", "format-2-units", "format-2-values",
  "design-query-record", "format-2-model", "import-sidecars", "import-reports", "undo-store"])
  require(require("../support/app-source-paths.cjs").appFile(file + ".js"));
const cleanup = require("../support/import-worker.cjs")({client:true});
const C = AtriumTranslatorClient, M = AtriumFormat2Model, F = AtriumFormat2, S = AtriumImportSidecars, R = AtriumImportReports;
const enc = new TextEncoder(), dec = new TextDecoder(), xml = AtriumSexpr;

// The fixtures are genuine foreign records. The first board rotation has a fractional
// nanodegree. Altium's 59 native ticks are 149.86 nm, on the low side of a KiCad sheet tie.
const pcb = '(kicad_pcb (version 20240108) (generator pcbnew) (general (thickness 1.6)) ' +
  '(layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "") ' +
  '(footprint "Precision" (layer "F.Cu") (at 2.000003 3.000007 12.1234567894) ' +
  '(fp_text reference "U1" (at 0 1) (layer "F.SilkS")) (fp_text value "Meter" (at 0 -1) (layer "F.Fab")) ' +
  '(pad "1" smd rect (at 0 0 12.1234567894) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))) ' +
  '(segment (start 4.000003 4.000007) (end 5.000013 5.000021) (width 0.200003) (layer "F.Cu") (net 0)))';
const sch = '|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0\r\n' +
  '|RECORD=31|SHEETSTYLE=0\r\n' +
  '|RECORD=4|INDEXINSHEET=0|LOCATION.X=0|LOCATION.X_FRAC=59|LOCATION.Y=0|LOCATION.Y_FRAC=1|TEXT=Witness|FONTID=1\r\n';
const input = (name, text) => ({name, bytes:enc.encode(text)});
const scope = (doc, extra = {}) => ({scope:"document", documentId:doc.id, ...extra});
function file(result, suffix) {
  const f = result.files.find(f => f.name.endsWith(suffix));
  assert.ok(f, "missing " + suffix);
  return f;
}
function field(line, key) {
  return Object.fromEntries(line.split("|").filter(Boolean).map(pair => { const at=pair.indexOf("=");return [pair.slice(0,at),pair.slice(at+1)]; }))[key];
}
function boardFields(result) {
  const tree = xml.parse(file(result,".kicad_pcb").text);
  return {at:xml.one(xml.one(tree,"footprint"),"at").slice(1),start:xml.one(xml.one(tree,"segment"),"start").slice(1)};
}
function sheetPoint(result) {
  const tree = xml.parse(file(result,".kicad_sch").text);
  return xml.one(xml.all(tree,"text").find(n => n[1] === "Witness"),"at").slice(1,3).map(Number);
}
function reopen(result) {
  const project = M.manifest(M.parse(F.serialize(result.manifest))).project;
  for (const member of result.files) {
    const f = M.parse(F.serialize(member.file)), kind = f.header.kind;
    if (kind === "pcb" || kind === "schematic") project.documents.push(M.document(f,{name:f.header.kind}));
    if (kind === "library") project.library.push(M.library(f));
  }
  return project;
}
async function nestedFields(source) {
  const design = Atrium.clone(source.model), d = design.documents[0];
  const fp = design.library[0].footprint, part = d.items.find(i => i.kind === "part");
  part.angle = 0;
  const width = .2540037;
  Object.assign(fp.pads[0], {id:"stable-pad", angle:-15.1234567894, w:width, number:"1"});
  fp.pads.push({...fp.pads[0],id:"plain-pad",number:"2",angle:0,w:width + .1});
  const track = d.items.find(i=>i.kind==="track");
  track.points[0][0] = width;
  design.rules = {format:"atrium-rules",version:3,units:"mm",list:[{id:"stable-limit",type:"clearance",
    name:"Precision gap",priority:1,enabled:true,scope:AtriumDesignQueryRecord.selector("all"),scope2:AtriumDesignQueryRecord.selector("all"),gap:width}]};
  design.rules.list.push({...design.rules.list[0],id:"companion-limit",name:"Companion resolution",priority:2,gap:.2539022});
  const saved = M.fromEditor({model:design,provenance:source.provenance}), model = reopen(saved), board = model.documents[0];
  const rows = saved.residuals, group = {...source.provenance,
    precision:{version:1,scopeId:"nested",documents:[board.id],rows}};
  assert.ok(rows.some(r=>r.id==="stable-pad"&&r.property==="/w"&&r.recordKind==="pad"));
  const precisionRule = model.rules.list.find(rule => rule.name === "Precision gap");
  assert.ok(AtriumUUID.isV7(precisionRule.id));
  assert.ok(rows.some(r=>r.id===precisionRule.id&&r.property==="/gap"&&r.recordKind==="rule"));
  const pad = model.library[0].footprint.pads.find(p=>p.id==="stable-pad");
  async function emitted(provenance) {
    const opts=scope(board,{provenance});
    const ki=await C.export("kicad",model,opts),k=xml.parse(file(ki,".kicad_pcb").text);
    assert.equal(JSON.parse(file(ki,".kicad_pro").text).board.design_settings.rules.min_clearance,.253902);
    const at=xml.one(xml.all(xml.one(k,"footprint"),"pad").find(p=>p[1]==="1"),"at");
    const ad=file(await C.export("altium",model,opts),".PcbDoc");
    const records=dec.decode(ad.bytes).split(/\r?\n/);
    const row=(which,match)=>records.find(line=>field(line,"RECORD")===which&&match(line));
    const p=row("Pad",line=>field(line,"NAME")==="1"), t=row("Track",line=>field(line,"LAYER")==="TOP");
    const r=row("DXPRule",line=>field(line,"NAME")==="Precision gap");
    return [at[3],field(p,"XSIZE"),field(p,"ROTATION"),field(t,"X1"),field(r,"GAP")];
  }
  const expected=["15.1234567894","10.0001mil","15.1234567894","10.0001mil","10.0001mil"];
  assert.deepEqual(await emitted([group]),expected);
  model.library[0].footprint.pads.reverse();
  assert.deepEqual(await emitted([group]),expected,"reordering stable leaves retains their own width/angle");
  assert.deepEqual(await emitted([]),["15.123456789","10.0002mil","15.123456789","10.0002mil","10.0002mil"]);
  pad.w=.508;model.rules.list[0].gap=.381;
  assert.deepEqual(await emitted([group]),["15.1234567894","20mil","15.1234567894","10.0001mil","15mil"]);
  // A positional-only library leaf cannot borrow a stable pad's old proof.
  delete pad.id;
  assert.equal((await emitted([group]))[0],"15.123456789");
}
async function main() {
  const k = await C.import([input("Measure.kicad_pcb",pcb)],{translator:"kicad"});
  const a = await C.import([input("Measure.SchDoc",sch)],{translator:"altium"});
  await nestedFields(k);
  const model = {...k.model,documents:[...k.model.documents,...a.model.documents]};
  const native = M.fromEditor(model), project = reopen(native), [board,sheet] = project.documents;
  const part = board.items.find(i => i.kind === "part"), label = sheet.items.find(i => i.text === "Witness");
  assert.ok(part && label);
  const proof = native.residuals.find(r => r.id === part.id && r.property === "/angle");
  assert.equal(proof.recordKind,"part");assert.equal(proof.nativeValue,12123456789);
  assert.equal(label.x,0.00015);
  const originalX=native.residuals.find(r=>r.owner===sheet.id && r.id===label.id && r.property==="/at/0");
  assert.deepEqual([originalX.nativeValue, originalX.numerator, originalX.denominator],[150,"-7","50"]);
  const sourceFor = (r,doc,id) => ({scopeId:id,adopted:true,names:r.provenance.files.map(f=>f.name),
    documents:[doc.id],report:JSON.parse(JSON.stringify(r.report)),provenance:{...JSON.parse(JSON.stringify({...r.provenance,files:[]})),
      files:r.provenance.files.map(f => ({...JSON.parse(JSON.stringify({...f,bytes:undefined})),bytes:new Uint8Array(f.bytes)}))},residuals:native.residuals.filter(row=>row.owner===doc.id)});
  const entries = [sourceFor(k,board,"scope-kicad"),sourceFor(a,sheet,"scope-altium")];
  const saved = await S.prepare(entries), session = {};
  const restored = saved.refs.map(ref=>S.restore(S.parse(saved.files.get(ref.path),ref)));
  const folder = {ensureImportReports:async()=>R.installRetained(session,restored)};
  const lazy = globalThis.AtriumLazy;
  globalThis.AtriumLazy = {...lazy, need:async name => name === "AtriumProjectArchiveUI" ?
    {originalFiles:binding => S.originalFiles(binding, row => saved.files.get(row.sourcePath))} : lazy.need(name)};
  globalThis.AtriumNavHost = {folderProject:()=>folder,project:()=>project,fileSession:()=>session,edit:f=>f(),on(){},registerAction(){}};
  R.attach(AtriumNavHost);

  async function outputs() {
    const k = boardFields(await C.export("kicad",project,scope(board)));
    const ad = await C.export("altium",project,scope(board));
    const line = dec.decode(file(ad,".PcbDoc").bytes).split(/\r?\n/).find(l=>/\|RECORD=Component\|/i.test(l));
    return {k,rotation:field(line,"ROTATION"),foreign:ad};
  }
  let out = await outputs();
  assert.deepEqual(out.k.at,["2.000003","3.000007","12.1234567894"]);
  assert.deepEqual(out.k.start,["4.000003","4.000007"]);
  assert.equal(out.rotation,"12.1234567894");
  const writtenKiCad=file(await C.export("kicad",project,scope(board)),".kicad_pcb");
  const parsedKiCad=await C.import([input(writtenKiCad.name,writtenKiCad.text)],{translator:"kicad"});
  assert.equal(parsedKiCad.model.documents[0].items.find(i=>i.kind==="part").angle,-12.1234567894);
  const parsed = await C.import([file(out.foreign,".PcbDoc")],{translator:"altium"});
  assert.equal(parsed.model.documents[0].items.find(i=>i.kind==="part").angle,-12.1234567894);
  const sheetResult = await C.export("kicad",project,scope(sheet));
  const [px,py] = sheetPoint(sheetResult), [ox,oy] = sheetResult.details.offset;
  assert.equal(Math.round((px-ox)*1e6),100);
  assert.equal(Math.round((py-oy)*1e6),0);
  const sheetOut = await C.export("altium",project,scope(sheet));
  const labelLine = dec.decode(file(sheetOut,".SchDoc").bytes).split(/\r?\n/).find(l=>l.includes("TEXT=Witness"));
  assert.equal(Number(field(labelLine,"LOCATION.X_FRAC"))%100000,59);
  assert.equal(Number(field(labelLine,"LOCATION.Y_FRAC"))%100000,1);

  const history=[], redo=[], U=AtriumUndoStore;
  U.reset();const mark=U.mark(project,{current:board.id});
  part.angle=-13.987654321;part.x=8.000003;
  U.checkpoint(history,redo,mark,"Rotate and move");U.touch(project);
  out=await outputs();
  assert.equal(out.k.at[2],"13.987654321");assert.equal(out.rotation,"13.987654321");assert.equal(out.k.at[0],"8.000003");
  assert.equal(out.k.at[1],"3.000007");
  assert.ok(U.jump(history,redo,U.mark(project,{current:board.id}),-1));U.touch(project);
  assert.equal((await outputs()).rotation,"12.1234567894");

  // Draft input can lie in the old integer's rounding cell and still be an authored edit.
  const restoredPart=board.items.find(i=>i.id===part.id), old=restoredPart.angle;
  restoredPart.angle=-12.1234567892;
  assert.equal((await outputs()).rotation,"12.1234567892");
  restoredPart.angle=old;
  // A different document has the same visible part and item ID. An additional scope
  // claiming the same native field is ambiguous. A replaced record of a different kind
  // does not inherit the original angle. No input or stored sidecar is modified.
  const other={...board,id:"other-board",name:"Other",items:board.items.map(i=>({...i}))};
  const working={...project,documents:[...project.documents,other]};
  const groups=R.provenance();
  assert.equal(boardFields(await C.export("kicad",working,scope(other,{provenance:groups}))).at[2],"12.123456789");
  const same=groups.find(g=>g.precision?.scopeId==="scope-kicad");
  const wrongUnit={...same,precision:{...same.precision,rows:same.precision.rows.map(r=>r.property==="/angle"?{...r,unit:"nm"}:r)}};
  assert.equal(boardFields(await C.export("kicad",working,scope(board,{provenance:[wrongUnit]}))).at[2],"12.123456789");
  const conflict={precision:{...same.precision,scopeId:"third-import"}};
  assert.equal(boardFields(await C.export("kicad",working,scope(board,{provenance:[...groups,conflict]}))).at[2],"12.123456789");
  const replacement={...restoredPart,kind:"label",text:"Replacement",size:1,layer:"Silk"};
  const swapped={...board,items:[replacement]};
  const flat=await C.export("kicad",{...project,documents:[swapped]},scope(swapped,{provenance:groups}));
  const gr=xml.one(xml.parse(file(flat,".kicad_pcb").text),"gr_text");
  assert.equal(xml.one(gr,"at")[3],"12.123456789");

  assert.ok(R.discard("scope-kicad"));
  assert.equal((await outputs()).rotation,"12.123456789");
  assert.ok(R.discard("scope-altium"));
  assert.equal(R.provenance().some(g=>g.precision),false);
  assert.equal(await S.sha(input("src",sch).bytes),a.provenance.files[0].sha256);
  console.log("Exact foreign precision passed for scoped native fields, grids, rotation, edit, Undo and discard.");
}
main().finally(()=>{C.cancel();cleanup();}).catch(e=>{console.error(e);process.exitCode=1;});
