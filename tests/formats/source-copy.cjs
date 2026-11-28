"use strict";

const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
globalThis.CFB=require("../../app/vendor/cfb.min.js");
for(const module of ["model","source-file","sch-import","altium-rules","pcb-pours","pcb-import","sch-patch","pcb-patch","source-copy","io","eco","blocks","symbols"])require(require("../support/app-source-paths.cjs").appFile(module));

const {reopenAltium}=require("../support/altium-folder.cjs");
const clone=structuredClone;
const originals=new Map(), entries=new Map(), retained=new WeakMap();
const digest=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const prepare=(project,bytes)=>AtriumSourceCopy.prepare(project.documents[0],project.library,bytes,{provenance:retained.get(project)});
function persisted(project) {
  const id=project.documents[0].id;
  const saved=reopenAltium(project,originals.get(id),entries.get(id));
  retained.set(saved.project,saved.retained);
  return saved.project;
}
function imported(name,bytes){
  const parsed=AtriumIO.read(name,bytes),project=Atrium.project(name,parsed.library);
  project.documents=parsed.documents;
  const original={name,bytes};
  originals.set(project.documents[0].id,original);
  entries.set(project.documents[0].id,reopenAltium(project,original).entry);
  return Atrium.validate(project);
}
function assertNoop(project,source){
  const result=prepare(project,source);
  assert.deepEqual(Buffer.from(result.bytes),source);
  assert.deepEqual(result.records,[]);
  assert.deepEqual(result.changes,[]);
  assert.equal(result.sourceSha256,digest(source));
}
function schFile(extra=[]){
  const records=[
    "|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0",
    "|RECORD=31",
    "|RECORD=1|LibReference=Resistor|Location.X=10|Location.Y=20",
    "|RECORD=34|OwnerIndex=1|Name=Designator|Text=R1",
    "|RECORD=41|OwnerIndex=1|Name=Value|Text=1k",
    "|RECORD=2|OwnerIndex=1|Location.X=10|Location.Y=20|PinLength=5|Designator=1",
    "|RECORD=2|OwnerIndex=1|Location.X=30|Location.Y=20|PinLength=5|Designator=2",
    "|RECORD=27|LocationCount=2|X1=5|Y1=8|X2=8|Y2=8",
    "|RECORD=29|Location.X=8|Location.Y=8",
    "|RECORD=225|Unmapped=Retained",...extra
  ];
  const compound=CFB.utils.cfb_new();
  const framed=records.map(line=>{
    const payload=Buffer.from(line+"\0","latin1"),header=Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    return Buffer.concat([header,payload]);
  });
  CFB.utils.cfb_add(compound,"FileHeader",Buffer.concat(framed));
  CFB.utils.cfb_add(compound,"Unmapped/Data",Buffer.from([235,255,170]));
  return Buffer.from(CFB.write(compound,{type:"buffer"}));
}
function legacy(project){
  const older=clone(project),doc=older.documents[0];
  delete doc.sourceSha256;
  for(const item of doc.items){delete item.schSource;delete item.sourceRecord;}
  return older;
}
function bindOlder(project,source){
  const doc=project.documents[0],before=AtriumECO.serialize(doc);
  const {binding}=prepare(project,source);
  assert.equal(AtriumECO.serialize(doc),before);
  assert.equal(binding.sha256,digest(source));
  assert.equal(binding.identities.length,doc.items.length);
  AtriumSourceCopy.applyBinding(doc,binding);
  assertNoop(persisted(project),source);
}

