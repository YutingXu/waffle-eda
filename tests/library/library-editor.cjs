"use strict";
const assert=require("node:assert/strict");
const installImportWorker=require("../support/import-worker.cjs");
const {nativeRoundTrip}=require("../support/native-cad.cjs");
for(const m of ["model","parts","library-editor"])require(require("../support/app-source-paths.cjs").appFile(m));
async function model(){
  const L=AtriumLibraryEditor, d=L.draft(null);d.name="Sense connector";d.footprint="TestHeader3";d.rows.push(L.freshRow(d.rows));
  d.rows[1].name="SENSE";d.rows[2].side="Right";d.rows[2].px=2.54;d.rows[2].drill=0;
  const def=L.build(d),p=Atrium.project("Library",[def]),symbol=Atrium.instantiate(p,def,[5,5]),pcb=Atrium.instantiate(p,def,[0,0],90,symbol);
  p.documents[0].items.push(symbol);p.documents[1].items.push(pcb);assert.deepEqual(Atrium.validate(JSON.parse(JSON.stringify(p))),p);
  const tips=Atrium.pins(symbol,def,"schematic");assert.deepEqual(tips.map(i=>i.number),def.footprint.pads.map(i=>i.number));
  assert.deepEqual(def.symbol.shapes.filter(s=>s.kind==="path"&&!s.closed).map(s=>s.points[0]),def.symbol.pins.map(p=>[p.x,p.y]));
  const U=AtriumFormat2Units, [x,y]=tips[1].at.map(value=>U.mm(U.length(value).value));
  p.documents[0].items.push({id:"named",kind:"netlabel",text:"SENSE",x,y});
  assert.equal(Atrium.connectivity(p.documents[0],new Map([[def.id,def]])).byPin.get(symbol.id+"/2"),"SENSE");
  const copied=L.build(L.draft(def,p.library));assert.notEqual(copied.id,def.id);assert.deepEqual(copied.symbol,def.symbol);assert.deepEqual(copied.footprint,def.footprint);
  const old=Atrium.clone(AtriumParts.catalogue[0]),stock=L.build(L.draft(old));assert.deepEqual(stock.symbol,old.symbol);assert.deepEqual(stock.footprint,old.footprint);
  for(const [field,value,re] of [["number","1",/appears twice/],["px","",/pad X/],["drill",3,/smaller/],["h",0,/height/],["side","south",/side/],["y",Infinity,/pin 2/]]){
    const copy=structuredClone(d);copy.rows[1][field]=value;assert.throws(()=>L.build(copy),re);
  }
  const bad=L.draft(null);bad.name="X";bad.rows[1].y=0;assert.throws(()=>L.build(bad),/connection point/);bad.rows[1].side="Right";bad.rows[1].py=0;assert.throws(()=>L.build(bad),/share a centre/);
  const reopened=nativeRoundTrip(p);
  assert.deepEqual(reopened.library.map(Atrium.definitionGeometry),p.library);
  assert.ok(reopened.library[0].symbol.pins.every(pin=>AtriumUUID.isV7(pin.nativeId)));
  assert.deepEqual(nativeRoundTrip(reopened).library,reopened.library);
  assert.deepEqual(reopened.documents,p.documents);
  assert.equal(Atrium.connectivity(reopened.documents[0],new Map(reopened.library.map(d=>[d.id,d]))).byPin.get(symbol.id+"/2"),"SENSE");
  const restoreWorker=installImportWorker({client:true});
  try {
    const bytes=new TextEncoder().encode(JSON.stringify(p));
    const refused=await AtriumTranslatorClient.import([{name:"Parts.waffle",bytes}]).then(()=>null,error=>error);
    assert.equal(AtriumTranslatorClient.mode,"worker");
    assert.equal(refused?.code,"pre-release-format");
    assert.equal(refused.message,"This file is from a pre-release Waffle build; re-import the design from its source EDA");
  } finally {restoreWorker();}
  console.log("PASS pin-mapped authoring, native folder round-trip, unchanged pin/pad geometry, and exact pre-release file refusal");
}
async function ui(){
  if(!process.argv.includes("--dom"))return;
  const {setup}=require("../integration/integration.cjs");
  const environment=await setup({demo:false}), restoreWorker=require("../support/folder-worker.cjs")();
  try {await nativeLibraryWorkflow(environment);}
  finally {try {await AtriumNavHost.folderProject()?.close();} finally {await restoreWorker();}}
}
async function nativeLibraryWorkflow({window,document,openPanel}){
  const H=AtriumNavHost, native=AtriumHost;
  const node=(s)=>{const n=document.querySelector(s);assert.ok(n,s);return n;};
  function action(n){node('[data-action="'+n+'"]').click();}
  const named=n=>node('dialog.se-dialog [aria-label="'+n+'"]');
  const button=(str,scope="dialog.se-dialog")=>{const b=[...document.querySelectorAll(scope+" button")].find(n=>n.textContent===str);assert.ok(b,str);return b;};
  function field(n,value,event="change"){const f=named(n);f.value=value;f.dispatchEvent(new window.Event(event,{bubbles:true}));}
  async function until(test,desc){const t=Date.now();while(!test()){if(Date.now()-t>4000)throw Error(desc+" · "+node("#status").textContent);await new Promise(r=>setTimeout(r,6));}}
  const draft=AtriumLibraryEditor.draft(null);
  draft.name="Header donor"; draft.prefix="X"; draft.footprint="Header_3"; draft.rows.push(AtriumLibraryEditor.freshRow(draft.rows));
  draft.rows[2].w=2.1; draft.rows[2].px=2.54;
  const donor=AtriumLibraryEditor.build(draft), fixture=Atrium.project("Parts bench",[donor]);
  fixture.documents[0].items.push(Atrium.instantiate(fixture,donor,[35,20]));
  const A=AtriumProjectArchive,M=AtriumFormat2Model,C=AtriumFormat2;
  const prepare=M.fromEditor(fixture), bytes=new Map(prepare.files.map(r=>[r.path,C.serialize(r.file)]));
  let savedZIP;
  async function open(manifest,files){
    const folder={...AtriumBrowserProject.create(manifest,files),temporary:false};
    native.open=async()=>[{name:manifest,folderProject:folder}];
    let adopted;
    const ack=new Promise(resolve=>{adopted=resolve;});
    native.finishedOpening=adopted;
    action("open");
    assert.equal(await ack,true,node("#status").textContent);
    assert.equal(H.folderProject().grant,folder.grant);
  }
  async function save(){
    const session=H.folderProject();
    await H.saveAll({download:false});
    assert.equal(session.dirty,false,node("#status").textContent);
    const lease=await AtriumProjectArchiveUI.acquireSavedExportSnapshot({project:H.project(),host:H});
    try {savedZIP=(await lease.projectArchive()).bytes;} finally {await lease.release();}
    const zip=A.zipDirectory(savedZIP), [entry]=await zip.projects();
    const verified=await A.extract(zip,entry,A.verifyClosure), read=path=>verified.files.get(path);
    return require("../support/native-cad.cjs").projectFromRecords(M.parse(read(verified.manifest)),read,{nativeAssets:true});
  }
  await open(prepare.manifestPath,bytes);
  async function create(){
    action("library-catalogue");node("#new-library-component").click();
    await until(()=>document.querySelector("dialog.se-dialog[open]"),"New component opened the symbol editor");
  }
  function clickScreen(p){for(const type of ["pointerdown","pointerup"]){const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{button:0,pointerId:1,clientX:p[0],clientY:p[1]});node("#canvas").dispatchEvent(e);}}
  await create();field("Name","Sensor link");field("Prefix","J");field("Default value","I²C");field("Use footprint of",donor.id);
  button("Pin table").click();
  for(const [i,name] of ["VDD","SDA","GND"].entries()){
    button("Add pin").click();field("Name of pin "+(i+1),name);
  }
  field("Side of pin 3","right");field("Number of pin 2","1");
  button("Save and place").click();assert.match(node("dialog.se-dialog .fe-hint").textContent,/duplicate|appears|used|repeated/i);
  field("Number of pin 2","2");button("Save and place").click();
  assert.equal(document.querySelector("dialog.se-dialog"),null);
  clickScreen([400,320]);const placed=await save(),definition=placed.library.find(i=>i.name==="Sensor link"),sheet=placed.documents[0],part=sheet.items.find(i=>i.def===definition.id);
  assert.ok(part);assert.equal(part.ref,"J1");assert.equal(part.value,"I²C");
  const camera=H.view();
  const appliedNames=["VDD_3V3","I2C_DATA","GND"];
  for(const [k,pin] of Atrium.pins(part,definition,"schematic").entries()){
    action("label");
    const tab=new window.Event("keydown",{bubbles:true,cancelable:true});Object.assign(tab,{key:"Tab",code:"Tab"});node("#canvas").dispatchEvent(tab);
    const f=node('[aria-label="Placement properties"] form'), input=f.querySelector('[aria-label="Net name"]');
    input.value=appliedNames[k];input.dispatchEvent(new window.Event("input",{bubbles:true}));
    f.onsubmit({preventDefault(){}});clickScreen(camera.worldToScreen(pin.at));
  }
  await openPanel("components");
  node('#parts [data-part="'+part.id+'"]').click();
  await openPanel("properties");
  button("Place footprint on board","#inspector").click();clickScreen([420,320]);
  const both=await save(),board=both.documents[1],fp=board.items.find(i=>i.link===part.link);
  assert.equal(fp.ref,part.ref);assert.equal(fp.def,definition.id);assert.deepEqual(fp.pinNets,{"1":"VDD_3V3","2":"I2C_DATA","3":"GND"});
  assert.match(AtriumKiCad.exportBoard(both,board.id).content,/\(pad "3" thru_hole/);assert.match(AtriumKiCadSchematic.exportSheet(both,sheet.id).content,/\(name "SDA"/);
  const zip=A.zipDirectory(savedZIP), [entry]=await zip.projects(), verified=await A.extract(zip,entry,A.verifyClosure);
  await open(verified.manifest,verified.files);
  const reopened=await save();assert.deepEqual(reopened,both);
  await openPanel("library");
  const originalRow='.lib-row[data-def="'+definition.id+'"]';
  await until(()=>document.querySelector(originalRow),"load authored library entry");
  node(originalRow).click();
  button("Duplicate",".lib-detail-actions").click();
  button("Edit symbol",".lib-detail-actions").click();
  await until(()=>document.querySelector("dialog.se-dialog[open]"),"edit the duplicate symbol");
  assert.equal(named("Name").value,"Sensor link copy");button("Pin table").click();field("Name of pin 2","SCL");
  button("Save •").click();
  assert.equal(document.querySelector("dialog.se-dialog"),null);
  const copied=await save(),copy=copied.library.find(i=>i.name==="Sensor link copy");
  assert.equal(copy.symbol.pins[1].name,"SCL");assert.deepEqual(copied.library.find(i=>i.id===definition.id),definition);assert.deepEqual(copied.documents,both.documents);
  action("undo");const unedited=await save();assert.equal(unedited.library.find(i=>i.id===copy.id).symbol.pins[1].name,"SDA");
  action("undo");assert.deepEqual(await save(),both);
  console.log("PASS library UI: authored three pins, rejected duplicate numbers, verified linked placements and KiCad exports after native Save, reopened the ZIP, edited the copy and undid each operation");
}
globalThis.__testDone=model().then(ui).catch(e=>{console.error(e);process.exitCode=1;});
