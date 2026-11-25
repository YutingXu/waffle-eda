"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
globalThis.CFB=require("../../app/vendor/cfb.min.js");
for(const name of ["model","parts","board-shape","stackup","pcb-pours","polygon-pour","pcb-appearance","pcb-text-rich","pcb-text","designator-place","pcb-edit",
  "source-file","altium-ids","pcb-import","eco","io","altium-export","source-copy","pcb-patch"])require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const {reopenAltium} = require("../support/altium-folder.cjs");
const A=Atrium, X=AtriumAltiumExport, V=AtriumPCBAppearance;
const folder=path.join(__dirname,"../fixtures/altium/pidp11-io-expander"), file="PiDP11IOExpander.PcbDoc";
const bytes=fs.readFileSync(path.join(folder,file)), result=AtriumIO.read(file,bytes), p=A.project("PiDP",result.library), pcb=result.documents[0];
p.documents=[pcb];
p.parameters=AtriumIO.read("PiDP.PrjPcb",fs.readFileSync(path.join(folder,"PCB-PiDP11IOExpander.PrjPcb"))).manifest.parameters;
const rows=content=>content.split(/\r\n|\r|\n/).filter(l=>l.startsWith("|RECORD=")).map(line=>
  Object.fromEntries(line.slice(1).split("|").map(f=>{const n=f.indexOf("=");return [f.slice(0,n),f.slice(n+1)];})));
const ticks=s=>Math.round(parseFloat(s)*10000);
const metrics=r=>[ticks(r.X),ticks(r.Y),+r.ROTATION,ticks(r.HEIGHT),ticks(r.WIDTH),+r.TTFINVERTEDTEXTJUSTIFY,ticks(r.JUSTIFICATIONCENETERX),ticks(r.JUSTIFICATIONCENETERY)];
const expected={
  GP0:[300000,6625041,0,250000,50000,2,250000,6750000],
  INT:[1874958,300001,90,250000,50000,2,1750000,250000],
  R1:[9800000,2975041,0,250000,50000,2,9750000,3100000],
  C2:[14424958,583469,90,250000,50000,8,14300000,1050000],
  U2:[10300000,1791734,90,250000,50000,6,10350000,2000000],
  J1:[550000,1625041,0,250000,50000,2,500000,1750000],
  J4:[1190000,7610000,0,250000,50000,5,1398266,7734959]
};
// Designer's PCB iterator and native ASCII save of the licensed original provide the oracle in native ticks.
function check(content){
  const all=rows(content),texts=all.filter(r=>r.RECORD==="Text"), parts=all.filter(r=>r.RECORD==="Component");
  assert.equal(texts.length,65);assert.equal(texts.filter(r=>r.DESIGNATOR==="TRUE").length,23);
  assert.equal(texts.filter(r=>r.COMMENT==="TRUE").length,23);
  assert.equal(parts.find(r=>r.SOURCEDESIGNATOR==="J4").NAMEON,"FALSE");
  assert.ok(parts.every(r=>r.COMMENTON==="FALSE"));
  for(const [s,source] of Object.entries(expected)){
    const t=texts.find(r=>r.TEXT===s);assert.ok(t,s);
    const m=metrics(t);
    for(let k=0;k<m.length;k++)assert.ok(Math.abs(m[k]-source[k])<=(s==="INT"&&k<2?1:0),s+" field "+k+": "+m[k]+" vs "+source[k]);
    assert.equal(t.ADVANCESNAPPING,"TRUE");assert.equal(t.FONT,"DEFAULT");assert.equal(t.USETTFONTS,"FALSE");
    assert.equal(t.LAYER,"TOPOVERLAY");
  }
  const u=texts.find(r=>r.TEXT===".ProjectURL");
  assert.equal(u.MIRROR,"TRUE");assert.equal(ticks(u.X),22230000);assert.equal(ticks(u.JUSTIFICATIONCENETERX),22280000);
}
const direct=X.exportBoard(p,pcb);check(direct.content);
const reopened=AtriumIO.read(file,direct.bytes),d=reopened.documents[0],q=A.project("ASCII",reopened.library);q.documents=[d];
const ref=key=>d.items.find(i=>i.ref===key);
assert.equal(V.sourceLabels(d,ref("J4")).length,0);
assert.equal(ref("J4").hiddenBoardLabels.length,2);
assert.equal(V.sourceLabels(d,ref("R1"))[0].justify,"middle-left");
const saved=reopenAltium(q,{name:file,bytes:direct.bytes}).project;
check(X.exportBoard(saved,saved.documents[0]).content);
ref("J4").showRef=true;
assert.equal(V.sourceLabels(d,ref("J4"))[0].field,"ref");
assert.equal(rows(X.exportBoard(q,d).content).find(r=>r.RECORD==="Component"&&r.SOURCEDESIGNATOR==="J4").NAMEON,"TRUE");
const r1=ref("R1"),before=metrics(rows(direct.content).find(r=>r.TEXT==="R1")); r1.x+=.254;
const moved=metrics(rows(X.exportBoard(q,d).content).find(r=>r.TEXT==="R1"));
assert.equal(moved[0]-before[0],100000);assert.equal(moved[6]-before[6],100000);
AtriumPCBEdit.flip(d,q,[r1.id]);
const flipped=rows(X.exportBoard(q,d).content).find(r=>r.TEXT==="R1");
assert.equal(flipped.LAYER,"BOTTOMOVERLAY");assert.equal(flipped.MIRROR,"TRUE");
AtriumPCBEdit.flip(d,q,[r1.id]);
assert.deepEqual(metrics(rows(X.exportBoard(q,d).content).find(r=>r.TEXT==="R1")),moved);