const original=schFile(),before=Buffer.from(original),fresh=imported("Source.SchDoc",original);
{
  const bytes=schFile(["|RECORD=17|ISCROSSSHEETCONNECTOR=T|SHOWNETNAME=T|TEXT=CLK|LOCATION.X=20|LOCATION.Y=25"]);
  const p=imported("Connector.SchDoc",bytes),connector=p.documents[0].items.find(Atrium.isOffsheet);
  connector.kind="offsheet";connector.io="output";
  const state=JSON.stringify(connector),copy=prepare(p,bytes);
  assert.deepEqual(Buffer.from(copy.bytes),bytes);
  assert.match(copy.diagnostics.join(" "),/CLK.*lost its output direction/);
  assert.equal(JSON.stringify(connector),state);
  connector.text="SCLK";
  const renamed=prepare(p,bytes),reopened=imported("Connector.SchDoc",renamed.bytes);
  assert.equal(reopened.documents[0].items.find(Atrium.isOffsheet).text,"SCLK");
  assert.ok(!Object.hasOwn(reopened.documents[0].items.find(Atrium.isOffsheet),"io"));
}
const sheet=fresh.documents[0],resistor=sheet.items.find(i=>i.ref==="R1");
const saved=persisted(fresh);
assert.deepEqual(saved.documents[0].items.map(i=>i.schSource),sheet.items.map(i=>i.schSource));
assertNoop(saved,original);
const changed=clone(saved),changedPart=changed.documents[0].items.find(i=>i.ref==="R1");
changedPart.ref="R101";changedPart.value="4.7 kΩ";
const result=prepare(persisted(changed),original);
assert.equal(result.name,"Source-edited.SchDoc");
assert.equal(result.sourceSha256,sheet.sourceSha256);
assert.deepEqual(result.records,[2,3]);
const reopened=imported(result.name,result.bytes);
assert.equal(reopened.documents[0].items.find(i=>i.ref==="R101").value,"4.7 kΩ");
assert.deepEqual(AtriumIO.streams(result.bytes).get("unmapped/data"),AtriumIO.streams(original).get("unmapped/data"));
assert.equal(reopened.documents[0].sourceSha256,digest(result.bytes));
assertNoop(reopened,Buffer.from(result.bytes));
assert.deepEqual(before,original);

// One supported edit must never hide another edit the writer cannot represent.
const fail=(alter,message)=>{
  const proposal=clone(changed);alter(proposal.documents[0],proposal);
  const snapshot=AtriumECO.serialize(proposal);
  assert.throws(()=>prepare(proposal,original),message);
  assert.equal(AtriumECO.serialize(proposal),snapshot);
  assert.deepEqual(original,before);
};
fail(doc=>doc.items.push({id:"new",kind:"junction",x:1,y:2}),/new or unlinked/);
fail(doc=>doc.items.splice(doc.items.findIndex(i=>i.kind==="wire"),1),/added or removed/);
fail(doc=>doc.items.push({...doc.items[0],id:"duplicate"}),/same Altium source record/);
fail(doc=>{doc.items.find(i=>i.kind==="part").angle=90;},/angle/);
fail(doc=>{doc.outline=[[1,1],[2,2]];},/outline/);
fail((doc,project)=>{project.library=[];},/library definition/);
const wrong=Buffer.from(original);wrong[wrong.length-1]^=1;
assert.throws(()=>prepare(changed,wrong),/SHA-256 mismatch/);
const editorOnly=clone(fresh);
Object.assign(editorOnly.documents[0],{name:"Power",grid:2.54,notes:["reviewed"],sourceProject:"Analog"});
editorOnly.documents[0].items.find(i=>i.kind==="part").link="reconciled";
assertNoop(editorOnly,original);

const style=clone(fresh),settings=AtriumSymbols.preferences(style);
settings.resistor="iec";
settings.mappings.push([AtriumSymbols.keyFor(style.library.find(d=>d.id===resistor.def)),"resistor"]);
assert.ok(AtriumSymbols.applyPreferences(style,settings).changed);
assert.throws(()=>prepare(style,original),/library definition/);
settings.resistor="source";AtriumSymbols.applyPreferences(style,settings);assertNoop(style,original);

bindOlder(legacy(saved),original);
const stale=legacy(fresh),staleDoc=stale.documents[0],pending=prepare(stale,original).binding;
staleDoc.items.find(i=>i.kind==="part").value="8k";
assert.throws(()=>AtriumSourceCopy.applyBinding(staleDoc,pending),/stale/);
assert.ok(staleDoc.items.every(i=>!i.schSource));assert.equal(staleDoc.sourceSha256,undefined);
assert.throws(()=>prepare(stale,original),/older import has edited/);
const other=legacy(fresh);other.documents[0].id="another-document";
assert.throws(()=>AtriumSourceCopy.applyBinding(other.documents[0],pending),/stale/);
const duplicate=clone(pending);duplicate.identities[1].schSource=duplicate.identities[0].schSource;
assert.throws(()=>AtriumSourceCopy.applyBinding(legacy(fresh).documents[0],duplicate),/during review/);

