"use strict";
// Use the same isolated import contract and editor adoption plan as File › Open.
// The public PiDP11 project must arrive in sync, including Altium's automatic net names.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "board-shape-sources", "stackup", "polygon-pour", "import-link",
  "altium-rules", "connectivity", "rules", "pcb-appearance", "pcb-edit", "eco", "translator-table", "translator-registry",
  "import-worker-client", "import-reports", "design-reader"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const ALTIUM = path.join(__dirname,"../fixtures/altium/pidp11-io-expander"), DEMO = path.join(__dirname,"../fixtures/import");
const file = (dir, name) => ({name, bytes: new Uint8Array(fs.readFileSync(path.join(dir,name)))});

async function run() {
  const mine = Atrium.project("My board", AtriumParts.catalogue);
  mine.documents[0].items.push({id:"mine-r",kind:"part",def:AtriumParts.catalogue[0].id,ref:"R99",value:"10k",x:0,y:0,angle:0});
  const before = JSON.stringify(mine), myDocs = new Set(mine.documents.map(d => d.id));
  async function translate(files) {
    return {files, ...await AtriumTranslatorClient.import(files)};
  }
  async function open(read, project=mine, into=false) {
    const r = await AtriumDesignReader.assemble(read, project, project.documents[0].id, {into});
    Atrium.validate(r.after);
    assert.equal(JSON.stringify(mine), before, "Open preserves the user's design until adoption");
    return r;
  }
  async function ownProject(files,name) {
    const read = await translate(files), result = await open(read);
    assert.equal(result.openLib,false);
    assert.equal(result.after.name,name);
    assert.notEqual(result.after.id, mine.id, "opening a foreign design owns a separate project identity");
    assert.ok(result.after.documents.every(d => !myDocs.has(d.id) && d.items.every(i => i.id!=="mine-r")));
    assert.ok(["pcb","schematic"].every(kind => result.after.documents.some(d => d.kind===kind)));
    assert.ok(read.provenance.files.some(f => f.documents.includes(result.newDoc)), "initial view is an imported document");
    return {read,result};
  }
  const altiumFiles=["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"].map(n => file(ALTIUM,n));
  const {read,result} = await ownProject(altiumFiles,"PCB-PiDP11IOExpander");
  const p=result.after, defs=new Map(p.library.map(d => [d.id,d]));
  assert.equal(p.documents.length,2);
  assert.ok(p.documents.every(d => !("sourceName" in d) && !("sourceProject" in d)));
  assert.ok(read.provenance.fields.filter(f => f.type==="document").every(f => f.values.sourceProject===p.name));
  for (const [names,name] of [
    [["demo.kicad_pro","demo.kicad_pcb","root.kicad_sch","child.kicad_sch"],"demo"],
    [["demo-eagle.sch","demo-eagle.brd"],"demo-eagle"],
    [["demo-easyeda-sch.json","demo-easyeda-pcb.json"],"demo-easyeda-sch"]
  ]) await ownProject(names.map(n=>file(DEMO,n)),name);
  const lib={id:"lib-x",name:"Imported part",footprint:{name:"X",shapes:[],pads:[]}};
  const appended=await open({model:{documents:[],library:[lib]},report:{translator:"altium",notes:[]},files:[{name:"parts.PcbLib"}]});
  assert.equal(appended.openLib,true);
  assert.deepEqual(appended.after.documents.map(d=>d.id),mine.documents.map(d=>d.id));
  assert.ok(appended.after.library.some(d=>d.id===lib.id));
  assert.equal(appended.libraryTarget,"pcb");

  const schFile=await translate([file(ALTIUM,"PiDP11IOExpander.SchDoc")]), added=await open(schFile,mine,true);
  assert.equal(added.after.name,mine.name);
  assert.equal(added.after.id,mine.id,"Add Existing keeps the current project identity");
  assert.deepEqual(added.after.documents.slice(0,-1).map(d=>d.id),mine.documents.map(d=>d.id));
  assert.equal(added.newDoc,added.after.documents.at(-1).id);
  assert.ok(added.after.documents[0].items.some(i=>i.ref==="R99"));
  const session = {};
  AtriumImportReports.attach({fileSession:() => session, on(){}, registerAction(){}});
  AtriumImportReports.remember(session, schFile, added.ids, schFile.files.map(f => f.name));
  const duplicate = await translate([file(ALTIUM,"PiDP11IOExpander.SchDoc")]);
  assert.notEqual(duplicate.model.documents[0].id, added.newDoc, "independent adoption allocates its own document UUID");
  await assert.rejects(open(duplicate,added.after,true),/already in the project/);
  await assert.rejects(open(read,mine,true),/File › Open/);

  const sch=p.documents.find(d=>d.kind==="schematic"),board=p.documents.find(d=>d.kind==="pcb");
  const plan=()=>AtriumECO.plan(p,{board:board.id,scope:"*",direction:"pcb"}).changes.filter(c=>c.selected||c.conflict);
  assert.deepEqual(plan(),[], "Update PCB starts with no changes");
  const names=new Set(Atrium.connectivity(sch,defs).nets.map(n=>n.name));
  for(const n of ["NetC1_2","NetD1_A"])assert.ok(names.has(n),"Source net "+n);
  assert.ok(![...names].some(n=>n.startsWith("Net-")));
  assert.ok(AtriumHierarchy.compile(p,{defs}).nets.some(n=>n.name==="NetC1_2"));
  const c1=board.items.find(i=>i.kind==="part" && i.ref==="C1"), was=c1.pinNets["2"];
  c1.pinNets["2"]="GND";
  assert.ok(plan().some(c=>c.action==="padNet" && c.object==="C1-2"),"edited board net is visible to ECO");
  c1.pinNets["2"]=was;
  assert.deepEqual(plan(),[]);
}
const restore=require("../support/import-worker.cjs")();
run().finally(restore).then(()=>console.log("import-open-project: ok"),error=>{console.error(error);process.exitCode=1;});