// Previously saved projections still reproduce the original binary and preserve unrecognized streams.
for(const nativeText of [false,true]){
  const r=AtriumPCB.read(file,AtriumIO.streams(bytes),null,{nativeText}), project=A.project("Copy",r.library);
  project.documents=r.documents;project.documents[0].sourceSha256=AtriumSourceFile.sha256(bytes);
  const {project:saved,retained}=reopenAltium(project,{name:file,bytes});
  assert.deepEqual(Buffer.from(AtriumSourceCopy.prepare(saved.documents[0],saved.library,bytes,{provenance:retained}).bytes),bytes);
}

const manifest=project=>X.exportProject(project).files.find(f=>f.name.endsWith(".PrjPcb"));
const normal=manifest(p);assert.deepEqual(AtriumIO.read(normal.name,normal.bytes).manifest.parameters,p.parameters);
p.parameters=[{name:"Drawing ID",value:' A=B | "温度" Ω🔩 '},{name:"[owner]=é",value:"before; after #1"},{name:"Flag",value:false},{name:"N",value:2}];
p.unrelated={Secret:"never publish this"};
const international=manifest(p);
assert.deepEqual([...international.bytes.slice(0,3)],[239,187,191]);
assert.deepEqual(AtriumIO.read(international.name,international.bytes).manifest.parameters,
  {"Drawing ID":' A=B | "温度" Ω🔩 ',"[owner]=é":"before; after #1",Flag:"false",N:"2"});
assert.ok(!international.content.includes("never publish this"));
p.parameters={Bad:"line\n[Document99]\nDocumentPath=other.PcbDoc"};
const sanitized=X.exportProject(p), ini=sanitized.files.find(f=>f.name.endsWith(".PrjPcb"));
assert.ok(sanitized.diagnostics.some(m=>m.includes("single Altium INI line")));
assert.ok(!ini.content.includes("Document99"));
assert.equal(AtriumIO.read(ini.name,ini.bytes).manifest.paths.length,1);
console.log("PASS Designer text origins, native sizes and anchors, visibility, mirrored component edits, binary copies and project strings.");