// Older Waffle imports did not keep the PCB datum. A native copy still
// retains that original Board6 field, including when applying an allowed edit.
{
  const name="PiDP11IOExpander.PcbDoc";
  const bytes=fs.readFileSync(path.join(__dirname,"../fixtures/altium/pidp11-io-expander",name));
  const old=imported(name,bytes),doc=old.documents[0];
  assert.deepEqual(doc.origin,[0,0]);
  doc.origin=[1,2];
  assert.throws(()=>prepare(old,bytes),/origin field changed/);
  delete doc.origin;
  assertNoop(persisted(old),bytes);
  const track=doc.items.find(i=>i.kind==="track"&&i.layer==="Top"&&i.sourceRecord.startsWith("tracks6/data#"));
  track.width+=.0254;
  const copy=prepare(persisted(old),bytes);
  assert.deepEqual(copy.records,[track.sourceRecord]);
  assert.deepEqual(imported(name,copy.bytes).documents[0].origin,[0,0]);
}

// A retained foreign import can omit fields the current Altium reader understands.
// A supported track edit keeps the compound file's original rules, islands and models.
{
  const name="PiDP11IOExpander.PcbDoc";
  const bytes=fs.readFileSync(path.join(__dirname,"../fixtures/altium/pidp11-io-expander",name));
  const p=imported(name,bytes),doc=p.documents[0];
  const track=doc.items.find(i=>i.kind==="track"&&i.sourceRecord.startsWith("tracks6/data#")&&!i.sourcePour);
  track.width+=.0254;
  const current=prepare(persisted(p),bytes);
  assert.deepEqual(current.records,[track.sourceRecord]);
  const proof=clone(p),saved=proof.documents[0];
  saved.appliedSourceRuleRecords=[1];
  assert.ok(saved.bodyModels.some(asset=>asset.checksum!=null));
  assert.ok(saved.pcbDrawing.pours.every(r=>Number.isInteger(r.subPolygonIndex)));
  for(const asset of saved.bodyModels)delete asset.checksum;
  for(const r of saved.pcbDrawing.pours)delete r.subPolygonIndex;
  for(const i of saved.items.filter(i=>i.kind==="polygon")){
    delete i.sourcePourOver;
    if(!i.fillMode){delete i.hatchWidth;delete i.hatchPitch;}
  }
  // Earlier imports did not read the source lock: every object of theirs is unlocked and the board is unstamped.
  assert.equal(saved.items.filter(i=>i.locked).length,107);
  assert.equal(saved.sourceLockVersion,1);
  for(const i of saved.items)delete i.locked;
  delete saved.sourceLockVersion;
  const pads=proof.library.flatMap(d=>d.footprint?.pads||[]).filter(p=>p.stackMode==="tmb");
  assert.ok(pads.length);
  for(const pad of pads){delete pad.stackMode;delete pad.padStack;}
  assert.deepEqual(prepare(persisted(proof),bytes).bytes,current.bytes);
  const streams=AtriumIO.streams(current.bytes);
  for(const [key,value] of AtriumIO.streams(bytes))if(key!=="tracks6/data")assert.deepEqual(streams.get(key),value,key);

  // The copy keeps the source's own locks, which this writer cannot change. On a board imported with
  // its locks, an unlock (the editor deletes the field) and an added lock are both refused by name,
  // for every kind; nothing is written.
  assert.equal(persisted(p).documents[0].sourceLockVersion,1,"the stamp survives a native save and reopen");
  for(const kind of ["part","polygon","via","pad","label","graphic"]){
    const unlocked=clone(p),item=unlocked.documents[0].items.find(i=>i.kind===kind&&i.locked);
    delete item.locked;
    assert.throws(()=>prepare(persisted(unlocked),bytes),error=>error.message===item.sourceRecord+" \u2014 Unlocking a source object requires editing in Altium.",kind);
  }
  for(const kind of ["via","track","graphic"]){
    const added=clone(p),item=added.documents[0].items.find(i=>i.kind===kind&&!i.locked);
    item.locked=true;
    assert.throws(()=>prepare(persisted(added),bytes),error=>error.message===item.sourceRecord+" \u2014 Locking a source object requires editing in Altium.",kind);
  }
  // Moving a source-locked part is refused as before, on a stamped board and on an earlier import.
  for(const older of [false,true]){
    const moved=clone(p),doc=moved.documents[0],part=doc.items.find(i=>i.kind==="part"&&i.locked);
    if(older){for(const i of doc.items)delete i.locked;delete doc.sourceLockVersion;}
    part.x+=.254;
    assert.throws(()=>prepare(persisted(moved),bytes),/Locked or grouped footprints require editing in Altium/);
  }
  // An earlier import in which the user locked an object: still an edit, still named.
  {
    const older=clone(p),doc=older.documents[0];
    for(const i of doc.items)delete i.locked;
    delete doc.sourceLockVersion;
    const via=doc.items.find(i=>i.kind==="via");via.locked=true;
    assert.throws(()=>prepare(persisted(older),bytes),error=>error.message===via.sourceRecord+" \u2014 Locking a source object requires editing in Altium.");
  }

  const altered=clone(p);
  altered.documents[0].pcbDrawing.pours[0].subPolygonIndex++;
  assert.throws(()=>prepare(persisted(altered),bytes),/pcbDrawing field changed/);
  const alteredLand=clone(p);
  alteredLand.library.flatMap(d=>d.footprint?.pads||[]).find(p=>p.stackMode==="tmb").padStack.Bottom.w+=.0254;
  assert.throws(()=>prepare(persisted(alteredLand),bytes),/library definition/);
}

