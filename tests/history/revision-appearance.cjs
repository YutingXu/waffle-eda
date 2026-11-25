"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
require("../../app/core/model.js");
require("../../app/history/revision-review.js");
require("../../app/history/revision-present.js");
require("../../mcp/board-runner.js");

const project = Atrium.project("Receiver");
const [sheet, board] = project.documents;
sheet.sourceName = "Receiver.SchDoc";
sheet.sourceSha256 = "a".repeat(64);
board.sourceName = "Receiver.PcbDoc";
board.sourceSha256 = "b".repeat(64);
board.items.push({id:"feed",kind:"track",net:"RF",layer:"Top",width:.2,points:[[0,0],[4,3]]});
const current = Atrium.clone(project);
const [sch, pcb] = current.documents;
const cachedText = "SOURCE_ONLY_TEMPLATE_DRAWING";
const page = {width:292,height:193,grid:1.27,frame:[{kind:"text",text:cachedText,x:1,y:1}]};
sch.schRestored = {sheet:page,items:{},definitions:{r:{fingerprint:"c".repeat(64),shapes:[],pins:[]}}};
for(let i=0;i<2000;i++)sch.schRestored.items[i+":item"] = {paint:{ink:"#123456"}};
const vertices = 40000, contours = Buffer.alloc(vertices * 16 + 4);
contours.writeUInt32LE(vertices);
for(let i=0;i<vertices;i++){contours.writeDoubleLE(i,4+i*16);contours.writeDoubleLE(i%2,12+i*16);}
const data = contours.toString("base64"), sentinel = data.slice(-100);
pcb.pcbDrawing = {pours:[{layer:"Top",net:"RF",bounds:[0,0,1,1],count:1,data}],annotations:{}};
pcb.sourcePourSignature = "0".repeat(16);
pcb.items[0].width = .4;
pcb.items[0].sourceRecord = "tracks6/data#7";
pcb.sourceName = "Receiver B.PcbDoc";
pcb.sourceSha256 = "d".repeat(64);

const R = AtriumRevisionReview;
const report = R.compare(project,current);
const key = (...parts)=>JSON.stringify(parts);
const fields = (result,k)=>[...R.fields(result,result.rows.find(r=>r.key===k))];
const appearanceKey = key("document",sch.id), boardKey = key("document",pcb.id);
const restored = {label:"Restored sheet appearance",before:"Absent",after:"2000 objects · 1 symbol definition"};
assert.deepEqual(fields(report,appearanceKey),[restored]);
assert.deepEqual(fields(R.compare(current,project),appearanceKey),[{...restored,before:restored.after,after:"Absent"}]);
assert.deepEqual(fields(report,boardKey).map(v=>v.after).sort(),
  ["1 pour region · 0 annotated components",pcb.sourceName,pcb.sourceSha256].sort());
assert.deepEqual(fields(report,key("item","feed")).map(v=>v.after).sort(),["0.4 mm","tracks6/data#7"].sort());
assert.ok(JSON.stringify(report.rows).length<8000);
assert.equal(R.findRows(report,"","",sentinel).length,0);
assert.equal(R.findRows(report,"","",cachedText).length,0);
assert.match(AtriumRevisionPresent.row(report,report.rows.find(r=>r.key===appearanceKey)).detail,/2000 objects/);
assert.match(AtriumRevisionPresent.row(report,report.rows.find(r=>r.locate==="feed")).detail,/tracks6\/data#7/);
const refreshed = Atrium.clone(current);
contours.writeDoubleLE(123,4);
refreshed.documents[1].pcbDrawing.pours[0].data = contours.toString("base64");
refreshed.documents[1].sourcePourSignature = "1".repeat(16);
refreshed.documents[0].schRestored.items["0:item"].paint.ink = "#234567";
assert.deepEqual(R.compare(current,refreshed).rows,[]);
const modern = Atrium.clone(project);
modern.documents[0].schDrawing = page;
const modernEdit = Atrium.clone(modern);
modernEdit.documents[0].schDrawing.width++;
modernEdit.documents[0].schDrawing.frame[0].text += " edited";
assert.deepEqual(fields(R.compare(modern,modernEdit),appearanceKey),[{label:"Sheet appearance · Width",before:"292 mm",after:"293 mm"}]);

AtriumBoardReport(JSON.stringify({tool:"load_git_comparison"}),JSON.stringify(project),JSON.stringify(current));
for(const k of [appearanceKey,boardKey,key("item","feed")]){
  const response = AtriumBoardReport(JSON.stringify({tool:"compare_git_head",options:{section:"fields",key:k,offset:0,limit:20}}));
  assert.deepEqual(JSON.parse(response).items,fields(report,k));
}
AtriumBoardReport(JSON.stringify({tool:"clear_git_comparison"}));

console.log("PASS bounded source artwork summaries, restore/undo, source revision, editable track, sheet settings and MCP field pages");

if (process.versions.node) {
  const {spawnSync} = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"waffle-native-textconv-"));
  const run = file => spawnSync("python3",[path.join(__dirname,"../../scripts/git-waffle-diff.py"),file],{encoding:"utf8"});
  try {
    const native = path.join(__dirname, "../fixtures/cad-native/sample-sensor/Sensor board.wpcb");
    assert.equal(run(native).stdout,fs.readFileSync(native,"utf8"),"keeps every canonical native record and exact source geometry");
    const old = path.join(dir,"Receiver.waffle");
    fs.writeFileSync(old,'{"format":"atrium","version":1,"documents":[]}');
    const rejected = run(old);
    assert.equal(rejected.status,1);
    assert.equal(rejected.stdout,"");
    assert.equal(rejected.stderr.trim(),"This file is from a pre-release Waffle build; re-import the design from its source EDA");
    const eco = path.join(dir,"Change.waffle-eco");
    fs.writeFileSync(eco,'{"format":"atrium-eco","rows":[{"targetId":"U2","field":"value","after":10000000000000001}]}');
    const rendered = run(eco);
    assert.equal(rendered.status,0);
    assert.ok(rendered.stdout.includes("U2") && rendered.stdout.includes("10000000000000001"));
    console.log("PASS exact native Git records, retired format diagnostic and independent ECO precision");
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
} else console.log("SKIP external Git text conversion requires the Python filter");
