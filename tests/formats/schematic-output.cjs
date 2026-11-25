"use strict";
const assert = require("node:assert/strict");
for (const m of ["model","parts","sch-objects","sch-appearance","schematic-output","hierarchy","sexpr","import-kicad","kicad-export","kicad-schematic","sch-import","zip","altium-export"]) require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const S = AtriumSchematicOutput, A = Atrium, K = AtriumKiCadSchematic, X = AtriumAltiumExport;
const project = A.project("Page sizes",[]), doc = project.documents[0];
doc.sheet = {infinite:true};
doc.items = [
  {id:"left",kind:"textframe",role:"frame",text:"Input",x:-384.81,y:-100.33,w:100,h:60},
  {id:"right",kind:"textframe",role:"frame",text:"Control",x:4,y:-90,w:65,h:80},
  {id:"net",kind:"wire",points:[[-380,-90],[50,-90]]}
];
const defs = new Map(), children = (n,k) => n.filter(t => Array.isArray(t) && t[0]===k);
const paper = s => children(AtriumSexpr.parse(s),"paper")[0].slice(1);
const record = line => Object.fromEntries(line.split("|").slice(1).map(s => s.split("=")));
const schRecords = r => r.content.split(/\r?\n/).map(record);
const mm = (r,k) => Number(r[k]||0)*.254+Number(r[k+"_FRAC"]||0)*.00000254;
const original = JSON.stringify(project);
for (const [format,write] of [["kicad",K.exportSheet],["altium",X.exportSchematic]]) {
  const page = S.page(doc,defs,format), r = write(project,doc);
  assert(r.diagnostics.includes(page.note)); assert(page.fits && page.left<0 && page.top<0);
  assert(page.left<=-384.81 && page.top<=-100.33 && page.left+page.width>=69 && page.top+page.height>=-10);
  if (format==="kicad") {
    const [type,w,h] = paper(r.content); assert.equal(type,"User"); assert.equal(+w,page.width); assert.equal(+h,page.height);
  } else {
    const records=schRecords(r), sheet=records.find(r=>r.RECORD==="31");
    assert.equal(sheet.USECUSTOMSHEET,"T"); assert(Math.abs(mm(sheet,"CUSTOMX")-page.width)<.00001);
    assert(Math.abs(mm(sheet,"CUSTOMY")-page.height)<.00001);
    for (const r of records.filter(r=>r.RECORD==="14")) for (const key of ["LOCATION","CORNER"]) {
      assert(mm(r,key+".X")>=0 && mm(r,key+".X")<=page.width && mm(r,key+".Y")>=0 && mm(r,key+".Y")<=page.height);
    }
  }
}
assert.equal(JSON.stringify(project),original);
doc.items[1].x=4000;
for(const [format,write] of [["kicad",K.exportSheet],["altium",X.exportSchematic]]) {
  assert.deepEqual(S.oversized(project,format).map(d=>d.id),[doc.id]); assert.throws(()=>write(project,doc),/One sheet per frame/);
}
doc.sheet={size:"A3",orientation:"portrait"}; doc.sourceName="control.kicad_sch";
assert.deepEqual(paper(K.exportSheet(project,doc).content),["A3","portrait"]);
const fixed = schRecords(X.exportSchematic(project,doc)).find(r=>r.RECORD==="31");
assert(Math.abs(mm(fixed,"CUSTOMX")-297)<.00001 && Math.abs(mm(fixed,"CUSTOMY")-420)<.00001);
const read = p => AtriumImportFormats.readSet([{name:"Imported.kicad_sch",bytes:new TextEncoder().encode('(kicad_sch (version 20250114) (generator "test") (uuid 00000000-0000-4000-8000-000000000001) (paper '+p+') (lib_symbols))')}])[0].documents[0];
for (const [expr,w,h] of [['"A5"',210,148],['"A3" portrait',297,420],['"User" 400.125 101.25',400.125,101.25]]) {
  const imported=read(expr), p=S.page(imported,defs,"kicad");
  assert.deepEqual([p.width,p.height,p.left,p.top],[w,h,0,0]);
}
// Native sheets created with the standard template have physical paper even before any setting is edited.
const defaultPage = S.page(A.sheet("schematic","Native"),defs,"kicad");
assert.deepEqual([defaultPage.left,defaultPage.top,defaultPage.width,defaultPage.height],[-12.7,-12.7,292.1,193.04]);
// Historical imports with no stored source paper still use their drawing extents.
assert.equal(S.measure({...A.sheet("schematic","Old source"),sourceName:"old.kicad_sch"},defs,"kicad"),null);
// Project files must agree on the actual root UUID, sheet symbol UUID and project name.
{
  const pr=A.project("Instrument",[]), root=pr.documents[0], child=A.sheet("schematic","Sensor");
  pr.documents=[root,child];
  root.items=[{id:"child",kind:"sheetsymbol",sheet:child.id,name:"Sensor",x:0,y:0,w:24,h:16,entries:[]}];
  child.items=[{id:"power",kind:"power",x:0,y:0,text:"GND",style:"gnd"}];
  const files = AtriumKiCad.exportProject(pr).files, rootFile=AtriumSexpr.parse(files.find(f=>f.name==="Instrument.kicad_sch").content);
  const placed=children(rootFile,"sheet")[0], rootId=children(rootFile,"uuid")[0][1], symbolId=children(placed,"uuid")[0][1];
  const contexts=e=>children(children(e,"instances")[0],"project")[0];
  const parent=contexts(placed); assert.equal(parent[1],"Instrument");
  assert.equal(children(parent,"path")[0][1],"/"+rootId);
  const childFile=AtriumSexpr.parse(files.find(f=>f.name==="Sensor.kicad_sch").content);
  const pins=contexts(children(childFile,"symbol")[0]); assert.equal(pins[1],"Instrument");
  assert.equal(children(pins,"path")[0][1],"/"+rootId+"/"+symbolId);
}
console.log("PASS schematic export physical page size, negative extents, frame titles and oversize choices; KiCad A5, A3 portrait and custom paper import");