let external=0,linkedBoards=0;
if(process.argv.includes("--fixtures")){
  const dir=process.argv[process.argv.indexOf("--fixtures")+1];
  // JSC cannot enumerate host directories. Its runner can pass the same real file names explicitly.
  const namesAt=process.argv.indexOf("--source-files");
  const names=namesAt<0 ? fs.readdirSync(dir) : process.argv.slice(namesAt+1);
  for(const name of names.filter(n=>path.basename(n)===n && /\.(SchDoc|PcbDoc)$/i.test(n))){
    const source=fs.readFileSync(path.join(dir,name)),project=imported(name,source);
    assertNoop(persisted(project),source);
    external++;
  }
  const realBoard=path.join(dir,"qfsae-0.PcbDoc");
  if(fs.existsSync(realBoard)){
    const boardBytes=fs.readFileSync(realBoard);
    for(const reviewedRules of [false,true]){
      const unlinked=legacy(imported("PDP_V3.PcbDoc",boardBytes));
      if(reviewedRules)unlinked.documents[0].appliedSourceRuleRecords=[1];
      bindOlder(unlinked,boardBytes);
      assert.ok(unlinked.documents[0].sourceRules.length);
      linkedBoards++;
    }
    const board=imported("PDP_V3.PcbDoc",boardBytes),doc=board.documents[0];
    const track=doc.items.find(i=>i.kind==="track" && i.layer==="Top" && i.sourceRecord.startsWith("tracks6/data#"));
    const via=doc.items.find(i=>i.kind==="via");
    track.width+=.0254;via.x+=.254;
    const output=prepare(persisted(board),boardBytes);
    assert.deepEqual(new Set(output.records),new Set([track.sourceRecord,via.sourceRecord]));
    const again=imported(output.name,output.bytes).documents[0];
    const actual=key=>again.items.find(i=>i.sourceRecord===key);
    assert.ok(Math.abs(actual(track.sourceRecord).width-track.width)<.00000131);
    assert.ok(Math.abs(actual(via.sourceRecord).x-via.x)<.00000131);
    assert.ok(output.diagnostics.some(line=>line.includes("Repour")));
    const defs=new Map(board.library.map(d=>[d.id,d]));
    const block=AtriumBlocks.capture(doc,defs,[-1000,-1000],[1000,1000],"Reusable layout");
    const copy=AtriumBlocks.prepare(board,block,[1,1]);
    assert.ok(copy.items.length);assert.ok(copy.items.every(i=>!i.sourceRecord));
    doc.items.push(...copy.items);board.library.push(...copy.library);
    assert.throws(()=>prepare(board,boardBytes),/new or unlinked/);
    const older=legacy(imported("PDP_V3.PcbDoc",boardBytes));
    older.documents[0].sourceRules.pop();
    assert.throws(()=>prepare(older,boardBytes),/sourceRules field changed/);
  }
}
console.log("High-level source copy, persistence, atomic rejection and legacy binding passed. "+external+" external document(s); "+linkedBoards+" verified board binding(s).");
